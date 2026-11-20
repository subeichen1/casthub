# CastHub WS 协议规范

本文件是实现的唯一依据。两条 WS 通道相互独立，不合并。

## 通道 A：中枢 ↔ 电视（电视端为 WS 服务端，端口 9417，中枢为客户端）

连接建立后，中枢必须发送 hello；token 错误时电视端以 close code 4001 断开。协议版本为 `1`，中枢 `hello` 携带 `version: 1`，电视端 `helloAck` 必须回传 `version`；中枢或电视端发现版本不兼容时以 close code 4004 断开。单条消息超过 64 KiB 时电视端以 close code 4002 断开；同一 IP 在 60 秒内认证失败 10 次后以 close code 4003 断开。

| 方向 | type | 载荷 |
|---|---|---|
| 中枢→电视 | hello | {token, clientId, version: 1}（token 错误则电视以 close code 4001 断开） |
| 电视→中枢 | helloAck | {ok, deviceName, version: 1} |
| 中枢→电视 | play | {url, title, mimeType} |
| 中枢→电视 | pause / resume / stop | {} |
| 中枢→电视 | seek | {positionMs} |
| 中枢→电视 | getStatus | {} |
| 电视→中枢 | status | {state: idle\|buffering\|playing\|paused\|error, positionMs, durationMs}（播放中每 1s 推送，状态变化立即推送） |
| 电视→中枢 | error | {code, message} |

## 通道 B：控制台 ↔ 中枢（9420，路径 /console）

连接必须携带控制台令牌（`?token=` 或 `x-casthub-token` 头），并满足同源 `Origin` 校验；否则以 close code 1008 断开。单条消息上限 64 KiB，每连接 10 秒最多 120 条消息，全局最多 32 个控制台连接。

| 方向 | type | 载荷 |
|---|---|---|
| 控制台→中枢 | addDevice | {address, token} |
| 控制台→中枢 | removeDevice | {id} |
| 控制台→中枢 | cast | {deviceId, path, resume?, subtitles?, subtitleMode?, subtitleTrack?}（resume 默认 true；subtitleMode 为 auto\|server\|off，缺省 auto；subtitleTrack 为内嵌字幕流索引，仅 server 模式使用；旧 subtitles 布尔值兼容：false→off、true/缺省→auto） |
| 控制台→中枢 | control | {deviceId, action: pause\|resume\|stop\|seek\|volume, positionMs?, value?}（volume 时 value 为 0-100 整数） |
| 控制台→中枢 | refreshDevices | {}（立即重扫 DLNA 设备并广播最新 devices） |
| 控制台→中枢 | getHistory | {} |
| 控制台→中枢 | deleteHistory | {path} |
| 控制台→中枢 | clearHistory | {} |
| 控制台→中枢 | queueAdd | {deviceId, path}（仅 DLNA；队列为空时首项立即开始播放，否则追加到队尾） |
| 控制台→中枢 | queuePlay | {deviceId}（开始或继续该设备队列；空队列返回 error） |
| 控制台→中枢 | queueRemove | {deviceId, index}（当前播放项返回 error，需先停止） |
| 控制台→中枢 | queueClear | {deviceId}（正在播放时先停止，再清空队列） |
| 控制台→中枢 | getDesktopInfo | {}（电视助手：adb 状态、Aerial 最新版本、可选电视列表） |
| 控制台→中枢 | installDesktop | {deviceId, apkUrl?}（在目标电视上安装 Aerial 桌面并接管 Home；apkUrl 仅 https，缺省用 GitHub 最新正式版） |
| 控制台→中枢 | uninstallDesktop | {deviceId}（卸载 Aerial 并执行通用还原步骤） |
| 中枢→控制台 | devices | {list: [{id, address, online, type: "casthub"\|"dlna", deviceName, volume?}]}（DLNA 音量 0-100；null/缺省表示不支持） |
| 中枢→控制台 | tvStatus | {deviceId, state, positionMs, durationMs, volume?}（历史由中枢内部消费） |
| 中枢→控制台 | history | {list: [{path, name, positionMs, durationMs, updatedAt, playCount, lastDeviceId}]}（updatedAt 倒序，最多 200 条） |
| 中枢→控制台 | queue | {deviceId, queue: {items: [{path, name}], currentIndex, state: "idle"\|"playing"\|"switching"\|"paused"\|"completed", playing, error?}}（连接建立时下发已有队列，变化时广播；currentIndex 未开始为 -1） |
| 中枢→控制台 | desktopInfo | {adb: {available, path, version, source: "env"\|"local"\|"path"\|"missing", hint}, release: {tag, apkName, apkUrl, sizeBytes, sha256, publishedAt, channel: "github"\|"mirror"\|"custom"} \| null, releaseError, targets: [{deviceId, name, address, ip, kind}], cacheDir, busy, packageName, platformToolsUrl} |
| 中枢→控制台 | desktopProgress | {action: "install"\|"uninstall", percent}（安装阶段下载 APK 时上报 0-100） |
| 中枢→控制台 | desktopResult | {action: "install"\|"uninstall", ok, message, steps: [{key, title, command, ok, required, output}], verification: {homeLauncher, accessibility, focus, detail} \| null, release} |
| 中枢→控制台 | error | {message} |

