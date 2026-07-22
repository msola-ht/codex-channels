# Project-skill-Codex-Connect 项目约束

## 适用范围

- 本文件适用于整个仓库。
- 更具体目录中的 `AGENTS.override.md` 或 `AGENTS.md` 可以补充本文件；发生冲突时，更具体目录的规则优先。
- 开始修改前先阅读根目录 `README.md`、本文件，以及与任务直接相关的设计文档和实现。
- 架构实现以 `ARCHITECTURE_REBUILD_PROPOSAL.md` 为设计基线；其中迁移步骤和旧实现描述仅作为历史决策记录。

## 当前项目状态

- 当前仓库以 TypeScript 模块化 Gateway 为唯一实现。
- 旧 Python Runtime、测试、smoke 脚本和打包入口已在用户确认后移除。
- Codex App Server 与 Gateway 的前后台常驻方式尚未最终启用；当前可使用 `npm run dev:all` 验证和运行。
- 不重新引入自定义会话数据库、Python Bridge 或替代 Codex Remote TUI 的本地 CLI。

## 目标架构

项目长期采用“模块化单体”架构，不提前拆分微服务。

推荐运行拓扑：

```text
Codex App Server（独立守护进程，Unix Socket）
├── 原生 Codex CLI：codex --remote unix:///...
└── Gateway
    ├── Codex Client
    ├── Conversation Core
    ├── Session Router
    ├── Approval Coordinator
    ├── Policy
    ├── Internal Event Bus
    └── Surface Adapters
        └── Telegram
```

必须遵守：

- Codex App Server 是 Thread、Turn、Item、Goal 和会话历史的唯一事实来源。
- CLI 与 Gateway 应连接同一个 App Server 实例，共享实时状态，而不仅是共享落盘文件。
- App Server 生命周期应独立于 Telegram Gateway；Gateway 停止不得主动终止共享 App Server。
- 本机连接优先使用私有 Unix Socket。
- Unix Socket Transport 使用 WebSocket HTTP Upgrade，不得按 JSONL Unix Stream 实现。
- 原生终端交互优先使用 `codex --remote`，不重复实现 Codex TUI。
- `codex remote-control` 不得替代自定义 Gateway 使用的 `codex app-server --listen`。
- 不直接读取、解析或修改 `~/.codex/sessions`、rollout JSONL 或其他 Codex 内部存储文件。
- 不将 Codex 完整会话历史复制到项目数据库。

## 模块边界

目标模块及职责：

- `codex-protocol`：保存由当前 Codex 版本生成的协议类型及版本信息。
- `codex-client`：负责 Transport、JSON-RPC、initialize、请求关联、Server Request 和重连。
- `conversation-core`：负责 Thread、Turn、Item 的状态归约，不依赖具体用户界面。
- `session-routing`：负责 Workspace、外部会话与 Codex Thread 的选择及绑定。
- `approval`：负责命令、文件、权限、用户输入和 MCP elicitation。
- `event-bus`：负责有界队列、事件分发和消费者隔离。
- `policy`：负责用户、Workspace、目录、模型和执行权限。
- `storage`：提供可替换状态存储接口，只保存业务映射和配置。
- `surfaces/*`：负责 Telegram、Web、Discord 等平台适配。
- `observability`：负责结构化日志、指标和诊断。
- `bootstrap`：负责配置加载、依赖装配和进程生命周期。

依赖方向：

```text
Surface Adapters -> Application/Core <- Codex Client
                            ^
                    Policy / Storage
```

禁止：

- `conversation-core` 依赖 Telegram SDK、具体数据库或 launchd。
- Surface Adapter 直接操作底层 JSON-RPC Transport。
- `codex-client` 直接调用 Telegram API 或生成平台文案。
- 跨模块导入其他模块的内部实现文件。
- 为绕过模块接口复制状态或协议解析逻辑。
- 为尚不存在的需求提前引入通用框架、服务发现或分布式组件。

模块间优先通过公开接口、显式命令和类型化事件通信。

## Codex App Server 协议约束

