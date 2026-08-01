# 测试

本目录包含 Vitest 单元测试、少量 fast-check 属性测试、模块边界测试和条件式真实 App Server 集成测试。测试文件按被测模块命名并使用 `.test.ts` 后缀。属性测试只用于输入空间大且存在稳定不变量的纯函数，不替代示例测试和真实合同测试。

## 覆盖范围

- JSON-RPC initialize、生成类型约束的精确出站消息、初始化断线竞态、消息分流、超时、过载
  重试和断线清理。
- Thread 新建、列表、恢复、切换、删除、订阅、恢复失败绑定保留、关闭/归档/删除通知语义、
  官方响应到稳定路由快照的映射与必需字段失败关闭、活动 Turn 重启恢复和 Workspace 路由。
- 多 Provider Client 的 Thread 归属发现、状态合并、Turn 路由、Server Request ID 隔离、独立重连
  与定向绑定/交互恢复；切换模式双 App Server、固定模式单主实例和 Provider Remote TUI Socket 选择。
- Thread 设置、归档、删除和关闭 Notification 到稳定 Routing 事件的映射，残缺或无关通知隔离，
  以及 Routing 不再解析原始协议信封。
- 活动 Turn 的即时 steer 与下一 Turn 有界内存队列、顺序启动、Thread 隔离和失败清理；项目输入
  到官方 `UserInput` 的映射，以及 Review、Goal 和控制响应到稳定 Application 结果的映射。
- 图片识别结果的严格数量、顺序、长度和提示注入隔离；双 Provider 与仅 DeepSeek Setup 均为
  外部视觉接口分离保存 Key；模型不支持图片时使用单次 Responses 请求、私有 Key 和稳定响应裁剪，
  外部视觉模型只做客观观察和文字提取，原 Thread 默认不额外搜索、核实或调用工具；
  三渠道只在外部请求发起后发送一次包含图片数量与本条要求的视觉 API 识别提示；`/vision`
  下一批图片要求的 Actor/Conversation 隔离、替换、取消、五分钟过期和一次消费。
- 官方 Turn、Item、Diff、Plan、Goal、Token、账户、额度、MCP 和 warning Notification 到稳定 Core
  输入事件的映射，畸形与未知通知隔离；Conversation Core 状态归约、严格 Turn 完成状态、
  官方 `Turn.durationMs` 校验、三渠道统一结束汇报耗时字段、可重试错误隔离、Thread/全局警告路由，
  以及 Client 边界的操作摘要、Turn/warning/MCP 错误
  脱敏限长与敏感文本清洗。
- 命令、文件修改、临时权限、用户输入和 MCP 审批的归属信息、优先于等待中非关键输出的
  Surface 交互投递、脱敏收到/送达/失败/安全拒绝日志、一次/会话批准、命令前缀及网络
  规则持久授权、网络专用请求、目标主机一致性、拒绝、无法路由、协议能力约束、一次性回调、
  同一 Conversation 有界串行、跨 Conversation 并行、重复请求、关闭、超时和跨客户端解决；
  五类 Server Request 到稳定 Approval 请求及稳定决定到官方响应的双向
  适配、MCP 工具审批元数据与持久范围、畸形请求安全拒绝和未知请求明确报错；三渠道审批、用户输入与 MCP 处理状态、账户额度、
  Turn 追加确认、空回复及文本文件错误的共享文案契约；Interaction Router 按
  `surface + accountId` 暂停、只取消故障账号的活动/排队请求、不可用期间立即拒绝并在恢复后
  重新接收，微信临时取消不会永久关闭交互端口。
- Bootstrap 单渠道启动/运行故障隔离、独立退避恢复、首次启动与恢复期关键输出有界暂存、启动中停止的单次组件
  关闭、App Server 重连取消与关闭等待；内置 Surface 插件
  顺序、零/多账号展开、插件与 Surface ID 一致性、账号唯一性；飞书按配置显式注册、允许名单
  热加载、撤权绑定清理，以及安全 Chat 配置与启动通知。
- 通用 Surface 启停、按账号输出路由与失败隔离，以及飞书和微信运行连接重新启动；三渠道有界引用上下文格式与当前消息隔离；
  Telegram Unicode 分片保真、飞书文本分片字节与数量上限、微信最终文本格式化幂等的属性测试；
  Telegram 与飞书普通 Turn 输入到开始确认和首条最终正文的原生回复目标关联、竞态绑定与清理；
  Telegram 格式、通知降噪、长回复折叠与文件回退、输出队列顺序与并发关闭等待、生命周期、
  API 重试、图片输入、纯内存 UTF-8 文本文件输入、生成图片安全读取与 `sendPhoto` 回传及
  `reply_to_message` 文本/说明识别。
