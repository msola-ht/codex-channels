# Codex CLI 协议边界收敛计划

## 目标

本计划用于让 Gateway 更容易跟随 Codex CLI 正式版升级，同时保持当前模块化单体、共享
App Server、单一事实来源和失败关闭边界不变。

最终目标不是隐藏官方协议语义，而是把版本专属变化限制在明确边界：

```text
Codex CLI 生成协议
        ↓
codex-protocol
        ↓
codex-client：请求、响应、通知和 Server Request 的精确适配
        ↓
Application / Conversation Core / Session Routing / Approval
        ↓
Surface
```

升级后，生成类型和官方语义发生变化时，应优先只修改 `codex-protocol`、`codex-client`、
对应的合同测试和文档。只有业务语义确实变化时，才继续修改 Core、Routing、Approval 或 Surface。

## 不改变的边界

- App Server 继续是 Thread、Turn、Item、Goal 和会话历史的唯一事实来源。
- Gateway 不读取 Codex 会话文件，不增加独立会话数据库或兼容旧 CLI 的并行实现。
- `codex-protocol` 继续保存当前精确 CLI 版本生成的完整类型，不手写或修补生成文件。
- 未知 Notification 可以记录后忽略；未知 Server Request 必须明确拒绝，不能悬挂。
- 审批、网络规则、命令规则和临时权限继续按官方协议原值校验，不扩大授权。
- 不新增微服务、消息代理、全局 DTO 模块或通用映射框架。
- 不为尚未使用的官方能力复制类型；只为当前业务实际消费的字段建立稳定结构。
- 不改变 SQLite Schema、用户配置格式、公开命令或 Surface 行为，除非某一阶段另行说明并获批准。

## 计划建立时的事实基线

当前架构已经具备两个正确基础：

1. `codex-protocol` 保存版本专属生成类型和精确版本基线。
2. `codex-client` 集中发送 App Server 请求并管理 Transport、JSON-RPC 和重连。

计划建立时协议隔离尚未完成：

- `src/codex-protocol/index.ts` 当前受控导出 53 个生成类型。
- 生产源码有 14 个文件直接导入 `codex-protocol`，其中 12 个位于 `codex-client` 之外。
- 直接依赖生成类型的业务模块包括 `application`、`approval`、`bootstrap`、
  `conversation-core`、`session-routing` 和 `surfaces`。
- `application` 中的会话与模型服务以及 `session-routing` 依赖具体
  `CodexAppServerClient`，测试因此大量使用 `as unknown as CodexAppServerClient` 构造不完整替身。
- `conversation-core` 和 `thread-state-sync` 接收 `{ method, params: unknown }` 后自行解析协议字段，
  但它们输出的事件又包含 `TurnStatus`、`ThreadTokenUsage`、`RateLimitSnapshot` 等生成类型。
- Telegram 格式器直接读取官方 `Thread`、模型、用量、Skill、Plugin、MCP 和权限结构。
- `tests/module-boundaries.test.ts` 当前允许六个非 Client 模块依赖 `codex-protocol`，因此只能检查
  已声明的现状，不能阻止协议继续向业务层泄漏。

之前完成的 `codex-protocol`、`codex-client`、`conversation-core` 和 `session-routing` 专项复核
仍是当前行为基线；本计划只在迁移实际触及时做定向复核，不从头重复无关审查。

## 目标依赖方向

各消费模块拥有自己需要的窄端口和稳定业务类型，`codex-client` 作为外部协议适配器实现这些端口。
不建立新的顶层“公共类型”模块，避免把不同职责重新集中到一个共享包。

目标生产依赖为：

```text
codex-protocol
        ↑
codex-client ──────→ application
      │             approval
      │             conversation-core
      └────────────→ session-routing

surfaces ──────────→ application / approval / conversation-core
bootstrap ─────────→ 所有具体实现并完成装配
```

关键变化：

- `application` 不再依赖具体 `CodexAppServerClient` 或生成协议。
- `session-routing` 不再依赖具体 Client 或官方 `Thread`。
- `conversation-core` 不再解析原始 JSON-RPC Notification，也不输出生成类型。
- `approval` 不再接收 `RpcServerRequest`，也不直接生成官方响应对象。
- `surfaces` 和 `bootstrap` 不再导入 `codex-protocol`。
- `codex-client` 可以依赖业务模块公开的窄端口和输入类型，但不得依赖 Surface、平台 SDK、
  Storage 实现或业务绑定。

## 类型归属

