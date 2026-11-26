#!/usr/bin/env node
// 生成 TV 应用静态目录（GitHub Actions 使用，零第三方依赖，仅 Node 22 原生 fetch）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META_PATH = path.resolve(HERE, "../src/tv-apps-meta.json");
const MAX_CHECKSUM_BYTES = 256 * 1024;
const API_TIMEOUT_MS = 30_000;

function envValue(name) {
  return (process.env[name] ?? "").trim();
}

function argValue(name, fallback = "") {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function isLoopbackHostname(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isAllowedUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && envValue("CASTHUB_ALLOW_INSECURE_LOOPBACK") === "1" && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}

function assertAllowedUrl(raw) {
  if (!isAllowedUrl(raw)) throw new Error("只允许 https://（测试环境仅允许本机 http://）: " + raw);
  return raw;
}

function apiBase() {
  const base = envValue("CASTHUB_GITHUB_API_BASE") || envValue("GITHUB_API_BASE") || "https://api.github.com";
  return assertAllowedUrl(base).replace(/\/+$/, "");
}

function githubHeaders(url) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "CastHub-Catalog-Builder"
  };
  const token = envValue("GITHUB_TOKEN");
  // 凭据只允许发给 api.github.com，绝不发给镜像或资产下载地址。
  if (token && new URL(url).hostname === "api.github.com") {
    headers.Authorization = "Bearer " + token;
  }
  return headers;
}

async function fetchResponse(url, init = {}) {
  assertAllowedUrl(url);
  const response = await fetch(url, {
    ...init,
    redirect: "follow",
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error("HTTP " + response.status + " " + url);
  return response;
}

async function readTextLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared && declared > maxBytes) throw new Error("文件超过 " + maxBytes + " 字节限制");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("响应为空");
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) throw new Error("文件超过 " + maxBytes + " 字节限制");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchJson(url, headers = {}) {
  const response = await fetchResponse(url, { headers });
  return JSON.parse(await response.text());
}

async function fetchText(url) {
  const response = await fetchResponse(url, { headers: { "User-Agent": "CastHub-Catalog-Builder" } });
  return readTextLimited(response, MAX_CHECKSUM_BYTES);
}

function parseDigest(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/^sha256:([0-9a-f]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

function selectRelease(meta, payload) {
  if (!meta.releaseTagPattern) return payload && typeof payload === "object" ? payload : null;
  if (!Array.isArray(payload)) return null;
  let pattern;
  try {
    pattern = new RegExp(meta.releaseTagPattern);
  } catch {
    return null;
  }
  let firstPrerelease = null;
  for (const item of payload) {
    if (!item || typeof item !== "object" || item.draft === true) continue;
    const tag = typeof item.tag_name === "string" ? item.tag_name : "";
    if (!pattern.test(tag)) continue;
    const assets = Array.isArray(item.assets) ? item.assets : [];
    const hasApk = assets.some((asset) => asset && typeof asset.name === "string" && /\.apk$/i.test(asset.name));
    if (!hasApk) continue;
    if (item.prerelease === true) {
      if (!firstPrerelease) firstPrerelease = item;
      continue;
    }
    return item;
  }
  return firstPrerelease;
}

function releaseUrl(meta, base) {
  return meta.releaseTagPattern
    ? base + "/repos/" + meta.repo + "/releases?per_page=15"
    : base + "/repos/" + meta.repo + "/releases/latest";
}

async function fetchRelease(meta) {
  const base = apiBase();
  const url = releaseUrl(meta, base);
  const payload = await fetchJson(url, githubHeaders(url));
  const release = selectRelease(meta, payload);
  if (!release) {
    throw new Error(
      meta.releaseTagPattern
        ? "最近 15 条 Release 中没有匹配 " + meta.releaseTagPattern + " 且包含 .apk 的版本"
        : "找不到 latest Release"
    );
  }
  return release;
}

function checksumAssetFor(release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  return assets.find((asset) => {
    const name = typeof asset?.name === "string" ? asset.name.toLowerCase() : "";
    return name === "sha256sums.txt" || name === "checksums.txt";
  });
}

function parseChecksumText(text, expectedNames) {
  const result = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    let hash = "";
    let name = "";
    const gnu = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (gnu) {
      hash = gnu[1].toLowerCase();
      name = gnu[2].trim();
    } else {
      const openssl = line.match(/^SHA256\s*\((.+)\)\s*=\s*([0-9a-f]{64})$/i);
      if (openssl) {
        name = openssl[1].trim();
        hash = openssl[2].toLowerCase();
      }
    }
    if (hash && name && expectedNames.has(name.toLowerCase())) {
      result.set(name.toLowerCase(), hash);
    }
  }
  return result;
}

async function checksumMapFor(release, apkAssets) {
  const checksumAsset = checksumAssetFor(release);
  if (!checksumAsset || typeof checksumAsset.browser_download_url !== "string") return new Map();
  const text = await fetchText(checksumAsset.browser_download_url);
  return parseChecksumText(text, new Set(apkAssets.map((asset) => asset.name.toLowerCase())));
}

async function normalizeRelease(meta, release) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const apkAssets = assets.filter(
    (asset) => asset && typeof asset.name === "string" && /\.apk$/i.test(asset.name)
  );
  const needsChecksum = apkAssets.some((asset) => !parseDigest(asset.digest));
  const checksums = needsChecksum ? await checksumMapFor(release, apkAssets) : new Map();
  return {
    repo: meta.repo,
    tag_name: typeof release.tag_name === "string" ? release.tag_name : "",
    published_at: typeof release.published_at === "string" ? release.published_at : null,
    assets: apkAssets.map((asset) => {
      const name = asset.name;
      const digest = parseDigest(asset.digest) ?? checksums.get(name.toLowerCase()) ?? null;
      return {
        name,
        browser_download_url: typeof asset.browser_download_url === "string" ? asset.browser_download_url : "",
        size: typeof asset.size === "number" ? asset.size : 0,
        digest: digest ? "sha256:" + digest : null
      };
    })
  };
}

