# Surface Adapters

本目录保存外部交互平台适配器。Surface 负责把平台输入转换为 Application 命令，并把 Core 输出和审批交互渲染为平台消息。

`index.ts` 是所有 Surface 的公开导出入口。

当前实现：

- [`telegram/`](telegram/README.md)：Telegram Bot 输入、输出、交互、图片和生命周期。

`types.ts` 定义最小 `SurfaceAdapter` 生命周期契约。每个实例使用
`surface + accountId` 标识，分别提供启停、可选配置变更通知与 `InteractionPort`；Bootstrap 只做编译期显式注册。
`stop()` 必须可在部分启动后安全调用，并保持幂等。
配置变更通知使用结构化动作区分热加载、自动重启、需要重装和加载失败；Surface 只渲染结果，
不得接收原始配置值或异常详情。普通生命周期通知可通过可选的 `configurationChanged` 异步入队；
`deliverConfigurationChange` 必须等待平台 API 实际发送成功，失败时抛出错误，以便 Bootstrap 保留
尚未确认的持久化配置事件。

新增 Surface 时应实现统一输入、输出和审批边界，通过 Application/Core 接入；输出消费者必须校验
目标 Surface 与账号，避免跨平台串台。Surface 不得直接操作底层 JSON-RPC Transport，也不得把平台
SDK 类型引入 Conversation Core。

会话命令统一映射到 Application 的 `ConversationCommandService`；Surface 负责提取命令名和参数，
并渲染类型化结果。普通文本、图片下载、平台帮助、身份查询和交互取消保留在平台边界。所有输入在
调用 Application 前必须构造 `SurfaceAccessContext` 并通过对应访问策略。

Surface 只能渲染明确标记的结构化用户错误，不能直接复用其内部回退文案；未知异常和 App Server
warning、MCP 失败等原始详情默认隐藏，避免把凭据、上游响应或本机信息带入聊天消息或日志。
