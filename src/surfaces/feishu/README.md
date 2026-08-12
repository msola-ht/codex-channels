# 飞书 Surface

本目录是飞书 Surface 的平台边界。当前已完成官方 SDK 与事件长连接窄封装、私聊普通文本、
纯文字富文本、独立图片、最多四张图片说明文字、一次性音频与独立 UTF-8 文本文件 Inbox、输出渲染、
Bootstrap 显式组合、全部平台无关
私聊命令、审批和用户输入卡片，以及
按需 OAuth 与 Doctor。当前可通过严格 TOML 或统一 Setup 启用单账号私聊 Surface；群聊、Lark、
Office、压缩包和其他未列明的通用二进制输入不支持。展示体验包括上线通知、Turn 开始确认、最终回复、命令
结果、操作过程与每轮结束统计统一使用 CardKit 2.0 Markdown，私聊 PNG/JPEG 图片复用
Application 的本地图片输入，同一 Thread 的
运行中与处理结束状态已实现合并到一条可更新消息，上线通知与每轮上下文状态复用共享生命周期数据，
持续模型增量使用 CardKit 2.0 原生流式卡片；Codex 原生 `imageGeneration` 完成以及
`codexc channel send-image` 提交的图片都只读取经共享安全边界校验的 PNG/JPEG，
通过官方图片上传和私聊图片消息接口顺序发送；
这些路径均有对应实现与测试。真实平台验收状态统一见
[`通讯渠道验收矩阵`](../../../docs/channel-acceptance-matrix.md)。

## 文件索引

- `index.ts`：飞书模块受控出口；一级 `surfaces/index.ts` 只转出 Bootstrap 所需工厂、选项类型
  和启动文案渲染器。
- `adapter.ts`：区分普通文本、平台本地命令和 Application 命令，把同一富文本或 Inbox 已明确成批的图片合并为
  一次最多 4 张的 Application 输入，并通过 Outbox 返回结果或安全错误。
- `approval-card.ts`：生成有界审批卡片和移除动作后的处理结果卡片。
- `card-action.ts`：严格裁剪 `card.action.trigger` 的路由字段和受限字符串动作值。
- `command-center.ts`：生成分类命令中心卡片，维护有界短期令牌与菜单事件去重，并复用
  Application 的唯一命令目录与执行入口；选择卡和通用输入卡不解析第二套命令语法。
- `application-api.ts`：隔离应用权限与已发布配置读取及 SDK 增量授权，严格裁剪远端应用及
  版本响应。
- `application-setup.ts`：生成精简 Doctor 和缺失权限授权卡片，绑定 App、Chat、Actor 和
  一次性令牌，管理有限任务、取消和安全结果。
- `client.ts`：隔离官方 HTTP SDK，提供消息读取/发送、生成图片上传、CardKit 与 OAuth 窄客户端。
- `audio.ts`：通过既有消息资源权限下载独立音频，限制为 5 分钟、20 MiB 和 Codex CLI
  支持的 WAV/MP3/M4A/WebM/OGG，写入一小时私有临时文件后构造 `localAudio`；Application
  仅在当前模型目录包含 `audio` 时提交，否则在创建或追加 Turn 前明确拒绝。
- `event-connection.ts`：隔离官方 WebSocket SDK，管理事件注册、握手、SDK 重连、失败后重新启动
  和最终停止生命周期。
- `file-input.ts`：通过官方消息资源 API 在内存下载独立文件，限制为 1,000,000 字节并严格验证
  文件名、UTF-8 和控制字符，不创建本地文件。
- `inbound-content.ts`：统一严格解析入站与被引用消息的文本、富文本、图片、文件和音频元素。
- `message-content.ts`：中和平台原生提及标签并生成飞书 `post + md` 降级内容。
- `operation-format.ts`：把单个操作终态渲染为包含脱敏详情的静态 CardKit Markdown。
- `outbox-content.ts`：集中处理 Outbox 的纯文本缓冲、CardKit 字符分片、富文本字节分片与截断标记。
- `message-event.ts`：SDK 消息事件的严格验证和稳定字段裁剪，保留回复事件的 `parent_id`。
- `menu-event.ts`：严格裁剪 `application.bot.menu_v6` 的 App、Actor、事件和菜单 Key。
- `inbox.ts`：私聊文本筛选、授权、同步有界入队、去重和按 Chat 顺序处理；不等待独立文字或图片，
  已在队列中明确相邻的图片可成批处理，普通文本与命令仍沿用既有顺序路径。