- 飞书官方 SDK 事件长连接的凭据预检、真实握手就绪、启动失败与超时、重连状态、脱敏生命周期
  日志、停止竞态、SDK 消息字段裁剪、运行状态门控和错误脱敏；文本、静态 CardKit Markdown 与
  `post + md` 降级发送的
  精确 `chat_id` Payload、平台原生提及标签中和、有限 HTTP
  超时、SDK 错误脱敏和残缺响应失败关闭；CardKit 2.0 原生流式卡片创建、消息引用、元素更新和
  终态完整静态卡片全量更新的精确 Payload、递增序列与 UUID、短回复静态卡片、300 ms 增量合并、单卡滚动、
  代码围栏衔接、卡片与回退共用五条预算、明确截断、失败卡片尽力结束、UTF-16 摘要边界、
  Turn/关闭收尾、HTTP 429 与官方频控码的稳定分类、中间帧跳过、后续增量继续及终态完整
  富文本回退；生成图片上传与 `msg_type=image` 发送、消息资源图片与文件下载的精确
  `message_id + image_key + type=image`、`message_id + file_key + type=file` Payload、资源标识
  约束、长度裁剪和错误脱敏；回复事件
  `parent_id` 裁剪、指定消息读取及文本/富文本/CardKit 可见内容解析与交互值忽略；私聊文本、
  独立图片与最多四张图片说明文字 `post` Inbox 的账号/类型/授权筛选、同步有界
  入队、授权拒绝不污染去重键、事件去重、旧事件过滤、同 Chat 顺序、跨 Chat 并行、过载重试和有限关闭；卡片动作
  稳定字段裁剪、受限字符串动作值、畸形输入失败关闭和 WebSocket 独立分流；所有关键
  `OutputEvent` 的 CardKit Markdown 最终回复、启动环境与脱敏 UA、每轮上下文和设置的紧凑
  CardKit Markdown、活动 Turn 输出不追加状态尾栏、纯文本安全回退、
  操作终态静态卡片与助手消息顺序，以及脱敏上游错误详情展示；共享操作标题、状态、飞书耗时底栏与
  退出码元数据、上游敏感占位符、完整本机路径显示、Unicode 单行摘要边界及三渠道按 Turn 聚合成功查询类操作；Outbox
  的精确账号路由、同 Chat 顺序、跨 Chat 并行、静态 CardKit 单元素 5,000 字符与最多 5 张卡片、
  纯文本及降级富文本 20,000 字节上限、
  明确截断、关闭等待及完整、单行摘要、隐藏三档操作输出；同一 Thread 的 active/idle 轻量状态卡片创建、重复抑制、顺序更新、更新错误
  分类、失败绑定清理和关闭超时后的迟到结果隔离；操作详情、状态、耗时和退出码的
  运行帧忽略、终态静态 CardKit 发送及会话顺序；已授权文本、PNG/JPEG 独立图片、单张图片说明
  文字和独立 UTF-8 文本文件到 Application 的提交，图片的 10 MiB 限制、内容签名校验、私有
  暂存与过期清理，文件的安全名称、1,000,000 字节、控制字符、纯内存和错误脱敏边界，活动 Turn
  追加提示、命令参数透传、
  全部平台无关命令结果种类与 Outcome、模型视图、
  非空集合、会话列表条数与预览边界、Diff、Default/Plan 切换与直接规划、Goal、本地帮助/身份/取消、未知斜杠命令
  失败关闭、输出队列拒绝不重试状态修改、结构化用户错误和
  未知异常脱敏；单账号 Surface 的长连接启停、重连事件去重、关闭排空、连续输入过载提示收敛和配置通知
  失败关闭与安全发送；审批、最多三个问题的用户输入表单、秘密输入、MCP JSON/工具审批/URL 卡片，
  `form_value` 边界、非法选项/JSON/URL 拒绝、取消和处理结果脱敏；按严格配置注册及允许名单
  热加载；飞书 `status/doctor` 的运行观测、四项精简摘要、租户 Scope 差集、单一处理入口、
  卡片与菜单运行时实证优先，以及 Application v7 配置快照、已有菜单保留、待发布版本提示、
  App/Chat/Actor 一次性确认、SDK 应用授权、授权卡片发送失败取消和 Lark 租户拒绝；
  分类命令中心、统一 Application 命令目录、有界选择值绑定、一次性通用输入表单、会话与归档
  搜索、表单动作/字段/长度失败关闭、直接写操作重复点击拒绝和命令任务的有限关闭等待；OAuth Device Flow
  请求/轮询、精确授权 Origin 与完整 URL、混合 Token 类型、能力所需 Scope 与应用已开通 Scope
  的交集、空需求不授权、有效 Token 覆盖检测与缺失差集申请、`offline_access` 飞书内授权卡片、统一 HTTP/HTTPS 代理、`NO_PROXY` 选择、显式
  直连和无效代理失败关闭、Actor 身份匹配、进行中状态、重复流、限时停止/撤销竞态、写入错误/
  取消回滚，以及 macOS Keychain 原地更新与命令超时、严格凭据载荷、macOS/Linux 分离的 Token
  Store 契约和 Linux 原子密文替换与私有权限。
