// CastHub portable 自动更新工具函数：仅使用 Node 内置模块与 fast-xml-parser，方便独立测试。
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { XMLParser } = require("fast-xml-parser");

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_HEADER_TIMEOUT_MS = 15 * 1000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30 * 1000;
const MAX_UPDATE_BYTES = 350 * 1024 * 1024;
const GITHUB_DOWNLOAD_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"]);
// 国内可用的 GitHub 下载加速前缀。仅在已有可信 SHA-256 时启用，见 downloadFile。
const DEFAULT_GITHUB_MIRRORS = Object.freeze(["https://gh-proxy.com", "https://ghproxy.net"]);

function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function allowInsecureLoopback() {
  return process.env.CASTHUB_ALLOW_INSECURE_LOOPBACK === "1";
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function isPrivateHostname(hostname) {
  const host = String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".lan") ||
    host.endsWith(".home") ||
    host.endsWith(".home.arpa")
  ) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return false;
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (host === "::" || host === "::1") return true;
  const first = host.split(":")[0] || "0";
  const prefix = Number.parseInt(first, 16);
  return Number.isFinite(prefix) && ((prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80);
}

/** 校验更新下载地址：生产环境必须是 HTTPS，测试环境可显式允许本机回环 HTTP。 */
function isAllowedDownloadUrl(value, options = {}) {
  if (typeof value !== "string") return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const insecureLoopback =
    parsed.protocol === "http:" && allowInsecureLoopback() && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !insecureLoopback) return false;
  if (!parsed.hostname || parsed.username || parsed.password) return false;
  if (options.mirrorPrefix) {
    if (parsed.search) return false;
  } else if (parsed.hash) {
    return false;
  }
  if (isPrivateHostname(parsed.hostname) && !insecureLoopback) return false;
  return true;
}

function isGitHubDownloadUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && GITHUB_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function normalizeSha256(value) {
  const text = String(value == null ? "" : value)
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
  return /^[a-f0-9]{64}$/.test(text) ? text : "";
}

/**
 * 解析 GNU sha256sum 输出。
 * 兼容 "hash  filename" 与 "hash *filename"，忽略空行和 # 注释。
 */
function parseChecksums(text) {
  const result = {};
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?(.+)$/.exec(line);
    if (!match) continue;
    const filename = match[2].trim();
    if (!filename) continue;
    result[filename] = match[1].toLowerCase();
  }
  return result;
}

/**
 * 从 GitHub Release assets 中挑选 portable exe 与 checksums.txt。
 * 文件名大小写不敏感；缺少任一资产时返回明确错误。
 */
function pickUpdateAssets(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const findAsset = (name) => {
    const normalized = name.toLowerCase();
    return list.find((asset) => asset && typeof asset.name === "string" && asset.name.toLowerCase() === normalized);
  };
  const exe = findAsset("CastHub.exe");
  const checksum = findAsset("checksums.txt");
  if (!exe || !checksum) throw new Error("Release 缺少 CastHub.exe 或 checksums.txt");
  const exeUrl = exe.browser_download_url;
  const checksumUrl = checksum.browser_download_url;
  if (!isHttpsUrl(exeUrl) || !isHttpsUrl(checksumUrl)) {
    throw new Error("CastHub.exe 或 checksums.txt 的下载地址不是 HTTPS");
  }
  const size = Number(exe.size);
  return {
    exeUrl,
    checksumUrl,
    exeSize: Number.isFinite(size) && size > 0 ? size : 0,
    // GitHub Release API 自带资产摘要（sha256:...），可省去先下载 checksums.txt。
    exeSha256: normalizeSha256(exe.digest),
  };
}

/**
 * 规范化 GitHub 仓库标识：支持 owner/repo 与 https://github.com/owner/repo。
 * 非 github.com 的自定义更新地址返回空字符串，不参与备用线路。
 */
function normalizeRepoSlug(value) {
  const text = String(value == null ? "" : value)
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text)) return text;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return "";
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length >= 2 && /^[A-Za-z0-9_.-]+$/.test(parts[0]) && /^[A-Za-z0-9_.-]+$/.test(parts[1])) {
      return parts[0] + "/" + parts[1];
    }
  } catch {
    // 普通 owner/repo 已在上面处理，非法 URL 直接返回空。
  }
  return "";
}

