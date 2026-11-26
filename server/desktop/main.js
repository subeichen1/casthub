// CastHub 桌面壳：起进程 → 起 server → 开窗口加载 http://127.0.0.1:9420
// 业务逻辑全部在 ../dist/index.js 的 startServer 中，本文件只做壳层编排。
const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, net: electronNet } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_GITHUB_MIRRORS,
  downloadFile,
  fetchLatestReleaseFallback,
  normalizeRepoSlug,
  normalizeSha256,
  parseChecksums,
  pickUpdateAssets,
  sha256File,
  writeUpdateHelperScript,
} = require("./updater");

const DEFAULT_PORT = 9420;
const APP_ICON = path.join(__dirname, "assets", "icon.ico");
const TRAY_ICON = path.join(__dirname, "assets", "icon-32.png");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_LOG_PATH = path.join(os.tmpdir(), "casthub-update.log");
const DEFAULT_DESKTOP_SETTINGS = {
  autoStart: false,
  updateRepo: "subeichen1/casthub",
  updateSignerSubject: "CN=CastHub Development*",
};

let mainWindow = null;
let tray = null;
let serverHandle = null;
let isQuitting = false;
let appRootPath = null;
let mainWindowUrl = "";
let updateTimer = null;
let updateInfo = null;
let updateInProgress = false;

function resolveAppRoot() {
  if (app.isPackaged) {
    // portable 目标会先解压到 %TEMP%，exe 所在目录只能从该变量取（坑位 1）
    return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  }
  // 开发模式：server/ 目录（package.json 所在目录）
  return path.resolve(__dirname, "..");
}

function resolveAutoStartPath() {
  // portable 版主进程从 %TEMP% 解压目录启动，process.execPath 不是 exe 本体；
  // PORTABLE_EXECUTABLE_FILE 由 electron-builder portable 目标注入，指向用户双击的 exe。
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

function logToFile(appRoot, message) {
  if (!app.isPackaged) {
    console.error(message);
    return;
  }
  try {
    const logPath = path.join(appRoot, "casthub.log");
    try {
      if (fs.statSync(logPath).size >= MAX_LOG_BYTES) {
        fs.rmSync(logPath + ".3", { force: true });
        if (fs.existsSync(logPath + ".2")) fs.renameSync(logPath + ".2", logPath + ".3");
        if (fs.existsSync(logPath + ".1")) fs.renameSync(logPath + ".1", logPath + ".2");
        fs.renameSync(logPath, logPath + ".1");
      }
    } catch {
      // 文件尚不存在或轮转失败时继续追加
    }
    fs.appendFileSync(logPath, "[" + new Date().toISOString() + "] " + message + "\n", "utf8");
  } catch {
    // 日志写不进去不能影响主流程
  }
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(600);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => resolve(false));
  });
}

function configPath(appRoot) {
  return path.join(appRoot, "config.json");
}

function readConfigObject(appRoot) {
  const filePath = configPath(appRoot);
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  } catch (error) {
    if (error && error.code === "ENOENT") return {};
    throw new Error("无法读取配置 " + filePath + ": " + (error && error.message ? error.message : String(error)));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("解析配置 " + filePath + " 失败: " + (error && error.message ? error.message : String(error)));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("配置 " + filePath + " 必须是 JSON 对象");
  }
  return parsed;
}

function readDesktopSettings(appRoot) {
  try {
    const obj = readConfigObject(appRoot);
    const desktop = obj.desktop && typeof obj.desktop === "object" && !Array.isArray(obj.desktop) ? obj.desktop : {};
    return {
      autoStart: desktop.autoStart === true,
      updateRepo:
        typeof desktop.updateRepo === "string" && desktop.updateRepo.trim()
          ? desktop.updateRepo.trim()
          : DEFAULT_DESKTOP_SETTINGS.updateRepo,
      updateSignerSubject:
        typeof desktop.updateSignerSubject === "string" && desktop.updateSignerSubject.trim()
          ? desktop.updateSignerSubject.trim()
          : DEFAULT_DESKTOP_SETTINGS.updateSignerSubject,
    };
  } catch (error) {
    logToFile(appRoot, "DESKTOP_CONFIG_READ_FAILED " + (error && error.message ? error.message : String(error)));
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

function saveDesktopSettings(appRoot, patch) {
  const obj = readConfigObject(appRoot);
  const current = obj.desktop && typeof obj.desktop === "object" && !Array.isArray(obj.desktop) ? obj.desktop : {};
  obj.desktop = { ...current, ...patch };
  const target = configPath(appRoot);
  const temp = target + ".tmp-" + process.pid + "-" + Date.now();
  try {
    fs.writeFileSync(temp, JSON.stringify(obj, null, 2) + "\n", "utf8");
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // 清理临时文件失败不影响原配置。
    }
    throw error;
  }
  return readDesktopSettings(appRoot);
}

function compareVersions(left, right) {
  function parse(value) {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || "").trim());
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
}

