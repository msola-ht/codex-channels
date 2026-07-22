# Codex Telegram Bridge 重构架构提案

> 状态：核心重构及双向 Thread 互通验收完成，常驻服务部署待定
> 日期：2026-07-22
> 官方文档复核：2026-07-22
> 本机协议基线：`codex-cli 0.145.0` 生成的稳定 JSON Schema
> 目标：记录从 Python Bridge 迁移到以 Codex App Server 为核心的可扩展 TypeScript 网关的设计与实施依据。

## 1. 结论摘要

推荐将项目重构为：

**独立 Codex App Server 守护进程 + TypeScript 模块化网关 + Unix Socket + 原生 Codex Remote TUI。**

核心原则：

- Codex App Server 是 Thread、Turn、Item 和历史记录的唯一事实来源。
- Codex CLI 与 Telegram Gateway 连接同一个 App Server 实例，共享实时运行状态，而不只是读取同一份落盘历史。
- 不读取或解析 `~/.codex/sessions` 等 Codex 内部文件。
- 不复制 Codex 会话历史到 Telegram 数据库。
- 不重新实现终端 UI；本地终端直接使用 `codex --remote`。
- Telegram 网络发送与 App Server 协议读取完全解耦。
- 第一阶段采用模块化单体，不提前引入微服务、Redis 或消息中间件。
- 为多平台、多项目、多用户和扩展模块保留稳定接口。
- App Server 和 Remote Transport 当前仍可能变化，必须用版本锁定、生成 Schema、契约测试和可替换 Transport 隔离兼容风险。
- 多客户端共享 Thread 和事件，不等于审批请求天然支持跨客户端抢答；交互请求由发起 Turn 的连接负责。

## 2. 当前实现存在的结构性问题

当前 Bridge 自行启动：

```text
codex app-server --stdio
```

这会创建一个独立 App Server 进程。原生 Codex CLI 如果正常启动，则使用另一个进程。两者可以看到相同的持久化 Thread，但不会共享：

- 已加载 Thread；
- 活动 Turn；
- 实时事件订阅；
- 审批请求；
- 内存中的运行状态。

因此，当前方案更准确地说是“共享会话历史”，而不是“CLI 与 Telegram 共享同一个 Codex 运行时”。

其他需要解决的问题：

- `thread/list` 未明确指定 `sourceKinds`，可能漏掉 Telegram 创建的 `appServer` Thread。
- 自动恢复只按 `cwd` 和更新时间选择，可能接入来源不符或仍在运行的 Thread。
- 切换 Thread 时没有完整执行 `thread/unsubscribe`。
- JSON-RPC 通知处理仍可能被 Telegram 网络发送拖慢。
- App Server 的用户输入、MCP elicitation 和部分 App 审批尚未完整支持。
- 自定义本地 CLI Socket 与 App Server Remote TUI 职责重叠。
- Bridge 退出时会同时终止它拉起的 App Server，运行时生命周期耦合。

这些问题可以继续局部修复，但如果目标是长期扩展，重新划分边界更清晰。

## 3. 推荐运行拓扑

```text
macOS launchd
│
├── Codex App Server
│   └── codex app-server --listen unix:///absolute/path/codex.sock
│
├── 原生 Codex CLI（按需启动）
│   └── codex --remote unix:///absolute/path/codex.sock
│
└── Codex Gateway
    ├── App Server RPC Client
    ├── Conversation Core
    ├── Thread Router
    ├── Policy Engine
    ├── Approval Coordinator
    ├── Internal Event Bus
    └── Surface Adapters
        └── Telegram Adapter
```

### 3.1 进程所有权

App Server 和 Gateway 分别由 launchd 管理：

```text
com.msola.codex-app-server
com.msola.codex-gateway
```

要求：

- App Server 先启动并持续运行。
- Gateway 只连接 App Server，不负责启动或终止它。
- Gateway 重启不影响 CLI 和 App Server 中的 Thread。
- App Server 重启后，Gateway 自动重新连接、重新初始化并恢复必要的 Thread 订阅。
- Unix Socket 位于私有目录，目录权限为 `0700`。
- 本机模式不开放 TCP 监听端口。

## 4. 技术选型

### 4.1 推荐技术栈

```text
Runtime:       Node.js LTS
Language:      TypeScript（strict）
Telegram:      grammY
WebSocket:     ws（支持通过 Unix Socket 建立 WebSocket）
Validation:    zod（只用于外部协议边界）
Logging:       pino
Testing:       Vitest
Process:       launchd
```

