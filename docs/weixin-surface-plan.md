# 微信 Surface 接入计划

## 状态与目标

状态：阶段 0 规划完成，尚未增加运行时代码、配置、依赖或公开能力。

本计划用于把腾讯微信 ClawBot 接入现有 TypeScript 模块化 Gateway。实现必须继续遵守
[`通讯渠道 Surface 接入指南`](surface-integration-guide.md)，并与 Telegram、飞书共享
Application、Conversation Core、Approval、Policy、Session Routing、Storage、Event Bus 和
同一个 Codex App Server。

首个目标是单个微信 Bot 账号与已授权用户之间的私聊文本闭环。当前不承诺群聊、交互按钮、
原生流式消息、主动推送、多账号或完整媒体能力。

## 官方参考基线

当前研究基线固定为腾讯官方仓库
[`Tencent/openclaw-weixin`](https://github.com/Tencent/openclaw-weixin/tree/v2.4.6) 的
`v2.4.6` 标签，对应提交
[`cef0bfc`](https://github.com/Tencent/openclaw-weixin/commit/cef0bfc390393f716903e16d50408118047f87e0)。
后续开始实现前必须重新确认标签、协议说明和微信侧可用性；不能直接以变化中的 `main` 分支作为
稳定合同。

| 查询目标 | 固定资料 | 当前事实 |
| --- | --- | --- |
| 安装、登录与后端协议 | [`README.zh_CN.md`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/README.zh_CN.md) | 扫码登录；HTTP JSON API；`getupdates` 长轮询；文本、图片、视频和文件发送 |
| 包与宿主要求 | [`package.json`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/package.json) | Node.js 22+；包本身依赖 OpenClaw Plugin SDK |
| 渠道能力 | [`channel.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/channel.ts) | 当前声明只支持私聊、媒体和块式回复，不声明群聊或交互卡片 |
| 扫码合同 | [`login-qr.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/auth/login-qr.ts) | 二维码会话、轮询、确认、过期、重定向和 Bot Token 返回 |
| HTTP API | [`api.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/api/api.ts)、[`types.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/api/types.ts) | Bearer Token、长轮询、发送、输入状态和错误响应 |
| 消息循环 | [`monitor.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/monitor/monitor.ts) | 按账号维护游标、有限重试、退避和可取消长轮询 |
| 身份与回复上下文 | [`inbound.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/messaging/inbound.ts)、[`send.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/messaging/send.ts) | `from_user_id`、`message_id`、`context_token` 和受限文本发送 |
| 账号与游标存储 | [`accounts.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/auth/accounts.ts)、[`sync-buf.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/storage/sync-buf.ts) | 官方插件自行保存账号 Token、账号索引和 `get_updates_buf` |
| 许可证 | [`LICENSE`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/LICENSE) | MIT |

官方 README 对 OpenClaw 宿主兼容范围的概述比 `v2.4.6` 包元数据更宽；这只影响官方插件作为
OpenClaw 扩展运行。Codex Connect 不采用该宿主合同，阶段 0 只把固定标签中的微信 HTTP 协议和
行为作为待验证参考。

## 接入决策

### 不引入第二个 Gateway

不安装 OpenClaw、不启动 OpenClaw Gateway，也不把
`@tencent-weixin/openclaw-weixin` 作为运行时依赖。该包的 Channel、路由、会话、授权和回复分发
依赖 OpenClaw Plugin SDK，直接嵌入会形成第二套 Core 和生命周期。

优先方案是在 `src/surfaces/weixin/` 内实现最小微信协议 Adapter：

```text
微信 ClawBot
  │ 扫码登录 / HTTP JSON / getupdates 长轮询
  ▼
Weixin Surface
  ├─ 微信协议窄客户端
  ├─ 身份、访问策略与输入队列
  ├─ OutputEvent 文本渲染
  └─ 失败关闭 InteractionPort
  │
  ▼
Application / Core / Approval / Routing
  │
  ▼
共享 Codex App Server
```

阶段 0 必须先确认 Codex Connect 作为独立客户端直接调用微信后端属于受支持的接入方式，并确认
API 使用约束、服务条款以及扫码、长轮询和发送合同仍与固定标签一致。若只能通过 OpenClaw 宿主
获得受支持连接，则停止实现，不以子进程、微服务或协议猜测绕过。

### 模块边界

- Surface ID 使用 `weixin`；“微信 ClawBot”只是显示名称。
- 微信协议、二维码、媒体和错误类型只存在于 `src/surfaces/weixin/`。
- Bootstrap 通过现有编译期内置插件注册表显式创建 Weixin Surface，不扫描目录、不动态加载 npm
  包。
- 普通消息调用 `ConversationService`，共享命令调用 `ConversationCommandService`。
- 微信不得导入 `codex-client`、`codex-protocol` 或其他 Surface 的内部文件。
- 平台输出继续使用 `ConversationDeliveryQueue`；同一私聊串行，不同私聊可以并行。
- 只复用已经公开的平台无关能力，不复制 Telegram HTML、飞书 CardKit、平台文案或交互状态机。

## 身份、授权与状态

首个版本只支持私聊：

| 稳定概念 | 微信来源 | 要求 |
| --- | --- | --- |
| `surface` | 固定值 `weixin` | 不使用官方插件 ID 作为项目内部 Surface ID |
| `accountId` | 扫码结果中的 Bot 账号 ID | 规范化规则必须在阶段 0 用真实结果固定，不使用显示名称 |
| `conversationId` | 私聊对端 `from_user_id` | 与账号共同确定回复目标 |
| `actorId` | 当前消息的 `from_user_id` | 私聊中可与 Conversation 值相同，但仍独立构造并校验 |

所有输入必须先验证消息方向、账号、Actor、时间戳和内容，再执行
`SurfaceAccessPolicy.isAllowed()`。扫码者不能仅因完成扫码就永久获得全部 Workspace 权限；
Setup 必须显示识别到的微信 Actor，并由操作者在终端确认允许名单。

当前官方能力只声明私聊。群聊身份、`@Bot`、群成员授权和 Conversation ID 在官方合同明确前不进入
配置 Schema，也不以私聊 ID 规则推断。

## 凭据与最小持久状态

官方插件的磁盘布局不能直接复制到本项目：

- Bot Token 属于敏感凭据。macOS 必须使用系统 Keychain，Linux 必须使用与项目现有凭据机制
  同等的 AES-256-GCM 私有文件；不得写入 `config.toml`、SQLite、日志或聊天消息。
- 二维码内容、扫码会话和短期验证码只保存在内存中，成功、取消、过期或进程停止时清除。
- `context_token` 是回复当前用户所需的敏感路由令牌。首个文本闭环只在内存保存，Gateway
  重启后在用户再次发言前不进行主动微信推送。
- `get_updates_buf` 是避免重启后漏取或大量重放的传输游标，不属于 Thread 或消息历史。阶段 0
  必须确认服务端确认语义，再单独评审是否以私有、原子文件保存在 Gateway 数据目录。该决定会
  新增持久化格式，进入实现前需要明确批准。
- 不持久化微信消息正文、媒体内容、引用消息、Codex 回复或完整事件原文。

若后续需要启动通知、配置通知或定时主动发送，必须先单独设计 `context_token` 的加密保存、撤销、
过期和账号隔离；不能为了主动推送把 Token 放进 StateStore。

### Bot Token 存储决策

当前仓库没有可直接使用的通用凭据 Store。现有实现是飞书用户 OAuth 专用的
`StoredFeishuUserToken`、Keychain Service 和 Linux 文件载荷；微信不得导入、包装或写入飞书
Surface 的内部存储，也不得沿用其 Service、文件名或账号键。

阶段 0 必须在写入生产凭据前完成并批准以下最小设计：

1. 只从飞书实现中抽取平台无关的 Keychain 调用、AES-256-GCM、私有目录、原子替换和删除机制；
   微信仍拥有自己的严格载荷解析、账号键、错误文案和撤销语义。共享机制属于 `surfaces` 模块
   内部基础设施，不建立新的一级模块，也不向 Application、Storage 或 Config 暴露 Token。
2. 保留飞书现有 Keychain Service、Linux 路径、主密钥和载荷格式，不迁移、不重写现有凭据。
   微信使用独立命名空间和独立凭据文件；共享代码不等于共享凭据记录。
3. 微信载荷必须带显式当前版本，只包含阶段 0 证明为恢复登录必需的账号身份、Bot Token 和服务端
   返回的稳定连接信息。未知版本、字段缺失、身份不匹配、解密失败或内容损坏必须失败关闭，不能
   当作“未登录”后静默重新授权。
4. 写入必须先验证完整新载荷，再原子替换；写入、关闭或取消失败时保留上一个有效记录。撤销只删除
   精确微信账号的凭据，不影响 TOML、Thread 绑定、飞书凭据或其他微信账号。
5. 回滚以禁用微信 Surface 并删除新增的微信凭据记录为界，不需要迁移 SQLite 或改写飞书数据。
   如果实现需要改变既有飞书格式、共用一份跨 Surface 载荷或迁移现有凭据，则停止并另行评审。

该设计会新增微信凭据持久化格式。进入阶段 1 前必须说明必要性、当前数据处理和回滚方式并取得
明确批准；计划文档本身不授权实现该格式。

## 分阶段实施

### 阶段 0：协议合同实验

本阶段不接入生产 Gateway，不新增公开配置：

1. 固定官方标签、提交和采用的源码入口。
2. 验证二维码创建、扫描、确认、过期、重定向和重复登录。
3. 记录登录成功返回的账号 ID、Actor ID、Bot Token 与 Base URL 的稳定形状，但所有 Fixture
   必须脱敏。
4. 验证 `getupdates` 的超时、游标推进、空轮询、批量消息、重放和 Token 失效语义。
5. 验证 `message_id` 的实际 JSON 表示和精度，不能默认 JavaScript `number` 安全。
6. 验证回复是否必须原样携带当前 `context_token`，以及重启后 Token 的有效期。
7. 验证文本长度、Unicode、Markdown、引用消息、错误码、限流、代理和 `NO_PROXY`。
8. 确认停止长轮询时可以通过 `AbortSignal` 有限退出，不遗留后台任务。
9. 完成 Bot Token 独立命名空间、严格载荷、原子写入、撤销和回滚设计，证明不需要迁移飞书凭据。

完成标准：形成脱敏合同 Fixture 和最小假客户端测试；明确游标提交时机、凭据撤销方式和阶段 1
所需依赖，并取得新增微信凭据格式的明确批准。任一关键语义不明确时停在阶段 0，不通过反复试改
生产代码推断协议。

### 阶段 1：单账号私聊文本

1. 在统一 `codexc setup` 中增加微信扫码入口；二维码仍只显示在当前终端。
2. 把非敏感启用状态、账号 ID 和允许 Actor 写入严格 TOML；按照阶段 0 已批准的独立格式把
   Bot Token 写入微信安全凭据 Store。
3. 实现可取消的单账号长轮询、有限重试、退避和致命故障上报。
4. 对事件做严格裁剪，过滤 Bot 消息、空消息、过旧消息、重复消息和未授权 Actor。
5. 普通文本经授权后提交给 Application；最终回复以微信安全纯文本发送。
6. 文本按阶段 0 验证后的限制进行有界分片；首版使用块式最终回复，不伪装原生流式编辑。
7. 输出进入共享 Conversation 队列；过载时仍保护错误与 Turn 完成等关键事件。
8. 提供立即失败关闭的 `InteractionPort`，审批、用户输入和 MCP elicitation 不得悬挂。
9. Adapter 启动失败由 Bootstrap 回滚；重复停止安全，Gateway 停止不终止共享 App Server。

阶段 1 不实现媒体、群聊、多账号、主动推送、交互按钮或微信专属会话状态。

### 阶段 2：共享命令与运行观测

- 接入共享命令目录、解析和 `ConversationCommandService`，不重新实现 Thread、模型、Fast、
  Workspace、Goal、用量或额度逻辑。
- 微信没有斜杠命令提示时，提供简短文本帮助和常用命令列表；命令本身仍使用统一规范名称。
- 增加账号、长轮询、最近收发和凭据可用性的 Doctor 观测，不显示 Token、游标或原始响应。
- 只接入当前 Gateway 进程内、已有有效 `context_token` 的 Turn 状态通知，并且只向仍在允许名单
  中的 Actor 发送。启动和配置主动通知延后到阶段 4，不在本阶段隐式持久化回复上下文。
- 未知或畸形命令明确拒绝，不作为普通文本提交给 Codex。

### 阶段 3：审批能力门槛

当前官方协议没有提供经过确认的按钮、表单或动作回调。开始本阶段前必须重新查询官方资料：

- 如果存在可绑定消息、账号、Actor、请求 ID 且一次性消费的官方交互控件，则实现五类共享
  `InteractionRequest`，并复用 Approval 的统一决定语义。
- 如果仍只有普通文本和引用消息，则保持失败关闭。不得用“回复 1”“回复同意”或宽松文本解析
  模拟高权限审批。
- 一次、会话、命令规则和网络规则只能在请求明确提供时显示并原样返回；未知、重复、过期和
  跨账号动作必须拒绝。

缺少安全交互不会阻止阶段 1、2 的只读和免审批路径，但必须在公开说明中明确限制。

### 阶段 4：媒体与多账号

每项单独实施，不合并成一次大改：

1. 图片输入与输出：内容签名、大小上限、AES-128-ECB CDN 合同、私有临时文件和过期清理。
2. 一般文件：文件名、MIME、大小、下载来源和上传失败语义。
3. 输入状态：只有官方 `getconfig` 与 `sendtyping` 合同稳定后启用。
4. 多账号：每个 Bot 独立凭据、游标、允许名单、长轮询、输出队列和 `surface + accountId`
   生命周期；不能依靠收件人猜测发送账号。
5. 主动推送：先完成加密 `context_token` 保存、过期、账号隔离与撤销评审，再接入启动或配置
   通知。

群聊只有在官方渠道明确声明支持、身份合同可验证且 Access Policy 能正确区分群与 Actor 后另立
切片，不属于本计划当前完成标准。

## 验证

离线测试至少覆盖：

- 二维码会话成功、取消、过期、重定向、重复登录和敏感字段清洗。
- 微信凭据命名空间与飞书隔离；覆盖首次写入、原子替换、写入/关闭竞态、撤销、未知版本、身份
  不匹配、密文损坏、Keychain 失败、Linux 权限以及失败后保留上一份有效记录。
- 长轮询空响应、批量响应、游标重放、重复消息、精度异常、限流、Token 失效和中止。
- 账号、Conversation、Actor 和允许名单严格匹配；跨账号不能串消息。
- 普通文本、共享命令、长文本分片、平台错误和未知内部异常。
- 同 Conversation 顺序、不同 Conversation 并行、队列过载、发送超时和有限关闭。
- 未实现交互时三类请求立即安全拒绝或取消。
- 配置热加载、账号撤权、Gateway 重启和共享 App Server 不被终止。
- 日志与平台消息不包含 Bot Token、`context_token`、二维码、游标、Authorization 或原始响应。

真实验收按阶段执行：

1. 扫码登录并只保存目标账号。
2. 已授权私聊文本产生一个 Codex Turn 并返回正确会话。
3. 未授权用户、重复事件和 Gateway 重启不产生额外 Turn。
4. `/status`、Workspace 与会话切换继续使用共享服务。
5. 停止或重启微信 Surface 不影响 Telegram、飞书、原生 CLI 和共享 App Server。

## 停止条件

出现以下任一情况时停止当前阶段并重新评审：

- 官方协议、API 使用约束或服务条款不支持 Codex Connect 作为独立客户端直接接入微信后端。
- 登录、Token 撤销、游标确认或消息身份无法形成稳定合同。
- 必须运行 OpenClaw Gateway 才能获得受支持连接。
- 需要把消息正文、完整事件或明文凭据持久化才能工作。
- 安全保存微信凭据必须迁移、重写或共用现有飞书凭据记录。
- 需要修改 Codex App Server 协议、SQLite 会话 Schema 或其他 Surface 的平台实现。
- 平台没有安全交互能力却要求放宽审批规则。

## 完成判定

当前计划完成不等于微信功能已经支持。只有源码、严格配置、Setup/Doctor、模块索引、离线测试和
真实微信验收全部完成后，README 才能声明微信私聊可用。每个阶段保持独立、可审查和可回退；
未经明确要求不提交、推送、发布或重建服务。
