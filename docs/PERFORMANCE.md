# CastHub 性能基线

本文件记录可复现的本地性能冒烟基线。它不是容量承诺；升级 Node、Fastify 或修改文件服务后应重跑并对比。

## 复现方式

```powershell
cd server
node scripts/perf-smoke.mjs
# 可选：PERF_PORT=19420 PERF_ITERATIONS=500 node scripts/perf-smoke.mjs
```

脚本会在临时目录创建 5 MiB 媒体文件，启动真实中枢（`tsx src/index.ts`），预热 20 次后测量：

- `/api/files?path=`（带控制台令牌）200 次顺序请求；
- `/media/sample.mp4` 的 64 KiB Range 请求（带令牌）200 次；
- 50 个文件列表请求的并发突发。

## 2026-11-14 基线

| 项目 | 结果 |
| --- | --- |
| 机器 | Windows 本机，Node v24.20.0 |
| 文件列表 p50 / p95 / max | 15.46 / 16.61 / 18.68 ms |
| 64 KiB Range p50 / p95 / max | 15.38 / 17.53 / 20.94 ms |
| 50 并发文件列表总耗时 | 38.73 ms |

以上为 2026-11-14 23:46 的单次测量；本机负载、杀毒扫描和后台构建会明显影响 50 并发数值，比较时应使用同一机器、同一时段重复运行。

## 判读建议

- 文件列表 p95 超过 100 ms 或并发 50 总耗时超过 1 s 时，先检查 `MEDIA_DIR` 所在磁盘、杀毒软件扫描和日志级别。
- 64 KiB Range p95 超过 100 ms 时，检查磁盘读取、Range 解析和 MIME 类型判断。
- 此基线只覆盖单机回环 HTTP，不覆盖 Wi-Fi 吞吐、Android TV 解码、DLNA 轮询和长时间运行内存增长；这些项目需要在真实局域网和真机上另行验证（见 `BLOCKERS.md`）。
