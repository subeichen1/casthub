// 电视应用目录：把「下载地址 + adb 命令模板」抽成可扩展的目录，Aerial 桌面与红果短剧共用同一套安装流程。
// 本模块只有静态数据与纯解析函数（不发网络、不碰文件系统），方便单测；网络与 adb 都在 tv-desktop.ts。

export type TvAppId = "aerial" | "hongguo" | "tvbox";

/** 同一个应用的不同发行变体（独立包名，可同时安装）。 */
export interface TvAppVariant {
  id: string;
  name: string;
  description: string;
  /** Android 包名，用于 dumpsys / pm grant / uninstall。 */
  packageName: string;
  /** 启动组件：<包名>/<Activity>。 */
  activity: string;
  /** 最低 Android 版本（只用于面板提示与自动匹配）。 */
  minSdk: number;
  /** 最高 Android 版本（含）；用于「只给老系统用」的变体（红果 Android 5 兼容版）。 */
  maxSdk?: number;
  /** 该变体只包含这些 ABI；留空表示不限架构。 */
  abis?: readonly string[];
  /** 自动匹配时的优先级：越大越优先；默认变体给 100，保证兼容时行为不变。 */
  autoPriority?: number;
  /** 发布资产文件名模板，`{version}` 会替换成去掉 v 前缀的版本号。 */
  assetName: string;
}

export interface TvAppDefinition {
  id: TvAppId;
  name: string;
  vendor: string;
  description: string;
  homepage: string;
  /** GitHub owner/repo，可以是没有源码的 release-only 仓库。 */
  repo: string;
  /** launcher：会接管电视桌面（需要额外授权步骤）；app：普通应用。 */
  installKind: "launcher" | "app";
  defaultVariant: string;
  variants: TvAppVariant[];
  /** 面板提示（第三方内容来源、合规等）。 */
  notice: string;
}

export interface TvAppReleaseInfo {
  appId: string;
  variantId: string;
  packageName: string;
  tag: string;
  /** 去掉 v 前缀的版本号，用于和电视上已装版本比较。 */
  version: string;
  apkName: string;
  apkUrl: string;
  sizeBytes: number;
  sha256: string | null;
  publishedAt: string | null;
  channel: "github" | "mirror" | "custom";
}

const AERIAL: TvAppDefinition = {
  id: "aerial",
  name: "Aerial 极简桌面",
  vendor: "pengchujin/aerial-tv",
  description: "把电视桌面换成 Apple TV 风格的极简桌面（会接管 Home 键）。",
  homepage: "https://github.com/pengchujin/aerial-tv",
  repo: "pengchujin/aerial-tv",
  installKind: "launcher",
  defaultVariant: "standard",
  variants: [
    {
      id: "standard",
      name: "标准版",
      description: "正式版桌面，安装后接管默认桌面。",
      packageName: "app.orchard.tv",
      activity: "app.orchard.tv/.MainActivity",
      minSdk: 21,
      autoPriority: 100,
      assetName: "aerial-standard.apk"
    }
  ],
  notice: "Aerial 会接管电视的默认桌面与 Home 键，属于对电视系统的修改；安装前请确认可以用「还原原桌面」恢复。"
};

const HONGGUO: TvAppDefinition = {
  id: "hongguo",
  name: "红果短剧 TV",
  vendor: "aston314/hongguo-tv",
  description: "第三方短剧播放应用（不接管桌面，装完就是一个普通 App）。",
  homepage: "https://github.com/aston314/hongguo-tv",
  repo: "aston314/hongguo-tv-releases",
  installKind: "app",
  defaultVariant: "standard",
  variants: [
    {
      id: "standard",
      name: "标准版",
      description: "HTML5 优先、失败切 Media3 播放器，适合大多数电视。",
      packageName: "rocks.aston.hongguotv",
      activity: "rocks.aston.hongguotv/.MainActivity",
      minSdk: 23,
      autoPriority: 100,
      assetName: "hongguo-tv-{version}.apk"
    },
    {
      id: "mpv",
      name: "MPV 版",
      description: "内置 MPV 解码，兼容性更好，安装包更大（约 46 MB）。",
      packageName: "rocks.aston.hongguotv.mpv",
      activity: "rocks.aston.hongguotv.mpv/.MainActivity",
      minSdk: 23,
      // 包体大得多、解码路径不同，只在用户手选时用，自动匹配不选它。
      autoPriority: 80,
      assetName: "hongguo-tv-mpv-{version}.apk"
    },
    {
      id: "android5",
      name: "Android 5 兼容版",
      description: "给 Android 5.0 / 5.1 老电视用。",
      packageName: "rocks.aston.hongguotv.android5test",
      activity: "rocks.aston.hongguotv.android5test/.MainActivity",
      minSdk: 21,
      // 只给 Android 5.0/5.1（API 21-22）：标准版 minSdk 23，两者互斥。
      maxSdk: 22,
      autoPriority: 100,
      assetName: "hongguo-tv-android5-{version}.apk"
    }
  ],
  notice: "红果短剧是第三方内容应用，CastHub 只负责下载官方安装包并用 adb 安装，不对内容来源与合规性负责。"
};

