# 通讯渠道 Surface 接入指南

## 目的

本指南规定如何在当前 TypeScript 模块化单体中新增通讯渠道。
目标是通过新增真实 Surface 持续验证现有边界，而不是复制已有渠道、建立插件框架或再次重构核心。

新增渠道应形成一个可独立装配、测试和停止的平台模块，同时继续共享 Application、Conversation
Core、Approval、Policy、Session Routing、Storage 和 Event Bus。App Server 仍是 Thread、
Turn、Item、Goal 和历史的唯一事实来源。

本文区分三类内容：固定架构、模块边界、安全要求和禁止模式是必须遵守的约束；带有具体类型或
方法名的内容描述当前公开合同；目录拆分和分阶段顺序是实施建议，可以按真实渠道需求裁剪。若新增
Surface 证明当前公开合同不足，应先单独评审合同、依赖方向和测试变更，再同步更新本指南，不能让
平台模块通过内部导入或复制核心逻辑绕过合同。

具体平台计划必须继续服从本指南。当前飞书的分阶段范围、组合工厂、身份、输入队列、配置和验证
设计见 [`飞书 Surface 接入计划`](feishu-surface-plan.md)；微信 ClawBot 的官方协议研究、
凭据边界、分阶段范围和停止条件见 [`微信 Surface 接入计划`](weixin-surface-plan.md)。

## 固定架构

```text
Bootstrap 显式组合工厂
      │ 创建、注册并管理生命周期
      ▼
Surface 平台模块 ─────────► 平台 SDK / API
  ├─ 输入解析与平台身份规范化
  ├─ 平台文案、布局、按钮和文件传输
  ├─ InteractionPort
  └─ 每 Conversation 输出队列
      │
      ├──────────────► Application 命令与会话用例
      ◄─────────────── Conversation Core 的 OutputEvent
      ◄─────────────── Approval 的 InteractionRequest
```

依赖方向保持为：

```text
Surface -> Application/Core <- Codex Client
                     ^
              Policy / Storage
```

- `bootstrap` 是唯一组合根，只选择具体实现、注册交互端口并协调生命周期。
- `surfaces` 只适配平台，不解析 App Server RPC，也不访问 Transport。
- `application` 返回平台无关的结构化结果，不包含平台 SDK 类型或平台文案。
- `conversation-core` 只产生平台无关的 `OutputEvent`，不识别聊天平台。
- `approval` 维护一次、会话、命令规则和网络规则的授权语义；Surface 只展示请求并返回用户决定。
- `policy` 校验 Surface、账号、Actor 和 Workspace；平台事件不能绕过授权直接进入 Application。
- `storage` 只保存恢复绑定所需的最小状态，不保存消息正文、平台回调原文或完整历史。

不要为新渠道改变上述方向，也不要扩大
[`tests/module-boundaries.test.ts`](../tests/module-boundaries.test.ts) 的白名单来绕过边界。

### Codex 能力门禁

Surface 只能适配项目已经接入的 Codex CLI/App Server 能力。当前公开能力以
[`Codex CLI 官方资料与实现索引`](index.md) 的支持矩阵为准，并且必须同时具有当前锁定版本的
官方协议依据、`codex-protocol` 受控类型、本地实现入口和对应验证。生成类型中出现字段或方法，
以及平台 SDK 自身能够展示按钮、表单、文件或流式内容，都不能单独作为新增 Gateway 能力的依据。

新增 Codex 能力时，先在 `docs/index.md` 记录官方方法、本地入口和验证方式，再完成协议导出、
Client/Application/Core 适配与真实 App Server 合同，最后才由各 Surface 做平台呈现。条件不完整
时必须保持未支持或失败关闭，不能在某个 Surface 内模拟第二套 Thread、Turn、历史、工具、审批、
模型设置或状态归约。

Setup、Doctor、菜单、输入状态、连接健康、平台授权和媒体传输属于渠道运维或呈现能力，可以按
平台差异实现，但不得被描述为 Codex 原生能力，也不得伪造 App Server 事件。平台只负责运输和
展示已存在的结构化输入、输出与交互；平台能力强于当前 Codex 输入合同时，仍以 Codex 合同边界
为准。

### 公开合同

