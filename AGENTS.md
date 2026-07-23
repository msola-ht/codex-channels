# codex-channels 项目约束

## 适用范围与事实来源

- 本文件适用于整个仓库；更具体目录中的 `AGENTS.override.md` 或 `AGENTS.md` 优先。
- 开始修改前读取根目录 `README.md`、本文件，以及与任务直接相关的模块 README、公开接口和测试。
- 本文件定义稳定的开发边界；当前功能、命令和部署方式以根目录 `README.md` 为准，模块职责以 `src/README.md` 和各模块 README 为准。
- 只支持当前文档、配置示例、协议基线和存储 Schema 明确定义的接口。不支持的输入必须明确报错，不增加隐式别名、迁移或回退。

## 当前实现

- 仓库只包含一个 TypeScript 模块化 Gateway；正式本机入口是 npm CLI `codexc`。
- Codex App Server 独立运行，原生 Codex TUI 与 Gateway 连接同一个实例，共享 Thread 和实时状态。
- App Server 是 Thread、Turn、Item、Goal 和会话历史的唯一事实来源。
- Gateway 停止或重启不得主动终止共享 App Server。
- 本机 App Server 连接使用私有 Unix WebSocket；Socket 生命周期和权限由运行时与服务安装脚本管理。
- 原生终端交互由 `codex --remote` 提供，Gateway 不实现第二套终端会话界面。
- Gateway 不读取、解析或修改 Codex 内部会话文件，也不复制完整会话历史。

## 模块边界

当前一级模块及职责：

- `application`：编排跨模块用例，返回平台无关的结构化结果。
- `approval`：处理命令、文件、权限、用户输入和 MCP elicitation。
- `bootstrap`：装配具体实现并管理进程、连接和 Surface 生命周期。
- `codex-client`：负责 Transport、JSON-RPC、类型化 App Server API 和重连。
- `codex-protocol`：保存生成的协议类型、受控导出和精确版本基线。
- `config`：解析并验证外部配置，分类配置变更。
- `conversation-core`：归约 Thread、Turn 和 Item 通知，产生平台无关事件。
- `event-bus`：提供进程内有界队列和消费者隔离。
- `observability`：提供结构化日志和敏感字段脱敏。
- `policy`：执行 Surface Actor 与 Workspace 授权。
- `session-routing`：维护 Conversation、Workspace、Thread 的绑定和订阅状态。
- `storage`：持久化恢复绑定所需的最小业务状态。
- `surfaces`：适配外部平台输入、输出和交互。

依赖方向保持为：

```text
Surface -> Application/Core <- Codex Client
                     ^
              Policy / Storage
```

- `bootstrap` 是组合根，具体实现选择和生命周期协调集中在这里。
- 每个一级模块通过自己的 `index.ts` 暴露公开能力；跨模块不得导入其他模块的内部实现文件。
- Conversation Core 不得依赖平台 SDK、具体数据库、服务管理器或底层 JSON-RPC Transport。
- Surface 不得直接操作底层 Transport，也不得把平台 SDK 类型带入核心模块。
- Codex Client 不得调用平台 API、生成平台文案或保存业务绑定。
- 不复制状态归约、协议解析、审批协调或授权逻辑来绕过模块接口。

## App Server 协议

- 协议类型由受支持的 Codex CLI 生成；不得凭记忆手写协议字段。
- 仓库必须记录并校验生成类型对应的精确 Codex CLI 版本。
- 升级协议时先审查生成差异，再更新 `codex-protocol` 的受控导出、实现和测试。
- 稳定业务代码不得依赖实验生成参数才会出现的字段。
- 每个 Transport 连接只执行一次 `initialize`，成功后发送 `initialized`；初始化前不得发送其他请求。
- JSON-RPC Response、Notification 和 Server Request 必须分别处理。
- Request ID 必须唯一关联 Pending Response，并在超时、断线和关闭时完成清理。
- 未知 Notification 可以记录后忽略；未知 Server Request 必须返回明确错误或安全拒绝，不能悬挂。
- 只有可证明安全的只读或幂等请求可以在过载后自动重试；创建和写入操作不得盲目重试。

## Thread 与会话

- 使用 App Server 的 `thread/list` 查询会话，不维护平行的会话索引。
- Thread 查询必须显式传入服务端允许的 `cwd` 和 `sourceKinds`。
- 自动接续前检查 Thread 来源、Workspace、运行状态和现有绑定。
- 一个 Thread 不能同时绑定多个外部 Conversation；活动 Thread 不得无条件追加新 Turn。
- 切换、退出、新建、归档或解绑时按协议取消旧订阅，不能只删除本地映射。
- `thread/resume`、`thread/read`、请求响应和状态通知是事实来源；本地缓存只用于路由和界面展示。
- 不从单次请求调用推断 App Server 未明确返回的状态变化。

## 状态与持久化

- SQLite StateStore 只保存 Conversation 身份、已授权 Actor、Workspace、Thread 和 Session 的最小绑定。
- 一个 Conversation 由 `surface + accountId + conversationId` 唯一标识。
- 不持久化消息正文、Turn/Item 历史、Diff、Plan、审批内容或 Codex 会话文件副本。
- 数据库只接受当前 Schema；不支持的版本必须失败关闭，不执行隐式迁移。
- StateStore 保持可替换，业务模块只能依赖其公开接口。
- 用户配置、数据库、Socket、日志和临时上传不得写入会被 npm 升级替换的包目录。
- 新增依赖或改变持久化格式前，必须说明必要性、当前数据的处理方式和回滚方案，并取得用户确认。

