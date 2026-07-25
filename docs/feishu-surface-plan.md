# 飞书 Surface 接入计划

## 状态与目标

本文是飞书通讯渠道的实施计划，不表示仓库当前已经支持飞书。实施必须继续遵守
[`通讯渠道 Surface 接入指南`](surface-integration-guide.md)；如果本文与通用指南冲突，以通用
架构和安全边界为准，并先单独评审需要调整的公开合同。

当前进度（2026-07-25）：已锁定官方 Node SDK `1.71.1`，并完成 Phase 0 的长连接生命周期窄封装、
消息事件稳定字段裁剪和离线合同测试；阶段 1 已完成平台本地私聊文本 Inbox、访问策略和
`OutputEvent` 纯文本渲染及有界 Outbox。该模块尚未注册到 Bootstrap，也没有飞书配置、SDK
发送适配或审批能力；测试应用的真实握手、
代理、事件投递和卡片动作实验仍待完成。

目标是在现有 TypeScript 模块化单体中增加一个编译期显式注册的飞书 Surface，使飞书与
Telegram、原生 Codex CLI 连接同一个 Codex App Server，共享 Thread、Turn、模型、Fast、Goal、
用量和审批事实来源。

首个可交付版本只验证一条最小完整纵向路径：

```text
飞书企业自建应用的单个 Bot 账号
        ↓ WebSocket 长连接
已授权用户的私聊文本
        ↓
Feishu Surface
        ↓
Policy / Application / Session Routing / Conversation Core
        ↓
现有共享 Codex App Server
        ↓
OutputEvent
        ↓
Feishu Surface 有界输出队列
        ↓
飞书私聊文本回复
```

第一阶段不追求 Telegram 功能完全对等。群聊、交互卡片审批、图片、文件和流式卡片必须在文本
主路径稳定后分别实施，不能扩大首个纵向切片。

## 不改变的边界

- App Server 继续是 Thread、Turn、Item、Goal 和历史的唯一事实来源。
- 不增加独立 Gateway、微服务、消息代理、会话数据库或飞书专属业务 Core。
- 飞书不得读取 Codex 会话文件，不得直接调用 JSON-RPC Transport。
- 飞书 SDK 类型只存在于 `src/surfaces/feishu/`，不得进入 Application、Core、Approval、
  Policy、Session Routing 或 Storage。
- 复用现有 `ConversationService`、`ConversationCommandService`、`InteractionPort`、
  `SurfaceAccessPolicy`、`ConversationActorRegistry`、`ConversationDeliveryQueue` 和
  `SurfaceAdapter`，不建立新的通用 Surface 基类。
- Bootstrap 仍是唯一组合根；飞书通过独立工厂显式装配，不扫描目录，不动态加载平台插件。
- 不为飞书修改 Codex App Server 协议、生成类型或当前锁定的 Codex CLI 版本。
- 第一阶段不修改 SQLite Schema，不持久化消息正文、飞书事件原文、卡片内容或审批详情。
- 新增 SDK 依赖前必须单独说明必要性、锁定版本、包体影响和回滚方式，并取得确认。

## 官方资料基线

实施前必须先查阅 [`飞书官方资料与实现索引`](feishu-reference-index.md)，再核对与当前阶段直接
相关的官方资料，并以准备锁定的精确 SDK 版本源码为准：