跨模块使用能力时只能从对应一级模块的 `index.ts` 导入。下表列出接入新渠道最常用的合同，
不是需要在本文重复维护的完整导出清单；实际可用能力始终以对应 `index.ts` 为准：

| 一级模块 | 通用合同 | 使用位置 |
| --- | --- | --- |
| [`surfaces`](../src/surfaces/index.ts) | `SurfaceAdapter`、`SurfaceOutputPort`、`SurfaceConfigurationChange`、`ConversationDeliveryQueue` | 平台模块与 Bootstrap |
| [`application`](../src/application/index.ts) | `ConversationService`、`ConversationCommandService`、`ConversationCommandResult`、通用命令名称与类型判断 | 平台模块 |
| [`approval`](../src/approval/index.ts) | `InteractionPort`、`InteractionRequest`、`InteractionDecision` | 平台模块与 Bootstrap |
| [`conversation-core`](../src/conversation-core/index.ts) | `ConversationTarget`、`OutputEvent`、`SurfaceId`、`UserFacingError`、`isCriticalOutputEvent` | 平台模块 |
| [`policy`](../src/policy/index.ts) | `SurfaceAccessContext`、`SurfaceAccessPolicy`、`ConversationActorRegistry`、`Workspace` | 平台模块与 Bootstrap |
| [`config`](../src/config/index.ts) | `GatewayConfig`、`ConfigChange` 及配置重载分类 | Bootstrap 组合与配置生命周期 |

具体平台类可以通过 `surfaces/index.ts` 暴露给 Bootstrap 组合，但不属于其他渠道可依赖的通用
合同。具体存储实现和 Bootstrap 内部组合类型同样不是平台合同。新渠道不得导入其他一级模块的
内部文件，也不得要求核心模块认识平台 SDK 类型。

## 身份模型

所有渠道必须先把平台身份转换为现有稳定模型：

| 概念 | 稳定表示 | 要求 |
| --- | --- | --- |
| Surface | `surface` | 稳定的小写名称，例如 `telegram`、`feishu` |
| 平台账号 | `accountId` | 标识一个 Bot 或应用实例，不使用显示名称 |
| Conversation | `conversationId` | 平台会话的规范 ID；群聊和私聊不得发生碰撞 |
| Actor | `actorId` | 平台用户的规范 ID，不从 Conversation ID 推断 |
| 完整目标 | `ConversationTarget` | `surface + accountId + conversationId` |

`surface + accountId` 必须唯一对应一个运行中的 `SurfaceAdapter`。完整 Conversation 身份由
`surface + accountId + conversationId` 唯一确定；不同 Bot、租户或渠道即使返回相同聊天 ID，
也不能共享绑定。

多账号支持只有在当前渠道确实需要时才实现。每个账号创建独立 Adapter 和访问策略；平台客户端
可以独立创建，也可以在平台模块内部安全共享，但凭据、收件人、限流状态和生命周期不能跨账号
泄漏。账号分支不得散落到 Core、Application 或 `SurfaceManager`。

## 组合式模块

### 平台目录

平台实现放在 `src/surfaces/<surface>/`，并只通过自己的 `index.ts` 公开所需能力。可按当前需求
拆分以下职责，但不要为了目录对称预先创建空文件：

```text
src/surfaces/<surface>/
├── index.ts          # 平台模块公开入口
├── adapter.ts        # SurfaceAdapter、输入处理和生命周期
├── renderer.ts       # 结构化命令结果与用户错误的平台渲染
├── interactions.ts   # InteractionPort 与跨客户端失效
├── outbox.ts         # OutputEvent、顺序、降噪和平台发送
└── api-executor.ts   # 平台超时、限流和有限重试
```

平台目录的 `index.ts` 是该平台内部出口；Bootstrap 需要的 Adapter 或组合接口还必须由一级模块
[`src/surfaces/index.ts`](../src/surfaces/index.ts) 受控转出。Bootstrap 不得直接导入
`src/surfaces/<surface>/index.ts`，平台出口也不得暴露 SDK 类型或仅供测试的内部帮助函数。

平台 SDK 类型只能留在该平台目录内。不得把 SDK 的 Message、User、Card、Callback 或 Error 类型
带入 Application、Core、Approval、Policy、Storage 或其他 Surface。

