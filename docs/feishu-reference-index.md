# 飞书官方资料与实现索引

## 用途与状态

本页用于定位飞书开放平台、官方 Node SDK、本地实现和验证入口。它是飞书 Surface 的事实查询
入口，不替代 [`飞书 Surface 接入计划`](feishu-surface-plan.md)；当前支持扫码 Setup 与开发验证
中的阶段 1 私聊文本路径。

截至 2026-07-26，项目已精确锁定 `@larksuiteoapi/node-sdk@1.71.1`，并完成阶段 1 私聊文本
模块、严格配置和 Bootstrap 显式组合。测试应用已完成扫码配置、Doctor 探测、生产 Gateway
首次握手、一次已授权私聊 Turn 和精确 Chat 文本回复；断线恢复、未授权/重复真实事件、代理和
用户输入/MCP 卡片动作真实验收仍未完成。私聊 PNG/JPEG 图片、命令审批动作、Gateway 重启后的
OAuth Token 与 Thread 绑定恢复，以及长回复折叠显示和顺序均已通过真实验收；持续回复在飞书
客户端可见 CardKit 原生流式更新的主路径也已通过真实验收。当前启用路径仍属于开发验证，
不应视为生产就绪。

## 资料优先级

查阅飞书行为时按以下顺序取证：

1. 项目 `package-lock.json` 中实际锁定的 SDK 精确版本。
2. 与该版本对应的官方 npm 包内容、Git Tag 或固定 Commit 源码和测试。
3. 飞书开放平台与该能力直接对应的官方文档。
4. 官方 SDK `main`，只用于发现可能的新能力和版本差异。
5. 本项目的真实测试应用实验、脱敏 Fixture 和自动化测试。

官方资料与锁定 SDK 不一致时，先记录差异并用测试应用验证，不通过反复修改生产路径推断行为。
本项目的支持状态以本页矩阵、实际实现和测试共同为准；官方 SDK 提供某项能力不等于 Gateway
已经支持。

## 版本基线

