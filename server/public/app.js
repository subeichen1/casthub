/* CastHub 控制台前端（原生 JS，无构建步骤） */
(function () {
  "use strict";

  const state = {
    devices: [],
    history: [],
    selectedDeviceId: null,
    files: [],
    filesOffset: 0,
    filesTotal: 0,
    currentPath: "",
    tvStatus: null,
    currentTitle: "",
    castingDeviceId: null,
    ws: null,
    reconnectTimer: null,
    draggingSeek: false,
    consoleToken: "",
    authenticated: false
  };

  const tokenFromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
  const tokenFromQuery = new URLSearchParams(location.search).get("token");
  const incomingToken = tokenFromHash || tokenFromQuery;
  if (incomingToken) {
    state.consoleToken = incomingToken;
    try { localStorage.setItem("casthub-token", incomingToken); } catch (error) { /* ignore */ }
    try { history.replaceState(null, "", location.pathname); } catch (error) { /* ignore */ }
  } else {
    try { state.consoleToken = localStorage.getItem("casthub-token") || ""; } catch (error) { /* ignore */ }
  }

  const els = {
    authGate: document.getElementById("authGate"),
    consoleTokenInput: document.getElementById("consoleToken"),
    connectBtn: document.getElementById("connectBtn"),
    authError: document.getElementById("authError"),
    loadMoreBtn: document.getElementById("loadMoreBtn"),
    connState: document.getElementById("connState"),
    deviceAddress: document.getElementById("deviceAddress"),
    deviceToken: document.getElementById("deviceToken"),
    addDeviceBtn: document.getElementById("addDeviceBtn"),
    refreshDevicesBtn: document.getElementById("refreshDevicesBtn"),
    deviceList: document.getElementById("deviceList"),
    historyList: document.getElementById("historyList"),
    clearHistoryBtn: document.getElementById("clearHistoryBtn"),
    dlnaBanner: document.getElementById("dlnaBanner"),
    breadcrumb: document.getElementById("breadcrumb"),
    fileList: document.getElementById("fileList"),
    playerTitle: document.getElementById("playerTitle"),
    stateBadge: document.getElementById("stateBadge"),
    seekSlider: document.getElementById("seekSlider"),
    positionText: document.getElementById("positionText"),
    durationText: document.getElementById("durationText"),
    toggleBtn: document.getElementById("toggleBtn"),
    stopBtn: document.getElementById("stopBtn"),
    toast: document.getElementById("toast")
  };

  let toastTimer = null;
  function showToast(message, isError) {
    els.toast.textContent = message;
    els.toast.className = "show" + (isError ? " error" : "");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.className = "";
    }, 3200);
  }

  function showAuthGate(message) {
    state.authenticated = false;
    els.authGate.hidden = false;
    els.authError.textContent = message || "";
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function hideAuthGate() {
    els.authGate.hidden = true;
    els.authError.textContent = "";
  }

  function connectWs() {
    if (!state.consoleToken) {
      showAuthGate("");
      return;
    }
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(protocol + "//" + location.host + "/console?token=" + encodeURIComponent(state.consoleToken));
    state.ws = ws;

    ws.onopen = function () {
      state.authenticated = true;
      hideAuthGate();
      els.connState.textContent = "已连接中枢";
      els.connState.className = "conn-state ok";
    };
    ws.onclose = function (event) {
      if (event.code === 1008) {
        state.ws = null;
        showAuthGate("访问令牌无效或已过期，请重新输入。");
        els.connState.textContent = "需要访问令牌";
        els.connState.className = "conn-state bad";
        return;
      }
      els.connState.textContent = "中枢连接断开，2 秒后重连…";
      els.connState.className = "conn-state bad";
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      state.reconnectTimer = setTimeout(connectWs, 2000);
    };
    ws.onerror = function () {
      els.connState.textContent = "中枢连接异常";
      els.connState.className = "conn-state bad";
    };
    ws.onmessage = function (event) {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      handleMessage(msg);
    };
  }

  function send(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
      return true;
    }
    showToast("尚未连接中枢", true);
    return false;
  }

  function handleMessage(msg) {
    if (msg.type === "history") {
      state.history = Array.isArray(msg.list) ? msg.list : [];
      renderHistory();
      if (state.files.length) renderFiles();
      return;
    }
    if (msg.type === "devices") {
      state.devices = Array.isArray(msg.list) ? msg.list : [];
      if (!state.devices.some(function (d) { return d.id === state.selectedDeviceId; })) {
        const firstOnline = state.devices.find(function (d) { return d.online; });
        state.selectedDeviceId = firstOnline ? firstOnline.id : (state.devices[0] ? state.devices[0].id : null);
        state.tvStatus = null;
      }
      if (state.castingDeviceId && !state.devices.some(function (d) { return d.id === state.castingDeviceId; })) {
        state.castingDeviceId = null;
      }
      renderDevices();
      renderControls();
      updateDlnaBanner();
      if (state.files.length) renderFiles();
      return;
    }
    if (msg.type === "tvStatus") {
      if (msg.deviceId === state.selectedDeviceId) {
        state.tvStatus = msg;
        renderControls();
      }
      return;
    }
    if (msg.type === "error") {
      showToast(msg.message || "未知错误", true);
    }
  }

  function normalizePath(value) {
    return String(value || "").replace(/\\/g, "/");
  }

  function historyForFile(entry) {
    const target = normalizePath(entry.path).replace(/^\/+/, "");
    if (!target) return null;
    for (let i = 0; i < state.history.length; i += 1) {
      const candidate = normalizePath(state.history[i].path);
      if (candidate === target || candidate.endsWith("/" + target)) return state.history[i];
    }
    return null;
  }

  function historyPercent(entry) {
    const duration = Math.max(0, Number(entry.durationMs) || 0);
    const position = Math.max(0, Number(entry.positionMs) || 0);
    if (duration <= 0) return 0;
    return Math.min(100, Math.round((position / duration) * 100));
  }

  function historyCompleted(entry) {
    return Number(entry.positionMs) < 5000 && Number(entry.playCount) >= 2;
  }

  function formatUpdatedAt(value) {
    const date = new Date(Number(value) || 0);
    if (!isFinite(date.getTime())) return "-";
    return date.toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function castFile(entry, resume) {
    if (!state.selectedDeviceId) {
      showToast("请先添加并选择一台电视", true);
      return;
    }
    state.currentTitle = entry.name;
    els.playerTitle.textContent = entry.name;
    if (send({ type: "cast", deviceId: state.selectedDeviceId, path: entry.path, resume: !!resume })) {
      state.castingDeviceId = state.selectedDeviceId;
      updateDlnaBanner();
    }
  }

  function castHistory(entry, resume) {
    castFile({ name: entry.name, path: entry.path }, resume);
  }

  function renderHistory() {
    els.historyList.innerHTML = "";
    els.clearHistoryBtn.disabled = !state.history.length;
    if (!state.history.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "暂无播放历史";
      els.historyList.appendChild(empty);
      return;
    }
    state.history.forEach(function (entry) {
      const row = document.createElement("div");
      row.className = "history-row";
      const main = document.createElement("div");
      main.className = "history-main";
      const name = document.createElement("span");
      name.className = "history-name";
      name.textContent = entry.name || entry.path;
      name.title = entry.path;
      const progress = document.createElement("span");
      progress.className = "history-progress";
      progress.textContent = historyCompleted(entry) ? "100% · 已看完" : historyPercent(entry) + "%";
      main.appendChild(name);
      main.appendChild(progress);
      const meta = document.createElement("div");
      meta.className = "history-meta";
      meta.textContent = "更新 " + formatUpdatedAt(entry.updatedAt) + " · 播放 " + (Number(entry.playCount) || 0) + " 次";
      const actions = document.createElement("div");
      actions.className = "history-actions";
      const continueBtn = document.createElement("button");
      continueBtn.textContent = "继续播放";
      continueBtn.addEventListener("click", function () { castHistory(entry, true); });
      const restartBtn = document.createElement("button");
      restartBtn.className = "secondary";
      restartBtn.textContent = "从头播放";
      restartBtn.addEventListener("click", function () { castHistory(entry, false); });
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "danger";
      deleteBtn.textContent = "删除";
      deleteBtn.addEventListener("click", function () { send({ type: "deleteHistory", path: entry.path }); });
      actions.appendChild(continueBtn);
      actions.appendChild(restartBtn);
      actions.appendChild(deleteBtn);
      row.appendChild(main);
      row.appendChild(meta);
      row.appendChild(actions);
      els.historyList.appendChild(row);
    });
  }

  function renderDevices() {
    if (!state.devices.length) {
      els.deviceList.innerHTML = '<div class="empty">尚未添加设备</div>';
      return;
    }
    els.deviceList.innerHTML = "";
    state.devices.forEach(function (device) {
      const isDlna = device.type === "dlna";
      const row = document.createElement("div");
      row.className = "device" + (device.id === state.selectedDeviceId ? " active" : "");
      const removeButton = isDlna
        ? '<span>自动发现</span>'
        : '<button class="danger" data-remove="' + escapeHtml(device.id) + '">移除</button>';
      row.innerHTML =
        '<div><span class="badge ' + (isDlna ? "dlna" : "app") + '">' + (isDlna ? "DLNA" : "App") + '</span>' +
        '<span class="name">' + escapeHtml(device.deviceName || (isDlna ? "DLNA 设备" : "电视")) + '</span></div>' +
        '<div class="addr">' + escapeHtml(device.address) + '</div>' +
        '<div class="meta"><span><span class="dot' + (device.online ? " online" : "") + '"></span>' +
        (device.online ? "在线" : "离线") + '</span>' + removeButton + '</div>';
      row.addEventListener("click", function (event) {
        if (event.target && event.target.getAttribute("data-remove")) return;
        state.selectedDeviceId = device.id;
        state.tvStatus = null;
        renderDevices();
        renderControls();
        updateDlnaBanner();
        renderFiles();
      });
      els.deviceList.appendChild(row);
    });
    Array.prototype.forEach.call(els.deviceList.querySelectorAll("[data-remove]"), function (btn) {
      btn.addEventListener("click", function (event) {
        event.stopPropagation();
        send({ type: "removeDevice", id: btn.getAttribute("data-remove") });
      });
    });
  }

  function updateDlnaBanner() {
    const selected = state.devices.find(function (d) { return d.id === state.selectedDeviceId; });
    const casting = state.devices.find(function (d) { return d.id === state.castingDeviceId; });
    const visible = !!((selected && selected.type === "dlna") || (casting && casting.type === "dlna"));
    els.dlnaBanner.hidden = !visible;
  }

  function renderControls() {
    const status = state.tvStatus;
    const selected = state.devices.find(function (d) { return d.id === state.selectedDeviceId; });
    const canControl = !!(selected && selected.online && status);
    const tvState = status ? status.state : "idle";
    els.stateBadge.textContent = tvState;
    els.stateBadge.className = "state-badge " + tvState;
    els.toggleBtn.disabled = !canControl || tvState === "idle";
    els.stopBtn.disabled = !canControl || tvState === "idle";

    if (tvState === "playing") {
      els.toggleBtn.textContent = "暂停";
    } else if (tvState === "paused") {
      els.toggleBtn.textContent = "播放";
    } else {
      els.toggleBtn.textContent = "播放";
    }

    if (!status) {
      els.playerTitle.textContent = "未在播放";
      els.seekSlider.value = "0";
      els.positionText.textContent = "00:00";
      els.durationText.textContent = "00:00";
      return;
    }
    const duration = Math.max(0, Number(status.durationMs) || 0);
    const position = Math.max(0, Number(status.positionMs) || 0);
    els.seekSlider.max = String(Math.max(duration, 1));
    if (!state.draggingSeek) {
      els.seekSlider.value = String(Math.min(position, Math.max(duration, 1)));
    }
    els.positionText.textContent = formatTime(state.draggingSeek ? Number(els.seekSlider.value) : position);
    els.durationText.textContent = formatTime(duration);
    if (state.currentTitle) {
      els.playerTitle.textContent = state.currentTitle;
    } else if (tvState === "playing") {
      els.playerTitle.textContent = "电视正在播放";
    } else if (tvState === "paused") {
      els.playerTitle.textContent = "电视已暂停";
    } else if (tvState === "buffering") {
      els.playerTitle.textContent = "电视缓冲中";
    } else {
      els.playerTitle.textContent = "未在播放";
    }
  }

  function formatTime(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = function (n) { return n < 10 ? "0" + n : String(n); };
    if (hours > 0) return hours + ":" + pad(minutes) + ":" + pad(seconds);
    return pad(minutes) + ":" + pad(seconds);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatSize(bytes) {
    if (!bytes) return "-";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function loadFiles(path, append) {
    if (!append) {
      state.currentPath = path || "";
      state.files = [];
      state.filesOffset = 0;
      state.filesTotal = 0;
    } else if (state.filesOffset >= state.filesTotal) {
      return;
    }
    const offset = append ? state.filesOffset : 0;
    fetch("/api/files?path=" + encodeURIComponent(state.currentPath) + "&limit=200&offset=" + offset, {
      headers: { "x-casthub-token": state.consoleToken }
    })
      .then(function (response) {
        if (response.status === 401) {
          showAuthGate("访问令牌无效或已过期，请重新输入。");
          throw new Error("unauthorized");
        }
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        const entries = Array.isArray(data.entries) ? data.entries : [];
        state.files = append ? state.files.concat(entries) : entries;
        state.filesOffset = offset + entries.length;
        state.filesTotal = Number(data.total) || state.files.length;
        renderBreadcrumb();
        renderFiles();
      })
      .catch(function (error) {
        if (error.message !== "unauthorized") showToast("读取文件列表失败: " + error.message, true);
      });
  }

  function renderBreadcrumb() {
    els.breadcrumb.innerHTML = "";
    const root = document.createElement("a");
    root.textContent = "媒体库";
    root.addEventListener("click", function () { loadFiles(""); });
    els.breadcrumb.appendChild(root);
    if (!state.currentPath) return;
    const parts = state.currentPath.split("/");
    let accumulated = "";
    parts.forEach(function (part) {
      accumulated = accumulated ? accumulated + "/" + part : part;
      const sep = document.createElement("span");
      sep.textContent = "/";
      els.breadcrumb.appendChild(sep);
      const link = document.createElement("a");
      link.textContent = part;
      const target = accumulated;
      link.addEventListener("click", function () { loadFiles(target); });
      els.breadcrumb.appendChild(link);
    });
  }

  function renderFiles() {
    if (!state.files.length) {
      els.fileList.innerHTML = '<div class="empty">此目录为空（把视频放入 MEDIA_DIR 后刷新）</div>';
      els.loadMoreBtn.hidden = true;
      return;
    }
    els.fileList.innerHTML = "";
    state.files.forEach(function (entry) {
      const row = document.createElement("div");
      row.className = "file-row" + (entry.isDir ? " dir" : "");
      row.innerHTML =
        '<span>' + (entry.isDir ? "📁" : "🎬") + '</span>' +
        '<span class="file-name" title="' + escapeHtml(entry.name) + '">' + escapeHtml(entry.name) + '</span>' +
        '<span class="file-mime">' + escapeHtml(entry.mimeType || (entry.isDir ? "文件夹" : "")) + '</span>' +
        '<span class="file-size">' + (entry.isDir ? "-" : formatSize(entry.size)) + '</span>' +
        '<span></span>';
      if (entry.isDir) {
        row.addEventListener("click", function () { loadFiles(entry.path); });
      } else {
        const historyEntry = historyForFile(entry);
        const actions = document.createElement("div");
        actions.className = "file-actions";
        const castBtn = document.createElement("button");
        castBtn.textContent = historyEntry ? "继续播放" : "投屏";
        castBtn.disabled = !state.selectedDeviceId;
        if (historyEntry) castBtn.title = "从上次播放位置继续（" + historyPercent(historyEntry) + "%）";
        castBtn.addEventListener("click", function (event) {
          event.stopPropagation();
          castFile(entry, true);
        });
        actions.appendChild(castBtn);
        if (historyEntry) {
          const restartBtn = document.createElement("button");
          restartBtn.className = "secondary";
          restartBtn.textContent = "从头";
          restartBtn.disabled = !state.selectedDeviceId;
          restartBtn.title = "从头开始播放";
          restartBtn.addEventListener("click", function (event) {
            event.stopPropagation();
            castFile(entry, false);
          });
          actions.appendChild(restartBtn);
        }
        row.lastElementChild.appendChild(actions);
      }
      els.fileList.appendChild(row);
    });
    els.loadMoreBtn.hidden = state.filesOffset >= state.filesTotal;
    els.loadMoreBtn.textContent = "加载更多（" + state.filesOffset + "/" + state.filesTotal + "）";
  }

  els.loadMoreBtn.addEventListener("click", function () {
    loadFiles(state.currentPath, true);
  });

  els.clearHistoryBtn.addEventListener("click", function () {
    if (!state.history.length) return;
    if (!window.confirm("确定清空全部播放历史？")) return;
    send({ type: "clearHistory" });
  });

  els.addDeviceBtn.addEventListener("click", function () {
    const address = els.deviceAddress.value.trim();
    const token = els.deviceToken.value.trim();
    if (!address) { showToast("请输入电视 WS 地址", true); return; }
    if (!/^\d{6,8}$/.test(token)) { showToast("配对码必须是 6-8 位数字", true); return; }
    if (send({ type: "addDevice", address: address, token: token })) {
      els.deviceAddress.value = "";
      els.deviceToken.value = "";
    }
  });

  els.toggleBtn.addEventListener("click", function () {
    if (!state.tvStatus || !state.selectedDeviceId) return;
    const action = state.tvStatus.state === "playing" ? "pause" : "resume";
    send({ type: "control", deviceId: state.selectedDeviceId, action: action });
  });

  els.stopBtn.addEventListener("click", function () {
    if (!state.selectedDeviceId) return;
    if (state.castingDeviceId === state.selectedDeviceId) {
      state.castingDeviceId = null;
      updateDlnaBanner();
    }
    send({ type: "control", deviceId: state.selectedDeviceId, action: "stop" });
  });

  els.refreshDevicesBtn.addEventListener("click", function () {
    if (!send({ type: "refreshDevices" })) return;
    showToast("正在重新扫描 DLNA 设备…");
    els.refreshDevicesBtn.disabled = true;
    setTimeout(function () {
      els.refreshDevicesBtn.disabled = false;
    }, 6000);
  });

  els.seekSlider.addEventListener("pointerdown", function () {
    state.draggingSeek = true;
  });
  els.seekSlider.addEventListener("input", function () {
    els.positionText.textContent = formatTime(Number(els.seekSlider.value));
  });
  els.seekSlider.addEventListener("change", function () {
    state.draggingSeek = false;
    if (!state.selectedDeviceId) return;
    send({
      type: "control",
      deviceId: state.selectedDeviceId,
      action: "seek",
      positionMs: Number(els.seekSlider.value)
    });
  });

  els.connectBtn.addEventListener("click", function () {
    const token = els.consoleTokenInput.value.trim();
    if (token.length < 16) {
      els.authError.textContent = "访问令牌至少 16 个字符，请查看 console-token.txt。";
      return;
    }
    state.consoleToken = token;
    try { localStorage.setItem("casthub-token", token); } catch (error) { /* ignore */ }
    els.authError.textContent = "";
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.close();
      state.ws = null;
    }
    loadFiles("");
    connectWs();
  });

  function start() {
    if (!state.consoleToken) {
      showAuthGate("");
      return;
    }
    hideAuthGate();
    loadFiles("");
    connectWs();
  }

  start();
})();
