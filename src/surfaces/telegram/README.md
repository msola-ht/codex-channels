# Telegram Surface

本目录实现 Telegram Bot 适配器，把聊天、命令、图片和按钮交互连接到平台无关的应用与核心模块。

## 文件

- `index.ts`：Telegram Surface 的公开导出入口。
- `constants.ts`：Telegram Surface 的稳定账号标识。
- `bot.ts`：注册 Telegram SDK 处理器，执行访问检查，把标准命令或普通输入提交给 Application，并发送热加载、自动重启、重装要求和失败等配置生命周期通知；Workspace 新增通知带直接切换按钮。
- `command-renderer.ts`：把平台无关的类型化命令结果渲染为 Telegram 消息。
- `outbox.ts`：通过 Surface 共用的每 Conversation 有界顺序队列协调流式回复和审批显示顺序；最终回复默认使用兼容 HTML，也可选择 Telegram 原生 Rich Markdown，超长或渲染失败时回退纯文本。
- `approval-operation-coordinator.ts`：隔离审批请求与操作日志之间的等待、拒绝抑制和 Turn 清理状态。
- 通知策略按逻辑事件降噪：操作过程、状态、上下文和后续分片静默；每轮最终回复、审批、用户输入与严重错误保留一次提醒。
- `html-format.ts`：安全转义并分块渲染命令面板、启动通知、审批卡与 Diff；长审批详情先显示约六行普通引用预览，再以文字分隔可展开的剩余全文，避免 Telegram 合并相邻引用或让长命令默认占满聊天界面。
- `markdown-format.ts`：把常见 Markdown 块与行内样式安全转换为传统 Telegram HTML；仅包含 Bot 命令的文本代码块和行内命令会转为可点击纯文本，普通代码块保持不变。
- `long-message-format.ts`：统一规划终端或 Telegram 发起 Turn 的长回复；普通长文本使用可展开引用块，超长代码与内容使用预览加内存文件。
- `operation-format.ts`：把操作记录分组、截断、脱敏并渲染为 Telegram HTML。
- `typing-indicator.ts`：维护活动请求和 Turn 的 Typing 状态、刷新与限速。
- `interactions.ts`：发送一次性审批或用户输入卡片，处理超时、回调和跨客户端失效。
- `lifecycle.ts`：Bot 命令注册、Long Polling、包含系统与会话摘要的启动联通通知，以及可取消关闭；有界重试耗尽后上报致命故障，由进程管理器恢复 Gateway。
- `api-executor.ts`：统一执行 Telegram API 调用，处理超时、限流和有限重试。
- `error-metadata.ts`：只保留异常类型和受约束的机器错误码，不记录任意异常消息。
- `user-error-renderer.ts`：把平台无关的结构化用户错误映射为 Telegram 专属提示与命令用法。
- `format.ts`：格式化会话、Diff/Plan、模型、Workspace、权限、用量和状态文本；Skill 只展示直接安装的个人项，Plugin 只展示本机已安装项。
- `image-store.ts`：安全下载、校验、暂存和过期清理 Telegram 图片。

Telegram 网络调用不得阻塞 App Server Reader。每个 Conversation 的最终输出保持顺序；审批卡状态更新必须先于批准后的操作展示。文件下载必须限制大小、路径、类型和保留时间。
审批请求晚于操作日志发送时，Outbox 必须撤回已经发送的命令消息，不能只清理内存状态。
账户额度和 MCP 状态通知也必须进入每聊天有界输出队列；不得从 App Server Reader 直接等待 Telegram 网络发送。
结构化用户错误由 `bot.ts` 转换为 Telegram 专属文案；App Server warning、MCP 失败和未知异常的原始详情不写入 Telegram 日志或外部消息。