function showNotification(title, body, appRoot) {
  if (!Notification.isSupported()) {
    logToFile(appRoot, "NOTIFICATION_UNSUPPORTED " + title);
    return;
  }
  try {
    new Notification({ title, body }).show();
    logToFile(appRoot, "NOTIFICATION_SHOWN " + title);
  } catch (error) {
    logToFile(appRoot, "NOTIFICATION_FAILED " + (error && error.message ? error.message : String(error)));
  }
}

function showMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return;
  }
  if (!mainWindowUrl) return;
  createWindow();
  mainWindow.loadURL(mainWindowUrl).catch((error) => {
    logToFile(
      appRootPath || resolveAppRoot(),
      "WINDOW_RELOAD_FAILED " + (error && error.message ? error.message : String(error)),
    );
  });
}

function rebuildTrayMenu() {
  if (!tray || !appRootPath) return;
  const settings = readDesktopSettings(appRootPath);
  const template = [
    { label: "显示 CastHub", click: showMainWindow },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: settings.autoStart,
      click: () => {
        // 单一数据源是 config.json：点击时读文件再反转，不维护内存副本
        const current = readDesktopSettings(appRootPath).autoStart;
        applyAutoStart(!current);
      },
    },
    {
      label: "检查更新",
      click: () => {
        checkForUpdates({ manual: true }).catch((error) => {
          logToFile(appRootPath, "UPDATE_CHECK_FAILED " + (error && error.message ? error.message : String(error)));
        });
      },
    },
  ];
  if (updateInfo) {
    template.push({
      label: updateInProgress ? "正在更新…" : "立即更新…",
      enabled: !updateInProgress,
      click: () => {
        if (updateInProgress) return;
        installUpdate().catch((error) => {
          logToFile(appRootPath, "UPDATE_INSTALL_FAILED " + (error && error.message ? error.message : String(error)));
        });
      },
    });
  }
  template.push({ type: "separator" });
  template.push({ label: "退出", click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray(appRoot) {
  if (tray) return;
  try {
    let image = nativeImage.createFromPath(TRAY_ICON);
    if (image.isEmpty()) {
      logToFile(appRoot, "TRAY_ICON_MISSING " + TRAY_ICON);
      image = nativeImage.createFromPath(APP_ICON);
    }
    tray = new Tray(image);
    tray.setToolTip("CastHub");
    tray.on("click", showMainWindow);
    rebuildTrayMenu();
    logToFile(appRoot, "TRAY_READY");
  } catch (error) {
    logToFile(appRoot, "TRAY_CREATE_FAILED " + (error && error.message ? error.message : String(error)));
  }
}

function syncAutoStart(appRoot) {
  const settings = readDesktopSettings(appRoot);
  const autoStartPath = resolveAutoStartPath();
  try {
    app.setLoginItemSettings({ openAtLogin: settings.autoStart, path: autoStartPath });
    logToFile(appRoot, "AUTOSTART_SYNC enabled=" + settings.autoStart + " path=" + autoStartPath);
  } catch (error) {
    logToFile(appRoot, "AUTOSTART_SYNC_FAILED " + (error && error.message ? error.message : String(error)));
  }
}

function applyAutoStart(enabled) {
  if (!appRootPath) return { ok: false, autoStart: false, error: "app not ready" };
  const previous = readDesktopSettings(appRootPath);
  const next = Boolean(enabled);
  const autoStartPath = resolveAutoStartPath();
  try {
    app.setLoginItemSettings({ openAtLogin: next, path: autoStartPath });
    saveDesktopSettings(appRootPath, { autoStart: next });
    logToFile(appRootPath, "AUTOSTART_SET enabled=" + next + " path=" + autoStartPath);
    rebuildTrayMenu();
    return { ok: true, autoStart: next };
  } catch (error) {
    try {
      app.setLoginItemSettings({ openAtLogin: previous.autoStart, path: autoStartPath });
    } catch {
      // 回滚失败也不能影响页面响应
    }
    const message = error && error.message ? error.message : String(error);
    logToFile(appRootPath, "AUTOSTART_SET_FAILED " + message);
    return { ok: false, autoStart: previous.autoStart, error: message };
  }
}

function updateEndpoint(repo) {
  if (/^https?:\/\//i.test(repo)) return repo;
  return "https://api.github.com/repos/" + repo.replace(/^\/+|\/+$/g, "") + "/releases/latest";
}

function safeUpdateCacheName(value) {
  return (
    String(value || "latest")
      .replace(/[^a-zA-Z0-9._-]+/g, "_")
      .slice(0, 48) || "latest"
  );
}

/**
 * 桌面更新复用服务端 network 配置：优先使用编译后的 network-config/network-fetch，
 * 开发环境尚未 build 时退化为全局 fetch（不阻断原有更新逻辑）。
 */
function createUpdateNetwork(appRoot) {
  let config = null;
  try {
    const { readStoredNetworkConfig, resolveNetworkConfig } = require("../dist/network-config.js");
    config = resolveNetworkConfig(readStoredNetworkConfig(appRoot), process.env);
  } catch (error) {
    logToFile(appRoot, "UPDATE_NETWORK_CONFIG_FALLBACK " + (error && error.message ? error.message : String(error)));
    return { fetch: (...args) => globalThis.fetch(...args), config: { githubMirror: "" }, close: async () => {} };
  }
  try {
    const { NetworkClient } = require("../dist/network-fetch.js");
    const client = new NetworkClient(config);
    return { fetch: client.fetch, config, close: () => client.close() };
  } catch (error) {
    logToFile(appRoot, "UPDATE_NETWORK_CLIENT_FALLBACK " + (error && error.message ? error.message : String(error)));
    return { fetch: (...args) => globalThis.fetch(...args), config, close: async () => {} };
  }
}

/** 判断当前网络配置是否经过显式代理或环境代理；只有此时才需要额外尝试电脑默认线路。 */
function hasConfiguredProxy(config) {
  return Boolean(config && (config.proxy || config.useEnvProxy));
}

/** 创建完全绕过代理的直连客户端，用于所有代理/镜像线路失败后的电脑默认线路兜底。 */
function createDirectUpdateNetwork(appRoot) {
  const config = {
    proxy: "",
    githubMirror: "",
    githubToken: "",
    catalogUrl: "",
    useEnvProxy: false,
    noProxy: "",
  };
  try {
    const { NetworkClient } = require("../dist/network-fetch.js");
    const client = new NetworkClient(config);
    return { fetch: client.fetch, config, close: () => client.close() };
  } catch (error) {
    logToFile(appRoot, "UPDATE_DIRECT_NETWORK_FALLBACK " + (error && error.message ? error.message : String(error)));
    return { fetch: (...args) => globalThis.fetch(...args), config, close: async () => {} };
  }
}

/**
 * Chromium 网络栈（Electron net.fetch）：自动跟随 Windows 系统代理 / PAC / TUN。
 * 实测 Node 直连 github.com 超时时，net.fetch 仍可完成 Releases 与资产下载，因此作为系统默认线路。
 */
function createSystemUpdateNetwork(appRoot, baseConfig) {
  if (!electronNet || typeof electronNet.fetch !== "function") {
    logToFile(appRoot, "UPDATE_SYSTEM_NETWORK_UNAVAILABLE Electron net.fetch 不可用");
    return null;
  }
  const config = {
    ...(baseConfig || {}),
    proxy: "",
    useEnvProxy: false,
  };
  return {
    fetch: (input, init) => electronNet.fetch(String(input), init),
    config,
    close: async () => {},
  };
}

/** 生成更新线路顺序：无显式代理时系统默认优先；配置了代理时配置线路优先，系统默认与直连兜底。 */
function buildUpdateAttempts(appRoot) {
  const primary = createUpdateNetwork(appRoot);
  const system = createSystemUpdateNetwork(appRoot, primary.config);
  const attempts = [];
  if (hasConfiguredProxy(primary.config)) {
    attempts.push({ label: "configured", display: "配置线路", network: primary });
    if (system) attempts.push({ label: "system", display: "系统默认线路", network: system });
    attempts.push({ label: "direct", display: "电脑默认线路", network: createDirectUpdateNetwork(appRoot) });
  } else {
    if (system) attempts.push({ label: "system", display: "系统默认线路", network: system });
    attempts.push({ label: "configured", display: "直连线路", network: primary });
  }
  logToFile(appRoot, "UPDATE_NETWORK_ORDER " + attempts.map((attempt) => attempt.label).join(" > "));
  return attempts;
}

function sendUpdateProgress(progress) {
  const payload = {
    phase: progress && progress.phase ? progress.phase : "error",
    received: progress && Number.isFinite(progress.received) ? progress.received : 0,
    total: progress && Number.isFinite(progress.total) ? progress.total : 0,
    percent: progress && Number.isFinite(progress.percent) ? progress.percent : 0,
    message: progress && progress.message ? progress.message : "",
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:update-progress", payload);
  }
  return payload;
}

function escapePowerShellSingleQuoted(value) {
  return String(value).replace(/'/g, "''");
}

function quoteWindowsArgument(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) return text;
  return '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") + '"';
}

function wildcardMatch(value, pattern) {
  const escaped = String(pattern)
    .replace(/[.+?^${\}|\[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$", "i").test(String(value));
}

function runPowerShell(script, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;
    const timeoutMessage = options.timeoutMessage || "PowerShell 执行超时";
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(timeoutMessage));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, stdout, stderr });
    });
  });
}

