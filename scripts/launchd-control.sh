#!/bin/zsh
set -euo pipefail

action="${1:-status}"
user_domain="gui/$(id -u)"
agents_dir="$HOME/Library/LaunchAgents"
app_label="com.hegenai.codex-app-server"
gateway_label="com.hegenai.codex-gateway"
webui_label="com.hegenai.codex-webui"
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

  if (( $# > 0 )) && [[ "$1" == "gateway" || "$1" == "app-server" || "$1" == "webui" || "$1" == "all" ]]; then
    service="$1"
    shift
  fi
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
  if [[ "$service" == "webui" ]]; then
    [[ -f "$runtime_dir/webui.log" ]] && log_files+=("$runtime_dir/webui.log")
    if [[ ! -f "$runtime_dir/webui.log" || "$runtime_dir/webui.error.log" -nt "$runtime_dir/webui.log" ]]; then
      [[ -f "$runtime_dir/webui.error.log" ]] && log_files+=("$runtime_dir/webui.error.log")
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

require_target() {
  case "$1" in
    gateway|app-server|webui|all)
      ;;
    *)
      print -u2 "服务目标必须是 gateway、app-server、webui 或 all：$1"
      return 2
      ;;
  esac
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
    print "WebUI 服务已生成，可执行 codexc service start webui 启动。"
    ;;
  start)
    reject_unsupported_jobs
    target="${2:-all}"
    require_target "$target"
    if [[ "$target" == "app-server" || "$target" == "all" ]]; then
      start_job "$app_label" "$agents_dir/$app_label.plist"
    fi
    if [[ "$target" == "gateway" || "$target" == "all" ]]; then
      start_job "$gateway_label" "$agents_dir/$gateway_label.plist"
    fi
    if [[ "$target" == "webui" ]]; then
      start_job "$webui_label" "$agents_dir/$webui_label.plist"
    fi
    case "$target" in
      gateway) print "Gateway 已启动。" ;;
      app-server) print "Codex App Server 已启动。" ;;
      webui) print "WebUI 已启动。" ;;
      all) print "Codex App Server 与 Gateway 已启动。" ;;
    esac
    ;;
  stop)
    target="${2:-all}"
    require_target "$target"
    if [[ "$target" == "gateway" || "$target" == "all" ]]; then
      stop_job "$gateway_label"
    fi
    if [[ "$target" == "app-server" || "$target" == "all" ]]; then
      stop_job "$app_label"
    fi
    if [[ "$target" == "webui" ]]; then
      stop_job "$webui_label"
    fi
    case "$target" in
      gateway) print "Gateway 已停止。" ;;
      app-server) print "Codex App Server 已停止。" ;;
      webui) print "WebUI 已停止。" ;;
      all) print "Codex App Server 与 Gateway 已停止。" ;;
    esac
    ;;
  uninstall)
    stop_job "$gateway_label"
    stop_job "$app_label"
    stop_job "$webui_label"
    /bin/rm -f "$agents_dir/$gateway_label.plist" "$agents_dir/$app_label.plist" "$agents_dir/$webui_label.plist"
    print "Codex App Server、Gateway 与 WebUI launchd 服务已卸载。"
    print "用户配置与运行数据保留在 ~/.codex-connect。"
    ;;
  restart)
    reject_unsupported_jobs
    target="${2:-gateway}"
    require_target "$target"
    if [[ "$target" == "app-server" || "$target" == "all" ]]; then
      start_job "$app_label" "$agents_dir/$app_label.plist"
    fi
    if [[ "$target" == "gateway" || "$target" == "all" ]]; then
      start_job "$gateway_label" "$agents_dir/$gateway_label.plist"
    fi
    if [[ "$target" == "webui" ]]; then
      start_job "$webui_label" "$agents_dir/$webui_label.plist"
    fi
    case "$target" in
      gateway) print "Gateway 已重启；Codex App Server 保持运行。" ;;
      app-server) print "Codex App Server 已重启；Gateway 将自动重连。" ;;
      webui) print "WebUI 已重启。" ;;
      all) print "Codex App Server 与 Gateway 已重启。" ;;
    esac
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
    target="${2:-all}"
    require_target "$target"
    if [[ "$target" == "app-server" || "$target" == "all" ]]; then
      launchctl print "$user_domain/$app_label" 2>/dev/null || true
    fi
    if [[ "$target" == "gateway" || "$target" == "all" ]]; then
      launchctl print "$user_domain/$gateway_label" 2>/dev/null || true
    fi
    if [[ "$target" == "webui" ]]; then
      launchctl print "$user_domain/$webui_label" 2>/dev/null || true
    fi
    ;;
  logs)
    shift
    show_logs "$@"
    ;;
  *)
    print -u2 "用法：$0 {install|uninstall|reload|start|stop|restart|status|logs} [gateway|app-server|webui|all]"
    exit 2
    ;;
esac
