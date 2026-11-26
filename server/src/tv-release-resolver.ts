// TV 应用发布解析：环境变量注入 → GitHub Actions 静态目录 → GitHub API 直连兜底。
// 磁盘缓存使用临时文件 + rename 原子写入，目录缓存带 ETag/304，API 缓存带限流降级。
import * as fs from "node:fs";
import * as path from "node:path";
import { fetch as undiciFetch } from "undici";
import { assertRemoteNetworkUrl } from "./network-config";
import {
  type TvAppDefinition,
  type TvAppReleaseInfo,
  type TvAppVariant,
  parseAppCustomRelease,
  parseAppRelease,
  releaseJsonEnvName,
  releasesApiUrl,
  releasesListApiUrl,
  selectReleaseFromList
} from "./tv-apps";

const DEFAULT_CATALOG_URL = "https://raw.githubusercontent.com/subeichen1/casthub/catalog-data/tv-catalog.json";
const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;
const API_CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const AERIAL_FALLBACK_URL = "https://aerial.qust.me/download/aerial-standard.apk";
const GITHUB_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"]);

export type TvReleaseSource = "env" | "catalog" | "api" | "aerial-fallback";

export interface TvReleaseResolverOptions {
  cacheDir: string;
  force?: boolean;
  fetcher?: typeof fetch;
  catalogUrl?: string;
  githubMirror?: string;
  githubToken?: string;
  apiBase?: string;
}

export interface TvReleaseResolution {
  release: TvAppReleaseInfo | null;
  error: string | null;
  source: TvReleaseSource | null;
  warnings: string[];
  /** 静态目录声明的 GitHub 镜像前缀，供 APK 下载按顺序回退。 */
  mirrors: string[];
}

interface CacheEntry {
  etag: string | null;
  fetchedAt: number;
  payload: unknown;
}

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function allowInsecureLoopback(): boolean {
  return envValue("CASTHUB_ALLOW_INSECURE_LOOPBACK") === "1";
}

function isAllowedUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && allowInsecureLoopback() && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function assertAllowedUrl(raw: string): void {
  if (!isAllowedUrl(raw)) throw new Error("只允许 https://（测试环境仅允许本机 http://）: " + raw);
}

function isGithubHostname(hostname: string): boolean {
  return GITHUB_HOSTS.has(hostname.toLowerCase());
}

/** 目录里的 mirrors 属于外部数据：只接受合法 https（测试回环除外），非法项静默跳过。 */
function catalogMirrorsOf(payload: Record<string, unknown>): string[] {
  if (!Array.isArray(payload.mirrors)) return [];
  const result: string[] = [];
  for (const item of payload.mirrors) {
    if (typeof item !== "string" || !item.trim()) continue;
    try {
      assertRemoteNetworkUrl(item.trim(), "目录 mirrors", { mirrorPrefix: true });
      result.push(item.trim().replace(/\/+$/, ""));
    } catch {
      // 忽略目录中非法的镜像前缀，不能让它把下载指向 file:// 或内网。
    }
  }
  return [...new Set(result)];
}

function resolveApiBase(option?: string): string {
  const configured = (option ?? envValue("CASTHUB_GITHUB_API_BASE") ?? "").trim() || "https://api.github.com";
  assertRemoteNetworkUrl(configured, "GITHUB_API_BASE");
  return configured.replace(/\/+$/, "");
}

function resolveCatalogUrl(option?: string): string {
  const configured = (option ?? envValue("CASTHUB_CATALOG_URL") ?? "").trim() || DEFAULT_CATALOG_URL;
  assertRemoteNetworkUrl(configured, "CATALOG_URL");
  return configured;
}

function resolveMirror(option?: string): string {
  const mirror = (option ?? envValue("CASTHUB_GITHUB_MIRROR") ?? "").trim();
  if (!mirror) return "";
  assertRemoteNetworkUrl(mirror, "GITHUB_MIRROR", { mirrorPrefix: true });
  return mirror.replace(/\/+$/, "");
}

function githubHeaders(url: string, token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "CastHub"
  };
  if (token && new URL(url).hostname === "api.github.com") {
    headers.Authorization = "Bearer " + token;
  }
  return headers;
}

