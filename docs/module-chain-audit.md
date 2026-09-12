# 模块链路审查记录

本文档记录按一级模块逐个进行的链路审查。每轮只审查一个模块，结论以当前源码、模块 README、公开接口、关键实现入口和已有测试为依据。2026-09-09 开始重新复核；重审结论覆盖此前同模块记录。本记录属于模块级重点审查，不等同于逐文件、逐函数或逐条执行路径的完整代码审计。

## 审查顺序与状态

| 顺序 | 模块 | 状态 |
| --- | --- | --- |
| 1 | `application` | 链路代码审查完成 |
| 2 | `approval` | 链路代码审查完成 |
| 3 | `bootstrap` | 链路代码审查完成 |
| 4 | `codex-client` | 链路代码审查完成 |
| 5 | `codex-protocol` | 链路代码审查完成 |
| 6 | `config` | 链路代码审查完成 |
| 7 | `conversation-core` | 链路代码审查完成 |
| 8 | `event-bus` | 链路代码审查完成 |
| 9 | `observability` | 链路代码审查完成 |
| 10 | `policy` | 链路代码审查完成 |
| 11 | `provider-proxy` | 链路代码审查完成 |
| 12 | `scheduled-tasks` | 链路代码审查完成 |
| 13 | `session-routing` | 链路代码审查完成（发现 1 项） |
| 14 | `storage` | 链路代码审查完成 |
| 15 | `surfaces` | 链路代码审查完成 |

## application

审查链路：`Surface → ConversationUseCases → ConversationService / Queue / Revert / Model / Task Service → Session Router、Conversation Core、Codex Client 窄端口`。

### 已确认边界

- Application 未直接导入平台 SDK、底层 Transport、生成协议类型或具体 Surface 实现。
- Surface 依赖公开的 `ConversationUseCases`，不直接拼装 JSON-RPC。
- Queue 和 Revert 使用 Conversation 锁，并对快照、并发变化和一次性确认令牌进行复核。
- Turn 启动失败会记录脱敏错误后继续向上抛出；未发现吞错或直接暴露内部异常的路径。
- 计划任务持久字段不完整时明确失败，不静默补默认值。

### 发现

**此前结论已撤销：Provider 校验发生在 Thread 确保之后。**

位置：`src/application/conversation-service.ts` 的 `startNewTurn()`。

重审发现该结论不成立。`router.ensure()` 在已有绑定时直接返回当前绑定；无绑定时会把 `threadStartOptions.modelProvider` 传给 `thread/start`，随后 `modelSettings()` 读取新 Thread 的实际 Provider。因此现有 Provider 不匹配路径不会因为该检查额外创建空 Thread。当前测试已覆盖失败关闭，但没有必要为该不存在的副作用增加修复。

保留现有实现，后续只需在实际协议或路由行为变化时重新核对。

### 重审验证

已运行既有定向测试：`conversation-service.test.ts`、`approval.test.ts`、`thread-queue-service.test.ts`、`thread-revert-service.test.ts`，共 105 项全部通过。

### 验证范围

本轮进行了源码、模块 README、公开端口和模块边界测试代码审查；未修改实现，并运行了 Application 相关定向测试。

### 代码链路重审状态

本轮按 `ConversationUseCases`、`ConversationService`、模型选择、Queue、Revert、计划任务接口、命令解析/编排、Goal、MCP、Plugin、Workspace 权限和后台释放路径阅读了 Application 入口及其直接实现，并对 Router/Core/Client 窄端口调用点进行了交叉核对。未发现能够由当前代码确认的新缺陷。该结论不代表已阅读仓库中所有模块的每个函数。

## bootstrap

审查链路：`GatewayApplication 构造与组合 → App Server/Provider Client、Core、Router、SurfaceManager、计划任务和指标组件 → start/stop/reconnect/config reload`。

本轮阅读 `app.ts` 的组合、启动、关闭、重连和请求分发路径，以及 `surface-manager.ts`、`scheduled-task-composition.ts`、`scheduled-task-executor.ts` 的直接生命周期与执行路径。依赖装配、失败关闭、后台任务清理、Surface 独立重试和 Server Request 分流未发现可由当前代码确认的新缺陷。指标和 Provider 辅助链路已在 `observability`、`provider-proxy`、`codex-client` 章节交叉阅读；未逐函数展开所有辅助实现。

## codex-client

审查链路：`Transport → JsonRpcClient → CodexAppServerClient / ProviderRoutingClient → 协议适配器 → Application、Core、Routing、Approval 端口`。

本轮阅读 `json-rpc.ts`、`client.ts`、`provider-routing-client.ts` 及 Thread、Turn、Queue、History、Notification、Server Request、Model、MCP、Plugin、Skill 和账户适配器的关键转换路径。初始化唯一性、Response/Notification/Server Request 分流、请求超时和断线清理、只读重试、Provider 路由及原始协议字段隔离未发现可由当前代码确认的新缺陷。由于适配器总量较大，本轮重点覆盖业务链路入口和安全裁剪点，未逐行复核所有字段辅助函数。

