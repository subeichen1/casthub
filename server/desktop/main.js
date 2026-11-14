// CastHub 桌面壳：起进程 → 起 server → 开窗口加载 http://127.0.0.1:9420
// 业务逻辑全部在 ../dist/index.js 的 startServer 中，本文件只做壳层编排。
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const DEFAULT_PORT = 9420;
const TV_PORT = 9417; // 电视端 WS 端口（CastHub 本身不监听，仅用于启动前冲突提示）
const APP_ICON = path.join(__dirname, "assets", "icon.ico");

let mainWindow = null;
let serverHandle = null;
let quitting = false;

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
    fs.appendFileSync(path.join(appRoot, "casthub.log"), `[${new Date().toISOString()}] ${message}\n`, "utf8");
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "CastHub",
    icon: APP_ICON,
    backgroundColor: "#10161d",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });
  // 页面 <title> 是「CastHub 控制台」，这里固定窗口标题为 CastHub
  mainWindow.on("page-title-updated", (event) => event.preventDefault());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showErrorPage(appRoot, message) {
  if (!mainWindow) createWindow();
  logToFile(appRoot, `启动失败: ${message}`);
  mainWindow.loadFile(path.join(__dirname, "error.html"), { query: { message } });
}

async function boot() {
  const appRoot = resolveAppRoot();
  // config.json 与 casthub.log 都放在 exe 所在目录（开发模式为 server/）
  process.env.CASTHUB_CONFIG_DIR = appRoot;
  if (app.isPackaged) {
    process.env.CASTHUB_LOG_FILE = path.join(appRoot, "casthub.log");
  }

  const port = Number(process.env.PORT || DEFAULT_PORT);

  // 先检查端口占用（坑位 3），占用则显示错误页，绝不白屏或静默失败
  for (const checkedPort of [port, TV_PORT]) {
    if (await isPortInUse(checkedPort)) {
      showErrorPage(appRoot, `端口 ${checkedPort} 被占用，请关闭占用程序后重试`);
      return;
    }
  }

  try {
    // 坑位 2：绝不 spawn process.execPath，直接 require dist 中的 startServer
    const { startServer } = require("../dist/index.js");
    serverHandle = await startServer({ mediaDir: path.join(appRoot, "media") });
    createWindow();
    await mainWindow.loadURL(serverHandle.url || `http://127.0.0.1:${port}`);
  } catch (error) {
    const message =
      error && error.code === "EADDRINUSE"
        ? `端口 ${port} 被占用，请关闭占用程序后重试`
        : `CastHub 启动失败：${error && error.message ? error.message : String(error)}`;
    showErrorPage(appRoot, message);
  }
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
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(boot);

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", (event) => {
    if (!serverHandle || quitting) return;
    event.preventDefault();
    quitting = true;
    // 兜底：即使 server.close() 因异常连接卡住，也要保证关窗后进程退出（坑位 7）
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
