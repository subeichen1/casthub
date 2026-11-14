# BLOCKERS / PENDING

记录无法在当前环境执行、需要人工补充验证的事项。

## Phase 1 — ffmpeg 生成测试片（pending）

- 环境检查：`ffmpeg -version` 不存在（CommandNotFoundException）。
- 因此无法按要求用 ffmpeg 生成 60 秒 720p 测试片。
- 替代措施：已下载公开示例 MP4（MDN `flower.mp4`，约 1.1 MB）保存为 `server/media/test.mp4`，用于 Phase 1 Range 门禁验证。
- 用户实际使用时：把自己的视频放入 `MEDIA_DIR`（默认 `server/media`）即可。

## Phase 3 — Android 构建（历史已解决）与模拟器验证（pending）

> **状态更新（2026-11-14 安全修复后）**：本机已使用独立工具链（JDK 17.0.21、Android SDK 34，见下）重新执行 `assembleDebug` / `assembleRelease`，均 BUILD SUCCESSFUL；最新 debug APK 6,493,060 字节、release unsigned APK 1,765,542 字节。`app-debug.apk` 仍只用于本地调试，正式包由 `.github/workflows/release.yml` 使用 release keystore 签名。模拟器/真机运行验证仍 pending。

- 初始环境：`ANDROID_HOME` 与 `ANDROID_SDK_ROOT` 为空，无 JDK / Gradle / SDK / AVD。
- 已补齐本地工具链：JDK 17.0.21（Temurin）、Gradle 8.2、Android SDK Platform 34、Build-Tools 34.0.0；仅用于本机验证，不随仓库交付。
- 构建结果：`gradle --no-daemon assembleDebug` → **BUILD SUCCESSFUL in 2m 5s**（33 actionable tasks）。
- APK 已复制回交付路径：`tv-app/app/build/outputs/apk/debug/app-debug.apk`，6,437,094 字节，SHA-256 `87816EA91C276A63164A19E66A0676B60F95174C85AC26E16CA9A8689FBD0183`。
- Gradle wrapper 已生成：`tv-app/gradlew`、`gradlew.bat`、`gradle/wrapper/gradle-wrapper.jar`；`distributionUrl` 指向腾讯镜像 `https://mirrors.cloud.tencent.com/gradle/gradle-8.2-bin.zip`（当前网络访问 services.gradle.org 会重定向到 GitHub 并超时）。
- 模拟器：已创建 AVD `Android_TV_1080p`（设备 tv_1080p，Android 14 / API 34，x86）。本机未安装 Android Emulator Hypervisor Driver（`emulator -accel-check` 原文：Android Emulator hypervisor driver is not installed on this machine），且当前账户无管理员权限，无法安装驱动；改用 `-accel off` 软件模拟启动后 `emulator-5554` 长期 offline，qemu 进程 CPU 为 0，AVD 无法完成启动。故 `adb install`、`WS_LISTENING`、helloAck、`STATE playing` 四项模拟器门禁 pending。

## Phase 4 — 模拟器内 UI 全流程（pending）

- 当前状态：SDK 与 AVD 已就绪，但模拟器因无硬件加速无法启动（见 Phase 3 条），无法在模拟器内点击控制台完成投屏链路。
- 替代验证：已用桌面浏览器打开控制台，配合 `fake-tv.mjs` 走通「添加设备 → 浏览 → 投屏 → 暂停 → 拖进度 → 恢复」；WS 层同一流程由 `server/scripts/e2e.mjs` 自动断言。
- 待人工：在具备硬件加速的 Android Studio + Android TV AVD 或真机上按 README「真机 / 模拟器验证清单」补跑模拟器路径。

## Phase 8D — GitHub 推送（已完成，2026-11-14）

- 初始环境未安装 GitHub CLI（`gh --version` 与 `gh auth status` 均为 `CommandNotFoundException`），也没有命令行 GitHub 凭据；实际改用已登录 GitHub 的 Edge 浏览器 + Git Credential Manager 完成发布。
- 仓库：<https://github.com/subeichen1/casthub>（Public），发布时 main HEAD `80b89618f7a024440d46d9d7931a44a09c8711cf`（`80b8961 phase8E: LICENSE 版权人信息`；后续文档提交会推进 main）。
- CI：GitHub Actions workflow “CI” 第 1 次运行（run id `43594983377`）状态 `completed`、结论 `success`。
- Release：`v0.1.0`（release id `445283603`），已上传 `CastHub.exe`（70,267,632 字节）与 `app-debug.apk`（6,437,094 字节）。
- `PUBLISH.md` 保留为发布流程参考。

## Phase 8K — v0.1.1 正式 Release（blocked，2026-11-15）

- 代码修复已完成并推送：main HEAD `9c4b7b70dedb453d5a30ab9ca4754e5f6592a7dd`（`fix: complete CastHub security and reliability remediation (v0.1.1)`）。
- GitHub Actions CI run #8（id `43615304471`）针对该提交完成，结论 `success`。
- 本地回归（2026-11-14）：typecheck / lint / build / npm audit / e2e 10/10 / e2e-dlna 9/9 / perf smoke 全部通过；详见 `REPORT.md` 与 `.dsh-pilot` 日志。
- 发布阻塞：仓库 Actions secrets 数量为 0；本机未找到 `.pfx` / `.p12` / `.jks` / `.keystore` 或代码签名证书。`.github/workflows/release.yml` 会在缺少 `WINDOWS_CERT_PFX_BASE64` / `CASTHUB_KEYSTORE_BASE64` 时主动失败，属于预期保护。
- 待人工提供：Windows PFX 与密码、Android release keystore 与密码/alias；配置 6 个 Secrets 后创建并推送 `v0.1.1` tag，验收 windows / android / source / publish jobs。
- 未上传本地 unsigned `server/release/CastHub.exe` 或 debug APK 作为 Release 资产。