- 以当前安装的 Codex CLI 生成 Schema 为协议依据，不凭历史记忆手写字段。
- App Server 和 Remote Transport 可能随 Codex 版本变化；仓库必须记录并验证支持的精确 Codex CLI 版本。
- TypeScript 实现应优先使用 `codex app-server generate-ts` 生成类型。
- Schema 生成物必须记录对应 Codex 版本；升级 Codex 时检查协议差异。
- 每个 Transport 连接只允许执行一次 `initialize`，成功后发送 `initialized`。
- 不在 initialize 完成前发送其他请求。
- 必须区分 JSON-RPC Response、Notification 和 Server Request。
- Request ID 必须唯一关联 Pending Response，并在断线、超时或关闭时完成清理。
- 服务器未知通知可以记录并安全忽略；需要响应的未知 Server Request 不得静默挂起。
- 实验 API 只有在功能确实需要时才启用，并为不支持版本提供明确错误。
- 第一阶段稳定协议类型不得依赖使用 `--experimental` 生成的字段。
- WebSocket 入口返回 `-32001` 过载错误时，只自动重试可证明安全的只读或幂等请求；不盲目重试创建或写入操作。

## Thread 与会话规则

- 使用 `thread/list` 获取原生 Codex 会话，不自行重建会话索引。
- Thread 查询必须由服务端确定并显式传递允许的 `cwd`。
- 默认会话列表应显式设置 `sourceKinds`，不得依赖隐式默认值。
- CLI 与 Telegram 互通时，显式考虑 `cli`、`vscode` 和 `appServer` 来源；当前锁定版本的 Remote TUI 实测会产生 `vscode` 来源。
- 自动接续前检查 Thread 的来源、Workspace、运行状态和当前绑定。
- 不自动接续已由其他外部 conversation 独占的 Thread。
- 对 `active` Thread 必须采用明确策略，不得无条件追加新 Turn。
- 切换、退出或新建会话时，按协议需要调用 `thread/unsubscribe`，不能只删除本地映射。
- `thread/resume`、`thread/read` 和状态通知的服务端返回值是事实来源，本地缓存只用于加速和界面展示。
- 不因 `thread/resume` 本身推断会话更新时间已经改变。

## 数据持久化规则

- 单用户、单 Gateway 默认使用内存保存 chat-to-thread 绑定，不新增数据库。
- 多用户或多实例需要重启后恢复绑定时，通过 `StateStore` 接口增加最小持久化。
- 持久化内容仅限用户、Workspace、Thread ID、权限和必要偏好。
- 不持久化 Codex 消息正文、Turn/Item 历史或 rollout 副本。
- 单机多用户优先 SQLite；分布式多实例确有需要时才考虑 PostgreSQL。
- 未出现分布式队列、缓存或锁需求前，不引入 Redis、Kafka、NATS 等基础设施。
- 新增依赖或持久化格式前必须说明必要性、迁移方式和回滚方案，并取得用户确认。

## 事件与并发规则

- App Server Reader 只负责读取、解析、关联 Response 和投递事件。
- App Server Reader 不得等待 Telegram、Discord、Web 或其他外部网络发送。
- 每个外部 Surface 使用独立的有界输出队列。
- 同一 conversation 的最终输出保持顺序，不同 conversation 可以并行。
- 队列过载时可以合并或丢弃中间 delta，但不得静默丢弃审批、错误、`item/completed` 或 `turn/completed`。
- Telegram 流式编辑必须限速、合并并避免发送相同内容。
- Telegram API 的超时或限流不得阻塞 App Server 的协议读取。
- 后台任务必须有明确所有者、取消路径和关闭等待上限。
- 不允许无界队列、无界重试或没有抖动的集中重连。

## 审批与交互规则

至少为以下 Server Request 提供明确处理策略：

- 命令执行审批；
- 文件修改审批；
- 权限申请；
- 用户输入请求；
- MCP elicitation；
- App 工具产生的确认流程。

审批要求：

- 审批状态绑定 `threadId`、`turnId` 和 `itemId/requestId`。
- Telegram 回调令牌必须不可预测、一次性使用并设置过期时间。
- 已由 CLI 或其他客户端处理的请求，应通过 `serverRequest/resolved` 使旧界面失效。
- 发起 Turn 的 App Server 连接负责该 Turn 的 Server Request；不得假设 CLI 与 Gateway 可以跨连接抢答同一个审批。
- 未识别或无法路由的高权限请求默认拒绝或取消，不得默认批准。
- “批准一次”和“会话持续批准”必须明确区分，不能将一次批准升级为长期授权。
- 不在日志中输出凭据、Token、Cookie、Authorization Header 或敏感表单内容。

