# 微信 Surface

当前实现单账号私聊文本、图片与 UTF-8 文本文件 Surface：独立安全凭据边界、运行时窄协议 Client、私有游标检查点、
私聊输入 Adapter、完整命令 Adapter、加密重启上线通知、Turn 生命周期统计、文本与生成图片 Outbox、
一次性精确文本审批、用户输入与 MCP 交互端口和目录内部完整 `SurfaceAdapter`；严格运行配置显式启用时由 Bootstrap 注册，
未新增 SQLite Schema。

- `credential-store.ts`：严格校验版本 1 微信 Bot 凭据；macOS 使用独立 Keychain Service，
  Linux 使用独立 `credentials/weixin` AES-256-GCM 私有目录。
- `credential-client.ts`：首次协议调用时从安全存储读取并缓存当前进程的凭据 Client；缺失或
  损坏凭据失败关闭，不把 Token 提升到 Bootstrap 配置或日志。
- `updates-cursor-store.ts`：在 `data/weixin-updates` 下按账号 SHA-256 文件名保存严格版本 1
  `get_updates_buf`；目录 `0700`、文件 `0600`，临时文件原子替换，损坏、未知版本和符号链接
  失败关闭。
- `protocol-client.ts`：实现固定 `v2.4.6` 的 `getupdates`、`sendmessage`、`getuploadurl`、
  `getconfig` 和 `sendtyping` HTTP 合同，并按官方 AES-128-ECB、CDN 二进制 `POST` 与
  双层 key 编码发送生成图片和受限内存文件；成功长轮询响应给出的下一轮建议超时只在
  1 至 120 秒边界内采用，越界响应失败关闭；
  在 JSON 数字转换前保留原始 `message_id`，只输出文本、带可选说明文字的最多 4 张图片引用、
  单个一般文件引用或带原因的忽略事件；文本项内受约束的 `ref_msg` 标题、引用文本与精确 `msg_id` 会作为
  独立引用信息输出；
  混入其他媒体、重复文本或超过图片数量上限时失败关闭，并限制出站文本为
  已验证的 4000 个 UTF-16 码元。
- `image-store.ts`：只接受固定官方微信 CDN，按 `image_item.aeskey` 或 `media.aes_key`
  执行 AES-128-ECB 解密；复用共享 10 MiB、PNG/JPEG 签名、`0700/0600` 私有暂存和过期清理，
  CDN 地址、查询参数、key 与响应正文不进入日志或用户消息。
- `file-input.ts`：只接受固定官方微信 CDN，按 `media.aes_key` 执行 AES-128-ECB 内存解密，
  校验可选声明长度与 MD5；生产边界只接受最多 1,000,000 字节、不含二进制控制字符的 UTF-8
  文本，验证后直接交给会话 Adapter；Gateway 不保存文件副本、不向 Codex 暴露工作区外路径，
  正文作为用户文本进入 App Server Thread。文件名、地址、查询参数、key、正文与底层异常
  不进入日志或下载错误。
- `outbound-image.ts`：只读取 App Server `imageGeneration.savedPath` 映射出的绝对路径；
  使用无符号链接文件句柄，限制为普通文件、10 MiB 和 PNG/JPEG 内容签名，不把路径或正文写入
  日志。
- `updates-monitor.ts`：组合协议 Client 与游标 Store；单批消息先按原始消息 ID 去重，只并发准备
  连续图片段，使平台拆开的图片可以进入同一聚合窗口；文本、命令和不同图片段仍保持原始顺序。
  仅在整批处理成功后提交游标。网络、HTTP 429 与 5xx 瞬时故障先按 2 秒重试，连续 3 次失败后
  进入 30 秒退避并继续轮询，不拖停其他 Surface；官方 `-14` Bot Token 失效返回码会暂停该账号
  一小时并记录重新 Setup 提示。未知 API 或协议错误仍失败关闭。
- `polling-health.ts`：只在当前进程内归约轮询中、短重试、退避、Token 失效暂停和停止状态，
  按 Gateway 本地时间显示当前消息到达前上一次后台成功轮询时间，并记录连续失败次数及预计恢复
  时间；不保存消息、游标、Token 或上游响应。
- `doctor.ts`：为微信内 `/weixin doctor` 提供只读诊断；严格读取 Bot 凭据、当前私聊回复上下文
  和后台游标后立即降维为可用性状态，并组合进程内轮询健康与 Token 失效状态。诊断不显示或返回
  Token、`context_token`、游标正文及底层存储错误。
