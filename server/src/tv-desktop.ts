// 电视助手：把「下载地址 + adb 命令模板」做成可扩展的安装流程。
// 目录（应用/变体/包名/资产名）在 tv-apps.ts；本模块只负责取发布信息、下载 APK、跑 adb 与校验结果。
// 目前支持两类应用：launcher（Aerial 极简桌面，会接管 Home 键）与 app（普通应用，如红果短剧 TV、TVBox）。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  TV_APPS,
  type TvAppDefinition,
  type TvAppReleaseInfo,
  type TvAppVariant,
  type TvDeviceProfile,
  type TvVariantMatch,
  findTvApp,
  findTvVariant,
  matchVariantForDevice,
  parseAppCustomRelease,
  parseAppRelease,
  parseDeviceProfile,
  variantSummary
} from "./tv-apps";
import { resolveTvAppRelease, type TvReleaseResolverOptions } from "./tv-release-resolver";
import { fetch as undiciFetch } from "undici";
import type { NetworkSettingsService } from "./network-config";
import type { NetworkClient } from "./network-fetch";

/** 兼容旧调用方：Aerial 发布信息的结构就是通用发布信息。 */
export type AerialReleaseInfo = TvAppReleaseInfo;

/** 官网直链兜底（拿不到版本号与校验和，只在 GitHub 查询失败时使用）。 */
const PLATFORM_TOOLS_URL = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";
const ADB_CONNECT_TIMEOUT_MS = 20_000;
const ADB_INSTALL_TIMEOUT_MS = 180_000;
const ADB_STEP_TIMEOUT_MS = 20_000;
const ADB_VERSION_TIMEOUT_MS = 8_000;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const RELEASE_CACHE_MS = 10 * 60 * 1000;
/** APK 默认上限 200 MiB；应用可用 maxApkBytes 覆盖。 */
const MAX_APK_BYTES = 200 * 1024 * 1024;

export type AdbSource = "env" | "local" | "path" | "missing";

export interface AdbInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  source: AdbSource;
  hint: string;
}

export interface TvDesktopTarget {
  deviceId: string;
  name: string;
  address: string;
  ip: string | null;
  kind: "casthub" | "dlna";
}

/** 电视上已安装的目标应用版本（只有显式请求 deviceId 时才查询，避免每次开面板都跑 adb）。 */
export interface TvDesktopInstalledInfo {
  deviceId: string;
  appId: string;
  variantId: string;
  packageName: string;
  installed: boolean;
  version: string | null;
  /** 最新发布版比已装版本新时为 true；无法比较（镜像渠道 / 非数字版本）时恒为 false。 */
  updateAvailable: boolean;
  error: string | null;
}

/** 面板用的应用摘要（不含内部字段）。 */
export interface TvDesktopAppSummary {
  id: string;
  name: string;
  vendor: string;
  description: string;
  homepage: string;
  installKind: "launcher" | "app";
  defaultVariant: string;
  notice: string;
  /** 多变体共用同一个包名（TVBox）：只能装一个，换版本要先卸载。 */
  sharedPackage: boolean;
  variants: ReturnType<typeof variantSummary>[];
}

export interface TvDesktopInfo {
  adb: AdbInfo;
  release: TvAppReleaseInfo | null;
  releaseError: string | null;
  targets: TvDesktopTarget[];
  cacheDir: string;
  busy: boolean;
  /** 当前选中变体的包名（旧字段，等价于 packageName）。 */
  packageName: string;
  platformToolsUrl: string;
  apps: TvDesktopAppSummary[];
  activeAppId: string;
  appName: string;
  variantId: string;
  variantName: string;
  installKind: "launcher" | "app";
  /** 目标电视的系统属性；没选设备、adb 不可用或读取失败时为 null。 */
  deviceProfile: TvDeviceProfile | null;
  /** 变体是怎么定下来的：manual（用户指定）/ auto（按系统属性匹配）/ fallback（用默认变体）。 */
  variantSource: "manual" | "auto" | "fallback";
  /** 一句话说明为什么选这个变体（面板直接显示）。 */
  variantReason: string;
  installed?: TvDesktopInstalledInfo;
}

export interface TvDesktopStep {
  key: string;
  title: string;
  command: string;
  ok: boolean;
  required: boolean;
  output: string;
}

export interface TvDesktopVerification {
  /** launcher：是否接管默认桌面；app：是否已安装并可见。 */
  homeLauncher: boolean;
  /** launcher：无障碍守护是否启用；app：恒为 false（不适用）。 */
  accessibility: boolean;
  focus: boolean;
  detail: string;
}

export interface TvDesktopResult {
  action: "install" | "uninstall";
  ok: boolean;
  message: string;
  steps: TvDesktopStep[];
  verification: TvDesktopVerification | null;
  release: TvAppReleaseInfo | null;
  appId: string;
  variantId: string;
  packageName: string;
  /** 实际使用的变体是怎么选出来的，便于用户理解自动匹配结果。 */
  variantSource: "manual" | "auto" | "fallback";
  variantReason: string;
  deviceProfile: TvDeviceProfile | null;
}

interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface StepSpec {
  key: string;
  title: string;
  args: string[];
  required: boolean;
  timeoutMs?: number;
  check?: (result: ToolResult) => boolean;
}

/** 设备来源只需要 id/name/address/type 四个字段。 */
export interface TvDesktopDeviceInput {
  id: string;
  deviceName: string;
  address: string;
  type: "casthub" | "dlna";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= 2000) return trimmed;
  return trimmed.slice(0, 2000) + "…";
}

function combineOutput(result: ToolResult): string {
  const parts = [result.stdout.trim(), result.stderr.trim()].filter((part) => part.length > 0);
  return truncate(parts.join("\n"));
}

function resolveToolInvocation(toolPath: string, args: string[]): { command: string; args: string[] } {
  if (/\.(?:cjs|mjs|js)$/i.test(toolPath)) {
    return { command: process.execPath, args: [toolPath, ...args] };
  }
  return { command: toolPath, args };
}

function runTool(toolPath: string, args: string[], timeoutMs: number): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve, reject) => {
    const invocation = resolveToolInvocation(toolPath, args);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_TOOL_OUTPUT_BYTES) stdoutChunks.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_TOOL_OUTPUT_BYTES) stderrChunks.push(chunk);
    });
    child.on("error", (error) => fail(error));
    child.on("close", (code) => {
      finish({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut
      });
    });
  });
}

function envValue(name: string): string {
  return (process.env[name] ?? "").trim();
}

function executableName(): string {
  return process.platform === "win32" ? "adb.exe" : "adb";
}

/** adb 本地安装目录（由桌面版按需下载 platform-tools，不塞进 exe）。 */
export function localPlatformToolsDir(): string {
  const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), ".casthub");
  return path.join(base, "CastHub", "platform-tools");
}

function findOnPath(): string | null {
  const raw = process.env.PATH ?? "";
  const target = executableName();
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, target);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 继续找
    }
  }
  return null;
}

export interface ResolveAdbResult {
  path: string | null;
  source: AdbSource;
}

/** adb 解析顺序：CASTHUB_ADB_PATH/ADB_PATH > %LOCALAPPDATA%\\CastHub\\platform-tools > PATH。 */
export function resolveAdbPath(): ResolveAdbResult {
  const fromEnv = envValue("CASTHUB_ADB_PATH") || envValue("ADB_PATH");
  if (fromEnv) {
    try {
      if (fs.statSync(fromEnv).isFile()) return { path: fromEnv, source: "env" };
    } catch {
      // 环境变量指向的文件不存在时继续往下找
    }
  }
  const local = path.join(localPlatformToolsDir(), executableName());
  try {
    if (fs.statSync(local).isFile()) return { path: local, source: "local" };
  } catch {
    // 未下载
  }
  const onPath = findOnPath();
  if (onPath) return { path: onPath, source: "path" };
  return { path: null, source: "missing" };
}

function parseAdbVersion(text: string): string | null {
  const match = text.match(/Android Debug Bridge version ([0-9][0-9A-Za-z.\-]*)/);
  return match ? match[1] : null;
}

