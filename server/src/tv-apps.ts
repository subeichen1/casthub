// 电视应用目录：把「下载地址 + adb 命令模板」抽成可扩展的目录，Aerial 桌面与红果短剧共用同一套安装流程。
// 本模块只有静态数据与纯解析函数（不发网络、不碰文件系统），方便单测；网络与 adb 都在 tv-desktop.ts。

export type TvAppId = "aerial" | "hongguo";

/** 同一个应用的不同发行变体（独立包名，可同时安装）。 */
export interface TvAppVariant {
  id: string;
  name: string;
  description: string;
  /** Android 包名，用于 dumpsys / pm grant / uninstall。 */
  packageName: string;
  /** 启动组件：<包名>/<Activity>。 */
  activity: string;
  /** 最低 Android 版本（只用于面板提示）。 */
  minSdk: number;
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
      assetName: "hongguo-tv-{version}.apk"
    },
    {
      id: "mpv",
      name: "MPV 版",
      description: "内置 MPV 解码，兼容性更好，安装包更大（约 46 MB）。",
      packageName: "rocks.aston.hongguotv.mpv",
      activity: "rocks.aston.hongguotv.mpv/.MainActivity",
      minSdk: 23,
      assetName: "hongguo-tv-mpv-{version}.apk"
    },
    {
      id: "android5",
      name: "Android 5 兼容版",
      description: "给 Android 5.0 / 5.1 老电视用。",
      packageName: "rocks.aston.hongguotv.android5test",
      activity: "rocks.aston.hongguotv.android5test/.MainActivity",
      minSdk: 21,
      assetName: "hongguo-tv-android5-{version}.apk"
    }
  ],
  notice: "红果短剧是第三方内容应用，CastHub 只负责下载官方安装包并用 adb 安装，不对内容来源与合规性负责。"
};

export const TV_APPS: readonly TvAppDefinition[] = [AERIAL, HONGGUO];

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
} {
  return {
    id: variant.id,
    name: variant.name,
    description: variant.description,
    packageName: variant.packageName,
    minSdk: variant.minSdk
  };
}
