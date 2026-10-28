# 会话自动命名设计与验收记录

状态：已部署并重启 Gateway，线上一次自动命名已确认；其他 Provider、渠道与服务故障恢复仍待验收。范围为 Gateway 经 App Server 为已授权渠道会话生成名称。
不修改上游源码，不为未绑定历史批量命名，不接管原生 TUI 或 Desktop 发起的输入。

设计修订基线为本仓库 `7f89a1dfc2fbd49010cb6b1f31168fe9149e87f9`，实现基于方案提交 `4ac5fc7c` 后的工作区，分支
`feat/thread-auto-title-design`；上游为 Codex `0.164.0`、提交
`6aaac694803004a63c6f393d153c96d22521a6b9`。本页保留设计合同与开放验收；用户行为见
[用户指南](user-guide.md#会话自动命名)，本次部署范围与线上证据见下文。

## 结论与职责

在 Application 增加专门的自动命名协调器，通过 Codex Client 的窄接口运行隔离的临时
Thread。标题只经官方 `thread/name/set` 保存在原 Thread，继续由现有名称通知、Router、
Core 和 Surface 链路消费。Bootstrap 负责接线、授权能力与生命周期；不让 Surface
编排 RPC，也不让 Core 执行后台模型调用。

本轮不增加配置项、数据库字段或服务进程。自动命名会产生额外模型请求，实际用量仍由既有
Provider 指标记录。实现阶段须在用户指南说明触发范围、模型选择和失败后的行为。

## 已核对的事实与关联影响

| 边界 | 源码事实 | 对实现的约束 |
| --- | --- | --- |
| 上游触发 | TUI 在未命名 Thread 的 `item/completed` 用户文字消息后异步触发 | App Server 接口本身不执行这段 TUI 自动逻辑；不能只升级 Server 就宣称渠道已有自动命名 |
| 上游生成 | 临时 Thread 使用 `ephemeral=true`、`threadSource={feature:"thread_title"}`，单独提交带 `outputSchema` 的 Turn | 不往用户的原 Thread 插入命名提示词或标题回复 |
| 上游回写 | 解析后 `thread/read`，仅在 `name` 为空时调用 `thread/name/set` | 原 Thread ID 必须贯穿任务；读后写没有跨客户端条件写保证 |
| 普通提交 | Application 统一规范化文字、媒体、Skill、Plugin、Agent 和异步回答，使用 `clientUserMessageId`；活跃时可能 steer | 只改 `startNewTurn` 会遗漏追加输入和其他共享入口；以关联的完成用户 Item 确认触发 |
| 原生 Queue | Gateway 已移除 Queue 写入与管理，只保留模型选择、绑定及 Revert 的只读安全检查 | 不恢复 Queue 写入入口；原生 Queue 派发没有 Gateway 授权提交登记，跳过命名，保留已有只读保护 |
| 用户 Item 投影 | `toItemEvent` 把 started/completed 都映射成 `item.userMessage`，不保留原通知阶段 | 不能直接拿该事件代替上游 completed 条件；Client 需提供专用于命名的完成投影 |
| 手工改名 | `ConversationService.rename` 固定前台目标，要求空闲并串行执行 | 自动命名不能直接复用该高层命令，否则会被正常运行的 Turn 拒绝；底层 `setThreadName` 可复用 |
| Provider | Routing Client 按 Thread 选择实际实例，固定自定义主实例的路由键可能仍为 openai；已有 activity 屏障 | 不能只按字符串 openai 判断官方账户；整个临时任务均要持有原 Provider activity |
| 后台归属 | `/new`、`/resume` 可保留原运行 Thread 为后台绑定，完成后会释放 | 可以继续写原有后台 Thread；解绑、接管、撤权或释放后不能继续写，不转向新前台 |
| 名称消费 | `thread/name/updated` 同时投影为路由状态与 Core 事件；列表读取官方 name，并与 preview 分开保存 | 只用真实 name 判断是否已命名；不以 preview 或本地列表标题代替 |
| 各端展示 | 飞书、Telegram、QQ 已渲染名称更新；微信的回复窗口白名单不接纳 thread.name，Outbox 也无渲染分支 | 保持既有渠道投递范围；官方名称一致不等于四端都有独立改名气泡 |
| 模型桥 | Responses→Chat 已映射 `text.format.json_schema`；通用 Chat 同时带工具时可能退化为提示词约束 | 传递 schema 不证明模型遵守；必须本地严格解析，且按 Provider 记录实际验收范围 |
| 取消订阅 | 官方 unsubscribe 响应表示连接取消订阅，不表示正在执行的 Turn 已停止 | 取消和超时须另行 interrupt；不能把 unsubscribe 成功当成执行结束 |

主要实现依据：
[上游触发](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/app/thread_routing.rs)、
[标题生成与解析](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/app/thread_title.rs)、
[临时请求隔离](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/temporary_structured_request.rs)、
[上游回写](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/tui/src/app/event_dispatch.rs)、
[服务端命名与取消订阅](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server/src/request_processors/thread_processor.rs)。
本地关联入口见后文文件分工；所有事实为源码审查结果，未进行真实模型请求或平台投递。

## 输入归属与触发

采用“已授权提交登记 + Server 实际用户 Item”双向关联。仅凭客户端 ID 前缀、工作目录、
相同模型或绑定中恰有一个 Actor，都不足以把其他客户端的输入归因于 Gateway。

1. Surface、命令和异步回答入口在仍知道输入来源时，向共享提交接口传递显式上下文：精确
   actorId、用户实际任务文字及其来源。Application 在最终提交守卫通过、确定原 Thread 后，
   通过 Bootstrap 注入的授权工厂签发只用于命名的进程内授权范围，固定 Actor、Conversation、
   Workspace ID/cwd、原 Thread、实际 Provider 和绑定代次。该范围检查持续权限，不能通过
   Actor 数量或闭包猜出身份；缺少上下文就跳过命名，不拒绝原有正常提交。
2. 命名授权与输入提交守卫分开：模型调用和名称回写分别复核当前 Actor 权限、Workspace 和
   原绑定；不继承附件 dispose、按钮失效、问题结束、QQ 一次性票据或“必须仍是前台”等
   提交期条件。授权只能在原提交仍获准时签发，不能事后绕过失效检查重新签发。
   解绑再绑定不得复活旧授权；保留同所有者的普通后台绑定可继续有效。
3. 在写请求真正可能发送前登记 Thread、clientUserMessageId、命名授权、有界候选文字和
   实际提交文本摘要，随后标记 attempted。普通 start/steer、附件的共享提交和命令任务走
   相同能力。不改变现有 `SubmissionObserver` 的 Surface 来源语义，不覆盖 QQ 的既有观察器。
4. 不登记或处理 Queue add/update/delete/start；这些写入与管理能力已从 Gateway 移除。
   原生 Queue 派发及其他客户端输入没有本 Gateway 的授权提交登记，直接跳过命名，
   不读取 Queue 正文补建登记。现有模型选择、绑定与 Revert 的原生 Queue 只读保护保持原样。
   普通 start/steer 结果未知也不重发；仅由精确关联的用户 Item 结算已接受的输入。
5. Client 从当前连接的 `item/completed.userMessage` 投影 Thread、Turn、Item、clientId
   和文本摘要。出站协议编码与入站投影使用同一纯文本序列规范计算摘要，不保留完整正文；
   命名协调器要求与 attempted 登记精确匹配，重复通知按 Item 身份消重。非文本内容不参与
   摘要，因此这只证明相关文字一致，不证明媒体字节或当前编辑者身份；无法保持精确映射的
   上游展开路径跳过，不用模糊匹配补偿。先到的通知不要求等 RPC 成功才承认实际输入已接受。
6. 候选文字只来自已标明来源的用户任务、附文或允许使用的转写，不事后解析附件 wrapper。
   `videoAttachmentBody` 的能力引用和元数据、`textAttachmentBody` 的暂存路径、系统生成的
   Skill/Plugin/Agent 指令都不能进入候选。用户主动写出的路径可作为其任务文字；系统不额外
   附加路径。纯媒体、只有合成附件说明或没有可靠文字来源时不触发。
7. 名称必须经权威 `thread/read` 确认未设置。`undefined` 表示未知，不能当作空名称。
   普通前台或仍归属同一 Conversation 的普通后台绑定可触发；automation、子代理、
   临时 Thread、未绑定 Thread 和其他客户端输入不触发。恢复的无名会话只在收到本 Gateway
   新的合格输入后命名，不读取或批量补写过去的消息。

登记只持有身份、独立命名授权、摘要和短候选文字，不保存完整消息、附件或待执行输入。
候选只用于这一项标题任务，不能重放给用户 Turn。候选与固定指令合计最多 960 UTF-8 字节；
这不是整个模型请求上下文或费用上限，原生 instructions 和服务端上下文仍可能增加请求大小。
可选命名登记同步完成，不等待模型或后台资源；容量不足、缺少候选或登记失败不改变主输入的
提交结果。原有输入授权守卫仍照常执行，不能借“跳过命名”放行原本无权提交的输入。
初始容量建议为全局 512 条、单 Thread 16 条、登记有效期一小时；超限或过期直接跳过可选命名，
不拒绝用户正常消息。Gateway 重启、Provider 断线、绑定失效后不恢复旧登记；无登记的迟到
用户 Item 跳过命名，后续新的合格 Gateway 输入可重新触发，但仍须满足 Provider 未被隔离。
原生 Queue 派发始终不属于本轮触发范围，不因重启或恢复绑定扩大范围。

## 临时生成接口与隔离

Application 拥有 `ThreadTitlePort` 与稳定请求/结果类型；Client 实现
`generateThreadTitle` 及带期限的生成名称写入能力，所有协议参数与通知收集留在 Client。
写入结果区分已应用、已有其他名称和未确认；复用现有命名 RPC 的内部实现，不把默认 60 秒的
手工命名接口直接套进五秒阶段期限。Routing Client 以原 Thread 选择实例，在有界的生成及
主动清理期间持有既有 Provider activity，不让设置应用或空闲释放插入；期限后仅保留清理
责任和命名隔离状态，不无限占用 activity 阻塞正常 Provider 操作。
设置应用须在等待 activity 排空之前取消命名任务，不能把取消放在屏障之后形成相互等待。
不把通用 Thread/Turn 端口扩展成可传任意 config、schema 或工具的业务接口。

临时 Thread 必须使用明确的原 cwd、实际模型 Provider、`ephemeral=true` 和官方
`feature:thread_title` 来源。不能直接调用现有普通 `startThread`：该入口写入 user 来源、
paginated 历史并可注册计划任务工具，也没有完整工具隔离配置。

隔离采用锁定上游 `start_temporary_thread` 的完整配置范围：先 `config/read` 读取目标 cwd
的实际 MCP 集合，将所有 MCP 显式禁用；禁用 Shell、统一执行、网络搜索、图片、Apps、
Plugin、Skills 指令、Hooks、Memory、Goal、多代理、计划、用户问题等工具或扩展；
环境、动态工具、运行时根与 capability roots 显式为空。不能只设置 read-only 或只传
`dynamicTools:[]` 就宣称工具已关闭。

权限不扩张：有当前自定义 Permission Profile 时保留并核对响应身份；否则请求内置只读
profile 并核对实际 sandbox。受管策略阻止隔离或实际配置不可确认时跳过生成，不使用更宽
权限或其他 Provider 重试。所需 profile 来自原 Thread 的已确认执行上下文，不能从不相干的
全局设置猜测。原 Thread 运行权限与临时 Thread 工具隔离是不同业务约束。

当前 `ThreadSession.effectiveSettings.permissions` 已来自官方 activePermissionProfile，
但 Router 未保留这部分当前事实。需新增明确区分未知、已确认无自定义 profile、已确认自定义
profile 的稳定投影，同时消费 start/resume/fork 生命周期响应与同步 settings 通知中的
profile/sandbox。订阅失效、断线、生命周期变化和旧连接迟到响应使旧快照失效；不能把缺字段
当作“没有 profile”，也不能只缓存首次创建时的值。取得这一当前上下文是临时请求的前置条件。

`runtimeWorkspaceRoots`、`environments`、`selectedCapabilityRoots` 等在固定上游中属于
实验请求字段。实施前必须把新增用途逐项登记到 `docs/index.md` 的受控边界，复核现有
experimental 协商与全部随之开放的 Server Requests；生成类型存在不等于本项目已允许。
现有 permissions/dynamicTools 的用途也须明确覆盖标题隔离，不能借计划任务例外扩大权限。

临时 Thread ID 一旦返回，就在提交 Turn 前注册专属通知收集器和拒绝交互处理。
只收集匹配 Thread/Turn 的最终 AgentMessage，成功必须同时有合法 JSON 和官方 completed
终态；乱序通知需在有界缓冲内与 turn/start 响应关联。该 Thread 的文本、错误、状态、工具请求
不进入普通 Core、Surface 或后台绑定清理。其他 Thread 正常流转。
意外交互明确安全拒绝并取消命名；不弹到平台、不自动批准。

初版固定使用原 Thread 已确认的当前模型，临时请求的思考等级仅从该模型目录选择合法值，
不修改主 Thread 的模型、思考等级或 Fast 设置。这与上游优先使用 `gpt-5.6-luna` 的策略不同，
目的是避免额外账户判定与模型选择配置。不得跨 Provider 回退；不支持 schema 或返回非法结果
时保留原名称。各 Provider 的模型兼容性须在实施验收时分别确认。

标题规则沿用上游：用户语言、单行任务标题、最多 36 个 Unicode 码点、尽量少于五词、保留工单号。
解析只接受恰含非空字符串 title 的 JSON 对象；规范化空白、引号和尾部标点，并按 Unicode
截断。拒绝额外字段、非 JSON、空标题与超过 8 KiB 的模型正文。日志不保存提示词或生成正文。

## 回写与并发

每个原 Thread 同时最多一项生成任务，使用任务 token 隔离迟到事件。建议初始并发限制为
全局两项、每 Provider 一项；忙时跳过本次候选，不建立正文等待队列。

生成不持有 Conversation 锁。回写只短暂进入现有会话锁，重新核对原 Thread 的归属、
Workspace、Provider、订阅与任务有效性；原 Thread 已成为同一 Conversation 的后台绑定
时可以写原 Thread，绝不写新的前台。现有 `prepareThreadWorkspaceGuard` 会把前后台角色
变化判为失效，转后台时应取消旧守卫并重新取得针对同一原 Thread 的守卫，不能忽略异常。
如果后台绑定已释放则丢弃结果，不为标题额外保留绑定。

手工 rename 必须在已通过手工命令授权和目标检查、发送其写请求之前取消同 Thread 命名任务。
无论手工请求成功或失败，旧自动结果均不得重新应用；后续新用户输入可重新尝试。
原生端的名称变更通知同样同步失效自动任务，不能等有界展示队列消费后再处理。

真正回写前，调用 `thread/read(includeTurns:false)` 检查真实 name；只在 name=null 时
调用 `thread/name/set`，写请求不重试。现有协议没有 compare-and-set，因而不能保证外部客户端
在 read 和 set 之间的手动改名不被覆盖。实现不得声称跨客户端原子保护，也不事后自动“恢复”
旧标题。若产品要求绝对保护，需另立上游条件写协议议题，不能靠本地锁假装解决。

写入 RPC 成功后用匹配的名称通知或权威读回确认结果；通知观察须在发送前注册。通知先到、
请求后到均按同一任务结算，不乐观制造官方事件。RPC 失败、断线或结果不确定时不得再发写入；
仍可执行有界权威读取结算实际名称。有效名称继续由既有同步链路进入 Router 与展示。
写入期间收到与目标相同的官方名称只表示目标事实已满足，不能当作外部改名取消而丢掉已发写入
的结算；不同名称则使自动回写失效。任何取消都不撤销或重放已经发出的写请求。

## 取消 失败与关闭

任务至少区分等待用户 Item、生成中、取消中、已命名、已跳过、失败、清理未确认。
同 Thread 在本次连续有效绑定内最多进行两次生成；明确失败后也只允许后续新的合格用户 Item 触发第二次，
不使用定时重试。资源不足的跳过不消耗模型请求预算。结果不确定或清理未确认时禁止继续生成。
业务候选与次数状态只在内存中保存，随有效绑定释放，不建立持久会话索引。未确认清理的临时
Thread/Turn 句柄和 Provider 隔离状态由 Client 另行持有，不随原业务绑定释放或普通重连删除。

配置读取使用可取消的有界只读请求。创建 Thread、启动 Turn、写入名称均不能因普通 AbortSignal
丢弃已发请求的结果；否则可能失去临时资源 ID。每个写请求发出后按该阶段期限等待 RPC 结算，
取消只阻止后续新业务操作；期限到达仍须按结果未知处理，不能认为写请求未执行。需要在现有
JSON-RPC 层增加只供标题调用使用的本地单次请求期限参数，默认调用的 60 秒合同保持原样，
不另建 Transport 或重复请求。

初版保留现有 JSON-RPC 超时移除 pending、忽略迟到响应的语义，不新增迟到响应回收机制。
因此十秒期限后即使 Server 返回资源 ID，本任务也不能依赖它恢复身份；普通取消保留期限内
响应，与超时后丢失关联是不同情形。身份未知直接进入下述持续隔离及人工恢复流程，不能宣称
缩短本地请求期限同时解决了资源回收。

| 阶段 | 初始期限与结算 |
| --- | --- |
| 命名授权、模型目录和配置预检 | 共十秒，只读请求与排队共用截止时间；失败不创建临时 Thread |
| 临时 Thread 创建 | 十秒，发出后不因普通取消丢弃响应；到期身份未知则隔离本 Provider 的新命名 |
| Turn 启动与生成 | 合计三十秒，从 turn/start 发出计时，启动 RPC 最多十秒；剩余期限等待匹配官方终态及合法标题 |
| interrupt 与终态观察 | 独立五秒，共用截止时间；只发送一次，对已知 Thread/Turn 收集终态；未知 Turn 身份保留未确认状态 |
| unsubscribe | 五秒；仅结算连接订阅释放，不代替执行终态。只有执行已结束且订阅已释放才记为正常清理完成 |
| 原 Thread 最终校验、名称写入和读回 | 共十秒，锁等待也计入；set 最多五秒且不重试。超时后只在剩余预算内读取实际名称，未确认单独记录 |
| Gateway 停止期间的全部命名清理 | 所有任务共五秒，不按任务累加；期限到达只停止等待和回写资格，不宣称模型已停止 |

各阶段不在持有 Provider activity 时等待另一个需要同一 activity 排空的操作。模型调用不在
Conversation 锁内；最终回写锁必须在总期限内才进入行动，超时等待的闭包随后取得锁也不得
继续发送。正常运行的清理在丢弃标题后仍保留专属通知收集器至结算或明确未确认状态。

Thread/Turn 创建超时且身份未知、取消订阅失败或终态未确认时，保留受限清理状态并记录阶段和
原 Provider；不把错误伪装成普通“无标题”。同 Provider 暂停新命名，不以连接关闭或重连解除
隔离。已知身份只核对和回收本任务精确资源，必要时重连后读取该临时 Thread 的最小执行状态；
只有足以确认原 Turn 已终止且订阅已释放的证据才能结算并解除该任务造成的隔离；同 Provider
仍有其他未确认任务时继续禁用。身份未知或无法确认时保持禁用，不扫描或清理其他客户端的
临时 Thread。初版不增加“强制解除隔离”命令，也不接受人工声明代替执行终态证据。
临时任务的资源释放不依赖原 Actor 仍获授权，
撤权只禁止新的模型调用和原会话名称写入。

人工恢复合同如下，实施时同步写入用户指南：

1. 隔离时记录结构化诊断：实际 Provider、原 Server 实例的生命周期标识、任务 token、失败阶段、
   已知 Thread/Turn ID、未确认原因及是否仍持有订阅。实例标识来自运行时已确认身份，不能只用
   Provider 名称或可复用 PID；若无法取得则明确记录未知，不能据此自动判定实例已更换。
   不记录候选文字、模型正文、凭据或未知上游错误原文。
2. 已知精确资源且 Client 能取得终态和订阅释放证据时，由清理状态机自动结算；人工通过既有
   日志入口查看结算或仍隔离的原因。只读失败、资源不存在或连接断开本身均不作为终态证明。
3. 身份未知或持续无法确认时，本进程保持禁用。管理员须在另行授权的维护窗口，使用既有服务
   管理流程确认原 App Server 实例确已退出，再启动所需服务并重启或重载 Gateway。该操作会
   影响共享 Server 的其他会话，不由命名任务自动执行；正常输入不必为恢复自动命名而停服。
4. 操作记录应包含原实例退出的监管器或进程生命周期证据，以及新实例身份。只有这些证据齐备
   才能把操作记为已完成恢复；无法取得证据时维持禁用，不把单纯 Gateway 重启、断线重连或
   Provider 设置应用记为清理成功。Gateway 重启虽会丢失内存隔离记录，仍不证明原执行已结束。

Bootstrap 在停止的同步入口先禁用准入并取消任务，然后在 Codex Client 关闭之前等待其清理。
接入构造失败清理、重载、Provider 断线/设置变更、Thread 归档/删除/Revert/关闭、解绑/接管和
Actor 撤权路径。已有 60 秒 RPC 默认期限不能直接叠加进 Gateway 的 30 秒服务关闭预算：
关闭最多给命名任务五秒等待。先停止新任务并保留专属通知收集器进行取消、结算，再移除普通
通知监听并关闭所拥有的 Client 连接；未完成者撤销回写资格并明确记录未确认。
连接关闭只释放连接：上游仅在无订阅者且非 Active 时卸载 Thread，活跃模型请求可能继续。
本方案不持久化清理句柄，故进程退出或崩溃后无法继续追踪未知在途任务，不能承诺跨重启零残留
或严格累计调用上限。这是实施后的故障恢复限制，须与普通重连保留隔离区分。
命名任务不增加后台服务或终止共享 App Server；三平台共用同一生命周期合同。

## 文件分工与实施顺序

| 模块或文件 | 必要改动 |
| --- | --- |
| `src/application/thread-title-port.ts`、`thread-title-service.ts` 及公开 index | 稳定窄端口、授权提交登记、有界任务与最终回写策略 |
| Surface 输入、命令执行及异步回答的共享提交上下文 | 传递精确 Actor 和原始用户任务候选；在最终提交授权边界交接独立命名授权，不以一次性票据充当持续权限 |
| `src/application/conversation-service.ts` | 共享 start/steer 登记与失效清理；手工命名取消；不替换现有提交观察器，不恢复 Queue 写入能力 |
| `src/codex-client/thread-title.ts`、`client.ts` 及公开 index | 官方通知完成投影、固定临时配置、schema、校验、结果收集、安全拒绝与资源回收 |
| `src/codex-client/provider-routing-client.ts`、`json-rpc.ts` | 原 Thread 选路、实际 Provider 身份校验、贯穿任务的 activity、命名单次请求期限、跨普通重连保留清理责任与隔离诊断；明确超时后不接收迟到响应 |
| `src/session-routing/router.ts`、Thread 稳定执行上下文及设置通知投影 | 生命周期与同步设置通知共同维护当前 profile/sandbox，失效与迟到保护；提供同原 Thread 的守卫，不建立新绑定 |
| `src/bootstrap/gateway-component-graph.ts` | 注入授权、生命周期及运行时已确认的 Server 实例身份供隔离诊断，无法确认则显式未知；当前连接的通知准入、名称同步失效、绑定变化、停止顺序 |
| 名称通知、Core 与 Surface | 复用官方名称链路；必要时在命名确认后失效派生显示缓存；保持现有 routine_notifications、微信白名单及纯文本安全 |
| `src/codex-protocol/index.ts`、`docs/index.md` | 只添加当前用途所需受控类型与字段说明，不手改生成文件，不扩大任意临时请求接口 |
| 模块 README、`docs/user-guide.md`、本方案及 `index.md` | 同步职责、用户可见触发/费用/限制、支持矩阵与实际验收状态 |

先完成当前权限事实投影、独立命名授权与输入候选来源，再完成临时请求的隔离及各阶段回收，
随后接普通提交身份与生命周期，最后接回写和四渠道消费。
每阶段核对现有端口调用方，避免把命名专用配置下放到普通 Thread 创建路径。

四端读取同一个官方名称；飞书、Telegram、QQ 是否发送独立改名提示继续遵守现有显示设置。
微信保持现有投递白名单，经列表及名称事实归约之后新产生的完成展示消费名称，不追溯改写
已发消息。标题晚于最后一次完成时，微信需要查询列表才能看见；本轮不扩大其主动通知范围。

## 观察计划与实际证据

2026-10-28 已观察以下边界，使用独立临时 Home、安装的 Codex CLI `0.164.0` 和自有 stdio
App Server，不访问真实账户，不发送平台消息，不重启共享服务：

- 实际 `Router.ensure → thread/start` 返回 `:read-only`；同所有者转后台后授权 key 不变且旧守卫
  仍有效。真实 `thread/settings/update` 切到 `:workspace`，等待官方通知后权限投影为
  `workspace-write`。取消订阅后投影未知、旧守卫拒绝；缺失 profile 不冒充 null，迟到设置不复活。
- `Application.submit → 实际 completed 用户 Item → 自动命名 → thread/name/set → thread/read/list`
  已跑通，原 Thread 的读取与列表名称均为“整理发布说明”，结算 `applied`。本地 HTTP 共两次请求，
  普通 Core 未收到标题 JSON，Client 诊断为未隔离、活动零、未确认清理零；随后手工改名读回“手工名称”。
  此路径的模型端是只监听 `127.0.0.1` 的受控 Responses 返回，证明协议与应用编排，不能证明真实
  模型的标题质量、Provider schema 兼容性或平台投递。任务进程已关闭，临时 Home 已删除。
- 解析人工挑战：重复 title 键、额外字段、非 JSON 围栏、空标题与超 8 KiB 正文均拒绝；40 个
  emoji 按码点截为 36。摘要保留文本分段边界，started 和旧连接通知不触发；全角尾标点沿锁定
  上游规则保留，只清理其定义的 `.?!`。
- 协调器人工挑战（内存端口）：摘要不匹配、缺少来源时模型调用零、写入零；同 Item 重复通知
  仅启动一次生成，期间手工名称到达后迟到生成结果结算 `cancelled`、写入零；撤权后新登记也不
  增加模型调用或写入。此项覆盖本地取消编排，不等于真实平台交互并发已验收。

集成只读复查发现并修正两处边界：Provider 标题调用只使用已连接实例，不通过可能等待普通
60 秒 Hook 刷新的连接准备路径；同步设置归约前检查当前连接，旧设置不能覆盖新连接权限与模型。
以上修订由主代理核对实际源码；该轮集成复查范围有限。随后按用户要求，由 Astra 独立进行
四渠道输入到授权登记、完成事件、临时隔离、取消清理、名称写入与显示消费的全链路关联审查，
包含撤权、旧连接、重复事件、非法输出、超时和未知资源等反例。

本次全链路审查确认一处 P2：临时 Turn 已结束但退订失败时，普通重连没有补偿；若其他订阅者
保留 runtime、没有 `thread/closed`，该 Provider 会持续禁用自动命名。已增加连接握手后的
五秒总预算恢复，只补偿有精确终态证据的资源，保持未知资源隔离；Astra 已复核该修复源码。
主代理另补 `thread_title.recovery` 前后诊断，覆盖主实例、受管、自定义和聚合 Provider。

本轮新增实际观察：固定自定义主 Provider 的 `openai → title-local` 路由，经真实 App Server
与受控 localhost Responses 端跑通 `Application.submit → applied → thread/read`，名称为
“整理发布说明”，模型端两次请求均无工具，activity 回到零，普通 Core 未收到标题 JSON。
恢复分支使用内存故障注入直接调用 `Client.connect`：已结束资源恰好补做一次退订并解除隔离；
终态未知、身份未知均不发退订且保留隔离；退订再次失败保留隔离；诊断回调抛错不影响连接成功。
这些观察未创建测试文件，不等于真实断网恢复。真实 Unix Socket 重连演练在启动时被上游拒绝：
环境固定目录 `/tmp/codex-daemon-0` 权限为 `000`，上游要求 `0700`；未改动共享目录，
该边界仍待可用隔离环境补证。该轮隔离观察不覆盖真实 Provider、四平台往返和三平台服务恢复。

2026-10-28 后续部署当前工作树：`npm run install:global` 成功，四个标题关键构建文件与全局
安装产物 SHA-256 一致；`codexc restart gateway` 完成就绪检查。Gateway 主 PID 从
3863933 变为 3890943，App Server 主 PID 3863826 与启动时间保持不变，Relay、WebUI 也未重启。
用户随后确认收到“Session 名称已更新：明确命名的适用情况”；同一运行实例日志记录
`thread_title.result`、`provider=openai`、`outcome=applied`。这是一次线上生成、官方名称写入与
用户可见通知的证据，不扩展为所有 Provider 或四渠道完整验收，也不据此推断模型质量稳定。
提交前关联复核复用此前 Astra 全链路审查，并核对授权登记、输入来源、Provider 选路、绑定失效、
旧连接通知、恢复与回写链路，未确认新的代码缺陷；本轮更新部署与验收状态，保留故障恢复开放项。

当前实现保守保留未确认资源；重连后的 ephemeral 元数据不提供精确 Turn 终态证据，不凭
`idle` 或“资源不存在”解除隔离。已知同 Turn 终态与订阅释放，或官方对应 runtime 关闭通知，
才可结算已知资源。Server 实例身份在当前接线中明确记为未知，人工恢复仍须自行保存监管器或
进程生命周期证据。每 Client 最多保留 2,000 个临时身份，满后跳过新命名，不淘汰身份放行迟到通知。

不新增或修改测试文件、fixtures、守卫或探针脚本。按实际改动运行既有类型、模块边界、lint
与文档检查；这些只记录工作流状态。使用隔离数据和既有入口进行下列人工挑战，记录实际输出。

| 场景 | 必须观察的结果 |
| --- | --- |
| 一个渠道的真实文字输入 → 生成 → 列表 → 原生端读取 | 原 Thread 的官方 name 持久化，原对话没有命名提示或标题 JSON；下一次读取仍有名称 |
| 运行中 steer、附件附文、Skill/Plugin/Agent/异步回答 | 独立命名授权不因正常 dispose/问题结束失效；仅用户任务候选进入模型；纯媒体、合成附件说明及原生 TUI 输入不触发 |
| 原生 Queue 派发、其他客户端输入、重启后迟到 Item | 没有 Gateway 授权提交登记则跳过；不读取 Queue 正文或恢复 Queue 写入口；既有只读安全检查保持有效 |
| 重复/乱序 Item、超长中文、注入文本、非法 JSON、额外字段 | 去重、UTF-8 与 Unicode 边界正确；无工具或平台交互；无错误名称写入 |
| 手工 rename、外部改名、切换前台、释放、接管、撤权 | 本地手工操作优先；仍保留的原后台可安全回写；失效目标丢弃；不声称外部条件写原子性 |
| 超时发生在创建、Turn 启动、生成、interrupt、unsubscribe 和名称写入 | 身份未知与清理未确认可见；无盲目重试；已发结果结算；不影响主任务 |
| 创建超时后迟到响应、Provider 持续隔离与人工恢复 | 迟到响应不恢复身份；精确资源清理有证据才解除隔离；未知身份保持禁用；隔离环境中确认原 Server 实例退出后再恢复，单纯 Gateway 重启不记为清理成功 |
| Provider 自定义固定主实例、多账户、断线、设置应用和空闲释放 | 同一实际 Provider 全程选路；没有跨账户回退或泄漏；活动租约与取消有效 |
| Gateway 启动期间停止、正常关闭、重载、重连 | 准入立即停止；五秒总清理等待；未确认资源不因断线判为已停止；普通重连保留隔离；共享 Server 存活 |
| 四渠道名称事实与历史列表 | 读取同一官方名称；独立通知遵守既有渠道政策，微信只验证列表及后续完成展示；不把既发消息当作会自动更新 |

真实模型、四个平台以及 macOS/Windows 服务路径尚未观察；实施时按可用环境逐项记录。
不为方案审查调用真实账户、发送外部消息、部署或重启用户服务。

## 独立方案复审

历史记录：初稿基于 `8b287192e118f97c021aa9b9b02bba02cdd17fc7`，已由 `gpt-6-astra`、high
独立复审完整初稿及相关代码。复审识别两项 P1 和三项 P2：提交守卫
不能充当长期命名授权、连接关闭不保证模型停止、Queue 编辑保留 clientId、附件合成说明属于
Text、微信投递准入早于渲染。主代理核对报告与源码后，已将对应授权交接、精确文本摘要与候选
来源、资源责任与阶段预算、微信展示范围修订合入，并补充当前 profile 的同步投影和 Provider
设置取消顺序。本段记录复审初稿及主代理整合，不声称 Astra 再次完整复审了修订后的文本。

本次按 `7f89a1dfc2fbd49010cb6b1f31168fe9149e87f9` 修订，移除已取消的 Queue 写入相关设计和
Reserve 引用，明确 JSON-RPC 超时丢弃迟到响应以及持续隔离的人工恢复合同。上述历史复审不代表
当前修订版已再次通过独立复审。

剩余边界为外部改名无条件写保护、跨进程未知任务无法继续追踪、重启后无登记则跳过，以及真实
Provider、平台、隔离恢复和三平台服务的实施验收。它们不以静态检查或方案复审标为通过。
