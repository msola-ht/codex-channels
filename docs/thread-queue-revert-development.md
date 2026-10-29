# 原生 Queue 只读保护与 Revert

本文定义锁定 Codex CLI `0.164.0` 的原生队列只读检查、分页历史和 Revert 合同。
Gateway 已移除会话 Queue 用户功能、Goal 及 Luna Reserve 自动回退；不删除 App Server 中已有的队列、
目标和会话历史，也不修改原生客户端配置。不添加、更新、删除、排序或启动队列项。

## 原生队列只读保护

保留 `thread/queue/list` 和 `thread/queue/changed`，仅用于以下边界：

- Revert 预览显示条数；确认前比较完整有序输入指纹，变化使待用确认失效。
- 模型、思考等级、速度和 Plan 的待生效选择不能与原生队列冲突。
- 转移、切换和释放绑定前核对原生队列，防止内容在错误 Actor 下执行或丢失后台绑定。
- 恢复非空队列的 Thread 时沿用原 Thread 设置，清除冲突的待生效选择。
- 后台释放前只读检查；有条目时保留绑定，不再主动调用 `thread/queue/start`。

Client 只返回 `itemCount`、`nextCursor` 和不可逆 `fingerprint`，指纹覆盖完整有序条目的 ID、
`clientUserMessageId` 和原始输入，不以截断的文字预览代替。Application 不接收队列正文、
媒体路径或 Skill 路径，不保留用户 Queue 列表选择快照。
内部完整检查最多读取原生容量 100 条，仍验证游标和完整性。未知、失败或不完整状态不能当作空队列。
Revert 无法读取完整队列时拒绝确认；绑定与模型安全检查保留各自既有的不可用与失败语义。
读取保留 Actor、Workspace、Thread 绑定及异步等待后的实时授权守卫。
变化通知只用于 Revert 快照及确认失效，不在 Reader 回调内等待 RPC 或平台网络。

- `application/thread-queue-port.ts`：最小只读端口、页状态和已知不可用错误。
- `application/thread-queue-reader.ts`：有界读取、完整性和错误映射。
- `codex-client/queue-adapter.ts`：官方响应到条数、游标与指纹的投影。
- `application/conversation-service.ts`：绑定、模型选择和后台释放保护。
- `application/thread-revert-service.ts`：历史选择、一次性确认与指纹复核。

## 固定事实来源

以正式 Tag `rust-v0.164.0`（`6aaac694803004a63c6f393d153c96d22521a6b9`）为准，
本机副本见[上游来源](upstream-sources.md)，不得用远端 main 替换。

- [队列处理器](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/thread_queue_processor.rs)：列表、分页和错误边界。
- [队列合同](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/thread_queue.rs)：持久化和原生派发。
- [回退合同](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/thread_revert.rs)：分页历史、中断、通知及重启。
- [生成类型](../src/codex-protocol/generated/v2/)：字段名称与可空性的最终来源。

## Revert 原生合同

### 前置历史模式

`thread/revert` 只支持创建时使用 `historyMode: "paginated"` 的 Thread；现有 Gateway
新建 Thread 已显式发送该字段，既有 Thread 仍可能是 `legacy`，不能原地迁移。

Revert 实现必须满足：

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

Turn ID 与数字序号都必须来自最近一次 `/revert list` 的同一页面快照；首期不接受任意历史 Turn ID
并从头扫描全部历史。确认前重新读取第一页和目标页：第一页用于复核最新 Turn 与活动 Turn，目标页
用于复核目标仍处于相同位置；同时复核 Thread 历史模式和完整 Queue 摘要。任一游标、顺序、目标、
最新 Turn、活动 Turn 或 Queue 在最后一次执行前复核时发生变化，令牌立即失效。固定版
`thread/revert` 不提供历史版本号或条件写入参数，因此外部客户端仍可能在最终复核与写请求之间
追加 Turn；预览必须提示确认完成前不要从 TUI 或其他客户端继续操作该 Thread，不能宣称原子防竞态。

预览必须明确展示：

- 被删除的边界 Turn，以及该 Turn 也会删除。
- 当前能够确定的受影响 Turn 数；未遍历完整历史时不能显示猜测总数。
- 是否会中断活动 Turn。
- 当前 Queue 条数，并说明原生 Revert 不负责清空 Queue。
- “不会恢复工作区文件或外部副作用”。

