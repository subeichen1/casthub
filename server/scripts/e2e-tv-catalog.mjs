#!/usr/bin/env node
// Step 2 E2E：静态目录构建（digest/checksum/失败保留/无变化）与 resolver 缓存 / API 回退。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findTvApp } from "../src/tv-apps.ts";
import { resolveTvAppRelease } from "../src/tv-release-resolver.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, "..");
const BUILDER = path.join(SERVER_DIR, "scripts", "build-tv-catalog.mjs");
const apkBytes = Buffer.from("PK-step2-apk-content");
const hongguoSha = "b".repeat(64);
const aerialSha = "a".repeat(64);
const tvboxSha = "c".repeat(64);
let builderMode = "ok";
let catalogMode = "ok";
let catalogRequests = 0;
let catalogLastHeader = "";
const catalogEtag = '"catalog-v1"';

function jsonResponse(res, payload, status = 200, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(payload));
}

function releaseAsset(name, url, digest) {
  return { name, browser_download_url: url, size: apkBytes.length, digest };
}

const mockServer = http.createServer((req, res) => {
  const url = req.url ?? "";
  res.on("error", () => undefined);

  if (url === "/catalog") {
    catalogRequests += 1;
    catalogLastHeader = String(req.headers["if-none-match"] ?? "");
    if (catalogMode === "500") {
      res.writeHead(500).end("catalog unavailable");
      return;
    }
    if (catalogMode === "etag" && catalogLastHeader === catalogEtag) {
      res.writeHead(304).end();
      return;
    }
    jsonResponse(res, {
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      mirrors: [],
      apps: {
        hongguo: {
          repo: "aston314/hongguo-tv-releases",
          tag_name: "v9.9.9",
          published_at: "2026-01-01T00:00:00.000Z",
          assets: [
            {
              name: "hongguo-tv-9.9.9.apk",
              browser_download_url: "https://github.com/example/hongguo-tv-9.9.9.apk",
              size: apkBytes.length,
              digest: "sha256:" + hongguoSha
            }
          ]
        }
      }
    }, 200, { ETag: catalogEtag });
    return;
  }

  if (url.startsWith("/repos/pengchujin/aerial-tv/releases/latest")) {
    if (builderMode === "all-fail") {
      res.writeHead(500).end("fail");
      return;
    }
    jsonResponse(res, {
      tag_name: "v1.2.3",
      published_at: "2026-01-01T00:00:00.000Z",
      assets: [releaseAsset("aerial-standard.apk", "https://github.com/example/aerial-standard.apk", "sha256:" + aerialSha)]
    });
    return;
  }

  if (url.startsWith("/repos/aston314/hongguo-tv-releases/releases")) {
    if (builderMode === "hongguo-fail" || builderMode === "all-fail") {
      res.writeHead(500).end("fail");
      return;
    }
    const release = {
      tag_name: "v9.9.9",
      published_at: "2026-01-01T00:00:00.000Z",
      assets: [
        {
          name: "hongguo-tv-9.9.9.apk",
          browser_download_url: "https://github.com/example/hongguo-tv-9.9.9.apk",
          size: apkBytes.length,
          digest: null
        },
        {
          name: "SHA256SUMS.txt",
          browser_download_url: "http://127.0.0.1:" + mockPort + "/checksums/hongguo.txt",
          size: 80,
          digest: null
        }
      ]
    };
    jsonResponse(res, [release]);
    return;
  }

  if (url.startsWith("/repos/j4Uq/TVBoxOSC/releases/latest")) {
    if (builderMode === "all-fail") {
      res.writeHead(500).end("fail");
      return;
    }
    jsonResponse(res, {
      tag_name: "v9.9.9",
      published_at: "2026-01-01T00:00:00.000Z",
      assets: [releaseAsset("TVBox_q215613905_9.9.9-java.apk", "https://github.com/example/tvbox.apk", "sha256:" + tvboxSha)]
    });
    return;
  }

  if (url === "/checksums/hongguo.txt") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(hongguoSha + "  hongguo-tv-9.9.9.apk\n");
    return;
  }

  if (url.startsWith("/repos/aston314/hongguo-tv-releases/releases?per_page=15")) {
    // 上面的 startsWith 已覆盖；保留显式分支便于理解列表接口。
    return;
  }

  res.writeHead(404).end();
});

