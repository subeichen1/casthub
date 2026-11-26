# CastHub

<p align="center">
  <strong>局域网投屏，把 PC 上的本地视频直接送上电视。</strong><br />
  开源 · 免云上传 · Windows 桌面端 / Android TV / DLNA
</p>

<p align="center">
  <a href="https://github.com/subeichen1/casthub/actions/workflows/ci.yml"><img src="https://github.com/subeichen1/casthub/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://github.com/subeichen1/casthub/releases/latest"><img src="https://img.shields.io/github/v/release/subeichen1/casthub?display_name=tag&sort=semver" alt="Latest release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/subeichen1/casthub" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=node.js&logoColor=white" alt="Node.js 22+" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Android%20TV%20%7C%20DLNA-0ea5e9" alt="Windows / Android TV / DLNA" />
</p>

CastHub 是一个开源的局域网投屏工具，由 **PC 中枢、浏览器控制台和 Android TV 客户端** 三部分组成。它可以把电脑上的本地视频直接投到电视播放，不需要数据线，不需要 U 盘，也不会上传云端。对于不能安装 App 的电视，CastHub 还提供 DLNA/UPnP 降级模式，尽可能覆盖更多家庭设备。

**English** — CastHub is an open-source, self-hosted LAN casting tool that streams local videos from your PC to Android TV and DLNA-enabled TVs. No cables, USB drives, or cloud uploads required.

![CastHub 浏览器控制台](docs/console-playing.png)