async function launchUpdateHelper(helperPath, target, source, logPath) {
  const commandLine = [
    "powershell.exe",
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
    "-Target",
    target,
    "-Source",
    source,
    "-ParentPid",
    String(process.pid),
    "-LogPath",
    logPath,
  ]
    .map(quoteWindowsArgument)
    .join(" ");
  // portable 版外层退出时会清理进程树，直接 spawn 的 helper 会被一起结束。
  // 通过 WMI 让 WmiPrvSE 创建 helper，使其脱离当前进程树后再退出应用。
  const script = [
    "$ErrorActionPreference = 'Stop';",
    "$commandLine = '" + escapePowerShellSingleQuoted(commandLine) + "';",
    "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine };",
    "if ($result.ReturnValue -ne 0) { Write-Error ('Win32_Process.Create failed: ' + $result.ReturnValue); exit 1 }",
    "Write-Output ('PID=' + $result.ProcessId)",
  ].join(" ");
  const result = await runPowerShell(script, {
    timeoutMs: 30000,
    timeoutMessage: "启动更新 helper 超时",
  });
  if (result.code !== 0) {
    throw new Error("启动更新 helper 失败：" + (result.stderr.trim() || result.stdout.trim() || "exit " + result.code));
  }
  const match = /PID=(\d+)/.exec(result.stdout);
  return match ? Number(match[1]) : 0;
}

