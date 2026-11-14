# CastHub MVP

CastHub 是一款开源的局域网投屏工具：把 PC 上的本地视频直接投到电视播放，无需数据线、无需上传云端。

CastHub is an open-source LAN casting tool that streams local videos from your PC to Android TV over your home network.
It solves the hassle of copying files or using USB drives — your TV plays videos directly from your PC.
Get started with `cd server && npm install && npm start`, then open `http://<PC-IP>:9420` in a browser.

## 功能特性

- **投屏**：浏览器控制台浏览本地媒体库，一键投到电视；支持播放 / 暂停 / 拖动进度 / 停止。
- **DLNA 降级**：电视无法安装 App 时，可驱动电视自带的 DLNA/UPnP 播放器（无字幕保证，mkv / avi 兼容性取决于电视）。
- **Windows 桌面版**：双击 `CastHub.exe` 即开即用，免安装、可放 U 盘；支持同目录 `config.json` 配置媒体目录。
- **字幕**：中枢支持 `.srt` / `.vtt` 字幕文件访问；显示效果取决于电视播放器（DLNA 模式不推送外挂字幕）。

## 技术栈

| 模块 | 技术栈 |
| --- | --- |
| `server/` 中枢 | Node.js 20 · TypeScript · Fastify · ws |
| 浏览器控制台 | 原生 HTML / CSS / JavaScript（无构建） |
| `tv-app/` 电视端 | Kotlin · Android TV · Media3 / ExoPlayer |
| Windows 桌面版 | Electron · electron-builder（portable） |
| 测试 | Node.js 脚本（fake-tv / fake-dlna + 端到端断言） |

> **构建产物下载**：`CastHub.exe` 与 `app-debug.apk` 不随 git 仓库提供，请到本仓库的 **Releases** 页下载。

局域网投屏工具：PC 上的 Node.js 中枢 + 安卓电视端 Kotlin App + 浏览器控制台。把本地视频从 PC 直接投到电视播放，控制台完成添加设备、浏览文件、投屏与播放控制。

## 架构

PC 中枢基于 Node.js 20 + TypeScript + Fastify + ws，在 9420 端口同时提供 REST（`/api/files`）、媒体流（`/media/*`，支持 Range）与控制台 WebSocket（`/console`）。电视端 App 用 Kotlin + Media3(ExoPlayer) 实现，自身在 9417 端口起 WebSocket **服务端**，中枢作为 **客户端** 主动连接电视；两条 WS 通道彼此独立。控制台在浏览器里通过 `/console` 让中枢下发指令，电视播放器则通过 HTTP 直接拉取 `http://<中枢IP>:9420/media/...`，拖动进度依赖中枢的 Range 支持。

```
浏览器控制台 ──WS /console──▶ PC 中枢(9420) ──WS 客户端──▶ 电视 App(9417)
                                   │
                                   └──HTTP /media（Range）──▶ 电视 ExoPlayer
```

## 目录结构

```
casthub-mvp/
├── server/                  # Node.js 中枢
│   ├── src/index.ts         # 入口：读取 MEDIA_DIR / PUBLIC_BASE_URL
│   ├── src/files.ts         # /api/files 浏览 + /media 流（Range）
│   ├── src/devices.ts       # 设备注册 + 中枢→电视 WS 客户端（指数退避重连）
│   ├── src/dlna.ts          # DLNA 发现、SOAP 控制与状态轮询（降级模式）
│   ├── src/console-ws.ts    # 控制台 ↔ 中枢 WS
│   ├── public/              # 控制台网页（原生 HTML/JS，无构建）
│   └── scripts/             # fake-tv/e2e + fake-dlna/e2e-dlna
└── tv-app/                  # Android TV App（Kotlin + Media3）
    └── app/src/main/java/io/casthub/tv/
        ├── MainActivity.kt  # 配对屏：本机 ws 地址 + 6 位配对码
        ├── TvWsServer.kt    # 9417 WS 服务端 + 协议分发
        ├── PlayerActivity.kt# ExoPlayer 全屏播放
        └── Protocol.kt      # 消息数据类
```

协议细节见 [PROTOCOL.md](PROTOCOL.md)。

## 从零运行（在用户自己的电脑上）

前提：安装 Node.js 20 或更高版本（含 npm）。电视与 PC 在同一局域网。

1. 安装依赖：

   ```bash
   cd server
   npm install
   ```

2. 设置媒体目录（不存在会自动创建）。PowerShell：

   ```powershell
   $env:MEDIA_DIR = "D:\Videos"
   ```

   cmd：

   ```bat
   set MEDIA_DIR=D:\Videos
   ```

   不设置时默认使用 `server/media`。把 mp4/mkv/avi/mov/webm/ts 等视频放进该目录。

