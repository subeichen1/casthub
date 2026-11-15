#!/usr/bin/env node
// CastHub 端到端集成测试：起 fake-tv + 中枢 -> /console 添加设备 -> 浏览 -> 投屏 -> seek -> pause
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const HTTP_PORT = Number(process.env.E2E_PORT ?? 9420);
const TV_PORT = Number(process.env.E2E_TV_PORT ?? 9417);
const OVERRIDE_PORT = HTTP_PORT + 1;
const OVERRIDE_TV_PORT = TV_PORT + 1;
const TOKEN = "246810";
const OVERRIDE_TOKEN = "135790";
const CONSOLE_TOKEN = "e2e-console-token-2024";

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

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-e2e-"));
  const mediaDir = path.join(tempDir, "media");
  const dataDir = path.join(tempDir, "data-root");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "sample.mp4"), Buffer.alloc(256 * 1024, 0x1a));
  console.log("测试媒体目录:", mediaDir);
  console.log("测试 DATA_DIR:", dataDir);

  console.log("\n[1/10] 启动 fake-tv ...");
  const fakeTv = startProcess("fake-tv", ["scripts/fake-tv.mjs"], {
    cwd: SERVER_DIR,
    env: { ...process.env, FAKE_TV_PORT: String(TV_PORT), FAKE_TV_TOKEN: TOKEN, FAKE_TV_NAME: "Fake TV" }
  });
  await fakeTv.waitFor(/LISTENING/, 10000, "fake-tv 监听");

  console.log("[2/10] 启动中枢 ...");
  const server = startProcess("server", ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(HTTP_PORT), HOST: "127.0.0.1", MEDIA_DIR: mediaDir, PUBLIC_BASE_URL: "", CONSOLE_TOKEN, DATA_DIR: dataDir }
  });
  await server.waitFor(/CastHub 已启动/, 20000, "中枢启动");
  await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);

  console.log("[3/10] 连接控制台 WS ...");
  const consoleClient = await ConsoleClient.connect(`ws://127.0.0.1:${HTTP_PORT}/console?token=${CONSOLE_TOKEN}`);
  await consoleClient.waitFor((m) => m.type === "devices", 5000, "初始 devices");
  assert(true, "控制台 WS 已连接并收到初始 devices");

  console.log("[4/10] addDevice ...");
  consoleClient.send({ type: "addDevice", address: `ws://127.0.0.1:${TV_PORT}`, token: TOKEN });
  const onlineMsg = await consoleClient.waitFor(
    (m) => m.type === "devices" && Array.isArray(m.list) && m.list.some((d) => d.online === true),
    10000,
    "devices(online:true)"
  );
  const device = onlineMsg.list.find((d) => d.online === true);
  assert(!!device, `设备上线: ${device.address}`);

  console.log("[5/10] 浏览文件 ...");
  const fileRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`, { headers: { "x-casthub-token": CONSOLE_TOKEN } });
  const fileJson = await fileRes.json();
  const video = fileJson.entries.find((entry) => !entry.isDir && /\.(mp4|mkv|avi|mov|webm|ts)$/i.test(entry.name));
  assert(!!video, `/api/files 返回视频: ${video.name} (${video.size} bytes, ${video.mimeType})`);

  console.log("[6/10] cast ...");
  consoleClient.send({ type: "cast", deviceId: device.id, path: video.path });
  const playingMsg = await consoleClient.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "playing",
    15000,
    "tvStatus=playing"
  );
  assert(playingMsg.durationMs > 0, `电视进入 playing（duration=${playingMsg.durationMs}ms）`);
  const playLine = await fakeTv.waitFor(/PLAY_URL/, 5000, "fake-tv PLAY_URL");
  assert(
    playLine.includes(`http://127.0.0.1:${HTTP_PORT}/media/${video.path}`),
    "播放地址由控制台 Host 头推导: " + playLine.replace("[fake-tv] PLAY_URL ", "")
  );
  await fakeTv.waitFor(/RANGE_PROBE 206/, 5000, "fake-tv Range 探测 206");

  console.log("[7/10] seek ...");
  consoleClient.send({ type: "control", deviceId: device.id, action: "seek", positionMs: 30000 });
  const seekMsg = await consoleClient.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.positionMs >= 30000,
    5000,
    "tvStatus positionMs>=30000"
  );
  assert(true, `seek 生效 positionMs=${seekMsg.positionMs}`);

  console.log("[8/10] pause ...");
  consoleClient.send({ type: "control", deviceId: device.id, action: "pause" });
  const pausedMsg = await consoleClient.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "paused",
    5000,
    "tvStatus=paused"
  );
  assert(pausedMsg.state === "paused", "pause 生效，tvStatus=paused");

  console.log("[9/10] 验证 PUBLIC_BASE_URL 覆盖 ...");
  const overrideTv = startProcess("fake-tv-override", ["scripts/fake-tv.mjs"], {
    cwd: SERVER_DIR,
    env: { ...process.env, FAKE_TV_PORT: String(OVERRIDE_TV_PORT), FAKE_TV_TOKEN: OVERRIDE_TOKEN, FAKE_TV_NAME: "Override TV", FAKE_TV_SKIP_PROBE: "1" }
  });
  await overrideTv.waitFor(/LISTENING/, 10000, "override fake-tv 监听");
  const overrideServer = startProcess("server-override", ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(OVERRIDE_PORT),
      HOST: "127.0.0.1",
      MEDIA_DIR: mediaDir,
      PUBLIC_BASE_URL: "http://10.0.2.2:9420",
      CONSOLE_TOKEN,
      DATA_DIR: dataDir
    }
  });
  await overrideServer.waitFor(/CastHub 已启动/, 20000, "override 中枢启动");
  await waitForHttp(`http://127.0.0.1:${OVERRIDE_PORT}/api/files?path=`);
  const overrideClient = await ConsoleClient.connect(`ws://127.0.0.1:${OVERRIDE_PORT}/console?token=${CONSOLE_TOKEN}`);
  await overrideClient.waitFor((m) => m.type === "devices", 5000, "override devices");
  overrideClient.send({ type: "addDevice", address: `ws://127.0.0.1:${OVERRIDE_TV_PORT}`, token: OVERRIDE_TOKEN });
  const overrideOnline = await overrideClient.waitFor(
    (m) => m.type === "devices" && m.list.some((d) => d.online === true),
    10000,
    "override devices online"
  );
  const overrideDevice = overrideOnline.list.find((d) => d.online === true);
  overrideClient.send({ type: "cast", deviceId: overrideDevice.id, path: video.path });
  await overrideClient.waitFor((m) => m.type === "tvStatus" && m.state === "playing", 10000, "override playing");
  const overrideLine = await overrideTv.waitFor(/PLAY_URL/, 5000, "override PLAY_URL");
  assert(
    overrideLine.includes("http://10.0.2.2:9420/media/"),
    "PUBLIC_BASE_URL 覆盖生效: " + overrideLine.replace("[fake-tv] PLAY_URL ", "")
  );
  overrideClient.close();

  console.log("[10/10] 清理 ...");
  consoleClient.close();
  console.log("\n✅ E2E 全部通过");
}

main()
  .then(() => {
    cleanup();
    setTimeout(() => process.exit(0), 300);
  })
  .catch((error) => {
    console.error("\n❌ E2E 失败:", error.message);
    cleanup();
    setTimeout(() => process.exit(1), 300);
  });
