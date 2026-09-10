#!/usr/bin/env bash
# SciHub 自动同步：提交工作区改动并推送到 GitHub。
#
# 为什么需要这个脚本：
#   本机 WSL 是 NAT 网络模式，直连 github.com 不通（Windows 上配的 localhost 代理
#   不会被镜像进 WSL），推送必须借道「Windows 宿主 IP + 代理端口」。
#   脚本会自动探测宿主 IP 与可用代理端口，所以 WSL 重启后 IP 变化也不用改配置。
#
# 用法：
#   bash tools/sync.sh "feat: 你的提交说明"
#   bash tools/sync.sh                  # 使用默认说明
#
# 安全：GitHub 凭据取自本机已登录的 GitHub CLI，写入 mktemp 临时目录，
#      脚本退出（含异常）时由 trap 删除；token 不落盘、不进仓库。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GH="/mnt/c/Program Files/GitHub CLI/gh.exe"
BRANCH="master"

cd "$REPO"

# ── 1. 探测可用的宿主代理 ────────────────────────────────────
HOST_IP="$(ip route show default | awk '{print $3}' | head -1)"
PROXY=""
for port in 7897 7890 7891 10809 10808 1080; do
  if curl -s -o /dev/null --max-time 4 -x "http://${HOST_IP}:${port}" https://github.com; then
    PROXY="http://${HOST_IP}:${port}"
    break
  fi
done

if [ -z "$PROXY" ]; then
  echo "找不到可用的 GitHub 代理（宿主 ${HOST_IP}）。请确认 Windows 上的代理软件正在运行。" >&2
  exit 1
fi
echo "代理：$PROXY"

# ── 2. 提交本地改动 ──────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "${1:-chore: 自动同步}"
  echo "已提交：$(git log --oneline -1)"
else
  echo "工作区干净，跳过提交。"
fi

# ── 3. 用 GitHub CLI 的 token 生成一次性凭据 ──────────────────
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
umask 077
"$GH" auth token > "$TMP/token"
printf 'https://x-access-token:' > "$TMP/cred"
tr -d '\r\n' < "$TMP/token" >> "$TMP/cred"
printf '@github.com\n' >> "$TMP/cred"
chmod 600 "$TMP/cred"

# ── 4. 推送 ─────────────────────────────────────────────────
GIT_TERMINAL_PROMPT=0 git \
  -c credential.helper="store --file=$TMP/cred" \
  -c http.proxy="$PROXY" \
  -c https.proxy="$PROXY" \
  push origin "$BRANCH"

echo "推送完成。当前状态："
git status --short --branch