let mockPort = 0;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-tv-catalog-e2e-"));
const catalogPath = path.join(tempDir, "tv-catalog.json");
const failedPath = path.join(tempDir, "tv-catalog-failed.json");
const previousPath = path.join(tempDir, "previous.json");
const cacheOne = path.join(tempDir, "cache-one");
const cacheTwo = path.join(tempDir, "cache-two");
const cacheThree = path.join(tempDir, "cache-three");

function runBuilder(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUILDER, ...args], {
      cwd: SERVER_DIR,
      env: { ...process.env, CASTHUB_ALLOW_INSECURE_LOOPBACK: "1", ...env },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function assertHeader(label) {
  console.log("\n-- " + label + " --");
}

async function main() {
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  mockPort = mockServer.address().port;
  process.env.CASTHUB_ALLOW_INSECURE_LOOPBACK = "1";
  delete process.env.CASTHUB_CATALOG_URL;
  delete process.env.CASTHUB_GITHUB_MIRROR;
  delete process.env.CASTHUB_GITHUB_TOKEN;
  delete process.env.CASTHUB_GITHUB_API_BASE;
  delete process.env.AERIAL_RELEASE_JSON;
  delete process.env.HONGGUO_RELEASE_JSON;
  delete process.env.TVBOX_RELEASE_JSON;

  const env = { CASTHUB_GITHUB_API_BASE: "http://127.0.0.1:" + mockPort };

  assertHeader("builder: digest / checksum / schema");
  const first = await runBuilder(["--out", catalogPath], env);
  assert.equal(first.code, 0, first.stderr + first.stdout);
  assert(first.stdout.includes("CHANGED"), "首次生成输出 CHANGED: " + first.stdout);
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  assert.equal(catalog.schemaVersion, 1, "schemaVersion=1");
  assert.equal(catalog.apps.hongguo.assets[0].digest, "sha256:" + hongguoSha, "checksum 文件归一化 digest");
  assert.equal(catalog.apps.aerial.assets[0].digest, "sha256:" + aerialSha, "asset.digest 优先");
  assert.equal(catalog.apps.tvbox.assets[0].digest, "sha256:" + tvboxSha, "TVBox digest");
  const firstGeneratedAt = catalog.generatedAt;

  assertHeader("builder: unchanged keeps generatedAt");
  const second = await runBuilder(["--previous", catalogPath, "--out", catalogPath], env);
  assert.equal(second.code, 0, second.stderr + second.stdout);
  assert(second.stdout.includes("NO_CHANGES"), "内容不变输出 NO_CHANGES: " + second.stdout);
  assert.equal(JSON.parse(fs.readFileSync(catalogPath, "utf8")).generatedAt, firstGeneratedAt, "generatedAt 未被改写");

  assertHeader("builder: one repo failure keeps previous");
  fs.writeFileSync(previousPath, JSON.stringify({
    schemaVersion: 1,
    generatedAt: "2025-01-01T00:00:00.000Z",
    mirrors: [],
    apps: {
      hongguo: {
        repo: "aston314/hongguo-tv-releases",
        tag_name: "v0.0.1",
        published_at: null,
        assets: [{ name: "old.apk", browser_download_url: "https://github.com/old.apk", size: 1, digest: null }]
      }
    }
  }));
  builderMode = "hongguo-fail";
  const failed = await runBuilder(["--previous", previousPath, "--out", failedPath], env);
  assert.equal(failed.code, 0, failed.stderr + failed.stdout);
  assert((failed.stdout + failed.stderr).includes("hongguo") && (failed.stdout + failed.stderr).includes("拉取失败"), "输出失败告警: " + failed.stdout + failed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(failedPath, "utf8")).apps.hongguo.tag_name, "v0.0.1", "保留 previous 旧记录");

  assertHeader("builder: all repos fail without previous exits non-zero");
  builderMode = "all-fail";
  const allFailed = await runBuilder(["--out", path.join(tempDir, "none.json")], env);
  assert.notEqual(allFailed.code, 0, "全部失败且无旧数据退出非零");
  assert(allFailed.stdout.includes("全部应用仓库拉取失败") || allFailed.stderr.includes("全部应用仓库拉取失败"), "输出全部失败错误");

  builderMode = "ok";
  const hongguo = findTvApp("hongguo");
  const standard = hongguo.variants.find((variant) => variant.id === "standard");
  const catalogUrl = "http://127.0.0.1:" + mockPort + "/catalog";
  const apiBase = "http://127.0.0.1:" + mockPort;

  assertHeader("resolver: catalog + disk cache + restart + 304");
  const firstResolve = await resolveTvAppRelease(hongguo, standard, { cacheDir: cacheOne, catalogUrl, apiBase });
  assert.equal(firstResolve.source, "catalog", "首次解析来源 catalog: " + firstResolve.error);
  assert.equal(firstResolve.release.tag, "v9.9.9", "目录版本 v9.9.9");
  assert.equal(catalogRequests, 1, "目录只请求一次");
  const secondResolve = await resolveTvAppRelease(hongguo, standard, { cacheDir: cacheOne, catalogUrl, apiBase });
  assert.equal(secondResolve.source, "catalog", "重新读取磁盘缓存仍为 catalog");
  assert.equal(catalogRequests, 1, "磁盘 TTL 内不重复请求");
  catalogMode = "etag";
  const thirdResolve = await resolveTvAppRelease(hongguo, standard, { cacheDir: cacheOne, catalogUrl, apiBase, force: true });
  assert.equal(thirdResolve.source, "catalog", "304 后复用缓存仍为 catalog");
  assert.equal(catalogRequests, 2, "force 触发一次目录请求");
  assert.equal(catalogLastHeader, catalogEtag, "发送 If-None-Match: " + catalogLastHeader);

  assertHeader("resolver: catalog 500 -> API fallback");
  catalogMode = "500";
  const apiRelease = await resolveTvAppRelease(hongguo, standard, { cacheDir: cacheTwo, catalogUrl, apiBase });
  assert.equal(apiRelease.source, "api", "目录 500 时使用 API: " + apiRelease.error);
  assert.equal(apiRelease.release.tag, "v9.9.9", "API 兜底版本 v9.9.9");

  assertHeader("resolver: API rate limit stale cache");
  // 先让 API 写入 cacheTwo，再模拟 403 + x-ratelimit-remaining=0。
  const apiModeServer = mockServer;
  apiModeServer.emit("rate-limit-test");
  catalogMode = "500";
  // 通过替换 handler 的 API 分支不够直观，使用独立 catalog 路径让 resolver 走 API 并读取缓存。
  // 这里直接调用同一 resolver：cacheTwo 已有 API payload，目录 500 会触发 API 403 降级。
  // mock 的 API 分支由 setApiRateLimit 标志控制。
  apiRateLimit = true;
  const stale = await resolveTvAppRelease(hongguo, standard, { cacheDir: cacheTwo, catalogUrl, apiBase, force: true });
  assert.equal(stale.source, "api", "限流时使用 API 旧缓存: " + stale.error);
  assert(stale.warnings.some((warning) => warning.includes("受限")), "告警包含限流信息: " + stale.warnings.join(" | "));

  assertHeader("resolver: API rate limit without cache returns Chinese error");
  apiRateLimit = true;
  const noCache = await resolveTvAppRelease(hongguo, standard, { cacheDir: cacheThree, catalogUrl, apiBase, force: true });
  assert.equal(noCache.release, null, "无缓存时不返回假数据");
  assert(String(noCache.error).includes("GitHub API 请求受限"), "错误包含限流说明: " + noCache.error);

  console.log("\n✅ E2E-TV-CATALOG 全部通过");
}

// 放在 handler 外部，避免在请求闭包中引用尚未初始化的变量。
let apiRateLimit = false;
// 给 mock 的 GitHub API 分支加一层限流开关。
const originalHandler = mockServer.listeners("request")[0];
mockServer.removeAllListeners("request");
mockServer.on("request", (req, res) => {
  const url = req.url ?? "";
  if (apiRateLimit && url.startsWith("/repos/aston314/hongguo-tv-releases/releases")) {
    res.writeHead(403, {
      "Content-Type": "application/json",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600)
    });
    res.end(JSON.stringify({ message: "rate limited" }));
    return;
  }
  originalHandler(req, res);
});

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await new Promise((resolve) => mockServer.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
