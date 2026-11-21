#!/usr/bin/env node
// CastHub DLNA 播放队列端到端测试：queueAdd -> 自动连播 -> 停止不跳 -> 清空/普通投屏清队列
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const HTTP_PORT = Number(process.env.E2E_QUEUE_PORT ?? 9431);
const CONSOLE_TOKEN = "e2e-queue-token-2024";
const FAKE_DEVICE_NAME = "Fake Queue TV";
const DURATION_MS = 4000;
const FAKE_FFPROBE = path.join(SERVER_DIR, "scripts", "fake-ffprobe.mjs");
const FAKE_FFMPEG = path.join(SERVER_DIR, "scripts", "fake-ffmpeg.mjs");

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
      throw new Error("等待超时: " + label);
    },
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
      FFPROBE_PATH: FAKE_FFPROBE,
      FFMPEG_PATH: FAKE_FFMPEG,
      DLNA_AUTO_NEXT_DELAY_MS: "300",
      ...extraEnv,
    },
  });
}

async function connectConsole() {
  const client = await ConsoleClient.connect(`ws://127.0.0.1:${HTTP_PORT}/console?token=${CONSOLE_TOKEN}`);
  await client.waitFor((m) => m.type === "devices", 5000, "初始 devices");
  return client;
}

function waitQueue(client, deviceId, predicate, timeoutMs, label) {
  return client.waitFor((m) => m.type === "queue" && m.deviceId === deviceId && predicate(m.queue), timeoutMs, label);
}

function countLines(lines, prefix) {
  return lines.filter((line) => line.startsWith(prefix)).length;
}

async function waitForLineIndex(lines, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const index = lines.findIndex(predicate);
    if (index >= 0) return index;
    await sleep(50);
  }
  throw new Error("等待目标输出行超时");
}

