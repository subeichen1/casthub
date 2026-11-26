// 网络配置：config.json 的 network 子对象、环境变量解析、URL/SSRF 校验与原子写回。
// 该模块不发起网络请求；代理与 fetch 在 network-fetch.ts。
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

export interface NetworkConfig {
  /** 显式 HTTP(S) 代理；空表示按系统 HTTPS_PROXY/HTTP_PROXY 自动检测。 */
  proxy: string;
  /** GitHub 加速镜像前缀，仅在 APK 具有可信 SHA-256 时参与下载。 */
  githubMirror: string;
  /** GitHub API Token；只允许发给 api.github.com，绝不返回前端明文。 */
  githubToken: string;
  /** 静态目录地址，空表示使用内置默认地址。 */
  catalogUrl: string;
}

export interface ResolvedNetworkConfig extends NetworkConfig {
  /** 没有显式代理但系统环境提供了 HTTP(S)_PROXY 时为 true。 */
  useEnvProxy: boolean;
  noProxy: string;
}

export interface NetworkSettingsOverrides {
  proxy: boolean;
  githubMirror: boolean;
  githubToken: boolean;
  catalogUrl: boolean;
}

export interface NetworkSettingsView {
  proxy: string;
  githubMirror: string;
  catalogUrl: string;
  hasGithubToken: boolean;
  overrides: NetworkSettingsOverrides;
}

export interface NetworkSettingsPatch {
  proxy?: unknown;
  githubMirror?: unknown;
  githubToken?: unknown;
  catalogUrl?: unknown;
  clearGithubToken?: unknown;
}

const MAX_PROXY_LENGTH = 2048;
const MAX_URL_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 512;

export function emptyNetworkConfig(): NetworkConfig {
  return { proxy: "", githubMirror: "", githubToken: "", catalogUrl: "" };
}

function envValue(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

function hasEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, name);
}

export function allowInsecureLoopback(env: NodeJS.ProcessEnv = process.env): boolean {
  return envValue(env, "CASTHUB_ALLOW_INSECURE_LOOPBACK") === "1";
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

function ipv4Parts(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const values = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : -1));
  return values.every((value) => value >= 0 && value <= 255) ? values : null;
}

function isPrivateIpv4(host: string): boolean {
  const parts = ipv4Parts(host);
  if (!parts) return false;
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

function isPrivateIpv6(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (value === "::" || value === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (mapped) return isPrivateIpv4(mapped[1]);
  const first = value.split(":")[0];
  const prefix = Number.parseInt(first || "0", 16);
  if (!Number.isFinite(prefix)) return false;
  return (prefix & 0xfe00) === 0xfc00 || (prefix & 0xffc0) === 0xfe80;
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
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
  if (net.isIPv4(host)) return isPrivateIpv4(host);
  if (net.isIPv6(host)) return isPrivateIpv6(host);
  return false;
}

function assertProxyUrl(raw: string): string {
  if (raw.length > MAX_PROXY_LENGTH) throw new Error("network.proxy 过长");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("network.proxy 必须是合法的 http:// 或 https:// 地址");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("network.proxy 只支持 http:// 或 https:// 代理");
  }
  if (!parsed.hostname) throw new Error("network.proxy 缺少主机名");
  if (parsed.username || parsed.password) throw new Error("network.proxy 不允许包含用户名或密码");
  return raw;
}

/** 校验可被服务端主动访问的 URL：https（或测试显式允许的本机 http），并拒绝局域网/回环 SSRF。 */
export function assertRemoteNetworkUrl(raw: string, label: string, options?: { mirrorPrefix?: boolean }): string {
  if (raw.length > MAX_URL_LENGTH) throw new Error(label + " 过长");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(label + " 必须是合法 URL");
  }
  const insecureLoopback = parsed.protocol === "http:" && allowInsecureLoopback() && isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !insecureLoopback) {
    throw new Error(label + " 必须是 https://（测试环境仅允许本机 http://）");
  }
  if (!parsed.hostname) throw new Error(label + " 缺少主机名");
  if (parsed.username || parsed.password) throw new Error(label + " 不允许包含用户名或密码");
  if (parsed.hash) throw new Error(label + " 不允许包含 # 片段");
  if (options?.mirrorPrefix && (parsed.search || (parsed.pathname !== "/" && parsed.pathname !== ""))) {
    // 镜像前缀允许带路径（如 https://example.com/gh），但不允许查询串；这里仅拒绝查询串。
    if (parsed.search) throw new Error(label + " 不允许包含查询参数");
  }
  if (isPrivateHostname(parsed.hostname) && !insecureLoopback) {
    throw new Error(label + " 不允许指向局域网或回环地址");
  }
  return raw;
}

