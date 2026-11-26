/* CastHub 控制台前端（原生 JS，无构建步骤） */
(function () {
  "use strict";

  const state = {
    devices: [],
    history: [],
    queues: {},
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
    draggingVolume: false,
    volumeSendTimer: null,
    lastVolumeSentAt: 0,
    consoleToken: "",
    authenticated: false,
    desktopUpdateBusy: false,
    tvDesktop: null,
    tvDesktopBusy: false,
    tvDesktopInstalled: {},
    tvDesktopInstalledPending: null,
    tvDesktopAutoQueried: false,
    tvDesktopAppId: null,
    tvDesktopVariantId: null,
  };

  const tokenFromHash = new URLSearchParams(location.hash.replace(/^#/, "")).get("token");
  const tokenFromQuery = new URLSearchParams(location.search).get("token");
  const incomingToken = tokenFromHash || tokenFromQuery;
  if (incomingToken) {
    state.consoleToken = incomingToken;
    try {
      localStorage.setItem("casthub-token", incomingToken);
    } catch (error) {
      /* ignore */
    }
    try {
      history.replaceState(null, "", location.pathname);
    } catch (error) {
      /* ignore */
    }
  } else {
    try {
      state.consoleToken = localStorage.getItem("casthub-token") || "";
    } catch (error) {
      /* ignore */
    }
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
    volumeBlock: document.getElementById("volumeBlock"),
    volumeSlider: document.getElementById("volumeSlider"),
    volumeValue: document.getElementById("volumeValue"),
    volumeHint: document.getElementById("volumeHint"),
    dlnaOptions: document.getElementById("dlnaOptions"),
    dlnaSubtitleMode: document.getElementById("dlnaSubtitleMode"),
    queueTitle: document.getElementById("queueTitle"),
    queueStatus: document.getElementById("queueStatus"),
    queueList: document.getElementById("queueList"),
    queuePlayBtn: document.getElementById("queuePlayBtn"),
    queueClearBtn: document.getElementById("queueClearBtn"),
    desktopSettingsPanel: document.getElementById("desktopSettingsPanel"),
    desktopVersion: document.getElementById("desktopVersion"),
    autoStartToggle: document.getElementById("autoStartToggle"),
    desktopCheckUpdatesBtn: document.getElementById("desktopCheckUpdatesBtn"),
    desktopInstallUpdateBtn: document.getElementById("desktopInstallUpdateBtn"),
    updateStatus: document.getElementById("updateStatus"),
    tvDesktopPanel: document.getElementById("tvDesktopPanel"),
    tvDesktopAdbStatus: document.getElementById("tvDesktopAdbStatus"),
    tvDesktopIntro: document.getElementById("tvDesktopIntro"),
    tvDesktopApp: document.getElementById("tvDesktopApp"),
    tvDesktopVariantRow: document.getElementById("tvDesktopVariantRow"),
    tvDesktopVariant: document.getElementById("tvDesktopVariant"),
    tvDesktopAppNotice: document.getElementById("tvDesktopAppNotice"),
    tvDesktopFooterHint: document.getElementById("tvDesktopFooterHint"),
    tvDesktopDevice: document.getElementById("tvDesktopDevice"),
    tvDesktopMeta: document.getElementById("tvDesktopMeta"),
    tvDesktopInstallBtn: document.getElementById("tvDesktopInstallBtn"),
    tvDesktopUninstallBtn: document.getElementById("tvDesktopUninstallBtn"),
    tvDesktopProgress: document.getElementById("tvDesktopProgress"),
    tvDesktopStatus: document.getElementById("tvDesktopStatus"),
    tvDesktopStepsWrap: document.getElementById("tvDesktopStepsWrap"),
    tvDesktopSteps: document.getElementById("tvDesktopSteps"),
    tvDesktopCustomUrl: document.getElementById("tvDesktopCustomUrl"),
    tvDesktopCopyRestoreBtn: document.getElementById("tvDesktopCopyRestoreBtn"),
    tvDesktopPlatformToolsBtn: document.getElementById("tvDesktopPlatformToolsBtn"),
    tvDesktopRefreshBtn: document.getElementById("tvDesktopRefreshBtn"),
    toast: document.getElementById("toast"),
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
    const ws = new WebSocket(
      protocol + "//" + location.host + "/console?token=" + encodeURIComponent(state.consoleToken),
    );
    state.ws = ws;

    ws.onopen = function () {
      state.authenticated = true;
      hideAuthGate();
      els.connState.textContent = "已连接中枢";
      els.connState.className = "conn-state ok";
      state.tvDesktopInstalled = {};
      state.tvDesktopInstalledPending = null;
      state.tvDesktopAutoQueried = false;
      requestTvDesktopInfo(false);
    };
    ws.onclose = function (event) {
      if (event.code === 1008 && event.reason === "unauthorized") {
        state.ws = null;
        showAuthGate("访问令牌无效或已过期，请重新输入。");
        els.connState.textContent = "需要访问令牌";
        els.connState.className = "conn-state bad";
        return;
      }
      if (event.code === 1013) {
        els.connState.textContent = "连接数过多，稍后重试…";
        els.connState.className = "conn-state bad";
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(connectWs, 5000);
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
      if (
        !state.devices.some(function (d) {
          return d.id === state.selectedDeviceId;
        })
      ) {
        const firstOnline = state.devices.find(function (d) {
          return d.online;
        });
        state.selectedDeviceId = firstOnline ? firstOnline.id : state.devices[0] ? state.devices[0].id : null;
        state.tvStatus = null;
      }
      if (
        state.castingDeviceId &&
        !state.devices.some(function (d) {
          return d.id === state.castingDeviceId;
        })
      ) {
        state.castingDeviceId = null;
      }
      renderDevices();
      renderControls();
      updateDlnaBanner();
      renderQueue();
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
    if (msg.type === "queue") {
      if (msg.deviceId) state.queues[msg.deviceId] = msg.queue;
      renderQueue();
      return;
    }
    if (msg.type === "desktopInfo") {
      applyTvDesktopInfo(msg);
      return;
    }
    if (msg.type === "desktopProgress") {
      applyTvDesktopProgress(msg);
      return;
    }
    if (msg.type === "desktopResult") {
      state.tvDesktopBusy = false;
      state.tvDesktop = null;
      state.tvDesktopInstalled = {};
      state.tvDesktopInstalledPending = null;
      state.tvDesktopAutoQueried = false;
      renderTvDesktopResult(msg);
      requestTvDesktopInfo(false);
      return;
    }
    if (msg.type === "error") {
      if (state.tvDesktopBusy) {
        state.tvDesktopBusy = false;
        setTvDesktopStatus(msg.message || "未知错误", true);
        setTvDesktopProgress(null);
        renderTvDesktop();
      }
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
      hour12: false,
    });
  }

  function castFile(entry, resume) {
    if (!state.selectedDeviceId) {
      showToast("请先添加并选择一台电视", true);
      return;
    }
    state.currentTitle = entry.name;
    els.playerTitle.textContent = entry.name;
    const payload = { type: "cast", deviceId: state.selectedDeviceId, path: entry.path, resume: !!resume };
    const selected = state.devices.find(function (d) {
      return d.id === state.selectedDeviceId;
    });
    if (selected && selected.type === "dlna") {
      payload.subtitleMode = els.dlnaSubtitleMode.value;
    }
    if (send(payload)) {
      state.castingDeviceId = state.selectedDeviceId;
      updateDlnaBanner();
    }
  }

  function castHistory(entry, resume) {
    castFile({ name: entry.name, path: entry.path }, resume);
  }

  function sendVolume(value) {
    const deviceId = state.selectedDeviceId;
    if (!deviceId) return;
    const target = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    const now = Date.now();
    const elapsed = now - state.lastVolumeSentAt;
    if (elapsed >= 300) {
      state.lastVolumeSentAt = now;
      send({ type: "control", deviceId: deviceId, action: "volume", value: target });
      return;
    }
    if (state.volumeSendTimer) clearTimeout(state.volumeSendTimer);
    state.volumeSendTimer = setTimeout(function () {
      state.volumeSendTimer = null;
      state.lastVolumeSentAt = Date.now();
      send({ type: "control", deviceId: deviceId, action: "volume", value: target });
    }, 300 - elapsed);
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
      meta.textContent =
        "更新 " + formatUpdatedAt(entry.updatedAt) + " · 播放 " + (Number(entry.playCount) || 0) + " 次";
      const actions = document.createElement("div");
      actions.className = "history-actions";
      const continueBtn = document.createElement("button");
      continueBtn.textContent = "继续播放";
      continueBtn.addEventListener("click", function () {
        castHistory(entry, true);
      });
      const restartBtn = document.createElement("button");
      restartBtn.className = "secondary";
      restartBtn.textContent = "从头播放";
      restartBtn.addEventListener("click", function () {
        castHistory(entry, false);
      });
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "danger";
      deleteBtn.textContent = "删除";
      deleteBtn.addEventListener("click", function () {
        send({ type: "deleteHistory", path: entry.path });
      });
      actions.appendChild(continueBtn);
      actions.appendChild(restartBtn);
      actions.appendChild(deleteBtn);
      row.appendChild(main);
      row.appendChild(meta);
      row.appendChild(actions);
      els.historyList.appendChild(row);
    });
  }

  function renderQueue() {
    const selected = state.devices.find(function (d) {
      return d.id === state.selectedDeviceId;
    });
    const isDlna = !!(selected && selected.type === "dlna");
    const queue = selected ? state.queues[selected.id] : null;
    const items = queue && Array.isArray(queue.items) ? queue.items : [];
    els.queueTitle.textContent = "播放队列（" + items.length + "）";
    els.queueList.innerHTML = "";

    if (!selected) {
      els.queueStatus.textContent = "请先选择设备";
    } else if (!isDlna) {
      els.queueStatus.textContent = "队列功能暂只支持 DLNA";
    } else if (!items.length) {
      els.queueStatus.textContent = "队列为空";
    } else if (queue.state === "completed") {
      els.queueStatus.textContent = "队列已完成";
    } else if (queue.state === "playing" || queue.state === "switching") {
      els.queueStatus.textContent = "正在播放 " + (queue.currentIndex + 1) + "/" + items.length;
    } else if (queue.state === "paused") {
      els.queueStatus.textContent = "队列已暂停（第 " + (queue.currentIndex + 1) + "/" + items.length + " 项）";
    } else {
      els.queueStatus.textContent = "队列待播放";
    }
    if (queue && queue.error) els.queueStatus.textContent += " · " + queue.error;

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = isDlna ? "还没有节目，点击视频行的“加入队列”" : "仅 DLNA 设备支持队列";
      els.queueList.appendChild(empty);
    } else {
      items.forEach(function (item, index) {
        const row = document.createElement("div");
        row.className = "queue-item" + (queue.currentIndex === index ? " active" : "");
        const idx = document.createElement("span");
        idx.className = "queue-index";
        idx.textContent = String(index + 1);
        const name = document.createElement("span");
        name.className = "queue-name";
        name.textContent = item.name || item.path || "";
        name.title = item.name || item.path || "";
        const removeBtn = document.createElement("button");
        removeBtn.className = "secondary";
        removeBtn.textContent = "移除";
        const isCurrent = queue.currentIndex === index && (queue.state === "playing" || queue.state === "switching");
        removeBtn.disabled = isCurrent;
        if (isCurrent) removeBtn.title = "当前播放项不允许移除，请先停止播放";
        removeBtn.addEventListener("click", function () {
          send({ type: "queueRemove", deviceId: selected.id, index: index });
        });
        row.appendChild(idx);
        row.appendChild(name);
        row.appendChild(removeBtn);
        els.queueList.appendChild(row);
      });
    }

    els.queuePlayBtn.disabled =
      !isDlna || !items.length || !queue || queue.state === "playing" || queue.state === "switching";
    els.queuePlayBtn.textContent =
      queue && queue.state === "paused" ? "继续队列" : queue && queue.state === "completed" ? "重新播放" : "开始播放";
    els.queueClearBtn.disabled = !isDlna || !items.length;
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
        ? "<span>自动发现</span>"
        : '<button class="danger" data-remove="' + escapeHtml(device.id) + '">移除</button>';
      row.innerHTML =
        '<div><span class="badge ' +
        (isDlna ? "dlna" : "app") +
        '">' +
        (isDlna ? "DLNA" : "App") +
        "</span>" +
        '<span class="name">' +
        escapeHtml(device.deviceName || (isDlna ? "DLNA 设备" : "电视")) +
        "</span></div>" +
        '<div class="addr">' +
        escapeHtml(device.address) +
        "</div>" +
        '<div class="meta"><span><span class="dot' +
        (device.online ? " online" : "") +
        '"></span>' +
        (device.online ? "在线" : "离线") +
        "</span>" +
        removeButton +
        "</div>";
      row.addEventListener("click", function (event) {
        if (event.target && event.target.getAttribute("data-remove")) return;
        state.selectedDeviceId = device.id;
        state.tvStatus = null;
        renderDevices();
        renderControls();
        updateDlnaBanner();
        renderQueue();
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
    const selected = state.devices.find(function (d) {
      return d.id === state.selectedDeviceId;
    });
    const casting = state.devices.find(function (d) {
      return d.id === state.castingDeviceId;
    });
    const visible = !!((selected && selected.type === "dlna") || (casting && casting.type === "dlna"));
    els.dlnaBanner.hidden = !visible;
  }

  function renderControls() {
    const status = state.tvStatus;
    const selected = state.devices.find(function (d) {
      return d.id === state.selectedDeviceId;
    });
    const isDlna = !!(selected && selected.type === "dlna");
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

    els.volumeBlock.hidden = !isDlna;
    els.dlnaOptions.hidden = !isDlna;
    if (isDlna) {
      const statusVolume = status && typeof status.volume === "number" ? status.volume : null;
      const deviceVolume = typeof selected.volume === "number" ? selected.volume : null;
      const volume = statusVolume !== null ? statusVolume : deviceVolume;
      const volumeAvailable = !!(selected.online && volume !== null);
      els.volumeSlider.disabled = !volumeAvailable;
      if (volumeAvailable) {
        if (!state.draggingVolume) els.volumeSlider.value = String(Math.round(volume));
        els.volumeValue.textContent = Math.round(volume) + "%";
        els.volumeHint.hidden = true;
      } else {
        els.volumeValue.textContent = "—";
        els.volumeHint.hidden = false;
      }
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
    const pad = function (n) {
      return n < 10 ? "0" + n : String(n);
    };
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
      headers: { "x-casthub-token": state.consoleToken },
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
    root.addEventListener("click", function () {
      loadFiles("");
    });
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
      link.addEventListener("click", function () {
        loadFiles(target);
      });
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
        "<span>" +
        (entry.isDir ? "📁" : "🎬") +
        "</span>" +
        '<span class="file-name" title="' +
        escapeHtml(entry.name) +
        '">' +
        escapeHtml(entry.name) +
        "</span>" +
        '<span class="file-mime">' +
        escapeHtml(entry.mimeType || (entry.isDir ? "文件夹" : "")) +
        "</span>" +
        '<span class="file-size">' +
        (entry.isDir ? "-" : formatSize(entry.size)) +
        "</span>" +
        "<span></span>";
      if (entry.isDir) {
        row.addEventListener("click", function () {
          loadFiles(entry.path);
        });
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
        const selectedDevice = state.devices.find(function (d) {
          return d.id === state.selectedDeviceId;
        });
        const queueBtn = document.createElement("button");
        queueBtn.className = "secondary";
        queueBtn.textContent = "加入队列";
        queueBtn.disabled = !(selectedDevice && selectedDevice.type === "dlna");
        queueBtn.title = queueBtn.disabled ? "请先选择 DLNA 设备" : "追加到该设备的播放队列";
        queueBtn.addEventListener("click", function (event) {
          event.stopPropagation();
          if (!state.selectedDeviceId) return;
          send({ type: "queueAdd", deviceId: state.selectedDeviceId, path: entry.path });
        });
        actions.appendChild(queueBtn);
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

  els.queuePlayBtn.addEventListener("click", function () {
    if (!state.selectedDeviceId) return;
    send({ type: "queuePlay", deviceId: state.selectedDeviceId });
  });

  els.queueClearBtn.addEventListener("click", function () {
    if (!state.selectedDeviceId) return;
    if (!window.confirm("确定清空播放队列？正在播放时会先停止当前视频。")) return;
    send({ type: "queueClear", deviceId: state.selectedDeviceId });
  });

  els.addDeviceBtn.addEventListener("click", function () {
    const address = els.deviceAddress.value.trim();
    const token = els.deviceToken.value.trim();
    if (!address) {
      showToast("请输入电视 WS 地址", true);
      return;
    }
    if (!/^\d{6,8}$/.test(token)) {
      showToast("配对码必须是 6-8 位数字", true);
      return;
    }
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
      positionMs: Number(els.seekSlider.value),
    });
  });

  els.volumeSlider.addEventListener("pointerdown", function () {
    state.draggingVolume = true;
  });
  els.volumeSlider.addEventListener("input", function () {
    els.volumeValue.textContent = els.volumeSlider.value + "%";
  });
  els.volumeSlider.addEventListener("change", function () {
    state.draggingVolume = false;
    sendVolume(Number(els.volumeSlider.value));
  });

  function setUpdateStatus(message) {
    els.updateStatus.textContent = message || "";
  }

  function setInstallButton(label, disabled) {
    els.desktopInstallUpdateBtn.textContent = label;
    els.desktopInstallUpdateBtn.disabled = disabled === true;
  }

  function applyUpdateInfo(info) {
    if (state.desktopUpdateBusy) return;
    const version = info && info.version ? String(info.version) : "";
    els.desktopInstallUpdateBtn.hidden = !version;
    setInstallButton("立即更新", false);
    if (version) setUpdateStatus("发现新版本 v" + version);
  }

  function applyUpdateProgress(progress) {
    if (!progress || !progress.phase) return;
    if (progress.phase === "downloading") {
      state.desktopUpdateBusy = true;
      els.desktopInstallUpdateBtn.hidden = false;
      setInstallButton(progress.percent > 0 ? "正在下载 " + progress.percent + "%" : "正在下载…", true);
      setUpdateStatus(progress.message || "正在下载更新…");
    } else if (progress.phase === "verifying") {
      state.desktopUpdateBusy = true;
      setInstallButton("正在校验…", true);
      setUpdateStatus("正在校验下载文件…");
    } else if (progress.phase === "installing") {
      state.desktopUpdateBusy = true;
      setInstallButton("正在安装，应用即将重启…", true);
      setUpdateStatus("正在安装，应用即将重启…");
    } else if (progress.phase === "error") {
      state.desktopUpdateBusy = false;
      els.desktopInstallUpdateBtn.hidden = false;
      setInstallButton("重试更新", false);
      setUpdateStatus(progress.message || "更新失败");
    }
  }

  function applyDesktopSettings(settings) {
    if (!settings) return;
    els.autoStartToggle.checked = settings.autoStart === true;
    els.desktopVersion.textContent = settings.version ? "v" + settings.version : "";
    applyUpdateInfo(settings.updateAvailable);
  }

  function initDesktopSettings() {
    const desktop = window.casthubDesktop;
    if (!desktop) return;
    els.desktopSettingsPanel.hidden = false;
    desktop
      .getSettings()
      .then(applyDesktopSettings)
      .catch(function () {
        showToast("读取桌面设置失败", true);
      });
    // 托盘菜单也能改开机自启；窗口重新获得焦点时从 config.json 刷新开关，保证双向同步。
    window.addEventListener("focus", function () {
      desktop
        .getSettings()
        .then(applyDesktopSettings)
        .catch(function () {
          /* ignore */
        });
    });
    els.autoStartToggle.addEventListener("change", function () {
      const target = els.autoStartToggle.checked;
      els.autoStartToggle.disabled = true;
      desktop
        .setAutoStart(target)
        .then(function (result) {
          els.autoStartToggle.checked = !!(result && result.autoStart);
          if (!result || !result.ok) {
            showToast("设置开机自启失败: " + (result && result.error ? result.error : "未知错误"), true);
            return;
          }
          showToast(result.autoStart ? "已开启开机自启" : "已关闭开机自启");
        })
        .catch(function (error) {
          els.autoStartToggle.checked = !target;
          showToast("设置开机自启失败: " + error.message, true);
        })
        .finally(function () {
          els.autoStartToggle.disabled = false;
        });
    });
    els.desktopCheckUpdatesBtn.addEventListener("click", function () {
      els.desktopCheckUpdatesBtn.disabled = true;
      setUpdateStatus("正在检查…");
      desktop
        .checkUpdates()
        .then(function (result) {
          if (result && result.status === "found") {
            applyUpdateInfo({ version: result.version || String(result.latest || "").replace(/^v/i, "") });
          } else if (result && result.status === "latest") {
            applyUpdateInfo(null);
            setUpdateStatus("已是最新版本");
          } else if (result && result.status === "skipped") {
            applyUpdateInfo(null);
            setUpdateStatus("未配置更新仓库");
          } else {
            applyUpdateInfo(null);
            setUpdateStatus("检查失败: " + (result && result.message ? result.message : "未知错误"));
          }
        })
        .catch(function (error) {
          setUpdateStatus("检查失败: " + error.message);
        })
        .finally(function () {
          els.desktopCheckUpdatesBtn.disabled = false;
        });
    });
    els.desktopInstallUpdateBtn.addEventListener("click", function () {
      if (state.desktopUpdateBusy) return;
      state.desktopUpdateBusy = true;
      els.desktopInstallUpdateBtn.hidden = false;
      setInstallButton("正在准备…", true);
      setUpdateStatus("正在准备更新…");
      desktop
        .installUpdate()
        .then(function (result) {
          if (result && result.ok) return;
          state.desktopUpdateBusy = false;
          els.desktopInstallUpdateBtn.hidden = false;
          setInstallButton("重试更新", false);
          const message = result && result.error ? result.error : "未知错误";
          setUpdateStatus("更新失败: " + message);
          showToast("更新失败: " + message, true);
        })
        .catch(function (error) {
          state.desktopUpdateBusy = false;
          els.desktopInstallUpdateBtn.hidden = false;
          setInstallButton("重试更新", false);
          setUpdateStatus("更新失败: " + error.message);
          showToast("更新失败: " + error.message, true);
        });
    });
    desktop.onUpdateAvailable(function (info) {
      if (info && info.version) {
        applyUpdateInfo(info);
        showToast("发现新版本 v" + info.version + "，可在桌面设置或托盘菜单立即更新");
      }
    });
    if (typeof desktop.onUpdateProgress === "function") {
      desktop.onUpdateProgress(applyUpdateProgress);
    }
  }

  function setTvDesktopStatus(text, isError) {
    els.tvDesktopStatus.textContent = text || "";
    els.tvDesktopStatus.className = "tv-desktop-status" + (text ? (isError ? " bad" : " ok") : "");
  }

  function setTvDesktopProgress(percent) {
    const value = percent === null || percent === undefined ? null : Math.max(0, Math.min(100, Number(percent) || 0));
    if (value === null) {
      els.tvDesktopProgress.hidden = true;
      els.tvDesktopProgress.firstElementChild.style.width = "0%";
      return;
    }
    els.tvDesktopProgress.hidden = false;
    els.tvDesktopProgress.firstElementChild.style.width = value + "%";
  }

  function formatBytes(value) {
    const size = Number(value) || 0;
    if (size <= 0) return "未知大小";
    if (size >= 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + " MB";
    if (size >= 1024) return Math.round(size / 1024) + " KB";
    return size + " B";
  }

  function tvDesktopAppName() {
    const info = state.tvDesktop;
    return (info && info.appName) || "Aerial";
  }

  function tvDesktopInstallLabel(busy) {
    if (busy) return "正在执行…";
    const info = state.tvDesktop;
    const kind = (info && info.installKind) || "launcher";
    return kind === "launcher" ? "一键安装桌面" : "安装 " + tvDesktopAppName();
  }

  function setTvDesktopBusy(busy) {
    state.tvDesktopBusy = !!busy;
    els.tvDesktopInstallBtn.disabled = !!busy;
    els.tvDesktopUninstallBtn.disabled = !!busy || !state.tvDesktop || !state.tvDesktop.adb || !state.tvDesktop.adb.available;
    els.tvDesktopRefreshBtn.disabled = !!busy;
    els.tvDesktopInstallBtn.textContent = tvDesktopInstallLabel(!!busy);
  }

  function selectedTvDesktopDeviceId() {
    const id = els.tvDesktopDevice.value;
    return id ? id : null;
  }

  /** 拉取面板信息；带 deviceId 时中枢会顺带查电视上已装的 Aerial 版本。 */
  function requestTvDesktopInfo(force) {
    const deviceId = selectedTvDesktopDeviceId();
    const payload = { type: "getDesktopInfo" };
    if (deviceId) payload.deviceId = deviceId;
    if (state.tvDesktopAppId) payload.appId = state.tvDesktopAppId;
    if (state.tvDesktopVariantId) payload.variantId = state.tvDesktopVariantId;
    if (force) payload.force = true;
    send(payload);
  }

  function queryTvDesktopInstalled(deviceId) {
    if (!deviceId || state.tvDesktopBusy) return;
    if (state.tvDesktopInstalled[deviceId]) return;
    state.tvDesktopInstalledPending = deviceId;
    const payload = { type: "getDesktopInfo", deviceId: deviceId };
    if (state.tvDesktopAppId) payload.appId = state.tvDesktopAppId;
    if (state.tvDesktopVariantId) payload.variantId = state.tvDesktopVariantId;
    send(payload);
  }

  function applyTvDesktopInfo(msg) {
    state.tvDesktop = msg;
    if (msg.activeAppId) state.tvDesktopAppId = msg.activeAppId;
    if (msg.variantId) state.tvDesktopVariantId = msg.variantId;
    const installed = msg.installed;
    if (installed && installed.deviceId) {
      state.tvDesktopInstalled[installed.deviceId] = installed;
      if (state.tvDesktopInstalledPending === installed.deviceId) state.tvDesktopInstalledPending = null;
    }
    renderTvDesktop();
    // 首次连上后自动查一次当前选中电视的已装版本（之后切设备按需查、结果缓存）。
    if (!installed && !state.tvDesktopAutoQueried && !state.tvDesktopBusy) {
      const deviceId = selectedTvDesktopDeviceId();
      if (deviceId) {
        state.tvDesktopAutoQueried = true;
        queryTvDesktopInstalled(deviceId);
      }
    }
  }

  /** 「刷新」：绕过中枢 10 分钟发布缓存，并重新读取已装版本。 */
  function refreshTvDesktop() {
    const deviceId = selectedTvDesktopDeviceId();
    state.tvDesktopAutoQueried = true;
    if (deviceId) {
      delete state.tvDesktopInstalled[deviceId];
      state.tvDesktopInstalledPending = deviceId;
    }
    requestTvDesktopInfo(true);
  }

  function renderTvDesktop() {
    const info = state.tvDesktop;
    if (!info) {
      els.tvDesktopPanel.hidden = true;
      return;
    }
    els.tvDesktopPanel.hidden = false;

    const apps = Array.isArray(info.apps) ? info.apps : [];
    const appName = info.appName || "Aerial";
    const installKind = info.installKind || "launcher";
    if (apps.length) {
      const previousApp = els.tvDesktopApp.value || state.tvDesktopAppId || info.activeAppId || apps[0].id;
      els.tvDesktopApp.innerHTML = "";
      apps.forEach(function (app) {
        const option = document.createElement("option");
        option.value = app.id;
        option.textContent = app.name;
        els.tvDesktopApp.appendChild(option);
      });
      const keepApp = apps.some(function (app) {
        return app.id === previousApp;
      });
      els.tvDesktopApp.value = keepApp ? previousApp : apps[0].id;
      const active = apps.find(function (app) {
        return app.id === els.tvDesktopApp.value;
      }) || apps[0];
      const variants = Array.isArray(active.variants) ? active.variants : [];
      const previousVariant = els.tvDesktopVariant.value || state.tvDesktopVariantId || info.variantId || active.defaultVariant;
      els.tvDesktopVariant.innerHTML = "";
      variants.forEach(function (variant) {
        const option = document.createElement("option");
        option.value = variant.id;
        option.textContent = variant.name + (variant.id === active.defaultVariant ? "（推荐）" : "");
        els.tvDesktopVariant.appendChild(option);
      });
      const keepVariant = variants.some(function (variant) {
        return variant.id === previousVariant;
      });
      els.tvDesktopVariant.value = keepVariant ? previousVariant : active.defaultVariant;
      els.tvDesktopVariantRow.hidden = variants.length <= 1;
      els.tvDesktopIntro.textContent =
        active.description +
        (active.installKind === "launcher"
          ? " 需要先在电视上开启 ADB 调试，安装后会接管 Home 键。"
          : " 需要先在电视上开启 ADB 调试，安装后可在电视应用列表里打开。") +
        (active.sharedPackage
          ? " 注意：这些变体共用同一个包名（" + variants.map(function (variant) { return variant.packageName; })[0] + "），同一台电视只能装一个，换版本请先卸载；直接重新安装会自动卸掉旧包。"
          : "");
      if (active.notice) {
        els.tvDesktopAppNotice.textContent = active.notice;
        els.tvDesktopAppNotice.hidden = false;
      } else {
        els.tvDesktopAppNotice.textContent = "";
        els.tvDesktopAppNotice.hidden = true;
      }
      if (els.tvDesktopFooterHint) {
        els.tvDesktopFooterHint.textContent =
          active.installKind === "launcher"
            ? "安装包不随 CastHub 分发，安装时从 GitHub 官方发布页（或官网镜像）下载；提供 SHA-256 时强制校验，未提供时会在开始前要求确认来源可信。adb 缺失时可点下方按钮查看下载地址。还原只做通用步骤，品牌定制项请用官方脚本。"
            : "安装包不随 CastHub 分发，安装时从 GitHub 官方发布页下载；提供 SHA-256 时强制校验，未提供时会在开始前要求确认来源可信。adb 缺失时可点下方按钮查看下载地址。普通应用只做卸载，不涉及桌面还原。";
      }
    }

    const adb = info.adb || {};
    const adbOk = !!adb.available;
    els.tvDesktopAdbStatus.textContent = adbOk ? "adb 就绪" + (adb.version ? " " + adb.version : "") : "adb 未找到";
    els.tvDesktopAdbStatus.className = "tv-desktop-head-status " + (adbOk ? "ok" : "bad");

    const targets = Array.isArray(info.targets) ? info.targets : [];
    const previous = els.tvDesktopDevice.value;
    els.tvDesktopDevice.innerHTML = "";
    if (!targets.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "暂无可用设备（先在上方添加电视）";
      els.tvDesktopDevice.appendChild(option);
    } else {
      targets.forEach(function (target) {
        const option = document.createElement("option");
        option.value = target.deviceId;
        option.textContent = (target.name || target.deviceId) + (target.ip ? " · " + target.ip : " · 无法解析 IP");
        els.tvDesktopDevice.appendChild(option);
      });
      const keep = targets.some(function (target) {
        return target.deviceId === previous;
      });
      els.tvDesktopDevice.value = keep ? previous : targets[0].deviceId;
    }

    const meta = els.tvDesktopMeta;
    meta.innerHTML = "";
    function addLine(label, value, className) {
      const line = document.createElement("div");
      const code = document.createElement("code");
      if (className) code.className = className;
      code.textContent = value;
      line.textContent = label + "：";
      line.appendChild(code);
      meta.appendChild(line);
    }
    if (!adbOk) {
      addLine("adb", adb.hint || "未找到 adb，请安装 platform-tools 或把 adb 加入 PATH");
    } else {
      addLine("adb", adb.path || "");
    }
    if (info.release) {
      const release = info.release;
      addLine(
        appName,
        "v" +
          String(release.tag || "").replace(/^v/i, "") +
          " · " +
          formatBytes(release.sizeBytes) +
          (release.channel === "github" ? "" : " · " + (release.channel === "mirror" ? "官网镜像" : "自定义")),
      );
      addLine("sha256", release.sha256 || "发布页未提供校验和");
    } else {
      addLine(appName, info.releaseError || "无法获取最新版本信息");
    }

    const deviceId = selectedTvDesktopDeviceId();
    const installed = deviceId ? state.tvDesktopInstalled[deviceId] : null;
    if (deviceId) {
      if (state.tvDesktopInstalledPending === deviceId) {
        addLine("电视上的 " + appName, "正在读取…");
      } else if (installed && installed.error) {
        addLine("电视上的 " + appName, installed.error);
      } else if (installed && !installed.installed) {
        addLine("电视上的 " + appName, "未安装");
      } else if (installed) {
        addLine("电视上的 " + appName, "v" + String(installed.version || ""));
        if (installed.updateAvailable && info.release) {
          addLine(
            "可更新",
            "有新版本 v" + String(info.release.tag || "").replace(/^v/i, "") + "，可重新一键安装升级",
            "update",
          );
        }
      }
    }

    setTvDesktopBusy(state.tvDesktopBusy);
    if (deviceId && !installed && state.tvDesktopInstalledPending !== deviceId) {
      queryTvDesktopInstalled(deviceId);
    }
    els.tvDesktopInstallBtn.textContent = state.tvDesktopBusy
      ? "正在执行…"
      : installKind === "launcher"
        ? "一键安装桌面"
        : "安装 " + appName;
    els.tvDesktopUninstallBtn.textContent = installKind === "launcher" ? "还原原桌面" : "卸载 " + appName;
  }

  function renderTvDesktopStep(step) {
    const row = document.createElement("div");
    row.className = "tv-desktop-step";
    const mark = document.createElement("span");
    mark.className = step.ok ? "ok" : step.required ? "fail" : "skip";
    mark.textContent = step.ok ? "✓" : step.required ? "✗" : "–";
    const body = document.createElement("div");
    const cmd = document.createElement("div");
    cmd.className = "cmd";
    cmd.textContent = step.command;
    body.appendChild(cmd);
    if (step.output) {
      const out = document.createElement("div");
      out.className = "out";
      out.textContent = step.output;
      body.appendChild(out);
    }
    row.appendChild(mark);
    row.appendChild(body);
    return row;
  }

  function renderTvDesktopResult(result) {
    const steps = Array.isArray(result.steps) ? result.steps : [];
    els.tvDesktopSteps.innerHTML = "";
    steps.forEach(function (step) {
      els.tvDesktopSteps.appendChild(renderTvDesktopStep(step));
    });
    els.tvDesktopStepsWrap.hidden = steps.length === 0;
    if (steps.length) els.tvDesktopStepsWrap.open = !result.ok;
    setTvDesktopProgress(null);
    setTvDesktopStatus(result.message || (result.ok ? "已完成" : "执行失败"), !result.ok);
    showToast(result.message || (result.ok ? "已完成" : "执行失败"), !result.ok);
  }

  function applyTvDesktopProgress(progress) {
    if (!progress) return;
    state.tvDesktopBusy = true;
    setTvDesktopBusy(true);
    const percent = Number(progress.percent);
    if (isFinite(percent) && percent > 0) {
      setTvDesktopProgress(percent);
      setTvDesktopStatus(progress.action === "uninstall" ? "正在还原…" : "正在下载安装包 " + percent + "%", false);
    } else {
      setTvDesktopStatus(progress.action === "uninstall" ? "正在还原…" : "正在准备…", false);
    }
  }

  function selectedTvDesktopTarget() {
    const info = state.tvDesktop;
    if (!info || !Array.isArray(info.targets)) return null;
    const id = els.tvDesktopDevice.value;
    return (
      info.targets.find(function (target) {
        return target.deviceId === id;
      }) || null
    );
  }

  function copyText(text, okMessage) {
    if (!text) return;
    const fallback = function () {
      showToast(text, false);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        showToast(okMessage, false);
      }, fallback);
      return;
    }
    fallback();
  }

  function initTvDesktop() {
    els.tvDesktopInstallBtn.addEventListener("click", function () {
      if (state.tvDesktopBusy) return;
      const target = selectedTvDesktopTarget();
      if (!target) {
        showToast("请先选择目标电视", true);
        return;
      }
      if (!target.ip) {
        showToast("无法从设备地址解析电视 IP", true);
        return;
      }
      if (!state.tvDesktop || !state.tvDesktop.adb || !state.tvDesktop.adb.available) {
        setTvDesktopStatus(state.tvDesktop && state.tvDesktop.adb ? state.tvDesktop.adb.hint : "adb 不可用", true);
        return;
      }
      const info = state.tvDesktop || {};
      const appName = info.appName || "Aerial";
      const isLauncher = (info.installKind || "launcher") === "launcher";
      const variantName = info.variantName ? "（" + info.variantName + "）" : "";
      if (
        !window.confirm(
          isLauncher
            ? "即将在「" + (target.name || target.ip) + "」上安装 " + appName + " 并接管 Home 键，确定继续？"
            : "即将在「" + (target.name || target.ip) + "」上安装 " + appName + variantName + "，确定继续？",
        )
      ) {
        return;
      }
      const payload = { type: "installDesktop", deviceId: target.deviceId };
      if (info.activeAppId) payload.appId = info.activeAppId;
      if (info.variantId) payload.variantId = info.variantId;
      const customUrl = els.tvDesktopCustomUrl.value.trim();
      if (customUrl) payload.apkUrl = customUrl;
      const release = state.tvDesktop && state.tvDesktop.release;
      if (customUrl || (release && !release.sha256)) {
        if (
          !window.confirm(
            "当前 " + appName + " 安装包未提供 SHA-256 校验值，无法验证下载完整性。请确认下载来源可信，是否继续？",
          )
        ) {
          return;
        }
        payload.allowUnverified = true;
      }
      els.tvDesktopStepsWrap.hidden = true;
      setTvDesktopBusy(true);
      setTvDesktopStatus("正在准备…", false);
      setTvDesktopProgress(0);
      if (!send(payload)) {
        setTvDesktopBusy(false);
        setTvDesktopProgress(null);
      }
    });

    els.tvDesktopUninstallBtn.addEventListener("click", function () {
      if (state.tvDesktopBusy) return;
      const target = selectedTvDesktopTarget();
      if (!target) {
        showToast("请先选择目标电视", true);
        return;
      }
      const info = state.tvDesktop || {};
      const appName = info.appName || "Aerial";
      const isLauncher = (info.installKind || "launcher") === "launcher";
      if (
        !window.confirm(
          isLauncher
            ? "将卸载 " + appName + " 并尝试恢复原厂桌面，确定继续？"
            : "将卸载 " + appName + "，确定继续？",
        )
      ) {
        return;
      }
      els.tvDesktopStepsWrap.hidden = true;
      setTvDesktopBusy(true);
      setTvDesktopStatus(isLauncher ? "正在还原…" : "正在卸载…", false);
      setTvDesktopProgress(0);
      const uninstallPayload = { type: "uninstallDesktop", deviceId: target.deviceId };
      if (info.activeAppId) uninstallPayload.appId = info.activeAppId;
      if (info.variantId) uninstallPayload.variantId = info.variantId;
      if (!send(uninstallPayload)) {
        setTvDesktopBusy(false);
        setTvDesktopProgress(null);
      }
    });

    els.tvDesktopRefreshBtn.addEventListener("click", function () {
      refreshTvDesktop();
    });

    els.tvDesktopDevice.addEventListener("change", function () {
      renderTvDesktop();
    });

    // 切换应用/变体：已装版本要重新查（同一台电视上装的是另一个包）。
    els.tvDesktopApp.addEventListener("change", function () {
      state.tvDesktopAppId = els.tvDesktopApp.value || null;
      state.tvDesktopVariantId = null;
      state.tvDesktopInstalled = {};
      state.tvDesktopInstalledPending = null;
      state.tvDesktopAutoQueried = true;
      renderTvDesktop();
      requestTvDesktopInfo(false);
    });

    els.tvDesktopVariant.addEventListener("change", function () {
      state.tvDesktopVariantId = els.tvDesktopVariant.value || null;
      state.tvDesktopInstalled = {};
      state.tvDesktopInstalledPending = null;
      state.tvDesktopAutoQueried = true;
      renderTvDesktop();
      requestTvDesktopInfo(false);
    });

    els.tvDesktopPlatformToolsBtn.addEventListener("click", function () {
      const info = state.tvDesktop;
      if (!info || !info.platformToolsUrl) {
        showToast("暂无下载地址", true);
        return;
      }
      copyText(info.platformToolsUrl, "已复制 platform-tools 下载地址");
    });

    els.tvDesktopCopyRestoreBtn.addEventListener("click", function () {
      const command =
        "curl -fsSL https://aerial.qust.me/install.sh | bash -s restore --uninstall";
      copyText(command, "已复制官方还原命令（macOS/Linux 终端执行）");
    });
  }

  els.connectBtn.addEventListener("click", function () {
    const token = els.consoleTokenInput.value.trim();
    if (token.length < 16) {
      els.authError.textContent = "访问令牌至少 16 个字符，请查看 console-token.txt。";
      return;
    }
    state.consoleToken = token;
    try {
      localStorage.setItem("casthub-token", token);
    } catch (error) {
      /* ignore */
    }
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
  initDesktopSettings();
  initTvDesktop();
})();