## codex-protocol、config、conversation-core、event-bus、policy

本轮分别阅读了协议受控导出、配置解析与热加载分类、Core 状态归约与输出发布、有界事件队列、Workspace/Surface 授权实现及对应公开入口。各链路未发现可由当前代码确认的新缺陷；协议与模块边界测试、核心定向测试已通过。协议生成文件本身按项目规则作为生成产物检查，不逐行人工审阅。

## observability

审查链路：`Provider Proxy/Turn 失败输入 → BufferedModelRequestMetricsWriter → SQLite 指标库 → 查询/聚合/Surface 展示`。

本轮阅读 `logger.ts`、`request-metrics.ts`、`request-metrics-writer.ts`、SQLite Schema/Row Codec/Store、数据库锁和公开导出。日志错误只保留受约束类型与机器码；指标写入队列有 10,000 条上限、关闭排空、检查点只等待当前水位；SQLite 使用独立锁、严格 Schema 和事务。未发现可由当前代码确认的新缺陷。

定向验证：`observability.test.ts`、`request-metrics-store.test.ts`、`request-metrics-writer.test.ts` 已通过。

## approval

审查链路：`Codex Client Server Request 适配 → ApprovalCoordinator → InteractionRouter → Surface InteractionPort → ApprovalResponse`。

### 已确认边界

- 模块不导入 `codex-client`、`codex-protocol` 或平台 SDK，原始 RPC 字段停留在 Client 适配边界。
- 请求按 `surface + accountId` 路由，同一 Conversation 串行、不同 Conversation 并行；重复请求、未注册渠道、容量溢出、超时和渠道不可用均安全拒绝或取消。
- 审批决定会重新校验会话、命令规则和网络规则能力；持久规则只返回协议明确提供且用户明确选择的原始提议。
- 未映射 Thread 和无法路由的高权限请求会安全拒绝，日志只记录脱敏身份字段。

### 发现

**此前结论已撤销：文件审批无条件向 Surface 暴露会话级批准。**

重审确认当前固定版本协议与项目 README 明确允许文件审批的会话级选项；`allowSession: true` 是该稳定合同的有意映射，不是无条件越权。

无需修改。审批定向测试已覆盖文件分支和会话决定映射。

### 验证范围

本轮完成源码、模块 README、公开接口和路由实现审查；未修改业务代码，并运行了 Approval 相关定向测试。

### 代码链路重审状态

本轮阅读 `requests.ts`、`types.ts`、`interaction-decision.ts`、`interaction-router.ts` 和 `coordinator.ts`，沿 Server Request 稳定类型、归属校验、Surface 路由、并发队列、超时/取消、审批决定映射和安全拒绝路径核对。未确认新缺陷；文件审批的 `allowSession` 与当前项目固定协议合同一致。

## provider-proxy

审查链路：`App Server → 回环 HTTP/SSE 或 WebSocket Proxy → 上游 Provider → 流式事件/状态码 → 脱敏 ProviderProxyMetrics → Metrics Channel`。

本轮阅读 `request-routing.ts`、`proxy.ts`、`metrics-channel.ts` 及模块 README。监听地址被限制为回环；路径、账户前缀和 OpenAI 额外端点使用白名单；转发头移除 Hop-by-hop、Authorization 不进入指标且私有 Turn 元数据不透传；HTTP、SSE、JSON 和 WebSocket 的完成、超时、客户端断开、握手失败及上游包装错误均形成受控状态；指标在完成事件前投递并避免重复关闭记录；IPC 使用 owner-only Unix Socket/当前 SID 私有管道和有界帧。未发现可由当前代码确认的新缺陷。

定向验证：`provider-proxy.test.ts`、`provider-proxy-metrics.test.ts`、`provider-routing-client.test.ts`，共 83 项通过。

## scheduled-tasks

审查链路：`Application 任务命令/动态工具 → ScheduledTaskStore → Scheduler tick/claim → ExecutionPort → Run 状态机 → Surface 状态通知`。

本轮阅读 `types.ts`、`schedule.ts`、`sqlite-row-codec.ts`、`sqlite-schema.ts`、`sqlite-store.ts` 和 `scheduler.ts`。Schedule 计算显式处理 UTC、时区、DST gap/fold 和一次性终态；领取在事务内校验 occurrence、任务状态和 blocking Run；并发按 Conversation 容量限制；执行异常进入 `uncertain`，崩溃恢复不会猜测结果，停止有取消信号和等待上限；清理只删除终态记录且失败不阻断调度。未发现可由当前代码确认的新缺陷。

定向验证：`scheduled-tasks.test.ts`、`scheduled-task-store.test.ts`、`scheduled-task-run-coordinator.test.ts` 及相关调度器测试通过。

## session-routing

