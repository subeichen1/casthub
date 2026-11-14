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
}

export type TvState = "idle" | "buffering" | "playing" | "paused" | "error";

export interface TvStatusPayload {
  state: TvState;
  positionMs: number;
  durationMs: number;
}
