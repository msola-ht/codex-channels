# 测试

本目录包含 Vitest 单元测试、模块边界测试和条件式真实 App Server 集成测试。测试文件按被测模块命名并使用 `.test.ts` 后缀。

## 覆盖范围

- JSON-RPC initialize、生成类型约束的精确出站消息、初始化断线竞态、消息分流、超时、过载
  重试和断线清理。
- Thread 新建、列表、恢复、切换、删除、订阅、恢复失败绑定保留、关闭/归档/删除通知语义、
  官方响应到稳定路由快照的映射与必需字段失败关闭、活动 Turn 重启恢复和 Workspace 路由。
- Thread 设置、归档、删除和关闭 Notification 到稳定 Routing 事件的映射，残缺或无关通知隔离，
  以及 Routing 不再解析原始协议信封。
- 活动 Turn 的即时 steer 与下一 Turn 有界内存队列、顺序启动、Thread 隔离和失败清理；项目输入
  到官方 `UserInput` 的映射，以及 Review、Goal 和控制响应到稳定 Application 结果的映射。
- 官方 Turn、Item、Diff、Plan、Goal、Token、账户、额度、MCP 和 warning Notification 到稳定 Core
  输入事件的映射，畸形与未知通知隔离；Conversation Core 状态归约、严格 Turn 完成状态、
  可重试错误隔离、Thread/全局警告路由，以及 Client 边界的操作摘要与敏感文本清洗。
- 命令、文件修改、临时权限、用户输入和 MCP 审批的归属信息、一次/会话批准、命令前缀及网络
  规则持久授权、网络专用请求、目标主机一致性、拒绝、无法路由、协议能力约束、一次性回调、
  超时和跨客户端解决；五类 Server Request 到稳定 Approval 请求及稳定决定到官方响应的双向
  适配、畸形请求安全拒绝和未知请求明确报错。
- Bootstrap 部分启动回滚、启动中停止的单次组件关闭、重连取消与关闭等待；飞书按配置显式注册、
  允许名单热加载、撤权绑定清理，以及安全 Chat 配置与启动通知。
- 通用 Surface 启停、按账号输出路由与失败隔离；Telegram 格式、通知降噪、长回复折叠与文件回退、
  输出队列顺序与并发关闭等待、生命周期、API 重试及图片输入。
