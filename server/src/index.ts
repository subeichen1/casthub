// CastHub 中枢入口：读取 MEDIA_DIR / PUBLIC_BASE_URL / config.json，启动 HTTP + WS 服务
import Fastify, { LogController } from "fastify";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { attachConsoleWs } from "./console-ws";
import { DeviceManager } from "./devices";
import { DlnaService } from "./dlna";
import { registerFileRoutes } from "./files";
import { createHistoryStore, HistoryRecorder } from "./history";
import { detectEmbeddedSubtitleTools } from "./embedded-subtitles";
import { TvDesktopService } from "./tv-desktop";
import { createRotatingLogStream } from "./log";
import { resolveConsoleToken } from "./security";

const DEFAULT_PORT = 9420;
const DEFAULT_MEDIA_DIR = path.resolve(__dirname, "..", "media");
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

export interface ServerConfig {
  mediaDir: string;
  publicBaseUrl?: string;
  consoleToken?: string;
  /** 最终历史数据目录（通常由 DATA_DIR / PORTABLE_EXECUTABLE_DIR 推导而来）。 */
  dataDir?: string;
}

export interface ServerHandle {
  /** 仅本机（Electron 壳）使用的控制台地址。 */
  url: string;
  /** 控制台访问令牌，Electron 壳用它打开页面；命令行会写入 console-token.txt。 */
  consoleToken: string;
  /** 给电视/手机等局域网设备使用的媒体基地址。 */
  publicBaseUrl: string;
  close: () => Promise<void>;
}

/**
 * 读取指定目录下的 config.json（不存在则返回空对象）。
 * mediaDir 相对路径按 config.json 所在目录解析。
 * 配置损坏时直接抛错，避免静默回退到错误目录。
 */
export function readConfigFile(dir: string): Partial<ServerConfig> {
  const configPath = path.join(dir, "config.json");
  let raw: string;
  try {
    // 兼容 Windows 记事本/PowerShell 生成的 UTF-8 BOM
    raw = fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new Error(`无法读取配置 ${configPath}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`解析配置 ${configPath} 失败: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`配置 ${configPath} 必须是 JSON 对象`);
  }

  const obj = parsed as Record<string, unknown>;
  const result: Partial<ServerConfig> = {};
  if (obj.mediaDir !== undefined && typeof obj.mediaDir !== "string") {
    throw new Error("config.json 的 mediaDir 必须是字符串");
  }
  if (typeof obj.mediaDir === "string" && obj.mediaDir.trim()) {
    result.mediaDir = path.resolve(dir, obj.mediaDir.trim());
  }
  if (obj.publicBaseUrl !== undefined && typeof obj.publicBaseUrl !== "string") {
    throw new Error("config.json 的 publicBaseUrl 必须是字符串");
  }
  if (typeof obj.publicBaseUrl === "string" && obj.publicBaseUrl.trim()) {
    result.publicBaseUrl = obj.publicBaseUrl.trim();
  }
  if (obj.consoleToken !== undefined && typeof obj.consoleToken !== "string") {
    throw new Error("config.json 的 consoleToken 必须是字符串");
  }
  if (typeof obj.consoleToken === "string" && obj.consoleToken.trim()) {
    result.consoleToken = obj.consoleToken.trim();
  }
  return result;
}

/**
 * 配置来源优先级：环境变量 > config.json > 调用方传入的默认值。
 * config.json 从 configDir（默认运行目录）读取。
 */
export function resolveServerConfig(config: ServerConfig, configDir: string = process.cwd()): ServerConfig {
  const fileConfig = readConfigFile(configDir);
  const envMediaDir = (process.env.MEDIA_DIR ?? "").trim();
  const envPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  const mediaDir = envMediaDir ? path.resolve(envMediaDir) : fileConfig.mediaDir ?? path.resolve(config.mediaDir);
  const publicBaseUrl =
    envPublicBaseUrl !== undefined ? envPublicBaseUrl.trim() : fileConfig.publicBaseUrl ?? config.publicBaseUrl;
  const consoleToken = fileConfig.consoleToken ?? config.consoleToken;
  return { mediaDir, publicBaseUrl, consoleToken, dataDir: resolveDataDir(config) };
}

