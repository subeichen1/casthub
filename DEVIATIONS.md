# DEVIATIONS

记录对锁定决策 / 依赖白名单的偏离（均不影响功能行为）。

## 依赖白名单补充：TypeScript 类型声明

- 增加 `@types/node`、`@types/ws`（devDependencies）。
- 原因：server 使用 TypeScript 编写，Node 内置模块与 ws 库需要类型声明才能通过 `tsc` 编译检查；二者仅为编译期类型包，不引入任何运行时依赖。

## 依赖白名单补充：fast-xml-parser

- 增加 `fast-xml-parser@^4`（dependencies）。
- 原因：DLNA 兼容模式需要解析带命名空间的 SOAP/XML 响应（GetTransportInfo、GetPositionInfo 等）。按本地名解析 XML 用正则手写易错且难维护，`fast-xml-parser` 是本项目唯一新增的运行时依赖，仅作用于 server 的 DLNA 降级路径，不影响主线 TV App。
- 影响：不改变锁定协议与 UI，无额外服务或配置。

## Phase 9 — better-sqlite3 不可用时的 JSON 降级

- 锁定决策 2 允许在 `better-sqlite3` 安装失败（编译失败/无预编译产物）时以 JSON 文件实现顶上；本机 `npm.cmd install better-sqlite3@^11 --save` 因缺少 Visual Studio C++ 工具链且预编译下载 `ECONNRESET` 失败。
- 已实现 `data/casthub-history.json` 整表读写作为唯一降级实现；`HistoryStore` 接口、协议、e2e、控制台 UI 均不变，未引入第三种实现。
- `server/package.json` 使用 `optionalDependencies` 声明 `better-sqlite3@^11.10.0`，使安装失败不阻塞 `npm install`，并让具备构建工具的人类机器自然启用 SQLite。

## Phase 10 — e2e-dlna 只选择 fake 设备的测试基线修正

- 前置检查时 `node scripts/e2e-dlna.mjs` 失败：SSDP 同时发现真实电视（TCL）与 fake-dlna，`waitDlnaDevice` 选中了真实电视，触发 `deviceName 与 device.xml friendlyName 不匹配`。这是测试环境干扰，不是产品缺陷。
- 修正 `server/scripts/e2e-dlna.mjs`：新增 `FAKE_DEVICE_NAME = "Fake DLNA TV"` 与 `isFakeDlnaDevice`，`waitDlnaDevice` 及两处设备查找仅匹配 fake 设备；生产代码零改动。
- 该修正合并在 `phase10A` commit 中：前置基线必须先修复才能执行 Phase 10A 门禁。
