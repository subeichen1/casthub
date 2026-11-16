// DLNA 服务器端播放队列（设备无关；不依赖 ws，也不直接依赖 DlnaService）
import type { TvState, TvStatusPayload } from "./types";

export interface QueueItem {
  path: string;
  name: string;
}

export type QueueState = "idle" | "playing" | "switching" | "paused" | "completed";

export interface QueueView {
  deviceId: string;
  items: QueueItem[];
  /** 未开始时为 -1。 */
  currentIndex: number;
  state: QueueState;
  playing: boolean;
  error?: string;
}

export interface QueuePlayContext {
  token: number;
  resume: boolean;
  auto: boolean;
}

export interface PlayQueueOptions {
  /** 每项自然结束后等待多久再投下一项；默认 1500ms。 */
  autoNextDelayMs?: number;
  /** 真正开始播放某一项（console-ws 注入，内部复用单文件 cast 流程）。 */
  playItem: (deviceId: string, item: QueueItem, context: QueuePlayContext) => Promise<void>;
  /** clear(stopPlayback=true) 时停止当前 DLNA 播放。 */
  stopPlayback?: (deviceId: string) => Promise<void> | void;
  /** 队列状态变化时广播完整 QueueView。 */
  broadcast: (view: QueueView) => void;
  /** 自动连播失败等需要提示控制台的错误。 */
  onError?: (deviceId: string, message: string) => void;
}

interface StatusSnapshot {
  state: TvState;
  positionMs: number;
  durationMs: number;
}

interface DeviceQueue {
  deviceId: string;
  items: QueueItem[];
  currentIndex: number;
  state: QueueState;
  playing: boolean;
  error?: string;
  lastStatus: StatusSnapshot | null;
  switching: boolean;
  awaitingPlayback: boolean;
  token: number;
  autoTimer: NodeJS.Timeout | null;
  suppressAutoNext: boolean;
  autoNextFailures: number;
  autoNextSuspended: boolean;
  naturalEndHandled: boolean;
}

const MAX_QUEUE_ITEMS = 500;
const DEFAULT_AUTO_NEXT_DELAY_MS = 1500;

function parseAutoNextDelay(value: number | undefined): number {
  if (value === undefined) return DEFAULT_AUTO_NEXT_DELAY_MS;
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_AUTO_NEXT_DELAY_MS;
}

function emptyView(deviceId: string): QueueView {
  return { deviceId, items: [], currentIndex: -1, state: "idle", playing: false };
}

export class PlayQueue {
  private readonly queues = new Map<string, DeviceQueue>();
  private readonly autoNextDelayMs: number;

  constructor(private readonly options: PlayQueueOptions) {
    this.autoNextDelayMs = parseAutoNextDelay(options.autoNextDelayMs);
  }

  add(deviceId: string, item: QueueItem): QueueView {
    const q = this.ensure(deviceId);
    if (q.items.length >= MAX_QUEUE_ITEMS) {
      throw new Error(`队列最多 ${MAX_QUEUE_ITEMS} 项`);
    }
    q.items.push({ path: item.path, name: item.name });
    // 已完成队列追加新项后，下一次“继续队列”应从新项开始，而不是重播最后一项。
    if (q.state === "completed") {
      q.currentIndex = q.items.length - 1;
      q.state = "paused";
      q.playing = false;
      q.error = undefined;
      q.lastStatus = null;
    }
    const view = this.view(q);
    this.broadcast(view);
    return view;
  }

  get(deviceId: string): QueueView | null {
    const q = this.queues.get(deviceId);
    return q ? this.view(q) : null;
  }

  list(): QueueView[] {
    return Array.from(this.queues.values()).map((q) => this.view(q));
  }

  async play(deviceId: string): Promise<void> {
    const q = this.queues.get(deviceId);
    if (!q || q.items.length === 0) throw new Error("队列为空");
    if (q.state === "playing" || q.switching) return;

    this.clearAutoTimer(q);
    q.suppressAutoNext = false;
    q.autoNextFailures = 0;
    q.autoNextSuspended = false;
    q.error = undefined;

    let resume = false;
    if (q.state === "completed") {
      q.currentIndex = 0;
      // 队列完成后重新播放从第一项开头开始，不沿用旧断点。
      resume = false;
    } else if (q.currentIndex < 0) {
      q.currentIndex = 0;
      // 仅队列第一项首次开始沿用既有断点续播；手动停止后的继续从头播放。
      resume = true;
    }
    await this.startCurrent(q, resume, false);
  }

