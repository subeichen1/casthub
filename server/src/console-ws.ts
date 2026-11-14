// 控制台↔中枢 WS 通道（9420，路径 /console）
import * as fs from "node:fs";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { WebSocketServer, WebSocket } from "ws";
import type { DeviceManager } from "./devices";
import { mimeTypeOf, resolveWithin } from "./files";

type ConsolePayload = Record<string, unknown>;

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

export function attachConsoleWs(app: FastifyInstance, devices: DeviceManager, mediaRoot: string): WebSocketServer {
  const wss = new WebSocketServer({ server: app.server, path: "/console" });

  const broadcast = (payload: unknown): void => {
    const text = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  };

  devices.onDevicesChanged = () => broadcast({ type: "devices", list: devices.list() });
  devices.onTvStatus = (deviceId, status) => broadcast({ type: "tvStatus", deviceId, ...status });
  devices.onDeviceError = (_deviceId, message) => broadcast({ type: "error", message });

  wss.on("connection", (ws, req) => {
    const host = req.headers.host || "127.0.0.1:9420";
    const override = (process.env.PUBLIC_BASE_URL ?? "").trim();
    const baseUrl = (override || `http://${host}`).replace(/\/$/, "");

    sendJson(ws, { type: "devices", list: devices.list() });

    ws.on("message", async (data) => {
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
            const device = devices.add(String(msg.address ?? ""), String(msg.token ?? ""));
            sendJson(ws, { type: "devices", list: devices.list() });
            console.log(`[console] 添加设备 ${device.address} (${device.id})`);
            break;
          }
          case "removeDevice": {
            devices.remove(String(msg.id ?? ""));
            sendJson(ws, { type: "devices", list: devices.list() });
            break;
          }
          case "cast": {
            const deviceId = String(msg.deviceId ?? "");
            const relPath = String(msg.path ?? "");
            const target = resolveWithin(mediaRoot, relPath);
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
            const encodedPath = relPath.split("/").map((part) => encodeURIComponent(part)).join("/");
            const url = `${baseUrl}/media/${encodedPath}`;
            const ok = devices.sendPlay(deviceId, url, path.basename(target), mimeTypeOf(target));
            if (!ok) {
              sendJson(ws, { type: "error", message: "设备不在线，无法投屏" });
              return;
            }
            console.log(`[console] 投屏 ${relPath} -> ${deviceId}: ${url}`);
            break;
          }
          case "control": {
            const deviceId = String(msg.deviceId ?? "");
            const action = String(msg.action ?? "");
            if (!["pause", "resume", "stop", "seek"].includes(action)) {
              sendJson(ws, { type: "error", message: `未知控制指令: ${action}` });
              return;
            }
            const positionMs = msg.positionMs === undefined ? undefined : Number(msg.positionMs);
            const ok = devices.control(deviceId, action as "pause" | "resume" | "stop" | "seek", positionMs);
            if (!ok) sendJson(ws, { type: "error", message: "设备不在线或参数错误" });
            break;
          }
          default:
            sendJson(ws, { type: "error", message: `未知消息类型: ${String(msg.type)}` });
        }
      } catch (error) {
        sendJson(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });

    ws.on("error", (error) => {
      console.error("[console-ws] 客户端错误:", error.message);
    });
  });

  return wss;
}
