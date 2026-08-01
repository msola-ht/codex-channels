# Conversation Core

本目录归约 App Server 的 Thread、Turn 和 Item 通知，输出平台无关事件，是会话状态与流式内容处理的核心。

## 文件

- `index.ts`：本模块的公开导出入口。
- `core.ts`：维护活动 Turn、Token、当前 Goal、上下文压缩 Item ID、最近 Diff/Plan 和事件去重状态，
  把稳定输入事件归约为文本、操作、状态和完成事件；Turn 完成事件原样携带 Client 已校验的官方
  `durationMs` 与 Router 已确认的 `modelProvider`；输出速度由 Client 在通知边界打接收时间戳、
  Core 按 Thread 归约最后一次模型响应的非推理 Token 与最终回答流式时长（不新建协议计时器，
  也不消费新协议字段）；模型代理提供时优先使用最后一次请求的首 Token、推理和输出时间窗，
  推理输出 Token 始终采用官方用量，思考速度与生成速度只在 Provider 实际提供推理流时间戳时归约；
  Thread Token 指标对所有 Provider 保持通用，OpenAI 账户周限只附加到 OpenAI Thread；可重试错误
  不污染最终完成状态，Thread 与全局 warning 分开路由。
- `input-events.ts`：定义 Client 可投递给 Core 的平台无关可辨识输入联合，不含 RPC method、
  未知 params 或生成协议类型；其中 `turn.modelTiming.updated` 由 Bootstrap 把模型代理的
  模型流指标转换为稳定输入，Core 按 Thread/Turn 保留请求时间最新的一次指标并计算首字延时、
  输出、思考与生成速度，避免重试累计重复计时。
- `events.ts`：定义 Conversation 目标、稳定 Token、Plan、Goal、Turn、额度、账户和 MCP 类型，以及
  输出事件、Turn 产物、操作状态、OpenAI 账户归属判定和关键事件判定。
- `routing-port.ts`：Core 查询 Thread 路由所需的窄接口。
- `user-facing-error.ts`：用稳定错误代码和最小参数描述预期输入与状态错误；Surface 按平台独立渲染，未标记异常默认隐藏详情。

本模块不得依赖 Telegram SDK、具体数据库、launchd 或底层 JSON-RPC Transport。完整历史和 Thread 权威状态始终由 App Server 持有。
本模块不解析官方 Notification 或 Item；协议校验、Item 分类、操作摘要和敏感命令清洗均由
`codex-client` 适配边界完成。
Conversation 目标由 `surface + accountId + conversationId` 唯一标识；Core 不解释平台账号或聊天 ID。
当前 Goal、上下文压缩实时增量和最近 Diff/Plan 仅为进程内界面缓存，Thread 关闭、归档、删除
或连接断开时清理，不属于持久化事实来源。压缩总次数通过 Router 持有的 `thread/resume` 派生
Item ID 与实时完成 Item 合并并去重。