- `input-card.ts`：生成有界用户输入表单、MCP JSON 表单、工具审批、HTTP(S) URL 确认和处理结果卡片。
- `interactions.ts`：维护私聊审批、用户输入和 MCP elicitation 的一次性令牌、Actor 绑定、
  请求去重、过期、取消和跨客户端失效。
- `media.ts`：通过官方消息资源 API 下载私聊图片，并调用 Surface 共用暂存器完成大小、签名、
  权限和过期清理。
- `permissions.ts`：渲染当前进程权限观测和 Doctor 无配置快照时的精简回退摘要。
- `oauth-device-flow.ts`：严格裁剪应用用户 Scope、Device Authorization、有限轮询和授权身份查询。
- `oauth-card.ts`：把 Device Flow 映射为飞书内嵌授权卡片及稳定结果卡片。
- `oauth-token-store.ts`：macOS Keychain 与 Linux AES-256-GCM 私有凭据后端。
- `oauth.ts`：按 App 与 Actor 协调单一进行中授权、身份匹配、凭据写入、撤销和停止取消。
- `renderer.ts`：把平台无关 `ConversationCommandResult`、`OutputEvent`、启动状态和结构化错误
  映射为稳定文本内容；CLI/TUI 输入使用共享“CLI 输入”语义，启动通知、`/status` 与
  `turn.completed` 结束统计均包含当前 Workspace Git 分支。
- `outbox.ts`：精确账号路由并通过通用有界队列调用窄消息发送端口；在内存中按 Turn 关联
  原始输入消息，使开始确认、短回复及首张流式卡片原生回复同一输入；完成的原生生成图片
  独立于操作显示档位上传并发送。
- `status-card.ts`：把 Thread 状态映射为可原地更新的轻量交互卡片。
- `surface.ts`：组合单账号连接、Inbox、Application Adapter、Outbox 和失败关闭交互端口，并由
  模块入口只暴露 `createFeishuSurface()` 工厂与生产选项类型。

## 当前边界

`client.ts`、`event-connection.ts` 与 `application-api.ts` 隔离
`@larksuiteoapi/node-sdk`：

- `start()` 只有在 SDK 触发 `onReady` 后才成功，不能把 `WSClient.start()` 返回当作握手完成。
- 首次连接设置有限超时；失败和超时只暴露稳定、脱敏的本地错误。
- 重连状态留在平台边界；停止操作幂等，并能终止尚未完成的启动。
- SDK 原始日志不进入项目 Logger，避免平台凭据、URL 或响应正文泄漏。
- Surface 只向项目 Logger 记录连接中、就绪、重连、恢复和停止等稳定状态，不附带 SDK 错误正文。
- 消息路径注册 `im.message.receive_v1`，机器人菜单注册 `application.bot.menu_v6`；回调只同步
  完成裁剪与有界分流，不能在 SDK Reader 中等待业务或平台网络请求。
- 已注册 `card.action.trigger` 的独立分流并严格裁剪动作；真实命令审批的一次批准已确认当前
  Gateway 长连接可以收到动作。动作必须匹配一次性令牌、Chat、消息、授权 Actor 和当前请求提供的
  精确选项或表单字段，否则拒绝处理。表单回调只额外保留官方 `action.form_value` 中最多四个、
  每项最多 1,000 字符的字符串字段。Plugin 列表只把已启用且可调用项变成受令牌约束的选择按钮，
  选择后通过一次性表单收集任务，再交回统一 `/plugin` Application 边界。