| 类型或行为 | 归属模块 | 说明 |
| --- | --- | --- |
| 完整生成协议、Request ID、RPC 联合 | `codex-protocol` | 只描述当前锁定 CLI |
| JSON-RPC、Transport、协议请求和响应映射 | `codex-client` | 版本变化的首要适配点 |
| Thread 查询、恢复和订阅所需快照 | `session-routing` | 只保留路由与恢复需要的字段 |
| Turn 输入、命令结果、模型和扩展查询 | `application` | Surface 可直接消费的结构化结果 |
| Turn/Item/用量/警告输入事件与输出事件 | `conversation-core` | 不包含生成协议类型 |
| 审批请求、可用决定和用户决定 | `approval` | 保留权限语义，协议编码由 Client 完成 |
| 平台文案、布局、按钮和文件传输 | `surfaces` | 不识别官方 RPC 字段 |
| 具体实现选择和生命周期 | `bootstrap` | 不解析协议对象 |

稳定类型不是官方对象的镜像。只保留当前用例需要的字段，并在 `codex-client` 映射时对必需字段
失败关闭。官方新增字段不会自动成为项目能力，官方删除或改变必需字段会使类型检查、映射测试或
真实合同测试失败。

## 实施原则

1. 按纵向能力迁移，不按目录批量重写；每个阶段保持可构建、可测试和可独立审查。
2. 先建立消费方窄端口和稳定类型，再修改 `codex-client` 适配，最后切换调用方。
3. 同一阶段删除被替代的生成类型导出、旧接口、测试替身和模块白名单，不长期保留双入口。
4. 不使用 `any`、宽泛字典或字段别名让新旧协议同时通过。
5. Notification 适配只输出已支持事件；未知 Notification 保留可观察日志并忽略。
6. Server Request 适配必须显式穷尽当前支持类型，未知或畸形高权限请求安全拒绝。
7. 每阶段只修改完成该纵向能力所需的文件，不顺带重构其他模块。
8. 每阶段完成后更新相关模块 README、`docs/index.md` 实现映射和测试索引。

## 进度

| 阶段 | 状态 | 说明 |
| --- | --- | --- |
| 计划与现状盘点 | 已完成 | 仅新增计划和索引，不改变运行时 |
| 1. Thread 生命周期 | 已完成 | 稳定端口、响应映射、调用方与测试已迁移 |
| 2. Turn 与 Application 命令 | 已完成 | Turn、Review、Goal 端口与响应映射已迁移 |
| 3. 模型、Fast、用量与扩展查询 | 已完成 | 模型、Fast、账户、Skill、MCP、Plugin 与 Permission Profile 查询均已收敛 |
| 4. Notification 与 Conversation Core | 已完成 | Routing 与 Core 均只消费稳定事件 |
| 5. Server Request 与审批 | 已完成 | 五类请求的解码、授权协调与响应编码已隔离 |
| 6. 边界收紧与测试替身 | 已完成 | 协议导入、具体 Client 依赖与白名单已自动收紧 |
| 7. 项目内部模块复核 | 进行中 | Storage 已完成，其余模块独立处理 |
| 8. Bootstrap 收尾 | 未开始 | 最后执行 |

## 阶段 1：Thread 生命周期

目标：把 Thread 查询、恢复、切换、分支、归档和订阅从官方 `Thread` 与具体 Client 中隔离。

主要工作：

- 在 `session-routing` 定义 Thread 生命周期窄端口和项目快照，覆盖当前实际使用的 ID、名称、
 预览、来源、状态、CWD、运行 Turn 与模型设置。
- 让 `CodexAppServerClient` 精确映射 `thread/list`、`thread/read`、`thread/start`、
  `thread/resume`、`thread/fork`、归档、恢复、删除和取消订阅响应。
- `SessionRouter` 依赖窄端口，不依赖具体 Client 或生成的 `Thread`。
- `ConversationService` 和 Telegram 会话列表只使用项目 Thread 摘要。
- 测试改用端口替身，移除该链路中的 `as unknown as CodexAppServerClient`。

重点验证：

- Thread 来源、Workspace、活动状态和独占绑定判断保持不变。
- `thread/resume` 的运行 Turn 和模型设置完整恢复。
- 列表循环游标、归档、删除、订阅取消和恢复失败路径继续覆盖。
- 真实 App Server Thread 查询、恢复和双客户端合同通过。

完成标准：

- `session-routing` 不再导入 `codex-client` 或 `codex-protocol`。
- Thread 会话列表和路由测试不再构造生成的 `Thread`。

## 阶段 2：Turn 与 Application 命令

目标：让 Application 依赖业务端口，不依赖具体 Client、`UserInput`、`ReviewTarget`、
`ThreadGoal` 或 Turn 响应类型。

