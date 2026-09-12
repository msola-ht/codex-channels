# Bootstrap

本目录是模块化单体的组合根，负责创建具体依赖并管理 Gateway 进程生命周期。

## 文件

- `index.ts`：向进程入口公开 `GatewayApplication`、计划任务执行/恢复端口、进程生命周期入口和安全的 Gateway 所有权错误。
- `scheduled-task-executor.ts`：在每次计划任务运行前重新校验 Actor、Conversation、Workspace、Provider、模型和无人值守权限，强制创建 `automation` 后台 Thread 并启动单个 Turn；写请求结果未知时失败关闭。
- `scheduled-task-run-coordinator.ts`：按持久化 Thread/Turn ID 关联 Run，接收既有 Core 输出完成事件，并在重启后读取权威分页 Turn 历史恢复或收敛运行状态。
- `scheduled-task-server-request.ts`：为已关联的计划任务 Thread 返回五类 Server Request 的官方安全拒绝形状，其他方法明确失败；非计划任务请求交给既有审批处理器。只在 `scheduled_tasks.enabled=true` 时由组合根安装。
- `scheduled-task-tool-request.ts`：校验前台 `item/tool/call` 的 Thread 绑定、唯一授权 Actor 和
  `schedule_task` 工具名，把结果复用现有计划任务渲染格式返回给 Agent，并把确认预览交给当前
  `surface + accountId` 的原生交互入口；后台计划任务 Thread 的
  同类请求先由 `scheduled-task-server-request.ts` 拒绝。
- `app.ts`：校验 Codex 版本，装配 Transport、Client、Core、Router 和 Storage；把同一 Client 的
  原生 Thread Queue 与分页历史/Revert 端口注入 Application，并把 Queue changed、Thread reverted 通知
  仅用于失效短期选择快照和校正 Core 派生状态；处理启动、重连、
  订阅恢复与关闭，并通过 Client 适配器把稳定事件分别转交 Core 与 `session-routing`、把
  Server Request 转交 Approval；未知或畸形 Notification 只记录 method 后忽略，未知或畸形
  高权限请求明确拒绝；受支持版本通过 Client 运行时信息读取，并把显示版本注入 Surface；
  对当前授权 Workspace 执行有时限的只读 Git 分支查询并注入 Application 状态；按 Setup 管理
  标记装配主 Client 与可选 Provider Client，并通过 Provider 路由复用其余业务模块；按已启用
  Provider 装配模型指标组件，不持有模型转发数据通路；通过 `request-metrics-query-adapter.ts`
  把同一指标库的精确 Thread 查询映射为 Application `/metrics` 窄端口，并为 OpenAI `/limits`
  提供当前周窗口的精确 Provider 聚合；
  计划任务的内部组件、恢复顺序和
  Store 生命周期委托给 `scheduled-task-composition.ts`。
- `scheduled-task-composition.ts`：在功能启用时集中创建计划任务 Store、Executor、Run Coordinator、Scheduler、
  Application Service 与动态工具 Handler，并拥有恢复、启动、停止和关闭顺序；Gateway 组合根只保留
  Surface 创建上下文、无人值守权限边界和 App Server 请求接线。
- `request-metrics-query-adapter.ts`：把 Observability 指标查询、时间范围和 Provider 显示名映射为
  Application 的 `/metrics` 窄端口；不改变 Store 查询模型，也不让 Application 依赖 SQLite 实现。
- `managed-provider-capabilities.ts`：按 `runtime/model-provider-definitions.mjs` 的编译期能力元数据
  有界装配 DeepSeek、OpenCode Go 的账户适配器；适配器以精确 Provider ID 登记，`none` 明确不提供
  账户能力；未知能力或适配器冲突启动时失败关闭，不回退到 OpenAI 账户查询。
