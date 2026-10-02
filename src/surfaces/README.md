# Surface Adapters

本目录保存外部交互平台适配器。Surface 负责把平台输入转换为 Application 命令，并把 Core 输出和审批交互渲染为平台消息。

`index.ts` 是 Gateway 装配各 Surface 的主公开入口；通过显式异步加载函数提供三个渠道实现，
纯共享能力与凭据检查不静态加载飞书或 Telegram SDK。

`delivery-diagnostics/index.ts` 是离线投递诊断的窄公开入口，仅复用载荷解码和屏障分类，不加载平台 SDK 或数据库实现。
`persistent-output.ts` 分类可恢复的终态输出与独立生命周期通知，持久结果发送未知或授权失效后解除顺序屏障并保留记录、检查点与容量计费，并将必要图片纳入同一有界快照；
`delivery-receipt.ts` 关联一次可靠投递生成的排队操作和平台检查点。`SurfaceOutputPort.deliver`
等待实际操作结算，Bootstrap 才能确认持久记录；TG/飞书可靠正文还要求存在平台成功检查点，排队终态持有正文引用，独立于断线清理的临时流缓存；正文截断会要求完整原文附件的确认，缺少完整性依据则拒绝确认。`snapshot-delivery.ts` 将状态展示的失效信号与排队操作关联；`SurfaceOutputPort.deliverSnapshot`
允许按展示规则不产生消息，等待实际状态操作结束，并在平台调用前复核归属。普通 `handle` 继续用于中间输出。

Surface 只运输和呈现项目已经接入的 Codex CLI/App Server 能力。当前能力范围以
[`docs/index.md`](../../docs/index.md) 的支持矩阵为准；平台 SDK 提供某项能力或生成协议中出现
某个类型，不代表 Surface 可以自行建立新的 Thread、Turn、历史、工具或审批语义。Setup、
Doctor、菜单、输入状态、连接健康和平台媒体传输属于渠道运维或呈现能力，不能伪装成 Codex
原生功能。

当前实现：

- [`telegram/`](telegram/README.md)：Telegram Bot 输入、输出、交互、图片、一次性音频、UTF-8 文本文件和生命周期。
- [`feishu/`](feishu/README.md)：飞书官方 SDK 长连接、私聊文本、PNG/JPEG/WebP/非动画 GIF、一次性音频与 UTF-8 文本文件到
  Application 的窄 Adapter、富文本最终回复、纯文本安全提示、有界输出队列、私聊交互卡片、平台权限中心、
  用户 OAuth Device Flow 和单账号生命周期组合；有效配置启用时由 Bootstrap 显式注册。真实平台
  状态见 [`通讯渠道验收矩阵`](../../docs/channel-acceptance-matrix.md)。
- [`weixin/`](weixin/README.md)：微信 Setup 的严格独立凭据边界、固定版窄协议 Client、
  私有原子游标检查点、可取消接收监控器、授权后提交 Application 的私聊文本、图片、一次性
  音频与 UTF-8 文本文件输入 Adapter，
  以及复用统一会话命令服务的完整命令目录、加密回复上下文、重启上线通知、受限配置通知和
  Turn 完成统计；
  文本与生成图片有界 Outbox、带随机一次性 ID 的精确文本审批、用户输入与 MCP 交互端口，以及
  目录内部完整 `SurfaceAdapter` 已实现；严格运行配置显式启用时由 Bootstrap 注册单账号私聊
  Surface。

`secure-credential-store.ts` 提供 Surface 内部复用的 macOS Keychain、Linux AES-256-GCM 和 Windows
DPAPI 主密钥 + AES-256-GCM 字符串记录机制；平台模块仍各自拥有 Service、目录、记录键、载荷校验
和错误语义。