/** 从 GitHub Releases 页面 URL 或 Location 中提取 tag。 */
function parseReleaseTagFromUrl(value) {
  try {
    const parsed = new URL(String(value == null ? "" : value));
    const match = /\/releases\/tag\/([^/?#]+)/i.exec(parsed.pathname);
    return match ? decodeURIComponent(match[1]) : "";
  } catch {
    return "";
  }
}

/** 解析 GitHub releases.atom，返回第一条 release 的 tag。 */
function parseAtomLatestTag(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const parsed = parser.parse(String(xml == null ? "" : xml));
  const feed = parsed && parsed.feed ? parsed.feed : parsed;
  const rawEntries = feed && feed.entry;
  const entries = Array.isArray(rawEntries) ? rawEntries : rawEntries ? [rawEntries] : [];
  for (const entry of entries) {
    const rawLinks = entry && entry.link;
    const links = Array.isArray(rawLinks) ? rawLinks : rawLinks ? [rawLinks] : [];
    for (const link of links) {
      const rel = link && link["@_rel"];
      const href = link && link["@_href"];
      if (rel === "alternate" && typeof href === "string") {
        const tag = parseReleaseTagFromUrl(href);
        if (tag) return tag;
      }
    }
  }
  throw new Error("Releases Atom 中没有找到版本标签");
}

/** 由 tag 拼出与 GitHub Release API 兼容的 CastHub 资产结构。 */
function buildReleaseInfoFromTag(repo, tag) {
  const slug = normalizeRepoSlug(repo);
  if (!slug) throw new Error("更新仓库不是有效的 GitHub owner/repo");
  const cleanTag = String(tag == null ? "" : tag).trim();
  if (!cleanTag || /[?#]/.test(cleanTag)) throw new Error("Release 版本标签不合法");
  const base = "https://github.com/" + slug + "/releases/download/" + encodeURIComponent(cleanTag);
  return {
    tag_name: cleanTag,
    assets: [
      { name: "CastHub.exe", browser_download_url: base + "/CastHub.exe", size: 0 },
      { name: "checksums.txt", browser_download_url: base + "/checksums.txt", size: 0 },
    ],
  };
}

/**
 * GitHub API 不可用时的版本信息兜底：
 * 1) GitHub 官方 releases.atom（不消耗 API 配额）；
 * 2) GitHub /releases/latest 的 302 Location（不消耗 API 配额）。
 * 只访问 github.com，不把 token 发给第三方，也不把镜像当元数据源。
 */
async function fetchLatestReleaseFallback(fetcher, repo, options = {}) {
  const slug = normalizeRepoSlug(repo);
  if (!slug) throw new Error("更新仓库不是有效的 GitHub owner/repo");
  const doFetch = typeof fetcher === "function" ? fetcher : globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("当前环境不支持 fetch，无法检查更新");
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 10000;
  const request = (url, extra) =>
    doFetch(url, {
      ...extra,
      signal: options.signal || AbortSignal.timeout(timeoutMs),
    });
  const errors = [];
  const messageOf = (error) => (error && error.message ? error.message : String(error));

  try {
    const response = await request("https://github.com/" + slug + "/releases.atom", {
      redirect: "follow",
      headers: {
        Accept: "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "CastHub",
      },
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const tag = parseAtomLatestTag(await response.text());
    return { tag, source: "atom", release: buildReleaseInfoFromTag(slug, tag) };
  } catch (error) {
    errors.push("releases.atom：" + messageOf(error));
  }

  try {
    const latestUrl = "https://github.com/" + slug + "/releases/latest";
    const response = await request(latestUrl, {
      redirect: "manual",
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "CastHub" },
    });
    let tag = "";
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) tag = parseReleaseTagFromUrl(new URL(location, latestUrl).href);
    }
    if (!tag && response.url) tag = parseReleaseTagFromUrl(response.url);
    if (!tag) throw new Error("HTTP " + response.status + " 且未找到版本跳转");
    return { tag, source: "redirect", release: buildReleaseInfoFromTag(slug, tag) };
  } catch (error) {
    errors.push("releases/latest：" + messageOf(error));
  }

  throw new Error("备用更新线路均失败：" + errors.join("；"));
}

/** 用流式计算文件 SHA-256。 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

/** 把 GitHub 原地址包进用户配置的镜像前缀；非 GitHub 域名绝不套镜像。 */
function buildMirrorUrl(originalUrl, mirrorPrefix) {
  if (!isGitHubDownloadUrl(originalUrl) || !mirrorPrefix) return null;
  const prefix = String(mirrorPrefix).trim().replace(/\/+$/, "");
  if (!prefix || !isAllowedDownloadUrl(prefix, { mirrorPrefix: true })) return null;
  return prefix + "/" + originalUrl;
}

/**
 * 生成候选下载地址：用户 githubMirror 优先，其次目录/服务端下发的 mirrors，最后原始地址。
 * 仅对 GitHub 下载域名套镜像；去重后返回。
 */
function buildDownloadCandidates(url, options = {}) {
  if (!isAllowedDownloadUrl(url)) throw new Error("下载地址必须是 HTTPS");
  const candidates = [];
  const push = (candidate) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };
  const mirrorValues = [];
  if (typeof options.githubMirror === "string" && options.githubMirror.trim()) {
    mirrorValues.push(options.githubMirror);
  }
  if (Array.isArray(options.mirrors)) {
    for (const mirror of options.mirrors) {
      if (typeof mirror === "string" && mirror.trim()) mirrorValues.push(mirror);
    }
  }
  for (const mirror of mirrorValues) push(buildMirrorUrl(url, mirror));
  push(url);
  return candidates;
}

async function readPartialMeta(metaPath) {
  try {
    const raw = await fs.promises.readFile(metaPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return {
      url: typeof parsed.url === "string" ? parsed.url : "",
      sha256: typeof parsed.sha256 === "string" ? parsed.sha256 : "",
      bytes: Number.isFinite(Number(parsed.bytes)) ? Number(parsed.bytes) : 0,
    };
  } catch {
    return null;
  }
}

async function writePartialMeta(metaPath, meta) {
  const temp = metaPath + ".tmp-" + process.pid + "-" + Date.now();
  try {
    await fs.promises.writeFile(temp, JSON.stringify(meta) + "\n", "utf8");
    await fs.promises.rename(temp, metaPath);
  } catch {
    await fs.promises.rm(temp, { force: true }).catch(() => {});
  }
}

async function removePartial(destination) {
  await fs.promises.rm(destination, { force: true }).catch(() => {});
  await fs.promises.rm(destination + ".meta.json", { force: true }).catch(() => {});
}

function parseContentRange(value) {
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(String(value || "").trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? 0 : Number(match[3]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (match[3] !== "*" && !Number.isFinite(total)) return null;
  return { start, end, total };
}

function rejectedContentType(contentType, allowText) {
  const type = String(contentType || "").toLowerCase();
  if (!type) return false;
  if (type.includes("text/html") || type.includes("application/json")) return true;
  return !allowText && type.includes("text/plain");
}

function timeoutMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function statSize(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function downloadOnce(candidate, destination, options, onProgress) {
  const expectedSha = normalizeSha256(options.expectedSha256);
  const metaPath = destination + ".meta.json";
  const currentMeta = await readPartialMeta(metaPath);
  let existing = await statSize(destination);
  let offset = 0;
  if (
    existing > 0 &&
    existing < MAX_UPDATE_BYTES &&
    currentMeta &&
    currentMeta.url === candidate &&
    (!expectedSha || currentMeta.sha256 === expectedSha)
  ) {
    offset = existing;
  } else if (existing > 0) {
    await removePartial(destination);
    existing = 0;
  }
  await writePartialMeta(metaPath, { url: candidate, sha256: expectedSha, bytes: offset });

  const controller = new AbortController();
  const headerTimeout = timeoutMs("CASTHUB_UPDATE_HEADER_TIMEOUT_MS", DOWNLOAD_HEADER_TIMEOUT_MS);
  const headerTimer = setTimeout(() => controller.abort(new Error("下载响应超时")), headerTimeout);
  let response;
  try {
    response = await options.fetcher(candidate, {
      redirect: "follow",
      signal: controller.signal,
      headers: offset > 0 ? { Range: "bytes=" + offset + "-" } : {},
    });
  } catch (error) {
    clearTimeout(headerTimer);
    throw error;
  } finally {
    clearTimeout(headerTimer);
  }

  let idleTimer = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error("下载空闲超时")),
      timeoutMs("CASTHUB_UPDATE_IDLE_TIMEOUT_MS", DOWNLOAD_IDLE_TIMEOUT_MS),
    );
  };
  try {
    if (response.url && !isAllowedDownloadUrl(response.url)) {
      throw new Error("下载重定向到了非 HTTPS 地址");
    }
    if (response.status !== 200 && response.status !== 206) {
      throw new Error("下载失败：HTTP " + response.status);
    }
    if (rejectedContentType(response.headers.get("content-type"), options.allowText === true)) {
      throw new Error("下载源返回了网页或文本内容，已切换来源");
    }
    if (!response.body) throw new Error("下载失败：响应没有文件内容");

    let total = 0;
    if (response.status === 206) {
      const range = parseContentRange(response.headers.get("content-range"));
      if (!range || range.start !== offset) {
        if (offset > 0) {
          await removePartial(destination);
          return downloadOnce(candidate, destination, options, onProgress);
        }
        throw new Error("服务器返回的 Content-Range 不合法");
      }
      total = range.total > 0 ? range.total : offset + (Number(response.headers.get("content-length")) || 0);
      if (total > MAX_UPDATE_BYTES) throw new Error("更新包体积异常：" + total + " 字节");
    } else {
      if (offset > 0) {
        await fs.promises.rm(destination, { force: true });
        offset = 0;
      }
      const contentLength = Number(response.headers.get("content-length"));
      total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
      if (total > MAX_UPDATE_BYTES) throw new Error("更新包体积异常：" + total + " 字节");
    }

    const handle = await fs.promises.open(destination, offset > 0 ? "a" : "w");
    let received = offset;
    let lastMetaBytes = offset;
    resetIdle();
    try {
      if (typeof onProgress === "function") {
        onProgress({
          received,
          total,
          percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
        });
      }
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        resetIdle();
        const chunk = Buffer.from(value);
        await handle.write(chunk);
        received += chunk.length;
        if (received > MAX_UPDATE_BYTES) throw new Error("更新包体积异常，已中止下载");
        if (received - lastMetaBytes >= 1024 * 1024) {
          lastMetaBytes = received;
          await writePartialMeta(metaPath, { url: candidate, sha256: expectedSha, bytes: received });
        }
        if (typeof onProgress === "function") {
          const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
          onProgress({ received, total, percent });
        }
      }
    } finally {
      clearTimeout(idleTimer);
      await handle.close().catch(() => {});
    }
    await writePartialMeta(metaPath, { url: candidate, sha256: expectedSha, bytes: received });
    if (typeof onProgress === "function") {
      onProgress({ received, total: total || received, percent: 100 });
    }
    return { received, total: total || received, url: candidate };
  } catch (error) {
    clearTimeout(idleTimer);
    throw error;
  }
}

/**
 * 流式下载更新文件并回报进度。
 * 支持 githubMirror/mirrors 多来源、失败自动切换、同源 Range 续传与 SHA-256 终校验。
 * 兼容旧调用：第三个参数可以是 onProgress 函数。
 */
async function downloadFile(url, destination, optionsOrProgress) {
  const options =
    typeof optionsOrProgress === "function" ? { onProgress: optionsOrProgress } : { ...(optionsOrProgress || {}) };
  const fetcher = typeof options.fetcher === "function" ? options.fetcher : globalThis.fetch;
  if (typeof fetcher !== "function") throw new Error("当前环境不支持 fetch，无法下载更新");
  const expectedSha = normalizeSha256(options.expectedSha256);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });

  if (expectedSha) {
    const existing = await statSize(destination);
    if (existing > 0) {
      const actual = await sha256File(destination);
      if (actual.toLowerCase() === expectedSha) {
        if (typeof options.onProgress === "function") {
          options.onProgress({ received: existing, total: existing, percent: 100 });
        }
        return { received: existing, total: existing, url: url, cached: true };
      }
      await removePartial(destination);
    }
  }

  // 只有拿到可信 SHA-256（或调用方显式信任无哈希镜像）时才允许启用第三方镜像；
  // 校验文件本身必须优先来自原始 GitHub。
  const mirrorOptions =
    expectedSha || options.allowMirrorWithoutSha ? options : { ...options, githubMirror: "", mirrors: [] };
  const candidates = buildDownloadCandidates(url, mirrorOptions);
  const errors = [];
  for (const candidate of candidates) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await downloadOnce(
          candidate,
          destination,
          {
            ...options,
            fetcher,
            expectedSha256: expectedSha,
          },
          options.onProgress,
        );
        if (expectedSha) {
          const actual = await sha256File(destination);
          if (actual.toLowerCase() !== expectedSha) {
            await removePartial(destination);
            errors.push(candidate + "：SHA-256 校验失败");
            break;
          }
        }
        await fs.promises.rm(destination + ".meta.json", { force: true }).catch(() => {});
        return result;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        const partial = await statSize(destination);
        const retryable =
          attempt === 0 &&
          partial > 0 &&
          partial < MAX_UPDATE_BYTES &&
          !/校验失败|网页或文本|Content-Range/.test(message);
        if (retryable) {
          await writePartialMeta(destination + ".meta.json", {
            url: candidate,
            sha256: expectedSha,
            bytes: partial,
          });
          continue;
        }
        errors.push(candidate + "：" + message);
        await removePartial(destination);
        break;
      }
    }
  }
  throw new Error("下载失败（已尝试 " + candidates.length + " 个来源）：" + errors.join("；"));
}

