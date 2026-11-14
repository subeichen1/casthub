// CastHub 中枢入口：读取 MEDIA_DIR / PUBLIC_BASE_URL，启动 HTTP + WS 服务
import Fastify from "fastify";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerFileRoutes } from "./files";

const PORT = Number(process.env.PORT ?? 9420);
const HOST = process.env.HOST ?? "0.0.0.0";
const DEFAULT_MEDIA_DIR = path.resolve(__dirname, "..", "media");
const MEDIA_DIR = process.env.MEDIA_DIR ? path.resolve(process.env.MEDIA_DIR) : DEFAULT_MEDIA_DIR;
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

async function main(): Promise<void> {
  await fs.promises.mkdir(MEDIA_DIR, { recursive: true });

  const app = Fastify({ logger: true });

  await registerFileRoutes(app, MEDIA_DIR);

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

  await app.listen({ port: PORT, host: HOST });
  app.log.info(`CastHub 已启动 http://${HOST}:${PORT}  MEDIA_DIR=${MEDIA_DIR}`);
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exit(1);
});
