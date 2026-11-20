#!/usr/bin/env node
// 电视助手 e2e：fake adb + 本地 APK，覆盖 安装成功 / 未授权 / 厂商拒绝 / 下载校验失败 / 还原 / 忙时拒绝。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import WebSocket from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const HTTP_PORT = Number(process.env.E2E_PORT ?? 9420);
const TV_PORT = Number(process.env.E2E_TV_PORT ?? 9417);
const CONSOLE_TOKEN = "e2e-console-token-2024";
const TV_TOKEN = "246810";
const FAKE_ADB = path.join(SERVER_DIR, "scripts", "fake-adb.mjs");
const AERIAL_PACKAGE = "app.orchard.tv";

const children = [];
let exiting = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanup() {
  if (exiting) return;
  exiting = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // ignore
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

function startProcess(name, args, options) {
  const child = spawn(process.execPath, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const lines = [];
  const absorb = (chunk) => {
    const text = chunk.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) {
        lines.push(line);
        process.stdout.write(`[${name}] ${line}\n`);
      }
    }
  };
  child.stdout.on("data", absorb);
  child.stderr.on("data", absorb);
  child.on("exit", (code) => {
    if (!exiting && code !== 0 && code !== null) console.error(`[${name}] 进程退出 code=${code}`);
  });
  return {
    child,
    lines,
    async waitFor(pattern, timeoutMs = 15000, label = String(pattern)) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = lines.find((line) => pattern.test(line));
        if (hit) return hit;
        await sleep(50);
      }
      throw new Error(`等待超时: ${label}`);
    }
  };
}

async function waitForHttp(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { headers: { "x-casthub-token": CONSOLE_TOKEN } });
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(100);
  }
  throw new Error("服务未就绪: " + url);
}

class ConsoleClient {
  constructor(url) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.messages.push(msg);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        const waiter = this.waiters[i];
        if (waiter.predicate(msg)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(i, 1);
          waiter.resolve(msg);
        }
      }
    });
  }

  static connect(url) {
    const client = new ConsoleClient(url);
    return new Promise((resolve, reject) => {
      client.ws.once("open", () => resolve(client));
      client.ws.once("error", reject);
    });
  }

  send(payload) {
    this.ws.send(JSON.stringify(payload));
  }

  waitFor(predicate, timeoutMs = 10000, label = "消息") {
    const found = this.messages.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("等待超时: " + label));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  mark() {
    return this.messages.length;
  }

  waitForAfter(index, predicate, timeoutMs = 10000, label = "消息") {
    const found = this.messages.slice(index).find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const position = this.waiters.findIndex((w) => w.timer === timer);
        if (position >= 0) this.waiters.splice(position, 1);
        reject(new Error("等待超时: " + label));
      }, timeoutMs);
      this.waiters.push({
        predicate: (message) => this.messages.indexOf(message) >= index && predicate(message),
        resolve,
        timer
      });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error("断言失败: " + message);
  console.log("✓ " + message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function writeReleaseJson(file, apkPath, sha, tag = "e2e-1.0.0") {
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        tag,
        apkName: "aerial-standard.apk",
        apkUrl: pathToFileURL(apkPath).href,
        sizeBytes: fs.statSync(apkPath).size,
        sha256: sha,
        publishedAt: "2026-01-01T00:00:00Z"
      },
      null,
      2
    )
  );
}

