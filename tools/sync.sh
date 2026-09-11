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

# ── 1. 先直连；不通再找代理 ─────────────────────────────────
# Git Bash / MSYS 走 Windows 网络栈，代理监听在本机 127.0.0.1；
# WSL 则要用 Windows 宿主 IP（NAT 网关）。两条都试。
PROXY=""
if ! curl -s -o /dev/null --max-time 6 https://github.com; then
  for port in 7897 7890 7891 10809 10808 1080; do
    if curl -s -o /dev/null --max-time 4 -x "http://127.0.0.1:${port}" https://github.com; then
      PROXY="http://127.0.0.1:${port}"
      break
    fi
  done

  if [ -z "$PROXY" ]; then
    HOST_IP="$(ip route show default 2>/dev/null | awk '{print $3}' | head -1 || true)"
    for port in 7897 7890 7891 10809 10808 1080; do
      if [ -n "$HOST_IP" ] && curl -s -o /dev/null --max-time 4 -x "http://${HOST_IP}:${port}" https://github.com; then
        PROXY="http://${HOST_IP}:${port}"
        break
      fi
    done
  fi

  if [ -z "$PROXY" ]; then
    echo "直连 github.com 不通，也没找到可用代理（本机 127.0.0.1 与宿主 ${HOST_IP:-未知} 都试过了）。" >&2
    echo "请确认 Windows 上的代理软件正在运行。" >&2
    exit 1
  fi
  echo "代理：$PROXY"
else
  echo "直连 GitHub"
fi

# ── 2. 有 node 就先做语法检查（没有则跳过）──────────────────
NODE_BIN=""
for candidate in node "/d/LeStoreDownload/Node.js/node.exe"; do
  if command -v "$candidate" >/dev/null 2>&1 || [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -n "$NODE_BIN" ]; then
  for js in app.js experiment.js sw.js; do
    if ! "$NODE_BIN" --check "$js"; then
      echo "语法检查失败：$js —— 已中止推送" >&2
      exit 1
    fi
  done
  echo "语法检查通过（app.js / experiment.js / sw.js）"
else
  echo "未找到 node，跳过语法检查"
fi

# ── 3. 提交本地改动 ─────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "${1:-chore: 自动同步}"
  echo "已提交：$(git log --oneline -1)"
else
  echo "工作区干净，跳过提交。"
fi

# ── 4. 推送 ─────────────────────────────────────────────────
if [ -n "$PROXY" ]; then
  GIT_TERMINAL_PROMPT=0 git -c "http.proxy=$PROXY" -c "https.proxy=$PROXY" push origin "$BRANCH"
else
  GIT_TERMINAL_PROMPT=0 git push origin "$BRANCH"
fi

echo "推送完成。当前状态："
git status --short --branch
