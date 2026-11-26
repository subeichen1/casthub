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
const HONGGUO_PACKAGE = "rocks.aston.hongguotv";
const HONGGUO_MPV_PACKAGE = "rocks.aston.hongguotv.mpv";
const TVBOX_PACKAGE = "com.github.tvbox.osc.jun";

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

function writeHongguoRelease(file, apkPath, sha, options = {}) {
  const payload = {
    apkUrl: pathToFileURL(apkPath).href,
    apkName: options.apkName ?? "hongguo-tv-0.2.182.apk",
    tag: options.tag ?? "0.2.182",
    sizeBytes: fs.statSync(apkPath).size,
    sha256: sha,
    publishedAt: "2026-11-25T12:21:17Z"
  };
  // 带上 variant 时只对该变体生效，用来验证变体过滤。
  if (options.variant) payload.variant = options.variant;
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
}

function writeTvboxRelease(file, apkPath, sha, options = {}) {
  const payload = {
    apkUrl: pathToFileURL(apkPath).href,
    apkName: options.apkName ?? "TVBox_q215613905_20261111-1518-java.apk",
    tag: options.tag ?? "20261111-1518",
    sizeBytes: fs.statSync(apkPath).size,
    sha256: sha,
    publishedAt: "2026-11-12T02:09:51Z"
  };
  if (options.variant) payload.variant = options.variant;
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
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
  // 红果短剧：三个变体各一个假 APK，文件名要能命中 fake-adb 的包名推断前缀。
  const hongguoApks = {
    standard: path.join(tempDir, "hongguo-standard.apk"),
    mpv: path.join(tempDir, "hongguo-mpv.apk"),
    android5: path.join(tempDir, "hongguo-android5.apk")
  };
  const hongguoReleaseJson = path.join(tempDir, "hongguo-release.json");
  // TVBox：六个变体共用一个包名，假 APK 文件名前缀 tvbox 会被 fake-adb 推断成 com.github.tvbox.osc.jun。
  const tvboxApk = path.join(tempDir, "tvbox-java.apk");
  const tvboxReleaseJson = path.join(tempDir, "tvbox-release.json");
  const modeFile = path.join(tempDir, "adb-mode.txt");
  const adbLog = path.join(tempDir, "adb-calls.log");
  const adbState = path.join(tempDir, "adb-state.json");
  fs.mkdirSync(mediaDir, { recursive: true });
  fs.writeFileSync(path.join(mediaDir, "sample.mp4"), Buffer.alloc(64 * 1024, 0x1a));
  const apkBytes = Buffer.concat([Buffer.from("PK-fake-aerial-apk-"), Buffer.alloc(32 * 1024, 0x5a)]);
  fs.writeFileSync(apkPath, apkBytes);
  const apkSha = sha256(apkBytes);
  writeReleaseJson(releaseJson, apkPath, apkSha);
  const hongguoBytes = Buffer.concat([Buffer.from("PK-fake-hongguo-apk-"), Buffer.alloc(48 * 1024, 0x5b)]);
  for (const file of Object.values(hongguoApks)) fs.writeFileSync(file, hongguoBytes);
  const hongguoSha = sha256(hongguoBytes);
  writeHongguoRelease(hongguoReleaseJson, hongguoApks.standard, hongguoSha);
  const tvboxBytes = Buffer.concat([Buffer.from("PK-fake-tvbox-apk-"), Buffer.alloc(40 * 1024, 0x5c)]);
  fs.writeFileSync(tvboxApk, tvboxBytes);
  const tvboxSha = sha256(tvboxBytes);
  writeTvboxRelease(tvboxReleaseJson, tvboxApk, tvboxSha);
  fs.writeFileSync(modeFile, "ok");
  fs.writeFileSync(
    adbState,
    JSON.stringify({ installed: true, accessibility: "com.example/.Svc:" + AERIAL_PACKAGE + "/.guard.HomeGuardService" })
  );
  console.log("测试临时目录:", tempDir);
  console.log("测试 DATA_DIR:", dataDir);

  console.log("\n[1/10] 启动 fake-tv ...");
  const fakeTv = startProcess("fake-tv", ["scripts/fake-tv.mjs"], {
    cwd: SERVER_DIR,
    env: { ...process.env, FAKE_TV_PORT: String(TV_PORT), FAKE_TV_TOKEN: TV_TOKEN, FAKE_TV_NAME: "Fake TV" }
  });
  await fakeTv.waitFor(/LISTENING/, 10000, "fake-tv 监听");

  console.log("[2/10] 启动中枢（fake adb + 本地 APK）...");
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
    HONGGUO_RELEASE_JSON: hongguoReleaseJson,
    TVBOX_RELEASE_JSON: tvboxReleaseJson,
    FAKE_ADB_MODE_FILE: modeFile,
    FAKE_ADB_LOG: adbLog,
    FAKE_ADB_STATE: adbState
  };
  const server = startProcess("server", ["--import", "tsx", "src/index.ts"], { cwd: SERVER_DIR, env: serverEnv });
  await server.waitFor(/CastHub 已启动/, 20000, "中枢启动");
  await waitForHttp(`http://127.0.0.1:${HTTP_PORT}/api/files?path=`);

  console.log("[3/10] 连接控制台并读取电视助手信息 ...");
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

  console.log("[4/10] 已装版本与更新提示（A）+ 刷新绕过缓存（B）...");
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

  console.log("[5/10] 一键安装（成功路径）...");
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

  console.log("[6/10] 未授权路径（unauthorized）...");
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

  console.log("[7/10] 厂商拒绝（INSTALL_FAILED_USER_RESTRICTED）与自定义地址拒绝 ...");
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

  console.log("[8/10] 还原（最小步骤）与忙时拒绝 ...");
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


  console.log("[9/10] 红果短剧：应用目录、变体、安装/更新提示/共存/卸载 ...");
  const appsMark = consoleClient.mark();
  consoleClient.send({ type: "getDesktopInfo", appId: "hongguo", force: true });
  const hongguoInfo = await consoleClient.waitForAfter(
    appsMark,
    (m) => m.type === "desktopInfo" && m.activeAppId === "hongguo",
    20000,
    "desktopInfo(hongguo)"
  );
  assert((hongguoInfo.apps ?? []).length === 3, "应用目录列出 Aerial、红果与 TVBox: " + hongguoInfo.apps.map((a) => a.id).join(","));
  assert(hongguoInfo.appName.includes("红果"), "面板应用名: " + hongguoInfo.appName);
  assert(hongguoInfo.installKind === "app", "红果按普通应用安装（不接管桌面）");
  assert(hongguoInfo.packageName === HONGGUO_PACKAGE, "默认变体包名 " + hongguoInfo.packageName);
  const hongguoApp = hongguoInfo.apps.find((a) => a.id === "hongguo");
  assert((hongguoApp.variants ?? []).length === 3, "红果提供三个变体: " + hongguoApp.variants.map((v) => v.id).join(","));
  assert(hongguoApp.defaultVariant === "standard", "默认变体是标准版");
  assert(hongguoInfo.release && hongguoInfo.release.tag === "0.2.182", "红果发布信息来自 HONGGUO_RELEASE_JSON: " + hongguoInfo.release.tag);
  assert(hongguoInfo.release.sha256 === hongguoSha, "红果发布信息带 sha256 校验值");
  assert(hongguoInfo.release.variantId === "standard", "发布信息绑定当前变体: " + hongguoInfo.release.variantId);

  // 变体切换：mpv 版是独立包名。
  const mpvMark = consoleClient.mark();
  consoleClient.send({ type: "getDesktopInfo", appId: "hongguo", variantId: "mpv" });
  const mpvInfo = await consoleClient.waitForAfter(
    mpvMark,
    (m) => m.type === "desktopInfo" && m.variantId === "mpv",
    20000,
    "desktopInfo(hongguo/mpv)"
  );
  assert(mpvInfo.packageName === HONGGUO_MPV_PACKAGE, "mpv 变体包名独立: " + mpvInfo.packageName);
  assert(mpvInfo.variantName.includes("MPV"), "变体名: " + mpvInfo.variantName);

  // 发布注入带 variant 时只对该变体生效，避免装错包。
  writeHongguoRelease(hongguoReleaseJson, hongguoApks.mpv, hongguoSha, { variant: "mpv", apkName: "hongguo-tv-mpv-0.2.182.apk" });
  const filteredMark = consoleClient.mark();
  consoleClient.send({ type: "getDesktopInfo", appId: "hongguo", variantId: "standard", force: true });
  const filteredInfo = await consoleClient.waitForAfter(
    filteredMark,
    (m) => m.type === "desktopInfo" && m.variantId === "standard" && m.release === null,
    20000,
    "desktopInfo(variant 过滤)"
  );
  assert(!!filteredInfo.releaseError && filteredInfo.releaseError.includes("variant"), "变体不匹配时不套用别的安装包: " + filteredInfo.releaseError);
  writeHongguoRelease(hongguoReleaseJson, hongguoApks.standard, hongguoSha);

  // 电视上已装 0.2.100、发布页是 0.2.182 → 提示可更新。
  fs.writeFileSync(
    adbState,
    JSON.stringify({
      packages: { [HONGGUO_PACKAGE]: { version: "0.2.100", versionCode: 100 } },
      accessibility: "com.example/.Svc",
      focus: HONGGUO_PACKAGE
    })
  );
  const hongguoInstalledMark = consoleClient.mark();
  consoleClient.send({ type: "getDesktopInfo", appId: "hongguo", deviceId: device.id, force: true });
  const hongguoInstalled = await consoleClient.waitForAfter(
    hongguoInstalledMark,
    (m) => m.type === "desktopInfo" && m.installed && m.installed.appId === "hongguo",
    20000,
    "desktopInfo(hongguo installed)"
  );
  assert(hongguoInstalled.installed.installed === true, "读到电视上已装红果: v" + hongguoInstalled.installed.version);
  assert(hongguoInstalled.installed.packageName === HONGGUO_PACKAGE, "已装查询用红果包名: " + hongguoInstalled.installed.packageName);
  assert(hongguoInstalled.installed.updateAvailable === true, "红果版本更旧时提示更新: 0.2.100 → " + hongguoInstalled.release.tag);

  // 标准版安装：只有下载/connect/state/install 必需步骤，不碰桌面与无障碍。
  const hongguoInstallMark = consoleClient.mark();
  consoleClient.send({ type: "installDesktop", deviceId: device.id, appId: "hongguo" });
  const hongguoInstall = await consoleClient.waitForAfter(
    hongguoInstallMark,
    (m) => m.type === "desktopResult" && m.action === "install" && m.appId === "hongguo",
    60000,
    "desktopResult(hongguo install)"
  );
  assert(hongguoInstall.ok === true, "红果安装成功: " + hongguoInstall.message);
  assert(hongguoInstall.packageName === HONGGUO_PACKAGE, "安装结果带包名: " + hongguoInstall.packageName);
  assert(hongguoInstall.steps.filter((step) => step.required).length === 4, "红果必需步骤 4 条（下载 + connect + state + install）");
  assert(hongguoInstall.steps.length === 6, "红果不跑桌面/无障碍授权步骤，共 " + hongguoInstall.steps.length + " 步（下载 + connect + state + install + 启动 + 预编译）");
  assert(!stepByKey(hongguoInstall, "appops-overlay"), "红果安装不申请悬浮窗等桌面权限");
  assert(!stepByKey(hongguoInstall, "remove-role"), "红果安装不涉及默认桌面角色");
  const launchStep = stepByKey(hongguoInstall, "launch");
  assert(
    launchStep.command.includes("rocks.aston.hongguotv/.MainActivity"),
    "安装后启动红果主界面: " + launchStep.command
  );
  const hongguoDownload = stepByKey(hongguoInstall, "download");
  assert(hongguoDownload.output.includes(path.join("cache", "tv-desktop")), "红果 APK 也缓存到 cache/tv-desktop");
  assert(hongguoInstall.verification.homeLauncher === true, "验收：红果已在包列表里");
  assert(hongguoInstall.verification.accessibility === false, "验收：红果不涉及无障碍（恒 false）");
  const hongguoState = JSON.parse(fs.readFileSync(adbState, "utf8"));
  assert(!!hongguoState.packages[HONGGUO_PACKAGE], "fake 设备上已记录红果包");
  assert(!hongguoState.packages[AERIAL_PACKAGE], "安装红果没有顺带装上 Aerial");

  const afterInstallMark = consoleClient.mark();
  consoleClient.send({ type: "getDesktopInfo", appId: "hongguo", deviceId: device.id, force: true });
  const hongguoAfter = await consoleClient.waitForAfter(
    afterInstallMark,
    (m) => m.type === "desktopInfo" && m.installed && m.installed.appId === "hongguo" && m.installed.version === "1.0.0",
    20000,
    "desktopInfo(hongguo 安装后)"
  );
  assert(hongguoAfter.installed.updateAvailable === false, "装完最新版后不再提示更新");

  // MPV 变体是独立包名，可与标准版共存。
  const mpvInstallMark = consoleClient.mark();
  consoleClient.send({ type: "installDesktop", deviceId: device.id, appId: "hongguo", variantId: "mpv" });
  const mpvInstall = await consoleClient.waitForAfter(
    mpvInstallMark,
    (m) => m.type === "desktopResult" && m.action === "install" && m.variantId === "mpv",
    60000,
    "desktopResult(hongguo mpv)"
  );
  assert(mpvInstall.ok === true, "MPV 版安装成功: " + mpvInstall.message);
  assert(mpvInstall.packageName === HONGGUO_MPV_PACKAGE, "MPV 版包名: " + mpvInstall.packageName);
  const coexistState = JSON.parse(fs.readFileSync(adbState, "utf8"));
  assert(
    !!coexistState.packages[HONGGUO_PACKAGE] && !!coexistState.packages[HONGGUO_MPV_PACKAGE],
    "标准版与 MPV 版共存: " + Object.keys(coexistState.packages).join(",")
  );

  // 卸载标准版不影响 MPV 版。
  const hongguoUninstallMark = consoleClient.mark();
  consoleClient.send({ type: "uninstallDesktop", deviceId: device.id, appId: "hongguo" });
  const hongguoUninstall = await consoleClient.waitForAfter(
    hongguoUninstallMark,
    (m) => m.type === "desktopResult" && m.action === "uninstall" && m.appId === "hongguo",
    60000,
    "desktopResult(hongguo uninstall)"
  );
  assert(hongguoUninstall.ok === true, "红果卸载成功: " + hongguoUninstall.message);
  assert(stepByKey(hongguoUninstall, "uninstall").command.includes(HONGGUO_PACKAGE), "卸载命令用红果包名");
  assert(!stepByKey(hongguoUninstall, "remove-role"), "红果卸载不解除默认桌面角色");
  assert(!stepByKey(hongguoUninstall, "accessibility-cleanup"), "红果卸载不清无障碍");
  assert(hongguoUninstall.verification.homeLauncher === true, "验收：红果已不在包列表");
  const finalState = JSON.parse(fs.readFileSync(adbState, "utf8"));
  assert(!finalState.packages[HONGGUO_PACKAGE], "fake 设备上红果标准版已卸载");
  assert(!!finalState.packages[HONGGUO_MPV_PACKAGE], "卸载标准版不影响 MPV 版: " + Object.keys(finalState.packages).join(","));

  console.log("[10/10] TVBox：共享包名应用目录、六变体、先卸旧包再安装、卸载 ...");
  const tvboxMark = consoleClient.mark();
  consoleClient.send({ type: "getDesktopInfo", appId: "tvbox", force: true });
  const tvboxInfo = await consoleClient.waitForAfter(
    tvboxMark,
    (m) => m.type === "desktopInfo" && m.activeAppId === "tvbox",
    20000,
    "desktopInfo(tvbox)"
  );
  assert(tvboxInfo.appName.includes("TVBox"), "面板应用名: " + tvboxInfo.appName);
  assert(tvboxInfo.installKind === "app", "TVBox 按普通应用安装（不接管桌面）");
  const tvboxApp = (tvboxInfo.apps ?? []).find((a) => a.id === "tvbox");
  assert(tvboxApp.sharedPackage === true, "TVBox 标记为多变体共用包名");
  const hongguoSummary = (tvboxInfo.apps ?? []).find((a) => a.id === "hongguo");
  assert(hongguoSummary.sharedPackage === false, "红果三变体包名互不相同，不标记共享包名");
  assert((tvboxApp.variants ?? []).length === 6, "TVBox 提供六个变体: " + tvboxApp.variants.map((v) => v.id).join(","));
  assert(tvboxApp.defaultVariant === "java", "TVBox 默认变体是 Java 标准版");
  assert(
    new Set(tvboxApp.variants.map((v) => v.packageName)).size === 1,
    "六个变体共用包名: " + tvboxApp.variants[0].packageName
  );
  assert(tvboxInfo.release && tvboxInfo.release.tag === "20261111-1518", "TVBox 发布信息来自 TVBOX_RELEASE_JSON: " + tvboxInfo.release.tag);
  assert(tvboxInfo.release.sha256 === tvboxSha, "TVBox 发布信息带 sha256 校验值");
  assert(tvboxInfo.release.apkName.endsWith("-java.apk"), "默认变体取 java 资产: " + tvboxInfo.release.apkName);

  // 时间戳版本号也能比较：电视上已装更早的日期构建 → 提示可更新。
  fs.writeFileSync(
    adbState,
    JSON.stringify({
      packages: { [TVBOX_PACKAGE]: { version: "20261110-0900", versionCode: 1 } },
      accessibility: "com.example/.Svc",
      focus: TVBOX_PACKAGE
    })
  );
  const tvboxInstalledMark = consoleClient.mark();
  consoleClient.send({ type: "getDesktopInfo", appId: "tvbox", deviceId: device.id, force: true });
  const tvboxInstalled = await consoleClient.waitForAfter(
    tvboxInstalledMark,
    (m) => m.type === "desktopInfo" && m.installed && m.installed.appId === "tvbox",
    20000,
    "desktopInfo(tvbox installed)"
  );
  assert(tvboxInstalled.installed.installed === true, "读到电视上已装 TVBox: " + tvboxInstalled.installed.version);
  assert(
    tvboxInstalled.installed.updateAvailable === true,
    "时间戳版本号可比较，提示更新: 20261110-0900 → " + tvboxInstalled.release.tag
  );

  const tvboxInstallMark = consoleClient.mark();
  consoleClient.send({ type: "installDesktop", deviceId: device.id, appId: "tvbox" });
  const tvboxInstall = await consoleClient.waitForAfter(
    tvboxInstallMark,
    (m) => m.type === "desktopResult" && m.action === "install" && m.appId === "tvbox",
    60000,
    "desktopResult(tvbox install)"
  );
  assert(tvboxInstall.ok === true, "TVBox 安装成功: " + tvboxInstall.message);
  assert(tvboxInstall.packageName === TVBOX_PACKAGE, "安装结果包名: " + tvboxInstall.packageName);
  const tvboxUninstallOld = stepByKey(tvboxInstall, "uninstall-old");
  assert(!!tvboxUninstallOld, "共享包名应用先卸载同包名旧版本");
  assert(
    tvboxUninstallOld.command.includes("uninstall " + TVBOX_PACKAGE),
    "卸载命令针对共享包名: " + tvboxUninstallOld.command
  );
  assert(tvboxUninstallOld.required === false, "卸旧包是尽力而为步骤（本来就没装也能继续）");
  const tvboxLaunch = stepByKey(tvboxInstall, "launch");
  assert(
    tvboxLaunch.command.includes("com.github.tvbox.osc.jun/com.github.tvbox.osc.ui.activity.HomeActivity"),
    "安装后启动 TVBox 主界面: " + tvboxLaunch.command
  );
  const tvboxState = JSON.parse(fs.readFileSync(adbState, "utf8"));
  assert(!!tvboxState.packages[TVBOX_PACKAGE], "fake 设备上已记录 TVBox 包");
  assert(tvboxState.packages[TVBOX_PACKAGE].version === "1.0.0", "安装后电视上的版本号来自 APK（fake adb 记为 1.0.0）");

  const tvboxUninstallMark = consoleClient.mark();
  consoleClient.send({ type: "uninstallDesktop", deviceId: device.id, appId: "tvbox" });
  const tvboxUninstall = await consoleClient.waitForAfter(
    tvboxUninstallMark,
    (m) => m.type === "desktopResult" && m.action === "uninstall" && m.appId === "tvbox",
    60000,
    "desktopResult(tvbox uninstall)"
  );
  assert(tvboxUninstall.ok === true, "TVBox 卸载成功: " + tvboxUninstall.message);
  assert(stepByKey(tvboxUninstall, "uninstall").command.includes(TVBOX_PACKAGE), "卸载命令用 TVBox 包名");
  assert(!stepByKey(tvboxUninstall, "remove-role"), "TVBox 卸载不解除默认桌面角色");
  const tvboxFinalState = JSON.parse(fs.readFileSync(adbState, "utf8"));
  assert(!tvboxFinalState.packages[TVBOX_PACKAGE], "fake 设备上 TVBox 已卸载");

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
