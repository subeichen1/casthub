// 多格式字幕：候选扫描、单条选择、统一转 UTF-8 SRT
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";

export type SubtitleFormat = "srt" | "vtt" | "ass" | "ssa" | "smi" | "sub";

export interface SubtitleCandidate {
  /** 绝对路径 */
  path: string;
  /** 小写扩展名 */
  format: SubtitleFormat;
  /** 语言后缀（小写），例如 "zh"、"zh-cn"；精确同名时为 null */
  language: string | null;
  /** 是否与视频 basename 完全同名 */
  exact: boolean;
  /** 视频同目录为 0，字幕子目录依次递增 */
  locationRank: number;
}

const FORMAT_ORDER: Record<SubtitleFormat, number> = {
  srt: 0,
  vtt: 1,
  ass: 2,
  ssa: 3,
  smi: 4,
  sub: 5
};

const SUBTITLE_DIRS = ["Subs", "subtitles", "sub"] as const;

export const DEFAULT_PREFERRED_LANGUAGES = [
  "zh",
  "zh-cn",
  "zh-hans",
  "zh-hant",
  "chs",
  "cht",
  "chi",
  "en",
  "eng",
  "ja",
  "jpn",
  "ko",
  "kor"
] as const;

// 只使用明确的语言标签 allowlist，避免把 movie.2024.srt 误认为语言后缀。
const LANGUAGE_TAGS = new Set([
  "zh", "zho", "chi", "chs", "cht", "zh-cn", "zh-sg", "zh-tw", "zh-hk", "zh-hans", "zh-hant",
  "en", "eng", "ja", "jpn", "ko", "kor",
  "fr", "fra", "fre", "de", "deu", "ger", "es", "spa", "it", "ita", "pt", "por", "ru", "rus",
  "ar", "ara", "nl", "nld", "dut", "pl", "pol", "tr", "tur", "sv", "swe", "da", "dan", "fi", "fin",
  "no", "nor", "nb", "nn", "cs", "ces", "cze", "hu", "hun", "el", "ell", "gre", "he", "heb",
  "hi", "hin", "th", "tha", "vi", "vie", "id", "ind", "ms", "msa", "may", "uk", "ukr",
  "ro", "ron", "rum", "bg", "bul", "hr", "hrv", "sr", "srp", "sk", "slk", "slo", "sl", "slv",
  "et", "est", "lv", "lav", "lt", "lit", "fa", "fas", "per", "ur", "urd", "tl", "tgl", "fil"
]);

const MODIFIERS = new Set(["forced", "sdh", "cc", "default", "full", "sc", "tc"]);

const SUBTITLE_CACHE_TTL_MS = 2_000;
const SUBTITLE_CACHE_MAX = 200;
const subtitleCache = new Map<string, { expiresAt: number; candidates: SubtitleCandidate[] }>();

function cloneCandidate(candidate: SubtitleCandidate): SubtitleCandidate {
  return { ...candidate };
}

/** 清空字幕扫描缓存（测试或显式刷新时使用）。 */
export function clearSubtitleCache(): void {
  subtitleCache.clear();
}

const ASS_DEFAULT_FIELDS = [
  "layer",
  "start",
  "end",
  "style",
  "name",
  "marginl",
  "marginr",
  "marginv",
  "effect",
  "text"
];