- 飞书官方 SDK 事件长连接的凭据预检、真实握手就绪、启动失败与超时、重连状态、脱敏生命周期
  日志、停止竞态、SDK 消息字段裁剪、运行状态门控和错误脱敏；文本、静态 CardKit Markdown 与
  `post + md` 降级发送的
  精确 `chat_id` Payload、平台原生提及标签中和、有限 HTTP
  超时、SDK 错误脱敏和残缺响应失败关闭；CardKit 2.0 原生流式卡片创建、消息引用、元素更新和
  结束设置的精确 Payload、递增序列与 UUID、短回复静态卡片、300 ms 增量合并、单卡滚动、
  代码围栏衔接、卡片与回退共用五条预算、明确截断、失败卡片尽力结束、UTF-16 摘要边界、
  Turn/关闭收尾、HTTP 429 与官方频控码的稳定分类、中间帧跳过、后续增量继续及终态完整
  富文本回退；消息资源图片下载的精确
  `message_id + image_key + type=image` Payload、资源标识约束、长度裁剪和错误脱敏；私聊文本
  与图片 Inbox 的账号/类型/授权筛选、同步有界
  入队、授权拒绝不污染去重键、事件去重、旧事件过滤、同 Chat 顺序、跨 Chat 并行、过载重试和有限关闭；卡片动作
  稳定字段裁剪、受限字符串动作值、畸形输入失败关闭和 WebSocket 独立分流；所有关键
  `OutputEvent` 的 CardKit Markdown 最终回复、启动环境与脱敏 UA、每轮上下文和设置的紧凑
  CardKit Markdown、纯文本安全回退、
  操作终态静态卡片与助手消息顺序和上游错误详情隐藏；Outbox
  的精确账号路由、同 Chat 顺序、跨 Chat 并行、静态 CardKit 单元素 5,000 字符与最多 5 张卡片、
  纯文本及降级富文本 20,000 字节上限、
  明确截断与关闭等待；同一 Thread 的 active/idle 轻量状态卡片创建、重复抑制、顺序更新、更新错误
  分类、失败绑定清理和关闭超时后的迟到结果隔离；操作详情、状态、耗时和退出码的
  运行帧忽略、终态静态 CardKit 发送及会话顺序；已授权文本和 PNG/JPEG 图片到 Application
  的提交、10 MiB 限制、内容签名校验、私有暂存、过期清理、活动 Turn 追加提示、命令参数透传、
  全部平台无关命令结果种类与 Outcome、模型视图、
  非空集合、会话列表条数与预览边界、Diff、Plan、Goal、本地帮助/身份/取消、未知斜杠命令
  失败关闭、输出队列拒绝不重试状态修改、结构化用户错误和
  未知异常脱敏；单账号 Surface 的长连接启停、重连事件去重、关闭排空、连续输入过载提示收敛和配置通知
  失败关闭与安全发送；审批、最多三个问题的用户输入表单、秘密输入、MCP JSON/URL 卡片，
  `form_value` 边界、非法选项/JSON/URL 拒绝、取消和处理结果脱敏；按严格配置注册及允许名单
  热加载；飞书 `status/doctor` 的运行观测、四项精简摘要、租户 Scope 差集、单一处理入口、
  卡片与菜单运行时实证优先，以及 Application v7 配置快照、已有菜单保留、待发布版本提示、
  App/Chat/Actor 一次性确认、SDK 应用授权、授权卡片发送失败取消和 Lark 租户拒绝；
  分类命令中心、统一 Application 命令目录、有界选择值绑定、一次性通用输入表单、会话与归档
  搜索、表单动作/字段/长度失败关闭、直接写操作重复点击拒绝和命令任务的有限关闭等待；OAuth Device Flow
  请求/轮询、精确授权 Origin 与完整 URL、混合 Token 类型、能力所需 Scope 与应用已开通 Scope
  的交集、空需求不授权、有效 Token 覆盖检测与缺失差集申请、`offline_access` 飞书内授权卡片、统一 HTTP/HTTPS 代理、`NO_PROXY` 选择、显式
  直连和无效代理失败关闭、Actor 身份匹配、进行中状态、重复流、限时停止/撤销竞态、写入错误/
  取消回滚，以及 macOS Keychain 原地更新与命令超时、严格凭据载荷、macOS/Linux 分离的 Token
  Store 契约和 Linux 原子密文替换与私有权限。
- Skill 用户与 Workspace 安装过滤、已安装 Plugin 稳定摘要及远端市场隔离。
- 官方模型目录到稳定 Application 模型选项的映射、不可见项过滤、必需字段失败关闭，模型、
  思考强度和 Fast 的 Thread 覆盖、Codex 用户级 Fast 默认值持久化、共享客户端完整或残缺设置
  通知、Thread 失效通知及 Gateway/CLI 连接恢复。
- 账户 Token 用量与单桶/多桶额度到稳定 Application 摘要的映射、重置券数量、畸形指标与未知
  枚举失败关闭，以及启动时周限缓存继续使用同一映射结果。
- Skill 查询按授权 Workspace 发送精确 CWD，Client 只映射启用的用户与项目直接安装项，排除
  系统和插件缓存并在缺少显示字段时失败关闭。
- MCP 查询按当前 Thread 读取项目级配置，使用精简清单分页并映射名称、认证状态和工具数量；
  必需字段畸形或分页游标循环时失败关闭。
- Plugin 查询按授权 Workspace 发送精确 CWD，只调用已安装接口并映射名称与启用状态；安装建议
  和 Marketplace 加载详情不进入 Application，必需字段畸形时失败关闭。
- Permission Profile 查询按授权 Workspace 发送精确 CWD，分页映射 ID、说明和策略可选状态；
  必需字段畸形或分页游标循环时失败关闭，并与高权限审批决定保持分离。
- SQLite 最小绑定恢复、当前版本 Schema 缺失失败关闭、配置热加载与自动重启分类、Setup
  类别与通讯渠道菜单、Telegram Setup、飞书手动输入与扫码注册的消息和 CardKit 最小权限、卡片动作回调
  声明、应用选择、Bot 身份验证、授权域名约束、允许名单确认、原子保存和错误脱敏、
  CLI 项目规则生成/检查、launchd、systemd、Unix WebSocket 请求头、模块依赖方向和公开入口边界。
- Workspace 不可变授权快照、热加载失败回滚、选择歧义，以及 Telegram Surface、账号和规范
  Actor ID 的联合授权；飞书 Surface、App 账号和 `open_id` 精确允许名单及原子替换。