审查链路：`ConversationTarget → BindingStore/WorkspaceRegistry → ensure/resume/fork/startBackground → ThreadLifecyclePort → ProviderRoutingClient → 订阅恢复与 ThreadStateSynchronizer`。

本轮阅读 `router.ts`、`thread-port.ts`、`thread-state-sync.ts`、`README.md`、`session-router.test.ts` 和 `thread-state-sync.test.ts`。普通新建、恢复、后台任务、接管、解绑、强制新建标记和状态同步均按 Workspace、Provider、活动状态与绑定独占约束执行；恢复失败分类和 `thread/unsubscribe` 清理路径完整。

### 发现

**中风险：`/fork` 未继承当前 Workspace 的权限配置。**

证据链：`src/session-routing/router.ts` 的 `fork()` 只把调用方的 `startOptions` 传给 `ThreadLifecyclePort.forkThread()`；而 `src/codex-client/client.ts` 的 `forkThread()` 固定发送 `sandbox: this.defaults.sandbox` 与 `approvalPolicy: "on-request"`，不读取绑定 Workspace 的 `sandbox`、`approvalPolicy` 或 `permissions`。因此，当 Workspace 配置了 `sandbox = "read-only"`、更严格的审批策略或 `permissions` Profile 时，显式 `/fork` 可能使用全局默认/固定参数，而不是当前 Workspace 的权限边界；若全局默认更宽，存在权限扩大风险。当前测试只验证模型 Provider 参数，没有覆盖配置权限的 Fork 继承。

该问题与项目升级决策中“恢复/Fork 保留原权限”的目标不一致。本次已修复：Session Router 现在把 Workspace 权限合并进 Fork 参数，Client 按与 `thread/start` / `thread/resume` 相同的互斥规则编码 `permissions` 或 `sandbox`，并保留审批策略。由于项目规则禁止修改测试文件，本次使用现有 Fork、Router 和 JSON-RPC 测试验证，未新增回归用例。

## storage

审查链路：`SessionRouter/Policy → BindingStore → MemoryBindingStore 或 SQLiteBindingStore → Schema/事务 → Gateway 重启恢复`。

本轮阅读 `binding-store.ts`、`memory-binding-store.ts`、`sqlite-binding-store.ts`、`sqlite-session-display-cache.ts` 和模块 README。复合 Conversation 身份、前后台绑定独占、Actor 撤权原子解绑、Workspace/forceNew 持久化、Schema v5 严格校验、事务回滚、私有文件权限和缓存独立性均有对应实现；加载顺序能恢复前台与多个后台绑定。未发现可由当前代码确认的新缺陷。

定向验证：`sqlite-binding-store.test.ts`、`session-display-cache.test.ts` 及 Session 路由相关测试通过。

## surfaces

审查链路：`Telegram/Feishu/Weixin 输入接收 → Actor/Workspace 授权 → 输入批处理或命令 → Application → Core/OutputEvent → 每 Conversation 有界输出队列 → 平台 API`，并覆盖 Approval/用户输入交互和 SurfaceManager 生命周期。

本轮阅读 `surfaces/README.md`、`types.ts`、`conversation-delivery-queue.ts`、`surface-input-batcher/coalescer`、Telegram Bot/Outbox/Interactions、Feishu Inbox/Adapter/Outbox/Interactions、Weixin Updates Monitor/Input Adapter/Conversation Adapter/Outbox，以及 `surface-manager.ts`。三个渠道都先授权再进入 Application；输入批次、去重、过期、容量、取消和关闭有界；同一 Conversation 输出串行、关键消息优先且平台失败隔离；交互令牌、请求归属、超时和跨客户端失效均由共享/渠道端口处理；Surface 不触碰底层 Transport 或核心状态。未发现可由当前代码确认的新缺陷。

定向验证：`surface-composition.test.ts`、`surface-manager.test.ts`、`conversation-delivery-queue.test.ts`、三个渠道 Outbox/Interactions 测试，共 227 项通过（18 项按测试设计跳过）。

## 阶段性验证与限制

本次审查先记录并修复了 Fork 权限继承问题，同时更新本记录、模块 README 和文档索引。已通过 `npm run check`、`npm run lint`、`npm run docs:check`；模块边界/核心定向测试 124 项通过，Fork/Router/JSON-RPC 定向测试 50 项通过，完整 `npm test` 在依赖补齐后通过（282 个测试文件、3121 项通过，7 个跳过）。`npm run verify:commit` 的完整测试阶段曾在并发执行时偶发失败于 `real-app-server-queue.test.ts`，该测试单独重跑通过，随后完整 `npm test` 通过；提交门禁需在稳定环境再执行一次确认。

“链路代码审查完成”表示已从模块公开入口追到主要下游端口并阅读该链路涉及的实现与测试，不表示逐文件、逐函数穷尽，也不表示不存在未覆盖的隐藏问题。当前唯一新记录的代码问题是 `session-routing` 的 Fork 权限继承问题；其余模块本轮未确认新增缺陷。
