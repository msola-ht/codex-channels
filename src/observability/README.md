# Observability

本目录提供 Gateway 的结构化日志和模型请求指标持久化入口。

`turn_execution_metrics` 按 Thread/Turn 唯一保存官方整轮耗时、顺序与记录时间；
`thread_execution_state` 仅保存 Provider 与历史补齐标记，不保存会话累计数或消息内容。
Gateway 是唯一写入方，实时终态幂等更新，完整历史快照在事务内替换；会话耗时查询仅汇总当前 Thread，
不重复叠加子代理，缺失耗时或未完成历史同步时完整总数返回未知，同时提供已知累计、缺失轮数和历史完整性。完成卡片按目标轮次截止，WebUI 查看全部保留轮次。
轮次耗时沿用指标保留期限和行数上限，清理、Provider prune 和 reset 同时处理，不复用单次请求耗时列。
轮次写入因保留期限跳过数据，或清理因期限、行数上限删除轮次时，历史补齐标记同步降级。
会话自动审查累计只有在历史轮次集合已补齐、各轮审查观测也完整时才能标记完整；本轮任务覆盖独立判断。
自动审查汇总同时读取精确运行范围内明确标记的审查请求用量，供完成卡独立显示；Token 缺失独立于审批事件覆盖，不按审批次数推算。Thread/Turn、任务、会话树与子代理的请求统计排除这些请求，包含请求数、Token、缓存、Credits、中断与性能；全局请求及模型分组保留审查成本，原始指标与归属不变。
审查 `usage.coverage` 只区分 `observed`（保留记录中的已知值）与 `partial`（已知字段或写入缺口），没有完整用量状态。输入、输出分别累加已知值；没有相应观测时保持 null。IPC 漏帧、迟到记录和保留裁剪无法从现存行证明不存在，不借审批事件 coverage 作保证，不改变数据库格式或回填历史。

## 文件

- `index.ts`：本模块的公开导出入口。
- `query/index.ts`：供 CLI 参数预检使用的无状态公开入口，只导出范围、日期、筛选和聚合维度解析，
  不加载 SQLite 实现；其他业务模块仍通过模块根入口访问完整能力。
- `logger.ts`：根据配置创建 Pino Logger，并对 Token、App Secret、Authorization、Cookie、密码等
  字段进行脱敏；`err` 和进程边界复用 `safeErrorMetadata`，只保留受约束的异常类型和机器错误码，
  不保留 message、stack 或附加响应对象。`createLogger` 默认绑定 Gateway 服务，可显式选择 WebUI/Relay 服务及模块；子 Logger 继承脱敏规则，供服务宿主复用。
- `request-metrics.ts`：定义与 Provider 实现无关的单次模型请求指标、内部查询结果，以及写入、普通
  请求查询、Thread/Subagent 查询、Quota/Account Snapshot 四类窄存储端口；组合接口只供同一
  SQLite 实现声明完整能力，各消费方按实际用途依赖窄端口。
  可空 `upstreamProvider`、`upstreamAttemptCount`、`modelAttemptCount`、`finishReason`、`errorStage`、`upstreamErrorCode`、`upstreamErrorType`、`upstreamHttpStatus` 保存受限请求诊断摘要，与转储开关独立；内层错误不覆盖外层 HTTP 状态，尝试次数不表示切换次数。
  `responseUsageAmount` 保存上游单次响应用量原始十进制字符串，供明细和 JSON/CSV 导出读取；
  历史或上游未提供时为 null；完成卡片的 OpenAI 汇总使用精确十进制求和及缺失请求计数，不换算费用、不保存任意上游 metadata。
  可空 `requestBytes` 保存本次逻辑请求实际发往模型上游的请求正文或 WebSocket 请求帧字节合计；
  HTTP 转换后的正文按实际提交内容计数，不包含响应、请求头或传输开销，未实际发送时为 null。
  新采集指标以请求归属、模型、状态、Token、错误分类与额度快照为主，不包含价格快照或请求/响应正文；普通Proxy在采集及IPC边界将 `errorMessage` 固定为null，错误分类、受限代码与HTTP状态保留，历史数据库中的错误文本不自动重写或清理；
  `responseTimeMs` 与 `generationTiming` 保留在线观测响应时间和生成区间；`firstTokenMs` 保留内部首内容诊断，`upstreamTtftMs` 独立保留 OpenAI 轮次首 Token 统计，
  `requestModel` 与 `responseModel` 分别保留请求和响应回显名称；可空 `traffic` 只保存转储标签、实际批次与调用编号，不包含正文或文件路径。
