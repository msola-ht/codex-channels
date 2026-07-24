# Codex Client

本目录封装 Codex App Server Transport、JSON-RPC 会话和类型化 API，是 Gateway 访问 App Server 的唯一底层入口。

## 文件

- `index.ts`：本模块的公开导出入口。
- `transport.ts`：Transport 接口和公共生命周期基类。
- `unix-websocket-transport.ts`：通过 Unix Socket 完成 WebSocket HTTP Upgrade 的正式 Transport。
- `stdio-transport.ts`：用于受控开发和测试场景的 stdio Transport。
- `json-rpc.ts`：initialize、请求关联、通知与 Server Request 分流、超时、断线清理及安全重试。
- `client.ts`：Thread 搜索/归档、Turn、模型、权限、已安装插件、Skill、用量及用户级配置
  读取与服务层级写入等 App Server 方法的类型化封装；插件状态查询不得加载远端市场目录。

本模块不得调用 Telegram API、生成平台文案或保存业务绑定。协议字段必须来自 `codex-protocol`，写操作不得在过载或断线后盲目重试。
当前精确协议基线要求 initialize 协商实验 API，App Server 才会发送已生成并受控导出的
`thread/settings/updated`；该通知用于同步共享 Thread 的模型、思考强度和服务层级。启用该能力
同时出现的实验审批字段必须在 `approval` 边界显式展示或默认拒绝，不能静默扩大授权。
