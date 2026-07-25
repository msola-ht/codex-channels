# 飞书 Surface

本目录是飞书 Surface 的平台边界。当前已完成 Phase 0 的官方 SDK、事件长连接和消息字段裁剪基础，
并进入 Phase 1 的私聊文本 Inbox 与纯文本输出渲染；模块仍未注册为可启用 Surface。

## 文件索引

- `index.ts`：飞书模块受控出口；尚未从一级 `surfaces/index.ts` 导出。
- `client.ts`：官方 SDK、事件长连接及生命周期隔离。
- `message-event.ts`：SDK 消息事件的严格验证和稳定字段裁剪。
- `inbox.ts`：私聊文本筛选、授权、同步有界入队、去重和按 Chat 顺序处理。
- `renderer.ts`：把平台无关 `OutputEvent` 映射为受约束的飞书纯文本。
- `outbox.ts`：精确账号路由并通过通用有界队列调用窄文本发送端口。

## 当前边界

`client.ts` 隔离 `@larksuiteoapi/node-sdk`：

- `start()` 只有在 SDK 触发 `onReady` 后才成功，不能把 `WSClient.start()` 返回当作握手完成。
- 首次连接设置有限超时；失败和超时只暴露稳定、脱敏的本地错误。
- 重连状态留在平台边界；停止操作幂等，并能终止尚未完成的启动。
- SDK 原始日志不进入项目 Logger，避免平台凭据、URL 或响应正文泄漏。
- 当前只注册 `im.message.receive_v1`，回调必须同步完成最小入队，不能在 SDK Reader 中等待业务或平台网络请求。

`message-event.ts` 在平台边界把 SDK 原始事件裁剪为稳定的 `FeishuMessageEvent`，只保留账号、
Actor、消息和 Conversation 路由后续需要的字段。缺少 `open_id`、消息标识或 Chat 标识时失败关闭；
原始事件和无关 SDK 字段不会进入其他模块或错误对象。

`inbox.ts` 只接受当前账号的已授权用户私聊文本。SDK 回调只做同步校验和入队；同一 Chat
按顺序处理，不同 Chat 可以并行。永久无效、未授权、重复或过旧事件被明确忽略；全局输入容量
耗尽时返回 `retry/overloaded`，由后续 Adapter 映射为 SDK 可重试失败。去重状态只存在于有界内存，
关闭时等待已接受任务至有限超时，不持久化消息正文。

`renderer.ts` 通过模块公开入口接收 `OutputEvent`。最终文本和所有关键事件都有纯文本回退；
非关键流式增量和运行中操作暂不输出。上游 warning、连接错误和 MCP 错误正文不会进入平台消息，
未知 Thread 状态不会原样显示。

`outbox.ts` 只同步接收匹配 `feishu + accountId` 的输出，并按 Chat ID 进入
`ConversationDeliveryQueue`。同一 Chat 串行、不同 Chat 可并行；关闭后拒绝新输出并有限等待
已接收发送。飞书 SDK 发送对象被隔离在后续实现的 `FeishuTextMessagePort` 具体实现之后，
Outbox 不持有完整 SDK Client。

本模块尚未接入配置、Bootstrap、Application、飞书 SDK 发送适配或审批，因此不构成可启用的飞书渠道。后续阶段按
[`飞书 Surface 接入计划`](../../../docs/feishu-surface-plan.md)推进；不得把 SDK 类型导出到一级
`surfaces` 入口，也不得在 Core 中引入飞书类型。
