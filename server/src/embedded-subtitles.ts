// 内嵌字幕探测、轨道选择、文本字幕抽取与去字幕副本缓存。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { DEFAULT_PREFERRED_LANGUAGES } from "./subtitles";

export type EmbeddedSubtitleKind = "text" | "bitmap" | "unknown";

export interface EmbeddedSubtitleTrack {
  streamIndex: number;
  codecName: string;
  kind: EmbeddedSubtitleKind;
  language: string | null;
  title: string | null;
  isDefault: boolean;
  isForced: boolean;
}

export interface EmbeddedSubtitleProbe {
  available: boolean;
  tracks: EmbeddedSubtitleTrack[];
  error?: string;
}

export interface ExtractEmbeddedSubtitleOptions {
  cacheDir: string;
  ffmpegPath?: string;
}

export interface CreateSubtitleStrippedVideoOptions {
  cacheDir: string;
  ffmpegPath?: string;
  /** 与 SRT 对应的稳定文件名前缀；不传时按视频元数据计算。 */
  cacheKey?: string;
}

export interface ExtractedSubtitle {
  srtPath: string;
  relativePath: string;
}

export interface StrippedVideo {
  videoPath: string;
  relativePath: string;
}

export interface EmbeddedToolStatus {
  ffprobe: boolean;
  ffmpeg: boolean;
}

const FFPROBE_TIMEOUT_MS = 15_000;
const FFMPEG_EXTRACT_TIMEOUT_MS = 120_000;
const FFMPEG_STRIP_TIMEOUT_MS = 120_000;
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024;
const PROBE_CACHE_MAX = 200;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const TEXT_CODECS = new Set([
  "ass",
  "jacosub",
  "lrc",
  "microdvd",
  "mov_text",
  "mpl2",
  "pjs",
  "realtext",
  "sami",
  "scc",
  "srt",
  "ssa",
  "stl",
  "subrip",
  "subviewer",
  "text",
  "vtt",
  "webvtt"
]);

const BITMAP_CODECS = new Set([
  "dvb_subtitle",
  "dvb_teletext",
  "dvbsub",
  "dvd_subtitle",
  "dvdsub",
  "hdmv_pgs_subtitle",
  "pgssub",
  "vobsub",
  "xsub"
]);

const probeCache = new Map<string, { key: string; probe: EmbeddedSubtitleProbe }>();
const extractionCache = new Map<string, Promise<ExtractedSubtitle>>();
const strippedCache = new Map<string, Promise<StrippedVideo>>();
const cleanupTimes = new Map<string, number>();
const activeOutputs = new Set<string>();

interface ToolResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
    child.on("close", (code, signal) => {
      finish({
        code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut
      });
    });
  });
}