async function verifyAuthenticode(exePath, expectedSubject) {
  const script = [
    "$sig = Get-AuthenticodeSignature -LiteralPath '" + escapePowerShellSingleQuoted(exePath) + "';",
    'if ($null -eq $sig.SignerCertificate) { Write-Output "NO_CERT"; exit 3 }',
    'Write-Output ("STATUS=" + $sig.Status);',
    'Write-Output ("SUBJECT=" + $sig.SignerCertificate.Subject);',
  ].join(" ");
  const result = await runPowerShell(script);
  if (result.code !== 0) {
    throw new Error("签名校验失败：" + (result.stderr.trim() || result.stdout.trim() || "exit " + result.code));
  }
  const fields = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  const status = fields.STATUS || "";
  const subject = fields.SUBJECT || "";
  const configuredSubject = String(expectedSubject || "").trim();
  if (!configuredSubject) {
    throw new Error("签名校验失败：未配置 desktop.updateSignerSubject");
  }
  // UnknownError 表示证书链不受信任（例如项目开发签名），只有签名者与配置主体完全匹配时才接受；
  // 未配置主体时一律拒绝，避免退化成“只看哈希、不验证发布者”。
  if (status !== "Valid" && status !== "UnknownError") {
    throw new Error("签名校验失败：状态为 " + (status || "未知"));
  }
  if (!wildcardMatch(subject, configuredSubject)) {
    throw new Error("签名校验失败：签名者 " + subject + " 与配置不匹配");
  }
}

