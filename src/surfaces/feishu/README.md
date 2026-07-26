# 飞书 Surface

本目录是飞书 Surface 的平台边界。当前已完成 Phase 0 的官方 SDK、事件长连接和消息字段裁剪基础，
以及 Phase 1 的私聊文本 Inbox、输出渲染和 Bootstrap 显式组合；Phase 2 的预备实现已
接入全部平台无关私聊命令，但 Phase 1 真实验收尚未整体关闭，群聊不得开始。当前可通过严格
TOML 或统一 Setup 启用开发验证路径。Phase 4 已完成三个独立体验切片：最终回复与命令结果
使用 `post + md` 富文本，私聊 PNG/JPEG 图片复用 Application 的本地图片输入，同一 Thread 的
运行中与空闲状态已实现合并到一条可更新消息并通过离线测试。Phase 3 已完成
私聊审批卡片的离线主路径，命令审批的一次批准及当前 Gateway 长连接动作接收已通过真实验收；
私聊 PNG/JPEG 真实消息也已通过。群聊和一般文件未实现。Phase 3 的用户输入与 MCP form/URL
elicitation 已完成离线实现，继续等待真实卡片动作验收。

## 文件索引

- `index.ts`：飞书模块受控出口；一级 `surfaces/index.ts` 只转出 Bootstrap 所需工厂和选项类型。
- `adapter.ts`：区分普通文本、平台本地命令和 Application 命令，并通过 Outbox 返回结果或安全错误。
- `approval-card.ts`：生成有界审批卡片和移除动作后的处理结果卡片。
- `card-action.ts`：严格裁剪 `card.action.trigger` 的路由字段和受限字符串动作值。
- `client.ts`：官方 SDK、事件长连接及生命周期隔离。
- `message-content.ts`：生成飞书 `post + md` 内容，供发送和实际序列化大小计量共用。
- `message-event.ts`：SDK 消息事件的严格验证和稳定字段裁剪。
- `inbox.ts`：私聊文本筛选、授权、同步有界入队、去重和按 Chat 顺序处理。
- `input-card.ts`：生成有界用户输入表单、MCP JSON 表单、HTTP(S) URL 确认和处理结果卡片。
- `interactions.ts`：维护私聊审批、用户输入和 MCP elicitation 的一次性令牌、Actor 绑定、
  请求去重、过期、取消和跨客户端失效。
- `media.ts`：通过官方消息资源 API 下载私聊图片，并调用 Surface 共用暂存器完成大小、签名、
  权限和过期清理。
- `permissions.ts`：渲染当前进程权限观测、Gateway 已用能力清单及已有应用的精确申请入口。
- `oauth-device-flow.ts`：严格裁剪应用用户 Scope、Device Authorization、有限轮询和授权身份查询。
- `oauth-card.ts`：把 Device Flow 映射为飞书内嵌授权卡片及稳定结果卡片。
- `oauth-token-store.ts`：macOS Keychain 与 Linux AES-256-GCM 私有凭据后端。
- `oauth.ts`：按 App 与 Actor 协调单一进行中授权、身份匹配、凭据写入、撤销和停止取消。
- `renderer.ts`：把平台无关 `ConversationCommandResult`、`OutputEvent` 和结构化错误映射为稳定文本内容。
- `outbox.ts`：精确账号路由并通过通用有界队列调用窄消息发送端口。
- `surface.ts`：组合单账号连接、Inbox、Application Adapter、Outbox 和失败关闭交互端口，并由
  模块入口只暴露 `createFeishuSurface()` 工厂与生产选项类型。

## 当前边界

`client.ts` 隔离 `@larksuiteoapi/node-sdk`：

- `start()` 只有在 SDK 触发 `onReady` 后才成功，不能把 `WSClient.start()` 返回当作握手完成。
- 首次连接设置有限超时；失败和超时只暴露稳定、脱敏的本地错误。
- 重连状态留在平台边界；停止操作幂等，并能终止尚未完成的启动。
- SDK 原始日志不进入项目 Logger，避免平台凭据、URL 或响应正文泄漏。
- Surface 只向项目 Logger 记录连接中、就绪、重连、恢复和停止等稳定状态，不附带 SDK 错误正文。
- 消息路径只注册 `im.message.receive_v1`，回调必须同步完成最小入队，不能在 SDK Reader 中等待业务或平台网络请求。
- 已注册 `card.action.trigger` 的独立分流并严格裁剪动作；真实命令审批的一次批准已确认当前
  Gateway 长连接可以收到动作。动作必须匹配一次性令牌、Chat、消息、授权 Actor 和当前请求提供的
  精确选项或表单字段，否则拒绝处理。表单回调只额外保留官方 `action.form_value` 中最多四个、
  每项最多 1,000 字符的字符串字段。
- 消息发送只使用 `im.v1.message.create` 的 `chat_id + text/post/interactive` 窄能力；富文本只生成单个
  `md` 元素，不暴露 SDK Client。模型或上游文本中的飞书原生 `<at>` 标签会在平台边界被中和，
  避免非预期提醒。审批结束和 Thread 状态更新使用 `im.v1.message.patch`；调用设置 15 秒 HTTP
  超时，创建响应必须包含 `message_id`。
