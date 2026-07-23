# Codex Connect Gateway

通过 Telegram 连接本机 Codex App Server。Telegram 与原生 Codex TUI 使用同一个 App Server，共享 Thread、运行状态和历史；项目不读取 `~/.codex/sessions`，也不复制完整会话。

当前版本要求 `codex-cli 0.145.0`，npm 包与 Gateway 直接使用同一版本号 `0.145.0`，不维护独立版本；版本不匹配时 Gateway 会拒绝启动。

## 功能

- 在 Telegram 中发送文本和 PNG/JPEG 图片。
- 查看 Codex 流式回复、操作过程、计划、Diff、用量和额度。
- 处理命令、文件修改、临时权限、用户输入及 MCP 审批。
- 在预配置 Workspace 间切换，并与原生 TUI 双向恢复 Thread。
- 使用私有 Unix WebSocket；Gateway 与 App Server 独立运行。

## 环境要求

- macOS 或 Linux；Windows Transport 尚未实现。
- Node.js 22.13 或更高版本。
- 已安装并登录 `codex-cli 0.145.0`。
- Telegram Bot Token 和允许使用的 Telegram 用户 ID。

Codex CLI 需要单独安装：

```bash
npm install -g @openai/codex@0.145.0
```

## 快速开始

安装 Codex Connect：

```bash
npm install -g @hegenai/codexc
codexc init
codexc setup
```

`codexc setup` 会引导通过官方 `@BotFather` 新建 Bot 或填写已有 Bot Token，验证 Token，并通过一次性 `/start` 配对链接自动获取 Telegram 用户 ID。复用当前 Bot 时默认保留已有用户允许名单，避免与运行中的 Gateway 争抢 Telegram 长轮询。该流程不依赖第三方机器人创建服务。也可以直接编辑 `~/.codex-connect/.env`，至少填写：

```dotenv
TELEGRAM_BOT_TOKEN=你的_Bot_Token
TELEGRAM_ALLOWED_USER_IDS=你的_Telegram_用户_ID
```

注册需要通过 Telegram 使用的项目目录：

```bash
cd /absolute/path/to/project
codexc ws add
```

macOS 或 Linux 安装常驻用户服务：

```bash
codexc service install
codexc service status
```

Linux 如需退出 SSH 后仍保持运行或开机启动，还需执行一次：

```bash
sudo loginctl enable-linger "$USER"
```

`codexc start` 仍可用于临时前台运行。

安装或升级后运行诊断：

```bash
codexc doctor
```

`doctor` 会检查 Node、Codex CLI、配置权限、Telegram 必填项、Workspace、App Server 握手和系统服务状态，但不会显示 Token。

## 常用命令

```bash
codexc config                    # 显示配置路径
codexc setup                     # 配置 Telegram Bot 和允许的用户 ID
codexc doctor                    # 运行安装与连通性诊断
codexc ws                        # 列出 Workspace
codexc ws add                    # 注册当前目录
codexc remote                    # 在当前目录启动原生 Codex TUI
codexc remote resume             # 恢复当前目录的原生会话
codexc service reload            # 立即热加载配置，必要时自动重启 Gateway
codexc service restart           # 只重启 Gateway
codexc service logs              # 查看 Gateway 最近 100 行日志
codexc service logs -f           # 持续跟踪后台日志
codexc service logs --service all # 同时查看 App Server 与 Gateway
codexc service uninstall         # 卸载服务并保留用户数据
```

用户配置、Workspace Registry、SQLite、Socket、日志和上传图片均位于 `~/.codex-connect`，不会写入全局 npm 包目录。`CODEX_CONNECT_HOME` 可用于隔离测试或多 Profile。

macOS 从旧版本升级后执行一次 `codexc service install`，安装器会将旧 `com.msola.*` launchd Job 迁移到 `com.hegenai.*`，并保留用户数据。Linux 使用 `systemctl --user` 管理两个独立服务，`service restart` 只重启 Gateway。

`codexc service logs` 默认显示 Gateway 日志；使用 `--service app-server` 查看 App Server，使用 `--service all` 查看两者。`-n 200` 可调整显示行数，`-f` 可持续跟踪。macOS 默认忽略早于正常日志的陈旧 stderr，日志文件位于 `.codex-connect/runtime`；Linux 日志来自 systemd user journal。

Telegram 与 App Server 均采用有界退避重连；连续失败耗尽后 Gateway 会退出，由 launchd 或 systemd 自动拉起，避免进程存活但不再接收消息。

Gateway 会监测用户 `.env`：新增 Workspace 和 Telegram 允许用户会直接热加载；删除允许用户会先重启 Gateway 并清理其旧 Thread 绑定；Bot Token、代理、数据库、默认模型等 Gateway 配置变化时，Gateway 会优雅退出并由 launchd 或 systemd 自动拉起，Codex App Server 保持运行。`CODEX_BINARY` 或 `CODEX_SOCKET_PATH` 涉及 App Server 服务定义，需要重新执行 `codexc service install`。配置校验失败时继续使用当前有效配置。可执行 `codexc service reload` 立即触发检查，无需等待文件监测。

## Telegram 命令

- 会话：`/new`、`/resume`、`/sessions`、`/archived`、`/archive`、`/unarchive`
- Workspace：`/workspace`
- Turn：`/status`、`/stop`、`/rename`、`/compact`、`/fork`、`/review`
- 模型：`/model`、`/effort`
- 状态：`/diff`、`/plan`、`/usage`、`/limits`、`/permissions`、`/goal`
- 扩展：`/skills`、`/mcp`、`/plugins`
- 交互：`/cancel`、`/whoami`

Telegram 只能选择预配置 Workspace，不能通过消息提交任意工作目录。命令、文件和权限申请默认需要明确批准；未知或过期的高权限请求会被拒绝或取消。

## 架构

```text
Codex App Server（独立进程，Unix WebSocket）
├── 原生 Codex TUI
└── Codex Connect Gateway
    ├── Codex Client / Conversation Core / Session Router
    ├── Approval / Policy / Storage / Event Bus
    └── Telegram Surface
```

App Server 是 Thread、Turn 和 Item 的唯一事实来源。SQLite 只保存 Telegram conversation、Workspace 与 Thread 的最小绑定。

详细设计见 [ARCHITECTURE_REBUILD_PROPOSAL.md](ARCHITECTURE_REBUILD_PROPOSAL.md)，项目约束见 [AGENTS.md](AGENTS.md)。

## 源码开发

```bash
npm ci
cp .env.example .env
chmod 600 .env
npm run dev:all
```

常用验证：

```bash
npm run check
npm test
npm run test:package
npm run protocol:check
```

真实 App Server 冒烟测试不会调用模型：

```bash
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

## 目录文档

- [`src/`](src/README.md)：源码模块与边界。
- [`bin/`](bin/README.md)：npm CLI 入口。
- [`scripts/`](scripts/README.md)：配置、协议、打包和服务脚本。
- [`launchd/`](launchd/README.md)：macOS 服务模板与迁移。
- [`systemd/`](systemd/README.md)：Linux 用户服务模板与运行说明。
- [`tests/`](tests/README.md)：测试范围与真实集成测试。
- [`.github/workflows/`](.github/workflows/README.md)：CI 与 npm Trusted Publishing。

## License

[MIT](LICENSE)