async function waitUnitCount(lines, prefix, expected, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countLines(lines, prefix) >= expected) return;
    await sleep(50);
  }
  throw new Error(`等待 ${prefix} 数量达到 ${expected} 超时（实际 ${countLines(lines, prefix)}）`);
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-e2e-queue-"));
  const mediaDir = path.join(tempDir, "media");
  const dataDir = path.join(tempDir, "data-root");
  fs.mkdirSync(mediaDir, { recursive: true });
  const names = ["queue-a.mp4", "queue-b.mp4", "queue-c.mp4"];
  for (const name of names) {
    fs.writeFileSync(path.join(mediaDir, name), Buffer.alloc(256 * 1024, 0x2a));
    fs.writeFileSync(
      path.join(mediaDir, name.replace(/\.mp4$/, ".srt")),
      "1\n00:00:01,000 --> 00:00:03,000\nQueue subtitle\n",
      "utf8",
    );
  }
  fs.writeFileSync(path.join(mediaDir, "notes.txt"), "not a video", "utf8");
  console.log("测试媒体目录:", mediaDir);

  console.log("[1/8] 启动 fake-dlna（自动结束模拟）...");
  const fake = startProcess("fake-queue", ["scripts/fake-dlna.mjs"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      FAKE_DLNA_HTTP_PORT: "0",
      FAKE_DLNA_SSDP_PORT: "0",
      FAKE_DLNA_NAME: FAKE_DEVICE_NAME,
      FAKE_DLNA_MANUFACTURER: "Samsung Electronics",
      FAKE_DLNA_MODEL_NAME: "UN55",
      FAKE_DLNA_DURATION_MS: String(DURATION_MS),
      FAKE_DLNA_AUTO_STOP: "1",
    },
  });
  const locationLine = await fake.waitFor(/^LOCATION /, 10000, "fake LOCATION");
  const location = locationLine.replace(/^LOCATION /, "").trim();
  await fake.waitFor(/FAKE_DLNA_READY/, 5000, "fake ready");

  console.log("[2/8] 启动中枢 ...");
  const server = startHub(mediaDir, { DATA_DIR: dataDir, DLNA_SEED: location });
  await server.waitFor(/CastHub 已启动/, 20000, "中枢启动");
  await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);

  console.log("[3/8] 连接控制台并等待 fake DLNA ...");
  const client = await connectConsole();
  const devicesMsg = await client.waitFor(
    (m) =>
      m.type === "devices" &&
      Array.isArray(m.list) &&
      m.list.some((d) => d.type === "dlna" && d.deviceName === FAKE_DEVICE_NAME),
    10000,
    "devices 中出现 " + FAKE_DEVICE_NAME,
  );
  const device = devicesMsg.list.find((d) => d.type === "dlna" && d.deviceName === FAKE_DEVICE_NAME);
  assert(!!device, `DLNA 设备出现: ${device.deviceName} (${device.id})`);

  console.log("[4/8] 队列参数校验 + 空队列第一次 queueAdd 立即播放 ...");
  client.messages.length = 0;
  const expectQueueError = async (payload, expected, label) => {
    client.send(payload);
    const message = await client.waitFor((m) => m.type === "error" && m.message === expected, 5000, label);
    assert(message.message === expected, `${label}: ${expected}`);
  };
  await expectQueueError(
    { type: "queueAdd", deviceId: device.id, path: "../escape.mp4" },
    "路径非法",
    "队列拒绝越界路径",
  );
  await expectQueueError(
    { type: "queueAdd", deviceId: device.id, path: "missing.mp4" },
    "文件不存在",
    "队列拒绝不存在文件",
  );
  await expectQueueError(
    { type: "queueAdd", deviceId: device.id, path: "notes.txt" },
    "只能把视频加入队列",
    "队列拒绝非视频文件",
  );
  await expectQueueError(
    { type: "queueAdd", deviceId: "not-a-device", path: names[0] },
    "设备不存在",
    "队列拒绝未知设备",
  );
  assert(client.messages.filter((m) => m.type === "queue").length === 0, "非法 queueAdd 均未创建队列");
  fake.lines.length = 0;
  client.messages.length = 0;
  client.send({ type: "queueAdd", deviceId: device.id, path: names[0] });
  const first = await waitQueue(
    client,
    device.id,
    (q) => q.items.length === 1 && q.currentIndex === 0,
    5000,
    "第一项进入队列并立即开始",
  );
  assert(first.queue.items[0].name === names[0], `队列第一项名称=${first.queue.items[0].name}`);
  const firstPlaying = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "playing",
    15000,
    "第一项 tvStatus=playing",
  );
  assert(firstPlaying.durationMs === DURATION_MS, `第一项播放中 duration=${firstPlaying.durationMs}ms`);
  await waitUnitCount(fake.lines, "DIDL_RECEIVED ", 1);
  await waitUnitCount(fake.lines, "SUBTITLE_URL_COUNT 1", 1);
  assert(countLines(fake.lines, "SUBTITLE_URL_COUNT 1") === 1, "第一项只输出一条字幕 URL");

  console.log("[5/8] 播放中追加 B/C，顺序正确且不打断 A ...");
  client.send({ type: "queueAdd", deviceId: device.id, path: names[1] });
  await waitQueue(client, device.id, (q) => q.items.length === 2, 5000, "第二项入队");
  client.send({ type: "queueAdd", deviceId: device.id, path: names[2] });
  const three = await waitQueue(client, device.id, (q) => q.items.length === 3, 5000, "第三项入队");
  assert(three.queue.items.map((item) => item.name).join(",") === names.join(","), "队列顺序为 A,B,C");
  assert(three.queue.currentIndex === 0, "追加 B/C 不打断当前 A");
  assert(countLines(fake.lines, "DIDL_RECEIVED ") === 1, "追加队列没有触发额外投屏");

  console.log("[6/8] A 自然结束自动播 B，B 结束播 C，C 结束 completed ...");
  const secondPlaying = await waitQueue(
    client,
    device.id,
    (q) => q.currentIndex === 1 && q.state === "playing",
    15000,
    "自动切到第二项",
  );
  assert(secondPlaying.queue.currentIndex === 1, "第一项自然结束后 currentIndex=1");
  await waitUnitCount(fake.lines, "DIDL_RECEIVED ", 2);
  const thirdPlaying = await waitQueue(
    client,
    device.id,
    (q) => q.currentIndex === 2 && q.state === "playing",
    15000,
    "自动切到第三项",
  );
  assert(thirdPlaying.queue.currentIndex === 2, "第二项自然结束后 currentIndex=2");
  await waitUnitCount(fake.lines, "DIDL_RECEIVED ", 3);
  const completed = await waitQueue(
    client,
    device.id,
    (q) => q.currentIndex === 2 && q.state === "completed",
    15000,
    "队列完成",
  );
  assert(completed.queue.items.length === 3, "队列完成后仍保留 3 项");
  assert(countLines(fake.lines, "DIDL_RECEIVED ") === 3, "每个队列项只投屏一次");
  await sleep(DURATION_MS + 1000);
  assert(countLines(fake.lines, "DIDL_RECEIVED ") === 3, "completed 后不重播第一项");
  assert(completed.queue.state === "completed", "completed 后状态不被自动改写");

  console.log("[7/8] 手动 stop 后不自动跳下一项，队列保留 paused ...");
  client.messages.length = 0;
  client.send({ type: "queueClear", deviceId: device.id });
  await waitQueue(client, device.id, (q) => q.items.length === 0, 5000, "清空旧队列");
  fake.lines.length = 0;
  client.messages.length = 0;
  client.send({ type: "queueAdd", deviceId: device.id, path: names[0] });
  await waitQueue(client, device.id, (q) => q.items.length === 1 && q.currentIndex === 0, 5000, "重新加入 A");
  await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "playing",
    15000,
    "重新播放 A",
  );
  client.send({ type: "queueAdd", deviceId: device.id, path: names[1] });
  await waitQueue(client, device.id, (q) => q.items.length === 2, 5000, "加入 B");
  client.send({ type: "control", deviceId: device.id, action: "stop" });
  const paused = await waitQueue(
    client,
    device.id,
    (q) => q.state === "paused" && q.currentIndex === 0,
    8000,
    "stop 后队列 paused",
  );
  assert(paused.queue.items.length === 2, "stop 后队列保留 2 项");
  const didlAfterStop = countLines(fake.lines, "DIDL_RECEIVED ");
  await sleep(DURATION_MS + 1000);
  assert(countLines(fake.lines, "DIDL_RECEIVED ") === didlAfterStop, "stop 后等待超过时长不自动跳下一项");
  const stillPaused = await waitQueue(
    client,
    device.id,
    (q) => q.state === "paused" && q.currentIndex === 0,
    2000,
    "仍然 paused",
  );
  assert(stillPaused.queue.items.length === 2, "stop 后队列仍为 paused");

  console.log("[8/8] queueRemove / queueClear / 普通 cast 清空队列 ...");
  client.send({ type: "queueRemove", deviceId: device.id, index: 1 });
  const removed = await waitQueue(client, device.id, (q) => q.items.length === 1, 5000, "移除第二项");
  assert(removed.queue.items[0].name === names[0], "queueRemove 后只剩第一项");
  client.messages.length = 0;
  client.send({ type: "queuePlay", deviceId: device.id });
  await waitQueue(client, device.id, (q) => q.state === "playing" && q.currentIndex === 0, 15000, "queuePlay 继续播放");
  client.send({ type: "control", deviceId: device.id, action: "stop" });
  await waitQueue(client, device.id, (q) => q.state === "paused", 8000, "继续后再次 stop");
  client.send({ type: "queueClear", deviceId: device.id });
  await waitQueue(client, device.id, (q) => q.items.length === 0, 5000, "queueClear 清空");

  client.messages.length = 0;
  fake.lines.length = 0;
  client.send({ type: "queueAdd", deviceId: device.id, path: names[0] });
  await waitQueue(
    client,
    device.id,
    (q) => q.items.length === 1 && q.state === "playing",
    10000,
    "普通投屏前 A 播放中",
  );
  client.send({ type: "queueAdd", deviceId: device.id, path: names[1] });
  await waitQueue(client, device.id, (q) => q.items.length === 2, 5000, "普通投屏前加入 B");
  fake.lines.length = 0;
  client.send({ type: "cast", deviceId: device.id, path: names[2] });
  const clearedByCast = await waitQueue(client, device.id, (q) => q.items.length === 0, 5000, "普通 cast 清空队列");
  assert(clearedByCast.queue.state === "idle", "普通 cast 后队列为空且 idle");
  const castPlaying = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "playing",
    15000,
    "普通 cast 播放 C",
  );
  assert(castPlaying.durationMs === DURATION_MS, "普通 cast 播放的仍是 C");
  // 清空 fake.lines 时队列里 B 的投屏命令可能仍在管道中，按“C 的 DIDL 之后”统计，避免混入上一项的输出。
  const castDidlIndex = await waitForLineIndex(fake.lines, (line) => line.startsWith("DIDL_RECEIVED ") && line.includes(names[2]), 8000);
  await waitUnitCount(fake.lines.slice(castDidlIndex), "SUBTITLE_URL_COUNT ", 1);
  await sleep(300);
  const castTail = fake.lines.slice(castDidlIndex);
  assert(countLines(castTail, "SUBTITLE_URL_COUNT 1") === 1, "普通 cast 也只输出一条字幕 URL");

  client.close();
  await stopHub(server);
  console.log("\n✅ E2E-QUEUE 全部通过");
}

main()
  .then(() => {
    cleanup();
    setTimeout(() => process.exit(0), 300);
  })
  .catch((error) => {
    console.error("\n❌ E2E-QUEUE 失败:", error.message);
    cleanup();
    setTimeout(() => process.exit(1), 300);
  });
