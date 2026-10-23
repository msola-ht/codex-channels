# Conversation Core

本目录归约 App Server 的 Thread、Turn 和 Item 通知，输出平台无关事件，是会话状态与流式内容处理的核心。

## 文件

- `index.ts`：本模块的公开导出入口。
- `core.ts`：维护活动 Turn、Token、当前 Goal、上下文压缩 Item ID、最近 Diff/Plan、推理段状态和事件去重状态，
  把稳定输入事件归约为文本、操作、状态和完成事件；Hook 完成通知仅按 Thread 路由，不改写 Turn 状态；启动请求与显式恢复期间临时跟踪 Turn 开始与终态通知，
  避免绑定时漏掉活动 Turn、迟到响应重新激活已结束轮次或覆盖更新轮次；观察器只保存有限活动状态，不保存完成历史，在请求结束时释放，断线或 Thread 关闭/归档/删除使旧窗口永久失效。合并前复核当前绑定，启动身份只附给同一 Turn；异步问题由 Bootstrap 在同一入站链路协调，
  Bootstrap 同步通过 `observeThreadClosed()` 失效已存在的恢复观察，异步归约该关闭事件时传入 `threadClosureObserved`，避免旧关闭事件再次失效后来建立的观察；其余状态仍按入站顺序归约。
  活动状态查询以当前绑定为准，清除已解绑或转移归属的活动缓存；没有前台绑定时不把后台任务当作当前任务；
  Core 不重复发布问题正文、不标记最终答复；Turn 完成事件原样携带 Client 已校验的官方
  `durationMs` 与 Router 已确认的 Workspace、`modelProvider`；Turn 启动和完成事件携带 Router 从权威响应或设置通知取得的实际审批审查方式，未知时不推断手动审批；普通前台用户 Turn 在官方成功终态前
  未产生非空最终回复时附加稳定诊断标记，手动压缩和后台 Turn 不参与该判断；结构化
  `misalignmentPolicyViolation`、Luna Reserve 触发所需的 `usageLimitExceeded` 与登录或刷新令牌
  失效的 `unauthorized` 只以窄分类传递到完成事件并由共享 Surface 展示层生成固定提示；模型代理提供时，Core 把稳定请求统计输入
  交给 `turn-timing-accumulator.ts`，不读取 SQLite。完成卡片消费官方 Turn 总耗时以及请求结果、
  Token 与压缩摘要，以及组合层从指标库恢复的单次响应用量汇总与缺失计数；上游 `upstreamTtftMs` 仅保留内部原始统计。统计摘要不计算模型请求聚合耗时、
  本地首段回复延迟或 TPS；完成卡展示官方整轮耗时，以及组合层从官方历史恢复的会话累计执行耗时；
  Thread Token 指标对所有 Provider 保持通用，OpenAI 账户周限只附加到 OpenAI Thread；可重试错误
  不污染最终完成状态；当前活动 Turn 的可重试错误发布 `turn.retry` 临时状态，同一连续重试段去重，收到模型文本或推理进展后转为继续处理，最终错误和官方完成状态结束展示；不携带上游错误正文，也不由 Gateway 重发模型请求。新 Turn、解绑、Thread 生命周期和连接断开发布本地 `unavailable` 状态并清理跟踪，不将展示失效解释为官方 Turn 终态；bootstrap 在绑定变化时调用 `pruneUnboundTurns()`，防止等到后续查询才清理旧状态。Thread 与全局 warning 分开路由；MCP 状态通知按 Provider、Thread 与服务去重，
  重试的 `starting` 不清除持续故障指纹，错误内容或原因变化仍通知，官方 `ready` 只在故障后通知恢复；
  MCP OAuth 完成结果须先由 Application 关联到本 Gateway 发起的登录及原绑定，再按 Thread 投递；
  无 Thread 或无法关联的 OAuth 完成不进入渠道。其他全局 MCP 状态与 warning 只广播给相同 Provider 的会话。
