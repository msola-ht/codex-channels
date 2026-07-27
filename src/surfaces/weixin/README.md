# 微信 Surface

当前实现单账号私聊文本 Surface：独立安全凭据边界、运行时窄协议 Client、私有游标检查点、
私聊文本输入 Adapter、完整命令 Adapter、加密重启上线通知、Turn 生命周期统计、纯文本 Outbox、
失败关闭交互端口和目录内部完整 `SurfaceAdapter`；严格运行配置显式启用时由 Bootstrap 注册，
未新增 SQLite Schema。

- `credential-store.ts`：严格校验版本 1 微信 Bot 凭据；macOS 使用独立 Keychain Service，
  Linux 使用独立 `credentials/weixin` AES-256-GCM 私有目录。
- `credential-client.ts`：首次协议调用时从安全存储读取并缓存当前进程的凭据 Client；缺失或
  损坏凭据失败关闭，不把 Token 提升到 Bootstrap 配置或日志。
- `updates-cursor-store.ts`：在 `data/weixin-updates` 下按账号 SHA-256 文件名保存严格版本 1
  `get_updates_buf`；目录 `0700`、文件 `0600`，临时文件原子替换，损坏、未知版本和符号链接
  失败关闭。
- `protocol-client.ts`：实现固定 `v2.4.6` 的 `getupdates` 和 `sendmessage` HTTP 合同，
  在 JSON 数字转换前保留原始 `message_id`，只输出文本或带原因的忽略事件，并限制出站文本为
  已验证的 4000 个 UTF-16 码元。
- `updates-monitor.ts`：组合协议 Client 与游标 Store，顺序处理单批消息、按原始消息 ID
  进程内去重，仅在整批处理成功后提交游标，并对网络、限流及服务端瞬时失败执行有限重试。
- `input-adapter.ts`：拥有单账号监控器生命周期；按微信账号和私聊 Actor 构造目标，授权后记录
  Actor、更新内存回复上下文并把文本交给目录内会话 Adapter。停止会取消长轮询并有限等待；
  处理失败不推进游标，只向生命周期所有者报告稳定错误码。
- `conversation-adapter.ts`：复用 Application 的 `ConversationCommandService` 和完整共享命令
  目录，并保留微信本地 `/start`、`/help`、`/whoami`；命令解析复用 Surface 公共模板，未知
  斜杠命令明确拒绝，不会提交为普通 Codex 输入。
- `command-renderer.ts`：按微信纯文本边界覆盖全部结构化命令结果与用户错误；多行内容转换为双
  换行段落，避免客户端把单换行折叠为空格。
- `operation-format.ts`：复用共享操作标题、状态、脱敏和摘要；完整模式中和 Markdown 控制字符，
  紧凑模式保持单行并限制详情长度。
- `reply-context-store.ts`：按账号隔离、最多保留 1000 个私聊的进程内
  `actorId + context_token` 副本，支持精确撤销和整体清空。
- `reply-context-persistence.ts`：按精确账号和私聊 Actor 保存严格版本 1 的最近回复上下文；
  macOS 使用独立 Keychain Service，Linux 使用独立
  `credentials/weixin-reply-context` AES-256-GCM 私有目录。载荷、密文或身份不匹配失败关闭。
- `outbox.ts`：只处理匹配账号的 Turn 开始提示、最终文本、操作终态、带耗时/模型/上下文/缓存/
  分支的完成或停止统计、失败通知、连接错误和警告；操作展示复用共享 `full`、`compact`、
  `hidden` 三档配置，不发送 `running` 帧；操作终态和生命周期通知作为关键输出，不因已有最终
  回复而省略；发送时重新检查 Actor
  授权，通过共享 Conversation 队列顺序发送，单条最多 4000 个 UTF-16 码元、最多五条并显示
  截断提示，避免拆开代理对。
- `interactions.ts`：审批立即拒绝、用户输入返回空答案、MCP elicitation 立即取消，不用普通
  微信文本模拟高权限交互。
- `surface.ts`：共享一个内存回复上下文组合 Input、Outbox 与 InteractionPort；启动时只为当前
  允许名单中已有绑定且存在加密回复上下文的私聊恢复收件人并发送上线通知，通知失败不停止长轮询；
  停止时先取消输入，再取消交互并排空输出，重复停止安全。一般主动配置通知仍明确失败关闭。
- `index.ts`：微信模块公开入口。

二维码、验证码和消息正文不持久化；最近回复目标和 `context_token` 只进入独立加密回复上下文
后端，长轮询游标只进入独立检查点，二者都不进入 Bot 凭据、TOML、SQLite 或日志。未知版本、
身份不匹配、密文或载荷损坏失败关闭，不能当作未配置后静默
重新扫码。微信目录通过一级 `src/surfaces/index.ts` 公开运行时组合所需的窄接口，并由 Bootstrap
内置插件装配安全凭据 Client、游标 Store、精确 Access Policy 和生命周期故障上报。
