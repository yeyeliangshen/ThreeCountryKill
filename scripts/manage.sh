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

# 本机出口 IP（用于打印访问地址，公网请用云服务器公网 IP）
my_ip() {
  command -v hostname >/dev/null 2>&1 && hostname -I 2>/dev/null | awk '{print $1; exit}' || echo "127.0.0.1"
}

ensure_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then
    log "未检测到 pm2，正在全局安装…"
    need_cmd npm
    npm install -g pm2
  fi
}

cmd_start() {
  need_cmd node
  need_cmd pnpm
  ensure_pm2

  # Node 版本检查（>=20）
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" -lt 20 ]; then
    err "Node 版本过低（$(node -v)），需 >= 20。"
    exit 1
  fi

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
  log "（云服务器请用公网 IP，并确认安全组已放行 $PORT 端口）"
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
