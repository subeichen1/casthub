#!/usr/bin/env node
// 测试用 fake adb：按 FAKE_ADB_MODE_FILE 的内容模拟不同设备返回，并把每次调用记录到 FAKE_ADB_LOG。
// 状态文件 FAKE_ADB_STATE 支持多包共存：packages = { "<包名>": { version, versionCode } }，
// 兼容旧的单包字段 installed / version / versionCode（等价于 app.orchard.tv）。
// props 可覆盖设备系统属性（getprop），不写则用 DEFAULT_PROPS（Android 11 / arm64 电视）。
import fs from "node:fs";

const DEFAULT_ACCESSIBILITY = "com.example/.Svc:app.orchard.tv/.guard.HomeGuardService";
const AERIAL_PACKAGE = "app.orchard.tv";
const DEFAULT_PROPS = {
  "ro.product.manufacturer": "Fake",
  "ro.product.model": "Fake TV",
  "ro.product.device": "fake_tv",
  "ro.build.version.sdk": "30",
  "ro.product.cpu.abilist": "arm64-v8a,armeabi-v7a,armeabi",
  "ro.product.cpu.abi": "arm64-v8a"
};

// 安装包文件名 → 包名。e2e 用本地假 APK，文件名来自 TV_APPS 的缓存前缀。
const PACKAGE_BY_FILE = [
  ["hongguo-android5", "rocks.aston.hongguotv.android5test"],
  ["hongguo-mpv", "rocks.aston.hongguotv.mpv"],
  ["hongguo", "rocks.aston.hongguotv"],
  // TVBox 六个变体共用一个包名。
  ["tvbox", "com.github.tvbox.osc.jun"],
  ["aerial", AERIAL_PACKAGE]
];

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

function normalizeState(parsed) {
  // 显式给了 props 就完全用它（空对象 = 这台设备读不到系统属性），
  // 只有完全没写 props 时才退回默认值，避免"想模拟读不到属性"却被默认值盖住。
  const explicitProps = parsed.props && typeof parsed.props === "object" ? parsed.props : null;
  const state = {
    packages: {},
    props: explicitProps ? {} : { ...DEFAULT_PROPS },
    accessibility: typeof parsed.accessibility === "string" ? parsed.accessibility : DEFAULT_ACCESSIBILITY,
    focus: typeof parsed.focus === "string" ? parsed.focus : null
  };
  if (explicitProps) {
    for (const [key, value] of Object.entries(explicitProps)) {
      if (typeof value === "string") state.props[key] = value;
    }
  }
  if (parsed.packages && typeof parsed.packages === "object") {
    for (const [name, value] of Object.entries(parsed.packages)) {
      if (!value) continue;
      state.packages[name] = {
        version: typeof value.version === "string" ? value.version : "1.0.0",
        versionCode: typeof value.versionCode === "number" ? value.versionCode : 1
      };
    }
  }
  if (parsed.installed !== undefined && !state.packages[AERIAL_PACKAGE]) {
    if (parsed.installed !== false) {
      state.packages[AERIAL_PACKAGE] = {
        version: typeof parsed.version === "string" ? parsed.version : "2.11",
        versionCode: typeof parsed.versionCode === "number" ? parsed.versionCode : 2110
      };
    }
  }
  if (!state.focus) {
    const names = Object.keys(state.packages);
    state.focus = names.length > 0 ? names[names.length - 1] : null;
  }
  return state;
}

function readState() {
  const file = env("FAKE_ADB_STATE", "");
  if (!file) {
    return normalizeState({ installed: true });
  }
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return normalizeState({ installed: true });
  }
}

