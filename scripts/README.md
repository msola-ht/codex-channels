# 项目脚本

本目录保存 npm CLI 和开发流程调用的 Node.js、Shell 脚本。脚本处理本机配置、构建、协议生成和服务管理，不承载 Gateway 的会话业务逻辑。

## 配置与 Workspace

- `runtime-config.mjs`：解析包目录、用户数据目录和运行时路径，并初始化 `.codex-connect`。
- `telegram-setup.mjs`：独立完成 Telegram Bot Token 验证、一次性私聊配对、用户 ID 获取和用户配置写入；新建 Bot 仅引导使用官方 BotFather。
- `workspace-config.mjs`：读取和原子更新环境文件中的 Workspace 配置。
- `workspace-add.mjs`：把指定目录或命令调用目录注册为 Workspace。

## 开发与协议

- `dev-all.mjs`：开发模式下复用或启动 App Server，再启动 Gateway。
- `codex-remote.mjs`：为原生 `codex --remote` 选择 Socket 和工作目录。
- `codex-remote.sh`：兼容性的 Shell 转发入口。
- `generate-protocol.mjs`：调用当前 Codex CLI 重新生成协议类型和版本记录，并同步 npm/Gateway 版本。
- `check-protocol.mjs`：校验本机 Codex CLI 与锁定协议版本一致。
- `check-gateway-version.mjs`：校验 npm 包和 Gateway 版本都与 Codex CLI 协议版本一致。

## 构建、打包与服务

- `clean-dist.mjs`：构建前清理 `dist/`。
- `prepare-package.mjs`：npm 打包前构建源码，并验证已安装包包含运行入口。
- `smoke-package.mjs`：生成实际 tarball，在隔离目录安装并执行两个公开 CLI 入口。
- `check-release-tag.mjs`：要求 Git Tag 与 `package.json` 版本严格一致，防止发布错版。
- `sync-gateway-version.mjs`：以锁定的 Codex CLI 协议版本同步 `package.json`、锁文件和 Gateway 运行时版本；不维护独立版本号。
- `doctor.mjs`：检查 npm 包、Node、Codex CLI、用户配置、Workspace、Unix WebSocket 与系统服务状态，不输出敏感配置内容。
- `install-launchd.mjs`：渲染并安装 launchd plist。
- `launchd-control.sh`：安装、启停、热加载、查看和卸载两个 launchd 服务；安装时清理旧标签，日常重启只更新 Gateway，保持共享 App Server 和活动 Turn 运行。
- `install-systemd.mjs`：渲染并安装 Linux systemd 用户服务 unit。
- `systemd-control.sh`：安装、启停、热加载、查看和卸载两个 systemd 用户服务；日常重启只更新 Gateway，用户数据始终保留。

脚本不得把凭据写入 npm 安装目录；用户配置、SQLite、Socket 和日志必须留在用户级 `.codex-connect`。