### 4.2 选择 TypeScript 的原因

- Codex App Server 可以通过 `generate-ts` 生成与当前安装版本一致的协议类型。
- Thread、Turn、Item 和 Server Request 都适合使用 TypeScript 的可辨识联合类型。
- Codex 协议升级后，可以通过编译错误发现未处理字段或事件。
- Node.js 适合 JSON-RPC、WebSocket、异步事件流和 Telegram Bot。
- 当前场景瓶颈主要是外部网络与 Codex 执行，无需为了性能引入 Rust。

Python 并非不能继续使用，但协议大量依赖 `dict[str, Any]` 时，字段错误通常只能在运行时发现。若决定彻底重做，TypeScript 的协议类型优势更明显。

### 4.3 官方文档复核后的兼容性结论

官方文档确认 App Server 是构建富客户端、会话历史、审批和流式事件集成的正确接口，但同时说明：

- `codex app-server` 主要面向开发和调试，可能随版本变化。
- TCP WebSocket Transport 仍为实验性且不受支持。
- Unix Socket 使用 WebSocket HTTP Upgrade，不是 JSONL Unix Stream。
- WebSocket 模式内部使用有界队列；入口过载时返回 JSON-RPC `-32001` 和 `Server overloaded; retry later.`。
- `codex remote-control` 面向托管 Remote Control 和 SSH 工作流，不能代替自定义客户端使用的 `codex app-server --listen`。
- 每次生成的 TypeScript/JSON Schema 只对应执行生成命令的 Codex 版本。

因此，本方案继续选择本机 Unix Socket，但将它视为需要兼容层保护的外部协议，而不是稳定 ABI。

必须增加：

```text
CodexTransport
├── UnixWebSocketTransport    # 生产首选，共享 App Server
└── StdioTransport            # 开发、诊断和兼容回退
```

Transport 只负责帧和连接，不包含 Thread、Turn 或 Telegram 逻辑。第一阶段不使用 TCP WebSocket，也不使用 `codex remote-control` 代替 App Server Listener。

### 4.4 Codex 版本与 Schema 策略

- 仓库记录经过验证的精确 Codex CLI 版本，初始基线为 `0.145.0`。
- 构建或测试时执行 `codex --version`，与支持版本清单比较。
- 使用不带 `--experimental` 的 `generate-ts` 生成第一阶段协议类型。
- 生成物和生成命令写入仓库，禁止手工修改生成文件。
- Codex 升级必须重新生成 Schema，并审查 Client Request、Server Request、Notification 和核心实体差异。
- 未通过契约测试的 Codex 版本应拒绝启动或进入明确的兼容诊断模式，不得静默继续。
- 实验 API 类型单独生成、单独导出，不得泄漏进稳定 Core 接口。

## 5. 推荐代码结构

```text
apps/
└── gateway/
    └── src/main.ts

packages/
├── codex-protocol/            # generate-ts 生成物和版本信息
├── codex-client/              # Unix WebSocket、JSON-RPC、初始化、重连
├── conversation-core/         # Thread/Turn/Item 状态机
├── extension-sdk/             # 扩展接口
├── storage/                   # 可替换状态存储
├── observability/             # 日志、指标、追踪
├── adapter-telegram/          # Telegram 输入与输出
└── extensions/
    ├── project-routing/
    ├── default-policy/
    ├── notifications/
    └── audit-log/

launchd/
├── codex-app-server.plist
└── codex-gateway.plist

tests/
├── contract/
├── integration/
└── unit/
```

依赖方向：

```text
Surface Adapters ──> Conversation Core <── Codex Client
                             ↑
                        Extensions
```

Conversation Core 不得依赖 Telegram、具体数据库或 launchd。

## 6. 核心模块

### 6.1 Codex Client

职责：

