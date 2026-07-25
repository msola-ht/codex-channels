# Codex Client

本目录封装 Codex App Server Transport、JSON-RPC 会话和类型化 API，是 Gateway 访问 App Server 的唯一底层入口。

## 文件

- `index.ts`：本模块的公开导出入口。
- `transport.ts`：Transport 接口和公共生命周期基类。
- `unix-websocket-transport.ts`：通过 Unix Socket 完成 WebSocket HTTP Upgrade 的正式 Transport。
- `stdio-transport.ts`：用于受控开发和测试场景的 stdio Transport。
- `json-rpc.ts`：使用生成的 `ClientRequest` / `ClientNotification` 约束出站消息，并处理
  initialize、请求关联、通知与 Server Request 分流、超时、断线清理及安全重试；初始化期间
  已失效的连接不得重新进入 connected 状态。
- `thread-adapter.ts`：把当前版本生成的官方 Thread、状态、来源、运行 Turn 和模型设置响应映射为
  `session-routing` 拥有的稳定快照；缺少路由必需字段时失败关闭。
- `turn-adapter.ts`：把 Application 的文本与本地图片输入编码为官方 `UserInput`，并映射
  Turn、Review 和 Goal 响应；缺少稳定结果必需字段时失败关闭。
- `model-adapter.ts`：把当前版本官方模型目录裁剪为 Application 拥有的模型选项，过滤不可见项，
  并在缺少模型选择必需字段时失败关闭。
- `account-adapter.ts`：把账户 Token 用量、单桶或多桶额度与重置券数量映射为 Application
  稳定摘要；未知枚举或畸形数值失败关闭，不把上游响应正文交给 Surface。
- `client.ts`：Thread 搜索/归档、Turn、模型、权限、已安装插件、Skill、用量及用户级配置
  读取与服务层级写入等 App Server 方法的类型化封装；配置读取只公开稳定服务层级值，插件状态
  查询不得加载远端市场目录。

本模块不得调用 Telegram API、生成平台文案或保存业务绑定。协议字段必须来自
`codex-protocol`；无参数请求和通知不得自行补空对象，写操作不得在过载或断线后盲目重试。
业务模块拥有窄端口和稳定结果类型；本模块可以实现这些端口，但不得让生成响应越过对应适配边界。
当前精确协议基线要求 initialize 协商实验 API，App Server 才会发送已生成并受控导出的
`thread/settings/updated`；该通知用于同步共享 Thread 的模型、思考强度和服务层级。启用该能力
同时出现的实验审批字段必须在 `approval` 边界显式展示或默认拒绝，不能静默扩大授权。
