# Application

本目录实现跨模块用例，协调 Codex Client、Conversation Core、Session Router 和模型设置，不处理 Telegram SDK 或底层 Transport。

## 文件

- `index.ts`：本模块的公开导出入口。
- `conversation-command-service.ts`：定义平台无关的会话命令名称，解析参数并返回结构化结果；不包含平台文案或消息布局。
- `conversation-service.ts`：通过稳定的 `ConversationUseCases` 公开 Surface 和命令层所需用例，
  具体 `ConversationService` 负责新建、恢复、切换、归档、固定和查询 Thread，提交、steer 或将纯文本
  排到下一 Turn，公开 Conversation 状态与最近 Turn 产物，并通过注入端口把项目规则操作限制
  到当前授权 Workspace；Conversation 状态使用 Core 从 App Server 归约的当前 Goal 与上下文压缩总次数，
  并通过组合根注入的只读端口取得当前 Workspace Git 分支；
  恢复已由其他渠道绑定的空闲 Thread 时，同时锁定新旧 Conversation，确认双方无活动 Turn、
  排队消息或待处理交互后调用路由层原子转移，并向原渠道发布关键解绑通知；
  扩展查询通过 `ConversationQueryPort` 组合窄端口，Skill、MCP 与
  Plugin 和 Permission Profile 均使用稳定结果。
- `model-selection-service.ts`：查询模型、输入能力与思考等级，保存按 Conversation 生效的 Turn 覆盖设置；
  选择不同 Provider 时保留并解绑当前 Thread，为下一 Turn 在对应 App Server 新建带精确
  `modelProvider` 的 Thread，并采用目标模型目录的默认思考等级，避免把原 Provider 的设置或专属
  历史发送到不兼容的 API；旧 Thread 保持可恢复；
  含本地图片或音频的输入在创建或追加 Turn 前必须分别通过当前模型的 `image` 或 `audio` 能力检查；
  Fast 只允许当前模型目录明确声明支持时切换，并通过模型窄端口保存用户级默认层级；第三方模型
  不得借关闭 Fast 改写 OpenAI 默认设置。
- `collaboration-mode-port.ts`：定义 Default/Plan 预设的稳定查询边界，不向 Application
  暴露完整实验协议。
- `collaboration-mode-service.ts`：把官方预设与当前模型设置组合为下一 Turn 的协作模式覆盖；
  模式按 Thread 同步，只在内存保存尚未生效的选择。
- `model-port.ts`：定义项目拥有的 Provider、`text/image/audio` 输入能力、思考等级、服务层级与 Fast 默认值写入窄端口；
  Application 和 Surface 不接收完整官方模型对象。
- `account-port.ts`：分别定义 OpenAI 账户 Token/额度、第三方余额和未支持状态的可辨识结果，
  以及 Provider 账户适配器与查询窄端口；不同来源不得共用含义不一致的字段。
- `provider-account-service.ts`：维护编译期显式 Provider 账户适配器注册表；OpenAI 适配器复用
  App Server 账户查询，未知 Provider 默认返回不支持，不回退到 OpenAI。
- `exchange-rate-port.ts`：定义稳定汇率快照与价格显示币种解析，并按实际启用 Provider 判断是否
  需要启动 USD/CNY 汇率刷新；Application 不执行网络请求或读取汇率缓存。
- `request-metrics-port.ts`：定义 `/metrics` 使用的当前 Thread 最近 Turn 运行聚合、整个 Thread
  指标累计、最近直接 API 请求，以及最近 24 小时、7 天或 30 天的全局/提供商/模型聚合和异常请求
  只读摘要；聚合中的远程压缩摘要单列实际请求模型、请求数、Token 与参考费用；
  直接 API 保留稳定提供商 ID，并可携带配置中的显示名称；不向 Application 暴露 SQLite、价格快照
  或请求正文。
- `vision-port.ts`：定义模型无原生图片能力时使用的稳定识别端口、严格结果 Schema 和已完成但
  不可信的图片资料格式；`conversation-service.ts` 只在模型目录明确拒绝图片且组合根注入适配器时
  传递当前提示并替换 `localImage`，视觉请求携带当前 Thread 的思考等级，适配器在支持时透传
  `reasoning.effort` 并同步记录指标；未配置时保持原有失败关闭行为；外部识图全局最多两个在途
  请求，超出后明确拒绝而不建立无界队列。
- `skill-port.ts`：定义已直接安装 Skill 的稳定名称与说明查询，以及只供 Application 启动
  Turn 使用的精确 Skill 路径解析；路径不向 Surface 暴露，也不传播 Scope、依赖或上游扫描错误。
- `mcp-port.ts`：定义 MCP Server 名称、认证状态与工具数量的稳定查询摘要，不向 Surface 暴露
  Server Info、工具 Schema、资源清单或完整官方响应。
- `plugin-port.ts`：定义已安装 Plugin 的稳定名称与启用状态查询，不向 Surface 暴露 Marketplace、
  本机路径、版本、安装策略或完整官方响应。
- `permission-port.ts`：定义 Permission Profile 的稳定 ID、说明和策略可选状态查询；只表示
  当前 Workspace 可见目录，不授予权限，也不承载审批决定。
