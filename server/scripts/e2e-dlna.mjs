#!/usr/bin/env node
// CastHub DLNA 端到端测试：fake-dlna -> 自动发现 -> 投屏 -> pause/seek/stop
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const HTTP_PORT = Number(process.env.E2E_DLNA_PORT ?? 9430);
const CONSOLE_TOKEN = "e2e-dlna-token-2024";
const FAKE_DEVICE_NAME = "Fake DLNA TV";

const children = [];
let exiting = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanup() {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function startProcess(name, args, options) {
  const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const lines = [];
  const absorb = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        lines.push(line);
        process.stdout.write(`[${name}] ${line}\n`);
      }
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  child.on("exit", (code) => {
    if (!exiting && code !== 0 && code !== null) console.error(`[${name}] 进程退出 code=${code}`);
  });
  return {
    child,
    lines,
    async waitFor(pattern, timeoutMs = 15000, label = String(pattern)) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = lines.find((line) => pattern.test(line));
        if (hit) return hit;
        await sleep(50);
      }
      throw new Error(`等待超时: ${label}`);
    }
  };
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { "x-casthub-token": CONSOLE_TOKEN } });
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error("服务未就绪: " + url);
}

class ConsoleClient {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.messages.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i];
        if (waiter.predicate(msg)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(i, 1);
          waiter.resolve(msg);
        }
      }
    });
  }

  static connect(url) {
    const client = new ConsoleClient(url);
    return new Promise((resolve, reject) => {
      client.ws.once("open", () => resolve(client));
      client.ws.once("error", reject);
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  waitFor(predicate, timeoutMs = 10000, label = "消息") {
    const found = this.messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("等待超时: " + label));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error("断言失败: " + message);
  console.log("✓ " + message);
}

async function stopHub(handle) {
  const child = handle.child;
  if (child.exitCode !== null) return child.exitCode;
  const exitPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      reject(new Error("等待 hub 进程退出超时"));
    }, 15000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  child.kill("SIGTERM");
  const result = await exitPromise;
  console.log("hub 进程已真正退出:", JSON.stringify(result));
  return result.code;
}

function startHub(mediaDir, extraEnv = {}) {
  return startProcess("server", ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(HTTP_PORT),
      HOST: "127.0.0.1",
      MEDIA_DIR: mediaDir,
      PUBLIC_BASE_URL: "",
      CONSOLE_TOKEN,
      DLNA_ALLOW_LOOPBACK: "1",
      ...extraEnv
    }
  });
}

async function connectConsole() {
  const client = await ConsoleClient.connect(`ws://127.0.0.1:${HTTP_PORT}/console?token=${CONSOLE_TOKEN}`);
  await client.waitFor((m) => m.type === "devices", 5000, "初始 devices");
  return client;
}

function isFakeDlnaDevice(device) {
  return device.type === "dlna" && device.deviceName === FAKE_DEVICE_NAME;
}

