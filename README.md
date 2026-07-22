# Codex Connect Gateway

一个以 Codex App Server 为唯一会话事实来源的本机模块化网关。Telegram 与原生 Codex TUI 连接同一个独立 App Server，因此共享 Thread、活动状态和持久化历史；项目不读取 `~/.codex/sessions`，也不复制完整会话到 Telegram 数据库。

当前协议基线为 `codex-cli 0.145.0`。Gateway 启动时会严格校验版本，版本不一致时拒绝运行，升级步骤见“协议升级”。

## 架构

```text
launchd
├── Codex App Server
│   └── Unix WebSocket: .runtime/codex-app-server.sock
├── Codex 原生 TUI（按需）
│   └── codex --remote unix://...
└── TypeScript Gateway
    ├── codex-protocol / codex-client
    ├── conversation-core / session-routing
    ├── approval / policy / event-bus
    └── surfaces/telegram
```

App Server 与 Gateway 是两个独立进程。Gateway 停止不会终止 App Server；连接中断后 Gateway 会有限次数指数退避重连、重新 `initialize` 并恢复已绑定 Thread 的订阅。Telegram 网络发送通过独立有界队列处理，不阻塞 App Server Reader。任务运行时会持续显示 Telegram 原生“正在输入”状态；每个 agent message item 分别渲染为一个消息气泡，同一 item 的流式 delta 只编辑对应气泡，Turn 完成后再定稿。TG 普通消息发起或补充 Turn 时，下一条 Codex 输出通过 Telegram 原生回复关联到该消息。CLI 等外部客户端在已绑定 Thread 中发起 Turn 时，Telegram 会把外部文本渲染为引用式 `CLI 输入` 消息，下一条 Codex 输出通过 Telegram 原生回复关联到该输入；Gateway 自己发起的输入通过协议 client ID 去重，不会重复回显。

详细设计和边界见 [ARCHITECTURE_REBUILD_PROPOSAL.md](ARCHITECTURE_REBUILD_PROPOSAL.md)，项目约束见 [AGENTS.md](AGENTS.md)。

## 环境要求

- macOS 或 Linux（launchd 配置仅支持 macOS；Windows Transport 尚未适配）
- Node.js 22.13+
- 已安装并登录的 `codex-cli 0.145.0`
- Telegram Bot Token 和允许使用的 Telegram 用户 ID

## npm CLI 安装

项目以 Node.js npm 包提供两个等价命令：短命令 `codexc` 和完整命令 `codex-connect`。本机从仓库安装：

```bash
npm install -g .
```

在第一个目标项目目录初始化：

```bash
cd /absolute/path/to/first-project
codexc init
```

`codexc init` 使用 Node `os.homedir()` 在当前系统用户主目录创建 `.codex-connect`，不会把配置写进全局 npm 包：

```text
~/.codex-connect/
├── .env                         # 0600，Token、Workspace 和运行配置
├── data/gateway.sqlite3         # Telegram Workspace/Thread 最小绑定
└── runtime/
    ├── codex-app-server.sock
    └── *.log
```

编辑 `~/.codex-connect/.env`，填写 `TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_ALLOWED_USER_IDS`，然后前台运行：

```bash
codexc start
```

常用命令：

```bash
codexc config                    # 显示用户配置路径
codexc ws                        # 列出 Workspace
codexc ws add                    # 将当前目录注册为 Workspace
codexc ws add --id docs --name Docs
codexc remote                    # 启动默认 Workspace 的原生 Codex TUI
codexc remote --workspace docs
```

`CODEX_CONNECT_HOME` 可以覆盖默认用户目录，主要用于隔离测试或多 Profile；正常使用无需设置。

## 源码开发安装

```bash
npm ci
cp .env.example .env
chmod 600 .env
```

编辑 `.env`：

```dotenv
TELEGRAM_BOT_TOKEN=从_BotFather_取得的_Token
TELEGRAM_ALLOWED_USER_IDS=你的_Telegram_用户_ID
TELEGRAM_PROXY_URL=http://127.0.0.1:7890
CODEX_BINARY=codex
CODEX_WORKSPACES_JSON=[{"id":"codex-connect","name":"Codex Connect","cwd":"/Users/you/Project-skill-Codex-Connect"},{"id":"another","name":"Another Project","cwd":"/Users/you/another-project"}]
CODEX_DEFAULT_WORKSPACE=codex-connect
CODEX_SOCKET_PATH=/Users/you/Project-skill-Codex-Connect/.runtime/codex-app-server.sock
CODEX_BRIDGE_SANDBOX=workspace-write
APPROVAL_TIMEOUT_SECONDS=300
STATE_DATABASE_PATH=./data/gateway.sqlite3
LOG_LEVEL=info
```

