# 微信 Surface

当前实现单账号私聊文本、图片、语音转写与 UTF-8 文本文件 Surface：独立安全凭据边界、运行时窄协议 Client、私有游标检查点、
私聊输入 Adapter、完整命令 Adapter、加密重启上线通知、Turn 生命周期统计、文本与生成图片 Outbox、
一次性精确文本审批、用户输入与 MCP 交互端口和目录内部完整 `SurfaceAdapter`；严格运行配置显式启用时由 Bootstrap 注册，
未新增 SQLite Schema。

- `credential-store.ts`：严格校验版本 1 微信 Bot 凭据；macOS 使用独立 Keychain Service，
  Linux 使用独立 `credentials/weixin` AES-256-GCM 私有目录，Windows 使用当前用户 DPAPI 主密钥
  保护的 AES-256-GCM 私有目录。
- `credential-client.ts`：首次协议调用时从安全存储读取并缓存当前进程的凭据 Client；缺失或
  损坏凭据失败关闭，不把 Token 提升到 Bootstrap 配置或日志。
- `factory.ts`：接收 Bootstrap 已决策的精确凭据、游标、回复上下文和上传目录，组合微信固定的
  协议 Client、存储与媒体实现，并把同一个代理感知 Fetch 注入 JSON API、CDN 上传和下载；
  一级 Surface 出口不暴露这些具体实现。
- `updates-cursor-store.ts`：在 `data/weixin-updates` 下按账号 SHA-256 文件名保存严格版本 1
  `get_updates_buf`；目录 `0700`、文件 `0600`，临时文件原子替换，损坏、未知版本和符号链接
  失败关闭。
- `protocol-client.ts`：实现固定 `v2.4.6` 的 `getupdates`、`sendmessage`、`getuploadurl`、
  `getconfig` 和 `sendtyping` HTTP 合同，并按官方 AES-128-ECB、CDN 二进制 `POST` 与
  双层 key 编码发送生成图片和受限内存文件；图片与文件复用同一媒体上传管线，只在验证和
  最终消息项结构处区分；成功长轮询响应给出的下一轮建议超时只在
  1 至 120 秒边界内采用，越界响应失败关闭；出站文本限制为已验证的 4000 个 UTF-16 码元。
- `inbound-message-parser.ts`：在 JSON 数字转换前保留原始 `message_id`，只输出文本、带可选说明文字的最多 4 张图片引用、
  单个一般文件引用、单个语音引用或带原因的忽略事件；文本项内受约束的 `ref_msg` 标题、引用文本与精确 `msg_id` 会作为
  独立引用信息输出；
  混入其他媒体、重复文本或超过图片数量上限时失败关闭。
- `protocol-types.ts`：保存协议稳定错误类型、入站消息可辨识联合和媒体引用结构；`protocol-client.ts`
  继续兼容导出这些公开类型。
- `response-validation.ts`：复用 JSON 对象、数组、受限字符串、整数与微信 API 返回码校验；只产生
  稳定 `WeixinProtocolError`，不保留上游响应正文。
- `request-abort.ts`：统一微信 JSON API、CDN 下载与二进制上传的请求超时、外部取消、监听器清理
  和 Abort 原因分类；协议 Client 仍负责按具体操作映射稳定错误码与中文文案。
- `fetch-body.ts`：统一微信 Fetch 响应的 Content-Length 校验、流式累计、超限取消与 Reader
  清理；JSON API 将有界 Buffer 解码为文本，CDN 下载保留二进制。
- `cdn-download.ts`：统一校验固定官方 CDN 地址，并执行禁止重定向、30 秒超时和有界响应下载；
  图片与文件复用该传输边界，各自保留解密、大小、内容与完整性校验。
- `media-crypto.ts`：统一解析媒体 Base64 AES Key 并执行 AES-128-ECB 解密；图片专属 Hex Key
  入口与文件完整性校验仍留在各自边界。
- `image-store.ts`：只接受固定官方微信 CDN，按 `image_item.aeskey` 或 `media.aes_key`
  执行 AES-128-ECB 解密；复用共享 10 MiB、PNG/JPEG/WebP/非动画 GIF 签名、`0700/0600` 私有暂存和过期清理，
  CDN 地址、查询参数、key 与响应正文不进入日志或用户消息。
