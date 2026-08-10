# Codex Client

本目录封装 Codex App Server Transport、JSON-RPC 会话和类型化 API，是 Gateway 访问 App Server 的唯一底层入口。

## 文件

- `index.ts`：本模块的公开导出入口。
- `transport.ts`：Transport 接口和公共生命周期基类。
- `unix-websocket-transport.ts`：连接前校验当前用户私有的父目录和本人所有的真实 Unix Socket，
  再完成 WebSocket HTTP Upgrade 的正式 Transport。
- `stdio-transport.ts`：用于受控开发和测试场景的 stdio Transport。
- `json-rpc.ts`：使用生成的 `ClientRequest` / `ClientNotification` 约束出站消息，并处理
  initialize、请求关联、通知与 Server Request 分流、超时、断线清理及安全重试；初始化期间
  已失效的连接不得重新进入 connected 状态；通过 `extensions` 显式声明已实现的 `openai/form`。
- `thread-adapter.ts`：把当前版本生成的官方 Thread、内置 Pinned 分区、运行状态、来源、运行 Turn、
  上下文压缩 Item ID 和模型设置响应映射为 `session-routing` 拥有的稳定快照与恢复会话；
  缺少必需字段时失败关闭。固定状态写入由 Client 原样回写当前 Git SHA 以无损协调加载中 Thread，
  再移动到官方分区并读回验证。
- `turn-adapter.ts`：把 Application 的文本、本地图片、本地音频与已解析 Skill 输入编码为官方 `UserInput`，并映射
  Turn、Review 和 Goal 响应；缺少稳定结果必需字段时失败关闭。
- `model-adapter.ts`：把当前版本官方模型目录裁剪为 Application 拥有的模型选项和
  `text/image/audio` 输入能力，过滤不可见项，
  并在缺少模型选择必需字段时失败关闭。
- `deepseek-catalog.ts`：按 Bootstrap 注入的编译期 DeepSeek 定义，只读取 Setup 下载到用户
  `CODEX_HOME` 的模型目录，把当前官方
  支持的 Flash 映射为可选模型，并保留 Pro 为带不可用原因、不能切换的展示项。
- `account-adapter.ts`：把账户 Token 用量、单桶或多桶额度与重置券数量映射为 Application
  稳定摘要；未知枚举或畸形数值失败关闭，不把上游响应正文交给 Surface。
- `skill-adapter.ts`：从官方按 CWD 返回的 Skill 条目中只保留启用的用户或项目直接安装项，
  排除系统与插件缓存；列表结果不含本机路径，显式调用只向 Application 返回精确匹配且名称、
  绝对路径均通过校验的引用。
- `mcp-adapter.ts`：把官方 MCP Server 状态页裁剪为概览或工具、资源、模板详情，校验 OAuth
  授权 URL，将说明字段的多行空白归一化并限为 2,000 字符，并把资源响应限为前 8 项、文本展示
  合计 8,000 字符，二进制裁剪为元数据；不传播工具 Schema 或 Base64 正文。
- `plugin-adapter.ts`：只映射已安装 Plugin，校验 Plugin ID、Marketplace、启用与管理员可用状态，
  并为可调用项生成官方 `plugin://` mention 路径。
- `permission-adapter.ts`：把官方 Permission Profile 分页响应裁剪为 ID、说明和策略可选状态，
  并对必需字段与分页游标失败关闭。
- `notification-adapter.ts`：把当前支持的官方 Notification 转换为 Routing 或 Conversation Core
  拥有的稳定事件；校验 Turn、Item、Diff、Plan、Goal、Token、账户、额度、MCP OAuth 完成、warning 与 Thread
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
- `client.ts`：Thread 搜索/归档/固定、Turn、模型、权限、Skill、用量及用户级配置
  读取与服务层级写入等 App Server 方法的类型化封装；MCP 概览按 Thread 使用
  `toolsAndAuthOnly` 分页，详情使用 `full`；`config/mcpServer/reload` 不自动重试，OAuth 不自动重试并消费
  官方登录完成通知，资源读取保持只读；Permission
  Profile 按 CWD 分页。开发中 Plugin 只调用 `plugin/installed` 并经 Application 开关约束，
  不接入搜索、安装或分享。Thread 列表显式传空
  `modelProviders` 获取当前 Workspace 的全部 Provider，
  供跨 Provider 会话展示和冷恢复定位使用。
  新 Thread 和 Fork 可显式携带官方 `modelProvider`。已有 Thread
  不在 Turn 覆盖中更换 Provider。Application 跨 Provider 选择时新建 Thread；`thread/fork`
  只用于用户显式创建同一 Provider 的历史分支，不承担跨 Provider 历史转换。
- `provider-routing-client.ts`：复用多个完整 Client 实例，按 Thread 的官方 `modelProvider` 路由
  生命周期、Turn、Review、Goal 和 MCP；合并各实例的进程内状态，隔离 Server Request ID，
  MCP 配置刷新会尝试全部受管实例并传播任一失败，单 Provider 重连只恢复该侧 Thread。第三方 Provider 的账户通知不会进入 OpenAI 账户状态；
  无法关联 Thread 的 MCP 与 warning 全局通知携带 Provider 来源，只发送到对应 Provider 会话。
  模型目录由对应 App Server 启动配置持有。

本模块不得调用 Telegram API、生成平台文案或保存业务绑定。协议字段必须来自
`codex-protocol`；无参数请求和通知不得自行补空对象，写操作不得在过载或断线后盲目重试。
业务模块拥有窄端口和稳定结果类型；本模块可以实现这些端口，但不得让生成响应越过对应适配边界。
生产源码只有本模块可以导入 `codex-protocol`；`codex-protocol/index.ts` 只保留本模块实际使用
的生成类型。
Notification 适配只返回当前支持的稳定事件；未知或畸形通知由组合根记录 method 后忽略，不记录
原始 params，也不阻塞 App Server Reader。
`subAgentActivity` Item 只在官方完成阶段进入稳定事件，并保留 `started`、`interacted`、
`interrupted` 类型，避免同一 Item 的开始与完成阶段重复发布；`collabAgentToolCall` Item 由操作适配器
保留官方接收线程 ID 和有界状态，不保留代理消息正文。Bootstrap 结合已订阅子线程自己的
`turn/completed`、中断活动和旧版工具状态判断子代理终态，Surface 只消费稳定操作与完成事件。
Server Request 适配只把已校验的稳定请求交给 Approval；Approval 不接触生成协议或 RPC 信封，
响应类型与请求不一致时失败关闭。
当前精确协议基线要求 initialize 协商实验 API，App Server 才会发送已生成并受控导出的
`thread/settings/updated`；该通知用于同步共享 Thread 的模型、思考等级、服务层级和
Default/Plan 协作模式。Client 只额外调用 `collaborationMode/list` 并把受控的
`turn/start.collaborationMode` 映射到 Application 窄类型；其他实验请求不属于业务入口。启用该能力
同时出现的实验审批字段必须在 `approval` 边界显式展示或默认拒绝，不能静默扩大授权。

固定协议的一次性 `localAudio` 已由 Application 的封闭 `TurnInput` 受控接入；Surface 只能提交
经过格式、大小和私有临时文件边界验证的绝对路径，Application 还必须在 Turn 前确认当前模型目录
包含 `audio`。远端 `audio` 和实验 `thread/realtime/*`
不得由本模块调用或映射；生成目录中存在 Realtime 请求和通知类型不改变该边界。