主要工作：

- 在 `application` 定义 Turn 执行端口、项目输入项、Review 目标和 Goal 结果。
- 把文本与本地图片转换成官方 `UserInput` 的职责移到 `codex-client`。
- 把 `turn/start`、`turn/steer`、`turn/interrupt`、重命名、压缩、Review 和 Goal 方法映射到
  稳定结果。
- Goal 与 Review 命令使用显式稳定结果；模型和扩展查询的
  `Awaited<ReturnType<...>>` 链已在阶段 3 随查询类型一起替换。
- 保持下一 Turn 队列、活动 Turn 判断、失败清理和用户错误代码不变。

重点验证：

- 普通提交、steer、排队、停止、Review、Goal 和图片输入主路径。
- 写请求仍不进行断线或过载盲目重试。
- Turn 成功后模型、思考强度和 Fast 状态的同步时机不变。

完成标准：

- Conversation Turn、Review、Goal 路径不再导入具体 Client 或对应生成协议类型。
- Conversation Turn 测试只依赖窄端口；模型与扩展查询的具体 Client 依赖已在阶段 3 清理。

## 阶段 3：模型、Fast、用量与扩展查询

目标：隔离变化频率较高的模型目录、服务层级、额度、Skill、MCP、Plugin 和权限结构。

主要工作：

- 在 `application` 定义项目自己的模型、思考强度、服务层级、用量、额度、Skill、MCP、
  Plugin 和权限摘要。
- `codex-client` 映射 `model/list`、`config/read`、`config/batchWrite`、账户用量与限额、
  `skills/list`、`mcpServerStatus/list`、`plugin/installed` 和 `permissionProfile/list`。
- Fast 能力判断只使用项目模型目录；保留官方服务层级 ID，不把 `priority`、`fast` 等协议事实
  分散到 Surface。
- Telegram 格式器只消费 Application 查询结果。

重点验证：

- Fast 开关与共享 Thread、用户级默认值和 CLI 重启保持同步。
- 模型选择、思考强度回退、空目录、分页循环和隐藏项过滤。
- Skill 只显示直接安装项，Plugin 查询不触发市场刷新。
- 用量、额度、MCP 故障和权限展示不泄露原始上游内容。

完成标准：

- `model-selection-service` 和 Telegram 的模型、用量与扩展查询格式化输入不再使用生成响应；
  同文件中的通知输入由阶段 4 继续隔离。
- 查询结果的协议字段变化只需修改 Client 映射和对应合同测试。

## 阶段 4：Notification 与 Conversation Core

目标：把原始 Notification 解析从 Core 和 Routing 移到协议适配边界。

主要工作：

- `conversation-core` 定义平台无关的输入事件联合，覆盖当前支持的 Turn、Item、Diff、Plan、
  Token、账户、额度、MCP 和 warning。
- `session-routing` 定义 Thread 设置、归档、删除和关闭所需的路由事件。
- 在 `codex-client` 增加 Notification 适配器，将当前生成的 `ServerNotification` 精确转换为
  Core 或 Routing 事件。
- `ConversationCore` 只归约已转换事件，不再按 `method` 和 `params: unknown` 读取协议字段。
- `ThreadStateSynchronizer` 只处理路由事件，不再解析原始通知。

重点验证：

- Turn/Item 顺序、重复通知、畸形通知、警告范围和错误终态。
- Thread 设置通知的模型、思考强度和服务层级完整性。
- 未知 Notification 可观察但不影响 Reader。
- App Server Reader 不等待 Surface 网络请求。

完成标准：

- `conversation-core` 不再导入 `codex-protocol`。
- Core 和 Routing 公开接口不再暴露 `RpcNotification` 或 `{ params: unknown }`。

## 阶段 5：Server Request 与审批

目标：隔离高权限 Server Request 的协议编码，同时保留 Approval 对授权语义的所有权。

主要工作：

- `approval` 定义项目拥有的命令、文件、临时权限、用户输入和 MCP elicitation 请求。
- 项目审批类型使用精确、最小的命令规则和网络规则结构，不引用生成类型。
- `codex-client` 负责把当前 `ServerRequest` 解码为 Approval 请求，并把用户决定重新编码为
  当前协议响应。
- Approval 继续验证 Thread/Turn/Item 归属、提议与可用决定一致性、一次性令牌、超时和跨客户端失效。
- 编码响应前再次确认选择来自原始提议，未知请求返回明确 JSON-RPC 错误或安全拒绝。

重点验证：

