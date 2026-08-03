# Telegram Surface

本目录实现 Telegram Bot 适配器，把聊天、命令、图片、一次性音频、UTF-8 文本文件和按钮交互连接到平台无关
的应用与核心模块。

## 文件

- `index.ts`：Telegram Surface 的公开导出入口。
- `constants.ts`：Telegram Surface 的稳定账号标识。
- `bot.ts`：提供 Bootstrap 使用的单一选项工厂，注册 Telegram SDK 处理器，执行访问检查，
  把标准命令或普通输入提交给 Application；
  同一 `media_group_id` 的图片按 Actor 合并为一次最多 4 张的 Application 输入；
  普通文字、单图和没有相册标识的独立图片立即提交，不用时间窗口猜测图文关系；
  原生 Voice/Audio 最长 5 分钟、最大 20 MiB，只在下载后验证为 WAV、MP3、M4A、WebM 或 OGG
  才构造稳定 `localAudio`，私有临时文件一小时后清理；Application 仅在当前模型目录包含
  `audio` 时提交，否则在创建或追加 Turn 前明确拒绝；
  普通文本与图片说明可读取 `reply_to_message` 自带的文本或说明文字并作为明确引用上下文提交；
  `/queue <描述>` 把纯文本排到下一 Turn，`/rules <init|check>` 只操作当前 Workspace 且不提供
  强制覆盖；同时发送热加载、自动重启、重装要求和失败等配置
  生命周期通知，Workspace 新增通知带直接切换按钮；启动消息只使用组合根注入的 Gateway
  版本字符串和当前 Workspace Git 分支，不读取生成协议。
- `command-renderer.ts`：把平台无关的类型化命令结果渲染为 Telegram 消息。
- `outbox.ts`：通过 Surface 共用的每 Conversation 有界顺序队列协调流式回复和审批显示顺序；
  普通 Turn 输入会在内存中绑定到精确消息 ID，“已开始处理。”和首条最终正文均使用
  `reply_parameters` 原生回复该输入；绑定在 Turn 结束、断线或关闭时清理；
  可见操作结果或生成图片入队前会先刷新同一 Turn 仍在合并窗口内的正文，避免过程通知越过说明文字；
  活动非终态流最多保留 100 个，单流正文最多保留 1,000,000 个 Unicode 字符并明确标记截断；
  每个 Turn 开始时发送共享确认；每轮状态卡复用共享生命周期字段，显示当前 Workspace Git
  分支、官方 Turn 对话耗时、最近模型请求缓存命中率、当前 Goal、上下文压缩总次数和用量；最终回复默认使用兼容 HTML，也可选择
  Telegram 原生 Rich Markdown，超长或渲染失败时回退纯文本；完成的原生 `imageGeneration`
  PNG/JPEG 经过共享安全读取边界后使用 `sendPhoto` 静默发送，且不受操作过程显示档位影响。
- `approval-operation-coordinator.ts`：隔离审批请求与操作日志之间的等待、拒绝抑制和 Turn 清理状态。
- 通知策略按逻辑事件降噪。Gateway 启动、CLI 输入镜像、思考/过程增量、操作过程、Turn 结束统计、
  账户/额度更新、普通 warning 和同一回复的后续分片使用 Telegram `disable_notification`；
  同一 Turn 的首个最终回复、审批或用户输入的最后一段、Turn 失败或异常终态、连接断开、MCP
  失败、配置变更和用户主动执行的命令结果保留普通提醒。审批前置长内容只静默发送折叠分片，
  最后带按钮的消息始终开启提醒；静默只控制客户端提醒，不改变队列关键性和失败处理。
- `html-format.ts`：安全转义并分块渲染命令面板、启动通知、审批卡与 Diff；长审批详情先显示约六行普通引用预览，再以文字分隔可展开的剩余全文，避免 Telegram 合并相邻引用或让长命令默认占满聊天界面。
- `markdown-format.ts`：把常见 Markdown 块与行内样式安全转换为传统 Telegram HTML；
  HTTP(S) 链接转换为可点击链接，Markdown 表格降级为紧凑的粗体表头与项目符号行；
  仅包含 Bot 命令的文本代码块和行内命令会转为可点击纯文本，普通代码块保持不变。
- `long-message-format.ts`：统一规划终端或 Telegram 发起 Turn 的长回复；普通长文本使用可展开引用块，超长代码与内容使用预览加内存文件。
- `operation-format.ts`：把操作记录分组、截断、脱敏并按完整或单行摘要模式渲染为 Telegram
  HTML；完整模式同时显示状态、耗时和退出码。
- `typing-indicator.ts`：维护活动请求和 Turn 的 Typing 状态、刷新与限速。
- `interactions.ts`：发送一次/会话/命令前缀或网络规则持久审批以及用户输入卡片，按协议能力显示
  互不混淆的按钮；网络会话按钮显示目标主机，持久按钮明确显示允许/拒绝动作和主机，并处理
  超时、回调和跨客户端失效。MCP 工具审批使用独立按钮，并只显示上游提供的一次、会话或始终
  允许范围，不进入 ForceReply JSON 输入。同一请求 ID 只允许一个待处理交互，同时最多保留 100 个；固定选项
  和多问题回复完整验证，Gateway 关闭期间未完成的消息发送不会重新建立交互。`/stop` 优先停止
  当前聊天最新交互，没有待处理交互时进入共享 Turn 停止命令。初始交互使用 Conversation
  优先有序通道，会排在等待中的非关键流式或状态输出之前；最终带按钮的审批消息保持通知开启，
  长内容的前置折叠分片静默。发送成功或失败只记录脱敏身份和平台错误分类。
