// 设备管理与「中枢→电视」WS 客户端（断线指数退避重连，上限 30s）
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import type { DeviceView, TvState, TvStatusPayload } from "./types";

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;

interface Device {
  id: string;
  address: string;
  token: string;
  deviceName: string;
  online: boolean;
  removed: boolean;
  fatalTokenError: boolean;
  ws: WebSocket | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectDelay: number;
}

function normalizeAddress(input: string): string {
  let address = input.trim();
  if (!address) throw new Error("设备地址不能为空");
  if (!/^wss?:\/\//i.test(address)) address = "ws://" + address;
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("设备地址格式错误");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("设备地址必须是 ws:// 或 wss://");
  if (!url.port) url.port = "9417";
  return url.toString().replace(/\/$/, "");
}

function toView(device: Device): DeviceView {
  return {
    id: device.id,
    address: device.address,
    online: device.online,
    type: "casthub",
    deviceName: device.deviceName
  };
}

export type ControlAction = "pause" | "resume" | "stop" | "seek";

export class DeviceManager {
  private devices = new Map<string, Device>();
  private clientId = "casthub-" + randomBytes(4).toString("hex");

  onDevicesChanged: (() => void) | null = null;
  onTvStatus: ((deviceId: string, status: TvStatusPayload) => void) | null = null;
  onDeviceError: ((deviceId: string, message: string) => void) | null = null;

  list(): DeviceView[] {
    return Array.from(this.devices.values()).map(toView);
  }

  has(id: string): boolean {
    return this.devices.has(id);
  }

  add(addressInput: string, token: string): DeviceView {
    const address = normalizeAddress(addressInput);
    if (!/^\d{6}$/.test(token)) throw new Error("配对码必须是 6 位数字");
    const existing = Array.from(this.devices.values()).find((d) => d.address === address);
    if (existing) {
      existing.token = token;
      existing.removed = false;
      existing.fatalTokenError = false;
      existing.reconnectDelay = INITIAL_RECONNECT_MS;
      this.connect(existing);
      this.emitDevices();
      return toView(existing);
    }
    const device: Device = {
      id: randomBytes(4).toString("hex"),
      address,
      token,
      deviceName: "电视",
      online: false,
      removed: false,
      fatalTokenError: false,
      ws: null,
      reconnectTimer: null,
      reconnectDelay: INITIAL_RECONNECT_MS
    };
    this.devices.set(device.id, device);
    this.connect(device);
    this.emitDevices();
    return toView(device);
  }

  remove(id: string): boolean {
    const device = this.devices.get(id);
    if (!device) return false;
    device.removed = true;
    if (device.reconnectTimer) {
      clearTimeout(device.reconnectTimer);
      device.reconnectTimer = null;
    }
    if (device.ws) {
      device.ws.removeAllListeners();
      try {
        device.ws.close(1000, "removed");
      } catch {
        // ignore
      }
      device.ws = null;
    }
    this.devices.delete(id);
    this.emitDevices();
    return true;
  }

  sendPlay(id: string, url: string, title: string, mimeType: string): boolean {
    return this.send(id, { type: "play", url, title, mimeType });
  }

  control(id: string, action: ControlAction, positionMs?: number): boolean {
    if (action === "seek") {
      if (!Number.isFinite(positionMs) || (positionMs as number) < 0) return false;
      return this.send(id, { type: "seek", positionMs: Math.round(positionMs as number) });
    }
    return this.send(id, { type: action });
  }

  dispose(): void {
    for (const device of this.devices.values()) {
      device.removed = true;
      if (device.reconnectTimer) clearTimeout(device.reconnectTimer);
      device.ws?.removeAllListeners();
      try {
        device.ws?.close(1000, "server shutdown");
      } catch {
        // ignore
      }
    }
    this.devices.clear();
  }

  private send(id: string, payload: Record<string, unknown>): boolean {
    const device = this.devices.get(id);
    if (!device || !device.online || !device.ws || device.ws.readyState !== WebSocket.OPEN) return false;
    device.ws.send(JSON.stringify(payload));
    return true;
  }

  private connect(device: Device): void {
    if (device.removed || device.fatalTokenError) return;
    if (device.ws && (device.ws.readyState === WebSocket.CONNECTING || device.ws.readyState === WebSocket.OPEN)) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(device.address);
    } catch (error) {
      console.error(`[devices] 创建连接失败 ${device.address}: ${(error as Error).message}`);
      this.scheduleReconnect(device);
      return;
    }
    device.ws = ws;

    ws.on("open", () => {
      device.reconnectDelay = INITIAL_RECONNECT_MS;
      try {
        ws.send(JSON.stringify({ type: "hello", token: device.token, clientId: this.clientId }));
      } catch (error) {
        console.error(`[devices] 发送 hello 失败: ${(error as Error).message}`);
      }
    });

    ws.on("message", (data) => {
      this.handleMessage(device, data.toString());
    });

    ws.on("error", (error) => {
      console.error(`[devices] ${device.address} 连接错误: ${error.message}`);
    });

    ws.on("close", (code) => {
      const wasOnline = device.online;
      device.online = false;
      device.ws = null;
      if (code === 4001) {
        device.fatalTokenError = true;
        this.onDeviceError?.(device.id, "配对码错误，电视已断开（close 4001）");
      }
      if (wasOnline || code === 4001) this.emitDevices();
      if (!device.removed && code !== 4001) this.scheduleReconnect(device);
    });
  }

  private scheduleReconnect(device: Device): void {
    if (device.removed || device.fatalTokenError || device.reconnectTimer) return;
    const delay = device.reconnectDelay;
    device.reconnectDelay = Math.min(device.reconnectDelay * 2, MAX_RECONNECT_MS);
    console.log(`[devices] ${device.address} ${delay}ms 后重试连接`);
    device.reconnectTimer = setTimeout(() => {
      device.reconnectTimer = null;
      if (device.removed || device.fatalTokenError) return;
      this.connect(device);
    }, delay);
  }

  private handleMessage(device: Device, raw: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") throw new Error("not object");
      msg = parsed as Record<string, unknown>;
    } catch {
      this.onDeviceError?.(device.id, "电视返回了非法 JSON 消息");
      return;
    }

    if (msg.type === "helloAck") {
      if (typeof msg.deviceName === "string" && msg.deviceName.trim()) {
        device.deviceName = msg.deviceName.trim();
      }
      if (msg.ok === true) {
        if (!device.online) {
          device.online = true;
          this.emitDevices();
        }
      } else {
        device.fatalTokenError = true;
        this.onDeviceError?.(device.id, "电视拒绝了配对");
        this.emitDevices();
      }
      return;
    }

    if (msg.type === "status") {
      const state = String(msg.state ?? "idle") as TvState;
      const allowed: TvState[] = ["idle", "buffering", "playing", "paused", "error"];
      this.onTvStatus?.(device.id, {
        state: allowed.includes(state) ? state : "idle",
        positionMs: Number.isFinite(msg.positionMs) ? Math.max(0, Number(msg.positionMs)) : 0,
        durationMs: Number.isFinite(msg.durationMs) ? Math.max(0, Number(msg.durationMs)) : 0
      });
      return;
    }

    if (msg.type === "error") {
      this.onDeviceError?.(device.id, `${String(msg.code ?? "error")}: ${String(msg.message ?? "")}`);
    }
  }

  private emitDevices(): void {
    this.onDevicesChanged?.();
  }
}