export async function detectAdb(): Promise<AdbInfo> {
  const resolved = resolveAdbPath();
  if (!resolved.path) {
    return {
      available: false,
      path: null,
      version: null,
      source: "missing",
      hint: "未检测到 adb。可在「电视助手」里一键下载 platform-tools，或自行安装 Android SDK 后把 adb 加入 PATH。"
    };
  }
  let version: string | null = null;
  try {
    const result = await runTool(resolved.path, ["version"], ADB_VERSION_TIMEOUT_MS);
    version = parseAdbVersion(result.stdout + result.stderr);
  } catch (error) {
    return {
      available: false,
      path: resolved.path,
      version: null,
      source: resolved.source,
      hint: "adb 无法执行: " + errorMessage(error)
    };
  }
  return {
    available: true,
    path: resolved.path,
    version,
    source: resolved.source,
    hint: resolved.source === "local" ? "使用 CastHub 下载的 platform-tools。" : "使用系统已有的 adb。"
  };
}

/** Aerial 标准版（默认应用）的定义，供旧调用方复用。 */
function aerialApp(): TvAppDefinition {
  const app = findTvApp("aerial");
  if (!app) throw new Error("电视应用目录缺少 aerial");
  return app;
}

function defaultVariantOf(app: TvAppDefinition): TvAppVariant {
  const variant = findTvVariant(app, app.defaultVariant);
  if (!variant) throw new Error("电视应用目录缺少变体 " + app.defaultVariant);
  return variant;
}

/** 旧导出：按 Aerial 标准版解析 GitHub 发布 JSON。 */
export function parseLatestRelease(payload: unknown): TvAppReleaseInfo | null {
  const app = aerialApp();
  return parseAppRelease(app, defaultVariantOf(app), payload);
}

