#!/usr/bin/env bash
set -euo pipefail

# CastHub Linux / macOS 一键部署脚本
# 用法：curl -fsSL https://github.com/subeichen1/casthub/releases/latest/download/install.sh | bash
# 可选环境变量：
#   CASTHUB_DIR           安装目录，默认 ~/.local/share/casthub
#   CASTHUB_MEDIA_DIR     媒体目录，默认 ~/Videos/CastHub
#   CASTHUB_PORT          服务端口，默认 9420
#   CASTHUB_NO_LAUNCH     设为 1 时安装完成后不启动
#   CASTHUB_DAEMON        设为 1 时后台启动并写入日志
#   CASTHUB_ARCHIVE_URL   源码包地址，默认最新 Release 的 casthub-src.tar.gz
#   CASTHUB_SHA256        源码包 SHA-256；不设置时尝试从 checksums.txt 读取
#   CASTHUB_ALLOW_UNVERIFIED 设为 1 时允许跳过源码包校验（不推荐）

REPO_OWNER="${CASTHUB_REPO_OWNER:-subeichen1}"
REPO_NAME="${CASTHUB_REPO_NAME:-casthub}"
INSTALL_DIR="${CASTHUB_DIR:-$HOME/.local/share/casthub}"
MEDIA_DIR="${CASTHUB_MEDIA_DIR:-$HOME/Videos/CastHub}"
PORT="${CASTHUB_PORT:-9420}"
ARCHIVE_URL="${CASTHUB_ARCHIVE_URL:-https://github.com/$REPO_OWNER/$REPO_NAME/releases/latest/download/casthub-src.tar.gz}"
CHECKSUM_URL="${CASTHUB_CHECKSUM_URL:-https://github.com/$REPO_OWNER/$REPO_NAME/releases/latest/download/checksums.txt}"
ARCHIVE_NAME="casthub-src.tar.gz"

log() { printf '==> %s\n' "$*"; }
warn() { printf '警告：%s\n' "$*" >&2; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        die '未找到 sha256sum 或 shasum，无法校验下载内容。'
    fi
}

case "$(uname -s)" in
    Darwin|Linux) ;;
    *) die '此脚本用于 macOS / Linux；Windows 请使用 scripts/install.ps1。' ;;
esac

command -v node >/dev/null 2>&1 || die '未找到 Node.js，请先安装 Node.js 20+：https://nodejs.org/'
command -v npm >/dev/null 2>&1 || die '未找到 npm，请重新安装 Node.js 20+。'
command -v curl >/dev/null 2>&1 || die '未找到 curl。'
command -v tar >/dev/null 2>&1 || die '未找到 tar。'

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
    die "当前 Node.js 版本为 $(node -v)，CastHub 需要 Node.js 20 或更高版本。"
fi

mkdir -p "$INSTALL_DIR" "$MEDIA_DIR"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/casthub-install.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

APP_DIR="$INSTALL_DIR/app"
SOURCE_DIR="${CASTHUB_SOURCE_DIR:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"

if [ -z "$SOURCE_DIR" ] && [ -f "$SCRIPT_DIR/../server/package.json" ] && [ -d "$SCRIPT_DIR/../.git" ]; then
    SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

if [ -n "$SOURCE_DIR" ]; then
    log "使用本地源码：$SOURCE_DIR"
    rm -rf "$APP_DIR"
    mkdir -p "$APP_DIR"
    (cd "$SOURCE_DIR" && tar -cf - --exclude=.git --exclude=server/node_modules --exclude=server/dist --exclude=server/release --exclude=server/media --exclude=tv-app/app/build --exclude=.dsh-pilot .) | (cd "$APP_DIR" && tar -xf -)
else
    log "下载 CastHub 源码：$ARCHIVE_URL"
    curl -fsSL "$ARCHIVE_URL" -o "$TMP_DIR/$ARCHIVE_NAME"

    EXPECTED_SHA256="${CASTHUB_SHA256:-}"
    if [ -z "$EXPECTED_SHA256" ]; then
        if curl -fsSL "$CHECKSUM_URL" -o "$TMP_DIR/checksums.txt" 2>/dev/null; then
            EXPECTED_SHA256="$(awk -v name="$ARCHIVE_NAME" '$2 == name { print tolower($1); exit }' "$TMP_DIR/checksums.txt")"
        else
            warn '无法下载 checksums.txt。'
        fi
    fi

    if [ -z "$EXPECTED_SHA256" ]; then
        if [ "${CASTHUB_ALLOW_UNVERIFIED:-0}" = "1" ]; then
            warn '未校验源码包哈希（CASTHUB_ALLOW_UNVERIFIED=1）。'
        else
            die '无法取得源码包 SHA-256。请设置 CASTHUB_SHA256，或在明确了解风险时设置 CASTHUB_ALLOW_UNVERIFIED=1。'
        fi
    else
        ACTUAL_SHA256="$(sha256_file "$TMP_DIR/$ARCHIVE_NAME")"
        if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
            die "源码包校验失败：期望 $EXPECTED_SHA256，实际 $ACTUAL_SHA256"
        fi
        log "源码包 SHA-256 校验通过：$ACTUAL_SHA256"
    fi

    mkdir -p "$TMP_DIR/src"
    tar -xzf "$TMP_DIR/$ARCHIVE_NAME" -C "$TMP_DIR/src"
    SRC_DIR="$(find "$TMP_DIR/src" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
    [ -n "$SRC_DIR" ] || die '下载的源码包为空。'
    rm -rf "$APP_DIR"
    mkdir -p "$APP_DIR"
    (cd "$SRC_DIR" && tar -cf - .) | (cd "$APP_DIR" && tar -xf -)
fi

SERVER_DIR="$APP_DIR/server"
[ -f "$SERVER_DIR/package.json" ] || die '源码中缺少 server/package.json。'

log '安装服务端依赖（Electron 二进制会跳过下载）...'
cd "$SERVER_DIR"
if [ -f package-lock.json ]; then
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
else
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --no-audit --no-fund
fi

log '编译 TypeScript ...'
npm run build

CONFIG_PATH="$INSTALL_DIR/config.json"
cat > "$CONFIG_PATH" <<EOF
{
  "mediaDir": "$MEDIA_DIR"
}
EOF

START_SCRIPT="$INSTALL_DIR/start-casthub.sh"
cat > "$START_SCRIPT" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$SERVER_DIR"
export CASTHUB_CONFIG_DIR="$INSTALL_DIR"
export PORT="$PORT"
exec node dist/index.js
EOF
chmod +x "$START_SCRIPT"

log "安装完成：$APP_DIR"
log "媒体目录：$MEDIA_DIR"
log "启动命令：$START_SCRIPT"

if [ "${CASTHUB_NO_LAUNCH:-0}" = "1" ]; then
    exit 0
fi

if [ "${CASTHUB_DAEMON:-0}" = "1" ]; then
    nohup "$START_SCRIPT" > "$INSTALL_DIR/casthub.log" 2>&1 &
    log "已在后台启动，日志：$INSTALL_DIR/casthub.log"
    exit 0
fi

log '启动 CastHub ...'
if command -v open >/dev/null 2>&1; then
    (sleep 1; open "http://127.0.0.1:$PORT" >/dev/null 2>&1 || true) &
elif command -v xdg-open >/dev/null 2>&1; then
    (sleep 1; xdg-open "http://127.0.0.1:$PORT" >/dev/null 2>&1 || true) &
fi
exec "$START_SCRIPT"
