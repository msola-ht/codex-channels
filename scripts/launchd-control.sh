#!/bin/zsh
set -euo pipefail

action="${1:-status}"
user_domain="gui/$(id -u)"
agents_dir="$HOME/Library/LaunchAgents"
app_label="com.msola.codex-app-server"
gateway_label="com.msola.codex-gateway"

case "$action" in
  start)
    launchctl bootstrap "$user_domain" "$agents_dir/$app_label.plist" 2>/dev/null || true
    launchctl bootstrap "$user_domain" "$agents_dir/$gateway_label.plist" 2>/dev/null || true
    launchctl kickstart -k "$user_domain/$app_label"
    launchctl kickstart -k "$user_domain/$gateway_label"
    print "Codex App Server 与 Gateway 已启动。"
    ;;
  stop)
    launchctl bootout "$user_domain/$gateway_label" 2>/dev/null || true
    launchctl bootout "$user_domain/$app_label" 2>/dev/null || true
    print "Codex App Server 与 Gateway 已停止。"
    ;;
  uninstall)
    launchctl bootout "$user_domain/$gateway_label" 2>/dev/null || true
    launchctl bootout "$user_domain/$app_label" 2>/dev/null || true
    /bin/rm -f "$agents_dir/$gateway_label.plist" "$agents_dir/$app_label.plist"
    print "Codex App Server 与 Gateway launchd 服务已卸载。"
    print "用户配置与运行数据保留在 ~/.codex-connect。"
    ;;
  restart)
    launchctl bootout "$user_domain/$gateway_label" 2>/dev/null || true
    launchctl bootout "$user_domain/$app_label" 2>/dev/null || true
    launchctl bootstrap "$user_domain" "$agents_dir/$app_label.plist"
    launchctl bootstrap "$user_domain" "$agents_dir/$gateway_label.plist"
    launchctl kickstart -k "$user_domain/$app_label"
    launchctl kickstart -k "$user_domain/$gateway_label"
    print "Codex App Server 与 Gateway 已重启。"
    ;;
  status)
    launchctl print "$user_domain/$app_label" 2>/dev/null || true
    launchctl print "$user_domain/$gateway_label" 2>/dev/null || true
    ;;
  *)
    print -u2 "用法：$0 {start|stop|restart|status|uninstall}"
    exit 2
    ;;
esac
