#!/usr/bin/env node
// Step 3 E2E：网络配置校验/持久化、代理、镜像回退、SHA-256、Range 续传、并发合并与鉴权隔离。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { findTvApp } from "../src/tv-apps.ts";
import {
  NetworkSettingsService,
  networkSettingsView,
  normalizeNetworkConfig,
  readStoredNetworkConfig,
  resolveNetworkConfig,
  saveStoredNetworkConfig
} from "../src/network-config.ts";
import { NetworkClient } from "../src/network-fetch.ts";
import { downloadApk, TvDesktopService } from "../src/tv-desktop.ts";
import { resolveTvAppRelease } from "../src/tv-release-resolver.ts";

const nativeFetch = globalThis.fetch;
const apkBytes = Buffer.concat([Buffer.from("PK-step3-apk-"), Buffer.alloc(16 * 1024, 0x33)]);
const apkSha = createHash("sha256").update(apkBytes).digest("hex");
const tamperedBytes = Buffer.from(apkBytes);
tamperedBytes[0] ^= 0xff;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-tv-network-"));
process.env.CASTHUB_ALLOW_INSECURE_LOOPBACK = "1";
delete process.env.CASTHUB_PROXY;
delete process.env.CASTHUB_GITHUB_MIRROR;
delete process.env.CASTHUB_GITHUB_TOKEN;
delete process.env.CASTHUB_CATALOG_URL;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertOk(condition, message) {
  assert.ok(condition, message);
  console.log("✓ " + message);
}

async function expectReject(fn, pattern, message) {
  try {
    await fn();
  } catch (error) {
    assert.match(String(error?.message ?? error), pattern, message + ": " + error?.message);
    console.log("✓ " + message);
    return;
  }
  throw new Error("断言失败（没有抛出错误）: " + message);
}

function jsonBody(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function writeFull(res, body, type = "application/octet-stream") {
  res.writeHead(200, { "Content-Type": type, "Content-Length": String(body.length) });
  res.end(body);
}

function writePartialAndDestroy(res, body, start, end) {
  const slice = body.subarray(start, Math.min(end, body.length));
  res.write(slice);
  setTimeout(() => res.destroy(), 30);
}

function parseRange(value) {
  const match = /^bytes=(\d+)-$/.exec(value ?? "");
  return match ? Number(match[1]) : null;
}

let origin = "";
const serverHits = [];
let concurrentHits = 0;
const mockServer = http.createServer((req, res) => {
  const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = parsed.pathname;
  const range = req.headers.range ?? null;
  serverHits.push({ path: pathname, range });

  if (pathname === "/catalog-empty") {
    writeFull(res, Buffer.from(JSON.stringify({
      schemaVersion: 1,
      generatedAt: "2026-01-01T00:00:00.000Z",
      mirrors: [origin + "/m-good"],
      apps: {}
    })), "application/json");
    return;
  }

  if (pathname.startsWith("/repos/aston314/hongguo-tv-releases/releases")) {
    writeFull(res, Buffer.from(JSON.stringify([{
      tag_name: "v9.9.9",
      draft: false,
      prerelease: false,
      published_at: "2026-01-01T00:00:00.000Z",
      assets: [{
        name: "hongguo-tv-9.9.9.apk",
        browser_download_url: "https://github.com/example/hongguo-tv-9.9.9.apk",
        size: apkBytes.length,
        digest: "sha256:" + apkSha
      }]
    }])), "application/json");
    return;
  }

  if (pathname === "/origin") {
    writeFull(res, apkBytes);
    return;
  }
  if (pathname === "/origin-concurrent") {
    concurrentHits += 1;
    setTimeout(() => writeFull(res, apkBytes), 150);
    return;
  }
  if (pathname.startsWith("/m-html")) {
    writeFull(res, Buffer.from("<html>mirror unavailable</html>"), "text/html");
    return;
  }
  if (pathname.startsWith("/m-good")) {
    writeFull(res, apkBytes);
    return;
  }
  if (pathname.startsWith("/m-tamper")) {
    writeFull(res, tamperedBytes);
    return;
  }
  if (pathname.startsWith("/m-half-resume")) {
    const offset = parseRange(range);
    if (offset === null) {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(apkBytes.length) });
      writePartialAndDestroy(res, apkBytes, 0, Math.floor(apkBytes.length / 2));
      return;
    }
    const tail = apkBytes.subarray(offset);
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(tail.length),
      "Content-Range": "bytes " + offset + "-" + (apkBytes.length - 1) + "/" + apkBytes.length
    });
    res.end(tail);
    return;
  }
  if (pathname.startsWith("/m-half-fail")) {
    const offset = parseRange(range);
    if (offset === null) {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(apkBytes.length) });
      writePartialAndDestroy(res, apkBytes, 0, Math.floor(apkBytes.length / 2));
      return;
    }
    const tail = apkBytes.subarray(offset);
    res.writeHead(206, {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(tail.length),
      "Content-Range": "bytes " + offset + "-" + (apkBytes.length - 1) + "/" + apkBytes.length
    });
    writePartialAndDestroy(res, tail, 0, Math.floor(tail.length / 2));
    return;
  }
  if (pathname === "/proxy-target") {
    writeFull(res, Buffer.from("proxy-target-ok"), "text/plain");
    return;
  }
  res.writeHead(404).end("not found");
});
mockServer.on("clientError", (_error, socket) => socket.destroy());

