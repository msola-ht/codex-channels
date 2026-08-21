# Observability

本目录提供 Gateway 的结构化日志和模型请求指标持久化入口。

## 文件

- `index.ts`：本模块的公开导出入口。
- `logger.ts`：根据配置创建 Pino Logger，并对 Token、App Secret、Authorization、Cookie、密码等
  字段进行脱敏；`err` 和进程边界复用 `safeErrorMetadata`，只保留受约束的异常类型和机器错误码，
  不保留 message、stack 或附加响应对象。
- `request-metrics.ts`：定义与 Provider 实现无关的单次模型请求指标、存储端口、内部查询结果，以及
  窄 `ModelPricingResolver` 端口。计价解析器按 Provider、模型、服务层级、输入规模和请求开始
  时间返回当次价格快照；远程目录与缓存实现留在 Bootstrap，未匹配价格时计价字段保持 `NULL`。
- `request-metrics-writer.ts`：提供 10,000 条上限的有界延迟写入队列；指标 Socket 只负责入队，
  每 10 ms 最多同步写入 1 条，关闭时排空，避免 SQLite 位于模型响应确认路径并限制单轮事件循环阻塞；
  公开持久化水位只等待调用时已经入队的记录，不被后续新记录无限延长，并按 Thread 返回该水位内
  的实际写入结果。
- `metrics-sync.ts`：把本地指标库的请求记录与子代理标注增量上报到中心服务。读取
  `MetricsSyncConfig`，自动生成或复用设备标识，持久化 `0600` 水位文件，按间隔与指数退避
  定时上报，429/5xx 且服务端返回 `Retry-After` 时优先按服务端要求延后；只有收到
  HTTP 2xx 才推进水位。载荷只含脱敏指标，不上传 `errorMessage`，不包含消息正文、提示词
  或审批内容；本模块不依赖代理、Surface 或业务 Storage，网络与状态路径由 Bootstrap 注入。
- `request-metrics-database.ts`：集中保存指标 Schema、固定路径和进程级独占锁；Gateway 与 reset
  共用独立 SQLite 锁库中的排他事务，由操作系统在进程退出时释放，不依赖 PID 或失效锁删除；真实
  运行中持有者与并发重建均失败关闭。升级时会检查旧 JSON 锁：失效 PID、Linux 跨系统重启遗留锁
  和超过保护期的残缺锁可清理；近期残缺锁、仍在运行的旧 Gateway，以及非 Linux 上 PID 仍存活的
  旧锁继续失败关闭。
- `sqlite-request-metrics-store.ts`：把脱敏后的 Provider、模型、状态、HTTP/传输格式、Usage、上游
  时间戳与本机流式阶段时间戳
  写入独立 `request-metrics.sqlite3`。当前 Thread 的独立 API 查询只选择调用适配器产生的
  HTTP JSON 记录，不能把缺少 Turn 元数据的 Codex WebSocket/SSE 代理请求误分类。数据库使用
  严格 Schema v10、`0600` 文件权限，只接受当前
