# CastHub MVP 最终验收报告

日期：2026-11-14  
项目目录：`C:\Users\18460\Desktop\项目\桌面美化复刻\casthub-mvp`

## 0. 环境自检

| 项目 | 结果 |
|---|---|
| Node | `v24.20.0` |
| npm | `11.19.0` |
| adb | `Android Debug Bridge version 1.0.41 / Version 37.0.1-15733141` |
| ffmpeg | 不存在（CommandNotFoundException），Phase 1 测试片使用公开示例 MP4 替代并记入 BLOCKERS.md |
| JDK | Temurin `17.0.21+9`（仅本机验证用） |
| Gradle | `8.2`（仅本机验证用） |
| Android SDK | Platform 34 / Build-Tools 34.0.0（本机安装于 `C:\castbuild\tools\android-sdk`，不随仓库交付） |
| AVD | `Android_TV_1080p`（tv_1080p，Android 14 / API 34，x86）；因无硬件加速驱动无法启动，见 BLOCKERS.md |

## Phase 0 — 骨架与协议

### 门禁：PROTOCOL.md 覆盖全部消息

```text
$ Select-String -Path PROTOCOL.md -Pattern '^\| (中枢|电视|控制台)'
```

PROTOCOL.md 中的协议表（完整内容见仓库文件）：

```text
| 中枢→电视 | hello | {token, clientId}（token 错误则电视以 close code 4001 断开） |
| 电视→中枢 | helloAck | {ok, deviceName} |
| 中枢→电视 | play | {url, title, mimeType} |
| 中枢→电视 | pause / resume / stop | {} |
| 中枢→电视 | seek | {positionMs} |
| 中枢→电视 | getStatus | {} |
| 电视→中枢 | status | {state: idle|buffering|playing|paused|error, positionMs, durationMs}（播放中每 1s 推送，状态变化立即推送） |
| 电视→中枢 | error | {code, message} |
| 控制台→中枢 | addDevice | {address, token} |
| 控制台→中枢 | removeDevice | {id} |
| 控制台→中枢 | cast | {deviceId, path} |
| 控制台→中枢 | control | {deviceId, action: pause|resume|stop|seek, positionMs?} |
| 中枢→控制台 | devices | {list: [{id, address, online}]} |
| 中枢→控制台 | tvStatus | {deviceId, state, positionMs, durationMs} |
| 中枢→控制台 | error | {message} |
```

初始 commit：`615cbab phase(0): 初始化项目骨架与协议文档`

## Phase 1 — 中枢文件服务与 Range

```text
=== 1) Range 0-1023 ===
HTTP/1.1 206 Partial Content
accept-ranges: bytes
content-type: video/mp4
content-range: bytes 0-1023/1128375
content-length: 1024
Date: Sat, 14 Nov 2026 07:24:53 GMT
Connection: keep-alive
Keep-Alive: timeout=72

=== 2) No Range ===
HTTP/1.1 200 OK
accept-ranges: bytes
content-type: video/mp4
content-length: 1128375
Date: Sat, 14 Nov 2026 07:24:53 GMT
Connection: keep-alive
Keep-Alive: timeout=72

=== 3) Path traversal ===
HTTP/1.1 403 Forbidden
content-type: application/json; charset=utf-8
content-length: 21
Date: Sat, 14 Nov 2026 07:24:53 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"error":"forbidden"}

=== 4) 非法 Range（附加验证） ===
$ curl -s -D - -o NUL -H "Range: bytes=99999999-" http://127.0.0.1:9420/media/test.mp4
HTTP/1.1 416 Range Not Satisfiable
content-range: bytes */1128375
content-type: application/json; charset=utf-8
content-length: 33
```

说明：第一次测试片使用 MDN 公开示例 `flower.mp4`（1,128,375 bytes），因环境无 ffmpeg；已在 BLOCKERS.md 记录。

## Phase 2 — 设备管理、fake-tv 与 e2e