/**
 * TVBox（TVBoxOSC）：release-only 仓库，由 GitHub Actions 每日构建上游 TVBoxOS 源码。
 * 六个变体共用同一个包名，同一台电视只能装一个，换版本要先卸载。
 */
const TVBOX: TvAppDefinition = {
  id: "tvbox",
  name: "TVBox（TVBoxOSC）",
  vendor: "j4Uq/TVBoxOSC",
  description: "第三方影视聚合客户端（不接管桌面，装完是一个普通 App），源地址需要自己配置。",
  homepage: "https://github.com/j4Uq/TVBoxOSC",
  repo: "j4Uq/TVBoxOSC",
  installKind: "app",
  defaultVariant: "java",
  variants: [
    {
      id: "java",
      name: "Java 标准版",
      description: "内置 Java 解析器，armv7 + arm64 双架构，绝大多数电视选这个。",
      packageName: "com.github.tvbox.osc.jun",
      activity: "com.github.tvbox.osc.jun/com.github.tvbox.osc.ui.activity.HomeActivity",
      minSdk: 19,
      // 双架构兜底：设备架构读不出来或专版不适用时选它。
      autoPriority: 100,
      assetName: "TVBox_q215613905_{version}-java.apk"
    },
    {
      id: "java32",
      name: "Java 32 位版",
      description: "仅 armeabi-v7a，给 32 位的老电视用。",
      packageName: "com.github.tvbox.osc.jun",
      activity: "com.github.tvbox.osc.jun/com.github.tvbox.osc.ui.activity.HomeActivity",
      minSdk: 19,
      abis: ["armeabi-v7a", "armeabi"],
      // 32 位专版：设备只有 32 位 ABI 时优先，包体更小、不会因缺 arm64 库闪退。
      autoPriority: 105,
      assetName: "TVBox_q215613905_{version}-java32.apk"
    },
    {
      id: "java64",
      name: "Java 64 位版",
      description: "仅 arm64-v8a，包体更小。",
      packageName: "com.github.tvbox.osc.jun",
      activity: "com.github.tvbox.osc.jun/com.github.tvbox.osc.ui.activity.HomeActivity",
      minSdk: 21,
      abis: ["arm64-v8a", "x86_64"],
      // 64 位专版：设备带 64 位 ABI 时优先。
      autoPriority: 105,
      assetName: "TVBox_q215613905_{version}-java64.apk"
    },
    {
      id: "python",
      name: "Python 标准版",
      description: "内置 Python 解析器，能跑部分 Java 版跑不动的源，包体更大（约 50 MB）。",
      packageName: "com.github.tvbox.osc.jun",
      activity: "com.github.tvbox.osc.jun/com.github.tvbox.osc.ui.activity.HomeActivity",
      minSdk: 19,
      autoPriority: 90,
      assetName: "TVBox_q215613905_{version}-python.apk"
    },
    {
      id: "python32",
      name: "Python 32 位版",
      description: "Python 解析器 + 仅 armeabi-v7a。",
      packageName: "com.github.tvbox.osc.jun",
      activity: "com.github.tvbox.osc.jun/com.github.tvbox.osc.ui.activity.HomeActivity",
      minSdk: 19,
      abis: ["armeabi-v7a", "armeabi"],
      autoPriority: 95,
      assetName: "TVBox_q215613905_{version}-python32.apk"
    },
    {
      id: "python64",
      name: "Python 64 位版",
      description: "Python 解析器 + 仅 arm64-v8a。",
      packageName: "com.github.tvbox.osc.jun",
      activity: "com.github.tvbox.osc.jun/com.github.tvbox.osc.ui.activity.HomeActivity",
      minSdk: 21,
      abis: ["arm64-v8a", "x86_64"],
      autoPriority: 95,
      assetName: "TVBox_q215613905_{version}-python64.apk"
    }
  ],
  notice:
    "TVBox 是第三方影视聚合客户端，CastHub 只负责下载官方构建并用 adb 安装，不对内容来源与合规性负责；源地址需要自己在应用里配置。六个变体共用同一个包名 com.github.tvbox.osc.jun，同一台电视只能装一个，换版本请先卸载。"
};

