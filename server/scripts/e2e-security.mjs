#!/usr/bin/env node
// CastHub 安全回归测试：日志脱敏、DLNA 私网白名单、局域网地址探测、SQLite 损坏恢复。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeRequestUrl, isPrivateIpv4 } from "../src/index.ts";
import { isLocalNetworkAddress } from "../src/dlna.ts";
import { SqliteHistoryStore } from "../src/history.ts";

function testSanitizeRequestUrl() {
  assert.equal(
    sanitizeRequestUrl("/media/movie.mp4?expires=1700000000&sig=secret-signature"),
    "/media/movie.mp4?expires=1700000000",
    "相对 URL 删除 sig、保留 expires"
  );
  assert.equal(
    sanitizeRequestUrl("/api/subtitle?path=a.srt&token=secret"),
    "/api/subtitle?path=a.srt",
    "删除 token"
  );
  assert.equal(
    sanitizeRequestUrl("http://192.168.1.2:9420/media/movie.mp4?expires=2&signature=abc&foo=1"),
    "http://192.168.1.2:9420/media/movie.mp4?expires=2&foo=1",
    "绝对 URL 保持绝对形式并保留非敏感参数"
  );
  assert.equal(sanitizeRequestUrl("/media/movie.mp4"), "/media/movie.mp4", "无查询参数原样保留");
  console.log("✅ sanitizeRequestUrl");
}

function testNetworkAddresses() {
  assert.equal(isLocalNetworkAddress("100.64.0.1", false), false, "CGNAT 默认拒绝");
  assert.equal(isLocalNetworkAddress("100.127.255.254", false), false, "CGNAT 尾部默认拒绝");
  assert.equal(isLocalNetworkAddress("100.64.0.1", false, true), true, "显式开启后允许 CGNAT");
  assert.equal(isLocalNetworkAddress("100.100.100.200", false, true), false, "即使开启也拒绝云元数据地址");
  assert.equal(isLocalNetworkAddress("192.168.1.10", false), true, "允许 RFC1918");
  assert.equal(isLocalNetworkAddress("10.1.2.3", false), true, "允许 10/8");
  assert.equal(isLocalNetworkAddress("172.20.0.1", false), true, "允许 172.16/12");
  assert.equal(isLocalNetworkAddress("127.0.0.1", false), false, "loopback 默认拒绝");
  assert.equal(isLocalNetworkAddress("127.0.0.1", true), true, "显式允许 loopback");

  assert.equal(isPrivateIpv4("10.0.0.1"), true);
  assert.equal(isPrivateIpv4("172.16.0.1"), true);
  assert.equal(isPrivateIpv4("172.31.255.255"), true);
  assert.equal(isPrivateIpv4("172.32.0.1"), false);
  assert.equal(isPrivateIpv4("192.168.1.1"), true);
  assert.equal(isPrivateIpv4("8.8.8.8"), false);
  assert.equal(isPrivateIpv4("100.64.0.1"), false, "CGNAT 不算 RFC1918");
  console.log("✅ 网络地址白名单");
}

function testSqliteRecovery() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-e2e-security-"));
  const dbPath = path.join(dir, "casthub.db");
  fs.writeFileSync(dbPath, Buffer.from("this is definitely not a sqlite database"));
  const store = new SqliteHistoryStore(dbPath);
  store.close();
  const files = fs.readdirSync(dir);
  assert.ok(files.some((name) => name.startsWith("casthub.db.corrupt-")), "损坏数据库被改名备份");
  assert.ok(files.includes("casthub.db"), "重建新的数据库文件");

  const directoryPath = path.join(dir, "not-a-database");
  fs.mkdirSync(directoryPath);
  assert.throws(() => new SqliteHistoryStore(directoryPath), /SQLITE|数据库|database/i, "非损坏错误直接抛出");
  assert.ok(fs.statSync(directoryPath).isDirectory(), "非损坏错误不删除原路径");
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith("not-a-database.corrupt-")), false, "非损坏错误不产生损坏备份");
  console.log("✅ SQLite 损坏恢复");
}

async function main() {
  testSanitizeRequestUrl();
  testNetworkAddresses();
  testSqliteRecovery();
  console.log("✅ E2E-SECURITY 全部通过");
}

main().catch((error) => {
  console.error("❌ E2E-SECURITY 失败:", error?.stack ? error.stack : error);
  process.exit(1);
});