async function waitDlnaDevice(client, timeoutMs) {
  // 本机可能同时发现真实电视；e2e 必须只锁定 fake-dlna，否则环境差异会让断言不确定。
  return client.waitFor(
    (m) => m.type === "devices" && Array.isArray(m.list) && m.list.some(isFakeDlnaDevice),
    timeoutMs,
    `devices 中出现 ${FAKE_DEVICE_NAME}`
  );
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-e2e-dlna-"));
  const mediaDir = path.join(tempDir, "media");
  const dataDir = path.join(tempDir, "data-root");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "sample.mp4"), Buffer.alloc(256 * 1024, 0x1a));
  console.log("测试媒体目录:", mediaDir);
  console.log("测试 DATA_DIR:", dataDir, "（两代 hub 共用）");

  console.log("\n[1/12] 启动 fake-dlna ...");
  const fake = startProcess("fake-dlna", ["scripts/fake-dlna.mjs"], {
    cwd: SERVER_DIR,
    env: { ...process.env, FAKE_DLNA_HTTP_PORT: "0", FAKE_DLNA_NAME: "Fake DLNA TV" }
  });
  const locationLine = await fake.waitFor(/^LOCATION /, 10000, "fake-dlna LOCATION");
  const location = locationLine.replace(/^LOCATION /, "").trim();
  await fake.waitFor(/FAKE_DLNA_READY/, 5000, "fake-dlna ready");
  console.log("fake-dlna LOCATION:", location);

  console.log("[2/12] 启动中枢 ...");
  let server = startHub(mediaDir, { DATA_DIR: dataDir });
  await server.waitFor(/CastHub 已启动/, 20000, "中枢启动");
  await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);

  console.log("[3/12] 连接控制台并等待 DLNA 自动发现 ...");
  let client = await connectConsole();
  let dlnaMsg;
  try {
    dlnaMsg = await waitDlnaDevice(client, 8000);
  } catch (error) {
    console.log("⚠ 8s 内未自动发现 DLNA（多播可能受限），降级为 DLNA_SEED 重启中枢");
    client.close();
    await stopHub(server);
    server = startHub(mediaDir, { DLNA_SEED: location, DATA_DIR: dataDir });
    await server.waitFor(/CastHub 已启动/, 20000, "seed 中枢启动");
    await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);
    client = await connectConsole();
    dlnaMsg = await waitDlnaDevice(client, 8000);
    console.log("DLNA_SEED 降级路径生效");
  }
  const device = dlnaMsg.list.find(isFakeDlnaDevice);
  assert(!!device, `DLNA 设备出现: ${device.deviceName} (${device.id})`);
  assert(device.deviceName === FAKE_DEVICE_NAME, "deviceName 来自 device.xml friendlyName");

  console.log("[4/12] 浏览文件 ...");
  const fileRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`, { headers: { "x-casthub-token": CONSOLE_TOKEN } });
  const fileJson = await fileRes.json();
  const video = fileJson.entries.find((entry) => !entry.isDir && /\.(mp4|mkv|avi|mov|webm|ts)$/i.test(entry.name));
  assert(!!video, `/api/files 返回视频: ${video.name} (${video.size} bytes, ${video.mimeType})`);

  console.log("[5/12] cast 到 DLNA 设备 ...");
  client.send({ type: "cast", deviceId: device.id, path: video.path });
  const playing = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "playing",
    15000,
    "tvStatus=playing"
  );
  assert(playing.durationMs > 0, `DLNA 进入 playing（duration=${playing.durationMs}ms）`);
  await fake.waitFor(/MEDIA_PROBE 206/, 5000, "fake-dlna Range 探测 206");

  console.log("[5.1/12] 验证 RenderingControl 初始音量与 SetVolume ...");
  const volumeReady = await client.waitFor(
    (m) => m.type === "devices" && m.list.some((d) => d.id === device.id && d.volume === 50),
    6000,
    "devices 中 DLNA volume=50"
  );
  const initialDevice = volumeReady.list.find((d) => d.id === device.id);
  assert(initialDevice.volume === 50, `发现后 GetVolume 初始值 volume=${initialDevice.volume}`);
  client.send({ type: "control", deviceId: device.id, action: "volume", value: 40 });
  const volume40 = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.volume === 40,
    6000,
    "tvStatus.volume=40"
  );
  assert(volume40.volume === 40, `SetVolume 40 生效 volume=${volume40.volume}`);
  client.send({ type: "control", deviceId: device.id, action: "volume", value: 100 });
  const volume100 = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.volume === 100,
    6000,
    "tvStatus.volume=100"
  );
  assert(volume100.volume === 100, `SetVolume 100 生效 volume=${volume100.volume}`);

  console.log("[6/12] pause ...");
  client.send({ type: "control", deviceId: device.id, action: "pause" });
  const paused = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "paused",
    6000,
    "tvStatus=paused"
  );
  assert(paused.state === "paused", "pause 生效，tvStatus=paused");

  console.log("[7/12] seek 30000 ...");
  client.send({ type: "control", deviceId: device.id, action: "seek", positionMs: 30000 });
  const seeked = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.positionMs >= 29000 && m.positionMs <= 35000,
    6000,
    "tvStatus positionMs∈[29000,35000]"
  );
  assert(true, `seek 生效 positionMs=${seeked.positionMs}`);

  console.log("[8/12] stop ...");
  client.send({ type: "control", deviceId: device.id, action: "stop" });
  const stopped = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "idle",
    6000,
    "tvStatus=idle"
  );
  assert(stopped.state === "idle", "stop 生效，tvStatus=idle");

  console.log("[9/12] 等待中枢真正退出后用同一 DATA_DIR 重启 ...");
  client.close();
  await stopHub(server);
  server = startHub(mediaDir, { DLNA_SEED: location, DATA_DIR: dataDir });
  await server.waitFor(/CastHub 已启动/, 20000, "重启中枢启动");
  await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);
  client = await connectConsole();
  const dlnaMsg2 = await waitDlnaDevice(client, 8000);
  const device2 = dlnaMsg2.list.find(isFakeDlnaDevice);
  assert(!!device2, `重启后 DLNA 设备出现: ${device2.deviceName} (${device2.id})`);

  console.log("[10/12] getHistory 断言重启后历史仍在 ...");
  const expectedPath = path.resolve(mediaDir, video.path);
  client.messages.length = 0;
  client.send({ type: "getHistory" });
  const historyReply = await client.waitFor(
    (m) => m.type === "history" && Array.isArray(m.list) && m.list.some((h) => path.resolve(h.path) === expectedPath),
    8000,
    "history 包含 sample.mp4"
  );
  const historyEntry = historyReply.list.find((h) => path.resolve(h.path) === expectedPath);
  console.log("getHistory entry:", JSON.stringify(historyEntry));
  assert(
    historyEntry.positionMs >= 29500 && historyEntry.positionMs <= 60000,
    `getHistory positionMs=${historyEntry.positionMs} ∈ [29500,60000]`
  );
  assert(historyEntry.durationMs === 60000, `getHistory durationMs=${historyEntry.durationMs}`);
  assert(historyEntry.playCount >= 1, `getHistory playCount=${historyEntry.playCount}`);

  console.log("[11/12] cast(resume=true) 断言 DLNA 续播生效 ...");
  client.messages.length = 0;
  client.send({ type: "cast", deviceId: device2.id, path: video.path, resume: true });
  const resumed = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device2.id && m.state === "playing" && m.positionMs >= 29500,
    15000,
    "resume=true 后 tvStatus.positionMs>=29500"
  );
  assert(
    resumed.positionMs >= 29500 && resumed.positionMs <= 60000,
    `resume=true 落回 positionMs=${resumed.positionMs} ∈ [29500,60000]`
  );

  console.log("[12/12] cast(resume=false) 从头播放并清理 ...");
  client.messages.length = 0;
  client.send({ type: "cast", deviceId: device2.id, path: video.path, resume: false });
  const fromStart = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device2.id && m.state === "playing" && m.positionMs < 5000,
    15000,
    "resume=false 后从 0 播放"
  );
  assert(fromStart.positionMs < 5000, `resume=false 从头部播放 positionMs=${fromStart.positionMs}`);
  client.send({ type: "control", deviceId: device2.id, action: "stop" });
  await sleep(500);
  client.close();
  console.log("\n✅ E2E-DLNA 全部通过");
}

main()
  .then(() => {
    cleanup();
    setTimeout(() => process.exit(0), 300);
  })
  .catch((error) => {
    console.error("\n❌ E2E-DLNA 失败:", error.message);
    cleanup();
    setTimeout(() => process.exit(1), 300);
  });
