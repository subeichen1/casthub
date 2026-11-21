// 播放历史：HistoryStore 接口、SQLite 默认实现、JSON 降级实现与记录节流
import * as fs from "node:fs";
import * as path from "node:path";
import type { TvState, TvStatusPayload } from "./types";

export interface HistoryEntry {
  path: string;
  name: string;
  positionMs: number;
  durationMs: number;
  updatedAt: number;
  playCount: number;
  lastDeviceId: string | null;
}

export interface HistoryStore {
  upsert(entry: HistoryEntry): void;
  get(filePath: string): HistoryEntry | null;
  list(limit?: number): HistoryEntry[];
  remove(filePath: string): boolean;
  close(): void;
}

export interface HistoryStoreHandle {
  store: HistoryStore;
  kind: "sqlite" | "json";
  filePath: string;
}

const HISTORY_LIMIT = 200;
const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS playback_history(
  path TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  position_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  play_count INTEGER NOT NULL DEFAULT 1,
  last_device_id TEXT
)`;

interface BetterSqliteStatement {
  run(...params: unknown[]): { changes?: number } | unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface BetterSqliteDatabase {
  pragma(source: string): unknown;
  exec(source: string): void;
  prepare(source: string): BetterSqliteStatement;
  close(): void;
}

type BetterSqliteConstructor = new (filePath: string) => BetterSqliteDatabase;

function loadBetterSqlite(): BetterSqliteConstructor | null {
  try {
    return require("better-sqlite3") as BetterSqliteConstructor;
  } catch (error) {
    console.error(`[history] better-sqlite3 不可用: ${(error as Error).message}`);
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function rowToEntry(row: unknown): HistoryEntry | null {
  const record = asRecord(row);
  if (!record) return null;
  const filePath = typeof record.path === "string" ? record.path : "";
  const name = typeof record.name === "string" ? record.name : "";
  const positionMs = Number(record.position_ms);
  const durationMs = Number(record.duration_ms);
  const updatedAt = Number(record.updated_at);
  const playCount = Number(record.play_count);
  if (!filePath || !name || !Number.isFinite(positionMs) || !Number.isFinite(durationMs)) return null;
  if (!Number.isFinite(updatedAt) || !Number.isFinite(playCount)) return null;
  return {
    path: filePath,
    name,
    positionMs: Math.max(0, Math.round(positionMs)),
    durationMs: Math.max(0, Math.round(durationMs)),
    updatedAt: Math.round(updatedAt),
    playCount: Math.max(1, Math.round(playCount)),
    lastDeviceId: typeof record.last_device_id === "string" ? record.last_device_id : null,
  };
}

function safeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit as number) <= 0) return HISTORY_LIMIT;
  return Math.min(Math.floor(limit as number), 100_000);
}

function isSqliteCorruption(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "SQLITE_CORRUPT" || code === "SQLITE_NOTADB";
}

/** 把损坏的数据库及 WAL/SHM 文件改名备份，返回备份前缀。 */
function backupSqliteFiles(dbPath: string): string {
  const backupBase = `${dbPath}.corrupt-${Date.now()}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.renameSync(dbPath + suffix, backupBase + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(`[history] 备份 SQLite 文件失败 ${dbPath + suffix}: ${(error as Error).message}`);
      }
    }
  }
  return backupBase;
}

/** SQLite 默认实现。所有方法同步且自行吞掉异常；仅对确认损坏的数据库备份后重建。 */
export class SqliteHistoryStore implements HistoryStore {
  private db: BetterSqliteDatabase;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const Database = loadBetterSqlite();
    if (!Database) throw new Error("better-sqlite3 模块未安装或加载失败");
    this.db = this.openDatabase(Database, dbPath);
  }

  private openDatabase(Database: BetterSqliteConstructor, dbPath: string): BetterSqliteDatabase {
    let db: BetterSqliteDatabase | null = null;
    try {
      db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.exec(CREATE_TABLE_SQL);
      return db;
    } catch (error) {
      if (!isSqliteCorruption(error)) throw error;
      console.error(`[history] SQLite 数据库损坏，备份并重建空库: ${dbPath} (${(error as Error).message})`);
      try {
        db?.close();
      } catch {
        // ignore
      }
      const backupBase = backupSqliteFiles(dbPath);
      console.error(`[history] 损坏数据库已备份到: ${backupBase}`);
      db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = NORMAL");
      db.exec(CREATE_TABLE_SQL);
      return db;
    }
  }

  upsert(entry: HistoryEntry): void {
    try {
      this.db
        .prepare(
          `INSERT INTO playback_history (path, name, position_ms, duration_ms, updated_at, play_count, last_device_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             name = excluded.name,
             position_ms = excluded.position_ms,
             duration_ms = excluded.duration_ms,
             updated_at = excluded.updated_at,
             play_count = excluded.play_count,
             last_device_id = excluded.last_device_id`
        )
        .run(
          entry.path,
          entry.name,
          Math.max(0, Math.round(entry.positionMs)),
          Math.max(0, Math.round(entry.durationMs)),
          Math.round(entry.updatedAt),
          Math.max(1, Math.round(entry.playCount)),
          entry.lastDeviceId
        );
    } catch (error) {
      console.error(`[history] 写入 SQLite 失败: ${(error as Error).message}`);
    }
  }

  get(filePath: string): HistoryEntry | null {
    try {
      return rowToEntry(this.db.prepare("SELECT * FROM playback_history WHERE path = ?").get(filePath));
    } catch (error) {
      console.error(`[history] 读取 SQLite 失败: ${(error as Error).message}`);
      return null;
    }
  }

  list(limit?: number): HistoryEntry[] {
    try {
      const rows = this.db
        .prepare("SELECT * FROM playback_history ORDER BY updated_at DESC LIMIT ?")
        .all(safeLimit(limit));
      return rows.map(rowToEntry).filter((entry): entry is HistoryEntry => entry !== null);
    } catch (error) {
      console.error(`[history] 列出 SQLite 失败: ${(error as Error).message}`);
      return [];
    }
  }

  remove(filePath: string): boolean {
    try {
      const result = this.db.prepare("DELETE FROM playback_history WHERE path = ?").run(filePath);
      return Number((result as { changes?: number }).changes ?? 0) > 0;
    } catch (error) {
      console.error(`[history] 删除 SQLite 记录失败: ${(error as Error).message}`);
      return false;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      console.error(`[history] 关闭 SQLite 失败: ${(error as Error).message}`);
    }
  }
}

