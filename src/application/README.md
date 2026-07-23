# Application

本目录实现跨模块用例，协调 Codex Client、Conversation Core、Session Router 和模型设置，不处理 Telegram SDK 或底层 Transport。

## 文件

- `index.ts`：本模块的公开导出入口。
- `conversation-command-service.ts`：定义平台无关的会话命令目录，解析参数并返回类型化结果；Surface 只负责把平台输入映射到命令并渲染结果。
- `conversation-service.ts`：新建、恢复、切换、归档和查询 Thread，提交或 steer Turn，并公开 Conversation 状态与最近 Turn 产物。
- `model-selection-service.ts`：查询模型与思考强度，保存按 Conversation 生效的 Turn 覆盖设置。

Surface 应通过这里的用例接口驱动会话，不应直接拼装 JSON-RPC。Thread 的权威状态仍来自 App Server，本模块只编排请求和必要的本地选择。
`/whoami`、交互取消、图片下载等平台能力不属于通用会话命令，继续由具体 Surface 实现。
