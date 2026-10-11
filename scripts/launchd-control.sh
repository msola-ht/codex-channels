#!/bin/zsh
set -euo pipefail

action="${1:-status}"
user_domain="gui/$(id -u)"
agents_dir="$HOME/Library/LaunchAgents"
script_dir="${0:A:h}"

service_ids() {
  "${NODE_BINARY:-node}" "$script_dir/service-target-query.mjs" launchd "$1" "$2"
}
print_status() {
  "${NODE_BINARY:-node}" "$script_dir/cli-status.mjs" "$1" "$2"
}
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

  if (( $# > 0 )) && [[ "$1" == "gateway" || "$1" == "app-server" || "$1" == "webui" || "$1" == "model-relay" || "$1" == "all" ]]; then
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
        print_status failure "未知日志参数：$1"
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
  if [[ "$service" == "webui" || "$service" == "all" ]]; then
    [[ -f "$runtime_dir/webui.log" ]] && log_files+=("$runtime_dir/webui.log")
    if [[ ! -f "$runtime_dir/webui.log" || "$runtime_dir/webui.error.log" -nt "$runtime_dir/webui.log" ]]; then
      [[ -f "$runtime_dir/webui.error.log" ]] && log_files+=("$runtime_dir/webui.error.log")
    fi
  fi
  if [[ "$service" == "model-relay" || "$service" == "all" ]]; then
    [[ -f "$runtime_dir/model-relay.log" ]] && log_files+=("$runtime_dir/model-relay.log")
    [[ -f "$runtime_dir/model-relay.error.log" ]] && log_files+=("$runtime_dir/model-relay.error.log")
  fi
  if (( ${#log_files[@]} == 0 )); then
    print_status failure "尚未找到后台日志：$runtime_dir"
    print_status remediation "请先执行 codexc start，并检查 codexc status。"
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
  print_status failure "检测到不支持的 launchd Job：${(j:, :)loaded}"
  print_status remediation "请先手动卸载这些 Job 并删除对应 plist，再重新运行 codexc install。"
  return 1
}

wait_until_unloaded() {
  local label="$1"
  local stop_timeout_seconds
  stop_timeout_seconds=$("${NODE_BINARY:-node}" --input-type=module -e \
    'import { pathToFileURL } from "node:url"; const { serviceStopTimeoutSeconds } = await import(pathToFileURL(process.argv[1]).href); console.log(serviceStopTimeoutSeconds);' \
    "$script_dir/../runtime/shutdown-budget.mjs") || return $?
  local deadline=$(( SECONDS + stop_timeout_seconds ))
  while (( SECONDS < deadline )); do
    if ! job_loaded "$label"; then
      return 0
    fi
    sleep 0.1
  done
  print_status failure "等待 launchd Job 卸载超时：$label"
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
  launchctl kickstart "$user_domain/$label"
}

require_target() {
  case "$1" in
    gateway|app-server|webui|model-relay|all)
      ;;
    *)
      print_status failure "服务目标必须是 gateway、app-server、webui、model-relay 或 all：$1"
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
    labels=$(service_ids all install-stop)
    for label in ${(f)labels}; do stop_job "$label"; done
    labels=$(service_ids all install)
    for label in ${(f)labels}; do
      start_job "$label" "$agents_dir/$label.plist"
    done
    print_status note "Codex App Server 与 Gateway 已安装，启动操作已完成，正在确认就绪状态。"
    print_status note "WebUI 服务已生成，可执行 codexc start webui 启动。"
    ;;
  start)
    reject_unsupported_jobs
    target="${2:-all}"
    require_target "$target"
    labels=$(service_ids "$target" start)
    failed_labels=()
    for label in ${(f)labels}; do
      if ! start_job "$label" "$agents_dir/$label.plist"; then
        failed_labels+=("$label")
      fi
    done
    if (( ${#failed_labels[@]} > 0 )) && [[ "$target" == "all" ]]; then
      print_status failure "服务启动部分失败；失败目标：${(j:, :)failed_labels}。请运行 codexc status。"
      exit 1
    elif (( ${#failed_labels[@]} > 0 )); then
      exit 1
    fi
    case "$target" in
      gateway) print_status note "Gateway 启动操作已完成，正在确认就绪状态。" ;;
      app-server) print_status note "Codex App Server 启动操作已完成，正在确认就绪状态。" ;;
      webui) print_status success "WebUI 已启动。" ;;
      model-relay) print_status success "Model Relay 已启动。" ;;
      all) print_status note "Codex App Server 与 Gateway 启动操作已完成，正在确认就绪状态。" ;;
    esac
    ;;
  stop)
    target="${2:-all}"
    require_target "$target"
    labels=$(service_ids "$target" stop)
    failed_labels=()
    for label in ${(f)labels}; do
      if ! stop_job "$label"; then
        failed_labels+=("$label")
      fi
    done
    if (( ${#failed_labels[@]} > 0 )) && [[ "$target" == "all" ]]; then
      print_status failure "服务停止部分失败；失败目标：${(j:, :)failed_labels}。请运行 codexc status。"
      exit 1
    elif (( ${#failed_labels[@]} > 0 )); then
      exit 1
    fi
    case "$target" in
      gateway) print_status success "Gateway 已停止。" ;;
      app-server) print_status success "Codex App Server 已停止。" ;;
      webui) print_status success "WebUI 已停止。" ;;
      model-relay) print_status success "Model Relay 已停止。" ;;
      all) print_status success "Codex App Server 与 Gateway 已停止。" ;;
    esac
    ;;
  uninstall)
    labels=$(service_ids all uninstall)
    for label in ${(f)labels}; do
      stop_job "$label"
      /bin/rm -f "$agents_dir/$label.plist"
    done
    print_status success "Codex App Server、Gateway 与 WebUI launchd 服务已卸载。"
    print_status note "用户配置与运行数据保留在 ~/.codex-connect。"
    ;;
  reload)
    reject_unsupported_jobs
    gateway_label=$(service_ids gateway start)
    if ! job_loaded "$gateway_label"; then
      print_status failure "Gateway 尚未运行，请先执行 codexc start。"
      exit 1
    fi
    if launchctl kill SIGHUP "$user_domain/$gateway_label" 2>/dev/null; then
      print_status success "已通知 Gateway 重新读取配置；Gateway 连接变化会自动重启，App Server 配置变化需重新安装服务。"
    else
      print_status failure "Gateway 当前没有可接收信号的运行进程，未隐式启动服务。"
      print_status remediation "请先执行 codexc start gateway，再运行 codexc reload。"
      exit 1
    fi
    ;;
  status)
    target="${2:-all}"
    require_target "$target"
    labels=$(service_ids "$target" status)
    required_labels=$(service_ids "$target" status-required)
    status_code=0
    for label in ${(f)labels}; do
      launchctl print "$user_domain/$label" 2>/dev/null && continue
      # 关闭或未启用的可选服务允许保持未加载，只有预期运行的服务才判定异常；
      # 配置不可读时 status-required 退回“已安装即可选服务必需”，状态查询仍然可用。
      required=0
      for candidate in ${(f)required_labels}; do
        [ "$candidate" = "$label" ] && required=1
      done
      if [ "$required" -eq 1 ]; then
        print_status failure "launchd 服务未加载：$label"
        status_code=1
      else
        print_status note "launchd 可选服务未加载：$label"
      fi
    done
    exit "$status_code"
    ;;
  logs)
    shift
    show_logs "$@"
    ;;
  *)
    print_status failure "用法：$0 {install|uninstall|reload|start|stop|status|logs} [gateway|app-server|webui|model-relay|all]"
    exit 2
    ;;
esac
