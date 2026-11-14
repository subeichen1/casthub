// 文件浏览（/api/files）与流服务（/media，含手写 Range 处理）
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { MediaFileEntry } from "./types";

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8"
};

export function mimeTypeOf(fileName: string): string {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/** 将相对路径安全解析到 root 内；越界返回 null（调用方回 403）。 */
export function resolveWithin(root: string, relative: string): string | null {
  const normalized = relative.replace(/\\/g, "/");
  if (normalized.includes("\0")) return null;
  const resolved = path.resolve(root, "." + (normalized.startsWith("/") ? normalized : "/" + normalized));
  const rel = path.relative(root, resolved);
  if (rel === "") return resolved;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

function toEntry(root: string, fullPath: string, name: string, isDir: boolean, size: number): MediaFileEntry {
  const rel = path.relative(root, fullPath).split(path.sep).join("/");
  return { name, path: rel, isDir, size, mimeType: isDir ? "" : mimeTypeOf(name) };
}

export async function registerFileRoutes(app: FastifyInstance, mediaRoot: string): Promise<void> {
  app.get("/api/files", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { path?: string };
    const raw = typeof query.path === "string" ? query.path : "";
    const target = resolveWithin(mediaRoot, raw);
    if (!target) {
      return reply.code(403).send({ error: "forbidden" });
    }
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(target);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    if (!stat.isDirectory()) {
      return reply.code(400).send({ error: "not a directory" });
    }
    const dirents = await fsp.readdir(target, { withFileTypes: true });
    const entries: MediaFileEntry[] = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".")) continue;
      const full = path.join(target, dirent.name);
      let itemStat: fs.Stats;
      try {
        itemStat = await fsp.stat(full);
      } catch {
        continue;
      }
      const isDir = itemStat.isDirectory();
      entries.push(toEntry(mediaRoot, full, dirent.name, isDir, isDir ? 0 : itemStat.size));
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });
    return reply.send({ entries });
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/media/*",
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      let rel: string;
      try {
        rel = decodeURIComponent((request.params as Record<string, string>)["*"] ?? "");
      } catch {
        return reply.code(400).send({ error: "bad path" });
      }
      const target = resolveWithin(mediaRoot, rel);
      if (!target) {
        return reply.code(403).send({ error: "forbidden" });
      }
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(target);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (!stat.isFile()) {
        return reply.code(404).send({ error: "not found" });
      }

      const size = stat.size;
      const rangeHeader = typeof request.headers.range === "string" ? request.headers.range.trim() : "";
      let start = 0;
      let end = size > 0 ? size - 1 : 0;
      let statusCode = 200;

      if (rangeHeader) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
        if (!match) {
          return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "invalid range" });
        }
        const [, startRaw, endRaw] = match;
        if (startRaw === "" && endRaw === "") {
          return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "invalid range" });
        }
        if (startRaw === "") {
          const suffixLength = Number.parseInt(endRaw, 10);
          if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
            return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "invalid range" });
          }
          start = Math.max(0, size - suffixLength);
        } else {
          start = Number.parseInt(startRaw, 10);
          end = endRaw === "" ? size - 1 : Number.parseInt(endRaw, 10);
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size || size === 0) {
          return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "range not satisfiable" });
        }
        if (end >= size) end = size - 1;
        statusCode = 206;
      }

      reply.header("Accept-Ranges", "bytes");
      reply.header("Content-Type", mimeTypeOf(target));
      if (statusCode === 206) {
        reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
      }
      reply.header("Content-Length", statusCode === 206 ? end - start + 1 : size);
      reply.code(statusCode);
      if (request.method === "HEAD" || size === 0) {
        return reply.send();
      }
      return reply.send(fs.createReadStream(target, { start, end }));
    }
  });
}
