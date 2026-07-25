# 飞书 Surface

本目录是飞书 Surface 的平台边界。当前已完成 Phase 0 的官方 SDK、事件长连接和消息字段裁剪基础，
以及 Phase 1 的私聊文本 Inbox、纯文本输出渲染和 Bootstrap 显式组合；当前可通过严格 TOML
手工启用开发验证路径。

## 文件索引

- `index.ts`：飞书模块受控出口；一级 `surfaces/index.ts` 只转出 Bootstrap 所需工厂和选项类型。
- `adapter.ts`：把已授权私聊文本提交到 Application，并通过 Outbox 返回追加提示或安全错误。
- `client.ts`：官方 SDK、事件长连接及生命周期隔离。
- `message-event.ts`：SDK 消息事件的严格验证和稳定字段裁剪。
- `inbox.ts`：私聊文本筛选、授权、同步有界入队、去重和按 Chat 顺序处理。
- `interactions.ts`：在卡片交互尚未实现时拒绝审批、返回空用户输入并取消 MCP elicitation。
- `renderer.ts`：把平台无关 `OutputEvent` 映射为受约束的飞书纯文本。
- `outbox.ts`：精确账号路由并通过通用有界队列调用窄文本发送端口。
- `surface.ts`：组合单账号连接、Inbox、Application Adapter、Outbox 和失败关闭交互端口，并由
  模块入口只暴露 `createFeishuSurface()` 工厂与生产选项类型。

## 当前边界

`client.ts` 隔离 `@larksuiteoapi/node-sdk`：

- `start()` 只有在 SDK 触发 `onReady` 后才成功，不能把 `WSClient.start()` 返回当作握手完成。
- 首次连接设置有限超时；失败和超时只暴露稳定、脱敏的本地错误。
- 重连状态留在平台边界；停止操作幂等，并能终止尚未完成的启动。
- SDK 原始日志不进入项目 Logger，避免平台凭据、URL 或响应正文泄漏。
- 当前只注册 `im.message.receive_v1`，回调必须同步完成最小入队，不能在 SDK Reader 中等待业务或平台网络请求。
- 文本发送只使用 `im.v1.message.create` 的 `chat_id + text` 窄能力，设置 15 秒 HTTP 超时，
  并要求响应包含 `message_id`。
- 发送超时、SDK 失败和残缺响应只暴露稳定错误码，不回传 SDK message、响应正文或凭据。
- 消息创建不自动重试；锁定 SDK 虽提供可选 `uuid` 字段，但当前官方资料未明确其幂等窗口和
  可重试错误语义。

`message-event.ts` 在平台边界把 SDK 原始事件裁剪为稳定的 `FeishuMessageEvent`，只保留账号、
Actor、消息和 Conversation 路由后续需要的字段。缺少 `open_id`、消息标识或 Chat 标识时失败关闭；
原始事件和无关 SDK 字段不会进入其他模块或错误对象。

`inbox.ts` 只接受当前账号的已授权用户私聊文本。SDK 回调只做同步校验和入队；同一 Chat
按顺序处理，不同 Chat 可以并行。永久无效、未授权、重复或过旧事件被明确忽略；全局输入容量
耗尽时返回 `retry/overloaded`。由于当前没有经过真实合同验证的 SDK 重试响应通道，Surface
通过同一有界 Outbox 提示用户稍后重试，不伪造平台自动重投。去重状态只存在于有界内存，关闭时
等待已接受任务至有限超时，不持久化消息正文。

`renderer.ts` 通过模块公开入口接收 `OutputEvent`。最终文本和所有关键事件都有纯文本回退；
非关键流式增量和运行中操作暂不输出。上游 warning、连接错误和 MCP 错误正文不会进入平台消息，
未知 Thread 状态不会原样显示。

`outbox.ts` 只同步接收匹配 `feishu + accountId` 的输出，并按 Chat ID 进入
`ConversationDeliveryQueue`。同一 Chat 串行、不同 Chat 可并行；关闭后拒绝新输出并有限等待
已接收发送。飞书 SDK 发送对象由 `FeishuTextMessageClient` 通过 `FeishuTextMessagePort`
注入，Outbox 不持有完整 SDK Client。Adapter 的追加确认和错误提示也进入同一有界队列，不绕过
平台输出顺序和关闭边界。

`adapter.ts` 只依赖 Application 的 `ConversationService.submit()` 窄能力。新 Turn 不额外发送
确认，后续回复由 Core 输出驱动；追加到活动 Turn 时发送明确提示。结构化 `UserFacingError`
按错误码渲染，不使用其内部 fallback message；未知异常只发送通用提示，然后把原异常交回 Inbox，
由 Inbox 现有诊断路径仅记录受约束的错误类型。

`interactions.ts` 当前只提供失败关闭语义，不创建待处理状态：命令、文件和权限审批一律拒绝，
用户输入返回空答案，MCP elicitation 返回取消；`resolved()` 和 `cancelAll()` 保持无状态幂等。
这不会伪装成飞书已经支持审批，卡片交互仍属于后续独立阶段。

`surface.ts` 实现单账号 `SurfaceAdapter` 生命周期：启动等待长连接就绪；停止先切断新事件，再
有限排空 Inbox 和 Outbox。Bootstrap 从现有绑定中选择仍有授权 Actor 的 Chat 作为配置通知
收件人；持久通知等待平台实际发送完成，没有已知安全会话时不广播。

本模块已有严格 TOML/运行配置、变更分类和 Bootstrap 显式组合，可启用阶段 1 私聊文本路径；
Setup、Doctor 的飞书专属诊断、真实应用冒烟和可批准交互仍未完成。后续阶段按
[`飞书 Surface 接入计划`](../../../docs/feishu-surface-plan.md)推进；一级 `surfaces` 入口只转出
窄工厂，不得导出 SDK 类型，也不得在 Core 中引入飞书类型。