> 当前版本：**v0.3.0**。主线投屏链路已通过自动化端到端测试；DLNA 是兼容性降级路径，具体限制见 [DLNA 兼容模式](#dlna-兼容模式降级)。

## 核心特性

| 能力 | 说明 |
| --- | --- |
| **本地投屏** | 浏览器控制台浏览媒体库，一键把视频投到电视；支持播放、暂停、拖动进度和停止。 |
| **DLNA 兼容** | 电视装不了 App 时，自动发现并驱动电视自带的 DLNA/UPnP 播放器。 |
| **播放历史** | 按文件路径保存播放位置；再次投同一文件默认续播，可从控制台管理历史。 |
| **Windows 桌面端** | 免安装 portable 版，双击即用，可放 U 盘携带；支持同目录 `config.json`。 |
| **Android TV 客户端** | Kotlin + Media3/ExoPlayer 原生播放，支持遥控器操作与 8 位安全配对码。 |
| **局域网直连** | PC 与电视直接传输媒体流，不经过云端；支持 HTTP Range，进度拖动可靠。 |
| **电视应用助手** | 通过 ADB 自动匹配电视 ABI/SDK，索引 GitHub Releases 并安装 Aerial / TVBox / 红果短剧 TV；支持镜像加速与 SHA-256 校验。 |
| **零构建控制台** | 原生 HTML/CSS/JavaScript，无需前端构建工具，打开浏览器即可使用。 |

## 系统要求

| 组件 | 要求 |
| --- | --- |
| PC 中枢（桌面版） | Windows 10 / 11，无需安装 Node.js |
| PC 中枢（源码 / 部署脚本） | Node.js 22+、npm，Windows / macOS / Linux |
| Android TV 客户端 | Android 6.0（API 23）及以上，约 8 MB 存储空间 |
| 网络 | PC 与电视连接同一局域网，路由器未开启 AP 隔离 |

## 快速开始

### 方式一：Windows 一键安装（推荐）

在 PowerShell 中运行：

```powershell
$p = Join-Path $env:TEMP 'CastHub-install.ps1'; iwr -UseBasicParsing https://github.com/subeichen1/casthub/releases/latest/download/install.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p
```

安装脚本会自动完成以下步骤：

1. 从最新 Release 下载 `CastHub.exe`，并校验 SHA-256（可用 `-Sha256` 指定官方值，或用 `-RequireSignature` 强制要求 Authenticode 签名）；
2. 安装到 `%LOCALAPPDATA%\CastHub`；
3. 创建桌面和开始菜单快捷方式；
4. 创建默认媒体目录 `%USERPROFILE%\Videos\CastHub`；
5. 启动 CastHub 桌面端。

安装完成后，把视频放入默认媒体目录，或在程序目录的 `config.json` 中修改 `mediaDir`。脚本源码见 [scripts/install.ps1](scripts/install.ps1)。

### 方式二：源码一键启动（Windows / macOS / Linux）

需要预先安装 **Node.js 22+** 和 Git。将下面整段命令粘贴到终端：

```bash
git clone --depth 1 https://github.com/subeichen1/casthub.git && cd casthub/server && npm install && npm start
```

启动成功后打开 `http://<PC 局域网 IP>:9420`。默认媒体目录为 `server/media`，可通过 `MEDIA_DIR` 环境变量指定其他目录。

### 方式三：Linux / macOS 一键部署脚本

```bash
curl -fsSL https://github.com/subeichen1/casthub/releases/latest/download/install.sh | bash
```

脚本会从最新 Release 下载源码包，并用 `checksums.txt` 校验 SHA-256（也可用 `CASTHUB_SHA256` 指定），然后部署到 `~/.local/share/casthub`、安装依赖并编译服务端，默认安装完成后直接启动；也可稍后手动执行 `~/.local/share/casthub/start-casthub.sh`。可通过环境变量 `CASTHUB_DIR`、`CASTHUB_MEDIA_DIR`、`CASTHUB_PORT` 覆盖默认路径和端口。

### 方式四：下载 Android TV 客户端

从 [Releases](https://github.com/subeichen1/casthub/releases/latest) 下载已签名的 `CastHub-TV.apk`，并用 `checksums.txt` 核对 SHA-256 后通过 U 盘安装到电视。详细步骤见 [电视端 App 安装](#电视端-app-安装tcl-u-盘-sideload)。

### 方式五：自动化 / 无人值守（非 AI 功能）

这里的“AI Agent”只是指自动化安装场景，项目本身不包含 AI/ML 功能。CI 或无图形环境建议使用“只安装、不启动、不创建快捷方式”的模式：

**Windows（PowerShell）**

```powershell
$p = Join-Path $env:TEMP 'CastHub-install.ps1'; iwr -UseBasicParsing https://github.com/subeichen1/casthub/releases/latest/download/install.ps1 -OutFile $p; powershell -NoProfile -ExecutionPolicy Bypass -File $p -NoShortcuts -NoLaunch
```

默认安装到 `%LOCALAPPDATA%\CastHub`；需要指定路径时，在末尾追加 `-InstallDir "D:\Apps\CastHub" -MediaDir "D:\Videos\CastHub"`。需要启动时执行：

```powershell
Start-Process "$env:LOCALAPPDATA\CastHub\CastHub.exe" -WorkingDirectory "$env:LOCALAPPDATA\CastHub"
```

**Linux / macOS**

```bash
curl -fsSL https://github.com/subeichen1/casthub/releases/latest/download/install.sh | CASTHUB_NO_LAUNCH=1 bash
```

默认安装到 `~/.local/share/casthub`；把 `CASTHUB_NO_LAUNCH=1` 换成 `CASTHUB_DAEMON=1` 可在安装后后台启动，日志写入 `~/.local/share/casthub/casthub.log`。自定义路径时，在命令前加 `CASTHUB_DIR=/opt/casthub CASTHUB_MEDIA_DIR=/srv/videos`。

## 控制台界面

控制台包含以下主要区域：

- **设备**：输入电视显示的 `ws://<电视 IP>:9417` 和 8 位配对码，添加并查看设备在线状态；
- **播放历史**：列出文件名、更新时间与进度百分比，可继续播放、从头播放、删除单条或清空全部；
- **电视助手**：给 Android TV 一键安装 Aerial 极简桌面（可一键还原），也能安装红果短剧 TV、TVBox 等普通电视应用（见下文）；
- **媒体库**：浏览 `MEDIA_DIR` 下的视频文件，显示文件名、类型与大小；有播放历史的文件默认从上次位置继续，并提供「从头」入口；
- **播放控制**：显示当前播放状态、进度条、暂停/继续和停止按钮。

## 播放历史与断点续播

CastHub 会按文件绝对路径记录播放位置，App（casthub）与 DLNA 设备共用同一份历史。再次投同一文件时默认从上次位置继续，也可以在控制台选择「从头播放」。

### 数据位置

优先级：`DATA_DIR` > `PORTABLE_EXECUTABLE_DIR`（桌面版 exe 所在目录）> 项目根目录。数据库固定位于其下的 `data/`：

- SQLite 模式：`data/casthub.db`
- JSON 降级模式：`data/casthub-history.json`（仅当 better-sqlite3 无法安装/加载时）
- `data/` 已加入 `.gitignore`，不与源码混在一起。

### 断点判定规则

- 每 5 秒最多落盘一次；状态切换为 paused / idle / error 时立即落盘。
- 5 秒 ≤ 播放位置 < 95% × 时长才视为有效断点；小于 5 秒不记录。
- 播放位置达到 95% 视为看完：位置清零、播放次数 +1，历史行保留。
- 时长为 0 时不判看完，避免除零。
- 续播目标超过换片源后的实际时长时，由播放错误自动清除该文件历史。

### 控制台操作

- 左侧「播放历史」列出文件名、更新时间与进度百分比，可「继续播放」「从头播放」「删除」，或点「清空」删除全部。
- 媒体库中有历史的文件，主按钮显示「继续播放」并默认 `resume=true`；旁边的「从头」按钮使用 `resume=false`。

### 备份方法

直接复制整个 `data/` 目录即可（SQLite 模式可能同时包含 `-wal`/`-shm` 临时文件；停止 CastHub 后复制最稳妥）。恢复时把 `data/` 放回同一优先级路径即可。

### JSON 降级模式

`better-sqlite3` 是可选原生依赖；如果当前机器没有预编译产物且缺少 C++ 构建工具，安装或加载失败时，中枢会记录日志并自动使用 `data/casthub-history.json`（整表读写）。接口、协议与控制台功能完全一致；在依赖安装正常的人类机器上会自然回到 SQLite。项目只保留 SQLite 与 JSON 两种实现。

### Electron 打包

`better-sqlite3` 13 起改用 N-API 并提供随包预编译二进制，通常无需单独按 Electron ABI 重建；`npm run dist` 会完成打包。若替换为自行编译的原生版本，可执行：

```bash
npx electron-builder install-app-deps
```

## 工作原理

PC 中枢基于 Node.js 22 + TypeScript + Fastify + ws，在 `9420` 端口同时提供 REST（`/api/files`）、媒体流（`/media/*`，支持 Range）与控制台 WebSocket（`/console`）。电视端 App 使用 Kotlin + Media3（ExoPlayer），自身在 `9417` 端口启动 WebSocket 服务端，中枢作为客户端主动连接电视；两条 WS 通道彼此独立。

```text
浏览器控制台 ──WS /console──▶ PC 中枢(9420) ──WS 客户端──▶ 电视 App(9417)
                                   │
                                   └──HTTP /media（Range）──▶ 电视 ExoPlayer
```

控制台通过 `/console` 让中枢下发播放指令，电视播放器通过 HTTP 直接拉取 `http://<中枢 IP>:9420/media/...`。拖动进度依赖中枢对 HTTP Range 的支持。

## 项目结构

```text
casthub/
├── server/                  # Node.js 中枢
│   ├── src/index.ts         # 入口：读取 config.json / 环境变量，组装 HTTP + WS 服务
│   ├── src/files.ts         # /api/files 浏览 + /media 流（Range）
│   ├── src/devices.ts       # 设备注册 + 中枢→电视 WS 客户端（指数退避重连）
│   ├── src/dlna.ts          # DLNA 发现、SOAP 控制与状态轮询（降级模式）
│   ├── src/history.ts       # 播放历史接口 + SQLite/JSON 存储
│   ├── src/console-ws.ts    # 控制台 ↔ 中枢 WS
│   ├── src/tv-apps.ts       # 第三方 TV 应用目录、变体匹配与设备属性解析
│   ├── src/tv-desktop.ts    # APK 下载、ADB 探测与安装
│   ├── src/tv-release-resolver.ts # GitHub Releases / 静态目录 / ETag 缓存解析
│   ├── src/tv-apps-meta.json # TV 应用元数据（后端与目录构建脚本共用）
│   ├── src/network-config.ts # 网络设置读取、校验与持久化
│   ├── src/network-fetch.ts  # undici 代理 / 网络客户端
│   ├── public/              # 控制台网页（原生 HTML/JS，无构建）
│   ├── data/                # 播放历史数据库（运行时生成，已 gitignore）
│   └── scripts/             # fake-tv / e2e / e2e-tv-* / build-tv-catalog / fake-dlna
├── tv-app/                  # Android TV App（Kotlin + Media3）
│   └── app/src/main/java/io/casthub/tv/
│       ├── MainActivity.kt  # 配对屏：本机 WS 地址 + 8 位配对码
│       ├── TvWsServer.kt    # 9417 WS 服务端 + 协议分发
│       ├── PlayerActivity.kt# ExoPlayer 全屏播放
│       └── Protocol.kt      # 消息数据类
├── scripts/                 # 安装与部署脚本
├── docs/                    # 截图与演示文件
└── .github/workflows/       # GitHub Actions CI + TV 目录定时生成
```

协议细节见 [PROTOCOL.md](PROTOCOL.md)。

## 配置说明

优先级：**环境变量 > `config.json` > 内置默认值**。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `MEDIA_DIR` | `server/media` | 媒体根目录，支持绝对路径；不存在时自动创建。 |
| `DATA_DIR` | 项目根目录（桌面版为 exe 所在目录） | 历史数据根目录，实际数据库位于其下的 `data/`；优先级高于 `PORTABLE_EXECUTABLE_DIR`。 |
| `PUBLIC_BASE_URL` | 自动探测局域网 IPv4 | 覆盖下发给电视的媒体基址，例如 `http://192.168.1.5:9420`。默认从网卡探测非回环 IPv4。 |
| `CONSOLE_TOKEN` | 自动生成并持久化 | 控制台访问令牌；未设置时优先读取 config.json，否则写入 `CASTHUB_CONFIG_DIR/console-token.txt`。 |
| `CASTHUB_CONFIG_DIR` | 进程工作目录 | `config.json` 与 `console-token.txt` 的存放目录。 |
| `CASTHUB_LOG_FILE` | 空（输出到终端） | 指定后写入带轮转的服务端日志文件。 |
| `PORT` | `9420` | 中枢 HTTP/WebSocket 端口。 |
| `DLNA_SEED` | 空 | 逗号分隔的 `device.xml` URL，用于跳过 SSDP 直接注入 DLNA 设备。 |
| `network.*` | 空 | 网络设置：代理、GitHub 镜像、GitHub Token、静态目录地址；字段、环境变量与安全限制详见下文「网络设置（代理 / 镜像 / GitHub Token）」。 |

桌面版可在 `CastHub.exe` 同目录放置 `config.json`：

```json
{
  "mediaDir": "D:\\Videos",
  "publicBaseUrl": "http://192.168.1.5:9420"
}
```

## 桌面版（便携版）

Windows 电脑直接双击 `CastHub.exe` 即可启动，免安装、可放 U 盘携带。首次运行请注意：

1. Windows SmartScreen 提示「Windows 已保护你的电脑」时，点「更多信息」→「仍要运行」。
2. Windows 防火墙弹窗（进程名 `CastHub.exe`）必须点「允许访问」，否则电视端无法拉取视频流。
3. 运行日志写在 exe 所在目录的 `casthub.log`，排查问题时请一并提供。
4. 需要指定媒体目录或公网地址时，在 exe 同目录创建 `config.json`；环境变量优先级最高。
5. **关闭窗口（右上角 ×）不会退出 CastHub，而是隐藏到系统托盘**；需要彻底退出时，右键任务栏托盘区的 CastHub 图标（蓝色 C）选择「退出」。托盘菜单还可以「显示 CastHub」、勾选「开机自启」、手动「检查更新」；发现新版本时会显示「立即更新…」。

### 开机自启

桌面设置面板与托盘菜单里的「开机自启」复选框双向同步，状态保存在 exe 同目录 `config.json` 的 `desktop.autoStart`。开启后 Windows 登录时会自动启动 CastHub。

portable 版请慎开：启动项指向 exe 当前路径，移动或删除 exe（例如 U 盘拔走后）启动项会失效；需要时把 exe 放回原路径，或重新打开 CastHub 重新勾选。

### 自动更新（Windows portable）

CastHub 启动 5 秒后检查一次，之后每 24 小时检查一次；也可以在托盘菜单或桌面设置面板点「检查更新」。内置默认更新仓库为 `subeichen1/casthub`，所有用户无需额外配置即可检查 GitHub Releases；程序读取 `releases/latest`，将 `tag_name` 与当前三段版本号比较，发现新版本会发系统通知，并在桌面设置面板和托盘菜单显示「立即更新」。

点击「立即更新」后，桌面设置面板会依次显示下载进度「正在下载 42%」、校验状态「正在校验…」和安装状态「正在安装，应用即将重启…」。整个流程不打开浏览器、不跳转 GitHub 页面，也不需要手动下载或替换文件。程序只使用 GitHub Release `assets` 里的 `CastHub.exe` 与 `checksums.txt`，强制核对 `CastHub.exe` 的 SHA-256；缺少任一资产、下载失败或哈希不匹配都会中止更新并保留现有 exe。更新 helper 会等待旧进程退出，并在外层 portable 进程释放文件锁后重试替换，再把新版本启动起来。

> **旧版本限制**：v0.2.0 及更早版本没有自动更新器，第一次必须从 Releases 页面手动下载并安装 v0.2.1 或更高版本；从包含自动更新器的版本开始，之后才能在应用内一键更新。

注意事项：

- 更新目标目录必须可写；把 `CastHub.exe` 放在 `Program Files` 等受保护目录时，Windows 可能拒绝替换，程序会提示「更新目标目录不可写」。
- helper 使用 Windows 自带的 `powershell.exe`（PowerShell 5.1 即可），不依赖 PowerShell 7。
- Release 必须同时提供 `CastHub.exe` 和 `checksums.txt`，且 `checksums.txt` 包含 `CastHub.exe` 的 SHA-256；否则检查更新会返回明确错误。
- 自动更新始终校验 Authenticode 签名者：默认 `desktop.updateSignerSubject` 为 `CN=CastHub Development*`（支持 `*` 通配）；使用其他发布证书时必须在 `config.json` 中改为对应 Subject，留空或主体不匹配都会拒绝更新。SHA-256 仍会同时强制校验。
- 如需改用其他 GitHub 仓库，可在 `config.json` 中覆盖 `desktop.updateRepo`；更新资产地址始终来自该仓库 `releases/latest` 返回的 `assets`，且必须是 HTTPS。

```json
{
  "mediaDir": "D:\\Videos",
  "publicBaseUrl": "http://192.168.1.5:9420",
  "desktop": {
    "autoStart": false,
    "updateRepo": "subeichen1/casthub",
    "updateSignerSubject": "CN=CastHub Development*"
  }
}
```

匿名请求受 GitHub 60 次/小时限额约束，程序固定每 24 小时检查一次，不会分钟级轮询。

## 电视端 App 安装（TCL U 盘 sideload）

APK 本地构建产物路径：

```text
tv-app/app/build/outputs/apk/release/app-release.apk
```

构建产物不随 git 仓库分发。请到本仓库的 **Releases** 页下载已签名的 `CastHub-TV.apk`，并用同页 `checksums.txt` 核对 SHA-256。Release 构建需要签名材料（`CASTHUB_KEYSTORE_FILE` 等环境变量），没有签名材料时本地只会产出 unsigned APK，不能用于正式分发。如需重新构建，请在一台装有 Android Studio 的电脑上：

1. 用 Android Studio 打开 `tv-app` 目录，等待 Gradle Sync 完成（JDK 17，AGP 8.2，Kotlin 1.9）。
2. 菜单 Build → Build App Bundle(s) / APK(s) → Build APK(s)。
3. 产物即位于上面的路径；正式发布请使用 `.github/workflows/release.yml` 注入签名材料构建。

安装到 TCL 电视：

1. 把已签名的 `CastHub-TV.apk` 复制到 U 盘（FAT32 即可）；`app-debug.apk` 仅用于本地调试，不要分发。
2. U 盘插到电视 USB 口，用电视自带的「媒体中心 / 文件管理」找到 APK。
3. 在电视上允许未知来源安装：设置 → 系统 → 安全 → 允许未知来源安装（不同 TCL 固件菜单名可能略有差异），然后安装。
4. 打开「CastHub TV」应用，屏幕会显示本机 WebSocket 地址和 8 位配对码。

## 使用流程

1. 启动 PC 中枢，终端会显示本地控制台地址（默认 `http://127.0.0.1:9420`）和 `MEDIA_BASE` 局域网地址。
2. 双击桌面版时控制台会自动携带令牌打开；用浏览器手动访问时打开 `http://<PC 局域网 IP>:9420`，并把中枢生成的 `console-token.txt` 内容填入令牌输入框。
3. 打开电视端 App，记下 `ws://<电视 IP>:9417` 和 8 位配对码。
4. 在控制台「设备」区域填入地址和配对码，点「添加」；设备显示「在线」后进入下一步。
5. 在「媒体库」选择视频，点「投屏」；在「播放控制」拖动进度条可 seek，暂停/继续和停止即时生效。
6. 遥控器操作：确认键播放/暂停，左右键 ±10 秒，返回键停止并回配对屏。

## 真机 / 模拟器验证清单

- [ ] Android Studio 能 Sync 并构建出 `tv-app/app/build/outputs/apk/release/app-release.apk`（或使用 CI 的 debug 构建产物做功能验证）。
- [ ] `adb install -r tv-app/app/build/outputs/apk/release/app-release.apk` 成功（需已签名）。
- [ ] 启动 App 后 `adb logcat` 出现 `WS_LISTENING ws://<局域网 IP>:9417`。
- [ ] 模拟器场景执行 `adb reverse tcp:9417 tcp:9417`，控制台添加 `ws://127.0.0.1:9417` + 配对码，设备显示在线。
- [ ] 模拟器场景以 `PUBLIC_BASE_URL=http://10.0.2.2:9420` 启动中枢，投屏后 `adb logcat` 出现 `STATE playing`。
- [ ] 真机场景：电视与 PC 同网段，控制台用 PC 局域网 IP 打开，添加电视后投屏能出画面。
- [ ] 遥控器：确认键播放/暂停，左右键 ±10 秒，返回键停止并回配对屏，播完自动回配对屏。

## DLNA 兼容模式（降级）

当电视装不了 CastHub App（老系统、酒店电视、朋友家电视等）但支持 DLNA/UPnP 渲染器时，中枢会降级为 UPnP 控制点，直接驱动电视自带的 DLNA 播放器。这是兜底路径，不是主线。

### 何时使用

电视无法安装 CastHub App，或临时在没有 App 的电视上播放 PC 本地视频时使用。电视必须具备 DLNA/UPnP MediaRenderer（AVTransport）能力。

### 限制清单

- **字幕是厂商扩展，尽力而为**：DLNA 没有统一的字幕协议。中枢会先按「内嵌字幕与三种字幕模式」处理内嵌字幕，需要外挂时扫描视频同目录及 `Subs/`、`subtitles/`、`sub/` 一级子目录中的字幕文件，按精确同名、语言后缀、格式顺序选出一条，再按电视品牌使用不同扩展写入 DIDL-Lite（见下方「字幕格式与厂商 profile」）。不同品牌、型号的识别率差异很大，不保证一定能显示。Sony 官方支持文档明确写「DLNA 服务器不支持 srt 字幕显示」，这类电视请改用主路线 CastHub App（字幕处理见「字幕」相关章节）。所有外挂字幕会统一转成 UTF-8 srt，`Content-Type` 为 `application/x-subrip; charset=utf-8`；个别电视只认 `text/plain` 时，可把 `server/src/files.ts` 的 `MIME_TYPES` 中 `.srt` 值改成 `text/plain` 后重启中枢（默认不建议，因为会影响主路线）。
- **音量控制**：支持 UPnP RenderingControl 的电视可在控制台调节 0-100 音量（发现后每 2 秒同步一次）；电视不支持或未提供 RenderingControl 时滑条禁用并提示，不影响播放控制。
- **拖动精度受电视影响**：进度条 seek 会转成电视的 AVTransport Seek，实际落点和响应速度由电视实现决定。
- **断点续播**：已支持；中枢在 Play 后等待 1 秒再发 Seek，实际落点与响应速度由电视实现决定。
- **mkv / avi 可能不被电视接受**：部分电视 DLNA 渲染器只支持 mp4 等有限封装；这是已知边界，本项目不做转码补救。
- **状态有最多数秒延迟**：中枢每 1s 轮询一次电视状态，界面显示可能比电视实际状态慢数秒。

### 字幕格式与厂商 profile

支持 `.srt`、`.vtt`、`.ass`、`.ssa`、`.smi`、`.sub`（文本 MicroDVD / SubViewer；二进制 VobSub 跳过）六种格式，扩展名大小写不敏感。扫描视频同目录与 `Subs/`、`subtitles/`、`sub/` 一级子目录；精确同名优先，其次支持 `zh`、`zh-CN`、`zh-Hans`、`zh-Hant`、`chs`、`cht`、`chi`、`en`、`eng`、`ja`、`jpn`、`ko`、`kor` 等语言后缀（可带 `forced` / `sdh` 等修饰词）。每次播放只选择并输出一条字幕。

| Profile | 识别依据（manufacturer / model） | DIDL-Lite 输出 |
|---|---|---|
| Samsung | manufacturer 含 `samsung` | 仅一个 `<sec:CaptionInfoEx protocolInfo="http-get:*:application/x-srt:*" sec:type="srt">` |
| Panasonic | manufacturer 含 `panasonic` / `matsushita` | 仅视频 `<res>` 增加 `pv:subtitleFileUri` 与 `pv:subtitleFileType="SRT"` |
| LG | manufacturer 含 `lg` / `webos` | 仅一个 `protocolInfo="http-get:*:text/srt:*"` 的额外 `<res>` |
| Generic | 其他厂商（含未知） | 同 LG：一个 `text/srt` 额外 `<res>` |
| Sony | manufacturer 含 `sony` | 不输出任何字幕标记（仅日志提示不支持） |

Samsung 场景还会在 `/media` 的 GET/HEAD 响应加 `CaptionInfo.sec: <完整URL>`；`subtitles=0` 时 DIDL 与响应头均不出现字幕。外挂字幕 URL 指向 `/api/subtitle`，服务端在内部完成格式解码和 SRT 规范化。

### 内嵌字幕与三种字幕模式

控制台 DLNA 选项提供三种模式（默认 `auto`，仅 DLNA 设备使用）：

- **自动（电视优先，`auto`）**：先探测视频内嵌字幕。存在任意内嵌字幕轨时，媒体 URL 带 `subtitles=0` 并让电视直接读取内嵌字幕，不再发外挂字幕，避免电视内嵌字幕和服务器外挂字幕叠成两层；没有内嵌字幕轨时才回退到同目录外挂字幕。若 ffprobe 不可用，中枢会先回退到同目录外挂字幕；没有外挂字幕时才提示「无法检测内嵌字幕，请安装 ffmpeg/ffprobe，或改用服务器字幕模式」，视频仍可播放。
- **服务器字幕（`server`）**：中枢用 ffprobe 选择一条文本内嵌字幕（优先 default 非 forced、语言偏好、其他非 forced，最后 forced），用 ffmpeg 抽取 UTF-8 SRT，并生成仅含视频/音频、不重编码的去字幕副本；媒体 URL 指向副本，字幕 URL 指向 SRT。首次抽取或生成副本会等待，之后复用缓存。图片字幕（PGS/VobSub 等）不支持服务器模式，会明确报错且不投屏；无内嵌字幕轨时回退外挂字幕。服务器模式需要 ffmpeg 与 ffprobe，缺失时明确报错，不会降级为外挂。
- **关闭（`off`）**：不发送任何字幕，媒体 URL 带 `subtitles=0`。

工具路径通过环境变量 `FFPROBE_PATH`（默认 `ffprobe`）与 `FFMPEG_PATH`（默认 `ffmpeg`）配置；启动日志会打印可用性。探测支持常见文本字幕编码（srt/subrip、ass/ssa、mov_text、webvtt 等）；硬字幕烧录在画面里，无法检测也无法关闭。内嵌字幕缓存位于 `data/cache/embedded-subtitles`（7 天未使用自动清理，不删正在生成的文件），首次服务器模式抽取会占用额外磁盘与时间。DLNA 电视对字幕的识别仍取决于厂商实现，不保证显示。

### 播放队列与自动连播（仅 DLNA）

选中 DLNA 设备后，媒体库的每个视频行会出现「加入队列」按钮。队列为空时，第一次加入会作为第 1 项立即开始播放；队列已有内容时，新视频只追加到队尾，不打断当前播放，点击顺序就是播放顺序。右侧「播放队列」面板显示序号、文件名、当前项高亮以及「正在播放 2/5」等状态，提供「开始播放/继续队列」「移除」「清空」操作；当前播放项不允许移除，需先停止，清空时若正在播放会先停止再清空。

自动连播完全由服务器执行，不依赖 PC 页面是否打开；PC 刷新或断开后队列继续播放。当前项自然结束后等待 `DLNA_AUTO_NEXT_DELAY_MS`（默认 1500ms，须为正整数，非法值按默认处理）自动播放下一项；最后一项结束后队列显示「队列已完成」，停在最后一项，不循环、不重复投最后一项。手动停止只停止当前播放并把队列置为暂停，保留队列，不会自动跳下一项；再次点「开始播放/继续队列」从当前项从头播放（第一项首次开始仍可沿用既有断点续播逻辑）。

普通「投屏/从头」是单文件操作：如果该 DLNA 设备已有队列，会先清空队列再按原逻辑投屏，避免旧队列在后台继续跳。队列只保存在服务器进程内存中，服务重启后清空；队列项只保存媒体库相对路径和显示名，真正播放时才生成签名 URL。队列内每一项都独立走现有的 DLNA 字幕准备流程，仍然保证任何时刻最多只向电视输出一条字幕。

### 设备如何出现

中枢启动时以及之后每 60 秒通过 SSDP M-SEARCH 自动发现同网段的 DLNA 渲染器，通常几秒内出现在控制台设备列表中，并带有「DLNA」徽章。也可以点设备面板的「刷新设备」立即重扫。DLNA 设备无需配对码，且不支持手动添加/移除。

### 发现失败 / AP 隔离时使用 DLNA_SEED

如果路由器开了 AP 隔离、禁用了多播，或 SSDP 一直收不到设备，可用 `DLNA_SEED` 直接注入电视的 `device.xml` 地址（多个地址用英文逗号分隔）：

```powershell
$env:DLNA_SEED = "http://192.168.1.8:49152/device.xml"
npm start
```

`DLNA_SEED` 只是发现阶段的降级入口，设备仍按 DLNA 渲染器工作，限制清单同样适用。

![DLNA 设备列表](docs/dlna-ui-01-devices.png)

## 第三方 TV 应用推荐与 ADB 安装

CastHub PC 中枢支持通过 ADB 自动探测电视的 Android 版本（`ro.build.version.sdk`）与芯片架构（`ro.product.cpu.abilist` / `abi`），自动匹配最合适的安装包并完成校验与推送安装。

### 内置索引的第三方项目

CastHub 仅索引以下项目的上游官方 GitHub Releases，**不在本仓库或 CastHub Releases 中托管、修改或二次打包任何第三方 APK**：

| 应用名称 | 上游仓库 | 说明与定位 |
| :--- | :--- | :--- |
| **Aerial 极简桌面** | [`pengchujin/aerial-tv`](https://github.com/pengchujin/aerial-tv) | 开源 Android TV 极简启动器；查询失败时提供官方默认直链兜底。 |
| **TVBox（TVBoxOSC）** | [`j4Uq/TVBoxOSC`](https://github.com/j4Uq/TVBoxOSC) | 社区维护的开源 TVBox 空壳构建库（含 `java` / `python` 及 32/64 位多变体），软件本身不含任何片源。 |
| **红果短剧 TV** | [`aston314/hongguo-tv-releases`](https://github.com/aston314/hongguo-tv-releases) | 第三方独立大屏客户端发布库（含标准版、MPV 版与 Android 5 兼容版）；自动过滤非 Android 平台 Tag。 |

### 使用前提

1. 电视与运行 CastHub 的电脑在同一局域网；
2. 在电视上开启「开发者选项 → USB 调试 / 网络调试（ADB）」；
3. 电脑上能运行 adb：优先用 `PATH` 里的 adb，其次用 `%LOCALAPPDATA%\CastHub\platform-tools\adb.exe`。也可以在 `config.json`/环境变量里指定：`CASTHUB_ADB_PATH` 或 `ADB_PATH`。没有 adb 时，控制台面板会给出 Google 官方 platform-tools 下载地址（需手动解压到上面那个目录）。
4. 首次连接时电视会弹出「允许 USB 调试」，请勾选「始终允许」。

### 操作

在控制台左侧「电视助手」面板里先选应用，再选目标电视（IP 从设备列表自动解析，不需要手输），点「一键安装桌面」/「安装 红果短剧 TV」/「安装 TVBox」。安装过程会依次显示下载进度与每一步 adb 命令的执行结果；失败时会给出中文原因（未授权、电视禁止安装、存储不足、签名冲突、连不上 5555 等）。

- **Aerial**：装完后按电视 Home 键，选择 Aerial 作为默认桌面即可。Aerial 的安装会额外执行官方推荐的可选步骤（定位/WRITE_SECURE_SETTINGS 授权、7 条 appops、通知监听、启动、预编译），验收三条：默认 HOME、无障碍守护服务、前台窗口。
- **红果短剧 TV / TVBox**：只执行必需步骤（下载 → `adb connect` → `get-state` → `install -r`）加两条可选（启动主界面、预编译），不申请桌面/无障碍相关权限，验收只看包是否装上、前台是否切到该应用。装完在电视的应用列表里打开即可，不需要也不要选它当默认桌面。TVBox 的六个变体共用一个包名，安装前会多跑一条可选的「卸载同包名旧版本」，避免签名冲突导致安装失败。

「还原原桌面」只对 Aerial 显示，执行通用还原步骤（关闭守护广播、撤销权限、清理 appops、移出无障碍服务、释放 HOME role、卸载）。海信、TCL、小米等品牌还有厂商定制项，面板里的「复制官方还原命令」会给出 Aerial 官方 `restore.sh` 命令，在 macOS/Linux 终端执行。红果、TVBox 这类普通应用的按钮是「卸载 <应用名>」，只做 `am force-stop` + `adb uninstall`，不碰桌面角色与无障碍设置。

### 红果短剧 TV 的三个变体

红果的发布页同时提供三个 APK，包名互相独立，**可以同时装在同一台电视上**（账号、观看历史、设置各自独立，互不影响）：

| 变体 | 包名 | 适用 |
| --- | --- | --- |
| 标准版（默认） | `rocks.aston.hongguotv` | 绝大多数 Android TV；HTML5 播放失败时自动切 Media3 |
| MPV 版 | `rocks.aston.hongguotv.mpv` | 标准版解码有问题的机型（MPV 解码，APK 更大） |
| Android 5 兼容版 | `rocks.aston.hongguotv.android5test` | 仅 Android 5.0 / 5.1 老电视 |

在面板的应用下拉里选中「红果短剧 TV」后会出现变体下拉，默认「自动匹配（按电视系统属性）」；切换变体会重新查询该变体对应的安装包与已装版本。

### TVBox 的六个变体（共用一个包名）

TVBoxOSC 的发布页对每个上游分支提供多个 APK，CastHub 取其中的 `TVBox_q215613905_<构建时间>-<flavor>.apk` 系列（`q215613905/TVBoxOS` 分支）：

| 变体 | 资产后缀 | 架构 | 适用 |
| --- | --- | --- | --- |
| Java 标准版（默认） | `-java.apk` | armeabi-v7a + arm64-v8a | 绝大多数电视 |
| Java 32 位版 | `-java32.apk` | 仅 armeabi-v7a | 32 位老电视 |
| Java 64 位版 | `-java64.apk` | 仅 arm64-v8a | 包体更小 |
| Python 标准版 | `-python.apk` | armeabi-v7a + arm64-v8a | 需要 Python 解析器的源，包体约 50 MB |
| Python 32 位版 | `-python32.apk` | 仅 armeabi-v7a | — |
| Python 64 位版 | `-python64.apk` | 仅 arm64-v8a | — |

**与红果的关键差别：六个变体共用同一个包名 `com.github.tvbox.osc.jun`，同一台电视只能装一个。** 想换变体请先点「卸载 TVBox」再装；直接点安装也会先执行一次可选的 `adb uninstall`（旧包不存在时该步骤失败也不影响后续安装）。

版本号不是语义化版本，而是构建时间戳（如 `20261111-1518`），面板照样能比较新旧并提示更新。

### 自动匹配电视系统属性

变体下拉的默认项是「自动匹配（按电视系统属性）」。选中它以后，CastHub 会在查询安装包之前先连上电视、跑一次 `adb shell getprop` 读系统属性，再按下面的规则挑资产：

| 判断依据 | 取自 | 作用 |
| --- | --- | --- |
| API 等级 | `ro.build.version.sdk` | 与变体的 `minSdk`/`maxSdk` 比对（红果 Android 5 兼容版上限 API 22，标准版下限 23） |
| CPU 架构 | `ro.product.cpu.abilist`（退回 `abi`） | 与变体的 ABI 列表比对（TVBox 的 java32 只吃 armeabi-v7a，java64 只吃 arm64-v8a/x86_64） |
| 机型/厂商 | `ro.product.model`、`ro.product.manufacturer` | 只用于在面板上显示「电视系统」一行，便于确认读到的确实是这台电视 |

排序规则：先按变体的自动优先级（标准版优先，专版略高，MPV/Python 这类包体大的排在后面），再按主 ABI 与变体的贴合度（同时支持 arm64 与 armv7 的电视会选 64 位专版，而不是靠目录顺序），最后才是默认变体与目录顺序。面板会显示匹配方式（自动匹配 / 手动选择 / 回退默认），自动匹配时还写清依据，例如「Android API 22 · armeabi-v7a · Old TV 1080P → Android 5 兼容版」。

几种兜底情况：

- 读不到系统属性（老固件 getprop 输出为空、adb 掉线）→ 回退默认变体，面板标注「读不到电视系统属性，使用默认变体」，安装照常进行，不会因为探测失败挡住流程。
- 手动在下拉里指定了具体变体 → 不再探测系统属性（省一次 adb 往返），完全尊重手动选择；点安装时中枢会用同一个具体变体重跑一次匹配，避免前端状态过期装错包。
- 红果 MPV 版自动优先级低于标准版，因此只有手动选才会装；它和标准版包名不同，可以共存。

### 静态目录与版本解析机制

为避免匿名访问 GitHub API 触发 60 次/小时的出口 IP 限流，并解决多平台混发仓库的 Tag 识别问题，CastHub 后端按以下优先级解析安装包信息：

1. **离线 JSON 注入（调试 / 离线环境）**：优先读取环境变量 `AERIAL_RELEASE_JSON`、`HONGGUO_RELEASE_JSON`、`TVBOX_RELEASE_JSON`。
2. **静态目录 `tv-catalog.json`（默认主路径，0 次 GitHub API 额度消耗）**：仓库通过 GitHub Actions（`.github/workflows/tv-catalog.yml`）每 4 小时自动抓取上游最新正式版并生成元数据清单，发布至独立分支 `catalog-data`。PC 后端本地磁盘缓存 30 分钟，过期后携带 `If-None-Match`（ETag）发起条件请求，上游无更新时返回 `304` 复用缓存；远端不可达时自动降级使用本地旧缓存。
3. **直连 GitHub API 兜底**：静态目录不可用或目标应用缺失时自动回退至 `api.github.com`，同样启用 10 分钟磁盘缓存与 ETag `304`（不扣除限流配额）；遇到 `403/429` 限流时优先降级返回旧缓存，无缓存时提示重置时间。
4. **应用级兜底**：Aerial 默认变体保留官方固定直链兜底。

### 版本与校验

面板显示版本号、体积与 SHA-256；上游 Release 提供 `digest` 或 `SHA256SUMS.txt` / `checksums.txt` 时，下载后会强制校验 SHA-256，校验失败即中止且不会安装。Aerial 的资产名固定为 `aerial-standard.apk`；红果按变体匹配 `hongguo-tv-<版本>.apk`、`hongguo-tv-mpv-<版本>.apk`、`hongguo-tv-android5-<版本>.apk`；TVBox 按变体匹配 `TVBox_q215613905_<构建时间>-java.apk`、`-java32`、`-java64`、`-python`、`-python32`、`-python64`。Aerial 在静态目录与 GitHub API 均不可达时会回退官方固定直链（此时无校验和，面板会标注「官网镜像」）；红果与 TVBox 查询失败时面板直接报错、不下载。

需要装特定版本时，在「装指定版本 / 手动安装」里填 https 的 APK 直链；手动地址不会自动带校验和，面板会再确认一次。

下载缓存位于 `data/cache/tv-desktop`，可以随时删除；同一个 APK 再次安装会复用缓存（文件名形如 `aerial-<版本>-<地址哈希>.apk`、`hongguo-mpv-<版本>-<地址哈希>.apk`）。

### 已装版本与更新提示

面板选中电视后会自动读取电视上已装的应用版本（`adb shell dumpsys package <包名>` 的 `versionName`），显示「电视上的 Aerial：v2.11」或「电视上的 红果短剧 TV：v0.2.182」；如果 GitHub 上的最新正式版更高，会额外提示「有新版本 vX，可重新一键安装升级」。比较用数字段逐段对比（`0.2.182`、`20261111-1518` 这类都能比），镜像渠道或版本号解析不出来时不提示更新，避免误报。红果三个变体分别查询各自的包名，装了两个变体时两条记录互不干扰；TVBox 六个变体共用一个包名，读到的就是当前装着的那一个。

CastHub **不会自动升级**已装的应用：确认要升级时再点一次安装按钮即可（内部是 `adb install -r`，保留数据）。静态目录默认缓存 30 分钟、直连 GitHub API 缓存 10 分钟；点面板上的「刷新」会绕过缓存重新查询发布信息，同时重新读取已装版本。

调试或多网环境可以用环境变量注入发布信息，跳过 GitHub 查询：`AERIAL_RELEASE_JSON`（Aerial）、`HONGGUO_RELEASE_JSON`（红果）与 `TVBOX_RELEASE_JSON`（TVBox）指向一个本地 JSON 文件（允许带 UTF-8 BOM），内容形如 `{"tag":"0.2.182","apkName":"hongguo-tv-0.2.182.apk","apkUrl":"https://…/hongguo-tv-0.2.182.apk","sizeBytes":30608185,"sha256":"…","publishedAt":"…","variant":"standard"}`；红果与 TVBox 可带 `variant` 字段限定只对该变体生效（缺省 `apkUrl` 或变体不匹配时报错，不会套用别的变体的安装包）。

### 风险提示

Aerial 会接管电视的默认桌面与 Home 键，属于对电视系统的修改。请在确认可以还原后再安装；还原依赖 adb 仍然可用，如果安装后又关闭了电视的 ADB 调试，就只能用官方脚本或电视恢复出厂设置。CastHub 不对第三方桌面的稳定性负责。

红果短剧 TV 与 TVBox 不修改桌面，但都是第三方内容应用：内容版权、账号、会员与隐私政策均由该应用与其服务方决定，CastHub 只负责把它装上，不参与内容分发也不对其内容负责。TVBoxOSC 本身不附带任何源地址，装完需要在应用里自行配置，源地址的可用性与合法性由使用者判断。安装包来自第三方 GitHub 发布页，面板会校验发布页给出的 SHA-256；手动填写的直链没有校验和，请自行确认来源。

下载链路的安全边界（SHA-256 强校验、镜像域名限制、GitHub Token 凭据隔离与安全 Range 续传）详见下方 [下载安全与容错边界](#下载安全与容错边界)，并与 [SECURITY.md](SECURITY.md) 的资产与信任边界统一。

---

## 网络设置（代理 / 镜像 / GitHub Token）

国内网络环境下如遇静态目录拉取慢、APK 下载断流或直连 API 限流，可通过 **Web 控制台 → 网络设置**（复用现有 `/console` 令牌鉴权，保存后立即热生效并自动清理旧缓存，无需重启）、`config.json` 或环境变量进行配置。

优先级为：**环境变量 > `config.json` > 默认直连**。

### 配置项与环境变量对照

| `config.json` 字段 | 环境变量 | 用途说明 | 校验与限制 |
| :--- | :--- | :--- | :--- |
| `network.proxy` | `CASTHUB_PROXY`（未设置时回退 `HTTPS_PROXY` / `HTTP_PROXY`，并尊重 `NO_PROXY`） | 为目录拉取、GitHub API 与 APK 下载配置代理（如 `http://127.0.0.1:7890`）。 | 仅允许 `http://` 或 `https://`，拒绝内嵌用户名密码的代理 URL。 |
| `network.githubMirror` | `CASTHUB_GITHUB_MIRROR` | 自定义 GitHub 加速镜像前缀（如 `https://mirror.example.com`）。 | 必须为 `https://`，禁止私网/局域网/回环地址（防 SSRF）。 |
| `network.githubToken` | `CASTHUB_GITHUB_TOKEN` | 可选的 GitHub Personal Access Token（无需额外权限），直连回退 API 时将限额由 60 次/小时提升至 5,000 次/小时。 | 仅保存在服务端本地，绝不写入日志或向前端回传明文。 |
| `network.catalogUrl` | `CASTHUB_CATALOG_URL` | 自定义静态目录 `tv-catalog.json` 地址（默认指向本仓库 `catalog-data` 分支）。 | 必须为 `https://`，禁止私网/局域网/回环地址。 |

`config.json` 示例（`network` 为可选字段，全留空即零配置直连）：

```json
{
  "desktop": {
    "autoStart": false,
    "updateRepo": "subeichen1/casthub"
  },
  "network": {
    "proxy": "",
    "githubMirror": "",
    "githubToken": "",
    "catalogUrl": ""
  }
}
```

### 下载安全与容错边界

* **SHA-256 强校验红线**：第三方加速镜像**仅在目标 APK 具备上游合法 64 位 SHA-256 哈希时启用**；若上游未提供校验值，CastHub 会自动跳过所有镜像，仅从官方原始地址下载。
* **多源自动回退**：下载按 `用户自定义镜像 → 目录镜像池 → GitHub 原始直链` 顺序尝试。若镜像返回非 `200/206`、返回 `text/html` / `application/json` 拦截页、连接超时或落盘后 SHA-256 校验失败，会自动清理临时 `.part` 文件并无缝切换至下一候选源。
* **域名与凭据严格隔离**：
  * 镜像前缀仅对 `github.com`、`raw.githubusercontent.com`、`objects.githubusercontent.com` 生效，绝不包裹独立官方域名。
  * `Authorization: Bearer <githubToken>` 请求头仅在访问 `api.github.com` 时附加，绝不发送给任何镜像站或文件下载节点。
  * Web 控制台仅显示 Token 是否已配置，留空保存不会覆盖现有 Token，支持显式一键清除。
* **可靠传输保护**：支持同源安全 `Range` 断点续传（切换镜像源时自动清空旧分片，严禁跨源拼接）、同文件并发下载去重，以及默认 200 MiB 的单包体积上限保护。

---

## 第三方应用来源声明与免责说明

1. **项目独立性与来源归属**：CastHub 本身是局域网投屏与 Android TV 设备管理工具。内置的第三方 TV 应用推荐功能仅作为上游公开 GitHub Releases 的索引与 ADB 安装辅助，**不托管、不修改、不二次分发任何第三方二进制安装包**。所列第三方应用的名称、图标、源代码及相关知识产权均归各自原作者或版权方所有，CastHub 与其不存在任何官方合作、授权或隶属关系。
2. **仅限纯工具与空壳播放器**：CastHub 不内置、不收集、不提供也不推荐任何影视点播接口、IPTV 直播源或受版权保护的音视频内容。开源播放器（如 TVBoxOSC）安装后均为不含片源的空壳软件。
3. **合规使用与风险自担**：第三方客户端的持续可用性、数据隐私行为及服务条款合规性由其各自上游项目独立承担。用户在使用 CastHub 安装及运行任何第三方应用前，应自行评估软件来源并严格遵守所在国家/地区的法律法规及相关平台服务协议，因安装或使用第三方软件产生的一切风险与责任均由用户自行承担。
4. **权利人通知与下架**：若任何第三方项目作者或权利人认为本项目的索引条目涉及不当引用或侵犯合法权益，请通过 GitHub Issues 或仓库安全联系方式告知，我们将在核实后第一时间移除对应索引。

## 开发与测试

```bash
cd server
npm install
npm run build        # TypeScript 类型检查 + 编译到 dist/
npm run typecheck    # 仅类型检查
npm run e2e          # fake-tv + 中枢，完整 App 投屏流程
node scripts/e2e-history.mjs # 播放历史 + 重启后续播流程
node scripts/e2e-dlna.mjs   # fake-dlna + 中枢，DLNA 降级流程
node --import tsx scripts/e2e-subtitles.mjs # 多格式字幕解析 + /api/subtitle + /media
node --import tsx scripts/e2e-embedded-subtitles.mjs # 内嵌字幕三模式 + 缓存路由 + DLNA DIDL
npm run e2e-queue   # DLNA 播放队列 + 自动连播 + 停止/清空
npm run e2e-tv-desktop # 电视助手：fake adb 覆盖 Aerial 安装/未授权/厂商拒绝/还原 + 红果三变体安装与共存 + TVBox 六变体（共享包名）+ 按系统属性自动匹配变体
npm run e2e-tv-release # TV release 解析：Tag 过滤 / 自动匹配 / 大小上限
npm run e2e-tv-catalog # 静态目录构建：digest / checksums / 旧数据保留
npm run e2e-tv-network # 网络设置 / 代理 / 镜像回退 / SHA-256 / Range 续传 / 并发合并
npm run e2e-security # 安全边界与历史存储恢复
npm run test:updater # 桌面自动更新器单元测试
```

单独运行电视模拟器：

```bash
node server/scripts/fake-tv.mjs
# 环境变量：FAKE_TV_PORT=9417 FAKE_TV_TOKEN=123456 FAKE_TV_NAME="Fake TV"
```

Range 验证示例：

```bash
# /api/files 与 /media 都需要控制台令牌；令牌见 console-token.txt
curl -H "x-casthub-token: $TOKEN" http://127.0.0.1:9420/api/files
curl -H "x-casthub-token: $TOKEN" -r 0-1023 http://127.0.0.1:9420/media/test.mp4
```

CI 使用 GitHub Actions（`.github/workflows/ci.yml`），在 Node.js 22 下执行 `npm ci`、类型检查、构建、生产与开发依赖审计（`npm audit --audit-level=high`）和十一条 e2e（App 投屏、DLNA、播放历史、字幕、内嵌字幕、播放队列、电视助手、TV release、TV catalog、TV network、安全），并构建 Android debug APK；发布由 `.github/workflows/release.yml` 使用签名材料产出带 `checksums.txt` 的 Release。

## 常见问题

1. **Windows 首次运行弹防火墙授权必须允许（端口 9420 入站）**。不允许的话，浏览器可能能打开控制台，但电视拉不到媒体流。
2. **手动打开控制台时建议使用 PC 的局域网 IP**（`http://<PC 局域网 IP>:9420`）；桌面版会自动打开本地控制台并通过 `PUBLIC_BASE_URL`/网卡探测生成电视可访问的媒体地址。若电视仍提示无法播放，请检查 `MEDIA_BASE` 是否是 PC 的局域网 IP。
3. **电视与 PC 必须同网段**。路由器 AP 隔离 / 访客网络会导致彼此连不上；请关闭 AP 隔离或使用同一普通 Wi-Fi。
4. **有画面无声音 = 片源大概率是 DTS 音轨**。属已知边界，不是 bug；换 AAC 音轨的片源即可。
5. **DLNA 搜索不到设备**。确认电视与 PC 同网段，必要时用 `DLNA_SEED` 注入 `device.xml` 地址。

## 已知边界

- 无转码、无多用户；设备列表与当前播放状态存内存，中枢重启后设备列表清空；播放历史持久化在本地 `data/`（SQLite，安装失败时 JSON 降级）。
- 主线不做 SSDP/mDNS/二维码/屏幕镜像，配对靠手输地址 + 8 位码；DLNA 兼容模式作为降级路径。
- DTS 等电视不支持的音轨只能换片源，本项目不转码。
- 本项目面向家庭局域网，不建议直接暴露到公网。控制面使用控制台令牌鉴权，媒体流使用 HMAC 签名 URL；信任边界与安全验收要求见 [SECURITY.md](SECURITY.md)。第三方 TV 应用下载的 SHA-256 强校验、镜像域名限制与 GitHub Token 凭据隔离统一见 [下载安全与容错边界](#下载安全与容错边界)。

## 文档

- [PROTOCOL.md](PROTOCOL.md)：WS 协议与 REST 规范（实现唯一依据）
- [PUBLISH.md](PUBLISH.md)：GitHub 发布手册与发布记录
- [BLOCKERS.md](BLOCKERS.md)：当前环境无法执行、需人工补充的事项
- [DEVIATIONS.md](DEVIATIONS.md)：对锁定决策 / 依赖白名单的说明
- [REPORT.md](REPORT.md)：最终验收报告（含各 Phase 门禁输出）

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

---

如果 CastHub 对你有帮助，欢迎在 GitHub 上点一个 Star，或提交 Issue / Pull Request。
