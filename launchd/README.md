# launchd 服务模板

本目录保存 macOS 用户级 launchd 模板，用于把 Codex App Server、多 Surface Gateway、WebUI
与指标中心安装为四个独立进程。

## 文件

- `com.hegenai.codex-app-server.plist.template`：启动共享 Codex App Server，并监听私有 Unix Socket。
- `com.hegenai.codex-gateway.plist.template`：启动连接该 Socket 的 Gateway。
- `com.hegenai.codex-webui.plist.template`：启动只读指标 WebUI，读取 `[webui]` 配置。
- `com.hegenai.codex-center.plist.template`：启动多设备指标中心服务，读取 `[metrics.center]` 配置。

模板中的占位符由 `scripts/install-launchd.mjs` 写入实际路径和运行环境。服务都通过 CLI
服务入口启动，并在每次启动时按 TOML、标准环境变量和 macOS 系统代理的顺序解析代理，不把
自动发现的地址固化到 plist。安装流程加载 App Server 与 Gateway 服务，WebUI plist 只生成不
自动加载；若检测到不支持的其他标签仍在运行则明确拒绝，避免多个 Gateway 同时轮询。卸载时保留
用户配置与运行数据。不要在模板中写入 Token、用户目录或机器相关绝对路径。Gateway 的停止和重启
不得终止共享 App Server。

日常管理统一使用 `codexc service`。启停、重启、状态和日志可选择 `gateway`、`app-server`、
`webui`、`center` 或 `all`；WebUI 与指标中心独立于 `all`，安装时只生成 plist 不自动
启动。不写目标时，启停和状态默认 `all`，重启和日志默认 `gateway`。

验证模板：

```bash
plutil -lint launchd/*.plist.template
```
