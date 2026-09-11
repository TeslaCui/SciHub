#!/usr/bin/env bash
# SciHub 自动同步：提交工作区改动并推送到 GitHub。
#
# 环境兼容：
#   · Windows Git Bash / MSYS —— 直连 GitHub（走 Windows 网络栈），凭据交给
#     git 自己的配置（Git Credential Manager / gh）即可。
#   · WSL（NAT 模式）—— 直连 github.com 不通，脚本会自动探测
#     「Windows 宿主 IP + 代理端口」并借道推送，所以 WSL 重启后 IP 变化也不用改配置。
#
# 用法：
#   bash tools/sync.sh "feat: 你的提交说明"
#   bash tools/sync.sh                  # 使用默认说明
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="master"

cd "$REPO"

# ── 1. 先直连试；不通再找宿主代理（WSL 场景）────────────────
PROXY=""
if ! curl -s -o /dev/null --max-time 6 https://github.com; then
  HOST_IP="$(ip route show default 2>/dev/null | awk '{print $3}' | head -1 || true)"
  for port in 7897 7890 7891 10809 10808 1080; do
    if [ -n "$HOST_IP" ] && curl -s -o /dev/null --max-time 4 -x "http://${HOST_IP}:${port}" https://github.com; then
      PROXY="http://${HOST_IP}:${port}"
      break
    fi
  done

  if [ -z "$PROXY" ]; then
    echo "直连 github.com 不通，也没找到可用的宿主代理（宿主 IP：${HOST_IP:-未知}）。" >&2
    echo "请确认 Windows 上的代理软件正在运行，或改用 Git Bash 执行本脚本。" >&2
    exit 1
  fi
  echo "代理：$PROXY"
else
  echo "直连 GitHub"
fi

# ── 2. 提交本地改动 ─────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "${1:-chore: 自动同步}"
  echo "已提交：$(git log --oneline -1)"
else
  echo "工作区干净，跳过提交。"
fi

# ── 3. 推送 ─────────────────────────────────────────────────
if [ -n "$PROXY" ]; then
  GIT_TERMINAL_PROMPT=0 git -c "http.proxy=$PROXY" -c "https.proxy=$PROXY" push origin "$BRANCH"
else
  GIT_TERMINAL_PROMPT=0 git push origin "$BRANCH"
fi

echo "推送完成。当前状态："
git status --short --branch