- Skill 用户与 Workspace 安装过滤、结构化显式调用、已安装 Plugin 稳定摘要及远端市场隔离。
- 官方模型目录到稳定 Application 模型选项的映射、不可见项过滤、必需字段失败关闭，模型、
  思考强度和 Fast 的 Thread 覆盖、Codex 用户级 Fast 默认值持久化、共享客户端完整或残缺设置
  通知、Thread 失效通知及 Gateway/CLI 连接恢复；DeepSeek 官方脚本目录提取、两种 Setup 模式、
  API Key 输出隔离、下载失败不修改、Flash 可选与 Pro 可见但不可选，以及跨 Provider 新建
  Thread、原 Thread 可恢复、精确 Provider 路由、设置通知不覆盖不可变 Provider，以及在文本模型
  上创建或追加 Turn 前拒绝图片输入。
- Provider 账户能力的编译期唯一注册、未知 Provider 不回退、OpenAI Token 用量与单桶/多桶额度
  到稳定 Application 摘要的映射、重置券数量，以及 DeepSeek 私有配置读取、统一代理、官方余额
  Schema 裁剪、响应上限和错误脱敏；Thread Token/上下文对 Provider 通用，OpenAI Fast 与周限
  不进入 DeepSeek 状态或完成卡片。
- 全 Provider 最后一次模型响应的文本与函数/自定义工具参数非推理输出速度；DeepSeek 可观测的
  首字延时、思考/生成速度，以及 OpenAI 即使收到推理摘要计时也只保留非推理输出指标；自动回环
  代理的精确 `/responses`、`/responses/compact`
  与只读 `/models` 路径、HTTP/SSE 与 WebSocket、上游
  状态/Header、私有元数据剥离、流式转发、统一代理 Agent、OpenAI 自定义上游保留、App Server
  服务独立生命周期、响应完成前的指标确认、启动失败清理，以及 `0600` Unix Socket 指标投递和
  Gateway 缺席时无损模型请求。
- Skill 查询按授权 Workspace 发送精确 CWD，Client 只映射启用的用户与项目直接安装项，排除
  系统和插件缓存并在缺少显示字段时失败关闭；显式调用重新解析精确名称、校验绝对路径，并同时
  发送 `$Skill` 文本标记与结构化 Skill 输入；三个渠道统一覆盖无参数 `/skill` 编号列表与
  `/skill <名称或序号> <任务>`，不维护渠道私有选择状态。
- MCP 查询按当前 Thread 读取项目级配置，使用精简清单分页并映射名称、认证状态和工具数量；
  必需字段畸形或分页游标循环时失败关闭。
- Plugin 查询按授权 Workspace 发送精确 CWD，只调用已安装接口并映射名称与启用状态；安装建议
  和 Marketplace 加载详情不进入 Application，必需字段畸形时失败关闭。
- Permission Profile 查询按授权 Workspace 发送精确 CWD，分页映射 ID、说明和策略可选状态；
  必需字段畸形或分页游标循环时失败关闭，并与高权限审批决定保持分离。
- 当前授权 Workspace 的 Git 分支通过组合根有时限只读查询进入共享 Conversation 状态，并由
  Telegram、飞书与微信共用的上线通知、Turn 开始确认和 `turn.completed` 结束汇报契约一致展示；
  `/status` 继续复用共享 Conversation 状态，非 Git 目录安全回退。
