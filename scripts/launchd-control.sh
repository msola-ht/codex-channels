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
    ;;
  stop)
    launchctl bootout "$user_domain/$gateway_label" 2>/dev/null || true
    launchctl bootout "$user_domain/$app_label" 2>/dev/null || true
    ;;
  restart)
    launchctl kickstart -k "$user_domain/$app_label"
    launchctl kickstart -k "$user_domain/$gateway_label"
    ;;
  status)
    launchctl print "$user_domain/$app_label" 2>/dev/null || true
    launchctl print "$user_domain/$gateway_label" 2>/dev/null || true
    ;;
  *)
    print -u2 "用法：$0 {start|stop|restart|status}"
    exit 2
    ;;
esac