### 通用 Surface 合同

新 Adapter 必须实现由 [`surfaces/index.ts`](../src/surfaces/index.ts) 公开的
`SurfaceAdapter`：

- `surface` 和 `accountId`：提供稳定路由身份。
- `interactions`：实现 `InteractionPort`，处理审批、用户输入和 MCP elicitation。
- `output.handle(event)`：只做同步入队，不等待平台网络请求。
- `start()`：启动平台客户端或长连接；失败必须抛出，由组合根回滚已启动模块。
- `stop()`：拒绝新输出，取消平台监听，有限等待在途发送；必须可重复调用。
- `configurationChanged?()`：异步入队普通配置生命周期通知，不向上抛平台网络失败。
- `deliverConfigurationChange()`：等待持久配置事件实际送达；失败必须抛出，使事件保留待重试。

不要因为新平台需要额外方法就扩展通用 `SurfaceAdapter`。平台专属的收件人替换、凭据刷新或
卡片能力应由 Bootstrap 内部的平台组合接口描述，再封装进当前运行时模块的热加载和重启通知
钩子。平台目录不得反向导入 Bootstrap 的内部组合类型。

即使第一阶段还没有平台交互界面，`interactions` 也不能使用空对象、永不完成的 Promise 或抛错
占位。注册后的端口必须立即按 `InteractionRouter` 的未注册回退语义失败关闭：

| 请求 | 安全决定 |
| --- | --- |
| `approval` | `{ type: "approval", approved: false }` |
| `user-input` | `{ type: "user-input", answers: {} }` |
| `elicitation` | `{ type: "elicitation", action: "cancel", content: null }` |

此时没有待处理交互，`resolved()` 和 `cancelAll()` 可以为空操作。不要仅为这个占位提前建立通用
交互基类；至少两个实际 Surface 证明需要复用时，再评估是否从现有失败关闭逻辑抽取最小帮助函数。

### 内置插件与组合工厂

在 [`surface-plugin.ts`](../src/bootstrap/surface-plugin.ts) 定义的编译期内置插件契约上为渠道建立
独立工厂，并在 [`surface-composition.ts`](../src/bootstrap/surface-composition.ts) 的固定注册表
中显式加入：

```text
BuiltInSurfacePlugin
├── Telegram -> 1 个默认账号实例
├── 飞书 -> 0 或 1 个配置账号实例
└── 新渠道 -> 0 到多个配置账号实例
```

内置插件及具体渠道工厂都留在 Bootstrap 内部，不是 Surface 公开合同，也不是外部 npm 插件
API。插件 ID 必须与返回模块的 Surface ID 一致，同一个 `surface + accountId` 只能注册一次。

每个工厂负责：

1. 从已验证的 `GatewayConfig` 读取该渠道配置。
2. 清理该 `surface + accountId` 下已撤权 Actor 的绑定。
3. 创建该渠道的 `SurfaceAccessPolicy`。
4. 创建平台 Adapter，并注入 `ConversationService`、`SurfaceAccessPolicy`、
   `ConversationActorRegistry`、Logger 和致命故障回调。具体存储实现只留在 Bootstrap，
   Surface 不得导入 `storage`。
5. 返回 Bootstrap 当前使用的运行时模块描述，封装热加载与重启通知行为。

`createSurfaceModules` 只遍历编译期固定的内置插件注册表，不扫描目录、不动态加载包。不得向
`GatewayApplication` 增加任何具体平台的专属字段。

绑定处理必须区分两种状态：

- 渠道已启用，但某个 Actor 被撤权：组合工厂只清理该 `surface + accountId` 下已撤权 Actor
  对应的绑定，不能影响其他账号或渠道。
- 渠道或某个账号暂时未启用：不创建对应 Adapter，恢复订阅时由组合根过滤该
  `surface + accountId`；已有持久绑定必须保留，不能按撤权处理。重新启用后，组合工厂先按当前
  授权名单清理，再恢复仍然有效的绑定。

## 输入路径

每条会进入 Application 的平台业务输入按以下顺序处理：