## 安全约束

- Telegram 用户只能选择预配置 Workspace，不允许通过消息提交任意绝对 `cwd`。
- 所有 Thread、Turn、Shell 和文件操作前执行用户与 Workspace 授权检查。
- App Server Unix Socket 父目录权限应为 `0700`，Socket 不得对无关用户开放。
- 不将无认证 App Server 监听到非回环网络地址。
- 非本机访问优先使用 SSH 端口转发；公开远程访问需要 TLS 和认证方案。
- `thread/shellCommand` 在沙箱外执行，只能由明确用户动作触发。
- 默认不自动批准命令执行、文件写入、额外文件系统权限或网络权限。
- 配置错误必须失败关闭，不得静默扩大权限或切换到更宽松模式。
- 日志清洗必须覆盖应用日志、异常、HTTP 客户端和第三方库日志。

## 扩展规则

- 第一阶段扩展采用编译期显式注册，不动态扫描并执行任意第三方代码。
- 新增 Surface 时实现统一输入、输出和审批接口，不修改 Conversation Core 的平台无关逻辑。
- 新增命令时优先映射 App Server 已有能力，避免建立重复状态。
- Codex Skill 用于模型工作流和操作指导，不用于实现实时 Transport、Thread 路由、事件循环或审批状态机。
- 只有出现真实的独立部署、权限隔离或扩容需求时，才从模块化单体拆分服务。
- 拆分前先保持模块公开接口稳定，并提供进程内实现作为基准。

## 实现要求

- 采用解决当前目标所需的最小完整实现。
- 优先使用明确类型和可辨识联合，避免协议核心使用不受约束的 `any`。
- 外部输入在边界验证；内部模块不重复验证同一数据。
- 错误必须保留可操作上下文，但不得泄露密钥和敏感内容。
- 不捕获过宽异常后静默继续；降级行为必须可观察。
- 不将网络、协议、状态、渲染和存储职责放入同一个大型类或文件。
- 不新增与当前任务无关的抽象、配置选项或兼容层。
- 修改公开命令、配置键、持久化格式或默认行为时，同步更新 README、示例配置和测试。

## 测试与验证

每次修改运行与改动最相关的最小验证。核心路径至少覆盖：

- App Server initialize 握手。
- JSON-RPC Response、Notification、Server Request 分流。
- `thread/list`、`thread/start`、`thread/resume` 和 `turn/start`。
- CLI 创建 Thread 后 Telegram 能发现并接续。
- Telegram 创建 Thread 后 CLI 能发现并接续。
- Thread 切换后旧订阅被取消。
- Telegram 超时不会阻塞 App Server Reader。
- Gateway 重启不会主动终止共享 App Server。
- 审批超时、拒绝、跨客户端解决和过期回调。
- 日志不包含 Telegram Token 和其他敏感凭据。

协议或 Transport 修改应增加真实 App Server 冒烟测试；不能只使用 Mock 证明兼容性。

## 重构与删除规则

- 重构阶段保留 Git 历史，不通过删除仓库或重新 `git init` 规避迁移审查。
- 已删除的 Python Bridge 不作为兼容入口恢复；需要兼容行为时在当前模块边界内实现。
- 删除或替换现行 TypeScript 模块时同步删除孤儿入口、依赖、配置、脚本和测试，并更新文档。
- 不覆盖或回退用户现有未提交改动；发现重叠修改时先检查差异并说明风险。
- 不执行 `git commit`、`git push`、历史改写或远端操作，除非用户明确要求并完成必要审批。

## 交付要求

完成修改时说明：

- 修改了哪些模块和行为；
- 运行了哪些测试或冒烟验证；
- 是否涉及协议、配置、持久化或安全边界；
- 尚未覆盖的风险和下一步；
- 是否影响当前单一 TypeScript 实现或尚未启用的服务部署方式。