- 通过 Unix Socket 执行 WebSocket HTTP Upgrade。
- 每个连接只执行一次 `initialize`，随后发送 `initialized`。
- 使用稳定能力初始化；只有具体功能需要时才启用 `experimentalApi`。
- 明确设置 `clientInfo.name`、`title` 和版本；企业使用前确认 Compliance Logs 的已知客户端要求。
- 将 `optOutNotificationMethods` 作为精确名称列表处理，不支持通配符推断。
- 维护 JSON-RPC 请求 ID 与 Pending Response。
- 独立处理通知、响应和 App Server 发起的请求。
- 连接断开时终止或转移 Pending Request。
- 使用指数退避和抖动重新连接。
- 连接恢复后重新获取 Thread 状态，而不是假设旧内存状态仍然有效。
- 对 `-32001` 仅自动重试可证明安全的只读或幂等请求；不得盲目重试 `thread/start`、`turn/start`、`thread/fork` 等创建或写入操作。
- 暴露 `UnixWebSocketTransport` 和 `StdioTransport` 的统一接口，以便协议或 Listener 行为变化时不影响 Core。

Codex Client 不得直接调用 Telegram API。

### 6.2 Conversation Core

维护 App Server 事件归约后的运行状态：

```ts
interface ThreadRuntime {
  threadId: string;
  sessionId: string;
  status: "notLoaded" | "idle" | "active" | "systemError";
  activeTurnId?: string;
  messages: Map<string, string>;
  pendingRequests: Map<string, PendingRequest>;
}
```

主要处理：

- `thread/started`
- `thread/status/changed`
- `thread/closed`
- `turn/started`
- `turn/completed`
- `item/started`
- `item/completed`
- 所有必要的 Item Delta
- `serverRequest/resolved`
- `warning`
- `error`

状态归约规则：

- 使用服务端返回的 `thread.sessionId`，不得从 `threadId` 推导 Session Tree Root。
- `item/completed` 是 Item 最终状态的权威来源；delta 只用于预览。
- Plan 的最终 Item 可能与 delta 拼接结果不同，必须以 completed Item 为准。
- `turn/diff/updated` 和 `turn/plan/updated` 中的空 `items` 不代表没有 Item；Item 状态以 `item/*` 事件为准。
- Turn 失败通常先产生 `error`，随后产生 `turn/completed` 且状态为 `failed`；两者需要合并成一次用户可理解的结果。
- 历史压缩以 `contextCompaction` Item 生命周期为准，不依赖已弃用的 `thread/compacted` 通知。

### 6.3 Thread Router

负责将外部对话映射到 Codex Thread：

```ts
interface ConversationBinding {
  surface: string;
  accountId: string;
  conversationId: string;
  workspaceId: string;
  threadId: string;
}
```

当前实现通过 SQLite `StateStore` 持久化 Workspace 选择和最小绑定，以便 Gateway 重启后恢复 Telegram 的当前 Workspace 与 Thread；不保存 Codex 会话内容。

### 6.4 Internal Event Bus

```text
App Server Reader
        ↓
有界 Event Queue
        ↓
Conversation Reducer
        ↓
订阅者独立队列
├── Telegram Renderer
├── Audit Extension
└── Metrics Extension
```

要求：

- App Server Reader 只解析和入队。
- Telegram 超时不能阻塞 App Server Reader。
- 中间文本 delta 在过载时允许合并或丢弃。
- `item/completed`、`turn/completed`、审批和错误事件不能静默丢失。
- 每个外部 conversation 保持消息顺序，不同 conversation 可以并行。

### 6.5 Approval Coordinator

统一处理：

```ts
type PendingRequest =
  | CommandApproval
  | FileApproval
  | PermissionApproval
  | UserInputRequest
  | McpElicitation;
```

必须覆盖：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `tool/requestUserInput`
- `mcpServer/elicitation/request`
- App 工具产生的确认流程
- `serverRequest/resolved`

审批标识必须绑定 `threadId + turnId + itemId/requestId`。过期按钮不可重复使用。

多客户端交互所有权：

- 发起 `turn/start`、`turn/steer` 或相关操作的 App Server 连接负责响应该 Turn 的 Server Request。
- Telegram 发起的 Turn 由 Gateway 展示并处理审批、用户输入和 MCP elicitation。
- CLI 发起的 Turn 由 CLI 负责交互；Gateway 可以展示已观察到的状态，但不能假设自己一定会收到或能够响应同一 Server Request。
- `serverRequest/resolved` 到达时应立即失效本地界面；没有收到该通知时，仍需通过 Turn/Thread 状态变化进行最终对账。
- 第一阶段不承诺“CLI 和 Telegram 同时抢答同一个审批”，避免依赖文档未保证的跨连接行为。

权限请求只返回用户实际批准的子集；只有用户明确选择时才使用 Session Scope，默认使用 Turn Scope。

## 7. Telegram Adapter