1. 在 Surface 边界校验事件类型、账号归属、Conversation ID 和 Actor ID。
2. 构造 `ConversationTarget` 与 `SurfaceAccessContext`。
3. 调用该渠道的 `SurfaceAccessPolicy.isAllowed()`；未授权时停止处理。
4. 通过 `ConversationActorRegistry` 记录已确认的 Actor。
5. 普通文本或图片调用 `ConversationService.submit()`；通用命令调用
   `ConversationCommandService.execute()`。
6. 只渲染 `ConversationCommandResult` 或明确标记的结构化用户错误。

平台帮助、身份查询、回调取消和文件下载可以留在 Surface。Thread、Turn、Workspace、模型、
Fast、Goal、用量和扩展查询不得在平台模块中重新实现。

身份发现属于可选的平台接入能力，不是通用会话命令。渠道确实需要时，由该平台根据自身可信身份
字段和账号定向机制单独设计，只返回完成授权配置所需的最小身份信息，不读取会话业务状态，也不
调用 Application。平台帮助、回调取消和文件下载仍须按其能力执行正常授权，不能因实现位于
Surface 就自动豁免。

群聊必须使用“Conversation 与 Actor 分离”的模型：群 ID 是 `conversationId`，操作者用户 ID
是 `actorId`。不能因为 Bot 已加入群聊就默认授权群内所有用户。

## 输出与并发

Core 输出由 `SurfaceManager` 按精确 `surface + accountId` 路由。Adapter 的 `output.handle()`
不得直接等待平台 API；应使用
[`surfaces/index.ts`](../src/surfaces/index.ts) 公开的 `ConversationDeliveryQueue`，或提供相同约束：

- 同一 Conversation 串行，不同 Conversation 可以并行。
- 队列有容量上限，平台发送有超时。
- `OutputEvent` 的关键性必须使用 Conversation Core 公开的 `isCriticalOutputEvent()` 判断，不在
  Surface 复制事件类型清单；由关键事件派生的平台发送操作不得被降级为非关键。
- 只有该函数判定为非关键的中间事件才可以合并或替换；关键事件不得静默丢弃。
- 平台限流只做有限重试，不能阻塞 App Server Reader。
- 关闭时拒绝新输出，等待同一个有限关闭任务，不能提前报告完成。

审批不属于 `OutputEvent`，由 `InteractionPort` 单独投递；它同样不得丢弃或悬挂。若平台把输出
和交互合并到同一个内部发送调度器，审批必须在既有关键操作之后、等待中的非关键过程输出之前
入队；已经开始的平台请求不强制中断，并保持审批状态更新先于批准后的操作展示。接收、无绑定
安全拒绝、平台送达和失败日志只能包含请求身份、目标与受约束错误分类，不得包含审批正文。

平台文案、Markdown/HTML、卡片、按钮、消息编辑、提醒策略和文件回退全部属于 Surface。
不要把已有平台的格式器直接改名为通用格式器；只有两个实际 Surface 出现相同、稳定且不包含
平台语义的逻辑时，才抽取最小公共实现。

## 审批与交互

Surface 的 `InteractionPort` 只负责展示稳定 `InteractionRequest` 并返回
`InteractionDecision`，不得复制 `ApprovalCoordinator` 的状态机。

- 请求必须保留 App Server 提供的归属，不得补造标识：`requestId` 和 `threadId` 始终保留；
  `turnId`、`itemId` 只在对应 `InteractionRequest` 提供时保留。MCP elicitation 没有
  `itemId`，无法关联活动 Turn 时 `turnId` 可以为 `null`。
- 交互令牌必须不可预测、一次性使用并有超时。
- `resolved(requestId)` 必须使已被 CLI 或其他客户端处理的交互立即失效。
- `cancelAll()` 必须在关闭或连接失效时结束待处理交互。
- 一次批准不能升级为会话批准。
- 只有请求明确提供对应能力时，才显示会话、命令前缀或网络规则持久批准。
- 命令和网络规则必须原样返回，Surface 不合并、不推导、不扩大。
- 未识别、畸形、过期或无法路由的高权限请求默认拒绝或取消。

平台不支持安全交互控件时，不得用宽松的文本解析代替按钮或表单。该阶段应明确拒绝，直到有
经过测试的一次性交互方案。

## 配置与设置

新增渠道配置必须进入统一 `config.toml` 和共享严格 Schema，不创建独立 `.env`、JSON 或平台
配置文件。

