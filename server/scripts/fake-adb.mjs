#!/usr/bin/env node
// 测试用 fake adb：按 FAKE_ADB_MODE_FILE 的内容模拟不同设备返回，并把每次调用记录到 FAKE_ADB_LOG。
import fs from "node:fs";

const DEFAULT_ACCESSIBILITY = "com.example/.Svc:app.orchard.tv/.guard.HomeGuardService";

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function readMode() {
  const file = env("FAKE_ADB_MODE_FILE", "");
  if (file) {
    try {
      const text = fs.readFileSync(file, "utf8").trim();
      if (text) return text;
    } catch {
      // 读不到就退回环境变量
    }
  }
  return env("FAKE_ADB_MODE", "ok");
}

function readState() {
  const file = env("FAKE_ADB_STATE", "");
  if (!file) return { installed: true, accessibility: DEFAULT_ACCESSIBILITY };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      installed: parsed.installed !== false,
      accessibility: typeof parsed.accessibility === "string" ? parsed.accessibility : DEFAULT_ACCESSIBILITY,
      version: typeof parsed.version === "string" ? parsed.version : "2.11",
      versionCode: typeof parsed.versionCode === "number" ? parsed.versionCode : 2110
    };
  } catch {
    return { installed: true, accessibility: DEFAULT_ACCESSIBILITY, version: "2.11", versionCode: 2110 };
  }
}

function writeState(state) {
  const file = env("FAKE_ADB_STATE", "");
  if (!file) return;
  fs.writeFileSync(file, JSON.stringify(state));
}

function logCall(args, mode) {
  const file = env("FAKE_ADB_LOG", "");
  if (!file) return;
  fs.appendFileSync(file, JSON.stringify({ args, mode, at: Date.now() }) + "\n");
}

function out(text, code) {
  if (text) process.stdout.write(text + "\n");
  process.exit(typeof code === "number" ? code : 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const args = process.argv.slice(2);

async function main() {
  const mode = readMode();
  const state = readState();
  logCall(args, mode);

  if (args[0] === "version") {
    out("Android Debug Bridge version 1.0.41\nVersion 35.0.2-12147458");
  }
  if (args[0] === "connect") {
    const serial = args[1] || "";
    if (mode === "connect-fail") out("failed to connect to '" + serial + "': Connection refused", 1);
    out("connected to " + serial);
  }

  const serialIndex = args.indexOf("-s");
  const rest = serialIndex >= 0 ? args.slice(serialIndex + 2) : args.slice();

  if (rest[0] === "get-state") {
    if (mode === "unauthorized") out("unauthorized");
    out("device");
  }
  if (rest[0] === "install") {
    const apk = rest[rest.length - 1];
    if (mode === "slow") await sleep(1500);
    if (!fs.existsSync(apk)) out("Performing Streamed Install\nFailure [INSTALL_FAILED_INVALID_URI]", 1);
    if (mode === "user-restricted") {
      out("Performing Streamed Install\nFailure [INSTALL_FAILED_USER_RESTRICTED: Install canceled by user]", 1);
    }
    writeState({ installed: true, accessibility: state.accessibility, version: state.version, versionCode: state.versionCode });
    out("Performing Streamed Install\nSuccess");
  }
  if (rest[0] === "uninstall") {
    writeState({ installed: false, accessibility: state.accessibility, version: state.version, versionCode: state.versionCode });
    out("Success");
  }
  if (rest[0] === "shell") {
    const shellArgs = rest.slice(1);
    const head = shellArgs.slice(0, 2).join(" ");
    if (head === "pm grant" || head === "pm revoke" || head === "appops set") out("");
    if (head === "pm list") out(state.installed ? "package:app.orchard.tv" : "");
    if (head === "dumpsys package") {
      if (!state.installed) out("Unable to find package: app.orchard.tv");
      out(
        "Packages:\n  Package [app.orchard.tv] (d1e2f3):\n    versionName=" +
          (state.version || "2.11") +
          "\n    versionCode=" +
          (state.versionCode || 2110)
      );
    }
    if (head === "am broadcast") out("Broadcast completed: result=0");
    if (head === "am start") out("Starting: Intent { cmp=app.orchard.tv/.MainActivity }");
    if (head === "am force-stop" || head === "cmd notification" || head === "cmd role") out("");
    if (head === "dumpsys window") {
      out(
        state.installed
          ? "  mCurrentFocus=Window{1a2b3c u0 app.orchard.tv/app.orchard.tv.MainActivity}"
          : "  mCurrentFocus=Window{4d5e6f u0 com.android.tv.launcher/com.android.tv.launcher.ui.MainActivity}"
      );
    }
    if (head === "cmd package") {
      const sub = shellArgs[2];
      if (sub === "resolve-activity") {
        out(state.installed ? "app.orchard.tv/.MainActivity" : "com.android.tv.launcher/.Launcher");
      }
      if (sub === "compile") out("Success");
      out("");
    }
    if (head === "settings get") out(state.accessibility);
    if (head === "settings put") {
      writeState({ installed: state.installed, accessibility: shellArgs[4], version: state.version, versionCode: state.versionCode });
      out("");
    }
    out("");
  }
  out("");
}

main().catch((error) => {
  process.stderr.write(String(error && error.message ? error.message : error) + "\n");
  process.exit(1);
});
