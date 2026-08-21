# Thread Queue 与 Revert 开发设计

本文定义 Codex CLI `0.148.0` 实验 `thread/queue/*`、`thread/queue/changed`、
`thread/revert`、`thread/reverted` 以及 Revert 所需分页历史查询在 Gateway 中的采用方案。
它是实施合同，不表示当前 `main` 已经支持这些能力；完成本文验收项并更新
[`Codex 协议支持矩阵`](index.md) 后，才能对三个 Surface 宣布可用。

## 目标与顺序

采用目标是让 App Server 成为待提交用户消息和 Thread 历史的唯一事实来源，删除 Gateway
现有的平行内存队列。实现分成两个独立阶段：

1. 先完整接入原生 Thread Queue，并删除现有 `queuedFollowUps`、完成事件派发和失败清空逻辑。
2. 再让新建 Thread 使用分页历史，接入分页 Turn 查询和带显式确认的 Revert。

Queue 与 Revert 不在同一个提交或 PR 中实现。Queue 替换现有公开能力；Revert 会改变新建
Thread 的历史模式并增加破坏性写操作，必须单独审查和回滚。

## 固定事实来源

实现只以正式 Tag `rust-v0.148.0` 为准：

- [`thread_queue_processor.rs`](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/src/request_processors/thread_queue_processor.rs)：Queue 请求处理、分页和错误边界。
- [`thread_queue.rs`](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/tests/suite/v2/thread_queue.rs)：实验握手、容量、持久化、自动派发、中断和手动启动合同。
- [`thread_revert.rs`](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/tests/suite/v2/thread_revert.rs)：分页历史回退、活动 Turn 中断、通知和重启合同。
- [`thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/src/request_processors/thread_processor.rs)：Revert 只接受分页历史 Thread，并在回退后重新加载同一 Thread。
- 本地生成类型：[`codex-protocol/generated/v2/`](../src/codex-protocol/generated/v2/)。生成类型是字段名称和可空性的最终事实来源。

项目内 `upstream/openai-codex` 应保持在提交
`3ba0f711642a888aec92a611a3f3b2211157ff89`，即 `rust-v0.148.0`。不得用官方 `main`
补充或替代本设计。

## Queue 原生合同

### 对齐范围

| 原生合同 | Gateway 决策 |
| --- | --- |
| `thread/queue/add`、`list`、`update`、`delete`、`reorder`、`start` 六个请求 | 六个请求全部通过受控 Client 端口接入，不保留第二套本地排队方法 |
| 每个 Thread 最多 100 条 | 采用原生 100 条，不再保留 Gateway 的 10 条限制 |
| 列表默认每页 25 条、单页最多 100 条 | Application 和 Surface 默认展示 25 条；内部需要完整快照时最多一次读取 100 条，并仍检查游标 |
| `QueuedSubmission` 包含 `id`、`input`、`clientUserMessageId` | 保留两个身份字段；`clientUserMessageId` 使用现有 Gateway UUID 前缀生成，不从消息正文推导 |
| Queue 持久化在 App Server 的 SQLite 状态库 | 不写入 Gateway StateStore；公开文案明确说明重启后仍保留 |
| 空闲 Thread 入队后可以立即自动派发 | 不再要求 `/queue add` 只能用于活动 Turn，也不由 Gateway 手动启动下一 Turn |
| 活动 Turn 完成后自动派发，普通新 Turn 不会提前消费 Queue | 只消费正常 `turn/started`、`turn/completed` 生命周期，不实现本地完成监听器 |
| 中断当前 Turn 保留 Queue | `/stop` 不清空 Queue |
| 冷 Thread 恢复后继续派发持久队列 | `thread/resume` 后不执行本地恢复或重放；由 App Server 决定派发 |
| `start` 无 ID 时启动队首，有 ID 时可以启动非队首项 | 两种形式都开放；只在 Thread 已加载且空闲时调用 |
| 活动或存在待触发 Turn 时 `start` 返回 busy，并保留 Queue | 映射为稳定的可操作错误，不自动重试、不删除条目 |
| `reorder` 必须包含当前 Queue 的全部 ID 且每个恰好一次 | Application 从最新完整快照计算全排列；并发变化导致失败时提示刷新，不重试旧排列 |
| `thread/queue/changed` 只携带 `threadId` | 不把通知解释为队列内容；只使当前 Conversation 的短期选择快照和 Revert 确认失效，列表和写操作始终重新读取权威状态 |

Queue 依赖 App Server 的本地 SQLite 状态库。固定版本默认 Thread Store 为 local，但没有状态库、
使用 in-memory Thread Store 或上游明确返回 `user message queue is unavailable` 时，Gateway 必须
显示“当前 App Server 不提供持久队列”，不得退回旧内存实现。

### Gateway 必须保留的边界

以下差异不是重新实现 Queue，而是外部渠道的授权和展示边界：

- 所有读写先校验当前 Surface Actor、Workspace、Conversation 与 Thread 绑定；外部用户不能提供任意 Thread ID。
- Queue 归属 Thread，不归属某次 Gateway 进程。接管或转移前异步读取来源与目标 Thread 的权威 Queue；任一非空时阻止 Thread 被另一个外部 Conversation 接管，避免排队内容在新 Actor 下执行。
- Queue 非空时继续禁止把当前 Thread 转为后台绑定；先由用户启动、删除或等待队列排空。
- 第一阶段渠道命令只创建和更新纯文本条目。其他客户端创建的图片、音频、Skill 或 Mention 条目可以列出安全摘要、删除、排序或启动，但 Gateway 不允许编辑，以免丢失附件或扩大输入语义。
- 列表不得显示本地媒体绝对路径、Plugin 路径或未裁剪的上游输入；Client 只返回输入种类、可编辑状态和有界文字预览。
- `add`、`update`、`delete`、`reorder`、`start` 都是写操作，不在过载、超时或断线后盲目重试。`list` 是只读请求，可以使用现有有界过载重试。
- Ephemeral、Archived、不接受直接输入的多代理 v2 子 Thread，以及未加载的 spawned subagent，沿用 App Server 的明确拒绝，不增加兼容回退。

### 公开命令合同

实施时把现有 `/queue <描述>` 收敛为与原生方法一一对应的规范语法：

```text
/queue add <文本>
/queue list [页码]
/queue update <ID 或当前列表序号> <文本>
/queue delete <ID 或当前列表序号>
/queue reorder <ID 或当前列表序号> <目标位置>
/queue start [ID 或当前列表序号]
```

不同时保留 `/queue <描述>` 作为隐式别名。实现 PR 必须同步根 README、`/help`、三渠道菜单、
错误文案和命令测试。`list` 只在 Conversation 内存中保留有界、五分钟有效的“序号到条目 ID”
选择快照，不保存消息正文；`thread/queue/changed` 使快照失效。数字选择器没有有效快照时要求先
重新执行 `list`，完整 ID 则始终针对最新权威列表复核。跨客户端修改使条目或 reorder 全排列
失效时返回刷新提示，不猜测用户原意。

`add` 成功只表示 App Server 已接受条目。空闲 Thread 可能在响应后立即消费该条目，因此结果文案
不得承诺它仍处于某个位置；活动 Thread 下可以在重新读取后显示当前序号。列表默认每页 25 条，
最大四页，与原生 100 条容量一致。

### 模块落点

- `application/thread-queue-port.ts`：拥有稳定的 Queue 窄端口、列表页和安全条目摘要。
- `codex-client/queue-adapter.ts`：在官方 `UserInput` 与安全摘要之间转换；不把生成类型或本地路径带出 Client。
- `codex-client/client.ts`：封装六个 RPC，只有 `list` 允许只读重试。
- `codex-client/provider-routing-client.ts`：六个请求全部通过 `callForThread` 路由到 Thread 所属 Provider App Server。
- `application/conversation-service.ts`：完成授权后编排命令，维护不含正文的短期选择快照，解析选择器和计算最新完整 reorder 排列。
- `bootstrap/app.ts`：删除 `conversation-follow-up` 中由 Gateway 启动下一 Turn 的分支；后台 Thread 正常完成后的释放职责保留。
- `codex-client/notification-adapter.ts` 与组合根：校验 `thread/queue/changed.threadId`，只触发选择快照和 Revert 确认失效，不同步读取 Queue，也不阻塞 App Server Reader。
- `surfaces/conversation-command-format.ts` 与三个 Surface：只负责规范命令和平台文案，不保存 Queue 镜像。

必须删除以下旧实现及其只针对内存语义的测试：

- `ConversationService.queuedFollowUps`。
- `handleTurnCompleted` 的下一 Turn 启动逻辑。
- `maximumQueuedFollowUpsPerConversation = 10`。
- “Gateway 重启会清空”和“启动失败会清空整个队列”的文案与测试。

这些内容应替换为共享端口合同测试，不能保留两套逻辑以兼容旧行为。

## Revert 原生合同

### 前置历史模式

`thread/revert` 只支持创建时使用 `historyMode: "paginated"` 的 Thread；现有 Gateway
`thread/start` 没有显式发送该字段，既有 Thread 可能是 `legacy`，不能原地迁移。

Revert 阶段必须先完成：

1. `thread/start` 对 Gateway 新建 Thread 显式发送 `historyMode: "paginated"`。
2. Thread 稳定快照保留 `legacy | paginated`，供 Application 判断能力。
3. 受控接入只读 `thread/turns/list`，默认倒序、每页 25 条，并校验循环游标。
4. 既有 `legacy` Thread 明确显示“不支持回退；请新建分页历史会话”，不得修改内部文件、隐式 Fork 或伪造迁移。
5. Fork、Resume 和跨 Provider 恢复必须保留 App Server 返回的实际历史模式，不从客户端猜测。

Gateway 不复制完整 Turn/Item 历史到 StateStore。分页 Turn 只为当前命令读取和生成有界预览；
Revert 响应的 `thread.turns` 固定为空，不能当作历史已丢失，也不能从响应推断完整保留内容。

### 回退语义

`beforeTurnId` 指定的 Turn 本身以及所有更晚 Turn 都会被永久移出 Thread 历史，只保留它之前的
前缀。Revert：

- 不回退 Git、工作区文件、命令副作用、外部 API 或 MCP 副作用。
- 可以中断活动 Turn；App Server 会先产生 `turn/completed`，状态为 `interrupted`。
- 保持原 Thread ID、订阅和运行时设置，并在内部重新加载 Thread。
- 产生 `thread/reverted { threadId }`。
- 重启后仍然有效；旧 rollout path 会失效，后续只按 Thread ID 恢复。
- 未知 Turn 返回明确 `turn not found`，不得改成“已经成功”或自动选择相邻 Turn。

项目本来只按 Thread ID 恢复，不应为 Revert 保存或重新使用 rollout path。

### 显式确认

公开入口采用两阶段命令：

```text
/revert list [页码]
/revert <Turn ID 或当前列表序号>
/revert confirm <一次性令牌>
```

第二条只生成预览和一次性令牌，不执行写入。确认记录只保存在 Application 的有界内存注册表，
有效期五分钟，并绑定 Surface Actor、Conversation、Workspace、Thread、`beforeTurnId`、预览时
最新 Turn ID、活动 Turn ID，以及 Client 对 Queue 有序条目生成的不透明摘要。该摘要覆盖条目 ID、
`clientUserMessageId` 和完整输入，但不把正文或路径带出 Client。令牌不可预测、只能消费一次，
Gateway 重启后自然失效。

预览必须明确展示：

- 被删除的边界 Turn，以及该 Turn 也会删除。
- 当前能够确定的受影响 Turn 数；未遍历完整历史时不能显示猜测总数。
- 是否会中断活动 Turn。
- 当前 Queue 条数，并说明 0.148 原生 Revert 不负责清空 Queue。
- “不会恢复工作区文件或外部副作用”。

确认执行前重新分页读取权威历史和 Queue；目标不存在、最新 Turn、活动 Turn 或 Queue 摘要变化时，
确认失效并要求重新预览。这样既允许原生支持的活动 Turn Revert，也不会把五分钟前的确认应用到
已经变化的 Thread。

固定版本源码中 Revert 与 Queue 使用独立存储，Revert 请求没有清空 Queue；但官方 0.148 测试
没有覆盖二者同时存在的合同。因此实施前必须增加真实 App Server 合同测试，确认 Revert 后 Queue
的实际保留和派发顺序。测试未通过前，Gateway 应在 Queue 非空时拒绝 Revert，而不是自行清空；
通过并确认原生保留语义后，按预览提示保留 Queue，不增加隐式清理。

### 状态协调

Revert 成功后：

- 先正常处理 App Server 对活动 Turn 发出的 `turn/completed: interrupted`，使相关审批、用户输入和 MCP 交互失效。
- 校验并消费 `thread/reverted`，只使用 `threadId` 触发状态校正，不伪造被保留的历史。
- 重新 `thread/read` 或使用 Revert 返回的 Thread 元数据校正模型设置、状态和绑定；Thread ID 不变。
- 清除只属于被删除 Turn 的 Core 界面缓存，包括最近 Diff、Plan、Goal 展示和操作摘要；权威 Goal 是否保留以回退后的 App Server 读取结果为准。
- 不自动启动新的 Turn，不重放被中断输入，不重试 Revert。
- 其他客户端并发执行 Revert 时，以通知和下一次权威读取收敛；本地过期确认全部失效。

### 模块落点

- `application/thread-history-port.ts`：拥有分页 Turn 摘要、历史模式和 Revert 稳定结果。
- `codex-client/history-adapter.ts`：从官方 Turn/Item 只提取选择所需的有界摘要，不传播完整历史或敏感操作参数。
- `codex-client/client.ts`：封装 `thread/turns/list` 与 `thread/revert`；前者允许只读重试，后者禁止重试。
- `codex-client/provider-routing-client.ts`：按 Thread Provider 路由历史查询和 Revert。
- `application/conversation-service.ts`：生成和校验一次性确认，执行前复核 Thread、历史和 Queue。
- `codex-client/notification-adapter.ts` 与 `conversation-core`：增加受控的 `thread.reverted` 状态失效事件，不把原始响应带入 Core。

首期不接入 `thread/items/list` 公开浏览能力。只有真实合同或状态校正证明必须读取 Item 游标时，
才把它作为 Revert 内部只读依赖受控导出；不能借 Revert 扩展成完整聊天历史浏览器。

## 协议与配置边界

当前 JSON-RPC 初始化已经发送 `experimentalApi: true`，Queue/Revert 不需要新增 Transport 握手。
采用时仍必须：

- 从 `codex-protocol/index.ts` 只导出实际使用的 Queue、Turn 分页、Revert 请求响应和通知类型。
- 修改根 `AGENTS.md` 中“只有两个受控实验例外”的旧约束，精确列出新增方法，不借机开放其他实验 API。
- 更新 `docs/index.md` 的受控导出数、直接调用方法数、支持矩阵、固定源码说明和复核命令结果。
- 不增加运行时兼容层；运行中的 App Server 不是精确 `0.148.0` 时仍由现有版本门禁拒绝。
- 不新增 Gateway SQLite Schema，也不新增消息正文持久化配置。

Queue 是对现有 `/queue` 的完整替换，实施后默认可用，不另设功能开关。Revert 是新的破坏性实验
命令，但已经由分页历史模式、能力判断和一次性确认失败关闭；首期同样不增加全局配置开关，避免
出现协议已采用但三渠道行为因本机配置分裂的状态。若实施审查认为仍需灰度，应先修改本决策，
而不是在代码中静默加入开关。

## 提交与验证链路

### PR 1：原生 Queue 替换

1. 受控协议导出、Queue Port、适配器和 Provider 路由。
2. 六个 Queue 请求的 Client 单元测试，确认只有 list 可重试。
3. Application 命令、100 条容量、25 条分页、安全摘要和并发 reorder 失败。
4. 删除旧内存队列、完成监听和旧文案。
5. 三 Surface 命令、帮助和展示同步。
6. 把 `notification-adapter.test.ts` 中 Queue 通知的负向断言替换为只失效选择快照的正向合同。
7. 真实 App Server 合同：实验握手、100/101 容量、CRUD、四页分页、自动派发、活动 busy、指定非队首启动、中断保留、Gateway/App Server 重启和冷 Thread 恢复。

### PR 2：分页历史与 Revert

1. 新 Thread 显式 `historyMode: paginated`，稳定快照区分 legacy/paginated。
2. Turn 分页摘要、Provider 路由和 legacy 失败关闭。
3. `/revert` 列表、预览、五分钟一次性确认和执行前并发复核。
4. `turn/completed: interrupted` 与 `thread/reverted` 状态校正。
5. 从 `module-boundaries.test.ts` 的未支持清单中只移除实际采用的 `thread/turns/list`，并把 `notification-adapter.test.ts` 的 Revert 负向断言替换为正向状态失效合同；`thread/items/list` 和其他实验方法继续禁止。
6. 真实合同：空闲回退、活动 Turn 回退、未知 Turn、重启持久、旧 path 拒绝、下一 Turn 上下文排除已删除历史。
7. Queue 与 Revert 联合合同：保留/派发顺序得到官方 0.148 实测后，才能解除 Queue 非空拒绝。

两个 PR 都必须执行定向单元测试、`npm run check`、`npm run lint`、`npm run docs:check`、协议检查
和真实 App Server 合同；提交门禁再统一运行 `npm run verify:commit`。Queue/Revert 的创建和写入
失败测试必须同时断言没有自动重试。

## 完成标准与停止条件

只有同时满足以下条件，才能把升级决策和支持矩阵改为“已采用”：

- 旧 Gateway Queue 已完全删除，生产代码不存在第二套消息正文队列。
- 原生六个 Queue 请求、100 条容量和 25/100 分页均有本地与真实合同覆盖。
- Gateway/App Server 重启、冷恢复、多 Provider 和跨客户端修改不会丢失或串用 Queue。
- 新建 Thread 使用 paginated；legacy Thread 明确拒绝 Revert，且没有隐式迁移。
- Revert 具有一次性确认、执行前复核、活动 Turn 中断处理和“不会恢复文件”提示。
- Queue/Revert 联合行为已在真实 0.148 App Server 上锁定。
- `docs/index.md`、根 README、模块 README、三个 Surface 帮助和测试描述与实现一致。

遇到以下任一情况必须停止实施并重新审查设计：

- 真实 App Server 没有本地 Queue Store，或部署配置无法稳定提供 SQLite 状态库。
- 第三方 Provider App Server 对 Queue/Revert 的合同与 OpenAI 主实例不同。
- paginated 历史破坏现有 Resume、Fork、后台 Thread、Goal、审批或 Remote TUI 共享行为。
- Revert 与 Queue 联合测试出现未记录的自动派发、条目丢失或顺序变化。
- 为实现功能需要读取 Codex 内部会话文件、把正文写入 Gateway StateStore，或绕过现有 Actor/Workspace 授权。