- [飞书/Lark 官方 Node SDK](https://github.com/larksuite/node-sdk)
- [官方 Node SDK 中文说明](https://github.com/larksuite/node-sdk/blob/main/README.zh.md)
- [官方 Channel 模块说明](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md)
- [飞书开放平台](https://open.feishu.cn/)

当前官方 SDK 提供低层 `Client`、`WSClient`、`EventDispatcher`，也提供封装传输、策略、去重、
串行、重试、流式卡片和媒体的高层 Channel。项目已经拥有授权、会话路由、有界输出队列、重试和
审批边界，因此默认选择低层 SDK 组合，避免高层 Channel 与现有模块重复管理策略和并发。

阶段 0 必须先锁定 SDK 版本并用最小实验确认：

1. 企业自建应用的 WebSocket 握手、断线重连和可取消关闭。
2. `im.message.receive_v1` 的当前事件结构、处理时限和重复投递行为。
3. 当前版本是否能通过同一长连接可靠接收卡片动作；如果不能，审批阶段是否需要 HTTPS 回调。
4. SDK HTTP 请求如何使用现有 `[network]` 代理环境，不新增飞书私有代理配置。
5. 飞书和海外 Lark 的域名及身份差异。本计划首版只支持飞书，不提前泛化 Lark。

官方 `main` 只用于发现当前方向；实现和测试不得依赖浮动 `main` 行为。选定版本后应在 lockfile
中精确解析，并同步更新飞书资料索引中的版本基线、固定链接、支持矩阵和实现映射。

## 组合式模块设计

### 现有模块复用

| 现有模块 | 直接复用的能力 | 飞书只负责 |
| --- | --- | --- |
| `application` | 文本提交、steer、排队和全部平台无关命令 | 解析飞书输入并渲染结构化结果 |
| `conversation-core` | Thread/Turn/Item 状态和 `OutputEvent` | 把事件转换为飞书消息 |
| `approval` | 审批归属、授权语义、超时和跨客户端失效 | 展示交互并返回明确决定 |
| `policy` | `target + actorId` 授权接口和 Actor Registry | 实现飞书账号、用户和会话限制 |
| `session-routing` | Conversation 与 Workspace/Thread 绑定 | 提供规范 Conversation 身份 |
| `storage` | 现有最小绑定恢复 | 不保存飞书消息或事件 |
| `surfaces` | `SurfaceAdapter` 和有界顺序输出队列 | 平台生命周期、输入、输出和 SDK |
| `bootstrap` | 显式工厂、启动回滚、输出路由和配置生命周期 | 创建飞书具体实现 |
| `observability` | 结构化日志和敏感字段脱敏 | 提供受约束的平台错误码 |

### 建议目录

只在对应阶段真正需要时创建文件，不为了目录对称建立空模块：

```text
src/surfaces/feishu/
├── README.md         # 模块职责、文件索引、官方基线和验证入口
├── index.ts          # 飞书模块受控出口
├── adapter.ts        # SurfaceAdapter、输入编排和生命周期
├── client.ts         # 官方 SDK 的窄封装与可测试端口
├── inbox.ts          # 平台本地的有界输入接收和事件去重
├── renderer.ts       # 命令结果、OutputEvent 和用户错误渲染
├── interactions.ts   # InteractionPort、卡片动作和失效
├── outbox.ts         # 飞书发送操作与 ConversationDeliveryQueue
└── media.ts          # 后续阶段的资源下载和上传
```

`src/surfaces/feishu/index.ts` 只导出 Bootstrap 装配所需的类型和工厂，再由
`src/surfaces/index.ts` 受控转出。Bootstrap 不直接导入飞书内部文件。飞书模块不导入 Telegram
实现，也不把 Telegram 格式器改名为通用格式器。

`client.ts` 只隔离 SDK 对象、错误和事件结构，不建立第二套会话客户端。它应向 Adapter 暴露当前
用例需要的窄能力，例如连接、断开、接收规范消息和发送平台消息；不得暴露整个 SDK Client 给
其他一级模块。

### Bootstrap 组合

在 `src/bootstrap/surface-composition.ts` 增加独立的 `createFeishuModule()`，并保持：

```text
createSurfaceModules
├── createTelegramModule
└── createFeishuModule（仅在有效配置明确启用时）
```

飞书工厂负责：

1. 从已经验证的 `GatewayConfig` 读取飞书配置。
2. 只清理当前 `surface + accountId` 下已经撤权 Actor 的绑定。
3. 创建 `FeishuAccessPolicy`。
4. 创建 Adapter，并注入 Application 服务、Actor Registry、Logger 和致命故障回调。
5. 返回现有 `SurfaceRuntimeModule`，封装允许名单热加载和重启通知收件人切换。

不得向 `GatewayApplication` 增加飞书专属字段。飞书未启用时不创建 Adapter，已有飞书绑定保留，
但启动恢复订阅时按未运行的 `surface + accountId` 过滤。

## 身份和授权

首版只支持一个企业自建应用账号：

| 项目身份 | 飞书来源 | 规则 |
| --- | --- | --- |
| `surface` | 固定值 | `feishu` |
| `accountId` | App ID | 使用稳定原值，不使用 Bot 显示名称 |
| `conversationId` | `chat_id` | 私聊和群聊均使用飞书规范 Chat ID |
| `actorId` | `sender.open_id` | 首版只接受明确 `open_id`，不在多个 ID 类型间回退 |
| `ConversationTarget` | 上述三项 | `feishu + appId + chatId` |

如果事件缺少 `chat_id`、`open_id` 或账号归属，必须拒绝，不使用 `user_id`、`union_id` 或显示名称
隐式回退。未来确需兼容其他身份类型时，应先明确稳定规范和迁移影响。

私聊输入需要 Actor 在 `allowed_open_ids` 中。群聊阶段还必须同时满足：

- Actor 已授权；
- 群 `chat_id` 位于明确允许名单；
- 默认只有明确 `@Bot` 的消息进入业务路径。

Bot 被加入群聊不代表群内用户自动授权。群聊中的 `conversationId` 是群 `chat_id`，
`actorId` 仍是操作用户的 `open_id`。

飞书长连接采用集群投递且不广播，因此首版同一个 `appId` 只允许一个活动的 Gateway 长连接
消费者。Setup、Doctor 和真实测试不得在生产 Gateway 运行时为同一应用静默建立第二条消费者
连接。

## 输入路径

飞书长连接处理有平台响应时限，不能在 SDK 回调内等待 Codex Turn。第一阶段在飞书模块内部建立
有界输入接收器，不立即增加通用一级模块或修改 `SurfaceAdapter`：

1. 校验事件类型、App 账号、消息 ID、Chat ID、Chat 类型和 Actor ID。
2. 过滤 Bot 自己的消息、非用户消息、重复事件和超时旧事件。
3. 构造 `ConversationTarget` 与 `SurfaceAccessContext`。
4. 调用 `FeishuAccessPolicy.isAllowed()`。
5. 输入队列有容量时接收任务，并在平台时限内结束 SDK 回调。
6. 队列消费者记录已授权 Actor，再调用 Application。

队列必须有容量上限、明确所有者、取消路径和关闭等待上限。队列满时不得无限增长或静默启动
Codex 写请求；阶段 0 必须确认 SDK 对失败返回和平台重投的精确语义，再决定返回可重试失败还是
发送受约束的忙碌提示。

去重首版只使用飞书模块内的有界 TTL 缓存，键使用平台稳定事件 ID 或消息 ID。不得把原始事件写入
SQLite。若真实测试证明 Gateway 重启后重复投递会造成重复 Turn，必须暂停上线并单独评审最小
幂等状态；不能通过盲目推进游标、复制消息正文或假定创建请求可安全重试解决。

普通文本调用 `ConversationService.submit()`；平台无关命令调用
`ConversationCommandService.execute()`。飞书帮助、`/whoami`、平台配对和交互取消保留在飞书
边界。未知命令不能绕过授权变成普通 Codex 输入。

## 输出路径

Core 输出仍由 `SurfaceManager` 按 `feishu + appId` 路由。飞书 Adapter 的
`output.handle()` 只能同步入队，平台网络调用进入现有 `ConversationDeliveryQueue`：

- 同一飞书 Chat 串行，不同 Chat 可以并行。
- 关键性统一使用 `isCriticalOutputEvent()`，不复制关键事件清单。
- 非关键中间进度可以合并；最终回复、错误、Item 完成和 Turn 完成不得静默丢弃。
- 发送调用设置超时，只对平台明确允许的幂等或只读失败有限重试。
- 关闭时拒绝新输出，取消连接并等待同一个有限关闭任务。

第一阶段只使用纯文本呈现，但必须覆盖 `isCriticalOutputEvent()` 判定的所有关键输出和明确的
结构化用户错误。尚未设计专用布局的关键事件使用受约束的纯文本回退，不能静默丢弃；非关键
中间事件可以按现有队列规则合并或丢弃。不得直接复用 Telegram HTML、Rich Messages、折叠预览
或按钮布局。飞书富文本、卡片和流式更新在后续阶段根据真实限制独立设计。

配置生命周期通知沿用 `SurfaceConfigurationChange`。只有已经建立安全收件人映射的 Actor 才能
收到通知；不得把 App Secret、允许名单、原始配置或其他 Surface 的私有变更发送到飞书。

## 审批与交互

第一阶段必须提供真实的失败关闭 `InteractionPort`：

- 审批返回拒绝；
- 用户输入返回空答案；
- MCP elicitation 返回取消；
- `resolved()` 和 `cancelAll()` 不得留下悬挂请求。

第一阶段不使用“回复同意”“回复 1”等宽松文本解析模拟审批。

卡片审批作为独立阶段实施。开始前必须用锁定 SDK 和测试应用确认卡片动作使用的订阅方式。若需要
公网 HTTPS 回调，必须先单独评审监听地址、TLS、反向代理、验签、加密、服务模板和攻击面，不能
让 Gateway 临时监听无认证公网端口。

卡片交互实现后仍须满足：

- 回调值包含不可预测、一次性且有过期时间的交互令牌；
- 令牌绑定 `surface + accountId + conversationId + actorId + requestId`；
- 保留请求提供的 Thread、Turn 和 Item 归属，不补造标识；
- 只显示请求明确提供的批准选项；
- 命令和网络规则原样返回，不合并、不推导、不扩大；
- `resolved(requestId)` 立即使已由 CLI 或其他客户端处理的卡片失效；
- 未知、重复、过期或 Actor 不匹配的卡片动作默认拒绝或取消。

## 配置、Setup 与 Doctor

飞书配置必须进入唯一 `config.toml` 和共享严格 Schema。建议首版结构：

```toml
[feishu]
enabled = true
app_id = "cli_xxx"
app_secret = "..."
allowed_open_ids = ["ou_xxx"]
allowed_chat_ids = []
require_mention = true
```

这是计划中的目标结构，不是当前已支持配置。实施时需逐项完成：

1. `runtime/gateway-config.mjs` 的严格结构、默认值和未知键拒绝。
2. `src/config/index.ts` 的运行时映射和语义校验。
3. `config-change.ts` 的飞书 Surface scope 变更码。
4. `reload-classifier.ts` 的热加载、Gateway 重启分类。
5. `config.example.toml`、README、Setup、Doctor 和测试同步。

建议分类：

| 变更 | 行为 |
| --- | --- |
| `allowed_open_ids`、`allowed_chat_ids`、`require_mention` | 原子热加载 |
| `app_id`、`app_secret` | Gateway 重启 |
| `enabled` | Gateway 重启并创建或停止 Surface |
| Workspace | 沿用现有全局热加载 |
| `[network]` | 沿用现有分类，不增加飞书私有代理 |

App Secret 只保存在权限受限的统一 TOML 中。SDK 换取的短期 Token 只保存在进程内存；日志、
错误、Doctor 和平台通知只能显示“已配置”或受约束状态，不能显示原值。

统一设置入口仍是 `codexc setup → 通讯渠道 → 飞书`。允许新增
`scripts/feishu-setup.mjs`，但它只能作为设置菜单的组合模块。Setup 至少需要：

1. 说明如何创建企业自建应用、启用 Bot、授予最小权限、订阅消息事件并发布应用。
2. 读取 App ID 和 App Secret，并在写入前验证凭据和 Bot 身份。
3. 引导获取可信 `open_id`。阶段 0 应验证锁定 SDK 的 `registerApp()` 是否能以最小权限安全返回
   扫码用户身份；如果仍需临时接收事件，必须避免与运行中的同一应用长连接争抢事件。
4. 明确展示准备写入的非敏感配置，成功后原子更新 TOML。
5. 不自动扩大允许用户或群聊范围。

Doctor 只读检查配置、凭据状态、SDK 握手所需网络、应用发布和必要权限，不修改配置，不输出
Secret、Access Token、完整 SDK 响应或原始事件。

## 生命周期、重连和故障

- `start()` 只有在 SDK 完成真实握手且输入消费者就绪后才成功。
- 部分启动失败必须关闭输入任务、SDK Client 和输出队列。
- SDK 自动重连仍需由 Adapter 观察；重连耗尽或认证失败调用飞书账号对应的 `onFatal`。
- 认证失败、权限不足和配置错误不可无限重试。
- 429、网络超时和 5xx 只进行有限退避；平台响应正文不进入日志。
- `stop()` 必须幂等，取消长连接和输入消费者，并有限等待在途发送。
- Gateway 停止或飞书失败不得终止共享 Codex App Server。
- 单个飞书 Chat 的失败不得阻塞其他 Conversation 或 App Server Reader。

受约束的错误分类至少区分认证、权限、限流、发送超时、连接中断、格式拒绝和未知内部错误。
外部用户只看到项目明确标记的结构化错误。

## 分阶段实施

### 阶段 0：SDK 合同实验

范围：

- [x] 选择并锁定官方 Node SDK `1.71.1`。
- [x] 封装 `WSClient` 的真实就绪、启动超时、重连、停止和脱敏错误语义。
- [x] 把 `im.message.receive_v1` 裁剪为不泄漏 SDK 类型的稳定平台事件。
- [x] 为上述生命周期建立不访问飞书网络的离线合同测试。
- 用最小隔离脚本验证握手、消息事件、取消、重连、代理和卡片动作。
- 比较手动应用配置与锁定版本 `registerApp()` 的权限、身份和安全边界。
- 记录应用权限、事件订阅、SDK 版本及真实限制。

该实验不得进入生产启动路径，不修改 Core、Storage 或公开命令。

完成标准：

- 能明确选择低层 SDK 接口；
- 能证明私聊文本事件字段和停止行为；
- 卡片动作的连接方式有直接证据；
- 新增依赖方案已获确认。

### 阶段 1：单账号私聊文本

范围：

- 可选飞书配置与严格校验；
- [x] `FeishuAccessPolicy`；
- 单账号 Adapter；
- [x] 窄 SDK Client 和平台本地输入队列；
- [x] 私聊/文本/账号筛选、同步有界入队、去重、旧事件和过载处理；
- 已授权私聊文本提交；
- 失败关闭 InteractionPort；
- [x] 所有关键 `OutputEvent` 的纯文本回退与上游错误详情隐藏；
- [x] 精确账号路由和按 Chat 隔离的有界 Outbox；
- 结构化用户错误；
- Bootstrap 显式组合、Setup 基础流程和 Doctor 检查。

明确不做群聊、媒体、流式卡片和可批准交互。

完成标准：

- Telegram 未配置行为和现有共享 App Server 行为不变；
- 飞书未启用时不创建连接；
- 已授权用户可完成一个私聊 Turn；
- 未授权、重复、畸形和过载输入不会启动 Turn；
- Gateway 重启后 Thread 绑定能按现有 StateStore 恢复。

### 阶段 2：命令与群聊

范围：

- 渲染全部当前 `ConversationCommandResult`；
- `/whoami`、帮助和交互取消；
- 群 Chat 允许名单、Actor 联合授权和 `@Bot` 要求；
- 状态、计划、Diff、Goal、用量和配置生命周期通知。

完成标准：

- 平台模块不重新实现 Thread、Fast、Goal 或用量查询；
- 群聊中未授权 Actor、未允许群和未提及 Bot 均不进入 Application；
- Telegram 与飞书对同一 Thread 的状态仍以 App Server 为准。

### 阶段 3：卡片审批

范围：

- 经验证的卡片动作接收方式；
- 一次性 Interaction Token；
- 命令、文件、临时权限、用户输入和 MCP elicitation；
- 跨客户端解决、超时和卡片失效更新。

完成标准：

- Approval 现有语义和协议映射不变；
- 一次批准不会升级；
- 所有高权限失败路径默认拒绝或取消；
- 若需要公网回调，相关部署和安全评审已单独完成。

### 阶段 4：媒体和飞书体验

范围按真实需要逐项选择：

- PNG/JPEG 输入和资源大小限制；
- 文件下载及临时文件清理；
- 飞书富文本、长回复和消息更新；
- 经测量后采用的流式卡片；
- 平台特有引用和提醒行为。

不得因为官方 SDK 提供更多能力就自动加入 Drive、通讯录、日历或文档写入。

## 测试与验证

新增行为优先进入最接近边界的测试文件，必要时增加明确命名的飞书测试：

- 配置：缺少字段、未知键、Secret 脱敏和重载分类。
- Policy：Surface、App ID、Actor、私聊和群聊联合授权。
- 输入：规范文本、Bot 自消息、重复、旧事件、未授权和队列过载。
- 输出：账号路由、Conversation 顺序、平台超时、限流和关键事件保护。
- 生命周期：真实握手替身、部分启动回滚、重连耗尽、并发停止和在途等待。
- 审批：失败关闭、令牌不可预测、Actor 绑定、过期、重复、跨客户端解决和原值决定。
- Setup/Doctor：凭据验证、运行中连接冲突、原子写入和敏感信息清洗。
- 模块边界：SDK 类型不离开 `surfaces/feishu`，Bootstrap 只经 `surfaces/index.ts` 使用具体实现。

常规提交门禁仍是：

```bash
npm run docs:check
npm run check
npm run lint
npm test
npm run test:coverage
npm run test:package
npm run verify:commit
```

协议、Transport 和 Codex App Server 行为没有变化时，不因新增飞书强制扩展 Codex 真实合同测试。
飞书真实冒烟需要操作者明确提供测试应用和测试 Conversation，并单独触发；CI 和普通提交门禁
不得向真实飞书用户发送消息。

真实冒烟至少验证：

1. WebSocket 握手与断线恢复。
2. 已授权私聊事件只产生一个 Turn。
3. 输出发送到精确 `appId + chatId`。
4. 未授权用户和重复事件不产生 Turn。
5. 停止 Gateway 不终止共享 App Server。
6. 卡片阶段验证审批超时和其他客户端解决后的失效。

## 回滚

- 阶段 0 实验可直接删除，不进入正式运行入口。
- 阶段 1 起每个阶段保持独立提交，可使用正常 Git revert 回退。
- 配置块是可选且显式启用；回退前先将 `feishu.enabled` 设为 `false` 或移除未发布配置。
- 第一阶段不改变 SQLite Schema，因此不需要数据迁移。
- 回滚飞书代码不得删除其他 Surface 的绑定或终止共享 App Server。

## 开放问题和实施停止条件

以下问题必须在对应阶段开始前解决，不能凭推测实现：

1. 锁定 SDK 版本中卡片动作能否通过 WebSocket 接收，还是必须配置 HTTPS 回调。
2. 官方事件回调失败时触发重投的精确响应语义，以及输入队列满时应如何返回。
3. SDK HTTP 层如何使用当前 `[network]` 代理，并保持 macOS/Linux 一致。
4. Setup 如何在不与运行中 Gateway 争抢同一应用事件的情况下发现 `open_id`。
5. 长连接重启后重复消息是否需要超出内存 TTL 的最小幂等状态。
6. 飞书应用需要的最小权限集合；阶段 1 不接受为后续媒体或 Drive 预授予宽泛权限。

出现以下任一情况时停止当前阶段并单独评审：

- 需要修改 Codex App Server 协议或 Core 才能适配飞书；
- 需要新增全局 Surface 基类、插件注册中心或独立服务；
- 需要改变 SQLite Schema 或持久化消息/事件原文；
- 需要开放未经验证的公网监听；
- 官方 SDK 高层策略无法关闭并与现有 Policy、队列或审批产生双重事实来源；
- 真实事件字段、权限或回调行为与本计划假设不一致。

## 计划完成判定

本文规划完成不等于飞书接入完成。实际飞书 Surface 只有同时满足以下条件才可标记完成：

- 各阶段范围和非目标得到遵守；
- 飞书 SDK 类型只留在平台目录；
- Application/Core/Approval/Session Routing 未复制平台逻辑；
- 配置、Setup、Doctor、README、模块索引和测试同步；
- 授权、重复事件、过载、重连、审批和敏感信息失败路径有测试；
- 文档检查、类型检查、Lint、全量测试、构建、打包和提交门禁通过；
- 操作者明确触发的真实飞书冒烟通过；
- Telegram、原生 CLI 和共享 App Server 行为没有回归。