- `workspace-permission-port.ts`：定义渠道 `/workspaceperm` 使用的工作区权限写入窄端口；
  Application 只按当前 Conversation 绑定的 Workspace 传递沙箱、审批策略或权限 Profile 更新，
  不接触配置文件。
- `turn-port.ts`：定义项目拥有的 Turn 输入、设置覆盖、Review 目标与执行窄端口，并复用 Core
  统一的 Goal 稳定状态类型；
  输入只允许文本、绝对本地图片路径、绝对本地音频路径和已由 Client 从当前 Workspace
  `skills/list` 解析的 Skill 引用；绝对媒体路径不代表当前模型可用，必须先通过模型目录能力检查。
  显式 Skill 调用同时发送 `$<skill-name>` 文本标记和内部 Skill 引用。Application 不构造官方 `UserInput`，
  也不接收完整官方 Turn 响应。

Surface 应依赖 `ConversationUseCases` 驱动会话，不依赖具体服务类，也不应直接拼装 JSON-RPC。
Thread 的权威状态仍来自 App Server，本模块只编排请求和必要的本地选择。
下一 Turn 队列按 Conversation 隔离、每个会话最多 10 条且只保存在内存中；`turn.completed`
后一次启动一条，Thread 变化或启动失败时清空，不能把消息正文写入 StateStore。
运行中通过 `/resume` 或 `/new` 切换时，Application 只把当前 Thread 转为有界后台绑定，不停止
Turn；后续普通输入、`/queue` 与 `/stop` 仍只作用于前台 Thread。后台完成事件不消费前台下一
Turn 队列。
扩展查询也保持平台无关：Skill 只向 Surface 返回当前用户或 Workspace 直接安装且已启用项的
名称与说明；显式调用时由 Client 再按精确名称解析绝对路径，排除系统和插件缓存内容。MCP 只返回
展示所需的稳定摘要，并按当前 Thread 读取项目级配置；Plugin 只返回已安装项的稳定摘要，不触发
`plugin/list` 市场目录查询。
成功启动 Turn 后，模型、思考等级、服务层级和协作模式以 App Server 的 Thread 设置为准；
Gateway 重启时通过恢复 Thread 和设置通知重新取得这些设置。`/plan` 无参数切换
Default/Plan，带参数时在空闲边界内直接启动 Plan Turn；活动 Turn 不允许中途切换。
Turn、steer、停止、重命名、固定、压缩、Review 和 Goal 只依赖 `TurnExecutionPort`；当前版本官方字段由
`codex-client` 负责映射。Goal set/clear 请求成功后，Application 使用已确认结果立即更新 Core；
App Server 通知继续处理其他客户端修改与恢复后的状态校正。
模型选择和 Fast 只依赖 `ModelSelectionPort`；不可见模型过滤、官方模型字段裁剪以及
`config/read` / `config/batchWrite` 的版本差异由 `codex-client` 处理。
OpenAI 原生账户查询只依赖 `AccountQueryPort`；当前 Thread 的 `/usage` 与 `/limits` 通过
`ProviderAccountQueryPort` 按 `modelProvider` 选择显式注册的适配器。新增第三方时实现
`ProviderAccountAdapter` 并在 Bootstrap 登记；未提供的账户能力保持不支持。Application 和
Surface 不解析 `account/usage/read`、`account/rateLimits/read` 或第三方完整响应。
`/metrics` 只依赖 `RequestMetricsQueryPort`；无参数或 `session` 查询当前 Thread，`global`、
`providers`、`models` 和 `errors` 使用严格的 `24h`、`7d`、`30d` 时间范围；`errors` 只展示
脱敏后的状态、HTTP 状态、错误类型、次数和最近发生时间。Bootstrap 把独立指标库映射为稳定摘要，
Application 不读取数据库。OpenAI `/limits` 还通过该端口按周窗口查询统计代理已经按相邻额度
快照归约的增量样本，估算每 1% 的 Token 与 API 参考费用；没有完整周窗口、有效重置时间或正向
额度变化区间时不产生估算。该请求流水
不能替代 App Server 提供的 Thread 上下文、账户额度或累计 Token 状态。
Skill 查询与显式调用只依赖 `SkillQueryPort`；用户和项目直接安装项的筛选、调用名称与绝对路径
校验由 Client 适配器在协议边界完成。
MCP 查询只依赖 `McpQueryPort`；分页、Thread 配置上下文与官方清单裁剪由 Client 适配器处理。
Plugin 查询只依赖 `PluginQueryPort`；已安装过滤与 Marketplace 响应裁剪由 Client 适配器处理。
Permission Profile 查询只依赖 `PermissionQueryPort`；CWD、分页和官方响应裁剪由 Client 处理。
命令成功文案、命令菜单说明和平台交互形式由各 Surface 维护，并通过类型穷尽检查保持完整。
项目规则命令只接受 `init` 或 `check`；Application 负责选择 Workspace，具体文件与进程操作由
Bootstrap 注入的运行时实现完成。远程入口不得提供强制覆盖。
`/whoami`、交互取消、图片下载等平台能力不属于通用会话命令，继续由具体 Surface 实现。