function toLf(input: string): string {
  return input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function logSkip(filePath: string, reason: string): void {
  console.warn("[subtitles] 跳过 " + filePath + ": " + reason);
}

function normalizePathForSort(filePath: string): string {
  return path.normalize(filePath).replace(/\\/g, "/").toLowerCase();
}

function languagePreferenceRank(language: string | null, preferred: readonly string[]): number {
  if (!language) return preferred.length + 1;
  const exact = preferred.indexOf(language);
  if (exact >= 0) return exact;
  // 允许 preferred=["zh"] 时 zh-cn/zh-hans 仍属于中文偏好，但排在精确 zh 之后。
  for (let index = 0; index < preferred.length; index += 1) {
    const tag = preferred[index];
    if (language.startsWith(tag + "-") || tag.startsWith(language + "-")) return index + 0.5;
  }
  return preferred.length + 1;
}

function comparePaths(a: SubtitleCandidate, b: SubtitleCandidate): number {
  const left = normalizePathForSort(a.path);
  const right = normalizePathForSort(b.path);
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface FindSubtitleCandidatesOptions {
  /** 跳过缓存重新扫描；投屏动作使用，确保刚放入的字幕立即可见。 */
  refresh?: boolean;
}

/** 扫描视频同目录及 Subs/subtitles/sub 一级子目录中的字幕候选。永不抛异常。 */
export async function findSubtitleCandidates(
  videoPath: string,
  options: FindSubtitleCandidatesOptions = {}
): Promise<SubtitleCandidate[]> {
  const absoluteVideo = path.resolve(videoPath);
  const cacheKey = normalizePathForSort(absoluteVideo);
  if (options.refresh) {
    subtitleCache.delete(cacheKey);
  } else {
    const cached = subtitleCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.candidates.map(cloneCandidate);
    }
    if (cached) subtitleCache.delete(cacheKey);
  }
  try {
    const base = path.basename(absoluteVideo, path.extname(absoluteVideo));
    const videoDir = path.dirname(absoluteVideo);
    const locations: Array<{ dir: string; rank: number }> = [{ dir: videoDir, rank: 0 }];
    for (let index = 0; index < SUBTITLE_DIRS.length; index += 1) {
      locations.push({ dir: path.join(videoDir, SUBTITLE_DIRS[index]), rank: index + 1 });
    }

    const result: SubtitleCandidate[] = [];
    for (const location of locations) {
      let entries: Dirent[];
      try {
        entries = await fsp.readdir(location.dir, { withFileTypes: true });
      } catch (error) {
        // 字幕子目录不存在是正常情况，不打扰日志。
        if (location.rank === 0) {
          logSkip(location.dir, error instanceof Error ? error.message : String(error));
        }
        continue;
      }

      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue;
        const parsed = parseCandidateName(entry.name, base);
        if (!parsed) continue;

        const fullPath = path.join(location.dir, entry.name);
        let handle: fsp.FileHandle | null = null;
        try {
          handle = await fsp.open(fullPath, "r");
          const stat = await handle.stat();
          if (!stat.isFile()) {
            logSkip(fullPath, "不是普通文件");
            continue;
          }
          if (stat.size === 0) {
            logSkip(fullPath, "零字节文件");
            continue;
          }
          if (parsed.format === "sub") {
            const sample = Buffer.alloc(4096);
            const read = await handle.read(sample, 0, sample.length, 0);
            if (sample.subarray(0, read.bytesRead).includes(0)) {
              logSkip(fullPath, "二进制 VobSub .sub");
              continue;
            }
          }
          result.push({
            path: fullPath,
            format: parsed.format,
            language: parsed.language,
            exact: parsed.exact,
            locationRank: location.rank
          });
        } catch (error) {
          logSkip(fullPath, error instanceof Error ? error.message : String(error));
        } finally {
          if (handle) await handle.close().catch(() => undefined);
        }
      }
    }
    subtitleCache.set(cacheKey, {
      expiresAt: Date.now() + SUBTITLE_CACHE_TTL_MS,
      candidates: result.map(cloneCandidate)
    });
    if (subtitleCache.size > SUBTITLE_CACHE_MAX) {
      const oldestKey = subtitleCache.keys().next().value;
      if (oldestKey) subtitleCache.delete(oldestKey);
    }
    return result;
  } catch (error) {
    logSkip(videoPath, error instanceof Error ? error.message : String(error));
    return [];
  }
}

function parseCandidateName(
  fileName: string,
  videoBase: string
): { format: SubtitleFormat; language: string | null; exact: boolean } | null {
  const extWithDot = path.extname(fileName).toLowerCase();
  const format = extWithDot.slice(1) as SubtitleFormat;
  if (!Object.prototype.hasOwnProperty.call(FORMAT_ORDER, format)) return null;
  const stem = fileName.slice(0, -extWithDot.length);
  const stemLower = stem.toLowerCase();
  const videoBaseLower = videoBase.toLowerCase();
  if (stemLower === videoBaseLower) return { format, language: null, exact: true };
  if (!stemLower.startsWith(videoBaseLower + ".")) return null;

  const suffix = stemLower.slice(videoBaseLower.length + 1);
  const parts = suffix.split(".");
  if (parts.length === 0 || !parts[0]) return null;
  const language = parts[0].toLowerCase();
  if (!LANGUAGE_TAGS.has(language)) return null;
  const modifiers = parts.slice(1).map((part) => part.toLowerCase());
  if (modifiers.some((part) => !MODIFIERS.has(part))) return null;
  return { format, language, exact: false };
}