`CODEX_WORKSPACES_JSON` 必须是非空 JSON 数组；每项包含唯一的 `id`、展示名称 `name` 和已存在的绝对目录 `cwd`。`CODEX_DEFAULT_WORKSPACE` 必须引用其中一个 ID。Telegram 只能通过 `/workspace` 选择这些预配置目录，不能通过聊天提交任意工作目录。Socket 父目录由安装脚本创建并设为 `0700`。

源码开发模式也可以从目标项目目录直接注册当前目录，无需手工编辑 JSON：

```bash
cd /absolute/path/to/target-project
npm --prefix /Users/you/Project-skill-Codex-Connect run workspace:add
```

命令通过 npm 的 `INIT_CWD` 读取执行时所在目录，默认使用目录名作为展示名称并生成 Workspace ID；同一路径重复执行不会重复添加。需要自定义时使用：

```bash
npm --prefix /Users/you/Project-skill-Codex-Connect run workspace:add -- \
  --id target-project --name "Target Project"
```

注册会原子更新 Gateway 的 `.env`。重启 Gateway 后，在 Telegram 发送 `/workspace` 即可选择新目录。该命令是本机可信管理入口，Telegram 仍不能提交任意路径。

`STATE_DATABASE_PATH` 只保存 Telegram chat 当前选择的 Workspace 及其 Codex Thread 绑定，不保存消息、Turn、Item 或会话历史。Gateway 启动后会通过 `thread/resume` 验证并恢复绑定，因此 `/resume` 可以继续标记 `← 当前`。数据库父目录权限固定为 `0700`，文件权限为 `0600`。当前开发版使用 SQLite Schema v2，不兼容旧 v1 状态库；升级后停止 Gateway 并删除旧数据库即可，Codex 原生 Thread 不受影响。

## 本地前台运行

最简单的测试启动方式：

```bash
npm run dev:all
```

它会复用已经存在的共享 Socket；如果 Socket 不存在，则启动一个开发用 App Server，再启动 Gateway。按 `Ctrl+C` 停止本次启动的两个进程。Gateway 的正式实现仍不负责 App Server 生命周期。

需要分别观察进程时，也可以手工启动：

先启动共享 App Server：

```bash
mkdir -p .runtime
chmod 700 .runtime
codex app-server --listen unix://"$PWD/.runtime/codex-app-server.sock"
```

另一个终端启动 Gateway：

```bash
npm run dev
```

原生 Codex TUI 连接同一个 App Server：

```bash
npm run remote
```

连接指定 Workspace：

```bash
npm run remote -- --workspace another
```

也可以直接运行：

```bash
codex --remote unix:///absolute/path/codex-app-server.sock -C /absolute/workdir
```

## launchd 常驻运行（macOS）

npm CLI 安装后使用：

```bash
codexc service install
codexc service status
codexc service restart
codexc service stop
codexc service uninstall
```

`service install` 生成并启动 App Server 与 Gateway 两个独立的用户级 launchd 服务；重复执行时会先卸载旧实例，再加载新 plist。Linux 当前没有系统服务安装器，可使用 `codexc start` 前台运行。用户配置目录解析本身不依赖 macOS，但 Windows 尚未适配当前 Unix WebSocket Transport，暂不属于可运行平台。

`service uninstall` 会停止并删除两个 launchd 服务配置，但保留 `~/.codex-connect` 下的配置、Workspace、SQLite 状态和日志；重新执行 `codexc service install` 即可恢复常驻服务。

安装器会把 Node 与 Codex 的绝对路径及受控 `PATH` 写入 plist，不依赖 fnm、nvm 等交互式 Shell 初始化。安装完成后可直接运行 `codexc remote resume` 连接共享 App Server 并打开会话选择器。

源码开发模式也保留原有 npm 命令：

首次安装并启动只需要：

```bash
npm run service:setup
```

以后使用：

```bash
npm run service:start
npm run service:restart
npm run service:status
npm run service:stop
npm run service:uninstall
```