/** JSON 降级实现：整表读入内存，每次变更原子写回 data/casthub-history.json。 */
export class JsonHistoryStore implements HistoryStore {
  private entries = new Map<string, HistoryEntry>();
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.load();
  }

  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8").replace(/^\uFEFF/, "");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // 权限、磁盘或临时 I/O 错误不能当作“历史文件损坏”，否则会静默清空历史。
        console.error(`[history] 读取 JSON 历史文件失败，保留原文件: ${this.filePath} (${(error as Error).message})`);
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.resetCorrupt(`JSON 解析失败: ${(error as Error).message}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      this.resetCorrupt("历史文件不是数组");
      return;
    }

    for (const item of parsed) {
      const record = asRecord(item);
      if (!record) continue;
      const entry = {
        path: typeof record.path === "string" ? record.path : "",
        name: typeof record.name === "string" ? record.name : "",
        positionMs: Number(record.positionMs),
        durationMs: Number(record.durationMs),
        updatedAt: Number(record.updatedAt),
        playCount: Number(record.playCount),
        lastDeviceId: typeof record.lastDeviceId === "string" ? record.lastDeviceId : null,
      };
      if (entry.path && entry.name && Number.isFinite(entry.positionMs) && Number.isFinite(entry.durationMs)) {
        this.entries.set(entry.path, entry);
      }
    }
  }

  private resetCorrupt(reason: string): void {
    const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(this.filePath, backupPath);
      console.error(`[history] JSON 历史文件损坏（${reason}），已备份到 ${backupPath} 并重建空文件`);
    } catch (error) {
      // 备份失败时保留原文件，避免为了“自愈”反而销毁唯一副本。
      console.error(`[history] JSON 历史文件损坏（${reason}），备份失败，保留原文件: ${(error as Error).message}`);
      return;
    }
    this.entries.clear();
    this.persist();
  }

  private persist(): void {
    try {
      const tempPath = this.filePath + ".tmp";
      fs.writeFileSync(tempPath, JSON.stringify(this.sorted(), null, 2), "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      console.error(`[history] 写入 JSON 历史失败: ${(error as Error).message}`);
    }
  }

  private sorted(): HistoryEntry[] {
    return Array.from(this.entries.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  upsert(entry: HistoryEntry): void {
    try {
      this.entries.set(entry.path, {
        ...entry,
        positionMs: Math.max(0, Math.round(entry.positionMs)),
        durationMs: Math.max(0, Math.round(entry.durationMs)),
        updatedAt: Math.round(entry.updatedAt),
        playCount: Math.max(1, Math.round(entry.playCount)),
      });
      this.persist();
    } catch (error) {
      console.error(`[history] 更新 JSON 历史失败: ${(error as Error).message}`);
    }
  }

  get(filePath: string): HistoryEntry | null {
    return this.entries.get(filePath) ?? null;
  }

  list(limit?: number): HistoryEntry[] {
    return this.sorted().slice(0, safeLimit(limit));
  }

  remove(filePath: string): boolean {
    const removed = this.entries.delete(filePath);
    if (removed) this.persist();
    return removed;
  }

  close(): void {
    this.persist();
  }
}

/** 优先 SQLite；原生模块不可用或建库失败时降级 JSON（只存在这两种实现）。 */
export function createHistoryStore(dataDir: string): HistoryStoreHandle {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "casthub.db");
  try {
    return { store: new SqliteHistoryStore(dbPath), kind: "sqlite", filePath: dbPath };
  } catch (error) {
    const jsonPath = path.join(dataDir, "casthub-history.json");
    console.error(`[history] SQLite 初始化失败，降级 JSON: ${(error as Error).message}`);
    return { store: new JsonHistoryStore(jsonPath), kind: "json", filePath: jsonPath };
  }
}

/** 有效续播位置：5s ≤ pos < 95% × duration；否则返回 null。 */
export function validResumePosition(entry: HistoryEntry | null): number | null {
  if (!entry || entry.durationMs <= 0) return null;
  if (entry.positionMs < 5_000 || entry.positionMs >= entry.durationMs * 0.95) return null;
  return Math.round(entry.positionMs);
}

interface ActivePlayback {
  path: string;
  name: string;
  completed: boolean;
  lastState: TvState | null;
  lastSavedPositionMs: number | null;
}

export type HistoryUpdate = "saved" | "cleared" | null;

/** 把 tvStatus 流转换为持久化记录；负责 5s 节流、状态切换立即落盘与 95% 看完判定。 */
export class HistoryRecorder {
  private readonly store: HistoryStore;
  private readonly now: () => number;
  private active = new Map<string, ActivePlayback>();
  private lastWriteAt = new Map<string, number>();
  private suppressed = new Set<string>();

  constructor(store: HistoryStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  startPlayback(deviceId: string, file: { path: string; name: string }): void {
    this.active.set(deviceId, {
      path: file.path,
      name: file.name,
      completed: false,
      lastState: null,
      lastSavedPositionMs: 0,
    });
    this.lastWriteAt.delete(file.path);
    this.suppressed.delete(file.path);
  }

  stopPlayback(deviceId: string): void {
    this.active.delete(deviceId);
  }

  /** 设备被移除时清理活动状态；不影响已持久化的历史记录。 */
  forgetDevice(deviceId: string): void {
    this.active.delete(deviceId);
  }

  record(deviceId: string, status: TvStatusPayload): HistoryUpdate {
    const active = this.active.get(deviceId);
    if (!active) return null;
    const filePath = active.path;
    if (this.suppressed.has(filePath)) return null;

    if (status.state === "error") {
      this.suppressed.add(filePath);
      const removed = this.store.remove(filePath);
      this.active.delete(deviceId);
      return removed ? "cleared" : null;
    }
    if (active.completed) {
      active.lastState = status.state;
      return null;
    }

    const position = Math.max(0, Math.round(Number(status.positionMs) || 0));
    const duration = Math.max(0, Math.round(Number(status.durationMs) || 0));
    const existing = this.store.get(filePath);
    const now = this.now();

    if (duration > 0 && position >= duration * 0.95) {
      const entry: HistoryEntry = {
        path: filePath,
        name: active.name,
        positionMs: 0,
        durationMs: duration,
        updatedAt: now,
        playCount: (existing?.playCount ?? 1) + 1,
        lastDeviceId: deviceId,
      };
      this.store.upsert(entry);
      active.completed = true;
      active.lastState = status.state;
      active.lastSavedPositionMs = 0;
      this.lastWriteAt.set(filePath, now);
      return "saved";
    }

    if (position < 5_000) {
      active.lastState = status.state;
      return null;
    }

    const lastWrite = this.lastWriteAt.get(filePath) ?? 0;
    const immediateState = status.state === "paused" || status.state === "idle";
    const moved = active.lastSavedPositionMs === null || Math.abs(position - active.lastSavedPositionMs) >= 500;
    const jumped = active.lastSavedPositionMs !== null && Math.abs(position - active.lastSavedPositionMs) >= 5_000;
    const shouldWrite = immediateState
      ? active.lastState !== status.state || moved
      : status.state === "playing"
        ? now - lastWrite >= 5_000 || jumped
        : false;

    active.lastState = status.state;
    if (!shouldWrite) return null;

    const entry: HistoryEntry = {
      path: filePath,
      name: active.name,
      positionMs: position,
      durationMs: duration > 0 ? duration : (existing?.durationMs ?? 0),
      updatedAt: now,
      playCount: existing?.playCount ?? 1,
      lastDeviceId: deviceId,
    };
    this.store.upsert(entry);
    active.lastSavedPositionMs = position;
    this.lastWriteAt.set(filePath, now);
    return "saved";
  }

  /** 设备上报 error 时清除该设备当前文件的历史位置。 */
  clearForDevice(deviceId: string): boolean {
    const active = this.active.get(deviceId);
    if (!active) return false;
    this.suppressed.add(active.path);
    this.active.delete(deviceId);
    return this.store.remove(active.path);
  }

  get(filePath: string): HistoryEntry | null {
    return this.store.get(filePath);
  }

  list(limit?: number): HistoryEntry[] {
    return this.store.list(limit);
  }

  remove(filePath: string): boolean {
    this.suppressed.add(filePath);
    this.lastWriteAt.delete(filePath);
    return this.store.remove(filePath);
  }

  clear(): number {
    const rows = this.store.list(100_000);
    let removed = 0;
    for (const row of rows) {
      if (this.store.remove(row.path)) removed += 1;
    }
    for (const active of this.active.values()) this.suppressed.add(active.path);
    this.lastWriteAt.clear();
    return removed;
  }

  close(): void {
    this.store.close();
  }
}