async function loadPrevious(file) {
  if (!file) return null;
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch (error) {
    console.warn("读取上一版目录失败，按首次生成处理: " + (error instanceof Error ? error.message : String(error)));
    return null;
  }
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortValue(value[key])])
    );
  }
  return value;
}

function sameCatalogContent(left, right) {
  return JSON.stringify(sortValue({ apps: left?.apps ?? {}, mirrors: left?.mirrors ?? [] })) ===
    JSON.stringify(sortValue({ apps: right?.apps ?? {}, mirrors: right?.mirrors ?? [] }));
}

function normalizeMirrors(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("tv-apps-meta.json 的 mirrors 必须是字符串数组");
  const result = [];
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) throw new Error("tv-apps-meta.json 的 mirrors 含空值");
    const url = new URL(item.trim());
    if (url.protocol !== "https:") throw new Error("mirrors 只允许 https:// 前缀: " + item);
    result.push(item.trim().replace(/\/+$/, ""));
  }
  return [...new Set(result)];
}

async function writeJsonAtomic(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = file + ".tmp-" + process.pid;
  await fs.promises.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.promises.rename(temp, file);
}

async function main() {
  const meta = JSON.parse(await fs.promises.readFile(META_PATH, "utf8"));
  const previousPath = argValue("--previous");
  const outPath = path.resolve(argValue("--out", "tv-catalog.json"));
  const previous = await loadPrevious(previousPath);
  const apps = {};
  const failures = [];

  for (const app of meta.apps) {
    try {
      const release = await fetchRelease(app);
      apps[app.id] = await normalizeRelease(app, release);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[" + app.id + "] 拉取失败: " + message);
      failures.push(app.id);
      if (previous?.apps?.[app.id]) apps[app.id] = previous.apps[app.id];
    }
  }

  const mirrors = normalizeMirrors(meta.mirrors);
  const output = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mirrors,
    apps
  };
  const usable = Object.keys(apps).length;
  if (usable === 0 && failures.length === meta.apps.length) {
    console.error("全部应用仓库拉取失败，且没有可用的旧目录数据");
    return 1;
  }

  const unchanged = !!previous && sameCatalogContent(previous, output);
  if (unchanged) {
    // 内容未变时保留上一版 generatedAt，避免每 4 小时产生无意义提交并破坏客户端 ETag。
    if (!fs.existsSync(outPath)) {
      await writeJsonAtomic(outPath, previous);
    }
    console.log("NO_CHANGES");
    return 0;
  }

  await writeJsonAtomic(outPath, output);
  console.log("CHANGED");
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
