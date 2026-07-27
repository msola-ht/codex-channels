# 微信 Surface 接入计划

## 状态与目标

状态：阶段 0 第一步“固定官方基线与源码入口”已于 2026-07-27 完成；第二步二维码合同已完成
离线探针、正常扫码和过期刷新实测，重定向、配对码及重复绑定状态仍只有离线合同覆盖。尚未注册
微信消息 Surface 或新增依赖；独立安全凭据 Store、统一 Setup 的禁用态连接配置、窄协议 Client、
版本 1 游标检查点、私聊文本输入 Adapter、内存回复上下文、纯文本 Outbox 与失败关闭交互端口
已实现；目录内部完整 `SurfaceAdapter` 已完成，尚未从一级 Surface 入口公开或注册 Bootstrap。

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
2026-07-27 已通过官方远端完整标签列表复核，`v2.4.6` 仍是最新标签；官方 `main` 的包版本同为
`2.4.6`，但实现和实验仍只使用上述固定标签与提交，不能把变化中的 `main` 当作稳定合同。

| 查询目标 | 固定资料 | 当前事实 |
| --- | --- | --- |
| 安装、登录与后端协议 | [`README.zh_CN.md`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/README.zh_CN.md) | 扫码登录；HTTP JSON API；`getupdates` 长轮询；文本、图片、视频和文件发送 |
| 包与宿主要求 | [`package.json`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/package.json) | Node.js 22+；官方插件声明 OpenClaw `>=2026.5.12` Peer 依赖并依赖 Plugin SDK |
| 渠道能力 | [`channel.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/channel.ts) | 当前声明只支持私聊、媒体和块式回复，不声明群聊或交互卡片；宿主侧文本分片值为 4000 |
| 扫码合同 | [`login-qr.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/auth/login-qr.ts) | 固定二维码主机、Bot Type `3`、5 分钟会话、35 秒状态长轮询、配对码、过期刷新、IDC 重定向、重复绑定、Bot Token、Bot ID、扫码者 ID 和业务 Base URL |
| HTTP API | [`api.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/api/api.ts)、[`types.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/api/types.ts) | Bearer Token、随机 `X-WECHAT-UIN`、iLink App/版本 Header、`base_info`、长轮询、发送、输入状态、启动/停止通知和错误响应 |
| 消息循环 | [`monitor.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/monitor/monitor.ts) | 按账号维护游标、有限重试、退避和可取消长轮询；官方实现先持久化响应游标，再逐条处理该批消息 |
| 身份与回复上下文 | [`inbound.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/messaging/inbound.ts)、[`send.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/messaging/send.ts) | `from_user_id`、数值 `message_id`、`context_token` 和块式文本发送；官方实现缺少上下文令牌时仍尝试发送 |
| 账号、回复上下文与游标存储 | [`accounts.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/auth/accounts.ts)、[`inbound.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/messaging/inbound.ts)、[`sync-buf.ts`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/src/storage/sync-buf.ts) | 官方插件把账号 Token、账号索引、每用户 `context_token` 和 `get_updates_buf` 保存为本地 JSON；这是参考行为，不是本项目可复用的安全存储设计 |
| 许可证 | [`LICENSE`](https://github.com/Tencent/openclaw-weixin/blob/v2.4.6/LICENSE) | MIT |

官方 README 对 OpenClaw 宿主兼容范围的概述比 `v2.4.6` 包元数据更宽；这只影响官方插件作为
OpenClaw 扩展运行。Codex Connect 不采用该宿主合同，阶段 0 只把固定标签中的微信 HTTP 协议和
行为作为待验证参考。

### 2026-07-27 基线复核结论

阶段 0 第一步只固定可审查事实，不代表已获得生产接入授权：

- 官方中文 README 公开了 `getupdates`、`sendmessage`、`getuploadurl`、`getconfig` 和
  `sendtyping` 的 HTTP JSON 结构，固定源码还实现了二维码、启动通知和停止通知端点。
- 二维码端点、完整 Header、扫码状态枚举、重定向与配对码主要来自固定源码，而不是 README
  的公开后端端点表；后续实验必须把“源码行为”和“公开协议承诺”分开记录。
- MIT 许可证允许使用和修改仓库代码，但不单独证明第三方客户端可以使用腾讯线上微信后端。
  在执行真实扫码或 API 实验前，仍须确认服务条款和独立客户端接入边界；无法确认时按停止条件
  结束当前阶段。
- 官方类型把 `message_id` 表示为 JavaScript `number`，但没有证明真实值始终处于安全整数范围；
  合同 Fixture 必须保留原始 JSON 并验证精度，业务实现不能先按 `number` 固化。
- 官方消息循环在处理批次前保存新 `get_updates_buf`。本项目不能直接照搬：阶段 0 必须验证服务端
  重放和确认语义，再决定持久化时机，避免处理失败后静默丢消息或重启后大量重复。
- 官方插件会把 Bot Token、`context_token` 和游标保存为普通 JSON，并在缺少
  `context_token` 时继续尝试发送。本项目明确不复制这些行为：敏感凭据必须进入独立安全后端，
  回复上下文默认只存在内存，缺少必需令牌时失败关闭。
- 固定标签的最小协议审查入口为 `src/auth/login-qr.ts`、`src/api/api.ts`、
  `src/api/types.ts`、`src/monitor/monitor.ts`、`src/messaging/inbound.ts`、
  `src/messaging/send.ts`、`src/auth/accounts.ts` 与 `src/storage/sync-buf.ts`；OpenClaw 的
  Channel、路由和会话实现不进入本项目协议 Adapter。

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
  已确认服务端重放语义并取得明确批准：以严格版本 1 私有原子文件保存在 Gateway 数据目录，
  不进入 SQLite、TOML 或凭据 Store。
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

1. 已完成（2026-07-27）：固定官方标签、提交和采用的源码入口，并记录源码行为与公开协议承诺
   的差异。
2. 进行中：二维码创建、扫描、确认和过期刷新已完成真实验证；重定向、配对码和重复绑定状态
   已完成离线合同验证，尚无可控的真实触发条件。
3. 记录登录成功返回的账号 ID、Actor ID、Bot Token 与 Base URL 的稳定形状，但所有 Fixture
   必须脱敏。
4. 进行中：`getupdates` 的固定请求、超时、取消、错误和脱敏响应裁剪已完成离线合同测试；
   游标推进和旧游标重放已完成真实验证，空轮询、批量消息和 Token 失效仍待真实验证。
5. 验证 `message_id` 的实际 JSON 表示和精度，不能默认 JavaScript `number` 安全。
6. 进行中：固定 `sendmessage` 请求和携带当前 `context_token` 的短文本回复已完成离线合同
   测试与真实验证；同一上下文双消息模式也已完成真实复用验证，缺失或过期上下文以及重启后
   Token 有效期仍待验证。
7. 进行中：固定 Unicode、emoji 和 Markdown 符号文本已完成真实呈现验证；官方宿主 4000 字符
   分片值已完成单次中文消息真实送达验证，引用消息、错误码、限流、代理和 `NO_PROXY`
   仍待验证。
8. 确认停止长轮询时可以通过 `AbortSignal` 有限退出，不遗留后台任务。
9. 完成 Bot Token 独立命名空间、严格载荷、原子写入、撤销和回滚设计，证明不需要迁移飞书凭据。

完成标准：形成脱敏合同 Fixture 和最小假客户端测试；明确游标提交时机、凭据撤销方式和阶段 1
所需依赖，并取得新增微信凭据格式的明确批准。任一关键语义不明确时停在阶段 0，不通过反复试改
生产代码推断协议。

2026-07-27 已增加隔离的 `scripts/weixin-qr-contract-probe.mjs` 和
`tests/weixin-qr-contract-probe.test.ts`：固定 `v2.4.6` 的二维码创建与状态请求、严格响应裁剪、
请求超时与外部取消区分、8 分钟整体上限、配对码、有限刷新和仅允许 `weixin.qq.com` 官方域名的
重定向。脚本默认只显示帮助，只有人工传入 `qr --live` 才访问固定端点；确认结果中的 Bot Token
只保存在当前进程内存，不写配置、凭据文件、SQLite、日志或 Fixture。真实扫码只记录下述脱敏
形状，不保留真实标识或凭据。

2026-07-27 的真实扫码验证得到以下脱敏结果：

- 正常二维码和过期后自动刷新的新二维码均可完成扫码确认并返回凭据。
- 账号 ID 的稳定形状为不透明主体加 `@im.bot`，扫码者 ID 为不透明主体加 `@im.wechat`；
  业务 Base URL 返回固定二维码主机。文档、日志和 Fixture 不记录真实主体或 Bot Token。
- 使用刷新后的新二维码连接时，微信客户端明确提示新连接会删除旧连接。这证明重新扫码具有替换
  既有连接的外部副作用，但尚不能据此断言所有账号始终只允许一个连接。
- 阶段 0 探针因此在联网前再次要求人工输入“继续”，明确提醒可能替换旧连接；取消时不得请求
  二维码。正式设置流程也必须二次确认，并在安全凭据写入成功后才原子替换本地旧凭据。
- 真实验证产生的 Bot Token 未保存，当前不能用于消息长轮询；进入该实验前必须先完成并批准
  独立安全凭据后端设计。

同日开始实现已批准的凭据格式与统一 Setup：共享机制仅抽取 Keychain 调用、AES-256-GCM、私有
权限和原子文件替换；飞书既有 Service、目录、键和载荷保持不变。微信使用独立 Service 与
`credentials/weixin`，版本 1 载荷只包含账号 ID、Bot Token、业务 Base URL 和授权时间。
Setup 写入 `enabled = false` 的严格非敏感元数据并明确提示消息 Surface 尚未实现；正式运行时
启用仍属于下一批。

真实 Setup 已完成风险确认、扫码、凭据加密写入和非敏感配置保存；随后 `codexc doctor` 成功从
独立后端读取并严格校验凭据，且全程未显示 Bot Token。实际账号与扫码者标识只保存在用户配置和
加密凭据所需位置，不进入本文、日志或测试 Fixture。

`scripts/weixin-updates-contract-probe.mjs` 已固定 `v2.4.6` 的 `getupdates` 请求合同，从安全
凭据读取连接并只允许显式 `once --live` 执行一次长轮询。它在 JSON 解析前检查
`message_id` 的原始数字词法，输出只包含消息数量、字段形状、项目类型、上下文令牌存在性和安全
整数结论；消息正文、完整身份、Token、上下文令牌、游标和原始响应均不输出或持久化。探针不保存
返回游标，因此重复运行可能收到重放消息，不能据此决定生产游标提交时机。

真实单次长轮询已收到一条完成态用户文本消息：响应包含下一游标和非空 `context_token`；
`message_id` 的原始十进制表示为 19 位，超出 JavaScript 安全整数范围。后续 Adapter 必须在
JSON 数字转换前保留原始 ID，并以十进制字符串进入去重与路由，不能使用已失真的 `number`。
探针新增 `sequence --live` 双轮模式，只在进程内把首轮游标传给第二轮，并只报告游标是否推进及
第二轮与首轮重复的消息数量。真实双轮测试确认游标会推进，第二轮收到的新消息没有与首轮重放；
新增 `replay --live` 三轮模式会再次使用首轮游标，验证第二批消息是否重放。第三轮不要求发送
新消息，并且只报告重放数量、等待超时以及返回游标关系，不输出任何游标或消息标识。

真实三轮测试确认：再次使用首轮游标会完整重放第二批消息，因此 `getupdates` 具备可由客户端游标
触发的至少一次投递语义；但重放响应返回的游标与第二轮游标不相等，游标值不能作为批次身份或消息
去重键。阶段 1 必须先按原始十进制 `message_id` 幂等处理并完成该批消息，再原子保存该次响应
返回的游标；处理失败时保留旧游标以允许重放。

`scripts/weixin-send-contract-probe.mjs` 新增隔离的 `reply --live` 短文本回复实验：它复用
`getupdates` 的严格裁剪，只从当前批次中选择已授权 Actor 的完成态用户文本，把回复目标和
`context_token` 留在进程内，并按固定 `v2.4.6` 合同发送一条固定短文本。脚本不接受命令行
Token、用户 ID 或任意回复正文，不输出或保存消息、游标、回复上下文、`client_id` 或完整身份；
未找到合格上下文时在发送前失败关闭。该探针已完成当前上下文的真实短文本回复验证，但不代表
运行时 Surface 已启用。

真实短文本回复已成功送达微信客户端，证明当前入站消息的 `context_token` 可原样用于
`sendmessage` 回复。成功响应正文为不含 `ret` 的空对象，固定源码把缺失返回码视为成功的行为
与真实服务一致；实现不能要求成功响应必须显式包含 `ret: 0`。该结果只证明当前上下文的即时回复，
不证明缺失、过期或进程重启后的上下文仍然有效。

发送探针新增 `sequence --live`：从一条合格入站消息取得一次回复上下文，顺序发送两条固定短文本，
第二条包含中文、emoji 和 Markdown 符号；每条使用独立随机 `client_id`，首条 API 错误时停止，
不把失败扩大为后续发送。该模式只用于验证同一 `context_token` 是否可连续回复及客户端如何呈现
固定字符，不探测或声明文本长度上限，也不接受操作者提供任意消息内容。

真实双消息测试确认：同一个当前 `context_token` 可连续完成两次 `sendmessage`，两条消息按请求
顺序到达微信客户端，且两次成功响应均为不含 `ret` 的空对象。中文和 emoji 正常显示；
`**粗体**` 被渲染为粗体，反引号包裹的内容被渲染为行内代码，说明文本项会解释这两种 Markdown
语法。阶段 1 输出必须中和非预期平台格式，不能把任意上游文本未经处理直接当作微信纯文本。

固定版 `channel.ts` 把宿主侧 `textChunkLimit` 设置为 4000，但没有说明计量单位，也没有证明这是
服务端最大值。发送探针新增 `limit --live`，只发送一条恰好 4000 个 JavaScript 字符的固定中文
消息，UTF-8 字节数大于 4000，并用明确首尾标记验证完整送达。该实验只用于证明 4000 是多字节
文本的安全分片值，不发送 4001 字符或批量超长消息，不尝试撞击未知服务端上限。

真实长度测试确认：恰好 4000 个 JavaScript 字符的固定中文消息被服务端接受，并在微信客户端
以一个气泡完整显示，末尾标记可见，没有发生截断。阶段 1 可以采用 4000 个 UTF-16 码元作为
保守文本分片上限；该结论不证明 4001 字符会失败，也不声明服务端最大长度。

经明确批准后，`src/surfaces/weixin/updates-cursor-store.ts` 实现独立版本 1 游标检查点：
`data/weixin-updates` 目录权限为 `0700`，每个账号使用 SHA-256 文件名，严格载荷只包含版本、
账号 ID 和游标，文件权限为 `0600` 并通过临时文件原子替换。缺失记录表示首次拉取；损坏、未知
版本、账号不匹配和符号链接失败关闭。回滚时删除该目录即可，不影响凭据、配置、SQLite 或其他
Surface。

`src/surfaces/weixin/protocol-client.ts` 把已验证的 `getupdates/sendmessage` 合同移入微信
模块：保留原始十进制 `message_id`，按账号方向把消息裁剪为文本或稳定忽略原因，限制响应体、
超时和取消，并把 HTTP/API 错误约束为不含上游正文的稳定错误。出站文本限定为已验证的 4000 个
UTF-16 码元。

`src/surfaces/weixin/updates-monitor.ts` 在模块内部组合 Client 与游标 Store，但不自行拥有
后台任务：逐条顺序投递文本，按原始消息 ID 做有界进程内去重，仅在整批处理成功后原子提交响应
游标；处理失败保留旧游标以允许重放。网络、限流和服务端瞬时错误只做有限重试，协议/API 错误
失败关闭，长轮询超时视为正常空轮询，取消立即退出。该监控器仍未注册为消息 Surface，也未调用
Application；其生命周期和消息处理由输入 Adapter 组合。

`src/surfaces/weixin/input-adapter.ts` 已实现上述输入侧所有权：按固定账号构造微信私聊目标，
调用 `SurfaceAccessPolicy` 后记录 Actor 并提交普通文本给 `ConversationService`；未授权消息
不进入 Application，并删除该私聊的旧回复上下文，但仍允许整批推进游标。授权消息把最新
`actorId + context_token` 更新到有界内存 Store 后再提交；接收或消息处理失败不推进游标，只向
生命周期所有者报告稳定错误码；重复停止安全，取消后有限等待。

`src/surfaces/weixin/reply-context-store.ts` 与 `outbox.ts` 实现首个安全输出边界：上下文按账号
与私聊隔离且不持久化，真正发送时再次调用 `SurfaceAccessPolicy`，撤权后删除上下文并拒绝发送。
Outbox 只接收匹配 `surface + accountId` 的最终文本、必要结束状态、连接错误和警告，通过共享
Conversation 队列投递；每个气泡最多 4000 个 UTF-16 码元、最多五个气泡，截断时显示提示且不
拆开代理对。关闭队列后清空全部回复上下文。`interactions.ts` 直接复用统一安全决定，三类请求
立即拒绝或取消，不显示文本审批。

`src/surfaces/weixin/surface.ts` 已把上述组件组合为正式 `SurfaceAdapter`：Input 与 Outbox
共享同一个回复上下文 Store；启动只开启输入监控，停止先取消输入，随后取消交互并排空输出，
最后由 Outbox 清空全部上下文；重复停止等待同一个关闭任务。接收致命错误只向生命周期所有者
报告稳定分类。由于当前不持久化回复上下文，也没有安全主动收件人，持久配置通知明确失败关闭，
不尝试向未知用户推送。

该类型仍只由微信目录入口导出。下一批必须先实现微信 Access Policy 和 Bootstrap 组合工厂，
从安全凭据 Store 读取精确账号连接，再经一级 Surface 入口受控导出并加入内置插件注册表。

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
