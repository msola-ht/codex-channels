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
    ├── application / conversation-core / session-routing
    ├── approval / policy / event-bus
    └── surfaces/telegram
```

`application` 负责跨模块用例编排，`conversation-core` 只归约 Thread、Turn 和 Item 状态，并通过窄端口查询会话路由；具体 Transport、SQLite 和 Telegram 实现仅在 `bootstrap` 组合。

仓库是单一 npm 包：业务源码位于根目录 `src/`，测试位于 `tests/`，构建入口为 `dist/main.js`。模块边界通过目录和自动化测试约束，不使用额外的 `gateway/` 包装层。

App Server 与 Gateway 是两个独立进程。Gateway 停止不会终止 App Server；连接中断后 Gateway 会有限次数指数退避重连、重新 `initialize` 并恢复已绑定 Thread 的订阅。Telegram 网络发送通过独立有界队列处理，不阻塞 App Server Reader。任务运行超过短暂延迟后会持续显示 Telegram 原生“正在输入”状态；收到第一批流式 delta 后发送正式消息，后续 delta 限速编辑同一消息，`item/completed` 再用权威文本定稿。`commentary` 进度与 `final_answer` 最终答复分开渲染，第一条最终答复通过 Telegram 原生回复关联到发起该 Turn 的输入；每轮结束后再显示 App Server 报告的当前上下文用量与模型窗口占比。CLI 等外部客户端在已绑定 Thread 中发起 Turn 时，Telegram 会把外部文本渲染为引用式 `CLI 输入` 消息；Gateway 自己发起的输入通过协议 client ID 去重，不会重复回显。连接断开会停止后续编辑和“正在输入”状态，已经发出的正式消息仍保留。

命令执行、文件修改、MCP/App 工具、网页搜索、图片操作、子代理和 Plan 等 App Server Item 会在 Telegram 中按回复分段为“操作过程”消息，并限速更新运行、完成或失败状态；Codex 每开始一段回复就定稿前一段操作，后续新操作另发消息，因此时间线可以按“过程 → 回复 → 过程 → 回复”交替展示。消息使用图标标题、命令代码块和路径/工具引用块呈现，连续且内容相同的操作会合并显示次数。操作过程不展示完整 stdout 或工具参数；可见命令会清洗常见 Token、密码、Cookie、Authorization 和 URL 凭据，过长记录只保留最近操作。

Telegram 审批、用户输入和 MCP elicitation 与普通回复共用同一聊天输出队列。交互卡片发送前会先冲刷已经生成的回复与此前操作；当前等待审批的命令或文件操作会暂存，只有用户批准且审批卡先更新状态后才显示，拒绝或超时则不显示。因此同一聊天按“说明 → 审批 → 用户选择 → 后续操作与输出”的顺序展示。

Gateway 还归约 App Server 的稳定 `turn/diff/updated` 与 `turn/plan/updated` 通知；Telegram 可用 `/diff` 和 `/plan` 查看当前 Thread 最近 Turn 的聚合 Diff 与计划状态。它们只保存在进程内用于界面展示，Gateway 重启后清空；不会写入 SQLite，也不会复制 App Server 历史。账户认证变化、额度达到 80%/90%/100% 阈值或进入限流状态，以及 MCP Server 启动状态变化，会通过同一有界输出队列发送简洁通知；重复状态会被合并。

Gateway 已连接 App Server 且 Telegram Bot 完成鉴权后，会向 `TELEGRAM_ALLOWED_USER_IDS` 中的每个用户发送一次启动联通通知，包含该用户当前选择的 Workspace（未选择时为默认 Workspace）、工作目录、当前模型、思考强度和完整 Workspace 列表。用户尚未与 Bot 建立私聊等原因导致通知发送失败时，只记录告警，不影响 Gateway 和 Long Polling 继续运行。

详细设计和边界见 [ARCHITECTURE_REBUILD_PROPOSAL.md](ARCHITECTURE_REBUILD_PROPOSAL.md)，项目约束见 [AGENTS.md](AGENTS.md)。

## 目录索引

- [`src/`](src/README.md)：Gateway 业务源码与模块边界。
- [`bin/`](bin/README.md)：npm CLI 入口与命令分发。
- [`scripts/`](scripts/README.md)：开发、配置、协议、打包和服务管理脚本。
- [`launchd/`](launchd/README.md)：macOS 双进程服务模板。
- [`tests/`](tests/README.md)：单元、契约和条件式真实集成测试。
- [`.github/workflows/`](.github/workflows/README.md)：GitHub Actions 自动验证。

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

初始化用户配置，然后在需要通过 Telegram 使用的项目目录注册 Workspace：

```bash
codexc init
cd /absolute/path/to/first-project
codexc ws add
```

`codexc init` 使用 Node `os.homedir()` 在当前系统用户主目录创建 `.codex-connect`，只将不含凭据和状态文件的 `.codex-connect/workspace` 子目录注册为默认 Workspace；项目目录通过 `codexc ws add` 显式注册。配置不会写进全局 npm 包：

```text
~/.codex-connect/
├── .env                         # 0600，Token、Workspace 和运行配置
├── data/
│   ├── gateway.sqlite3         # Telegram Workspace/Thread 最小绑定
│   └── uploads/                # 私有 Telegram 图片暂存，24 小时过期
├── workspace/                   # 默认 Workspace，不存放 Gateway 凭据
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
codexc remote                    # 在当前目录启动原生 Codex TUI
codexc remote resume             # 列出当前目录的原生 Codex 会话
codexc remote --workspace docs   # 显式使用已注册 Workspace
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
HTTP_PROXY=http://127.0.0.1:7897
HTTPS_PROXY=http://127.0.0.1:7897
NO_PROXY=localhost,127.0.0.1
CODEX_BINARY=codex
CODEX_WORKSPACES_JSON=[{"id":"codex-connect","name":"Codex Connect","cwd":"/Users/you/Project-skill-Codex-Connect"},{"id":"another","name":"Another Project","cwd":"/Users/you/another-project"}]
CODEX_DEFAULT_WORKSPACE=codex-connect
CODEX_SOCKET_PATH=/Users/you/Project-skill-Codex-Connect/.runtime/codex-app-server.sock
CODEX_BRIDGE_SANDBOX=workspace-write
APPROVAL_TIMEOUT_SECONDS=300
STATE_DATABASE_PATH=./data/gateway.sqlite3
LOG_LEVEL=info
```

可选的 `CODEX_MODEL` 只作为新建 Thread 的初始模型；恢复已有 Thread 或后续 Turn 时，以 App Server 当前 Thread 设置以及 Telegram `/model`、`/effort` 的显式选择为准，避免覆盖原生 TUI 中的切换。

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

`codexc remote` 和 `npm run remote` 未指定 `--workspace` 时使用命令调用目录；`--workspace <ID>` 显式选择 Registry 中的目录并覆盖当前目录。

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

`service restart` 只重启承载项目代码的 Gateway，共享 App Server、当前 Thread 和正在执行的 Turn 保持运行，因此可以安全地从 Telegram 发起。升级 Codex CLI、修改 App Server 启动参数或重新生成 launchd 配置时，应在本机终端执行 `codexc service install`，由安装流程重新加载两个服务。

`service uninstall` 会停止并删除两个 launchd 服务配置，但保留 `~/.codex-connect` 下的配置、Workspace、SQLite 状态和日志；重新执行 `codexc service install` 即可恢复常驻服务。

安装器会把 Node 与 Codex 的绝对路径、受控 `PATH`，以及 `.env` 中已配置的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`（含小写形式）写入两个 plist，不依赖 fnm、nvm 等交互式 Shell 初始化。修改这些代理变量后需要重新执行 `codexc service install`。安装完成后可直接运行 `codexc remote resume` 连接共享 App Server 并打开会话选择器。

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
- `/sessions [搜索词]`、`/archived [搜索词]`：按服务端 Thread 标题搜索当前或已归档会话
- `/archive`、`/unarchive <序号|名称|Thread ID>`：归档当前 Thread，或取消归档并切换到目标 Thread
- `/workspace [序号|ID|名称]`：列出或切换服务端预配置的 Workspace；切换时解除旧 Thread 绑定
- `/new`：解除并删除当前持久化绑定，下一条普通消息创建新 Thread
- `/status`：查看当前 Thread、Turn、工作目录及 App Server 已推送的 Thread Token 统计
- `/stop`：中断活动 Turn
- `/rename <名称>`、`/compact`、`/fork`
- `/review [branch <分支>|commit <SHA>|custom <说明>]`
- `/model [序号|模型 ID|名称]`：查看或切换当前 Thread 模型；切换在下一次 Turn 生效
- `/effort [序号|档位]`：查看或切换当前模型支持的思考强度；切换在下一次 Turn 生效
- `/skills`、`/mcp`、`/plugins`
- `/diff`、`/plan`：查看当前 Thread 最近 Turn 的聚合变更和计划状态
- `/usage`：显示账号级 Token 汇总（M）和最近 7 个有数据日期的每日用量
- `/limits`：显示套餐、主/次额度窗口、重置时间、Credits 和限流状态
- `/permissions`
- `/goal [set <目标>|clear]`
- `/cancel`：取消当前审批、用户输入或 MCP 交互
- `/whoami`：显示 Telegram 用户 ID