- `response-usage-summary.ts`：流式精确汇总 OpenAI 单次用量文本与采集覆盖数量，供 Turn、任务和会话查询使用；不以浮点数累计或把缺失值当零。
- `request-metrics-query-service.ts`：在只读 Store 之上统一滚动时间范围、本地今天/昨天、自定义日期、请求筛选、聚合维度以及
  会话、请求、异常、趋势和额度查询；Bootstrap、`codexc metrics` 与 WebUI 复用同一查询语义，
  各自只负责授权、参数边界和结果呈现。
  控制台整体及各 Provider 的会话/轮次计数使用 `threadCounts(scope)`，按自身 Thread/Turn 去重，不执行会话列表的递归用量、排序或行映射。
- `async-metrics-store.ts` / `metrics-worker.ts` / `metrics-worker-protocol.ts`：Gateway 唯一指标数据库连接由单 Worker 拥有，初始化、SQL 写入与查询、保留清理和关闭均在线程内执行；主线程只使用明确的异步窄端口，不再为账户窗口额外打开同步读连接。请求队列上限 256 项、8 MiB，逐项串行，2 秒普通请求预算包括排队；初始化独立限时 15 秒，关闭确认独立限时 5 秒。取消的排队请求不执行；已发出的写入保留请求、容量和原始期限，调用方取消等待后仍由内部任务接收实际结果，成功提交后的缓存与通知继续收尾。真正的写入超时按结果未知处理，连接不再接收新操作且不重试写入；未确认线程退出时保留 Worker 所有权与数据库锁归属。
  正常关闭、初始化失败与致命请求失败共用协作关闭：停止标记阻止迟到就绪与尚未开始的 SQL，线程先关闭 SQLite，再用 1 秒预算请求 Windows ACL helper 退出；预算失败继续保留 owner 并等待实际退出后才关闭端口。`closeMetricsStores()` 拒绝新实例并请求所有 owner 关闭，`waitForMetricsStoresExit()` 供最终退出路径等待物理结束，实例仅在 Worker exit 后移出登记。
- `provider-quota-tokens.ts`：按精确 Provider 单次流式归约最多三个额度窗口，只返回有限窗口总数；Gateway 在线程内读取，保留同步只读消费端的同一窗口语义。
- `request-metrics-writer.ts`：提供 10,000 条、16 MiB 上限的有界延迟写入队列；指标 Socket 只负责入队，
  批次成功提交后通过注入回调通知读取方失效，通知故障不改变写入结果；失败批次不发送成功通知。
  每批最多取 32 条并等待异步事务完成后再调度后续批次；关闭排空有总预算，预算耗尽显式记录未写入样本并关闭数据库，不继续无限等待。公开
  持久化水位只等待调用时已经入队的记录，不被后续请求延长。单轮按已知范围等待，任务与会话先等待全局有限水位，再通过数据库只读 `metricsWriteScopes` 取得对应运行树或线程树，仅判断初始水位内相同范围和用途的写入失败；无关线程、其他父轮和审查用途失败不影响普通任务统计。未归属具体 Turn 的请求不进入任务或会话汇总，其写入失败也不影响这些汇总的就绪状态。
  已取出但未确认提交的批次仍属于水位；等待支持取消并释放检查点和监听，不取消底层写入，等待队列容量耗尽显式拒绝。失败范围有界保留，迟到的等待不能把相关历史失败解释为成功，失败范围溢出时保守返回不可用。
  入队拒绝独立计序号，等待同时捕获接收与拒绝水位；数据库范围解析期间的新拒绝不污染原统计，
  后续等待仍反映该缺口。失败范围溢出也按这两个水位判断，不放宽相关历史失败的降级。
- `request-metrics-database.ts`：集中保存指标 Schema 版本、固定路径和进程级独占锁；Gateway 与 reset
  共用独立 SQLite 锁库中的排他事务，由操作系统在进程退出时释放，不依赖 PID 或失效锁删除；真实
  运行中持有者与并发重建均失败关闭。
