# BLOCKERS / PENDING

记录无法在当前环境执行、需要人工补充验证的事项。

## Phase 1 — ffmpeg 生成测试片（pending）

- 环境检查：`ffmpeg -version` 不存在（CommandNotFoundException）。
- 因此无法按要求用 ffmpeg 生成 60 秒 720p 测试片。
- 替代措施：已下载公开示例 MP4（MDN `flower.mp4`，约 1.1 MB）保存为 `server/media/test.mp4`，用于 Phase 1 Range 门禁验证。
- 用户实际使用时：把自己的视频放入 `MEDIA_DIR`（默认 `server/media`）即可。

## Phase 3 — Android SDK / 模拟器验证（pending）

- 环境检查：`ANDROID_HOME` 与 `ANDROID_SDK_ROOT` 均为空；未找到 Android SDK、sdkmanager、emulator、AVD、JDK、Gradle（`java -version` 不存在）。
- 影响：APK 构建、`adb install`、模拟器端到端门禁无法在本机执行。
- 处理：tv-app 代码照常完整编写；README 附真机验证清单，用户可在具备 Android Studio 的机器上构建、安装并逐条验证。
- 附加问题：Gradle wrapper jar 下载失败（GitHub raw / jsDelivr 连接重置、gitee 404），`tv-app/gradlew` 与 `gradlew.bat` 未生成。用 Android Studio 打开工程时如提示 wrapper 缺失，可在本地安装 Gradle 8.2 后执行 `gradle wrapper`，或使用 Android Studio 自带的 Gradle。

## Phase 4 — 模拟器内 UI 全流程（pending）

- 环境检查：无 Android SDK / AVD，「Android TV (1080p)」模拟器不存在，无法在模拟器内点击控制台完成投屏链路。
- 替代验证：已用桌面浏览器打开控制台，配合 `fake-tv.mjs` 走通「添加设备 → 浏览 → 投屏 → 暂停 → 拖进度 → 恢复」；WS 层同一流程由 `server/scripts/e2e.mjs` 自动断言。
- 待人工：在具备 Android Studio + Android TV AVD 的机器上按 README「真机验证清单」补跑模拟器路径。
