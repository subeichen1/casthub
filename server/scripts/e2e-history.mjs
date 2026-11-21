#!/usr/bin/env node
// Phase 9B 播放历史/断点续播端到端测试（casthub 设备）。
// 使用独立临时 DATA_DIR：第一代中枢退出后，第二代中枢复用同一 DATA_DIR，验证历史存活与 resume。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const HTTP_PORT = Number(process.env.E2E_HISTORY_PORT ?? 9440);
const TV_PORT = Number(process.env.E2E_HISTORY_TV_PORT ?? 9441);
const TOKEN = "944100";
const CONSOLE_TOKEN = "e2e-history-console-token-2024";

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
        process.stdout.write("[" + name + "] " + line + "\n");
      }
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  child.on("exit", (code) => {
    if (!exiting && code !== 0 && code !== null) console.error("[" + name + "] 进程退出 code=" + code);
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
      throw new Error("等待超时: " + label);
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
  if (child.exitCode !== null) {
    console.log("hub 进程此前已退出 code=" + child.exitCode);
    return child.exitCode;
  }
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

async function startHub(mediaDir, dataDir) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log("启动中枢（第 " + attempt + " 次）...");
    const handle = startProcess("server", ["--import", "tsx", "src/index.ts"], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        PORT: String(HTTP_PORT),
        HOST: "127.0.0.1",
        MEDIA_DIR: mediaDir,
        PUBLIC_BASE_URL: "",
        CONSOLE_TOKEN,
        DATA_DIR: dataDir
      }
    });
    try {
      await handle.waitFor(/CastHub 已启动/, 20000, "中枢启动");
      await waitForHttp("http://127.0.0.1:" + HTTP_PORT + "/api/files?path=");
      return handle;
    } catch (error) {
      lastError = error;
      console.log("中枢启动失败，准备退避重试:", error.message);
      await stopHub(handle).catch(() => undefined);
      if (attempt < 3) await sleep(1000);
    }
  }
  throw lastError;
}

async function connectConsole() {
  const client = await ConsoleClient.connect("ws://127.0.0.1:" + HTTP_PORT + "/console?token=" + CONSOLE_TOKEN);
  await client.waitFor((m) => m.type === "devices", 5000, "初始 devices");
  return client;
}