- `sqlite-request-metrics-row-codec.ts`：集中保存指标明细、Turn、Thread、聚合与压缩摘要的 SQLite
  Row 类型和纯领域映射，包括请求结果与额度窗口解析；不重解释历史完成状态。
- `sqlite-auto-approval-review-metrics.ts`：在同一指标连接保存官方自动审查 ID、通过/拒绝/超时/中止/进行中状态与轮次连续观测标记；按精确 `subagent_turns` 递归去重汇总本轮任务和当前会话累计，各分类、总次数与覆盖独立返回。无法区分的历史终态明确保留 unknown，不推成拒绝。不保存审查内容；重启、断线、写入失败和保留裁剪降级覆盖，不能从官方历史补齐缺失审查。Gateway 是唯一写入方，只读访问、清理、Provider prune 和 reset 沿用指标库边界。
- `sqlite-review-run-scope.ts`：共享任务精确根、会话四来源根及按父 Thread/Turn 递归的 UNION 去重片段，供审查摘要和指标写入失败归属使用；不持有数据库，不合并覆盖率判定或会话根 Thread 通配规则。
- `sqlite-quota-queries.ts`：封装周额度估算、最新额度与历史窗口归约；通过 Store 的同一连接和受跟踪迭代器读取，不创建连接或事务，不承担 Store 关闭及 Schema 生命周期。
- `sqlite-request-metrics-query-base.ts`：请求、Thread 与子代理查询共用的只读 Reader 端口、SQL 聚合片段及分页、范围、ID 校验；不依赖查询组件或组合根，不持有连接、事务或写入口。ID 校验同时供 Store 与自动审查写入使用。
  中断统计共用来源感知判定：未生成完成时，Relay 使用 `error_code`、原生代理使用 `error_type` 的 `client_disconnected`；缺失原因不视为中断。已完成生成的交付异常不改写生成结果，查询不回写历史记录。
- `sqlite-request-metrics-queries.ts`：请求分页、错误统计、日/小时汇总、Relay 调用方与 Key 的批量使用摘要及同步游标读取，并作为组合根持有线程域与子代理域查询；通过 Store 的读取与关闭检查端口执行，SQL 和行映射不介入写入、事务或数据库生命周期。
  错误聚合保留来源、提供商、模型、生成状态、HTTP 状态、错误类型和错误码维度；同组最新诊断按记录时间及行 ID 确定，有限组结果按全部分组维度稳定排序。CLI 与 WebUI 共用该投影，不修改存储 Schema。
  请求分页的 `isSubagent` 只读关联当前 `subagent_threads` 的精确 Thread 登记；Relay、自动审查及未登记归属返回 false，不代表已确认是主代理，不新增持久化字段。
  `modelUsage(scope, modelAliases?)` 在相同请求范围内按记录的模型和统计组跨提供商合并：可选映射以持久化模型 ID 做一次精确匹配，未配置的模型和 null 保持原值，自动审查同样归入其记录模型，不生成用途伪模型。同一组名在 SQLite 内先分组，再汇总请求、Token、状态、压缩和缓存指标及按 Thread/Turn 去重的轮数。每组的 `members` 按提供商与原始模型 ID 返回同范围的请求、Token、状态、压缩、缓存指标和去重轮数，原始模型 null 保留；组轮数独立去重，同一 Thread/Turn 的不同模型组或成员轮数不能相加。组与成员均完整返回，按请求量降序稳定排序，不沿用 CLI 的“提供商 + 模型”分组或前 20 组上限。控制台通过 `overview(range, modelAliases?).models` 在同一只读快照消费；分组不影响模型选择和明细展示，原始指标与请求详情用途保持原值。
  Thread 列表额外返回同筛选范围的 `totalTokens`、自身缓存与后代输入/缓存/输出分项，以及按请求去重的 `treeAggregate`，支持总计 Token 排序；缓存是输入子集，不重复累加，自身与后代分别判断缓存完整性。自身 `cacheUsage` 与后代 `subagentUsage.cacheUsage` 分别保留输入和缓存均已观测的缓存样本及缺失请求数，供部分采集时展示已知缓存；完整缓存合计仍在任意请求缺失时返回 null。WebUI 主会话查询允许只有后代匹配的根入选。普通 Thread 查询仍保留自身有匹配记录的行集合，自身聚合与 Turn 查询口径不变；不新增持久化汇总或 Schema 字段。
