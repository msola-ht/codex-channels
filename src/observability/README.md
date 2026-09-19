# Observability

本目录提供 Gateway 的结构化日志和模型请求指标持久化入口。

## 文件

- `index.ts`：本模块的公开导出入口。
- `query/index.ts`：供 CLI 参数预检使用的无状态公开入口，只导出范围、日期、筛选和聚合维度解析，
  不加载 SQLite 实现；其他业务模块仍通过模块根入口访问完整能力。
- `logger.ts`：根据配置创建 Pino Logger，并对 Token、App Secret、Authorization、Cookie、密码等
  字段进行脱敏；`err` 和进程边界复用 `safeErrorMetadata`，只保留受约束的异常类型和机器错误码，
  不保留 message、stack 或附加响应对象。
- `request-metrics.ts`：定义与 Provider 实现无关的单次模型请求指标、内部查询结果，以及写入、普通
  请求查询、Thread/Subagent 查询、Quota/Account Snapshot 四类窄存储端口；组合接口只供同一
  SQLite 实现声明完整能力，各消费方按实际用途依赖窄端口。
  新采集指标以请求归属、模型、状态、Token、错误分类与额度快照为主，不包含价格快照或请求/响应正文；
  `firstContentMs` 保留代理单请求首内容延迟，`upstreamTtftMs` 独立保留 OpenAI 轮次首 Token 统计，
  `requestModel` 与 `responseModel` 分别保留请求和响应回显名称；可空 `traffic` 只保存转储标签、实际批次与调用编号，不包含正文或文件路径。
- `request-metrics-query-service.ts`：在只读 Store 之上统一滚动时间范围、本地今天/昨天、自定义日期、请求筛选、聚合维度以及
  会话、请求、异常、趋势和额度查询；Bootstrap、`codexc metrics` 与 WebUI 复用同一查询语义，
  各自只负责授权、参数边界和结果呈现。
- `request-metrics-writer.ts`：提供 10,000 条上限的有界延迟写入队列；指标 Socket 只负责入队，
  每 10 ms 最多取 32 条并优先在一个 SQLite 事务中写入，关闭时排空，减少逐请求事务开销；公开
  持久化水位只等待调用时该 Thread 或 Turn 已经入队的最后一条记录，不被后续无关请求延长，并
  返回该范围内的实际写入结果。
- `request-metrics-database.ts`：集中保存指标 Schema 版本、固定路径和进程级独占锁；Gateway 与 reset
  共用独立 SQLite 锁库中的排他事务，由操作系统在进程退出时释放，不依赖 PID 或失效锁删除；真实
  运行中持有者与并发重建均失败关闭。升级时会检查旧 JSON 锁：失效 PID、Linux 跨系统重启遗留锁
  和超过保护期的残缺锁可清理；近期残缺锁、仍在运行的旧 Gateway，以及非 Linux 上 PID 仍存活的
  旧锁继续失败关闭。
- `sqlite-request-metrics-row-codec.ts`：集中保存指标明细、Turn、Thread、聚合与压缩摘要的 SQLite
  Row 类型和纯领域映射，包括历史未观测响应归一化与额度窗口解析。
- `sqlite-request-metrics-schema.ts`：集中保存当前 Schema v18 建库 SQL、存储列定义、版本错误和
  严格结构校验；Store 继续持有初始化事务，停机升级继续由指标脚本管理。
