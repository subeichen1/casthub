// CastHub 桌面壳：起进程 → 起 server → 开窗口加载 http://127.0.0.1:9420
// 业务逻辑全部在 ../dist/index.js 的 startServer 中，本文件只做壳层编排。
const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, shell } = require("electron");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_PORT = 9420;
const APP_ICON = path.join(__dirname, "assets", "icon.ico");
const TRAY_ICON = path.join(__dirname, "assets", "icon-32.png");
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DESKTOP_SETTINGS = { autoStart: false, updateRepo: "" };

let mainWindow = null;
let tray = null;
let serverHandle = null;
let isQuitting = false;
let appRootPath = null;
let mainWindowUrl = "";
let updateTimer = null;
let updateInfo = null;

function resolveAppRoot() {
  if (app.isPackaged) {
    // portable 目标会先解压到 %TEMP%，exe 所在目录只能从该变量取（坑位 1）
    return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  }
  // 开发模式：server/ 目录（package.json 所在目录）
  return path.resolve(__dirname, "..");
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
      updateRepo: typeof desktop.updateRepo === "string" ? desktop.updateRepo.trim() : "",
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
  fs.writeFileSync(configPath(appRoot), JSON.stringify(obj, null, 2) + "\n", "utf8");
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
      label: "下载新版本…",
      click: () => {
        if (updateInfo && updateInfo.url) shell.openExternal(updateInfo.url);
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
  try {
    app.setLoginItemSettings({ openAtLogin: settings.autoStart, path: process.execPath });
    logToFile(appRoot, "AUTOSTART_SYNC enabled=" + settings.autoStart + " path=" + process.execPath);
  } catch (error) {
    logToFile(appRoot, "AUTOSTART_SYNC_FAILED " + (error && error.message ? error.message : String(error)));
  }
}

function applyAutoStart(enabled) {
  if (!appRootPath) return { ok: false, autoStart: false, error: "app not ready" };
  const previous = readDesktopSettings(appRootPath);
  const next = Boolean(enabled);
  try {
    app.setLoginItemSettings({ openAtLogin: next, path: process.execPath });
    saveDesktopSettings(appRootPath, { autoStart: next });
    logToFile(appRootPath, "AUTOSTART_SET enabled=" + next + " path=" + process.execPath);
    rebuildTrayMenu();
    return { ok: true, autoStart: next };
  } catch (error) {
    try {
      app.setLoginItemSettings({ openAtLogin: previous.autoStart, path: process.execPath });
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

async function checkForUpdates(options) {
  const manual = Boolean(options && options.manual);
  if (!appRootPath || isQuitting) return { status: "skipped", reason: "not-ready" };
  const settings = readDesktopSettings(appRootPath);
  if (!settings.updateRepo) {
    logToFile(appRootPath, "UPDATE_CHECK_SKIPPED 未配置 desktop.updateRepo");
    return { status: "skipped", reason: "no-repo" };
  }
  const endpoint = updateEndpoint(settings.updateRepo);
  logToFile(appRootPath, "UPDATE_CHECK_START manual=" + manual + " endpoint=" + endpoint);
  try {
    const response = await fetch(endpoint, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "CastHub" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    const latestTag = typeof data.tag_name === "string" ? data.tag_name : "";
    const htmlUrl = typeof data.html_url === "string" ? data.html_url : "";
    const current = app.getVersion();
    if (compareVersions(latestTag, current) > 0 && htmlUrl) {
      updateInfo = { version: latestTag.replace(/^v/i, ""), tag: latestTag, url: htmlUrl };
      logToFile(appRootPath, "UPDATE_FOUND current=" + current + " latest=" + latestTag + " url=" + htmlUrl);
      showNotification("发现新版本", "CastHub " + latestTag + " 已发布，可在托盘菜单下载。", appRootPath);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("desktop:update-available", updateInfo);
      }
      rebuildTrayMenu();
      return { status: "found", current, latest: latestTag, url: htmlUrl };
    }
    updateInfo = null;
    rebuildTrayMenu();
    logToFile(appRootPath, "UPDATE_CHECK_LATEST current=" + current + " latest=" + (latestTag || "(none)"));
    return { status: "latest", current, latest: latestTag };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    logToFile(appRootPath, "UPDATE_CHECK_FAILED " + message);
    return { status: "error", message };
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
      updateAvailable: updateInfo ? { ...updateInfo } : null,
    };
  });
  ipcMain.handle("desktop:set-auto-start", (_event, enabled) => applyAutoStart(enabled === true));
  ipcMain.handle("desktop:check-updates", () => checkForUpdates({ manual: true }));
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
