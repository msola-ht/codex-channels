# 飞书 Surface 接入计划

## 状态与目标

本文记录飞书通讯渠道的分阶段实施状态。阶段 1 私聊文本路径已可通过 Setup 或手工配置启用，但
后续能力仍须分别完成离线实现和真实验收后才能公开支持。实施必须继续遵守
[`通讯渠道 Surface 接入指南`](surface-integration-guide.md)；如果本文与通用指南冲突，以通用
架构和安全边界为准，并先单独评审需要调整的公开合同。

当前进度（2026-07-25）：已锁定官方 Node SDK `1.71.1`，并完成 Phase 0 的长连接生命周期窄封装、
消息事件稳定字段裁剪和离线合同测试；阶段 1 已完成平台本地私聊文本 Inbox、访问策略和
Application 输入 Adapter、安全错误、`OutputEvent` 纯文本渲染、有界 Outbox 及官方 SDK
文本发送窄适配、单账号 `SurfaceAdapter` 生命周期组合、严格 TOML/运行配置与变更分类，以及
Bootstrap 显式注册、允许名单热加载、安全配置通知收件人组合、手动/扫码 Setup 和只读
Doctor 凭据/Bot 身份探测。2026-07-25 已由操作者使用测试应用完成扫码配置、Doctor 探测、
生产 Gateway 长连接就绪，以及一次已授权私聊文本 Turn 和精确 Chat 文本回复。阶段 2 的私聊
命令预备切片已接入全部平台无关命令及 `/start`、`/help`、`/whoami`、
`/cancel`，但阶段 1 尚未整体关闭，因此尚未进入阶段 2 验收，也不得继续群聊切片。断线恢复、
代理真实验收和未授权/重复真实事件仍待完成。

2026-07-26 操作者在 Gateway 重启后完成飞书私聊命令试用，确认当时回复均为纯文本。随后按独立
切片实现最终回复和命令结果的 `post + md` 富文本；错误、过载和操作性提示继续使用纯文本，
同日已在 Gateway 重启后通过真实飞书验证状态命令与普通 Turn 的短回复，标题、列表、加粗、
行内代码和链接均正确显示。群聊需求已记录为阶段 2 后续项且当前开发批次明确暂停；审批卡片、
一次性令牌、精确 Actor/Chat/消息/请求绑定、原值决定和失效更新已完成离线实现，待重新扫码后
验证真实动作投递。随后操作者已通过真实命令审批卡片完成一次批准，当前 Gateway 收到
`card.action.trigger` 后任务继续完成；私聊 PNG/JPEG 图片输入也已通过真实消息验收。长回复
在飞书客户端折叠显示且消息顺序正确；一般文件仍未实现。Gateway 重启后的 OAuth Token 与
Thread 绑定恢复也已通过验收。

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
| `storage` | 现有最小绑定恢复 | 不保存飞书消息、事件或用户 OAuth Token |
| `surfaces` | `SurfaceAdapter` 和有界顺序输出队列 | 平台生命周期、输入、输出、SDK 与平台凭据后端 |
| `bootstrap` | 显式工厂、启动回滚、输出路由和配置生命周期 | 创建飞书具体实现 |
| `observability` | 结构化日志和敏感字段脱敏 | 提供受约束的平台错误码 |

### 建议目录

只在对应阶段真正需要时创建文件，不为了目录对称建立空模块：

```text
src/surfaces/feishu/
├── README.md         # 模块职责、文件索引、官方基线和验证入口
├── index.ts          # 飞书模块受控出口
├── adapter.ts        # Application 输入编排和安全错误
├── surface.ts        # SurfaceAdapter 与平台生命周期
├── client.ts         # 官方 SDK 的窄封装与可测试端口
├── card-action.ts    # 卡片动作严格裁剪与稳定字段
├── message-content.ts # 飞书消息内容编码与平台专属标签中和
├── inbox.ts          # 平台本地的有界输入接收和事件去重
├── renderer.ts       # 命令结果、OutputEvent 和用户错误渲染
├── interactions.ts   # InteractionPort、卡片动作和失效
├── permissions.ts    # 平台权限与运行观测
├── oauth-device-flow.ts # 用户 Scope、Device Flow 和身份查询
├── oauth-card.ts     # 飞书内授权与结果卡片
├── oauth-token-store.ts # macOS Keychain / Linux 加密凭据
├── oauth.ts          # Actor 级授权生命周期
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

第一阶段建立的纯文本路径必须覆盖 `isCriticalOutputEvent()` 判定的所有关键输出和明确的
结构化用户错误。当前最终回复与命令结果使用飞书 `post + md`，尚未设计专用布局的关键事件、
错误和操作性提示继续使用受约束的纯文本，不能静默丢弃；非关键
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
```