```text
$ node server/scripts/e2e.mjs
测试媒体目录: C:\Users\18460\AppData\Local\Temp\casthub-e2e-EuaZFP\media

[1/10] 启动 fake-tv ...
[fake-tv] [fake-tv] LISTENING ws://0.0.0.0:9417 token=246810 name=Fake TV
[2/10] 启动中枢 ...
[server] {"level":30,"time":1794641119322,"pid":12592,"hostname":"星辰","msg":"Server listening at http://127.0.0.1:9420"}
[server] {"level":30,"time":1794641119322,"pid":12592,"hostname":"星辰","msg":"CastHub 已启动 http://127.0.0.1:9420  MEDIA_DIR=C:\Users\18460\AppData\Local\Temp\casthub-e2e-EuaZFP\media"}
[server] {"level":30,"time":1794641119366,"pid":12592,"hostname":"星辰","reqId":"req-1","req":{"method":"GET","url":"/api/files?path=","hostname":"127.0.0.1:9420","remoteAddress":"127.0.0.1","remotePort":12652},"msg":"incoming request"}
[3/10] 连接控制台 WS ...
[server] {"level":30,"time":1794641119370,"pid":12592,"hostname":"星辰","reqId":"req-1","res":{"statusCode":200},"responseTime":3.404899999499321,"msg":"request completed"}
✓ 控制台 WS 已连接并收到初始 devices
[4/10] addDevice ...
[server] [console] 添加设备 ws://127.0.0.1:9417 (3bf21b62)
[fake-tv] [fake-tv] CONNECTED 127.0.0.1
[fake-tv] [fake-tv] AUTH_OK clientId=casthub-db35c09b
✓ 设备上线: ws://127.0.0.1:9417
[5/10] 浏览文件 ...
[server] {"level":30,"time":1794641119396,"pid":12592,"hostname":"星辰","reqId":"req-2","req":{"method":"GET","url":"/api/files?path=","hostname":"127.0.0.1:9420","remoteAddress":"127.0.0.1","remotePort":12652},"msg":"incoming request"}
✓ /api/files 返回视频: sample.mp4 (262144 bytes, video/mp4)
[6/10] cast ...
[server] {"level":30,"time":1794641119396,"pid":12592,"hostname":"星辰","reqId":"req-2","res":{"statusCode":200},"responseTime":0.6078999992460012,"msg":"request completed"}
[server] [console] 投屏 sample.mp4 -> 3bf21b62: http://127.0.0.1:9420/media/sample.mp4
[fake-tv] [fake-tv] PLAY_URL http://127.0.0.1:9420/media/sample.mp4
[server] {"level":30,"time":1794641119401,"pid":12592,"hostname":"星辰","reqId":"req-3","req":{"method":"GET","url":"/media/sample.mp4","hostname":"127.0.0.1:9420","remoteAddress":"127.0.0.1","remotePort":12655},"msg":"incoming request"}
[server] {"level":30,"time":1794641119403,"pid":12592,"hostname":"星辰","reqId":"req-3","res":{"statusCode":206},"responseTime":2.2648999989032745,"msg":"request completed"}
[fake-tv] [fake-tv] RANGE_PROBE 206
✓ 电视进入 playing（duration=60000ms）
✓ 播放地址由控制台 Host 头推导: http://127.0.0.1:9420/media/sample.mp4
[7/10] seek ...
✓ seek 生效 positionMs=30000
[8/10] pause ...
✓ pause 生效，tvStatus=paused
[9/10] 验证 PUBLIC_BASE_URL 覆盖 ...
[fake-tv-override] [fake-tv] LISTENING ws://0.0.0.0:9418 token=135790 name=Override TV
[server-override] {"level":30,"time":1794641119944,"pid":22616,"hostname":"星辰","msg":"Server listening at http://127.0.0.1:9421"}
[server-override] {"level":30,"time":1794641119945,"pid":22616,"hostname":"星辰","msg":"CastHub 已启动 http://127.0.0.1:9421  MEDIA_DIR=C:\Users\18460\AppData\Local\Temp\casthub-e2e-EuaZFP\media"}
[server-override] {"level":30,"time":1794641119979,"pid":22616,"hostname":"星辰","reqId":"req-1","req":{"method":"GET","url":"/api/files?path=","hostname":"127.0.0.1:9421","remoteAddress":"127.0.0.1","remotePort":3987},"msg":"incoming request"}
[server-override] {"level":30,"time":1794641119982,"pid":22616,"hostname":"星辰","reqId":"req-1","res":{"statusCode":200},"responseTime":3.3933999985456467,"msg":"request completed"}
[server-override] [console] 添加设备 ws://127.0.0.1:9418 (62dce562)
[fake-tv-override] [fake-tv] CONNECTED 127.0.0.1
[fake-tv-override] [fake-tv] AUTH_OK clientId=casthub-911fccc6
[server-override] [console] 投屏 sample.mp4 -> 62dce562: http://10.0.2.2:9420/media/sample.mp4
[fake-tv-override] [fake-tv] PLAY_URL http://10.0.2.2:9420/media/sample.mp4
[fake-tv-override] [fake-tv] SKIP_PROBE
✓ PUBLIC_BASE_URL 覆盖生效: http://10.0.2.2:9420/media/sample.mp4
[10/10] 清理 ...

✅ E2E 全部通过
EXIT_CODE=0
```

