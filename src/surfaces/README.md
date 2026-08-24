# Surface Adapters

本目录保存外部交互平台适配器。Surface 负责把平台输入转换为 Application 命令，并把 Core 输出和审批交互渲染为平台消息。

`index.ts` 是所有 Surface 的公开导出入口。

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

`secure-credential-store.ts` 提供 Surface 内部复用的 macOS Keychain 和 Linux AES-256-GCM
字符串记录机制；平台模块仍各自拥有 Service、目录、记录键、载荷校验和错误语义。

`types.ts` 定义最小 `SurfaceAdapter` 契约。每个实例使用
`surface + accountId` 标识，分别提供启停、输出、可选配置变更通知、计划任务确认呈现与 `InteractionPort`；Bootstrap
只通过编译期内置插件注册表显式注册。
Bootstrap 的内置插件注册表负责把一个渠道插件展开为零到多个账号实例并验证身份唯一性；
Telegram、飞书目录仍只实现平台 Adapter，不导入插件宿主或组合根类型。
`SurfaceOutputPort` 接收平台无关的 `OutputEvent`，只负责同步入队，不得等待平台网络请求。
Bootstrap 按 `surface + accountId` 精确选择一个输出端口，Surface 不再各自订阅全局事件总线。
只有成功启动且仍处于运行状态的 Surface 才会收到输出；单个输出端口拒绝事件不得中断后续路由。
运行连接失败后，同一 Adapter 的 `start()` 必须能重新建立输入连接；Bootstrap 对每个账号实例
独立退避，不通过重启 Gateway 恢复单个渠道。`stop()` 只用于 Gateway 关闭，必须可在部分启动后
安全调用并保持幂等。首次启动和故障恢复期间的关键输出只保存在 Bootstrap 有界内存中，不写入
StateStore；临时连接故障只能取消当前交互，不能把可恢复端口永久关闭。
配置变更通知使用结构化动作区分热加载、自动重启、需要重装、加载失败，以及第三方模型设置的
等待重启、重启中、已生效和失败；Surface 只渲染结果，不得接收原始配置值或异常详情。普通
生命周期通知可通过可选的 `configurationChanged` 异步入队；`deliverConfigurationChange` 必须等待
平台 API 实际发送成功，失败时抛出错误，以便 Bootstrap 保留尚未确认的持久化配置事件。
全局变更投递给所有 Surface；平台作用域变更只投递给匹配 Surface。进程重启和重装会影响所有
Surface，因此未匹配到具体变更的 Surface 仍会收到不包含平台私有原因的生命周期通知。