这是阶段 1 私聊的当前严格结构；群 Chat 允许名单和 `@Bot` 要求属于阶段 2，不提前进入 Schema。
当前配置、Setup 与 Bootstrap 已形成显式启用路径。实施状态：

1. [x] `runtime/gateway-config.mjs` 的严格结构和未知键拒绝。
2. [x] `src/config/index.ts` 的运行时映射和语义校验。
3. [x] `config-change.ts` 的飞书 Surface scope 变更码。
4. [x] `reload-classifier.ts` 的热加载、Gateway 重启分类。
5. [x] `config.example.toml`、README 和启用路径测试同步。
6. [x] 手动/扫码 Setup 与只读 Doctor 凭据/Bot 身份探测。

建议分类：

| 变更 | 行为 |
| --- | --- |
| `allowed_open_ids` | 原子热加载 |
| `app_id`、`app_secret` | Gateway 重启 |
| `enabled` | Gateway 重启并创建或停止 Surface |
| Workspace | 沿用现有全局热加载 |
| `[network]` | 沿用现有分类，不增加飞书私有代理 |

App Secret 只保存在权限受限的统一 TOML 中。SDK 换取的短期 Token 只保存在进程内存；日志、
错误、Doctor 和平台通知只能显示“已配置”或受约束状态，不能显示原值。

统一设置入口仍是 `codexc setup → 通讯渠道 → 飞书`。允许新增
`scripts/feishu-setup.mjs`，但它只能作为设置菜单的组合模块。Setup 至少需要：

1. 说明如何创建企业自建应用、启用 Bot、授予最小权限、订阅消息事件并发布应用。
2. 提供手动输入 App ID/App Secret 与锁定 SDK Device Authorization 扫码两种方式；扫码时由
   飞书授权页选择新建或已有应用，两种方式都在写入前验证凭据和 Bot 身份。
3. 扫码使用返回的可信 `open_id`，手动方式要求显式输入允许名单；不为身份发现临时启动第二条长连接。
4. 明确展示准备写入的非敏感配置，成功后原子更新 TOML。
5. 不自动扩大允许用户或群聊范围。

Doctor 只读检查配置、允许名单，以及通过有限 HTTP 请求验证应用凭据和 Bot 身份；不修改配置，
不建立第二条消息长连接，也不输出 Secret、Access Token、完整 SDK 响应或原始事件。
`bot/v3/info` 不能证明应用已经发布、长连接可握手或消息权限完整，这些仍由操作者明确触发的
真实冒烟验证。

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
- [x] 使用测试应用验证生产 Gateway 握手、已授权私聊事件和文本回复。
- 继续用最小隔离实验验证取消、断线重连、代理和卡片动作。
- [x] 比较手动应用配置与锁定版本 `registerApp()` 的权限、身份和安全边界，并采用手动输入与
  扫码并列、飞书页选择应用、最小权限和 Bot 身份验证方案。
- 记录应用权限、事件订阅、SDK 版本及真实限制。

该实验不得进入生产启动路径，不修改 Core、Storage 或公开命令。

完成标准：

- 能明确选择低层 SDK 接口；
- 能证明私聊文本事件字段和停止行为；
- 卡片动作的连接方式有直接证据；
- 新增依赖方案已获确认。

### 阶段 1：单账号私聊文本

范围：

- [x] 可选飞书配置与严格校验；
- [x] `FeishuAccessPolicy`；
- [x] Application 输入 Adapter；
- [x] 单账号 SurfaceAdapter 生命周期组合；
- [x] 窄 SDK Client 和平台本地输入队列；
- [x] 私聊/文本/账号筛选、同步有界入队、去重、旧事件和过载处理；
- [x] 已授权私聊文本提交；
- [x] 失败关闭 InteractionPort；
- [x] 所有关键 `OutputEvent` 的纯文本回退与上游错误详情隐藏；
- [x] 精确账号路由和按 Chat 隔离的有界 Outbox；
- [x] `chat_id` 文本发送、有限 HTTP 超时和稳定脱敏错误；
- [x] 结构化用户错误；
- [x] Bootstrap 显式组合；
- [x] Setup 基础流程；
- [x] Doctor 的飞书专属配置与凭据/Bot 身份检查。

