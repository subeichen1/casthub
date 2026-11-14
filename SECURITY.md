# CastHub 安全模型与发布基线

本文件定义 CastHub 的信任边界、攻击者模型、隐私约定和安全验收标准。实现与测试应以此为准；发现偏差时按安全缺陷处理。

## 1. 适用范围

CastHub 是家庭局域网内的单用户投屏工具，不是公网服务，也不支持多租户。以下内容属于安全边界内：

- PC 中枢（HTTP + WebSocket，默认 9420）
- 浏览器控制台（同源静态页面）
- Android TV 客户端（WebSocket 服务端，默认 9417）
- DLNA/UPnP 降级控制点
- Windows 便携版、Android APK、安装脚本和发布产物

## 2. 资产与信任边界

| 资产 | 位置 | 保护目标 |
| --- | --- | --- |
| 媒体文件 | PC 的 `MEDIA_DIR` | 只允许已认证控制台或持签名 URL 的播放器读取；不得越出媒体根目录 |
| 控制面 | `/console`、`/api/files` | 只有持控制台令牌且来源合法的客户端可操作 |
| 控制台令牌 | `console-token.txt` 或 `config.json` | 不进入 URL 访问日志、不回显给未认证连接 |
| 电视配对 | Android TV 9417 | 8 位随机配对码，认证失败限速；状态只发给已认证连接 |
| 发布产物 | GitHub Release / 安装目录 | 来源可验证、完整性可校验、签名可追溯 |

信任边界：

1. **PC 本机**：Electron 壳和本地进程视为可信；但桌面壳加载的网页仍按不可信输入处理。
2. **家庭局域网**：默认不可信。任何同网段主机都可能发起扫描、连接、HTTP 请求或 SSDP 响应。
3. **电视端 App**：只信任持正确配对码的中枢；电视自身不存储媒体。
4. **外部互联网**：完全不可信；项目不主动上传媒体，不调用云端 API。
5. **DLNA 设备**：设备描述、SOAP 响应和 `device.xml` 均视为不可信输入。

## 3. 攻击者模型

考虑以下攻击者：

- 同网段但未认证的电脑/手机，可枚举端口、访问 `/console`、`/api/files`、`/media`。
- 恶意网页：受害者浏览器访问攻击者页面后，向 `http://<PC IP>:9420` 发起跨站 WebSocket/HTTP 请求。
- 恶意 DLNA/SSDP 响应者：伪造 `LOCATION`、`device.xml` 或 SOAP 响应，诱导中枢访问内网/回环地址。
- 被篡改的依赖、安装包或 Release 资产。
- 物理接触者：可读取安装目录、日志和 `console-token.txt`。

不考虑：拥有 PC 管理员权限的本机攻击者、公网直接暴露、侧信道、DRM 破解。

## 4. 安全目标

1. **控制面保密性**：未持令牌者不能读取文件列表、添加/移除设备、投屏或控制播放。
2. **媒体访问控制**：`/media` 只能读取 `MEDIA_DIR` 内的普通文件；符号链接/junction 不得越界。
3. **来源校验**：浏览器控制台 WebSocket 必须校验 `Origin`，降低跨站 WebSocket 劫持风险。
4. **电视配对安全**：配对码至少 8 位随机数字；认证失败有限速；未认证连接收不到设备状态。
5. **DLNA 输入安全**：只允许 http/https、无凭据、解析后位于同网段或私网的 URL；限制响应体大小和设备数量。
6. **可用性**：连接数、消息大小、设备数、轮询和日志均有上限。
7. **供应链完整性**：发布产物必须有签名或校验和；CI 使用锁文件、完整依赖审计（生产与开发）和 SBOM。

## 5. 已实施的控制

- 控制台：`CONSOLE_TOKEN`/`console-token.txt` 令牌、`Origin` 校验、连接数上限 32、消息上限 64 KiB、每连接 120 条/10 秒、认证失败 10 次/IP/60 秒封禁。
- 媒体：`/api/files` 需要令牌；`/media` 需要 HMAC-SHA256 签名 URL（`expires`+`sig`，默认 24 小时）或令牌；路径经 `realpath` 校验并拒绝符号链接。
- 电视：8 位 `SecureRandom` 配对码；`hello` 携带协议版本 1；认证失败限速；`sendStatus` 仅广播给已认证连接；播放 URL 仅允许 http/https。
- DLNA：SSDP `LOCATION` 与 SOAP URL 白名单（同网段/私网、禁止回环，测试可用 `DLNA_ALLOW_LOOPBACK=1`）；响应体上限 512 KiB；设备上限 64；5 分钟清理失效设备。
- 日志：服务端日志轮转 5 MiB × 3；桌面壳日志轮转 5 MiB × 1；签名媒体 URL 不写入日志。
- 发布：Windows Authenticode 与 Android release keystore 由 CI Secrets 注入；Release 生成 `checksums.txt`；CI 执行 `npm ci`、类型检查、完整依赖 `npm audit --audit-level=high` 和 CycloneDX SBOM。

## 6. 隐私说明

- 媒体文件只在 PC 与电视之间通过局域网传输，不上传云端。
- 服务端日志可能包含媒体相对路径、设备地址、连接时间和错误信息；日志保留在本地，默认不收集遥测。
- `console-token.txt` 属于敏感文件，权限应限制为当前用户；不要提交到 Git 或公开分享。
- Android 端不申请存储权限即可播放网络流；配对码只保存在电视内存，不写入日志。
- 卸载/删除安装目录会删除本地配置和日志；媒体目录不会被安装脚本删除。

## 7. 发布安全基线

发布前必须满足：

1. Windows `CastHub.exe` 通过 Authenticode 校验（`Get-AuthenticodeSignature` 为 `Valid`）。
2. Android APK 使用 release keystore 签名，禁止发布 `app-debug.apk`。
3. Release 附带 `checksums.txt`，安装脚本默认校验 SHA-256；无校验和时必须显式 `-AllowUnsigned` / `CASTHUB_ALLOW_UNVERIFIED=1`。
4. CI 的 `npm audit --audit-level=high` 通过；SBOM 作为构建产物保留。
5. Gradle wrapper 固定 `distributionSha256Sum`，禁止使用可变分支归档作为生产安装源。

## 8. 安全验收清单

- [ ] 未带令牌访问 `/console` 返回 1008，访问 `/api/files` 返回 401。
- [ ] 未带 `Origin` 或跨源 `Origin` 的 WebSocket 被拒绝。
- [ ] 直接访问未签名的 `/media/<file>` 返回 401；过期签名返回 401。
- [ ] 在 `MEDIA_DIR` 放置指向外部的 symlink/junction 后，列表不显示且直接访问被拒绝。
- [ ] 电视端错误配对码连续失败 10 次后被限速 60 秒。
- [ ] 未认证的 TV 连接收不到 `status` 广播。
- [ ] DLNA `LOCATION` 指向 `127.0.0.1`、`169.254.x.x` 或外部域名时被拒绝（测试模式除外）。
- [ ] `npm audit --audit-level=high` 无 high/critical（当前全量审计为 0 漏洞）。
- [ ] Release 页面包含 `checksums.txt`，且安装脚本能校验通过。