async function fetchRaw(
  url: string,
  options: TvReleaseResolverOptions,
  headers: Record<string, string>
): Promise<Response> {
  assertAllowedUrl(url);
  const fetcher = options.fetcher ?? (undiciFetch as typeof fetch);
  const response = await fetcher(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (response.url && !isAllowedUrl(response.url)) {
    throw new Error("请求重定向到了非 HTTPS 地址");
  }
  return response;
}

async function readJsonAtomic(file: string, fallback: unknown): Promise<unknown> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = file + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2);
  await fs.promises.writeFile(temp, JSON.stringify(value), "utf8");
  try {
    await fs.promises.rename(temp, file);
  } catch {
    await fs.promises.rm(file, { force: true });
    await fs.promises.rename(temp, file);
  }
}

function asCacheEntry(value: unknown): CacheEntry | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.fetchedAt !== "number" || !("payload" in data)) return null;
  return {
    etag: typeof data.etag === "string" ? data.etag : null,
    fetchedAt: data.fetchedAt,
    payload: data.payload
  };
}

function catalogCandidates(options: TvReleaseResolverOptions): string[] {
  const primary = resolveCatalogUrl(options.catalogUrl);
  const mirror = resolveMirror(options.githubMirror);
  const candidates: string[] = [];
  if (mirror) {
    try {
      if (isGithubHostname(new URL(primary).hostname)) candidates.push(mirror + "/" + primary);
    } catch {
      // resolveCatalogUrl 已经校验过，这里只是防御。
    }
  }
  candidates.push(primary);
  return [...new Set(candidates)];
}

async function loadCatalog(
  options: TvReleaseResolverOptions
): Promise<{ payload: Record<string, unknown>; warning: string | null }> {
  const cachePath = path.join(options.cacheDir, "catalog-cache.json");
  const cached = asCacheEntry(await readJsonAtomic(cachePath, null));
  if (cached?.payload && !options.force && Date.now() - cached.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return { payload: cached.payload as Record<string, unknown>, warning: null };
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "CastHub"
  };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  let lastError: unknown = null;
  for (const url of catalogCandidates(options)) {
    try {
      const response = await fetchRaw(url, options, headers);
      if (response.status === 304) {
        if (!cached) throw new Error("收到 304 但没有本地目录缓存");
        cached.fetchedAt = Date.now();
        await writeJsonAtomic(cachePath, cached);
        return { payload: cached.payload as Record<string, unknown>, warning: null };
      }
      if (!response.ok) throw new Error("HTTP " + response.status + " " + url);
      const payload = (await response.json()) as unknown;
      if (!payload || typeof payload !== "object" || !(payload as Record<string, unknown>).apps) {
        throw new Error("静态目录格式无效");
      }
      const entry: CacheEntry = {
        etag: response.headers.get("etag"),
        fetchedAt: Date.now(),
        payload
      };
      await writeJsonAtomic(cachePath, entry);
      return { payload: payload as Record<string, unknown>, warning: null };
    } catch (error) {
      lastError = error;
    }
  }

  if (cached?.payload) {
    return {
      payload: cached.payload as Record<string, unknown>,
      warning: "静态目录刷新失败，使用磁盘旧缓存: " + errorMessage(lastError)
    };
  }
  throw new Error("静态目录不可用: " + errorMessage(lastError));
}

async function loadApiRelease(
  app: TvAppDefinition,
  options: TvReleaseResolverOptions
): Promise<{ payload: unknown; warning: string | null }> {
  const apiBase = resolveApiBase(options.apiBase);
  const url = app.releaseTagPattern
    ? releasesListApiUrl(app, apiBase)
    : releasesApiUrl(app, apiBase);
  const cachePath = path.join(options.cacheDir, "api-release-cache.json");
  const cache = (await readJsonAtomic(cachePath, {})) as Record<string, unknown>;
  const cached = asCacheEntry(cache[url]);
  if (cached && !options.force && Date.now() - cached.fetchedAt < API_CACHE_TTL_MS) {
    return { payload: cached.payload, warning: null };
  }

  const token = (options.githubToken ?? envValue("CASTHUB_GITHUB_TOKEN")).trim();
  const headers = githubHeaders(url, token);
  if (cached?.etag) headers["If-None-Match"] = cached.etag;

  let response: Response;
  try {
    response = await fetchRaw(url, options, headers);
  } catch (error) {
    if (cached) return { payload: cached.payload, warning: "GitHub API 请求失败，使用磁盘旧缓存: " + errorMessage(error) };
    throw error;
  }

  if (response.status === 304) {
    if (!cached) throw new Error("收到 304 但没有 API 缓存");
    cached.fetchedAt = Date.now();
    cache[url] = cached;
    await writeJsonAtomic(cachePath, cache);
    return { payload: cached.payload, warning: null };
  }

  const remaining = response.headers.get("x-ratelimit-remaining");
  if ((response.status === 403 || response.status === 429) && remaining === "0") {
    const resetRaw = response.headers.get("x-ratelimit-reset");
    const resetSeconds = resetRaw ? Number(resetRaw) : 0;
    const resetText = resetSeconds > 0 ? new Date(resetSeconds * 1000).toLocaleString("zh-CN", { hour12: false }) : "稍后";
    const message = "GitHub API 请求受限（HTTP " + response.status + "），预计 " + resetText + " 恢复";
    if (cached) return { payload: cached.payload, warning: message + "，已使用磁盘旧缓存" };
    throw new Error(message);
  }
  if (!response.ok) throw new Error("GitHub API 返回 HTTP " + response.status);

  const payload = (await response.json()) as unknown;
  const entry: CacheEntry = {
    etag: response.headers.get("etag"),
    fetchedAt: Date.now(),
    payload
  };
  cache[url] = entry;
  await writeJsonAtomic(cachePath, cache);
  return { payload, warning: null };
}

