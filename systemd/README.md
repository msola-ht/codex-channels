# systemd 用户服务模板

本目录保存 Linux 用户级 systemd 模板，用于把 Codex App Server 与 Gateway 安装为两个独立进程。

## 文件

- `codex-connect-app-server.service.template`：启动共享 Codex App Server，并监听私有 Unix Socket。
- `codex-connect-gateway.service.template`：启动连接该 Socket 的 Gateway。

模板由 `scripts/install-systemd.mjs` 渲染到 `~/.config/systemd/user`（或 `$XDG_CONFIG_HOME/systemd/user`）。安装、启停和卸载由 `scripts/systemd-control.sh` 完成；Gateway 的日常重启不会停止共享 App Server。

若需要用户退出 SSH 后仍保持运行或开机自动启动用户服务，请由管理员执行：

```bash
sudo loginctl enable-linger "$USER"
```

用户配置和运行数据始终保留在 `~/.codex-connect`，卸载 unit 不会删除这些数据。
