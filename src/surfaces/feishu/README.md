# 飞书 Surface

本目录是飞书 Surface 的平台边界。当前只完成 Phase 0 基础：锁定官方 Node SDK，并封装事件长连接的启动、重连、停止和错误语义。

## 文件索引

- `index.ts`：飞书模块受控出口；尚未从一级 `surfaces/index.ts` 导出。
- `client.ts`：官方 SDK、事件长连接及生命周期隔离。
- `message-event.ts`：SDK 消息事件的严格验证和稳定字段裁剪。

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

本模块尚未接入配置、Bootstrap、Application、出站消息或审批，因此不构成可启用的飞书渠道。后续阶段按
[`飞书 Surface 接入计划`](../../../docs/feishu-surface-plan.md)推进；不得把 SDK 类型导出到一级
`surfaces` 入口，也不得在 Core 中引入飞书类型。