- `turn-timing-accumulator.ts`：按单个 Turn 累加模型请求结果、Token 与压缩摘要；不追踪文本增量时间，
  不路由 Thread、不发布事件、不读取数据库或 Provider 配置。各 Token 字段独立记录缺失请求数，压缩为其中项。
  有模型请求观测时只累计其已知用量，不用最近单次官方 Token 快照填补本轮缺口；缓存全请求字段齐全才提供完整累计。
- `input-events.ts`：定义 Client 可投递给 Core 的平台无关可辨识输入联合，不含 RPC method、
  未知 params 或生成协议类型；其中 `turn.modelTiming.updated` 由 Bootstrap 把模型代理的
  终态与 Usage 指标转换为稳定输入，Core 按 Thread/Turn 累计每个已确认请求；上下文压缩还按操作
  类型归约模型与 Token 摘要，供完成卡片单列。
- `events.ts`：定义 Conversation 目标、稳定 Token、Plan、Goal、Turn、额度、账户和 MCP OAuth 类型，以及
  自动审查窄状态通知（保留审查来源及授权路由身份）及公开的 `AutoApprovalReviewDetails` 完成摘要类型；摘要含固定动作类别、文件数量、网络协议和端口，以及经 Client 凭据脱敏、控制字符清理并各按最多 320 字符截断的 operation、cwd、rationale，并带 durationMs；Client 保留 ASCII 标点，execve program 与 argv 逐参数脱敏后再格式化。operation 按 action 类别摘要 command、execve program 与 argv、文件列表、network host、MCP server/tool 或权限申请 reason，不含 stdin 正文或完整 network target URL，不采集风险与用户授权字段。Core 归约及输出保留处理后的有界纯文本，平台富文本转义由 Surface 负责。输出事件的 details 可选，新通知生产路径只发布完成结果，
  输出事件、Turn 产物、操作状态、OpenAI 账户归属判定和关键事件判定；`turn.reasoning`
  输出只携带“思考中…”状态、每段独立耗时与最终标记，不携带摘要或原始思维链内容；同一 Thread
  开始新 Turn 时会结束并释放旧 Turn 遗留的推理段定时器。
- `routing-port.ts`：Core 查询 Thread 的 Conversation、Workspace 和模型设置所需的窄路由接口。
  完成输出只使用 `effectiveServiceTier` 的已确认值；用户选择和设置通知不被当作加速生效证据，
  有效档位未知时省略完成事件的 `serviceTier`。
- `session-display-cache.ts`：定义会话列表展示缓存的派生元数据接口；不包含消息正文、Turn 明细或协议状态事实。
- `user-facing-error.ts`：用稳定错误代码和最小参数描述预期输入与状态错误；Surface 按平台独立渲染，未标记异常默认隐藏详情。

本模块不得依赖 Telegram SDK、具体数据库、launchd 或底层 JSON-RPC Transport。完整历史和 Thread 权威状态始终由 App Server 持有。
`partial_answer` 保留为可展示的部分回答，不计入最终回复判定；仅官方 Turn 终态结束整轮。
子代理开始事件保留官方启动时的模型和思考等级快照，不以稍后读取的 Thread 配置替代。
本模块不解析官方 Notification 或 Item；协议校验、Item 分类、操作摘要和敏感命令清洗均由
`codex-client` 适配边界完成。
Conversation 目标由 `surface + accountId + conversationId` 唯一标识；Core 不解释平台账号或聊天 ID。
当前 Goal、上下文压缩实时增量和最近 Diff/Plan 仅为进程内界面缓存，Thread 关闭、归档、删除
或连接断开时清理，不属于持久化事实来源。压缩总次数通过 Router 持有的 `thread/resume` 派生
Item ID 与实时完成 Item 合并并去重。
Turn 完成只释放同一 Turn 的请求统计，不删除随后轮次的累计；错误按 Thread/Turn 保存。
绑定失效、Thread 生命周期和对应连接断开同时释放错误、用户消息去重和消息阶段缓存。
收到 `thread.reverted` 时 Core 清除该 Thread 的 artifacts/diff/plan、Goal、上下文压缩、用量与计时
等派生展示状态，并释放推理段；活动 Turn 保留到官方 `turn.completed: interrupted` 正常收尾，Core 不伪造
被回退历史的保留内容。