export const TV_APPS: readonly TvAppDefinition[] = [AERIAL, HONGGUO, TVBOX];

export function findTvApp(appId: string | null | undefined): TvAppDefinition | null {
  if (!appId) return null;
  return TV_APPS.find((app) => app.id === appId) ?? null;
}

export function findTvVariant(app: TvAppDefinition, variantId: string | null | undefined): TvAppVariant | null {
  const wanted = variantId && variantId.trim() ? variantId.trim() : app.defaultVariant;
  return app.variants.find((variant) => variant.id === wanted) ?? null;
}

/** 发布资产文件名：把 `{version}` 换成版本号（没有占位符时原样返回）。 */
export function resolveAssetName(variant: TvAppVariant, version: string): string {
  return variant.assetName.replace(/\{version\}/g, version);
}

/** tag 形如 v0.2.182 / 2.0.0 → 0.2.182 / 2.0.0。 */
export function versionFromTag(tag: string): string {
  const trimmed = (tag ?? "").trim();
  return trimmed.replace(/^v/i, "");
}

function parseSha256Digest(digest: unknown): string | null {
  if (typeof digest !== "string") return null;
  const match = digest.match(/^sha256:([0-9a-f]{64})$/i);
  return match ? match[1].toLowerCase() : null;
}

/** 从 GitHub release JSON 里挑出该变体的 APK；资产缺失时返回 null。 */
export function parseAppRelease(
  app: TvAppDefinition,
  variant: TvAppVariant,
  payload: unknown
): TvAppReleaseInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  const tag = typeof data.tag_name === "string" ? data.tag_name : "";
  const version = versionFromTag(tag) || versionFromTag(typeof data.name === "string" ? data.name : "");
  const expected = resolveAssetName(variant, version);
  const assets = Array.isArray(data.assets) ? data.assets : [];
  for (const item of assets) {
    if (!item || typeof item !== "object") continue;
    const asset = item as Record<string, unknown>;
    const name = typeof asset.name === "string" ? asset.name : "";
    // 有版本号时按精确文件名匹配；拿不到版本号时退回「前缀 + .apk」，避免装错变体。
    const matches = version
      ? name === expected
      : name.startsWith(variant.assetName.split("{version}")[0]) && /\.apk$/i.test(name);
    if (!matches) continue;
    const url = typeof asset.browser_download_url === "string" ? asset.browser_download_url : "";
    if (!/^https:\/\//i.test(url)) continue;
    return {
      appId: app.id,
      variantId: variant.id,
      packageName: variant.packageName,
      tag: tag || "latest",
      version,
      apkName: name,
      apkUrl: url,
      sizeBytes: typeof asset.size === "number" ? asset.size : 0,
      sha256: parseSha256Digest(asset.digest),
      publishedAt: typeof data.published_at === "string" ? data.published_at : null,
      channel: "github"
    };
  }
  return null;
}