- `sqlite-request-metrics-thread-queries.ts`：Thread/Turn 列表、汇总与耗时查询，只被请求查询组合根持有；不接触写入、事务或数据库生命周期。代表会话或轮次的提供商、模型和思考等级只取相应范围内最近的普通响应（`source = owned`、`operation = response`、用途为空），不使用自动审查、压缩或后代请求兜底；有非审查请求但无普通响应时仍保留聚合与列表行，模型字段返回未知。子代理列表采用相同选择，单次轮次首 Token 时间、用量和请求统计均排除明确标记的审查请求。
- `sqlite-request-metrics-subagent-queries.ts`：子代理线程列表、单线程往返与同步游标查询，同样只被组合根持有并保持只读。
- `sqlite-request-metrics-schema.ts`：集中保存当前 Schema v32 建库 SQL、存储列定义、版本错误和
  严格结构校验；Store 持有初始化事务，仅在空库建表，已有非空库必须具有当前版本与结构。
- `sqlite-request-metrics-store.ts`：把脱敏后的 Provider、模型、状态、HTTP/传输格式、Usage、
  逐请求上游 `User-Agent` 和额度快照写入独立 `request-metrics.sqlite3`。新采集请求不解析上游时间戳；
  可空 `upstream_ttft_ms` 逐请求保留上游原值，Turn 汇总仅选择自身首个有效 OpenAI 普通响应样本，不合计或平均。
  `traffic_label`、`traffic_session`、`traffic_interaction` 全部为空或共同定位一次转储调用。
  可空 `request_purpose` 保存明确的 `autoApprovalReview` 用途，`reviewer_thread_id` / `reviewer_turn_id` 保存原始审查身份；父任务沿用 `thread_id` / `turn_id`，两者必须同时存在才归属。用途与原始身份独立于转储保存，请求筛选和导出复用相同字段，历史缺失不推断为普通请求，不关联或推断单次审批结果。
  可空 `total_duration_ms` 保存提交发送至首次模型终态或结束/失败的单调时钟耗时，支持明细排序与导出，不聚合为 Turn 耗时。
  可空 `request_bytes` 保存发往模型上游的请求正文或 WebSocket 请求帧字节合计；旧 v31 记录经更新器停服备份升级后保持 null，不从 Token、转储或历史耗时推算。
  可空 `quota_observed_at_ms` 保存额度快照的本机采集时间，未观测时为空。
  数据库使用严格 Schema v32、Unix `0600` / Windows 当前 SID 私有文件权限，
  可空 `request_service_tier` 独立保留出站请求层级。
  只接受当前 Schema；已有库先只读核验版本和结构，再保护权限、创建 Writer 锁与启用 WAL；不兼容库原样拒绝。
  首次初始化在单一事务内完成；使用 WAL
  允许后续只读查询与采集并行，锁等待限制为
  10 ms；同一 Store 还提供不获取写锁、不初始化或清理 Schema 的显式只读模式。
  可通过同步 `readSnapshot()` 让多个查询共用一个读事务，保持并发采集期间的结果一致；`iterateSnapshot()`
  跨迭代保留只读事务，完成、异常或提前 return 时释放。导出使用 `iterateExport()` 的单一 SQLite 游标，
  沿用普通分页的受控排序、null 与 id 次序，不在每批重复聚合或累积全部记录；只读 Worker 的归属、背压与取消由脚本消费端负责。
  普通分页每页最多 500 条，供 CLI 报表和本地 WebUI 复用。记录默认保留
  365 天、以 1,000,000 条为清理目标，可由 `[metrics.storage]` 收窄或扩大；保留期限始终按本机当前时钟计算，每 100 次写入分批清理，两个清理周期之间
  最多短暂超出 99 条。行数裁剪按 id 上界一次定位，不再对主键做倒序偏移扫描，因此只保证"不超过目标条数"
  并始终保留最新记录；按 Provider 单独清理等操作在 id 上留下空洞时，可能比目标少保留一部分最旧记录。
  每条记录保存提供商、模型、思考等级、服务层级、状态与错误类型；路由层在
  Thread 启动、恢复、切换或模型设置更新时维护思考等级，指标采集按 Thread 关联补齐。
  请求明细读取时直接从输入与缓存 Token 计算未缓存 Token 和缓存命中率，不保存派生列。
  首 Token、响应时间与总耗时从提交上游发送计时；生成区间保存思考、正文、工具参数与去重并集时长供诊断。查询方按已完成请求的总输出量除以总请求耗时计算平均输出速度，不把请求计时聚合为整轮耗时。采集和入库不依赖转储开关。
  `first_token_ms` 使用提交发送起点，只接受当前 Schema。
  内部读取限制为每次
  最多 500 条；精确 Thread 查询把
  最近 Turn 的运行聚合和指标库保留范围内的 Thread 会话累计分开返回，由
  Bootstrap 映射到 Application 的 `/metrics` 只读端口；会话归纳（模型、思考等级与 Token）
  递归纳入显式父 Thread 的子代理后代；`subagent_turns` 按子 Thread 与子 Turn
  保存运行级父 Turn 关系，父 Turn 任务合计只纳入这些精确运行关系；
  会话与每轮期间查询由 `threadList(query)`、`threadTurnSummaries(threadId, query)` 提供，先按请求
  记录时间及精确条件筛选，再按自身 Thread/Turn 汇总、排序和分页，返回匹配总数和不受分页影响的
  汇总；Provider 筛选支持单值或多值并集，`providers()` 返回库内完整去重名单供筛选选项使用。
  `threadTurnSummaries()` 另外返回同筛选范围、分页前的后代 `subagentAggregate`、按 Thread/Turn 去重的 `subagentTurnCount` 和会话加后代的 `treeAggregate`；递归关系只覆盖已登记后代，请求必须具有 Turn 归属，不改变自身轮次列表与聚合口径。精确 Turn 筛选时这三个字段均为 null，避免推断后代请求的父轮次归属；无匹配请求时聚合为 null、后代轮数为零。WebUI `/turns` 入口在同一读取快照中取得这些汇总和轮次分页。
  Provider、模型和思考等级只取同筛选范围内最近的普通响应（`source = owned`、`operation = response`、用途为空），不混入范围外的最新设置；无普通响应时保持未知。父 Turn 任务窄查询由
  `threadTurnTaskSummary()` 提供，子代理完成卡片通过 `threadTurnSummary()` 精确读取官方终态对应
  Turn，再按需合并该 Turn 的子任务；`threadList()` 与 `threadTurnSummaries()` 供
  `codexc metrics threads` 和 `turns` 导出复用。
  `subagents()` 从全部已登记关系读取各层子代理，`threadSubagents()` 限定为目标 Thread 的直接子代理；两者均包括尚无请求的代理，未指定父 Turn 时聚合各自全部保留请求的轮次、Token 与缓存指标，模型、提供商与思考等级共同取同范围最近的普通响应（`source = owned`、`operation = response`、用途为空；无普通响应时为 null），在数据库内按首次请求或最后记录排序后分页；会话列表的
  `directSubagentCount` 同样只计直接子级，不随请求筛选变化，不把关系导航混入指标聚合。
  每轮明细的 `directSubagentCount` 通过 `subagent_turns` 精确父 Thread/Turn 关联并验证直接父关系后，按不同子 Thread 计数；`threadSubagents()` 的可选 `parentTurnId` 使用相同关系筛选，行用量、请求数、代表模型、时间排序、分页前汇总与模型分布均只纳入这些精确子 Thread/Turn 的请求，不混入同一代理其他调用的历史。全局 `subagents()` 拒绝该字段。
  子代理行的 `executionTiming` 仅累计 `turn_execution_metrics` 的官方耗时，`durationMs` 返回已知部分（无已知值或累计超出安全整数时为 null），`observedTurnCount` 返回范围内轮数，`missingDurationTurnCount` 保留缺失数；它不使用请求耗时推算。父 Turn 查询按全部精确关系轮次统计，缺失执行行也计入缺失，`historyComplete` 同时要求这些关系均已有官方执行行且 `thread_execution_state` 已确认历史完整；断开或恢复尚未补齐时保留已知值但标记部分累计；其余查询按全部自身保留执行轮次统计，完整性沿用 `thread_execution_state`。有已知累计不代表完整总耗时。
  父 Turn 查询同时返回每个代理最多 100 个精确 `turnIds` 和显式 `turnIdsTruncated`；截断只限制导航信息，不裁剪聚合。其他查询的 `turnIds` 为 null，`turnIdsTruncated` 为 false。行的 `parentTurnId` 在父 Turn 查询中保持当前查询范围，其他查询沿用线程关系登记值。
  WebUI 顶层列表通过 `mainThreadsOnly` 在汇总和分页前排除已登记子代理；CLI 导出与控制台仍查询全部会话。
  会话列表的 `sessionTiming` 批量读取当前页各会话全部自身保留轮次的官方耗时，保留缺失轮数与历史完整性，不受请求筛选影响、不叠加后代。
  请求、Turn、Thread、任务树、子代理、压缩与趋势汇总保留 Token 已知值之和，同时返回必填 `usageCoverage`，分别统计输入、输出、推理字段缺失的请求数；数值为 0 不代表字段已采集，须结合请求数和覆盖判断。Thread 列表的后代 `subagentUsage` 独立返回请求数与覆盖，子代理页的列表、summary 和 modelUsage 同样保留覆盖。单条原始请求的可空字段不变，不回填历史。
  全局、提供商、模型、请求页汇总与趋势额外返回 `reviewUsage`，包含明确标记为 `autoApprovalReview` 的请求数、输入、输出已知合计及三项缺失数；它是总量的子集，不能再次累加。请求用途筛选只接受 `unmarked` 和 `autoApprovalReview`，前者严格查询 `request_purpose IS NULL`，不代表已确认普通请求。Turn、Thread、任务树及子代理维持排除明确审查请求的范围。
  时间范围聚合覆盖指标库全部保留记录，可按全局、提供商或“提供商 + 模型”分组；支持 `today`、`yesterday`、`24h`、`7d`、`30d`、`90d`、`all` 和自定义日期范围。提供商组完整返回；CLI 的“提供商 + 模型”分组最多返回请求量最高的 20 组，并返回完整组数。OpenAI 请求还可保存统计代理归一化的周额度定点快照与账户套餐等级；
  同一重置周期内
  从首个基线开始累计请求，只在后续快照超过该周期已观测最高比例时形成加权估算区间；
  同周期回退不降低基线，不同周期快照断开区间。估算仅使用闭合区间，周期请求总量另行累计。
  快照估算、最新额度及额度历史优先按采集时间排序；未观测采集时间的样本按入库时间近似排序，
  不把入库时间写回为采集时间。请求明细与导出保留两种时间。
  WebSocket 上游握手失败和 WS 内包装错误事件（如 429 usage_limit_reached）作为实际请求的失败记录落库，
  保留已观测 HTTP 状态、提供商、模型与受限错误分类、代码，不保留上游错误正文。Gateway 的 Turn 级错误独立记录诊断日志，不再生成模型请求；
  历史混入记录没有可靠区分标识，原样保留，不按空用量或错误码猜测排除。账户快照历史使用
  相同的保留期限清理，但每个账户源保留最新一条确认状态，避免把历史到期误作订阅恢复；OpenCode Go 账户窗口的本机 Token 汇总按精确
  Provider 对相关时间范围执行一次流式读取，不复用带总数统计的页面查询。
  普通 `/responses` 上由受控元数据标记的 remote compaction v2
  以 `operation = 'compact'` 独立分类，但其请求、Usage 与额度快照仍参与汇总、异常报告、
  会话指标和周额度估算；Turn、Thread 及时间范围聚合还从相同明细派生独立压缩摘要，不新增或
  复制持久化数据。当前锁定 Codex 0.163.0 的 `request_kind=prewarm` 是 `generate=false` 的 WebSocket
  连接预热而非模型推理，Provider Proxy 不将其写入本指标库，因此不会扩大请求、Token 或
  错误率分母。所有合计仍在 SQLite 内完成，不把缺失缓存字段当成零。期间汇总与 Thread 列表额外返回 `cacheUsage`，
  包含输入及缓存字段均已提供的样本对应的缓存和输入合计，以及缺失任一字段的请求数；
  WebUI 用它呈现已知缓存量与样本命中率，原有完整缓存合计字段保留其语义。
  采集器显式记录未观测响应的 `incomplete/response_not_observed`，查询不根据 Usage 缺失推断完成状态。
  查询摘要的 `requestOutcomes` 从记录状态和错误类型区分成功、中断、失败与未完成，未知状态归未完成；客户端提前断开的原始状态与错误类型不变，`unsuccessfulRequestCount` 保留全部非成功请求的语义。
  Thread/Turn 查询的 `failures` 排序按四类中的失败数，不把中断或未完成纳入失败排序。
  Turn 与会话累计的 `interruptionSummary` 在所选请求范围内按 Thread/非空 Turn 分区，以真实响应完成时间判定中断后同轮是否有成功请求，严格排除相同或更早的完成时间，不推断重试或因果恢复；输入或输出用量缺失的中断另计覆盖数，已知部分继续汇总。时间范围查询不会使用范围外记录判定后续成功。
  异常查询以同一时间范围内全部模型请求作为分母，只把
  非完成状态按提供商、模型、状态、HTTP 状态和错误类型分组，返回出现次数、最近发生时间及总分组数，
  最多展示出现次数最高的 20 组。

