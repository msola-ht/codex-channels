# Application

本目录实现跨模块用例，协调 Codex Client、Conversation Core、Session Router 和模型设置，不处理 Telegram SDK 或底层 Transport。

## 文件

- `index.ts`：本模块的公开导出入口。
- `conversation-service.ts`：新建、恢复、切换、删除和查询 Thread，提交或 steer Turn，并公开 Conversation 状态。
- `model-selection-service.ts`：查询模型与思考强度，保存按 Conversation 生效的 Turn 覆盖设置。

Surface 应通过这里的用例接口驱动会话，不应直接拼装 JSON-RPC。Thread 的权威状态仍来自 App Server，本模块只编排请求和必要的本地选择。