  remove(deviceId: string, index: number): QueueView {
    const q = this.queues.get(deviceId);
    if (!q) throw new Error("队列为空");
    if (!Number.isInteger(index) || index < 0 || index >= q.items.length) throw new Error("队列项不存在");
    if (index === q.currentIndex && (q.state === "playing" || q.switching)) {
      throw new Error("当前播放项不允许移除，请先停止播放");
    }

    q.items.splice(index, 1);
    if (q.items.length === 0) {
      q.currentIndex = -1;
      q.state = "idle";
      q.playing = false;
      q.error = undefined;
      q.lastStatus = null;
    } else if (index < q.currentIndex) {
      q.currentIndex -= 1;
    } else if (index === q.currentIndex) {
      q.currentIndex = Math.min(index, q.items.length - 1);
      q.state = "paused";
      q.playing = false;
      q.lastStatus = null;
    }
    const view = this.view(q);
    this.broadcast(view);
    return view;
  }

  async clear(deviceId: string, options: { stopPlayback?: boolean } = {}): Promise<QueueView> {
    const q = this.queues.get(deviceId);
    if (!q) return emptyView(deviceId);
    const shouldStop = !!options.stopPlayback && (q.state === "playing" || q.state === "switching");
    q.token += 1;
    q.switching = false;
    q.awaitingPlayback = false;
    q.playing = false;
    this.clearAutoTimer(q);
    this.queues.delete(deviceId);
    if (shouldStop && this.options.stopPlayback) {
      try {
        await this.options.stopPlayback(deviceId);
      } catch (error) {
        console.error(`[queue] 清空队列时停止播放失败: ${(error as Error).message}`);
      }
    }
    const view = emptyView(deviceId);
    this.broadcast(view);
    return view;
  }

  suppressAutoNext(deviceId: string): void {
    const q = this.queues.get(deviceId);
    if (!q) return;
    q.suppressAutoNext = true;
    this.clearAutoTimer(q);
    // 自动切集等待期间手动停止：取消待执行的自动下一项，回到 paused。
    if (q.state === "switching") {
      q.state = "paused";
      q.playing = false;
      q.switching = false;
      q.awaitingPlayback = false;
      q.lastStatus = null;
      this.broadcast(this.view(q));
    }
  }

  handleTvStatus(deviceId: string, status: TvStatusPayload): void {
    const q = this.queues.get(deviceId);
    if (!q) return;

    if (q.switching) {
      // dlna.play 尚未返回时，旧视频轮询产生的 playing/idle 全部忽略，避免提前解锁或误跳下一集。
      if (q.awaitingPlayback) return;
      if (status.state === "playing") {
        q.switching = false;
        q.state = "playing";
        q.playing = true;
        q.error = undefined;
        q.autoNextFailures = 0;
        q.naturalEndHandled = false;
        q.lastStatus = { state: "playing", positionMs: status.positionMs, durationMs: status.durationMs };
        this.broadcast(this.view(q));
        return;
      }
      if (status.state === "error") {
        q.switching = false;
        q.state = "paused";
        q.playing = false;
        q.error = "播放出错";
        q.lastStatus = null;
        this.broadcast(this.view(q));
      }
      return;
    }

    const previous = q.lastStatus;
    if (status.state === "error") {
      q.state = "paused";
      q.playing = false;
      q.error = "播放出错";
      q.lastStatus = null;
      this.broadcast(this.view(q));
      return;
    }

    if (status.state === "playing") {
      const changed = q.state !== "playing" || !q.playing;
      q.state = "playing";
      q.playing = true;
      q.error = undefined;
      q.autoNextFailures = 0;
      q.lastStatus = { state: "playing", positionMs: status.positionMs, durationMs: status.durationMs };
      if (changed) this.broadcast(this.view(q));
      return;
    }

    if (status.state === "paused" || status.state === "buffering") {
      // 电视端暂停/缓冲不算队列暂停：队列会话仍处于活动状态，stop 才转 paused。
      q.lastStatus = { state: status.state, positionMs: status.positionMs, durationMs: status.durationMs };
      return;
    }

    // idle：只有上一次 playing + 本次 idle + 已知位置达到 95% 才算自然结束。
    // 兼容部分电视 STOPPED 时把 position 报为 0：取本次与上次位置的较大值，duration 同理。
    const duration = Math.max(status.durationMs, previous?.durationMs ?? 0);
    const position = Math.max(status.positionMs, previous?.positionMs ?? 0);
    const naturalEnd =
      q.state === "playing" &&
      !q.suppressAutoNext &&
      previous?.state === "playing" &&
      duration > 0 &&
      position >= duration * 0.95;
    q.lastStatus = { state: "idle", positionMs: status.positionMs, durationMs: status.durationMs };
    if (naturalEnd) {
      this.finishCurrent(q);
      return;
    }
    if (q.state === "playing" || q.state === "switching") {
      q.state = "paused";
      q.playing = false;
      this.broadcast(this.view(q));
    }
  }

