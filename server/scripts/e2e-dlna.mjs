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

async function waitDlnaDevice(client, timeoutMs) {
  return client.waitFor(
    (m) => m.type === "devices" && Array.isArray(m.list) && m.list.some((d) => d.type === "dlna"),
    timeoutMs,
    "devices 中出现 type=dlna"
  );
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-e2e-dlna-"));
  const mediaDir = path.join(tempDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "sample.mp4"), Buffer.alloc(256 * 1024, 0x1a));
  console.log("测试媒体目录:", mediaDir);

  console.log("\n[1/9] 启动 fake-dlna ...");
  const fake = startProcess("fake-dlna", ["scripts/fake-dlna.mjs"], {
    cwd: SERVER_DIR,
    env: { ...process.env, FAKE_DLNA_HTTP_PORT: "0", FAKE_DLNA_NAME: "Fake DLNA TV" }
  });
  const locationLine = await fake.waitFor(/^LOCATION /, 10000, "fake-dlna LOCATION");
  const location = locationLine.replace(/^LOCATION /, "").trim();
  await fake.waitFor(/FAKE_DLNA_READY/, 5000, "fake-dlna ready");
  console.log("fake-dlna LOCATION:", location);

  console.log("[2/9] 启动中枢 ...");
  let server = startHub(mediaDir);
  await server.waitFor(/CastHub 已启动/, 20000, "中枢启动");
  await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);

  console.log("[3/9] 连接控制台并等待 DLNA 自动发现 ...");
  let client = await connectConsole();
  let dlnaMsg;
  try {
    dlnaMsg = await waitDlnaDevice(client, 8000);
  } catch (error) {
    console.log("⚠ 8s 内未自动发现 DLNA（多播可能受限），降级为 DLNA_SEED 重启中枢");
    client.close();
    server.child.kill();
    await sleep(800);
    server = startHub(mediaDir, { DLNA_SEED: location });
    await server.waitFor(/CastHub 已启动/, 20000, "seed 中枢启动");
    await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);
    client = await connectConsole();
    dlnaMsg = await waitDlnaDevice(client, 8000);
    console.log("DLNA_SEED 降级路径生效");
  }
  const device = dlnaMsg.list.find((d) => d.type === "dlna");
  assert(!!device, `DLNA 设备出现: ${device.deviceName} (${device.id})`);
  assert(device.deviceName === "Fake DLNA TV", "deviceName 来自 device.xml friendlyName");

  console.log("[4/9] 浏览文件 ...");
  const fileRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`, { headers: { "x-casthub-token": CONSOLE_TOKEN } });
  const fileJson = await fileRes.json();
  const video = fileJson.entries.find((entry) => !entry.isDir && /\.(mp4|mkv|avi|mov|webm|ts)$/i.test(entry.name));
  assert(!!video, `/api/files 返回视频: ${video.name} (${video.size} bytes, ${video.mimeType})`);

  console.log("[5/9] cast 到 DLNA 设备 ...");
  client.send({ type: "cast", deviceId: device.id, path: video.path });
  const playing = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "playing",
    15000,
    "tvStatus=playing"
  );
  assert(playing.durationMs > 0, `DLNA 进入 playing（duration=${playing.durationMs}ms）`);
  await fake.waitFor(/MEDIA_PROBE 206/, 5000, "fake-dlna Range 探测 206");

  console.log("[6/9] pause ...");
  client.send({ type: "control", deviceId: device.id, action: "pause" });
  const paused = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "paused",
    6000,
    "tvStatus=paused"
  );
  assert(paused.state === "paused", "pause 生效，tvStatus=paused");

  console.log("[7/9] seek 30000 ...");
  client.send({ type: "control", deviceId: device.id, action: "seek", positionMs: 30000 });
  const seeked = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.positionMs >= 29000 && m.positionMs <= 35000,
    6000,
    "tvStatus positionMs∈[29000,35000]"
  );
  assert(true, `seek 生效 positionMs=${seeked.positionMs}`);

  console.log("[8/9] stop ...");
  client.send({ type: "control", deviceId: device.id, action: "stop" });
  const stopped = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "idle",
    6000,
    "tvStatus=idle"
  );
  assert(stopped.state === "idle", "stop 生效，tvStatus=idle");

  console.log("[9/9] 清理 ...");
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