/** 旧导出：按 Aerial 标准版解析本地注入的发布 JSON。 */
export function parseCustomRelease(payload: unknown): TvAppReleaseInfo | null {
  const app = aerialApp();
  return parseAppCustomRelease(app, defaultVariantOf(app), payload);
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** 仅供本地 E2E：显式开关 + 严格回环地址，生产 HTTPS 校验不受影响。 */
function allowInsecureLoopback(): boolean {
  return envValue("CASTHUB_ALLOW_INSECURE_LOOPBACK") === "1";
}

/** 发布信息内存缓存（按 appId:variantId 分槽），磁盘缓存由 tv-release-resolver 负责。 */
const releaseCache = new Map<
  string,
  { at: number; value: TvAppReleaseInfo | null; error: string | null; mirrors: string[] }
>();
let fallbackCacheDir: string | null = null;

export function clearReleaseCache(): void {
  releaseCache.clear();
}

export interface FetchAppReleaseOptions {
  force?: boolean;
  /** 服务使用 dataDir/cache/tv-desktop；测试或旧调用方缺省时使用进程级临时目录。 */
  cacheDir?: string;
  resolverOptions?: Omit<TvReleaseResolverOptions, "cacheDir" | "force">;
}

/** 取指定应用变体的最新发布信息：静态目录优先，GitHub API 兜底，Aerial 最终回退官网直链。 */
export async function fetchAppRelease(
  app: TvAppDefinition,
  variant: TvAppVariant,
  options?: FetchAppReleaseOptions
): Promise<{ release: TvAppReleaseInfo | null; error: string | null; mirrors: string[] }> {
  let cacheDir = options?.cacheDir;
  if (!cacheDir) {
    fallbackCacheDir ??= path.join(os.tmpdir(), "casthub-tv-desktop-" + process.pid);
    cacheDir = fallbackCacheDir;
  }
  const key = app.id + ":" + variant.id;
  const cached = releaseCache.get(key);
  if (!options?.force && cached && Date.now() - cached.at < RELEASE_CACHE_MS) {
    return { release: cached.value, error: cached.error, mirrors: cached.mirrors };
  }
  const resolved = await resolveTvAppRelease(app, variant, {
    cacheDir,
    force: options?.force,
    ...options?.resolverOptions
  });
  const result = { release: resolved.release, error: resolved.error, mirrors: resolved.mirrors };
  releaseCache.set(key, { at: Date.now(), value: result.release, error: result.error, mirrors: result.mirrors });
  return result;
}

/** 旧导出：Aerial 标准版的最新发布信息。 */
export async function fetchLatestRelease(options?: { force?: boolean }): Promise<{
  release: TvAppReleaseInfo | null;
  error: string | null;
  mirrors: string[];
}> {
  const app = aerialApp();
  return fetchAppRelease(app, defaultVariantOf(app), options);
}

export function sha256File(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function isAllowedDownloadUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "file:" || parsed.protocol === "https:") return true;
    return parsed.protocol === "http:" && allowInsecureLoopback() && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function assertRemoteUrl(url: string): void {
  if (!isAllowedDownloadUrl(url)) {
    throw new Error("APK 地址必须是 https://（或本机 file:// 测试地址；HTTP 仅限显式回环测试）");
  }
}

export type DownloadProgress = (percent: number) => void;

export interface DownloadApkOptions {
  onProgress?: DownloadProgress;
  /** 覆盖默认 200 MiB 上限（字节）。 */
  maxBytes?: number;
  /** 用户配置的 GitHub 加速镜像前缀（仅 GitHub 域名可用）。 */
  githubMirror?: string;
  /** 静态目录下发的镜像前缀列表（仅 release 有可信 SHA-256 时启用）。 */
  mirrors?: readonly string[];
  /** 统一由 NetworkClient 提供的 undici fetch；测试可注入。 */
  fetcher?: typeof fetch;
}

function normalizeDownloadOptions(input?: DownloadProgress | DownloadApkOptions): DownloadApkOptions {
  return typeof input === "function" ? { onProgress: input } : (input ?? {});
}

function resolveMaxBytes(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  return MAX_APK_BYTES;
}

function normalizeSha256(value: string | null | undefined): string | null {
  const text = (value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

const GITHUB_DOWNLOAD_HOSTS = new Set(["github.com", "raw.githubusercontent.com", "objects.githubusercontent.com"]);
const inFlightDownloads = new Map<string, Promise<{ filePath: string; sha256: string; cached: boolean }>>();
const DOWNLOAD_HEADER_TIMEOUT_MS = 15_000;
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

function positiveTimeoutEnv(name: string, fallback: number): number {
  const raw = envValue(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function downloadHeaderTimeoutMs(): number {
  return positiveTimeoutEnv("CASTHUB_DOWNLOAD_HEADER_TIMEOUT_MS", DOWNLOAD_HEADER_TIMEOUT_MS);
}

function downloadIdleTimeoutMs(): number {
  return positiveTimeoutEnv("CASTHUB_DOWNLOAD_IDLE_TIMEOUT_MS", DOWNLOAD_IDLE_TIMEOUT_MS);
}

function buildMirrorUrl(prefix: string, originalUrl: string): string | null {
  const trimmed = prefix.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    const mirror = new URL(trimmed);
    if (mirror.protocol !== "https:" && !(mirror.protocol === "http:" && allowInsecureLoopback() && isLoopbackHostname(mirror.hostname))) {
      return null;
    }
    if (mirror.username || mirror.password) return null;
    const original = new URL(originalUrl);
    if (!GITHUB_DOWNLOAD_HOSTS.has(original.hostname.toLowerCase())) return null;
    return trimmed + "/" + originalUrl;
  } catch {
    return null;
  }
}

function downloadCandidates(release: TvAppReleaseInfo, options: DownloadApkOptions): string[] {
  const result: string[] = [];
  const add = (value: string | null): void => {
    if (!value) return;
    if (!result.includes(value)) result.push(value);
  };
  // 只有可信 SHA-256 才允许第三方镜像；否则必须直连原始地址，避免来源不可验证。
  if (normalizeSha256(release.sha256)) {
    add(buildMirrorUrl(options.githubMirror ?? "", release.apkUrl));
    for (const mirror of options.mirrors ?? []) add(buildMirrorUrl(mirror, release.apkUrl));
  }
  add(release.apkUrl);
  return result;
}

interface PartialMeta {
  url: string;
  sha256: string;
  bytes: number;
}

async function readPartialMeta(metaPath: string): Promise<PartialMeta | null> {
  try {
    const value = JSON.parse(await fs.promises.readFile(metaPath, "utf8")) as Partial<PartialMeta>;
    if (typeof value.url !== "string" || typeof value.sha256 !== "string" || typeof value.bytes !== "number") return null;
    return { url: value.url, sha256: value.sha256, bytes: value.bytes };
  } catch {
    return null;
  }
}

async function writePartialMeta(metaPath: string, meta: PartialMeta): Promise<void> {
  const temp = metaPath + ".tmp";
  await fs.promises.writeFile(temp, JSON.stringify(meta), "utf8");
  await fs.promises.rename(temp, metaPath);
}

async function removePartial(partial: string, metaPath: string): Promise<void> {
  await Promise.all([
    fs.promises.rm(partial, { force: true }).catch(() => undefined),
    fs.promises.rm(metaPath, { force: true }).catch(() => undefined)
  ]);
}

function isRejectedContentType(value: string | null): boolean {
  const mime = (value ?? "").split(";")[0].trim().toLowerCase();
  return mime === "text/html" || mime === "application/json" || mime === "text/plain";
}

function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) return null;
  if (start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

/** 下载单个候选地址；Range 只允许在同一 URL、同一期望摘要且已有 .part 时使用。 */
async function downloadHttpCandidate(
  url: string,
  partial: string,
  metaPath: string,
  expectedSha: string,
  maxBytes: number,
  options: DownloadApkOptions
): Promise<void> {
  const meta = await readPartialMeta(metaPath);
  let offset = 0;
  if (meta && meta.url === url && meta.sha256 === expectedSha) {
    const size = await fs.promises.stat(partial).then((stat) => stat.size).catch(() => 0);
    if (size > 0 && size < maxBytes) offset = size;
  }
  if (offset === 0) await removePartial(partial, metaPath);
  else await writePartialMeta(metaPath, { url, sha256: expectedSha, bytes: offset });

  const controller = new AbortController();
  let headerTimedOut = false;
  let idleTimedOut = false;
  const headerTimer = setTimeout(() => {
    headerTimedOut = true;
    controller.abort();
  }, downloadHeaderTimeoutMs());
  let response: Response;
  try {
    response = await (options.fetcher ?? (undiciFetch as typeof fetch))(url, {
      redirect: "follow",
      signal: controller.signal,
      ...(offset > 0 ? { headers: { Range: "bytes=" + offset + "-" } } : {})
    });
  } catch (error) {
    clearTimeout(headerTimer);
    if (headerTimedOut) throw new Error("下载 APK 超时（响应头超过 " + Math.round(downloadHeaderTimeoutMs() / 1000) + " 秒）");
    throw new Error("请求失败: " + errorMessage(error));
  }
  clearTimeout(headerTimer);

  if (response.url && !isAllowedDownloadUrl(response.url)) {
    controller.abort();
    throw new Error("下载 APK 时重定向到了非 HTTPS 地址");
  }
  if (response.status !== 200 && response.status !== 206) {
    controller.abort();
    throw new Error("下载 APK 失败: HTTP " + response.status);
  }
  if (isRejectedContentType(response.headers.get("content-type"))) {
    controller.abort();
    throw new Error("下载地址返回了非 APK 内容（" + response.headers.get("content-type") + "）");
  }

  let append = false;
  let total = 0;
  if (response.status === 206) {
    const range = parseContentRange(response.headers.get("content-range"));
    if (!range || range.start !== offset || range.total > maxBytes) {
      controller.abort();
      await removePartial(partial, metaPath);
      if (offset > 0) {
        // 不合规的 206 不能拿旧字节拼接，从 0 重新请求同一候选。
        return downloadHttpCandidate(url, partial, metaPath, expectedSha, maxBytes, options);
      }
      throw new Error("下载 APK 失败: 206 响应的 Content-Range 不合规");
    }
    append = offset > 0;
    total = range.total;
  } else {
    // 服务器忽略 Range 返回 200：必须从 0 覆盖写入，绝不能追加到旧 .part。
    if (offset > 0) await removePartial(partial, metaPath);
    const lengthHeader = response.headers.get("content-length");
    total = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : 0;
    if (total > maxBytes) {
      controller.abort();
      throw new Error("APK 体积异常: " + total + " 字节，超过上限 " + maxBytes + " 字节");
    }
  }
  if (!response.body) {
    controller.abort();
    throw new Error("下载 APK 失败: 响应为空");
  }

  let idleTimer: NodeJS.Timeout | null = null;
  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, downloadIdleTimeoutMs());
  };
  resetIdle();
  const handle = await fs.promises.open(partial, append ? "a" : "w");
  let received = append ? offset : 0;
  try {
    for await (const chunk of response.body) {
      resetIdle();
      const buffer = Buffer.from(chunk);
      received += buffer.length;
      if (received > maxBytes) {
        throw new Error("APK 体积异常，已中止下载：超过上限 " + maxBytes + " 字节");
      }
      await handle.write(buffer);
      if (options.onProgress && total > 0) {
        options.onProgress(Math.min(100, Math.round((received / total) * 100)));
      }
    }
  } catch (error) {
    if (idleTimedOut) throw new Error("下载 APK 超时（数据流空闲超过 " + Math.round(downloadIdleTimeoutMs() / 1000) + " 秒）");
    throw error;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    await handle.close().catch(() => undefined);
  }
  await writePartialMeta(metaPath, { url, sha256: expectedSha, bytes: received });
}

async function downloadToPath(
  release: TvAppReleaseInfo,
  target: string,
  partial: string,
  metaPath: string,
  options: DownloadApkOptions
): Promise<{ filePath: string; sha256: string; cached: boolean }> {
  const maxBytes = resolveMaxBytes(options.maxBytes);
  const expectedSha = normalizeSha256(release.sha256);
  const candidates = downloadCandidates(release, options);
  const failures: string[] = [];
  for (const candidate of candidates) {
    const maxAttempts = candidate.startsWith("file:") ? 1 : 2;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        if (candidate.startsWith("file:")) {
          await removePartial(partial, metaPath);
          const source = new URL(candidate);
          const stat = await fs.promises.stat(source);
          if (stat.size > maxBytes) {
            throw new Error("APK 体积异常: " + stat.size + " 字节，超过上限 " + maxBytes + " 字节");
          }
          await fs.promises.copyFile(source, partial);
        } else {
          await downloadHttpCandidate(candidate, partial, metaPath, expectedSha ?? "", maxBytes, options);
        }
        const actual = await sha256File(partial);
        if (expectedSha && actual !== expectedSha) {
          await removePartial(partial, metaPath);
          throw new Error("APK 校验失败：期望 " + expectedSha.slice(0, 12) + "… 实际 " + actual.slice(0, 12) + "…");
        }
        await fs.promises.rename(partial, target);
        await fs.promises.rm(metaPath, { force: true }).catch(() => undefined);
        return { filePath: target, sha256: actual, cached: false };
      } catch (error) {
        // 同一来源的传输中断允许再试一次；第二次请求会按 .part 大小续传。
        const partialSize = await fs.promises.stat(partial).then((stat) => stat.size).catch(() => 0);
        const canResume = !candidate.startsWith("file:") && partialSize > 0 && partialSize < maxBytes;
        const isChecksumFailure = errorMessage(error).includes("校验失败");
        if (attempt + 1 < maxAttempts && canResume && !isChecksumFailure) {
          await writePartialMeta(metaPath, { url: candidate, sha256: expectedSha ?? "", bytes: partialSize }).catch(() => undefined);
          continue;
        }
        failures.push((candidates.length > 1 ? candidate + "：" : "") + errorMessage(error));
        await removePartial(partial, metaPath);
        break;
      }
    }
  }
  throw new Error("下载 APK 失败（已尝试 " + candidates.length + " 个来源）：" + failures.join("；"));
}