- 普通消息发送使用 `im.v1.message.create` 的 `chat_id + text/post/interactive` 窄能力；
  普通 Turn 输入的开始确认和首条最终正文使用官方 `im.v1.message.reply` 回复精确
  `message_id`，不创建话题串；富文本只生成单个
  `md` 元素，不暴露 SDK Client。模型或上游文本中的飞书原生 `<at>` 标签会在平台边界被中和，
  避免非预期提醒。审批结束和 Thread 状态都只更新 `interactive` 卡片，并使用
  `im.v1.message.patch`；当前 Turn 的启动回复（包括 Skill、Plugin 或子代理身份）会登记为 Thread 状态消息，后续 `active`
  不再创建第二张卡；没有可复用回复时才由 `active` 创建状态卡，`idle` 只把已有卡更新为
  “处理结束 · 结果见下方消息”并保留扩展身份，
  不创建孤立空闲卡。普通文本不会交给卡片更新接口。调用设置 15 秒 HTTP 超时，创建响应必须包含
  `message_id`。
- 发送超时、SDK 失败和残缺响应只暴露稳定错误码，不回传 SDK message、响应正文或凭据。
- 消息创建不自动重试；锁定 SDK 虽提供可选 `uuid` 字段，但当前官方资料未明确其幂等窗口和
  可重试错误语义。
- 原生流式额外需要应用权限 `cardkit:card:write`；一次性音频、UTF-8 文本文件输入和超长最终正文文件补发
  共用既有 `im:resource`。新扫码应用会声明这些权限；已经能接收私聊的已有应用由 Owner
  通过 `/fs doctor` 只增量开通缺失权限，再由 Owner 发布，无需重新扫码或申请用户 OAuth；完全
  收不到消息时改用终端 `codexc doctor` 和重新扫码当前应用恢复。
- 最小新应用接收机器人私聊需要 `im:message.p2p_msg:readonly`。显式回复消息时使用 `parent_id`
  按需读取一条被引用消息，另需 `im:message:readonly`；文本、富文本和 CardKit 只提取受支持的可见
  文字，忽略按钮、输入值与
  引用附件；不扫描历史消息、不下载引用中的附件，也不持久化引用正文。引用读取失败时记录
  受限错误码并降级为只处理当前消息，不因可选上下文丢失当前输入。新扫码应用会声明该权限，
  已经能接收私聊的已有应用由 Owner 通过 `/fs doctor` 增量开通。飞书“复制消息链接”的 token
  没有公开反查接口；
  Adapter 在引用读取和 Turn 创建前精确拒绝这类链接，并提示用户改为直接回复目标消息，不扫描历史。
- 扫码 Setup 在凭据与 Bot 身份验证并原子保存连接配置后，直接复用 Application v7 配置能力，
  只把本次扫码用户写入允许名单，不合并旧应用名单或追加其他用户；随后保留已有菜单并自动发布
  `codexc_home` 悬浮菜单、长连接菜单事件与卡片回调。发布失败时保留
  已验证连接配置，并提示先用终端 `codexc doctor` 检查、再重新扫码选择当前应用；消息事件尚未
  生效时不能依赖 `/fs doctor`。手动凭据 Setup 不直接修改远端应用，终端 Doctor 会检查必需租户
  权限、消息事件和待审核版本。
- Doctor 使用 `application:application:self_manage` 做只读检测，并默认申请
  `application:application:patch` 完成受控配置写入。当前授权 Actor 点击一次性卡片后通过 SDK
  官方流程只授权缺失差集；授权页包装为飞书 AppLink，在客户端侧边栏完成确认。
  注册端返回的 Open ID 属于
  其应用作用域且字段可选，不用于和消息 Actor 比较。授权结果必须匹配当前 App，Lark 租户结果
  失败关闭。SDK 生成的授权链接只接受 `accounts.feishu.cn`、`open.feishu.cn` 或
  `applink.feishu.cn` 精确 HTTPS Origin；`accounts.feishu.cn` 和 `open.feishu.cn` 会包装为
  飞书 AppLink，在客户端侧边栏完成确认。应用凭据或短期授权状态不写入业务存储。授权完成后
  Doctor 保留已有菜单，自动启用 Event Key 为 `codexc_home` 的单个悬浮事件类型菜单项、追加长连接
  菜单事件并提交应用版本；已有待发布版本时拒绝覆盖，需审核时等待管理员批准。授权卡片发送失败会立即取消 SDK 轮询并更新 Doctor
  结果，不能留下无人处理的后台拒绝。已发布版本的菜单节点和 `bot_menu_enable` 分开归约；
  节点存在但开关关闭时显示“已添加，尚未启用”，不得误报为已完成。`unaudit_version_id` 作为
  冲突检测依据，不允许自动配置覆盖。Application v6 应用详情未返回事件 Key 时，Doctor 会从
  固定使用 `zh_cn` 读取的已发布版本事件名称中识别“接收消息”和“机器人自定义菜单事件”。
