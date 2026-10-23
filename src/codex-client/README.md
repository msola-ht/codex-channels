# Codex Client

本目录封装 Codex App Server Transport、JSON-RPC 会话和类型化 API，是 Gateway 访问 App Server 的唯一底层入口。

Thread 启动/恢复、Turn 启动/追加及中断的本地 `beforeSubmit` 守卫透过 Provider 准备保留到 RPC 发送前同步执行，不编码为
协议字段；守卫拒绝时不发请求，已经发出的写请求仍等待实际响应，不以取消丢弃写入结果。
图片引用准备同样在创建文件、每次字节上传及完成确认前复核该守卫；受管 DS 还在私有上传路由
IPC 前后及上传后复核。撤权后不再新出站，
守卫错误保留原分类，既有上传失败处理不会将其吞掉或重试。
Queue 的本地守卫由 JSON-RPC 在每次请求尝试前执行，读请求遇过载后的重试也复核授权；写请求仍不重试。
模型与 Thread 列表分页、模型默认配置读取/写入、派生、归档和取消订阅同样保留调用方的本地守卫，
不把闭包编码进协议；已提交的默认配置写入不会因响应期间撤权自动回滚。
Thread 命名、固定、压缩、Review 和 Goal 同样接受提交守卫；固定状态的初始读取、元数据写入及分区移动
分别复核。移动已提交后的权威读回用于结算实际结果，不因随后撤权跳过，也不回滚已经提交的元数据。
Skill/Plugin 目录解析和 MCP 列表、资源读取、OAuth、刷新保留调用方提交守卫；分页与过载重试逐次复核，
MCP 刷新各 Provider 分支分别复核并等待已启动分支结算。取消信号与授权闭包是独立的本地参数。
Plugin 列表与精确解析显式路由到目标 Provider，失败不回退主实例；Provider 参数只用于本地选路，不进入 `plugin/installed` RPC。
重置券查询的账户路由、券明细读取及单次消费保留提交守卫；读取重试复核，消费不重试。
Hook 列表、配置版本与状态写入也保留提交守卫；最终写守卫通过后才使共享配置修订失效，
已经提交的写入继续完成跨实例刷新，避免撤权阻断结果结算。
Permission Profile 分页、无人值守权限预检和账户查询接受本地提交守卫，Provider 准备和过载重试均复核。

Provider 路由层为所有转发通知附上实际连接的 Provider 路由键，覆盖上游同名字段；固定自定义主 Provider 的路由键仍为 `openai`，实际账户身份由组合根区分。
聚合暂时关闭时，缺失 `codexc-aggregate` Client 返回专用不可用错误，保留旧绑定供后续恢复；不会回退主实例或把临时关闭分类为会话删除。

Luna Reserve 设置写入也在 Provider 准备后执行最终提交守卫，并与当前 Thread 审批方式更新复用
RPC 成功和最新匹配设置通知的确认流程；超时、断线、Thread 失效、重连或关闭会清理等待。
空 RPC 响应不等于设置已经应用，组合根须等待共享入站归约后由 Application 核对实际设置。

0.162.0 引入的 `partial_answer` 在通知边界继续保留，Goal set/clear 的渠道用户操作显式携带 `origin: "user"`。
Goal get/set 的非空响应还必须与请求 Thread 身份一致，错配结果不进入当前会话缓存。
子代理 started 活动保留官方 `model` 与 `reasoningEffort`，空值不推断；其他活动不复用启动快照。

