# Conversation Core

本目录归约 App Server 的 Thread、Turn 和 Item 通知，输出平台无关事件，是会话状态与流式内容处理的核心。

## 文件

- `index.ts`：本模块的公开导出入口。
- `core.ts`：维护活动 Turn、Token、当前 Goal、上下文压缩 Item ID、最近 Diff/Plan、推理段状态和事件去重状态，
  把稳定输入事件归约为文本、操作、状态和完成事件；Turn 完成事件原样携带 Client 已校验的官方
  `durationMs` 与 Router 已确认的 `modelProvider`；结构化 `misalignmentPolicyViolation` 只以窄分类
  传递到完成事件并由共享 Surface 展示层生成固定提示；模型代理提供时，Core 按 Thread/Turn 聚合全部
  已关联请求的次数、实际产生推理输出的思考次数、累计耗时、Usage 与流式时间窗，不读取 SQLite；
  三类综合速度只聚合同时具有对应
  Token 和流式时间窗的请求，并携带已计时请求数与可计速请求数，避免缺失时间窗时虚高。OpenAI 不展示
  隐藏推理计时，DeepSeek 才提供最后请求首事件延迟（渠道在调试模式开启时展示）以及整轮综合思考与生成速度；所有 Provider 使用
  App Server 增量展示首段回复延迟。代理缺席时仍由 Client
  通知边界时间戳和 App Server 最近 Usage 提供有限回退；
  Thread Token 指标对所有 Provider 保持通用，OpenAI 账户周限只附加到 OpenAI Thread；可重试错误
  不污染最终完成状态，Thread 与全局 warning 分开路由；MCP OAuth 完成结果按 Thread 精确投递，
  无 Thread 的结果只广播给相同 Provider 的会话。
- `input-events.ts`：定义 Client 可投递给 Core 的平台无关可辨识输入联合，不含 RPC method、
  未知 params 或生成协议类型；其中 `turn.modelTiming.updated` 由 Bootstrap 把模型代理的
  模型流与 Usage 指标转换为稳定输入，Core 按 Thread/Turn 累计每个已确认请求，并单独保留请求时间
  最新一次的首事件延迟；上下文压缩还按操作类型归约模型、Token 与参考费用摘要，供完成卡片单列；
  根据 Provider 能力计算通用或详细聚合计时。
- `events.ts`：定义 Conversation 目标、稳定 Token、Plan、Goal、Turn、额度、账户和 MCP OAuth 类型，以及
  输出事件、Turn 产物、操作状态、OpenAI 账户归属判定和关键事件判定；`turn.reasoning`
  输出只携带“思考中…”状态、每段独立耗时与最终标记，不携带摘要或原始思维链内容；同一 Thread
  开始新 Turn 时会结束并释放旧 Turn 遗留的推理段定时器。
- `routing-port.ts`：Core 查询 Thread 路由所需的窄接口。
- `user-facing-error.ts`：用稳定错误代码和最小参数描述预期输入与状态错误；Surface 按平台独立渲染，未标记异常默认隐藏详情。

本模块不得依赖 Telegram SDK、具体数据库、launchd 或底层 JSON-RPC Transport。完整历史和 Thread 权威状态始终由 App Server 持有。
本模块不解析官方 Notification 或 Item；协议校验、Item 分类、操作摘要和敏感命令清洗均由
`codex-client` 适配边界完成。
Conversation 目标由 `surface + accountId + conversationId` 唯一标识；Core 不解释平台账号或聊天 ID。
当前 Goal、上下文压缩实时增量和最近 Diff/Plan 仅为进程内界面缓存，Thread 关闭、归档、删除
或连接断开时清理，不属于持久化事实来源。压缩总次数通过 Router 持有的 `thread/resume` 派生
Item ID 与实时完成 Item 合并并去重。
收到 `thread.reverted` 时 Core 清除该 Thread 的 artifacts/diff/plan、Goal、上下文压缩、用量与计时
等派生展示状态，并释放推理段；活动 Turn 保留到官方 `turn.completed: interrupted` 正常收尾，Core 不伪造
被回退历史的保留内容。
