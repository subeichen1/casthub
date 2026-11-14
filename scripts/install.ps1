<#
.SYNOPSIS
    CastHub Windows 一键安装脚本。
.DESCRIPTION
    下载最新 Release 中的 CastHub.exe，安装到本地应用目录，创建快捷方式并启动。
    支持通过参数修改安装目录、媒体目录以及跳过启动。
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://raw.githubusercontent.com/subeichen1/casthub/main/scripts/install.ps1 | iex"
#>
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CastHub'),
    [string]$MediaDir = '',
    [string]$SourceExe = '',
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

if (-not [string]::IsNullOrWhiteSpace($SourceExe)) {
    Write-Step "使用本地安装包：$SourceExe"
    if (-not (Test-Path -LiteralPath $SourceExe -PathType Leaf)) {
        Fail "找不到安装包：$SourceExe"
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
