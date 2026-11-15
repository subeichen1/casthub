#!/usr/bin/env node
// Phase 9A 存储层门禁：真实调用 HistoryStore 五类方法，并用垃圾 casthub.db 验证损坏重建/降级不崩。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHistoryStore, validResumePosition } from "../src/history";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error("断言失败: " + message);
  console.log("✓ " + message);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-phase9a-"));
const dataDir = path.join(tempDir, "data");
fs.mkdirSync(dataDir, { recursive: true });
const garbage = path.join(dataDir, "casthub.db");
fs.writeFileSync(garbage, "this is not a sqlite database\n".repeat(20));
const garbageJson = path.join(dataDir, "casthub-history.json");
fs.writeFileSync(garbageJson, "this is not a json history file\n".repeat(10));
console.log("临时数据目录:", dataDir);
console.log("预置垃圾数据库:", garbage, fs.statSync(garbage).size, "bytes");
console.log("预置垃圾 JSON 历史（JSON 降级模式）:", garbageJson, fs.statSync(garbageJson).size, "bytes");

const handle = createHistoryStore(dataDir);
console.log("STORE_KIND", handle.kind);
console.log("STORE_FILE", handle.filePath);

const now = Date.now();
const one = {
  path: path.join(tempDir, "电影 一.mp4"),
  name: "电影 一.mp4",
  positionMs: 30_000,
  durationMs: 60_000,
  updatedAt: now - 1000,
  playCount: 1,
  lastDeviceId: "tv-1",
};
const two = {
  path: path.join(tempDir, "第二部.mp4"),
  name: "第二部.mp4",
  positionMs: 5_000,
  durationMs: 120_000,
  updatedAt: now,
  playCount: 3,
  lastDeviceId: null,
};

console.log("\n[1/5] upsert x2 ...");
handle.store.upsert(one);
handle.store.upsert(two);
console.log("upsert 完成");

console.log("\n[2/5] get ...");
const got = handle.store.get(one.path);
console.log("get =>", JSON.stringify(got));
assert(got !== null && got.positionMs === 30_000 && got.name === "电影 一.mp4", "get 返回完整记录");

console.log("\n[3/5] list ...");
const list = handle.store.list(200);
console.log("list =>", JSON.stringify(list));
assert(list.length === 2 && list[0].path === two.path, "list 按 updatedAt 倒序且含两条");

console.log("\n[4/5] remove ...");
const removed = handle.store.remove(one.path);
const afterRemove = handle.store.get(one.path);
console.log("remove =>", removed, "getAfterRemove =>", afterRemove);
assert(removed === true && afterRemove === null, "remove 删除指定记录");

console.log("\n[5/5] close + reopen ...");
handle.store.close();
const reopened = createHistoryStore(dataDir);
const persisted = reopened.store.get(two.path);
console.log("reopen kind =>", reopened.kind, "persisted =>", JSON.stringify(persisted));
assert(persisted !== null && persisted.playCount === 3, "close 后数据仍可读取（持久化生效）");
console.log("validResumePosition 30000/60000 =>", validResumePosition({ ...one, positionMs: 30_000 }));
console.log("validResumePosition 57000/60000 =>", validResumePosition({ ...one, positionMs: 57_000 }));
assert(validResumePosition({ ...one, positionMs: 57_000 }) === null, "95% 看完位置不再续播");
reopened.store.close();
fs.rmSync(tempDir, { recursive: true, force: true });
console.log("\n✅ PHASE9A-GATE 全部通过");