/** 请求 GitHub Releases API，并把限流状态转成更可诊断的错误。 */
async function fetchReleaseFromApi(network, endpoint) {
  if (!/^https:/i.test(endpoint)) throw new Error("更新仓库必须使用 HTTPS");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "CastHub" };
  try {
    if (new URL(endpoint).hostname === "api.github.com" && network.config.githubToken) {
      headers.Authorization = "Bearer " + network.config.githubToken;
    }
  } catch {
    // URL 校验由 updateEndpoint/上游 fetch 处理
  }
  const response = await network.fetch(endpoint, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    const remaining = response.headers.get("x-ratelimit-remaining") || "";
    const reset = Number(response.headers.get("x-ratelimit-reset") || 0);
    const limited = response.status === 403 && remaining === "0";
    const error = new Error((limited ? "GitHub API 限流" : "GitHub API") + " HTTP " + response.status);
    error.rateLimitReset = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : "";
    throw error;
  }
  return response.json();
}

/**
 * 按 attempts 顺序尝试 GitHub API；每个线路失败后自动切到 releases.atom 和 releases/latest 重定向。
 * attempts 由 buildUpdateAttempts 生成，通常为系统默认线路 → 配置线路 → 直连。
 */
async function fetchLatestReleaseWithFallback(attempts, repoSlug, appRoot) {
  let apiError = null;
  const errors = [];
  for (const attempt of attempts) {
    try {
      const release = await fetchReleaseFromApi(attempt.network, updateEndpoint(repoSlug));
      return { release, source: "api", via: attempt.label };
    } catch (error) {
      if (!apiError) apiError = error;
      logToFile(
        appRoot,
        "UPDATE_CHECK_FALLBACK line=" +
          attempt.label +
          " reason=" +
          (error && error.message ? error.message : String(error)) +
          (error && error.rateLimitReset ? " reset=" + error.rateLimitReset : ""),
      );
    }
    try {
      const fallback = await fetchLatestReleaseFallback(attempt.network.fetch, repoSlug);
      logToFile(
        appRoot,
        "UPDATE_CHECK_FALLBACK_OK line=" + attempt.label + " source=" + fallback.source + " tag=" + fallback.tag,
      );
      return { ...fallback, via: attempt.label };
    } catch (error) {
      errors.push(attempt.display + "：" + (error && error.message ? error.message : String(error)));
    }
  }

  const apiMessage = apiError && apiError.message ? apiError.message : "GitHub API 不可用";
  throw new Error(apiMessage + "；" + errors.join("；") + "。请检查网络，或开启系统代理 / TUN 代理（节点）后重试。");
}

async function downloadAndVerifyWithNetwork(info, network, appRoot, tempDir, label) {
  const cacheDir = path.join(appRoot, "update-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const exePath = path.join(cacheDir, "CastHub-" + safeUpdateCacheName(info.tag) + ".exe");
  logToFile(
    appRoot,
    "UPDATE_DOWNLOAD_START line=" + label + " url=" + info.exeUrl + " size=" + info.size + " cache=" + exePath,
  );
  let expected = normalizeSha256(info.exeSha256);
  if (expected) {
    logToFile(appRoot, "UPDATE_CHECKSUM_SOURCE line=" + label + " api-digest sha256=" + expected);
  } else {
    // Atom/重定向兜底没有 API digest，只能从 Release 的 checksums.txt 取哈希。
    const checksumPath = path.join(tempDir, "checksums.txt");
    sendUpdateProgress({ phase: "downloading", received: 0, total: 0, percent: 0, message: "正在下载校验文件…" });
    await downloadFile(info.checksumUrl, checksumPath, {
      fetcher: network.fetch,
      allowText: true,
    });
    const checksums = parseChecksums(fs.readFileSync(checksumPath, "utf8"));
    expected = checksums["CastHub.exe"];
    if (!expected) {
      const key = Object.keys(checksums).find((name) => name.toLowerCase() === "casthub.exe");
      if (key) expected = checksums[key];
    }
    if (!expected) throw new Error("checksums.txt 缺少 CastHub.exe 的 SHA-256");
  }
  sendUpdateProgress({ phase: "downloading", received: 0, total: info.size || 0, percent: 0, message: "正在下载 0%" });
  await downloadFile(info.exeUrl, exePath, {
    fetcher: network.fetch,
    githubMirror: network.config.githubMirror || "",
    mirrors: DEFAULT_GITHUB_MIRRORS,
    expectedSha256: expected,
    onProgress: (progress) => {
      sendUpdateProgress({
        phase: "downloading",
        received: progress.received,
        total: progress.total,
        percent: progress.percent,
        message: "正在下载 " + progress.percent + "%",
      });
    },
  });
  logToFile(appRoot, "UPDATE_DOWNLOAD_DONE line=" + label + " path=" + exePath);
  sendUpdateProgress({ phase: "verifying", received: 0, total: 0, percent: 100, message: "正在校验…" });
  const actual = await sha256File(exePath);
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("CastHub.exe 的 SHA-256 校验失败");
  }
  const settings = readDesktopSettings(appRoot);
  await verifyAuthenticode(exePath, settings.updateSignerSubject);
  logToFile(
    appRoot,
    "UPDATE_VERIFY_OK line=" + label + " sha256=" + actual + " signer=" + settings.updateSignerSubject,
  );
  return { tempDir, exePath };
}