`ConversationDeliveryQueue` 提供可复用的每 Conversation 有界顺序队列：同一 Conversation 串行，
不同 Conversation 可并行；关键输出可以替换仍在等待的非关键输出。新增 Surface 时应实现统一输入、
输出和审批边界，通过 Application/Core 接入，并把平台发送操作放入该队列或提供等价约束。
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
非关键过程输出；关键消息与非关键消息各自保持原顺序，已经开始的平台请求不会被中断。
Telegram 和飞书在交互消息创建成功或失败时
只记录脱敏身份与平台错误分类，不记录审批正文。
完整接入顺序、组合工厂、身份、配置、存储和验证要求见
[`通讯渠道 Surface 接入指南`](../../docs/surface-integration-guide.md)。
关闭队列时拒绝新输出、限时等待在途发送；并发关闭调用等待同一个关闭结果，不能提前报告完成。
实现位于 `conversation-delivery-queue.ts`，并通过本目录 `index.ts` 公开。
`surface-input-coalescer.ts` 是已授权 Surface 输入门面；`surface-input-batcher.ts` 只合并 Surface
明确标识的图片批次，普通文字、单图和无批次标识的消息立即提交。图片落盘后仍由渠道管理，批次
flush 时由该共享边界一次读取并复核可信 MIME、PNG/JPEG/WebP/非动画 GIF 签名、单张 10 MiB 与整批 20 MiB，转换为
有界 Base64 Data URL 再交给 Application；Gateway 只在本次 Turn 内存中持有 Base64，
不写入自身日志或独立存储，也不向 App Server 发送本地路径，不在 Surface 维护另一套识图会话或重试队列。
三渠道共享的 `/metrics` 分开展示当前 Thread 最近 Turn 的运行聚合、指标库保留范围内的会话累计，
并单独列出最近直接 API 请求；`global/providers/models` 支持自然日/周/月、24 小时至 365 天滚动窗口和全部保留历史，
把 Codex Provider 和直接 API 按同一请求口径聚合，最多展示请求量最高的 20 组；`errors` 用同一
范围展示异常率及按提供商、模型、状态、HTTP 状态和错误类型形成的前 20 组异常，附带最近发生时间。
综合速度和首段回复延迟附带有效样本覆盖率，不把请求累计输入误写成上下文占用；总价附带
计价覆盖率，并按提供商币种先出总计、再列出输入、缓存、输出三项价格明细，不显示目录静态
单价；所有 Provider 的完成卡片与 `/metrics` 最近运行和会话累计按本机实际用量展示均价；
聚合存在多档价格时只标记多档、
不显示伪统一单价。信息类聊天指令（`/status`、`/usage`、
`/limits`、`/models`、`/sessions`、`/section`、`/skills`、`/mcp`、`/plugin`、`/permissions`、`/goal`、
`/project-rules`、`/metrics` 等）输出统一为 Markdown 列表：首行为 `##` 标题、小节为 `###`
标题、字段为 `-` 列表项、明细缩进嵌套；`/diff` 与操作结果保持原文。三个渠道分别用飞书卡片
Markdown、Telegram HTML、微信结构化字段渲染列表。
`/sessions` 和 `/archived` 共用可复制的分页/筛选命令，并保持完整目录选择器；`/section` 共用
全局影响说明、管理员校验和删除确认文案。三渠道把当前已授权 Actor 传给共享命令边界；未列入
`thread_sections.administrators` 时只能查看和筛选自定义分区。内置 Pinned 在三渠道统一复用 `/pin` 与 `/unpin`；
飞书选择卡与 Telegram 内联按钮只向管理员展示自定义分区移动，并向所有用户提供翻页，微信使用同一
文字命令。渠道只提交选择，不保存分区状态。
`turn-reply-targets.ts` 只在 Surface 内存中把待提交输入的精确平台消息 ID 绑定到实际
Thread 与 Turn，允许 `turn.started` 早于提交响应时仍原生回复正确输入；不保存消息正文，
Turn、Thread 或 Surface 关闭时清理。
`quoted-input.ts` 把各平台已验证的回复/引用正文转换为有界、明确标记且与当前消息分离的上下文；
引用获取仍由各 Surface 负责，不能读取 Gateway 私有历史或让引用内容参与命令解析。
`plan-presentation.ts` 统一完整计划与新增完成步骤的有界展示、状态符号和去重指纹；各渠道只决定
完整计划是原地更新还是追加紧凑进度。
`lifecycle-presentation.ts` 统一 Telegram、飞书与微信的 Gateway 上线、Turn 开始确认、子代理
开始/继续/完成通知和 Turn 结束汇报；OpenAI 启动传输探测全部失败时，上线通知增加代理检查提醒，
不显示目标地址或底层错误；飞书和微信仍只通知已有安全会话。Turn 完成把本次运行、当前会话累计和账户状态依次分区，并按 Token、费用、性能分组；按 Turn
聚合统计代理捕获的全部模型请求、实际产生推理输出的思考次数及当前 Turn 总价，并保留 Provider
通用的 Thread Token/上下文、请求数与总价累计指标；父 Turn 存在显式子代理时另展示递归任务合计，
不把子代理性能混入父 Turn；本轮存在非正常模型尝试时，请求总数会进一步拆分为
完成、中断、未完整观测和失败数量；`429/5xx` 瞬时失败后存在成功请求时显示为“自动重试、最终
成功”，本轮计价覆盖只统计成功请求，底层异常记录仍完整保留。`reference-cost-format.ts` 统一总价、计价覆盖率及
输入/缓存/输出价格明细格式（先总价后明细，按提供商币种换算）；完成卡片正式模式只保留
Token 与费用总计及均价，调试模式才展示模型请求聚合耗时，并展开 Token/费用子项和附加货币
换算对照。子代理完成卡片始终展示从启动到首次官方终态的墙钟耗时，并复用同一价格、Token 和均价格式，
在值可靠时展示思考等级与线程聚合的
综合输出速度（不含推理，并标明计时覆盖率）：正式模式保留总计，调试模式才展开缓存与推理 Token、
缓存命中率、输入/缓存/输出费用、附加货币换算和模型请求聚合耗时；计价覆盖不全时显示覆盖比例并
省略可能低估的均价，指标读取失败时只显示“统计暂不可用”。
原生 OpenAI 鉴权的 Codex Provider 统一显示为“OpenAI 官方”，且只在该类 Thread 显示 Fast 与
OpenAI 周限；配置的自定义主模型 Provider 追加“ · 自定义”标识（例如“OpenAI · 自定义”），
直接 API 的自定义提供商继续使用自身名称；各 Surface 只保留 HTML、
CardKit Markdown 或微信文本布局以及各自的发送策略。后台 Thread 的文本、审批和完成汇报均标注
短 Thread ID，并继续进入原 Conversation 的有界顺序队列。
`elapsed-duration.ts` 只把已确认的 Turn、首事件/首段回复延迟等毫秒值或账户用量秒数格式化为三个 Surface
共用的中文短文本，不负责计时、状态或持久化。
`account-format.ts` 统一套餐名称、额度状态、百分比、周期与重置时间格式，供命令结果、运行时通知
和生命周期汇报复用。
`provider-format.ts` 统一已知 Provider 显示名，并对后续 Provider 标识做有界展示。
`slash-command.ts` 统一飞书与微信的严格斜杠命令解析，并规范化三个渠道共同公开的
`/h`、`/work`、`/r` 快捷命令；Telegram 在 Bot 注册边界接入同一组显式映射。
`conversation-command-format.ts`
统一 Telegram、飞书与微信共用的分组命令目录、有界会话列表、Workspace、Skill、MCP、Plugin、
权限、项目规则、Diff、Goal、模型选择、Default/Plan 模式、Provider 感知的用量与额度等平台无关
命令结果文案与状态文本；OpenAI `/usage` 以账户摘要为主，在当前 Thread 有效时追加有界的官方 Credits、可选美元、
字段完整时的 Token 汇总和最多 8 个明细组，官方估算不可用或查询失败时只追加稳定提示；DeepSeek `/usage` 显示余额，
未支持的 Provider 明确说明能力缺失。计划任务确认、列表、运行记录和命令结果格式也通过本目录
`index.ts` 供 Bootstrap 动态工具回调复用。
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
准备期跨客户端失效、完成清理和超时计时器释放；平台仍各自负责授权复核、消息准备、输入解析、
决定映射和结果更新。
`text-file-copy.ts` 统一三个渠道文本文件下载失败、1,000,000 字节上限和 UTF-8 类型拒绝文案，
同时保留渠道名称以便定位来源。`text-file-input.ts` 统一文件名安全校验、UTF-8 严格解码、
BOM 清理、控制字符拒绝和有界流读取；平台下载与错误类型仍留在各自 Surface。
`runtime-status-format.ts` 统一账户、额度与 MCP Server 运行状态的稳定中文语义和脱敏；
Core 只把 MCP 启动失败、取消及异常恢复投递给 Surface，首次启动中和正常就绪保持静默；
Telegram、飞书与微信分别通过 HTML 面板、CardKit Markdown 或按会话排序的纯文本气泡发送。
`configuration-change-format.ts` 统一 Telegram、飞书与微信已有的配置热加载、重启、重装和失败通知；
Workspace 操作提示只在 Telegram 实际提供切换按钮时声明可点击。
`operation-presentation.ts` 统一操作标题、状态、耗时与退出码元数据、上游敏感占位符和单行摘要；
Telegram HTML、飞书 CardKit Markdown 与微信安全文本的转义、布局、分组和发送仍由各自
Adapter 负责。
`operation-update-buffer.ts` 在 Surface 边界按 Turn 有界暂存成功的查询操作；最终回复前单项
保持原详情，多项生成一次分类计数汇总，并展示最多 8 个去重后的详情及各自次数；
超出时明确省略数量。飞书网页搜索完成后直接发送，不进入该缓冲；失败、拒绝和其他操作同样
不进入缓冲。
`generated-image.ts` 对 App Server `imageGeneration.savedPath` 指向的生成图片和
`codexc channel send-image` 提交的渠道 spool 图片执行同一读取校验：绝对路径、拒绝符号链接、
空文件、超过 10 MiB 的内容和非 PNG/JPEG 签名；Telegram、飞书与微信分别负责平台上传和发送，
不读取 `imageView` 或用户上传图片路径。
`SurfaceAdapter.sendChannelImage` 是可选的渠道图片发送入口，由 Gateway 的
`channel-image-spool` 驱动，复用 `generated-image.ts` 的读取校验和各自平台上传发送；
三个 Surface 都实现该入口，微信按目标 Conversation 复用其回复上下文与授权检查。
Surface 不得直接操作底层 JSON-RPC Transport，也不得把平台 SDK 类型引入 Conversation Core。