Telegram Adapter 只负责平台相关行为：

- 接收消息、命令、按钮回调和附件。
- 将输入转换成统一 `IncomingMessage`。
- 将统一 `OutputEvent` 渲染成 Telegram 消息。
- 处理 Telegram 限速、超时、消息长度和 Markdown 差异。

统一输入：

```ts
interface IncomingMessage {
  surface: "telegram" | "discord" | "web" | "api";
  accountId: string;
  conversationId: string;
  text: string;
  attachments: Attachment[];
  replyTo?: string;
}
```

统一输出：

```ts
type OutputEvent =
  | { type: "user.message"; text: string }
  | { type: "text.delta"; text: string }
  | { type: "text.completed"; text: string }
  | { type: "turn.status"; status: string }
  | { type: "approval.requested"; request: Approval }
  | { type: "input.requested"; request: UserInputRequest }
  | { type: "command.updated"; command: CommandState }
  | { type: "file.updated"; change: FileChange }
  | { type: "warning"; message: string };
```

同一 Thread 被多个客户端订阅时，Gateway 归约外部 `turn/started` 和
`userMessage` Item，将外部文本输入同步到已绑定 Surface。Gateway 自己发起的
`turn/start` 和 `turn/steer` 必须设置 `clientUserMessageId`，Surface 根据该标记
避免重复回显本地已经显示的输入。审批请求仍由发起 Turn 的连接负责，不跨连接抢答。

Telegram 将外部输入渲染为独立的引用式 `CLI 输入` 气泡，并让该输入之后的第一条
agent message 使用原生 reply 关系关联到它；后续 agent message item 继续按独立气泡
输出，避免重复引用。

### 7.1 Telegram Outbox

Outbox 独立负责：

- 合并流式 delta。
- 限制消息编辑频率。
- 对 429 使用 Telegram 指示的等待时间。
- 对连接超时进行有限重试。
- 将超过 4096 字符的内容安全分段。
- 优先保证最终消息送达。
- 避免相同内容重复编辑。
- Gateway 停止时执行有时限的最终刷新。

## 8. 会话策略

### 8.1 默认自动接续

Gateway 启动时不主动恢复 Thread。第一次收到普通消息时调用：

```json
{
  "cwd": "/absolute/project/path",
  "sourceKinds": ["cli", "appServer"],
  "sortKey": "updated_at",
  "sortDirection": "desc",
  "useStateDbOnly": true
}
```

`useStateDbOnly: true` 用于常规快速列表，但它不会扫描 JSONL 修复状态库元数据。出现以下情况时，Gateway 应再执行一次 `useStateDbOnly: false` 的完整查询：

- 快速查询为空但用户预期存在会话；
- 用户主动执行刷新命令；
- 已知 Thread ID 无法在状态库结果中找到；
- Codex 升级或状态库修复后首次查询。

选择规则：

1. `cwd` 必须属于服务端配置的 Workspace，不能由 Telegram 用户提交任意路径。
2. 只选择允许的 `sourceKinds`。
3. 排除已绑定给其他外部 conversation 的 Thread。
4. 排除或明确处理 `active` Thread。
5. 恢复最新符合条件的 Thread。
6. 没有符合条件的 Thread 时调用 `thread/start`。
7. 恢复后再执行 `turn/start`。

列表预览优先使用 `thread/list`；需要核对单个 Thread 而不订阅事件时使用 `thread/read`。只有确定要继续该会话时才调用 `thread/resume`。

`thread/resume` 本身不会更新 `updatedAt`；真正开始新 Turn 后才更新会话时间。恢复结果中的 `thread` 和 `instructionSources` 应被读取并纳入诊断信息。

### 8.2 命令语义

- `/new`：当前 Turn 必须为空闲；取消旧 Thread 订阅；下一条消息创建新 Thread。
- `/resume`：列出当前 Workspace 的 Codex 原生 Thread。
- `/resume <selector>`：恢复指定 Thread，并取消旧 Thread 订阅。
- `/stop`：调用 `turn/interrupt`。
- `/status`：以 App Server 的实际状态为准，不只显示本地缓存。
- `/rename`：调用 `thread/name/set`。
- `/compact`：调用 `thread/compact/start`。

`thread/unsubscribe` 返回 `unsubscribed`、`notSubscribed` 或 `notLoaded`。这三个结果都应作为可解释状态处理。最后一个订阅者退出后，Thread 可能继续保持加载直到无订阅且无活动达到服务端宽限期，不能把 unsubscribe 当作立即 unload。

