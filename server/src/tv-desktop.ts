// 电视助手：把电视桌面换成 Aerial（第三方开源项目 pengchujin/aerial-tv）的一键安装与最小还原。
// 本模块只做「APK 地址 + adb 命令模板」两件事：不内置 APK，不做通用 APK 安装器。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Aerial 正式版包名（Lite 版为 app.orchard.tv.lite，本模块不安装 Lite）。 */
const AERIAL_PACKAGE = "app.orchard.tv";
/** Aerial 守护 APK 包名（由正式版内部引导安装，这里只用于提示）。 */
const AERIAL_REVIVAL_LISTENER = "app.orchard.tv/app.orchard.tv.guard.RevivalListener";
const AERIAL_HOME_GUARD_SERVICE = "app.orchard.tv/.guard.HomeGuardService";
const GITHUB_LATEST_RELEASE = "https://api.github.com/repos/pengchujin/aerial-tv/releases/latest";
const MIRROR_APK_URL = "https://aerial.qust.me/download/aerial-standard.apk";
const APK_ASSET_NAME = "aerial-standard.apk";
const PLATFORM_TOOLS_URL = "https://dl.google.com/android/repository/platform-tools-latest-windows.zip";
const ADB_CONNECT_TIMEOUT_MS = 20_000;
const ADB_INSTALL_TIMEOUT_MS = 180_000;
const ADB_STEP_TIMEOUT_MS = 20_000;
const ADB_VERSION_TIMEOUT_MS = 8_000;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const RELEASE_CACHE_MS = 10 * 60 * 1000;
const RELEASE_FETCH_TIMEOUT_MS = 12_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_APK_BYTES = 64 * 1024 * 1024;

export type AdbSource = "env" | "local" | "path" | "missing";

export interface AdbInfo {
  available: boolean;
  path: string | null;
  version: string | null;
  source: AdbSource;
  hint: string;
}

export interface AerialReleaseInfo {
  tag: string;
  apkName: string;
  apkUrl: string;
  sizeBytes: number;
  sha256: string | null;
  publishedAt: string | null;
  channel: "github" | "mirror" | "custom";
}

export interface TvDesktopTarget {
  deviceId: string;
  name: string;
  address: string;
  ip: string | null;
  kind: "casthub" | "dlna";
}

