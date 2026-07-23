# Codex Connect Gateway

通过 Telegram 连接本机 Codex App Server。Telegram 与原生 Codex TUI 使用同一个 App Server，共享 Thread、运行状态和历史；项目不读取 `~/.codex/sessions`，也不复制完整会话。

当前版本要求 `codex-cli 0.145.0`，npm 包与 Gateway 直接使用同一版本号 `0.145.0`，不维护独立版本；版本不匹配时 Gateway 会拒绝启动。

## 功能

- 在 Telegram 中发送文本和 PNG/JPEG 图片。
- 查看 Codex 流式回复、格式化最终回复、操作过程、计划、Diff、用量和额度；长文本自动折叠，超长代码以预览加完整文件发送；每轮结束显示上下文、当前模型、思考强度、Fast 模式和周限。
- Telegram 通知按逻辑事件降噪：过程、状态、上下文和后续分片静默发送；最终回复、审批、用户输入与严重错误保留提醒。
- Gateway 启动时通知当前系统、版本、App Server 返回的上游 User-Agent、本地连接方式、Workspace、Thread、模型、思考强度、Fast 模式和周限。
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
TELEGRAM_MESSAGE_FORMAT=html
```

最终回复默认把常用 Markdown 安全转换为兼容性更好的 Telegram HTML。支持 Rich Messages
的客户端可设置 `TELEGRAM_MESSAGE_FORMAT=rich`；修改后执行 `codexc service reload`，
Gateway 会自动重启。

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
codexc ws add --prune-missing    # 清理失效 Workspace 并注册当前目录
codexc ws add --restore-default  # 恢复固定默认 Workspace
codexc ws remove <序号|ID|名称>   # 删除 Workspace 注册，不删除目录
codexc remote                    # 在当前目录启动原生 Codex TUI
codexc remote resume             # 恢复当前目录的原生会话
codexc service reload            # 立即热加载配置，必要时自动重启 Gateway
codexc service restart           # 只重启 Gateway
codexc service logs              # 查看 Gateway 最近 100 行日志
codexc service logs -f           # 持续跟踪后台日志
codexc service logs --service all # 同时查看 App Server 与 Gateway
codexc service uninstall         # 卸载服务并保留用户数据
```

用户配置、Workspace Registry、SQLite、配置事件队列、Socket、日志和上传图片均位于 `~/.codex-connect`，不会写入全局 npm 包目录。`CODEX_CONNECT_HOME` 可用于隔离测试或多 Profile。

macOS 从旧版本升级后执行一次 `codexc service install`，安装器会将旧 `com.msola.*` launchd Job 迁移到 `com.hegenai.*`，并保留用户数据。Linux 使用 `systemctl --user` 管理两个独立服务，`service restart` 只重启 Gateway。

`codexc service logs` 默认显示 Gateway 日志；使用 `--service app-server` 查看 App Server，使用 `--service all` 查看两者。`-n 200` 可调整显示行数，`-f` 可持续跟踪。macOS 默认忽略早于正常日志的陈旧 stderr，日志文件位于 `.codex-connect/runtime`；Linux 日志来自 systemd user journal。

Telegram 与 App Server 均采用有界退避重连；连续失败耗尽后 Gateway 会退出，由 launchd 或 systemd 自动拉起，避免进程存活但不再接收消息。

Gateway 会监测用户 `.env`：新增 Workspace 和 Telegram 允许用户会直接热加载；Workspace 新增后，Telegram 会向授权用户发送通知，并提供直接切换按钮。Workspace 新增事件会先写入 `~/.codex-connect/data/config-events.json`，Gateway 热加载或重启并通过平台 API 实际发送成功后再确认删除，因此不会因配置监听合并或重启窗口静默丢失；平台 API 重试后仍失败时保留事件，等待下次启动或 `codexc service reload`，发送后、确认前崩溃可能导致重复通知。删除允许用户会先重启 Gateway 并清理其旧 Thread 绑定；Bot Token、代理、数据库、默认模型等 Gateway 配置变化时，Gateway 会优雅退出并由 launchd 或 systemd 自动拉起，Codex App Server 保持运行。`CODEX_BINARY` 或 `CODEX_SOCKET_PATH` 涉及 App Server 服务定义，需要重新执行 `codexc service install`。配置校验失败时继续使用当前有效配置。Telegram 会通知热加载成功项、自动重启原因、需要重装的服务配置或加载失败状态，但不会发送原始配置和异常详情。可执行 `codexc service reload` 立即触发检查，无需等待文件监测。

## Telegram 命令

- 会话：`/new`、`/resume`、`/sessions`、`/archived`、`/archive`、`/unarchive`
- Workspace：`/workspace`
- Turn：`/status`、`/stop`、`/rename`、`/compact`、`/fork`、`/review`
- 模型：`/model`、`/effort`、`/fast [on|off|status]`
- 状态：`/diff`、`/plan`、`/usage`、`/limits`、`/permissions`、`/goal`
- 扩展：`/skills`、`/mcp`、`/plugins`
- 交互：`/cancel`、`/whoami`

Telegram 只能选择预配置 Workspace，不能通过消息提交任意工作目录。命令、文件和权限申请默认需要明确批准；未知或过期的高权限请求会被拒绝或取消。

如果已配置的 Workspace 目录被移动、删除或暂时不可访问，普通 `codexc ws add` 会停止并列出失效项，
避免误删暂时未挂载的目录。确认目录不再使用后，可执行 `codexc ws add --prune-missing`：
它会清理失效项、注册当前目录，并在原默认 Workspace 失效时恢复固定默认目录。
默认 Workspace 固定为 `~/.codex-connect/workspace`；清理失效的默认项时会自动重建该目录，
不会把本次添加的项目设为默认。若曾被旧版本错误改成项目目录，可执行
`codexc ws add --restore-default` 恢复，同时保留现有项目 Workspace。
`codexc ws` 会继续列出目录已不存在或无法访问的注册项并标注状态；可使用
`codexc ws remove <序号|ID|名称>` 删除对应注册记录。该命令不会删除磁盘目录，
且不能删除固定默认 Workspace。

## 架构

```text
Codex App Server（独立进程，Unix WebSocket）
├── 原生 Codex TUI
└── Codex Connect Gateway
    ├── Codex Client / Conversation Core / Session Router
    ├── Application Commands / Approval / Policy / Storage / Event Bus
    └── Telegram Surface
```

App Server 是 Thread、Turn 和 Item 的唯一事实来源。SQLite 只保存外部 conversation、Surface
账号、Workspace 与 Thread 的最小绑定。Surface 通过编译期显式注册接入；当前只启用 Telegram，
后续平台适配器通过统一命令服务和 `target + actorId` 授权上下文接入，不需要修改 Conversation Core
或 Codex Client；授权同时按 Surface 账号隔离。Application 返回结构化命令结果，平台 SDK、成功
文案、消息格式和文件传输由各自适配器实现；未知内部错误不会原样发送到外部聊天。

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
npm run lint
npm test
npm run test:coverage
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