- 发送超时、SDK 失败和残缺响应只暴露稳定错误码，不回传 SDK message、响应正文或凭据。
- 消息创建不自动重试；锁定 SDK 虽提供可选 `uuid` 字段，但当前官方资料未明确其幂等窗口和
  可重试错误语义。
- 图片下载只使用 `im.v1.messageResource.get` 的 `message_id + image_key + type=image` 窄能力；
  SDK 响应被裁剪为下载流和可选长度，不向其他模块暴露 Client、Header 或上游错误。

`message-event.ts` 在平台边界把 SDK 原始事件裁剪为稳定的 `FeishuMessageEvent`，只保留账号、
Actor、消息和 Conversation 路由后续需要的字段。缺少 `open_id`、消息标识或 Chat 标识时失败关闭；
原始事件和无关 SDK 字段不会进入其他模块或错误对象。

`inbox.ts` 只接受当前账号的已授权用户私聊文本和图片。SDK 回调只做同步校验、图片 Key 裁剪
和入队，不执行资源下载；同一 Chat
按顺序处理，不同 Chat 可以并行。永久无效、未授权、重复或过旧事件被明确忽略；全局输入容量
耗尽时返回 `retry/overloaded`。由于当前没有经过真实合同验证的 SDK 重试响应通道，Surface
通过同一有界 Outbox 提示用户稍后重试，不伪造平台自动重投；同一 Chat 在一个连续过载周期内
最多排入一条提示，下一条消息成功接收后才允许再次提示。去重状态只存在于有界内存，关闭时等待
已接受任务至有限超时，不持久化消息正文。

`media.ts` 只在已授权消息进入 Conversation Worker 后下载图片。平台资源 Key 不作为本机路径，
下载流经 Surface 共用 `ManagedImageStore` 限制为 10 MiB，并按内容签名只接受 PNG/JPEG；
目录权限为 `0700`、文件权限为 `0600`，过期文件定期清理。下载或文件异常只返回稳定脱敏错误。

`renderer.ts` 通过模块公开入口接收 `OutputEvent`。最终文本由 Outbox 作为富文本发送，其他
关键事件和安全提示使用纯文本；
非关键流式增量和运行中操作暂不输出。上游 warning、连接错误和 MCP 错误正文不会进入平台消息，
未知 Thread 状态不会原样显示。

`outbox.ts` 只同步接收匹配 `feishu + accountId` 的输出，并按 Chat ID 进入
`ConversationDeliveryQueue`。同一 Chat 串行、不同 Chat 可并行；关闭后拒绝新输出并有限等待
已接收发送。飞书 SDK 发送对象由 `FeishuMessageClient` 通过 `FeishuMessagePort`
注入，Outbox 不持有完整 SDK Client。Adapter 的追加确认和错误提示也进入同一有界队列，不绕过
平台输出顺序和关闭边界。纯文本按 UTF-8 字节、富文本按序列化后的 `post` 内容计量；超过项目
内部 20,000 字节上限时，在同一个队列任务内按 Unicode 字符安全分片并顺序发送。每个逻辑结果
最多发送 5 条，超出时明确标记截断，避免单个结果无限占用同一 Chat 的发送任务。消息创建失败
不自动改发另一种格式，避免非幂等重发产生重复消息；卡片创建和更新进入相同 Chat 顺序边界，
均不自动重试。同一 Thread 的 `active` 状态消息 ID 只保存在 Outbox 内存，并在 `idle` 到达时
按同一 Chat 顺序更新；重复 `active` 被忽略，更新失败会清理旧绑定且不阻塞后续输出。真实长回复
已确认由飞书客户端折叠显示且消息顺序正确；状态更新仍待真实验收，通用消息更新和文件回退
尚未实现。

`adapter.ts` 对普通文本调用 `ConversationService.submit()`，图片则先通过 `media.ts` 取得受管
绝对路径，再调用同一 `submit()` 的 `localImages` 输入；对已知平台无关命令调用
`ConversationCommandService.execute()`；`/start`、`/help`、`/whoami`、`/cancel` 和
`/feishu <status|doctor|authorize|revoke>` 留在飞书边界。`status` 展示当前进程实际观测到的
连接、消息事件、卡片回调和当前 Actor OAuth 状态，`doctor` 合并必要能力诊断和应用配置入口。
`authorize` 读取应用已开通的用户级 Scope，并先比较安全凭据后端中的有效 Token：全部覆盖时
不重复授权，部分缺失时只用缺失 Scope 发起 Device Flow；没有有效 Token 时申请应用当前开放的
用户级 Scope。卡片明确加入并展示 `offline_access`；授权地址只接受
`https://accounts.feishu.cn` 精确 Origin 的完整 URL，外部响应的 Scope、时间和长度均有界。
原始应用权限条目先按独立安全上限裁剪，再筛选并限制为最多 100 项用户 Scope；授权与凭据载荷
为其保留额外一项 `offline_access`。完成后校验返回 Token 所属 `open_id` 必须与消息 Actor
一致；`status` 会优先显示当前 Actor 正在进行的授权。未知或畸形斜杠命令失败关闭，
不能作为普通消息提交给 Codex。新 Turn 不额外发送确认，
后续回复由 Core 输出驱动；追加到活动 Turn 时发送明确提示。结构化 `UserFacingError` 按错误码
渲染，不使用其内部 fallback message；未知异常只发送通用提示，然后把原异常交回 Inbox，由
Inbox 现有诊断路径仅记录受约束的错误类型。命令结果、追加确认和错误提示被输出队列拒绝时，
Adapter 不会重试已经执行的状态修改，而是把稳定的队列错误交回同一诊断路径。会话列表最多展示
20 条，名称或预览会规范空白并限制为 48 个字符，剩余项通过搜索提示收敛。

