#!/usr/bin/env node
// CastHub Phase13 内嵌字幕端到端测试：纯函数 + /api/embedded-* + DLNA 三模式。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  classifyEmbeddedSubtitleCodec,
  cleanupEmbeddedCache,
  clearEmbeddedProbeCache,
  createSubtitleStrippedVideo,
  detectEmbeddedSubtitleTools,
  extractEmbeddedSubtitleToSrt,
  parseEmbeddedSubtitleProbe,
  probeEmbeddedSubtitles,
  selectEmbeddedSubtitleTrack
} from "../src/embedded-subtitles.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const HTTP_PORT = Number(process.env.E2E_EMBEDDED_PORT ?? 9434);
const CONSOLE_TOKEN = "e2e-embedded-token-2024";
const FAKE_FFPROBE = path.join(SERVER_DIR, "scripts", "fake-ffprobe.mjs");
const FAKE_FFMPEG = path.join(SERVER_DIR, "scripts", "fake-ffmpeg.mjs");
const FAKE_FFPROBE_HANG = path.join(SERVER_DIR, "scripts", "fake-ffprobe-hang.mjs");
const FAKE_DEVICE_NAME = "Fake DLNA TV";
const children = [];
let exiting = false;

process.env.FFPROBE_PATH = FAKE_FFPROBE;
process.env.FFMPEG_PATH = FAKE_FFMPEG;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanup() {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    try { child.kill(); } catch { /* ignore */ }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(130); });

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

function startHub(mediaDir, dataDir, seedLocation) {
  return startProcess("server", ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(HTTP_PORT),
      HOST: "127.0.0.1",
      MEDIA_DIR: mediaDir,
      DATA_DIR: dataDir,
      PUBLIC_BASE_URL: "",
      CONSOLE_TOKEN,
      DLNA_ALLOW_LOOPBACK: "1",
      DLNA_SEED: seedLocation,
      FFPROBE_PATH: FAKE_FFPROBE,
      FFMPEG_PATH: FAKE_FFMPEG
    }
  });
}

async function waitForHttp(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { "x-casthub-token": CONSOLE_TOKEN } });
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error("服务未就绪: " + url);
}