/** 纯函数：按固定优先级从候选中选出一条字幕，不修改入参。 */
export function selectSubtitle(
  candidates: SubtitleCandidate[],
  preferredLanguages?: readonly string[]
): SubtitleCandidate | null {
  if (candidates.length === 0) return null;
  const preferred = (preferredLanguages ?? DEFAULT_PREFERRED_LANGUAGES).map((item) => item.trim().toLowerCase());

  const ranked = candidates.slice().sort((a, b) => {
    const groupA = a.exact ? (a.locationRank === 0 ? 0 : 1) : 2;
    const groupB = b.exact ? (b.locationRank === 0 ? 0 : 1) : 2;
    if (groupA !== groupB) return groupA - groupB;

    if (groupA === 2) {
      const languageA = languagePreferenceRank(a.language, preferred);
      const languageB = languagePreferenceRank(b.language, preferred);
      if (languageA !== languageB) return languageA - languageB;
    }

    const formatA = FORMAT_ORDER[a.format] ?? 99;
    const formatB = FORMAT_ORDER[b.format] ?? 99;
    if (formatA !== formatB) return formatA - formatB;
    return comparePaths(a, b);
  });

  return ranked[0] ?? null;
}

/** 字幕统一转 UTF-8：优先识别 BOM/严格 UTF-8，失败再按 GB18030（覆盖 GBK/GB2312）解码。 */
export function decodeSubtitleBuffer(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString("utf8");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(buffer.subarray(2));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder("gb18030").decode(buffer);
    } catch {
      return buffer.toString("utf8");
    }
  }
}

interface Cue {
  start: number;
  end: number;
  text: string;
}

function formatTimestamp(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  const two = (value: number) => String(value).padStart(2, "0");
  return two(hours) + ":" + two(minutes) + ":" + two(seconds) + "," + String(millis).padStart(3, "0");
}

function cleanCueLines(lines: string[]): string {
  const cleaned = lines.map((line) => line.replace(/\r/g, "").replace(/[ \t]+$/g, ""));
  while (cleaned.length > 0 && cleaned[0].trim() === "") cleaned.shift();
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === "") cleaned.pop();
  return cleaned.join("\n");
}

function buildSrt(cues: Cue[]): string {
  const valid = cues
    .map((cue, index) => ({ cue, index }))
    .filter(({ cue }) => Number.isFinite(cue.start) && Number.isFinite(cue.end) && cue.end > cue.start)
    .sort((a, b) => a.cue.start - b.cue.start || a.index - b.index);
  return (
    valid
      .map(
        ({ cue }, index) =>
          String(index + 1) + "\n" + formatTimestamp(cue.start) + " --> " + formatTimestamp(cue.end) + "\n" + cue.text
      )
      .join("\n\n") + (valid.length > 0 ? "\n" : "")
  );
}

function parseSrtTime(value: string): number | null {
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000 + Number(fraction.padEnd(3, "0"));
}

function parseSrt(input: string): string {
  const lines = toLf(input).split("\n");
  const cues: Cue[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && lines[index].trim() === "") index += 1;
    if (index >= lines.length) break;
    let timingLine = lines[index].trim();
    if (/^\d+$/.test(timingLine)) {
      index += 1;
      if (index >= lines.length) break;
      timingLine = lines[index].trim();
    }
    const parts = timingLine.split("-->");
    if (parts.length !== 2) {
      index += 1;
      continue;
    }
    const start = parseSrtTime(parts[0]);
    const end = parseSrtTime(parts[1].trim().split(/\s+/)[0] ?? "");
    index += 1;
    if (start === null || end === null) continue;
    const textLines: string[] = [];
    while (index < lines.length && lines[index].trim() !== "") {
      textLines.push(lines[index]);
      index += 1;
    }
    const text = cleanCueLines(textLines);
    if (text) cues.push({ start, end, text });
  }
  return buildSrt(cues);
}

function parseVttTime(value: string): number | null {
  const match = /^(?:(\d{1,3}):)?([0-5]\d):([0-5]\d)[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  return (
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    Number(fraction.padEnd(3, "0"))
  );
}

function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith("#")) {
      const hex = code[1]?.toLowerCase() === "x";
      const value = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(value)) {
        try {
          return String.fromCodePoint(value);
        } catch {
          return whole;
        }
      }
      return whole;
    }
    return named[code.toLowerCase()] ?? whole;
  });
}

function stripTextMarkup(input: string): string {
  return decodeHtmlEntities(input.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""));
}