- `provider-metrics-composition.ts`：组合 Provider 私有指标 Socket、Observability 独立存储和 Core
  模型请求统计端口。所有脱敏请求样本都会持久化；具备 Thread 与 Turn 关联的样本按 Turn 聚合
  到完成卡片；持久化通过 Observability 有界 Writer 延迟分片执行，单项写入失败不会阻断指标确认或
  Core 统计。优先使用代理指标携带的 WebSocket `reasoning.effort` 或私有第三方角色路径标注，
  普通 Thread 仅在缺失时
  由可选 `resolveModelSettings` 按 Thread 关联回填路由层维护的思考等级；代理、Core 和数据库
  View 都不读取请求正文、设置文件或价格目录。
- `bounded-fetch-body.ts`：统一组合根远端适配器的 Content-Length 校验、流式累计、超限取消与
  Reader 清理；调用方注入领域错误，并决定是否允许缺少正文，不向 Surface 暴露该基础设施。
- `completion-timing.ts`：在 Turn 完成时用指标库重建本轮请求数、Token 与压缩统计；
  若当前 Turn 已部分延迟写入，按持久化汇总校正请求状态与
  可选用量字段。
- `subagent-completion-tracker.ts`：登记 Core 发布的子代理线程，以 App Server 发给发起父 Turn 的
  `subAgentActivity.completed` 作为成功终态，并以父 Thread、父 Turn、子 Thread 和代理路径精确
  匹配；子线程 `turn/completed` 不再重复宣布成功，失败/中断仍接受子线程终态、官方中断活动与
  `collabAgentToolCall.agentsStates` 异常状态。极快子线程在登记前完成时只在有界短期缓存中保留
  带父运行归属的完成活动。Tracker 在 App Server 输入阶段同步记录未结算父运行，避免异步 Surface
  输出尚未登记时提前释放后台父 Thread；最后一个子代理终态后由组合根重试挂起的订阅清理。
  `interacted` 到达时若该子线程仍有活动轮次则不重复登记；上一轮已经终止时开启新一轮完成跟踪，
  上一轮仍在指标结算窗口内则分离结算；子线程 `turn/started` 会把本轮精确 Turn 与父 Turn 记入
  Observability，官方成功活动按同一子 Turn 读取本轮统计，避免通知乱序或快速继续时覆盖终态，
  也不会把多轮 Thread 累计误报为单轮用量。
  已观察到模型指标且终态后出现父线程官方 `wait` Item 时，立即等待 Observability Writer 当前
  水位落库并发布，保持该等待操作先于完成卡片；终态到达时尚无指标或之后未出现父线程等待时
  保留有界收敛窗口，后续新指标使旧结算失效；指标到达或静默本身不推断子代理结束。无指标
  发布零统计终态，指标写入或读取失败发布“统计不可用”终态；完成事件复用汇总中的最后一次
  思考等级、请求结果和 Token，不在 Tracker 内重复计算。
- `workspace-permission-writer.ts`：把渠道 `/workspaceperm` 的工作区权限更新写回
  `config.toml` 并校验 `permissions` 与 `sandbox` 互斥；文件变化由配置监听热加载。
- `surface-plugin.ts`：定义编译期内置 Surface 插件、插件上下文和运行时模块契约，并校验插件 ID、
  实际 Surface ID 与账号实例唯一性。
- `surface-composition.ts`：显式注册 Telegram、飞书和微信内置插件，并保留各平台访问策略、
  热加载钩子、故障上报装配和全局生命周期通知的安全收件人。三个插件都只在严格运行配置启用时创建实例；Telegram 由非空 Token
  决定是否启用，飞书和微信使用显式开关；飞书和微信启动通知从仍有授权 Actor 的已知 Conversation
  解析收件人，不要求当时已有 Thread 绑定。三个渠道按目标复用共享代理选择；微信协议 Client 在首次调用时从独立安全存储
  读取凭据，不把 Token 放入运行配置。