- 图片下载只使用 `im.v1.messageResource.get` 的 `message_id + image_key + type=image` 窄能力；
  SDK 响应被裁剪为下载流和可选长度，不向其他模块暴露 Client、Header 或上游错误。
- 独立文件下载复用同一消息资源 API 的 `message_id + file_key + type=file` 窄能力；只接受
  1,000,000 字节以内、不含二进制控制字符的非空 UTF-8 文本，并以内联文件名边界提交到
  Application。文件不落盘，Office、压缩包、音视频及富文本内附件失败关闭。

`message-event.ts` 在平台边界把 SDK 原始事件裁剪为稳定的 `FeishuMessageEvent`，只保留账号、
Actor、消息和 Conversation 路由后续需要的字段。缺少 `open_id`、消息标识或 Chat 标识时失败关闭；
原始事件和无关 SDK 字段不会进入其他模块或错误对象。事件、账号、Actor、消息和 Chat 标识按
UTF-8 限制为 1,024 字节，类型字段限制为 64 字节，时间戳限制为 32 字节，消息内容采用官方
文本消息 150 KiB 上限；超出边界的事件不会进入 Inbox。

`menu-event.ts` 只保留菜单事件 ID、App ID、Actor Open ID 和事件 Key。官方菜单事件不提供
Chat ID；`surface.ts` 只在 Actor 与当前 App 的一个已授权私聊绑定精确匹配时打开命令中心，
零个或多个候选都失败关闭。`command-center.ts` 的主卡按“常用”“模型与工作区”“更多”展示
十个动作和一个分类入口；Fast、Goal 和用户明确要求的一键新建会话均复用现有共享命令。
分类入口打开第二张卡片，按“会话查询”“会话操作”“能力与集成”“当前内容”“飞书”展示二十一个动作，
不复用完整文本帮助。会话切换、会话列表、已归档、模型、思考等级、Fast 和工作区会打开
最多 18 项的选择卡；活动会话选择复用 `resume`，归档会话选择复用 `unarchive`，Fast 首次点击
只读取模型状态，明确选择开关后才执行修改。会话与归档搜索、重命名、下一 Turn 追加、Review
和 Goal 共用一个输入卡片；输入前缀只保存在服务端短期 UI 状态，提交后仍由共享命令语法解析。
Skills 入口等价于无参数 `/skill`，只展示与其他渠道一致的编号列表；调用统一使用
`/skill <名称或序号> <任务>`，卡片值不携带本机路径。
项目规则卡只提供 `init` 和 `check`。每张卡片的
令牌除绑定消息、Chat、Actor 和访问策略外，还绑定该卡实际渲染的精确动作与参数；未展示值
失败关闭，选择卡和输入卡接受一次后立即失效；直接新建、停止、归档、固定、取消固定、压缩或
分叉会话也会消费
主卡或分类卡令牌，只读查询仍可复用。令牌限时保存在有界内存中；事件 ID 同样
有限去重。动作直接调用 Adapter 对
`ConversationCommandService` 的复用入口，不伪造文本消息，也不复用审批令牌；已接受的卡片
发送和命令任务由命令中心持有，Surface 停止时在关闭 Outbox 前有限等待。