/**
 * 数据目录优先级：DATA_DIR > PORTABLE_EXECUTABLE_DIR（exe 旁）> 项目根目录；
 * 最终数据库固定放在其下的 data/casthub.db。
 */
export function resolveDataDir(config: ServerConfig): string {
  const envDataDir = (process.env.DATA_DIR ?? "").trim();
  if (envDataDir) return path.resolve(envDataDir, "data");
  const portableDir = (process.env.PORTABLE_EXECUTABLE_DIR ?? "").trim();
  if (portableDir) return path.resolve(portableDir, "data");
  return config.dataDir ? path.resolve(config.dataDir) : path.resolve(__dirname, "..", "data");
}

const SENSITIVE_QUERY_KEYS = new Set(["sig", "signature", "token", "access_token", "auth", "key", "api_key"]);

/**
 * 移除请求 URL 中的签名/令牌查询参数，避免 Fastify 访问日志泄露媒体签名。
 * 保留路径、expires 等排障所需字段。
 */
export function sanitizeRequestUrl(rawUrl: string): string {
  try {
    const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawUrl);
    const url = new URL(rawUrl, "http://localhost");
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return isAbsolute ? url.toString() : `${url.pathname}${url.search}`;
  } catch {
    return rawUrl;
  }
}

/** 仅 RFC1918 私网 IPv4：10/8、172.16/12、192.168/16。 */
export function isPrivateIpv4(address: string): boolean {
  if (!net.isIPv4(address)) return false;
  const [first, second] = address.split(".").map((part) => Number(part));
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  return first === 192 && second === 168;
}

/**
 * 探测局域网 IPv4 地址，供电视/手机访问媒体。
 * 只选择 RFC1918 私网地址，避免把公网网卡地址当作局域网入口。
 */
export function detectLanIpv4(): string | null {
  const candidates: Array<{ address: string; score: number }> = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (!info || info.family !== "IPv4" || info.internal) continue;
      if (!isPrivateIpv4(info.address)) continue;
      let score = 100;
      const lowerName = name.toLowerCase();
      if (/(docker|veth|vmware|virtualbox|hyper-v|vethernet|wsl|tailscale|zerotier)/.test(lowerName)) {
        score += 50;
      }
      if (info.address.startsWith("192.168.")) score -= 10;
      else if (info.address.startsWith("10.")) score += 0;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(info.address)) score += 10;
      candidates.push({ address: info.address, score });
    }
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.address ?? null;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * 启动 CastHub 中枢。返回监听地址与关闭函数，供 CLI / Electron 壳共用。
 * 业务逻辑与页面资源保持不变，仅把启动流程函数化。
 */