async function stopHub(handle) {
  const child = handle.child;
  if (child.exitCode !== null) return child.exitCode;
  const exitPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
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

class ConsoleClient {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
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
  send(payload) { this.ws.send(JSON.stringify(payload)); }
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
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function writeProbeSidecar(videoPath, streams) {
  fs.writeFileSync(videoPath + ".ffprobe.json", JSON.stringify({ streams }), "utf8");
}

function textStream(index, codecName = "subrip", extra = {}) {
  return { index, codec_type: "subtitle", codec_name: codecName, ...extra };
}

function decodeXml(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
}

function didlResUrl(didl) {
  const match = /<res\b[^>]*>([^<]+)<\/res>/i.exec(didl);
  assert.ok(match, "DIDL 包含视频 res URL");
  return decodeXml(match[1]);
}

function didlSubtitleUrl(didl) {
  const match = /<sec:CaptionInfoEx\b[^>]*>([^<]+)<\/sec:CaptionInfoEx>/i.exec(didl);
  if (!match) return null;
  return decodeXml(match[1]);
}

async function castAndWait(client, fake, device, filePath, extra, label) {
  client.messages.length = 0;
  fake.lines.length = 0;
  client.send({ type: "cast", deviceId: device.id, path: filePath, ...extra });
  const playing = await client.waitFor(
    (m) => m.type === "tvStatus" && m.deviceId === device.id && m.state === "playing",
    20000,
    label + " tvStatus=playing"
  );
  assert(playing.state === "playing", label + " 进入 playing");
  return playing;
}

async function castExpectError(client, fake, device, filePath, extra, label) {
  client.messages.length = 0;
  fake.lines.length = 0;
  client.send({ type: "cast", deviceId: device.id, path: filePath, ...extra });
  const error = await client.waitFor((m) => m.type === "error", 15000, label + " error");
  await sleep(300);
  assert(!client.messages.some((m) => m.type === "tvStatus" && m.state === "playing"), label + " 未进入 playing");
  assert(!fake.lines.some((line) => line.startsWith("DIDL_RECEIVED ")), label + " 未发送 DIDL");
  return error;
}

function assertCount(line, expected, label) {
  assert.equal(line, "SUBTITLE_URL_COUNT " + expected, label + " 字幕 URL 数量为 " + expected);
}

async function unitTests(tempDir) {
  console.log("== 单元：ffprobe 解析与轨道分类 ==");
  const sample = {
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264" },
      textStream(2, "subrip", { tags: { language: "chi", title: "中文字幕" }, disposition: { default: 1, forced: 0 } }),
      textStream(3, "ass", { tags: { Language: "eng" }, disposition: { forced: 1 } }),
      textStream(4, "hdmv_pgs_subtitle", { tags: { language: "jpn" } }),
      { index: 5, codec_type: "audio", codec_name: "aac" }
    ]
  };
  const parsed = parseEmbeddedSubtitleProbe(JSON.stringify(sample));
  assert.equal(parsed.available, true, "有效 JSON available=true");
  assert.equal(parsed.tracks.length, 3, "只保留字幕流");
  assert.deepEqual(parsed.tracks.map((track) => track.streamIndex), [2, 3, 4], "按 streamIndex 升序");
  assert.equal(parsed.tracks[0].kind, "text", "subrip 分类为 text");
  assert.equal(parsed.tracks[1].kind, "text", "ass 分类为 text");
  assert.equal(parsed.tracks[2].kind, "bitmap", "hdmv_pgs_subtitle 分类为 bitmap");
  assert.equal(parsed.tracks[0].language, "chi", "language 标签读取");
  assert.equal(parsed.tracks[0].title, "中文字幕", "title 标签读取");
  assert.equal(parsed.tracks[0].isDefault, true, "default disposition 读取");
  assert.equal(parsed.tracks[1].isForced, true, "forced disposition 读取");
  assert.equal(classifyEmbeddedSubtitleCodec("mov_text"), "text", "mov_text 分类");
  assert.equal(classifyEmbeddedSubtitleCodec("dvd_subtitle"), "bitmap", "dvd_subtitle 分类");
  assert.equal(classifyEmbeddedSubtitleCodec("weird_codec"), "unknown", "未知编码分类");

  assert.equal(parseEmbeddedSubtitleProbe("{bad json").available, false, "非法 JSON available=false");
  const empty = parseEmbeddedSubtitleProbe('{"streams":[]}');
  assert.equal(empty.available, true, "空 streams available=true");
  assert.equal(empty.tracks.length, 0, "空 streams 无轨道");
  assert.equal(parseEmbeddedSubtitleProbe("{}").available, true, "缺少 streams 视为无字幕");
  assert.equal(parseEmbeddedSubtitleProbe('{"streams":{}}').available, false, "非数组 streams 报错");

  console.log("== 单元：轨道选择优先级 ==");
  const tracks = [
    { streamIndex: 1, codecName: "subrip", kind: "text", language: "eng", title: null, isDefault: false, isForced: false },
    { streamIndex: 2, codecName: "subrip", kind: "text", language: "zh", title: null, isDefault: false, isForced: false },
    { streamIndex: 3, codecName: "ass", kind: "text", language: "jpn", title: null, isDefault: true, isForced: false },
    { streamIndex: 4, codecName: "hdmv_pgs_subtitle", kind: "bitmap", language: "eng", title: null, isDefault: true, isForced: false },
    { streamIndex: 5, codecName: "subrip", kind: "text", language: "eng", title: null, isDefault: false, isForced: true }
  ];
  assert.equal((await selectEmbeddedSubtitleTrack(tracks)).streamIndex, 3, "default 非 forced 优先");
  assert.equal((await selectEmbeddedSubtitleTrack(tracks, { requestedStreamIndex: 2 })).streamIndex, 2, "显式文本索引优先");
  assert.equal(await selectEmbeddedSubtitleTrack(tracks, { requestedStreamIndex: 4 }), null, "显式图片索引不 fallback");
  assert.equal(await selectEmbeddedSubtitleTrack(tracks, { requestedStreamIndex: 99 }), null, "显式不存在索引返回 null");
  assert.equal((await selectEmbeddedSubtitleTrack([tracks[0], tracks[1]], { preferredLanguages: ["zh"] })).streamIndex, 2, "语言偏好选择 zh");
  assert.equal((await selectEmbeddedSubtitleTrack([tracks[0], tracks[4]], { preferredLanguages: ["zh"] })).streamIndex, 0 + 1, "非 forced 优先于 forced");
  assert.equal(await selectEmbeddedSubtitleTrack([tracks[3]]), null, "只有图片轨返回 null");
  assert.equal((await selectEmbeddedSubtitleTrack([tracks[4]])).streamIndex, 5, "只有 forced 文本轨时选择 forced");

  console.log("== 单元：fake ffprobe 探测与缓存键 ==");
  const probeDir = path.join(tempDir, "probe");
  fs.mkdirSync(probeDir, { recursive: true });
  const probeVideo = path.join(probeDir, "cache.mp4");
  fs.writeFileSync(probeVideo, Buffer.alloc(256, 0x41));
  writeProbeSidecar(probeVideo, [textStream(2, "subrip", { tags: { language: "eng" } })]);
  clearEmbeddedProbeCache();
  const firstProbe = await probeEmbeddedSubtitles(probeVideo);
  assert.equal(firstProbe.available, true, "真实 fake ffprobe 可用");
  assert.equal(firstProbe.tracks.length, 1, "首次探测读取 sidecar");
  writeProbeSidecar(probeVideo, [
    textStream(2, "subrip", { tags: { language: "eng" } }),
    textStream(3, "ass", { tags: { language: "zh" } })
  ]);
  const cachedProbe = await probeEmbeddedSubtitles(probeVideo);
  assert.equal(cachedProbe.tracks.length, 1, "同 size/mtime 复用探测缓存");
  fs.appendFileSync(probeVideo, Buffer.from([0x42]));
  const sizeChangedProbe = await probeEmbeddedSubtitles(probeVideo);
  assert.equal(sizeChangedProbe.tracks.length, 2, "size 变化使缓存失效");
  fs.utimesSync(probeVideo, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
  writeProbeSidecar(probeVideo, [textStream(2, "subrip"), textStream(3, "ass"), textStream(4, "mov_text")]);
  const mtimeChangedProbe = await probeEmbeddedSubtitles(probeVideo);
  assert.equal(mtimeChangedProbe.tracks.length, 3, "mtime 变化使缓存失效");
  const exitVideo = path.join(probeDir, "exit-fail.mp4");
  fs.writeFileSync(exitVideo, Buffer.alloc(32, 0x44));
  fs.writeFileSync(exitVideo + ".ffprobe-fail", "1");
  const exitProbe = await probeEmbeddedSubtitles(exitVideo);
  assert.equal(exitProbe.available, false, "ffprobe 非 0 退出 available=false");
  assert.match(exitProbe.error, /ffprobe 失败/, "ffprobe 非 0 退出带错误信息");
  const hangVideo = path.join(probeDir, "hang.mp4");
  fs.writeFileSync(hangVideo, Buffer.alloc(32, 0x45));
  const previousFfprobe = process.env.FFPROBE_PATH;
  process.env.FFPROBE_PATH = FAKE_FFPROBE_HANG;
  const hangStartedAt = Date.now();
  const timeoutProbe = await probeEmbeddedSubtitles(hangVideo);
  process.env.FFPROBE_PATH = previousFfprobe;
  assert.equal(timeoutProbe.available, false, "ffprobe 超时 available=false");
  assert.match(timeoutProbe.error, /超时/, "ffprobe 超时带错误信息");
  assert.ok(Date.now() - hangStartedAt >= 14900, "ffprobe 超时实际等待 15s 保护");

  console.log("== 单元：抽取、去字幕副本、清理与工具检测 ==");
  const cacheDir = path.join(tempDir, "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const textTrack = {
    streamIndex: 2,
    codecName: "subrip",
    kind: "text",
    language: "chi",
    title: null,
    isDefault: true,
    isForced: false
  };
  const extracted = await extractEmbeddedSubtitleToSrt(probeVideo, textTrack, { cacheDir, ffmpegPath: FAKE_FFMPEG });
  assert.ok(fs.existsSync(extracted.srtPath), "抽取生成 SRT");
  assert.ok(fs.readFileSync(extracted.srtPath, "utf8").includes("内嵌字幕测试"), "SRT 内容正确");
  const extractedAgain = await extractEmbeddedSubtitleToSrt(probeVideo, textTrack, { cacheDir, ffmpegPath: FAKE_FFMPEG });
  assert.equal(extractedAgain.srtPath, extracted.srtPath, "重复抽取复用缓存");
  const stripped = await createSubtitleStrippedVideo(probeVideo, {
    cacheDir,
    ffmpegPath: FAKE_FFMPEG,
    cacheKey: path.basename(extracted.srtPath)
  });
  assert.ok(stripped.videoPath.endsWith(".nosubs.mp4"), "去字幕副本保留扩展名");
  assert.equal(fs.readFileSync(stripped.videoPath).length, fs.readFileSync(probeVideo).length, "去字幕副本复制视频内容");
  await assert.rejects(
    extractEmbeddedSubtitleToSrt(probeVideo, { ...textTrack, kind: "bitmap", codecName: "hdmv_pgs_subtitle" }, { cacheDir, ffmpegPath: FAKE_FFMPEG }),
    /不是文本字幕/,
    "图片轨拒绝抽取"
  );
  const failVideo = path.join(probeDir, "fail.mp4");
  fs.writeFileSync(failVideo, Buffer.alloc(64, 0x33));
  fs.writeFileSync(failVideo + ".ffmpeg-fail", "1");
  await assert.rejects(
    extractEmbeddedSubtitleToSrt(failVideo, textTrack, { cacheDir, ffmpegPath: FAKE_FFMPEG }),
    /ffmpeg 抽取字幕失败/,
    "ffmpeg 失败时抽取报错"
  );
  const oldFile = path.join(cacheDir, "old.srt");
  const newFile = path.join(cacheDir, "new.srt");
  fs.writeFileSync(oldFile, "old");
  fs.writeFileSync(newFile, "new");
  fs.utimesSync(oldFile, new Date(2000, 0, 1), new Date(2000, 0, 1));
  const removed = await cleanupEmbeddedCache(cacheDir, 7 * 24 * 60 * 60 * 1000);
  assert.ok(removed >= 1, "清理删除过期缓存文件");
  assert.equal(fs.existsSync(oldFile), false, "过期文件已删除");
  assert.equal(fs.existsSync(newFile), true, "新文件保留");
  const tools = await detectEmbeddedSubtitleTools();
  assert.equal(tools.ffprobe, true, "检测 fake ffprobe 可用");
  assert.equal(tools.ffmpeg, true, "检测 fake ffmpeg 可用");
}

async function main() {
  const realFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore", shell: false }).status === 0;
  const realFfprobe = spawnSync("ffprobe", ["-version"], { stdio: "ignore", shell: false }).status === 0;
  console.log("真实 ffmpeg 可用:", realFfmpeg, "真实 ffprobe 可用:", realFfprobe);
  if (!realFfmpeg || !realFfprobe) {
    console.log("SKIP 真实 ffmpeg 转码：未检测到 ffmpeg/ffprobe；确定性的 fake 工具已覆盖探测、抽取、路由与 DIDL 断言，相关断言未跳过。");
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-e2e-embedded-"));
  const mediaDir = path.join(tempDir, "media");
  const dataDir = path.join(tempDir, "data-root");
  fs.mkdirSync(mediaDir, { recursive: true });
  console.log("测试媒体目录:", mediaDir);
  console.log("测试 DATA_DIR:", dataDir);

  await unitTests(tempDir);

  console.log("== 集成准备：fake DLNA 与媒体文件 ==");
  const autoEmbedded = path.join(mediaDir, "auto-embedded.mp4");
  const autoExternal = path.join(mediaDir, "auto-external.mp4");
  const autoUnavailable = path.join(mediaDir, "auto-unavailable.mp4");
  const serverEmbedded = path.join(mediaDir, "server-embedded.mp4");
  const serverBitmap = path.join(mediaDir, "server-bitmap.mp4");
  const serverExternal = path.join(mediaDir, "server-external.mp4");
  const offVideo = path.join(mediaDir, "off.mp4");
  for (const filePath of [autoEmbedded, autoExternal, autoUnavailable, serverEmbedded, serverBitmap, serverExternal, offVideo]) {
    fs.writeFileSync(filePath, Buffer.alloc(8192, path.basename(filePath).length));
  }
  writeProbeSidecar(autoEmbedded, [textStream(2, "subrip", { tags: { language: "chi", title: "自动内嵌" }, disposition: { default: 1 } })]);
  fs.writeFileSync(path.join(mediaDir, "auto-embedded.srt"), "1\n00:00:01,000 --> 00:00:02,000\n不应发送的外挂\n", "utf8");
  writeProbeSidecar(autoExternal, []);
  fs.writeFileSync(path.join(mediaDir, "auto-external.srt"), "1\n00:00:01,000 --> 00:00:02,000\n自动外挂\n", "utf8");
  fs.writeFileSync(autoUnavailable + ".ffprobe-fail", "1");
  fs.writeFileSync(path.join(mediaDir, "auto-unavailable.srt"), "1\n00:00:01,000 --> 00:00:02,000\n不可检测时回退外挂\n", "utf8");
  writeProbeSidecar(serverEmbedded, [
    { index: 0, codec_type: "video", codec_name: "h264" },
    textStream(2, "subrip", { tags: { language: "chi", title: "服务器内嵌" }, disposition: { default: 1 } })
  ]);
  writeProbeSidecar(serverBitmap, [textStream(2, "hdmv_pgs_subtitle", { tags: { language: "jpn" } })]);
  writeProbeSidecar(serverExternal, []);
  fs.writeFileSync(path.join(mediaDir, "server-external.srt"), "1\n00:00:01,000 --> 00:00:02,000\n服务器回退外挂\n", "utf8");
  writeProbeSidecar(offVideo, [textStream(2, "subrip", { tags: { language: "chi" } })]);
  fs.writeFileSync(path.join(mediaDir, "off.srt"), "1\n00:00:01,000 --> 00:00:02,000\n关闭时不应发送\n", "utf8");

  const fake = startProcess("fake-dlna", ["scripts/fake-dlna.mjs"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      FAKE_DLNA_HTTP_PORT: "0",
      FAKE_DLNA_SSDP_PORT: "0",
      FAKE_DLNA_NAME: FAKE_DEVICE_NAME,
      FAKE_DLNA_MANUFACTURER: "Samsung Electronics",
      FAKE_DLNA_MODEL_NAME: "UN55",
      FAKE_DLNA_MODEL_NUMBER: "SAMSUNG-E2E"
    }
  });
  const locationLine = await fake.waitFor(/^LOCATION /, 10000, "fake-dlna LOCATION");
  const seedLocation = locationLine.replace(/^LOCATION /, "").trim();
  await fake.waitFor(/FAKE_DLNA_READY/, 5000, "fake-dlna ready");

  const server = startHub(mediaDir, dataDir, seedLocation);
  await server.waitFor(/CastHub 已启动/, 20000, "中枢启动");
  await waitForHttp("http://127.0.0.1:" + HTTP_PORT + "/api/files?path=");
  const base = "http://127.0.0.1:" + HTTP_PORT;

  console.log("== 集成：连接控制台与 DLNA 设备 ==");
  const client = await ConsoleClient.connect("ws://127.0.0.1:" + HTTP_PORT + "/console?token=" + CONSOLE_TOKEN);
  const devices = await client.waitFor(
    (m) => m.type === "devices" && Array.isArray(m.list) && m.list.some((d) => d.type === "dlna" && d.deviceName === FAKE_DEVICE_NAME),
    10000,
    "fake DLNA 设备"
  );
  const device = devices.list.find((d) => d.type === "dlna" && d.deviceName === FAKE_DEVICE_NAME);
  assert.ok(device, "DLNA 设备出现");

  console.log("== 集成 1：auto 有内嵌轨 → 不发外挂，媒体带 subtitles=0 ==");
  await castAndWait(client, fake, device, "auto-embedded.mp4", { subtitleMode: "auto" }, "auto 内嵌");
  const autoCount = await fake.waitFor(/^SUBTITLE_URL_COUNT /, 5000, "auto 内嵌字幕数量");
  assertCount(autoCount, 0, "auto 内嵌");
  const autoDidlLine = await fake.waitFor(/^DIDL_RECEIVED /, 5000, "auto 内嵌 DIDL");
  const autoDidl = autoDidlLine.replace(/^DIDL_RECEIVED /, "");
  assert(!autoDidl.includes("CaptionInfoEx"), "auto 内嵌 DIDL 不含 CaptionInfoEx");
  const autoProbeLine = await fake.waitFor(/^MEDIA_PROBE 206 /, 5000, "auto 内嵌媒体探测");
  assert(autoProbeLine.includes("subtitles=0"), "auto 内嵌媒体 URL 带 subtitles=0");
  assert(!fake.lines.some((line) => line.startsWith("SUBTITLE_GET")), "auto 内嵌未请求外挂字幕");

  console.log("== 集成 2：auto 无内嵌轨 → 外挂一条 ==");
  await castAndWait(client, fake, device, "auto-external.mp4", { subtitleMode: "auto" }, "auto 外挂");
  const autoExternalCount = await fake.waitFor(/^SUBTITLE_URL_COUNT /, 5000, "auto 外挂字幕数量");
  assertCount(autoExternalCount, 1, "auto 外挂");
  const autoExternalDidlLine = await fake.waitFor(/^DIDL_RECEIVED /, 5000, "auto 外挂 DIDL");
  const autoExternalDidl = autoExternalDidlLine.replace(/^DIDL_RECEIVED /, "");
  assert(autoExternalDidl.includes("CaptionInfoEx"), "auto 外挂 DIDL 含 CaptionInfoEx");
  const autoExternalGet = await fake.waitFor(/^SUBTITLE_GET \[0\] 200 /, 5000, "auto 外挂字幕 GET 200");
  assert(autoExternalGet.includes("application/x-subrip"), "auto 外挂字幕 Content-Type 正确");

  console.log("== 集成 3：auto ffprobe 不可用 → 回退外挂字幕 ==");
  await castAndWait(client, fake, device, "auto-unavailable.mp4", { subtitleMode: "auto" }, "auto 不可用");
  const unavailableCount = await fake.waitFor(/^SUBTITLE_URL_COUNT /, 5000, "auto 不可用回退外挂数量");
  assertCount(unavailableCount, 1, "auto 不可用回退外挂");
  const unavailableDidlLine = await fake.waitFor(/^DIDL_RECEIVED /, 5000, "auto 不可用 DIDL");
  const unavailableDidl = unavailableDidlLine.replace(/^DIDL_RECEIVED /, "");
  assert(unavailableDidl.includes("CaptionInfoEx"), "auto 不可用 DIDL 含 CaptionInfoEx");
  const unavailableGet = await fake.waitFor(/^SUBTITLE_GET \[0\] 200 /, 5000, "auto 不可用字幕 GET 200");
  assert(unavailableGet.includes("application/x-subrip"), "auto 不可用字幕 Content-Type 正确");

  console.log("== 集成 4：server 内嵌 → 抽取 SRT + 去字幕副本 + 两条签名 URL ==");
  await castAndWait(client, fake, device, "server-embedded.mp4", { subtitleMode: "server" }, "server 内嵌");
  const serverCount = await fake.waitFor(/^SUBTITLE_URL_COUNT /, 5000, "server 内嵌字幕数量");
  assertCount(serverCount, 1, "server 内嵌");
  const serverDidlLine = await fake.waitFor(/^DIDL_RECEIVED /, 5000, "server 内嵌 DIDL");
  const serverDidl = serverDidlLine.replace(/^DIDL_RECEIVED /, "");
  assert(serverDidl.includes("/api/embedded-subtitle?"), "server DIDL 字幕 URL 指向 /api/embedded-subtitle");
  const serverMediaUrl = didlResUrl(serverDidl);
  const serverSubtitleUrl = didlSubtitleUrl(serverDidl);
  assert.ok(serverMediaUrl.includes("/api/embedded-media?"), "server DIDL 媒体 URL 指向 /api/embedded-media");
  assert.ok(serverSubtitleUrl && serverSubtitleUrl.includes("/api/embedded-subtitle?"), "server 字幕 URL 已签名");
  const serverProbeLine = await fake.waitFor(/^MEDIA_PROBE 206 /, 5000, "server 媒体探测");
  assert(serverProbeLine.includes("/api/embedded-media?"), "fake DLNA 探测的是去字幕副本");
  const serverCaptionLine = await fake.waitFor(/^CAPTION_HEADER HEAD 200 http:\/\/.+\/api\/embedded-subtitle\?/, 5000, "server CaptionInfo.sec");
  assert(serverCaptionLine.includes("/api/embedded-subtitle?"), "server HEAD 返回 embedded-subtitle 发现头");
  const serverSubGet = await fake.waitFor(/^SUBTITLE_GET \[0\] 200 /, 5000, "server 字幕 GET 200");
  assert(serverSubGet.includes("application/x-subrip"), "server 字幕 Content-Type 正确");
  const serverSubText = await fake.waitFor(/^SUBTITLE_TEXT \[0\] /, 5000, "server 字幕文本");
  assert(serverSubText.includes("内嵌字幕测试"), "server 抽取 SRT 内容正确");
  await sleep(300);
  assert(!fake.lines.some((line) => line.startsWith("SUBTITLE_GET [1]")), "server 只请求一条字幕");

  const cacheDir = path.join(dataDir, "data", "cache", "embedded-subtitles");
  const cacheFiles = fs.readdirSync(cacheDir);
  assert(cacheFiles.some((name) => name.endsWith(".srt")), "缓存目录存在 SRT");
  assert(cacheFiles.some((name) => name.includes(".nosubs.") && name.endsWith(".mp4")), "缓存目录存在去字幕副本");

  console.log("== 集成 5：/api/embedded-* Range、签名、过期、篡改与路径穿越 ==");
  const rangeRes = await fetch(serverMediaUrl, { headers: { Range: "bytes=0-9" } });
  assert.equal(rangeRes.status, 206, "embedded-media Range 返回 206");
  assert.equal(rangeRes.headers.get("accept-ranges"), "bytes", "embedded-media Accept-Ranges");
  assert.match(rangeRes.headers.get("content-range") || "", /^bytes 0-9\/\d+$/, "embedded-media Content-Range 正确");
  assert.equal(Buffer.from(await rangeRes.arrayBuffer()).length, 10, "embedded-media Range 响应体长度 10");
  const captionRes = await fetch(serverMediaUrl, { headers: { "getCaptionInfo.sec": "1" } });
  assert.ok((captionRes.headers.get("captioninfo.sec") || "").includes("/api/embedded-subtitle?"), "embedded-media 返回 CaptionInfo.sec");
  await captionRes.arrayBuffer();
  const captionDisabled = await fetch(serverMediaUrl + "&subtitles=0", { headers: { "getCaptionInfo.sec": "1" } });
  assert.equal(captionDisabled.headers.get("captioninfo.sec"), null, "embedded-media subtitles=0 不返回 CaptionInfo.sec");
  await captionDisabled.arrayBuffer();
  const subtitleRes = await fetch(serverSubtitleUrl);
  assert.equal(subtitleRes.status, 200, "embedded-subtitle 200");
  assert.equal(subtitleRes.headers.get("content-type"), "application/x-subrip; charset=utf-8", "embedded-subtitle Content-Type");
  assert.ok((await subtitleRes.text()).includes("内嵌字幕测试"), "embedded-subtitle 内容正确");

  const unsignedUrl = new URL(serverMediaUrl);
  unsignedUrl.searchParams.delete("sig");
  unsignedUrl.searchParams.delete("expires");
  assert.equal((await fetch(unsignedUrl)).status, 401, "embedded-media 未签名 401");
  const expiredUrl = new URL(serverSubtitleUrl);
  expiredUrl.searchParams.set("expires", String(Date.now() - 1000));
  assert.equal((await fetch(expiredUrl)).status, 401, "embedded-subtitle 过期 401");
  const tamperedUrl = new URL(serverSubtitleUrl);
  tamperedUrl.searchParams.set("path", "tampered.srt");
  assert.equal((await fetch(tamperedUrl)).status, 401, "embedded-subtitle 篡改路径 401");
  const tokenTraversal = new URL("/api/embedded-subtitle", base);
  tokenTraversal.searchParams.set("path", "../secret.srt");
  tokenTraversal.searchParams.set("token", CONSOLE_TOKEN);
  assert.equal((await fetch(tokenTraversal)).status, 404, "embedded-subtitle 令牌 + 路径穿越 404");
  const tokenSubtitle = new URL(serverSubtitleUrl);
  tokenSubtitle.searchParams.delete("expires");
  tokenSubtitle.searchParams.delete("sig");
  tokenSubtitle.searchParams.set("token", CONSOLE_TOKEN);
  assert.equal((await fetch(tokenSubtitle)).status, 200, "embedded-subtitle 控制台令牌可读");
  const wrongExtension = new URL("/api/embedded-media", base);
  wrongExtension.searchParams.set("path", new URL(serverSubtitleUrl).searchParams.get("path") || "");
  wrongExtension.searchParams.set("token", CONSOLE_TOKEN);
  assert.equal((await fetch(wrongExtension)).status, 415, "embedded-media 非视频扩展名 415");

  console.log("== 集成 6：server 图片字幕 → 明确错误且不投屏 ==");
  const bitmapError = await castExpectError(client, fake, device, "server-bitmap.mp4", { subtitleMode: "server" }, "server 图片字幕");
  assert.equal(bitmapError.message, "内嵌字幕为图片字幕，当前版本不支持服务器字幕模式", "图片字幕错误文本");

  console.log("== 集成 7：server 无内嵌轨 → 外挂回退 ==");
  await castAndWait(client, fake, device, "server-external.mp4", { subtitleMode: "server" }, "server 外挂回退");
  const fallbackCount = await fake.waitFor(/^SUBTITLE_URL_COUNT /, 5000, "server 外挂回退字幕数量");
  assertCount(fallbackCount, 1, "server 外挂回退");
  const fallbackDidlLine = await fake.waitFor(/^DIDL_RECEIVED /, 5000, "server 外挂回退 DIDL");
  const fallbackDidl = fallbackDidlLine.replace(/^DIDL_RECEIVED /, "");
  assert(fallbackDidl.includes("/api/subtitle?"), "server 回退使用 /api/subtitle");
  assert(!fallbackDidl.includes("/api/embedded-subtitle?"), "server 回退不误用 embedded-subtitle");

  console.log("== 集成 8：off 关闭所有字幕 ==");
  await castAndWait(client, fake, device, "off.mp4", { subtitleMode: "off" }, "off");
  const offCount = await fake.waitFor(/^SUBTITLE_URL_COUNT /, 5000, "off 字幕数量");
  assertCount(offCount, 0, "off");
  const offProbeLine = await fake.waitFor(/^MEDIA_PROBE 206 /, 5000, "off 媒体探测");
  assert(offProbeLine.includes("subtitles=0"), "off 媒体 URL 带 subtitles=0");
  assert(!fake.lines.some((line) => line.startsWith("SUBTITLE_GET")), "off 未请求字幕");

  console.log("== 集成 9：非法模式与非法轨道索引 ==");
  const invalidMode = await castExpectError(client, fake, device, "off.mp4", { subtitleMode: "bogus" }, "非法模式");
  assert.equal(invalidMode.message, "未知字幕模式", "非法模式错误文本");
  const invalidTrack = await castExpectError(
    client, fake, device, "server-embedded.mp4", { subtitleMode: "server", subtitleTrack: "abc" }, "非法轨道"
  );
  assert.equal(invalidTrack.message, "字幕轨索引非法", "非法轨道错误文本");

  client.close();
  await stopHub(server);
  console.log("\n✅ E2E-EMBEDDED-SUBTITLES 全部通过");
}

main()
  .then(() => {
    cleanup();
    setTimeout(() => process.exit(0), 300);
  })
  .catch((error) => {
    console.error("\n❌ E2E-EMBEDDED-SUBTITLES 失败:", error && error.stack ? error.stack : error);
    cleanup();
    setTimeout(() => process.exit(1), 300);
  });