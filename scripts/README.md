# 项目脚本

本目录保存 npm CLI 和开发流程调用的 Node.js、Shell 脚本。脚本处理本机配置、构建、协议生成和服务管理，不承载 Gateway 的会话业务逻辑。

## 配置与 Workspace

- `runtime-config.mjs`：解析用户数据目录和运行时路径，并初始化 `.codex-connect`。
- `setup.mjs`：使用 `@clack/prompts` 提供统一设置类别菜单，并从“通讯渠道”把流程委派给具体适配器。
- `telegram-setup.mjs`：独立完成 Telegram Bot Token 验证、一次性私聊配对、用户 ID 获取和用户配置写入；
  交互输入的 Token 在当前终端明文显示，但验证错误继续脱敏；新建 Bot 仅引导使用官方 BotFather。
- `workspace-config.mjs`：读取、检查和原子更新 TOML 中的 Workspace 配置，通过 `runtime/config-event-queue.mjs` 保证 Gateway 重启窗口内的 Workspace 新增通知可恢复；支持列出失效项、删除注册记录，并恢复固定默认 Workspace。
- `workspace-add.mjs`：把指定目录或命令调用目录注册为 Workspace，支持 `--prune-missing` 清理失效配置。

## 开发与协议

- `dev-all.mjs`：开发模式下复用或启动 App Server，再启动 Gateway。
- `codex-remote.mjs`：为原生 `codex --remote` 选择 Socket 和工作目录。
- `generate-protocol.mjs`：调用当前 Codex CLI 重新生成协议类型和版本记录，并同步 npm/Gateway 版本。
- `check-protocol.mjs`：校验本机 Codex CLI 与锁定协议版本一致。
- `check-gateway-version.mjs`：校验 npm 包和 Gateway 版本都与 Codex CLI 协议版本一致。
- `check-docs.mjs`：校验 Markdown 本地链接、根文档索引、源码模块索引和相关目录文件索引，并拒绝已移除的文档名称。
- `codex-rules.mjs`：向 CLI 重新导出 `runtime/project-rules.mjs` 的项目定位、规则生成与检查能力。
- `install-git-hooks.mjs`：只为当前源码仓库设置 `.githooks`，不修改用户全局 Git 配置。
- `verify-commit.mjs`：为 pre-commit hook 与 GitHub CI 串行执行统一的完整提交检查。
- `validate-config.mjs`：在安装系统服务前使用已构建的 Gateway 配置模块执行完整校验。

## 构建、打包与服务

- `clean-dist.mjs`：构建前清理 `dist/`。
- `package-path.mjs`：提供不依赖第三方包的 npm 包根目录解析。
- `prepare-package.mjs`：源码仓库安装或 npm 打包前按 lockfile 补齐缺失的本地构建依赖、
  启用仓库 Git hooks、构建源码，并验证已安装包包含运行入口。
- `smoke-source-prepare.mjs`：在不含 `node_modules` 和 `dist` 的临时源码副本中验证 prepare。
- `smoke-package.mjs`：生成实际 tarball，在隔离目录安装并执行公开的 `codexc` 入口与配置预检。
- `check-release-tag.mjs`：要求 Git Tag 与 `package.json` 版本严格一致，防止发布错版。
- `sync-gateway-version.mjs`：以锁定的 Codex CLI 协议版本同步 `package.json`、锁文件和 Gateway 运行时版本；不维护独立版本号。
- `doctor.mjs`：检查 npm 包、Node、Codex CLI、当前 TOML 配置、Workspace、Unix WebSocket 与系统服务状态，不输出敏感配置内容。
- `install-launchd.mjs`：渲染并安装 launchd plist；代理由 CLI 服务入口在每次启动时解析。
- `launchd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载两个 launchd 服务；检测到不支持的旧标签时明确拒绝启动，日常重启只更新 Gateway，保持共享 App Server 和活动 Turn 运行。
- `install-systemd.mjs`：渲染并安装 Linux systemd 用户服务 unit；代理由 CLI 服务入口在每次启动时解析。
- `systemd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载两个 systemd 用户服务；日常重启只更新 Gateway，用户数据始终保留。

脚本不得把凭据写入 npm 安装目录；用户配置、SQLite、配置事件队列、Socket 和日志必须留在用户级 `.codex-connect`。