`inbox.ts` 只接受当前账号的已授权用户私聊普通文本、由 `text` 与 `a` 元素组成的纯文字
`post` 富文本、独立图片，以及包含最多四张图片和可选说明文字的 `post`。超链接同时保留可见文字
和目标 URL；未知元素或畸形结构失败关闭，不能丢弃部分内容后提交。SDK 回调只做
同步校验、富文本结构与图片 Key 裁剪和入队，不执行资源下载。同一 Chat
按顺序处理，不同 Chat 可以并行。永久无效、未授权、重复或过旧事件被明确忽略；全局输入容量
耗尽时返回 `retry/overloaded`。由于当前没有经过真实合同验证的 SDK 重试响应通道，Surface
通过同一有界 Outbox 提示用户稍后重试，不伪造平台自动重投；同一 Chat 在一个连续过载周期内
最多排入一条提示，下一条消息成功接收后才允许再次提示。去重状态只存在于有界内存，关闭时等待
已接受任务至有限超时；超时后只允许已经开始的任务自然结束，尚未开始的同 Chat 排队消息会被
丢弃，不会在旧 Surface 上继续启动。不持久化消息正文。

`media.ts` 只在已授权消息进入 Conversation Worker 后下载图片。平台资源 Key 不作为本机路径，
下载流经 Surface 共用 `ManagedImageStore` 限制为 10 MiB，并按内容签名只接受 PNG/JPEG；
目录权限为 `0700`、文件权限为 `0600`，过期文件定期清理。下载或文件异常只返回稳定脱敏错误。

`renderer.ts` 通过模块公开入口接收 `OutputEvent`。没有进入原生流式路径的最终文本、
Turn 开始确认和 `turn.completed` 结束统计由 Outbox 作为静态 CardKit Markdown 发送；进入
原生流式路径时，结束统计作为独立元素追加到同一终态卡片。其他关键事件和安全提示
使用纯文本；`operation.updated` 由 Outbox 按 Turn 合并，不再逐条渲染普通文本。App Server
Turn、warning 和 MCP 错误会显示 Client 边界已经统一脱敏并限长的详情；连接错误只显示 Gateway
生成的稳定状态文案，未知异常和原始响应正文不会进入平台消息，
未知 Thread 状态不会原样显示。`turn.completed` 使用共享标题、字段顺序和合并后的模型设置行，按 Token、费用、性能分组展开
最近模型请求的上下文、Token 与费用明细、模型设置、压缩次数、周限和 Goal，不查询第二状态源。
共享配置 `display.operation_updates` 为 `full` 时发送包含完整详情、状态和退出码的
操作终态卡片，为 `compact` 时发送一行状态、元数据和最多 160 个字符的详情摘要；两种模式都完整
显示本机路径，并把操作耗时单独放在分隔线后的底栏。网页搜索
成功完成后立即发送；成功的 MCP 与动态工具按 Turn 延迟到最终回复前聚合，单项保留详情，
多项发送一次分类计数，并列出最多 8 个去重后的工具明细及各自次数；超出时明确省略数量。
失败与拒绝仍即时发送。`hidden` 不发送命令、
文件、工具或搜索操作终态卡片；审批、错误、最终回复和 Turn 完成统计保持原有行为。
`display.plan_updates = true` 时，官方自动计划在同一 Turn 内固定使用一张卡片显示完整步骤；
后续计划状态全部在原消息中更新，不再为完成步骤新增卡片；默认开启，可通过 `display.plan_updates = false` 关闭。