/** 本地注入的发布信息（e2e / 内网离线安装），字段与 AERIAL_RELEASE_JSON 一致，可带 variant 限定。 */
export function parseAppCustomRelease(
  app: TvAppDefinition,
  variant: TvAppVariant,
  payload: unknown
): TvAppReleaseInfo | null {
  if (!payload || typeof payload !== "object") return null;
  const data = payload as Record<string, unknown>;
  if (typeof data.variant === "string" && data.variant !== variant.id) return null;
  if (typeof data.appId === "string" && data.appId !== app.id) return null;
  const url = typeof data.apkUrl === "string" ? data.apkUrl : "";
  if (!url) return null;
  const sha256 =
    typeof data.sha256 === "string" && /^[0-9a-f]{64}$/i.test(data.sha256) ? data.sha256.toLowerCase() : null;
  const tag = typeof data.tag === "string" ? data.tag : "custom";
  return {
    appId: app.id,
    variantId: variant.id,
    packageName: variant.packageName,
    tag,
    version: versionFromTag(tag),
    apkName: typeof data.apkName === "string" ? data.apkName : resolveAssetName(variant, versionFromTag(tag)),
    apkUrl: url,
    sizeBytes: typeof data.sizeBytes === "number" ? data.sizeBytes : 0,
    sha256,
    publishedAt: typeof data.publishedAt === "string" ? data.publishedAt : null,
    channel: "custom"
  };
}

/** 每个应用一个环境变量覆盖：AERIAL_RELEASE_JSON / HONGGUO_RELEASE_JSON。 */
export function releaseJsonEnvName(app: TvAppDefinition): string {
  return app.id.toUpperCase() + "_RELEASE_JSON";
}

export function releasesApiUrl(app: TvAppDefinition): string {
  return "https://api.github.com/repos/" + app.repo + "/releases/latest";
}

export function releaseByTagApiUrl(app: TvAppDefinition, tag: string): string {
  return "https://api.github.com/repos/" + app.repo + "/releases/tags/" + encodeURIComponent(tag);
}

export function releaseDownloadUrl(app: TvAppDefinition, tag: string, assetName: string): string {
  return "https://github.com/" + app.repo + "/releases/download/" + encodeURIComponent(tag) + "/" + assetName;
}

/** 面板展示用的变体摘要（不含函数与内部字段）。 */
export function variantSummary(variant: TvAppVariant): {
  id: string;
  name: string;
  description: string;
  packageName: string;
  minSdk: number;
  maxSdk: number | null;
  abis: string[];
  autoPriority: number;
} {
  return {
    id: variant.id,
    name: variant.name,
    description: variant.description,
    packageName: variant.packageName,
    minSdk: variant.minSdk,
    maxSdk: typeof variant.maxSdk === "number" ? variant.maxSdk : null,
    abis: variant.abis ? [...variant.abis] : [],
    autoPriority: variant.autoPriority ?? 100
  };
}
/** 电视系统属性（adb shell getprop 的子集），用于自动匹配发行变体。 */
export interface TvDeviceProfile {
  manufacturer: string | null;
  model: string | null;
  device: string | null;
  /** Android API 级别（ro.build.version.sdk）；读不到为 null。 */
  sdkInt: number | null;
  /** 设备支持的 ABI，按 ro.product.cpu.abilist 顺序；读不到为空数组。 */
  abis: string[];
}

/** getprop 键 → 字段；顺序即优先级（abilist 优先于 abi）。 */
const ABI_KEYS = ["ro.product.cpu.abilist", "ro.product.cpu.abi", "ro.product.cpu.abilist64", "ro.product.cpu.abi2"];

function firstProp(props: Record<string, string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = (props[key] ?? "").trim();
    if (value) return value;
  }
  return null;
}

/** 解析 `adb shell getprop` 的 `[key]: [value]` 输出；也接受已解析的键值对。 */
export function parseDeviceProfile(input: string | Record<string, string>): TvDeviceProfile {
  const props: Record<string, string> = {};
  if (typeof input === "string") {
    for (const line of input.split(/\r?\n/)) {
      const match = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]$/);
      if (match) props[match[1]] = match[2];
    }
  } else {
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string") props[key] = value;
    }
  }
  const sdkRaw = firstProp(props, ["ro.build.version.sdk"]);
  const sdkInt = sdkRaw && /^\d+$/.test(sdkRaw) ? Number.parseInt(sdkRaw, 10) : null;
  const abis: string[] = [];
  for (const key of ABI_KEYS) {
    const value = (props[key] ?? "").trim();
    if (!value) continue;
    for (const abi of value.split(",")) {
      const name = abi.trim();
      if (name && !abis.includes(name)) abis.push(name);
    }
  }
  return {
    manufacturer: firstProp(props, ["ro.product.manufacturer"]),
    model: firstProp(props, ["ro.product.model"]),
    device: firstProp(props, ["ro.product.device"]),
    sdkInt,
    abis
  };
}