function readAdbCalls(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function stepByKey(result, key) {
  return (result.steps ?? []).find((step) => step.key === key);
}

function lastLine(text) {
  const parts = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => line.trim());
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-tv-desktop-"));
  const mediaDir = path.join(tempDir, "media");
  const dataDir = path.join(tempDir, "data-root");
  const apkPath = path.join(tempDir, "aerial-standard.apk");
  const releaseJson = path.join(tempDir, "release.json");
  const modeFile = path.join(tempDir, "adb-mode.txt");
  const adbLog = path.join(tempDir, "adb-calls.log");
  const adbState = path.join(tempDir, "adb-state.json");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "sample.mp4"), Buffer.alloc(64 * 1024, 0x1a));
  const apkBytes = Buffer.concat([Buffer.from("PK-fake-aerial-apk-"), Buffer.alloc(32 * 1024, 0x5a)]);
  fs.writeFileSync(apkPath, apkBytes);
  const apkSha = sha256(apkBytes);
  writeReleaseJson(releaseJson, apkPath, apkSha);
  fs.writeFileSync(modeFile, "ok");
  fs.writeFileSync(
    adbState,
    JSON.stringify({ installed: true, accessibility: "com.example/.Svc:" + AERIAL_PACKAGE + "/.guard.HomeGuardService" })
  );
  console.log("测试临时目录:", tempDir);
  console.log("测试 DATA_DIR:", dataDir);

  console.log("\n[1/8] 启动 fake-tv ...");
  const fakeTv = startProcess("fake-tv", ["scripts/fake-tv.mjs"], {
    cwd: SERVER_DIR,
    env: { ...process.env, FAKE_TV_PORT: String(TV_PORT), FAKE_TV_TOKEN: TV_TOKEN, FAKE_TV_NAME: "Fake TV" }
  });
  await fakeTv.waitFor(/LISTENING/, 10000, "fake-tv 监听");

  console.log("[2/8] 启动中枢（fake adb + 本地 APK）...");
  const serverEnv = {
    ...process.env,
    PORT: String(HTTP_PORT),
    HOST: "127.0.0.1",
    MEDIA_DIR: mediaDir,
    PUBLIC_BASE_URL: "",
    CONSOLE_TOKEN,
    DATA_DIR: dataDir,
    CASTHUB_ADB_PATH: FAKE_ADB,
    AERIAL_RELEASE_JSON: releaseJson,
    FAKE_ADB_MODE_FILE: modeFile,
    FAKE_ADB_LOG: adbLog,
    FAKE_ADB_STATE: adbState
  };
  const server = startProcess("server", ["--import", "tsx", "src/index.ts"], { cwd: SERVER_DIR, env: serverEnv });
  await server.waitFor(/CastHub 已启动/, 20000, "中枢启动");
  await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);

  console.log("[3/8] 连接控制台并读取电视助手信息 ...");
  const consoleClient = await ConsoleClient.connect(`ws://127.0.0.1:${HTTP_PORT}/console?token=${CONSOLE_TOKEN}`);
  await consoleClient.waitFor((m) => m.type === "devices", 5000, "初始 devices");
  consoleClient.send({ type: "addDevice", address: `ws://127.0.0.1:${TV_PORT}`, token: TV_TOKEN });
  const onlineMsg = await consoleClient.waitFor(
    (m) => m.type === "devices" && Array.isArray(m.list) && m.list.some((d) => d.online === true),
    10000,
    "devices(online:true)"
  );
  const device = onlineMsg.list.find((d) => d.online === true);
  assert(!!device, `设备上线: ${device.address}`);

  consoleClient.send({ type: "getDesktopInfo" });
  const info = await consoleClient.waitFor((m) => m.type === "desktopInfo", 20000, "desktopInfo");
  assert(info.adb.available === true, `adb 探测可用: ${info.adb.version} (source=${info.adb.source})`);
  assert(info.adb.path === FAKE_ADB, "adb 路径来自 CASTHUB_ADB_PATH");
  assert(info.release && info.release.tag === "e2e-1.0.0", `发布信息来自 AERIAL_RELEASE_JSON: ${info.release.tag}`);
  assert(info.release.sha256 === apkSha, "发布信息带 sha256 校验值");
  const target = (info.targets ?? []).find((item) => item.deviceId === device.id);
  assert(!!target && target.ip === "127.0.0.1", `目标电视 IP 由设备地址解析: ${target.ip}`);
  assert(info.busy === false, "电视助手初始不忙");
  assert(info.packageName === AERIAL_PACKAGE, "面板显示目标包名 " + info.packageName);

  console.log("[4/8] 已装版本与更新提示（A）+ 刷新绕过缓存（B）...");
  consoleClient.send({ type: "getDesktopInfo", deviceId: device.id });
  const installedInfo = await consoleClient.waitFor(
    (m) => m.type === "desktopInfo" && m.installed && m.installed.deviceId === device.id,
    20000,
    "desktopInfo(installed)"
  );
  assert(installedInfo.installed.installed === true, "读到电视上已装 Aerial: v" + installedInfo.installed.version);
  assert(installedInfo.installed.version === "2.11", "已装版本来自 dumpsys versionName: " + installedInfo.installed.version);
  assert(installedInfo.installed.updateAvailable === false, "非数字 tag 不做版本比较，不误报更新");
  assert(installedInfo.installed.error === null, "已装版本查询无错误");

  // 电视上是 1.0.0、发布页是 2.0.0 → 提示有更新。
  fs.writeFileSync(
    adbState,
    JSON.stringify({
      installed: true,
      accessibility: "com.example/.Svc:" + AERIAL_PACKAGE + "/.guard.HomeGuardService",
      version: "1.0.0",
      versionCode: 100
    })
  );
  writeReleaseJson(releaseJson, apkPath, apkSha, "2.0.0");
  consoleClient.send({ type: "getDesktopInfo", deviceId: device.id, force: true });
  const updateInfo = await consoleClient.waitFor(
    (m) => m.type === "desktopInfo" && m.installed && m.installed.version === "1.0.0",
    20000,
    "desktopInfo(update)"
  );
  assert(updateInfo.installed.updateAvailable === true, "电视版本更旧时提示有新版本: 1.0.0 → " + updateInfo.release.tag);

  // 不传 force 时命中 10 分钟缓存：改发布页也不生效；传 force 立即生效。
  writeReleaseJson(releaseJson, apkPath, apkSha, "3.0.0");
  const cacheMark = consoleClient.mark();
  consoleClient.send({ type: "getDesktopInfo" });
  const cachedInfo = await consoleClient.waitForAfter(
    cacheMark,
    (m) => m.type === "desktopInfo",
    20000,
    "desktopInfo(cached)"
  );
  assert(cachedInfo.release.tag === "2.0.0", "不传 force 时使用 10 分钟发布缓存: " + cachedInfo.release.tag);
  assert(cachedInfo.installed === undefined, "不带 deviceId 时不查询已装版本（不额外跑 adb）");
  const forceMark = consoleClient.mark();
  consoleClient.send({ type: "getDesktopInfo", force: true });
  const forcedInfo = await consoleClient.waitForAfter(
    forceMark,
    (m) => m.type === "desktopInfo",
    20000,
    "desktopInfo(force)"
  );
  assert(forcedInfo.release.tag === "3.0.0", "force=true 绕过缓存拿到最新发布: " + forcedInfo.release.tag);

  // 恢复安装前的状态，后续段落继续按原剧本走。
  fs.writeFileSync(
    adbState,
    JSON.stringify({ installed: true, accessibility: "com.example/.Svc:" + AERIAL_PACKAGE + "/.guard.HomeGuardService" })
  );
  writeReleaseJson(releaseJson, apkPath, apkSha);
  const restoreMark = consoleClient.mark();
  consoleClient.send({ type: "getDesktopInfo", force: true });
  await consoleClient.waitForAfter(
    restoreMark,
    (m) => m.type === "desktopInfo" && m.release && m.release.tag === "e2e-1.0.0",
    20000,
    "desktopInfo(恢复)"
  );

  console.log("[5/8] 一键安装（成功路径）...");
  const progressSeen = [];
  const collectProgress = setInterval(() => {
    for (const msg of consoleClient.messages) {
      if (msg.type === "desktopProgress" && !progressSeen.includes(msg)) progressSeen.push(msg);
    }
  }, 20);
  consoleClient.send({ type: "installDesktop", deviceId: device.id });
  const installResult = await consoleClient.waitFor(
    (m) => m.type === "desktopResult" && m.action === "install",
    60000,
    "desktopResult(install)"
  );
  clearInterval(collectProgress);
  assert(installResult.ok === true, `安装成功: ${installResult.message}`);
  const downloadStep = stepByKey(installResult, "download");
  assert(!!downloadStep && downloadStep.ok === true, "下载步骤成功");
  assert(downloadStep.output.includes(apkSha), "下载步骤输出实际 sha256");
  assert(downloadStep.output.includes(path.join("cache", "tv-desktop")), "APK 缓存写入 DATA_DIR 下的 cache/tv-desktop");
  const connectStep = stepByKey(installResult, "connect");
  assert(connectStep.command === "adb connect 127.0.0.1:5555", "connect 步骤命令: " + connectStep.command);
  const installStep = stepByKey(installResult, "install");
  assert(installStep.ok === true, "install 步骤成功: " + lastLine(installStep.output));
  assert(installStep.command.includes("install -r"), "install 步骤命令含 -r");
  const appopsStep = stepByKey(installResult, "appops-overlay");
  assert(!!appopsStep && appopsStep.required === false, "appops 步骤标记为可选（失败不中断）");
  const notificationStep = stepByKey(installResult, "notification-listener");
  assert(
    notificationStep.command.includes("app.orchard.tv/app.orchard.tv.guard.RevivalListener"),
    "通知监听命令使用官方组件名"
  );
  assert(installResult.verification.homeLauncher === true, "验收：默认桌面已切到 Aerial");
  assert(installResult.verification.accessibility === true, "验收：无障碍守护已启用");
  assert(installResult.verification.focus === true, "验收：前台窗口是 Aerial");
  assert(installResult.steps.filter((step) => step.required).length === 4, "必需步骤共 4 条（下载 + connect + state + install）");
  assert(installResult.steps.length >= 18, "步骤总数含 14 条可选授权步骤: " + installResult.steps.length);
  assert(progressSeen.length === 0, "file:// APK 不产生下载进度事件（体积小，一次性复制）");
  const calls = readAdbCalls(adbLog);
  assert(calls.length >= 18, "fake adb 收到 " + calls.length + " 次调用");
  assert(
    calls.some((call) => call.args[0] === "version"),
    "fake adb 处理了 version 探测"
  );

  console.log("[6/8] 未授权路径（unauthorized）...");
  fs.writeFileSync(modeFile, "unauthorized");
  consoleClient.send({ type: "installDesktop", deviceId: device.id });
  const unauthorizedResult = await consoleClient.waitFor(
    (m) => m.type === "desktopResult" && m.action === "install" && m.ok === false,
    60000,
    "desktopResult(unauthorized)"
  );
  assert(unauthorizedResult.message.includes("未授权"), "未授权提示: " + unauthorizedResult.message);
  assert(stepByKey(unauthorizedResult, "state").ok === false, "get-state 步骤被判定失败");
  assert(!stepByKey(unauthorizedResult, "install"), "未授权时不继续执行 install");

  console.log("[7/8] 厂商拒绝（INSTALL_FAILED_USER_RESTRICTED）与自定义地址拒绝 ...");
  fs.writeFileSync(modeFile, "user-restricted");
  consoleClient.send({ type: "installDesktop", deviceId: device.id });
  const restrictedResult = await consoleClient.waitFor(
    (m) => m.type === "desktopResult" && m.action === "install" && m.ok === false && m.message.includes("USB 安装"),
    60000,
    "desktopResult(user-restricted)"
  );
  assert(restrictedResult.ok === false, "安装被电视拒绝: " + restrictedResult.message);
  assert(stepByKey(restrictedResult, "install").ok === false, "install 步骤输出 Failure 被识别");
  assert(!stepByKey(restrictedResult, "grant-location"), "install 失败后不执行后续授权步骤");
  fs.writeFileSync(modeFile, "ok");
  const callsBefore = readAdbCalls(adbLog).length;
  consoleClient.send({ type: "installDesktop", deviceId: device.id, apkUrl: pathToFileURL(apkPath).href });
  const customUrlResult = await consoleClient.waitFor(
    (m) => m.type === "desktopResult" && m.action === "install" && m.ok === false && m.message.includes("https"),
    30000,
    "desktopResult(custom url)"
  );
  assert(customUrlResult.message.includes("https://"), "自定义地址仅允许 https: " + customUrlResult.message);
  assert(readAdbCalls(adbLog).length === callsBefore, "自定义地址被拒时没有执行 adb");

  console.log("[8/8] 还原（最小步骤）与忙时拒绝 ...");
  fs.writeFileSync(modeFile, "slow");
  const slowMark = consoleClient.mark();
  consoleClient.send({ type: "installDesktop", deviceId: device.id });
  await sleep(400);
  consoleClient.send({ type: "uninstallDesktop", deviceId: device.id });
  const busyError = await consoleClient.waitForAfter(
    slowMark,
    (m) => m.type === "error" && String(m.message).includes("正忙"),
    20000,
    "error(正忙)"
  );
  assert(busyError.message.includes("正忙"), "并发任务被拒绝: " + busyError.message);
  await consoleClient.waitForAfter(
    slowMark,
    (m) => m.type === "desktopResult" && m.action === "install" && m.ok === true,
    60000,
    "desktopResult(slow install 完成)"
  );
  fs.writeFileSync(modeFile, "ok");
  const uninstallMark = consoleClient.mark();
  consoleClient.send({ type: "uninstallDesktop", deviceId: device.id });
  const uninstallResult = await consoleClient.waitForAfter(
    uninstallMark,
    (m) => m.type === "desktopResult" && m.action === "uninstall",
    60000,
    "desktopResult(uninstall)"
  );
  assert(uninstallResult.ok === true, `还原成功: ${uninstallResult.message}`);
  const removeRole = stepByKey(uninstallResult, "remove-role");
  assert(removeRole.command.includes("remove-role-holder"), "还原包含解除默认桌面角色: " + removeRole.command);
  assert(!!stepByKey(uninstallResult, "accessibility-cleanup"), "还原清理了无障碍守护项");
  assert(stepByKey(uninstallResult, "uninstall").ok === true, "卸载步骤成功");
  assert(uninstallResult.verification.homeLauncher === true, "验收：Aerial 已不在包列表");
  assert(!uninstallResult.verification.focus, "验收：前台不再是 Aerial");
  const stateAfter = JSON.parse(fs.readFileSync(adbState, "utf8"));
  assert(stateAfter.installed === false, "fake 设备状态已变为未安装");
  assert(stateAfter.accessibility === "com.example/.Svc", "无障碍列表已剔除 Aerial 守护项: " + stateAfter.accessibility);

  consoleClient.close();
  console.log("\n✅ E2E-TV-DESKTOP 全部通过");
}

main()
  .then(() => {
    cleanup();
    setTimeout(() => process.exit(0), 300);
  })
  .catch((error) => {
    console.error("\n❌ E2E-TV-DESKTOP 失败:", error.message);
    cleanup();
    setTimeout(() => process.exit(1), 300);
  });