确认执行前重新分页读取权威历史和 Queue；目标不存在、最新 Turn、活动 Turn 或 Queue 摘要变化时，
确认失效并要求重新预览。这样既允许原生支持的活动 Turn Revert，也不会把五分钟前的确认应用到
已经变化的 Thread。

固定版本源码中 Revert 与 Queue 使用独立存储，Revert 请求没有清空 Queue；官方 0.148 测试没有
覆盖二者同时存在的合同。升级前的真实 App Server 联合合同实测已确认：Revert 后 Queue 条目和顺序保留，
Revert 本身不自动派发；显式启动队首后，后续条目继续按原生顺序派发。因此 Gateway 允许 Queue
非空时预览和执行 Revert，在预览与执行前用完整有序输入摘要复核，不自行清空、重放或启动 Queue。
当前没有执行后 Queue 回读；不能把回退响应成功解释为事后 Queue 状态已经再次核验。

### 状态协调

Revert 成功后：

- 先正常处理 App Server 对活动 Turn 发出的 `turn/completed: interrupted`，使相关审批、用户输入和 MCP 交互失效。
- 校验并消费 `thread/reverted`，只使用 `threadId` 触发状态校正，不伪造被保留的历史。
- 锁定 App Server 在内部恢复 Thread 设置并保留 ID 与订阅；Client 投影返回的 Thread 元数据，
  当前 Application 不据此改写 Router，也没有额外 `thread/read`，后续仍由权威通知和既有读取收敛。
- 清除只属于被删除 Turn 的 Core 界面缓存，包括最近 Diff、Plan 展示和操作摘要。
- 不自动启动新的 Turn，不重放被中断输入，不重试 Revert。
- 其他客户端并发执行 Revert 时，以通知和下一次权威读取收敛；本地过期确认全部失效。

### 模块落点

- `application/thread-history-port.ts`：拥有分页 Turn 摘要、历史模式和 Revert 稳定结果。
- `codex-client/user-input-summary.ts`：提供 Client 内部的 `UserInput`
  种类识别、有界文字预览和敏感路径裁剪；不从 `codex-client/index.ts` 公开。
- `codex-client/history-adapter.ts`：复用共享输入摘要，从官方 Turn/Item 只提取选择所需的有界摘要，
  不传播完整历史或敏感操作参数。
- `codex-client/client.ts`：封装 `thread/turns/list` 与 `thread/revert`；前者允许只读重试，后者禁止重试。
- `codex-client/provider-routing-client.ts`：按 Thread Provider 路由历史查询和 Revert。
- `application/conversation-command-parser.ts`、`conversation-command-service.ts` 与
  `conversation-service.ts`：解析规范命令，维护最多 500 个 Turn 的有界页面选择状态，生成和校验
  一次性确认，并在执行前复核 Thread、历史和 Queue。
- `codex-client/notification-conversation-events.ts` 与 `conversation-core`：增加受控的 `thread.reverted` 状态失效事件，不把原始响应带入 Core。
- `surfaces/conversation-session-command-format.ts` 与渠道：渲染统一列表、破坏性预览、确认结果和
  legacy/并发失败文案；同步 `/help` 与菜单，但不各自实现 Revert 状态。

首期不接入 `thread/items/list` 公开浏览能力。只有真实合同或状态校正证明必须读取 Item 游标时，
才把它作为 Revert 内部只读依赖受控导出；不能借 Revert 扩展成完整聊天历史浏览器。

## 协议与数据边界

只受控导出实际使用的 Queue 列表、变化通知、Turn 分页与 Revert 类型。
不接入 `thread/items/list` 公开浏览，不新增 Gateway Schema 或消息正文持久化。
现有实验握手和精确版本门禁保持不变。

历史联合观察见[升级补验](codex-cli-upgrade-decisions.md#2026-10-23-queuerevert-与原生-tui-补验)
和[确认与断线补验](codex-cli-upgrade-decisions.md#2026-10-23-确认断线与失败路径补验)。
这些属于删除前实现的观察，不表示当前仍开放 Queue 命令。本次清理尚未部署；
真实渠道交互、原生客户端并发和生产恢复仍未观察。
