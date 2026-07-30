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
- [`feishu/`](feishu/README.md)：飞书官方 SDK 长连接、私聊文本、PNG/JPEG、一次性音频与 UTF-8 文本文件到
  Application 的窄 Adapter、富文本最终回复、纯文本安全提示、有界输出队列、私聊交互卡片、平台权限中心、
  用户 OAuth Device Flow 和单账号生命周期组合；有效配置启用时由 Bootstrap 显式注册，私聊
  PNG/JPEG、命令审批动作、原生流式主路径、用户输入卡及 OAuth Token 重启恢复已通过真实验收，
  MCP form/URL 卡片仍待验收。
- [`weixin/`](weixin/README.md)：微信阶段 0/Setup 的严格独立凭据边界、固定版窄协议 Client、
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
`surface + accountId` 标识，分别提供启停、输出、可选配置变更通知与 `InteractionPort`；Bootstrap
只通过编译期内置插件注册表显式注册。
Bootstrap 的内置插件注册表负责把一个渠道插件展开为零到多个账号实例并验证身份唯一性；
Telegram、飞书目录仍只实现平台 Adapter，不导入插件宿主或组合根类型。
`SurfaceOutputPort` 接收平台无关的 `OutputEvent`，只负责同步入队，不得等待平台网络请求。
Bootstrap 按 `surface + accountId` 精确选择一个输出端口，Surface 不再各自订阅全局事件总线。
只有成功启动且仍处于运行状态的 Surface 才会收到输出；单个输出端口拒绝事件不得中断后续路由。
`stop()` 必须可在部分启动后安全调用，并保持幂等。
配置变更通知使用结构化动作区分热加载、自动重启、需要重装和加载失败；Surface 只渲染结果，
不得接收原始配置值或异常详情。普通生命周期通知可通过可选的 `configurationChanged` 异步入队；
`deliverConfigurationChange` 必须等待平台 API 实际发送成功，失败时抛出错误，以便 Bootstrap 保留
尚未确认的持久化配置事件。
全局变更投递给所有 Surface；平台作用域变更只投递给匹配 Surface。进程重启和重装会影响所有
Surface，因此未匹配到具体变更的 Surface 仍会收到不包含平台私有原因的生命周期通知。