- `audio-store.ts`：有官方转写时由会话 Adapter 优先提交转写文本；无转写时只下载并验证
  Codex CLI 可直接读取的 MP3/OGG，最长 5 分钟、最大 20 MiB，使用一小时私有临时文件。
  常见 SILK 在未引入额外解码依赖前明确拒绝，不伪装为 WAV。
- `file-input.ts`：只接受固定官方微信 CDN，按 `media.aes_key` 执行 AES-128-ECB 内存解密，
  校验可选声明长度与 MD5；生产边界只接受最多 1,000,000 字节、不含二进制控制字符的 UTF-8
  文本，验证后直接交给会话 Adapter；Gateway 不保存文件副本、不向 Codex 暴露工作区外路径，
  正文作为用户文本进入 App Server Thread。文件名、地址、查询参数、key、正文与底层异常
  不进入日志或下载错误。
- `outbound-image.ts`：读取 App Server `imageGeneration.savedPath` 映射的绝对路径或
  渠道 spool（`codexc channel send-image`）提交的图片；使用无符号链接文件句柄，限制为
  普通文件、10 MiB 和 PNG/JPEG 内容签名，不把路径或正文写入日志。
- `updates-monitor.ts`：组合协议 Client 与游标 Store；单批消息先按原始消息 ID 去重，并按原始顺序处理
  连续图片段；文本、命令和不同图片段同样保持原始顺序。
  连续图片段失败时先记住本次 Surface 生命周期内此前已经成功处理的消息 ID，渠道独立重试时
  从失败图片继续处理；仅在整批处理成功后提交游标。网络、HTTP 429 与 5xx 瞬时故障先按 2 秒重试，连续 3 次失败后
  进入 30 秒退避并继续轮询，不拖停其他 Surface；官方 `-14` Bot Token 失效返回码会暂停该账号
  一小时并记录重新 Setup 提示。未知 API 或协议错误仍失败关闭。该顺序提供至少一次处理语义：
  如果进程在 Application 已接受消息、游标原子替换尚未完成时退出，重启会从旧游标重放；
  进程内消息 ID 去重不跨重启。固定 App Server 的 `clientUserMessageId` 只形成用户消息
  `client_id`，不会按该值拒绝重复 Turn。
- `polling-health.ts`：只在当前进程内归约轮询中、短重试、退避、Token 失效暂停和停止状态，
  按 Gateway 本地时间显示当前消息到达前上一次后台成功轮询时间，并记录连续失败次数及预计恢复
  时间；不保存消息、游标、Token 或上游响应。
- `doctor.ts`：为微信内 `/wx doctor` 提供只读诊断；严格读取 Bot 凭据、当前私聊回复上下文
  和后台游标后立即降维为可用性状态，并组合进程内轮询健康与 Token 失效状态。诊断不显示或返回
  Token、`context_token`、游标正文及底层存储错误。
- `input-adapter.ts`：拥有单账号监控器生命周期；按微信账号和私聊 Actor 构造目标，授权后记录
  Actor、更新内存回复上下文并把文本、UTF-8 文本文件、图文或最多 4 张图片交给目录内会话 Adapter。协议边界
  兼容同一更新携带文字和多图，但微信客户端实际按单图、单文字消息发送；这些独立消息不等待、
  不按到达时间合并。图片只在
  授权后下载，整批成功后才通过共享输入批处理器转换为 PNG/JPEG/WebP/非动画 GIF Data URL 提交，不向 App Server
  传递本地路径；每张最多 10 MiB、整批最多 20 MiB。已授权用户文本按会话和精确消息 ID 进入最多 1000 条的进程内引用缓存；平台引用只在
  精确命中时补充原文，机器人消息、重启后或淘汰后的未命中引用只处理当前消息，消息正文不持久化。
  停止会清空引用缓存、取消长轮询并有限等待；接收任务意外结束后释放本次运行状态，使 Bootstrap
  可只重启该微信账号的监控器。处理失败不推进游标，只向生命周期所有者报告稳定错误码。