1. 在 `runtime/gateway-config.mjs` 增加严格配置结构。
2. 在 `src/config/index.ts` 映射为运行时配置，并完成 URL、路径或平台 ID 的语义校验。
3. 在 `config-change.ts` 增加精确的变更代码和 Surface scope。
4. 在 `reload-classifier.ts` 明确每个字段属于热加载、Gateway 重启还是服务重装。
5. 在 `config.example.toml`、README、Setup 和 Doctor 中同步公开行为。
6. 凭据只显示“已配置”，日志、异常和平台通知不得输出原值。

渠道是否启用必须由已验证配置明确决定，不能通过“某个 Secret 恰好存在”推断。可选渠道缺少
配置时应保持禁用；一旦出现配置块，必填字段缺失或未知字段必须失败关闭。其他既有渠道的必填、
可选或默认启用语义属于独立产品决策，不能作为接入新渠道的顺手修改。

配置变更的 scope 当前按 Surface，而不是按账号路由：

- `reloaded` 只发给匹配 Surface；Workspace 等 `global` 变更发给所有 Surface。
- `restarting`、`reinstall-required` 和 `reload-failed` 会影响整个 Gateway，必须发给所有已启动
  Surface。非目标 Surface 收到的 `changes` 可以为空，此时仍要显示不包含其他平台私有原因的
  通用进程通知。
- 一个 Surface 有多个账号时，不得把某个账号的凭据或私有原因发送给其他账号。初次接入优先采用
  单账号；确有多账号需求时，账号集合或凭据变化应整体重启，或由各平台运行时模块
  根据已验证配置精确选择自己的通知收件人，不能擅自把账号 ID 加入通用 Core 事件。

统一设置入口仍是 `codexc setup`。渠道可以拥有独立的 `scripts/<surface>-setup.mjs`，但必须由
设置菜单组合调用；不得让具体渠道重新成为顶层 Setup。

## 存储与安全

- 不改变当前 SQLite Schema，除非新渠道确实需要恢复绑定之外的最小字段，并先单独评审迁移方案。
- 由操作者明确输入、属于静态应用配置的 Bot Token、App Secret 等平台凭据保存在权限受限的统一
  `config.toml`，不得复制到 SQLite、日志、服务定义或其他平台文件。扫码登录、OAuth 或其他平台
  授权流程签发的账号 Token 不属于静态应用配置；需要跨重启使用时必须保存到项目规定的 macOS
  Keychain 或 Linux 加密凭据后端，不得写入配置或 StateStore。SDK 使用应用凭据自动换取且可以
  重新获取的短期租户 Access Token 只保留在进程内存中，不另行写入磁盘。
- 新增一种持久账号 Token 前，必须先评审其独立命名空间、严格载荷 Schema、版本、账号键、撤销、
  原子替换、损坏处理和回滚方式，并说明是否改变现有凭据格式。可以复用平台无关的 Keychain、
  加密与私有文件机制，但不得直接复用其他 Surface 的载荷类型、Keychain Service、文件名或账号
  键，也不得为了统一存储迁移现有 Surface 凭据。
- 不持久化消息正文、回调原文、卡片内容、Diff、Plan 或审批详情。
- 临时下载必须限制大小、类型、路径和保留时间，保存到用户数据目录并定期清理。
- 外部用户只能选择配置中已授权的 Workspace，不能提交任意绝对路径。
- 平台 API 错误只记录受约束的错误类型和机器码，不记录响应正文、Header、Token 或用户输入。
- 一个 Surface 故障耗尽重试后，通过组合工厂注入的致命故障回调向 Bootstrap 报告精确
  `surface + accountId` 和受约束的错误；由进程管理器恢复。平台模块不得自行退出整个进程或
  终止共享 App Server。

## 分阶段实施

每次只完成一个可验证的纵向切片：

### 阶段 1：最小文本闭环

- 严格配置、账号身份和访问策略。
- Adapter 启停与致命故障上报。
- 一个受支持 Conversation 类型的文本输入、Application 提交和最终文本输出；平台支持私聊时
  优先使用私聊完成首个闭环。
