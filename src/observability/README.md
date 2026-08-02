# Observability

本目录提供 Gateway 的结构化日志入口。

## 文件

- `index.ts`：本模块的公开导出入口。
- `logger.ts`：根据配置创建 Pino Logger，并对 Token、App Secret、Authorization、Cookie、密码等
  字段进行脱敏；`err` 和进程边界复用 `safeErrorMetadata`，只保留受约束的异常类型和机器错误码，
  不保留 message、stack 或附加响应对象。

其他模块应注入并复用该 Logger，不应自行创建不受控日志通道。`logging.level = "debug"` 或
`"trace"` 启用全局调试模式；调试日志只记录受约束的模块、类型、阶段、耗时与结果，不记录消息
正文、JSON-RPC 参数或结果、上游响应、凭据、敏感表单或审批内容。异常日志可以保留受约束的操作
上下文，但不得输出完整认证请求。逐 Token 文本增量以及未处理的 `delta`、`outputDelta` 和
`progress` 通知不逐条记录，避免调试模式造成无界日志放大；对应完成态、路由结果与请求耗时仍保留。
