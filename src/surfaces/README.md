# Surface Adapters

本目录保存外部交互平台适配器。Surface 负责把平台输入转换为 Application 命令，并把 Core 输出和审批交互渲染为平台消息。

`index.ts` 是所有 Surface 的公开导出入口。

当前实现：

- [`telegram/`](telegram/README.md)：Telegram Bot 输入、输出、交互、图片和生命周期。

`types.ts` 定义最小 `SurfaceAdapter` 契约。每个实例使用
`surface + accountId` 标识，分别提供启停、输出、可选配置变更通知与 `InteractionPort`；Bootstrap 只做编译期显式注册。
`SurfaceOutputPort` 接收平台无关的 `OutputEvent`，只负责同步入队，不得等待平台网络请求。
Bootstrap 按 `surface + accountId` 精确选择一个输出端口，Surface 不再各自订阅全局事件总线。
`stop()` 必须可在部分启动后安全调用，并保持幂等。
配置变更通知使用结构化动作区分热加载、自动重启、需要重装和加载失败；Surface 只渲染结果，
不得接收原始配置值或异常详情。普通生命周期通知可通过可选的 `configurationChanged` 异步入队；
`deliverConfigurationChange` 必须等待平台 API 实际发送成功，失败时抛出错误，以便 Bootstrap 保留
尚未确认的持久化配置事件。
全局变更投递给所有 Surface；平台作用域变更只投递给匹配 Surface。进程重启和重装会影响所有
Surface，因此未匹配到具体变更的 Surface 仍会收到不包含平台私有原因的生命周期通知。

`ConversationDeliveryQueue` 提供可复用的每 Conversation 有界顺序队列：同一 Conversation 串行，
不同 Conversation 可并行；关键输出可以替换仍在等待的非关键输出。新增 Surface 时应实现统一输入、
输出和审批边界，通过 Application/Core 接入，并把平台发送操作放入该队列或提供等价约束。
Surface 不得直接操作底层 JSON-RPC Transport，也不得把平台 SDK 类型引入 Conversation Core。

会话命令统一映射到 Application 的 `ConversationCommandService`；Surface 负责提取命令名和参数，
并渲染类型化结果。普通文本、图片下载、平台帮助、身份查询和交互取消保留在平台边界。所有输入在
调用 Application 前必须构造 `SurfaceAccessContext` 并通过对应访问策略。

Surface 只能渲染明确标记的结构化用户错误，不能直接复用其内部回退文案；未知异常和 App Server
warning、MCP 失败等原始详情默认隐藏，避免把凭据、上游响应或本机信息带入聊天消息或日志。