当 Thread 已有活动 Turn 时：

- 默认不调用新的 `turn/start`。
- 用户明确表示补充当前任务且已知 `expectedTurnId` 时，可以调用 `turn/steer`。
- 用户选择停止时调用 `turn/interrupt`。
- 无法确认活动 Turn 所有权时，先展示状态，不自动 steer 或 interrupt。

## 9. 多项目、多用户和多平台扩展

### 9.1 Workspace Registry

```ts
interface Workspace {
  id: string;
  name: string;
  cwd: string;
}
```

当前单机实现使用一个共享 App Server 和服务端 `CODEX_WORKSPACES_JSON` Registry。Telegram 只能按序号、ID 或名称选择 Registry 中的 Workspace；所有 `thread/list`、`thread/start`、`thread/resume`、`turn/start`、Skills、Plugins 和权限查询都显式使用所选 Workspace 的 `cwd`。切换 Workspace 必须在 Turn 空闲时执行，并先取消旧 Thread 订阅。

Workspace 通过本机可信管理入口注册：操作者在目标目录执行 `npm --prefix <Gateway 目录> run workspace:add`，脚本读取 npm 的 `INIT_CWD` 并原子更新 Gateway `.env` 中的 Registry；同一路径重复注册保持幂等。Gateway 重启后加载新配置。该入口不改变 Telegram 的安全边界，聊天消息仍不能指定任意绝对路径。

一个 App Server 可以服务多个 `cwd`。只有认证、配置或安全边界确实不同，才创建多个 App Server Profile：

```text
AppServerPool
├── personal → unix:///.../personal.sock
├── work     → unix:///.../work.sock
└── isolated → unix:///.../isolated.sock
```

不为每个 Thread 单独启动 App Server。

### 9.1.1 本机安装与运行目录

正式本机入口通过 npm 安装为 `ccx`（同时提供 `codex-connect` 长别名）。代码位于 npm 包安装目录，用户配置与运行状态使用 Node `os.homedir()` 定位到 `~/.codex-connect`，避免 npm 升级覆盖 Token、Workspace Registry、SQLite、Socket 或日志。源码开发模式仍使用仓库内 `.env`，两种模式共用同一 Gateway 实现和 App Server 协议。

`~/.codex-connect` 权限为 `0700`，`.env` 和 SQLite 为 `0600`。该目录只保存 Gateway 配置、最小业务绑定与进程运行文件，不保存或复制 Codex Thread/Turn/Item 历史。macOS 可通过 `ccx service install` 安装独立 launchd 服务；Linux 暂用 `ccx start`。Windows 可以复用用户目录约定，但当前 Unix WebSocket Transport 尚未适配，不能宣称运行支持。未来的平台 Transport 和系统服务适配不得改变配置目录与模块边界。

### 9.2 可替换存储

```ts
interface StateStore {
  getBinding(key: BindingKey): Promise<ConversationBinding | null>;
  saveBinding(binding: ConversationBinding): Promise<void>;
  deleteBinding(key: BindingKey): Promise<void>;
}
```

当前选择：

- 单机 Gateway：SQLite，只保存 Workspace 选择与 Thread 绑定。
- 多实例部署：PostgreSQL。
- 只有出现分布式队列或锁需求时才引入 Redis。

### 9.3 扩展接口

第一阶段采用编译期注册，不动态扫描和执行第三方代码。

```ts
interface SurfaceAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(target: Target, event: OutputEvent): Promise<void>;
}

interface CommandExtension {
  name: string;
  description: string;
  execute(context: CommandContext): Promise<CommandResult>;
}

interface PolicyExtension {
  selectThread(input: ThreadSelectionInput): Promise<string | null>;
  authorize(action: ActionContext): Promise<PolicyDecision>;
}
```

只有确实需要第三方安装扩展时，再增加 manifest、API 版本、权限声明、签名、进程隔离和资源限制。

Codex Skill 适合描述模型工作流，不适合实现 Gateway 的实时 Transport、Thread 路由、事件处理或审批状态机。

## 10. 安全要求

