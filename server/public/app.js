/* CastHub 控制台前端（原生 JS，无构建步骤） */
(function () {
  "use strict";

  const state = {
    devices: [],
    selectedDeviceId: null,
    files: [],
    currentPath: "",
    tvStatus: null,
    currentTitle: "",
    ws: null,
    reconnectTimer: null,
    draggingSeek: false
  };

  const els = {
    connState: document.getElementById("connState"),
    deviceAddress: document.getElementById("deviceAddress"),
    deviceToken: document.getElementById("deviceToken"),
    addDeviceBtn: document.getElementById("addDeviceBtn"),
    deviceList: document.getElementById("deviceList"),
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

  function connectWs() {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(protocol + "//" + location.host + "/console");
    state.ws = ws;

    ws.onopen = function () {
      els.connState.textContent = "已连接中枢";
      els.connState.className = "conn-state ok";
    };
    ws.onclose = function () {
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
    if (msg.type === "devices") {
      state.devices = Array.isArray(msg.list) ? msg.list : [];
      if (!state.devices.some(function (d) { return d.id === state.selectedDeviceId; })) {
        const firstOnline = state.devices.find(function (d) { return d.online; });
        state.selectedDeviceId = firstOnline ? firstOnline.id : (state.devices[0] ? state.devices[0].id : null);
        state.tvStatus = null;
      }
      renderDevices();
      renderControls();
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

  function renderDevices() {
    if (!state.devices.length) {
      els.deviceList.innerHTML = '<div class="empty">尚未添加设备</div>';
      return;
    }
    els.deviceList.innerHTML = "";
    state.devices.forEach(function (device) {
      const row = document.createElement("div");
      row.className = "device" + (device.id === state.selectedDeviceId ? " active" : "");
      row.innerHTML =
        '<div class="addr">' + escapeHtml(device.address) + '</div>' +
        '<div class="meta"><span><span class="dot' + (device.online ? " online" : "") + '"></span>' +
        (device.online ? "在线" : "离线") + '</span><button class="danger" data-remove="' + device.id + '">移除</button></div>';
      row.addEventListener("click", function (event) {
        if (event.target && event.target.getAttribute("data-remove")) return;
        state.selectedDeviceId = device.id;
        state.tvStatus = null;
        renderDevices();
        renderControls();
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
    if (state.currentTitle) els.playerTitle.textContent = state.currentTitle;
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
      .replace(/"/g, "&quot;");
  }

  function formatSize(bytes) {
    if (!bytes) return "-";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function loadFiles(path) {
    state.currentPath = path || "";
    fetch("/api/files?path=" + encodeURIComponent(state.currentPath))
      .then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      })
      .then(function (data) {
        state.files = Array.isArray(data.entries) ? data.entries : [];
        renderBreadcrumb();
        renderFiles();
      })
      .catch(function (error) {
        showToast("读取文件列表失败: " + error.message, true);
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
        const castBtn = document.createElement("button");
        castBtn.textContent = "投屏";
        castBtn.disabled = !state.selectedDeviceId;
        castBtn.addEventListener("click", function (event) {
          event.stopPropagation();
          if (!state.selectedDeviceId) {
            showToast("请先添加并选择一台电视", true);
            return;
          }
          state.currentTitle = entry.name;
          els.playerTitle.textContent = entry.name;
          send({ type: "cast", deviceId: state.selectedDeviceId, path: entry.path });
        });
        row.lastElementChild.appendChild(castBtn);
      }
      els.fileList.appendChild(row);
    });
  }

  els.addDeviceBtn.addEventListener("click", function () {
    const address = els.deviceAddress.value.trim();
    const token = els.deviceToken.value.trim();
    if (!address) { showToast("请输入电视 WS 地址", true); return; }
    if (!/^\d{6}$/.test(token)) { showToast("配对码必须是 6 位数字", true); return; }
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
    send({ type: "control", deviceId: state.selectedDeviceId, action: "stop" });
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

  loadFiles("");
  connectWs();
})();