明确不做群聊、媒体、流式卡片和可批准交互。

完成标准：

- Telegram 未配置行为和现有共享 App Server 行为不变；
- 飞书未启用时不创建连接；
- 已授权用户可完成一个私聊 Turn；
- 未授权、重复、畸形和过载输入不会启动 Turn；
- Gateway 重启后 Thread 绑定能按现有 StateStore 恢复。

截至 2026-07-26，已授权私聊 Turn、文本回复和 Gateway 重启后的 Thread 绑定恢复已经通过真实
测试；未授权/重复真实事件仍待验收，因此阶段 1 尚未整体关闭。

### 阶段 2 预备实现：命令与群聊

范围：

- [x] 离线渲染全部当前 `ConversationCommandResult`；
- [x] 离线验证 `/whoami`、帮助和失败关闭状态下的交互取消；
- [x] 飞书本地权限中心：运行观测、Gateway 已用能力清单与已有应用配置入口；
- [x] 用户 OAuth Device Flow：精确 Origin 的完整授权 URL、飞书内卡片、Actor 身份匹配、
  分层 Scope 上限、安全持久化、撤销、限时停止和写入错误/取消竞态回滚；
- [x] 飞书 HTTP API、OAuth 与 WebSocket 复用统一 HTTP/HTTPS 代理并遵循 `NO_PROXY`，无效或
  不支持的代理失败关闭；
- [ ] 群 Chat 允许名单、Actor 联合授权和 `@Bot` 要求；
- [x] 离线验证状态、计划、Diff、Goal、用量和配置生命周期通知。

群聊只记录需求，不在当前开发批次实施。开始前仍须先关闭阶段 1，并单独确认群 Chat 配置、
允许名单、Actor 联合授权、Bot 身份和 `@Bot` 触发边界。

私聊命令统一调用 `ConversationCommandService`，未知或畸形斜杠命令失败关闭，不会退回普通
Codex 输入。Outbox 对纯文本按 UTF-8 字节、对富文本按序列化后的 `post` 内容采用项目内部的
20,000 字节单条上限并按逻辑结果顺序分片，每个逻辑结果最多 5 条，超出时明确标记截断；会话
列表最多展示 20 条并规范、截断长预览。消息创建失败不自动切换格式重发，避免重复消息。

当前代码属于可独立审查的预备实现，不代表阶段状态晋级。Gateway 重启绑定恢复已经通过验收；
仍须完成阶段 1 的未授权/重复真实事件和真实应用命令矩阵。群聊的严格配置、身份校验和真实事件
Fixture 继续暂停，当前阶段 2 尚未整体关闭。

`/feishu <status|doctor|authorize|revoke>` 属于平台本地权限中心，不占用 Application 的
`/permissions`。`status` 记录当前进程是否实际收到消息事件或卡片动作；`doctor` 汇总必要能力、
应用配置入口和当前 OAuth 状态，不静默修改权限。`authorize` 使用
`application:application:self_manage` 读取应用已开通的用户 Scope，先检查有效 Token 的 Scope
覆盖，全部覆盖时停止，部分缺失时只把差集列入卡片，再由当前 Actor 通过飞书内 Device Flow
明确授权。完成后必须校验 Token 对应 `open_id`
与发起 Actor 一致。macOS 凭据进入系统 Keychain，Linux 凭据以独立主密钥和 AES-256-GCM 密文
保存在 Gateway 数据目录，不进入配置、StateStore、Application/Core、日志或消息。`revoke`
先取消进行中轮询再删除当前 Actor 本地凭据，Surface 停止取消授权任务并最多等待 5 秒；停止或
存储错误与 Token 写入竞态时尝试恢复原凭据，恢复失败必须脱敏记录。飞书 CLI 尚未实现，Token
自动刷新和真实 API 消费留到具体命令需要时再增加。

完成标准：

- 平台模块不重新实现 Thread、Fast、Goal 或用量查询；
- 群聊中未授权 Actor、未允许群和未提及 Bot 均不进入 Application；
- Telegram 与飞书对同一 Thread 的状态仍以 App Server 为准。

### 阶段 3：卡片审批

范围：