async function addDevice(client) {
  client.send({ type: "addDevice", address: "ws://127.0.0.1:" + TV_PORT, token: TOKEN });
  const online = await client.waitFor(
    (m) =>
      m.type === "devices" &&
      Array.isArray(m.list) &&
      m.list.some((d) => d.type === "casthub" && d.online === true),
    10000,
    "devices(casthub online:true)"
  );
  return online.list.find((d) => d.type === "casthub" && d.online === true);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-e2e-history-"));
  const mediaDir = path.join(tempDir, "media");
  const dataDir = path.join(tempDir, "data-root");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "sample.mp4"), Buffer.alloc(256 * 1024, 0x1a));
  console.log("测试媒体目录:", mediaDir);
  console.log("测试 DATA_DIR:", dataDir, "（两代 hub 共用）");

  console.log("\n[1/11] 启动 fake-tv ...");
  const fakeTv = startProcess("fake-tv", ["scripts/fake-tv.mjs"], {
    cwd: SERVER_DIR,
    env: { ...process.env, FAKE_TV_PORT: String(TV_PORT), FAKE_TV_TOKEN: TOKEN, FAKE_TV_NAME: "History TV" }
  });
  await fakeTv.waitFor(/LISTENING/, 10000, "fake-tv 监听");

  console.log("[2/11] 启动第一代中枢 ...");
  let server = await startHub(mediaDir, dataDir);
  const startLine = server.lines.find((line) => line.includes("HISTORY="));
  assert(!!startLine, "启动日志包含 HISTORY 存储信息: " + startLine);

  console.log("[3/11] 连接控制台并添加设备 ...");
  let client = await connectConsole();
  const device = await addDevice(client);
  assert(!!device, "设备上线: " + device.address);

  console.log("[4/11] 浏览并首次 cast ...");
  const fileRes = await fetch("http://127.0.0.1:" + HTTP_PORT + "/api/files?path=", {
    headers: { "x-casthub-token": CONSOLE_TOKEN }
  });
  const fileJson = await fileRes.json();
  const video = fileJson.entries.find((entry) => !entry.isDir && /\.mp4$/i.test(entry.name));
  assert(!!video, "/api/files 返回视频: " + video.name);
  // Windows CI 的 TEMP 可能含 8.3 短名（如 RUNNER~1）；服务器用 fs.promises.realpath 存储长路径，比较前统一展开。
  const realPath = (value) => {
    try {
      return fs.realpathSync.native(path.resolve(value));
    } catch {
      return path.resolve(value);
    }
  };
  const expectedPath = realPath(path.resolve(mediaDir, video.path));
  client.messages.length = 0;
  client.send({ type: "cast", deviceId: device.id, path: video.path });
  const playing = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "playing",
    15000,
    "首次 tvStatus=playing"
  );
  assert(playing.durationMs > 0, "首次进入 playing（duration=" + playing.durationMs + "ms）");

  console.log("[5/11] control seek 30000，等待 positionMs>=29500 ...");
  client.send({ type: "control", deviceId: device.id, action: "seek", positionMs: 30000 });
  const seeked = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.positionMs >= 29500,
    8000,
    "tvStatus positionMs>=29500"
  );
  assert(seeked.positionMs >= 29500, "seek 生效 positionMs=" + seeked.positionMs);

  console.log("[6/11] stop 并等待第一代 hub 进程真正 exit ...");
  client.send({ type: "control", deviceId: device.id, action: "stop" });
  await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "idle",
    8000,
    "tvStatus=idle"
  );
  client.close();
  await stopHub(server);

  console.log("[7/11] 同一 DATA_DIR 重启第二代 hub ...");
  server = await startHub(mediaDir, dataDir);
  const restartLine = server.lines.find((line) => line.includes("HISTORY="));
  console.log("第二代 HISTORY:", restartLine);
  client = await connectConsole();

  console.log("[8/11] getHistory 断言重启后历史仍在 ...");
  client.messages.length = 0;
  client.send({ type: "getHistory" });
  const historyReply = await client.waitFor(
    (m) => m.type === "history" && Array.isArray(m.list) && m.list.some((h) => realPath(h.path) === expectedPath),
    8000,
    "history 包含 sample.mp4"
  );
  const historyEntry = historyReply.list.find((h) => realPath(h.path) === expectedPath);
  console.log("getHistory entry:", JSON.stringify(historyEntry));
  assert(
    historyEntry.positionMs >= 29500 && historyEntry.positionMs <= 60000,
    "getHistory positionMs=" + historyEntry.positionMs + " ∈ [29500,60000]"
  );
  assert(historyEntry.durationMs === 60000, "getHistory durationMs=" + historyEntry.durationMs);
  assert(historyEntry.playCount >= 1, "getHistory playCount=" + historyEntry.playCount);

  console.log("[9/11] 重新添加设备并 cast(resume=true) ...");
  const device2 = await addDevice(client);
  assert(!!device2, "重启后设备重新上线: " + device2.address);
  client.messages.length = 0;
  client.send({ type: "cast", deviceId: device2.id, path: video.path, resume: true });
  const resumed = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device2.id && m.state === "playing" && m.positionMs >= 29500,
    15000,
    "resume=true 后 tvStatus.positionMs>=29500"
  );
  assert(
    resumed.positionMs >= 29500 && resumed.positionMs <= 60000,
    "resume=true 落回 positionMs=" + resumed.positionMs + " ∈ [29500,60000]"
  );

  console.log("[10/11] cast(resume=false) 从头播放 ...");
  client.messages.length = 0;
  client.send({ type: "cast", deviceId: device2.id, path: video.path, resume: false });
  const fromStart = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device2.id && m.state === "playing" && m.positionMs < 5000,
    15000,
    "resume=false 后从 0 播放"
  );
  assert(fromStart.positionMs < 5000, "resume=false 从头部播放 positionMs=" + fromStart.positionMs);

  console.log("[11/11] 清理 ...");
  client.send({ type: "control", deviceId: device2.id, action: "stop" });
  await sleep(500);
  client.close();
  console.log("\n✅ E2E-HISTORY 全部通过");
}

main()
  .then(() => {
    cleanup();
    setTimeout(() => process.exit(0), 300);
  })
  .catch((error) => {
    console.error("\n❌ E2E-HISTORY 失败:", error.message);
    cleanup();
    setTimeout(() => process.exit(1), 300);
  });
