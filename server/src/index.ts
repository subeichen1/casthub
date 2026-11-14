// CastHub 中枢入口：读取 MEDIA_DIR / PUBLIC_BASE_URL / config.json，启动 HTTP + WS 服务
import Fastify from "fastify";
import * as fs from "node:fs";
import * as path from "node:path";
import { attachConsoleWs } from "./console-ws";
import { DeviceManager } from "./devices";
import { DlnaService } from "./dlna";
import { registerFileRoutes } from "./files";

const DEFAULT_PORT = 9420;
const DEFAULT_MEDIA_DIR = path.resolve(__dirname, "..", "media");
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

export interface ServerConfig {
  mediaDir: string;
  publicBaseUrl?: string;
}

export interface ServerHandle {
  url: string;
  close: () => Promise<void>;
}

/**
 * 读取指定目录下的 config.json（不存在则返回空对象）。
 * mediaDir 相对路径按 config.json 所在目录解析。
 */
export function readConfigFile(dir: string): Partial<ServerConfig> {
  const configPath = path.join(dir, "config.json");
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`[config] 无法读取 ${configPath}: ${(error as Error).message}（已忽略）`);
    }
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("config.json 必须是 JSON 对象");
    }
    const obj = parsed as Record<string, unknown>;
    const result: Partial<ServerConfig> = {};
    if (typeof obj.mediaDir === "string" && obj.mediaDir.trim()) {
      result.mediaDir = path.resolve(dir, obj.mediaDir.trim());
    }
    if (typeof obj.publicBaseUrl === "string" && obj.publicBaseUrl.trim()) {
      result.publicBaseUrl = obj.publicBaseUrl.trim();
    }
    return result;
  } catch (error) {
    console.error(`[config] 解析 ${configPath} 失败: ${(error as Error).message}（已忽略）`);
    return {};
  }
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
  return { mediaDir, publicBaseUrl };
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
  const host = process.env.HOST ?? "0.0.0.0";

  // console-ws 直接读取 process.env.PUBLIC_BASE_URL；把 config.json 的值同步进环境变量，
  // 保证既有业务模块零改动即可享受 环境变量 > config.json > 默认值 的优先级。
  const previousPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  if (resolved.publicBaseUrl !== undefined) {
    process.env.PUBLIC_BASE_URL = resolved.publicBaseUrl;
  } else if (previousPublicBaseUrl === undefined) {
    process.env.PUBLIC_BASE_URL = "";
  }

  const logFile = (process.env.CASTHUB_LOG_FILE ?? "").trim();
  if (logFile) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  const app = Fastify({ logger: logFile ? { level: "info", file: logFile } : true });
  const devices = new DeviceManager();
  const dlna = new DlnaService();

  await registerFileRoutes(app, resolved.mediaDir);
  attachConsoleWs(app, devices, resolved.mediaDir, dlna);

  // 控制台静态页面（无构建步骤）
  app.get("/", async (_request, reply) => {
    const html = await fs.promises.readFile(path.join(PUBLIC_DIR, "index.html"), "utf8");
    return reply.type("text/html; charset=utf-8").send(html);
  });
  app.get("/app.js", async (_request, reply) => {
    const js = await fs.promises.readFile(path.join(PUBLIC_DIR, "app.js"), "utf8");
    return reply.type("application/javascript; charset=utf-8").send(js);
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
  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${port}`;
  app.log.info(`CastHub 已启动 ${url}  MEDIA_DIR=${resolved.mediaDir}`);
  dlna.start();

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    dlna.dispose();
    devices.dispose();
    await app.close();
    if (previousPublicBaseUrl === undefined) {
      delete process.env.PUBLIC_BASE_URL;
    } else {
      process.env.PUBLIC_BASE_URL = previousPublicBaseUrl;
    }
  };

  return { url, close };
}

async function main(): Promise<void> {
  const server = await startServer({ mediaDir: DEFAULT_MEDIA_DIR });
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