## 播放历史与断点续播（协议增量）

- 历史按文件绝对路径（`path.resolve` 后）为主键，字段为 `path`、`name`、`positionMs`、`durationMs`、`updatedAt`、`playCount`、`lastDeviceId`。
- 中枢在 `tvStatus` 统一出口记录播放位置：播放中距上次落盘不少于 5s 才写；状态变为 `paused`/`idle`/`error` 时立即落盘；位置达到时长 95% 视为看完（位置清零、`playCount + 1`、保留历史行）；位置小于 5s 不记录；`durationMs = 0` 不判看完。
- 续播规则：`cast` 的 `resume` 缺省为 true；若存在有效历史位置（`5s ≤ positionMs < 95% × durationMs`），播放开始后定位到该位置。`resume=false` 从头播放。casthub 设备在收到 `playing` 后发送既有 `seek`；DLNA 设备在 `Play` 后等待 1s（500ms × 2）再发 `Seek`。收到该文件的 `error` 消息时清除其历史位置。
- `getHistory` 返回最新列表；`deleteHistory`/`clearHistory` 执行后广播最新 `history`。

## DLNA 兼容模式（降级，协议增量）

- 设备类型：`devices.list[].type` 为 `"casthub"`（电视 App）或 `"dlna"`（自动发现的 UPnP MediaRenderer）；`deviceName` 分别取 `helloAck.deviceName` 与 `device.xml` 的 `friendlyName`。
- 发现：中枢作为 UPnP 控制点，用 SSDP M-SEARCH（ST=`urn:schemas-upnp-org:device:MediaRenderer:1` 与 `ssdp:all`）发现设备，每 60s 重扫；控制台发送 `refreshDevices` 立即重扫。
- 设备身份：`device.xml` 的 `UDN` 即设备 id。`addDevice` / `removeDevice` 仅适用于 `casthub` 类型；对 `dlna` 设备返回 `error {message: "DLNA 设备为自动发现，不支持手动增删"}`。
- 投屏：`cast` 到 `dlna` 设备时，中枢调用 `SetAVTransportURI` → 500ms → `Play`；正在播放时先 `Stop`。若 `resume=true` 且存在有效历史位置，在 `Play` 后再等待 1s（500ms × 2）并发送 `Seek`。`control` 的 pause/resume/stop/seek 分别映射为 `Pause`/`Play`/`Stop`/`Seek`（Seek 的 Target 为 `H:MM:SS` 字符串）。
- 状态：中枢每 1s 轮询 `GetTransportInfo` + `GetPositionInfo`，翻译成既有 `tvStatus` 消息。映射：`STOPPED`/`NO_MEDIA_PRESENT`→`idle`、`TRANSITIONING`→`buffering`、`PLAYING`→`playing`、`PAUSED_PLAYBACK`→`paused`。
- 音量：从 `device.xml` 的 `RenderingControl:1` 服务解析独立 `controlURL`，发现设备后立即 `GetVolume` 一次，之后每 2s 轮询一次；`control` 的 `volume` 映射为 `SetVolume`（`Channel=Master`，`DesiredVolume` 为 0-100 整数）。`devices.list[].volume` 与 `tvStatus.volume` 为 `number | null`；`null` 表示该电视不支持 RenderingControl 或音量语义特殊。SetVolume 单次失败只回 `error`，不判设备离线。
- 字幕：`cast` 的 `subtitleMode` 缺省为 `auto`（旧 `subtitles` 布尔值兼容：false→off、true/缺省→auto）。`auto` 优先让电视读取内嵌字幕：探测到任意内嵌字幕轨时媒体 URL 带 `subtitles=0` 且不发送外挂 URL；无内嵌轨时才扫描外挂字幕。`server` 由中枢用 ffprobe 选择一条文本内嵌轨，ffmpeg 抽取 UTF-8 SRT 并生成去字幕副本，媒体 URL 指向副本、字幕 URL 指向 SRT；无文本轨而只有图片轨时明确报错不投屏；无内嵌轨时回退外挂。`off` 不发送任何字幕且媒体 URL 带 `subtitles=0`。任何模式单次播放最多输出一条字幕，禁止内嵌与外挂双发。外挂字幕扫描视频同目录及 `Subs/`、`subtitles/`、`sub/` 一级子目录中的 `.srt`/`.vtt`/`.ass`/`.ssa`/`.smi`/`.sub`，按精确同名 > 同名子目录 > 语言偏好 > 格式顺序 > 路径字典序选出一条。DIDL-Lite 按设备的 `subtitleProfile` 输出：Samsung 仅一个 `sec:CaptionInfoEx`（`sec:type="srt"`）；Panasonic 仅在视频 `<res>` 上加 `pv:subtitleFileUri` 与 `pv:subtitleFileType="SRT"`；LG/Generic 仅一个 `protocolInfo="http-get:*:text/srt:*"` 的额外 `<res>`；Sony 不输出任何字幕标记。`/media` 的 GET/HEAD 仅在请求带 `getCaptionInfo.sec` 头（不限大小写）时返回 `CaptionInfo.sec: <完整URL>`，`subtitles=0` 时 DIDL 与响应头均不出现字幕。外挂字幕 URL 指向 `/api/subtitle`，服务端解码并统一转 UTF-8 srt 后以 `application/x-subrip; charset=utf-8` 下发。
- 字幕扫描与 profile 判定：语言后缀 allowlist 包括 `zh`、`zh-CN`、`zh-Hans`、`zh-Hant`、`chs`、`cht`、`chi`、`en`、`eng`、`ja`、`jpn`、`ko`、`kor` 等，支持 `forced`/`sdh` 等修饰词；`subtitleProfile` 在 manufacturer 非空时按 manufacturer 匹配 `samsung` / `panasonic|matsushita` / `lg|webos` / `sony`，否则为 `generic`，manufacturer 为空时才依次回退 modelName、modelNumber、friendlyName（均 trim + 小写）。
- 测试降级：环境变量 `DLNA_SEED`（逗号分隔的 `device.xml` URL）可跳过 SSDP 直接注入设备，用于 AP 隔离网络或沙箱多播不可达场景。