会话命令统一映射到 Application 的 `ConversationCommandService`；Surface 负责提取命令名和参数，
并渲染类型化结果。Skill、Plugin 与子代理新建 Turn 时由统一 `turn.started` 生命周期确认，命令结果
不重复发送启动提示；该事件保留具体扩展类型和名称，追加到活动 Turn 时仍渲染明确确认。普通文本、图片下载、平台帮助、身份查询和
交互取消保留在平台边界。PNG/JPEG/WebP/非动画 GIF
的大小限制与内容签名校验由 `managed-image-store.ts` 在 Surface 内复用；
一次性音频的 20 MiB、WAV/MP3/M4A/WebM/OGG 内容签名、`0700/0600` 私有暂存和一小时清理由
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
`hidden` 忽略 `operation.updated`；Core 始终正常归约操作，审批与其他关键输出不受影响。
Telegram 和微信把同一 Turn 的成功查询类操作延迟聚合；
飞书只聚合 MCP 与动态工具，网页搜索完成后立即发送。MCP 目录与实际工具调用统一显示 App Server
提供的只读、可能写入或未知提示，该提示不替代审批或执行结果。微信
对其余操作仍仅发送终态，避免用普通气泡模拟持续更新；Surface 只实现平台格式，不各自定义
第二套显示配置。

Bootstrap 还把默认开启的 `display.plan_updates` 注入三个 Surface Outbox。开启后，各端消费
Core 发布的结构化 `plan.updated`：首次发送完整计划；飞书后续只原地更新这一张卡，
Telegram 和微信则在步骤首次完成时发送紧凑进度并保留首次快照。不解析或拆分模型
正文，也不根据操作事件推断步骤完成时间；多个步骤若在同一官方通知中完成，只能按该通知的实际
到达时间展示。关闭时不产生任何计划渠道消息，Core 的计划归约保持不变。

三个 Surface 消费 Core 发布的 `turn.reasoning`，按顺序展示“思考中…”状态，连续思考每段只
显示一次，每段独立计时并流式原地更新耗时；摘要与原始思维链内容不进入渠道。
