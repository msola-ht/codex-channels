#!/bin/zsh
set -euo pipefail

action="${1:-status}"
user_domain="gui/$(id -u)"
agents_dir="$HOME/Library/LaunchAgents"
app_label="com.hegenai.codex-app-server"
gateway_label="com.hegenai.codex-gateway"
unsupported_app_label="com.msola.codex-app-server"
unsupported_gateway_label="com.msola.codex-gateway"

show_logs() {
  local follow=0
  local lines=100
  local service="gateway"
  local socket_path="${CODEX_SOCKET_PATH:-${CODEX_CONNECT_HOME:-$HOME/.codex-connect}/runtime/codex-app-server.sock}"
  local runtime_dir
  local -a log_files
  local path
  if [[ "$socket_path" != /* ]]; then
    socket_path="${CODEX_CONNECT_HOME:-$HOME/.codex-connect}/$socket_path"
  fi
  runtime_dir="${socket_path:h}"

  while (( $# > 0 )); do
    case "$1" in
      --follow)
        follow=1
        shift
        ;;
      --lines)
        lines="$2"
        shift 2
        ;;
      --service)
        service="$2"
        shift 2
        ;;
      *)
        print -u2 "未知日志参数：$1"
        return 2
        ;;
    esac
  done

  log_files=()
  if [[ "$service" == "gateway" || "$service" == "all" ]]; then
    [[ -f "$runtime_dir/gateway.log" ]] && log_files+=("$runtime_dir/gateway.log")
    if [[ "$service" == "all"
      || ! -f "$runtime_dir/gateway.log"
      || "$runtime_dir/gateway.error.log" -nt "$runtime_dir/gateway.log" ]]; then
      [[ -f "$runtime_dir/gateway.error.log" ]] && log_files+=("$runtime_dir/gateway.error.log")
    fi
  fi
  if [[ "$service" == "app-server" || "$service" == "all" ]]; then
    [[ -f "$runtime_dir/codex-app-server.log" ]] && log_files+=("$runtime_dir/codex-app-server.log")
    if [[ "$service" == "all"
      || ! -f "$runtime_dir/codex-app-server.log"
      || "$runtime_dir/codex-app-server.error.log" -nt "$runtime_dir/codex-app-server.log" ]]; then
      [[ -f "$runtime_dir/codex-app-server.error.log" ]] && log_files+=("$runtime_dir/codex-app-server.error.log")
    fi
  fi
  if (( ${#log_files[@]} == 0 )); then
    print -u2 "尚未找到后台日志：$runtime_dir"
    print -u2 "请先执行 codexc service start，并检查 codexc service status。"
    return 1
  fi
  if (( follow )); then
    exec /usr/bin/tail -n "$lines" -F "${log_files[@]}"
  fi
  /usr/bin/tail -n "$lines" "${log_files[@]}"
}

job_loaded() {
  launchctl print "$user_domain/$1" >/dev/null 2>&1
}

reject_unsupported_jobs() {
  local -a loaded
  local label
  loaded=()
  for label in "$unsupported_app_label" "$unsupported_gateway_label"; do
    job_loaded "$label" && loaded+=("$label")
  done
  if (( ${#loaded[@]} == 0 )); then
    return 0
  fi
  print -u2 "检测到不支持的 launchd Job：${(j:, :)loaded}"
  print -u2 "请先手动卸载这些 Job 并删除对应 plist，再重新运行 codexc service install。"
  return 1
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

case "$action" in
  check-install)
    reject_unsupported_jobs
    ;;
  install)
    reject_unsupported_jobs
    stop_job "$gateway_label"
    stop_job "$app_label"
    start_job "$app_label" "$agents_dir/$app_label.plist"
    start_job "$gateway_label" "$agents_dir/$gateway_label.plist"
    print "Codex App Server 与 Gateway 已安装并启动。"
    ;;
  start)
    reject_unsupported_jobs
    start_job "$app_label" "$agents_dir/$app_label.plist"
    start_job "$gateway_label" "$agents_dir/$gateway_label.plist"
    print "Codex App Server 与 Gateway 已启动。"
    ;;
  stop)
    stop_job "$gateway_label"
    stop_job "$app_label"
    print "Codex App Server 与 Gateway 已停止。"
    ;;
  uninstall)
    stop_job "$gateway_label"
    stop_job "$app_label"
    /bin/rm -f "$agents_dir/$gateway_label.plist" "$agents_dir/$app_label.plist"
    print "Codex App Server 与 Gateway launchd 服务已卸载。"
    print "用户配置与运行数据保留在 ~/.codex-connect。"
    ;;
  restart)
    reject_unsupported_jobs
    print "正在重启 Gateway..."
    start_job "$gateway_label" "$agents_dir/$gateway_label.plist"
    print "Gateway 已重启；Codex App Server 保持运行。"
    ;;
  reload)
    reject_unsupported_jobs
    if ! job_loaded "$gateway_label"; then
      print -u2 "Gateway 尚未运行，请先执行 codexc service start。"
      exit 1
    fi
    if launchctl kill SIGHUP "$user_domain/$gateway_label" 2>/dev/null; then
      print "已通知 Gateway 重新读取配置；Gateway 连接变化会自动重启，App Server 配置变化需重新安装服务。"
    else
      print "Gateway 当前没有可接收信号的进程，正在启动..."
      start_job "$gateway_label" "$agents_dir/$gateway_label.plist"
      print "Gateway 已启动并将读取最新配置。"
    fi
    ;;
  status)
    launchctl print "$user_domain/$app_label" 2>/dev/null || true
    launchctl print "$user_domain/$gateway_label" 2>/dev/null || true
    ;;
  logs)
    shift
    show_logs "$@"
    ;;
  *)
    print -u2 "用法：$0 {install|start|stop|reload|restart|status|logs|uninstall}"
    exit 2
    ;;
esac