- App Server Unix Socket 父目录权限为 `0700`。
- 不将无认证 App Server 监听到非回环地址。
- 非本机连接优先使用 SSH 端口转发；必须远程暴露时才考虑 TLS 和认证。
- 如果将来启用 WebSocket 认证，优先使用 `--ws-token-file`，不得把原始 Token 放在命令行；客户端通过 `Authorization: Bearer` 完成握手。
- Telegram Token 只从环境变量或系统 Secret Store 读取。
- 日志不得包含 Token、Cookie、Authorization Header 或完整敏感输入。
- Telegram 用户只能选择预配置 Workspace，不能提交任意 `cwd`。
- 默认不自动批准命令、写文件和网络权限。
- 审批回调一次性使用并设置过期时间。
- 多用户模式必须在 Thread 操作前重新执行授权检查。
- App Server 的 `thread/shellCommand` 属于全权限执行，只能由明确的用户操作触发。
- 第一阶段不向 Telegram 暴露 `thread/shellCommand`、`process/*`、`thread/delete` 或 `fs/remove`；这些能力分别涉及沙箱外执行、实验性进程控制或不可逆删除。

## 11. 故障与恢复行为

### App Server 断开

- Gateway 停止接受新的 Codex Turn。
- Telegram 显示“Codex 服务重连中”，但不重复发送用户任务。
- 使用有上限的指数退避和抖动重连。
- 重连后重新 initialize。
- 使用 `thread/list`、`thread/read` 或 `thread/loaded/list` 重建状态。
- 不自动重放无法确认是否已提交成功的 `turn/start`。
- 对已经拿到成功 Response 的只读请求可以安全重试；对结果未知的创建或写入请求进入“结果待确认”状态，由 Thread/Turn 查询对账。

### Telegram 断开

- 不影响 App Server Reader 和 Codex Turn。
- 中间 delta 可以合并。
- 保存内存中的最终消息，连接恢复后优先发送最终状态。
- 达到队列限制时丢弃中间刷新，不丢审批和完成事件。

### Gateway 重启

- App Server 与 CLI 继续运行。
- 从 StateStore 恢复绑定，并通过 `thread/resume` 验证 Thread 仍然有效。
- Pending Approval 不进行盲目恢复，以 App Server 当前请求状态为准。

## 12. 测试策略

### 单元测试

- JSON-RPC 请求、响应、通知和 Server Request 分流。
- `-32001` 过载处理以及读写请求的不同重试策略。
- Thread/Turn/Item Reducer 状态转换。
- Thread 自动选择规则。
- 审批一次性、超时与跨客户端解决。
- Telegram 分段、合并、限速和重试。

### 契约测试

- CI 或本机根据当前 Codex 版本执行 `codex app-server generate-ts`。
- 检查生成协议与仓库锁定版本是否存在未审查差异。
- 检查 stable 与 experimental 类型没有错误混用。
- 使用真实 App Server 验证 initialize、thread/list、thread/resume 和 turn/start。

### 集成测试

- CLI 创建 Thread，Gateway 能列出并恢复。
- Telegram 创建 Thread，CLI 能通过 `/resume` 或 Remote TUI 接续。
- Gateway 重启后 App Server Thread 保持可用。
- Telegram 超时期间 App Server 事件读取不中断。
- Telegram 发起的 Turn 能在 Telegram 完成审批、用户输入和 MCP elicitation。
- CLI 发起的 Turn 不会被 Gateway 错误接管审批。
- 收到 `serverRequest/resolved` 后本地交互界面失效，并通过最终 Turn 状态完成对账。
- 切换 Thread 后旧 Thread 正确 unsubscribe。

## 13. 是否删除重做的建议

不建议直接删除整个仓库后从空目录开始。建议保留 Git 历史，并采用以下方式：

1. 当前实现作为重构前参考基线。
2. 新建 TypeScript 目录结构和最小 App Server Unix Socket 客户端。
3. 先完成协议连接、Thread 列表、恢复和一次文本 Turn。
4. 再实现 Event Reducer、Telegram Outbox 和审批。
5. 完成新旧功能对照验收后，删除 Python Runtime。
6. 最后删除自定义本地 CLI Socket、旧依赖和旧测试。

建议保留或迁移：

- README 中经过确认的产品行为。
- Telegram 命令语义和文案。
- 授权用户配置思路。
- 流式文本分段、审批和访问控制测试场景。
- Git 历史。

建议最终移除：

- Python Bridge Runtime。
- `codex app-server --stdio` 子进程管理。
- 自定义 LocalControlServer 和自定义 CLI 协议。
- 复制 Codex 会话内容的 SQLite 会话历史或 Telegram 消息历史存储。
- 直接依赖 Codex 内部会话文件的任何代码。