async function downloadAndVerifyUpdate() {
  const info = updateInfo;
  if (!info) throw new Error("没有可用更新");
  const appRoot = appRootPath || resolveAppRoot();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "casthub-update-"));
  const attempts = buildUpdateAttempts(appRoot);
  let lastError = null;
  try {
    for (const attempt of attempts) {
      sendUpdateProgress({
        phase: "downloading",
        received: 0,
        total: info.size || 0,
        percent: 0,
        message: "正在通过" + attempt.display + "下载…",
      });
      try {
        return await downloadAndVerifyWithNetwork(info, attempt.network, appRoot, tempDir, attempt.label);
      } catch (error) {
        lastError = error;
        logToFile(
          appRoot,
          "UPDATE_DOWNLOAD_ATTEMPT_FAILED line=" +
            attempt.label +
            " " +
            (error && error.message ? error.message : String(error)),
        );
      }
    }
    const tried = attempts.map((attempt) => attempt.display).join("、");
    const detail = lastError && lastError.message ? lastError.message : String(lastError);
    throw new Error(
      "所有下载线路均失败（已尝试 " +
        tried +
        "，含 GitHub 镜像与 GitHub 原始地址）。" +
        "请检查网络，或开启系统代理 / TUN 代理（节点）后重试。最后错误：" +
        detail,
    );
  } catch (error) {
    logToFile(appRoot, "UPDATE_VERIFY_FAILED " + (error && error.message ? error.message : String(error)));
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  } finally {
    for (const attempt of attempts) await attempt.network.close().catch(() => {});
  }
}

async function installUpdate() {
  if (updateInProgress) return { ok: false, error: "更新任务正在进行中，请勿重复操作" };
  if (!updateInfo) return { ok: false, error: "没有可用更新" };
  if (!app.isPackaged) return { ok: false, error: "开发模式不支持自动更新" };
  const target = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!target) return { ok: false, error: "当前不是 portable 安装，无法自动替换" };
  if (!/\.exe$/i.test(target)) return { ok: false, error: "更新目标不是 .exe 文件" };
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, error: "更新目标不存在：" + target };
  }
  if (!stat.isFile()) return { ok: false, error: "更新目标不是文件：" + target };
  const targetDir = path.dirname(target);
  try {
    fs.accessSync(targetDir, fs.constants.W_OK);
  } catch {
    return { ok: false, error: "更新目标目录不可写：" + targetDir };
  }

  updateInProgress = true;
  rebuildTrayMenu();
  const appRoot = appRootPath || resolveAppRoot();
  logToFile(appRoot, "UPDATE_TARGET path=" + target);
  try {
    const downloaded = await downloadAndVerifyUpdate();
    sendUpdateProgress({
      phase: "installing",
      received: 0,
      total: 0,
      percent: 100,
      message: "正在安装，应用即将重启…",
    });
    const helperPath = writeUpdateHelperScript(downloaded.tempDir);
    const helperPid = await launchUpdateHelper(helperPath, target, downloaded.exePath, UPDATE_LOG_PATH);
    logToFile(appRoot, "UPDATE_INSTALL_SPAWNED helper=" + helperPath + " target=" + target + " pid=" + helperPid);
    // helper 已由 WMI 创建到独立进程树中，只需留出日志落盘时间即可退出。
    setTimeout(() => app.quit(), 300);
    return { ok: true };
  } catch (error) {
    updateInProgress = false;
    rebuildTrayMenu();
    const message = error && error.message ? error.message : String(error);
    logToFile(appRoot, "UPDATE_INSTALL_FAILED " + message);
    sendUpdateProgress({ phase: "error", received: 0, total: 0, percent: 0, message: "更新失败: " + message });
    return { ok: false, error: message };
  }
}