const proxyHits = [];
const proxyServer = http.createServer((req, res) => {
  proxyHits.push(req.url ?? "");
  writeFull(res, Buffer.from("proxy-ok"), "text/plain");
});
proxyServer.on("connect", (req, clientSocket, head) => {
  proxyHits.push("CONNECT " + (req.url ?? ""));
  const [host, portText] = String(req.url ?? "").split(":");
  const upstream = net.connect(Number(portText), host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
});

function makeRelease(label, apkUrl, sha256Value, overrides = {}) {
  return {
    appId: "hongguo",
    variantId: "standard",
    packageName: "rocks.aston.hongguotv",
    tag: "v9.9.9-" + label,
    version: "9.9.9",
    apkName: "hongguo-tv-9.9.9-" + label + ".apk",
    apkUrl,
    sizeBytes: apkBytes.length,
    sha256: sha256Value,
    publishedAt: null,
    channel: "custom",
    ...overrides
  };
}

function makeDownloadFetcher(log) {
  return async (input, init = {}) => {
    const raw = String(input);
    const headers = new Headers(init.headers ?? {});
    log.push({ url: raw, authorization: headers.get("authorization"), range: headers.get("range") });
    const target = new URL(raw);
    if (target.hostname === "github.com") {
      let route = "/origin";
      if (target.pathname.includes("resume")) route = "/m-half-resume";
      else if (target.pathname.includes("switch")) route = "/m-half-fail";
      else if (target.pathname.includes("concurrent")) route = "/origin-concurrent";
      return nativeFetch(origin + route, init);
    }
    if (target.hostname === "downloads.example.com") {
      return new Response(apkBytes, {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-length": String(apkBytes.length) }
      });
    }
    return nativeFetch(raw, init);
  };
}

async function main() {
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + mockServer.address().port;
  const proxyOrigin = "http://127.0.0.1:" + proxyServer.address().port;

  // 1. config.json network 持久化：保留 desktop、空 token 不覆盖、显式清除、视图不含明文。
  const configDir = path.join(tempDir, "config");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
    desktop: { autoStart: true, updateRepo: "subeichen1/casthub", keepMe: 42 },
    network: {
      proxy: "http://127.0.0.1:7890",
      githubMirror: "https://mirror.example/gh",
      githubToken: "stored-secret-token",
      catalogUrl: "https://example.com/catalog.json"
    }
  }, null, 2));
  const stored = readStoredNetworkConfig(configDir);
  assertOk(stored.githubToken === "stored-secret-token", "读取 config.json network 中的 token");
  const saved = saveStoredNetworkConfig(configDir, {
    proxy: "",
    githubMirror: "https://mirror.example/new",
    catalogUrl: "https://example.com/new.json",
    githubToken: ""
  }, stored);
  assertOk(saved.githubToken === "stored-secret-token", "githubToken 留空时保留原 token");
  const savedFile = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8"));
  assertOk(savedFile.desktop.autoStart === true && savedFile.desktop.keepMe === 42, "写回 network 时保留 desktop 其他字段");
  assertOk(savedFile.network.githubToken === "stored-secret-token", "写回文件仍保留原 token");
  const view = networkSettingsView(saved, resolveNetworkConfig(saved, {}), {});
  assertOk(view.hasGithubToken === true && !JSON.stringify(view).includes("stored-secret-token"), "networkSettingsView 只暴露 hasGithubToken，不含 token 明文");
  const cleared = saveStoredNetworkConfig(configDir, { clearGithubToken: true, githubToken: "" }, saved);
  assertOk(cleared.githubToken === "", "clearGithubToken=true 显式清空 token");

  // 1b. 保存设置后热更新：内存配置立即更新，并清理 resolver 磁盘缓存（无需重启）。
  const hotCacheDir = path.join(tempDir, "hot-cache");
  fs.mkdirSync(hotCacheDir, { recursive: true });
  const hotCatalogCache = path.join(hotCacheDir, "catalog-cache.json");
  const hotApiCache = path.join(hotCacheDir, "api-release-cache.json");
  fs.writeFileSync(hotCatalogCache, "{}");
  fs.writeFileSync(hotApiCache, "{}");
  const hotSettings = new NetworkSettingsService(configDir);
  const hotTv = new TvDesktopService({ cacheDir: hotCacheDir, networkSettings: hotSettings });
  let hotChanges = 0;
  hotSettings.onChange = () => {
    hotChanges += 1;
    hotTv.invalidateNetworkCaches();
  };
  hotSettings.save({
    proxy: "",
    githubMirror: origin + "/m-good",
    githubToken: "hot-token",
    catalogUrl: origin + "/catalog-empty"
  });
  assertOk(hotChanges === 1, "保存网络设置触发热更新回调");
  assertOk(
    hotSettings.config.githubMirror === origin + "/m-good" && hotSettings.config.githubToken === "hot-token",
    "保存后内存配置立即使用新镜像与 Token"
  );
  const hotReleaseOptions = hotTv.releaseOptions();
  assertOk(
    hotReleaseOptions.resolverOptions?.githubMirror === origin + "/m-good" &&
      hotReleaseOptions.resolverOptions?.githubToken === "hot-token" &&
      hotReleaseOptions.resolverOptions?.catalogUrl === origin + "/catalog-empty",
    "TvDesktopService 下一次解析读取新镜像、Token 与目录地址"
  );
  assertOk(!fs.existsSync(hotCatalogCache) && !fs.existsSync(hotApiCache), "保存网络设置清理 resolver 磁盘缓存");

  // 2. SSRF / 代理 / URL 校验。
  await expectReject(() => normalizeNetworkConfig({ proxy: "socks5://127.0.0.1:1080" }), /http:\/\/|https:\/\//, "拒绝 socks5 代理");
  await expectReject(() => normalizeNetworkConfig({ githubMirror: "https://192.168.1.10/gh" }), /局域网|回环/, "拒绝私网镜像");
  await expectReject(() => normalizeNetworkConfig({ catalogUrl: "ftp://example.com/catalog.json" }), /https:\/\//, "拒绝非 https 目录");
  await expectReject(() => normalizeNetworkConfig({ githubMirror: "https://example.com/gh?x=1" }), /查询参数/, "拒绝带查询参数的镜像前缀");
  await expectReject(() => normalizeNetworkConfig({ proxy: "http://user:dummy@127.0.0.1:7890" }), /用户名|密码/, "拒绝带凭据的代理");
  const envConfig = resolveNetworkConfig(
    { proxy: "", githubMirror: "https://stored.example/gh", githubToken: "", catalogUrl: "" },
    { CASTHUB_GITHUB_MIRROR: "https://env.example/gh", CASTHUB_GITHUB_TOKEN: "env-token", CASTHUB_CATALOG_URL: "https://env.example/catalog.json" }
  );
  assertOk(envConfig.githubMirror === "https://env.example/gh" && envConfig.githubToken === "env-token", "环境变量优先于 config.json");
  assertOk(networkSettingsView({ proxy: "", githubMirror: "", githubToken: "", catalogUrl: "" }, envConfig, {
    CASTHUB_GITHUB_MIRROR: "https://env.example/gh"
  }).overrides.githubMirror === true, "视图标记环境变量覆盖");

  // 3. NetworkClient 通过本地 HTTP 代理发起请求（普通代理或 CONNECT 均可）。
  const networkClient = new NetworkClient({
    proxy: proxyOrigin,
    useEnvProxy: false,
    noProxy: "",
    githubMirror: "",
    githubToken: "",
    catalogUrl: ""
  });
  try {
    const response = await networkClient.fetch(origin + "/proxy-target");
    const body = await response.text();
    assertOk(body.includes("proxy") && proxyHits.length > 0, "network.proxy 生效: " + proxyHits[0]);
  } finally {
    await networkClient.close();
  }

  const cacheDir = path.join(tempDir, "cache");
  const downloadLog = [];
  const downloadFetcher = makeDownloadFetcher(downloadLog);

  // 4. 镜像 1 返回 text/html，自动切到镜像 2。
  const htmlRelease = makeRelease("html", "https://github.com/e2e/html.apk", apkSha);
  const htmlDownload = await downloadApk(htmlRelease, cacheDir, {
    githubMirror: origin + "/m-html",
    mirrors: [origin + "/m-good"],
    fetcher: downloadFetcher
  });
  assertOk(htmlDownload.sha256 === apkSha && downloadLog.some((item) => item.url.startsWith(origin + "/m-good")), "镜像返回 text/html 时自动切到下一镜像");

  // 5. 镜像 1 篡改字节，SHA-256 失败后删除 .part 并回退源站。
  const tamperRelease = makeRelease("tamper", "https://github.com/e2e/tamper.apk", apkSha);
  const tamperLog = [];
  const tamperDownload = await downloadApk(tamperRelease, cacheDir, {
    githubMirror: origin + "/m-tamper",
    fetcher: makeDownloadFetcher(tamperLog)
  });
  assertOk(tamperDownload.sha256 === apkSha, "镜像篡改字节后 SHA-256 失败并回退源站成功");
  assertOk(!fs.readdirSync(cacheDir).some((name) => name.endsWith(".part") || name.endsWith(".meta.json")), "校验失败后清理 .part 与 meta");
  assertOk(tamperLog.some((item) => item.url.startsWith("https://github.com/")), "篡改镜像后请求原始 GitHub 源站");

  // 6. 缺少可信 SHA-256 时完全跳过镜像。
  const noShaRelease = makeRelease("no-sha", "https://github.com/e2e/no-sha.apk", null);
  const noShaLog = [];
  const noShaDownload = await downloadApk(noShaRelease, cacheDir, {
    githubMirror: origin + "/m-html",
    mirrors: [origin + "/m-good"],
    fetcher: makeDownloadFetcher(noShaLog)
  });
  assertOk(noShaDownload.sha256 === apkSha && noShaLog.length === 1 && noShaLog[0].url.startsWith("https://github.com/"), "无 SHA-256 时只请求原始地址，不启用镜像");

  // 7. 非 GitHub 域名不被镜像前缀包裹。
  const nonGithubRelease = makeRelease("non-github", "https://downloads.example.com/e2e/app.apk", apkSha);
  const nonGithubLog = [];
  const nonGithubDownload = await downloadApk(nonGithubRelease, cacheDir, {
    githubMirror: origin + "/m-html",
    mirrors: [origin + "/m-good"],
    fetcher: makeDownloadFetcher(nonGithubLog)
  });
  assertOk(nonGithubDownload.sha256 === apkSha && nonGithubLog.length === 1 && nonGithubLog[0].url === nonGithubRelease.apkUrl, "非 GitHub 域名不被镜像包裹");

  // 8. 同源半字节断开后重试 Range，206 拼装后 SHA-256 通过。
  const resumeRelease = makeRelease("resume", "https://github.com/e2e/resume.apk", apkSha);
  const resumeLog = [];
  const resumeDownload = await downloadApk(resumeRelease, cacheDir, { fetcher: makeDownloadFetcher(resumeLog) });
  const resumeRanges = resumeLog.map((item) => item.range).filter(Boolean);
  assertOk(resumeDownload.sha256 === apkSha && resumeRanges.length >= 1 && resumeRanges[0].startsWith("bytes="), "同源断开后按 Range 续传并通过 SHA-256: " + resumeRanges[0]);
  assertOk(serverHits.some((hit) => hit.path.startsWith("/m-half-resume") && hit.range), "服务端收到续传 Range 请求");

  // 9. 镜像 1 连续中断后切镜像 2，切换候选源必须清空 .part 且不带旧 Range。
  const switchRelease = makeRelease("switch", "https://github.com/e2e/switch.apk", apkSha);
  const switchLog = [];
  const switchDownload = await downloadApk(switchRelease, cacheDir, {
    githubMirror: origin + "/m-half-fail",
    mirrors: [origin + "/m-good"],
    fetcher: makeDownloadFetcher(switchLog)
  });
  const goodRequests = switchLog.filter((item) => item.url.startsWith(origin + "/m-good"));
  assertOk(switchDownload.sha256 === apkSha, "镜像连续中断后切换到镜像 2 成功");
  assertOk(goodRequests.length === 1 && goodRequests[0].range === null, "切换候选源不带旧 Range");
  assertOk(!fs.readdirSync(cacheDir).some((name) => name.endsWith(".part") || name.endsWith(".meta.json")), "切换候选源后清理旧 .part");

  // 10. 同一个 APK 并发两次只触发一次上游下载。
  const concurrentRelease = makeRelease("concurrent", "https://github.com/e2e/concurrent.apk", apkSha);
  const concurrentLog = [];
  const concurrentFetcher = makeDownloadFetcher(concurrentLog);
  const [first, second] = await Promise.all([
    downloadApk(concurrentRelease, cacheDir, { fetcher: concurrentFetcher }),
    downloadApk(concurrentRelease, cacheDir, { fetcher: concurrentFetcher })
  ]);
  assertOk(first.filePath === second.filePath && concurrentHits === 1, "并发下载同一 APK 只触发一次上游请求");
  assertOk(concurrentLog.filter((item) => item.url.includes("concurrent")).length === 1, "并发合并后下载 fetcher 只收到一次请求");

  // 11. resolver：目录缺失应用时回退 API；api.github.com 收到 Bearer，目录/下载请求绝不带 Authorization。
  const resolverFetcher = async (input, init = {}) => {
    const raw = String(input);
    const authorization = new Headers(init.headers ?? {}).get("authorization");
    if (raw.startsWith("https://api.github.com/")) {
      resolverApiAuth.push(authorization);
      return jsonBody([{
        tag_name: "v9.9.9",
        draft: false,
        prerelease: false,
        published_at: "2026-01-01T00:00:00.000Z",
        assets: [{
          name: "hongguo-tv-9.9.9.apk",
          browser_download_url: "https://github.com/example/hongguo-tv-9.9.9.apk",
          size: apkBytes.length,
          digest: "sha256:" + apkSha
        }]
      }]);
    }
    resolverOtherAuth.push(authorization);
    return nativeFetch(raw, init);
  };
  const resolverApiAuth = [];
  const resolverOtherAuth = [];
  const hongguo = findTvApp("hongguo");
  assert.ok(hongguo, "找到红果应用定义");
  const hongguoVariant = hongguo.variants.find((variant) => variant.id === "standard");
  const resolved = await resolveTvAppRelease(hongguo, hongguoVariant, {
    cacheDir: path.join(tempDir, "resolver"),
    force: true,
    catalogUrl: origin + "/catalog-empty",
    githubToken: "secret-token",
    apiBase: "https://api.github.com",
    fetcher: resolverFetcher
  });
  assertOk(resolved.release?.tag === "v9.9.9" && resolved.source === "api", "目录缺失应用时回退 GitHub API");
  assertOk(resolverApiAuth[0] === "Bearer secret-token", "api.github.com 收到 Bearer token");
  assertOk(resolverOtherAuth.every((value) => value === null), "目录请求不携带 Authorization");
  assertOk(resolved.mirrors.includes(origin + "/m-good"), "resolver 返回目录 mirrors 供下载回退");

  const allDownloadAuth = downloadLog.concat(tamperLog, noShaLog, nonGithubLog, resumeLog, switchLog, concurrentLog).map((item) => item.authorization);
  assertOk(allDownloadAuth.every((value) => value === null), "所有下载/镜像请求均不携带 Authorization");
}

let failures = 0;
try {
  await main();
  console.log("\nStep 3 网络 E2E 全部通过");
} catch (error) {
  failures = 1;
  console.error("\nStep 3 网络 E2E 失败: " + (error?.stack ?? error));
} finally {
  mockServer.closeAllConnections?.();
  proxyServer.closeAllConnections?.();
  await new Promise((resolve) => mockServer.close(resolve));
  await new Promise((resolve) => proxyServer.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}
process.exitCode = failures;
