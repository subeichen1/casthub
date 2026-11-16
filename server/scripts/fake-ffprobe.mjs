#!/usr/bin/env node
// 测试用 ffprobe：读取同名 .ffprobe.json sidecar；没有 sidecar 时输出空 streams。
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("-version")) {
  console.log("fake-ffprobe 1.0");
  process.exit(0);
}
const input = args[args.length - 1];
try {
  if (fs.existsSync(`${input}.ffprobe-fail`)) {
    process.stderr.write("fake ffprobe: requested failure\n");
    process.exit(1);
  }
  const sidecar = `${input}.ffprobe.json`;
  if (fs.existsSync(sidecar)) {
    process.stdout.write(fs.readFileSync(sidecar, "utf8"));
  } else {
    process.stdout.write(JSON.stringify({ streams: [] }));
  }
  process.exit(0);
} catch (error) {
  process.stderr.write(`${String(error?.message ? error.message : error)}\n`);
  process.exit(1);
}