/** 下载 APK 到缓存目录；已存在且校验通过则直接复用。返回本地路径与实际 sha256。 */
export async function downloadApk(
  release: TvAppReleaseInfo,
  cacheDir: string,
  optionsOrProgress?: DownloadProgress | DownloadApkOptions
): Promise<{ filePath: string; sha256: string; cached: boolean }> {
  assertRemoteUrl(release.apkUrl);
  const options = normalizeDownloadOptions(optionsOrProgress);
  const maxBytes = resolveMaxBytes(options.maxBytes);
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const safeTag = release.tag.replace(/[^0-9A-Za-z._-]/g, "_").slice(0, 40) || "latest";
  // 同一 tag 可能对应不同下载地址（尤其 custom），缓存名必须带上 URL 摘要，避免复用旧包。
  const urlKey = createHash("sha256").update(release.apkUrl).digest("hex").slice(0, 16);
  const prefix = release.appId === "aerial" ? "aerial" : release.appId + "-" + release.variantId;
  const target = path.join(cacheDir, prefix + "-" + safeTag + "-" + urlKey + ".apk");

  if (fs.existsSync(target)) {
    const expected = normalizeSha256(release.sha256);
    if (expected) {
      const existing = await sha256File(target);
      if (existing === expected) {
        return { filePath: target, sha256: existing, cached: true };
      }
    }
    // 没有期望摘要时不能证明缓存仍对应原地址内容，强制重新下载。
    await fs.promises.rm(target, { force: true });
  }

  const existingTask = inFlightDownloads.get(target);
  if (existingTask) return existingTask;
  const partial = target + ".part";
  const metaPath = partial + ".meta.json";
  const task = downloadToPath(release, target, partial, metaPath, { ...options, maxBytes }).finally(() => {
    inFlightDownloads.delete(target);
  });
  inFlightDownloads.set(target, task);
  return task;
}

/** 从设备地址里取电视 IP（casthub 是 ws://ip:9417，DLNA 是 http://ip:port/desc.xml）。 */
export function deviceIpFromAddress(address: string): string | null {
  if (!address) return null;
  try {
    const host = new URL(address).hostname;
    if (!host) return null;
    return host.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

export function listTargets(devices: readonly TvDesktopDeviceInput[]): TvDesktopTarget[] {
  return devices.map((device) => ({
    deviceId: device.id,
    name: device.deviceName,
    address: device.address,
    ip: deviceIpFromAddress(device.address),
    kind: device.type
  }));
}

function serialFor(ip: string): string {
  return ip + ":5555";
}

function commandLine(args: string[]): string {
  return "adb " + args.join(" ");
}

function stepOk(result: ToolResult): boolean {
  return result.code === 0 && !result.timedOut;
}

interface ExecContext {
  adbPath: string;
  steps: TvDesktopStep[];
}

async function runStep(
  ctx: ExecContext,
  spec: StepSpec
): Promise<{ ok: boolean; output: string; result: ToolResult | null }> {
  const timeoutMs = spec.timeoutMs ?? ADB_STEP_TIMEOUT_MS;
  let result: ToolResult | null = null;
  let ok = false;
  let output = "";
  try {
    result = await runTool(ctx.adbPath, spec.args, timeoutMs);
    ok = spec.check ? spec.check(result) : stepOk(result);
    output = combineOutput(result);
    if (result.timedOut) output = (output + " (超时 " + timeoutMs + "ms)").trim();
  } catch (error) {
    output = "执行失败: " + errorMessage(error);
  }
  ctx.steps.push({
    key: spec.key,
    title: spec.title,
    command: commandLine(spec.args),
    ok,
    required: spec.required,
    output
  });
  return { ok, output, result };
}

/** 安装失败时的常见提示，直接展示给控制台。 */
export function explainAdbFailure(output: string): string | null {
  const text = output.toLowerCase();
  if (text.includes("unauthorized")) {
    return "电视未授权这台电脑的 adb 调试。请在电视上勾选「始终允许」并确认调试授权弹窗，然后重试。";
  }
  if (text.includes("install_failed_user_restricted")) {
    return "电视拒绝安装：请在电视的开发者选项里允许「USB 安装」/关闭「安装未知来源限制」后重试。";
  }
  if (text.includes("install_failed_insufficient_storage")) return "电视存储空间不足，无法安装 APK。";
  if (text.includes("install_failed_update_incompatible")) return "电视上已装同名但签名不同的应用，请先卸载再装。";
  if (text.includes("cannot connect") || text.includes("failed to connect") || text.includes("unable to connect")) {
    return "连不上电视的 adb 端口。请确认电视与电脑在同一局域网、已在电视上开启「网络调试/ADB 调试」，端口 5555 未被占用。";
  }
  if (text.includes("more than one device")) return "adb 连接了多台设备，请先 adb disconnect 其他设备。";
  return null;
}

/** Aerial 守护 APK 包名（由正式版内部引导安装，这里只用于提示/授权）。 */
const AERIAL_PACKAGE = "app.orchard.tv";
const AERIAL_REVIVAL_LISTENER = "app.orchard.tv/app.orchard.tv.guard.RevivalListener";
const AERIAL_HOME_GUARD_SERVICE = "app.orchard.tv/.guard.HomeGuardService";

/** 桌面类应用（Aerial）：安装 + 官方脚本里的授权步骤，尽量让守护生效。 */
async function launcherInstallSteps(
  ctx: ExecContext,
  serial: string,
  apkPath: string
): Promise<{ ok: boolean; failure: string | null }> {
  const required: StepSpec[] = [
    { key: "connect", title: "连接电视 adb", args: ["connect", serial], required: true, timeoutMs: ADB_CONNECT_TIMEOUT_MS, check: (r) => /connected to|already connected/i.test(r.stdout + r.stderr) },
    { key: "state", title: "确认调试授权", args: ["-s", serial, "get-state"], required: true, check: (r) => stepOk(r) && /device/.test(r.stdout) && !/unauthorized|offline/i.test(r.stdout + r.stderr) },
    { key: "install", title: "安装 Aerial APK", args: ["-s", serial, "install", "-r", apkPath], required: true, timeoutMs: ADB_INSTALL_TIMEOUT_MS, check: (r) => stepOk(r) && /success/i.test(r.stdout + r.stderr) }
  ];
  for (const spec of required) {
    const outcome = await runStep(ctx, spec);
    if (!outcome.ok) return { ok: false, failure: explainAdbFailure(outcome.output) ?? spec.title + " 失败" };
  }

  // 以下是官方脚本里的授权步骤，个别厂商/老系统不支持，失败只记录不中断。
  const optional: StepSpec[] = [
    { key: "grant-location", title: "授予定位权限", args: ["-s", serial, "shell", "pm", "grant", AERIAL_PACKAGE, "android.permission.ACCESS_FINE_LOCATION"], required: false },
    { key: "grant-secure", title: "授予 WRITE_SECURE_SETTINGS", args: ["-s", serial, "shell", "pm", "grant", AERIAL_PACKAGE, "android.permission.WRITE_SECURE_SETTINGS"], required: false },
    { key: "appops-overlay", title: "允许悬浮窗", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "SYSTEM_ALERT_WINDOW", "allow"], required: false },
    { key: "appops-write-settings", title: "允许修改系统设置", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "WRITE_SETTINGS", "allow"], required: false },
    { key: "appops-install", title: "允许安装 APK", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "REQUEST_INSTALL_PACKAGES", "allow"], required: false },
    { key: "appops-usage", title: "允许使用情况访问", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "GET_USAGE_STATS", "allow"], required: false },
    { key: "appops-usage-android", title: "允许使用情况访问（android:）", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "android:get_usage_stats", "allow"], required: false },
    { key: "appops-restricted", title: "允许受限设置", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "ACCESS_RESTRICTED_SETTINGS", "allow"], required: false },
    { key: "notification-listener", title: "授权通知监听守护", args: ["-s", serial, "shell", "cmd", "notification", "allow_listener", AERIAL_REVIVAL_LISTENER], required: false },
    { key: "appops-auto-start", title: "允许自启动（APP_AUTO_START）", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "APP_AUTO_START", "allow"], required: false },
    { key: "appops-assoc-start", title: "允许关联启动（APP_ASSOC_START）", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "APP_ASSOC_START", "allow"], required: false },
    { key: "appops-auto-start-plain", title: "允许自启动（AUTO_START）", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "AUTO_START", "allow"], required: false },
    { key: "launch", title: "启动 Aerial", args: ["-s", serial, "shell", "am", "start", "-n", AERIAL_PACKAGE + "/.MainActivity"], required: false },
    { key: "compile", title: "预编译加速（首次启动更快）", args: ["-s", serial, "shell", "cmd", "package", "compile", "-m", "speed", "-f", AERIAL_PACKAGE], required: false, timeoutMs: 120_000 }
  ];
  for (const spec of optional) {
    await runStep(ctx, spec);
  }
  return { ok: true, failure: null };
}

