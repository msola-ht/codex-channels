# Observability

本目录提供 Gateway 的结构化日志和模型请求指标持久化入口。

## 文件

- `index.ts`：本模块的公开导出入口。
- `logger.ts`：根据配置创建 Pino Logger，并对 Token、App Secret、Authorization、Cookie、密码等
  字段进行脱敏；`err` 和进程边界复用 `safeErrorMetadata`，只保留受约束的异常类型和机器错误码，
  不保留 message、stack 或附加响应对象。
- `request-metrics.ts`：定义与 Provider 实现无关的单次模型请求指标、存储端口、内部查询结果，以及
  后续 Setup 可实现的窄 `ModelPricingResolver` 端口。计价解析器按 Provider、模型、服务层级和
  请求完成时间返回当次价格快照；当前不内置模型价格，未注入解析器时计价字段保持 `NULL`。
- `request-metrics-writer.ts`：提供 10,000 条上限的有界延迟写入队列；指标 Socket 只负责入队，
  每 10 ms 最多同步写入 1 条，关闭时排空，避免 SQLite 位于模型响应确认路径并限制单轮事件循环阻塞。
- `sqlite-request-metrics-store.ts`：把脱敏后的 Provider、模型、状态、HTTP/传输格式、Usage、上游
  时间戳与本机流式阶段时间戳
  写入独立 `request-metrics.sqlite3`。数据库使用严格 Schema v2、`0600` 文件权限，只接受当前
  Schema；首次初始化在单一事务内完成；使用 WAL 允许后续只读查询与采集并行，锁等待限制为
  10 ms；记录保留 30 天，以 100,000 条为清理目标，每 100 次写入分批清理，两个清理周期之间
  最多短暂超出 99 条。`model_request_metrics_enriched` View 统一派生总耗时、TTFT、推理/输出/生成
  阶段耗时、收尾间隔、缓存与非推理 Token、缓存命中率、三类生成速度，以及按当次价格快照计算的
  输入/缓存/输出和总费用。价格以每百万 Token 的十亿分之一币种单位保存，费用同样使用十亿分之一
  币种单位，避免浮点金额落库和历史价格回算。内部读取限制为每次最多 500 条，为后续展示层保留
  稳定边界。

其他模块应注入并复用该 Logger，不应自行创建不受控日志通道。`logging.level = "debug"` 或
`"trace"` 启用全局调试模式；调试日志只记录受约束的模块、类型、阶段、耗时与结果，不记录消息
正文、JSON-RPC 参数或结果、上游响应、凭据、敏感表单或审批内容。异常日志可以保留受约束的操作
上下文，但不得输出完整认证请求。逐 Token 文本增量以及未处理的 `delta`、`outputDelta` 和
`progress` 通知不逐条记录，避免调试模式造成无界日志放大；对应完成态、路由结果与请求耗时仍保留。

模型指标库不属于会话 `StateStore`，不保存消息、请求/响应正文、图片、工具参数、凭据或上游响应
ID。`provider-proxy` 只生成脱敏样本，`bootstrap` 负责把样本装配到本模块；本模块不依赖代理、
App Server 协议、Surface 或业务 Storage。当前没有公开 HTTP API 或 WebUI。
指标采集始终开启，不受全局调试模式影响；`debug` / `trace` 只增加脱敏的关联诊断，写入失败仍按
`warn` 输出，避免关闭调试后形成历史数据断档或隐藏采集故障。