`outbox.ts` 只同步接收匹配 `feishu + accountId` 的输出，并按 Chat ID 进入
`ConversationDeliveryQueue`。同一 Chat 串行、不同 Chat 可并行；关闭后拒绝新输出并有限等待
已接收发送。飞书 SDK 发送对象由 `FeishuMessageClient` 通过 `FeishuMessagePort`
注入，Outbox 不持有完整 SDK Client。Adapter 的追加确认和错误提示也进入同一有界队列，不绕过
平台输出顺序和关闭边界。生成图片路径来自 App Server `imageGeneration.savedPath` 或
渠道 spool（`codexc channel send-image`），两者都在共享读取边界验证绝对路径、无符号链接
普通文件、10 MiB 与 PNG/JPEG 签名；`imageView` 和用户上传图片不会自动外发。
静态 CardKit Markdown 按单元素 5,000 个 Unicode 字符、最多 5 张卡片
分片；纯文本和 `post + md` 降级按 UTF-8 序列化后的 20,000 字节计量。每个逻辑结果
最多发送 5 条，超出时明确标记截断，避免单个结果无限占用同一 Chat 的发送任务。消息创建失败
不自动改发另一种格式，避免非幂等重发产生重复消息；卡片创建和更新进入相同 Chat 顺序边界，
均不自动重试。模型 `text.delta` 只在 Outbox 内存中合并 300 ms；可见操作结果或生成图片到达前，
Outbox 会先把同一 Turn 已暂存的正文作为关键顺序屏障刷新，避免操作越过说明文字。短回复完成前不创建卡片，
静态展示使用 CardKit 2.0 `card.create → message.create`；只有卡片实体创建失败且尚未向 Chat
发送时才记录受约束告警并降级为 `post + md`，消息创建失败不重发。持续回复使用
`card.create → message.create → cardElement.content → card.update`
链路；终态通过关闭流式模式的完整静态卡片全量更新正文并追加结束统计，避免打字机动画尚未追平
时关闭导致尾字缺失，也避免独立消息创建先于卡片更新在客户端可见。每张卡片最多保留 5,000 个
Unicode 字符，跨卡代码围栏会闭合并重开；流式卡片与失败
回退富文本共享单个结果最多 5 条的总预算，达到预算或本地有界缓冲上限时在最后一张消息明确
标记截断。非终态流式输出最多使用前 4 条，第 5 条保留给最终校正或失败回退。创建或内容
更新失败会尽力结束已显示的卡片，再在最终文本到达后用剩余预算回退完整富文本；CardKit 的
HTTP 429 和开放平台通用频控码 `99991400` 在非终态元素更新中只跳过当前帧，保留累计正文和
已递增序列供后续自然增量继续，不主动重试；终态受限仍回退完整富文本。终态全量更新失败不重复正文；
状态、正文和
卡片更新继续共用一个 Chat 队列，不引入第二套 Channel、队列或持久化。同一 Thread 的状态消息 ID
只保存在 Outbox 内存；新 Turn 的“已开始处理”回复优先作为该状态消息，没有可复用回复时才由
`active` 创建轻量状态卡，并在 `idle` 到达时按同一 Chat 顺序更新为绿色
“处理结束 · 结果见下方消息”；重复 `active` 被忽略，
更新失败会清理旧绑定且不阻塞后续输出。终态卡片明确说明结果位于后续消息，避免原地更新后的卡片
在聊天记录原位置造成顺序误解；通用消息更新尚未实现。超过五张卡片可靠
展示预算且不超过 1,000,000 字节的最终回复会保留有界预览，并通过官方 IM 文件上传与
`msg_type=file` 追加 `codex-final-answer.txt`；流式路径在已有卡片后追加文件。该路径只接受
当前最终正文构造的内存 Buffer，不读取本机路径；文件上传或发送失败不重试，静态路径从预览
截断点继续发送剩余有界正文。
飞书当前使用的 `im.v1.message.create` 没有采用 Telegram 式静默发送参数，也不调用加急接口。
过程增量和 Thread 状态通过同一卡片流式或原地更新降噪；运行中的操作帧不创建消息。最终回复、
Turn 失败或错误、审批和用户输入必须创建新的普通消息或卡片，以获得飞书标准提醒；审批结果和
结束状态只更新原消息。启用操作过程显示时，操作终态仍会创建普通 CardKit 消息，这是用户明确
选择的可见过程，不伪装为平台静默通知。
活动原生流状态最多保留 100 个；单流只保留最多 5 张卡片展示预算所需的 25,001 个 Unicode
字符；为接续紧邻的 Turn 完成统计，最近结束卡片同样只保留最多 100 个有界引用，完成后立即
清理。超过活动流容量时只忽略非关键增量，最终完成事件仍进入静态 CardKit 主路径。

`surface.ts` 在长连接就绪后，从 Bootstrap 注入的 provider 读取启动通知。Bootstrap 只为
StateStore 中已有绑定且仍有授权 Actor 的精确 Chat 生成消息；Surface 再次校验 Chat ID、去重
并通过同一 CardKit Markdown Outbox 入队。生成失败或输出队列关闭只记录受约束诊断，不阻塞长连接。

