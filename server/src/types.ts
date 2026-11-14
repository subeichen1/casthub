// CastHub 共享类型定义

export interface MediaFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mimeType: string;
}

export interface DeviceView {
  id: string;
  address: string;
  online: boolean;
}

export type TvState = "idle" | "buffering" | "playing" | "paused" | "error";

export interface TvStatusPayload {
  state: TvState;
  positionMs: number;
  durationMs: number;
}
