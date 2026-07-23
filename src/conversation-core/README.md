# Conversation Core

本目录归约 App Server 的 Thread、Turn 和 Item 通知，输出平台无关事件，是会话状态与流式内容处理的核心。

## 文件

- `index.ts`：本模块的公开导出入口。
- `core.ts`：维护活动 Turn、Token、最近 Diff/Plan 和通知去重状态，把协议通知归约为文本、操作、状态和完成事件。
- `events.ts`：定义 Conversation 目标、输出事件、Turn 产物、操作状态和关键事件判定。
- `operation.ts`：把 App Server Item 转换为安全、简洁的操作过程，并清洗敏感命令文本。
- `routing-port.ts`：Core 查询 Thread 路由所需的窄接口。

本模块不得依赖 Telegram SDK、具体数据库、launchd 或底层 JSON-RPC Transport。完整历史和 Thread 权威状态始终由 App Server 持有。
Conversation 目标由 `surface + accountId + conversationId` 唯一标识；Core 不解释平台账号或聊天 ID。
最近 Diff/Plan 仅为进程内界面缓存，Thread 关闭、归档或删除时清理，不属于持久化事实来源。
