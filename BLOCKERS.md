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
