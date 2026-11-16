#!/usr/bin/env node
// 测试用 ffmpeg：-c:s srt 写出固定 SRT；-sn 复制输入；sidecar 可模拟失败。
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args.includes("-version")) {
  console.log("fake-ffmpeg 1.0");
  process.exit(0);
}
const inputIndex = args.indexOf("-i");
const input = inputIndex >= 0 ? args[inputIndex + 1] : "";
const output = args[args.length - 1];
if (!input || !output) {
  process.stderr.write("fake ffmpeg: missing input/output\n");
  process.exit(1);
}
try {
  if (fs.existsSync(`${input}.ffmpeg-fail`)) {
    process.stderr.write("fake ffmpeg: requested failure\n");
    process.exit(1);
  }
  if (args.includes("-c:s") && args.includes("srt")) {
    const sidecar = `${input}.embedded.srt`;
    const body = fs.existsSync(sidecar)
      ? fs.readFileSync(sidecar, "utf8")
      : "1\n00:00:01,000 --> 00:00:03,000\n内嵌字幕测试\n";
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, body, "utf8");
    process.exit(0);
  }
  if (args.includes("-sn") && args.includes("copy")) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(input, output);
    process.exit(0);
  }
  process.stderr.write("fake ffmpeg: unsupported arguments\n");
  process.exit(1);
} catch (error) {
  process.stderr.write(`${String(error?.message ? error.message : error)}\n`);
  process.exit(1);
}
