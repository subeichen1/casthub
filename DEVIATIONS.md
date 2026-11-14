# DEVIATIONS

记录对锁定决策 / 依赖白名单的偏离（均不影响功能行为）。

## 依赖白名单补充：TypeScript 类型声明

- 增加 `@types/node`、`@types/ws`（devDependencies）。
- 原因：server 使用 TypeScript 编写，Node 内置模块与 ws 库需要类型声明才能通过 `tsc` 编译检查；二者仅为编译期类型包，不引入任何运行时依赖。

## 依赖白名单补充：fast-xml-parser

- 增加 `fast-xml-parser@^4`（dependencies）。
- 原因：DLNA 兼容模式需要解析带命名空间的 SOAP/XML 响应（GetTransportInfo、GetPositionInfo 等）。按本地名解析 XML 用正则手写易错且难维护，`fast-xml-parser` 是本项目唯一新增的运行时依赖，仅作用于 server 的 DLNA 降级路径，不影响主线 TV App。
- 影响：不改变锁定协议与 UI，无额外服务或配置。
