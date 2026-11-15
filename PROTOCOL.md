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
| 控制台→中枢 | cast | {deviceId, path, resume?, subtitles?}（resume 默认 true，见续播规则；subtitles 默认 true，仅 DLNA 生效） |
| 控制台→中枢 | control | {deviceId, action: pause\|resume\|stop\|seek\|volume, positionMs?, value?}（volume 时 value 为 0-100 整数） |
| 控制台→中枢 | refreshDevices | {}（立即重扫 DLNA 设备并广播最新 devices） |
| 控制台→中枢 | getHistory | {} |
| 控制台→中枢 | deleteHistory | {path} |
| 控制台→中枢 | clearHistory | {} |
| 中枢→控制台 | devices | {list: [{id, address, online, type: "casthub"\|"dlna", deviceName, volume?}]}（DLNA 音量 0-100；null/缺省表示不支持） |
| 中枢→控制台 | tvStatus | {deviceId, state, positionMs, durationMs, volume?}（历史由中枢内部消费） |
| 中枢→控制台 | history | {list: [{path, name, positionMs, durationMs, updatedAt, playCount, lastDeviceId}]}（updatedAt 倒序，最多 200 条） |
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
- 字幕：`cast` 的 `subtitles` 缺省为 true；中枢扫描视频同目录及 `Subs/`、`subtitles/`、`sub/` 一级子目录中的 `.srt`/`.vtt`/`.ass`/`.ssa`/`.smi`/`.sub`，按精确同名 > 同名子目录 > 语言偏好 > 格式顺序 > 路径字典序选出一条（单次播放最多输出一条）。DIDL-Lite 按设备的 `subtitleProfile` 输出：Samsung 仅一个 `sec:CaptionInfoEx`（`sec:type="srt"`）；Panasonic 仅在视频 `<res>` 上加 `pv:subtitleFileUri` 与 `pv:subtitleFileType="SRT"`；LG/Generic 仅一个 `protocolInfo="http-get:*:text/srt:*"` 的额外 `<res>`；Sony 不输出任何字幕标记。`/media` 的 GET/HEAD 仅在请求带 `getCaptionInfo.sec` 头（不限大小写）时返回 `CaptionInfo.sec: <完整URL>`，`subtitles=false` 时 DIDL 与响应头均不出现字幕。字幕 URL 指向 `/api/subtitle`，由服务端解码并统一转 UTF-8 srt 后以 `application/x-subrip; charset=utf-8` 下发。
- 字幕扫描与 profile 判定：语言后缀 allowlist 包括 `zh`、`zh-CN`、`zh-Hans`、`zh-Hant`、`chs`、`cht`、`chi`、`en`、`eng`、`ja`、`jpn`、`ko`、`kor` 等，支持 `forced`/`sdh` 等修饰词；`subtitleProfile` 在 manufacturer 非空时按 manufacturer 匹配 `samsung` / `panasonic|matsushita` / `lg|webos` / `sony`，否则为 `generic`，manufacturer 为空时才依次回退 modelName、modelNumber、friendlyName（均 trim + 小写）。
- 测试降级：环境变量 `DLNA_SEED`（逗号分隔的 `device.xml` URL）可跳过 SSDP 直接注入设备，用于 AP 隔离网络或沙箱多播不可达场景。

## REST

`GET /api/files?path=&limit=&offset=` 需要 `x-casthub-token` 或 `?token=`，返回 `{entries: [{name, path, isDir, size, mimeType}], total, offset, limit, hasMore}`；`limit` 默认 200、最大 500。符号链接条目不会出现在列表中。

`GET /api/subtitle?path=&expires=&sig=`（也支持 HEAD）使用与 `/media` 相同的 HMAC 签名或控制台令牌；支持 `.srt`、`.vtt`、`.ass`、`.ssa`、`.smi`、`.sub`（扩展名大小写不敏感），服务端解码后统一转 UTF-8 srt，返回 `application/x-subrip; charset=utf-8`，`Content-Length` 为转换后字节数。不支持的扩展名返回 415，无法解析返回 422 `{error}`。

## 流媒体

电视端播放器 HTTP 直拉 `http://<中枢IP>:9420/media/...`，中枢必须支持 Range 请求（拖进度依赖它）。

`/media` 只接受带 `expires` 与 `sig` 的 HMAC 签名 URL（默认 24 小时有效），或控制台令牌；签名 URL 由中枢在 `cast` 时基于 `PUBLIC_BASE_URL` 生成。`PUBLIC_BASE_URL` 未显式配置时，中枢自动探测非回环局域网 IPv4；`MEDIA_BASE` 日志行会打印实际使用的基址。