async function checkForUpdates(options) {
  const manual = Boolean(options && options.manual);
  if (!appRootPath || isQuitting) return { status: "skipped", reason: "not-ready" };
  const settings = readDesktopSettings(appRootPath);
  if (!settings.updateRepo) {
    logToFile(appRootPath, "UPDATE_CHECK_SKIPPED 未配置 desktop.updateRepo");
    return { status: "skipped", reason: "no-repo" };
  }
  const repoSlug = normalizeRepoSlug(settings.updateRepo);
  const endpoint = updateEndpoint(settings.updateRepo);
  logToFile(appRootPath, "UPDATE_CHECK_START manual=" + manual + " endpoint=" + endpoint);
  const attempts = buildUpdateAttempts(appRootPath);
  try {
    let data;
    let source = "api";
    let via = attempts[0] ? attempts[0].label : "configured";
    if (repoSlug) {
      const result = await fetchLatestReleaseWithFallback(attempts, repoSlug, appRootPath);
      data = result.release;
      source = result.source;
      via = result.via;
    } else {
      const primaryAttempt = attempts.find((attempt) => attempt.label === "configured") || attempts[0];
      via = primaryAttempt.label;
      data = await fetchReleaseFromApi(primaryAttempt.network, endpoint);
    }
    const latestTag = typeof data.tag_name === "string" ? data.tag_name : "";
    const current = app.getVersion();
    if (compareVersions(latestTag, current) > 0) {
      const assets = pickUpdateAssets(data.assets);
      updateInfo = {
        version: latestTag.replace(/^v/i, ""),
        tag: latestTag,
        exeUrl: assets.exeUrl,
        checksumUrl: assets.checksumUrl,
        size: assets.exeSize,
        exeSha256: assets.exeSha256,
      };
      logToFile(
        appRootPath,
        "UPDATE_FOUND source=" +
          source +
          " via=" +
          via +
          " current=" +
          current +
          " latest=" +
          latestTag +
          " exe=" +
          assets.exeUrl +
          " size=" +
          assets.exeSize +
          " digest=" +
          (assets.exeSha256 ? "yes" : "no"),
      );
      showNotification("发现新版本", "CastHub " + latestTag + " 已发布，可在桌面设置或托盘菜单立即更新。", appRootPath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("desktop:update-available", {
          version: updateInfo.version,
          tag: updateInfo.tag,
          size: updateInfo.size,
        });
      }
      rebuildTrayMenu();
      return { status: "found", current, latest: latestTag, version: updateInfo.version, source };
    }
    updateInfo = null;
    rebuildTrayMenu();
    logToFile(appRootPath, "UPDATE_CHECK_LATEST current=" + current + " latest=" + (latestTag || "(none)"));
    return { status: "latest", current, latest: latestTag };
  } catch (error) {
    updateInfo = null;
    rebuildTrayMenu();
    const message = error && error.message ? error.message : String(error);
    logToFile(appRootPath, "UPDATE_CHECK_FAILED " + message);
    return { status: "error", message };
  } finally {
    for (const attempt of attempts) await attempt.network.close().catch(() => {});
  }
}

function scheduleUpdateChecks(appRoot) {
  setTimeout(() => {
    checkForUpdates({ manual: false }).catch((error) => {
      logToFile(appRoot, "UPDATE_CHECK_FAILED " + (error && error.message ? error.message : String(error)));
    });
  }, 5000);
  updateTimer = setInterval(() => {
    checkForUpdates({ manual: false }).catch((error) => {
      logToFile(appRoot, "UPDATE_CHECK_FAILED " + (error && error.message ? error.message : String(error)));
    });
  }, UPDATE_INTERVAL_MS);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "CastHub",
    icon: APP_ICON,
    backgroundColor: "#10161d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  // 页面 <title> 是「CastHub 控制台」，这里固定窗口标题为 CastHub
  mainWindow.on("page-title-updated", (event) => event.preventDefault());
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      logToFile(appRootPath || resolveAppRoot(), "WINDOW_HIDDEN");
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  return mainWindow;
}