## 播放队列（仅 DLNA，协议增量）

- 队列按设备保存在中枢进程内存中，不持久化；控制台连接建立时，中枢会为每个已有队列发送一条 `queue` 快照。队列项只保存媒体库相对路径 `path` 与显示名 `name`，每次真正播放该项时才生成签名媒体 URL。
- 队列为空时第一次 `queueAdd` 会把该项作为第 1 项并立即开始播放；队列已有内容时只追加到队尾，不打断当前项。普通 `cast`（单文件投屏/从头）会先清空该 DLNA 设备的队列，再按原投屏流程播放。
- `queue.state` 为 `idle`（空队列）、`playing`、`switching`（正在投下一项）、`paused`（手动停止或播放失败，保留队列）或 `completed`（最后一项自然结束，不循环）。`currentIndex` 未开始时为 -1。
- 自动连播由服务器执行，不依赖控制台页面：当前项自然结束（播放器由 `playing` 转为 `idle`，且位置达到时长的 95%）后等待 `DLNA_AUTO_NEXT_DELAY_MS`（默认 1500ms）自动播放下一项；最后一项结束后停在最后一项并置为 `completed`，不重复投最后一项。切集期间通过 `switching` 锁和播放令牌忽略旧视频的 STOPPED 轮询，避免连跳；自动下一项失败会置为 `paused` 并广播错误，连续失败 2 次停止自动尝试。
- 手动 `control` 的 `stop` 只停止当前播放并保留队列为 `paused`，不会触发自动下一项；之后的 `queuePlay` 从当前项从头播放。`queueRemove` 不允许移除当前播放项；`queueClear` 会先停止当前播放再清空。
- 队列内的每一项仍独立走现有 DLNA 字幕准备流程，任何时刻最多只输出一条字幕。

## 电视助手（Aerial 桌面，协议增量）

