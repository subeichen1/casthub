#!/usr/bin/env node
// Step 1 单测：默认变体 auto / 全不匹配 fallback / 多平台 Release Tag 过滤 / APK 200MiB 上限。
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { findTvApp, matchVariantForDevice, parseDeviceProfile } from "../src/tv-apps.ts";
import { clearReleaseCache, downloadApk, fetchAppRelease } from "../src/tv-desktop.ts";

function assert(condition, message) {
  if (!condition) throw new Error("断言失败: " + message);
  console.log("✓ " + message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function expectReject(fn, message) {
  try {
    await fn();
  } catch (error) {
    assert(String(error.message).includes(message), "按预期失败: " + error.message);
    return;
  }
  throw new Error("断言失败: 没有抛出错误");
}

const apkBytes = Buffer.concat([Buffer.from("PK-step1-apk-"), Buffer.alloc(8 * 1024, 0x61)]);
const apkSha = sha256(apkBytes);
let releaseMode = "mixed";
let releaseRequests = 0;

const mockServer = http.createServer((req, res) => {
  const url = req.url ?? "";
  res.on("error", () => undefined);
  if (url.startsWith("/repos/aston314/hongguo-tv-releases/releases")) {
    releaseRequests += 1;
    res.setHeader("Content-Type", "application/json");
    const apkAsset = (name) => ({
      name,
      browser_download_url: "https://github.com/example/" + name,
      size: apkBytes.length,
      digest: "sha256:" + apkSha
    });
    if (releaseMode === "no-match") {
      res.end(JSON.stringify([{ tag_name: "desktop-v1.0.0", assets: [{ name: "desktop.exe" }] }]));
      return;
    }
    if (releaseMode === "prerelease-only") {
      res.end(
        JSON.stringify([
          { tag_name: "v0.3.0-beta", draft: false, prerelease: true, assets: [apkAsset("hongguo-tv-0.3.0-beta.apk")] }
        ])
      );
      return;
    }
    res.end(
      JSON.stringify([
        { tag_name: "v0.2.10", draft: true, assets: [apkAsset("hongguo-tv-0.2.10.apk")] },
        { tag_name: "desktop-v0.2.9", draft: false, assets: [{ name: "desktop.exe" }] },
        { tag_name: "webos-v0.2.8-test.1", draft: false, assets: [{ name: "webos.ipk" }] },
        { tag_name: "v0.2.6-beta", draft: false, prerelease: true, assets: [apkAsset("hongguo-tv-0.2.6-beta.apk")] },
        { tag_name: "v0.2.7", draft: false, assets: [apkAsset("hongguo-tv-0.2.7.apk")] }
      ])
    );
    return;
  }
  if (url === "/catalog-empty") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), mirrors: [], apps: {} }));
    return;
  }
  if (url === "/apk-ok") {
    res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive", "Content-Length": String(apkBytes.length) });
    res.end(apkBytes);
    return;
  }
  if (url === "/apk-big-header") {
    res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive", "Content-Length": "999999" });
    res.end();
    return;
  }
  if (url === "/apk-big-stream") {
    res.writeHead(200, { "Content-Type": "application/vnd.android.package-archive" });
    res.write(Buffer.alloc(2 * 1024, 0x62));
    res.write(Buffer.alloc(2 * 1024, 0x63));
    res.end();
    return;
  }
  res.writeHead(404).end();
});

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-tv-release-"));
const cacheDir = path.join(tempDir, "cache");
let mockPort;

