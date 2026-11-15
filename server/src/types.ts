// CastHub 共享类型定义

export interface MediaFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mimeType: string;
}

export type DeviceType = "casthub" | "dlna";

export interface DeviceView {
  id: string;
  address: string;
  online: boolean;
  type: DeviceType;
  deviceName: string;
  /** DLNA RenderingControl 音量（0-100）；casthub 设备恒为 null（App 不控系统音量）。 */
  volume?: number | null;
}

export type TvState = "idle" | "buffering" | "playing" | "paused" | "error";

export interface TvStatusPayload {
  state: TvState;
  positionMs: number;
  durationMs: number;
  /** DLNA 设备可选携带当前音量；不支持 RenderingControl 时为 null。 */
  volume?: number | null;
}