function toolPathFromEnv(name: string, fallback: string): string {
  const value = (process.env[name] ?? "").trim();
  return value || fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeTagValue(tags: unknown, key: string): string | null {
  if (!tags || typeof tags !== "object" || Array.isArray(tags)) return null;
  const record = tags as Record<string, unknown>;
  let raw: unknown = record[key];
  if (raw === undefined) {
    const wanted = key.toLowerCase();
    for (const [name, value] of Object.entries(record)) {
      if (name.toLowerCase() === wanted) {
        raw = value;
        break;
      }
    }
  }
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value ? value : null;
}

function dispositionFlag(disposition: unknown, key: "default" | "forced"): boolean {
  if (!disposition || typeof disposition !== "object" || Array.isArray(disposition)) return false;
  const value = (disposition as Record<string, unknown>)[key];
  return value === 1 || value === true || value === "1";
}

/** 将 ffprobe codec_name 归类为文本、图片或未知字幕。 */
export function classifyEmbeddedSubtitleCodec(codecName: string): EmbeddedSubtitleKind {
  const codec = String(codecName ?? "").trim().toLowerCase();
  if (TEXT_CODECS.has(codec)) return "text";
  if (BITMAP_CODECS.has(codec)) return "bitmap";
  return "unknown";
}

/** 解析 ffprobe -show_streams JSON；独立导出便于单元测试错误分支。 */
export function parseEmbeddedSubtitleProbe(raw: string): EmbeddedSubtitleProbe {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    return { available: false, tracks: [], error: "ffprobe 输出不是有效 JSON: " + errorMessage(error) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { available: false, tracks: [], error: "ffprobe 输出格式无效" };
  }
  const streams = (parsed as Record<string, unknown>).streams;
  if (streams === undefined) return { available: true, tracks: [] };
  if (!Array.isArray(streams)) {
    return { available: false, tracks: [], error: "ffprobe 输出缺少 streams 数组" };
  }
  const tracks: EmbeddedSubtitleTrack[] = [];
  for (const rawStream of streams) {
    if (!rawStream || typeof rawStream !== "object" || Array.isArray(rawStream)) continue;
    const stream = rawStream as Record<string, unknown>;
    const codecType = String(stream.codec_type ?? "").trim().toLowerCase();
    if (codecType !== "subtitle") continue;
    const streamIndex = Number(stream.index);
    if (!Number.isInteger(streamIndex) || streamIndex < 0) continue;
    const codecName = String(stream.codec_name ?? "").trim().toLowerCase();
    tracks.push({
      streamIndex,
      codecName,
      kind: classifyEmbeddedSubtitleCodec(codecName),
      language: normalizeTagValue(stream.tags, "language"),
      title: normalizeTagValue(stream.tags, "title"),
      isDefault: dispositionFlag(stream.disposition, "default"),
      isForced: dispositionFlag(stream.disposition, "forced")
    });
  }
  tracks.sort((a, b) => a.streamIndex - b.streamIndex);
  return { available: true, tracks };
}

function cloneProbe(probe: EmbeddedSubtitleProbe): EmbeddedSubtitleProbe {
  return { ...probe, tracks: probe.tracks.map((track) => ({ ...track })) };
}

export function clearEmbeddedProbeCache(): void {
  probeCache.clear();
}

async function probeKey(videoPath: string): Promise<{ key: string; realPath: string }> {
  const realPath = await fsp.realpath(path.resolve(videoPath));
  const stat = await fsp.stat(realPath);
  if (!stat.isFile()) throw new Error("不是文件");
  return {
    key: realPath + "|" + stat.size + "|" + Math.trunc(stat.mtimeMs),
    realPath
  };
}

/** 使用 ffprobe 探测视频内嵌字幕轨，结果按 realpath+size+mtime 缓存。 */
export async function probeEmbeddedSubtitles(videoPath: string): Promise<EmbeddedSubtitleProbe> {
  let identity: { key: string; realPath: string };
  try {
    identity = await probeKey(videoPath);
  } catch (error) {
    return { available: false, tracks: [], error: "无法读取视频文件: " + errorMessage(error) };
  }
  const cached = probeCache.get(identity.key);
  if (cached) return cloneProbe(cached.probe);

  const ffprobePath = toolPathFromEnv("FFPROBE_PATH", "ffprobe");
  let result: ToolResult;
  try {
    result = await runTool(
      ffprobePath,
      ["-v", "error", "-print_format", "json", "-show_streams", identity.realPath],
      FFPROBE_TIMEOUT_MS
    );
  } catch (error) {
    return { available: false, tracks: [], error: "ffprobe 不可用: " + errorMessage(error) };
  }
  if (result.timedOut) {
    return { available: false, tracks: [], error: "ffprobe 超时（" + FFPROBE_TIMEOUT_MS + "ms）" };
  }
  if (result.code !== 0) {
    const detail = result.stderr.trim() || "退出码 " + String(result.code);
    return { available: false, tracks: [], error: "ffprobe 失败: " + detail };
  }
  const probe = parseEmbeddedSubtitleProbe(result.stdout);
  if (probeCache.size >= PROBE_CACHE_MAX) {
    const oldest = probeCache.keys().next().value;
    if (oldest !== undefined) probeCache.delete(oldest);
  }
  probeCache.set(identity.key, { key: identity.key, probe });
  return cloneProbe(probe);
}

function languagePreferenceRank(language: string | null, preferred: readonly string[]): number {
  if (!language) return preferred.length + 1;
  const normalized = language.trim().toLowerCase();
  const exact = preferred.indexOf(normalized);
  if (exact >= 0) return exact;
  for (let index = 0; index < preferred.length; index += 1) {
    const tag = preferred[index];
    if (normalized.startsWith(tag + "-") || tag.startsWith(normalized + "-")) return index + 0.5;
  }
  return preferred.length + 1;
}

/** 按显式索引、default、语言偏好、其他非 forced、forced 的顺序选择一条文本字幕。 */
export async function selectEmbeddedSubtitleTrack(
  tracks: readonly EmbeddedSubtitleTrack[],
  options: { requestedStreamIndex?: number; preferredLanguages?: readonly string[] } = {}
): Promise<EmbeddedSubtitleTrack | null> {
  const textTracks = tracks
    .filter((track) => track.kind === "text")
    .slice()
    .sort((a, b) => a.streamIndex - b.streamIndex);
  if (textTracks.length === 0) return null;
  if (options.requestedStreamIndex !== undefined) {
    return textTracks.find((track) => track.streamIndex === options.requestedStreamIndex) ?? null;
  }
  const nonForced = textTracks.filter((track) => !track.isForced);
  const defaultTrack = nonForced.find((track) => track.isDefault);
  if (defaultTrack) return defaultTrack;

  const preferred = options.preferredLanguages ?? DEFAULT_PREFERRED_LANGUAGES;
  let preferredTrack: EmbeddedSubtitleTrack | null = null;
  let preferredRank = Number.POSITIVE_INFINITY;
  for (const track of nonForced) {
    const rank = languagePreferenceRank(track.language, preferred);
    if (
      rank < preferred.length &&
      (rank < preferredRank ||
        (rank === preferredRank && (!preferredTrack || track.streamIndex < preferredTrack.streamIndex)))
    ) {
      preferredTrack = track;
      preferredRank = rank;
    }
  }
  if (preferredTrack) return preferredTrack;
  if (nonForced.length > 0) return nonForced[0];
  return textTracks.find((track) => track.isForced) ?? null;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeCacheStem(cacheKey: string | undefined): string | null {
  if (!cacheKey) return null;
  const stem = path.basename(cacheKey).replace(/\.[^.]+$/, "");
  if (!/^[a-f0-9]{32,64}$/i.test(stem)) return null;
  return stem.toLowerCase();
}

async function ensureCacheDir(cacheDir: string): Promise<string> {
  const resolved = path.resolve(cacheDir);
  await fsp.mkdir(resolved, { recursive: true });
  scheduleCleanup(resolved);
  return resolved;
}

function scheduleCleanup(cacheDir: string): void {
  const last = cleanupTimes.get(cacheDir) ?? 0;
  const now = Date.now();
  if (now - last < CLEANUP_INTERVAL_MS) return;
  cleanupTimes.set(cacheDir, now);
  // 清理失败不能影响探测/投屏主流程。
  void cleanupEmbeddedCache(cacheDir).catch((error) => {
    console.warn("[embedded-subtitles] 缓存清理失败: " + errorMessage(error));
  });
}

/** 删除超过 7 天的缓存文件；正在生成的 .part 与活跃输出不会被删除。 */
export async function cleanupEmbeddedCache(cacheDir: string, maxAgeMs = CACHE_MAX_AGE_MS): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = path.join(cacheDir, entry.name);
    if (entry.name.includes(".part") || activeOutputs.has(fullPath)) continue;
    try {
      const stat = await fsp.stat(fullPath);
      if (stat.mtimeMs < cutoff) {
        await fsp.unlink(fullPath);
        removed += 1;
      }
    } catch {
      // 文件可能被其他进程删除或仍被占用，跳过。
    }
  }
  return removed;
}