`adapter.ts` 对普通文本调用 `ConversationService.submit()`，图片则先通过 `media.ts` 取得受管
绝对路径，再调用同一 `submit()` 的 `localImages` 输入；富文本内的全部图片按原顺序与说明文字在同一次
提交中传入，没有说明文字时才使用稳定图片提示。对已知平台无关命令调用
`ConversationCommandService.execute()`；手动输入的 `/h`、`/work`、`/r` 分别规范化为
`/help`、`/workspace`、`/resume`，不重复加入命令中心菜单。`/start`、`/help` 打开同一命令中心卡片，
`/vision <要求>` 在当前 Actor 与私聊内预设下一批图片的识别要求；多图使用
`/vision <2–4> <要求>` 声明数量并在收齐后自动提交；兼容的 `/vision begin <要求>`、
`/vision done` 保留给数量未知的收集，失败后可在五分钟内用 `/vision retry` 复用原图片和要求，
`/vision cancel` 取消；
`/stop` 优先停止当前 Actor 在本私聊中的最新待处理交互，没有待处理交互时调用共享 Turn
停止命令；`/whoami` 和
`/fs <status|doctor|revoke>` 留在飞书边界。`status` 展示当前进程实际观测到的
连接、消息事件、卡片回调和当前 Actor OAuth 状态；`doctor` 只显示长连接、消息接收、卡片交互
和自定义菜单四项摘要，用户 OAuth 状态与撤销分别留在 `status` 和 `revoke`。用户级能力必须把
自身需要的 Scope 显式传给 OAuth 控制器；控制器先比较应用已开通权限与安全凭据后端中的有效
Token，只用当前能力缺失的差集发起 Device Flow，不提供预授权全部应用 Scope 的公开命令。卡片
明确加入并展示 `offline_access`；授权地址只接受
`https://accounts.feishu.cn` 精确 Origin 的完整 URL，外部响应的 Scope、时间和长度均有界。
原始应用权限条目先按独立安全上限裁剪，再筛选并限制为最多 100 项用户 Scope；授权与凭据载荷
为其保留额外一项 `offline_access`。完成后校验返回 Token 所属 `open_id` 必须与消息 Actor
一致；`status` 会优先显示当前 Actor 正在进行的授权。未知或畸形斜杠命令失败关闭，
不能作为普通消息提交给 Codex。新 Turn 的一次启动确认由共享生命周期事件驱动，并保留 Skill、
Plugin 或子代理的具体类型与名称，
并通过 Outbox 原生回复当前输入，同时作为后续 Thread 结束状态的原地更新目标；Adapter 不自行
重复发送，Skill、Plugin 与子代理命令的新建 Turn 结果也不再追加第二份启动确认。后续回复由 Core 输出驱动；追加到
活动 Turn 时发送明确提示。结构化 `UserFacingError` 按错误码
渲染，不使用其内部 fallback message；未知异常只发送通用提示，然后把原异常交回 Inbox，由
Inbox 现有诊断路径仅记录受约束的错误类型。命令结果、追加确认和错误提示被输出队列拒绝时，
Adapter 不会重试已经执行的状态修改，而是把稳定的队列错误交回同一诊断路径。会话列表最多展示
20 条，名称或预览会规范空白并限制为 48 个字符，剩余项通过搜索提示收敛。

`/fs doctor` 在 Surface 内调用 `application-setup.ts`，不经过 Conversation Core，也不把
应用 SDK 类型带入 Application。Doctor 先读取租户已开通权限、已发布版本、事件和回调形成快照，
再以当前进程真实收到的消息、卡片动作和菜单事件为优先证据。只有必需租户权限仍有缺项且当前
Actor 仍获授权时才生成授权按钮，并把精确差集传给 SDK；菜单、事件、回调或待发布版本缺项只
生成一个当前应用入口，不重复展开权限清单、OAuth 状态和配置教程。卡片动作经过同一严格动作
裁剪后优先路由到应用授权控制器；首次读取失败时仍可在同一卡片进入官方应用授权。令牌一次使用
并绑定原消息、Chat 和 Actor；官方授权结果必须匹配当前 App 和飞书租户，完成后重新读取最新
快照，避免使用点击前的陈旧状态。Surface 停止会取消进行中的 SDK 授权或 HTTP 请求并有限等待。