普通文本会发送给当前 Thread；若当前 Turn 正在执行，则通过 `turn/steer` 追加。首次消息会在当前 Workspace 的 `cli`、`vscode`（当前版本 Remote TUI 的来源标记）和 `appServer` 来源中选择最近的空闲且未绑定 Thread；不会自动接入活动 Thread。切换 Workspace 前必须等待当前 Turn 结束或先 `/stop`。

Telegram 可以直接发送单张照片，或以文件方式发送 PNG/JPEG 图片；图片说明会与图片一起作为 Codex 输入，没有说明时使用默认的图片检查提示。活动 Turn 中收到的图片通过 `turn/steer` 追加。Gateway 先把图片下载到状态数据库同级的私有 `uploads` 目录，目录权限为 `0700`、文件权限为 `0600`，单张限制 10 MiB，只根据文件头接受 PNG/JPEG。托管图片保留 24 小时并定时清理，不写入 SQLite。当前不聚合 Telegram 相册，多图请逐张发送并分别写明用途。

当前 Workspace 选择与 Thread 绑定会写入本机 StateStore。Gateway 重启后会恢复有效绑定；过载、超时或连接中断等瞬时失败会保留绑定等待后续重连，只有对应 Thread 已删除、关闭或发生其他永久错误时才自动清理绑定，同时保留有效的 Workspace 选择。配置中已删除的 Workspace 会回退到默认 Workspace。

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
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

