#!/usr/bin/env node
// 假电视：纯 Node 完整模拟电视端协议（WS 服务端 9417）
// 关键行为：收到 play 后对 url 发 GET + Range: bytes=0-1023，拿到 206 才转 playing。
import http from "node:http";
import https from "node:https";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.FAKE_TV_PORT ?? process.argv[2] ?? 9417);
const TOKEN = process.env.FAKE_TV_TOKEN ?? process.argv[3] ?? "123456";
const NAME = process.env.FAKE_TV_NAME ?? "Fake TV";
const SKIP_PROBE = process.env.FAKE_TV_SKIP_PROBE === "1";

function log(...args) {
  console.log("[fake-tv]", ...args);
}

let client = null;
let authenticated = false;
let state = "idle";
let positionMs = 0;
let durationMs = 0;
let basePosition = 0;
let baseWallClock = 0;
let ticker = null;

function send(payload) {
  if (client && client.readyState === 1) client.send(JSON.stringify(payload));
}

function currentPosition() {
  if (state === "playing") {
    const value = basePosition + (Date.now() - baseWallClock);
    return durationMs > 0 ? Math.min(value, durationMs) : value;
  }
  return positionMs;
}

function pushStatus() {
  send({ type: "status", state, positionMs: Math.round(currentPosition()), durationMs });
}

function setState(next) {
  if (state === "playing" && next !== "playing") positionMs = currentPosition();
  state = next;
  if (next === "playing") {
    basePosition = positionMs;
    baseWallClock = Date.now();
  }
  pushStatus();
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (state !== "playing") return;
    const p = currentPosition();
    if (durationMs > 0 && p >= durationMs) {
      positionMs = durationMs;
      state = "idle";
      pushStatus();
      log("ENDED");
      return;
    }
    pushStatus();
  }, 1000);
}

function probeRange(url) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error("播放 URL 非法: " + url));
      return;
    }
    const mod = target.protocol === "https:" ? https : http;
    const req = mod.get(target, { headers: { Range: "bytes=0-1023" } }, (res) => {
      const status = res.statusCode ?? 0;
      res.resume();
      res.on("end", () => resolve(status));
    });
    req.on("error", reject);
    req.setTimeout(8000, () => req.destroy(new Error("Range 探测请求超时")));
  });
}

async function handlePlay(msg) {
  const url = String(msg.url ?? "");
  log("PLAY_URL", url);
  durationMs = 60000;
  positionMs = 0;
  if (!SKIP_PROBE) {
    try {
      const status = await probeRange(url);
      log("RANGE_PROBE", status);
      if (status !== 206) {
        state = "error";
        send({ type: "error", code: "STREAM_UNREACHABLE", message: "Range 探测期望 206，实际 " + status });
        pushStatus();
        return;
      }
    } catch (error) {
      state = "error";
      send({ type: "error", code: "STREAM_UNREACHABLE", message: String(error.message ?? error) });
      pushStatus();
      return;
    }
  } else {
    log("SKIP_PROBE");
  }
  basePosition = 0;
  baseWallClock = Date.now();
  state = "playing";
  pushStatus();
  startTicker();
}

const wss = new WebSocketServer({ port: PORT, host: "0.0.0.0" });

wss.on("listening", () => {
  log(`LISTENING ws://0.0.0.0:${PORT} token=${TOKEN} name=${NAME}`);
});

wss.on("connection", (ws, req) => {
  log("CONNECTED", req.socket.remoteAddress ?? "");
  client = ws;
  authenticated = false;

  ws.on("message", async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
      if (!msg || typeof msg !== "object") throw new Error("not object");
    } catch {
      send({ type: "error", code: "BAD_MESSAGE", message: "非法 JSON 消息" });
      return;
    }

    if (!authenticated) {
      if (msg.type !== "hello") {
        ws.close(4001, "hello required");
        return;
      }
      if (String(msg.token) !== TOKEN) {
        log("AUTH_FAIL");
        ws.close(4001, "invalid token");
        return;
      }
      authenticated = true;
      log("AUTH_OK clientId=" + String(msg.clientId ?? ""));
      send({ type: "helloAck", ok: true, deviceName: NAME });
      pushStatus();
      return;
    }

    switch (msg.type) {
      case "play":
        await handlePlay(msg);
        break;
      case "pause":
        if (state === "playing") setState("paused");
        else pushStatus();
        break;
      case "resume":
        if (state === "paused") setState("playing");
        else pushStatus();
        break;
      case "stop":
        positionMs = 0;
        setState("idle");
        break;
      case "seek": {
        const value = Number(msg.positionMs);
        const max = durationMs > 0 ? durationMs : Number.MAX_SAFE_INTEGER;
        positionMs = Math.min(Math.max(Number.isFinite(value) ? value : 0, 0), max);
        if (state === "playing") {
          basePosition = positionMs;
          baseWallClock = Date.now();
        }
        pushStatus();
        break;
      }
      case "getStatus":
        pushStatus();
        break;
      default:
        send({ type: "error", code: "UNKNOWN_TYPE", message: "未知消息类型: " + String(msg.type) });
    }
  });

  ws.on("close", (code) => {
    log("CLOSED", code);
    if (client === ws) {
      client = null;
      authenticated = false;
    }
  });

  ws.on("error", (error) => log("WS_ERROR", error.message));
});

process.on("SIGINT", () => {
  wss.close();
  if (ticker) clearInterval(ticker);
  process.exit(0);
});
process.on("SIGTERM", () => {
  wss.close();
  if (ticker) clearInterval(ticker);
  process.exit(0);
});