## Phase 3 — 电视 App

### 构建（真实执行）

构建在 ASCII 路径副本 `C:\castbuild\tv-app` 执行（原工作目录包含中文，AGP 8.2 拒绝非 ASCII 路径；仓库 tv-app 源码与副本逐文件哈希一致）：

```text
$ gradle --no-daemon --console=plain assembleDebug
...
> Task :app:packageDebug
> Task :app:createDebugApkListingFileRedirect
> Task :app:assembleDebug

BUILD SUCCESSFUL in 2m 5s
33 actionable tasks: 33 executed
```

APK 实际存在：

```text
Path: C:\Users\18460\Desktop\项目\桌面美化复刻\casthub-mvp\tv-app\app\build\outputs\apk\debug\app-debug.apk
Length: 6437094 bytes
SHA-256: 87816EA91C276A63164A19E66A0676B60F95174C85AC26E16CA9A8689FBD0183
package: name='io.casthub.tv' versionCode='1' versionName='0.1.0'
sdkVersion:'23'
targetSdkVersion:'34'
application-label:'CastHub TV'
```

### 模拟器安装门禁（pending，环境限制）

```text
$ adb devices -l
List of devices attached
emulator-5554          offline transport_id:3

$ adb install -r ...\app-debug.apk
adb.exe: device offline
ADB_INSTALL_EXIT=1

$ emulator -accel-check
accel:
6
Android Emulator hypervisor driver is not installed on this machine
accel
```

已创建 AVD `Android_TV_1080p`（tv_1080p，Android 14 / API 34，x86），但当前账户无管理员权限，无法安装 Android Emulator Hypervisor Driver；以 `-accel off` 软件模拟启动后 emulator-5554 长期 offline、qemu 进程 CPU 为 0。详细记录见 [BLOCKERS.md](BLOCKERS.md)。

## Phase 4 — 控制台 UI 与 README

已用桌面 Chrome + fake-tv 实测（控制台 DOM 操作，非仅截图）：

```json
{
  "connected": true,
  "initial": {"conn": "已连接中枢", "devices": "尚未添加设备", "files": ["测试视频.mp4", "test.mp4"]},
  "online": true,
  "deviceInfo": {"addr": "ws://127.0.0.1:9417", "meta": "在线\n移除", "castDisabled": [false, false]},
  "playing": true,
  "playingInfo": {"badge": "playing", "title": "测试视频.mp4", "pos": "00:00", "dur": "01:00", "sliderMax": "60000", "sliderValue": "0", "toggle": "暂停"},
  "paused": true,
  "pausedInfo": {"badge": "paused", "toggle": "播放", "pos": "00:00"},
  "seekInfo": {"badge": "paused", "pos": "00:30", "sliderValue": "30000"},
  "resumed": true,
  "resumedInfo": {"badge": "playing", "toggle": "暂停", "pos": "00:30"},
  "jsErrors": []
}
```

截图：[控制台 playing 状态](docs/console-playing.png)

README.md 已包含要求的四节：架构、从零运行、TCL U 盘 sideload、常见问题排查；真机操作清单位于 **README.md 的「真机 / 模拟器验证清单」小节**（第 102 行）：

- [ ] Android Studio 能 Sync 并构建出 `tv-app/app/build/outputs/apk/debug/app-debug.apk`。
- [ ] `adb install -r tv-app/app/build/outputs/apk/debug/app-debug.apk` 成功。
- [ ] 启动 App 后 `adb logcat` 出现 `WS_LISTENING ws://<局域网IP>:9417`。
- [ ] 模拟器场景执行 `adb reverse tcp:9417 tcp:9417`，控制台添加 `ws://127.0.0.1:9417` + 配对码，设备显示在线（helloAck 成功）。
- [ ] 模拟器场景以 `PUBLIC_BASE_URL=http://10.0.2.2:9420` 启动中枢，投屏后 `adb logcat` 出现 `STATE playing`。
- [ ] 真机场景：电视与 PC 同网段，控制台用 PC 局域网 IP 打开，添加电视后投屏能出画面。
- [ ] 遥控器：确认键播放/暂停，左右键 ±10 秒，返回键停止并回配对屏，播完自动回配对屏。