function resolveEnvRelease(app: TvAppDefinition, variant: TvAppVariant): TvReleaseResolution | null {
  const customPath = envValue(releaseJsonEnvName(app));
  if (!customPath) return null;
  try {
    // Windows 记事本 / PowerShell 5 写出的 JSON 常带 UTF-8 BOM，JSON.parse 会直接报错，这里先剥掉。
    const customText = fs.readFileSync(customPath, "utf8").replace(/^\uFEFF/, "");
    const release = parseAppCustomRelease(app, variant, JSON.parse(customText));
    return {
      release,
      error: release ? null : releaseJsonEnvName(app) + " 缺少 apkUrl（或 variant 不匹配）",
      source: "env",
      warnings: [],
      mirrors: []
    };
  } catch (caught) {
    return {
      release: null,
      error: "读取 " + releaseJsonEnvName(app) + " 失败: " + errorMessage(caught),
      source: "env",
      warnings: [],
      mirrors: []
    };
  }
}

/** 解析单个应用变体的发布信息；调用方负责 Aerial 固定直链等业务级兜底。 */
export async function resolveTvAppRelease(
  app: TvAppDefinition,
  variant: TvAppVariant,
  options: TvReleaseResolverOptions
): Promise<TvReleaseResolution> {
  const envRelease = resolveEnvRelease(app, variant);
  if (envRelease) return envRelease;

  const warnings: string[] = [];
  let catalog: { payload: Record<string, unknown>; warning: string | null } | null = null;
  let mirrors: string[] = [];
  try {
    catalog = await loadCatalog(options);
    if (catalog.warning) warnings.push(catalog.warning);
    mirrors = catalogMirrorsOf(catalog.payload);
    const appRecord = (catalog.payload.apps as Record<string, unknown> | undefined)?.[app.id];
    if (appRecord) {
      const release = parseAppRelease(app, variant, appRecord);
      if (release) return { release, error: null, source: "catalog", warnings, mirrors };
      warnings.push("静态目录中没有 " + app.name + " 的 " + variant.name + " 资产");
    } else {
      warnings.push("静态目录中没有应用 " + app.id);
    }
  } catch (caught) {
    warnings.push(errorMessage(caught));
  }

  let apiError: string | null = null;
  try {
    const api = await loadApiRelease(app, options);
    if (api.warning) warnings.push(api.warning);
    let payload = api.payload;
    if (app.releaseTagPattern) {
      const picked = selectReleaseFromList(app, payload);
      if (!picked) {
        throw new Error("最近 15 条 Release 中未找到匹配 " + app.releaseTagPattern + " 且包含 .apk 的版本");
      }
      payload = picked;
    }
    const release = parseAppRelease(app, variant, payload);
    if (release) return { release, error: null, source: "api", warnings, mirrors };
    apiError = "GitHub 发布页里没有找到 " + variant.assetName.replace("{version}", "*");
  } catch (caught) {
    apiError = "查询 " + app.name + " 最新版本失败: " + errorMessage(caught);
  }

  if (app.id === "aerial" && variant.id === app.defaultVariant) {
    return {
      release: {
        appId: app.id,
        variantId: variant.id,
        packageName: variant.packageName,
        tag: "latest",
        version: "",
        apkName: variant.assetName,
        apkUrl: AERIAL_FALLBACK_URL,
        sizeBytes: 0,
        sha256: null,
        publishedAt: null,
        channel: "mirror"
      },
      error: apiError,
      source: "aerial-fallback",
      warnings,
      mirrors
    };
  }

  return { release: null, error: apiError, source: null, warnings, mirrors };
}