export interface TvDesktopInfo {
  adb: AdbInfo;
  release: AerialReleaseInfo | null;
  releaseError: string | null;
  targets: TvDesktopTarget[];
  cacheDir: string;
  busy: boolean;
  packageName: string;
  platformToolsUrl: string;
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
  homeLauncher: boolean;
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
  release: AerialReleaseInfo | null;
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

/** adb 解析顺序：CASTHUB_ADB_PATH/ADB_PATH > %LOCALAPPDATA%\CastHub\platform-tools > PATH。 */
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

function parseSha256Digest(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  const match = digest.match(/^sha256:([0-9a-f]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

/** 从 GitHub release JSON 里挑出标准版 APK；digest 字段缺失时返回 null（安装前会跳过校验并提示）。 */
export function parseLatestRelease(payload: unknown): AerialReleaseInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  const assets = Array.isArray(data.assets) ? data.assets : [];
  for (const item of assets) {
    if (!item || typeof item !== "object") continue;
    const asset = item as Record<string, unknown>;
    if (asset.name !== APK_ASSET_NAME) continue;
    const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
    if (!/^https:\/\//i.test(url)) continue;
    return {
      tag: typeof data.tag_name === "string" ? data.tag_name : "latest",
      apkName: APK_ASSET_NAME,
      apkUrl: url,
      sizeBytes: typeof asset.size === "number" ? asset.size : 0,
      sha256: parseSha256Digest(asset.digest),
      publishedAt: typeof data.published_at === "string" ? data.published_at : null,
      channel: "github"
    };
  }
  return null;
}

export function parseCustomRelease(payload: unknown): AerialReleaseInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  const url = typeof data.apkUrl === "string" ? data.apkUrl : "";
  if (!url) return null;
  const sha256 = typeof data.sha256 === "string" && /^[0-9a-f]{64}$/i.test(data.sha256) ? data.sha256.toLowerCase() : null;
  return {
    tag: typeof data.tag === "string" ? data.tag : "custom",
    apkName: typeof data.apkName === "string" ? data.apkName : APK_ASSET_NAME,
    apkUrl: url,
    sizeBytes: typeof data.sizeBytes === "number" ? data.sizeBytes : 0,
    sha256,
    publishedAt: typeof data.publishedAt === "string" ? data.publishedAt : null,
    channel: "custom"
  };
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "CastHub" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error("HTTP " + response.status + " " + url);
  return (await response.json()) as unknown;
}

/** 发布信息缓存，避免每次打开面板都打 GitHub API。 */
let releaseCache: { at: number; value: AerialReleaseInfo | null; error: string | null } | null = null;

export function clearReleaseCache(): void {
  releaseCache = null;
}

export async function fetchLatestRelease(options?: { force?: boolean }): Promise<{
  release: AerialReleaseInfo | null;
  error: string | null;
}> {
  if (!options?.force && releaseCache && Date.now() - releaseCache.at < RELEASE_CACHE_MS) {
    return { release: releaseCache.value, error: releaseCache.error };
  }
  const customPath = envValue("AERIAL_RELEASE_JSON");
  let release: AerialReleaseInfo | null = null;
  let error: string | null = null;
  if (customPath) {
    try {
      release = parseCustomRelease(JSON.parse(fs.readFileSync(customPath, "utf8")));
      if (!release) error = "AERIAL_RELEASE_JSON 缺少 apkUrl";
    } catch (caught) {
      error = "读取 AERIAL_RELEASE_JSON 失败: " + errorMessage(caught);
    }
  } else {
    try {
      release = parseLatestRelease(await fetchJson(GITHUB_LATEST_RELEASE, RELEASE_FETCH_TIMEOUT_MS));
      if (!release) error = "GitHub 发布页里没有找到 " + APK_ASSET_NAME;
    } catch (caught) {
      error = "查询 Aerial 最新版本失败: " + errorMessage(caught);
    }
    if (!release) {
      // 兜底：官网直链，无法拿到版本号与校验和
      release = {
        tag: "latest",
        apkName: APK_ASSET_NAME,
        apkUrl: MIRROR_APK_URL,
        sizeBytes: 0,
        sha256: null,
        publishedAt: null,
        channel: "mirror"
      };
    }
  }
  releaseCache = { at: Date.now(), value: release, error };
  return { release, error };
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

function assertRemoteUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("APK 地址格式错误");
  }
  if (parsed.protocol === "file:") return;
  if (parsed.protocol !== "https:") throw new Error("APK 地址必须是 https://（或本机 file:// 测试地址）");
}

/** 下载 APK 到缓存目录；已存在且校验通过则直接复用。返回本地路径与实际 sha256。 */
export async function downloadApk(
  release: AerialReleaseInfo,
  cacheDir: string,
  onProgress?: (percent: number) => void
): Promise<{ filePath: string; sha256: string; cached: boolean }> {
  assertRemoteUrl(release.apkUrl);
  await fs.promises.mkdir(cacheDir, { recursive: true });
  const safeTag = release.tag.replace(/[^0-9A-Za-z._-]/g, "_").slice(0, 40) || "latest";
  const target = path.join(cacheDir, "aerial-" + safeTag + ".apk");

  if (fs.existsSync(target)) {
    const existing = await sha256File(target);
    if (!release.sha256 || existing === release.sha256) {
      return { filePath: target, sha256: existing, cached: true };
    }
    await fs.promises.rm(target, { force: true });
  }

  const partial = target + ".part";
  await fs.promises.rm(partial, { force: true });

  if (release.apkUrl.startsWith("file:")) {
    await fs.promises.copyFile(new URL(release.apkUrl), partial);
  } else {
    const response = await fetch(release.apkUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error("下载 APK 失败: HTTP " + response.status);
    if (!response.body) throw new Error("下载 APK 失败: 响应为空");
    const total = Number(response.headers.get("content-length") ?? 0);
    if (total > MAX_APK_BYTES) throw new Error("APK 体积异常: " + total + " 字节");
    const handle = await fs.promises.open(partial, "w");
    let received = 0;
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        received += buffer.length;
        if (received > MAX_APK_BYTES) throw new Error("APK 体积异常，已中止下载");
        await handle.write(buffer);
        if (onProgress && total > 0) onProgress(Math.min(100, Math.round((received / total) * 100)));
      }
    } finally {
      await handle.close();
    }
  }

  const actual = await sha256File(partial);
  if (release.sha256 && actual !== release.sha256) {
    await fs.promises.rm(partial, { force: true });
    throw new Error("APK 校验失败：期望 " + release.sha256.slice(0, 12) + "… 实际 " + actual.slice(0, 12) + "…");
  }
  await fs.promises.rename(partial, target);
  return { filePath: target, sha256: actual, cached: false };
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
  if (text.includes("install_failed_update_incompatible")) return "电视上已装同名但签名不同的 Aerial，请先卸载再装。";
  if (text.includes("cannot connect") || text.includes("failed to connect") || text.includes("unable to connect")) {
    return "连不上电视的 adb 端口。请确认电视与电脑在同一局域网、已在电视上开启「网络调试/ADB 调试」，端口 5555 未被占用。";
  }
  if (text.includes("more than one device")) return "adb 连接了多台设备，请先 adb disconnect 其他设备。";
  return null;
}

async function installSteps(ctx: ExecContext, serial: string, apkPath: string): Promise<{ ok: boolean; failure: string | null }> {
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

async function verifyInstall(ctx: ExecContext, serial: string): Promise<TvDesktopVerification> {
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

function parseAccessibilityList(text: string): string[] {
  return text
    .trim()
    .split(":")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** 最小还原：卸载 + 解除默认桌面角色 + 撤销权限/AppOps + 清理无障碍项。 */
async function uninstallSteps(ctx: ExecContext, serial: string): Promise<{ ok: boolean; failure: string | null }> {
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

async function verifyUninstall(ctx: ExecContext, serial: string): Promise<TvDesktopVerification> {
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

function targetOf(devices: readonly TvDesktopDeviceInput[], deviceId: string): TvDesktopTarget {
  const target = listTargets(devices).find((item) => item.deviceId === deviceId);
  if (!target) throw new Error("设备不存在");
  if (!target.ip) throw new Error("无法从设备地址解析电视 IP");
  return target;
}

export interface TvDesktopServiceOptions {
  /** APK 下载缓存目录（data/cache/tv-desktop）。 */
  cacheDir: string;
}

/** 电视助手服务：同一时间只允许一个安装/还原任务。 */
export class TvDesktopService {
  private readonly cacheDir: string;
  private running: string | null = null;

  constructor(options: TvDesktopServiceOptions) {
    this.cacheDir = options.cacheDir;
  }

  get busy(): boolean {
    return this.running !== null;
  }

  async info(devices: readonly TvDesktopDeviceInput[]): Promise<TvDesktopInfo> {
    const [adb, releaseResult] = await Promise.all([detectAdb(), fetchLatestRelease()]);
    return {
      adb,
      release: releaseResult.release,
      releaseError: releaseResult.error,
      targets: listTargets(devices),
      cacheDir: this.cacheDir,
      busy: this.busy,
      packageName: AERIAL_PACKAGE,
      platformToolsUrl: PLATFORM_TOOLS_URL
    };
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
    options?: { apkUrl?: string; onProgress?: (percent: number) => void }
  ): Promise<TvDesktopResult> {
    this.begin("安装");
    const steps: TvDesktopStep[] = [];
    try {
      // 自定义地址先校验再碰 adb：地址非法时不该在电视上留下任何动作。
      let customUrl: string | null = null;
      if (options?.apkUrl) {
        const url = options.apkUrl.trim();
        if (!/^https:\/\//i.test(url)) {
          return { action: "install", ok: false, message: "自定义 APK 地址必须是 https:// 链接", steps, verification: null, release: null };
        }
        customUrl = url;
      }

      const target = targetOf(devices, deviceId);
      const adb = await detectAdb();
      if (!adb.available || !adb.path) {
        return { action: "install", ok: false, message: adb.hint, steps, verification: null, release: null };
      }

      let release: AerialReleaseInfo | null;
      if (customUrl) {
        release = { tag: "custom", apkName: APK_ASSET_NAME, apkUrl: customUrl, sizeBytes: 0, sha256: null, publishedAt: null, channel: "custom" };
      } else {
        release = (await fetchLatestRelease()).release;
      }
      if (!release) {
        return { action: "install", ok: false, message: "无法获取 Aerial 安装包地址", steps, verification: null, release: null };
      }

      let apkPath: string;
      try {
        const downloaded = await downloadApk(release, this.cacheDir, options?.onProgress);
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
        return { action: "install", ok: false, message: errorMessage(error), steps, verification: null, release };
      }

      const ctx: ExecContext = { adbPath: adb.path, steps };
      const serial = serialFor(target.ip as string);
      const outcome = await installSteps(ctx, serial, apkPath);
      if (!outcome.ok) {
        return { action: "install", ok: false, message: outcome.failure ?? "安装失败", steps, verification: null, release };
      }
      const verification = await verifyInstall(ctx, serial);
      const message = verification.homeLauncher
        ? "Aerial 已安装并接管默认桌面"
        : "Aerial 已安装，但未成为默认桌面。请在电视「设置 → 应用 → 默认应用」里把桌面设为 Aerial，或按 Home 键时选择 Aerial。";
      return { action: "install", ok: true, message, steps, verification, release };
    } catch (error) {
      return { action: "install", ok: false, message: errorMessage(error), steps, verification: null, release: null };
    } finally {
      this.end();
    }
  }

  async uninstall(devices: readonly TvDesktopDeviceInput[], deviceId: string): Promise<TvDesktopResult> {
    this.begin("还原");
    const steps: TvDesktopStep[] = [];
    try {
      const target = targetOf(devices, deviceId);
      const adb = await detectAdb();
      if (!adb.available || !adb.path) {
        return { action: "uninstall", ok: false, message: adb.hint, steps, verification: null, release: null };
      }
      const ctx: ExecContext = { adbPath: adb.path, steps };
      const serial = serialFor(target.ip as string);
      const outcome = await uninstallSteps(ctx, serial);
      if (!outcome.ok) {
        return { action: "uninstall", ok: false, message: outcome.failure ?? "还原失败", steps, verification: null, release: null };
      }
      const verification = await verifyUninstall(ctx, serial);
      const message = verification.homeLauncher
        ? "Aerial 已卸载，电视会回到原厂桌面"
        : "已执行还原命令，但 Aerial 仍存在。海信/TCL/小米等品牌有额外设置，请用官方 restore.sh 处理。";
      return { action: "uninstall", ok: true, message, steps, verification, release: null };
    } catch (error) {
      return { action: "uninstall", ok: false, message: errorMessage(error), steps, verification: null, release: null };
    } finally {
      this.end();
    }
  }
}