/**
 * 生成 PowerShell 5.1 可用的 ASCII helper 脚本。
 * helper 必须独立于 Electron/asar 路径，因此主进程会把它写到临时目录。
 */
function buildUpdateHelperScript() {
  return [
    "param(",
    "  [Parameter(Mandatory=$true)][string]$Target,",
    "  [Parameter(Mandatory=$true)][string]$Source,",
    "  [Parameter(Mandatory=$true)][int]$ParentPid,",
    "  [Parameter(Mandatory=$true)][string]$LogPath",
    ")",
    '$ErrorActionPreference = "Continue"',
    "function Write-Log([string]$Message) {",
    '  try { Add-Content -LiteralPath $LogPath -Value ((Get-Date).ToString("s") + " " + $Message) -Encoding ASCII } catch { }',
    "}",
    'Write-Log "HELPER_START target=$Target source=$Source parent=$ParentPid"',
    "$parentDeadline = (Get-Date).AddSeconds(30)",
    "while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $parentDeadline)) { Start-Sleep -Milliseconds 200 }",
    'if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { Write-Log "PARENT_STILL_RUNNING" } else { Write-Log "PARENT_EXITED" }',
    '$oldTarget = $Target + ".old"',
    "$deadline = (Get-Date).AddSeconds(120)",
    "while ((Get-Date) -lt $deadline) {",
    "  $moved = $false",
    "  try {",
    "    if (Test-Path -LiteralPath $oldTarget) { Remove-Item -LiteralPath $oldTarget -Force -ErrorAction Stop }",
    "    if (Test-Path -LiteralPath $Target) {",
    "      Rename-Item -LiteralPath $Target -NewName (Split-Path -Path $oldTarget -Leaf) -Force -ErrorAction Stop",
    "      $moved = $true",
    '      Write-Log ("MOVE_OK target=" + $Target)',
    "    }",
    "    Copy-Item -LiteralPath $Source -Destination $Target -Force -ErrorAction Stop",
    '    Write-Log ("COPY_OK target=" + $Target)',
    "    Start-Process -FilePath $Target -WorkingDirectory (Split-Path -Parent $Target)",
    '    Write-Log ("START_OK target=" + $Target)',
    '    Write-Log "UPDATE_OK target=$Target"',
    "    exit 0",
    "  } catch {",
    '    Write-Log ("RETRY_FAILED " + $_.Exception.Message)',
    "    if ($moved -and (Test-Path -LiteralPath $oldTarget)) {",
    "      try {",
    "        if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force -ErrorAction Stop }",
    "        Rename-Item -LiteralPath $oldTarget -NewName (Split-Path -Path $Target -Leaf) -Force -ErrorAction Stop",
    '        Write-Log "ROLLBACK_OK"',
    '      } catch { Write-Log ("ROLLBACK_FAILED " + $_.Exception.Message) }',
    "    }",
    "    Start-Sleep -Milliseconds 500",
    "  }",
    "}",
    'Write-Log "UPDATE_FAILED target=$Target"',
    "exit 1",
  ].join("\r\n");
}

/** 把 helper 脚本写入临时目录并返回路径。 */
function writeUpdateHelperScript(tempDir) {
  const helperPath = path.join(tempDir, "casthub-update-helper.ps1");
  fs.writeFileSync(helperPath, buildUpdateHelperScript(), "ascii");
  return helperPath;
}

module.exports = {
  DOWNLOAD_TIMEOUT_MS,
  DOWNLOAD_HEADER_TIMEOUT_MS,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  DEFAULT_GITHUB_MIRRORS,
  isHttpsUrl,
  isAllowedDownloadUrl,
  isGitHubDownloadUrl,
  normalizeSha256,
  normalizeRepoSlug,
  parseReleaseTagFromUrl,
  parseAtomLatestTag,
  buildReleaseInfoFromTag,
  fetchLatestReleaseFallback,
  buildMirrorUrl,
  buildDownloadCandidates,
  parseChecksums,
  pickUpdateAssets,
  sha256File,
  downloadFile,
  buildUpdateHelperScript,
  writeUpdateHelperScript,
};