/** 自动匹配结果；reason 是给用户看的一句话依据。 */
export interface TvVariantMatch {
  variant: TvAppVariant;
  /** manual（用户指定）/ auto（按系统属性选中）/ fallback（信息不足，用默认变体）。 */
  source: "manual" | "auto" | "fallback";
  reason: string;
}

function sdkCompatible(variant: TvAppVariant, sdkInt: number | null): boolean {
  if (sdkInt === null) return true;
  if (sdkInt < variant.minSdk) return false;
  if (typeof variant.maxSdk === "number" && sdkInt > variant.maxSdk) return false;
  return true;
}

function abiCompatible(variant: TvAppVariant, abis: readonly string[]): boolean {
  if (!variant.abis || variant.abis.length === 0) return true;
  if (abis.length === 0) return true;
  return variant.abis.some((abi) => abis.includes(abi));
}

function describeProfile(profile: TvDeviceProfile): string {
  const parts: string[] = [];
  if (profile.sdkInt !== null) parts.push("Android API " + profile.sdkInt);
  if (profile.abis.length > 0) parts.push(profile.abis[0]);
  if (profile.model) parts.push(profile.model);
  return parts.join(" · ");
}

/**
 * 按电视系统属性挑发行变体：先按 minSdk/maxSdk 与 ABI 过滤，再按 autoPriority 从高到低、
 * 默认变体优先、目录顺序兜底。用户显式指定变体时直接尊重（source=manual）。
 * 读不到属性时返回默认变体并标 fallback，绝不因为探测失败而挡住安装。
 */
export function matchVariantForDevice(
  app: TvAppDefinition,
  profile: TvDeviceProfile | null,
  requestedVariantId?: string | null
): TvVariantMatch {
  const requested = (requestedVariantId ?? "").trim();
  if (requested && requested !== "auto") {
    const manual = findTvVariant(app, requested);
    if (manual) return { variant: manual, source: "manual", reason: "手动选择" };
  }
  const fallbackVariant = findTvVariant(app, app.defaultVariant) ?? app.variants[0];
  if (!profile || (profile.sdkInt === null && profile.abis.length === 0)) {
    return { variant: fallbackVariant, source: "fallback", reason: "读不到电视系统属性，使用默认变体" };
  }
  const candidates = app.variants.filter(
    (variant) => sdkCompatible(variant, profile.sdkInt) && abiCompatible(variant, profile.abis)
  );
  if (candidates.length === 0) {
    return {
      variant: fallbackVariant,
      source: "fallback",
      reason: "没有完全匹配的变体（" + describeProfile(profile) + "），使用默认变体"
    };
  }
  // 设备主 ABI（abilist 第一项）匹配得越靠前越优先：同时带 arm64 与 armv7 的电视应装 64 位专版。
  const primaryAbi = profile.abis[0] ?? "";
  const abiRank = (variant: TvAppVariant): number => {
    if (!variant.abis || variant.abis.length === 0) return 99;
    const index = variant.abis.indexOf(primaryAbi);
    return index < 0 ? 98 : index;
  };
  const ranked = [...candidates].sort((a, b) => {
    const priority = (b.autoPriority ?? 100) - (a.autoPriority ?? 100);
    if (priority !== 0) return priority;
    const abi = abiRank(a) - abiRank(b);
    if (abi !== 0) return abi;
    const aDefault = a.id === app.defaultVariant ? 1 : 0;
    const bDefault = b.id === app.defaultVariant ? 1 : 0;
    if (aDefault !== bDefault) return bDefault - aDefault;
    return app.variants.indexOf(a) - app.variants.indexOf(b);
  });
  const chosen = ranked[0];
  return {
    variant: chosen,
    source: chosen.id === app.defaultVariant ? "fallback" : "auto",
    reason: describeProfile(profile) + " → " + chosen.name
  };
}