Schema；首次初始化在单一事务内完成；使用 WAL 允许后续只读查询与采集并行，锁等待限制为
  10 ms；同一 Store 还提供不获取写锁、不初始化或清理 Schema 的显式只读模式，以及每页最多
  500 条、按受控字段与方向排序的偏移分页，供 CLI 报表、导出和本地 WebUI 复用。记录默认保留
  365 天、以 1,000,000 条为清理目标，可由 `[metrics.storage]` 收窄或扩大；每 100 次写入分批清理，两个清理周期之间
  最多短暂超出 99 条。每条记录保存提供商、模型、思考等级、服务层级、状态与错误类型；路由层在
  Thread 启动、恢复、切换或模型设置更新时维护思考等级，指标采集按 Thread 关联补齐。
  `model_request_metrics_enriched` View 统一派生总耗时、TTFT、推理/输出/生成
  阶段耗时、收尾间隔、缓存与不含推理的 Token、缓存命中率、三类生成速度，以及按当次价格快照计算的
  输入/缓存/输出和总费用。价格以每百万 Token 的十亿分之一币种单位保存，费用同样使用十亿分之一
  币种单位，避免浮点金额落库和历史价格回算。内部读取限制为每次最多 500 条；精确 Thread 查询把
  最近 Turn 的运行聚合、指标库保留范围内的 Thread 会话累计和最近一条无 Turn 的直接 API 请求分开返回，由
  Bootstrap 映射到 Application 的 `/metrics` 只读端口；会话归纳（模型、思考等级、Token 与费用）
  递归纳入显式父 Thread 的子代理后代，父 Turn 任务合计只纳入显式 `parent_turn_id` 关联；
  与每次对话明细查询由 `threadList()`、`threadTurnSummaries()` 提供，父 Turn 任务窄查询由
  `threadTurnTaskSummary()` 提供完成卡片窄查询；`threadList()` 与 `threadTurnSummaries()` 供
  `codexc metrics threads` 和 `turns` 导出复用。时间范围聚合统一覆盖 Codex Provider 与
  直接 API，可按全局、提供商或“提供商 + 模型”分组；支持自然日/周/月、24 小时至 365 天滚动窗口、全部保留历史和 CLI 自定义日期范围，最多
  返回请求量最高的 20 组。OpenAI 请求还可保存统计代理归一化的周额度定点快照与账户套餐等级；
  同一重置周期内
  从首个基线开始累计请求，只在后续快照正向增长时形成加权估算区间，重置或倒退会断开区间。
  WebSocket 上游握手失败、WS 内包装错误事件（如 429 usage_limit_reached）与 Gateway 层未发起
  上游请求的 Turn 级失败（如用量上限）也以 failed 记录落库：前者保留 HTTP 状态，后者无 Token
  与费用；失败记录还保存提供商、模型与受限长度的错误消息，供 WebUI 与导出展示详情。
  旧版 `/responses/compact` 与普通 `/responses` 上由受控元数据标记的 remote compaction v2
  都以 `operation = 'compact'` 独立分类，但其请求、Usage、费用与额度快照仍参与汇总、异常报告、
  会话指标和周额度估算；Turn、Thread 及时间范围聚合还从相同明细派生独立压缩摘要，不新增或
  复制持久化数据。综合输出速度只使用同时具有非推理输出 Token 与输出时间窗的请求；
  首段回复延迟只使用有效 TTFT 样本，并返回平均、P50、P95 和覆盖计数。所有合计仍在 SQLite 内完成，
  费用也按同币种快照求和并返回计价请求数；只有聚合范围内三类每百万 Token 单价分别一致时才
  返回统一单价，否则标记为多档价格，不把缺失价格、计时或缓存字段当成零；不同币种不强行合计。
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
参数、凭据或上游响应 ID。`provider-proxy` 生成 Codex Provider 脱敏样本；指标 Schema 仍可读取
历史直接 API 样本，但当前没有新的直接 API 调用方。本模块不依赖代理、App Server
协议、Surface 或业务 Storage。本模块不直接暴露 HTTP API；`codexc metrics` 的
`report`、`export`、`run`、`turns`、`threads` 只通过本地只读连接输出 Markdown、JSON 或 CSV；
`report` 与 `export` 同时输出未过期的最后 OpenAI 周额度区间；`codexc webui` 的服务端通过只读
HTTP API 复用相同查询，不向本模块写入状态。Schema v3/v4/v5/v6/v7/v8/v9 可在停止 Gateway 后用
`codexc update` 统一预检，并先创建 `0600` 备份再逐版本事务升级到 v10 并保留原记录；v8 升级
v9 为 OpenCode Go 窗口快照新增 `quota_windows` 列，v9 升级 v10 为 `subagent_threads` 新增可空
`parent_turn_id`。历史 NULL 不按时间推断父 Turn；递归会话累计使用显式父 Thread 关系，父 Turn
任务合计只使用显式父 Turn 关系。单库排障可用
`codexc metrics upgrade`。未知版本继续失败关闭，
使用 `codexc metrics reset` 归档后重建，不执行隐式迁移。
指标采集始终开启，不受全局调试模式影响；`debug` / `trace` 只增加脱敏的关联诊断，写入失败仍按
`warn` 输出，避免关闭调试后形成历史数据断档或隐藏采集故障。
