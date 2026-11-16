// CastHub portable 自动更新工具函数：只使用 Node 内置模块，方便独立测试。
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function isHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 解析 GNU sha256sum 输出。
 * 兼容 "hash  filename" 与 "hash *filename"，忽略空行和 # 注释。
 */
function parseChecksums(text) {
  const result = {};
  const lines = String(text == null ? "" : text).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-fA-F0-9]{64})[ \t]+\*?(.+)$/.exec(line);
    if (!match) continue;
    const filename = match[2].trim();
    if (!filename) continue;
    result[filename] = match[1].toLowerCase();
  }
  return result;
}

/**
 * 从 GitHub Release assets 中挑选 portable exe 与 checksums.txt。
 * 文件名大小写不敏感；缺少任一资产时返回明确错误。
 */
function pickUpdateAssets(assets) {
  const list = Array.isArray(assets) ? assets : [];
  const findAsset = (name) => {
    const normalized = name.toLowerCase();
    return list.find(
      (asset) => asset && typeof asset.name === "string" && asset.name.toLowerCase() === normalized,
    );
  };
  const exe = findAsset("CastHub.exe");
  const checksum = findAsset("checksums.txt");
  if (!exe || !checksum) throw new Error("Release 缺少 CastHub.exe 或 checksums.txt");
  const exeUrl = exe.browser_download_url;
  const checksumUrl = checksum.browser_download_url;
  if (!isHttpsUrl(exeUrl) || !isHttpsUrl(checksumUrl)) {
    throw new Error("CastHub.exe 或 checksums.txt 的下载地址不是 HTTPS");
  }
  const size = Number(exe.size);
  return {
    exeUrl,
    checksumUrl,
    exeSize: Number.isFinite(size) && size > 0 ? size : 0,
  };
}

/** 用流式计算文件 SHA-256。 */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * 流式下载 HTTPS 文件并回报进度。
 * 失败时删除未完成的文件，避免后续误把半截 exe 当成更新包。
 */
async function downloadFile(url, destination, onProgress) {
  if (!isHttpsUrl(url)) throw new Error("下载地址必须是 HTTPS");
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (response.url && !isHttpsUrl(response.url)) throw new Error("下载重定向到了非 HTTPS 地址");
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  if (!response.body) throw new Error("下载失败：响应没有文件内容");
  const totalHeader = Number(response.headers.get("content-length"));
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : 0;
  const handle = await fs.promises.open(destination, "w");
  let received = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      await handle.writeFile(chunk);
      received += chunk.length;
      if (typeof onProgress === "function") {
        const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
        onProgress({ received, total, percent });
      }
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.rm(destination, { force: true }).catch(() => {});
    throw error;
  }
  await handle.close();
  if (typeof onProgress === "function") {
    onProgress({ received, total: total || received, percent: 100 });
  }
  return { received, total: total || received };
}

/**
 * 生成 PowerShell 5.1 可用的 ASCII helper 脚本。
 * helper 必须独立于 Electron/asar 路径，因此主进程会把它写到临时目录。
 */
function buildUpdateHelperScript() {
  return [
    'param(',
    '  [Parameter(Mandatory=$true)][string]$Target,',
    '  [Parameter(Mandatory=$true)][string]$Source,',
    '  [Parameter(Mandatory=$true)][int]$ParentPid,',
    '  [Parameter(Mandatory=$true)][string]$LogPath',
    ')',
    '$ErrorActionPreference = "Continue"',
    'function Write-Log([string]$Message) {',
    '  try { Add-Content -LiteralPath $LogPath -Value ((Get-Date).ToString("s") + " " + $Message) -Encoding ASCII } catch { }',
    '}',
    'Write-Log "HELPER_START target=$Target source=$Source parent=$ParentPid"',
    '$parentDeadline = (Get-Date).AddSeconds(30)',
    'while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $parentDeadline)) { Start-Sleep -Milliseconds 200 }',
    'if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { Write-Log "PARENT_STILL_RUNNING" } else { Write-Log "PARENT_EXITED" }',
    '$oldTarget = $Target + ".old"',
    '$deadline = (Get-Date).AddSeconds(120)',
    'while ((Get-Date) -lt $deadline) {',
    '  $moved = $false',
    '  try {',
    '    if (Test-Path -LiteralPath $oldTarget) { Remove-Item -LiteralPath $oldTarget -Force -ErrorAction Stop }',
    '    if (Test-Path -LiteralPath $Target) {',
    '      Rename-Item -LiteralPath $Target -NewName (Split-Path -Path $oldTarget -Leaf) -Force -ErrorAction Stop',
    '      $moved = $true',
    '      Write-Log ("MOVE_OK target=" + $Target)',
    '    }',
    '    Copy-Item -LiteralPath $Source -Destination $Target -Force -ErrorAction Stop',
    '    Write-Log ("COPY_OK target=" + $Target)',
    '    Start-Process -FilePath $Target -WorkingDirectory (Split-Path -Parent $Target)',
    '    Write-Log ("START_OK target=" + $Target)',
    '    Write-Log "UPDATE_OK target=$Target"',
    '    exit 0',
    '  } catch {',
    '    Write-Log ("RETRY_FAILED " + $_.Exception.Message)',
    '    if ($moved -and (Test-Path -LiteralPath $oldTarget)) {',
    '      try {',
    '        if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force -ErrorAction Stop }',
    '        Rename-Item -LiteralPath $oldTarget -NewName (Split-Path -Path $Target -Leaf) -Force -ErrorAction Stop',
    '        Write-Log "ROLLBACK_OK"',
    '      } catch { Write-Log ("ROLLBACK_FAILED " + $_.Exception.Message) }',
    '    }',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '}',
    'Write-Log "UPDATE_FAILED target=$Target"',
    'exit 1',
  ].join("\r\n");
}

/** 把 helper 脚本写入临时目录并返回路径。 */
function writeUpdateHelperScript(tempDir) {
  const helperPath = path.join(tempDir, "casthub-update-helper.ps1");
  fs.writeFileSync(helperPath, buildUpdateHelperScript(), "ascii");
  return helperPath;
}

module.exports = {
  DOWNLOAD_TIMEOUT_MS,
  isHttpsUrl,
  parseChecksums,
  pickUpdateAssets,
  sha256File,
  downloadFile,
  buildUpdateHelperScript,
  writeUpdateHelperScript,
};