function showErrorPage(appRoot, message) {
  if (!mainWindow) createWindow();
  logToFile(appRoot, "启动失败: " + message);
  mainWindow.loadFile(path.join(__dirname, "error.html"), { query: { message } });
}

async function boot() {
  const appRoot = resolveAppRoot();
  appRootPath = appRoot;
  // config.json 与 casthub.log 都放在 exe 所在目录（开发模式为 server/）
  process.env.CASTHUB_CONFIG_DIR = appRoot;
  if (app.isPackaged) {
    process.env.CASTHUB_LOG_FILE = path.join(appRoot, "casthub.log");
  }

  syncAutoStart(appRoot);
  createTray(appRoot);

  const port = Number(process.env.PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const message = "PORT 必须是 1-65535 之间的整数，当前为 " + process.env.PORT;
    showErrorPage(appRoot, message);
    showNotification("CastHub 启动失败", message, appRoot);
    return;
  }

  // 先检查端口占用（坑位 3），占用则显示错误页，绝不白屏或静默失败
  if (await isPortInUse(port)) {
    const message = "端口 " + port + " 被占用，请关闭占用程序后重试";
    showErrorPage(appRoot, message);
    showNotification("CastHub 启动失败", message, appRoot);
    return;
  }

  try {
    // 坑位 2：绝不 spawn process.execPath，直接 require dist 中的 startServer
    const { startServer } = require("../dist/index.js");
    serverHandle = await startServer({ mediaDir: path.join(appRoot, "media") });
    createWindow();
    const consoleUrl = new URL(serverHandle.url || "http://127.0.0.1:" + port);
    // 令牌放在 fragment，不会进入 HTTP 请求、服务端访问日志或代理日志。
    consoleUrl.hash = "token=" + encodeURIComponent(serverHandle.consoleToken || "");
    mainWindowUrl = consoleUrl.toString();
    await mainWindow.loadURL(mainWindowUrl);
    scheduleUpdateChecks(appRoot);
  } catch (error) {
    // 服务已经启动但窗口加载失败时，必须回收后台服务，避免残留端口和进程。
    if (serverHandle) {
      try {
        await serverHandle.close();
      } catch (closeError) {
        logToFile(
          appRoot,
          "启动失败后关闭服务异常: " + (closeError && closeError.message ? closeError.message : String(closeError)),
        );
      }
      serverHandle = null;
    }
    const message =
      error && error.code === "EADDRINUSE"
        ? "端口 " + port + " 被占用，请关闭占用程序后重试"
        : "CastHub 启动失败：" + (error && error.message ? error.message : String(error));
    showErrorPage(appRoot, message);
    showNotification("CastHub 启动失败", message, appRoot);
  }
}

function registerIpc() {
  ipcMain.handle("desktop:get-settings", () => {
    const settings = readDesktopSettings(appRootPath || resolveAppRoot());
    return {
      ...settings,
      version: app.getVersion(),
      updateAvailable: updateInfo ? { version: updateInfo.version, tag: updateInfo.tag, size: updateInfo.size } : null,
    };
  });
  ipcMain.handle("desktop:set-auto-start", (_event, enabled) => applyAutoStart(enabled === true));
  ipcMain.handle("desktop:check-updates", () => checkForUpdates({ manual: true }));
  ipcMain.handle("desktop:install-update", () => installUpdate());
}

if (process.platform === "win32") {
  app.setAppUserModelId("io.casthub.app");
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // 二次启动：直接退出，由 first instance 的 second-instance 事件聚焦已有窗口
  app.quit();
} else {
  app.on("second-instance", () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    registerIpc();
    boot();
  });

  app.on("window-all-closed", () => {
    // 关闭窗口只隐藏到托盘；托盘常驻，不因窗口全部关闭而退出
  });

  app.on("before-quit", (event) => {
    if (isQuitting) return;
    isQuitting = true;
    if (!serverHandle) return;
    event.preventDefault();
    if (updateTimer) {
      clearInterval(updateTimer);
      updateTimer = null;
    }
    // 兜底：即使 server.close() 因异常连接卡住，也要保证退出（坑位 7）
    const forceQuit = setTimeout(() => {
      console.error("关闭 CastHub 服务超时，强制退出");
      app.exit(0);
    }, 2000);
    serverHandle
      .close()
      .catch((error) => console.error("关闭 CastHub 服务失败:", error))
      .finally(() => {
        clearTimeout(forceQuit);
        serverHandle = null;
        app.quit();
      });
  });
}