function stringField(value: unknown, name: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("network." + name + " 必须是字符串");
  return value.trim();
}

/** 严格解析 network 对象；undefined 视为全空。 */
export function normalizeNetworkConfig(raw: unknown): NetworkConfig {
  if (raw === undefined || raw === null) return emptyNetworkConfig();
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("config.json 的 network 必须是对象");
  const obj = raw as Record<string, unknown>;
  const proxy = stringField(obj.proxy, "proxy");
  const githubMirror = stringField(obj.githubMirror, "githubMirror");
  const githubToken = stringField(obj.githubToken, "githubToken");
  const catalogUrl = stringField(obj.catalogUrl, "catalogUrl");
  if (proxy) assertProxyUrl(proxy);
  if (githubMirror) assertRemoteNetworkUrl(githubMirror, "network.githubMirror", { mirrorPrefix: true });
  if (catalogUrl) assertRemoteNetworkUrl(catalogUrl, "network.catalogUrl");
  if (githubToken.length > MAX_TOKEN_LENGTH) throw new Error("network.githubToken 过长");
  return { proxy, githubMirror, githubToken, catalogUrl };
}

/** 读取 config.json 中的 network；文件不存在返回全空。 */
export function readStoredNetworkConfig(dir: string): NetworkConfig {
  const configPath = path.join(dir, "config.json");
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyNetworkConfig();
    throw new Error("无法读取配置 " + configPath + ": " + (error as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("解析配置 " + configPath + " 失败: " + (error as Error).message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置 " + configPath + " 必须是 JSON 对象");
  }
  return normalizeNetworkConfig((parsed as Record<string, unknown>).network);
}

/** 环境变量优先于 config.json；CASTHUB_PROXY 未设置时自动读取系统 HTTPS_PROXY/HTTP_PROXY。 */
export function resolveNetworkConfig(stored: NetworkConfig, env: NodeJS.ProcessEnv = process.env): ResolvedNetworkConfig {
  const proxyOverride = hasEnv(env, "CASTHUB_PROXY");
  const proxy = proxyOverride ? envValue(env, "CASTHUB_PROXY") : stored.proxy;
  if (proxy) assertProxyUrl(proxy);
  const githubMirror = envValue(env, "CASTHUB_GITHUB_MIRROR") || stored.githubMirror;
  const githubToken = envValue(env, "CASTHUB_GITHUB_TOKEN") || stored.githubToken;
  const catalogUrl = envValue(env, "CASTHUB_CATALOG_URL") || stored.catalogUrl;
  if (githubMirror) assertRemoteNetworkUrl(githubMirror, "CASTHUB_GITHUB_MIRROR", { mirrorPrefix: true });
  if (catalogUrl) assertRemoteNetworkUrl(catalogUrl, "CASTHUB_CATALOG_URL");
  if (githubToken.length > MAX_TOKEN_LENGTH) throw new Error("CASTHUB_GITHUB_TOKEN 过长");
  const systemProxy = envValue(env, "HTTPS_PROXY") || envValue(env, "https_proxy") || envValue(env, "HTTP_PROXY") || envValue(env, "http_proxy");
  return {
    proxy,
    githubMirror,
    githubToken,
    catalogUrl,
    useEnvProxy: !proxyOverride && !proxy && Boolean(systemProxy),
    noProxy: envValue(env, "NO_PROXY") || envValue(env, "no_proxy")
  };
}

export function networkSettingsView(
  stored: NetworkConfig,
  effective: ResolvedNetworkConfig,
  env: NodeJS.ProcessEnv = process.env
): NetworkSettingsView {
  return {
    proxy: stored.proxy,
    githubMirror: stored.githubMirror,
    catalogUrl: stored.catalogUrl,
    hasGithubToken: Boolean(effective.githubToken || stored.githubToken),
    overrides: {
      proxy: hasEnv(env, "CASTHUB_PROXY") && envValue(env, "CASTHUB_PROXY") !== "",
      githubMirror: envValue(env, "CASTHUB_GITHUB_MIRROR") !== "",
      githubToken: envValue(env, "CASTHUB_GITHUB_TOKEN") !== "",
      catalogUrl: envValue(env, "CASTHUB_CATALOG_URL") !== ""
    }
  };
}

function readFullConfigObject(configPath: string): Record<string, unknown> {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("无法读取配置 " + configPath + ": " + (error as Error).message);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("解析配置 " + configPath + " 失败: " + (error as Error).message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置 " + configPath + " 必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/**
 * 保存 network 子对象：先读全量 JSON，仅替换 network，保留 desktop 等 Electron 字段，再原子替换。
 * githubToken 留空且未显式清除时保留原值；clearGithubToken=true 才置空。
 */
export function saveStoredNetworkConfig(
  dir: string,
  patch: NetworkSettingsPatch,
  current: NetworkConfig
): NetworkConfig {
  const configPath = path.join(dir, "config.json");
  const obj = readFullConfigObject(configPath);
  const existingNetwork =
    obj.network && typeof obj.network === "object" && !Array.isArray(obj.network)
      ? (obj.network as Record<string, unknown>)
      : {};
  const currentStored = normalizeNetworkConfig(existingNetwork);
  const nextProxy = patch.proxy === undefined ? current.proxy : stringField(patch.proxy, "proxy");
  const nextMirror = patch.githubMirror === undefined ? current.githubMirror : stringField(patch.githubMirror, "githubMirror");
  const nextCatalog = patch.catalogUrl === undefined ? current.catalogUrl : stringField(patch.catalogUrl, "catalogUrl");
  const tokenInput = patch.githubToken === undefined ? "" : stringField(patch.githubToken, "githubToken");
  const clearToken = patch.clearGithubToken === true;
  const nextToken = clearToken ? "" : tokenInput || currentStored.githubToken;
  const next = normalizeNetworkConfig({
    proxy: nextProxy,
    githubMirror: nextMirror,
    githubToken: nextToken,
    catalogUrl: nextCatalog
  });
  obj.network = { ...existingNetwork, ...next };
  const temp = configPath + ".tmp-" + process.pid + "-" + Date.now();
  try {
    fs.writeFileSync(temp, JSON.stringify(obj, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, configPath);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // ignore
    }
    throw error;
  }
  return next;
}

/** 带环境变量覆盖判断的配置服务；保存后通过 onChange 通知网络客户端重建 Agent。 */
export class NetworkSettingsService {
  private stored: NetworkConfig;
  private effective: ResolvedNetworkConfig;
  private readonly configDir: string;
  private readonly env: NodeJS.ProcessEnv;
  onChange: ((config: ResolvedNetworkConfig) => void) | null = null;

  constructor(configDir: string, initial?: ResolvedNetworkConfig, env: NodeJS.ProcessEnv = process.env) {
    this.configDir = configDir;
    this.env = env;
    this.stored = readStoredNetworkConfig(configDir);
    this.effective = initial ?? resolveNetworkConfig(this.stored, env);
  }

  get config(): ResolvedNetworkConfig {
    return this.effective;
  }

  view(): NetworkSettingsView {
    return networkSettingsView(this.stored, this.effective, this.env);
  }

  save(patch: NetworkSettingsPatch): NetworkSettingsView {
    this.stored = saveStoredNetworkConfig(this.configDir, patch, this.stored);
    this.effective = resolveNetworkConfig(this.stored, this.env);
    this.onChange?.(this.effective);
    return this.view();
  }
}
