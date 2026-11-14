# CastHub GitHub 发布手册

> **发布状态（2026-11-14）**：已通过已登录 GitHub 的浏览器完成实际发布 —— <https://github.com/subeichen1/casthub>，发布时 main HEAD `80b8961`，GitHub Actions “CI” 首轮 `success`。**该历史 Release 的 `app-debug.apk` 是未签名调试包，已不符合当前发布基线；请使用 `.github/workflows/release.yml` 重新构建并发布已签名的 `CastHub-TV.apk`。** 本文保留为发布流程参考。
>
> **v0.1.1 状态（2026-11-15）**：已使用开发自签名证书和开发 release keystore 完成正式构建。Release workflow run `43617653552` 的 windows / android / source / publish 四个 job 全部 `success`；Release <https://github.com/subeichen1/casthub/releases/tag/v0.1.1> 已发布 `CastHub.exe`、`CastHub-TV.apk`、`casthub-src.tar.gz` 与 `checksums.txt`。开发签名可能触发 Windows“未知发布者”提示，生产分发需替换正式证书。
>
> 适用场景：本机没有安装 GitHub CLI（`gh`），或 `gh` 未登录 GitHub。本文按"网页建仓 + Git 命令行推送"的手工路径写成；仓库本身已经整理完毕（分支 `main`、历史保留、构建产物已排除出 git），照着做即可发布。
>
> 仓库位置：`C:\Users\18460\Desktop\项目\桌面美化复刻\casthub-mvp`

## 1. 准备

### 1.1 注册 GitHub 账号

打开 <https://github.com>，点 **Sign up** 注册账号（已有账号则直接登录）。记住你的用户名，下面命令里的 `<你的用户名>` 都要替换成它。

### 1.2 安装 Git（Windows）

打开 <https://git-scm.com/download/win> 下载并安装 Git for Windows，安装时保持默认选项即可。安装完成后新开一个 PowerShell 窗口验证：

```powershell
git --version
```

### 1.3 替换 LICENSE 里的版权占位符

仓库根目录的 `LICENSE` 目前是：

```
Copyright (c) 2026 <你的GitHub用户名>
```

把 `<你的GitHub用户名>` 替换成你的 GitHub 用户名，例如：

```
Copyright (c) 2026 octocat
```

保存后建议顺手配置本仓库提交身份（可选，见第 6 节隐私提示）：

```powershell
cd "C:\Users\18460\Desktop\项目\桌面美化复刻\casthub-mvp"
git config user.name "你的名字"
git config user.email "你的邮箱"
```

## 2. 在 GitHub 网页创建空仓库

1. 登录 GitHub，点右上角 **+** → **New repository**。
2. **Repository name** 填 `casthub`。
3. **Description** 可填：`局域网投屏工具：PC 上的 Node.js 中枢 + Android TV 客户端 + 浏览器控制台`。
4. **Visibility** 按你的意愿选择 **Public** 或 **Private**（两者都支持 Release；Public 仓库的 Actions 分钟数不受私有仓库配额限制）。
5. **关键：三个初始化选项全部不要勾选**——
   - 不要勾 **Add a README file**
   - 不要勾 **Add .gitignore**
   - 不要勾 **Choose a license**
6. 点 **Create repository**。

> 为什么都不勾：本地仓库已经有 README、.gitignore 和 LICENSE。如果网页仓库先自动生成这些文件，远程会多出一个初始提交，首次 `git push` 会被拒绝（non-fast-forward），需要额外处理。

## 3. 推送本地仓库

在仓库根目录打开 PowerShell，依次执行（把 `<你的用户名>` 换成你的 GitHub 用户名）：

```powershell
cd "C:\Users\18460\Desktop\项目\桌面美化复刻\casthub-mvp"
git branch -M main
git remote add origin https://github.com/<你的用户名>/casthub.git
git push -u origin main
```

说明：