- `proxy-fetch.ts`：把共享 HTTP(S) 代理选择适配到微信使用的 Fetch 接口；命中 `NO_PROXY`
  时使用直连 Fetch，否则通过按代理 URL 复用的 Undici Dispatcher 发出请求。
- `openai-connectivity.ts`：在 OpenAI Provider 启动时复用同一代理做一次有界、无凭据的 HTTP
  传输探测；官方双目标全部不可达时生成脱敏状态供渠道上线通知使用，单目标失败只记录日志，
  均不阻断 Gateway；自定义 `openai_base_url` 只探测该地址。
- `deepseek-account-adapter.ts`：通过共享 Provider 运行时按请求读取切换 Profile 或固定基础配置中的
  DeepSeek Key，
  通过共享代理调用官方余额接口，并在共享有界响应读取和严格 Schema 校验后只返回稳定余额；Key、响应正文
  和解析异常不进入日志或业务事件。官方账户只有余额接口，没有用量窗口，不展示本地用量估算。
- `opencode-go-account-adapter.ts`：通过同一共享 Provider 运行时按请求读取 OpenCode Go Key，调用官方
  `/zen/go/v1/usage` 接口，把 5 小时/7 天/月度三个窗口归约为通用 `quota-windows` 形态（已用百分比与
  重置时间）；参数化工厂按 `modelProvider` 区分 `ocg-<账户>`，指标库按账户过滤，并汇总本机
  指标库的模型本地 Token 用量；三个额度窗口共用一次精确 Provider 流式读取，不执行通用文本筛选、
  重复计数或偏移分页；Key、响应正文
  和解析异常同样不进入日志或业务事件。
- `provider-idle-releaser.ts`：统一跟踪所有 Provider Client 的活动操作；当 Gateway 没有前台或后台
  Conversation 绑定、没有正在进行的 Provider 操作或启动任务时，先等待 60 秒宽限期；宽限期内
  新绑定、新操作或启动任务会取消本轮释放。宽限期结束仍空闲时，只有渠道会话空闲自动解除触发的
  全局释放轮次会先通过注入回调通知所有已知授权渠道，再关闭全部已连接 Client；其他原因导致的
  无绑定关闭不发送该通知。该组件在关闭 Client 后通过监管入口停止对应 App Server 进程（含主实例），
  不按 Provider 类型区分；每 60 秒复检一次，并停止监管入口中全部未被租约占用的运行实例，因此也
  覆盖仅由 `codexc remote` 启动、Gateway 从未连接的实例。租约占用或未运行的实例保持现状，后续
  请求通过 Provider 路由按需启动并重连。Client 关闭和启动期间使用有界并发保护，关闭失败只记录
  日志并在后续全局空闲检查重试；启动完成、会话解绑、后台任务终态和 Provider 操作结束都会触发
  检查；Gateway 关闭时停止新的检查，并在有界时间内等待已开始的关闭完成。
- `conversation-idle-releaser.ts`：按 `conversation.idle_release_minutes` 定期扫描前台 Thread
  绑定；输入或输出刷新最近活动时间，超过阈值且 App Server 确认为空闲后由
  `ConversationService.releaseIdle` 取消订阅并解绑，成功后通过共享结构化事件只通知一次
  “自动解除占用”，并携带当前 Thread ID 供 `/r` 直接恢复。
  正在恢复或 Provider 断线的绑定会跳过本轮，强制新建标记也会跳过扫描；关闭时停止定时器并限时等待已经在途的
  扫描退出，避免释放 RPC 卡住 Gateway 关闭。
- `turn-error-metrics.ts`：把同步 RPC 与异步 `turn.error` 通知的 Turn 级失败统一转换为脱敏的
  模型请求失败样本，保存错误原文与分类；结构化 `misalignmentPolicyViolation` 使用独立分类并
  保留协议代码，不携带任何平台上下文或敏感凭据。