/** 应用目录里所有变体共用一个包名的应用（TVBox）：先卸旧包，否则 install -r 会因签名/版本冲突失败。 */
function sharedPackageApp(app: TvAppDefinition): boolean {
  return app.variants.length > 1 && new Set(app.variants.map((item) => item.packageName)).size === 1;
}

/** 普通应用（红果短剧 / TVBox）：只做连接、安装、启动与预编译，不动桌面/无障碍/AppOps。 */
async function appInstallSteps(
  ctx: ExecContext,
  serial: string,
  apkPath: string,
  variant: TvAppVariant,
  appName: string,
  sharedPackage: boolean
): Promise<{ ok: boolean; failure: string | null }> {
  const required: StepSpec[] = [
    { key: "connect", title: "连接电视 adb", args: ["connect", serial], required: true, timeoutMs: ADB_CONNECT_TIMEOUT_MS, check: (r) => /connected to|already connected/i.test(r.stdout + r.stderr) },
    { key: "state", title: "确认调试授权", args: ["-s", serial, "get-state"], required: true, check: (r) => stepOk(r) && /device/.test(r.stdout) && !/unauthorized|offline/i.test(r.stdout + r.stderr) }
  ];
  // 多变体共用一个包名时，先卸掉旧包再装，避免「签名冲突 / 版本降级」把安装卡死。
  if (sharedPackage) {
    required.push({
      key: "uninstall-old",
      title: "卸载同包名的旧版本",
      args: ["-s", serial, "uninstall", variant.packageName],
      required: false
    });
  }
  required.push({ key: "install", title: "安装 " + appName + " APK", args: ["-s", serial, "install", "-r", apkPath], required: true, timeoutMs: ADB_INSTALL_TIMEOUT_MS, check: (r) => stepOk(r) && /success/i.test(r.stdout + r.stderr) });
  for (const spec of required) {
    const outcome = await runStep(ctx, spec);
    if (!outcome.ok) return { ok: false, failure: explainAdbFailure(outcome.output) ?? spec.title + " 失败" };
  }

  const optional: StepSpec[] = [
    { key: "launch", title: "启动 " + appName, args: ["-s", serial, "shell", "am", "start", "-n", variant.activity], required: false },
    { key: "compile", title: "预编译加速（首次启动更快）", args: ["-s", serial, "shell", "cmd", "package", "compile", "-m", "speed", "-f", variant.packageName], required: false, timeoutMs: 120_000 }
  ];
  for (const spec of optional) {
    await runStep(ctx, spec);
  }
  return { ok: true, failure: null };
}

async function verifyLauncherInstall(ctx: ExecContext, serial: string): Promise<TvDesktopVerification> {
  const launcher = await runTool(ctx.adbPath, ["-s", serial, "shell", "cmd", "package", "resolve-activity", "--brief", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME"], ADB_STEP_TIMEOUT_MS);
  const accessibility = await runTool(ctx.adbPath, ["-s", serial, "shell", "settings", "get", "secure", "enabled_accessibility_services"], ADB_STEP_TIMEOUT_MS);
  const window = await runTool(ctx.adbPath, ["-s", serial, "shell", "dumpsys", "window"], ADB_STEP_TIMEOUT_MS);
  const homeLauncher = (launcher.stdout + launcher.stderr).includes(AERIAL_PACKAGE);
  const accessibilityOk = (accessibility.stdout + accessibility.stderr).includes(AERIAL_HOME_GUARD_SERVICE);
  const focusLine = window.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes("mCurrentFocus"))
    .join(" ");
  const focus = focusLine.includes(AERIAL_PACKAGE);
  const detail = [
    "默认桌面: " + (homeLauncher ? "Aerial" : "未接管（" + truncate(launcher.stdout + launcher.stderr) + "）"),
    "无障碍守护: " + (accessibilityOk ? "已启用" : "未启用"),
    "前台窗口: " + (focus ? "Aerial" : focusLine ? truncate(focusLine) : "未知")
  ].join("\n");
  return { homeLauncher, accessibility: accessibilityOk, focus, detail };
}

/** `pm list packages` 输出里是否精确包含该包名（避免 rocks.aston.hongguotv 命中 .mpv 变体）。 */
function hasPackage(output: string, packageName: string): boolean {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === "package:" + packageName);
}

/** 普通应用安装后的校验：包是否在列表里 + 前台是否切到它。 */
async function verifyAppInstall(ctx: ExecContext, serial: string, variant: TvAppVariant): Promise<TvDesktopVerification> {
  const packages = await runTool(ctx.adbPath, ["-s", serial, "shell", "pm", "list", "packages", variant.packageName], ADB_STEP_TIMEOUT_MS);
  const window = await runTool(ctx.adbPath, ["-s", serial, "shell", "dumpsys", "window"], ADB_STEP_TIMEOUT_MS);
  const installed = hasPackage(packages.stdout + packages.stderr, variant.packageName);
  const focusLine = window.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes("mCurrentFocus"))
    .join(" ");
  const focus = focusLine.includes(variant.packageName);
  const detail = [
    "已安装: " + (installed ? variant.packageName : "未找到 " + variant.packageName),
    "前台窗口: " + (focus ? variant.packageName : focusLine ? truncate(focusLine) : "未知")
  ].join("\n");
  return { homeLauncher: installed, accessibility: false, focus, detail };
}

