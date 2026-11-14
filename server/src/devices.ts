// 设备管理与「中枢→电视」WS 客户端（断线指数退避重连，上限 30s）
import { randomBytes } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import type { DeviceView, TvState, TvStatusPayload } from "./types";

const INITIAL_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 30000;
const MAX_DEVICES = 32;
const HEARTBEAT_INTERVAL_MS = 15000;
const OFFLINE_AFTER_MS = 50000;
const MAX_TV_MESSAGE_BYTES = 256 * 1024;
const MAX_ADDRESS_LENGTH = 2048;
const MAX_DEVICE_NAME_LENGTH = 64;
export const PROTOCOL_VERSION = 1;

function rawDataLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((sum, part) => sum + part.length, 0);
  if (data instanceof ArrayBuffer) return data.byteLength;
  return data.length;
}

function sanitizeDeviceName(value: string): string {
  let clean = "";
  for (const char of value.trim()) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 && code !== 0x7f) clean += char;
  }
  return clean.slice(0, MAX_DEVICE_NAME_LENGTH) || "电视";
}

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
  heartbeatTimer: NodeJS.Timeout | null;
  reconnectDelay: number;
  lastSeenAt: number;
}

function normalizeAddress(input: string): string {
  let address = input.trim();
  if (!address) throw new Error("设备地址不能为空");
  if (address.length > MAX_ADDRESS_LENGTH) throw new Error("设备地址过长");
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
    if (!/^\d{6,8}$/.test(token)) throw new Error("配对码必须是 6-8 位数字");
    const existing = Array.from(this.devices.values()).find((d) => d.address === address);
    if (existing) {
      const tokenChanged = existing.token !== token;
      existing.token = token;
      existing.removed = false;
      existing.fatalTokenError = false;
      existing.reconnectDelay = INITIAL_RECONNECT_MS;
      if (tokenChanged && existing.ws) {
        existing.online = false;
        existing.ws.removeAllListeners();
        try {
          existing.ws.close(1000, "token changed");
        } catch {
          // ignore
        }
        existing.ws = null;
        this.clearHeartbeat(existing);
      }
      this.connect(existing);
      this.emitDevices();
      return toView(existing);
    }
    if (this.devices.size >= MAX_DEVICES) {
      throw new Error(`设备数量已达到上限 ${MAX_DEVICES}`);
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
      heartbeatTimer: null,
      reconnectDelay: INITIAL_RECONNECT_MS,
      lastSeenAt: 0
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
    this.clearHeartbeat(device);
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
      this.clearHeartbeat(device);
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
    try {
      device.ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }

  private clearHeartbeat(device: Device): void {
    if (device.heartbeatTimer) {
      clearInterval(device.heartbeatTimer);
      device.heartbeatTimer = null;
    }
  }

  private startHeartbeat(device: Device): void {
    this.clearHeartbeat(device);
    device.heartbeatTimer = setInterval(() => {
      if (!device.ws || device.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - device.lastSeenAt > OFFLINE_AFTER_MS) {
        console.warn(`[devices] ${device.address} 心跳超时，主动断开`);
        device.ws.terminate();
        return;
      }
      try {
        device.ws.ping();
      } catch {
        // ignore
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private connect(device: Device): void {
    if (device.removed || device.fatalTokenError) return;
    if (device.ws && (device.ws.readyState === WebSocket.CONNECTING || device.ws.readyState === WebSocket.OPEN)) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(device.address, {
        maxPayload: MAX_TV_MESSAGE_BYTES,
        handshakeTimeout: 10_000
      });
    } catch (error) {
      console.error(`[devices] 创建连接失败 ${device.address}: ${(error as Error).message}`);
      this.scheduleReconnect(device);
      return;
    }
    device.ws = ws;

    ws.on("open", () => {
      device.reconnectDelay = INITIAL_RECONNECT_MS;
      device.lastSeenAt = Date.now();
      this.startHeartbeat(device);
      try {
        ws.send(JSON.stringify({ type: "hello", version: PROTOCOL_VERSION, token: device.token, clientId: this.clientId }));
      } catch (error) {
        console.error(`[devices] 发送 hello 失败: ${(error as Error).message}`);
      }
    });

    ws.on("message", (data) => {
      if (rawDataLength(data) > MAX_TV_MESSAGE_BYTES) {
        this.onDeviceError?.(device.id, "电视消息过大");
        return;
      }
      device.lastSeenAt = Date.now();
      this.handleMessage(device, data.toString());
    });

    ws.on("pong", () => {
      device.lastSeenAt = Date.now();
    });

    ws.on("error", (error) => {
      console.error(`[devices] ${device.address} 连接错误: ${error.message}`);
    });

    ws.on("close", (code) => {
      const wasOnline = device.online;
      device.online = false;
      device.ws = null;
      this.clearHeartbeat(device);
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
      if (msg.version !== undefined) {
        const version = Number(msg.version);
        if (!Number.isInteger(version) || version !== PROTOCOL_VERSION) {
          device.fatalTokenError = true;
          this.onDeviceError?.(device.id, `协议版本不兼容（电视 ${String(msg.version)}，中枢 ${PROTOCOL_VERSION}）`);
          try {
            device.ws?.close(4004, "protocol version unsupported");
          } catch {
            // ignore
          }
          return;
        }
      }
      if (typeof msg.deviceName === "string" && msg.deviceName.trim()) {
        device.deviceName = sanitizeDeviceName(msg.deviceName);
      }
      if (msg.ok === true) {
        device.lastSeenAt = Date.now();
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
        positionMs: Number.isFinite(Number(msg.positionMs)) ? Math.max(0, Number(msg.positionMs)) : 0,
        durationMs: Number.isFinite(Number(msg.durationMs)) ? Math.max(0, Number(msg.durationMs)) : 0
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