- SQLite 最小绑定恢复、当前版本 Schema 缺失失败关闭、配置文件类型/所有者/权限和父目录
  写权限失败关闭、配置热加载与自动重启分类、Setup
  类别与通讯渠道菜单、Telegram Setup、飞书手动输入与扫码注册的消息和 CardKit 最小权限、卡片动作回调
  声明、应用选择、Bot 身份验证、扫码后自动发布悬浮菜单、发布失败保留连接配置并安全提示 Doctor
  恢复、授权域名约束、允许名单确认、原子保存和错误脱敏、
  CLI 项目规则生成/检查、launchd、systemd、Unix WebSocket 私有目录/真实 Socket 校验和请求头、
  模块依赖方向、`runtime` 导入白名单及公开入口边界。
- 微信 Setup 的替换风险取消门槛、扫码结果到禁用态非敏感配置和独立安全凭据的原子提交、配置失败
  凭据恢复，以及微信/飞书分离的 Keychain Service、Linux 密文私有权限、严格版本和损坏失败关闭。
- Workspace 不可变授权快照、热加载失败回滚、选择歧义，以及 Telegram Surface、账号和规范
  Actor ID 的联合授权；飞书 Surface、App 账号和 `open_id` 精确允许名单及原子替换。
- 微信二维码合同探针的固定请求 Header/路径/Body、严格响应裁剪、未知和残缺状态失败
  关闭、请求超时与外部取消区分、官方域名重定向、配对码、刷新上限、整体时限，以及默认离线、
  显式 `qr --live` 和连接替换风险再次确认后才允许访问真实端点的 CLI 门槛。
- 微信 `getupdates` 单次合同探针的固定认证 Header、随机请求标识、请求 Body、响应体上限、
  API 错误脱敏、消息结构裁剪、原始数值词法精度判断、超时与外部取消，以及默认离线和不持久化
  消息或游标的边界；双轮与三轮模式覆盖内存游标传递、游标推进、旧游标复用和基于原始 ID 的
  重放计数。
- 微信 `sendmessage` 合同探针的固定认证 Header、完成态文本请求、随机 `client_id`、响应体
  上限、API 错误脱敏、超时与外部取消、已授权完成态文本上下文筛选，以及回复目标、
  `context_token` 和消息正文只在内存使用且不进入探针输出的边界；双消息模式覆盖同一上下文
  连续回复、固定 Unicode/emoji/Markdown 文本和首条 API 错误后停止；长度模式覆盖恰好
  4000 个 JavaScript 字符、UTF-8 多字节中文、首尾标记和正文不进入输出。
- 微信 `getconfig/sendtyping` 合同探针的固定认证 Header、输入状态票据裁剪、开始/5 秒续期/
  取消顺序、续期失败后的取消、API 错误脱敏、畸形票据、超时与外部取消。
- 微信图片合同探针的已授权完成态图片筛选、固定官方 CDN 地址、`image_item.aeskey` 与
  `media.aes_key` 两种 AES-128-ECB key 形态、内存解密、10 MiB 上限、PNG/JPEG 签名校验，
  以及图片、地址、查询参数、key、Token、游标和完整身份不进入输出。
- 微信一般文件合同探针的已授权完成态文件筛选、固定官方 CDN 地址、`media.aes_key`
  AES-128-ECB key 形态、内存解密和 20 MiB 本地安全上限，声明长度与 MD5 校验、文件名形状
  和扩展名 MIME 推断，以及文件名、文件正文、MD5、地址、查询参数、key、Token、游标和完整
  身份不进入输出；非官方 CDN、畸形 key 和超限声明长度失败关闭。
- 微信反向图片合同探针的已授权完成态文本上下文筛选、固定 `getuploadurl` 请求、
  PNG MD5/大小与 AES-128-ECB PKCS7 密文大小、官方 CDN 完整地址及参数回退、二进制 `POST`、
  `x-encrypted-param` 有限重试和 4xx 立即失败、单张图片 `sendmessage` 字段，以及图片、
  上传地址、参数、key、Token、游标和完整身份不进入输出。