  /** dlna.poll 的精确自然结束回调；与 handleTvStatus 双保险且幂等。 */
  handlePlaybackEnded(deviceId: string): void {
    const q = this.queues.get(deviceId);
    if (!q || q.state !== "playing" || q.switching || q.suppressAutoNext) return;
    if (q.naturalEndHandled) return;
    q.naturalEndHandled = true;
    this.finishCurrent(q);
  }

  private ensure(deviceId: string): DeviceQueue {
    let q = this.queues.get(deviceId);
    if (!q) {
      q = {
        deviceId,
        items: [],
        currentIndex: -1,
        state: "idle",
        playing: false,
        lastStatus: null,
        switching: false,
        awaitingPlayback: false,
        token: 0,
        autoTimer: null,
        suppressAutoNext: false,
        autoNextFailures: 0,
        autoNextSuspended: false,
        naturalEndHandled: false,
      };
      this.queues.set(deviceId, q);
    }
    return q;
  }

  private view(q: DeviceQueue): QueueView {
    return {
      deviceId: q.deviceId,
      items: q.items.map((item) => ({ ...item })),
      currentIndex: q.currentIndex,
      state: q.state,
      playing: q.playing,
      ...(q.error ? { error: q.error } : {}),
    };
  }

  private broadcast(view: QueueView): void {
    this.options.broadcast(view);
  }

  private clearAutoTimer(q: DeviceQueue): void {
    if (q.autoTimer) {
      clearTimeout(q.autoTimer);
      q.autoTimer = null;
    }
  }

  private async startCurrent(q: DeviceQueue, resume: boolean, auto: boolean): Promise<void> {
    const item = q.items[q.currentIndex];
    if (!item) {
      q.state = "paused";
      q.playing = false;
      return;
    }
    this.clearAutoTimer(q);
    q.token += 1;
    const token = q.token;
    q.state = "switching";
    q.playing = true;
    q.switching = true;
    q.awaitingPlayback = true;
    q.lastStatus = null;
    q.naturalEndHandled = false;
    q.error = undefined;
    this.broadcast(this.view(q));

    try {
      await this.options.playItem(q.deviceId, item, { token, resume, auto });
    } catch (error) {
      if (token !== q.token) return;
      q.switching = false;
      q.awaitingPlayback = false;
      q.playing = false;
      q.state = "paused";
      q.error = (error as Error).message;
      q.autoNextFailures += 1;
      let message = `自动连播失败: ${q.error}`;
      if (!auto) message = `队列播放失败: ${q.error}`;
      if (q.autoNextFailures >= 2) {
        q.autoNextSuspended = true;
        message += "（连续失败 2 次，已停止自动尝试）";
      }
      q.lastStatus = null;
      this.broadcast(this.view(q));
      this.options.onError?.(q.deviceId, message);
      return;
    }
    if (token !== q.token) return;
    // 仍保持 switching：必须等新视频第一次上报 playing 才解除切集锁。
    q.awaitingPlayback = false;
    if (q.autoNextSuspended) {
      q.autoNextSuspended = false;
    }
  }

  private finishCurrent(q: DeviceQueue): void {
    this.clearAutoTimer(q);
    q.state = "switching";
    q.playing = false;
    // 自动切集等待期间同样是锁：旧视频轮询产生的 idle/STOPPED 必须忽略。
    q.switching = true;
    q.awaitingPlayback = false;
    q.lastStatus = null;
    q.naturalEndHandled = true;
    this.broadcast(this.view(q));

    if (q.currentIndex >= q.items.length - 1) {
      q.state = "completed";
      q.playing = false;
      q.switching = false;
      this.broadcast(this.view(q));
      return;
    }
    if (q.autoNextSuspended) {
      q.state = "paused";
      q.switching = false;
      this.broadcast(this.view(q));
      return;
    }
    const token = q.token;
    q.autoTimer = setTimeout(() => {
      q.autoTimer = null;
      if (q.token !== token || q.state !== "switching") return;
      q.currentIndex += 1;
      void this.startCurrent(q, false, true);
    }, this.autoNextDelayMs);
  }
}
