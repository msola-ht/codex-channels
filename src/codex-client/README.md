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
- `thread-adapter.ts`：把当前版本生成的官方 Thread、状态、来源、运行 Turn、上下文压缩 Item ID
  和模型设置响应映射为 `session-routing` 拥有的稳定快照与恢复会话；缺少必需字段时失败关闭。
- `turn-adapter.ts`：把 Application 的文本、本地图片与本地音频输入编码为官方 `UserInput`，并映射
  Turn、Review 和 Goal 响应；缺少稳定结果必需字段时失败关闭。
- `model-adapter.ts`：把当前版本官方模型目录裁剪为 Application 拥有的模型选项和
  `text/image/audio` 输入能力，过滤不可见项，
  并在缺少模型选择必需字段时失败关闭。
- `account-adapter.ts`：把账户 Token 用量、单桶或多桶额度与重置券数量映射为 Application
  稳定摘要；未知枚举或畸形数值失败关闭，不把上游响应正文交给 Surface。
- `skill-adapter.ts`：从官方按 CWD 返回的 Skill 条目中只保留启用的用户或项目直接安装项，
  排除系统与插件缓存，并映射为不含本机路径的稳定结果。
- `mcp-adapter.ts`：把官方 MCP Server 状态页裁剪为名称、认证状态和工具数量，并校验分页与
  展示必需字段；不向 Application 传播工具 Schema、资源或 Server Info。
- `plugin-adapter.ts`：从官方已安装 Plugin 响应中只保留名称和启用状态，排除安装建议与
  Marketplace、路径、版本、策略和加载错误。
- `permission-adapter.ts`：把官方 Permission Profile 分页响应裁剪为 ID、说明和策略可选状态，
  并对必需字段与分页游标失败关闭。
- `notification-adapter.ts`：把当前支持的官方 Notification 转换为 Routing 或 Conversation Core
  拥有的稳定事件；校验 Turn、Item、Diff、Plan、Goal、Token、账户、额度、MCP、warning 与 Thread
  生命周期字段；`turn/completed` 只接受官方 `Turn.durationMs` 的非负安全整数并转为稳定耗时，
  Turn、warning 和 MCP 错误在此统一脱敏并限长，残缺或无关通知不进入业务模块。
- `operation-adapter.ts`：把官方 Item 转换为安全、简洁的操作摘要，并在离开 Client 边界前
  清洗命令、查询及上游错误中的敏感文本；只把 `imageGeneration.savedPath` 映射为稳定生成图片
  产物路径，不把 `imageView` 当作可外发产物。
- `server-request-adapter.ts`：把命令、文件、临时权限、用户输入和 MCP elicitation 五类
  Server Request 解码为 Approval 稳定请求；其中按固定版本的空对象 Schema 与
  `mcp_tool_call` 元数据识别 MCP 工具审批，保留工具展示参数和上游提供的持久范围。稳定决定
  精确编码为当前官方响应；畸形请求安全拒绝，未知请求返回明确 JSON-RPC 方法错误。
- `protocol-info.ts`：从精确协议基线公开受支持的 Codex CLI 版本和 Gateway 显示版本，供组合根
  校验并向 Surface 注入纯字符串。
- `client.ts`：Thread 搜索/归档、Turn、模型、权限、已安装插件、Skill、用量及用户级配置
  读取与服务层级写入等 App Server 方法的类型化封装；MCP 查询按 Thread 使用
  `toolsAndAuthOnly` 分页，配置读取只公开稳定服务层级值，Plugin 查询只调用
  `plugin/installed`，不得改用 `plugin/list` 加载市场目录；Permission Profile 按 CWD 分页，
  仅用于只读目录展示。

本模块不得调用 Telegram API、生成平台文案或保存业务绑定。协议字段必须来自
`codex-protocol`；无参数请求和通知不得自行补空对象，写操作不得在过载或断线后盲目重试。
业务模块拥有窄端口和稳定结果类型；本模块可以实现这些端口，但不得让生成响应越过对应适配边界。
生产源码只有本模块可以导入 `codex-protocol`；`codex-protocol/index.ts` 只保留本模块实际使用
的生成类型。
Notification 适配只返回当前支持的稳定事件；未知或畸形通知由组合根记录 method 后忽略，不记录
原始 params，也不阻塞 App Server Reader。
Server Request 适配只把已校验的稳定请求交给 Approval；Approval 不接触生成协议或 RPC 信封，
响应类型与请求不一致时失败关闭。
当前精确协议基线要求 initialize 协商实验 API，App Server 才会发送已生成并受控导出的
`thread/settings/updated`；该通知用于同步共享 Thread 的模型、思考强度、服务层级和
Default/Plan 协作模式。Client 只额外调用 `collaborationMode/list` 并把受控的
`turn/start.collaborationMode` 映射到 Application 窄类型；其他实验请求不属于业务入口。启用该能力
同时出现的实验审批字段必须在 `approval` 边界显式展示或默认拒绝，不能静默扩大授权。

固定协议的一次性 `localAudio` 已由 Application 的封闭 `TurnInput` 受控接入；Surface 只能提交
经过格式、大小和私有临时文件边界验证的绝对路径，Application 还必须在 Turn 前确认当前模型目录
包含 `audio`。远端 `audio` 和实验 `thread/realtime/*`
不得由本模块调用或映射；生成目录中存在 Realtime 请求和通知类型不改变该边界。
