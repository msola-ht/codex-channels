#!/bin/zsh
set -euo pipefail

action="${1:-status}"
user_domain="gui/$(id -u)"
agents_dir="$HOME/Library/LaunchAgents"
app_label="com.hegenai.codex-app-server"
gateway_label="com.hegenai.codex-gateway"
legacy_app_label="com.msola.codex-app-server"
legacy_gateway_label="com.msola.codex-gateway"

job_loaded() {
  launchctl print "$user_domain/$1" >/dev/null 2>&1
}

wait_until_unloaded() {
  local label="$1"
  local attempt
  for attempt in {1..50}; do
    if ! job_loaded "$label"; then
      return 0
    fi
    sleep 0.1
  done
  print -u2 "等待 launchd Job 卸载超时：$label"
  return 1
}

stop_job() {
  local label="$1"
  if ! job_loaded "$label"; then
    return 0
  fi
  launchctl bootout "$user_domain/$label" 2>/dev/null || true
  wait_until_unloaded "$label"
}

ensure_loaded() {
  local label="$1"
  local plist="$2"
  local attempt
  if job_loaded "$label"; then
    return 0
  fi
  for attempt in {1..20}; do
    if launchctl bootstrap "$user_domain" "$plist" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  launchctl bootstrap "$user_domain" "$plist"
}

start_job() {
  local label="$1"
  local plist="$2"
  ensure_loaded "$label" "$plist" || return $?
  launchctl kickstart -k "$user_domain/$label"
}

remove_legacy_jobs() {
  stop_job "$legacy_gateway_label"
  stop_job "$legacy_app_label"
  /bin/rm -f \
    "$agents_dir/$legacy_gateway_label.plist" \
    "$agents_dir/$legacy_app_label.plist"
}

case "$action" in
  install)
    stop_job "$gateway_label"
    stop_job "$app_label"
    remove_legacy_jobs
    start_job "$app_label" "$agents_dir/$app_label.plist"
    start_job "$gateway_label" "$agents_dir/$gateway_label.plist"
    print "Codex App Server 与 Gateway 已安装并启动。"
    ;;
  start)
    start_job "$app_label" "$agents_dir/$app_label.plist"
    start_job "$gateway_label" "$agents_dir/$gateway_label.plist"
    print "Codex App Server 与 Gateway 已启动。"
    ;;
  stop)
    stop_job "$gateway_label"
    stop_job "$app_label"
    stop_job "$legacy_gateway_label"
    stop_job "$legacy_app_label"
    print "Codex App Server 与 Gateway 已停止。"
    ;;
  uninstall)
    stop_job "$gateway_label"
    stop_job "$app_label"
    remove_legacy_jobs
    /bin/rm -f "$agents_dir/$gateway_label.plist" "$agents_dir/$app_label.plist"
    print "Codex App Server 与 Gateway launchd 服务已卸载。"
    print "用户配置与运行数据保留在 ~/.codex-connect。"
    ;;
  restart)
    print "正在重启 Gateway..."
    start_job "$gateway_label" "$agents_dir/$gateway_label.plist"
    print "Gateway 已重启；Codex App Server 保持运行。"
    ;;
  reload)
    if ! job_loaded "$gateway_label"; then
      print -u2 "Gateway 尚未运行，请先执行 codexc service start。"
      exit 1
    fi
    launchctl kill SIGHUP "$user_domain/$gateway_label"
    print "已通知 Gateway 重新读取配置；Gateway 连接变化会自动重启，App Server 配置变化需重新安装服务。"
    ;;
  status)
    launchctl print "$user_domain/$app_label" 2>/dev/null || true
    launchctl print "$user_domain/$gateway_label" 2>/dev/null || true
    launchctl print "$user_domain/$legacy_app_label" 2>/dev/null || true
    launchctl print "$user_domain/$legacy_gateway_label" 2>/dev/null || true
    ;;
  *)
    print -u2 "用法：$0 {install|start|stop|reload|restart|status|uninstall}"
    exit 2
    ;;
esac