用户 OAuth Token 不进入 Application、Core、配置或会话 SQLite。macOS 使用系统 Keychain；
Linux 在 Bootstrap 从状态数据库父目录注入的 `credentials/feishu` 下保存独立主密钥和
AES-256-GCM 密文，目录为 `0700`、文件为 `0600`。`revoke` 先取消当前 Actor 的进行中轮询再删除
本地凭据，Surface 停止会取消授权任务并最多等待 5 秒；停止或存储错误与 Token 写入竞态时尝试
恢复原凭据，失败只记录脱敏警告。Linux 后端在原子替换前完成权限设置；Keychain 命令同样有
5 秒上限并使用原地更新，读取两种后端时均严格校验凭据载荷。飞书 HTTP
API、OAuth 与 WebSocket 由 Bootstrap 注入统一 HTTP/HTTPS 代理并按目标域名遵循 `NO_PROXY`；
HTTP 直连会显式关闭 SDK 底层的环境代理再解析，避免覆盖 Bootstrap 决策。仅 SOCKS
`ALL_PROXY` 尚不支持；目标未命中 `NO_PROXY` 时，无效或不支持的代理会失败关闭而非直连。
当前仅完成授权基础设施，飞书 CLI API 调用与 Token 自动刷新尚未实现。

`interactions.ts` 只为当前 Conversation 已恢复且恰有一个仍获授权 Actor 的交互请求创建卡片。
不可预测令牌只存于内存并绑定请求、Chat、消息和 Actor；审批点击只能映射请求原本提供的一次、
会话、命令前缀或精确网络规则，重复、畸形、越权、过期和关闭后的动作均不会升级权限。用户输入
最多接受三个问题，固定选项不接受列表外值，秘密问题使用飞书密码输入框；答案按原始问题 ID
返回且不会显示在处理结果卡。MCP form 只接受单个最长 1,000 字符的有效 JSON，URL 模式只渲染
HTTP(S) 链接。其他客户端解决、取消、超时和 Surface 停止会按请求类型返回空答案或取消，并移除
卡片动作。同一 App Server 请求 ID 的并发重复只保留首个交互；Surface 停止即使遇到未返回的
卡片创建也会先结束协议请求，卡片结果更新失败不会改变已经作出的协议决定。所有表单值只存在于
待处理内存和协议响应中，不写入数据库或日志。

`surface.ts` 实现单账号 `SurfaceAdapter` 生命周期：启动等待长连接就绪；停止先切断新事件，再
有限排空 Inbox 和 Outbox。Bootstrap 从现有绑定中选择仍有授权 Actor 的 Chat 作为配置通知
收件人；持久通知等待平台实际发送完成，没有已知安全会话时不广播。

本模块已有严格 TOML/运行配置、变更分类和 Bootstrap 显式组合，可启用阶段 1 私聊文本路径；
Setup 与只读 Doctor 凭据/Bot 身份探测已完成，真实应用的首次握手、已授权私聊 Turn 和文本回复
已通过；2026-07-26 操作者在 Gateway 重启后确认私聊命令能够返回纯文本结果；随后本地实现已
切换最终回复和命令结果为富文本，并已用状态命令与普通 Turn 短回复验证标题、列表、加粗、
行内代码和链接的真实显示。用户 OAuth Device Flow、Actor 身份校验和安全凭据写入也已通过
真实应用验证；Gateway 重启后的 Token 恢复和精确 Thread 绑定也已通过验收。私聊 PNG/JPEG、
命令审批一次批准，以及长回复在客户端折叠显示且顺序正确也已完成真实验收。断线恢复、代理、
未授权/重复事件、用户输入与 MCP 卡片动作仍未完成真实验收。后续阶段按
[`飞书 Surface 接入计划`](../../../docs/feishu-surface-plan.md)推进；一级 `surfaces` 入口只转出
窄工厂，不得导出 SDK 类型，也不得在 Core 中引入飞书类型。Phase 1 真实验收关闭前，Phase 2
命令只视为预备实现。群聊已记录为后续需求但当前不开发，也不更新为公开支持。