- 微信运行时前置协议 Client 的固定 `getupdates/sendmessage/getuploadurl/getconfig/sendtyping` 请求、
  原始 `message_id` 精度、输入状态票据严格裁剪与状态值映射、
  文本、带说明文字的最多 4 张图片、单个语音引用与忽略事件裁剪、其他媒体/重复文本/超量图片失败关闭、
  账号方向、4000 码元出站边界、
  响应体上限、API/HTTP 错误脱敏、超时和
  取消；版本 1 游标 Store 的账号哈希文件名、严格载荷、原子替换、权限修复、精确删除、损坏与
  符号链接失败关闭；接收监控器的顺序投递、原始 ID 去重、整批成功后游标提交、失败保留旧游标、
  有限瞬时重试、长轮询超时和取消；固定官方 CDN 图片下载、两种 AES key 形态、AES-128-ECB
  解密、单张 10 MiB/PNG/JPEG 边界、私有暂存和敏感错误裁剪；语音转写优先、MP3/OGG
  下载、5 分钟/20 MiB、SILK 明确拒绝，以及当前模型缺少 `audio` 时在 Turn 前拒绝；
  私聊文本、图文与多图片输入
  Adapter 的授权、Actor 记录、协议单次更新多图兼容与客户端独立消息立即提交、整批 20 MiB 限制、失败不提交部分输入及
  Application `localImages` 同次提交、
  单个一般文件解析、授权后固定 CDN 下载、AES-128-ECB 内存解密、声明长度与 MD5 校验、
  1,000,000 字节 UTF-8 文本边界、二进制拒绝、Gateway 不保存文件副本及未授权不接触 CDN，
  完整共享命令目录、全结果渲染、未知命令拒绝、未授权确认与上下文撤销、稳定致命错误、重复启停
  和有限关闭；进程内回复上下文、独立 Keychain/Linux AES-256-GCM 持久记录、严格载荷和损坏
  失败关闭、授权绑定恢复、官方 `notifystart` / `notifystop` 在线状态对账、重启上线通知失败隔离
  与 `-2` 被拒绝回复上下文的精确清理及下次入站恢复、紧凑命令换行、账号隔离、
  Turn 原生输入状态的开始、5 秒续期、
  内存票据复用、取消与失败隔离、最终文本的微信 Markdown 兼容转换、
  单行代码块压缩、多行代码块保留及未闭合围栏降级、完成/停止/失败统计、操作终态的完整/紧凑/隐藏模式、
  官方 `imageGeneration.savedPath` 到生成图片输出的映射、无符号链接普通文件读取、
  10 MiB/PNG/JPEG 边界、读取前后撤权复查、官方 CDN 上传与双层 AES key 编码、
  详情脱敏与 Markdown 中和、4000 码元
  代理对安全分片、五片截断、同会话顺序、跨会话并行、发送前
  及分片中途撤权复查、缺少上下文、过载拒绝、关闭清理和日志脱敏；微信命令、文件与临时权限
  审批的随机一次性精确命令、请求能力原值映射、账号/Actor/Conversation 绑定、裸数字与宽松
  文本不拦截、畸形/未知/重复/过期/跨边界拒绝和跨客户端失效；用户输入的定值选择、自由回答、
  多问题收集、敏感问题安全取消，以及 MCP JSON 表单、工具审批范围、HTTP(S) URL 完成和取消命令；
  完整微信 Surface 的稳定身份、输入到最终输出与审批闭环、输入先停再排空输出、重复启停、
  瞬时故障重试与 30 秒退避恢复、`-14` 失效凭据暂停和受限诊断、其他致命故障裁剪、
  进程内轮询健康归约、当前消息到达前上一次后台成功轮询的本地绝对时间、预计恢复时间渲染及
  `/status` 组合、
  已授权回复上下文中的运行时和持久化配置通知、缺少安全收件人提供器时失败关闭，以及停止后拒绝
  重启；安全凭据延迟加载与单次缓存、缺失凭据
  失败关闭、配置目录凭据与独立数据库路径组合、精确账号/Actor Policy、显式启用配置、内置插件
  注册、允许名单新增热加载、缩减重启和重启时撤权绑定清理。
- 飞书卡片动作与表单字段裁剪、私聊审批/用户输入/MCP 卡片、一次性令牌、
  Actor/Chat/消息/请求绑定、请求原值决定、越权与重复动作、重复请求失败关闭、超时、
  卡片创建悬挂时的有限关闭、结果卡更新失败隔离、跨客户端失效和 `/stop` 交互优先语义；
  Telegram 同步覆盖重复请求、100 项交互容量、准备期关闭、严格回答验证、100 个活动流和
  单流 1,000,000 字符边界。
- Event Bus 容量、关键事件保护、关闭后拒绝订阅、并发关闭等待、慢消费者超时和消费者失败隔离。
- 统一 Logger 异常元数据约束，以及 Token、App Secret、Authorization、Password 和 Cookie
  字段脱敏。
- TOML、热加载分类、标准环境变量、macOS 系统代理和 Linux GNOME 代理的优先级，以及 Telegram
  Setup 对同一解析结果的复用；无代理时不注入空环境变量；飞书启用/禁用、凭据和允许 Open ID
  的严格映射、畸形与未知字段拒绝，以及启用/凭据重启和允许名单热加载分类。
