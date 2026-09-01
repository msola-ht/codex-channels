# Telegram Surface

本目录实现 Telegram Bot 适配器，把聊天、命令、图片、一次性音频、UTF-8 文本文件和按钮交互连接到平台无关
的应用与核心模块。

## 文件

- `index.ts`：Telegram Surface 的公开导出入口。
- `constants.ts`：Telegram Surface 的稳定账号标识。
- `bot.ts`：提供 Bootstrap 使用的单一选项工厂，注册 Telegram SDK 处理器，执行访问检查，
  把标准命令或普通输入提交给 Application；
  同一 `media_group_id` 的图片按 Actor 合并为一次最多 4 张的 Application 输入；静态 GIF 无论作为文档还是
  `animation` 消息到达都进入相同内容校验，真正的动画 GIF 会被拒绝；共享输入批处理器在提交时
  将已校验的 PNG/JPEG/WebP/非动画 GIF 暂存文件读取为 Data URL，不把本地路径交给 App Server；
  普通文字、单图和没有相册标识的独立图片立即提交，不用时间窗口猜测图文关系；
  原生 Voice/Audio 最长 5 分钟、最大 20 MiB，只在下载后验证为 WAV、MP3、M4A、WebM 或 OGG
  才构造稳定 `localAudio`，私有临时文件一小时后清理；Application 仅在当前模型目录包含
  `audio` 时提交，否则在创建或追加 Turn 前明确拒绝；
  普通文本与图片说明可读取 `reply_to_message` 自带的文本或说明文字并作为明确引用上下文提交；
  `/queue add|list|update|delete|reorder|start` 管理 App Server 持久 Queue，`/schedule <自然语言>` 由前台 Agent 调用 `schedule_task` 工具生成确认预览，`/schedule` 管理显式启用的
  Gateway 计划任务；创建与删除预览直接提供原生确认/取消按钮，确认仍复用五分钟一次性令牌；选择支持多个思考等级的模型后提供思考等级内联按钮；`/rules <init|check>` 只操作当前 Workspace 且不提供
  强制覆盖；同时发送热加载、自动重启、重装要求和失败等配置
  生命周期通知，Workspace 新增通知带直接切换按钮；启动消息只使用组合根注入的 Gateway
  版本字符串和当前 Workspace Git 分支，不读取生成协议。
- `command-renderer.ts`：把平台无关的类型化命令结果渲染为 Telegram 消息。
- `outbox.ts`：通过 Surface 共用的每 Conversation 有界顺序队列协调流式回复和审批显示顺序；
  普通 Turn 输入会在内存中绑定到精确消息 ID，“已开始处理。”、阶段性最终正文和最终正文均使用
  `reply_parameters` 原生回复该输入；回复目标保留到 Turn 结束、断线或关闭时清理；
  可见操作结果或生成图片入队前会先刷新同一 Turn 仍在合并窗口内的正文，避免过程通知越过说明文字；
  思考按工具边界拆分为独立流程段，同一思考段可增量编辑并在工具开始时收尾；命令和文件等操作各自
  使用独立的可编辑过程消息，不把整个 Turn 的操作堆到同一条消息；
  活动非终态流最多保留 100 个，单流正文最多保留 1,000,000 个 Unicode 字符并明确标记截断；
  每个 Turn 开始时发送共享确认；每轮状态卡复用共享生命周期字段，显示当前 Workspace Git
  分支、官方 Turn 对话耗时、按 Token/费用/性能分组的统计、当前 Goal、上下文压缩总次数和用量；最终回复默认使用兼容 HTML，也可选择
  Telegram 原生 Rich Markdown，超长或渲染失败时回退纯文本；完成的原生 `imageGeneration`
  PNG/JPEG 经过共享安全读取边界后使用 `sendPhoto` 静默发送，且不受操作过程显示档位影响。
- `approval-operation-coordinator.ts`：隔离审批请求与操作日志之间的等待、拒绝抑制和 Turn 清理状态。
- 通知策略按逻辑事件降噪。Gateway 启动、CLI 输入镜像、思考/过程增量、操作过程、Turn 结束统计、
  账户/额度更新、普通 warning 和同一回复的后续分片使用 Telegram `disable_notification`；
  同一 Turn 的首个最终回复、审批或用户输入的最后一段、Turn 失败或异常终态、连接断开、MCP
  失败、配置变更和用户主动执行的命令结果保留普通提醒。审批前置长内容只静默发送折叠分片，
  最后带按钮的消息始终开启提醒；静默只控制客户端提醒，不改变队列关键性和失败处理。