function writeState(state) {
  const file = env("FAKE_ADB_STATE", "");
  if (!file) return;
  const aerial = state.packages[AERIAL_PACKAGE];
  // 同时写多包视图与旧的单包字段，老断言（installed / version / versionCode）继续成立。
  const payload = {
    packages: state.packages,
    props: state.props,
    accessibility: state.accessibility,
    focus: state.focus,
    installed: !!aerial,
    version: aerial ? aerial.version : "2.11",
    versionCode: aerial ? aerial.versionCode : 2110
  };
  fs.writeFileSync(file, JSON.stringify(payload));
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

/** 从 APK 文件名推断包名（fake 专用），可用 FAKE_ADB_INSTALL_PACKAGE 强制覆盖。 */
function packageForApk(apkPath) {
  const forced = env("FAKE_ADB_INSTALL_PACKAGE", "");
  if (forced) return forced;
  const base = apkPath.replace(/\\/g, "/").split("/").pop() || "";
  for (const [needle, pkg] of PACKAGE_BY_FILE) {
    if (base.includes(needle)) return pkg;
  }
  return AERIAL_PACKAGE;
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
    const pkg = packageForApk(apk);
    const version = env("FAKE_ADB_INSTALL_VERSION", "1.0.0");
    state.packages[pkg] = { version, versionCode: 1 };
    state.focus = pkg;
    writeState(state);
    out("Performing Streamed Install\nSuccess");
  }
  if (rest[0] === "uninstall") {
    const pkg = rest[1] || AERIAL_PACKAGE;
    delete state.packages[pkg];
    if (state.focus === pkg) {
      const names = Object.keys(state.packages);
      state.focus = names.length > 0 ? names[names.length - 1] : null;
    }
    writeState(state);
    out("Success");
  }
  if (rest[0] === "shell") {
    const shellArgs = rest.slice(1);
    const head = shellArgs.slice(0, 2).join(" ");
    if (head === "pm grant" || head === "pm revoke" || head === "appops set") out("");
    if (head === "pm list") {
      // pm list packages [<过滤串>]：shellArgs = ["pm","list","packages",过滤串?]
      const filter = shellArgs[3];
      const names = Object.keys(state.packages);
      if (filter) {
        const matched = names.filter((name) => name.includes(filter));
        out(matched.map((name) => "package:" + name).join("\n"));
      }
      out(names.map((name) => "package:" + name).join("\n"));
    }
    if (head === "dumpsys package") {
      const pkg = shellArgs[2];
      const entry = state.packages[pkg];
      if (!entry) out("Unable to find package: " + pkg);
      out(
        "Packages:\n  Package [" +
          pkg +
          "] (d1e2f3):\n    versionName=" +
          entry.version +
          "\n    versionCode=" +
          entry.versionCode
      );
    }
    if (head === "am broadcast") out("Broadcast completed: result=0");
    if (head === "am start") {
      const target = shellArgs[3] || "";
      const pkg = target.split("/")[0];
      if (pkg) {
        state.focus = pkg;
        writeState(state);
      }
      out("Starting: Intent { cmp=" + target + " }");
    }
    if (head === "am force-stop") {
      const pkg = shellArgs[2];
      if (pkg && state.focus === pkg) {
        state.focus = null;
        writeState(state);
      }
      out("");
    }
    if (head === "cmd notification" || head === "cmd role") out("");
    if (head === "dumpsys window") {
      out(
        state.focus
          ? "  mCurrentFocus=Window{1a2b3c u0 " + state.focus + "/" + state.focus + ".MainActivity}"
          : "  mCurrentFocus=Window{4d5e6f u0 com.android.tv.launcher/com.android.tv.launcher.ui.MainActivity}"
      );
    }
    if (head === "cmd package") {
      const sub = shellArgs[2];
      if (sub === "resolve-activity") {
        out(state.packages[AERIAL_PACKAGE] ? AERIAL_PACKAGE + "/.MainActivity" : "com.android.tv.launcher/.Launcher");
      }
      if (sub === "compile") out("Success");
      out("");
    }
    if (shellArgs[0] === "getprop") {
      const key = shellArgs[1];
      if (key) {
        out(state.props[key] ?? "");
      }
      out(
        Object.entries(state.props)
          .map(([name, value]) => "[" + name + "]: [" + value + "]")
          .join("\n")
      );
    }
    if (head === "settings get") out(state.accessibility);
    if (head === "settings put") {
      state.accessibility = shellArgs[4];
      writeState(state);
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