- CLI Doctor 的严格 TOML Schema 校验、共享 App Server 握手与实际版本匹配、飞书凭据/Bot
  身份有限探测、微信安全凭据只读校验、敏感错误清洗和只读诊断；微信 Doctor 的配置与允许人数、
  Bot 凭据、游标检查点、加密上线通知上下文覆盖数和最近保存时间摘要，以及 Token、
  `context_token` 和实际游标不进入输出；项目规则限定当前 Workspace、
  拒绝远程覆盖和符号链接路径逃逸；CLI 分级帮助、规范命令名称及 macOS/Linux 服务目标选择；
  一级模块使用完整依赖允许列表并要求跨模块只导入公开入口；Session Routing 不得依赖具体
  Client 或生成协议，Conversation Turn 测试不得伪装成完整 Client；生产源码只有 Codex Client
  可以导入生成协议，业务模块不得依赖具体 Client。
- 仓库 Git hooks 自动安装与重复执行安全性，以及无本地依赖时的源码安装准备。
- 协议临时生成失败时保留现有类型目录、生成树逐文件比较和安全替换。
- Codex CLI 升级准备脚本的精确版本参数、CLI 输出、干净工作区保护和 Codex 审查交接。
- 正式 README 版本同步的升级、幂等、开发基线保留、预发布与降级失败关闭。
- 官方稳定 Release 校验，以及 CI 升级差异摘要中的文件和协议目录数量。
- 官方 Alpha 过滤与版本排序、GitHub 临时错误有限重试、无差异失败报告，以及临时 Git Index
  对新增文件的完整捕获。
- GitHub Release 响应正文中断后的有限重试，以及目标版本未解析时仍可生成失败报告。
- 升级验证在单项失败后继续执行、保存独立日志和结构化结果，以及 RPC 方法和顶层必填字段差异
  的自动报告。

常规验证：

```bash
npm test
```

该命令会先构建当前源码到 `dist/`，再运行完整测试，避免 CLI 与 Doctor 用例读取旧构建产物。

生成包含未执行源码的 V8 Coverage 报告：

```bash
npm run test:coverage
```

HTML 报告写入被 Git 忽略的 `coverage/`；当前只记录基线，不设置缺乏依据的强制覆盖率阈值。

CI 中的隔离 App Server 合同测试要求安装受支持的 Codex CLI，但不需要登录，也不会调用模型：

```bash
RUN_CODEX_CONTRACT=1 npm test -- --run tests/real-app-server.test.ts
```

该合同测试使用临时 `CODEX_HOME`、provider-only DeepSeek 测试配置和本地测试 MCP 进程，验证
App Server 不依赖 CLI Profile 即可初始化，并验证 MCP 工具审批元数据及
`_meta.persist` 通过真实 App Server 往返；同时验证一个 Client 写入的 Fast 用户默认值能被另一个 Client
读取，之后新建 Thread 的运行时 `serviceTier` 按 `default → priority → default` 变化，并验证
第二个 Client 修改共享 Thread 的模型、思考强度和 Fast 设置时，订阅方收到完整的
`thread/settings/updated`；第二个 Client 重连后再次修改仍会广播。合同还会启动并立即清理一个
不等待模型结果的 Plan Turn，验证 Default/Plan 预设、Plan 设置通知、稳定 Turn ID、中断后的
官方非负 `durationMs`、Skill、MCP、Plugin
与 Permission Profile 查询摘要，
以及跨 Client 的 Goal 设置、读取和清除映射；第二个 Client 重新连接并 resume 当前 Thread 后，
还必须重新收到已有 Goal 状态。

使用当前用户配置的完整 Unix WebSocket/App Server 冒烟测试同样不会调用模型：

```bash
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

默认真实测试会让两个 Client 连接同一个临时 Unix WebSocket App Server，验证一个连接创建的
临时 Thread 会实时广播到另一个连接，并出现在共享的 loaded Thread 列表中；该流程不会启动
模型 Turn。若还要验证两个连接依次读取和恢复同一个已有会话，可显式指定当前 Workspace 中
空闲且允许临时订阅的 fixture Thread：

```bash
CODEX_RESUME_FIXTURE_THREAD_ID=<thread-id> \
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

新增行为应优先扩展最接近的现有测试文件；协议或 Transport 修改还必须增加真实 App Server 验证，不能只依赖 Mock。