`ConversationDeliveryQueue` 提供可复用的每 Conversation 有界顺序队列：同一 Conversation 串行，
不同 Conversation 可并行；关键输出可以替换仍在等待的非关键输出。新增 Surface 时应实现统一输入、
输出和审批边界，通过 Application/Core 接入，并把平台发送操作放入该队列或提供等价约束。
审批卡片和其他需要等待结果的 `runOrdered` 操作排在所有既有关键消息之后，但会越过尚未执行的
非关键过程输出；关键消息与非关键消息各自保持原顺序，已经开始的平台请求不会被中断。
Telegram 和飞书在交互消息创建成功或失败时
只记录脱敏身份与平台错误分类，不记录审批正文。
完整接入顺序、组合工厂、身份、配置、存储和验证要求见
[`通讯渠道 Surface 接入指南`](../../docs/surface-integration-guide.md)。
关闭队列时拒绝新输出、限时等待在途发送；并发关闭调用等待同一个关闭结果，不能提前报告完成。
实现位于 `conversation-delivery-queue.ts`，并通过本目录 `index.ts` 公开。
`surface-input-coalescer.ts` 在已授权的 Surface 输入边界按完整 Conversation 与 Actor 隔离，
把平台拆分到相邻消息的文本和图片在一秒静默窗口内合并为一次 Application 提交；命令仍由各
Surface 在入队前立即处理，停止时必须排空已接收的聚合输入。
`turn-reply-targets.ts` 只在 Surface 内存中把待提交输入的精确平台消息 ID 绑定到实际
Thread 与 Turn，允许 `turn.started` 早于提交响应时仍原生回复正确输入；不保存消息正文，
Turn、Thread 或 Surface 关闭时清理。
`quoted-input.ts` 把各平台已验证的回复/引用正文转换为有界、明确标记且与当前消息分离的上下文；
引用获取仍由各 Surface 负责，不能读取 Gateway 私有历史或让引用内容参与命令解析。
`lifecycle-presentation.ts` 统一 Telegram、飞书与微信的 Gateway 上线、Turn 开始确认和 Turn
结束汇报信息模型、字段顺序与中文状态词；各 Surface 只保留 HTML、CardKit Markdown 或微信文本
布局以及各自的发送策略。
`elapsed-duration.ts` 只把 App Server 已提供的 Turn 毫秒耗时或账户用量秒数格式化为三个
Surface 共用的中文短文本，不负责计时、状态或持久化。
`account-format.ts` 统一套餐名称、额度状态、百分比、周期与重置时间格式，供命令结果、运行时通知
和生命周期汇报复用。
`slash-command.ts` 统一飞书与微信的严格斜杠命令解析，并规范化三个渠道共同公开的
`/h`、`/work`、`/r` 快捷命令；Telegram 在 Bot 注册边界接入同一组显式映射。
`conversation-command-format.ts`
统一 Telegram、飞书与微信共用的分组命令目录、有界会话列表、Workspace、Skill、MCP、Plugin、
权限、项目规则、Diff、Goal、模型选择、Default/Plan 模式、用量与额度等平台无关命令结果文案
与状态文本。
`user-facing-error-format.ts` 统一三个渠道的结构化用户错误文案，只保留渠道名称差异；
`error-metadata.ts` 统一渠道日志中的受约束异常类型和机器错误码，拒绝异常正文、堆栈及
上游自定义名称进入日志；Bootstrap 继续通过注入的 Pino `err` 序列化器处理组合根异常。
`input-copy.ts` 统一补充文字、文件、图片与音频追加到当前 Turn 的确认文案；
`output-copy.ts` 统一 CLI 输入镜像、断线、警告、操作失败、停止交互、空回复与内容截断等输出
语义，各渠道继续自行决定 HTML、CardKit Markdown、纯文本布局和发送方式。
`interaction-copy.ts` 统一审批、用户输入和 MCP 交互的处理、取消、超时、跨客户端解决及提交结果
语义；平台仍各自使用按钮、卡片或可复制命令完成交互。
`pending-interaction-registry.ts` 统一三个渠道待处理交互的请求 ID 与一次性令牌索引、容量限制、
准备期跨客户端失效、完成清理和超时计时器释放；平台仍各自负责授权复核、消息准备、输入解析、
决定映射和结果更新。
`text-file-copy.ts` 统一三个渠道文本文件下载失败、1,000,000 字节上限和 UTF-8 类型拒绝文案，
同时保留渠道名称以便定位来源。`text-file-input.ts` 统一文件名安全校验、UTF-8 严格解码、
BOM 清理、控制字符拒绝和有界流读取；平台下载与错误类型仍留在各自 Surface。
`runtime-status-format.ts` 统一账户、额度与 MCP Server 运行状态的稳定中文语义和脱敏；
Telegram、飞书与微信分别通过 HTML 面板、CardKit Markdown 或按会话排序的纯文本气泡发送。
`configuration-change-format.ts` 统一 Telegram、飞书与微信已有的配置热加载、重启、重装和失败通知；
Workspace 操作提示只在 Telegram 实际提供切换按钮时声明可点击。
`operation-presentation.ts` 统一操作标题、状态、耗时与退出码元数据、敏感占位符、Codex 私有
目录绝对路径清洗和单行摘要；
Telegram HTML、飞书 CardKit Markdown 与微信安全文本的转义、布局、分组和发送仍由各自
Adapter 负责。
`operation-update-buffer.ts` 在 Surface 边界按 Turn 有界暂存成功的 MCP、动态工具和网页搜索；
最终回复前单项保持原详情，多项生成一次分类计数汇总。失败、拒绝和其他操作不进入该缓冲。
`generated-image.ts` 只读取 App Server `imageGeneration.savedPath` 指向的绝对普通文件，
拒绝符号链接、空文件、超过 10 MiB 的内容和非 PNG/JPEG 签名；Telegram、飞书与微信分别负责
平台上传和发送，不读取 `imageView` 或用户上传图片路径。
Surface 不得直接操作底层 JSON-RPC Transport，也不得把平台 SDK 类型引入 Conversation Core。

会话命令统一映射到 Application 的 `ConversationCommandService`；Surface 负责提取命令名和参数，
并渲染类型化结果。普通文本、图片下载、平台帮助、身份查询和交互取消保留在平台边界。PNG/JPEG
的大小限制、内容签名校验、私有暂存和过期清理由 `managed-image-store.ts` 在 Surface 内复用；
一次性音频的 20 MiB、WAV/MP3/M4A/WebM/OGG 内容签名、`0700/0600` 私有暂存和一小时清理由
`managed-audio-store.ts` 复用，Application 只接收绝对本地路径；
平台仍各自负责取得受信下载流。所有输入在调用 Application 前必须构造
`SurfaceAccessContext` 并通过对应访问策略。

Surface 只能渲染明确标记的结构化用户错误，不能直接复用其内部回退文案；App Server 的 Turn、
warning 和 MCP 错误只使用 Client 边界已经统一脱敏并限长的稳定字段。未知异常、凭据和未经约束
的响应正文不得带入聊天消息或日志。

Bootstrap 把共享的 `display.operation_updates` 三档模式显式注入各 Surface Outbox。`full`
显示完整操作，`compact` 显示单行摘要，`hidden` 忽略 `operation.updated`；Core 始终正常归约
操作，审批与其他关键输出不受影响。三个渠道统一把同一 Turn 的成功查询类操作延迟聚合，微信
对其余操作仍仅发送终态，避免用普通气泡模拟持续更新；Surface 只实现平台格式，不各自定义
第二套显示配置。
