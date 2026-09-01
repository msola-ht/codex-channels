#!/bin/sh
set -eu

action="${1:-status}"
systemctl_binary="${SYSTEMCTL_BINARY:-systemctl}"
loginctl_binary="${LOGINCTL_BINARY:-loginctl}"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
units_dir="$config_home/systemd/user"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

service_ids() {
  "${NODE_BINARY:-node}" "$script_dir/service-target-query.mjs" systemd "$1" "$2"
}

print_status() {
  "${NODE_BINARY:-node}" "$script_dir/cli-status.mjs" "$1" "$2"
}

show_logs() {
  follow=0
  lines=100
  service=gateway
  if [ "$#" -gt 0 ] && { [ "$1" = "gateway" ] || [ "$1" = "app-server" ] || [ "$1" = "webui" ] || [ "$1" = "center" ] || [ "$1" = "all" ]; }; then
    service=$1
    shift
  fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --follow)
        follow=1
        shift
        ;;
      --lines)
        lines=$2
        shift 2
        ;;
      *)
        print_status failure "未知日志参数：$1"
        return 2
        ;;
    esac
  done

  set --
  if [ "$service" = "all" ]; then
    resolved_units=$(service_ids all stop)
    for unit in $resolved_units; do
      set -- "$@" --user-unit="$unit"
    done
  else
    unit=$(service_ids "$service" start)
    set -- "$@" --user-unit="$unit"
  fi
  set -- "$@" --lines="$lines" --no-pager
  if [ "$follow" -eq 1 ]; then
    set -- "$@" --follow
  fi
  exec "${JOURNALCTL_BINARY:-journalctl}" "$@"
}

systemctl_user() {
  "$systemctl_binary" --user "$@"
}

stop_unit() {
  unit="$1"
  load_state=$(systemctl_user show "$unit" --property=LoadState --value 2>/dev/null || true)
  if [ "$load_state" = "not-found" ]; then
    return 0
  fi
  systemctl_user stop "$unit"
}

ensure_linger() {
  user_id=$(id -u)
  linger=$(
    "$loginctl_binary" show-user "$user_id" --property=Linger --value 2>/dev/null \
      || true
  )
  if [ "$linger" = "yes" ]; then
    return 0
  fi
  if ! "$loginctl_binary" enable-linger "$user_id" 2>/dev/null; then
    print_status failure "无法为当前用户启用 systemd linger，后台服务不能保证在登录前启动。"
    print_status remediation "请先执行 sudo loginctl enable-linger \"$(id -un)\"，再重新运行 codexc service install。"
    return 1
  fi
  linger=$(
    "$loginctl_binary" show-user "$user_id" --property=Linger --value 2>/dev/null \
      || true
  )
  if [ "$linger" != "yes" ]; then
    print_status failure "systemd linger 启用后未生效，后台服务不能保证在登录前启动。"
    print_status remediation "请执行 sudo loginctl enable-linger \"$(id -un)\" 并复查 loginctl show-user \"$(id -un)\"。"
    return 1
  fi
}

require_target() {
  case "$1" in
    gateway|app-server|webui|center|all)
      ;;
    *)
      print_status failure "服务目标必须是 gateway、app-server、webui、center 或 all：$1"
      return 2
      ;;
  esac
}

