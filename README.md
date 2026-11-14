# CastHub MVP

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
│   ├── src/console-ws.ts    # 控制台 ↔ 中枢 WS
│   ├── public/              # 控制台网页（原生 HTML/JS，无构建）
│   └── scripts/             # fake-tv.mjs 电视模拟器 + e2e.mjs 集成测试
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

> 本仓库开发环境没有 ffmpeg，未内置 ffmpeg 生成的测试片；请自行把视频放入媒体目录。开发时用的 `server/media/test.mp4` 是公开示例视频，仅用于本地 Range 门禁验证。

## 电视端 App 安装（TCL U 盘 sideload）

APK 实际路径：

```
tv-app/app/build/outputs/apk/debug/app-debug.apk
```

本仓库交付时已包含构建产物（6,437,094 字节，SHA-256 `87816EA91C276A63164A19E66A0676B60F95174C85AC26E16CA9A8689FBD0183`），可直接复制到 U 盘安装。如需重新构建，请在一台装有 Android Studio 的电脑上：

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

## 常见问题排查

1. **Windows 首次运行弹防火墙授权必须允许（端口 9420 入站）**。不允许的话，浏览器可能能打开控制台，但电视拉不到媒体流。
2. **控制台必须用 PC 的局域网 IP 打开，严禁 localhost / 127.0.0.1**。否则中枢推导出的 play URL 是 `http://127.0.0.1:9420/...`，电视端访问的是它自己，拉不到流。
3. **电视与 PC 必须同网段**，路由器 AP 隔离 / 访客网络会导致彼此连不上；请关闭 AP 隔离或使用同一普通 Wi-Fi。
4. **有画面无声音 = 片源大概率是 DTS 音轨**，属已知边界，不是 bug；换 AAC 音轨的片源即可。

## 开发与测试

```bash
cd server
npm install
npm run build     # TypeScript 类型检查 + 编译到 dist/
npm run e2e       # 启动 fake-tv + 中枢，跑完整投屏流程
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
- 不做 SSDP/mDNS/DLNA/二维码/屏幕镜像，配对靠手输地址 + 6 位码。
- DTS 等电视不支持的音轨只能换片源，本项目不转码。
