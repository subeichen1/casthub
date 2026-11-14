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
| 中枢→控制台 | devices | {list: [{id, address, online}]} |
| 中枢→控制台 | tvStatus | {deviceId, state, positionMs, durationMs} |
| 中枢→控制台 | error | {message} |

## REST

`GET /api/files?path=` → `{entries: [{name, path, isDir, size, mimeType}]}`

## 流媒体

电视端播放器 HTTP 直拉 `http://<中枢IP>:9420/media/...`，中枢必须支持 Range 请求（拖进度依赖它）。
播放地址默认由控制台连接的 Host 头推导（如 `http://192.168.1.5:9420`），环境变量 `PUBLIC_BASE_URL` 可覆盖。