- 如果 `git remote add` 提示 `origin` 已存在，改用 `git remote set-url origin https://github.com/<你的用户名>/casthub.git`。
- Windows 版 Git 首次推送通常会弹出浏览器窗口，让你登录 GitHub 并授权（Git Credential Manager），按提示完成即可。
- 如果使用 **Personal Access Token（PAT）**：GitHub 网页右上角头像 → **Settings** → **Developer settings** → **Personal access tokens** → **Tokens (classic)** → **Generate new token**，勾选 `repo` 权限；推送时用户名填 GitHub 用户名，密码粘贴 PAT。
- GitHub 自 **2021-08-13** 起不再接受账号密码做 Git 操作；如果提示要密码，请使用 PAT 或浏览器授权，不要输入账号密码。
- 如果 `push` 返回 **403**，一般是认证方式不对或无仓库写权限，不是账号密码问题。

推送成功后验证：

```powershell
git remote -v
git log origin/main -1 --oneline
```

## 4. 收尾设置

1. 打开仓库主页，点右侧 **About** 旁的齿轮：
   - **Description** 填：`局域网投屏工具：PC 上的 Node.js 中枢 + Android TV 客户端 + 浏览器控制台`
   - **Topics** 依次添加：`dlna`、`casting`、`android-tv`、`media-server`、`local-network`
2. 点仓库顶部 **Actions** 标签，确认 `CI` 工作流已被推送触发。
   - 首次云端运行需要人工在本机推送后到 Actions 页面观察，本地无法预演。
   - CI 在 Ubuntu 上跑两条 e2e：`node scripts/e2e.mjs` 与 `node scripts/e2e-dlna.mjs`。
   - GitHub Actions 的容器网络通常限制多播，`e2e-dlna.mjs` 在 8 秒内发现不到 DLNA 设备时会自动改用 `DLNA_SEED` 重启中枢（脚本 `server/scripts/e2e-dlna.mjs` 第 201–214 行的降级分支），不会硬失败。若 CI 仍失败，请点进具体 job 查看日志。

## 5. 创建 v0.1.1 Release（由 Release workflow 自动构建）

构建产物不进入 git 仓库（`.gitignore` 已排除 `*.exe`、`*.apk`、`server/release/` 等），请通过 GitHub Release 分发。

1. 仓库主页右侧 **Releases** → **Create a new release**。
2. **Choose a tag** 填 `v0.1.1`，Target 选 `main`，Release title 填 `CastHub v0.1.1`。
3. 推荐由 `.github/workflows/release.yml` 在推送 `v*` 标签时自动构建并上传以下文件（拖拽到 **Attach binaries** 区域仅用于手工兜底）：
   - `CastHub.exe`（Windows 桌面版，需 Authenticode 签名）
   - `CastHub-TV.apk`（Android TV 安装包，需 release keystore 签名；构建产物原始路径为 `tv-app/app/build/outputs/apk/release/app-release.apk`）
   - `casthub-src.tar.gz` 与 `checksums.txt`（SHA-256 校验和）

   > 历史 `v0.1.0` 附件中的 `app-debug.apk` 是未签名调试包，禁止继续分发。
4. 可附发布说明，例如：

   ```markdown
   CastHub v0.1.1 — 安全与可靠性修复
   - 修复 29 项安全问题与可靠性问题
   - 控制台令牌与媒体签名 URL、DLNA 安全校验
   - Android TV 8 位配对码与 release 签名流程
   - Windows 桌面版（portable，正式包由 CI 签名）
   ```

5. 点 **Publish release**。

## 6. 隐私提示

如果不想公开真实邮箱，建议使用 GitHub 提供的 noreply 邮箱：

1. GitHub 网页右上角头像 → **Settings** → **Emails**，勾选 **Keep my email addresses private**。
2. 在 **Emails** 页面找到形如 `12345678+你的用户名@users.noreply.github.com` 的地址。
3. 在本仓库设置提交身份：

```powershell
cd "C:\Users\18460\Desktop\项目\桌面美化复刻\casthub-mvp"
git config user.name "你的GitHub用户名"
git config user.email "12345678+你的用户名@users.noreply.github.com"
```

> 现有历史提交的作者是占位身份 `CastHub Dev <dev@casthub.local>`，不含真实姓名和邮箱。若之后要改历史作者需要重写提交哈希，不建议在发布后操作。