归档写操作需要已有 rollout，默认冒烟不会修改现有会话。若要验证 `thread/archive` 与 `thread/unarchive`，显式指定当前仓库中一个已完成、空闲且允许临时归档的 Thread；测试会在 `finally` 中恢复归档状态：

```bash
RUN_CODEX_INTEGRATION=1 CODEX_ARCHIVE_FIXTURE_THREAD_ID=<Thread ID> npm test -- --run tests/real-app-server.test.ts
```

验证 launchd 模板语法：

```bash
plutil -lint launchd/*.plist.template
```

GitHub Actions 会在 push、Pull Request 和手动触发时，分别使用 macOS 与 Linux、Node.js 22.13.0 执行依赖锁定安装、类型和版本检查、单元测试、构建及 npm 包内容检查；macOS 任务还会检查 launchd 模板。依赖本机 `codex-cli 0.145.0` 的协议检查和真实 App Server 冒烟测试仍按上述命令手动执行。

## 协议升级

先升级 Codex CLI，再重新生成协议：

```bash
npm run protocol:generate
npm run protocol:check
npm run check
npm test
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

生成物位于 `src/codex-protocol/generated`，对应版本记录在 `src/codex-protocol/version.json`。生成文件不得手工修改。

## 当前状态

仓库已经切换为单一 TypeScript Gateway；旧 Python Runtime、测试、smoke 脚本和打包入口已移除。CLI/Remote TUI 与 Telegram 双向恢复原生 Codex Thread 已完成真实验证。Gateway 支持从服务端预配置列表安全切换 Workspace，所有 Thread 查询和 Turn 均使用所选 Workspace 的 `cwd`。正式本机入口为 npm CLI `codexc`，运行数据位于 `~/.codex-connect`；源码开发仍可使用项目内 `.env` 和 `npm run dev:all`。macOS 支持 `codexc service install` 安装两个独立 launchd 服务。