用户 OAuth Token 不进入 Application、Core、配置或会话 SQLite。macOS 使用系统 Keychain；
Linux 在 Bootstrap 从状态数据库父目录注入的 `credentials/feishu` 下保存独立主密钥和
AES-256-GCM 密文，目录为 `0700`、文件为 `0600`。`revoke` 先取消当前 Actor 的进行中轮询再删除
本地凭据，Surface 停止会取消授权任务并最多等待 5 秒；停止或存储错误与 Token 写入竞态时尝试
恢复原凭据，失败只记录脱敏警告。Linux 后端在原子替换前完成权限设置；Keychain 命令同样有
5 秒上限并使用原地更新，读取两种后端时均严格校验凭据载荷。Linux 只有凭据文件不存在时才返回
未授权；密钥、权限、密文或载荷损坏会返回稳定读取错误，不能静默覆盖为缺失。
明确执行 `revoke` 时不依赖成功解密旧凭据；读取失败后仍会删除对应本地凭据，并只记录错误类型。
飞书 HTTP API、OAuth 与 WebSocket 由 Bootstrap 注入统一 HTTP/HTTPS 代理并按目标域名遵循
`NO_PROXY`；
HTTP 直连会显式关闭 SDK 底层的环境代理再解析，避免覆盖 Bootstrap 决策。仅 SOCKS
`ALL_PROXY` 尚不支持；目标未命中 `NO_PROXY` 时，无效或不支持的代理会失败关闭而非直连。
当前仅完成按需授权基础设施，飞书 CLI API 调用与 Token 自动刷新尚未实现；没有用户级能力调用
授权器，因此不会主动申请用户权限。

`interactions.ts` 只为当前 Conversation 已恢复且恰有一个仍获授权 Actor 的交互请求创建卡片。
初始审批和用户输入卡片使用 Conversation 优先有序通道创建，会排在等待中的非关键流式或状态
输出之前，并作为新的飞书交互消息触发平台正常提醒；已经开始的平台请求不会被中断。创建成功
或失败只记录请求身份、目标和消息 ID/错误类型，不记录命令、理由、表单或 MCP 输入正文。
不可预测令牌只存于内存并绑定请求、Chat、消息和 Actor；审批点击只能映射请求原本提供的一次、
会话、命令前缀或精确网络规则，重复、畸形、越权、过期和关闭后的动作均不会升级权限。用户输入
最多接受三个问题，固定选项不接受列表外值，秘密问题使用飞书密码输入框；答案按原始问题 ID
返回且不会显示在处理结果卡。MCP form 只接受单个最长 1,000 字符的有效 JSON；MCP 工具审批
按上游实际提供的范围显示允许一次、本会话允许和始终允许按钮，不要求填写 JSON；URL 模式只渲染
HTTP(S) 链接。其他客户端解决、取消、超时和 Surface 停止会按请求类型返回空答案或取消，并移除
卡片动作。同一 App Server 请求 ID 的并发重复只保留首个交互；Surface 停止即使遇到未返回的
卡片创建也会先结束协议请求，卡片结果更新失败不会改变已经作出的协议决定。所有表单值只存在于
待处理内存和协议响应中，不写入数据库或日志。同时进行的交互最多保留 100 个，超过容量的请求
按类型安全拒绝或取消，不再发送新卡片；`/stop` 只匹配精确 App、Chat 和 Actor。

`surface.ts` 实现单账号 `SurfaceAdapter` 生命周期：启动等待长连接就绪，运行故障后允许
Bootstrap 只重新建立本账号长连接；最终停止先切断新事件，再有限排空 Inbox 和 Outbox。
Bootstrap 从现有绑定中选择仍有授权 Actor 的 Chat 作为配置通知
收件人；持久通知等待平台实际发送完成，没有已知安全会话时不广播。

本模块已有严格 TOML/运行配置、变更分类、Bootstrap 显式组合和对应离线测试。真实平台结论只在
[`通讯渠道验收矩阵`](../../../docs/channel-acceptance-matrix.md) 维护；一级 `surfaces`
入口只转出窄工厂，不得导出 SDK 类型，也不得在 Core 中引入飞书类型。群聊已记录为后续需求但
当前不开发，也不更新为公开支持。