function parseVtt(input: string): string {
  const lines = toLf(input).split("\n");
  const cues: Cue[] = [];
  let index = 0;
  if ((lines[0] ?? "").toUpperCase().startsWith("WEBVTT")) {
    index = 1;
    while (index < lines.length && lines[index].trim() !== "") index += 1;
  }
  while (index < lines.length) {
    while (index < lines.length && lines[index].trim() === "") index += 1;
    if (index >= lines.length) break;
    const block: string[] = [];
    while (index < lines.length && lines[index].trim() !== "") {
      block.push(lines[index]);
      index += 1;
    }
    if (block.length === 0) continue;
    const heading = block[0].trim().toUpperCase();
    if (heading.startsWith("NOTE") || heading === "STYLE" || heading === "REGION") continue;
    const timingIndex = block.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = block[timingIndex].trim().split(/\s+-->\s+/);
    if (timing.length !== 2) continue;
    const start = parseVttTime(timing[0]);
    const endToken = timing[1].trim().split(/\s+/)[0] ?? "";
    const end = parseVttTime(endToken);
    if (start === null || end === null) continue;
    const text = cleanCueLines(block.slice(timingIndex + 1).map((line) => stripTextMarkup(line)));
    if (text) cues.push({ start, end, text });
  }
  return buildSrt(cues);
}

function parseAssTime(value: string): number | null {
  const match = /^(\d+):([0-5]\d):([0-5]\d)[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000 + Number(fraction.padEnd(3, "0"));
}

function splitAssFields(payload: string, count: number): string[] {
  const values: string[] = [];
  let position = 0;
  for (let index = 0; index < count - 1; index += 1) {
    const comma = payload.indexOf(",", position);
    if (comma < 0) break;
    values.push(payload.slice(position, comma));
    position = comma + 1;
  }
  values.push(payload.slice(position));
  while (values.length < count) values.push("");
  return values;
}

function cleanAssText(value: string): string {
  return value
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ");
}

function parseAss(input: string): string {
  const lines = toLf(input).split("\n");
  const cues: Cue[] = [];
  let inEvents = false;
  let fields: string[] = ASS_DEFAULT_FIELDS;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[[^\]]+\]$/.test(trimmed)) {
      inEvents = trimmed.toLowerCase() === "[events]";
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(trimmed)) {
      const parsed = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((field) => field.trim().toLowerCase());
      if (parsed.length > 0) fields = parsed;
      continue;
    }
    if (!/^dialogue\s*:/i.test(trimmed)) continue;
    const payload = trimmed.slice(trimmed.indexOf(":") + 1).trimStart();
    const values = splitAssFields(payload, fields.length);
    const map: Record<string, string> = {};
    for (let index = 0; index < fields.length; index += 1) map[fields[index]] = values[index] ?? "";
    const start = parseAssTime(map.start ?? "");
    const end = parseAssTime(map.end ?? "");
    if (start === null || end === null) continue;
    const text = cleanCueLines(cleanAssText(map.text ?? "").split("\n"));
    if (text) cues.push({ start, end, text });
  }
  return buildSrt(cues);
}

