// 控制台↔中枢 WS 通道（9420，路径 /console）
import * as fs from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { DlnaService } from "./dlna";
import type { DeviceManager } from "./devices";
import {
  buildEmbeddedMediaUrl,
  buildEmbeddedSubtitleUrl,
  buildSubtitleUrl,
  mimeTypeOf,
  resolveWithin,
  resolveWithinReal,
} from "./files";
import {
  createSubtitleStrippedVideo,
  detectEmbeddedSubtitleTools,
  extractEmbeddedSubtitleToSrt,
  probeEmbeddedSubtitles,
  selectEmbeddedSubtitleTrack,
} from "./embedded-subtitles";
import { findSubtitleCandidates, selectSubtitle } from "./subtitles";
import { PlayQueue } from "./play-queue";
import type { TvDesktopService } from "./tv-desktop";
import { type HistoryRecorder, validResumePosition } from "./history";
import { MEDIA_URL_TTL_MS, safeTokenEquals, signMediaPath } from "./security";
import type { TvStatusPayload } from "./types";

type ConsolePayload = Record<string, unknown>;

const DLNA_MANUAL_ERROR = "DLNA 设备为自动发现，不支持手动增删";
const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_WINDOW = 120;
const MESSAGE_WINDOW_MS = 10_000;
const MAX_AUTH_FAILURES = 10;
const AUTH_BLOCK_MS = 60_000;
const MAX_CONNECTIONS = 32;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_AUTH_TRACKED_IPS = 1024;

/** 可直接展示给控制台的业务错误（区别于内部异常）。 */
class ConsoleActionError extends Error {}

export type SubtitleMode = "auto" | "server" | "off";

export interface ConsoleWsOptions {
  consoleToken: string;
  publicBaseUrl: string;
  mediaSigningKey: Buffer;
  history: HistoryRecorder;
  /** 内嵌字幕抽取与去字幕副本缓存目录。 */
  embeddedCacheDir: string;
  /** 电视助手（Aerial 一键安装/还原）；缺省时不提供该功能。 */
  tvDesktop?: TvDesktopService;
}

function resolveSubtitleMode(msg: ConsolePayload): SubtitleMode | null {
  const raw = msg.subtitleMode;
  if (raw !== undefined) {
    if (raw === "auto" || raw === "server" || raw === "off") return raw;
    return null;
  }
  return msg.subtitles === false ? "off" : "auto";
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function rawDataLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + part.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.length;
}

function clientIp(req: { socket: { remoteAddress?: string | undefined } }): string {
  return req.socket.remoteAddress ?? "unknown";
}

function originAllowed(origin: string | undefined, reqHost: string | undefined, publicBaseUrl: string): boolean {
  // 非浏览器客户端通常不发送 Origin；浏览器连接必须校验，防止任意网页连本机 WS。
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (reqHost && parsed.host.toLowerCase() === reqHost.toLowerCase()) return true;
    if (publicBaseUrl && parsed.origin.toLowerCase() === publicBaseUrl.toLowerCase()) return true;
    return false;
  } catch {
    return false;
  }
}

