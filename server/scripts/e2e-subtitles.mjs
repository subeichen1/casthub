#!/usr/bin/env node
// CastHub 字幕解析端到端测试：单元 + /api/subtitle + /media CaptionInfo.sec
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSubtitleCandidates, selectSubtitle, subtitleToSrt, decodeSubtitleBuffer } from "../src/subtitles.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const PORT = Number(process.env.E2E_SUBTITLES_PORT ?? 9432);
const TOKEN = "e2e-subtitles-token-2024";
const children = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanup() {
  for (const child of children) {
    try { child.kill(); } catch { /* ignore */ }
  }
}

function startServer(mediaDir, dataDir) {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      MEDIA_DIR: mediaDir,
      DATA_DIR: dataDir,
      CONSOLE_TOKEN: TOKEN
    }
  });
  children.push(child);
  child.stdout.on("data", (chunk) => process.stdout.write("[server] " + chunk.toString()));
  child.stderr.on("data", (chunk) => process.stderr.write("[server] " + chunk.toString()));
  return child;
}

async function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { "x-casthub-token": TOKEN } });
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error("服务未就绪: " + url);
}

function assertSrt(text, label) {
  assert.equal(text.charCodeAt(0) === 0xfeff, false, label + " 不含 BOM");
  assert.equal(text.includes("WEBVTT"), false, label + " 不含 WEBVTT");
  assert.equal(text.includes("[Script Info]"), false, label + " 不含 ASS 容器");
  assert.ok(text.includes("1\n00:00:01,000 --> 00:00:02,000"), label + " 输出标准 SRT");
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-e2e-subtitles-"));
  const mediaDir = path.join(tempDir, "media");
  const dataDir = path.join(tempDir, "data");
  fs.mkdirSync(path.join(mediaDir, "api"), { recursive: true });
  fs.mkdirSync(path.join(mediaDir, "select", "Subs"), { recursive: true });
  fs.mkdirSync(path.join(mediaDir, "lang"), { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "movie.mp4"), Buffer.alloc(1024, 0x1a));
  fs.writeFileSync(path.join(mediaDir, "movie.srt"), "1\n00:00:01,000 --> 00:00:02,000\nMovie subtitle\n", "utf8");
  fs.writeFileSync(path.join(mediaDir, "movie.zh-CN.srt"), "1\n00:00:01,000 --> 00:00:02,000\n中文字幕\n", "utf8");
  fs.writeFileSync(path.join(mediaDir, "movie.en.sdh.srt"), "1\n00:00:01,000 --> 00:00:02,000\nEnglish SDH\n", "utf8");
  fs.writeFileSync(path.join(mediaDir, "movie.2024.srt"), "1\n00:00:01,000 --> 00:00:02,000\nNot a language tag\n", "utf8");
  fs.writeFileSync(path.join(mediaDir, "Case.mp4"), Buffer.alloc(1024, 0x1d));
  fs.writeFileSync(path.join(mediaDir, "case.srt"), "1\n00:00:01,000 --> 00:00:02,000\nCase-insensitive subtitle\n", "utf8");
  fs.writeFileSync(path.join(mediaDir, "select", "movie.mp4"), Buffer.alloc(1024, 0x1b));
  fs.writeFileSync(path.join(mediaDir, "select", "movie.en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nEnglish\n", "utf8");
  fs.writeFileSync(path.join(mediaDir, "select", "Subs", "movie.srt"), "1\n00:00:01,000 --> 00:00:02,000\nExact in Subs\n", "utf8");
  fs.writeFileSync(path.join(mediaDir, "lang", "movie.mp4"), Buffer.alloc(1024, 0x1c));
  fs.writeFileSync(path.join(mediaDir, "lang", "movie.en.srt"), "1\n00:00:01,000 --> 00:00:02,000\nEnglish\n", "utf8");
  fs.writeFileSync(path.join(mediaDir, "lang", "movie.zh-CN.srt"), "1\n00:00:01,000 --> 00:00:02,000\n中文\n", "utf8");

  console.log("== 单元：扫描与选择 ==");
  const movieCandidates = await findSubtitleCandidates(path.join(mediaDir, "movie.mp4"));
  assert.ok(movieCandidates.some((c) => c.path.endsWith("movie.srt") && c.exact && c.locationRank === 0), "找到同目录精确字幕");
  assert.ok(movieCandidates.some((c) => c.path.endsWith("movie.zh-CN.srt") && !c.exact && c.language === "zh-cn"), "识别 zh-CN 语言后缀");
  assert.ok(movieCandidates.some((c) => c.path.endsWith("movie.en.sdh.srt") && !c.exact && c.language === "en"), "识别 .en.sdh 修饰词");
  assert.equal(movieCandidates.some((c) => c.path.endsWith("movie.2024.srt")), false, "排除伪语言后缀 movie.2024.srt");
  const selectedExact = selectSubtitle(movieCandidates);
  assert.ok(selectedExact && selectedExact.path.endsWith("movie.srt"), "优先同目录精确字幕");

  const caseCandidates = await findSubtitleCandidates(path.join(mediaDir, "Case.mp4"));
  assert.ok(caseCandidates.some((c) => c.path.endsWith("case.srt") && c.exact), "Windows 大小写不敏感匹配 Case.mp4 + case.srt");

  fs.writeFileSync(path.join(mediaDir, "Refresh.mp4"), Buffer.alloc(1024, 0x1e));
  const beforeRefresh = await findSubtitleCandidates(path.join(mediaDir, "Refresh.mp4"));
  assert.equal(beforeRefresh.length, 0, "投屏前无字幕");
  fs.writeFileSync(path.join(mediaDir, "Refresh.srt"), "1\n00:00:01,000 --> 00:00:02,000\nNew subtitle\n", "utf8");
  const cachedRefresh = await findSubtitleCandidates(path.join(mediaDir, "Refresh.mp4"));
  assert.equal(cachedRefresh.length, 0, "短 TTL 缓存内复用旧扫描结果");
  const refreshed = await findSubtitleCandidates(path.join(mediaDir, "Refresh.mp4"), { refresh: true });
  assert.ok(refreshed.some((c) => c.path.endsWith("Refresh.srt") && c.exact), "投屏前强制刷新发现新增字幕");

  const selectCandidates = await findSubtitleCandidates(path.join(mediaDir, "select", "movie.mp4"));
  const before = JSON.stringify(selectCandidates);
  const selectedSubs = selectSubtitle(selectCandidates);
  assert.ok(selectedSubs && selectedSubs.path.endsWith(path.join("Subs", "movie.srt")), "精确同名的 Subs 子目录优先于非精确字幕");
  assert.equal(JSON.stringify(selectCandidates), before, "selectSubtitle 不修改入参数组");

  const langCandidates = await findSubtitleCandidates(path.join(mediaDir, "lang", "movie.mp4"));
  const selectedZh = selectSubtitle(langCandidates, ["zh"]);
  assert.ok(selectedZh && selectedZh.path.endsWith("movie.zh-CN.srt"), "偏好语言 zh 选择 zh-CN 字幕");
  const selectedEn = selectSubtitle(langCandidates, ["en"]);
  assert.ok(selectedEn && selectedEn.path.endsWith("movie.en.srt"), "偏好语言 en 选择英文字幕");
  assert.equal(selectSubtitle([]), null, "空候选返回 null");

  console.log("== 单元：六种格式转换为 SRT ==");
  const cases = [
    ["srt", "1\n00:00:01,000 --> 00:00:02,000\nHello\n"],
    ["vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000 align:start\n<v Speaker>Hello</v>\n"],
    ["ass", "[Script Info]\nTitle: test\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}Hello{\\i0}, world!\n"],
    ["ssa", "[Script Info]\n\n[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello\n"],
    ["smi", "<SAMI>\n<BODY>\n<SYNC Start=1000><P Class=ENCC>Hello\n<SYNC Start=2000><P Class=ENCC>&nbsp;\n</BODY>\n</SAMI>\n"],
    ["sub", "{1}{1}25.000\n{25}{50}Hello\n"]
  ];
  for (const [format, input] of cases) {
    const out = subtitleToSrt(input, format);
    assertSrt(out, format);
  }
  const multiClassSmi = subtitleToSrt(
    "<SAMI>\n<BODY>\n<SYNC Start=1000><P Class=ENCC>English<P Class=ZHCN>中文\n<SYNC Start=2000><P Class=ENCC>&nbsp;\n</BODY>\n</SAMI>\n",
    "smi"
  );
  assert.ok(multiClassSmi.includes("中文"), "SMI 同一 SYNC 多 Class 优先中文");
  assert.equal(multiClassSmi.includes("English"), false, "SMI 同一 SYNC 不拼接多个 Class");
  assert.equal(subtitleToSrt("not a subtitle", "vtt"), "", "无法解析的 VTT 返回空字符串");

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hello", "utf16le")]);
  assert.equal(decodeSubtitleBuffer(utf16), "Hello", "UTF-16LE BOM 解码");

  console.log("== HTTP：/api/subtitle 每种格式均返回合法 SRT ==");
  fs.writeFileSync(path.join(mediaDir, "api", "movie.mp4"), Buffer.alloc(2048, 0x2a));
  fs.writeFileSync(path.join(mediaDir, "api", "movie.srt"), "1\n00:00:01,000 --> 00:00:02,000\nHTTP movie subtitle\n", "utf8");
  const apiFiles = [
    ["srt", "1\n00:00:01,000 --> 00:00:02,000\nHello SRT\n"],
    ["vtt", "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello VTT\n"],
    ["ass", "[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello ASS\n"],
    ["ssa", "[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hello SSA\n"],
    ["smi", "<SAMI>\n<BODY>\n<SYNC Start=1000><P Class=ENCC>Hello SMI\n<SYNC Start=2000><P Class=ENCC>&nbsp;\n</BODY>\n</SAMI>\n"],
    ["sub", "{1}{1}25.000\n{25}{50}Hello SUB\n"]
  ];
  for (const [format, body] of apiFiles) {
    fs.writeFileSync(path.join(mediaDir, "api", "sample." + format), body, "utf8");
  }
  fs.writeFileSync(path.join(mediaDir, "api", "broken.xyz"), "nothing", "utf8");
  fs.writeFileSync(path.join(mediaDir, "api", "broken.vtt"), "not a vtt file", "utf8");

  const server = startServer(mediaDir, dataDir);
  await waitForHttp("http://127.0.0.1:" + PORT + "/api/files?path=", 20000);
  const base = "http://127.0.0.1:" + PORT;
  for (const [format] of apiFiles) {
    const params = new URLSearchParams({ path: "api/sample." + format, token: TOKEN });
    const res = await fetch(base + "/api/subtitle?" + params.toString());
    assert.equal(res.status, 200, "/api/subtitle " + format + " 状态 200");
    assert.equal(res.headers.get("content-type"), "application/x-subrip; charset=utf-8", "/api/subtitle " + format + " Content-Type");
    const text = await res.text();
    assertSrt(text, "HTTP " + format);
    const head = await fetch(base + "/api/subtitle?" + params.toString(), { method: "HEAD" });
    assert.equal(head.status, 200, "/api/subtitle HEAD " + format + " 状态 200");
    assert.equal(Number(head.headers.get("content-length")), Buffer.byteLength(text, "utf8"), "/api/subtitle HEAD Content-Length 为转换后长度");
  }
  const unsupported = await fetch(base + "/api/subtitle?" + new URLSearchParams({ path: "api/broken.xyz", token: TOKEN }).toString());
  assert.equal(unsupported.status, 415, "不支持扩展名返回 415");
  const broken = await fetch(base + "/api/subtitle?" + new URLSearchParams({ path: "api/broken.vtt", token: TOKEN }).toString());
  assert.equal(broken.status, 422, "无法解析返回 422");
  const badAuth = await fetch(base + "/api/subtitle?" + new URLSearchParams({ path: "api/sample.srt" }).toString());
  assert.equal(badAuth.status, 401, "无 token 返回 401");

  console.log("== HTTP：/media CaptionInfo.sec 仅在 Samsung 式探测时返回 ==");
  const mediaUrl = base + "/media/api/movie.mp4?token=" + encodeURIComponent(TOKEN);
  const withCaption = await fetch(mediaUrl, { headers: { "getCaptionInfo.sec": "1", Range: "bytes=0-9" } });
  const captionHeader = withCaption.headers.get("captioninfo.sec") || "";
  assert.ok(captionHeader.includes("/api/subtitle?path="), "/media 带 getCaptionInfo.sec 时返回字幕发现头");
  assert.equal(new URL(captionHeader).searchParams.get("path"), "api/movie.srt", "CaptionInfo.sec 指向选中字幕");
  await withCaption.arrayBuffer();
  const withoutCaption = await fetch(mediaUrl, { headers: { Range: "bytes=0-9" } });
  assert.equal(withoutCaption.headers.get("captioninfo.sec"), null, "/media 普通 GET 不返回字幕发现头");
  await withoutCaption.arrayBuffer();
  const disabledCaption = await fetch(mediaUrl + "&subtitles=0", { headers: { "getCaptionInfo.sec": "1", Range: "bytes=0-9" } });
  assert.equal(disabledCaption.headers.get("captioninfo.sec"), null, "/media subtitles=0 不返回字幕发现头");
  await disabledCaption.arrayBuffer();

  console.log("✅ E2E-SUBTITLES 全部通过");
  server.kill("SIGTERM");
  await sleep(300);
}

main()
  .then(() => {
    cleanup();
    setTimeout(() => process.exit(0), 200);
  })
  .catch((error) => {
    console.error("❌ E2E-SUBTITLES 失败:", error && error.stack ? error.stack : error);
    cleanup();
    setTimeout(() => process.exit(1), 200);
  });