async function existingOutput(filePath: string): Promise<boolean> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function resolveVideoIdentity(
  videoPath: string,
  marker: string,
  track?: EmbeddedSubtitleTrack
): Promise<{ realPath: string; key: string }> {
  const realPath = await fsp.realpath(path.resolve(videoPath));
  const stat = await fsp.stat(realPath);
  if (!stat.isFile()) throw new Error("不是文件");
  const trackPart = track ? "|" + track.streamIndex + "|" + track.codecName : "";
  return { realPath, key: realPath + "|" + stat.size + "|" + Math.trunc(stat.mtimeMs) + "|" + marker + trackPart };
}

function cacheRelative(cacheDir: string, filePath: string): string {
  return path.relative(cacheDir, filePath).replace(/\\/g, "/");
}

function cleanupPart(partPath: string): void {
  void fsp.unlink(partPath).catch(() => undefined);
}

/** 抽取单条文本字幕为 UTF-8 SRT，使用临时文件 + 原子重命名。 */
export async function extractEmbeddedSubtitleToSrt(
  videoPath: string,
  track: EmbeddedSubtitleTrack,
  options: ExtractEmbeddedSubtitleOptions
): Promise<ExtractedSubtitle> {
  if (track.kind !== "text") {
    throw new Error("字幕流 " + track.streamIndex + " 不是文本字幕，无法抽取");
  }
  const cacheDir = await ensureCacheDir(options.cacheDir);
  const identity = await resolveVideoIdentity(videoPath, "subtitle", track);
  const outputName = hashText(identity.key) + ".srt";
  const outputPath = path.join(cacheDir, outputName);
  if (await existingOutput(outputPath)) {
    return { srtPath: outputPath, relativePath: cacheRelative(cacheDir, outputPath) };
  }
  const inflight = extractionCache.get(outputPath);
  if (inflight) return inflight;

  const task = (async (): Promise<ExtractedSubtitle> => {
    const partPath = outputPath + "." + process.pid + "." + Date.now() + "." + Math.random().toString(16).slice(2) + ".part";
    activeOutputs.add(outputPath);
    try {
      const ffmpegPath = options.ffmpegPath ?? toolPathFromEnv("FFMPEG_PATH", "ffmpeg");
      const result = await runTool(
        ffmpegPath,
        [
          "-v",
          "error",
          "-y",
          "-i",
          identity.realPath,
          "-map",
          "0:" + track.streamIndex,
          "-c:s",
          "srt",
          "-f",
          "srt",
          partPath
        ],
        FFMPEG_EXTRACT_TIMEOUT_MS
      );
      if (result.timedOut) throw new Error("ffmpeg 抽取字幕超时（" + FFMPEG_EXTRACT_TIMEOUT_MS + "ms）");
      if (result.code !== 0) {
        throw new Error("ffmpeg 抽取字幕失败: " + (result.stderr.trim() || "退出码 " + String(result.code)));
      }
      const partStat = await fsp.stat(partPath).catch(() => null);
      if (!partStat || !partStat.isFile() || partStat.size === 0) {
        throw new Error("ffmpeg 未生成字幕文件");
      }
      if (partStat.size > MAX_SUBTITLE_BYTES) {
        throw new Error("字幕文件超过 " + MAX_SUBTITLE_BYTES + " 字节限制");
      }
      const raw = await fsp.readFile(partPath);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      } catch {
        throw new Error("ffmpeg 生成的字幕不是有效 UTF-8");
      }
      if (!text.trim()) throw new Error("ffmpeg 生成的字幕为空");
      await fsp.writeFile(partPath, text.replace(/^\uFEFF/, ""), "utf8");
      await fsp.rename(partPath, outputPath).catch(async (error) => {
        if (await existingOutput(outputPath)) return;
        throw error;
      });
      return { srtPath: outputPath, relativePath: cacheRelative(cacheDir, outputPath) };
    } finally {
      activeOutputs.delete(outputPath);
      cleanupPart(partPath);
    }
  })();
  extractionCache.set(outputPath, task);
  try {
    return await task;
  } finally {
    extractionCache.delete(outputPath);
  }
}

