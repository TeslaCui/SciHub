#!/usr/bin/env bash
# SciHub 自动同步：提交工作区改动并推送到 GitHub。
#
# 环境兼容：
#   · Windows Git Bash / MSYS —— 直连 GitHub（走 Windows 网络栈），凭据交给
#     git 自己的配置（Git Credential Manager / gh）即可。
#   · WSL（NAT 模式）—— 直连 github.com 不通，脚本会按顺序降级：直连 → 本机
#     代理 → 「Windows 宿主 IP + 代理端口」，宿主 IP 每次现算，WSL 重启后也不用改配置。
#   · 推送采用「失败才降级」，不做预先探测 —— 探测通过不代表 push 一定能过
#     （github 的 443 时通时不通），所以每次都从直连试起，成功即停。
#
# 用法：
#   bash tools/sync.sh "feat: 你的提交说明"
#   bash tools/sync.sh                  # 使用默认说明
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BRANCH="master"

cd "$REPO"

# ── 1. 语法检查（有 node 才做，没有则跳过）──────────────────
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

# ── 2. 提交本地改动 ─────────────────────────────────────────
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "${1:-chore: 自动同步}"
  echo "已提交：$(git log --oneline -1)"
else
  echo "工作区干净，跳过提交。"
fi

# ── 3. 推送：直连失败就自动降级到代理 ───────────────────────
# 不再「先探测再决定」——探测通过不代表 push 一定能过（github 的 443 时通时不通）。
# 这里直接按顺序尝试，成功即停：
#   ① 直连（Git Bash / MSYS 走 Windows 网络栈）
#   ② 本机代理 127.0.0.1（Clash / v2ray 等常见端口）
#   ③ WSL 宿主 IP（NAT 模式，宿主 IP 会变，所以每次现算）
PUSHED=0

try_push() {
  local label="$1"
  shift
  echo "→ 推送（$label）"
  if GIT_TERMINAL_PROMPT=0 git "$@" push origin "$BRANCH" 2>&1; then
    PUSHED=1
    return 0
  fi
  return 1
}

PROXY_PORTS="7897 7890 7891 10809 10808 1080"

try_push "直连" || true

if [ "$PUSHED" != "1" ]; then
  for port in $PROXY_PORTS; do
    # 注意：这里必须写成 if...then，不能写 `cmd && break`——
    # 在 set -e 下 `cmd && break` 中 cmd 失败会让整条语句返回非 0 而直接退出脚本。
    if try_push "本机代理 127.0.0.1:${port}" \
      -c "http.proxy=http://127.0.0.1:${port}" -c "https.proxy=http://127.0.0.1:${port}"; then
      break
    fi
  done
fi

if [ "$PUSHED" != "1" ]; then
  HOST_IP="$(ip route show default 2>/dev/null | awk '{print $3}' | head -1 || true)"
  if [ -n "$HOST_IP" ]; then
    for port in $PROXY_PORTS; do
      if try_push "宿主代理 ${HOST_IP}:${port}" \
        -c "http.proxy=http://${HOST_IP}:${port}" -c "https.proxy=http://${HOST_IP}:${port}"; then
        break
      fi
    done
  fi
fi

if [ "$PUSHED" != "1" ]; then
  echo "推送失败：直连、本机代理、宿主代理都没成功。" >&2
  echo "请确认代理软件（Clash 等）正在运行，或手动执行：git push origin $BRANCH" >&2
  exit 1
fi

echo "推送完成。当前状态："
git status --short --branch