其他模块应注入并复用该 Logger，不应自行创建不受控日志通道。`logging.level = "debug"` 或
`"trace"` 启用全局调试模式；调试日志只记录受约束的模块、类型、阶段、耗时与结果，不记录消息
正文、JSON-RPC 参数或结果、上游响应、凭据、敏感表单或审批内容。异常日志可以保留受约束的操作
上下文，但不得输出完整认证请求。逐 Token 文本增量以及未处理的 `delta`、`outputDelta` 和
`progress` 通知不逐条记录，避免调试模式造成无界日志放大；对应完成态、路由结果与请求耗时仍保留。

模型指标库不属于会话 `StateStore`，不保存消息、提示词、请求/响应正文、图片、识别结果、工具
参数、凭据或上游响应 ID。`provider-proxy` 生成 Codex Provider 脱敏样本；历史无 Turn 记录仅参与
通用明细与时间范围聚合，不再建立单独的直接 API 会话分栏。本模块不依赖代理、App Server
协议、Surface 或业务 Storage。本模块不直接暴露 HTTP API；`codexc metrics` 的
`report`、`export`、`run`、`turns`、`threads` 只通过本地只读连接输出 Markdown、JSON 或 CSV；
WebUI 还通过同一只读 Store 的 `daily()` / `hourly()` 按系统本地日期或钟表小时聚合请求；
查询服务 `trend()` 为今天、昨天和自定义单日返回补零的小时统计，其他范围返回日统计。
热力图固定展示含今天的最近 90 天，趋势图跟随控制台汇总范围；
`report` 与 `export` 同时输出未过期的最后 OpenAI 周额度区间；`codexc webui` 的服务端通过只读
HTTP API 复用相同查询，不向本模块写入状态。只接受当前 Schema v32，不在启动或查询时自动迁移。
保留 v31 历史时，`codexc update` 在只读检查后停止原运行服务，调用包内
`scripts/metrics-database-upgrade.mjs` 建立私有完整备份并执行单事务转换，再完成程序切换与服务恢复；
`database-upgrades/metrics-to-v32.mjs` 作为显式离线入口复用同一实现。
其他写入方必须先退出；未知结构拒绝，历史记录新增的请求发送大小为 null。
指标采集始终开启，不受全局调试模式影响；`debug` / `trace` 只增加脱敏的关联诊断，写入失败仍按
`warn` 输出，避免关闭调试后形成历史数据断档或隐藏采集故障。


Relay 指标保存真实 source/caller/key/代次/请求 UUID 与交付字段，关联 label=relay.chat 或 relay.responses 的完整转储定位；Thread/Turn 必须为空，
唯一索引去重同一次调用。写入队列保留自有流量空间，Relay 至多占 256 个待写位置；IPC 接收确认只代表入队。