- [x] 锁定 SDK 的 `card.action.trigger` 离线注册、严格字段裁剪和独立分流；
- [x] 扫码 Setup 增量声明 `card.action.trigger` 回调；
- [x] 私聊审批卡片、一次性 Interaction Token、精确 Actor/Chat/消息/请求绑定；
- [x] 命令、文件和临时权限的原值决定映射；
- [x] 跨客户端解决、超时、停止和卡片失效更新的离线测试；
- [x] 测试应用配置回调后的真实命令审批动作投递验证；
- [x] 当前 Gateway 长连接收到 `card.action.trigger` 的接收方式验证；
- [x] 用户输入和 MCP form/URL elicitation 的有界卡片、严格回调映射和离线测试；

完成标准：

- Approval 现有语义和协议映射不变；
- 一次批准不会升级；
- 所有高权限失败路径默认拒绝或取消；
- 若需要公网回调，相关部署和安全评审已单独完成。

用户输入最多渲染三个问题，秘密问题使用密码输入框，固定选项在回调边界按原值校验。MCP form
使用单个有界 JSON 输入，URL 模式只接受 HTTP(S)。两类交互复用审批的一次性令牌、
Actor/Chat/消息绑定、超时、跨客户端失效和卡片更新，不新增持久化；命令审批动作已通过真实
验收，用户输入与 MCP 卡片动作仍属于本阶段未完成验收项。

### 阶段 4：媒体和飞书体验

范围按真实需要逐项选择：

- [x] 私聊 PNG/JPEG 输入、10 MiB 限制、内容签名校验和 Application `localImages` 提交；
- [x] 官方消息资源下载、私有临时文件和过期清理；
- [x] 最终回复和命令结果的 `post + md` 富文本；
- [x] 富文本真实应用短回复显示验收；
- [x] 富文本长回复在客户端折叠显示且消息顺序正确；
- [ ] 消息更新；
- 经测量后采用的流式卡片；
- 平台特有引用和提醒行为。

基础纯文本 UTF-8 有界安全分片已经作为命令传输边界完成。首个体验切片复用同一 Outbox 顺序
边界，并按序列化后的实际 `post` 内容限制富文本分片；没有引入卡片、流式更新或媒体。纯文本
路径继续承载错误和操作性提示，不作为消息创建失败后的自动重试。

第二个体验切片只接受已授权私聊的 `image` 事件。SDK 回调同步裁剪 `image_key` 并进入现有
有界 Inbox；Conversation Worker 使用锁定 SDK 的 `im.v1.messageResource.get` 下载资源，
经 Surface 共用暂存器限制大小、校验 PNG/JPEG 内容签名和管理 24 小时过期清理，再调用现有
Application 图片输入。一般文件、图片说明文字、群聊媒体和下载重试不在本切片范围；真实飞书
私聊 PNG/JPEG 图片消息主路径已经通过验收；大小超限、无效签名等失败路径仍由离线测试覆盖。

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

2026-07-25 已完成第 1 项中的首次握手、第 2 项的已授权私聊主路径和第 3 项的精确 Chat 回复。
断线恢复以及第 4 至第 6 项仍未完成；该记录不包含真实消息、应用标识、Chat ID 或凭据。

## 回滚

- 阶段 0 实验可直接删除，不进入正式运行入口。
- 阶段 1 起每个阶段保持独立提交，可使用正常 Git revert 回退。
- 配置块是可选且显式启用；回退前先将 `feishu.enabled` 设为 `false` 或移除未发布配置。
- 第一阶段不改变 SQLite Schema，因此不需要数据迁移。
- 回滚飞书代码不得删除其他 Surface 的绑定或终止共享 App Server。

## 开放问题和实施停止条件

以下问题必须在对应阶段开始前解决，不能凭推测实现：

1. 已确认当前测试应用的命令审批动作可由 Gateway 长连接接收；后续 SDK 升级时是否仍保持该
   通道，需要按锁定版本重新验证。
2. 官方事件回调失败时触发重投的精确响应语义，以及输入队列满时应如何返回。
3. 当前统一 HTTP/HTTPS 代理在 macOS/Linux 真实网络中的握手、断线和 `NO_PROXY` 行为是否一致；
   仅 SOCKS `ALL_PROXY` 暂不支持。
4. 长连接重启后重复消息是否需要超出内存 TTL 的最小幂等状态。
5. 真实应用是否接受 Setup 当前声明的 `im:message:send_as_bot`、
   `im.message.receive_v1` 和 `card.action.trigger` 最小集合；阶段 1 不接受为后续媒体或
   Drive 预授予宽泛权限。

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