export function attachConsoleWs(
  app: FastifyInstance,
  devices: DeviceManager,
  mediaRoot: string,
  dlna: DlnaService,
  options: ConsoleWsOptions,
): WebSocketServer {
  const wss = new WebSocketServer({
    server: app.server,
    path: "/console",
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });

  const authorized = new Set<WebSocket>();
  const authFailures = new Map<string, { count: number; blockedUntil: number }>();

  const pruneAuthFailures = (now: number): void => {
    for (const [ip, failure] of authFailures) {
      if (failure.blockedUntil !== 0 && failure.blockedUntil <= now) authFailures.delete(ip);
    }
    if (authFailures.size > MAX_AUTH_TRACKED_IPS) authFailures.clear();
  };

  const broadcast = (payload: unknown): void => {
    const text = JSON.stringify(payload);
    for (const client of authorized) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  };

  const allDevices = () => [...devices.list(), ...dlna.list()];
  const broadcastDevices = (): void => broadcast({ type: "devices", list: allDevices() });
  const broadcastHistory = (): void => broadcast({ type: "history", list: options.history.list(200) });
  const pendingSeeks = new Map<string, number>();

  interface DlnaSubtitlePlan {
    mediaUrl: string;
    subtitleUrl: string | null;
    warning?: string;
  }

  const externalSubtitleUrl = async (target: string, realRoot: string): Promise<string | null> => {
    try {
      const candidates = await findSubtitleCandidates(target, { refresh: true });
      const selected = selectSubtitle(candidates);
      return selected
        ? buildSubtitleUrl(options.publicBaseUrl, realRoot, selected.path, options.mediaSigningKey)
        : null;
    } catch (error) {
      // 字幕不可用不阻断视频投屏。
      console.error(`[console] 字幕选择失败: ${(error as Error).message}`);
      return null;
    }
  };

  const withSubtitleFlag = (mediaUrl: string, disabled: boolean): string => {
    if (!disabled) return mediaUrl;
    // 旧 subtitles=false 路径已在媒体 URL 上带过一次标记，避免重复参数被解析成数组。
    return /[?&]subtitles=0(?:&|$)/.test(mediaUrl) ? mediaUrl : `${mediaUrl}&subtitles=0`;
  };

  const prepareDlnaSubtitlePlan = async (
    target: string,
    mode: SubtitleMode,
    requestedStreamIndex: number | undefined,
    mediaUrl: string,
    realRoot: string,
  ): Promise<DlnaSubtitlePlan> => {
    if (mode === "off") {
      return { mediaUrl: withSubtitleFlag(mediaUrl, true), subtitleUrl: null };
    }
    if (mode === "auto") {
      const probe = await probeEmbeddedSubtitles(target);
      if (!probe.available) {
        // ffmpeg/ffprobe 缺失只影响“内嵌字幕探测”，不应连带禁用已有的外挂字幕。
        const external = await externalSubtitleUrl(target, realRoot);
        if (external) return { mediaUrl, subtitleUrl: external };
        return {
          mediaUrl: withSubtitleFlag(mediaUrl, true),
          subtitleUrl: null,
          warning: "无法检测内嵌字幕，请安装 ffmpeg/ffprobe，或改用服务器字幕模式",
        };
      }
      if (probe.tracks.length > 0) {
        return { mediaUrl: withSubtitleFlag(mediaUrl, true), subtitleUrl: null };
      }
      return { mediaUrl, subtitleUrl: await externalSubtitleUrl(target, realRoot) };
    }

    const probe = await probeEmbeddedSubtitles(target);
    if (!probe.available) {
      throw new Error("无法检测内嵌字幕，请安装 ffmpeg/ffprobe，或改用服务器字幕模式");
    }
    const textTracks = probe.tracks.filter((track) => track.kind === "text");
    if (textTracks.length === 0) {
      if (probe.tracks.some((track) => track.kind === "bitmap")) {
        throw new Error("内嵌字幕为图片字幕，当前版本不支持服务器字幕模式");
      }
      return { mediaUrl, subtitleUrl: await externalSubtitleUrl(target, realRoot) };
    }

    const tools = await detectEmbeddedSubtitleTools();
    if (!tools.ffprobe) throw new Error("无法检测内嵌字幕：ffprobe 不可用，服务器字幕模式需要 ffmpeg/ffprobe");
    if (!tools.ffmpeg) throw new Error("服务器字幕模式需要 ffmpeg，当前不可用");
    const selected = await selectEmbeddedSubtitleTrack(probe.tracks, { requestedStreamIndex });
    if (!selected) throw new Error("指定的字幕轨不存在或不是文本字幕");

    let extracted: Awaited<ReturnType<typeof extractEmbeddedSubtitleToSrt>>;
    try {
      extracted = await extractEmbeddedSubtitleToSrt(target, selected, { cacheDir: options.embeddedCacheDir });
    } catch (error) {
      throw new Error(`抽取内嵌字幕失败: ${(error as Error).message}`);
    }
    let stripped: Awaited<ReturnType<typeof createSubtitleStrippedVideo>>;
    try {
      stripped = await createSubtitleStrippedVideo(target, {
        cacheDir: options.embeddedCacheDir,
      });
    } catch (error) {
      throw new Error(`生成去字幕副本失败: ${(error as Error).message}`);
    }
    return {
      mediaUrl: buildEmbeddedMediaUrl(
        options.publicBaseUrl,
        options.embeddedCacheDir,
        stripped.videoPath,
        options.mediaSigningKey,
        extracted.srtPath,
      ),
      subtitleUrl: buildEmbeddedSubtitleUrl(
        options.publicBaseUrl,
        options.embeddedCacheDir,
        extracted.srtPath,
        options.mediaSigningKey,
      ),
    };
  };

  interface CastToDeviceOptions {
    resume?: boolean;
    subtitleMode?: SubtitleMode;
    subtitleTrack?: number;
    notify?: (message: string) => void;
  }

  interface CastToDeviceResult {
    target: string;
    actualRelPath: string;
    resumePositionMs: number | null;
  }

  /** 单文件投屏的共用实现：普通 cast 与队列自动切集都走这里，保持字幕/历史行为一致。 */
  const castToDevice = async (
    deviceId: string,
    relPath: string,
    castOptions: CastToDeviceOptions = {},
  ): Promise<CastToDeviceResult> => {
    const target = await resolveWithinReal(mediaRoot, relPath);
    if (!target) throw new ConsoleActionError("路径非法");
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(target);
    } catch {
      throw new ConsoleActionError("文件不存在");
    }
    if (!stat.isFile()) throw new ConsoleActionError("只能投屏文件");
    const realRoot = await fs.promises.realpath(mediaRoot);
    const actualRelPath = path.relative(realRoot, target).replace(/\\/g, "/");
    const expires = Date.now() + MEDIA_URL_TTL_MS;
    const signature = signMediaPath(options.mediaSigningKey, actualRelPath, expires);
    const encodedPath = actualRelPath
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const subtitleMode = castOptions.subtitleMode ?? "auto";
    const subtitles = subtitleMode !== "off";
    // subtitles=false 时把标记带到 /media，让 GET/HEAD 也不返回 CaptionInfo.sec。
    const subtitleQuery = subtitles ? "" : "&subtitles=0";
    const url = `${options.publicBaseUrl}/media/${encodedPath}?expires=${expires}&sig=${encodeURIComponent(signature)}${subtitleQuery}`;
    const title = path.basename(target);
    const mimeType = mimeTypeOf(target);
    const resume = castOptions.resume !== false;
    const resumePositionMs = resume ? validResumePosition(options.history.get(target)) : null;
    if (devices.has(deviceId)) {
      options.history.startPlayback(deviceId, { path: target, name: title });
      const ok = devices.sendPlay(deviceId, url, title, mimeType);
      if (!ok) {
        options.history.stopPlayback(deviceId);
        throw new ConsoleActionError("设备不在线，无法投屏");
      }
      if (resumePositionMs !== null) {
        // casthub 设备沿用既有 seek：等设备上报 playing 后立刻定位。
        pendingSeeks.set(deviceId, resumePositionMs);
      } else {
        pendingSeeks.delete(deviceId);
      }
    } else if (dlna.has(deviceId)) {
      let subtitleTrack = castOptions.subtitleTrack;
      if (subtitleTrack !== undefined) {
        if (!Number.isInteger(subtitleTrack) || subtitleTrack < 0) {
          throw new ConsoleActionError("字幕轨索引非法");
        }
      }
      let plan: DlnaSubtitlePlan;
      try {
        plan = await prepareDlnaSubtitlePlan(target, subtitleMode, subtitleTrack, url, realRoot);
      } catch (error) {
        throw new ConsoleActionError((error as Error).message);
      }
      options.history.startPlayback(deviceId, { path: target, name: title });
      try {
        await dlna.play(deviceId, plan.mediaUrl, title, mimeType, resumePositionMs, plan.subtitleUrl);
      } catch (error) {
        options.history.stopPlayback(deviceId);
        throw error;
      }
      if (plan.warning) castOptions.notify?.(plan.warning);
    } else {
      throw new ConsoleActionError("设备不存在");
    }
    return { target, actualRelPath, resumePositionMs };
  };

  const parseQueueAutoNextDelay = (): number | undefined => {
    const raw = process.env.DLNA_AUTO_NEXT_DELAY_MS;
    if (raw === undefined || raw.trim() === "") return undefined;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  };

  const playQueue = new PlayQueue({
    autoNextDelayMs: parseQueueAutoNextDelay(),
    playItem: async (deviceId, item, context) => {
      await castToDevice(deviceId, item.path, {
        resume: context.resume,
        // 队列复用单文件投屏的字幕准备流程；auto 模式检测工具不可用等提示仍要浮到控制台。
        notify: (message) => broadcast({ type: "error", message }),
      });
      console.log(`[queue] 播放 ${item.name} -> ${deviceId}${context.auto ? "（自动连播）" : ""}`);
    },
    stopPlayback: async (deviceId) => {
      await dlna.control(deviceId, "stop");
    },
    broadcast: (view) => broadcast({ type: "queue", deviceId: view.deviceId, queue: view }),
    onError: (_deviceId, message) => broadcast({ type: "error", message }),
  });

  /** 队列加入前校验：路径必须位于媒体库内、是存在的视频文件。 */
  const resolveQueueVideo = async (relPath: string): Promise<{ path: string; name: string }> => {
    const lexical = resolveWithin(mediaRoot, relPath);
    if (!lexical) throw new ConsoleActionError("路径非法");
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(lexical);
    } catch {
      throw new ConsoleActionError("文件不存在");
    }
    const target = await resolveWithinReal(mediaRoot, relPath);
    if (!target) throw new ConsoleActionError("路径非法");
    if (!stat.isFile()) throw new ConsoleActionError("只能把视频加入队列");
    if (!mimeTypeOf(target).startsWith("video/")) throw new ConsoleActionError("只能把视频加入队列");
    const realRoot = await fs.promises.realpath(mediaRoot);
    const actualRelPath = path.relative(realRoot, target).replace(/\\/g, "/");
    if (!actualRelPath || actualRelPath.startsWith("../")) throw new ConsoleActionError("路径非法");
    return { path: actualRelPath, name: path.basename(target) };
  };

  const handleTvStatus = (deviceId: string, status: TvStatusPayload): void => {
    const update = options.history.record(deviceId, status);
    if (update) broadcastHistory();
    broadcast({ type: "tvStatus", deviceId, ...status });
    playQueue.handleTvStatus(deviceId, status);
    if (status.state === "playing") {
      const seekPositionMs = pendingSeeks.get(deviceId);
      if (seekPositionMs !== undefined) {
        pendingSeeks.delete(deviceId);
        devices.control(deviceId, "seek", seekPositionMs);
      }
    }
  };

  const handleDeviceError = (deviceId: string, message: string): void => {
    if (options.history.clearForDevice(deviceId)) broadcastHistory();
    broadcast({ type: "error", message });
  };

  const cleanupDeviceState = (deviceId: string): void => {
    pendingSeeks.delete(deviceId);
    options.history.forgetDevice(deviceId);
    void playQueue.clear(deviceId, { stopPlayback: false }).catch((error: unknown) => {
      console.warn(`[console] 清理设备队列失败 ${deviceId}: ${(error as Error).message}`);
    });
  };

  devices.onDevicesChanged = broadcastDevices;
  devices.onTvStatus = (deviceId, status) => handleTvStatus(deviceId, status);
  devices.onDeviceError = (deviceId, message) => handleDeviceError(deviceId, message);
  dlna.onDevicesChanged = broadcastDevices;
  dlna.onTvStatus = (deviceId, status) => handleTvStatus(deviceId, status);
  dlna.onDeviceError = (deviceId, message) => handleDeviceError(deviceId, message);
  dlna.onDeviceRemoved = cleanupDeviceState;
  dlna.onPlaybackEnded = (deviceId) => playQueue.handlePlaybackEnded(deviceId);

  wss.on("connection", (ws, req) => {
    if (wss.clients.size > MAX_CONNECTIONS) {
      ws.close(1013, "too many connections");
      return;
    }
    // 先校验 Origin：恶意网页不能用错误令牌反复连接，把同 IP 的正常控制台锁死。
    if (!originAllowed(req.headers.origin, req.headers.host, options.publicBaseUrl)) {
      ws.close(1008, "bad origin");
      return;
    }
    const ip = clientIp(req as { socket: { remoteAddress?: string } });
    const now = Date.now();
    pruneAuthFailures(now);
    const failure = authFailures.get(ip);
    if (failure && failure.blockedUntil > now) {
      ws.close(1008, "unauthorized");
      return;
    }

    const requestUrl = new URL(req.url ?? "/console", "http://localhost");
    const token = requestUrl.searchParams.get("token") ?? String(req.headers["x-casthub-token"] ?? "");
    if (!safeTokenEquals(options.consoleToken, token)) {
      const next = { count: (failure?.count ?? 0) + 1, blockedUntil: 0 };
      if (next.count >= MAX_AUTH_FAILURES) next.blockedUntil = now + AUTH_BLOCK_MS;
      authFailures.set(ip, next);
      ws.close(1008, "unauthorized");
      return;
    }
    authFailures.delete(ip);

    authorized.add(ws);
    let messageWindowStart = Date.now();
    let messageCount = 0;
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, HEARTBEAT_INTERVAL_MS);
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("close", () => clearInterval(heartbeat));

    sendJson(ws, { type: "devices", list: allDevices() });
    sendJson(ws, { type: "history", list: options.history.list(200) });
    for (const view of playQueue.list()) sendJson(ws, { type: "queue", deviceId: view.deviceId, queue: view });

    ws.on("message", async (data) => {
      if (rawDataLength(data) > MAX_MESSAGE_BYTES) {
        sendJson(ws, { type: "error", message: "消息过大" });
        return;
      }
      const current = Date.now();
      if (current - messageWindowStart > MESSAGE_WINDOW_MS) {
        messageWindowStart = current;
        messageCount = 0;
      }
      messageCount += 1;
      if (messageCount > MAX_MESSAGES_PER_WINDOW) {
        sendJson(ws, { type: "error", message: "消息过于频繁" });
        ws.close(1008, "rate limited");
        return;
      }

      let msg: ConsolePayload;
      try {
        const parsed = JSON.parse(data.toString());
        if (!parsed || typeof parsed !== "object") throw new Error("not object");
        msg = parsed as ConsolePayload;
      } catch {
        sendJson(ws, { type: "error", message: "非法 JSON 消息" });
        return;
      }

      try {
        switch (msg.type) {
          case "addDevice": {
            const address = String(msg.address ?? "");
            if (dlna.findByAddress(address)) {
              sendJson(ws, { type: "error", message: DLNA_MANUAL_ERROR });
              break;
            }
            let device: ReturnType<DeviceManager["add"]>;
            try {
              device = devices.add(address, String(msg.token ?? ""));
            } catch (error) {
              sendJson(ws, { type: "error", message: (error as Error).message });
              break;
            }
            broadcastDevices();
            console.log(`[console] 添加设备 ${device.address} (${device.id})`);
            break;
          }
          case "removeDevice": {
            const id = String(msg.id ?? "");
            if (dlna.has(id)) {
              sendJson(ws, { type: "error", message: DLNA_MANUAL_ERROR });
              break;
            }
            devices.remove(id);
            cleanupDeviceState(id);
            broadcastDevices();
            break;
          }
          case "refreshDevices": {
            await dlna.discover();
            broadcastDevices();
            break;
          }
          case "getHistory": {
            sendJson(ws, { type: "history", list: options.history.list(200) });
            break;
          }
          case "deleteHistory": {
            const filePath = String(msg.path ?? "");
            if (!filePath) {
              sendJson(ws, { type: "error", message: "缺少历史路径" });
              break;
            }
            options.history.remove(filePath);
            broadcastHistory();
            break;
          }
          case "clearHistory": {
            const removed = options.history.clear();
            broadcastHistory();
            console.log(`[console] 清空播放历史 ${removed} 条`);
            break;
          }
          case "queueAdd": {
            const deviceId = String(msg.deviceId ?? "");
            if (!dlna.has(deviceId)) {
              sendJson(ws, {
                type: "error",
                message: devices.has(deviceId) ? "队列功能暂只支持 DLNA" : "设备不存在",
              });
              break;
            }
            try {
              const item = await resolveQueueVideo(String(msg.path ?? ""));
              const before = playQueue.get(deviceId);
              const wasEmpty = !before || before.items.length === 0;
              playQueue.add(deviceId, item);
              const current = playQueue.get(deviceId);
              if (wasEmpty && current && current.state === "idle" && current.currentIndex === -1) {
                await playQueue.play(deviceId);
              }
            } catch (error) {
              sendJson(ws, { type: "error", message: (error as Error).message });
            }
            break;
          }
          case "queuePlay": {
            const deviceId = String(msg.deviceId ?? "");
            if (!dlna.has(deviceId)) {
              sendJson(ws, {
                type: "error",
                message: devices.has(deviceId) ? "队列功能暂只支持 DLNA" : "设备不存在",
              });
              break;
            }
            try {
              await playQueue.play(deviceId);
            } catch (error) {
              sendJson(ws, { type: "error", message: (error as Error).message });
            }
            break;
          }
          case "queueRemove": {
            const deviceId = String(msg.deviceId ?? "");
            if (!dlna.has(deviceId)) {
              sendJson(ws, {
                type: "error",
                message: devices.has(deviceId) ? "队列功能暂只支持 DLNA" : "设备不存在",
              });
              break;
            }
            try {
              playQueue.remove(deviceId, Number(msg.index));
            } catch (error) {
              sendJson(ws, { type: "error", message: (error as Error).message });
            }
            break;
          }
          case "queueClear": {
            const deviceId = String(msg.deviceId ?? "");
            if (!dlna.has(deviceId)) {
              sendJson(ws, {
                type: "error",
                message: devices.has(deviceId) ? "队列功能暂只支持 DLNA" : "设备不存在",
              });
              break;
            }
            await playQueue.clear(deviceId, { stopPlayback: true });
            break;
          }
          case "cast": {
            const deviceId = String(msg.deviceId ?? "");
            const relPath = String(msg.path ?? "");
            // 普通“投屏/从头”是单文件操作：先清空该 DLNA 设备的旧队列，避免后台继续跳。
            // 清空前先做轻量预检，路径非法/文件不存在时不能丢掉用户已有队列。
            if (dlna.has(deviceId) && (playQueue.get(deviceId)?.items.length ?? 0) > 0) {
              const preflight = await resolveWithinReal(mediaRoot, relPath);
              let preflightStat: fs.Stats | null = null;
              if (preflight) {
                try {
                  preflightStat = await fs.promises.stat(preflight);
                } catch {
                  preflightStat = null;
                }
              }
              if (!preflight || !preflightStat || !preflightStat.isFile()) {
                sendJson(ws, { type: "error", message: !preflight ? "路径非法" : "文件不存在" });
                break;
              }
              await playQueue.clear(deviceId, { stopPlayback: false });
            }
            let subtitleMode: SubtitleMode | undefined;
            let subtitleTrack: number | undefined;
            if (!devices.has(deviceId)) {
              const mode = resolveSubtitleMode(msg);
              if (!mode) {
                sendJson(ws, { type: "error", message: "未知字幕模式" });
                break;
              }
              subtitleMode = mode;
              if (msg.subtitleTrack !== undefined) {
                const parsed = Number(msg.subtitleTrack);
                if (!Number.isInteger(parsed) || parsed < 0) {
                  sendJson(ws, { type: "error", message: "字幕轨索引非法" });
                  break;
                }
                subtitleTrack = parsed;
              }
            }
            try {
              const result = await castToDevice(deviceId, relPath, {
                resume: msg.resume !== false,
                ...(subtitleMode ? { subtitleMode } : {}),
                ...(subtitleTrack !== undefined ? { subtitleTrack } : {}),
                notify: (message) => sendJson(ws, { type: "error", message }),
              });
              console.log(
                `[console] 投屏 ${result.actualRelPath} -> ${deviceId}${result.resumePositionMs !== null ? `（续播 ${result.resumePositionMs}ms）` : ""}`,
              );
            } catch (error) {
              if (error instanceof ConsoleActionError) {
                sendJson(ws, { type: "error", message: error.message });
                break;
              }
              throw error;
            }
            break;
          }
          case "control": {
            const deviceId = String(msg.deviceId ?? "");
            const action = String(msg.action ?? "");
            if (!["pause", "resume", "stop", "seek", "volume"].includes(action)) {
              sendJson(ws, { type: "error", message: `未知控制指令: ${action}` });
              return;
            }
            const positionMs = msg.positionMs === undefined ? undefined : Number(msg.positionMs);
            const value = msg.value === undefined ? undefined : Number(msg.value);
            // 手动停止不得触发自动下一项；直到下一次显式 play/queuePlay 才恢复。
            if (action === "stop") playQueue.suppressAutoNext(deviceId);
            if (devices.has(deviceId)) {
              if (action === "volume") {
                sendJson(ws, { type: "error", message: "casthub 设备不支持音量控制" });
                break;
              }
              const ok = devices.control(deviceId, action as "pause" | "resume" | "stop" | "seek", positionMs);
              if (!ok) sendJson(ws, { type: "error", message: "设备不在线或参数错误" });
            } else if (dlna.has(deviceId)) {
              try {
                const ok = await dlna.control(
                  deviceId,
                  action as "pause" | "resume" | "stop" | "seek" | "volume",
                  positionMs,
                  value,
                );
                if (!ok) {
                  sendJson(ws, {
                    type: "error",
                    message: action === "volume" ? "音量控制失败（设备可能不支持）" : "设备不在线或参数错误",
                  });
                }
              } catch (error) {
                if (action !== "volume") throw error;
                console.error("[console-ws] 音量控制失败:", error);
                sendJson(ws, { type: "error", message: "音量控制失败（设备可能不支持）" });
              }
            } else {
              sendJson(ws, { type: "error", message: "设备不存在" });
            }
            break;
          }
          case "getDesktopInfo": {
            if (!options.tvDesktop) {
              sendJson(ws, { type: "error", message: "电视助手不可用" });
              break;
            }
            try {
              const info = await options.tvDesktop.info(allDevices(), {
                force: msg.force === true,
                deviceId: msg.deviceId === undefined ? undefined : String(msg.deviceId),
                appId: msg.appId === undefined ? undefined : String(msg.appId),
                variantId: msg.variantId === undefined ? undefined : String(msg.variantId)
              });
              sendJson(ws, { type: "desktopInfo", ...info });
            } catch (error) {
              sendJson(ws, { type: "error", message: "读取电视助手信息失败: " + (error as Error).message });
            }
            break;
          }
          case "installDesktop": {
            if (!options.tvDesktop) {
              sendJson(ws, { type: "error", message: "电视助手不可用" });
              break;
            }
            const deviceId = String(msg.deviceId ?? "");
            const apkUrl = msg.apkUrl === undefined ? undefined : String(msg.apkUrl);
            try {
              const result = await options.tvDesktop.install(allDevices(), deviceId, {
                apkUrl,
                allowUnverified: msg.allowUnverified === true,
                appId: msg.appId === undefined ? undefined : String(msg.appId),
                variantId: msg.variantId === undefined ? undefined : String(msg.variantId),
                onProgress: (percent) => {
                  sendJson(ws, { type: "desktopProgress", action: "install", percent });
                }
              });
              sendJson(ws, { type: "desktopResult", ...result });
              console.log(`[console] 电视助手安装 ${result.ok ? "成功" : "失败"}: ${result.message}`);
            } catch (error) {
              sendJson(ws, { type: "error", message: (error as Error).message });
            }
            break;
          }
          case "uninstallDesktop": {
            if (!options.tvDesktop) {
              sendJson(ws, { type: "error", message: "电视助手不可用" });
              break;
            }
            const deviceId = String(msg.deviceId ?? "");
            try {
              const result = await options.tvDesktop.uninstall(allDevices(), deviceId, {
                appId: msg.appId === undefined ? undefined : String(msg.appId),
                variantId: msg.variantId === undefined ? undefined : String(msg.variantId)
              });
              sendJson(ws, { type: "desktopResult", ...result });
              console.log(`[console] 电视助手还原 ${result.ok ? "成功" : "失败"}: ${result.message}`);
            } catch (error) {
              sendJson(ws, { type: "error", message: (error as Error).message });
            }
            break;
          }
          default:
            sendJson(ws, { type: "error", message: `未知消息类型: ${String(msg.type)}` });
        }
      } catch (error) {
        if (error instanceof ConsoleActionError) {
          sendJson(ws, { type: "error", message: error.message });
        } else {
          console.error("[console-ws] 处理消息失败:", error);
          sendJson(ws, { type: "error", message: "操作失败" });
        }
      }
    });

    ws.on("close", () => authorized.delete(ws));
    ws.on("error", (error) => {
      console.error("[console-ws] 客户端错误:", error.message);
    });
  });

  return wss;
}