- `config-lifecycle.ts`：在任何 Surface 或指标组件启动前获取配置级 Gateway 所有权，随后管理配置
  监听、防抖重载、持久配置事件投递、信号、所有权释放与进程退出；只有应用启动完成后才把所有权
  协议标记为就绪，供服务管理入口区分进程占位和可用 Gateway；账户刷新私有 IPC 与应用一同启停。
- `provider-settings-watcher.ts`：监听受管第三方 Provider 的模型目录、Profile 与管理标记变化，
  校验通过后防抖等待该 Provider 无活动 Turn，再自动触发 App Server 重启；校验失败保留旧基线并
  等待修复，重启失败按冷却时间重试；等待、重启中、生效和失败状态通过共享配置变更通知投递给
  所有渠道，停止 Gateway 时一并关闭。
- `service-restart-runner.ts`：统一执行 App Server 服务重启的异步子进程封装，Gateway 自动重启
  与未来 CLI 单 Provider 重启复用同一入口，输出脱敏后写入日志。
- `surface-manager.ts`：按 `surface + accountId` 向已启动 Surface 集中路由 Core 输出，并为
  `turn.completed` 等待当前 Thread 的指标写入水位，再注入可恢复的本轮统计、当前授权 Workspace
  的 Git 分支、递归包含子代理后代的 Session 累计统计及显式父 Turn 任务合计；并行完成各 Surface 的首次启动，
  单个渠道启动或运行失败时只取消该渠道交互并独立退避恢复，不停止 Gateway 或其他渠道。
  首次启动和故障恢复期间只在有界内存队列中保留关键输出，就绪后按序补投；流式增量不积压。
  渠道未就绪时对应账号的新审批、用户输入与 MCP 交互立即失败关闭。
- `channel-image-spool.ts`：扫描 `data/channel-outbox/pending/` 的图片发送请求，按
  Thread 绑定解析目标会话，调用 `SurfaceManager.sendChannelImage` 由各渠道机器人凭据
  发送，成功归档到 `done/`、失败归档到 `failed/` 并保留原因；Unix 使用 `0700/0600`，Windows
  使用当前 SID 私有 ACL，并在启动时收紧既有受管文件；只接受
  pending 目录内的绝对图片路径。

业务状态和平台逻辑应留在对应模块，只有具体实现选择、交互端口注册与生命周期协调放在这里。
Provider 账户能力同样通过编译期显式注册：OpenAI 复用 Codex Client，第三方实现 Application
拥有的窄适配器；新增 Provider 不得动态加载，也不得把未知 Provider 回退到 OpenAI 账户查询。
新增内置 Surface 时实现一个 `BuiltInSurfacePlugin` 并加入显式注册表，不应向
`GatewayApplication` 添加平台专属字段。当前插件层只用于模块化单体内部装配，不扫描目录、
不动态导入包，也不是外部插件 API。
未启用 Surface 的持久绑定应保留但不恢复订阅。Gateway 关闭不得主动终止独立运行的 Codex App Server。
启动、停止和 App Server 重连由同一生命周期协调；单 Provider 断线只重连并恢复该侧订阅，
只取消该侧 Thread 的待处理交互，`thread/resume` 返回的活动 Turn 会重新归约到 Core。停止会中断启动中的 Codex 请求、取消并限时等待重连任务，且不会把主动关闭误判为永久
Thread 恢复失败。单个 Thread 被另一个 Codex 进程持有写锁时，组合根保留绑定并让 Gateway 与
其他 Thread 正常启动，按有界退避间隔只重试未恢复 Thread；占用与解除各投递一次结构化渠道通知。
停止会取消等待计时器并限时等待在途恢复，不删除官方写锁或绕过 App Server 单写约束。
启动失败、启动中停止和正常停止共享同一个组件关闭任务；除中断未完成连接所需
的 Client 关闭外，Surface、事件总线、Client 收尾和存储不会被组合根重复关闭。组合根有界持有
已接收的 Queue 完成释放任务，停止时拒绝新任务并先限时等待，避免 Surface 或 Client 关闭后继续派发。
