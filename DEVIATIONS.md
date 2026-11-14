# DEVIATIONS

记录对锁定决策 / 依赖白名单的偏离（均不影响功能行为）。

## 依赖白名单补充：TypeScript 类型声明

- 增加 `@types/node`、`@types/ws`（devDependencies）。
- 原因：server 使用 TypeScript 编写，Node 内置模块与 ws 库需要类型声明才能通过 `tsc` 编译检查；二者仅为编译期类型包，不引入任何运行时依赖。