- 一次、会话、命令前缀、网络会话和网络持久规则互不升级。
- 额外权限、畸形网络上下文、缺少归属、过期和已由其他客户端解决。
- 用户输入和 MCP 表单/URL elicitation。
- 新增官方 Server Request 时测试必须失败或证明会安全拒绝。

完成标准：

- `approval` 不再导入 `codex-client` 或 `codex-protocol`。
- Surface 只看到 `InteractionRequest` 和 `InteractionDecision`。

## 阶段 6：边界收紧与测试替身

目标：把目标依赖方向变成自动执行的架构规则。

主要工作：

- Bootstrap 通过 `codex-client` 的运行时信息读取支持版本，不再直接导入 `codex-protocol`。
- 清理 Surface、Bootstrap 和其他业务模块剩余的协议导入。
- 收缩 `src/codex-protocol/index.ts` 的业务导出，只保留 Client 内部实际使用的当前协议类型。
- 更新 `tests/module-boundaries.test.ts`：
  - 生产代码只有 `codex-client` 可以依赖 `codex-protocol`；
  - Application、Approval、Core、Routing 和 Surface 不得依赖具体 Client；
  - 跨模块仍只能使用公开 `index.ts`。
- 把业务测试中的具体 Client 强制转换替换为窄端口替身。

重点验证：

- 模块依赖白名单与 `AGENTS.md`、`src/README.md` 一致。
- 协议生成、协议检查、全量单元测试和真实合同测试通过。
- 升级预览仍能准确报告受控导出和业务影响。

完成标准：

- 非测试生产源码中只有 `codex-client` 导入 `codex-protocol`。
- 新增协议泄漏会由模块边界测试立即阻止。

## 阶段 7：项目内部模块复核

协议边界稳定后，继续完成尚未结束的模块复核，每个模块独立处理和提交：

1. `storage`（已完成）：最小绑定 Schema、内存/SQLite 一致性、原子清理和失败回滚。
2. `policy`：Surface Actor、账号和 Workspace 授权边界。
3. `event-bus`：有界队列、关键事件保护、关闭和消费者隔离。
4. `observability`：结构化日志、错误上下文和敏感字段脱敏。
5. `config`：TOML 边界、热加载分类、代理优先级和失败关闭。
6. `surfaces`：通用接口、Telegram 输入输出、审批和平台超时隔离。

这些模块不强行映射成官方 App Server 模块；只按项目职责、安全边界和生命周期复核。

## 阶段 8：Bootstrap 收尾

目标：在所有稳定端口确定后复核组合根，不让临时迁移逻辑留在生命周期代码中。

主要工作：

- 统一装配各窄端口、事件适配器和审批处理器。
- 复核启动、部分启动回滚、重连、订阅恢复、后台任务取消和关闭上限。
- 确认 Gateway 重启不会终止共享 App Server，原生 CLI 与 Telegram 继续共享 Thread。
- 删除迁移期间产生的孤儿接口、旧白名单和重复状态同步。

重点验证：

- `gateway-startup-cleanup`、共享 App Server、双客户端恢复和服务模板检查。
- macOS 与 Linux 服务重建前后的运行时行为不变。

## 每阶段工作流

每个阶段按以下顺序执行：

1. 重新读取 `AGENTS.md`、`docs/index.md`、本计划和涉及模块 README。
2. 查阅当前锁定版本生成类型、官方文档、固定版本源码和测试。
3. 记录本阶段现状、目标接口、失败行为和不处理范围。
4. 先增加或调整最接近边界的测试，再迁移一个完整纵向能力。
5. 删除被替代入口，不保留旧、新双路径。
6. 运行定向测试、类型检查、Lint 和文档检查。
7. 涉及协议、Transport、共享状态或审批时运行真实 App Server 合同测试。
8. 审查 Git 差异、模块索引和规则一致性，再运行 `npm run verify:commit`。
9. 经用户明确要求后单独提交；未经要求不推送、不发布、不重建服务。

每阶段提交应可单独回退。因为计划不改变持久化格式，回退以正常 Git revert 为主，不需要数据迁移。

## 完成判定

全部收敛完成需要同时满足：

- 生产源码只有 `codex-client` 直接依赖 `codex-protocol`。
- Application、Core、Routing、Approval 和 Surface 的公开接口不含生成协议类型。
- Core 和 Routing 不再解析原始 JSON-RPC `params`。
- 业务测试使用窄端口替身，不再强制转换成完整具体 Client。
- 未知 Notification 和 Server Request 的行为保持可观察与失败关闭。
- 模块边界测试、协议检查、全量测试、真实合同、构建、打包和文档索引全部通过。
- `docs/index.md`、`src/README.md`、模块 README 与实际依赖方向一致。