`types.ts` 定义最小 `SurfaceAdapter` 契约。每个实例使用
`surface + accountId` 标识，分别提供启停、输出、可选配置变更通知、计划任务确认呈现与 `InteractionPort`；Bootstrap
只通过编译期内置插件注册表显式注册。
Bootstrap 的内置插件注册表负责把一个渠道插件展开为零到多个账号实例并验证身份唯一性；
Telegram、飞书目录仍只实现平台 Adapter，不导入插件宿主或组合根类型。
`SurfaceOutputPort` 接收平台无关的 `OutputEvent`。Reader 只同步调用 `observe`；`deliver` 和
`deliverSnapshot` 的等待发生在后台 Conversation 队列，不阻塞 Reader。
可选 `observe` 在实时发布时执行本地生命周期处理，持久重放不再调用；`handle` 的直接调用仍处理本地状态。
`delivery-policy.ts` 定义最新展示快照的键及终态淘汰关系；Bootstrap 持有有界临时快照，平台不维护第二套投递恢复队列。状态进入渠道队列后仍属于该快照的预算；断线、终态与新轮次
会取消对应旧状态的未发送操作。状态发送失败或结果未知会向调用方报告，不自动重试整个状态。
Bootstrap 按 `surface + accountId` 精确选择一个输出端口，Surface 不再各自订阅全局事件总线。
平台投递只交给成功启动且仍处于运行状态的 Surface；本地生命周期观察不依赖渠道就绪。单个输出端口拒绝事件不得中断后续路由。
运行连接失败后，同一 Adapter 的 `start()` 必须能重新建立输入连接；Bootstrap 对每个账号实例
独立退避，不通过重启 Gateway 恢复单个渠道。`stop()` 用于 Gateway 关闭或账号永久隔离，必须可在部分启动后
安全调用并保持幂等。生产装配中的关键终态由 Bootstrap 提交独立持久投递箱，不写入 StateStore；
渠道恢复后按 Conversation 顺序交给 `deliver`，实际发送确认成功后才清除记录。渠道离线或存在前序
持久结果时，展示状态按键保留最新快照，正文增量依赖完整 Item，不另建流式恢复队列。未装配持久投递的独立使用路径仍采用内存恢复缓冲，按
`isSheddableBacklogEvent` 合并或削减中间输出。容量与恢复合同见[关键结果投递](../../docs/delivery.md)。
临时连接故障只能取消当前交互，不能把可恢复端口永久关闭。
配置变更通知使用结构化动作区分热加载、自动重启、需要重装、加载失败，以及第三方模型设置的
等待重启、重启中、已生效和失败；Surface 只渲染结果，不得接收原始配置值或异常详情。普通
生命周期通知可通过可选的 `configurationChanged` 异步入队；`deliverConfigurationChange` 必须等待
平台 API 实际发送成功，失败时抛出错误，以便 Bootstrap 保留尚未确认的持久化配置事件。
全局变更投递给所有 Surface；平台作用域变更只投递给匹配 Surface。进程重启和重装会影响所有
Surface，因此未匹配到具体变更的 Surface 仍会收到不包含平台私有原因的生命周期通知。