## 14. 分阶段实施建议

### 阶段 0：协议与兼容性闸门

- 锁定并记录首个支持的 Codex CLI 精确版本。
- 生成稳定 TypeScript Schema 和 JSON Schema。
- 建立 Schema 差异检查、真实 App Server 握手测试和版本拒绝策略。
- 实现统一 `CodexTransport` 接口以及 Unix WebSocket、stdio 两种 Transport。
- 验证 Unix Socket 的 WebSocket HTTP Upgrade，而不是按 JSONL Unix Stream 实现。

停止条件：受支持版本可以通过两种 Transport 完成 initialize；不支持版本会给出明确诊断而不是带病运行。

### 阶段 A：最小贯通

- launchd 启动 App Server Unix Socket。
- TypeScript Gateway 完成 initialize。
- 完成 `thread/list`、`thread/start`、`thread/resume`、`turn/start`。
- CLI 通过 `codex --remote` 连接同一 App Server。

停止条件：CLI 与测试客户端能够看到并接续同一个 Thread。

### 阶段 B：Telegram 主路径

- Telegram 鉴权。
- 普通文本提交。
- 流式输出与最终消息。
- `/new`、`/resume`、`/stop`、`/status`。
- App Server 与 Telegram 网络故障隔离。

停止条件：Telegram 断网不会阻塞或终止 Codex Turn。

### 阶段 C：完整交互

- 命令、文件和权限审批。
- User Input Request。
- MCP elicitation。
- App 工具确认。
- 多客户端 `serverRequest/resolved` 同步。

停止条件：App Server 所有稳定交互请求都有明确响应策略。

### 阶段 D：扩展能力

- [x] Workspace Registry 与 Telegram 安全切换。
- Extension SDK。
- 可替换 StateStore。
- 可观测性和协议升级检查。

停止条件：新增 Surface 或 Policy 不需要修改 Conversation Core。

## 15. 重构验收标准

满足以下条件后，才适合删除旧实现：

- [ ] App Server 独立运行并由 launchd 自动恢复。
- [ ] 原生 Codex CLI 可通过 `codex --remote` 正常连接。
- [ ] CLI 与 Telegram 使用同一个 App Server 实例。
- [ ] 使用的 Codex CLI 精确版本已记录，生成 Schema 与该版本一致。
- [ ] Codex 升级存在契约差异检查和不兼容拒绝策略。
- [ ] Unix WebSocket 与 stdio Transport 通过同一套协议契约测试。
- [ ] CLI 创建的 Thread 能被 Telegram 接续。
- [ ] Telegram 创建的 Thread 能被 CLI 接续。
- [x] Gateway 重启不会终止 App Server，并从 StateStore 恢复有效 Thread 绑定。
- [ ] Telegram API 超时不会阻塞 App Server Reader。
- [ ] `/new` 和 `/resume` 会正确 unsubscribe 旧 Thread。
- [ ] Telegram 发起 Turn 的审批、用户输入和 MCP elicitation 有完整处理逻辑。
- [ ] CLI 发起 Turn 的交互请求不会被 Gateway 错误接管。
- [x] 所有 Thread 查询显式指定 Workspace 与 `sourceKinds`。
- [x] SQLite StateStore 只持久化绑定，不复制 Codex 会话历史。
- [ ] 真实 App Server 集成测试通过。
- [ ] 旧命令和必要产品行为完成对照验收。

## 16. 需要在实施前确认的决策

1. 第一阶段是否只支持一个 Telegram 私聊用户。
2. 是否从第一阶段就支持多个 Workspace。
3. 是否确认切换到 TypeScript，还是保留 Python 并只重构架构。
4. App Server 是否由 launchd 常驻，还是手工启动。
5. 是否需要保留任何 Bridge 专属本地管理命令。
6. 是否需要在 Telegram 展示命令执行、diff、计划和推理摘要等详细事件。
7. 是否接受 App Server/Remote Transport 当前可能变化，并通过精确版本锁定后再实施重构。
8. 第一阶段是否严格禁用所有 experimental API。

这些决策不会改变“共享单一 App Server”的核心架构，但会影响第一版范围和重构工作量。

## 参考

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex App Server 源码](https://github.com/openai/codex/tree/main/codex-rs/app-server)