| 项目 | 当前记录 |
| --- | --- |
| 查阅日期 | 2026-07-26 |
| npm 包 | `@larksuiteoapi/node-sdk` |
| npm 当日采用正式版 | `1.71.1` |
| 项目锁定版本 | `1.71.1` |
| 固定官方源码 | [`8b3e0df`](https://github.com/larksuite/node-sdk/tree/8b3e0df3af9401c263dc96026e1c7f17460a21cc) |
| 项目依赖状态 | 已安装并由 `package-lock.json` 精确锁定 |
| 目标应用类型 | 飞书企业自建应用 |
| 首版目标传输 | WebSocket 长连接 |
| 首版目标范围 | 单 Bot 账号、授权私聊文本 |
| Lark 海外版 | 不在首版范围 |

依赖升级时不得只修改版本数字；还要复核下方资料、已知约束、支持矩阵、实现映射和验证结果。

## 官方资料

| 查询目标 | 官方资料 | 当前用途 |
| --- | --- | --- |
| SDK 包与版本 | [npm 包版本](https://www.npmjs.com/package/@larksuiteoapi/node-sdk?activeTab=versions) | 发现正式版本，不作为锁定证据 |
| SDK 源码 | [固定 `1.71.1` 提交](https://github.com/larksuite/node-sdk/tree/8b3e0df3af9401c263dc96026e1c7f17460a21cc) | 当前实现和测试的源码基线 |
| Client、事件和长连接示例 | [固定版本中文说明](https://github.com/larksuite/node-sdk/blob/8b3e0df3af9401c263dc96026e1c7f17460a21cc/README.zh.md) | 核对 `Client`、`WSClient`、`EventDispatcher` 和 `registerApp()` |
| 官方 OpenClaw 飞书插件 | [固定提交 `dde0be3`](https://github.com/larksuite/openclaw-lark/tree/dde0be3680d6fd5443cab426c8f4b3216266346a) | 参考手动凭据输入、保留已有配置、Bot 身份探测和允许名单交互；不引入其 OpenClaw 运行时或宽权限工具 |
| OpenClaw 应用权限查询 | [`app-scope-checker.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/core/app-scope-checker.ts) | 区分应用 Scope 与用户 OAuth，并确认完整远端 Scope 查询需要额外自管理权限 |
| OpenClaw 私聊增量授权 | [`auto-auth.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/tools/auto-auth.ts) | 区分应用 Scope 引导卡与用户 OAuth Device Flow，不复制其 OpenClaw 工具运行时 |
| OpenClaw Device Flow | [`device-flow.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/core/device-flow.ts)、[`oauth.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/tools/oauth.ts) | 核对现有 Token 与 Scope 覆盖检测、缺失 Scope 增量授权、飞书端点、`offline_access`、有限轮询、账号校验、取消和卡片结果更新 |
| OpenClaw OAuth 卡片 | [`oauth-cards.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/tools/oauth-cards.ts) | 核对 Device Flow 地址通过飞书 AppLink 在客户端侧边栏打开，不把外部 URL 直接作为普通文本 |
| OpenClaw Token Store | [`token-store.ts`](https://github.com/larksuite/openclaw-lark/blob/dde0be3680d6fd5443cab426c8f4b3216266346a/src/core/token-store.ts) | 参考 macOS Keychain 和 Linux AES-256-GCM 分离后端；项目使用自己的 Gateway 数据目录和严格载荷验证 |
| WebSocket 生命周期 | [固定版本 `ws-client`](https://github.com/larksuite/node-sdk/tree/8b3e0df3af9401c263dc96026e1c7f17460a21cc/ws-client) | 核对 `onReady`、错误、重连、关闭和状态语义 |
| 高层 Channel | [固定版本 Channel 说明](https://github.com/larksuite/node-sdk/blob/8b3e0df3af9401c263dc96026e1c7f17460a21cc/docs/channel.zh.md) | 识别其策略、去重、串行、重试、媒体和卡片职责 |
| SDK 原生流式实现 | [`card-stream.ts`](https://github.com/larksuite/node-sdk/blob/8b3e0df3af9401c263dc96026e1c7f17460a21cc/channel/outbound/streaming/card-stream.ts)、[`markdown-stream.ts`](https://github.com/larksuite/node-sdk/blob/8b3e0df3af9401c263dc96026e1c7f17460a21cc/channel/outbound/streaming/markdown-stream.ts) | 核对 CardKit 2.0 实体创建、消息引用、元素增量、递增序列、UUID、结束设置和滚动语义；项目只复用低层协议，不采用整套 Channel |
| 消息事件字段格式 | [官方 CLI 固定事件 Schema 指南](https://github.com/larksuite/cli/blob/a7865cd0a7416655535517a2a630848fde318761/skills/lark-event/SKILL.md) | 核对 `create_time` 为毫秒时间戳字符串 |
| 长连接规则 | [使用长连接接收事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode) | 处理时限、集群投递和订阅类型 |
| 文本消息发送 | [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create) | 核对 `chat_id` 接收目标、文本消息体和机器人可用性 |
| 更新消息卡片 | [更新应用发送的消息卡片](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch) | 核对应用发送的交互卡片原地更新、14 天窗口、单消息 5 QPS 和请求大小限制 |
| 卡片更新错误 | [错误码 230001：消息不是卡片](https://open.feishu.cn/document/faq/trouble-shooting/how-to-resolve-error-230001?lang=zh-CN) | 明确 `im.v1.message.patch` 只更新卡片；普通文本或富文本必须使用对应的编辑消息能力 |
| 消息资源下载 | [获取消息中的资源文件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get) | 核对用户消息资源使用 `message_id + file_key + type` 下载、机器人与消息同会话及 100 MiB 平台上限 |
| 消息常见问题 | [消息常见问题](https://open.feishu.cn/document/server-docs/im-v1/faq) | 核对用户发送资源可由同会话机器人下载；项目另收紧为 PNG/JPEG 与 10 MiB |
| 机器人自定义菜单事件 | [机器人自定义菜单](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v6/bot/events/menu) | 核对 `application.bot.menu_v6` 只提供操作者与事件 Key、不提供 Chat ID；项目只路由唯一已授权私聊 |
| 更新应用能力配置 | [应用能力 v7](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v7/application-v7/application-ability/patch) | 核对 `application:application:patch`、机器人菜单启用、事件类型 `menu_content_type = 2` 和菜单展示策略 |
| 更新应用开发配置 | [应用配置 v7](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v7/application-v7/application-config/patch) | 核对 WebSocket 订阅类型及事件、回调的增量添加字段 |
| 提交发布自建应用 | [应用发布 v7](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v7/application-v7/application-publish/create) | 核对应用管理权限、发布理由/变更说明、版本响应及审核边界 |
| 事件接收安全 | [接收事件](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case) | Webhook 阶段的验签和加密入口 |
| 消息卡片 | [消息卡片介绍](https://open.feishu.cn/document/ukTMukTMukTM/uczM3QjL3MzN04yNzcDN) | 后续卡片呈现和交互边界 |
| 创建卡片实体 | [新建卡片实体](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/create) | 核对 CardKit 2.0 流式卡片实体和 `cardkit:card:write` 应用权限 |
| 流式更新文本 | [流式更新文本](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card-element/content) | 核对 `card_id + element_id`、递增 `sequence`、请求 UUID 与元素内容更新 |
| 结束流式卡片 | [更新卡片配置](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/cardkit-v1/card/settings) | 核对关闭 `streaming_mode`、摘要、序列和 UUID |
| 卡片输入框与表单 | [输入框组件](https://open.feishu.cn/document/feishu-cards/card-components/interactive-components/input) | 核对 JSON 1.0 `form` 容器、`form_submit`、`action.form_value`、1,000 字符上限和密码输入 |
| 开放平台总入口 | [飞书开放平台](https://open.feishu.cn/) | 定位事件、API、权限和应用发布文档 |

开放平台页面是动态资料。阶段 0 应把实际采用的消息事件、发送 API、权限点、卡片动作和应用发布
页面补成精确链接，并记录查阅日期；不能只保留开放平台首页或搜索结果。

## 已知约束与待验证差异

### 长连接

官方长连接资料当前说明：

- 事件处理需要在 3 秒内完成，否则可能超时重推。
- 同一应用的多个客户端按集群模式接收，只有随机一个客户端得到事件，不支持广播。
- 长连接支持事件订阅，不支持回调订阅。

因此第一版同一个 `appId` 只允许一个活动的 Gateway 长连接消费者。SDK 回调只能完成校验、授权
和有界入队，不能等待 Codex Turn。Setup、Doctor 或测试脚本不得在生产 Gateway 运行时为同一
应用静默启动第二个消费者。

### 卡片动作

当前 SDK `main` 的 Channel 文档提供 `cardAction`，而长连接资料仍说明不支持回调订阅。两者不能
直接合并成“卡片审批可通过 WebSocket”这一结论。阶段 0 必须在准备锁定的正式 SDK 版本和测试
应用中验证：

1. `card.action.trigger` 实际使用长连接还是 HTTPS 回调。
2. 多客户端和重连时的投递语义。
3. 回调响应时限、重试和卡片更新方式。
4. SDK 是否隐藏启动的 HTTP Listener 或其他运行时组件。

验证完成前，项目可以在开发路径中实现卡片、内存待处理状态和严格决定映射，但不能宣称公开
支持。未收到经校验的动作时必须超时拒绝；真实投递验证若证明长连接不可用，则不得用不受约束的
公网回调临时绕过，而应先补充独立部署与安全方案。

### 高层 Channel

官方 Channel 同时管理平台策略、消息归一化、去重、旧事件过滤、同会话串行、发送回退、重试、
流式卡片和媒体。项目已经由 Policy、Application、Conversation Core、Approval 和
`ConversationDeliveryQueue` 管理这些语义，因此当前计划默认采用低层 `Client + WSClient +
EventDispatcher`。

原生流式也只从锁定 SDK 的 Channel 提取 CardKit 调用顺序和平台约束；流式状态仍由
`FeishuOutbox` 在内存中维护，并进入项目既有 Chat 队列。不得调用 `createLarkChannel()` 再建立
第二套去重、串行、重试、发送回退、媒体或生命周期。

阶段 0 可以比较 Channel，但只有能够关闭重复职责、不会形成第二事实来源且明显减少平台胶水时，
才可重新提议采用；不能为了使用便利绕过项目授权、关键事件保护或队列边界。

### 文本发送

锁定 SDK 的 `im.v1.message.create` 接口支持 `chat_id` 接收目标、文本消息和可选 `uuid`。当前
官方资料没有明确 `uuid` 的幂等窗口、冲突结果和哪些网络或平台错误允许安全重试，因此首版只
设置有限 HTTP 超时，不自动重试消息创建。响应缺少 `message_id` 时失败关闭；SDK 错误正文不进入
平台消息或日志。

### 身份与 Setup

当前 SDK `main` 的 Channel 会在缺少 `open_id` 时向 `user_id` 或 `union_id` 回退；本项目首版不
采用该回退，只接受明确的 `sender.open_id`。

锁定 SDK `1.71.1` 的 `registerApp()` 已确认返回应用凭据和可选的扫码用户 `open_id`，并支持
`addons.preset = false` 的最小机器人基座。Setup 提供手动输入和扫码授权两种方式；扫码时不传
`createOnly` 或 `appId`，由飞书授权页让用户选择新建或已有企业自建应用，只增量声明
`application:application:self_manage`、`application:application:patch`、
`im:message:send_as_bot`、`cardkit:card:write`、`im.message.receive_v1` 和
`application.bot.menu_v6`，卡片阶段另声明 `card.action.trigger` 回调。注册完成后使用
`/open-apis/bot/v3/info` 验证凭据和 Bot 身份，不启动
第二条消息长连接。`addons` 不能直接创建机器人菜单或设置订阅方式；运行中的 Gateway 通过
`/feishu doctor` 一次性确认卡片调用 v7 应用能力、开发配置和发布 API 增量完成。已有未完成
版本时失败关闭，企业审核不能由 Gateway 绕过。

## 项目支持矩阵

| 能力 | 官方入口 | 项目状态 | 实施阶段 |
| --- | --- | --- | --- |
| Node SDK | npm 包、固定官方源码 | 已精确锁定 `1.71.1` | 阶段 0 |
| WebSocket 握手和重连 | `WSClient` | 生命周期封装、统一 HTTP/HTTPS 代理注入、离线合同和真实首次握手已完成；真实断线恢复与代理待验证 | 阶段 0 |
| 消息事件字段裁剪 | `im.message.receive_v1` | 稳定字段映射、畸形输入失败关闭和一条真实私聊文本事件已验证 | 阶段 0 |
| 私聊文本事件 | `im.message.receive_v1` | 平台本地筛选、有界入队、Access Policy、Application 提交、安全错误和生命周期组合已完成；真实已授权主路径已通过，未授权/重复真实事件待验证 | 阶段 1 |
| 文本与富文本发送 | `client.im.v1.message.create` | `chat_id` 的 `text` 与 `post + md` Payload、平台原生提及标签中和、有限 HTTP 超时和脱敏错误已完成；富文本短回复及长回复客户端折叠显示和顺序已通过真实验收 | 阶段 1 / 阶段 4 切片 |
| 原生流式回复 | `cardkit.v1.card.create`、`cardElement.content`、`card.settings` | 已完成 300 ms 增量合并、同 Chat 顺序、递增序列与 UUID、短回复富文本保留、5,000 字符单卡、卡片与回退合计 5 条预算、代码围栏衔接、明确截断、Turn/关闭收尾、失败卡片尽力结束及创建/更新失败回退的离线验证；持续回复的真实可见流式主路径已通过，真实限流、失败回退和超长内容滚动待验收 | 阶段 4 切片 |
| Thread 状态消息更新 | `client.im.v1.message.create/patch` | 同一 Thread 的 `active → idle` 轻量交互卡片创建、重复抑制、同 Chat 顺序更新、失败绑定清理和有限关闭已离线验证；蓝色运行中原地更新为绿色空闲的真实主路径已通过，不更新模型正文且不自动重试 | 阶段 4 切片 |
| 输出渲染 | `OutputEvent`、`turn.completed` | 最终回复和启动通知使用富文本；其他关键事件、安全错误和操作性提示使用纯文本；每轮上下文状态、安全启动收件人、有界 Outbox 和 Surface 生命周期已离线验证，启动与每轮状态待真实验收 | 阶段 1 / 阶段 4 切片 |
| 事件去重与旧事件过滤 | 平台事件 ID、毫秒时间戳 | 已实现飞书模块内有界内存状态；真实重投待验证 | 阶段 1 |
| 严格配置与重载分类 | 统一 `config.toml` | 私聊字段、失败关闭校验、变更码、公开示例和 Bootstrap 显式组合已完成 | 阶段 1 |
| 私聊命令 | `ConversationCommandService`、私聊文本事件、`application.bot.menu_v6` | 全部平台无关命令结果、帮助、身份、取消、`status/doctor/authorize/revoke` 权限中心、未知命令失败关闭、会话列表收敛和有界安全分片已完成离线验证；`/start`、`/help` 与机器人菜单复用六项只读命令中心，菜单只路由唯一授权私聊且令牌/事件去重有界；状态命令富文本真实显示已通过，命令中心和完整命令矩阵仍待验收 | 阶段 2 预备实现 |
| 用户 OAuth | OAuth Device Flow、应用用户 Scope、飞书 AppLink | 已完成精确授权 Origin 与完整 URL、原始条目和筛选后 100 项用户 Scope 的分层上限、有效 Token 覆盖检查与缺失 Scope 增量授权、`offline_access` 完整卡片、统一 HTTP/HTTPS 代理、显式直连与无效代理失败关闭、有限轮询、身份匹配、macOS Keychain/Linux 加密文件、进行中/持久状态、撤销、限时停止和写入错误/取消竞态回滚；真实 Device Flow、身份校验、安全写入和 Gateway 重启恢复已通过，代理待验收，尚无飞书 CLI API 消费 Token | 阶段 2 预备实现 |
| 群聊 | 群消息事件、群身份与 @Bot | 已记录为后续需求，当前开发批次不实施 | 阶段 2 |
| 卡片交互 | `im.v1.message.create/patch`、`card.action.trigger` | 私聊审批、用户输入、MCP form/URL 卡片、一次性令牌、Actor/Chat/消息/请求绑定、重复请求失败关闭、原值决定、超时、有限停止、结果更新失败隔离和跨客户端失效已离线验证；命令审批卡片的一次批准与当前 Gateway 长连接动作接收已通过真实验收，用户输入和 MCP 卡片仍待真实验收 | 阶段 3 |
| 私聊 PNG/JPEG 图片 | `im.message.receive_v1`、`im.v1.messageResource.get` | 已完成授权后异步下载、10 MiB 限制、内容签名、私有暂存、过期清理和 Application 图片提交；真实消息主路径已通过验收 | 阶段 4 |
| 一般文件 | IM 资源 API | 暂不支持 | 阶段 4 |
| 飞书 Setup 与应用配置 | SDK Device Authorization、`bot/v3/info`、Application v7 ability/config/publish | 已实现手动输入与扫码、飞书页应用选择、消息/CardKit/应用管理权限及消息/菜单事件与卡片动作回调声明、身份验证和原子配置；Doctor 通过 App/Chat/Actor 一次性令牌保留已有菜单、增量配置 `codexc_home`、事件及回调并提交版本，已有未完成版本时失败关闭；消息路径真实扫码、Doctor 身份探测和命令审批动作回调均已通过，一键配置与菜单待真实验收 | 阶段 0 / 阶段 2 / 阶段 3 / 阶段 4 |
| 飞书以外的 Lark | SDK Domain 配置 | 不在首版范围 | 未计划 |

“计划中”不是公开支持。只有源码、配置、README、测试和真实测试应用冒烟均完成后，才能更新为
“已支持”。

## 真实验收记录

2026-07-25 由操作者在本机开发环境使用测试应用完成以下最小验收：

- 扫码授权完成应用选择并原子保存配置，随后 Doctor 凭据与 Bot 身份探测通过；
- 生产 Gateway 等待 `WSClient.onReady` 后完成启动；
- 一条已授权私聊文本事件成功提交并完成一个 Codex Turn；
- 最终纯文本输出返回原精确 Chat。

2026-07-26 由操作者在 Gateway 重启后继续使用测试应用，确认飞书私聊命令可以返回结果，且命令
与状态当时均为纯文本格式。随后实现切换最终回复和命令结果为 `post + md`，并在 Gateway 重启
后用状态命令和普通 Turn 短回复验证标题、列表、加粗、行内代码和链接能够正确显示。当时长回复
和消息更新尚未验证，不据此把群聊标记为已开始。

同日操作者通过飞书内授权卡片完成真实 OAuth Device Flow，Gateway 校验当前 Actor 后成功写入
安全凭据后端；重复执行授权时暴露出缺少现有 Scope 覆盖检测，随后改为已覆盖时不重复授权、
部分缺失时只申请差集。OAuth 按钮是打开 AppLink 的链接动作，不构成
`card.action.trigger` 回调验收。

随后操作者完成私聊 PNG/JPEG 图片消息、命令审批卡片一次批准和长回复验收：当前 Gateway
通过长连接收到 `card.action.trigger` 后任务继续完成，长回复由飞书客户端折叠显示且消息顺序
正确。再次重启 Gateway 后，原 Thread 绑定恢复且用户 OAuth 仍显示已授权。

同日完成原生流式实现、重建并重启 Gateway 后，操作者确认持续生成的普通回复在飞书客户端
以 CardKit 原生流式卡片可见更新。该验收只覆盖权限、卡片创建、消息引用、至少一次增量更新和
正常结束组成的主路径，不覆盖限流、失败回退、超长内容滚动或网络中断。

同日修正普通文本误用卡片更新接口后，操作者确认同一条轻量 Thread 状态卡片能够从蓝色“运行中”
原地更新为绿色“空闲”，最终正文和 Turn 状态保持原有顺序。该验收不扩大到通用消息编辑或
CardKit 流式失败路径。

尚未验证真实断线恢复、代理、未授权/重复事件重投、用户输入与 MCP 卡片动作、CardKit 真实限流、
失败回退和超长内容滚动。
本记录不保存真实消息、应用标识、用户 Open ID、Chat ID、Token、Secret、临时跳转链接或完整
SDK 响应。

## 本地实现映射

已创建的入口使用仓库链接；尚未创建的文件使用代码文本表示，不建立失效链接。

| 官方概念 | 计划中的本地入口 | 计划验证 |
| --- | --- | --- |
| WebSocket 和 Client | [`src/surfaces/feishu/client.ts`](../src/surfaces/feishu/client.ts)、[`src/surfaces/feishu/message-content.ts`](../src/surfaces/feishu/message-content.ts) | [`tests/feishu-client.test.ts`](../tests/feishu-client.test.ts)：凭据、就绪、重连、停止、文本与富文本 Payload、HTTP 超时、响应校验和错误脱敏 |
| 消息事件信封 | [`src/surfaces/feishu/message-event.ts`](../src/surfaces/feishu/message-event.ts) | [`tests/feishu-message-event.test.ts`](../tests/feishu-message-event.test.ts)：稳定字段裁剪和畸形输入失败关闭 |
| 机器人菜单与命令中心 | [`src/surfaces/feishu/menu-event.ts`](../src/surfaces/feishu/menu-event.ts)、[`src/surfaces/feishu/command-center.ts`](../src/surfaces/feishu/command-center.ts)、[`src/surfaces/feishu/surface.ts`](../src/surfaces/feishu/surface.ts) | [`tests/feishu-menu-event.test.ts`](../tests/feishu-menu-event.test.ts)、[`tests/feishu-command-center.test.ts`](../tests/feishu-command-center.test.ts)、[`tests/feishu-client.test.ts`](../tests/feishu-client.test.ts)、[`tests/feishu-surface.test.ts`](../tests/feishu-surface.test.ts)：严格事件裁剪、活动连接门控、唯一授权私聊路由、事件去重、卡片令牌绑定、只读动作白名单和审批动作隔离 |
| 应用配置与发布 | [`src/surfaces/feishu/application-api.ts`](../src/surfaces/feishu/application-api.ts)、[`src/surfaces/feishu/application-setup.ts`](../src/surfaces/feishu/application-setup.ts) | [`tests/feishu-application-api.test.ts`](../tests/feishu-application-api.test.ts)、[`tests/feishu-application-setup.test.ts`](../tests/feishu-application-setup.test.ts)、[`tests/feishu-surface.test.ts`](../tests/feishu-surface.test.ts)：严格配置快照、已有菜单保留、官方应用管理授权的 App/租户校验、App/Chat/Actor/消息令牌、未完成版本失败关闭、事件/回调增量更新、版本提交、部分失败提示和生命周期取消 |
| 输入接收与去重 | [`src/surfaces/feishu/inbox.ts`](../src/surfaces/feishu/inbox.ts) | [`tests/feishu-inbox.test.ts`](../tests/feishu-inbox.test.ts)：同步入队、授权拒绝不污染去重键、重复、旧事件、顺序、并行、过载和关闭 |
| Application 输入适配 | [`src/surfaces/feishu/adapter.ts`](../src/surfaces/feishu/adapter.ts) | [`tests/feishu-adapter.test.ts`](../tests/feishu-adapter.test.ts)：新 Turn 提交、活动 Turn 追加提示、Application 命令与参数透传、本地帮助/身份/取消、未知斜杠命令失败关闭、结构化错误、未知异常脱敏和输出队列拒绝不重试状态修改 |
| 身份与授权 | [`src/policy/feishu-access.ts`](../src/policy/feishu-access.ts)、`ConversationActorRegistry` | [`tests/policy.test.ts`](../tests/policy.test.ts)：Surface、App ID、Open ID 和原子替换 |
| 消息发送与状态更新 | [`src/surfaces/feishu/outbox.ts`](../src/surfaces/feishu/outbox.ts)、[`src/surfaces/feishu/client.ts`](../src/surfaces/feishu/client.ts)、[`src/surfaces/feishu/message-content.ts`](../src/surfaces/feishu/message-content.ts)、[`src/surfaces/feishu/status-card.ts`](../src/surfaces/feishu/status-card.ts) | [`tests/feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts)、[`tests/feishu-client.test.ts`](../tests/feishu-client.test.ts)：精确账号路由、顺序、并行、纯文本 UTF-8 与富文本序列化内容的 20,000 字节上限、每个逻辑结果最多 5 条、明确截断、Thread active/idle 轻量卡片创建与更新、重复抑制、失败绑定清理、关闭、SDK Payload、超时和错误；真实状态卡片原地更新已通过，限流行为待验证 |
| 原生流式输出 | [`src/surfaces/feishu/outbox.ts`](../src/surfaces/feishu/outbox.ts)、[`src/surfaces/feishu/client.ts`](../src/surfaces/feishu/client.ts) | [`tests/feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts)、[`tests/feishu-client.test.ts`](../tests/feishu-client.test.ts)：CardKit 2.0 精确 Payload、消息引用、递增序列与 UUID、增量合并、短回复、滚动与代码围栏、卡片和回退共用 5 条预算、失败卡片尽力结束、UTF-16 摘要边界、Turn/关闭收尾、稳定脱敏错误及完整富文本回退；真实持续回复主路径已通过，限流、失败回退和超长内容滚动待验收 |
| 私聊图片输入 | [`src/surfaces/feishu/media.ts`](../src/surfaces/feishu/media.ts)、[`src/surfaces/managed-image-store.ts`](../src/surfaces/managed-image-store.ts)、[`src/surfaces/feishu/inbox.ts`](../src/surfaces/feishu/inbox.ts)、[`src/surfaces/feishu/adapter.ts`](../src/surfaces/feishu/adapter.ts) | [`tests/feishu-media.test.ts`](../tests/feishu-media.test.ts)、[`tests/feishu-inbox.test.ts`](../tests/feishu-inbox.test.ts)、[`tests/feishu-adapter.test.ts`](../tests/feishu-adapter.test.ts)、[`tests/feishu-surface.test.ts`](../tests/feishu-surface.test.ts)、[`tests/feishu-client.test.ts`](../tests/feishu-client.test.ts)：资源 Key 裁剪、授权后下载、精确资源 API Payload、10 MiB 限制、PNG/JPEG 签名、私有权限、错误脱敏、Application 提交和生命周期；真实消息主路径已通过 |
| 输出渲染 | [`src/surfaces/feishu/renderer.ts`](../src/surfaces/feishu/renderer.ts) | [`tests/feishu-renderer.test.ts`](../tests/feishu-renderer.test.ts)：启动环境与脱敏 UA、每轮上下文和设置、全部 `ConversationCommandResult` 顶层种类、全部命令 Outcome、模型视图、非空集合、会话列表最多 20 条及 48 字符规范预览、Diff、Plan、Goal、关键事件、非关键进度和错误详情隐藏 |
| 权限中心 | [`src/surfaces/feishu/permissions.ts`](../src/surfaces/feishu/permissions.ts)、[`src/surfaces/feishu/adapter.ts`](../src/surfaces/feishu/adapter.ts) | [`tests/feishu-adapter.test.ts`](../tests/feishu-adapter.test.ts)、[`tests/feishu-surface.test.ts`](../tests/feishu-surface.test.ts)：当前进程连接/事件/回调观测、Gateway 已用能力清单、精确 App ID 申请入口、未知参数失败关闭和不泄露凭据 |
| 用户 OAuth | [`src/surfaces/feishu/oauth-device-flow.ts`](../src/surfaces/feishu/oauth-device-flow.ts)、[`src/surfaces/feishu/oauth-card.ts`](../src/surfaces/feishu/oauth-card.ts)、[`src/surfaces/feishu/oauth-token-store.ts`](../src/surfaces/feishu/oauth-token-store.ts)、[`src/surfaces/feishu/oauth.ts`](../src/surfaces/feishu/oauth.ts) | [`tests/feishu-oauth-device-flow.test.ts`](../tests/feishu-oauth-device-flow.test.ts)、[`tests/feishu-oauth.test.ts`](../tests/feishu-oauth.test.ts)、[`tests/feishu-client.test.ts`](../tests/feishu-client.test.ts)：严格用户 Scope、混合 Token 类型与分层数量上限、精确授权 Origin 与完整 URL、有界 Device Flow 请求/轮询、飞书 AppLink、`offline_access` 展示、有效 Token 覆盖与缺失 Scope 增量授权、统一 HTTP 代理、显式直连与无效代理失败关闭、Actor 身份匹配、进行中状态、重复流、限时停止/撤销竞态、写入错误/取消回滚、Token 不进入消息、Keychain 原地更新与命令超时，以及 Linux 原子密文替换与私有权限；真实 Device Flow、身份校验、安全写入和 Token 重启恢复已通过，代理待验收 |
| 卡片动作裁剪 | [`src/surfaces/feishu/card-action.ts`](../src/surfaces/feishu/card-action.ts)、[`src/surfaces/feishu/client.ts`](../src/surfaces/feishu/client.ts) | [`tests/feishu-card-action.test.ts`](../tests/feishu-card-action.test.ts)、[`tests/feishu-client.test.ts`](../tests/feishu-client.test.ts)：稳定路由字段、受限字符串动作值与 `form_value`、畸形输入失败关闭、活动连接门控和独立诊断 |
| 卡片交互 | [`src/surfaces/feishu/approval-card.ts`](../src/surfaces/feishu/approval-card.ts)、[`src/surfaces/feishu/input-card.ts`](../src/surfaces/feishu/input-card.ts)、[`src/surfaces/feishu/interactions.ts`](../src/surfaces/feishu/interactions.ts) | [`tests/feishu-interactions.test.ts`](../tests/feishu-interactions.test.ts)：有界审批与表单卡片、秘密输入、MCP JSON/URL、不可预测一次性令牌、Actor/Chat/消息绑定、请求原值决定、越权与重复动作、重复请求失败关闭、过期、卡片创建悬挂时的有限停止、结果更新失败隔离和跨客户端失效；命令审批一次批准真实主路径已通过，用户输入与 MCP 卡片仍待真实验收 |
| 配置 | [`runtime/gateway-config.mjs`](../runtime/gateway-config.mjs)、[`src/config/`](../src/config/README.md) | [`tests/config.test.ts`](../tests/config.test.ts)、[`tests/config-reload.test.ts`](../tests/config-reload.test.ts)：启用映射、禁用、畸形输入、未知字段、凭据/启用重启和允许名单热加载 |
| Setup 与 Doctor | [`scripts/feishu-setup.mjs`](../scripts/feishu-setup.mjs)、[`scripts/feishu-application.mjs`](../scripts/feishu-application.mjs)、[`scripts/doctor.mjs`](../scripts/doctor.mjs)、[`src/surfaces/feishu/application-setup.ts`](../src/surfaces/feishu/application-setup.ts) | [`tests/feishu-setup.test.ts`](../tests/feishu-setup.test.ts)、[`tests/feishu-application.test.ts`](../tests/feishu-application.test.ts)、[`tests/feishu-adapter.test.ts`](../tests/feishu-adapter.test.ts)、[`tests/feishu-application-setup.test.ts`](../tests/feishu-application-setup.test.ts)：手动输入、扫码授权、应用选择、消息/CardKit/应用管理权限、消息/菜单事件与卡片动作回调声明、有限 HTTP 探测、凭据与 Bot 身份验证、精确增量权限入口、应用配置确认、允许名单确认、原子写入和错误脱敏。Doctor 不建立第二条消息长连接；命令审批回调已通过，一键应用配置、菜单、用户输入/MCP 回调仍由真实冒烟验证 |
| Surface 生命周期 | [`src/surfaces/feishu/surface.ts`](../src/surfaces/feishu/surface.ts) | [`tests/feishu-surface.test.ts`](../tests/feishu-surface.test.ts)：长连接启停与脱敏状态日志、重连跨越时的事件去重、输入与输出排空、连续过载提示收敛、未组合收件人失败关闭和安全配置通知 |
| Bootstrap 组合 | [`src/bootstrap/surface-composition.ts`](../src/bootstrap/surface-composition.ts) | [`tests/surface-composition.test.ts`](../tests/surface-composition.test.ts)、[`tests/surface-manager.test.ts`](../tests/surface-manager.test.ts)：按配置注册、允许名单热加载、撤权绑定清理、配置通知路由、部分启动回滚和停止不影响 App Server |

新增能力必须同时更新支持矩阵和实现映射，不能只增加 SDK 调用。

## 本地资料保存规则

不把飞书官方文档整站或整页复制到仓库。仓库只保存：

- `package-lock.json` 锁定的 SDK 版本和必要的固定源码链接；
- 从测试应用取得、已脱敏且最小化的事件 Fixture；
- 真实合同实验的命令、结构化结果和不含凭据的结论；
- 官方动态页面无法固定时，对影响实现的约束所做的简短转述、来源链接和查阅日期。

不得保存 App Secret、Access Token、Verification Token、Encrypt Key、真实用户消息、完整事件原文
或未经清洗的 SDK 响应。官方页面变化时更新索引和测试，不通过长期维护整页镜像解决漂移问题。

## 查询与更新流程

实施或排查飞书行为时：

1. 从本页按能力找到官方入口、已知约束和项目状态。
2. 查看项目锁定版本；未锁定时只能进行阶段 0 研究，不能写稳定适配。
3. 阅读对应固定版本 SDK 类型和源码，再查开放平台动态文档。
4. 对照 [`飞书 Surface 接入计划`](feishu-surface-plan.md) 和
   [`通讯渠道 Surface 接入指南`](surface-integration-guide.md) 确认模块归属。
5. 用测试应用验证仍不明确的投递、重试、权限和回调行为。
6. 实现后更新支持矩阵、本地映射、测试入口和查阅日期。

出现以下变化时必须更新本页：

- 首次安装或升级飞书 SDK；
- 改变事件、权限、卡片动作、身份或传输方式；
- 新增飞书公开能力或真实测试入口；
- 官方资料与实际行为不一致；
- 计划文件、本地实现入口或测试文件发生移动。