`ConversationDeliveryQueue` 提供可复用的每 Conversation 有界顺序队列：同一 Conversation 串行，
不同 Conversation 可并行；关键输出可以替换仍在等待的非关键输出。入队时可携带合并键，仍在等待
执行的同键条目会就地替换为最新载荷并保持顺序与容量计数，达到硬预算时仍允许等量替换。
取消会移除未执行操作并释放预算；不带回执的普通任务显式清除上个任务的异步回执上下文。新增 Surface
时应实现统一输入、输出和审批边界，通过 Application/Core 接入，并把平台发送操作放入该队列或
提供等价约束。`waitForIdle()` 在暂停新入队后限时等待当前任务结束，保留队列供恢复后继续使用。
Bootstrap 复用该队列隔离每个会话的完成统计准备，并关闭逐 Token 的普通阶段
调试记录；终态统计准备与慢队列警告仍保留。
`delivery-policy.ts` 是渠道投递策略的唯一判定点：`resolveSurfaceDelivery` 决定事件是投递、按合并键
合并还是忽略，并给出是否关键；渠道差异只保留微信回复窗口白名单和思考状态的合并键两张表，
Surface 不再各自维护允许列表或在 `handle` 内散落关键性字面量。Telegram 与飞书对同一 Turn 的
思考状态按分段合并，仅合并尚未执行的中间快照，创建首条状态和终态始终执行。
`SurfaceOutputCoalescer` 供出站总线与运行中路由复用：首条快照不合并，后续同段快照可被终态替换，
终态或同 Conversation 的其他事件结束当前合并段；不同渠道、账号、Conversation、Thread 和 Turn 不串段。
分段元数据最多保留 1,000 个 Conversation，淘汰只减少合并机会，不复用旧键；故障恢复缓冲仍采用最新状态策略。
`delivery-retry.ts` 为缺少其他恢复路径的渠道提供有界重试：只重试能证明请求未被平台接受的失败
（显式拒绝、限流、服务端错误），超时与网络中断一律不重试，避免重复气泡；等待有上限，且重试
保持在单次平台调用粒度，不在分段发送的上层重跑整段逻辑。
投递关键性有三个层次，不能互相替代：Core 的 `isCriticalOutputEvent` 区分完整输出与可丢弃的
增量或过程事件；`SurfaceDeliveryDecision.critical` 表示该事件在本渠道不得静默丢失，微信白名单
事件恒为真，其他渠道沿用 Core 判定；`ConversationDeliveryQueue` 的排队关键性决定队列满时该平台
发送能否被丢弃，由渠道按用户可见结果选择。收紧或合并任意两层前，必须先确认对应渠道的用户可见
结果。
Thread Queue 属于 App Server，由 Application 负责授权、25 条分页和五分钟数字选择快照；Surface
只渲染共享的 `/queue add|list|update|delete|reorder|start` 结果，不保存 Queue 镜像或消息正文。
分页历史 Revert 同样由 Application 统一编排；三个 Surface 只渲染 `/revert list`、预览和一次性确认结果，
统一提示仅支持新建分页历史 Thread、执行前会复核并且不会恢复工作区文件。Surface 不保存 Turn 历史、
确认令牌或 Queue/历史快照；按钮和菜单只能提交当前绑定 Actor 的规范选择器。
Gateway 计划任务同样由 Application 统一编排；三个 Surface 只渲染 `/schedule` 的类型化列表、Run、
预览与操作结果。飞书管理按钮携带完整任务或 Run ID 并继续走共享命令；显式命令和 `schedule_task`
工具预览都按精确 Surface 复用同一呈现入口，飞书与 Telegram 的创建/删除确认按钮提交同一五分钟令牌，
飞书按钮被接受后会把原卡片更新为无按钮终态，微信保留同一文本语法；
Surface 不保存任务定义、Prompt、选择快照或确认令牌。
审批卡片和其他需要等待结果的 `runOrdered` 操作排在所有既有关键消息之后，但会越过尚未执行的
非关键过程输出；关键消息与非关键消息各自保持原顺序。交互取消会移除尚未执行的发送，
并向在途平台请求传递取消信号；平台仍返回迟到消息时，按已知消息 ID 清理交互入口。
生产交互由 Approval Router 统一约束从排队到答复的总期限；发送准备不会延长有效期，
超时复用上述取消路径。Surface 自身的答复计时不能替代 Router 的全链路期限。
Telegram 和飞书在交互消息创建成功或失败时
只记录脱敏身份与平台错误分类，不记录审批正文。
完整接入顺序、组合工厂、身份、配置、存储和验证要求见
[`通讯渠道 Surface 接入指南`](../../docs/surface-integration-guide.md)。
关闭队列时拒绝新输出，立即结束 `runOrdered` 等待者并限时等待在途发送；超时记录告警，
清除余下积压且不再执行发送回调。飞书普通输出选择在期限内排空，期限结束再取消；
有序交互在所有模式下立即取消，其取消信号与普通输出相互独立。并发关闭调用等待同一个关闭结果，不能提前报告完成。
实现位于 `conversation-delivery-queue.ts`，并通过本目录 `index.ts` 公开。`enqueue` 可关联取消信号；已接受任务通过 `settled` 在移出队列或实际执行结束时结算一次，调用方据此释放上游载荷预算。取消在途任务不会提前结算。
`diagnostics.ts` 提供 Surface 内部共用的脱敏阶段计时与异步关联上下文，只携带账号、会话、
Thread/Turn/Item、事件类型及输入/投递标识；输出队列、输入处理和平台调用复用该上下文，
不保留事件正文。公开的 `withPersistentDeliveryDiagnostics` 供组合根注入持久记录 ID，各层通过 `persistentDeliveryId` 关联同一记录，单次操作的 `deliveryId` 独立保留。终态相关任务在 `info` 留痕，任务成功与正文投递成功分别记录，慢操作与失败在 `warn` 留痕；阶段明细、合并与取消
使用 `debug`。诊断不修改平台调用、重试或排队顺序，日志口径与排障步骤见
[`渠道展示与调试模式`](../../docs/display.md#调试模式)。
`surface-input-coalescer.ts` 是已授权 Surface 输入门面；`surface-input-batcher.ts` 只合并 Surface
明确标识的图片批次，普通文字、单图和无批次标识的消息立即提交。图片落盘后仍由渠道管理，批次
flush 时由该共享边界一次读取并复核可信 MIME、PNG/JPEG/WebP/非动画 GIF 签名、单张 10 MiB 与整批 20 MiB，转换为
有界 Base64 Data URL 再交给 Application；Gateway 只在本次 Turn 内存中持有 Base64，
不写入自身日志或独立存储，也不向 App Server 发送本地路径，不在 Surface 维护另一套识图会话或重试队列。
三渠道共享的 `/metrics` 分开展示当前 Thread 最近 Turn 的运行聚合、指标库保留范围内的会话累计，
`global/providers/models` 支持自然日/周/月、24 小时至 365 天滚动窗口和全部保留历史，
按同一请求口径聚合指标库记录，最多展示请求量最高的 20 组；`errors` 用同一
范围展示异常率及按提供商、模型、状态、HTTP 状态和错误类型形成的前 20 组异常，附带最近发生时间。
不把请求累计输入误写成上下文占用；聚合中的上下文压缩摘要单列请求数与 Token，不显示模型请求
聚合耗时、首段回复延迟、TPS、本地价格或费用；完成卡只显示官方整轮耗时，标为“本轮耗时”。
信息类聊天指令（`/status`、`/usage`、
`/limits`、`/models`、`/sessions`、`/skills`、`/mcp`、`/plugin`、`/permissions`、`/goal`、
`/metrics` 等）输出统一为 Markdown 列表：首行为 `##` 标题、小节为 `###`
标题、字段为 `-` 列表项、明细缩进嵌套；`/diff` 与操作结果保持原文。三个渠道分别用飞书卡片
Markdown、Telegram HTML、微信结构化字段渲染列表。
`/sessions` 和 `/archived` 共用可复制的分页/筛选命令，仅支持运行状态、固定状态、Provider 和关键词。
自定义会话分区入口及其管理员权限已移除。内置 Pinned 在三渠道统一复用 `/pin` 与 `/unpin`，
渠道只提交选择，不保存分区状态。
`turn-reply-targets.ts` 只在 Surface 内存中把待提交输入的精确平台消息 ID 绑定到实际
Thread 与 Turn，允许 `turn.started` 早于提交响应时仍原生回复正确输入；读取、登记与删除均核对
Conversation，旧会话完成不能删除新会话已登记的回复目标。不保存消息正文，Turn、Thread 或 Surface 关闭时清理。
`quoted-input.ts` 把各平台已验证的回复/引用正文转换为有界、明确标记且与当前消息分离的上下文；
引用获取仍由各 Surface 负责，不能读取 Gateway 私有历史或让引用内容参与命令解析。
`plan-presentation.ts` 统一完整计划与新增完成步骤的有界展示、状态符号和去重指纹；Telegram 复用
同一个按完整 Conversation 与 Turn 隔离并在完成时释放的进度状态，飞书保留原地更新卡片所需的平台消息状态并核对接收会话；微信不展示
结构化计划，其回复窗口只保留生命周期、终态与全局空闲通知。各渠道只决定完整计划是原地更新还是
追加紧凑进度。
`lifecycle-presentation.ts` 统一 Telegram、飞书与微信的 Gateway 上线、Turn 开始确认、子代理
开始/继续/完成通知和 Turn 结束汇报；OpenAI 启动传输探测全部失败时，上线通知增加代理检查提醒，
官方主路由缺少鉴权时增加未登录提示和 `codex login` 或 `/model` 的操作建议，不显示目标地址或
底层错误；飞书和微信仍只通知已有安全会话。完成卡片对 `unauthorized` 按 OpenAI 官方与其他
Provider 分别生成固定凭据提示，不展示上游原文。Turn 完成在正式与调试模式都显示当前
工作区、Session 名称和 Session ID，并在官方 `Turn.durationMs` 可用时显示本轮总耗时，把本次运行、
当前会话累计和账户状态依次分区；按 Turn
聚合统计代理捕获的全部模型请求与实际产生推理输出的思考次数，并保留 Provider
通用的 Thread Token/上下文与请求数累计指标；父 Turn 存在显式子代理时另展示递归任务合计，
不把子代理用量混入父 Turn 自身统计；本轮存在非正常模型尝试时，请求总数会进一步拆分为
完成、中断、未完整观测和失败数量；`429/5xx` 瞬时失败后存在成功请求时显示为“自动重试、最终
成功”，底层异常记录仍完整保留。完成卡片正式模式保留 Token 总计，调试模式才展开 Token 子项；
账户状态在正式和调试模式均显示剩余额度及可用的重置时间、剩余时长；含重置时间时标注时区。子代理完成卡片在值可靠时
展示思考等级、请求次数和 Token：正式模式保留总计，调试模式才展开缓存与推理 Token 和缓存命中率；
指标读取失败时只显示“统计暂不可用”。
原生 OpenAI 鉴权的 Codex Provider 统一显示为“OpenAI 官方”，且只在该类 Thread 显示 Fast 与
OpenAI 周限；配置的自定义主模型 Provider 追加“ · 自定义”标识（例如“OpenAI · 自定义”），
历史无 Turn 指标只在通用明细和时间范围聚合中按稳定 Provider ID 展示；各 Surface 只保留 HTML、
CardKit Markdown 或微信文本布局以及各自的发送策略。后台 Thread 的文本、审批和完成汇报均标注
短 Thread ID，并继续进入原 Conversation 的有界顺序队列。
`elapsed-duration.ts` 把已确认的 Turn、操作、推理状态和请求耗时格式化为自适应 `ms` / `s` / `min` / `h`，
三个 Surface、CLI 与 WebUI 共用该纯函数；账户用量秒数仍使用独立的中文周期格式。不负责计时、状态或持久化。
`account-format.ts` 统一套餐名称、额度状态、百分比、周期与重置时间格式，供命令结果、运行时通知
和生命周期汇报复用。
`conversation-model-account-command-format.ts` 为三个渠道渲染 `/limits reset` 选券预览、确认命令和消费结果，并在 OpenAI `/limits` 中展示重置券可用数量，并按相同
到期时间合并服务端返回的明细；`null` 到期时间明确显示为“无到期时间”，明细少于可用数量时标出
未返回明细的剩余张数。
`provider-format.ts` 统一已知 Provider 显示名、命令中的 Provider 文案及限定 Provider 后的模型显示名前缀裁剪，并对后续 Provider 标识做有界展示。
`slash-command.ts` 统一飞书与微信的严格斜杠命令解析，并规范化三个渠道共同公开的
`/h`、`/work`、`/r` 快捷命令；Telegram 在 Bot 注册边界接入同一组显式映射。
`conversation-command-format.ts` 只汇总稳定导出；纯格式化实现分别位于
`conversation-command-help.ts`、`conversation-session-command-format.ts`、
`conversation-scheduled-task-command-format.ts`、`conversation-extension-command-format.ts`、
`conversation-model-account-command-format.ts`、`conversation-workspace-status-command-format.ts` 和
`conversation-command-outcome-format.ts`，按帮助、会话、计划任务、Skill/MCP/Plugin、模型账户、
Workspace/状态与操作结果分派隔离。它们统一 Telegram、飞书与微信的平台无关命令文案，不导入平台 SDK，
也不写入 Application 状态；OpenAI `/usage` 以账户摘要为主，在当前 Thread 有效时追加有界的官方 Credits、可选美元、
字段完整时的 Token 汇总和最多 8 个明细组，官方估算不可用或查询失败时只追加稳定提示；DeepSeek `/usage` 显示余额，
未支持的 Provider 明确说明能力缺失。计划任务确认、列表、运行记录和命令结果格式也通过本目录
`index.ts` 供 Bootstrap 动态工具回调复用。
`conversation-command-renderer.ts` 把完整 `ConversationCommandResult` 穷尽映射为共享纯文本结果；
三个渠道复用该映射，Telegram 在自己的交互式渲染器中处理按钮、键盘及专属展示，其余结果统一走共享映射。
`/skill` 返回带序号的已启用项，`/skill <名称或序号> <任务>` 通过 Application
提交官方结构化 Skill 输入；Surface 不接收或拼装本机 Skill 路径。
`/mcp`、`/mcp health`、`/mcp reload`、`/mcp <名称或序号>`、工具/资源/模板分页搜索、`/mcp login ...` 与
`/mcp resource ...` 共用详情、OAuth 能力判断和只读资源格式；OAuth 完成结果由三个渠道共用格式，
成功静默发送、失败按错误通知发送；健康检查只展示需处理项与提示，刷新明确说明在 Thread 下一次
活动 Turn 生效；健康处理命令使用当前列表数字序号，最多展示 8 项并明确省略数量；资源正文明确标为
外部不可信内容。详情及分页中的后续命令沿用 Application 返回的原始选择器，Surface 不使用 Server
名称重新构造命令。
`/plugin` 无参数显示已安装项第一页，`/plugin list [页码] [search <关键词>]` 使用全局数字选择器
进行每页 8 项的本地分页过滤，`/plugin health` 只展示未启用、不可用和 Marketplace 加载失败等状态，
问题最多展示 8 项；只带选择器时查看开发者、分类、能力、认证时机及套餐等安全详情，能力与套餐
列表最多展示 8 项；`health` / `list` 同名 Plugin 带任务时仍可直接调用，详情使用完整 ID 或序号；
带选择器和任务时调用 Plugin，并统一显示开发中提示；飞书按相同分页生成一次性任务表单，
Telegram 使用当前页按钮和绑定 Actor 的十分钟一次性 ForceReply，微信提供可复制的编号任务命令；
各 Surface 都不拼装 Plugin mention 路径。
`user-facing-error-format.ts` 统一三个渠道的结构化用户错误文案，只保留渠道名称差异；
`error-metadata.ts` 统一渠道日志中的受约束异常类型、机器错误码和锁定 App Server
白名单拒绝分类，拒绝异常正文、堆栈、请求标识及上游自定义名称进入日志；Bootstrap
继续通过注入的 Pino `err` 序列化器处理组合根异常。
`input-copy.ts` 统一补充文字、文件、图片与音频追加到当前 Turn 的确认文案，以及
开始识别图片与本条要求时的进度文案，并统一视觉完成通知正式模式只显示 Token 总计、调试模式
展开 Token 子项与 API 耗时的展示策略；
`output-copy.ts` 统一 CLI 输入镜像、断线、警告、操作失败、停止交互、空回复与内容截断等输出
语义，以及 Thread 被其他 Codex 客户端占用与自动恢复的提示；各渠道继续自行决定 HTML、CardKit
Markdown、纯文本布局和发送方式。
`interaction-copy.ts` 统一审批、用户输入和 MCP 交互的处理、取消、超时、跨客户端解决及提交结果
语义；平台仍各自使用按钮、卡片或可复制命令完成交互。
`pending-interaction-registry.ts` 统一三个渠道待处理交互的请求 ID 与一次性令牌索引、容量限制、
请求级取消信号、准备期失效与立即释放身份及容量、完成清理和超时计时器释放；
旧请求的迟到清理不能释放同 ID 新请求的占用。平台仍各自负责授权复核、消息准备、输入解析、
决定映射和结果更新。
`text-file-copy.ts` 统一三个渠道文本文件下载失败、1,000,000 字节上限以及编码、空内容、文件名和控制字符拒绝文案，
同时保留渠道名称以便定位来源。`text-file-input.ts` 统一文件名安全校验、UTF-8 严格解码、
BOM 与常见终端转义序列清理、残留控制字符拒绝和有界流读取（流读取总时限 30 秒，不因持续到达数据而延长）；平台下载与错误类型仍留在各自 Surface。
`text-attachment-store.ts` 复用私有媒体存储：清理后不超过 32 KiB 的文本内联提交，更大文本保存为随机命名的私有文件并提交路径与到期时间。每个渠道暂存目录最多 50 个文件、50,000,000 字节，保留 24 小时，每分钟及启动时清理过期文件；关闭停止清理计时器但保留尚未到期文件。文件内容不写入 StateStore，工具读取仍受当前 App Server 权限约束。
`runtime-status-format.ts` 统一账户、额度与 MCP Server 运行状态的稳定中文语义和脱敏；
Core 只把 MCP 启动失败、取消及异常恢复投递给 Surface，首次启动中和正常就绪保持静默；
Telegram、飞书与微信分别通过 HTML 面板、CardKit Markdown 或按会话排序的纯文本气泡发送。
`configuration-change-format.ts` 统一 Telegram、飞书与微信已有的配置热加载、重启、重装和失败通知；
Workspace 操作提示只在 Telegram 实际提供切换按钮时声明可点击。
`operation-presentation.ts` 统一操作标题、状态、耗时与退出码元数据、上游敏感占位符和单行摘要，
并为三个渠道提供有界的压缩通知去重与文案；
Telegram HTML、飞书 CardKit Markdown 与微信安全文本的转义、布局、分组和发送仍由各自
Adapter 负责。
`operation-update-buffer.ts` 在 Surface 边界按完整 Conversation 与 Turn 有界暂存成功的查询操作，并统一在非 Commentary
最终文本或 Turn 完成前 Flush；最终回复前单项
保持原详情，多项生成一次分类计数汇总，并展示最多 8 个去重后的详情及各自次数；
超出时明确省略数量。可靠投递入口在每个终态操作后显式排空所属 Turn 的缓冲，避免仅凭内存聚合就确认持久记录。飞书网页搜索完成后直接发送，不进入该缓冲；失败、拒绝和其他操作同样
不进入缓冲。
Computer Use 的 MCP 操作也不进入查询缓冲；飞书在同一卡片展示调用开始和终态，复用已有去重、
顺序队列及 `hidden` 模式。具体操作说明已在 Client 边界提取并清洗，过程展示不使用 MCP 读写声明标签。
`generated-image.ts` 对 App Server `imageGeneration.savedPath` 指向的生成图片和
`codexc channel send-image` 提交的渠道 spool 图片执行同一读取校验：绝对路径、拒绝符号链接、
空文件、超过 10 MiB 的内容和非 PNG/JPEG 签名；Telegram、飞书与微信分别负责平台上传和发送，
不读取 `imageView` 或用户上传图片路径。
`SurfaceAdapter.sendChannelImage` 是可选的渠道图片发送入口，由 Gateway 的
`channel-image-spool` 驱动，复用 `generated-image.ts` 的读取校验和各自平台上传发送；
三个 Surface 都实现该入口，微信按目标 Conversation 复用其回复上下文与授权检查。
Surface 不得直接操作底层 JSON-RPC Transport，也不得把平台 SDK 类型引入 Conversation Core。

会话命令统一映射到 Bootstrap 注入的 Application `ConversationCommandExecutor`；Surface 只保留普通输入、状态或菜单实际需要的能力切片，并负责提取命令名、参数和渲染类型化结果。
Skill、Plugin 与子代理新建 Turn 时由统一 `turn.started` 生命周期确认，命令结果
不重复发送启动提示；该事件保留具体扩展类型和名称，追加到活动 Turn 时仍渲染明确确认。普通文本、图片下载、平台帮助、身份查询和
交互取消保留在平台边界。PNG/JPEG/WebP/非动画 GIF
的大小限制与内容签名校验由 `managed-image-store.ts` 在 Surface 内复用；
一次性音频的 20 MiB、WAV/MP3/M4A/WebM/OGG 内容签名、Unix `0700/0600` 或 Windows 当前 SID
ACL 私有暂存和一小时清理由
`managed-audio-store.ts` 复用。两者通过内部 `managed-media-store.ts` 统一私有目录生命周期、
有界流落盘、临时文件清理和过期清理；各自的格式白名单、限制、保留时间和公开接口保持独立。
Application 只接收绝对本地路径；
平台仍各自负责取得受信下载流。所有输入在调用 Application 前必须构造
`SurfaceAccessContext` 并通过对应访问策略。

Surface 只能渲染明确标记的结构化用户错误，不能直接复用其内部回退文案；App Server 的 Turn、
warning 和 MCP 错误只使用 Client 边界已经统一脱敏并限长的稳定字段。未知异常、凭据和未经约束
的响应正文不得带入聊天消息或日志。

Bootstrap 把共享的 `display.operation_updates` 三档模式显式注入各 Surface Outbox。`full`
显示完整操作，`compact` 显示单行摘要，其中子代理只保留启动和失败、抑制成功的等待与交互操作，
`hidden` 忽略普通 `operation.updated`；Core 始终正常归约操作，审批与其他关键输出不受影响。
上下文压缩开始和完成由共享展示状态去重，三个渠道均独立、有序发送，不受操作显示设置影响。
Telegram 把同一 Turn 的成功查询类操作延迟聚合；
飞书只聚合 MCP 与动态工具，网页搜索完成后立即发送。MCP 目录与实际工具调用统一显示 App Server
提供的只读、可能写入或未知提示，该提示不替代审批或执行结果。微信
除上下文压缩生命周期外，不主动发送操作事件；Surface 只实现平台格式，不各自定义
第二套显示配置。

Bootstrap 还把默认开启的 `display.plan_updates` 注入 Telegram 与飞书 Outbox。开启后，Telegram 与飞书消费
Core 发布的结构化 `plan.updated`：首次发送完整计划；飞书后续只原地更新这一张卡，
Telegram 则在步骤首次完成时发送紧凑进度并保留首次快照；微信不展示计划。不解析或拆分模型
正文，也不根据操作事件推断步骤完成时间；多个步骤若在同一官方通知中完成，只能按该通知的实际
到达时间展示。关闭时不产生任何计划渠道消息，Core 的计划归约保持不变。

Telegram 与飞书在 `display.reasoning` 开启时消费 Core 发布的 `turn.reasoning`，按顺序展示“思考中…”状态，连续思考每段只
显示一次，每段独立计时并流式原地更新耗时；微信不展示思考状态，摘要与原始思维链内容不进入渠道。
