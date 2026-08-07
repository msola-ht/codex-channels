#!/bin/sh
set -eu

action="${1:-status}"
systemctl_binary="${SYSTEMCTL_BINARY:-systemctl}"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
units_dir="$config_home/systemd/user"
app_unit="codex-connect-app-server.service"
gateway_unit="codex-connect-gateway.service"
webui_unit="codex-connect-webui.service"

show_logs() {
  follow=0
  lines=100
  service=gateway
  if [ "$#" -gt 0 ] && { [ "$1" = "gateway" ] || [ "$1" = "app-server" ] || [ "$1" = "webui" ] || [ "$1" = "all" ]; }; then
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
        printf '%s\n' "未知日志参数：$1" >&2
        return 2
        ;;
    esac
  done

  set --
  if [ "$service" = "gateway" ] || [ "$service" = "all" ]; then
    set -- "$@" --user-unit="$gateway_unit"
  fi
  if [ "$service" = "app-server" ] || [ "$service" = "all" ]; then
    set -- "$@" --user-unit="$app_unit"
  fi
  if [ "$service" = "webui" ]; then
    set -- "$@" --user-unit="$webui_unit"
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

require_target() {
  case "$1" in
    gateway|app-server|webui|all)
      ;;
    *)
      printf '%s\n' "服务目标必须是 gateway、app-server、webui 或 all：$1" >&2
      return 2
      ;;
  esac
}

case "$action" in
  install)
    systemctl_user daemon-reload
    systemctl_user enable "$app_unit" "$gateway_unit"
    systemctl_user restart "$app_unit"
    systemctl_user restart "$gateway_unit"
    printf '%s\n' "Codex App Server 与 Gateway systemd 用户服务已安装并启动。"
    printf '%s\n' "WebUI 服务已生成，可执行 codexc service start webui 启动。"
    ;;
  start)
    target=${2:-all}
    require_target "$target"
    case "$target" in
      gateway)
        systemctl_user start "$gateway_unit"
        printf '%s\n' "Gateway 已启动。"
        ;;
      app-server)
        systemctl_user start "$app_unit"
        printf '%s\n' "Codex App Server 已启动。"
        ;;
      webui)
        systemctl_user start "$webui_unit"
        printf '%s\n' "WebUI 已启动。"
        ;;
      all)
        systemctl_user start "$app_unit"
        systemctl_user start "$gateway_unit"
        printf '%s\n' "Codex App Server 与 Gateway 已启动。"
        ;;
    esac
    ;;
  stop)
    target=${2:-all}
    require_target "$target"
    case "$target" in
      gateway)
        systemctl_user stop "$gateway_unit"
        printf '%s\n' "Gateway 已停止。"
        ;;
      app-server)
        systemctl_user stop "$app_unit"
        printf '%s\n' "Codex App Server 已停止。"
        ;;
      webui)
        systemctl_user stop "$webui_unit"
        printf '%s\n' "WebUI 已停止。"
        ;;
      all)
        systemctl_user stop "$gateway_unit"
        systemctl_user stop "$app_unit"
        printf '%s\n' "Codex App Server 与 Gateway 已停止。"
        ;;
    esac
    ;;
  restart)
    target=${2:-gateway}
    require_target "$target"
    case "$target" in
      gateway)
        systemctl_user restart "$gateway_unit"
        printf '%s\n' "Gateway 已重启；Codex App Server 保持运行。"
        ;;
      app-server)
        systemctl_user restart "$app_unit"
        printf '%s\n' "Codex App Server 已重启；Gateway 将自动重连。"
        ;;
      webui)
        systemctl_user restart "$webui_unit"
        printf '%s\n' "WebUI 已重启。"
        ;;
      all)
        systemctl_user restart "$app_unit"
        systemctl_user restart "$gateway_unit"
        printf '%s\n' "Codex App Server 与 Gateway 已重启。"
        ;;
    esac
    ;;
  reload)
    if ! systemctl_user is-active --quiet "$gateway_unit"; then
      printf '%s\n' "Gateway 尚未运行，请先执行 codexc service start。" >&2
      exit 1
    fi
    systemctl_user kill --kill-whom=main --signal=HUP "$gateway_unit"
    printf '%s\n' "已通知 Gateway 重新读取配置；Gateway 连接变化会自动重启，App Server 配置变化需重新安装服务。"
    ;;
  status)
    target=${2:-all}
    require_target "$target"
    case "$target" in
      gateway) systemctl_user --no-pager status "$gateway_unit" || true ;;
      app-server) systemctl_user --no-pager status "$app_unit" || true ;;
      webui) systemctl_user --no-pager status "$webui_unit" || true ;;
      all) systemctl_user --no-pager status "$app_unit" "$gateway_unit" || true ;;
    esac
    ;;
  logs)
    shift
    show_logs "$@"
    ;;
  uninstall)
    systemctl_user disable --now "$gateway_unit" "$app_unit" "$webui_unit" 2>/dev/null || true
    rm -f "$units_dir/$gateway_unit" "$units_dir/$app_unit" "$units_dir/$webui_unit"
    systemctl_user daemon-reload
    systemctl_user reset-failed "$gateway_unit" "$app_unit" "$webui_unit" 2>/dev/null || true
    printf '%s\n' "Codex App Server、Gateway 与 WebUI systemd 用户服务已卸载。"
    printf '%s\n' "用户配置与运行数据保留在 ~/.codex-connect。"
    ;;
  *)
    printf '%s\n' "用法：$0 {install|uninstall|reload|start|stop|restart|status|logs} [gateway|app-server|webui|all]" >&2
    exit 2
    ;;
esac