try {
  await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  mockPort = mockServer.address().port;
  process.env.CASTHUB_ALLOW_INSECURE_LOOPBACK = "1";
  process.env.CASTHUB_GITHUB_API_BASE = "http://127.0.0.1:" + mockPort;
  process.env.CASTHUB_CATALOG_URL = "http://127.0.0.1:" + mockPort + "/catalog-empty";
  delete process.env.HONGGUO_RELEASE_JSON;
  delete process.env.AERIAL_RELEASE_JSON;
  delete process.env.TVBOX_RELEASE_JSON;
  clearReleaseCache();

  const aerial = findTvApp("aerial");
  const tvbox = findTvApp("tvbox");
  assert(aerial && tvbox, "找到 Aerial / TVBox 应用定义");

  const defaultAuto = matchVariantForDevice(
    aerial,
    parseDeviceProfile({ "ro.build.version.sdk": "30", "ro.product.cpu.abilist": "arm64-v8a" })
  );
  assert(defaultAuto.variant.id === "standard", "设备命中默认变体: " + defaultAuto.variant.id);
  assert(defaultAuto.source === "auto", "设备命中默认变体时标记 source=auto: " + defaultAuto.source);

  const noProfile = matchVariantForDevice(tvbox, null);
  assert(noProfile.variant.id === "java" && noProfile.source === "fallback", "读不到属性时回退默认变体且 source=fallback");

  const allExcluded = matchVariantForDevice(aerial, parseDeviceProfile({ "ro.build.version.sdk": "19" }));
  assert(allExcluded.variant.id === "standard" && allExcluded.source === "fallback", "全部变体被过滤时回退默认变体且 source=fallback");

  const hongguo = findTvApp("hongguo");
  const standard = hongguo.variants.find((variant) => variant.id === "standard");
  const release = await fetchAppRelease(hongguo, standard, { force: true });
  assert(!!release.release, "通过 mock GitHub API 拿到红果发布: " + (release.error ?? ""));
  assert(release.release.tag === "v0.2.7", "跳过 draft / desktop / webos / prerelease，选中 v0.2.7: " + release.release.tag);
  assert(release.release.apkName === "hongguo-tv-0.2.7.apk", "按 Tag 版本精确匹配 APK: " + release.release.apkName);
  assert(releaseRequests === 1, "使用 /releases?per_page=15 列表接口，而非 /releases/latest");

  releaseMode = "no-match";
  const noMatch = await fetchAppRelease(hongguo, standard, { force: true });
  assert(noMatch.release === null && String(noMatch.error).includes("最近 15 条"), "15 条内无匹配时返回明确错误");

  releaseMode = "prerelease-only";
  const prereleaseOnly = await fetchAppRelease(hongguo, standard, { force: true });
  assert(prereleaseOnly.release?.tag === "v0.3.0-beta", "没有正式版时回退匹配 prerelease: " + prereleaseOnly.release?.tag);

  const okRelease = {
    appId: "step1",
    variantId: "ok",
    packageName: "test.ok",
    tag: "v1",
    version: "1",
    apkName: "ok.apk",
    apkUrl: "http://127.0.0.1:" + mockPort + "/apk-ok",
    sizeBytes: apkBytes.length,
    sha256: apkSha,
    publishedAt: null,
    channel: "custom"
  };
  const downloaded = await downloadApk(okRelease, cacheDir, { maxBytes: apkBytes.length + 1024 });
  assert(downloaded.cached === false && downloaded.sha256 === apkSha, "回环 HTTP APK 正常下载并通过 SHA-256");

  const bigHeaderRelease = { ...okRelease, variantId: "big-header", tag: "big-header", apkUrl: "http://127.0.0.1:" + mockPort + "/apk-big-header" };
  await expectReject(() => downloadApk(bigHeaderRelease, cacheDir, { maxBytes: 1024 }), "超过上限");
  assert(!fs.readdirSync(cacheDir).some((name) => name.endsWith(".part")), "Content-Length 超限后清理 .part");

  const bigStreamRelease = { ...okRelease, variantId: "big-stream", tag: "big-stream", apkUrl: "http://127.0.0.1:" + mockPort + "/apk-big-stream" };
  await expectReject(() => downloadApk(bigStreamRelease, cacheDir, { maxBytes: 1024 }), "超过上限");
  assert(!fs.readdirSync(cacheDir).some((name) => name.endsWith(".part")), "流式接收超限后清理 .part");

  const savedFlag = process.env.CASTHUB_ALLOW_INSECURE_LOOPBACK;
  delete process.env.CASTHUB_ALLOW_INSECURE_LOOPBACK;
  await expectReject(() => downloadApk(okRelease, cacheDir), "https://");
  process.env.CASTHUB_ALLOW_INSECURE_LOOPBACK = savedFlag;

  console.log("\n✅ E2E-TV-RELEASE 全部通过");
} finally {
  await new Promise((resolve) => mockServer.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
}
