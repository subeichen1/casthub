<#
.SYNOPSIS
    CastHub Windows 一键安装脚本。
.DESCRIPTION
    下载最新 Release 中的 CastHub.exe，安装到本地应用目录，创建快捷方式并启动。
    支持通过参数修改安装目录、媒体目录以及跳过启动。
.EXAMPLE
    $p = Join-Path $env:TEMP 'CastHub-install.ps1'; iwr -UseBasicParsing https://github.com/subeichen1/casthub/releases/latest/download/install.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CastHub'),
    [string]$MediaDir = '',
    [string]$SourceExe = '',
    [string]$Sha256 = '',
    [switch]$AllowUnsigned,
    [switch]$RequireSignature,
    [switch]$NoShortcuts,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Message) {
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Fail([string]$Message) {
    Write-Host "错误：$Message" -ForegroundColor Red
    exit 1
}

function Get-Sha256Hex([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Read-ChecksumForFile([string]$ChecksumText, [string]$FileName) {
    foreach ($line in ($ChecksumText -split "`r?`n")) {
        if ($line -match '^\s*([A-Fa-f0-9]{64})\s+\*?([^\s]+)\s*$' -and $Matches[2] -eq $FileName) {
            return $Matches[1].ToLowerInvariant()
        }
    }
    return ''
}

function Assert-Checksum([string]$Path, [string]$Expected, [string]$Label) {
    $actual = Get-Sha256Hex $Path
    if ($actual -ne $Expected.ToLowerInvariant()) {
        Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        Fail "$Label 校验失败：期望 $Expected，实际 $actual"
    }
    Write-Step "$Label SHA-256 校验通过：$actual"
}

function Assert-Authenticode([string]$Path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid') {
        Fail "CastHub.exe 数字签名无效（$($signature.Status)），请从官方 Release 重新下载。"
    }
    Write-Step "数字签名校验通过：$($signature.SignerCertificate.Subject)"
}

Write-Host ''
Write-Host 'CastHub 一键安装程序' -ForegroundColor White
Write-Host '----------------------------------------' -ForegroundColor DarkGray

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    Fail '无法确定安装目录，请通过 -InstallDir 指定。'
}

if ([string]::IsNullOrWhiteSpace($MediaDir)) {
    $videos = [Environment]::GetFolderPath('MyVideos')
    if ([string]::IsNullOrWhiteSpace($videos)) {
        $videos = Join-Path $HOME 'Videos'
    }
    $MediaDir = Join-Path $videos 'CastHub'
}

$running = Get-Process -Name 'CastHub' -ErrorAction SilentlyContinue
if ($running) {
    Fail '检测到 CastHub 正在运行，请先退出 CastHub 后重新执行安装。'
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
    # PowerShell 7 默认已启用 TLS 1.2+，忽略旧系统上的设置失败。
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path $MediaDir | Out-Null

$exePath = Join-Path $InstallDir 'CastHub.exe'
$configPath = Join-Path $InstallDir 'config.json'

$expectedHash = $Sha256
if (-not [string]::IsNullOrWhiteSpace($SourceExe)) {
    Write-Step "使用本地安装包：$SourceExe"
    if (-not (Test-Path -LiteralPath $SourceExe -PathType Leaf)) {
        Fail "找不到安装包：$SourceExe"
    }
    if ([string]::IsNullOrWhiteSpace($expectedHash)) {
        $sidecar = "$SourceExe.sha256"
        if (Test-Path -LiteralPath $sidecar -PathType Leaf) {
            $expectedHash = Read-ChecksumForFile (Get-Content -LiteralPath $sidecar -Raw) (Split-Path -Leaf $SourceExe)
        }
    }
    Copy-Item -LiteralPath $SourceExe -Destination $exePath -Force
} else {
    $downloadUrl = 'https://github.com/subeichen1/casthub/releases/latest/download/CastHub.exe'
    Write-Step '下载最新版本 CastHub.exe ...'
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $exePath -UseBasicParsing
    } catch {
        Fail "下载失败：$($_.Exception.Message)"
    }
    if ([string]::IsNullOrWhiteSpace($expectedHash)) {
        $checksumUrl = 'https://github.com/subeichen1/casthub/releases/latest/download/checksums.txt'
        try {
            $checksums = (Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing).Content
            $expectedHash = Read-ChecksumForFile $checksums 'CastHub.exe'
        } catch {
            Write-Warning "无法下载 checksums.txt：$($_.Exception.Message)"
        }
    }
}

if ([string]::IsNullOrWhiteSpace($expectedHash)) {
    if (-not $AllowUnsigned) {
        Fail '无法取得 CastHub.exe 的 SHA-256 校验和。请通过 -Sha256 指定官方校验值，或在明确了解风险时使用 -AllowUnsigned。'
    }
    Write-Warning '未校验安装包哈希（-AllowUnsigned）。'
} else {
    Assert-Checksum $exePath $expectedHash 'CastHub.exe'
}

if ($RequireSignature) {
    Assert-Authenticode $exePath
} elseif ((Get-AuthenticodeSignature -LiteralPath $exePath).Status -ne 'Valid') {
    Write-Warning 'CastHub.exe 未通过 Authenticode 签名校验；请核对 SHA-256 或使用 -RequireSignature 强制要求签名。'
}

Unblock-File -Path $exePath -ErrorAction SilentlyContinue

$config = [ordered]@{ mediaDir = $MediaDir }
$json = $config | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)

Write-Step "已安装到：$InstallDir"
Write-Step "媒体目录：$MediaDir"

function New-CastHubShortcut([string]$ShortcutPath, [string]$TargetPath, [string]$WorkingDirectory) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($ShortcutPath)
        $shortcut.TargetPath = $TargetPath
        $shortcut.WorkingDirectory = $WorkingDirectory
        $shortcut.IconLocation = "$TargetPath,0"
        $shortcut.Description = 'CastHub 局域网投屏'
        $shortcut.Save()
    } catch {
        Write-Warning "创建快捷方式失败：$ShortcutPath"
    }
}

if (-not $NoShortcuts) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not [string]::IsNullOrWhiteSpace($desktop)) {
        New-CastHubShortcut (Join-Path $desktop 'CastHub.lnk') $exePath $InstallDir
    }
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    if (Test-Path -LiteralPath $startMenu) {
        New-CastHubShortcut (Join-Path $startMenu 'CastHub.lnk') $exePath $InstallDir
    }
}

if (-not $NoLaunch) {
    Write-Step '启动 CastHub ...'
    Start-Process -FilePath $exePath -WorkingDirectory $InstallDir
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host "程序位置：$exePath"
Write-Host "媒体目录：$MediaDir"
Write-Host '首次运行如出现 Windows SmartScreen 提示，请选择「更多信息」→「仍要运行」。'
