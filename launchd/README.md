# launchd 服务模板

本目录保存 macOS 用户级 launchd 模板，用于把 Codex App Server 与 Telegram Gateway 安装为两个独立进程。

## 文件

- `com.hegenai.codex-app-server.plist.template`：启动共享 Codex App Server，并监听私有 Unix Socket。
- `com.hegenai.codex-gateway.plist.template`：启动连接该 Socket 的 Gateway。

模板中的占位符由 `scripts/install-launchd.mjs` 写入实际路径和运行环境。两个服务都通过 CLI
服务入口启动，并在每次启动时按 TOML、标准环境变量和 macOS 系统代理的顺序解析代理，不把
自动发现的地址固化到 plist。安装流程加载 `com.hegenai.*` 服务；若检测到不支持的其他标签仍在运行则明确拒绝，避免多个 Gateway 同时轮询。卸载时保留用户配置与运行数据。不要在模板中写入 Token、用户目录或机器相关绝对路径。Gateway 的停止和重启不得终止共享 App Server。

验证模板：

```bash
plutil -lint launchd/*.plist.template
```