export async function startServer(config: ServerConfig): Promise<ServerHandle> {
  const configDir = (process.env.CASTHUB_CONFIG_DIR ?? "").trim() || process.cwd();
  const resolved = resolveServerConfig(config, configDir);
  await fs.promises.mkdir(resolved.mediaDir, { recursive: true });

  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1-65535 之间的整数，当前为 ${String(process.env.PORT)}`);
  }
  const host = (process.env.HOST ?? "0.0.0.0").trim();
  if (!host) throw new Error("HOST 不能为空");
  if (net.isIP(host) === 0 && host !== "localhost") {
    throw new Error(`HOST 必须是 IP 地址或 localhost，当前为 ${host}`);
  }

  const consoleToken = resolveConsoleToken(configDir, resolved.consoleToken);
  const mediaSigningKey = randomBytes(32);

  const logFile = (process.env.CASTHUB_LOG_FILE ?? "").trim();
  const app = Fastify({
    logger: logFile ? { level: "info", stream: createRotatingLogStream(logFile) } : true,
    logController: new LogController({ disableRequestLogging: true })
  });
  app.addHook("onRequest", async (request) => {
    request.log.info({ method: request.method, url: sanitizeRequestUrl(request.url) }, "incoming request");
  });
  app.addHook("onResponse", async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        url: sanitizeRequestUrl(request.url),
        statusCode: reply.statusCode,
        responseTimeMs: Math.round(reply.elapsedTime)
      },
      "request completed"
    );
  });
  const devices = new DeviceManager();
  const dlna = new DlnaService();
  const historyHandle = createHistoryStore(resolved.dataDir as string);
  const history = new HistoryRecorder(historyHandle.store);
  app.log.info(`播放历史存储: ${historyHandle.kind}  ${historyHandle.filePath}`);
  const embeddedCacheDir = path.join(resolved.dataDir as string, "cache", "embedded-subtitles");
  await fs.promises.mkdir(embeddedCacheDir, { recursive: true });
  const embeddedTools = await detectEmbeddedSubtitleTools();
  app.log.info(
    `内嵌字幕工具: ffprobe=${embeddedTools.ffprobe ? "可用" : "不可用"} ffmpeg=${embeddedTools.ffmpeg ? "可用" : "不可用"}`
  );
  const tvDesktop = new TvDesktopService({ cacheDir: path.join(resolved.dataDir as string, "cache", "tv-desktop") });

  // 安全响应头：控制台页面只允许加载自身资源。
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'"
    );
    return payload;
  });

  // 媒体地址必须在监听前确定；显式配置优先，否则探测局域网地址。
  const explicitPublicBaseUrl = (resolved.publicBaseUrl ?? "").trim();
  const lanIp = detectLanIpv4();
  const publicHost = host === "0.0.0.0" || host === "::" ? lanIp ?? "127.0.0.1" : host;
  const publicBaseUrl = (explicitPublicBaseUrl || `http://${formatHostForUrl(publicHost)}:${port}`).replace(/\/+$/, "");

  await registerFileRoutes(app, resolved.mediaDir, {
    consoleToken,
    mediaSigningKey,
    publicBaseUrl,
    embeddedCacheDir,
  });
  const consoleWs = attachConsoleWs(app, devices, resolved.mediaDir, dlna, {
    consoleToken,
    publicBaseUrl,
    mediaSigningKey,
    history,
    embeddedCacheDir,
    tvDesktop
  });

  // 控制台静态页面（无构建步骤）
  app.get("/", async (_request, reply) => {
    const html = await fs.promises.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
    return reply.header("Cache-Control", "no-store").type("text/html; charset=utf-8").send(html);
  });
  app.get("/app.js", async (_request, reply) => {
    const js = await fs.promises.readFile(path.join(PUBLIC_DIR, "app.js"), "utf8");
    return reply.header("Cache-Control", "no-store").type("application/javascript; charset=utf-8").send(js);
  });

  // 兜底：任何试图访问项目内部文件（MEDIA_DIR/public 之外）的路径一律 403。
  // curl 等客户端会先规范化 /media/../package.json 为 /package.json，这里再次兜底。
  const projectRoot = path.resolve(__dirname, "..");
  app.setNotFoundHandler(async (request, reply) => {
    let urlPath = (request.raw.url ?? "").split("?")[0];
    try {
      urlPath = decodeURIComponent(urlPath);
    } catch {
      return reply.code(400).send({ error: "bad path" });
    }
    if (urlPath.includes("..")) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const candidate = path.resolve(projectRoot, "." + urlPath);
    if (!candidate.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return reply.code(403).send({ error: "forbidden" });
    }
    return reply.code(404).send({ error: "not found" });
  });

  await app.listen({ port, host });
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${formatHostForUrl(displayHost)}:${port}`;
  app.log.info(
    `CastHub 已启动 ${url}  MEDIA_BASE=${publicBaseUrl}  MEDIA_DIR=${resolved.mediaDir}  HISTORY=${historyHandle.kind}:${historyHandle.filePath}`
  );
  try {
    await dlna.start();
  } catch (error) {
    history.close();
    await app.close().catch(() => undefined);
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await dlna.dispose();
    devices.dispose();
    history.close();
    for (const client of consoleWs.clients) client.terminate();
    await new Promise<void>((resolve) => consoleWs.close(() => resolve()));
    await app.close();
  };

  return { url, consoleToken, publicBaseUrl, close };
}

async function main(): Promise<void> {
  const server = await startServer({ mediaDir: DEFAULT_MEDIA_DIR });
  const tokenFile = path.join((process.env.CASTHUB_CONFIG_DIR ?? "").trim() || process.cwd(), "console-token.txt");
  console.log(`控制台令牌文件: ${tokenFile}`);
  const shutdown = async (): Promise<void> => {
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// 直接执行（npm start / tsx src/index.ts）时保持原有行为；被 Electron require 时不自动启动。
if (require.main === module) {
  main().catch((error) => {
    console.error("启动失败:", error);
    process.exit(1);
  });
}
