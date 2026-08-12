# systemd 用户服务模板

本目录保存 Linux 用户级 systemd 模板，用于把 Codex App Server、Gateway、WebUI 与指标中心
安装为四个独立进程。

## 文件

- `codex-connect-app-server.service.template`：启动共享 Codex App Server，并监听私有 Unix Socket。
- `codex-connect-gateway.service.template`：启动连接该 Socket 的 Gateway。
- `codex-connect-webui.service.template`：启动只读指标 WebUI，读取 `[webui]` 配置。
- `codex-connect-center.service.template`：启动多设备指标中心服务，读取 `[metrics.center]` 配置。

模板由 `scripts/install-systemd.mjs` 渲染到 `~/.config/systemd/user`（或 `$XDG_CONFIG_HOME/systemd/user`）。
服务都通过 CLI 服务入口启动，并在每次启动时按 TOML、systemd 用户管理器继承的标准
代理环境变量和 GNOME 手动代理的顺序解析代理，不把自动发现的地址固化到 unit。安装、启停和
卸载由 `scripts/systemd-control.sh` 完成；Gateway unit 显式标记为受监管进程，配置要求重启时
由 systemd 自动拉起。Gateway 的日常重启不会停止共享 App Server。
启停、重启、状态和日志可选择 `gateway`、`app-server`、`webui`、`center` 或 `all`；
WebUI 与指标中心独立于 `all`，安装时只生成 unit 不自动启动。不写目标时，启停和状态默认
`all`，重启和日志默认 `gateway`。

`codexc service install` 在安装 unit 前检查当前用户的 systemd linger；未启用时先尝试通过
`loginctl enable-linger` 开启并复查。无法启用或复查未生效时，安装在调用 `systemctl --user`
前失败，并显示需要管理员执行的精确命令。安装成功即表示用户管理器会在系统启动时运行，用户
尚未登录或退出 SSH 后 App Server 与 Gateway 仍可启动和继续运行。

linger 是当前用户的系统级开机属性，可能同时服务于其他用户 unit，因此卸载 Codex Connect 时不
自动关闭。用户配置和运行数据始终保留在 `~/.codex-connect`，卸载 unit 不会删除这些数据。
