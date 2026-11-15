// 文件浏览（/api/files）与流服务（/media，含手写 Range 处理）
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Dirent } from "node:fs";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { MediaFileEntry } from "./types";
import { MEDIA_URL_TTL_MS, safeTokenEquals, signMediaPath, verifyMediaPath } from "./security";
import {
  decodeSubtitleBuffer,
  findSubtitleCandidates,
  selectSubtitle,
  subtitleToSrt,
  type SubtitleFormat
} from "./subtitles";

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

export interface FileRouteOptions {
  consoleToken: string;
  mediaSigningKey: Buffer;
  publicBaseUrl: string;
}

const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_SUBTITLE_FORMATS: readonly SubtitleFormat[] = ["srt", "vtt", "ass", "ssa", "smi", "sub"];

export function mimeTypeOf(fileName: string): string {
  return MIME_TYPES[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}

/** 将相对路径安全解析到 root 内；越界返回 null（调用方回 403）。 */
export function resolveWithin(root: string, relative: string): string | null {
  const normalized = relative.replace(/\\/g, "/");
  if (normalized.includes("\0")) return null;
  // 控制台历史记录携带绝对路径；允许绝对路径但必须仍在 mediaRoot 内。
  const resolved = path.isAbsolute(relative)
    ? path.resolve(relative)
    : path.resolve(root, "." + (normalized.startsWith("/") ? normalized : "/" + normalized));
  const rel = path.relative(root, resolved);
  if (rel === "") return resolved;
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return resolved;
}

/** 兼容包装：从多格式候选中选出一条字幕，返回其绝对路径。 */
export async function findSubtitleForVideo(videoPath: string): Promise<string | null> {
  const candidates = await findSubtitleCandidates(videoPath);
  return selectSubtitle(candidates)?.path ?? null;
}

/** 生成带签名、可被 DLNA 电视直接 GET 的 /api/subtitle URL。 */
export function buildSubtitleUrl(
  publicBaseUrl: string,
  mediaRoot: string,
  subtitlePath: string,
  signingKey: Buffer
): string {
  const rel = path.relative(mediaRoot, subtitlePath).split(path.sep).join("/");
  const expires = Date.now() + MEDIA_URL_TTL_MS;
  const signature = signMediaPath(signingKey, rel, expires);
  return `${publicBaseUrl}/api/subtitle?path=${encodeURIComponent(rel)}&expires=${expires}&sig=${encodeURIComponent(signature)}`;
}

/** 在 resolveWithin 的基础上做 realpath 校验，阻止通过符号链接逃逸 mediaRoot。 */
export async function resolveWithinReal(mediaRoot: string, relative: string): Promise<string | null> {
  const lexical = resolveWithin(mediaRoot, relative);
  if (!lexical) return null;
  try {
    const realRoot = await fsp.realpath(mediaRoot);
    const realTarget = await fsp.realpath(lexical);
    const rel = path.relative(realRoot, realTarget);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return realTarget;
    return null;
  } catch {
    return null;
  }
}

function toEntry(root: string, fullPath: string, name: string, isDir: boolean, size: number): MediaFileEntry {
  const rel = path.relative(root, fullPath).split(path.sep).join("/");
  return { name, path: rel, isDir, size, mimeType: isDir ? "" : mimeTypeOf(name) };
}

function headerToken(request: FastifyRequest): string {
  const raw = request.headers["x-casthub-token"];
  return Array.isArray(raw) ? raw[0] ?? "" : String(raw ?? "");
}

function queryToken(request: FastifyRequest): string {
  const query = request.query as Record<string, unknown>;
  return typeof query.token === "string" ? query.token : "";
}

function consoleAuthorized(request: FastifyRequest, options: FileRouteOptions): boolean {
  return safeTokenEquals(options.consoleToken, headerToken(request) || queryToken(request));
}

function mediaAuthorized(request: FastifyRequest, relativePath: string, options: FileRouteOptions): boolean {
  const query = request.query as Record<string, unknown>;
  const expires = typeof query.expires === "string" ? Number(query.expires) : Number.NaN;
  const signature = typeof query.sig === "string" ? query.sig : "";
  if (verifyMediaPath(options.mediaSigningKey, relativePath, expires, signature)) return true;
  return consoleAuthorized(request, options);
}

export async function registerFileRoutes(
  app: FastifyInstance,
  mediaRoot: string,
  options: FileRouteOptions
): Promise<void> {
  const rootReal = await fsp.realpath(mediaRoot);
  app.get("/api/files", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!consoleAuthorized(request, options)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const query = request.query as { path?: string; limit?: string; offset?: string };
    const raw = typeof query.path === "string" ? query.path : "";
    const limit = Math.min(500, Math.max(1, Number.parseInt(query.limit ?? "200", 10) || 200));
    const offset = Math.max(0, Number.parseInt(query.offset ?? "0", 10) || 0);

    const target = await resolveWithinReal(mediaRoot, raw);
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
    let dirents: Dirent[];
    try {
      dirents = await fsp.readdir(target, { withFileTypes: true });
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    const entries: MediaFileEntry[] = [];
    for (const dirent of dirents) {
      if (dirent.name.startsWith(".") || dirent.isSymbolicLink()) continue;
      const full = path.join(target, dirent.name);
      entries.push(toEntry(rootReal, full, dirent.name, dirent.isDirectory(), 0));
    }
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    });
    const page = entries.slice(offset, offset + limit);
    // 只对当前页的文件取 stat，避免大目录下逐项系统调用。
    await Promise.all(
      page
        .filter((entry) => !entry.isDir)
        .map(async (entry) => {
          try {
            const itemStat = await fsp.stat(path.join(target, entry.name));
            entry.size = itemStat.isFile() ? itemStat.size : 0;
          } catch {
            entry.size = 0;
          }
        })
    );
    return reply.send({
      entries: page,
      total: entries.length,
      offset,
      limit,
      hasMore: offset + page.length < entries.length
    });
  });

  app.route({
    method: ["GET", "HEAD"],
    url: "/api/subtitle",
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { path?: string };
      const rel = typeof query.path === "string" ? query.path : "";
      if (!rel || !mediaAuthorized(request, rel, options)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const target = await resolveWithinReal(mediaRoot, rel);
      if (!target) return reply.code(404).send({ error: "not found" });
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(target);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (!stat.isFile()) return reply.code(404).send({ error: "not found" });
      const format = path.extname(target).slice(1).toLowerCase() as SubtitleFormat;
      if (!SUPPORTED_SUBTITLE_FORMATS.includes(format)) {
        return reply.code(415).send({ error: "unsupported subtitle format" });
      }
      if (stat.size > MAX_SUBTITLE_BYTES) return reply.code(413).send({ error: "subtitle too large" });
      let raw: Buffer;
      try {
        raw = await fsp.readFile(target);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      const srt = subtitleToSrt(decodeSubtitleBuffer(raw), format);
      if (!srt.trim()) return reply.code(422).send({ error: "subtitle parse failed" });
      const utf8 = Buffer.from(srt, "utf8");
      reply
        .header("Content-Type", `${mimeTypeOf("subtitle.srt")}; charset=utf-8`)
        .header("Content-Length", utf8.length)
        .header("Cache-Control", "no-store")
        .code(200);
      if (request.method === "HEAD") return reply.send();
      return reply.send(utf8);
    }
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
      if (!mediaAuthorized(request, rel, options)) {
        return reply.code(401).send({ error: "unauthorized" });
      }

      // 先打开文件再 stat，避免检查与读取之间被替换（TOCTOU）。
      let handle: fsp.FileHandle;
      let stat: fs.Stats;
      let target: string;
      try {
        const resolved = await resolveWithinReal(mediaRoot, rel);
        if (!resolved) return reply.code(404).send({ error: "not found" });
        target = resolved;
        handle = await fsp.open(target, "r");
        stat = await handle.stat();
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (!stat.isFile()) {
        await handle.close();
        return reply.code(404).send({ error: "not found" });
      }

      try {
        const size = stat.size;
        const rawRange = typeof request.headers.range === "string" ? request.headers.range.trim() : "";
        // 多段 Range 或非 bytes 单位按 RFC 允许忽略，回退整文件 200；单段 Range 走 206。
        const rangeHeader = !rawRange.startsWith("bytes=") || rawRange.includes(",") ? "" : rawRange;
        let start = 0;
        let end = size > 0 ? size - 1 : 0;
        let statusCode = 200;

        if (rangeHeader) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
          if (!match) {
            await handle.close();
            return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "invalid range" });
          }
          const [, startRaw, endRaw] = match;
          if (startRaw === "" && endRaw === "") {
            await handle.close();
            return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "invalid range" });
          }
          if (startRaw === "") {
            if (!/^\d+$/.test(endRaw)) {
              await handle.close();
              return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "invalid range" });
            }
            const suffixLength = Number(endRaw);
            if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
              await handle.close();
              return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "invalid range" });
            }
            start = Math.max(0, size - suffixLength);
          } else {
            if (!/^\d+$/.test(startRaw) || (endRaw !== "" && !/^\d+$/.test(endRaw))) {
              await handle.close();
              return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "invalid range" });
            }
            start = Number(startRaw);
            end = endRaw === "" ? size - 1 : Number(endRaw);
          }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || size === 0) {
            await handle.close();
            return reply.code(416).header("Content-Range", `bytes */${size}`).send({ error: "range not satisfiable" });
          }
          if (end >= size) end = size - 1;
          statusCode = 206;
        }

        reply.header("Accept-Ranges", "bytes");
        reply.header("Content-Type", mimeTypeOf(rel));
        // 只有 Samsung 式探测（带 getCaptionInfo.sec 请求头）才返回字幕发现头；
        // cast(subtitles=false) 生成的媒体 URL 带 subtitles=0，此时完全禁用。
        const subtitleDisabled = (request.query as { subtitles?: string }).subtitles === "0";
        const wantsCaptionInfo = Object.keys(request.headers).some((key) => key.toLowerCase() === "getcaptioninfo.sec");
        if (!subtitleDisabled && wantsCaptionInfo) {
          const candidates = await findSubtitleCandidates(target);
          const selected = selectSubtitle(candidates);
          if (selected) {
            reply.header(
              "CaptionInfo.sec",
              buildSubtitleUrl(options.publicBaseUrl, rootReal, selected.path, options.mediaSigningKey)
            );
          }
        }
        if (statusCode === 206) {
          reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
        }
        reply.header("Content-Length", statusCode === 206 ? end - start + 1 : size);
        reply.code(statusCode);
        if (request.method === "HEAD" || size === 0) {
          await handle.close();
          return reply.send();
        }
        return reply.send(handle.createReadStream({ start, end, autoClose: true }));
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    }
  });
}