- `html-format.ts`：安全转义并分块渲染命令面板、启动通知、审批卡与 Diff；审批详情整体使用
  Telegram 原生可展开引用，收起时由客户端显示开头与省略标记，点击后才展开完整内容；超出单条
  消息限制时仍按完整引用边界安全分片。
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
  分支摘要的启动联通通知，以及可取消关闭；拉取循环与普通更新处理使用有界分离通道，精确的
  `/stop` 即使在前一条普通消息开始处理后才到达，也会立即进入现有授权命令处理链；其他更新仍
  保持原有顺序，普通积压最多 1000 项，紧急任务最多并发 100 项。只有当前批次全部成功放入对应
  有界通道后才推进 Long Polling offset；关闭时最多等待更新处理 5 秒，超时只记录未完成数量，
  不记录消息正文，也不让 Surface 生命周期无限悬挂。
  有界重试耗尽后向 Bootstrap 报告渠道故障，由该
  Telegram 实例独立退避重连，不停止 Gateway 或其他 Surface。
- `api-executor.ts`：统一执行 Telegram API 调用，处理超时、限流和有限重试。
- `error-metadata.ts`：只保留异常类型和受约束的机器错误码，不记录任意异常消息。
- `user-error-renderer.ts`：把平台无关的结构化用户错误映射为 Telegram 专属提示与命令用法。
- `plugin-task-prompts.ts`：把 Plugin 选择后的 ForceReply 提示绑定到聊天、Actor 与精确消息，
  使用十分钟一次性内存状态和 100 项容量上限；过期、跨 Actor 与重复回复不会进入普通 Turn。
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
命令解析及位置、容量和内存生命周期提示。`/queue list` 还提供当前业务页的刷新、分页和条目入口；
条目按钮使用完整 Queue ID，进入后可启动或删除，删除必须二次确认。新增、更新和排序继续使用文本命令，
不建立渠道私有 Queue 状态。
Telegram 手动命令注册显式接入三个渠道共享的 `/h`、`/work`、`/r` 快捷入口，分别执行
`/help`、`/workspace`、`/resume`；快捷入口不重复写入 BotFather 菜单。帮助消息复用共享的
分组列表，只在 Telegram 边界转换为安全 HTML。无参数 `/skill` 与其他渠道一样展示编号列表，
调用统一使用 `/skill <名称或序号> <任务>`，不维护渠道私有选择状态。
`/plugin` 在共享文字列表上增加当前页可调用项和未过滤列表的翻页按钮；选择后通过一次性
ForceReply 收集任务，再使用完整 Plugin ID 进入共享 Application 调用边界。搜索结果仍保留
可复制的文字翻页命令，避免把搜索词写入 Telegram callback data。
`/section` 在共享全局警示和删除预览之外，为内置 Pinned 提供复用 `/pin` 的快捷按钮，只向分区管理员
展示当前页自定义分区的带哈希选择令牌移动按钮，并向所有用户显示纯页码翻页按钮；回调时重新读取官方目录并精确
匹配，失效按钮失败关闭。其他自定义分区管理继续使用共享命令。
审批请求晚于操作消息发送时，Outbox 必须撤回已经发送的命令消息，不能只清理内存状态。
账户额度和 MCP 状态通知也必须进入每聊天有界输出队列；不得从 App Server Reader 直接等待 Telegram 网络发送。
结构化用户错误由 `bot.ts` 转换为 Telegram 专属文案；App Server Turn、warning 和 MCP 错误会
显示 Client 边界已经统一脱敏并限长的详情，未知异常和原始响应正文不写入 Telegram 日志或外部消息。
共享配置 `display.operation_updates` 为 `full` 时显示完整操作详情、状态、耗时和退出码，
为 `compact` 时显示一行状态、元数据和最多 160 个字符的详情摘要，为 `hidden` 时不发送操作
过程；命令、文件、图片和子代理等操作按 item 独立发送并在同一消息内更新状态；成功的 MCP、动态工具和网页搜索按 Turn 延迟到最终回复前聚合，单项保留详情，多项显示
一次分类计数和最多 8 个去重后的详情及各自次数，超出时明确省略数量。失败与拒绝保持即时展示。
审批、错误、最终回复和 Turn 完成统计保持原有行为。
`display.plan_updates = true` 时，官方自动计划先发送一次静默文本清单，每个步骤首次完成时
再发送一条紧凑进度；默认开启，可通过 `display.plan_updates = false` 关闭，不解析模型正文，也不改变 `/plan` 模式。
思考状态只显示“思考中…”；同一思考段的耗时可以在原消息中增量更新，但工具或命令开始后会先把
当前思考段收尾，后续思考使用新的独立消息，不展示推理摘要或思维链内容；`display.reasoning = false`
时不显示。
