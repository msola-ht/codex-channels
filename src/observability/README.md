# Observability

本目录提供 Gateway 的结构化日志和模型请求指标持久化入口。

## 文件

- `index.ts`：本模块的公开导出入口。
- `logger.ts`：根据配置创建 Pino Logger，并对 Token、App Secret、Authorization、Cookie、密码等
  字段进行脱敏；`err` 和进程边界复用 `safeErrorMetadata`，只保留受约束的异常类型和机器错误码，
  不保留 message、stack 或附加响应对象。
- `request-metrics.ts`：定义与 Provider 实现无关的单次模型请求指标、存储端口和内部查询结果；
  新采集指标以请求归属、模型、状态、Token、错误分类与额度快照为主，不包含价格快照、响应正文
  或流式阶段时间。
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
- `sqlite-request-metrics-schema.ts`：集中保存当前 Schema v12 建库 SQL、存储列定义、版本错误和
  严格结构校验；Store 继续持有初始化事务，停机升级继续由指标脚本管理。
- `sqlite-request-metrics-store.ts`：把脱敏后的 Provider、模型、状态、HTTP/传输格式、Usage 和
  额度快照写入独立 `request-metrics.sqlite3`。新采集请求不再解析上游时间戳或流式阶段时间戳；
  现有计时列与派生 View 暂时保留，用于读取历史数据并避免本次精简引入 Schema 迁移。当前 Thread
  的独立 API 查询只选择调用适配器产生的
  HTTP JSON 记录，不能把缺少 Turn 元数据的 Codex WebSocket/SSE 代理请求误分类。数据库使用
  严格 Schema v12、Unix `0600` / Windows 当前 SID 私有文件权限，只接受当前 Schema；首次初始化在单一事务内完成；使用 WAL
  允许后续只读查询与采集并行，锁等待限制为
  10 ms；同一 Store 还提供不获取写锁、不初始化或清理 Schema 的显式只读模式，以及每页最多
  500 条、按受控字段与方向排序的偏移分页，供 CLI 报表、导出和本地 WebUI 复用。记录默认保留
  365 天、以 1,000,000 条为清理目标，可由 `[metrics.storage]` 收窄或扩大；每 100 次写入分批清理，两个清理周期之间
  最多短暂超出 99 条。每条记录保存提供商、模型、思考等级、服务层级、状态与错误类型；路由层在
  Thread 启动、恢复、切换或模型设置更新时维护思考等级，指标采集按 Thread 关联补齐。
  `model_request_metrics_enriched` View 继续为历史记录派生旧计时字段，并统一派生缓存与不含推理的
  Token、缓存命中率；人类可读 CLI、渠道卡片和 WebUI 页面不再展示总耗时、首段回复延迟或生成速度。内部读取限制为每次
  最多 500 条；精确 Thread 查询把
  最近 Turn 的运行聚合、指标库保留范围内的 Thread 会话累计和最近一条无 Turn 的直接 API 请求分开返回，由
  Bootstrap 映射到 Application 的 `/metrics` 只读端口；会话归纳（模型、思考等级与 Token）
  递归纳入显式父 Thread 的子代理后代；Schema v11 的 `subagent_turns` 按子 Thread 与子 Turn
  保存运行级父 Turn 关系，父 Turn 任务合计只纳入这些精确运行关系；
  与每次对话明细查询由 `threadList()`、`threadTurnSummaries()` 提供，父 Turn 任务窄查询由
  `threadTurnTaskSummary()` 提供，子代理完成卡片通过 `threadTurnSummary()` 精确读取官方终态对应
  Turn，再按需合并该 Turn 的子任务；`threadList()` 与 `threadTurnSummaries()` 供
  `codexc metrics threads` 和 `turns` 导出复用。时间范围聚合统一覆盖 Codex Provider 与
  直接 API，可按全局、提供商或“提供商 + 模型”分组；支持自然日/周/月、24 小时至 365 天滚动窗口、全部保留历史和 CLI 自定义日期范围，最多
  返回请求量最高的 20 组。OpenAI 请求还可保存统计代理归一化的周额度定点快照与账户套餐等级；
  同一重置周期内
  从首个基线开始累计请求，只在后续快照正向增长时形成加权估算区间，重置或倒退会断开区间。
  WebSocket 上游握手失败、WS 内包装错误事件（如 429 usage_limit_reached）与 Gateway 层未发起
  上游请求的 Turn 级失败（如用量上限）也以 failed 记录落库：前者保留 HTTP 状态，后者无 Token
  失败记录还保存提供商、模型与受限长度的错误消息，供 WebUI 与导出展示详情。账户快照历史使用
  相同的保留期限清理，避免按需刷新长期无界累积；OpenCode Go 账户窗口的本机 Token 汇总按精确
  Provider 对相关时间范围执行一次流式读取，不复用带总数统计的页面查询。
  旧版 `/responses/compact` 与普通 `/responses` 上由受控元数据标记的 remote compaction v2
  都以 `operation = 'compact'` 独立分类，但其请求、Usage 与额度快照仍参与汇总、异常报告、
  会话指标和周额度估算；Turn、Thread 及时间范围聚合还从相同明细派生独立压缩摘要，不新增或
  复制持久化数据。当前锁定 Codex 0.153.4 的 `request_kind=prewarm` 是 `generate=false` 的 WebSocket
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
参数、凭据或上游响应 ID。`provider-proxy` 生成 Codex Provider 脱敏样本；指标 Schema 仍可读取
历史直接 API 样本，但当前没有新的直接 API 调用方。本模块不依赖代理、App Server
协议、Surface 或业务 Storage。本模块不直接暴露 HTTP API；`codexc metrics` 的
`report`、`export`、`run`、`turns`、`threads` 只通过本地只读连接输出 Markdown、JSON 或 CSV；
WebUI 还通过同一只读 Store 按 UTC 日聚合最近 90 天请求，供本地热力图和趋势图展示；
`report` 与 `export` 同时输出未过期的最后 OpenAI 周额度区间；`codexc webui` 的服务端通过只读
HTTP API 复用相同查询，不向本模块写入状态。Schema v3/v4/v5/v6/v7/v8/v9/v10 可在停止 Gateway 后用
`codexc update` 统一预检，并先创建 `0600` 备份再逐版本事务升级到 v12 并保留原记录；v8 升级
v9 为 OpenCode Go 窗口快照新增 `quota_windows` 列，v9 升级 v10 为 `subagent_threads` 新增可空
`parent_turn_id`，v10 升级 v11 新增运行级 `subagent_turns`，v11 升级 v12 新增账户源与账户快照表。历史 NULL 和 v10 以前不存在的运行关系
均不按时间推断；递归会话累计继续使用显式父 Thread 关系，父 Turn 任务合计只使用 v11 起记录的
精确父子 Turn 关系。单库排障可用
`codexc metrics upgrade`。未知版本继续失败关闭，
使用 `codexc metrics reset` 归档后重建，不执行隐式迁移。
指标采集始终开启，不受全局调试模式影响；`debug` / `trace` 只增加脱敏的关联诊断，写入失败仍按
`warn` 输出，避免关闭调试后形成历史数据断档或隐藏采集故障。
