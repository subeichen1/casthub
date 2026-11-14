#!/usr/bin/env node
/**
 * 轻量性能基线：文件列表、媒体 Range、并发请求。
 * 用法：node scripts/perf-smoke.mjs
 * 环境变量：PERF_PORT（默认 19420）、PERF_ITERATIONS（默认 200）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER_DIR = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PERF_PORT ?? 19420);
const ITERATIONS = Number(process.env.PERF_ITERATIONS ?? 200);
const CONSOLE_TOKEN = "perf-console-token-2024";
const BASE = `http://127.0.0.1:${PORT}`;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Number(sorted[index].toFixed(2));
}

async function waitForServer() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/files?path=`, { headers: { "x-casthub-token": CONSOLE_TOKEN } });
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("服务端未在 20 秒内就绪");
}

async function timedFetch(url, options) {
  const start = performance.now();
  const res = await fetch(url, options);
  const elapsed = performance.now() - start;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  await res.arrayBuffer();
  return elapsed;
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-perf-"));
  const mediaDir = path.join(tempDir, "media");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "sample.mp4"), Buffer.alloc(5 * 1024 * 1024, 0x1a));

  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      MEDIA_DIR: mediaDir,
      PUBLIC_BASE_URL: BASE,
      CONSOLE_TOKEN
    },
    stdio: ["ignore", "ignore", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  try {
    await waitForServer();
    const fileHeaders = { "x-casthub-token": CONSOLE_TOKEN };
    const rangeHeaders = { Range: "bytes=0-65535" };

    for (let i = 0; i < 20; i += 1) {
      await timedFetch(`${BASE}/api/files?path=`, { headers: fileHeaders });
      await timedFetch(`${BASE}/media/sample.mp4?token=${encodeURIComponent(CONSOLE_TOKEN)}`, { headers: rangeHeaders });
    }

    const listTimes = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      listTimes.push(await timedFetch(`${BASE}/api/files?path=`, { headers: fileHeaders }));
    }

    const mediaTimes = [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      mediaTimes.push(await timedFetch(`${BASE}/media/sample.mp4?token=${encodeURIComponent(CONSOLE_TOKEN)}`, { headers: rangeHeaders }));
    }

    const burstStart = performance.now();
    await Promise.all(Array.from({ length: 50 }, () =>
      fetch(`${BASE}/api/files?path=`, { headers: fileHeaders }).then((res) => {
        if (!res.ok) throw new Error(`burst HTTP ${res.status}`);
        return res.arrayBuffer();
      })
    ));
    const burstMs = performance.now() - burstStart;

    const report = {
      timestamp: new Date().toISOString(),
      node: process.version,
      iterations: ITERATIONS,
      fileListMs: { p50: percentile(listTimes, 50), p95: percentile(listTimes, 95), max: Number(Math.max(...listTimes).toFixed(2)) },
      mediaRange64KiBMs: { p50: percentile(mediaTimes, 50), p95: percentile(mediaTimes, 95), max: Number(Math.max(...mediaTimes).toFixed(2)) },
      concurrent50FileListMs: Number(burstMs.toFixed(2))
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    child.kill();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (stderr.trim()) console.error(stderr.trim());
  }
}

main().catch((error) => {
  console.error("性能基线失败:", error.message);
  process.exitCode = 1;
});