- `lifecycle.ts`：Bot 命令注册、Long Polling、连续且属于同一原生媒体组的并发准备、包含系统、会话与 Git
  分支摘要的启动联通通知，以及可取消关闭；有界重试耗尽后向 Bootstrap 报告渠道故障，由该
  Telegram 实例独立退避重连，不停止 Gateway 或其他 Surface。
- `api-executor.ts`：统一执行 Telegram API 调用，处理超时、限流和有限重试。
- `error-metadata.ts`：只保留异常类型和受约束的机器错误码，不记录任意异常消息。
- `user-error-renderer.ts`：把平台无关的结构化用户错误映射为 Telegram 专属提示与命令用法。
- `format.ts`：格式化会话、Diff/Plan、Goal、模型、Workspace、Git 分支、权限、用量、缓存命中率、
  上下文压缩总次数和状态文本；可复用语义委托给 Surface 共享格式器，账户、额度与 MCP 运行状态
  由 `runtime-status-format.ts` 提供；上线通知复用 Surface 共享生命周期字段并把结构化字段渲染为
  紧凑项目符号列表，`/status` 与 Turn 结束统计均显示当前 Workspace Git 分支。
- `file-download.ts`：统一通过 Bot API 定位文件，并执行支持 HTTPS 代理、超时和状态校验的下载；
  图片与文本文件复用该传输边界，各自保留大小、内容和错误语义校验。
- `image-store.ts`：安全获取 Telegram 下载地址和下载流；大小、内容签名、私有暂存与过期清理
  复用上层 `managed-image-store.ts`。
- `audio-store.ts`：复用统一文件定位与下载边界，把受支持音频交给
  `managed-audio-store.ts` 验证、私有暂存和一小时清理。
- `file-input.ts`：通过 Bot API 在内存下载最多 1,000,000 字节的普通文件，严格验证文件名、
  UTF-8 和控制字符并返回有界文本；二进制正文不进入 Application，也不创建本地文件。单个
  UTF-8 文本文件的文件名、说明文字、正文解析和最终原生回复已通过真实 Bot 主路径验收；
  超限、二进制拒绝与多文档相册仍只经过离线边界验证。

Telegram 网络调用不得阻塞 App Server Reader。每个 Conversation 的最终输出保持顺序；审批卡状态更新必须先于批准后的操作展示。图片下载必须限制大小、路径、类型和保留时间，文本文件下载
必须保持纯内存、有界且严格验证 UTF-8。
Bot API 与文件下载使用 Bootstrap 按 `api.telegram.org` 选择的统一 HTTP(S) 代理；共享代理
遵循 `NO_PROXY`，Telegram 私有 `proxy_url` 作为显式覆盖。
下一 Turn 输入队列属于 Application，不得复用本目录的 Telegram 输出队列；Telegram 只负责
命令解析及位置、容量和内存生命周期提示。
Telegram 手动命令注册显式接入三个渠道共享的 `/h`、`/work`、`/r` 快捷入口，分别执行
`/help`、`/workspace`、`/resume`；快捷入口不重复写入 BotFather 菜单。帮助消息复用共享的
分组列表，只在 Telegram 边界转换为安全 HTML。无参数 `/skill` 与其他渠道一样展示编号列表，
调用统一使用 `/skill <名称或序号> <任务>`，不维护渠道私有选择状态。
`/vision <要求>` 预设当前用户与聊天的下一批图片识别要求；多图使用
`/vision <2–4> <要求>` 声明数量，收齐后自动提交；兼容的 `/vision begin <要求>`、
`/vision done` 保留给数量未知的收集，失败后可在五分钟内用 `/vision retry` 复用原图片和要求，
`/vision cancel` 取消；该入口加入 Bot 命令菜单，但不进入 Application 会话命令目录。
审批请求晚于操作日志发送时，Outbox 必须撤回已经发送的命令消息，不能只清理内存状态。
账户额度和 MCP 状态通知也必须进入每聊天有界输出队列；不得从 App Server Reader 直接等待 Telegram 网络发送。
结构化用户错误由 `bot.ts` 转换为 Telegram 专属文案；App Server Turn、warning 和 MCP 错误会
显示 Client 边界已经统一脱敏并限长的详情，未知异常和原始响应正文不写入 Telegram 日志或外部消息。
共享配置 `display.operation_updates` 为 `full` 时显示完整操作详情、状态、耗时和退出码，
为 `compact` 时显示一行状态、元数据和最多 160 个字符的详情摘要，为 `hidden` 时不发送操作
过程；成功的 MCP、动态工具和网页搜索按 Turn 延迟到最终回复前聚合，单项保留详情，多项仅显示
一次分类计数，失败与拒绝保持即时展示。审批、错误、最终回复和 Turn 完成统计保持原有行为。
`display.plan_updates = true` 时，官方自动计划先发送一次静默文本清单，每个步骤首次完成时
再发送一条紧凑进度；默认开启，可通过 `display.plan_updates = false` 关闭，不解析模型正文，也不改变 `/plan` 模式。