3. 启动中枢：

   ```bash
   npm start
   ```

   看到 `CastHub 中枢已启动 http://0.0.0.0:9420` 即成功。

4. 在浏览器打开 `http://<PC局域网IP>:9420`（例如 `http://192.168.1.5:9420`）。

5. 电视端 App 打开后显示 `ws://<电视IP>:9417` 和 6 位配对码；在控制台「设备」里填入地址和配对码，点「添加」。设备变为在线后，在「媒体库」选择视频点「投屏」。

可选环境变量：

- `MEDIA_DIR`：媒体根目录，默认 `server/media`。
- `PUBLIC_BASE_URL`：覆盖下发给电视的媒体基址，例如 `http://192.168.1.5:9420`。默认按控制台连接请求的 Host 头自动推导，一般无需设置。
- `PORT`：中枢端口，默认 9420。
- `DLNA_SEED`：可选，逗号分隔的 `device.xml` URL；跳过 SSDP 直接注入 DLNA 设备（AP 隔离/多播不可达时使用）。

> 本仓库开发环境没有 ffmpeg，未内置 ffmpeg 生成的测试片；请自行把视频放入媒体目录。开发时用的 `server/media/test.mp4` 是公开示例视频，仅用于本地 Range 门禁验证。

## 桌面版（推荐）

Windows 电脑直接双击 `CastHub.exe` 即可启动，免安装、可放 U 盘携带。首次运行请注意：

1. Windows SmartScreen 会提示「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。
2. Windows 防火墙弹窗（此时进程名是 `CastHub.exe`）必须点「允许访问」，否则电视端无法拉取视频流。
3. 运行日志写在 exe 所在目录的 `casthub.log`，排查问题时请一并提供。
4. 如需指定媒体目录或公网地址，可在 exe 同目录放 `config.json`，例如 `{"mediaDir":"D:\\Videos","publicBaseUrl":"http://192.168.1.5:9420"}`；环境变量优先级最高，其次是 `config.json`，最后是内置默认值。

## 回退到网页版

桌面版异常时关闭 exe，然后 `cd server && npm install && npm start`，浏览器开 `http://<PC局域网IP>:9420`，功能完全等价（DLNA 模式同样可用）。

开发者可用 `git reset --hard pre-desktop` 回到无桌面层代码。

## 电视端 App 安装（TCL U 盘 sideload）

APK 实际路径：

```
tv-app/app/build/outputs/apk/debug/app-debug.apk
```

构建产物不随 git 仓库分发，请到本仓库的 **Releases** 页下载 `app-debug.apk`（本地构建参考：6,437,094 字节，SHA-256 `87816EA91C276A63164A19E66A0676B60F95174C85AC26E16CA9A8689FBD0183`）。如需重新构建，请在一台装有 Android Studio 的电脑上：

1. 用 Android Studio 打开 `tv-app` 目录，等待 Gradle Sync 完成（JDK 17，AGP 8.2，Kotlin 1.9）。
2. 菜单 Build → Build App Bundle(s) / APK(s) → Build APK(s)。
3. 产物即位于上面的路径。

安装到 TCL 电视：

1. 把 `app-debug.apk` 复制到 U 盘（FAT32 即可）。
2. U 盘插到电视 USB 口，用电视自带的「媒体中心 / 文件管理」找到 APK。
3. 在电视上允许未知来源安装：设置 → 系统 → 安全 → 允许未知来源安装（不同 TCL 固件菜单名可能略有差异），然后安装。
4. 打开「CastHub TV」应用，屏幕会显示本机 WebSocket 地址和 6 位配对码。

## 真机 / 模拟器验证清单

- [ ] Android Studio 能 Sync 并构建出 `tv-app/app/build/outputs/apk/debug/app-debug.apk`。
- [ ] `adb install -r tv-app/app/build/outputs/apk/debug/app-debug.apk` 成功。
- [ ] 启动 App 后 `adb logcat` 出现 `WS_LISTENING ws://<局域网IP>:9417`。
- [ ] 模拟器场景执行 `adb reverse tcp:9417 tcp:9417`，控制台添加 `ws://127.0.0.1:9417` + 配对码，设备显示在线（helloAck 成功）。
- [ ] 模拟器场景以 `PUBLIC_BASE_URL=http://10.0.2.2:9420` 启动中枢，投屏后 `adb logcat` 出现 `STATE playing`。
- [ ] 真机场景：电视与 PC 同网段，控制台用 PC 局域网 IP 打开，添加电视后投屏能出画面。
- [ ] 遥控器：确认键播放/暂停，左右键 ±10 秒，返回键停止并回配对屏，播完自动回配对屏。