case "$action" in
  install)
    ensure_linger
    systemctl_user daemon-reload
    resolved_units=$(service_ids all start)
    set -- $resolved_units
    systemctl_user enable "$@"
    for unit in "$@"; do systemctl_user restart "$unit"; done
    print_status note "Codex App Server 与 Gateway systemd 用户服务已安装，启动操作已完成，正在确认就绪状态。"
    print_status note "systemd linger 已启用，未登录时也会随系统启动。"
    print_status note "WebUI 服务已生成，可执行 codexc service start webui 启动。"
    print_status note "指标中心服务已生成，可执行 codexc service start center 启动。"
    ;;
  start)
    target=${2:-all}
    require_target "$target"
    resolved_units=$(service_ids "$target" start)
    failed_units=""
    for unit in $resolved_units; do
      if ! systemctl_user start "$unit"; then
        failed_units="$failed_units $unit"
      fi
    done
    if [ -n "$failed_units" ] && [ "$target" = "all" ]; then
      print_status failure "服务启动部分失败；失败目标：${failed_units# }。请运行 codexc service status。"
      exit 1
    elif [ -n "$failed_units" ]; then
      exit 1
    fi
    case "$target" in
      gateway) print_status note "Gateway 启动操作已完成，正在确认就绪状态。" ;;
      app-server) print_status note "Codex App Server 启动操作已完成，正在确认就绪状态。" ;;
      webui) print_status success "WebUI 已启动。" ;;
      center) print_status success "指标中心已启动。" ;;
      all) print_status note "Codex App Server 与 Gateway 启动操作已完成，正在确认就绪状态。" ;;
    esac
    ;;
  stop)
    target=${2:-all}
    require_target "$target"
    resolved_units=$(service_ids "$target" stop)
    failed_units=""
    for unit in $resolved_units; do
      if ! stop_unit "$unit"; then
        failed_units="$failed_units $unit"
      fi
    done
    if [ -n "$failed_units" ] && [ "$target" = "all" ]; then
      print_status failure "服务停止部分失败；失败目标：${failed_units# }。请运行 codexc service status。"
      exit 1
    elif [ -n "$failed_units" ]; then
      exit 1
    fi
    case "$target" in
      gateway) print_status success "Gateway 已停止。" ;;
      app-server) print_status success "Codex App Server 已停止。" ;;
      webui) print_status success "WebUI 已停止。" ;;
      center) print_status success "指标中心已停止。" ;;
      all) print_status success "Codex App Server 与 Gateway 已停止。" ;;
    esac
    ;;
  restart)
    target=${2:-gateway}
    require_target "$target"
    resolved_units=$(service_ids "$target" start)
    failed_units=""
    for unit in $resolved_units; do
      if ! systemctl_user restart "$unit"; then
        failed_units="$failed_units $unit"
      fi
    done
    if [ -n "$failed_units" ] && [ "$target" = "all" ]; then
      print_status failure "服务重启部分失败；失败目标：${failed_units# }。请运行 codexc service status。"
      exit 1
    elif [ -n "$failed_units" ]; then
      exit 1
    fi
    case "$target" in
      gateway) print_status note "Gateway 重启操作已完成，正在确认就绪状态；Codex App Server 保持运行。" ;;
      app-server) print_status note "Codex App Server 重启操作已完成，正在确认就绪状态；Gateway 将自动重连。" ;;
      webui) print_status success "WebUI 已重启。" ;;
      center) print_status success "指标中心已重启。" ;;
      all) print_status note "Codex App Server 与 Gateway 重启操作已完成，正在确认就绪状态。" ;;
    esac
    ;;
  reload)
    gateway_unit=$(service_ids gateway start)
    if ! systemctl_user is-active --quiet "$gateway_unit"; then
      print_status failure "Gateway 尚未运行，请先执行 codexc service start。"
      exit 1
    fi
    systemctl_user kill --kill-whom=main --signal=HUP "$gateway_unit"
    print_status success "已通知 Gateway 重新读取配置；Gateway 连接变化会自动重启，App Server 配置变化需重新安装服务。"
    ;;
  status)
    target=${2:-all}
    require_target "$target"
    resolved_units=$(service_ids "$target" start)
    set -- $resolved_units
    set +e
    systemctl_user --no-pager status "$@"
    status_code=$?
    set -e
    if [ "$status_code" -ne 0 ]; then
      print_status failure "systemd 服务状态异常。"
      exit "$status_code"
    fi
    ;;
  logs)
    shift
    show_logs "$@"
    ;;
  uninstall)
    resolved_units=$(service_ids all stop)
    webui_unit=$(service_ids webui stop)
    center_unit=$(service_ids center stop)
    set -- $resolved_units "$webui_unit" "$center_unit"
    if ! systemctl_user disable --now "$@"; then
      print_status failure "systemd 服务未能停止或禁用，已保留服务定义以便排查。"
      exit 1
    fi
    for unit in "$@"; do rm -f "$units_dir/$unit"; done
    systemctl_user daemon-reload
    systemctl_user reset-failed "$@" 2>/dev/null || true
    print_status success "Codex App Server、Gateway、WebUI 与指标中心 systemd 用户服务已卸载。"
    print_status note "用户配置与运行数据保留在 ~/.codex-connect。"
    ;;
  *)
    print_status failure "用法：$0 {install|uninstall|reload|start|stop|restart|status|logs} [gateway|app-server|webui|center|all]"
    exit 2
    ;;
esac