function parseAccessibilityList(text: string): string[] {
  return text
    .trim()
    .split(":")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** Aerial 最小还原：卸载 + 解除默认桌面角色 + 撤销权限/AppOps + 清理无障碍项。 */
async function launcherUninstallSteps(ctx: ExecContext, serial: string): Promise<{ ok: boolean; failure: string | null }> {
  const pre: StepSpec[] = [
    { key: "connect", title: "连接电视 adb", args: ["connect", serial], required: true, timeoutMs: ADB_CONNECT_TIMEOUT_MS, check: (r) => /connected to|already connected/i.test(r.stdout + r.stderr) },
    { key: "state", title: "确认调试授权", args: ["-s", serial, "get-state"], required: true, check: (r) => stepOk(r) && /device/.test(r.stdout) && !/unauthorized|offline/i.test(r.stdout + r.stderr) }
  ];
  for (const spec of pre) {
    const outcome = await runStep(ctx, spec);
    if (!outcome.ok) return { ok: false, failure: explainAdbFailure(outcome.output) ?? spec.title + " 失败" };
  }

  // 先读无障碍列表，稍后剔除 Aerial 的守护服务再写回。
  const accessibilityBefore = await runTool(ctx.adbPath, ["-s", serial, "shell", "settings", "get", "secure", "enabled_accessibility_services"], ADB_STEP_TIMEOUT_MS);
  const currentServices = parseAccessibilityList(accessibilityBefore.stdout);
  const remainingServices = currentServices.filter((item) => !item.startsWith(AERIAL_PACKAGE + "/"));
  if (remainingServices.length !== currentServices.length) {
    const value = remainingServices.length > 0 ? remainingServices.join(":") : "null";
    await runStep(ctx, {
      key: "accessibility-cleanup",
      title: "移除 Aerial 无障碍守护",
      args: ["-s", serial, "shell", "settings", "put", "secure", "enabled_accessibility_services", value],
      required: false
    });
  }

  const steps: StepSpec[] = [
    { key: "keep-adb", title: "通知守护保留 adb（官方还原步骤）", args: ["-s", serial, "shell", "am", "broadcast", "-a", "app.orchard.tv.CONFIG", "-n", AERIAL_PACKAGE + "/.guard.ConfigReceiver", "--ez", "keep_adb", "false"], required: false },
    { key: "notification", title: "取消通知监听", args: ["-s", serial, "shell", "cmd", "notification", "disallow_listener", AERIAL_REVIVAL_LISTENER], required: false },
    { key: "revoke-secure", title: "撤销 WRITE_SECURE_SETTINGS", args: ["-s", serial, "shell", "pm", "revoke", AERIAL_PACKAGE, "android.permission.WRITE_SECURE_SETTINGS"], required: false },
    { key: "appops-overlay", title: "复位悬浮窗", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "SYSTEM_ALERT_WINDOW", "default"], required: false },
    { key: "appops-install", title: "复位安装 APK 权限", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "REQUEST_INSTALL_PACKAGES", "default"], required: false },
    { key: "appops-usage", title: "复位使用情况访问", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "GET_USAGE_STATS", "default"], required: false },
    { key: "appops-auto-start", title: "复位自启动", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "APP_AUTO_START", "default"], required: false },
    { key: "appops-assoc-start", title: "复位关联启动", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "APP_ASSOC_START", "default"], required: false },
    { key: "appops-auto-start-plain", title: "复位自启动（AUTO_START）", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "AUTO_START", "default"], required: false },
    { key: "appops-restricted", title: "复位受限设置", args: ["-s", serial, "shell", "appops", "set", AERIAL_PACKAGE, "ACCESS_RESTRICTED_SETTINGS", "default"], required: false },
    { key: "force-stop", title: "停止 Aerial", args: ["-s", serial, "shell", "am", "force-stop", AERIAL_PACKAGE], required: false },
    { key: "remove-role", title: "解除默认桌面角色", args: ["-s", serial, "shell", "cmd", "role", "remove-role-holder", "--user", "0", "android.app.role.HOME", AERIAL_PACKAGE], required: false },
    { key: "uninstall", title: "卸载 Aerial", args: ["-s", serial, "uninstall", AERIAL_PACKAGE], required: true, check: (r) => stepOk(r) && /success/i.test(r.stdout + r.stderr) }
  ];
  for (const spec of steps) {
    const outcome = await runStep(ctx, spec);
    if (spec.required && !outcome.ok) return { ok: false, failure: explainAdbFailure(outcome.output) ?? spec.title + " 失败" };
  }
  return { ok: true, failure: null };
}

/** 普通应用卸载：连接 + 停止 + 卸载，不碰桌面与无障碍。 */
async function appUninstallSteps(
  ctx: ExecContext,
  serial: string,
  variant: TvAppVariant,
  appName: string
): Promise<{ ok: boolean; failure: string | null }> {
  const pre: StepSpec[] = [
    { key: "connect", title: "连接电视 adb", args: ["connect", serial], required: true, timeoutMs: ADB_CONNECT_TIMEOUT_MS, check: (r) => /connected to|already connected/i.test(r.stdout + r.stderr) },
    { key: "state", title: "确认调试授权", args: ["-s", serial, "get-state"], required: true, check: (r) => stepOk(r) && /device/.test(r.stdout) && !/unauthorized|offline/i.test(r.stdout + r.stderr) }
  ];
  for (const spec of pre) {
    const outcome = await runStep(ctx, spec);
    if (!outcome.ok) return { ok: false, failure: explainAdbFailure(outcome.output) ?? spec.title + " 失败" };
  }

  const steps: StepSpec[] = [
    { key: "force-stop", title: "停止 " + appName, args: ["-s", serial, "shell", "am", "force-stop", variant.packageName], required: false },
    { key: "uninstall", title: "卸载 " + appName, args: ["-s", serial, "uninstall", variant.packageName], required: true, check: (r) => stepOk(r) && /success/i.test(r.stdout + r.stderr) }
  ];
  for (const spec of steps) {
    const outcome = await runStep(ctx, spec);
    if (spec.required && !outcome.ok) return { ok: false, failure: explainAdbFailure(outcome.output) ?? spec.title + " 失败" };
  }
  return { ok: true, failure: null };
}

async function verifyLauncherUninstall(ctx: ExecContext, serial: string): Promise<TvDesktopVerification> {
  const packages = await runTool(ctx.adbPath, ["-s", serial, "shell", "pm", "list", "packages", AERIAL_PACKAGE], ADB_STEP_TIMEOUT_MS);
  const window = await runTool(ctx.adbPath, ["-s", serial, "shell", "dumpsys", "window"], ADB_STEP_TIMEOUT_MS);
  const stillInstalled = (packages.stdout + packages.stderr).includes("package:" + AERIAL_PACKAGE);
  const focusLine = window.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes("mCurrentFocus"))
    .join(" ");
  const focus = focusLine.includes(AERIAL_PACKAGE);
  const detail = [
    "Aerial 包: " + (stillInstalled ? "仍然存在" : "已卸载"),
    "前台窗口: " + (focus ? "仍是 Aerial" : focusLine ? truncate(focusLine) : "未知")
  ].join("\n");
  return { homeLauncher: !stillInstalled, accessibility: !focus, focus, detail };
}

async function verifyAppUninstall(ctx: ExecContext, serial: string, variant: TvAppVariant): Promise<TvDesktopVerification> {
  const packages = await runTool(ctx.adbPath, ["-s", serial, "shell", "pm", "list", "packages", variant.packageName], ADB_STEP_TIMEOUT_MS);
  const window = await runTool(ctx.adbPath, ["-s", serial, "shell", "dumpsys", "window"], ADB_STEP_TIMEOUT_MS);
  const stillInstalled = hasPackage(packages.stdout + packages.stderr, variant.packageName);
  const focusLine = window.stdout
    .split(/\r?\n/)
    .filter((line) => line.includes("mCurrentFocus"))
    .join(" ");
  const focus = focusLine.includes(variant.packageName);
  const detail = [
    "包 " + variant.packageName + ": " + (stillInstalled ? "仍然存在" : "已卸载"),
    "前台窗口: " + (focus ? "仍是目标应用" : focusLine ? truncate(focusLine) : "未知")
  ].join("\n");
  return { homeLauncher: !stillInstalled, accessibility: !focus, focus, detail };
}

/** 从 `dumpsys package` 输出里取 versionName（Aerial 正式版形如 2.11，红果形如 0.2.182）。 */
export function parseInstalledVersion(output: string): string | null {
  const match = output.match(/versionName=([0-9][0-9A-Za-z.\-_]*)/);
  return match ? match[1] : null;
}

function versionSegments(value: string): number[] | null {
  const cleaned = value.trim().replace(/^v/i, "");
  // TVBox 这类每日构建用「日期-时刻」当版本号（20261111-1518），按数字段比较即可。
  if (!/^[0-9]+(?:[.-][0-9]+)*$/.test(cleaned)) return null;
  return cleaned.split(/[.-]/).map((part) => Number(part));
}