## DLNA 兼容模式（降级）

当电视装不了 CastHub App（老系统、酒店电视、朋友家电视等）但支持 DLNA/UPnP 渲染器时，中枢会降级为 UPnP 控制点，直接驱动电视自带的 DLNA 播放器。这是兜底路径，不是主线。

### 何时用

电视无法安装 CastHub App，或临时在没有 App 的电视上播放 PC 本地视频时使用。电视必须具备 DLNA/UPnP MediaRenderer（AVTransport）能力。

### 限制清单

- **无字幕保证**：DLNA 降级模式不推送外挂字幕，字幕能否显示取决于电视自身。
- **拖动精度受电视影响**：进度条 seek 会转成电视的 AVTransport Seek，实际落点和响应速度由电视实现决定。
- **无断点续播**：中枢不保存播放进度，重启或重新投屏从头开始。
- **mkv / avi 可能不被电视接受**：部分电视 DLNA 渲染器只支持 mp4 等有限封装，mkv（video/x-matroska）/avi 会直接播放失败，这是已知边界，本项目不做转码补救。
- **状态有最多数秒延迟**：中枢每 1s 轮询一次电视状态，界面显示可能比电视实际状态慢数秒。

### 设备如何出现

中枢启动时以及之后每 60 秒通过 SSDP M-SEARCH 自动发现同网段的 DLNA 渲染器，通常几秒内出现在控制台设备列表中，并带有「DLNA」徽章。也可以点设备面板的「刷新设备」立即重扫。DLNA 设备无需配对码，且不支持手动添加/移除。

### 发现失败 / AP 隔离时用 DLNA_SEED 手动添加

如果路由器开了 AP 隔离、禁用了多播，或 SSDP 一直收不到设备，可用 `DLNA_SEED` 直接注入电视的 `device.xml` 地址（多个地址用英文逗号分隔）：

```powershell
$env:DLNA_SEED = "http://192.168.1.8:49152/device.xml"
npm start
```

`DLNA_SEED` 只是发现阶段的降级入口，设备仍按 DLNA 渲染器工作，限制清单同样适用。

## 常见问题排查

1. **Windows 首次运行弹防火墙授权必须允许（端口 9420 入站）**。不允许的话，浏览器可能能打开控制台，但电视拉不到媒体流。
2. **控制台必须用 PC 的局域网 IP 打开，严禁 localhost / 127.0.0.1**。否则中枢推导出的 play URL 是 `http://127.0.0.1:9420/...`，电视端访问的是它自己，拉不到流。
3. **电视与 PC 必须同网段**，路由器 AP 隔离 / 访客网络会导致彼此连不上；请关闭 AP 隔离或使用同一普通 Wi-Fi。
4. **有画面无声音 = 片源大概率是 DTS 音轨**，属已知边界，不是 bug；换 AAC 音轨的片源即可。

## 开发与测试

```bash
cd server
npm install
npm run build        # TypeScript 类型检查 + 编译到 dist/
npm run e2e          # 启动 fake-tv + 中枢，跑完整 App 投屏流程
node scripts/e2e-dlna.mjs   # 启动 fake-dlna + 中枢，跑 DLNA 降级流程
```

单独运行电视模拟器：

```bash
node server/scripts/fake-tv.mjs
# 环境变量：FAKE_TV_PORT=9417 FAKE_TV_TOKEN=123456 FAKE_TV_NAME="Fake TV"
```

Range 验证示例：

```bash
curl -s -D - -o /dev/null -r 0-1023 http://127.0.0.1:9420/media/test.mp4
curl -s -D - -o /dev/null http://127.0.0.1:9420/media/test.mp4
curl 'http://127.0.0.1:9420/media/../package.json'   # 应返回 403
```

## 文档

- [PROTOCOL.md](PROTOCOL.md)：WS 协议与 REST 规范（实现唯一依据）
- [BLOCKERS.md](BLOCKERS.md)：当前环境无法执行、需人工补充的事项
- [DEVIATIONS.md](DEVIATIONS.md)：对锁定决策 / 依赖白名单的说明
- [REPORT.md](REPORT.md)：最终验收报告（含各 Phase 门禁输出）

## 已知边界

- 无数据库、无转码、无多用户，状态存内存；中枢重启后设备列表清空。
- 主线不做 SSDP/mDNS/二维码/屏幕镜像，配对靠手输地址 + 6 位码；DLNA 兼容模式作为降级路径见上节（不含 DLNA MediaServer）。
- DTS 等电视不支持的音轨只能换片源，本项目不转码。

## 许可证

[MIT](LICENSE)

