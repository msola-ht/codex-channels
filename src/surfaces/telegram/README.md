# Telegram Surface

本目录实现 Telegram Bot 适配器，把聊天、命令、图片和按钮交互连接到平台无关的应用与核心模块。

## 文件

- `index.ts`：Telegram Surface 的公开导出入口。
- `bot.ts`：注册命令和消息处理器，执行访问检查，并把输入提交给 Conversation Service。
- `outbox.ts`：协调每聊天有界输出队列、流式回复和审批显示顺序。
- `operation-format.ts`：把操作记录分组、截断、脱敏并渲染为 Telegram HTML。
- `typing-indicator.ts`：维护活动请求和 Turn 的 Typing 状态、刷新与限速。
- `interactions.ts`：发送一次性审批或用户输入卡片，处理超时、回调和跨客户端失效。
- `lifecycle.ts`：Bot 命令注册、Long Polling、启动联通通知和可取消关闭。
- `api-executor.ts`：统一执行 Telegram API 调用，处理超时、限流和有限重试。
- `format.ts`：格式化会话、Diff/Plan、模型、Workspace、权限、用量和状态文本。
- `image-store.ts`：安全下载、校验、暂存和过期清理 Telegram 图片。

Telegram 网络调用不得阻塞 App Server Reader。每个 Conversation 的最终输出保持顺序；审批卡状态更新必须先于批准后的操作展示。文件下载必须限制大小、路径、类型和保留时间。
账户额度和 MCP 状态通知也必须进入每聊天有界输出队列；不得从 App Server Reader 直接等待 Telegram 网络发送。