安装脚本只把渲染后的 plist 写入 `~/Library/LaunchAgents`，不会把 Token 写入 plist。npm CLI 模式读取 `~/.codex-connect/.env` 并把日志写入 `~/.codex-connect/runtime`；源码开发模式继续读取仓库 `.env`，日志位于其配置的 Socket 父目录。

## Telegram 命令

- `/resume [序号|名称|Thread ID]`：列出或恢复当前工作目录下的原生 Codex Thread
- `/workspace [序号|ID|名称]`：列出或切换服务端预配置的 Workspace；切换时解除旧 Thread 绑定
- `/new`：解除并删除当前持久化绑定，下一条普通消息创建新 Thread
- `/status`：查看当前 Thread、Turn、工作目录及 App Server 已推送的 Thread Token 统计
- `/stop`：中断活动 Turn
- `/rename <名称>`、`/compact`、`/fork`
- `/review [branch <分支>|commit <SHA>|custom <说明>]`
- `/model`、`/skills`、`/mcp`、`/plugins`
- `/usage`：显示账号级 Token 汇总（M）和最近 7 个有数据日期的每日用量
- `/limits`：显示套餐、主/次额度窗口、重置时间、Credits 和限流状态
- `/permissions`
- `/goal [set <目标>|clear]`
- `/cancel`：取消当前审批、用户输入或 MCP 交互
- `/whoami`：显示 Telegram 用户 ID

普通文本会发送给当前 Thread；若当前 Turn 正在执行，则通过 `turn/steer` 追加。首次消息会在当前 Workspace 的 `cli`、`vscode`（当前版本 Remote TUI 的来源标记）和 `appServer` 来源中选择最近的空闲且未绑定 Thread；不会自动接入活动 Thread。切换 Workspace 前必须等待当前 Turn 结束或先 `/stop`。

当前 Workspace 选择与 Thread 绑定会写入本机 StateStore。Gateway 重启后会恢复有效绑定；如果对应 Thread 已删除或无法恢复，Thread 绑定会自动清理，但仍保留有效的 Workspace 选择。配置中已删除的 Workspace 会回退到默认 Workspace。

## 审批和安全

- 命令、文件修改、临时权限、用户输入和 MCP elicitation 由发起 Turn 的 Gateway 连接处理。
- 无法映射、过期或未知的高权限请求默认拒绝或取消。
- Telegram 回调令牌随机生成、一次性使用并有超时；临时权限默认只作用于当前 Turn。
- CLI 等其他客户端处理审批后，`serverRequest/resolved` 会立即使 Telegram 按钮失效并标记为已在其他客户端处理。
- 连接断开会取消悬挂交互，不把旧审批带到新连接。
- 日志对 Token 和 Authorization 字段脱敏。
- 本机只监听私有 Unix Socket，不开放无认证 TCP 地址。

## 开发与验证

```bash
npm run check
npm test
npm run build
npm run protocol:check
```

真实 Unix WebSocket/App Server 冒烟测试不会调用模型：

```bash
RUN_CODEX_INTEGRATION=1 npm test -- --run gateway/tests/real-app-server.test.ts
```

验证 launchd 模板语法：

```bash
plutil -lint launchd/*.plist.template
```

## 协议升级

先升级 Codex CLI，再重新生成协议：

```bash
npm run protocol:generate
npm run protocol:check
npm run check
npm test
RUN_CODEX_INTEGRATION=1 npm test -- --run gateway/tests/real-app-server.test.ts
```

生成物位于 `gateway/src/codex-protocol/generated`，对应版本记录在 `gateway/src/codex-protocol/version.json`。生成文件不得手工修改。

## 当前状态

仓库已经切换为单一 TypeScript Gateway；旧 Python Runtime、测试、smoke 脚本和打包入口已移除。CLI/Remote TUI 与 Telegram 双向恢复原生 Codex Thread 已完成真实验证。Gateway 支持从服务端预配置列表安全切换 Workspace，所有 Thread 查询和 Turn 均使用所选 Workspace 的 `cwd`。正式本机入口为 npm CLI `codexc`，运行数据位于 `~/.codex-connect`；源码开发仍可使用项目内 `.env` 和 `npm run dev:all`。macOS 支持 `codexc service install` 安装两个独立 launchd 服务。
