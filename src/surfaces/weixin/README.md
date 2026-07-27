# 微信 Surface

当前实现阶段 0/Setup 的独立安全凭据边界，以及运行时接入前的窄协议 Client、私有游标
检查点、私聊文本输入 Adapter、纯文本 Outbox、失败关闭交互端口和目录内部完整
`SurfaceAdapter`；尚未注册微信消息 Surface，未修改 SQLite。

- `credential-store.ts`：严格校验版本 1 微信 Bot 凭据；macOS 使用独立 Keychain Service，
  Linux 使用独立 `credentials/weixin` AES-256-GCM 私有目录。
- `updates-cursor-store.ts`：在 `data/weixin-updates` 下按账号 SHA-256 文件名保存严格版本 1
  `get_updates_buf`；目录 `0700`、文件 `0600`，临时文件原子替换，损坏、未知版本和符号链接
  失败关闭。
- `protocol-client.ts`：实现固定 `v2.4.6` 的 `getupdates` 和 `sendmessage` HTTP 合同，
  在 JSON 数字转换前保留原始 `message_id`，只输出文本或带原因的忽略事件，并限制出站文本为
  已验证的 4000 个 UTF-16 码元。
- `updates-monitor.ts`：组合协议 Client 与游标 Store，顺序处理单批消息、按原始消息 ID
  进程内去重，仅在整批处理成功后提交游标，并对网络、限流及服务端瞬时失败执行有限重试。
- `input-adapter.ts`：拥有单账号监控器生命周期；按微信账号和私聊 Actor 构造目标，授权后记录
  Actor、更新内存回复上下文并把普通文本提交给 Application。停止会取消长轮询并有限等待；
  处理失败不推进游标，只向生命周期所有者报告稳定错误码。
- `reply-context-store.ts`：按账号隔离、最多保留 1000 个私聊的最新 `actorId + context_token`；
  只存在进程内存，返回副本，支持精确撤销和整体清空。
- `outbox.ts`：只处理匹配账号的最终文本、必要结束状态、连接错误和警告；发送时重新检查 Actor
  授权，通过共享 Conversation 队列顺序发送，单条最多 4000 个 UTF-16 码元、最多五条并显示
  截断提示，避免拆开代理对。
- `interactions.ts`：审批立即拒绝、用户输入返回空答案、MCP elicitation 立即取消，不用普通
  微信文本模拟高权限交互。
- `surface.ts`：共享一个内存回复上下文组合 Input、Outbox 与 InteractionPort；停止时先取消输入，
  再取消交互并排空输出，重复停止安全。主动配置通知因没有可持久化的安全收件人而明确失败关闭。
- `index.ts`：微信模块公开入口。

二维码、验证码、扫码者 ID、消息和回复上下文均不持久化；长轮询游标只进入独立检查点，不进入
凭据、TOML 或 SQLite。未知版本、身份不匹配、密文或载荷损坏失败关闭，不能当作未配置后静默
重新扫码。微信目录已经提供完整 `SurfaceAdapter`，但尚未从一级 `src/surfaces/index.ts`
公开，也未加入 Bootstrap 内置插件注册表；配置、凭据装配和启用流程完成前不能启动。
