// preload：只暴露白名单方法，绝不把整个 ipcRenderer 交给渲染进程（坑位 4）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("casthubDesktop", {
  getSettings: () => ipcRenderer.invoke("desktop:get-settings"),
  setAutoStart: (enabled) => ipcRenderer.invoke("desktop:set-auto-start", enabled === true),
  checkUpdates: () => ipcRenderer.invoke("desktop:check-updates"),
  installUpdate: () => ipcRenderer.invoke("desktop:install-update"),
  onUpdateAvailable: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:update-available", listener);
    return () => ipcRenderer.removeListener("desktop:update-available", listener);
  },
  onUpdateProgress: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("desktop:update-progress", listener);
    return () => ipcRenderer.removeListener("desktop:update-progress", listener);
  },
});