- `conversation-adapter.ts`：复用 Application 的 `ConversationCommandService` 和完整共享命令
  目录（包括显式启用后的 Gateway `/schedule <自然语言>` 确认预览与计划任务管理），并保留微信本地 `/start`、`/help`、
  `/whoami`、`/wx doctor`；共享解析器把
  `/h`、`/work`、`/r` 显式规范化为
  `/help`、`/workspace`、`/resume`；同一 Conversation 的普通消息处理链保持顺序，不同
  Conversation 可并行；授权且精确匹配的 `/stop` 绕过普通消息顺序器，直接进入现有共享命令
  和交互停止边界；将说明文字和全部成功下载的图片一次
  提交；UTF-8 文本文件以内联文本和明确文件名边界提交，不使用本地文件路径。引用正文与当前
  消息明确分离，任一图片失败或总大小超限时不提交部分输入。命令解析只看
  当前消息并复用 Surface 公共模板，未知斜杠
  命令明确拒绝，不会提交为普通 Codex 输入；`/status` 在共享会话状态后追加当前微信轮询健康
  快照。无参数 `/skill` 使用稳定序号展示当前项，`/skill <名称或序号> <任务>` 直接进入共享结构化
  Skill 调用路径。`/plugin` 在共享列表后按当前页可调用项补充可复制的编号任务命令；固定协议未
  验证出站按钮或表单能力，因此不维护渠道私有选择状态。
- `command-renderer.ts`：覆盖全部结构化命令结果与用户错误；在命令适配边界把标题和
  `字段：值` 转换为微信客户端稳定显示的 Markdown 粗体标题与项目符号，保留已有段落和围栏代码。
- `final-text-format.ts`：仅在微信最终回复边界按锁定上游的兼容集合保留标题、粗体、删除线、引用、
  列表、表格、分隔线和代码格式；中文斜体降级为普通文字，H5/H6 降级为粗体标题，普通
  HTTP(S) Markdown 链接保留并交给微信客户端渲染；Markdown 图片标记移除且不触发网络下载，图片仍只由既有
  原生图片通道发送。单行 fenced code 转为行内代码，避免客户端为单条命令生成高大的
  `TEXT / 复制` 区域；多行代码块保留，
  未闭合代码围栏降级为普通文本。
- `operation-format.ts`：复用共享操作标题、状态、脱敏和摘要；完整模式中和 Markdown 控制字符，
  紧凑模式保持单行并限制详情长度；成功的 MCP、动态工具和网页搜索按 Turn 延迟聚合，单项
  保留详情，多项输出一次分类计数和最多 8 个去重后的详情及各自次数，超出时明确省略数量；
  失败与拒绝仍即时输出。
- `reply-context-store.ts`：按账号隔离、最多保留 1000 个私聊的进程内
  `actorId + context_token` 副本，支持精确撤销和整体清空。
- `reply-context-persistence.ts`：按精确账号和私聊 Actor 保存严格版本 1 的最近回复上下文；
  macOS 使用独立 Keychain Service，Linux 使用独立
  `credentials/weixin-reply-context` AES-256-GCM 私有目录，Windows 使用同目录语义的当前用户 DPAPI
  主密钥与 AES-256-GCM 记录。载荷、密文或身份不匹配失败关闭。
- `typing-controller.ts`：只在内存按 Actor 缓存最多 24 小时的 `typing_ticket`；Turn 开始时
  启用原生输入状态并每 5 秒续期，最终回复、完成、停止、失败或 Surface 关闭时取消；协议失败
  只记录受限元数据，不阻断正常回复。
- `outbox.ts`：只处理匹配账号且复用共享生命周期字段的 Turn 开始确认、原生输入状态、CLI/TUI
  输入镜像、最终文本、生成图片产物、操作终态、账户/额度/MCP Server 状态、带耗时/模型/上下文/
  缓存/分支的完成或停止统计、失败通知、连接错误和警告；运行状态使用按会话排序的纯文本气泡，
  不模拟其他平台卡片或静默参数。最终回复使用微信专用格式器，操作展示复用
  共享 `full`、`compact`、`hidden` 三档配置，查询类 `running` 帧由共享缓冲抑制，其余操作
  不发送 `running` 帧；操作终态和生命周期通知
  作为关键输出，不因已有最终回复而省略；超过五个文本气泡且不超过 1,000,000 字节的最终回复
  发送一个有界预览和内存生成的 `codex-final-answer.txt`，不读取任意路径；再大时保持原有
  有界截断。文件协议失败时从预览截断点继续发送剩余文本，总计仍不超过五个气泡，并让原异常
  进入共享队列的脱敏日志。发送时重新检查 Actor
  授权，通过共享 Conversation 队列顺序发送，单条最多 4000 个 UTF-16 码元、最多五条并显示
  截断提示，避免拆开代理对。生成图片独立于操作展示档位，读取前后各复查授权；`imageView`
  和用户上传图片不会自动外发。固定 v2.4.6 合同尚未验证可用的出站原生回复字段，普通 Turn
  继续发送普通消息，避免未支持载荷阻断开始确认、最终正文和完成统计。
  `display.plan_updates = true` 时，自动计划先发送一次完整文本清单，每个步骤首次完成时
  再发送一条紧凑进度；进行中状态不重复发送完整快照。默认开启，可通过 `display.plan_updates = false` 关闭。
  思考状态只显示“思考中…”，连续思考每段只显示一次，每段独立计时并在该段结束时发送一条
  “思考中+耗时”文本，不展示推理摘要或思维链内容；`display.reasoning = false` 时不显示。