function parseSyncStart(attributes: string): number | null {
  const match = /\bstart\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
  if (!match) return null;
  const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function extractSamiText(body: string): string {
  const entries: Array<{ className: string; text: string }> = [];
  // SAMI 的 <P> 经常没有闭合标签；按下一个 <P> 或块尾切分，避免把多个 Class 拼在一起。
  const paragraph = /<p\b([^>]*)>/gi;
  let match: RegExpExecArray | null = paragraph.exec(body);
  while (match) {
    const contentStart = paragraph.lastIndex;
    const rest = body.slice(contentStart);
    const nextMatch = /<p\b[^>]*>/i.exec(rest);
    const contentEnd = nextMatch ? contentStart + nextMatch.index : body.length;
    const raw = body.slice(contentStart, contentEnd).replace(/<\/p\s*>/gi, "");
    const classMatch = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    const className = (classMatch?.[1] ?? classMatch?.[2] ?? classMatch?.[3] ?? "").trim();
    const text = cleanCueLines(stripTextMarkup(raw).split("\n"));
    if (text) entries.push({ className, text });
    match = paragraph.exec(body);
  }
  if (entries.length === 0) return cleanCueLines(stripTextMarkup(body).split("\n"));
  const preferred = entries.find((entry) => /ZH|CN|CHS|CHT/i.test(entry.className));
  if (preferred) return preferred.text;
  return entries[0].text;
}

function parseSmi(input: string): string {
  const text = toLf(input);
  const syncPattern = /<sync\b([^>]*)>/gi;
  const matches: Array<{ index: number; length: number; attributes: string }> = [];
  let match: RegExpExecArray | null = syncPattern.exec(text);
  while (match) {
    matches.push({ index: match.index, length: match[0].length, attributes: match[1] });
    match = syncPattern.exec(text);
  }
  const cues: Cue[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = parseSyncStart(matches[index].attributes);
    if (start === null) continue;
    const bodyStart = matches[index].index + matches[index].length;
    const bodyEnd = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const body = text.slice(bodyStart, bodyEnd).replace(/<\/sync\s*>/gi, "");
    const cueText = extractSamiText(body);
    if (!cueText) continue;
    const nextStart = index + 1 < matches.length ? parseSyncStart(matches[index + 1].attributes) : null;
    const end = nextStart !== null && nextStart > start ? nextStart : start + 2000;
    if (end > start) cues.push({ start, end, text: cueText });
  }
  return buildSrt(cues);
}

function parseSubViewerTimePair(value: string): { start: number; end: number } | null {
  const match = /^(\d{1,2}):([0-5]\d):([0-5]\d)[.,](\d{1,3})\s*,\s*(\d{1,2}):([0-5]\d):([0-5]\d)[.,](\d{1,3})$/.exec(
    value.trim()
  );
  if (!match) return null;
  const toMs = (hours: string, minutes: string, seconds: string, fraction: string) =>
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number(seconds) * 1000 +
    Number(fraction.padEnd(3, "0"));
  return {
    start: toMs(match[1], match[2], match[3], match[4]),
    end: toMs(match[5], match[6], match[7], match[8])
  };
}

function parseSubViewer(input: string): string {
  const lines = toLf(input).split("\n");
  const cues: Cue[] = [];
  let index = 0;
  const subtitleStart = lines.findIndex((line) => /^\[subtitle\]$/i.test(line.trim()));
  if (subtitleStart >= 0) index = subtitleStart + 1;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (trimmed === "" || /^\[[^\]]+\]$/.test(trimmed)) {
      index += 1;
      continue;
    }
    const timing = parseSubViewerTimePair(trimmed);
    if (!timing) {
      index += 1;
      continue;
    }
    index += 1;
    const textLines: string[] = [];
    while (index < lines.length) {
      const line = lines[index].trim();
      if (line === "" || parseSubViewerTimePair(line)) break;
      textLines.push(lines[index]);
      index += 1;
    }
    const text = cleanCueLines(textLines);
    if (text && timing.end > timing.start) cues.push({ start: timing.start, end: timing.end, text });
  }
  return buildSrt(cues);
}

function parseMicroDvd(input: string): string {
  const lines = toLf(input).split("\n");
  let fps = 25;
  let hasFps = false;
  let index = 0;
  if (lines.length > 0) {
    const fpsMatch = /^\{1\}\{1\}\s*(\d+(?:\.\d+)?)\s*$/.exec(lines[0].trim());
    if (fpsMatch) {
      const value = Number(fpsMatch[1]);
      if (value > 0) fps = value;
      hasFps = true;
      index = 1;
    }
  }
  if (!hasFps) console.warn("[subtitles] MicroDVD 缺少 FPS，默认 25");
  const cues: Cue[] = [];
  for (; index < lines.length; index += 1) {
    const match = /^\{(\d+)\}\{(\d+)\}(.*)$/.exec(lines[index].trim());
    if (!match) continue;
    const start = Math.round((Number(match[1]) / fps) * 1000);
    const end = Math.round((Number(match[2]) / fps) * 1000);
    const text = cleanCueLines(match[3].replace(/\{[^}]*\}/g, "").replace(/\|/g, "\n").split("\n"));
    if (text && end > start) cues.push({ start, end, text });
  }
  return buildSrt(cues);
}

function parseSub(input: string): string {
  if (input.includes("\0")) return "";
  const normalized = toLf(input);
  if (/\{\d+\}\{\d+\}/.test(normalized)) return parseMicroDvd(normalized);
  const firstLine = normalized.split("\n").find((line) => line.trim() !== "") ?? "";
  if (/^\[subtitle\]$/im.test(normalized) || parseSubViewerTimePair(firstLine)) {
    return parseSubViewer(normalized);
  }
  return "";
}

/** 将任意受支持格式的字幕文本转换为 UTF-8 SRT；无法解析时返回空字符串。 */
export function subtitleToSrt(input: string, format: SubtitleFormat): string {
  try {
    switch (format) {
      case "srt":
        return parseSrt(input);
      case "vtt":
        return parseVtt(input);
      case "ass":
      case "ssa":
        return parseAss(input);
      case "smi":
        return parseSmi(input);
      case "sub":
        return parseSub(input);
      default:
        return "";
    }
  } catch (error) {
    console.warn("[subtitles] 解析 " + format + " 失败: " + (error instanceof Error ? error.message : String(error)));
    return "";
  }
}