/** 生成同扩展名、仅视频+音频、不重编码的去字幕副本。 */
export async function createSubtitleStrippedVideo(
  videoPath: string,
  options: CreateSubtitleStrippedVideoOptions
): Promise<StrippedVideo> {
  const cacheDir = await ensureCacheDir(options.cacheDir);
  const identity = await resolveVideoIdentity(videoPath, "stripped");
  const extension = path.extname(identity.realPath).toLowerCase() || ".mp4";
  const stem = safeCacheStem(options.cacheKey) ?? hashText(identity.key);
  const outputPath = path.join(cacheDir, stem + ".nosubs" + extension);
  if (await existingOutput(outputPath)) {
    return { videoPath: outputPath, relativePath: cacheRelative(cacheDir, outputPath) };
  }
  const inflight = strippedCache.get(outputPath);
  if (inflight) return inflight;

  const task = (async (): Promise<StrippedVideo> => {
    const partPath = outputPath + "." + process.pid + "." + Date.now() + "." + Math.random().toString(16).slice(2) + ".part";
    activeOutputs.add(outputPath);
    try {
      const ffmpegPath = options.ffmpegPath ?? toolPathFromEnv("FFMPEG_PATH", "ffmpeg");
      const result = await runTool(
        ffmpegPath,
        [
          "-v",
          "error",
          "-y",
          "-i",
          identity.realPath,
          "-map",
          "0:v:0",
          "-map",
          "0:a?",
          "-c",
          "copy",
          "-sn",
          partPath
        ],
        FFMPEG_STRIP_TIMEOUT_MS
      );
      if (result.timedOut) throw new Error("ffmpeg 生成去字幕副本超时（" + FFMPEG_STRIP_TIMEOUT_MS + "ms）");
      if (result.code !== 0) {
        throw new Error("ffmpeg 生成去字幕副本失败: " + (result.stderr.trim() || "退出码 " + String(result.code)));
      }
      const partStat = await fsp.stat(partPath).catch(() => null);
      if (!partStat || !partStat.isFile() || partStat.size === 0) {
        throw new Error("ffmpeg 未生成去字幕副本");
      }
      await fsp.rename(partPath, outputPath).catch(async (error) => {
        if (await existingOutput(outputPath)) return;
        throw error;
      });
      return { videoPath: outputPath, relativePath: cacheRelative(cacheDir, outputPath) };
    } finally {
      activeOutputs.delete(outputPath);
      cleanupPart(partPath);
    }
  })();
  strippedCache.set(outputPath, task);
  try {
    return await task;
  } finally {
    strippedCache.delete(outputPath);
  }
}

/** 探测 ffprobe/ffmpeg 是否可执行；启动时记录日志，具体模式错误由投屏流程给出。 */
export async function detectEmbeddedSubtitleTools(): Promise<EmbeddedToolStatus> {
  const check = async (toolPath: string): Promise<boolean> => {
    try {
      const result = await runTool(toolPath, ["-version"], 3_000);
      return !result.timedOut && result.code === 0;
    } catch {
      return false;
    }
  };
  const [ffprobe, ffmpeg] = await Promise.all([
    check(toolPathFromEnv("FFPROBE_PATH", "ffprobe")),
    check(toolPathFromEnv("FFMPEG_PATH", "ffmpeg"))
  ]);
  return { ffprobe, ffmpeg };
}