- `input-adapter.ts`：拥有单账号监控器生命周期；按微信账号和私聊 Actor 构造目标，授权后记录
  Actor、更新内存回复上下文并把文本、UTF-8 文本文件、图文或最多 4 张图片交给目录内会话 Adapter。同一接收批次
  内连续到达的文字和图片按 Actor 隔离，并在一秒静默窗口后合并；图片只在
  授权后下载，整批成功后才通过同一次 `localImages` 输入提交；每张最多 10 MiB、整批最多
  20 MiB。已授权用户文本按会话和精确消息 ID 进入最多 1000 条的进程内引用缓存；平台引用只在
  精确命中时补充原文，机器人消息、重启后或淘汰后的未命中引用只处理当前消息，消息正文不持久化。
  停止会清空引用缓存、取消长轮询并有限等待；
  处理失败不推进游标，只向生命周期所有者报告稳定错误码。
- `conversation-adapter.ts`：复用 Application 的 `ConversationCommandService` 和完整共享命令
  目录，并保留微信本地 `/start`、`/help`、`/whoami`、`/weixin doctor`；将说明文字和全部成功下载的图片一次
  提交；UTF-8 文本文件以内联文本和明确文件名边界提交，不使用本地文件路径。引用正文与当前
  消息明确分离，任一图片失败或总大小超限时不提交部分输入。命令解析只看
  当前消息并复用 Surface 公共模板，未知斜杠
  命令明确拒绝，不会提交为普通 Codex 输入；`/status` 在共享会话状态后追加当前微信轮询健康
  快照。
- `command-renderer.ts`：按微信纯文本边界覆盖全部结构化命令结果与用户错误；多行内容转换为双
  换行段落，避免客户端把单换行折叠为空格。
- `final-text-format.ts`：仅在微信最终回复边界把单行 fenced code 转为行内代码，避免客户端
  为单条命令生成高大的 `TEXT / 复制` 区域；多行和未闭合代码块保持原样。
- `operation-format.ts`：复用共享操作标题、状态、脱敏和摘要；完整模式中和 Markdown 控制字符，
  紧凑模式保持单行并限制详情长度；成功的 MCP、动态工具和网页搜索按 Turn 延迟聚合，单项
  保留详情，多项仅输出一次分类计数，失败与拒绝仍即时输出。
- `reply-context-store.ts`：按账号隔离、最多保留 1000 个私聊的进程内
  `actorId + context_token` 副本，支持精确撤销和整体清空。
- `reply-context-persistence.ts`：按精确账号和私聊 Actor 保存严格版本 1 的最近回复上下文；
  macOS 使用独立 Keychain Service，Linux 使用独立
  `credentials/weixin-reply-context` AES-256-GCM 私有目录。载荷、密文或身份不匹配失败关闭。
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
- `interactions.ts`：命令、文件和临时权限审批使用 96 位随机、一次性、限时的 ID，提示用户完整
  复制 `/批准一次 <id>`、`/批准会话 <id>`、`/保存命令规则 <id>`、
  `/保存网络规则 <id> <序号>` 或 `/拒绝 <id>`；同一审批的选项优先合并到一个 Markdown
  消息，每个选项使用独立代码块提供单独复制入口，超长时只在完整选项之间分组；只接受当前请求实际
  提供的原值决定，并再次绑定账号、Conversation、唯一授权 Actor、Thread、Turn 和请求 ID。
  裸数字、“同意”、畸形、未知、重复、过期或跨账号/Actor/会话命令不会批准。最多三个非敏感
  用户问题通过 `/选择 <id> <问题序号> <选项序号>` 或
  `/填写 <id> <问题序号> <答案>` 分项收集，全部完成后一次返回原问题 ID；敏感问题明确取消。
  MCP form 只接受 `/提交表单 <id> <JSON>` 后不超过 1000 字符的有效 JSON，URL 模式只显示
  HTTP(S) 链接并接受 `/完成 <id>`；两类交互均可用 `/取消 <id>` 安全取消，答案和表单正文
  不写入日志或持久化存储。
- `surface.ts`：共享一个内存回复上下文组合 Input、Outbox、Typing 与 InteractionPort；启动时只为当前
  允许名单中已有绑定且存在加密回复上下文的私聊恢复收件人并发送上线通知，通知失败不停止长轮询；
  停止时先取消输入，再取消交互并排空输出，重复停止安全。一般主动配置通知仍明确失败关闭。
- `index.ts`：微信模块公开入口。

二维码、验证码和消息正文不持久化；解密图片只进入受限临时目录并按统一保留期清理；
最近回复目标和 `context_token` 只进入独立加密回复上下文
后端，长轮询游标只进入独立检查点，二者都不进入 Bot 凭据、TOML、SQLite 或日志。未知版本、
身份不匹配、密文或载荷损坏失败关闭，不能当作未配置后静默
重新扫码。微信目录通过一级 `src/surfaces/index.ts` 公开运行时组合所需的窄接口，并由 Bootstrap
内置插件装配安全凭据 Client、游标 Store、精确 Access Policy 和生命周期故障上报。