- `sqlite-request-metrics-store.ts`：把脱敏后的 Provider、模型、状态、HTTP/传输格式、Usage、
  逐请求上游 `User-Agent` 和额度快照写入独立 `request-metrics.sqlite3`。新采集请求不解析上游时间戳；
  Schema v14 已删除对应旧计时列、价格与成本列及派生 View。数据库使用
  Schema v15 增加可空 `upstream_ttft_ms`，逐请求保留上游原值，Turn 汇总仅选择自身首个有效 OpenAI
  普通响应样本，不合计或平均。Schema v16 增加可空 `first_content_ms`、`request_model`、`response_model`。
  Schema v17 增加可空 `traffic_label`、`traffic_session`、`traffic_interaction`，三字段全部为空或共同定位一次转储调用。
  Schema v18 增加可空 `total_duration_ms`，逐请求保存代理入口至首次模型终态或结束/失败的单调时钟总耗时，支持明细排序与导出，不聚合为 Turn 耗时；升级保留 v17 调用关联，历史总耗时为 NULL。
  数据库使用严格 Schema v18、Unix `0600` / Windows 当前 SID 私有文件权限，
  只接受当前 Schema；首次初始化在单一事务内完成；使用 WAL
  允许后续只读查询与采集并行，锁等待限制为
  10 ms；同一 Store 还提供不获取写锁、不初始化或清理 Schema 的显式只读模式。
  可通过同步 `readSnapshot()` 让多个查询共用一个读事务，保持并发采集期间的结果一致；分页每页最多
  500 条、按受控字段与方向排序的偏移分页，供 CLI 报表、导出和本地 WebUI 复用。记录默认保留
  365 天、以 1,000,000 条为清理目标，可由 `[metrics.storage]` 收窄或扩大；每 100 次写入分批清理，两个清理周期之间
  最多短暂超出 99 条。每条记录保存提供商、模型、思考等级、服务层级、状态与错误类型；路由层在
  Thread 启动、恢复、切换或模型设置更新时维护思考等级，指标采集按 Thread 关联补齐。
  请求明细读取时直接从输入与缓存 Token 计算未缓存 Token 和缓存命中率，不保存派生列；人类可读 CLI、
  渠道卡片和 WebUI 页面展示派生 `tokensPerSecond`：单请求输出 Token 除以总耗时秒数，Turn/Thread 为范围内有效请求速率的算术平均，仅输出与耗时都大于零的记录参与，不新增存储列；不是纯生成速度或会话墙钟吞吐量。单请求首内容不合成为轮次指标，完成卡片的官方 Turn 总耗时
  不来自本指标库。内部读取限制为每次
  最多 500 条；精确 Thread 查询把
  最近 Turn 的运行聚合和指标库保留范围内的 Thread 会话累计分开返回，由
  Bootstrap 映射到 Application 的 `/metrics` 只读端口；会话归纳（模型、思考等级与 Token）
  递归纳入显式父 Thread 的子代理后代；Schema v11 的 `subagent_turns` 按子 Thread 与子 Turn
  保存运行级父 Turn 关系，父 Turn 任务合计只纳入这些精确运行关系；
  会话与每轮期间查询由 `threadList(query)`、`threadTurnSummaries(threadId, query)` 提供，先按请求
  记录时间及精确条件筛选，再按自身 Thread/Turn 汇总、排序和分页，返回匹配总数和不受分页影响的
  汇总；Provider 筛选支持单值或多值并集，`providers()` 返回库内完整去重名单供筛选选项使用。
  Provider、模型和思考等级取匹配范围内最后一条记录，不混入范围外的最新设置。父 Turn 任务窄查询由
  `threadTurnTaskSummary()` 提供，子代理完成卡片通过 `threadTurnSummary()` 精确读取官方终态对应
  Turn，再按需合并该 Turn 的子任务；`threadList()` 与 `threadTurnSummaries()` 供
  `codexc metrics threads` 和 `turns` 导出复用。时间范围聚合覆盖指标库全部保留记录，
  可按全局、提供商或“提供商 + 模型”分组；支持 `today`、`yesterday`、`24h`、`7d`、`30d`、`90d`、`all` 和自定义日期范围，最多
  返回请求量最高的 20 组。OpenAI 请求还可保存统计代理归一化的周额度定点快照与账户套餐等级；
  同一重置周期内
  从首个基线开始累计请求，只在后续快照正向增长时形成加权估算区间，重置或倒退会断开区间。
  WebSocket 上游握手失败、WS 内包装错误事件（如 429 usage_limit_reached）与 Gateway 层未发起
  上游请求的 Turn 级失败（如用量上限）也以 failed 记录落库：前者保留 HTTP 状态，后者无 Token
  失败记录还保存提供商、模型与受限长度的错误消息，供 WebUI 与导出展示详情。账户快照历史使用
  相同的保留期限清理，但每个账户源保留最新一条确认状态，避免把历史到期误作订阅恢复；OpenCode Go 账户窗口的本机 Token 汇总按精确
  Provider 对相关时间范围执行一次流式读取，不复用带总数统计的页面查询。
  旧版 `/responses/compact` 与普通 `/responses` 上由受控元数据标记的 remote compaction v2
  都以 `operation = 'compact'` 独立分类，但其请求、Usage 与额度快照仍参与汇总、异常报告、
  会话指标和周额度估算；Turn、Thread 及时间范围聚合还从相同明细派生独立压缩摘要，不新增或
  复制持久化数据。当前锁定 Codex 0.154.0 的 `request_kind=prewarm` 是 `generate=false` 的 WebSocket
  连接预热而非模型推理，Provider Proxy 不将其写入本指标库，因此不会扩大请求、Token 或
  错误率分母。所有合计仍在 SQLite 内完成，不把缺失缓存字段当成零。
  查询时还会把旧库中 HTTP 200、响应格式未知且没有模型或 Usage 的普通响应历史“完成”记录归一为
  `incomplete/response_not_observed`；客户端提前断开仍保持独立失败类型。异常查询以同一时间范围内全部模型请求作为失败率分母，只把
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
HTTP API 复用相同查询，不向本模块写入状态。Schema v3 至 v17 可在停止 Gateway 后用
`codexc update` 统一预检，并先创建 `0600` 备份再在单一事务中升级到 v18；请求、子代理关系和账户快照
均保留，模型请求表只复制 v18 仍支持的字段，新增字段为 NULL、已有 TTFT、首内容与模型名称保留；历史转储关联不按时间猜配，并删除价格、成本、旧计时列和派生 View。v8 升级
v9 为 OpenCode Go 窗口快照新增 `quota_windows` 列，v9 升级 v10 为 `subagent_threads` 新增可空
`parent_turn_id`，v10 升级 v11 新增运行级 `subagent_turns`，v11 升级 v12 新增账户源与账户快照表，
v12 升级 v13 新增记录实际发往模型上游 `User-Agent` 的可空 `user_agent` 列。历史 NULL 和 v10 以前不存在的运行关系
均不按时间推断；递归会话累计继续使用显式父 Thread 关系，父 Turn 任务合计只使用 v11 起记录的
精确父子 Turn 关系。单库排障可用
`codexc metrics upgrade`。未知版本继续失败关闭，
使用 `codexc metrics reset` 归档后重建，不执行隐式迁移。
指标采集始终开启，不受全局调试模式影响；`debug` / `trace` 只增加脱敏的关联诊断，写入失败仍按
`warn` 输出，避免关闭调试后形成历史数据断档或隐藏采集故障。
