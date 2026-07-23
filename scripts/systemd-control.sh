#!/bin/sh
set -eu

action="${1:-status}"
systemctl_binary="${SYSTEMCTL_BINARY:-systemctl}"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
units_dir="$config_home/systemd/user"
app_unit="codex-connect-app-server.service"
gateway_unit="codex-connect-gateway.service"

systemctl_user() {
  "$systemctl_binary" --user "$@"
}

case "$action" in
  install)
    systemctl_user daemon-reload
    systemctl_user enable "$app_unit" "$gateway_unit"
    systemctl_user restart "$app_unit"
    systemctl_user restart "$gateway_unit"
    printf '%s\n' "Codex App Server 与 Gateway systemd 用户服务已安装并启动。"
    ;;
  start)
    systemctl_user start "$app_unit"
    systemctl_user start "$gateway_unit"
    printf '%s\n' "Codex App Server 与 Gateway 已启动。"
    ;;
  stop)
    systemctl_user stop "$gateway_unit"
    systemctl_user stop "$app_unit"
    printf '%s\n' "Codex App Server 与 Gateway 已停止。"
    ;;
  restart)
    systemctl_user restart "$gateway_unit"
    printf '%s\n' "Gateway 已重启；Codex App Server 保持运行。"
    ;;
  status)
    systemctl_user --no-pager status "$app_unit" "$gateway_unit" || true
    ;;
  uninstall)
    systemctl_user disable --now "$gateway_unit" "$app_unit" 2>/dev/null || true
    rm -f "$units_dir/$gateway_unit" "$units_dir/$app_unit"
    systemctl_user daemon-reload
    systemctl_user reset-failed "$gateway_unit" "$app_unit" 2>/dev/null || true
    printf '%s\n' "Codex App Server 与 Gateway systemd 用户服务已卸载。"
    printf '%s\n' "用户配置与运行数据保留在 ~/.codex-connect。"
    ;;
  *)
    printf '%s\n' "用法：$0 {install|start|stop|restart|status|uninstall}" >&2
    exit 2
    ;;
esac