- `interactions.ts`：命令、文件和临时权限审批使用 96 位随机、一次性、限时的 ID，提示用户完整
  复制 `/批准一次 <id>`、`/批准会话 <id>`、`/保存命令规则 <id>`、
  `/保存网络规则 <id> <序号>` 或 `/拒绝 <id>`；同一审批的选项优先合并到一个 Markdown
  消息，每个选项使用独立代码块提供单独复制入口，超长时只在完整选项之间分组；只接受当前请求实际
  提供的原值决定，并再次绑定账号、Conversation、唯一授权 Actor、Thread、Turn 和请求 ID。
  裸数字、“同意”、畸形、未知、重复、过期或跨账号/Actor/会话命令不会批准。最多三个非敏感
  用户问题通过 `/选择 <id> <问题序号> <选项序号>` 或
  `/填写 <id> <问题序号> <答案>` 分项收集，全部完成后一次返回原问题 ID；敏感问题明确取消。
  MCP form 只接受 `/提交表单 <id> <JSON>` 后不超过 1000 字符的有效 JSON；MCP 工具审批按
  上游提供的范围接受 `/批准一次 <id>`、`/批准会话 <id>` 或 `/始终允许 <id>`，不要求填写
  JSON；URL 模式只显示 HTTP(S) 链接并接受 `/完成 <id>`。各类交互均可用 `/取消 <id>` 安全取消，答案和表单正文
  不写入日志或持久化存储。
- `surface.ts`：共享一个内存回复上下文组合 Input、Outbox、Typing 与 InteractionPort；启停时通过
  官方 `notifystart` / `notifystop` 合同完成在线状态对账；启动时只为当前允许名单中已知且存在
  加密回复上下文的私聊恢复收件人并发送上线通知，不要求当前仍有 Thread 绑定。状态对账或聊天
  通知失败不停止长轮询；
  微信发送接口以 `-2` 拒绝回复上下文时，只清除该 Conversation 的内存与加密记录，等待后续
  入站消息自然写入新上下文；其他发送失败保留最近回复上下文；
  临时渠道故障只取消当前交互，恢复后仍可接收新的审批、用户输入和 MCP 请求；最终停止时才永久
  关闭交互端口，并先取消输入、再取消交互和排空输出，重复停止安全。配置热加载、重启提示与持久化
  Workspace 新增通知复用同一授权绑定和回复上下文边界；没有安全收件人提供器时持久化通知失败关闭，
  不提供一般主动推送。
- `index.ts`：微信模块公开入口。

命令、状态和 Doctor 的结构化标题与字段使用 Markdown 粗体标题和项目符号；其他短通知
保留紧凑硬换行和既有段落，生命周期结构化字段使用项目符号，不把每个字段扩成独立空行；
围栏代码正文不插入硬换行空格，最终回复仍由独立的 Markdown 兼容格式器处理。

二维码、验证码和消息正文不持久化；解密图片只进入受限临时目录并按统一保留期清理；
最近回复目标和 `context_token` 只进入独立加密回复上下文
后端，长轮询游标只进入独立检查点，二者都不进入 Bot 凭据、TOML、SQLite 或日志。未知版本、
身份不匹配、密文或载荷损坏失败关闭，不能当作未配置后静默
重新扫码。微信目录通过一级 `src/surfaces/index.ts` 公开运行时组合所需的窄接口，并由 Bootstrap
内置插件装配安全凭据 Client、游标 Store、精确 Access Policy 和生命周期故障上报。