## Git log

```text
$ git log --oneline
39750bf docs: 补充非法 Range 验证记录
96e0559 docs: 修正最终报告中的提交记录
2290e48 docs: 添加最终验收报告与控制台实测截图
1d24a64 chore: 补充 Gradle wrapper、APK 构建产物与环境验证记录
814e79d phase(4): 控制台 UI 与中文 README
7c4e68f phase(3): 电视端 Android TV App（构建待 Android SDK）
917b98d phase(2): 设备管理、fake-tv 模拟器与 e2e 集成测试
0f090bc phase(1): 中枢文件服务与 Range 支持
615cbab phase(0): 初始化项目骨架与协议文档
# 注：本报告文件本次更新产生的 docs 提交随后出现，最终提交号以仓库 git log 为准。
```

## BLOCKERS.md

```text
# BLOCKERS / PENDING

记录无法在当前环境执行、需要人工补充验证的事项。

## Phase 1 — ffmpeg 生成测试片（pending）

- 环境检查：`ffmpeg -version` 不存在（CommandNotFoundException）。
- 因此无法按要求用 ffmpeg 生成 60 秒 720p 测试片。
- 替代措施：已下载公开示例 MP4（MDN `flower.mp4`，约 1.1 MB）保存为 `server/media/test.mp4`，用于 Phase 1 Range 门禁验证。
- 用户实际使用时：把自己的视频放入 `MEDIA_DIR`（默认 `server/media`）即可。

## Phase 3 — Android 构建（已解决）与模拟器验证（pending）

- 初始环境：`ANDROID_HOME` 与 `ANDROID_SDK_ROOT` 为空，无 JDK / Gradle / SDK / AVD。
- 已补齐本地工具链：JDK 17.0.21（Temurin）、Gradle 8.2、Android SDK Platform 34、Build-Tools 34.0.0；仅用于本机验证，不随仓库交付。
- 构建结果：`gradle --no-daemon assembleDebug` → **BUILD SUCCESSFUL in 2m 5s**（33 actionable tasks）。
- APK 已复制回交付路径：`tv-app/app/build/outputs/apk/debug/app-debug.apk`，6,437,094 字节，SHA-256 `87816EA91C276A63164A19E66A0676B60F95174C85AC26E16CA9A8689FBD0183`。
- Gradle wrapper 已生成：`tv-app/gradlew`、`gradlew.bat`、`gradle/wrapper/gradle-wrapper.jar`；`distributionUrl` 指向腾讯镜像。
- 模拟器：已创建 AVD `Android_TV_1080p`（tv_1080p，Android 14 / API 34，x86）。本机未安装 Android Emulator Hypervisor Driver，且当前账户无管理员权限，无法安装驱动；`-accel off` 启动后 emulator-5554 长期 offline，qemu CPU 为 0。故 `adb install`、`WS_LISTENING`、helloAck、`STATE playing` 四项模拟器门禁 pending。

## Phase 4 — 模拟器内 UI 全流程（pending）

- 当前状态：SDK 与 AVD 已就绪，但模拟器因无硬件加速无法启动（见 Phase 3 条），无法在模拟器内点击控制台完成投屏链路。
- 替代验证：已用桌面浏览器打开控制台，配合 `fake-tv.mjs` 走通「添加设备 → 浏览 → 投屏 → 暂停 → 拖进度 → 恢复」；WS 层同一流程由 `server/scripts/e2e.mjs` 自动断言。
- 待人工：在具备硬件加速的 Android Studio + Android TV AVD 或真机上按 README「真机 / 模拟器验证清单」补跑模拟器路径。
```

## DEVIATIONS.md

```text
# DEVIATIONS

记录对锁定决策 / 依赖白名单的偏离（均不影响功能行为）。

## 依赖白名单补充：TypeScript 类型声明

- 增加 `@types/node`、`@types/ws`（devDependencies）。
- 原因：server 使用 TypeScript 编写，Node 内置模块与 ws 库需要类型声明才能通过 `tsc` 编译检查；二者仅为编译期类型包，不引入任何运行时依赖。
```

## KNOWN_ISSUES.md

无。Phase 5（外挂字幕）为可选阶段，因 Phase 3/4 的模拟器门禁尚未完成，未尝试实现。