- 每 Conversation 有界输出队列。
- 立即返回安全决定的失败关闭 `InteractionPort`，不展示或等待审批交互。
- 组合工厂和恢复绑定过滤。

这一阶段不同时实现其他 Conversation 类型、图片、文件、全部命令、富卡片和可操作的审批界面。

### 阶段 2：命令与审批

- 渲染 `ConversationCommandResult` 和结构化用户错误。
- 实现命令、文件、权限、用户输入和 MCP elicitation 五类稳定交互及跨客户端失效。
- 覆盖一次、会话、命令前缀和网络规则的能力判断。
- 增加状态、停止、Workspace 和会话切换等主路径。

### 阶段 3：平台增强

- 图片和文件安全下载。
- 流式消息编辑、长文本和代码文件回退。
- 平台卡片、降噪通知和输入表单。
- 其余命令与平台体验优化。

只有前一阶段的边界、失败路径和关闭语义通过审查后才进入下一阶段。

## 验证要求

新增 Surface 至少覆盖：

- 未授权 Surface、账号、Actor 和 Workspace 失败关闭。
- 实现身份发现时，覆盖该平台的可信 Actor 字段、账号定向、最小信息暴露和非身份输入不能借此
  进入业务能力。
- 未实现交互界面时，三类 `InteractionRequest` 分支立即返回安全决定，不抛错或悬挂。
- Conversation 与 Actor 分离，多个账号之间不串路由。
- 撤权只清理对应 Actor；禁用 Surface 或账号保留绑定但不恢复订阅。
- 普通输入、命令和结构化用户错误主路径。
- 同 Conversation 顺序、不同 Conversation 并行、队列过载和平台超时隔离。
- `isCriticalOutputEvent()` 判定的事件及其派生发送操作不被降级或丢弃，非关键事件才允许合并。
- 审批请求不被丢弃或悬挂。
- 审批超时、一次性令牌、跨客户端失效和关闭取消。
- 部分启动失败反向回滚，重复关闭安全，关闭等待有上限。
- 热加载、重启、重装和配置事件确认语义。
- 其他 Surface 引起进程重启或重装时，当前 Surface 收到不泄露私有原因的通用通知。
- 敏感字段、平台错误和未知内部异常不进入日志或外部消息。
- `module-boundaries.test.ts` 继续通过，不新增协议或具体 Client 泄漏。

平台 SDK 的 Mock 测试只验证 Surface 边界；Application、Core、Approval 和 Routing 继续使用各自
现有测试。条件允许时增加平台测试租户或沙箱集成测试，但不得依赖真实模型调用完成常规提交门禁。

提交前运行：

```bash
npm run docs:check
npm run verify:commit
```

并同步更新根 README 文档索引、`src/README.md`、`src/surfaces/README.md`、新渠道目录 README、
测试索引、配置示例与公开 Setup/Doctor 说明。

## 禁止模式

- 复制一套 Session、Thread、Turn、审批或状态数据库。
- Surface 直接调用 JSON-RPC、读取 Codex 会话文件或解释生成协议。
- 在 Core、Application 或 Storage 中加入平台名称分支。
- 用全局事件广播替代按 `surface + accountId` 的精确路由。
- 为平台 SDK 类型建立跨模块“公共 DTO”镜像。
- 为尚未接入的平台建立动态插件系统、自动发现、外部插件 API 或兼容层。
- 为通过测试扩大模块依赖白名单。
- 因两个平台命名相似就提前抽取公共渲染器、Bot 基类或万能消息模型。
- 让 Setup、Doctor、配置热加载或服务管理出现平台专属顶层入口。

## 完成判定

一个新渠道只有同时满足以下条件才算接入完成：

1. 通过统一配置和 Setup 明确启用，可被 Doctor 安全诊断。
2. 实现公开的 `SurfaceAdapter`，并由组合根的内置插件显式注册。
3. 所有业务输入先授权，所有输出和交互按精确账号路由。
4. 禁用时保留绑定并停止恢复订阅，撤权时只清理对应 Actor。
5. 平台网络不会阻塞 App Server Reader，关闭与失败路径有界。
6. 不新增协议泄漏、平行会话状态或平台专属核心分支。
7. 文档、索引、配置示例和相关测试与实现一致。
8. `npm run verify:commit` 全部通过。