/** 语义化比较：a > b 返回正数，相等 0，a < b 负数；任一方无法解析返回 null（此时不提示更新）。 */
export function compareVersions(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const left = versionSegments(a);
  const right = versionSegments(b);
  if (!left || !right) return null;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/** 查询电视上已装的目标包版本；未安装返回 installed=false。 */
async function queryInstalledVersion(
  adbPath: string,
  serial: string,
  packageName: string
): Promise<{ installed: boolean; version: string | null }> {
  const result = await runTool(adbPath, ["-s", serial, "shell", "dumpsys", "package", packageName], ADB_STEP_TIMEOUT_MS);
  const text = result.stdout + result.stderr;
  if (/Unable to find package|Unknown package|not found/i.test(text)) return { installed: false, version: null };
  const version = parseInstalledVersion(text);
  if (!version) return { installed: false, version: null };
  return { installed: true, version };
}

/** 读电视系统属性（一次 getprop 批量返回）；失败返回 null，绝不因此中断安装。 */
async function probeDeviceProfile(adbPath: string, serial: string): Promise<TvDeviceProfile | null> {
  try {
    const result = await runTool(adbPath, ["-s", serial, "shell", "getprop"], ADB_STEP_TIMEOUT_MS);
    const text = result.stdout + result.stderr;
    if (!/\[/.test(text)) return null;
    return parseDeviceProfile(text);
  } catch {
    return null;
  }
}

/**
 * 自动匹配用的一步到位版本：连 adb（只连不断开）→ 读系统属性 → 挑变体。
 * 用户显式指定变体时不探测，直接返回该变体（省一次 adb 往返）。
 */
async function resolveVariantForTarget(
  adbPath: string,
  serial: string,
  app: TvAppDefinition,
  requestedVariantId: string | null | undefined
): Promise<{ match: TvVariantMatch; profile: TvDeviceProfile | null }> {
  const wanted = (requestedVariantId ?? "").trim();
  if (wanted && wanted !== "auto") {
    return { match: matchVariantForDevice(app, null, wanted), profile: null };
  }
  // 连不上也继续读一次：部分设备已在线时 connect 会报 already connected 或直接失败，但 getprop 仍可用。
  await runTool(adbPath, ["connect", serial], ADB_CONNECT_TIMEOUT_MS);
  const profile = await probeDeviceProfile(adbPath, serial);
  return { match: matchVariantForDevice(app, profile, null), profile };
}

function targetOf(devices: readonly TvDesktopDeviceInput[], deviceId: string): TvDesktopTarget {
  const target = listTargets(devices).find((item) => item.deviceId === deviceId);
  if (!target) throw new Error("设备不存在");
  if (!target.ip) throw new Error("无法从设备地址解析电视 IP");
  return target;
}

/** 解析请求里的应用/变体；缺省回退到 Aerial 标准版，非法值回退到该应用的默认变体。 */
export function resolveTvAppSelection(
  appId: string | null | undefined,
  variantId: string | null | undefined
): { app: TvAppDefinition; variant: TvAppVariant } {
  const app = findTvApp(appId) ?? aerialApp();
  const variant = findTvVariant(app, variantId) ?? defaultVariantOf(app);
  return { app, variant };
}

export interface TvDesktopServiceOptions {
  /** APK 下载缓存目录（data/cache/tv-desktop）。 */
  cacheDir: string;
  /** 网络设置服务；缺省时仅使用环境变量/内置默认。 */
  networkSettings?: NetworkSettingsService;
  /** 统一代理 fetch；缺省时使用 undici 直连。 */
  networkClient?: NetworkClient;
}

/** 电视助手服务：同一时间只允许一个安装/还原任务。 */
export class TvDesktopService {
  private readonly cacheDir: string;
  private readonly networkSettings: NetworkSettingsService | undefined;
  private readonly networkClient: NetworkClient | undefined;
  private running: string | null = null;

  constructor(options: TvDesktopServiceOptions) {
    this.cacheDir = options.cacheDir;
    this.networkSettings = options.networkSettings;
    this.networkClient = options.networkClient;
  }

  /**
   * 网络设置保存后立即失效发布信息内存缓存与 resolver 磁盘缓存；
   * 下一次面板刷新/安装会使用新的代理、镜像、Token 和目录地址重新解析。
   */
  invalidateNetworkCaches(): void {
    clearReleaseCache();
    for (const name of ["catalog-cache.json", "api-release-cache.json"]) {
      try {
        fs.rmSync(path.join(this.cacheDir, name), { force: true });
      } catch {
        // 缓存清理失败只影响热更新时机，不阻断设置保存；下次 TTL 到期仍会刷新。
      }
    }
  }

  /** 发布信息拉取选项：把网络配置与代理 fetch 传给 resolver。 */
  private releaseOptions(): FetchAppReleaseOptions {
    const network = this.networkSettings?.config;
    const resolverOptions: NonNullable<FetchAppReleaseOptions["resolverOptions"]> = {};
    if (network?.githubMirror) resolverOptions.githubMirror = network.githubMirror;
    if (network?.githubToken) resolverOptions.githubToken = network.githubToken;
    if (network?.catalogUrl) resolverOptions.catalogUrl = network.catalogUrl;
    if (this.networkClient) {
      resolverOptions.fetcher = this.networkClient.fetch as typeof fetch;
    }
    return { cacheDir: this.cacheDir, resolverOptions };
  }

  get busy(): boolean {
    return this.running !== null;
  }

  /**
   * 读取面板信息。`options.force` 绕过 10 分钟发布信息缓存（面板「刷新」用）；
   * `options.deviceId` 会额外查询该电视上已装的应用版本并判断是否有更新。
   */
  async info(
    devices: readonly TvDesktopDeviceInput[],
    options?: { force?: boolean; deviceId?: string; appId?: string; variantId?: string }
  ): Promise<TvDesktopInfo> {
    const app = findTvApp(options?.appId) ?? aerialApp();
    const requested = (options?.variantId ?? "").trim();
    const manual = requested && requested !== "auto" ? findTvVariant(app, requested) : null;
    const adb = await detectAdb();
    // 变体未指定（或选了「自动匹配」）且有目标电视时，先读系统属性再决定装哪个资产。
    let profile: TvDeviceProfile | null = null;
    let match: TvVariantMatch;
    if (manual) {
      match = { variant: manual, source: "manual", reason: "手动选择" };
    } else if (options?.deviceId && adb.available && adb.path) {
      try {
        const target = targetOf(devices, options.deviceId);
        const probed = await resolveVariantForTarget(adb.path, serialFor(target.ip as string), app, null);
        profile = probed.profile;
        match = probed.match;
      } catch {
        match = matchVariantForDevice(app, null, null);
      }
    } else {
      match = matchVariantForDevice(app, null, null);
    }
    const variant = match.variant;
    const releaseResult = await fetchAppRelease(app, variant, { force: options?.force, ...this.releaseOptions() });
    const info: TvDesktopInfo = {
      adb,
      release: releaseResult.release,
      releaseError: releaseResult.error,
      targets: listTargets(devices),
      cacheDir: this.cacheDir,
      busy: this.busy,
      packageName: variant.packageName,
      platformToolsUrl: PLATFORM_TOOLS_URL,
      apps: TV_APPS.map((item) => ({
        id: item.id,
        name: item.name,
        vendor: item.vendor,
        description: item.description,
        homepage: item.homepage,
        installKind: item.installKind,
        defaultVariant: item.defaultVariant,
        notice: item.notice,
        sharedPackage: sharedPackageApp(item),
        variants: item.variants.map(variantSummary)
      })),
      activeAppId: app.id,
      appName: app.name,
      variantId: variant.id,
      variantName: variant.name,
      installKind: app.installKind,
      deviceProfile: profile,
      variantSource: match.source,
      variantReason: match.reason
    };
    if (options?.deviceId) {
      info.installed = await this.installedInfo(devices, options.deviceId, adb, releaseResult.release, app, variant);
    }
    return info;
  }

  /** 查询指定电视的已装版本；任何失败都降级成 error 字段，不影响面板其余信息。 */
  private async installedInfo(
    devices: readonly TvDesktopDeviceInput[],
    deviceId: string,
    adb: AdbInfo,
    release: TvAppReleaseInfo | null,
    app: TvAppDefinition,
    variant: TvAppVariant
  ): Promise<TvDesktopInstalledInfo> {
    const empty = {
      deviceId,
      appId: app.id,
      variantId: variant.id,
      packageName: variant.packageName,
      installed: false,
      version: null,
      updateAvailable: false
    };
    if (!adb.available || !adb.path) return { ...empty, error: "adb 不可用，无法读取电视上已装版本" };
    let target: TvDesktopTarget;
    try {
      target = targetOf(devices, deviceId);
    } catch (error) {
      return { ...empty, error: errorMessage(error) };
    }
    const serial = serialFor(target.ip as string);
    try {
      // 只连不断开：后续安装/还原复用同一个 adb 连接。
      await runTool(adb.path, ["connect", serial], ADB_CONNECT_TIMEOUT_MS);
      const current = await queryInstalledVersion(adb.path, serial, variant.packageName);
      const latest = release && release.channel !== "mirror" ? release.version || release.tag : null;
      const diff = current.installed ? compareVersions(latest, current.version) : null;
      return {
        ...empty,
        installed: current.installed,
        version: current.version,
        updateAvailable: diff !== null && diff > 0,
        error: null
      };
    } catch (error) {
      return { ...empty, error: "读取已装版本失败: " + errorMessage(error) };
    }
  }

  private begin(action: string): void {
    if (this.running) throw new Error("电视助手正忙（" + this.running + " 进行中），请稍后再试");
    this.running = action;
  }

  private end(): void {
    this.running = null;
  }

  async install(
    devices: readonly TvDesktopDeviceInput[],
    deviceId: string,
    options?: {
      apkUrl?: string;
      allowUnverified?: boolean;
      onProgress?: (percent: number) => void;
      appId?: string;
      variantId?: string;
    }
  ): Promise<TvDesktopResult> {
    const app = findTvApp(options?.appId) ?? aerialApp();
    const requested = (options?.variantId ?? "").trim();
    let variant = (requested && requested !== "auto" ? findTvVariant(app, requested) : null) ?? defaultVariantOf(app);
    let variantSource: "manual" | "auto" | "fallback" = requested && requested !== "auto" ? "manual" : "fallback";
    let variantReason = variantSource === "manual" ? "手动选择" : "使用默认变体";
    let profile: TvDeviceProfile | null = null;
    this.begin(app.installKind === "launcher" ? "安装" : "安装" + app.name);
    const steps: TvDesktopStep[] = [];
    const fail = (message: string, release: TvAppReleaseInfo | null): TvDesktopResult => ({
      action: "install",
      ok: false,
      message,
      steps,
      verification: null,
      release,
      appId: app.id,
      variantId: variant.id,
      packageName: variant.packageName,
      variantSource,
      variantReason,
      deviceProfile: profile
    });
    try {
      // 自定义地址先校验再碰 adb：地址非法时不该在电视上留下任何动作。
      let customUrl: string | null = null;
      if (options?.apkUrl) {
        const url = options.apkUrl.trim();
        if (!/^https:\/\//i.test(url)) {
          return fail("自定义 APK 地址必须是 https:// 链接", null);
        }
        customUrl = url;
      }

      const target = targetOf(devices, deviceId);
      const adb = await detectAdb();
      if (!adb.available || !adb.path) {
        return fail(adb.hint, null);
      }
      const serial = serialFor(target.ip as string);

      // 用户没指定变体时，先读电视系统属性（Android 版本 / ABI）再决定装哪个资产。
      if (variantSource !== "manual") {
        const probed = await resolveVariantForTarget(adb.path, serial, app, null);
        variant = probed.match.variant;
        variantSource = probed.match.source;
        variantReason = probed.match.reason;
        profile = probed.profile;
      }

      let release: TvAppReleaseInfo | null;
      let mirrors: string[] = [];
      if (customUrl) {
        release = {
          appId: app.id,
          variantId: variant.id,
          packageName: variant.packageName,
          tag: "custom",
          version: "",
          apkName: variant.assetName.replace("{version}", "custom"),
          apkUrl: customUrl,
          sizeBytes: 0,
          sha256: null,
          publishedAt: null,
          channel: "custom"
        };
      } else {
        const fetched = await fetchAppRelease(app, variant, this.releaseOptions());
        release = fetched.release;
        mirrors = fetched.mirrors;
      }
      if (!release) {
        return fail("无法获取 " + app.name + " 安装包地址", null);
      }
      if (!release.sha256 && !options?.allowUnverified) {
        return fail(app.name + " 安装包未提供 SHA-256，无法验证完整性；请确认来源可信后重试", release);
      }

      let apkPath: string;
      try {
        const downloaded = await downloadApk(release, this.cacheDir, {
          onProgress: options?.onProgress,
          maxBytes: app.maxApkBytes,
          githubMirror: this.networkSettings?.config.githubMirror ?? "",
          mirrors,
          ...(this.networkClient ? { fetcher: this.networkClient.fetch as typeof fetch } : {})
        });
        apkPath = downloaded.filePath;
        steps.push({
          key: "download",
          title: "下载安装包",
          command: release.apkUrl,
          ok: true,
          required: true,
          output: (downloaded.cached ? "使用缓存 " : "已下载 ") + apkPath + "  sha256=" + downloaded.sha256
        });
      } catch (error) {
        steps.push({ key: "download", title: "下载安装包", command: release.apkUrl, ok: false, required: true, output: errorMessage(error) });
        return fail(errorMessage(error), release);
      }

      const ctx: ExecContext = { adbPath: adb.path, steps };
      const outcome =
        app.installKind === "launcher"
          ? await launcherInstallSteps(ctx, serial, apkPath)
          : await appInstallSteps(ctx, serial, apkPath, variant, app.name, sharedPackageApp(app));
      if (!outcome.ok) {
        return fail(outcome.failure ?? "安装失败", release);
      }
      let verification: TvDesktopVerification;
      let message: string;
      if (app.installKind === "launcher") {
        verification = await verifyLauncherInstall(ctx, serial);
        message = verification.homeLauncher
          ? "Aerial 已安装并接管默认桌面"
          : "Aerial 已安装，但未成为默认桌面。请在电视「设置 → 应用 → 默认应用」里把桌面设为 Aerial，或按 Home 键时选择 Aerial。";
      } else {
        verification = await verifyAppInstall(ctx, serial, variant);
        message = verification.homeLauncher
          ? app.name + " 已安装完成，可在电视应用列表里打开"
          : app.name + " 安装命令已执行，但没在包列表里查到 " + variant.packageName + "，请在电视上确认安装结果。";
      }
      return {
        action: "install",
        ok: true,
        message,
        steps,
        verification,
        release,
        appId: app.id,
        variantId: variant.id,
        packageName: variant.packageName,
        variantSource,
        variantReason,
        deviceProfile: profile
      };
    } catch (error) {
      return fail(errorMessage(error), null);
    } finally {
      this.end();
    }
  }

  async uninstall(
    devices: readonly TvDesktopDeviceInput[],
    deviceId: string,
    options?: { appId?: string; variantId?: string }
  ): Promise<TvDesktopResult> {
    const { app, variant } = resolveTvAppSelection(options?.appId, options?.variantId);
    this.begin(app.installKind === "launcher" ? "还原" : "卸载" + app.name);
    const steps: TvDesktopStep[] = [];
    const fail = (message: string): TvDesktopResult => ({
      action: "uninstall",
      ok: false,
      message,
      steps,
      verification: null,
      release: null,
      appId: app.id,
      variantId: variant.id,
      packageName: variant.packageName,
      variantSource: "manual",
      variantReason: "卸载按所选变体的包名执行",
      deviceProfile: null
    });
    try {
      const target = targetOf(devices, deviceId);
      const adb = await detectAdb();
      if (!adb.available || !adb.path) {
        return fail(adb.hint);
      }
      const ctx: ExecContext = { adbPath: adb.path, steps };
      const serial = serialFor(target.ip as string);
      const outcome =
        app.installKind === "launcher"
          ? await launcherUninstallSteps(ctx, serial)
          : await appUninstallSteps(ctx, serial, variant, app.name);
      if (!outcome.ok) {
        return fail(outcome.failure ?? "卸载失败");
      }
      const verification =
        app.installKind === "launcher"
          ? await verifyLauncherUninstall(ctx, serial)
          : await verifyAppUninstall(ctx, serial, variant);
      const message =
        app.installKind === "launcher"
          ? verification.homeLauncher
            ? "Aerial 已卸载，电视会回到原厂桌面"
            : "已执行还原命令，但 Aerial 仍存在。海信/TCL/小米等品牌有额外设置，请用官方 restore.sh 处理。"
          : verification.homeLauncher
            ? app.name + " 已卸载"
            : app.name + " 卸载命令已执行，但电视上仍能查到 " + variant.packageName + "，请手动确认。";
      return {
        action: "uninstall",
        ok: true,
        message,
        steps,
        verification,
        release: null,
        appId: app.id,
        variantId: variant.id,
        packageName: variant.packageName,
        variantSource: "manual",
        variantReason: "卸载按所选变体的包名执行",
        deviceProfile: null
      };
    } catch (error) {
      return fail(errorMessage(error));
    } finally {
      this.end();
    }
  }
}
