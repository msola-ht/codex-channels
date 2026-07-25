# 飞书官方资料与实现索引

## 用途与状态

本页用于定位飞书开放平台、官方 Node SDK、计划中的本地实现和验证入口。它是飞书 Surface 的
事实查询入口，不替代 [`飞书 Surface 接入计划`](feishu-surface-plan.md)，也不表示项目当前已经
支持飞书。

截至 2026-07-25，项目已精确锁定 `@larksuiteoapi/node-sdk@1.71.1`，并建立未注册到 Bootstrap
的 Phase 0 长连接生命周期封装和离线合同测试。飞书仍不是可启用渠道；测试应用握手、代理、
事件投递和卡片动作实验完成前，不能进入生产启动路径。

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
| WebSocket 生命周期 | [固定版本 `ws-client`](https://github.com/larksuite/node-sdk/tree/8b3e0df3af9401c263dc96026e1c7f17460a21cc/ws-client) | 核对 `onReady`、错误、重连、关闭和状态语义 |
| 高层 Channel | [固定版本 Channel 说明](https://github.com/larksuite/node-sdk/blob/8b3e0df3af9401c263dc96026e1c7f17460a21cc/docs/channel.zh.md) | 识别其策略、去重、串行、重试、媒体和卡片职责 |
| 消息事件字段格式 | [官方 CLI 固定事件 Schema 指南](https://github.com/larksuite/cli/blob/a7865cd0a7416655535517a2a630848fde318761/skills/lark-event/SKILL.md) | 核对 `create_time` 为毫秒时间戳字符串 |
| 长连接规则 | [使用长连接接收事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/long-connection-mode) | 处理时限、集群投递和订阅类型 |
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

### 身份与 Setup

当前 SDK `main` 的 Channel 会在缺少 `open_id` 时向 `user_id` 或 `union_id` 回退；本项目首版不
采用该回退，只接受明确的 `sender.open_id`。

当前 SDK 资料还显示 `registerApp()` 可能返回扫码用户的 `open_id`。这可能避免 Setup 为发现身份
临时启动第二条长连接，但它是否已进入准备锁定的正式版本、申请了哪些默认权限、能否使用最小
权限基座，以及是否适合更新已有应用，都必须在阶段 0 单独验证。未验证前，Setup 继续以手动创建
企业自建应用和显式配置为基线。

## 项目支持矩阵

| 能力 | 官方入口 | 项目状态 | 实施阶段 |
| --- | --- | --- | --- |
| Node SDK | npm 包、固定官方源码 | 已精确锁定 `1.71.1` | 阶段 0 |
| WebSocket 握手和重连 | `WSClient` | 生命周期封装和离线合同已完成；真实应用实验待完成 | 阶段 0 |
| 消息事件字段裁剪 | `im.message.receive_v1` | 稳定字段映射和畸形输入失败关闭已完成；真实事件待验证 | 阶段 0 |
| 私聊文本事件 | `im.message.receive_v1` | 平台本地筛选和有界入队已完成；Access Policy 与 Adapter 待实现 | 阶段 1 |
| 文本发送 | `client.im.v1.message.create` | 计划中 | 阶段 1 |
| 事件去重与旧事件过滤 | 平台事件 ID、毫秒时间戳 | 已实现飞书模块内有界内存状态；真实重投待验证 | 阶段 1 |
| 命令和群聊 | 消息事件、群身份与 @Bot | 暂不支持 | 阶段 2 |
| 卡片审批 | `card.action.trigger` | 接收方式待验证，当前失败关闭 | 阶段 3 |
| 图片和文件 | IM 资源 API | 暂不支持 | 阶段 4 |
| `registerApp()` Setup | SDK Device Authorization | 候选方案，未采用 | 阶段 0 后决定 |
| 飞书以外的 Lark | SDK Domain 配置 | 不在首版范围 | 未计划 |

“计划中”不是公开支持。只有源码、配置、README、测试和真实测试应用冒烟均完成后，才能更新为
“已支持”。

## 本地实现映射

已创建的入口使用仓库链接；尚未创建的文件使用代码文本表示，不建立失效链接。

| 官方概念 | 计划中的本地入口 | 计划验证 |
| --- | --- | --- |
| WebSocket 和 Client | [`src/surfaces/feishu/client.ts`](../src/surfaces/feishu/client.ts) | [`tests/feishu-client.test.ts`](../tests/feishu-client.test.ts)：凭据、就绪、超时、重连、停止和错误脱敏 |
| 消息事件信封 | [`src/surfaces/feishu/message-event.ts`](../src/surfaces/feishu/message-event.ts) | [`tests/feishu-message-event.test.ts`](../tests/feishu-message-event.test.ts)：稳定字段裁剪和畸形输入失败关闭 |
| 输入接收与去重 | [`src/surfaces/feishu/inbox.ts`](../src/surfaces/feishu/inbox.ts) | [`tests/feishu-inbox.test.ts`](../tests/feishu-inbox.test.ts)：同步入队、授权、重复、旧事件、顺序、并行、过载和关闭 |
| 身份与授权 | `FeishuAccessPolicy`、`ConversationActorRegistry` | App ID、Chat ID、Open ID 和 Workspace |
| 文本发送 | `src/surfaces/feishu/outbox.ts` | 精确账号路由、同 Chat 顺序、超时和限流 |
| 输出渲染 | `src/surfaces/feishu/renderer.ts` | 所有关键 `OutputEvent` 的纯文本回退 |
| 卡片动作 | `src/surfaces/feishu/interactions.ts` | 失败关闭、令牌、过期、Actor 绑定和跨客户端失效 |
| 配置与 Setup | `runtime/gateway-config.mjs`、`src/config/`、`scripts/` | 严格 Schema、脱敏、原子写入和只读 Doctor |
| 生命周期组合 | `src/bootstrap/surface-composition.ts` | 单消费者、部分启动回滚和停止不影响 App Server |

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