遵循[跨平台变更规则](../../docs/development-rules.md#cross-platform-changes)：Unix UDS 与 Windows 官方 Proxy 是同一本机 App Server 合同的适配方式，不能各自放宽认证、消息边界或生命周期语义。Transport 只拥有本次连接及显式创建的子进程；关闭、连接中取消和回收失败都不得扩大为终止共享 App Server。修改共享 Transport 接口时同时核对 UDS、Proxy、stdio 的调用与关闭路径，具体进程及文件保护由注入的 Runtime 能力承担。

## 文件

- `app-server-transport.ts`：用平台无关的本机 App Server 端点描述选择 Transport；Unix 保留原生
  WebSocket UDS，Windows 使用官方 Proxy 字节桥接。
- `codex-process.ts`：定义由组合根注入 Transport 的 Codex 子进程调用与终止形状，使 Windows batch
  shim 解析及精确 PID 树终止留在共享 Runtime，Codex Client 不反向依赖部署基础设施。
  本机 App Server 与 stdio 连接必须注入启动和回收端口；没有裸命令启动或只结束单个包装进程的回退。
- `index.ts`：本模块的公开导出入口。
- `transport.ts`：Transport 接口和公共生命周期基类。
- `unix-websocket-transport.ts`：连接前校验当前用户私有的父目录和本人所有的真实 Unix Socket，
  通过共享 Runtime 校验 0.163.0 的确定性 rendezvous 链接与受保护目标，再完成 WebSocket HTTP Upgrade 的正式 Transport；消息上限与锁定版本原生 Remote Client 的
  128 MiB 边界一致，避免大型 Thread 恢复响应被客户端提前断开，同时保留有界内存约束。
  直接 Socket 与链接目标均要求 `0600`；关闭超时不丢弃连接引用，不把发出终止请求当作已退出。
- `windows-proxy-transport.ts`：在 Windows 启动并拥有固定版 `codex app-server proxy --sock`
  子进程，把其双向 stdio 包装为标准 WebSocket Transport；复用 128 MiB 消息边界，握手使用独立
  有界超时并清理静默 Proxy，关闭 Gateway Client 时只终止对应 Proxy，不终止独立 App Server。
  Proxy 与 stdio 的并发关闭共用清理任务；终止失败保留进程所有权，重新连接不能绕过未完成的清理。
  Proxy 握手期间关闭会立即取消握手，再等待同一子进程清理，不等待完整连接超时。
- `stdio-transport.ts`：用于临时配置事务及受控开发场景的 stdio Transport。Unix 创建独立进程组并经注入的 Runtime 端口登记；包装器退出后仍保留归属，只有整组清理确认后允许新连接。Windows 继续使用自有进程树回收。失去组长身份且后代仍存活时拒绝关闭成功，不向可能复用的旧 PGID 盲目发信号。
- `json-rpc.ts`：使用生成的 `ClientRequest` / `ClientNotification` 约束出站消息，并处理
  initialize、请求关联、通知与 Server Request 分流、超时、断线清理及安全重试；通知不附加本地接收时间戳。
  初始化期间
  通过组合根注入 `clientInfo`；缺省声明官方 `codex --remote` 的 `codex-tui` 与当前锁定 Codex CLI
  版本，`[codex].client_identity` 可覆盖 name/title/version；仅在 `follow_cli_version = true` 时由配置层将官方身份版本解析为当前锁定版本；
  建连与重连共用连接代次，清理旧 Transport、握手与初始化响应后的每个异步边界均拒绝过期连接；
  并发关闭及重连前清理共用 Transport 关闭任务，旧失败不清理替代连接。通过 `extensions` 显式声明已实现的 `openai/form`。
- `thread-adapter.ts`：把当前版本生成的官方 Thread、内置 Pinned、运行状态、更新时间/最近活跃时间、来源（含稳定的
  `automation` 任务来源）、运行 Turn、
  上下文压缩 Item ID 和模型设置响应映射为 `session-routing` 拥有的稳定快照与恢复会话；启动、恢复与分叉响应的实际 `approvalsReviewer` 用于会话审批方式展示，缺失或未知值映射为未知，不从全局配置推断；Thread 的当前模型及思考设置供子代理继续通知只读展示，开始通知使用官方活动的启动快照，均不等同实际请求遥测；
  恢复结果保留响应的实际 Default/Plan 模式、目录和权限，以及与请求配置的一致性，供 Router 在绑定前校验；
  缺少必需字段时失败关闭。`parentThreadId` 只映射官方派生关系；`listThreadDescendants` 以明确祖先查询所有来源及指定归档状态，不用父目录截断后代，供本机归档预览和核验。固定状态写入由 Client 原样回写当前 Git SHA 以无损协调加载中 Thread，
  再移动到官方分区并读回验证。
  `hasActiveDescendants` 在目标 Provider 内通过 `thread/loaded/list` 枚举包括 ephemeral 的已加载
  Thread，再用不含历史的 `thread/read` 沿官方 `parentThreadId` 核验活动后代；使用共享执行结算判定，
  idle/notLoaded 必须没有活动 Turn，systemError 还必须有本连接按同一 Turn 观察到的 started → completed
  终态证据，未知状态保守阻挡，根 Thread 本身不计入后代。证据只在 Client 内存中最多保留 2,000 个
  Thread，不从历史或元数据中的空 Turn 补证；旧 Turn 完成不能覆盖新活动，active、旁路错误、
  Thread 失效、重新订阅、取消订阅、断线及关闭会使相关证据失效，淘汰后也不以孤立 completed 重建。
  取消订阅发送及结算时均清理证据，取消订阅后的读取不能沿用旧终态证明新活动不存在。
  Queue 启动屏障只有明确返回空队列、且等待期间没有通知或连接/提交变化时才恢复原证据；其他拒绝保持未知，不把失败写入当成已完成执行。
  查询共享调用方取消信号和 10 秒总预算，最多 20 页、
  2,000 个唯一节点及 64 层祖先；身份或 Provider 不匹配、缺字段、循环、越限、超时和断线均拒绝，
  不以持久 `thread/list` 或内存活动缓存替代权威查询。覆盖范围遵循官方 loaded/list，包含标准
  SubAgent 与 ephemeral，但不宣称枚举上游主动隐藏的 Internal Thread。
- `image-reference-upload.ts`：通过 `config/read` 定位当前 App Server 的回环模型代理；OpenAI ChatGPT 查询无凭据只读路由，走官方账户路由、令牌校验、创建、无凭据字节 PUT 和完成确认。受管 DS 按 Thread 的精确 Provider 经 Bootstrap 注入的私有 IPC reader 取得随机 Bearer 能力；modelEndpoint 包含准确账户前缀，必须与该 App Server 配置精确一致，能力只发送到私有合同确认的同源根路径上传 endpoint。上传前后复核能力和修订，只提交校验后的 fileId，能力缺失或变化失败关闭，不回退 inline。OpenAI API Key、自定义第三方、CLP 等其他 Provider 保持 inline。管理有界并发、顺序多图、分阶段超时和取消；OpenAI 同一字节 PUT 共用 5 分钟、最多 5 次尝试及退避，完成确认最多 30 秒；DS 客户端传输上限 5 分钟，代理整体和上游 Files POST 仍受各自更短期限约束，材料及路由准备阶段最多 60 秒。创建、DS 上传和 Turn 提交不重试；账户或 Provider 修订变化时取消。
- `turn-adapter.ts`：把 Application 的文本、内联 PNG/JPEG/WebP/非动画 GIF 图片、本地音频与已解析 Skill 输入编码为官方 `UserInput`，并映射
  Turn、Review 和 Goal 响应；缺少稳定结果必需字段时失败关闭。
- `queue-adapter.ts`：把官方 Queue 条目裁剪为 Application 的稳定种类、可编辑标记和有界文本预览；
  本地媒体、Skill、Mention 与其他非文本输入只返回安全摘要，不传播原始值或绝对路径。仅在六个 Queue RPC 拒绝处将锁定版本的错误码与已知文字映射为稳定失败分类；传输及响应转换失败原样传播。
- `history-adapter.ts`：把官方分页 Turn 与 Revert 响应裁剪为有界摘要和稳定 Thread 快照；只提取
  `userMessage` 的安全输入摘要，拒绝残缺游标、非空 Revert 历史和越界字段。
- `user-input-summary.ts`：为 Queue 与分页历史共用的 Client 内部 UserInput 安全摘要工具；摘要有界，
  不传播完整输入、命令参数或本地路径。
- `model-adapter.ts`：把当前版本官方模型目录裁剪为 Application 拥有的模型选项和
  `text/image/audio` 输入能力、Codex 多代理运行时及结构化替代模型/退役时间，过滤不可见项；
  只有 Luna Reserve 内部窄入口会请求隐藏目录并精确解析 `gpt-reserve`，公开模型列表仍过滤隐藏项；
  官方迁移 Markdown、链接和自由文案不越过 Client 边界，
  并在缺少模型选择必需字段时失败关闭。
- `model-provider-catalog.ts`：按 Bootstrap 注入的 Provider 定义读取 Setup 下载到用户
  `CODEX_HOME` 的受管模型目录；目录里声明什么就开放什么，相同模型 ID 仍按 Provider 独立映射；
  已开放模型的 `text/image/audio` 输入能力从目录严格校验后映射，未知、重复或缺少文字能力时失败关闭。
  CCG 使用从 DS 基础内容生成的独立本地目录，保留含命名空间的上游模型 ID。
  `parseAggregateModelOptions` 复用纯目录裁剪并显式校验聚合命名空间，不读取源文件或启动服务。
  聚合保留源模型的不透明 ID 和无思考等级语义，按 API 可用性与 picker 可见性筛选，保持空闲目录与 `model/list` 一致。
- `account-adapter.ts`：把 `account/read` 的当前认证类型裁剪为 API、ChatGPT 或无需 OpenAI 认证的
  启动探测路由，不读取或传播凭据；把账户 Token 用量、单桶或多桶额度、重置券数量与到期时间、账户 ID、普通用量权限及
  有界 Luna Reserve 授权摘要映射为 Application
  稳定摘要；接受当前 0.163.0 完整套餐枚举，按请求 Thread 严格校验官方估算的 ID、整数单位、可选 Token 和分组字段，未知枚举或畸形数值失败关闭，
  不把上游响应正文交给 Surface。
  `client.ts` 的手动与后台额度查询直接调用 `account/rateLimits/read`，携带取消信号且不主动刷新登录凭据；
  后台查询省略重置券详情，启动认证路由使用 `account/read.refreshToken: false`。
- `skill-adapter.ts`：从官方按 CWD 返回的 Skill 条目中只保留启用的用户或项目直接安装项，
  使用稳定 `SkillMetadata.pluginId` 排除系统与 Plugin 所有项，不从安装路径猜测来源；列表结果不含本机路径，显式调用只向 Application 返回精确匹配且名称、
  绝对路径均通过校验的引用。
- `mcp-adapter.ts`：把官方 MCP Server 状态页裁剪为概览或工具、资源、模板详情，严格映射当前 Thread
  已发布连接的七种 `runtimeStatus`，把官方 `null` 映射为稳定“未知”且不据此启动或重连 Server；并把工具
  `annotations.readOnlyHint` 归约为只读、可能写入或未知；校验 OAuth
  授权 URL 和当前基线必需的 loginId，完成通知保留同一 ID；Provider 路由层返回实际连接路由键，供 Application 精确关联。
  将说明字段的多行空白归一化并限为 2,000 字符，并把资源响应限为前 8 项、文本展示
  合计 8,000 字符且隐藏常见凭据，二进制裁剪为元数据；保留可空、长度受限且符合固定上游
  `<plugin>@<marketplace>` 字符规则的 `pluginId`，
  仅供 `/mcp` 详情展示来源 Plugin；工具发现错误只归约为布尔状态，不传播上游错误正文、工具 Schema
  或 Base64 正文。资源请求、内容、目录与模板 URI 的展示投影也隐藏常见凭据，不改变 RPC 请求 URI。
  详情原样保留必需且可空的 `toolListMeta`，缺失字段明确拒绝；它是对应工具目录第一页的不透明 JSON，仅内部透传，不解析键或用于展示、日志、权限和模型输入，概览仍不携带。
- `plugin-adapter.ts`：只映射已安装 Plugin，校验 Plugin ID、Marketplace、启用与管理员可用状态，
  裁剪版本、来源类型、安装时间、开发者、分类、能力、认证时机、不可用原因和适用套餐标识，
  不传播来源路径或 URL；保留 Marketplace 加载失败计数，
  并为可调用项生成官方 `plugin://` mention 路径。
- `permission-adapter.ts`：把官方 Permission Profile 分页响应裁剪为 ID、说明和策略可选状态，
  并对必需字段与分页游标失败关闭。
- `hook-adapter.ts`：把稳定 `hooks/list` 的单 Workspace 目录裁剪为 Application Hook 条目，
  校验事件、来源、处理器和信任状态，原始 warnings/errors 只返回计数。命令、MCP 工具、matcher
  与来源路径复用凭据脱敏、控制字符清理和限长；关键展示信息改变、来源未知，以及缺少执行内容的
  prompt/agent 及缺少输入模板的 MCP Tool 处理器均标记为不可审阅；命令条目同时提供安全整数
  timeout、async 和 additionalContext spill 阈值。Hook key 仅用于内部精确定位，不作为渠道展示文本。
  状态写入只允许 trust/enable/disable，通过 `hooks.state` 的 upsert 保留其他 Hook 与状态字段。
- `notification-adapter.ts`：稳定导出门面，只 re-export 四个协议入口与 `AutoApprovalReviewEvent` 类型；具体映射按目标消费者拆分到下列文件，其它模块仍从本路径导入。
- `notification-conversation-events.ts`：把官方 Notification 转换为 Conversation Core 拥有的稳定事件；异步 Agent 消息保留 `delivery` 与已校验的问题，按过程消息处理其阶段；
  `hook/completed` 保留 Thread、运行 ID、已知触发事件及上游终态，不按执行模式额外过滤；忽略 `hook/started`，不转发输出条目、状态自由文本或路径；
  校验 Turn、Item、Diff、Plan、Goal 与 Token 字段；`turn/completed` 只接受官方 `Turn.durationMs` 的非负安全整数并转为稳定耗时，
  只识别 `misalignmentPolicyViolation`、Luna Reserve 触发所需的 `usageLimitExceeded` 与登录或刷新令牌失效的 `unauthorized` 结构化错误分类，Turn 错误在此统一脱敏并限长，
  残缺或无关通知不进入业务模块。
- `notification-reasoning-guard.ts`：将锁定协议的 `item/reasoning/textDelta` 与 `summaryTextDelta` 投影为 Application 重复保护的瞬时输入，保留 Thread／Turn／Item／段索引及原始思考／摘要来源隔离；Item 起止只标记边界，不把完成快照重放为增量。内容不转为渠道事件或指标。
- `notification-account-events.ts`：映射账户、额度、MCP OAuth 完成、MCP 启动状态与 warning 事件，统一脱敏并限长，残缺字段省略而不推断。
- `notification-thread-state.ts`：映射 Routing 侧线程设置、线程名、生命周期与 Queue 变更事件；Queue 变化只让本地选择快照失效，不触发读取。
- `notification-review.ts`：把受控 `item/autoApprovalReview/started|completed` 裁剪为 Thread、Turn、review ID、阶段、状态和 agent 来源的批准标志，供 Bootstrap 继续采集开始与完成指标。仅 agent 完成事件附加 `AutoApprovalReviewDetails`：七种官方动作类别、最多 1,024 个字符串条目的文件数量、白名单网络协议与 u16 端口；按动作提取操作与工作目录、审查理由，经共享凭据脱敏、控制字符清理及 320 字符限长后传递，execve 参数按原始边界脱敏后才格式化；保留文本标点，由 Surface 处理富文本呈现。合法起止时间投影为耗时，不采集风险与授权等级。未知或畸形摘要字段省略，超大文件列表只保留动作类别，不传递 stdin 正文或完整网络 target URL，非法来源和终态明确排除。
- `notification-parse-helpers.ts`：上述映射共用的纯解析与基础断言（记录/字符串断言、Turn 与 Thread 状态、MessagePhase、PlanType、额度快照、Token 用量与 Turn 错误分类）；不持有状态、不执行 IO。
- `value-primitives.ts`：本模块适配器共用的最小取值断言（有限数值、原样字符串、去空白后非空的字符串）；不含协议语义、不持有状态，供通知映射、操作摘要与服务器请求解码复用同一实现。
- `operation-adapter.ts`：把官方 Item 转换为安全、简洁的操作摘要，保留 MCP Tool Item 的
  `readOnlyHint` 能力提示，把多代理工具调用的 `interrupted` 归为失败，并在离开 Client 边界前
  清洗命令、查询及上游错误中的敏感文本；`commandExecution.commandActions` 非空、全部为
  read/listFiles/search 且来源不是用户终端命令时输出只读探索归类与文件名摘要，任何未知或畸形片段都退回
  原始命令；该判定沿用上游 best-effort 解析，`find … -delete`、`… | tee` 之类写入形态可能一并归类；
  把 `imageGeneration.savedPath` 映射为生成图片产物路径；`fileId` 原样保留为所属
  Thread/Item 内存事件的 `imageFileId`，不解释为 URL、不提交模型、不用于跨 Provider 查询。
  Surface 在持久输出快照中移除引用，仅保留内容不可获取状态；不消费 `result` 或 `inputImages`，
  不把 `imageView` 当作可外发产物。
  `cua_repl.js` / `js_reset` 归为 MCP 的 `computerUse` 操作，`js` 只提取参数中的操作标题并
  脱敏限长，不把执行代码或原始结果带入稳定事件。
- `file-change-approval-context.ts`：按每个 Client 的 Thread、Turn、Item 精确关联批准前的
  文件变更通知，仅有界保留路径、操作类型与移动目标，不保存 Diff；Item/Turn 完成、Thread
  失效、取消订阅、断线与关闭时清理。缺失明细不借用其他 Item，Provider 路由同时校验请求来源。
- `server-request-adapter.ts`：把命令、文件、临时权限、用户输入和 MCP elicitation 五类
  Server Request 解码为 Approval 稳定请求；命令审批只接受缺省或明确的 `kind=command`，保留上游可选工作目录，畸形目录拒绝而非当作缺失，
  `writeStdin` 解码为独立 stdin 审批，要求完整输入、目录、回调身份和仅 accept/cancel 决策；未知种类安全拒绝；其中按固定版本的空对象 Schema 与
  `mcp_tool_call` 元数据识别 MCP 工具审批，逐名、逐值核对 `tool_params` 对象与展示数组完整一致；
  缺失、重复或矛盾时安全拒绝，保留参数原名、展示标签和上游提供的持久范围。稳定决定
  精确编码为当前官方响应；未协商的 `openai/userVerification` 模式显式取消，畸形请求安全拒绝，
  未知请求返回明确 JSON-RPC 方法错误。实验
  `item/tool/call` 属于 Gateway 宿主动态工具边界，不在本审批适配器中执行。
- `protocol-info.ts`：集中公开 App Server 客户端标识、受支持的 Codex CLI 版本和 Gateway 显示版本，
  供 Client 请求复用，并由组合根校验版本、向 Surface 注入纯字符串。
- `client.ts`：Thread 搜索/归档/固定、原生 Queue 六请求、分页历史与 Revert、Turn、模型、权限、Skill。
  新建 Thread 隐式使用 Gateway 默认模型前核对当前实例 `model/list`，失效时不发送 `thread/start`；显式模型和历史恢复保持各自调用合同。
  仅在 `thread/resume` 拒绝处，将 `-32600` 且完整消息精确等于 `no rollout found for thread id <请求的 Thread ID>` 的错误映射为稳定 `thread.resume.history-unavailable`；其他方法、错误码或 Thread 身份不复用该分类。此错误不证明 Thread 已删除，Client 不自动命名、创建替代 Thread 或重试写请求，保留绑定与恢复调度由 Router 和组合根负责。
  Workspace 的可选 `approvalsReviewer` 通过稳定 `thread/start`、`thread/resume`、`thread/fork` 参数传递；省略时保留 Codex 默认或历史持久设置，恢复响应核对明确请求的 reviewer。
  当前 Thread 审批方式通过 `updateThreadApprovalsReviewer` 更新；请求前注册合法设置通知观察器，等待 RPC 成功和最新同 Thread 同目标通知，超时、断线、关闭或 Thread 失效清理等待和请求，不启动 Turn、不重试设置写入。
  `account/read` 当前认证路由、账户与 Thread 用量及用户级配置
  读取等 App Server 方法的类型化封装；按 Workspace 读取有效思考等级与服务层级，模型、思考等级、服务层级默认值和受控 agents 设置统一通过
  同一个 `config/batchWrite` 用户配置事务写入；`writeDefaultServiceTier` 只接受 Standard 对应的
  `default`、`fast` 与 `ultrafast`，渠道通过模型目录检查可用性，下一 Turn 覆盖仍走 `turn/start.serviceTier`。
  `readModelAccelerationSettings` 复用带 Workspace `cwd` 的 `config/read`，结合 `configRequirements/read` 独立速度合同和稳定 `featureRequirements`，只向 Application 返回配置服务层级与 Fast/Ultrafast 两个有效开关；受管精确值优先，缺失按锁定版本默认 true，异常响应拒绝。`readDefaultServiceTier` 保留未经功能过滤的配置选择，不证明既有 Thread 的选择或有效档位；用户设置快照按需投影同一独立开关，原始用户配置仍用于版本化编辑。Provider 路由固定到目标实例，不暴露原始配置。
  受控的读改写流程从原始用户层取得版本并通过
  `expectedVersion` 拒绝并发覆盖；Hook 目录和用户层版本通过独立窄端口读取，不把原始配置交给
  Application。Hook 状态写入携带 `expectedVersion` 和 `reloadUserConfig: true`，不自动重试；
  Provider 路由使用调用方明确选择的实例和活动边界，不以主实例替代未知 Provider。各实例共用
  Codex Home；写入后协调已连接及正在连接的实例，以空编辑 `config/batchWrite` 请求刷新，
  不复制或重写状态。返回失败 Provider，未连接或刷新失败的实例在后续接入操作前刷新，失败关闭；
  新建连接与重连均刷新，避免 Gateway 重启后丢失失效标记而继续使用独立实例的旧运行配置。
  首次连接的握手与刷新共同构成初始化；失败时经既有 Provider 关闭路径清理本次连接，
  清理成功后才允许重新握手，清理未确认时保留所有权并拒绝接入，不终止独立 App Server。
  不为刷新启动未使用的 Provider，结果未知的写入同样使旧运行配置失效。并发刷新合并，同一次编辑不重试。
  用户设置读取可显式附加稳定 `configRequirements/read`，
  仅投影受控实验 `allowedApprovalsReviewers` 和稳定 `featureRequirements` 中的 Auto-review
  审批人及功能限制，不返回完整受管配置；策略读取失败或畸形时保留有效用户快照，省略审批策略投影，由设置入口显示不可用并拒绝该字段写入。
  MCP 概览按 Thread 使用 `toolsAndAuthOnly` 分页，详情使用 `full`；`config/mcpServer/reload` 不自动重试，成功只表示已加载 Thread
  刷新了 MCP 配置，远端连接结果仍由后续运行状态查询确认；MCP 概览、刷新与账户额度读取接受调用方取消信号，
  截止时间到达会清理 Pending Request，不代表撤销服务端已接收的刷新。OAuth 不自动重试并消费
  官方登录完成通知，资源读取保持只读；Permission
  Profile 按 CWD 分页。Plugin 查询只调用 `plugin/installed`，按当前 Workspace CWD 获取已安装目录，
  不接入市场搜索、安装或分享。Thread 列表支持官方 `searchTerm`、`sectionId` 和
  `section_position` 排序，并显式传空
  `modelProviders` 获取当前 Workspace 的全部 Provider，
  供跨 Provider 会话展示和冷恢复定位使用；macOS Desktop 启动前的只读检查使用官方分页
  `thread/loaded/list` 枚举当前内存中的持久及临时 Thread，再通过 `thread/read` 读取权威状态，只返回
  活动 Thread 数量。
  新 Thread 可显式携带官方 `modelProvider` 与实验 `dynamicTools`；普通新建和用户显式 Fork
  与原生 CLI 一致发送稳定 `threadSource=user`，计划任务新建保留 `threadSource=automation`。
  Fork 不继承父会话的功能来源；恢复接口没有来源覆盖字段，保留官方持久来源，不重写旧会话或历史用量。
  普通会话入口的 `turn/start` 显式发送 `turnTrigger=user`；计划任务不填该字段，
  `turn/steer` 与 Queue 使用各自原生协议，不附加不支持的字段。
  新建、恢复和 Fork 的 `runtimeWorkspaceRoots` 校验后透传为生命周期目录快照；设置通知只提供 cwd，不能更新该 roots 快照。
  新建、恢复和 Fork 的 `instructionSources` 透传为实际加载文件清单，供 `/status` 展示生命周期快照；
  不读取文件正文，也不据此推断系统、开发者或其他动态指令是否存在。
  功能来源与 `source` 的 CLI/App Server 入口分类独立，普通来源缺失可能影响官方用量页面归类，
  最终分类及历史统计由官方服务决定。前台新建、恢复和 Fork 不补网关权限默认值，由 App Server 处理原生配置及继承。
  Thread 响应保留实际目录、沙箱、审批策略和 Profile 身份；恢复只核对显式请求的约束。
  无人值守预检按目标 Provider/CWD 读取原生明确受限沙箱配置，创建后的实际权限仍须复核。
  Fork 调用方只允许选择同一 Provider，不承担跨 Provider 权限或历史转换。
  已有 Thread
  不在 Turn 覆盖中更换 Provider。Application 跨 Provider 选择时新建 Thread；`thread/fork`
  只用于用户显式创建同一 Provider 的历史分支，不承担跨 Provider 历史转换。
  重置券读取保留受控可用券的 ID、到期时间及展示说明；消费使用显式券 ID 和幂等键，禁止过载自动重试。
  OpenAI 额度读取声明 Luna Reserve 客户端能力，后台恢复轮询省略独立重置券详情；自动切换只解析
  精确隐藏模型 `gpt-reserve`，并用不重试的 `thread/settings/update` 同步 Thread 模型与当前协作模式，
  不写用户级默认设置。
- `provider-routing-client.ts` 不暴露自定义 Thread 分区 RPC；固定状态仍通过官方 Pinned 分区移动实现。
  `listModelsForProvider` 通过指定实例和既有活动边界读取模型目录，供独立 CP 选择及精确可用性检查共用；不回退主实例目录。
- `provider-routing-client.ts`：复用多个完整 Client 实例，按 Thread 的官方 `modelProvider` 路由
  生命周期、Turn、Review、Goal 和 MCP；合并各实例的进程内状态，隔离 Server Request ID，
  Server Request 的物理来源与已知 Thread Provider 冲突时拒绝；未知来源关联只作为读取路由提示，
  后续官方 Thread 快照必须匹配所读实例及请求的 Thread ID，才可用于子代理审批归属。
  `readConnectedThreadState` 只在现有连接的活动保护内读取官方无历史 Thread 元数据；未知归属先由已连接主实例定位，
  再由已连接目标实例核验，不启动或连接 Provider。无法读取时明确返回未知，不把 idle/notLoaded 解释为任务完成。
  第三方实例在查询对应实时模型目录、首次选择模型或恢复其 Thread 时通过私有监管入口按需启动并连接，未使用的
  Provider 不增加 App Server 子进程；MCP 配置刷新只尝试当前已连接实例并传播任一失败，单 Provider
  重连只恢复该侧 Thread。组合根为所有 Provider 请求注入活动保护：统一空闲管理器在 Gateway 没有前后台
  绑定、没有进行中操作且没有启动任务时等待 60 秒并每 60 秒复检，宽限期内新请求会取消本轮释放；
  到期仍空闲时先通知所有已知授权渠道，再关闭已连接 Client，并停止监管入口中全部未被租约占用的
  运行实例（含主实例与仅由 `codexc remote` 启动的实例）；该通知只在渠道会话空闲自动解除触发的
  全局释放轮次发送。检查由绑定变化、任务终态事件和周期复检触发。关闭先发生时，已排队请求在
  Client 空闲关闭后按需启动并重连。整体 `close()` 是终止边界：取消在途 Provider 启动及握手等待，
  关闭所有受管 Client 并拒绝后续连接；晚到的结果不能重新登记连接，不终止独立 App Server。
  并发整体关闭共用清理任务，清理失败可再次关闭重试。
  单 Provider 关闭也取消该侧在途建连，新的请求等待关闭结束后再建立连接；其他 Provider 不受影响。
  `connectProvider` 在定向设置应用后的主动关闭场景复用按实例合并的握手，与普通请求共同建立连接，
  不重置已经建立的新连接；意外断线仍由 `reconnectProvider` 恢复。
  第三方 Provider 的账户通知不会进入 OpenAI 账户状态；
  无法关联 Thread 的 MCP 启动状态与 warning 全局通知携带 Provider 来源，只发送到对应 Provider
  会话；无法关联 Thread 的 OAuth 完成通知不进入渠道。
  模型目录与 Profile 有效设置由对应 App Server 启动配置持有；跨 Provider 模型选择的默认思考等级
  和服务层级读取精确路由到目标实例。

Queue 的六个请求也按 Thread Provider 路由；只有 `thread/queue/list` 使用有界只读过载重试，
其余五个写请求不自动重试。
`thread/turns/list` 是有界只读查询，可按协议安全重试；`thread/revert` 是破坏性写请求，禁止自动重试。
两者及 Revert 前置 `thread/read` 保留本地提交守卫；Provider 查询与准备后仍复核，读请求每次过载重试前复核。
Queue 复核摘要由 Client 对完整有序原始输入计算不可逆指纹，Application 不使用截断预览自行重算。

本模块不得调用 Telegram API、生成平台文案或保存业务绑定。协议字段必须来自
`codex-protocol`；无参数请求和通知不得自行补空对象，写操作不得在过载或断线后盲目重试。
业务模块拥有窄端口和稳定结果类型；本模块可以实现这些端口，但不得让生成响应越过对应适配边界。
生产源码只有本模块可以导入 `codex-protocol`；`codex-protocol/index.ts` 只保留本模块实际使用
的生成类型。
Notification 适配只返回当前支持的稳定事件；未知或畸形通知由组合根记录 method 后忽略，不记录
原始 params，也不阻塞 App Server Reader。
`subAgentActivity` Item 只在官方完成阶段进入稳定事件，并保留 `started`、`interacted`、
`interrupted` 与 `completed` 类型，避免同一 Item 的开始与完成阶段重复发布；`completed` 是
当前锁定版对成功运行的父 Turn 归属信号，Bootstrap 不再从子线程 `turn/completed` 或等待工具状态
重复推断成功。`collabAgentToolCall` Item 由操作适配器保留官方接收线程 ID 和有界状态，不保留
代理消息正文；其异常状态与子线程失败/中断通知继续用于非成功终态。Surface 把 `started` 与
`interacted` 分别显示为开始和继续，并消费稳定操作与完成事件，`interacted` 不改变存活状态。
Server Request 适配只把已校验的稳定请求交给 Approval；Approval 不接触生成协议或 RPC 信封，
响应类型与请求不一致时失败关闭。
当前精确协议基线要求 initialize 协商实验 API，App Server 才会发送已生成并受控导出的
`thread/settings/updated`；该通知用于同步共享 Thread 的模型、思考等级、服务层级、实际审批审查方式和
Default/Plan 协作模式；其中 `approvalsReviewer` 是稳定字段。Client 仅按[受控协议边界](../../docs/index.md#受控协议边界)采用 Plan、Queue、Revert、计划任务动态工具、图片上传账户路由和 Auto-review 策略读取及审查状态投影六类明确列出的受控例外，并映射到业务窄类型；生成类型不自动开放其他实验能力。启用这些能力
同时出现的实验审批字段必须在 `approval` 边界显式展示或默认拒绝，不能静默扩大授权。
自动审批设置的本地提交守卫在 Provider 准备后、设置 RPC 发送前执行；守卫拒绝不发请求，
保留明确的授权或 Thread 变化错误，并释放本次确认等待。已提交请求继续按设置通知和响应结算。

固定协议的一次性 `localAudio` 已由 Application 的封闭 `TurnInput` 受控接入；Surface 只能提交
经过格式、大小和私有临时文件边界验证的绝对路径，Application 还必须在 Turn 前确认当前模型目录
包含 `audio`。远端 `audio` 和实验 `thread/realtime/*`
不得由本模块调用或映射；生成目录中存在 Realtime 请求和通知类型不改变该边界。
