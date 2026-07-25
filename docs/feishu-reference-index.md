# 飞书官方资料与实现索引

## 用途与状态

本页用于定位飞书开放平台、官方 Node SDK、本地实现和验证入口。它是飞书 Surface 的事实查询
入口，不替代 [`飞书 Surface 接入计划`](feishu-surface-plan.md)；当前支持扫码 Setup 与开发验证
中的阶段 1 私聊文本路径。

截至 2026-07-25，项目已精确锁定 `@larksuiteoapi/node-sdk@1.71.1`，并完成阶段 1 私聊文本
模块、严格配置和 Bootstrap 显式组合。测试应用已完成扫码配置、Doctor 探测、生产 Gateway
首次握手、一次已授权私聊 Turn 和精确 Chat 文本回复；断线恢复、未授权/重复真实事件、代理和
卡片动作合同仍未完成，当前启用路径属于开发验证，不应视为生产就绪。

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
| 查阅日期 | 2026-07-25 |
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
| WebSocket 生命周期 | [固定版本 `ws-client`](https://github.com/larksuite/node-sdk/tree/8b3e0df3af9401c263dc96026e1c7f17460a21cc/ws-client) | 核对 `onReady`、错误、重连、关闭和状态语义 |
| 高层 Channel | [固定版本 Channel 说明](https://github.com/larksuite/node-sdk/blob/8b3e0df3af9401c263dc96026e1c7f17460a21cc/docs/channel.zh.md) | 识别其策略、去重、串行、重试、媒体和卡片职责 |
| 消息事件字段格式 | [官方 CLI 固定事件 Schema 指南](https://github.com/larksuite/cli/blob/a7865cd0a7416655535517a2a630848fde318761/skills/lark-event/SKILL.md) | 核对 `create_time` 为毫秒时间戳字符串 |
| 长连接规则 | [使用长连接接收事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode) | 处理时限、集群投递和订阅类型 |
| 文本消息发送 | [发送消息](https://open.feishu.cn/document/server-docs/im-v1/message/create) | 核对 `chat_id` 接收目标、文本消息体和机器人可用性 |
| 事件接收安全 | [接收事件](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-/encrypt-key-encryption-configuration-case) | Webhook 阶段的验签和加密入口 |
| 消息卡片 | [消息卡片介绍](https://open.feishu.cn/document/ukTMukTMukTM/uczM3QjL3MzN04yNzcDN) | 后续卡片呈现和交互边界 |
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

验证完成前，项目只能提供失败关闭的 `InteractionPort`，不得开放飞书批准操作。

### 高层 Channel

官方 Channel 同时管理平台策略、消息归一化、去重、旧事件过滤、同会话串行、发送回退、重试、
流式卡片和媒体。项目已经由 Policy、Application、Conversation Core、Approval 和
`ConversationDeliveryQueue` 管理这些语义，因此当前计划默认采用低层 `Client + WSClient +
EventDispatcher`。

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
`im:message:send_as_bot` 和
`im.message.receive_v1`。注册完成后使用 `/open-apis/bot/v3/info` 验证凭据和 Bot 身份，不启动
第二条消息长连接。事件订阅方式等敏感开发配置无法通过 `addons` 设置，仍需在开放平台确认。

## 项目支持矩阵

| 能力 | 官方入口 | 项目状态 | 实施阶段 |
| --- | --- | --- | --- |
| Node SDK | npm 包、固定官方源码 | 已精确锁定 `1.71.1` | 阶段 0 |
| WebSocket 握手和重连 | `WSClient` | 生命周期封装、离线合同和真实首次握手已完成；真实断线恢复待验证 | 阶段 0 |
| 消息事件字段裁剪 | `im.message.receive_v1` | 稳定字段映射、畸形输入失败关闭和一条真实私聊文本事件已验证 | 阶段 0 |
| 私聊文本事件 | `im.message.receive_v1` | 平台本地筛选、有界入队、Access Policy、Application 提交、安全错误和生命周期组合已完成；真实已授权主路径已通过，未授权/重复真实事件待验证 | 阶段 1 |
| 文本发送 | `client.im.v1.message.create` | `chat_id` 文本 Payload、有限 HTTP 超时和脱敏错误已完成；真实精确 Chat 文本回复已通过 | 阶段 1 |
| 纯文本输出渲染 | `OutputEvent` | 关键事件回退、错误隐藏、有界 Outbox、Surface 生命周期和安全配置通知收件人已完成 | 阶段 1 |
| 事件去重与旧事件过滤 | 平台事件 ID、毫秒时间戳 | 已实现飞书模块内有界内存状态；真实重投待验证 | 阶段 1 |
| 严格配置与重载分类 | 统一 `config.toml` | 私聊字段、失败关闭校验、变更码、公开示例和 Bootstrap 显式组合已完成 | 阶段 1 |
| 私聊命令 | `ConversationCommandService`、私聊文本事件 | 全部平台无关命令结果、帮助、身份、取消、未知命令失败关闭、会话列表收敛和 20,000 UTF-8 字节有界安全分片已完成离线验证；阶段 1 关闭后再做真实应用验收 | 阶段 2 预备实现 |
| 群聊 | 群消息事件、群身份与 @Bot | 暂不支持 | 阶段 2 |
| 卡片审批 | `card.action.trigger` | 接收方式待验证，当前失败关闭 | 阶段 3 |
| 图片和文件 | IM 资源 API | 暂不支持 | 阶段 4 |
| 飞书 Setup | SDK Device Authorization、`bot/v3/info` | 已实现手动输入与扫码、飞书页应用选择、最小权限、身份验证和原子配置；真实扫码与 Doctor 身份探测已通过 | 阶段 0 |
| 飞书以外的 Lark | SDK Domain 配置 | 不在首版范围 | 未计划 |

“计划中”不是公开支持。只有源码、配置、README、测试和真实测试应用冒烟均完成后，才能更新为
“已支持”。

## 真实验收记录

2026-07-25 由操作者在本机开发环境使用测试应用完成以下最小验收：

- 扫码授权完成应用选择并原子保存配置，随后 Doctor 凭据与 Bot 身份探测通过；
- 生产 Gateway 等待 `WSClient.onReady` 后完成启动；
- 一条已授权私聊文本事件成功提交并完成一个 Codex Turn；
- 最终纯文本输出返回原精确 Chat。

尚未验证真实断线恢复、代理、未授权/重复事件重投、Gateway 重启后的 Thread 绑定恢复和卡片动作。
本记录不保存真实消息、应用标识、用户 Open ID、Chat ID、Token、Secret 或完整 SDK 响应。

## 本地实现映射

已创建的入口使用仓库链接；尚未创建的文件使用代码文本表示，不建立失效链接。

| 官方概念 | 计划中的本地入口 | 计划验证 |
| --- | --- | --- |
| WebSocket 和 Client | [`src/surfaces/feishu/client.ts`](../src/surfaces/feishu/client.ts) | [`tests/feishu-client.test.ts`](../tests/feishu-client.test.ts)：凭据、就绪、重连、停止、文本 Payload、HTTP 超时、响应校验和错误脱敏 |
| 消息事件信封 | [`src/surfaces/feishu/message-event.ts`](../src/surfaces/feishu/message-event.ts) | [`tests/feishu-message-event.test.ts`](../tests/feishu-message-event.test.ts)：稳定字段裁剪和畸形输入失败关闭 |
| 输入接收与去重 | [`src/surfaces/feishu/inbox.ts`](../src/surfaces/feishu/inbox.ts) | [`tests/feishu-inbox.test.ts`](../tests/feishu-inbox.test.ts)：同步入队、授权、重复、旧事件、顺序、并行、过载和关闭 |
| Application 输入适配 | [`src/surfaces/feishu/adapter.ts`](../src/surfaces/feishu/adapter.ts) | [`tests/feishu-adapter.test.ts`](../tests/feishu-adapter.test.ts)：新 Turn 提交、活动 Turn 追加提示、Application 命令与参数透传、本地帮助/身份/取消、未知斜杠命令失败关闭、结构化错误、未知异常脱敏和输出队列拒绝不重试状态修改 |
| 身份与授权 | [`src/policy/feishu-access.ts`](../src/policy/feishu-access.ts)、`ConversationActorRegistry` | [`tests/policy.test.ts`](../tests/policy.test.ts)：Surface、App ID、Open ID 和原子替换 |
| 文本发送 | [`src/surfaces/feishu/outbox.ts`](../src/surfaces/feishu/outbox.ts)、[`src/surfaces/feishu/client.ts`](../src/surfaces/feishu/client.ts) | [`tests/feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts)、[`tests/feishu-client.test.ts`](../tests/feishu-client.test.ts)：精确账号路由、顺序、并行、每条 20,000 UTF-8 字节且每个逻辑结果最多 5 条的安全分片、明确截断、关闭、SDK Payload、超时和错误；真实限流行为待验证 |
| 输出渲染 | [`src/surfaces/feishu/renderer.ts`](../src/surfaces/feishu/renderer.ts) | [`tests/feishu-renderer.test.ts`](../tests/feishu-renderer.test.ts)：全部 `ConversationCommandResult` 顶层种类、全部命令 Outcome、模型视图、非空集合、会话列表最多 20 条及 48 字符规范预览、Diff、Plan、Goal、关键事件、非关键进度和错误详情隐藏 |
| 卡片动作 | [`src/surfaces/feishu/interactions.ts`](../src/surfaces/feishu/interactions.ts) | [`tests/feishu-interactions.test.ts`](../tests/feishu-interactions.test.ts)：当前审批拒绝、用户输入为空、MCP elicitation 取消；卡片令牌、过期、Actor 绑定和跨客户端失效待实现 |
| 配置 | [`runtime/gateway-config.mjs`](../runtime/gateway-config.mjs)、[`src/config/`](../src/config/README.md) | [`tests/config.test.ts`](../tests/config.test.ts)、[`tests/config-reload.test.ts`](../tests/config-reload.test.ts)：启用映射、禁用、畸形输入、未知字段、凭据/启用重启和允许名单热加载 |
| Setup 与 Doctor | [`scripts/feishu-setup.mjs`](../scripts/feishu-setup.mjs)、[`scripts/feishu-application.mjs`](../scripts/feishu-application.mjs)、[`scripts/doctor.mjs`](../scripts/doctor.mjs) | [`tests/feishu-setup.test.ts`](../tests/feishu-setup.test.ts)、[`tests/feishu-application.test.ts`](../tests/feishu-application.test.ts)：手动输入、扫码授权、应用选择、最小权限、有限 HTTP 探测、凭据与 Bot 身份验证、授权域名约束、允许名单确认、原子写入和错误脱敏。Doctor 不建立第二条消息长连接；应用发布和完整权限仍由真实冒烟验证 |
| Surface 生命周期 | [`src/surfaces/feishu/surface.ts`](../src/surfaces/feishu/surface.ts) | [`tests/feishu-surface.test.ts`](../tests/feishu-surface.test.ts)：长连接启停与脱敏状态日志、输入与输出排空、过载提示、未组合收件人失败关闭和安全配置通知 |
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
