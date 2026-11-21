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
// 本环境没有真实 ffmpeg/ffprobe：给中枢注入 fake 工具，让 auto 模式稳定走“无内嵌轨→外挂字幕”的既有断言路径。
const FAKE_FFPROBE = path.join(SERVER_DIR, "scripts", "fake-ffprobe.mjs");
const FAKE_FFMPEG = path.join(SERVER_DIR, "scripts", "fake-ffmpeg.mjs");
const PROFILE_DEVICES = [
  { key: "samsung", deviceName: "Fake DLNA TV", manufacturer: "Samsung Electronics", modelName: "UN55", modelNumber: "SAMSUNG-1", ssdp: true },
  { key: "panasonic", deviceName: "Fake Panasonic TV", manufacturer: "Panasonic Corporation", modelName: "VIERA", modelNumber: "PANASONIC-1", ssdp: false },
  { key: "lg", deviceName: "Fake LG TV", manufacturer: "LG Electronics", modelName: "webOS TV", modelNumber: "LG-1", ssdp: false },
  { key: "generic", deviceName: "Fake Generic TV", manufacturer: "Acme Display", modelName: "Generic One", modelNumber: "GENERIC-1", ssdp: false },
  { key: "sony", deviceName: "Fake Sony TV", manufacturer: "Sony Corporation", modelName: "BRAVIA", modelNumber: "SONY-1", ssdp: false }
];

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
      FFPROBE_PATH: FAKE_FFPROBE,
      FFMPEG_PATH: FAKE_FFMPEG,
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
  fs.writeFileSync(path.join(mediaDir, "profiles.mp4"), Buffer.alloc(256 * 1024, 0x1b));
  fs.writeFileSync(
    path.join(mediaDir, "profiles.srt"),
    "1\n00:00:01,000 --> 00:00:03,000\nProfile subtitle\n",
    "utf8"
  );
  fs.writeFileSync(
    path.join(mediaDir, "sample.srt"),
    "1\n00:00:01,000 --> 00:00:03,000\n测试字幕第一行\n\n2\n00:00:04,000 --> 00:00:06,000\n测试字幕第二行\n",
    "utf8"
  );
  console.log("测试媒体目录:", mediaDir);
  console.log("测试 DATA_DIR:", dataDir, "（两代 hub 共用）");

  console.log("\n[1/13] 启动 fake-dlna（五种字幕 profile）...");
  const fakes = new Map();
  for (const profile of PROFILE_DEVICES) {
    const fake = startProcess("fake-" + profile.key, ["scripts/fake-dlna.mjs"], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        FAKE_DLNA_HTTP_PORT: "0",
        FAKE_DLNA_NAME: profile.deviceName,
        FAKE_DLNA_MANUFACTURER: profile.manufacturer,
        FAKE_DLNA_MODEL_NAME: profile.modelName,
        FAKE_DLNA_MODEL_NUMBER: profile.modelNumber,
        FAKE_DLNA_SSDP_PORT: profile.ssdp ? "1900" : "0"
      }
    });
    const locationLine = await fake.waitFor(/^LOCATION /, 10000, profile.key + " LOCATION");
    profile.location = locationLine.replace(/^LOCATION /, "").trim();
    await fake.waitFor(/FAKE_DLNA_READY/, 5000, profile.key + " ready");
    fakes.set(profile.key, fake);
    console.log("fake-dlna[" + profile.key + "] LOCATION:", profile.location);
  }
  const fake = fakes.get("samsung");
  const seedLocations = PROFILE_DEVICES.map((profile) => profile.location).join(",");

  console.log("[2/13] 启动中枢 ...");
  let server = startHub(mediaDir, { DATA_DIR: dataDir });
  await server.waitFor(/CastHub 已启动/, 20000, "中枢启动");
  await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);

  console.log("[3/13] 连接控制台并等待 DLNA 自动发现 ...");
  let client = await connectConsole();
  let dlnaMsg;
  try {
    dlnaMsg = await waitDlnaDevice(client, 8000);
  } catch (error) {
    console.log("⚠ 8s 内未自动发现 DLNA（多播可能受限），降级为 DLNA_SEED 重启中枢");
    client.close();
    await stopHub(server);
    server = startHub(mediaDir, { DLNA_SEED: seedLocations, DATA_DIR: dataDir });
    await server.waitFor(/CastHub 已启动/, 20000, "seed 中枢启动");
    await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);
    client = await connectConsole();
    dlnaMsg = await waitDlnaDevice(client, 8000);
    console.log("DLNA_SEED 降级路径生效");
  }
  const device = dlnaMsg.list.find(isFakeDlnaDevice);
  assert(!!device, `DLNA 设备出现: ${device.deviceName} (${device.id})`);
  assert(device.deviceName === FAKE_DEVICE_NAME, "deviceName 来自 device.xml friendlyName");

  console.log("[4/13] 浏览文件 ...");
  const fileRes = await fetch(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`, { headers: { "x-casthub-token": CONSOLE_TOKEN } });
  const fileJson = await fileRes.json();
  const video = fileJson.entries.find((entry) => entry.name === "sample.mp4");
  const profilesVideo = fileJson.entries.find((entry) => entry.name === "profiles.mp4");
  assert(!!video, `/api/files 返回视频: ${video.name} (${video.size} bytes, ${video.mimeType})`);
  assert(!!profilesVideo, `/api/files 返回 profile 视频: ${profilesVideo.name}`);

  console.log("[5/13] cast 到 DLNA 设备 ...");
  client.send({ type: "cast", deviceId: device.id, path: video.path });
  const playing = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "playing",
    15000,
    "tvStatus=playing"
  );
  assert(playing.durationMs > 0, `DLNA 进入 playing（duration=${playing.durationMs}ms）`);
  await fake.waitFor(/MEDIA_PROBE 206/, 5000, "fake-dlna Range 探测 206");

  console.log("[5.0/13] 验证 Samsung 字幕 DIDL 与 CaptionInfo.sec ...");
  const didlLine = await fake.waitFor(/^DIDL_RECEIVED /, 5000, "fake-dlna 收到 DIDL");
  const didl = didlLine.replace(/^DIDL_RECEIVED /, "");
  assert(didl.includes('xmlns:sec="http://www.samsung.com/sec/"'), "Samsung DIDL 声明 sec 命名空间");
  assert(!didl.includes('xmlns:pv="http://www.pv.com/pvns/"'), "Samsung DIDL 不含 pv 命名空间");
  assert(
    didl.includes('<sec:CaptionInfoEx protocolInfo="http-get:*:application/x-srt:*" sec:type="srt">'),
    "DIDL 含属性式 sec:CaptionInfoEx（sec:type=\"srt\"）"
  );
  assert(!didl.includes("pv:subtitleFileUri"), "Samsung DIDL 不含独立 pv:subtitleFileUri");
  const samsungCount = await fake.waitFor(/^SUBTITLE_URL_COUNT /, 5000, "Samsung 字幕 URL 数量");
  assert(samsungCount === "SUBTITLE_URL_COUNT 1", "Samsung 场景只输出一条字幕 URL");
  const captionHeadLine = await fake.waitFor(
    /^CAPTION_HEADER HEAD 200 http:\/\/.+\/api\/subtitle\?/,
    5000,
    "HEAD 响应含 CaptionInfo.sec"
  );
  const captionHeaderUrl = captionHeadLine.split(" ")[3];
  assert(captionHeaderUrl.includes("/api/subtitle?path=sample.srt"), `HEAD CaptionInfo.sec 指向字幕 URL: ${captionHeaderUrl}`);
  const subtitleGet0 = await fake.waitFor(/^SUBTITLE_GET \[0\] 200 /, 5000, "字幕 URL[0] GET 200");
  assert(subtitleGet0.includes("application/x-subrip"), "字幕[0] Content-Type 为 application/x-subrip");
  const subtitleText = await fake.waitFor(/^SUBTITLE_TEXT \[0\] /, 5000, "字幕内容为 UTF-8 文本");
  assert(subtitleText.includes("00:00:01,000") && subtitleText.includes("测试字幕第一行"), "字幕内容按 UTF-8 下发");
  await sleep(300);
  assert(!fake.lines.some((line) => line.startsWith("SUBTITLE_GET [1]")), "Samsung 场景只请求一次字幕 URL");

  console.log("[5.1/13] 验证 RenderingControl 初始音量与 SetVolume ...");
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

  console.log("[5.2/13] 验证 subtitles=false 不推送字幕 ...");
  fake.lines.length = 0;
  client.messages.length = 0;
  client.send({ type: "cast", deviceId: device.id, path: video.path, subtitles: false });
  await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "playing",
    15000,
    "subtitles=false 重新起播"
  );
  const noSubCount = await fake.waitFor(/^SUBTITLE_URL_COUNT /, 5000, "subtitles=false 字幕 URL 数量");
  assert(noSubCount === "SUBTITLE_URL_COUNT 0", "subtitles=false 时字幕 URL 数量为 0");
  const noSubDidlLine = await fake.waitFor(/^DIDL_RECEIVED /, 5000, "subtitles=false DIDL");
  const noSubDidl = noSubDidlLine.replace(/^DIDL_RECEIVED /, "");
  assert(!noSubDidl.includes("CaptionInfoEx"), "subtitles=false 时 DIDL 不含 CaptionInfoEx");
  assert(!noSubDidl.includes("subtitleFileUri"), "subtitles=false 时 DIDL 不含 subtitleFileUri");
  const noSubHead = await fake.waitFor(/^CAPTION_HEADER HEAD /, 5000, "subtitles=false HEAD 响应");
  assert(noSubHead.endsWith(" -"), "subtitles=false 时 HEAD 响应无 CaptionInfo.sec 头");
  assert(!fake.lines.some((line) => line.startsWith("SUBTITLE_GET")), "subtitles=false 时未请求字幕 URL");

  console.log("[6/13] pause ...");
  client.send({ type: "control", deviceId: device.id, action: "pause" });
  const paused = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "paused",
    6000,
    "tvStatus=paused"
  );
  assert(paused.state === "paused", "pause 生效，tvStatus=paused");

  console.log("[7/13] seek 30000 ...");
  client.send({ type: "control", deviceId: device.id, action: "seek", positionMs: 30000 });
  const seeked = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.positionMs >= 29000 && m.positionMs <= 35000,
    6000,
    "tvStatus positionMs∈[29000,35000]"
  );
  assert(true, `seek 生效 positionMs=${seeked.positionMs}`);

  console.log("[8/13] stop ...");
  client.send({ type: "control", deviceId: device.id, action: "stop" });
  const stopped = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "idle",
    6000,
    "tvStatus=idle"
  );
  assert(stopped.state === "idle", "stop 生效，tvStatus=idle");

  console.log("[9/13] 等待中枢真正退出后用同一 DATA_DIR 重启 ...");
  client.close();
  await stopHub(server);
  server = startHub(mediaDir, { DLNA_SEED: seedLocations, DATA_DIR: dataDir });
  await server.waitFor(/CastHub 已启动/, 20000, "重启中枢启动");
  await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);
  client = await connectConsole();
  const seededDevices = await client.waitFor(
    (m) => m.type === "devices" && Array.isArray(m.list) && PROFILE_DEVICES.every((profile) => m.list.some((d) => d.type === "dlna" && d.deviceName === profile.deviceName)),
    10000,
    "五种 DLNA profile 设备全部出现"
  );
  const device2 = seededDevices.list.find(isFakeDlnaDevice);
  assert(!!device2, `重启后 DLNA 设备出现: ${device2.deviceName} (${device2.id})`);

  console.log("[10/13] getHistory 断言重启后历史仍在 ...");
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
    `getHistory positionMs=${historyEntry.positionMs} ∈ [29500,60000]`
  );
  assert(historyEntry.durationMs === 60000, `getHistory durationMs=${historyEntry.durationMs}`);
  assert(historyEntry.playCount >= 1, `getHistory playCount=${historyEntry.playCount}`);

  console.log("[11/13] cast(resume=true) 断言 DLNA 续播生效 ...");
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

  console.log("[12/13] cast(resume=false) 从头播放并清理 ...");
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

  console.log("[13/13] 验证 Panasonic / LG / Generic / Sony 字幕 profile ...");
  for (const profile of PROFILE_DEVICES.filter((item) => item.key !== "samsung")) {
    const profileDevice = seededDevices.list.find((d) => d.type === "dlna" && d.deviceName === profile.deviceName);
    assert(!!profileDevice, `profile 设备存在: ${profile.deviceName}`);
    const profileFake = fakes.get(profile.key);
    profileFake.lines.length = 0;
    client.messages.length = 0;
    client.send({ type: "cast", deviceId: profileDevice.id, path: profilesVideo.path });
    await client.waitFor(
      (m) => m.type === "tvStatus" && m.deviceId === profileDevice.id && m.state === "playing",
      15000,
      profile.key + " tvStatus=playing"
    );
    const profileDidlLine = await profileFake.waitFor(/^DIDL_RECEIVED /, 5000, profile.key + " DIDL");
    const profileDidl = profileDidlLine.replace(/^DIDL_RECEIVED /, "");
    const profileCount = await profileFake.waitFor(/^SUBTITLE_URL_COUNT /, 5000, profile.key + " 字幕数量");
    if (profile.key === "panasonic") {
      assert(profileCount === "SUBTITLE_URL_COUNT 1", "Panasonic 只输出一条字幕 URL");
      assert(!profileDidl.includes("sec:CaptionInfoEx"), "Panasonic DIDL 不含 sec:CaptionInfoEx");
      assert(!profileDidl.includes("<pv:subtitleFileUri>"), "Panasonic 不输出独立 pv 元素");
      assert(profileDidl.includes('pv:subtitleFileUri="http://'), "Panasonic 视频 res 含 pv:subtitleFileUri 属性");
      assert(profileDidl.includes('pv:subtitleFileType="SRT"'), "Panasonic pv:subtitleFileType=SRT");
    } else if (profile.key === "lg" || profile.key === "generic") {
      assert(profileCount === "SUBTITLE_URL_COUNT 1", profile.key + " 只输出一条字幕 URL");
      assert(!profileDidl.includes("sec:CaptionInfoEx"), profile.key + " DIDL 不含 sec:CaptionInfoEx");
      assert(!profileDidl.includes("pv:subtitleFileUri"), profile.key + " DIDL 不含 pv:subtitleFileUri");
      assert(profileDidl.includes('<res protocolInfo="http-get:*:text/srt:*">'), profile.key + " 输出 text/srt res");
    } else if (profile.key === "sony") {
      assert(profileCount === "SUBTITLE_URL_COUNT 0", "Sony 不输出字幕 URL");
      assert(!profileDidl.includes("sec:CaptionInfoEx"), "Sony DIDL 不含 sec:CaptionInfoEx");
      assert(!profileDidl.includes("pv:subtitleFileUri"), "Sony DIDL 不含 pv:subtitleFileUri");
      assert(!profileDidl.includes("text/srt"), "Sony DIDL 不含 text/srt res");
    }
    if (profile.key === "sony") {
      await sleep(500);
      assert(!profileFake.lines.some((line) => line.startsWith("SUBTITLE_GET")), "Sony 未请求字幕 URL");
    } else {
      const profileGet = await profileFake.waitFor(/^SUBTITLE_GET \[0\] 200 /, 5000, profile.key + " 字幕 GET 200");
      assert(profileGet.includes("application/x-subrip"), profile.key + " 字幕 Content-Type 为 application/x-subrip");
    }
    client.send({ type: "control", deviceId: profileDevice.id, action: "stop" });
    await sleep(300);
  }
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
