#!/usr/bin/env bash
# 三国杀联机版服务端一键管理脚本（Linux 服务器上运行）。
# 用法：
#   bash scripts/manage.sh start     一键开启（必要时自动 install + 构建前端 + pm2 拉起）
#   bash scripts/manage.sh stop      关闭服务端
#   bash scripts/manage.sh restart   重启
#   bash scripts/manage.sh status    查看运行状态
#   bash scripts/manage.sh logs      查看日志
set -euo pipefail

# 切到仓库根（脚本在 scripts/ 下）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

APP_NAME="sgs"
PORT="${PORT:-8080}"

log() { printf '\033[36m[manage]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[manage]\033[0m %s\n' "$*" >&2; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "未找到命令：$1。请先安装。"
    exit 1
  fi
}

# 一次性前置安装指引（国内镜像，免 sudo）：缺少 node/pnpm 时打印
install_help() {
  cat <<'EOF'
未检测到 Node.js(>=20) 或 pnpm。这是一次性前置安装（全程国内镜像，免 sudo）：

  # 1) 从 gitee 克隆 nvm
  git clone https://gitee.com/mirrors/nvm.git ~/.nvm

  # 2) 让 bash 加载 nvm
  cat >> ~/.bashrc <<'NVM_INIT'
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
NVM_INIT
  source ~/.bashrc

  # 3) 用淘宝镜像装 Node 20
  export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
  nvm install 20
  nvm use 20
  node -v        # 应显示 v20.x

  # 4) npm 换淘宝源，装 pnpm 和 pm2
  npm config set registry https://registry.npmmirror.com
  npm install -g pnpm pm2

装完回到本目录再跑一次：bash scripts/manage.sh start
EOF
}

# 启动前自检：node/pnpm 必须存在且 node>=20，否则打印安装指引并退出
preflight() {
  if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
    err "缺少运行所需命令（node / pnpm）。"
    install_help
    exit 1
  fi
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" -lt 20 ]; then
    err "Node 版本过低（$(node -v)），需 >= 20。请按下面重装："
    install_help
    exit 1
  fi
}

# 判断是否为合法 IPv4（4 段、各 1-3 位数字）。
# 用于过滤元数据/回显服务返回的错误页、JSON 等非 IP 乱码。
is_ipv4() {
  [ -n "$1" ] && printf '%s\n' "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
}

# 取阿里云元数据（实例内可达、不走外网）。IMDSv2 token 优先，IMDSv1 兜底。
# 元数据正常返回纯 IP 文本；若返回错误页/JSON，会被调用方的 is_ipv4 过滤掉。
meta_get() {
  local path="$1" token
  token="$(curl -s --max-time 2 -X PUT -H 'X-aliyun-ecs-metadata-token-ttl-seconds:60' \
    http://100.100.100.200/latest/api/token 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
  if [ -n "$token" ]; then
    curl -s --max-time 2 -H "X-aliyun-ecs-metadata-token: $token" \
      "http://100.100.100.200${path}" 2>/dev/null | head -n1 | tr -d '[:space:]' || true
  else
    curl -s --max-time 2 "http://100.100.100.200${path}" 2>/dev/null | head -n1 | tr -d '[:space:]' || true
  fi
}

# 本机出口 IP（优先公网，用于打印访问地址）。依次尝试：
# 1) 阿里云元数据 public-ipv4 / eipv4
# 2) 公网 IP 回显服务（api.ipify.org / 4.ipw.cn，需公网出口）
# 3) 退回内网 IP（hostname -I）——浏览器连不上，仅作兜底显示
my_ip() {
  local pub=""
  pub="$(meta_get /latest/meta-data/public-ipv4)"
  is_ipv4 "$pub" || pub="$(meta_get /latest/meta-data/eipv4)"
  is_ipv4 "$pub" || pub="$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
  is_ipv4 "$pub" || pub="$(curl -s --max-time 3 https://4.ipw.cn 2>/dev/null | head -n1 | tr -d '[:space:]' || true)"
  if is_ipv4 "$pub"; then
    echo "$pub"
    return
  fi
  command -v hostname >/dev/null 2>&1 && hostname -I 2>/dev/null | awk '{print $1; exit}' || echo "127.0.0.1"
}

ensure_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    log "未检测到 pm2，正在全局安装…"
    need_cmd npm
    npm install -g pm2 --registry=https://registry.npmmirror.com
  fi
}

cmd_start() {
  preflight
  ensure_pm2

  # 装依赖（首次 clone 后 node_modules 不存在）
  if [ ! -d node_modules ]; then
    log "安装依赖（pnpm install）…"
    pnpm install
  fi

  # 构建前端（dist 不存在则构建）
  if [ ! -f packages/client/dist/index.html ]; then
    log "构建前端（vite build）…"
    pnpm --filter @sgs/client exec vite build
  fi

  log "启动服务端（pm2）…"
  # 已存在则先删掉，保证幂等
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  pm2 start ecosystem.config.cjs
  pm2 save >/dev/null 2>&1 || true

  IP="$(my_ip)"
  log "✅ 已启动。浏览器访问：http://$IP:$PORT"
  log "（若上方不是公网 IP，请到云控制台查看公网 IP；并确认安全组已放行 $PORT 端口）"
  log "查看日志：bash scripts/manage.sh logs"
}

cmd_stop() {
  ensure_pm2
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 delete "$APP_NAME"
    pm2 save >/dev/null 2>&1 || true
    log "✅ 已停止。"
  else
    log "服务未在运行。"
  fi
}

cmd_restart() {
  ensure_pm2
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME"
    log "✅ 已重启。"
  else
    log "服务未运行，改为启动…"
    cmd_start
  fi
}

cmd_status() {
  ensure_pm2
  pm2 describe "$APP_NAME" 2>/dev/null || log "服务未注册。"
  IP="$(my_ip)"
  log "对外地址：http://$IP:$PORT"
}

cmd_logs() {
  ensure_pm2
  pm2 logs "$APP_NAME" --lines 50
}

usage() {
  cat <<EOF
三国杀服务端管理脚本
用法：
  bash scripts/manage.sh start      一键开启
  bash scripts/manage.sh stop       关闭
  bash scripts/manage.sh restart    重启
  bash scripts/manage.sh status     查看状态
  bash scripts/manage.sh logs       查看日志
可选环境变量：PORT（默认 8080）
EOF
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_restart ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *) usage; exit 1 ;;
esac