- 飞书卡片动作与表单字段裁剪、私聊审批/用户输入/MCP 卡片、一次性令牌、
  Actor/Chat/消息/请求绑定、请求原值决定、越权与重复动作、重复请求失败关闭、超时、
  卡片创建悬挂时的有限关闭、结果卡更新失败隔离和跨客户端失效。
- Event Bus 容量、关键事件保护、关闭后拒绝订阅、并发关闭等待、慢消费者超时和消费者失败隔离。
- 统一 Logger 异常元数据约束，以及 Token、App Secret、Authorization、Password 和 Cookie
  字段脱敏。
- TOML、热加载分类、标准环境变量、macOS 系统代理和 Linux GNOME 代理的优先级，以及 Telegram
  Setup 对同一解析结果的复用；无代理时不注入空环境变量；飞书启用/禁用、凭据和允许 Open ID
  的严格映射、畸形与未知字段拒绝，以及启用/凭据重启和允许名单热加载分类。
- CLI Doctor 的严格 TOML Schema 校验、共享 App Server 握手与实际版本匹配、飞书凭据/Bot
  身份有限探测、敏感错误清洗和只读诊断；项目规则限定当前 Workspace、
  拒绝远程覆盖和符号链接路径逃逸；CLI 分级帮助、规范命令名称及 macOS/Linux 服务目标选择；
  一级模块使用完整依赖允许列表并要求跨模块只导入公开入口；Session Routing 不得依赖具体
  Client 或生成协议，Conversation Turn 测试不得伪装成完整 Client；生产源码只有 Codex Client
  可以导入生成协议，业务模块不得依赖具体 Client。
- 仓库 Git hooks 自动安装与重复执行安全性，以及无本地依赖时的源码安装准备。
- 协议临时生成失败时保留现有类型目录、生成树逐文件比较和安全替换。
- Codex CLI 升级准备脚本的精确版本参数、CLI 输出、干净工作区保护和 Codex 审查交接。
- 官方稳定 Release 校验，以及 CI 升级差异摘要中的文件和协议目录数量。
- 官方 Alpha 过滤与版本排序、GitHub 临时错误有限重试、无差异失败报告，以及临时 Git Index
  对新增文件的完整捕获。
- GitHub Release 响应正文中断后的有限重试，以及目标版本未解析时仍可生成失败报告。
- 升级验证在单项失败后继续执行、保存独立日志和结构化结果，以及 RPC 方法和顶层必填字段差异
  的自动报告。

常规验证：

```bash
npm test
```

生成包含未执行源码的 V8 Coverage 报告：

```bash
npm run test:coverage
```

HTML 报告写入被 Git 忽略的 `coverage/`；当前只记录基线，不设置缺乏依据的强制覆盖率阈值。

CI 中的隔离 App Server 合同测试要求安装受支持的 Codex CLI，但不需要登录，也不会调用模型：

```bash
RUN_CODEX_CONTRACT=1 npm test -- --run tests/real-app-server.test.ts
```

该合同测试使用临时 `CODEX_HOME`，验证一个 Client 写入的 Fast 用户默认值能被另一个 Client
读取，之后新建 Thread 的运行时 `serviceTier` 按 `default → priority → default` 变化，并验证
第二个 Client 修改共享 Thread 的模型、思考强度和 Fast 设置时，订阅方收到完整的
`thread/settings/updated`；第二个 Client 重连后再次修改仍会广播。合同还会启动并立即清理一个
不等待模型结果的 Turn，验证稳定 Turn ID、Skill、MCP、Plugin 与 Permission Profile 查询摘要，
以及跨 Client 的 Goal 设置、读取和清除映射；第二个 Client 重新连接并 resume 当前 Thread 后，
还必须重新收到已有 Goal 状态。

使用当前用户配置的完整 Unix WebSocket/App Server 冒烟测试同样不会调用模型：

```bash
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

默认真实测试会让两个 Client 连接同一个临时 Unix WebSocket App Server，验证一个连接创建的
临时 Thread 会实时广播到另一个连接，并出现在共享的 loaded Thread 列表中；该流程不会启动
模型 Turn。若还要验证两个连接依次读取和恢复同一个已有会话，可显式指定当前 Workspace 中
空闲且允许临时订阅的 fixture Thread：

```bash
CODEX_RESUME_FIXTURE_THREAD_ID=<thread-id> \
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

新增行为应优先扩展最接近的现有测试文件；协议或 Transport 修改还必须增加真实 App Server 验证，不能只依赖 Mock。