- 目标电视只能来自现有设备列表（`devices`），中枢从设备地址解析 IP（casthub 为 `ws://ip:9417`，DLNA 为 LOCATION URL），串口统一为 `<ip>:5555`；不新增手工 IP 输入。
- `getDesktopInfo` 每次实时探测 adb（顺序：`CASTHUB_ADB_PATH`/`ADB_PATH` → `%LOCALAPPDATA%\CastHub\platform-tools` → `PATH`）并查询 Aerial 最新正式版（GitHub Releases API，10 分钟缓存；失败回退官网镜像直链，此时 `sha256` 为 null、`channel` 为 `mirror`）。`busy` 为 true 时拒绝新的安装/还原请求。
- `installDesktop` 流程：解析版本 → 下载 APK 到 `data/cache/tv-desktop`（仅 https 或本机 `file://`，>64 MB 拒绝，发布页提供 `sha256` 时强校验，写 `.part` 后原子重命名）→ `adb connect <ip>:5555` → `get-state` → `install -r`（三条必需）→ 官方可选步骤（`pm grant`、`appops`、`cmd notification allow_listener`、`am start`、`cmd package compile`）。任何必需步骤失败立即中止并返回已执行步骤明细。
- 安装后验收三条：默认 HOME（`cmd package resolve-activity -a android.intent.action.MAIN -c android.intent.category.HOME`）、无障碍服务包含 `app.orchard.tv/.guard.HomeGuardService`、`dumpsys window` 的 `mCurrentFocus` 属于 Aerial。未接管默认桌面时 `ok` 仍为 true，但 `message` 提示手动设置默认桌面。
- `uninstallDesktop` 执行最小还原：`am broadcast` 关闭 keep_adb、`cmd notification disallow_listener`、`pm revoke`、6 条 `appops set … default`、`am force-stop`、从 `enabled_accessibility_services` 剔除 Aerial、`cmd role remove-role-holder --user 0 android.app.role.HOME app.orchard.tv`，最后 `uninstall`。海信/TCL/小米等品牌定制项不在通用还原范围内，控制台给出官方 `restore.sh` 命令供手动执行。
- Aerial 为第三方开源项目（MIT，`pengchujin/aerial-tv`），安装包不随 CastHub 分发；CastHub 只提供下载地址与 adb 命令模板。电视端 App（tv-app）无任何改动。

## REST

`GET /api/files?path=&limit=&offset=` 需要 `x-casthub-token` 或 `?token=`，返回 `{entries: [{name, path, isDir, size, mimeType}], total, offset, limit, hasMore}`；`limit` 默认 200、最大 500。符号链接条目不会出现在列表中。

`GET /api/subtitle?path=&expires=&sig=`（也支持 HEAD）使用与 `/media` 相同的 HMAC 签名或控制台令牌；支持 `.srt`、`.vtt`、`.ass`、`.ssa`、`.smi`、`.sub`（扩展名大小写不敏感），服务端解码后统一转 UTF-8 srt，返回 `application/x-subrip; charset=utf-8`，`Content-Length` 为转换后字节数。不支持的扩展名返回 415，无法解析返回 422 `{error}`。

`GET/HEAD /api/embedded-subtitle?path=&expires=&sig=` 只读取 `data/cache/embedded-subtitles` 内的 `.srt`（5 MB 上限、UTF-8），使用与 `/media` 相同的 HMAC 签名或控制台令牌。

`GET/HEAD /api/embedded-media?path=&expires=&sig=&subtitles=0` 只读取同目录内去字幕副本（`.mp4`/`.m4v`/`.mkv`），支持 Range/206/Accept-Ranges；带 `getCaptionInfo.sec` 请求头且未带 `subtitles=0` 时，按 `<stem>.nosubs.<ext>` 对应 `<stem>.srt` 返回 `CaptionInfo.sec`。

## 流媒体

电视端播放器 HTTP 直拉 `http://<中枢IP>:9420/media/...`，中枢必须支持 Range 请求（拖进度依赖它）。

`/media` 只接受带 `expires` 与 `sig` 的 HMAC 签名 URL（默认 24 小时有效），或控制台令牌；签名 URL 由中枢在 `cast` 时基于 `PUBLIC_BASE_URL` 生成。`PUBLIC_BASE_URL` 未显式配置时，中枢自动探测非回环局域网 IPv4；`MEDIA_BASE` 日志行会打印实际使用的基址。
