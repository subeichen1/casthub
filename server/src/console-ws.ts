// 控制台↔中枢 WS 通道（9420，路径 /console）
import * as fs from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { DlnaService } from "./dlna";
import type { DeviceManager } from "./devices";
import { mimeTypeOf, resolveWithinReal } from "./files";
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

export interface ConsoleWsOptions {
  consoleToken: string;
  publicBaseUrl: string;
  mediaSigningKey: Buffer;
  history: HistoryRecorder;
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
  options: ConsoleWsOptions
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

  const handleTvStatus = (deviceId: string, status: TvStatusPayload): void => {
    const update = options.history.record(deviceId, status);
    if (update) broadcastHistory();
    broadcast({ type: "tvStatus", deviceId, ...status });
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

  devices.onDevicesChanged = broadcastDevices;
  devices.onTvStatus = (deviceId, status) => handleTvStatus(deviceId, status);
  devices.onDeviceError = (deviceId, message) => handleDeviceError(deviceId, message);
  dlna.onDevicesChanged = broadcastDevices;
  dlna.onTvStatus = (deviceId, status) => handleTvStatus(deviceId, status);
  dlna.onDeviceError = (deviceId, message) => handleDeviceError(deviceId, message);

  wss.on("connection", (ws, req) => {
    if (wss.clients.size > MAX_CONNECTIONS) {
      ws.close(1013, "too many connections");
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
    if (!originAllowed(req.headers.origin, req.headers.host, options.publicBaseUrl)) {
      ws.close(1008, "bad origin");
      return;
    }

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
          case "cast": {
            const deviceId = String(msg.deviceId ?? "");
            const relPath = String(msg.path ?? "");
            const target = await resolveWithinReal(mediaRoot, relPath);
            if (!target) {
              sendJson(ws, { type: "error", message: "路径非法" });
              return;
            }
            let stat: fs.Stats;
            try {
              stat = await fs.promises.stat(target);
            } catch {
              sendJson(ws, { type: "error", message: "文件不存在" });
              return;
            }
            if (!stat.isFile()) {
              sendJson(ws, { type: "error", message: "只能投屏文件" });
              return;
            }
            const realRoot = await fs.promises.realpath(mediaRoot);
            const actualRelPath = path.relative(realRoot, target).replace(/\\/g, "/");
            const expires = Date.now() + MEDIA_URL_TTL_MS;
            const signature = signMediaPath(options.mediaSigningKey, actualRelPath, expires);
            const encodedPath = actualRelPath.split("/").map((part) => encodeURIComponent(part)).join("/");
            const url = `${options.publicBaseUrl}/media/${encodedPath}?expires=${expires}&sig=${encodeURIComponent(signature)}`;
            const title = path.basename(target);
            const mimeType = mimeTypeOf(target);
            const resume = msg.resume !== false;
            const resumePositionMs = resume ? validResumePosition(options.history.get(target)) : null;
            if (devices.has(deviceId)) {
              options.history.startPlayback(deviceId, { path: target, name: title });
              const ok = devices.sendPlay(deviceId, url, title, mimeType);
              if (!ok) {
                options.history.stopPlayback(deviceId);
                sendJson(ws, { type: "error", message: "设备不在线，无法投屏" });
                return;
              }
              if (resumePositionMs !== null) {
                // casthub 设备沿用既有 seek：等设备上报 playing 后立刻定位。
                pendingSeeks.set(deviceId, resumePositionMs);
              } else {
                pendingSeeks.delete(deviceId);
              }
            } else if (dlna.has(deviceId)) {
              options.history.startPlayback(deviceId, { path: target, name: title });
              try {
                await dlna.play(deviceId, url, title, mimeType, resumePositionMs);
              } catch (error) {
                options.history.stopPlayback(deviceId);
                throw error;
              }
            } else {
              sendJson(ws, { type: "error", message: "设备不存在" });
              return;
            }
            console.log(
              `[console] 投屏 ${actualRelPath} -> ${deviceId}${resumePositionMs !== null ? `（续播 ${resumePositionMs}ms）` : ""}`
            );
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
                  value
                );
                if (!ok) {
                  sendJson(ws, {
                    type: "error",
                    message: action === "volume" ? "音量控制失败（设备可能不支持）" : "设备不在线或参数错误"
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
          default:
            sendJson(ws, { type: "error", message: `未知消息类型: ${String(msg.type)}` });
        }
      } catch (error) {
        console.error("[console-ws] 处理消息失败:", error);
        sendJson(ws, { type: "error", message: "操作失败" });
      }
    });

    ws.on("close", () => authorized.delete(ws));
    ws.on("error", (error) => {
      console.error("[console-ws] 客户端错误:", error.message);
    });
  });

  return wss;
}
