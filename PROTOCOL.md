# CastHub WS 协议规范

本文件是实现的唯一依据。两条 WS 通道相互独立，不合并。

## 通道 A：中枢 ↔ 电视（电视端为 WS 服务端，端口 9417，中枢为客户端）

连接建立后，中枢必须发送 hello；token 错误时电视端以 close code 4001 断开。

| 方向 | type | 载荷 |
|---|---|---|
| 中枢→电视 | hello | {token, clientId}（token 错误则电视以 close code 4001 断开） |
| 电视→中枢 | helloAck | {ok, deviceName} |
| 中枢→电视 | play | {url, title, mimeType} |
| 中枢→电视 | pause / resume / stop | {} |
| 中枢→电视 | seek | {positionMs} |
| 中枢→电视 | getStatus | {} |
| 电视→中枢 | status | {state: idle\|buffering\|playing\|paused\|error, positionMs, durationMs}（播放中每 1s 推送，状态变化立即推送） |
| 电视→中枢 | error | {code, message} |

## 通道 B：控制台 ↔ 中枢（9420，路径 /console）

| 方向 | type | 载荷 |
|---|---|---|
| 控制台→中枢 | addDevice | {address, token} |
| 控制台→中枢 | removeDevice | {id} |
| 控制台→中枢 | cast | {deviceId, path} |
| 控制台→中枢 | control | {deviceId, action: pause\|resume\|stop\|seek, positionMs?} |
| 控制台→中枢 | refreshDevices | {}（立即重扫 DLNA 设备并广播最新 devices） |
| 中枢→控制台 | devices | {list: [{id, address, online, type: "casthub"\|"dlna", deviceName}]} |
| 中枢→控制台 | tvStatus | {deviceId, state, positionMs, durationMs} |
| 中枢→控制台 | error | {message} |

## DLNA 兼容模式（降级，协议增量）

- 设备类型：`devices.list[].type` 为 `"casthub"`（电视 App）或 `"dlna"`（自动发现的 UPnP MediaRenderer）；`deviceName` 分别取 `helloAck.deviceName` 与 `device.xml` 的 `friendlyName`。
- 发现：中枢作为 UPnP 控制点，用 SSDP M-SEARCH（ST=`urn:schemas-upnp-org:device:MediaRenderer:1` 与 `ssdp:all`）发现设备，每 60s 重扫；控制台发送 `refreshDevices` 立即重扫。
- 设备身份：`device.xml` 的 `UDN` 即设备 id。`addDevice` / `removeDevice` 仅适用于 `casthub` 类型；对 `dlna` 设备返回 `error {message: "DLNA 设备为自动发现，不支持手动增删"}`。
- 投屏：`cast` 到 `dlna` 设备时，中枢调用 `SetAVTransportURI` → 500ms → `Play`；正在播放时先 `Stop`。`control` 的 pause/resume/stop/seek 分别映射为 `Pause`/`Play`/`Stop`/`Seek`（Seek 的 Target 为 `H:MM:SS` 字符串）。
- 状态：中枢每 1s 轮询 `GetTransportInfo` + `GetPositionInfo`，翻译成既有 `tvStatus` 消息。映射：`STOPPED`/`NO_MEDIA_PRESENT`→`idle`、`TRANSITIONING`→`buffering`、`PLAYING`→`playing`、`PAUSED_PLAYBACK`→`paused`。
- 测试降级：环境变量 `DLNA_SEED`（逗号分隔的 `device.xml` URL）可跳过 SSDP 直接注入设备，用于 AP 隔离网络或沙箱多播不可达场景。

## REST

`GET /api/files?path=` → `{entries: [{name, path, isDir, size, mimeType}]}`

## 流媒体

电视端播放器 HTTP 直拉 `http://<中枢IP>:9420/media/...`，中枢必须支持 Range 请求（拖进度依赖它）。
播放地址默认由控制台连接的 Host 头推导（如 `http://192.168.1.5:9420`），环境变量 `PUBLIC_BASE_URL` 可覆盖。
