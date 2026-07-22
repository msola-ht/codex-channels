# Observability

本目录提供 Gateway 的结构化日志入口。

## 文件

- `index.ts`：本模块的公开导出入口。
- `logger.ts`：根据配置创建 Pino Logger，并对 Token、Authorization、Cookie、密码等字段进行脱敏。

其他模块应注入并复用该 Logger，不应自行创建不受控日志通道。异常日志可以保留操作上下文，但不得输出凭据、敏感表单或完整认证请求。