## Surface、审批与并发

- Surface 通过编译期显式注册接入，并通过统一的输入、输出、授权和审批接口调用 Application/Core。
- 所有外部输入先完成 Surface Actor 与 Workspace 授权，再调用会话能力。
- App Server Reader 只负责读取、解析、关联 Response 和投递事件，不等待平台网络请求。
- 平台输出使用有界队列；同一 Conversation 保持顺序，不同 Conversation 可以并行。
- 队列过载时可以合并或丢弃非关键中间事件，但不得静默丢弃审批、错误、Item 完成或 Turn 完成事件。
- 平台 API 超时、限流或失败不得阻塞 App Server Reader。
- 后台任务必须有明确所有者、取消路径、有限重试和关闭等待上限。
- 审批状态必须绑定 Thread、协议提供的 Turn 和请求标识；MCP elicitation 无法关联活动 Turn
  时允许 `turnId` 为 `null`，但仍必须保留 Thread 与 App Server 请求 ID。交互令牌必须不可预测、
  一次性使用并设置过期时间。
- 已被其他客户端解决的请求必须及时使当前交互失效。
- 未识别、无法路由或缺少归属信息的高权限请求默认拒绝或取消。
- 一次批准不得升级为会话持续授权。

## 安全

- 外部用户只能选择预配置 Workspace，不能提交任意绝对工作目录。
- Thread、Turn、命令、文件和权限操作前必须执行 Actor 与 Workspace 授权检查。
- Unix Socket 父目录权限必须限制为当前用户，Socket 不得向无关用户开放。
- 无认证 App Server 不得监听非回环网络地址。
- 默认不自动批准命令、文件写入、额外文件系统权限或网络权限。
- 配置错误必须失败关闭，不得采用更宽松的权限、目录或网络默认值。
- 日志、异常和平台消息不得包含 Token、Cookie、Authorization Header、敏感表单或未经约束的上游响应。
- 外部用户消息只显示明确标记的结构化错误；未知内部异常不得原样发送。

## 实现与修改

- 采用满足当前目标的最小完整修改，优先复用现有模块、公开接口和类型。
- 不为未出现的需求增加抽象层、通用框架、配置项或扩展机制。
- 外部输入在边界验证一次；内部模块不重复验证同一数据。
- 协议核心使用明确类型和可辨识联合，避免不受约束的 `any`。
- 错误保留可操作上下文但不泄露敏感信息；降级行为必须可观察。
- 不把网络、协议、状态、渲染和存储职责集中到同一个大型模块。
- 修改公开命令、配置键、协议基线、持久化格式或默认行为时，同步更新 README、示例和测试。
- 删除或替换实现时同步删除孤儿入口、依赖、配置、脚本和测试。

## 命令与提权

- 执行 Git、npm 以及测试、类型检查、Lint、构建、打包或集成验证命令时，首次调用就直接发起提权请求，不先在受限沙箱内试跑后再重试。
- 提权请求必须说明命令目的并保持在当前仓库和当前任务范围内；不得借此扩大修改、提交或远端写入权限。
- 提权只解决命令执行权限，不代替用户授权。提交、推送、依赖变更和其他外部写入仍须遵守本文件对应约束。

## 验证

- 每次修改运行与改动最相关的最小验证，至少覆盖本次修改的主路径和失败路径。
- 协议、Transport 或共享 App Server 行为变化必须增加真实 App Server 冒烟验证，不能只依赖 Mock。
- 核心协议测试应覆盖初始化、消息分流、请求清理、Thread/Turn 主路径和订阅取消。
- 会话测试应覆盖双向发现与接续、绑定独占、活动状态和 Gateway 重启恢复。
- Surface 测试应覆盖授权、审批超时与失效、输出顺序、平台超时隔离和敏感信息清洗。
- 无法执行必要验证时，交付中必须说明未验证项、原因和可执行的后续检查。

## Git 与交付

- 保留 Git 历史，不通过删除仓库或重新初始化规避审查。
- 不覆盖、回退或混入用户已有的未提交改动；无法安全绕开时停止并说明。
- 提交前重新读取并审查所有实际适用的规则文件，包括根目录 `AGENTS.md`、更具体目录中的 `AGENTS.override.md` 或 `AGENTS.md`，不依赖会话中的旧记忆。
- 规则文件必须与当前源码、公开接口、测试和文档一致，不得保留已删除实现、旧名称、迁移阶段描述、未落地能力或相互冲突的要求；修改规则文件后必须再次执行这项自审。
- 提交前重新读取根目录 `README.md` 和本次改动涉及的目录 README。
- 提交前审查根目录文档索引、`src/README.md` 模块索引及相关目录 README 中的文件索引，确认文件、模块、公开入口、命令、配置和链接均与当前仓库及本次改动一致。
- 发现索引缺项、孤儿链接、旧名称或行为描述不一致时，必须先更新文档并重新检查；文档索引未通过审查不得提交。
- 提交前至少执行 `git diff --check`、文档链接与索引一致性检查，以及本次改动要求的验证命令。
- 未经用户明确要求，不执行提交、推送、历史改写或其他远端写入。
- 完成修改时说明改动的模块和行为、已运行的验证、涉及的公开接口或安全边界，以及仍存在的风险。
