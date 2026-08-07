# systemd 用户服务模板

本目录保存 Linux 用户级 systemd 模板，用于把 Codex App Server、Gateway 与 WebUI 安装为三个独立进程。

## 文件

- `codex-connect-app-server.service.template`：启动共享 Codex App Server，并监听私有 Unix Socket。
- `codex-connect-gateway.service.template`：启动连接该 Socket 的 Gateway。
- `codex-connect-webui.service.template`：启动只读指标 WebUI，读取 `[webui]` 配置。

模板由 `scripts/install-systemd.mjs` 渲染到 `~/.config/systemd/user`（或 `$XDG_CONFIG_HOME/systemd/user`）。
两个服务都通过 CLI 服务入口启动，并在每次启动时按 TOML、systemd 用户管理器继承的标准
代理环境变量和 GNOME 手动代理的顺序解析代理，不把自动发现的地址固化到 unit。安装、启停和
卸载由 `scripts/systemd-control.sh` 完成；Gateway 的日常重启不会停止共享 App Server。
启停、重启、状态和日志可选择 `gateway`、`app-server`、`webui` 或 `all`；WebUI 独立于 `all`，
安装时只生成 unit 不自动启动。不写目标时，启停和状态默认 `all`，重启和日志默认 `gateway`。

若需要用户退出 SSH 后仍保持运行或开机自动启动用户服务，请由管理员执行：

```bash
sudo loginctl enable-linger "$USER"
```

用户配置和运行数据始终保留在 `~/.codex-connect`，卸载 unit 不会删除这些数据。
