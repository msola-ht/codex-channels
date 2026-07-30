# Codex Connect Gateway

通过 Telegram、飞书和微信私聊连接本机 Codex App Server。各通讯渠道与原生 Codex TUI 使用
同一个 App Server，共享 Thread、运行状态和历史；项目不读取 `~/.codex/sessions`，也不复制完整会话。

当前版本要求 `codex-cli 0.145.0`，npm 包与 Gateway 直接使用同一版本号 `0.145.0`，不维护独立版本；版本不匹配时 Gateway 会拒绝启动。

渠道只运输和呈现项目已经接入的 Codex CLI/App Server 能力；当前能力范围以
[`docs/index.md`](docs/index.md) 的支持矩阵为准。平台 SDK 自身具备某项功能，或生成协议中
出现某个类型，不代表 Gateway 已支持该能力。Setup、Doctor、菜单、输入状态、连接健康和平台
媒体传输属于渠道运维或呈现能力，不建立第二套 Thread、Turn、历史、工具或审批语义。

## 功能

- Telegram、飞书和微信均识别平台明确携带的回复/引用关系，把可验证的引用文字作为有界上下文与
  当前消息分离后提交；命令只解析当前消息。飞书通过官方消息读取接口解析 `parent_id`；
  Telegram 使用入站事件自带内容；微信只按精确 `msg_id` 命中当前进程内、已授权用户最近收到的
  最多 1000 条文本，机器人消息、重启后或淘汰后的未命中引用只处理当前消息。项目不读取或复制
  平台聊天历史，微信引用正文不持久化。
- Telegram 和飞书从收到普通 Turn 输入开始，把“已开始处理。”和首条最终正文原生回复到该输入消息；
  回复目标只在 Surface 内存中按 Conversation 与 Turn 短期关联，不进入 Core、SQLite 或聊天历史。
  Telegram 使用 `reply_parameters`，飞书使用官方 `im.v1.message.reply`。微信固定 v2.4.6
  合同尚未验证可用的出站原生回复字段，因此继续使用普通消息，避免未支持载荷阻断回复。
- 在 Telegram 中发送文本、PNG/JPEG 图片和最多
  1,000,000 字节的 UTF-8 文本文件；同一原生
  相册最多 4 张图片合并为一次 Turn 输入。文本文件只在内存中严格校验文件名、UTF-8 和控制字符，
  以内联文本提交，不保存文件副本；单个 UTF-8 文本文件的文件名、说明文字、正文解析与最终
  原生回复已通过真实 Bot 验收。Codex 原生 `imageGeneration` 成功保存的 PNG/JPEG 会经过
  安全文件校验后作为静默图片消息发送。二进制、Office、压缩文件和多文档相册未做真实验收，
  不列入支持范围。
- 可选启用飞书企业自建应用，通过已授权用户的私聊文本提交 Turn；启动通知、短回复、命令结果、
  操作过程和每轮结束统计统一使用 CardKit 2.0 Markdown，持续模型增量使用原生流式卡片，错误与操作性提示
  保留纯文本；同一 Turn 的运行中与空闲状态已实现合并到一条
  可更新消息。私聊 PNG/JPEG 图片、命令审批卡片、静态展示、操作终态、启动通知、每轮状态、
  原生流式主路径、状态卡片更新和 CardKit 2.0 原生用户输入卡已通过真实应用验收；
  MCP form/URL 卡片仍待真实验收，
  Codex 原生 `imageGeneration` 成功保存的 PNG/JPEG 会经安全文件校验、官方图片上传接口
  和私聊消息接口发送；该反向图片路径已通过真实应用验收。
  `/start`、`/help` 与机器人自定义菜单可打开分类命令中心卡片；
  `/fs doctor` 可在 Actor
  明确确认后只增量申请缺失的应用权限，并通过飞书客户端内的授权页自动补齐菜单、事件与回调后
  提交应用版本。Doctor 会分别检查菜单节点和启用开关；节点存在但
  未启用时显示“已添加，尚未启用”。飞书独立音频复用既有 `im:resource`，限制为 5 分钟、
  20 MiB 和 Codex CLI 支持的格式，但只有当前模型目录明确包含 `audio` 输入能力时才会提交；
  飞书独立文件消息当前只接受最多 1,000,000 字节、
  不含二进制控制字符的 UTF-8 文本，在授权后通过官方消息资源 API 下载并以内联文本提交，
  不保存文件副本或暴露本地路径；Office、压缩包、其他二进制文件和群聊仍不支持。
- 微信单账号私聊文本、图片、语音转写与 UTF-8 文本文件 Surface 已接入：`codexc setup` 会在明确确认连接替换风险后扫码，把
  Bot Token 保存到独立安全凭据后端，并记录脱敏账号与允许用户；将保存配置中的
  `weixin.enabled` 显式改为 `true` 并重载服务后开始接收和回复文本。微信支持
  `/start`、`/help`、`/whoami`、只读 `/wx doctor`，以及统一会话命令服务的全部命令；
  旧的 `/weixin doctor` 入口仍兼容；
  Doctor 仅显示 Bot 凭据、回复上下文、后台游标和轮询/Token 状态，不显示对应私密正文；
  未知斜杠命令会明确拒绝，
  不会作为普通消息提交给 Codex。单条消息及同一接收批次内连续发送的图片支持说明文字和最多
  4 张 PNG/JPEG 图片；图片会从
  固定官方 CDN 下载、按官方 key 解密，并与文字通过统一图片输入一次提交。每张图片最多
  10 MiB，整批最多 20 MiB；Codex 原生 `imageGeneration` 成功保存的 PNG/JPEG 会按同一会话顺序
  加密上传并作为微信图片气泡发送，普通 `imageView` 不会自动外发。单个一般文件会在授权后从
  固定官方 CDN 下载、AES-128-ECB 解密并核对声明长度与 MD5；当前只接受最多 1,000,000 字节、
  不含二进制控制字符的 UTF-8 文本，直接作为有明确文件名边界的文本输入进入 App Server Thread；
  Gateway 不保存文件副本，也不要求 Codex 读取工作区外路径。单条微信语音有可信转写时作为
  文本输入；否则仅在当前模型目录明确包含 `audio` 时接受 Codex CLI 可读取的 MP3/OGG，
  常见 SILK 当前明确拒绝。Office、压缩包、
  其他二进制文件和视频暂不支持。每个 Turn
  开始时先发送一次“已开始处理。”确认，再显示微信原生输入状态并每 5 秒续期，最终回复、
  完成、停止或失败时取消；输入状态失败不阻断正常回复。最终回复后仍发送完成、停止
  或失败统计；已授权且已有绑定的私聊在至少接收过一条消息后，会使用独立加密保存的最近回复
  上下文接收 Gateway 重启上线通知。微信最终回复会把单行 Markdown 代码块压缩为行内代码，
  避免客户端生成占空间的 `TEXT / 复制` 区域；多行代码块仍保留复制能力。
  超过五个文本气泡且不超过 1,000,000 字节的最终回复会先发送有界预览，再把完整 UTF-8 正文
  作为 `codex-final-answer.txt` 文件发送；文件发送失败时从预览截断点继续发送剩余的有界文本，
  不重复预览，底层错误只进入脱敏日志。不读取任意本地路径，超过文件上限时保持原有有界截断。
  微信长轮询会在 1 至 120 秒安全范围内采用成功响应给出的下一轮建议超时；空响应仍提交已推进
  的游标。网络、429 或 5xx 连续故障时自动退避恢复，不停止 Telegram、飞书或共享 App Server；官方 `-14`
  Token 失效会暂停微信轮询并在日志提示重新执行 Setup。微信 `/status` 会追加当前轮询、短重试、
  退避、Token 失效暂停或停止状态，以及按 Gateway 本地时间显示的当前消息到达前上一次后台成功
  轮询时间、连续失败次数和预计恢复时间。微信消息采用至少一次处理语义：仅在整批消息成功处理后
  保存官方游标；如果进程在消息已经提交给 App Server、游标尚未落盘的极短窗口内退出，重启后
  可能再次提交该消息。固定版 App Server 的 `clientUserMessageId` 只标记用户消息来源，不提供
  重复 Turn 拒绝。命令、文件修改和临时权限审批会发送带随机一次性 ID
  的精确 `/批准一次 <id>`、`/批准会话 <id>`、`/保存命令规则 <id>`、
  `/保存网络规则 <id> <序号>` 或 `/拒绝 <id>` 命令；回复数字、“同意”、错误或过期 ID 均不会
  批准。微信把同一审批的选项优先合并到一个 Markdown 消息，每条命令保留独立复制入口；
  审批绑定当前账号、私聊 Actor、Conversation、Thread、Turn 与 App Server 请求。Codex 用户输入
  逐题发送当前问题，并通过精确 `/选择 <id> <问题序号> <选项序号>` 或
  `/填写 <id> <问题序号> <答案>` 收集；当前题回答成功后才发送下一题；
  MCP JSON 表单使用 `/提交表单 <id> <JSON>`，外部 URL 操作使用 `/完成 <id>` 确认，
  `/取消 <id>` 安全取消。所有命令沿用一次性 ID、Actor/会话绑定、超时和跨客户端失效；
  微信聊天无法隐藏敏感回答，带敏感标记的输入请求会明确取消。
- 查看 Codex 流式回复、格式化最终回复、操作过程、计划、Diff、Goal、用量和额度；长文本自动折叠，超长代码以预览加完整文件发送；Telegram、飞书与微信的 `/status`、上线通知和每轮结束状态卡均显示当前授权 Workspace 的 Git 分支；`/status` 还显示 Thread 累计缓存命中率，每轮结束状态卡显示最近 Turn 缓存命中率、当前 Goal 状态及 Thread 上下文压缩总次数，并统一显示 App Server 返回的准确对话耗时。
- 原生 Codex CLI/TUI 向已绑定 Thread 发送的用户输入会镜像到 Telegram、飞书和微信；三端共用
  “CLI 输入”语义，并分别使用引用块、CardKit Markdown 或普通文本气泡展示。
- App Server 明确返回的 Turn、warning、账户、额度和 MCP 状态会在统一脱敏并限长后显示到
  Telegram、飞书和微信；微信使用按会话排序的纯文本气泡，不模拟卡片或静默提醒。未知内部异常、
  凭据和未经约束的响应正文仍不会直接发送。
- Telegram 通知按逻辑事件降噪：过程、状态、上下文和后续分片静默发送；最终回复、审批、用户输入与严重错误保留提醒。多题用户输入逐题展示：固定选项使用 Inline Keyboard，“其他内容”和自由文本使用 ForceReply；当前题回答成功后才发送下一题。
- 飞书不模拟 Telegram 的静默参数，也不调用加急接口；过程与状态通过流式或原地更新降噪，
  最终回复、错误、审批和用户输入使用新的普通消息或卡片获得平台标准提醒。
- 飞书最终回复超过五张 CardKit 卡片的可靠展示预算且不超过 1,000,000 字节时，会保留一张
  有界预览卡并把完整 UTF-8 正文作为 `codex-final-answer.txt` 文件发送；原生流式回复则在已有
  卡片后追加完整文件。该能力只发送进程内生成的正文 Buffer，不读取任意本地路径；飞书输入侧
  仅支持前述受限 UTF-8 文本文件，不表示支持 Office、压缩包或其他任意一般文件。
- Telegram 与飞书审批交互优先于同一会话中尚未发送的非关键过程消息；两端只记录脱敏的请求
  路由、送达和失败状态，便于区分无需审批、无会话绑定与平台发送失败。
- Telegram、飞书和微信共用一套生命周期信息模型：Gateway 上线时按相同顺序通知当前系统、版本、
  App Server 返回的上游 User-Agent、本地连接方式、Workspace、Git 分支、Thread、模型、
  思考强度、Fast 模式和周限；每个 Turn 开始时统一确认“已开始处理。”，结束时统一汇报状态、
  错误、上下文、缓存、模型、压缩、周限、Goal、Git 分支和耗时。各平台只保留自己的消息外观。
- 处理命令、文件修改、临时权限、用户输入及 MCP 审批。
- 在预配置 Workspace 间切换，并与原生 TUI 双向恢复 Thread。
- 使用私有 Unix WebSocket；Gateway 与 App Server 独立运行。

## 环境要求

- macOS 或 Linux；Windows Transport 尚未实现。
- Node.js 22.13 或更高版本。
- 已安装并登录 `codex-cli 0.145.0`。
- Telegram Bot Token 和允许使用的 Telegram 用户 ID。
- 如需启用飞书，还需要企业自建应用的 App ID、App Secret 和允许使用的用户 Open ID。

Codex CLI 需要单独安装：

```bash
npm install -g @openai/codex@0.145.0
```

## 快速开始

安装 Codex Connect：

```bash
npm install -g @hegenai/codexc
codexc init
codexc setup
```

`codexc setup` 使用统一设置菜单进入具体配置流程；当前可从“通讯渠道”选择 Telegram、飞书或
微信。Telegram 模块会引导
通过官方 `@BotFather` 新建 Bot 或填写已有 Bot Token，验证 Token，并通过一次性 `/start`
配对链接自动获取 Telegram 用户 ID。复用当前 Bot 时默认保留已有用户允许名单，避免与运行中的
Gateway 争抢 Telegram 长轮询。该流程不依赖第三方机器人创建服务。也可以直接编辑
`~/.codex-connect/config.toml`，至少填写：

交互式输入 Bot Token 时会在当前终端明文显示；屏幕共享或录屏期间请先停止共享。

```toml
[telegram]
bot_token = "你的_Bot_Token"
allowed_user_ids = [你的_Telegram_用户_ID]
message_format = "html"

[display]
operation_updates = "compact"
```

`display.operation_updates` 控制 Telegram、飞书和微信的命令、文件修改、MCP 工具及搜索过程：
`"full"` 显示完整详情、状态和退出码，`"compact"` 只显示一行状态与最多 160 个字符的
详情摘要；两种模式都会把 `.codex` 与 `.codex-connect` 私有目录的绝对路径显示为
`[内部路径]`，普通项目路径保持可核对。同一 Turn 内成功完成的 MCP 工具、动态工具和网页搜索会延迟到最终回复前统一发送，
单项保留详情，多项只发送一次分类计数汇总，失败和拒绝仍即时显示。飞书在两种模式下都把耗时
单独放在操作卡底栏；Telegram 和飞书在可见操作结果或生成图片入队前，会先刷新同一 Turn
仍在合并窗口内的正文，避免过程通知越过说明文字；微信不发送进行中帧。`"hidden"` 完全隐藏操作过程。审批、
最终回复、错误和回合结束统计不受影响。默认值为
`"compact"`；旧的布尔字段不再接受。修改后执行 `codexc service reload`，Gateway 会自动重启，
共享 App Server 和活动 Thread 不受影响。

飞书模块提供“手动输入应用凭据”和“扫码授权”两种方式。扫码后在飞书授权页选择新建应用或
已有企业自建应用；流程只申请应用只读检测与配置写入、机器人发送消息、原生 CardKit 流式卡片、
`im.message.receive_v1`、`application.bot.menu_v6` 事件和
`card.action.trigger` 审批卡片回调所需的最小配置。
两种方式都会验证应用凭据和 Bot 身份，再把 App ID、App Secret 与允许的用户 Open ID 原子写入
统一配置。二维码、设备码和短期授权状态不会保存；已有允许名单只会在终端再次确认后保留。
扫码方式保存配置后会立即保留已有菜单，自动启用 Event Key 为 `codexc_home` 的悬浮 `Codex`
事件菜单、追加长连接菜单事件与卡片回调并提交应用版本。自动配置失败不会删除已验证的连接配置，
可在 Gateway 启动后通过 `/fs doctor` 恢复。手动输入凭据不会在终端直接修改应用配置。
也可以手工在同一配置文件中加入：

```toml
[feishu]
enabled = true
app_id = "cli_0123456789abcdef"
app_secret = "你的_飞书_App_Secret"
allowed_open_ids = ["ou_xxx"]
```

手工配置后、扫码自动配置失败时，或需要复查当前应用状态时，可在飞书私聊发送
`/fs doctor`。Doctor 以当前 Gateway 已收到的消息、
卡片动作和菜单事件为优先证据，并只读复查应用已开通的租户权限与已发布配置；卡片只显示四项
摘要和当前仍需处理的入口。缺少应用权限时，一次性授权按钮只申请差集，并在飞书客户端侧边栏
完成确认；随后 Gateway 保留已有菜单，自动启用一个 Event Key 为 `codexc_home` 的悬浮 `Codex`
事件菜单、追加长连接菜单事件并提交应用版本。存在待发布版本时拒绝覆盖；企业要求审核时仍由
管理员批准。新扫码应用默认声明 `application:application:patch`，已有应用可由 Doctor 增量开通，
无需重新创建应用。
当前接收允许名单用户的私聊普通文本和纯文字富文本；连续私聊图片会在一秒静默窗口内按顺序
合并为一次最多 4 张图片的 Turn 输入。私聊 PNG/JPEG 独立图片已通过真实应用验收，
包含两张图片及说明文字的富文本消息已通过真实应用验收，三至四张图片的上限组合仍待复验。包含不支持
元素的富文本失败关闭，不会丢弃部分内容后提交。审批请求不会通过飞书静默批准高权限操作。

微信 Setup 会在联网前提示新连接可能删除旧连接，并要求再次确认；扫码成功后 Bot Token 不进入
TOML、SQLite 或日志。macOS 使用独立 Keychain Service，Linux 使用
`credentials/weixin` 下独立主密钥和 AES-256-GCM 密文。TOML 只记录：

```toml
[weixin]
enabled = true
account_id = "不透明账号@im.bot"
allowed_user_ids = ["不透明用户@im.wechat"]
```

Setup 默认保存 `enabled = false`，避免扫码完成后在操作者确认前启动长轮询。确认账号与允许名单
后可将其改为 `true`，执行 `codexc service reload`；Gateway 会从安全凭据后端延迟读取 Token，
接收允许用户的私聊文本、语音转写、UTF-8 文本文件、图文消息与最多 4 张 PNG/JPEG 图片；同一接收批次内的连续图片会在
一秒静默窗口内合并后一次提交，并在独立
`credentials/weixin-reply-context` 安全后端加密保存每个
已绑定私聊的最近回复上下文，用于重启上线通知和重启后恢复关键输出。回复上下文不进入 TOML、
SQLite 或日志；撤权目标不会收到通知。`codexc doctor` 会只读检查连接凭据是否存在且载荷有效，
不显示 Token。没有可信转写的 MP3/OGG 只有在当前模型目录明确包含 `audio` 时才提交；
固定版当前可见模型均只声明文本和图片输入，因此三渠道原始音频会在创建或追加 Turn 前明确拒绝，
不会用占位文本消耗一次 Turn。微信暂不支持 SILK 解码、实时语音、语音输出、其他二进制文件、视频、群聊或脱离已保存回复上下文的一般主动推送；
已有授权绑定且存在安全回复上下文的私聊可以接收上线和配置生命周期通知。当前图片
输出只处理活动 Turn 中 App Server 明确返回的 `imageGeneration.savedPath`。

最终回复默认把常用 Markdown 安全转换为兼容性更好的 Telegram HTML。支持 Rich Messages
的客户端可设置 `telegram.message_format = "rich"`；修改后执行 `codexc service reload`，
Gateway 会自动重启。

注册需要通过 Telegram 使用的项目目录：

```bash
cd /absolute/path/to/project
codexc ws add
```

macOS 或 Linux 安装常驻用户服务：

```bash
codexc service install
codexc service status
```

安装会先执行完整配置校验；校验失败时不会替换或停止现有服务。

Linux 如需退出 SSH 后仍保持运行或开机启动，还需执行一次：

```bash
sudo loginctl enable-linger "$USER"
```

`codexc start` 仍可用于临时前台运行。

安装或升级后运行诊断：

```bash
codexc doctor
```

`doctor` 会检查 Node、Codex CLI、TOML 语法、完整 Gateway Schema 与权限、Telegram 必填项、
飞书启用状态、允许名单及凭据/Bot 身份，以及微信配置、Bot 凭据、消息游标、加密上线通知上下文
覆盖数和最近授权消息时间；同时检查 Workspace、App Server 握手、运行中 App Server 的实际版本
和系统服务状态。磁盘 CLI 或共享 App Server 与项目锁定版本不一致时诊断失败，但不会显示 Token、
`context_token`、游标、图片 CDN 地址或 AES key、App Secret、完整飞书响应或完整上游
User-Agent。Doctor 不额外调用微信
`getupdates`，不会与 Gateway 竞争消费消息。项目不读取或迁移旧 `.env` 配置。

## 常用命令

```bash
codexc config                    # 显示配置路径
codexc setup                     # 选择并配置 Gateway 模块
codexc doctor                    # 诊断配置与服务连通性
codexc ws                        # 列出 Workspace
codexc ws add                    # 注册当前目录
codexc ws add --prune-missing    # 清理失效 Workspace 并注册当前目录
codexc ws remove <序号|ID|名称>   # 删除 Workspace 注册，不删除目录
codexc remote                    # 在当前目录启动原生 Codex TUI
codexc remote resume             # 恢复当前目录的原生会话
codexc rules init                # 为当前项目生成安全命令预设
codexc rules check               # 使用 Codex CLI 检查项目规则
codexc service reload            # 立即热加载配置，必要时自动重启 Gateway
codexc service restart           # 只重启 Gateway
codexc service restart app-server # 只重启 Codex App Server
codexc service restart all       # 重启 App Server 与 Gateway
codexc service logs              # 查看 Gateway 最近 100 行日志
codexc service logs -f           # 持续跟踪后台日志
codexc service logs all          # 同时查看 App Server 与 Gateway
codexc service uninstall         # 卸载服务并保留用户数据
codexc service -h                # 查看服务命令及目标默认值
```

`codexc -h` 显示全部公开命令；每个命令和子命令都支持 `-h` 或 `--help`，例如
`codexc ws add -h`、`codexc rules init -h` 和 `codexc service restart -h`。

用户配置、Workspace Registry、SQLite、配置事件队列、Socket、日志和上传图片均位于 `~/.codex-connect`，不会写入全局 npm 包目录。统一配置文件是 `config.toml`；`CODEX_CONNECT_CONFIG_FILE` 可显式选择其他配置文件，其相对路径和运行数据以该文件所在目录为基准，但不会修改已存在父目录的权限。`CODEX_CONNECT_HOME` 可用于隔离测试或多 Profile。

macOS 使用 `com.hegenai.codex-app-server` 与 `com.hegenai.codex-gateway` 两个 launchd Job。Linux 使用
`systemctl --user` 管理两个独立服务。`start`、`stop` 和 `status` 默认目标为 `all`；
`restart` 默认目标为 `gateway`，保持共享 App Server 和活动 Turn 运行。需要操作单个进程时显式
使用 `gateway` 或 `app-server`，需要同时操作时使用 `all`。

`[network]` 代理字段留空时不需要额外设置：运行入口依次采用 TOML 明确值、当前进程的
`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`，再尝试 macOS 系统 HTTP/HTTPS
代理或 Linux GNOME 手动代理，最后直连。Linux 服务也会继承 systemd 用户管理器已有的标准
代理环境变量。自动代理配置（PAC）和未定义统一接口的桌面私有格式不会被猜测；需要时仍可在
TOML 中明确填写。`codexc setup`、Gateway 和服务入口共用这一解析逻辑；Telegram 的
`telegram.proxy_url` 保持最高优先级。飞书 HTTP API、用户 OAuth
和 WebSocket 复用解析后的 HTTP/HTTPS 代理并遵循 `NO_PROXY`；飞书当前不支持只通过
SOCKS `ALL_PROXY` 连接。目标未命中 `NO_PROXY` 时，无效或不支持的飞书代理会让 Gateway
启动失败，不会静默改为直连。

`codexc service logs` 默认显示 Gateway 日志；使用 `codexc service logs app-server` 查看 App Server，
使用 `codexc service logs all` 查看两者。目标必须放在日志选项之前；`-n 200` 可调整显示行数，
`-f` 可持续跟踪。macOS 默认忽略早于正常日志的陈旧 stderr，日志文件位于
`.codex-connect/runtime`；Linux 日志来自 systemd user journal。Gateway 的结构化日志会裁剪错误并
脱敏已知凭据字段；App Server 是独立的官方进程，其原始 stdout/stderr 可能包含命令、工作内容或
诊断上下文，不经过 Gateway 脱敏器。分享 `app-server` 或 `all` 日志前必须人工检查内容。

Telegram、飞书长连接与 App Server 均采用受约束的连接恢复；连续失败耗尽后 Gateway 会退出，
由 launchd 或 systemd 自动拉起，避免进程存活但不再接收消息。

Gateway 会监测用户 `config.toml`：新增 Workspace 和各渠道允许用户列表中的受支持变更会直接热加载。Workspace 新增后，持久化事件会投递给各渠道当前可安全确定的授权收件人；Telegram 另外提供直接切换按钮，飞书和微信只使用已有授权绑定及各自安全收件人条件。Workspace 新增事件会先写入 `~/.codex-connect/data/config-events.json`，Gateway 热加载或重启并通过平台 API 实际发送成功后再确认删除，因此不会因配置监听合并或重启窗口静默丢失；平台 API 重试后仍失败时保留事件，等待下次启动或 `codexc service reload`，发送后、确认前崩溃可能导致重复通知。删除允许用户会先重启 Gateway 并清理其旧 Thread 绑定；Bot Token、Telegram 代理、数据库、默认模型等 Gateway 配置变化时，Gateway 会优雅退出并由 launchd 或 systemd 自动拉起，Codex App Server 保持运行。`codex.binary`、`codex.socket_path` 或有效 `network` 代理同时影响独立 App Server，需要重新执行 `codexc service install` 使两项服务采用新值。系统代理和标准环境变量会在每次服务启动时重新读取，不会复制进服务定义。配置校验失败时继续使用当前有效配置。三个渠道都会按各自安全收件人条件通知热加载成功项、自动重启原因、需要重装的服务配置或加载失败状态，但不会发送原始配置和异常详情。可执行 `codexc service reload` 立即触发检查，无需等待文件监测。

飞书 `allowed_open_ids` 可热加载，并会清理已撤权 Actor 的旧绑定；启用状态、App ID 或 App Secret
变化会重启 Gateway。飞书配置通知只发送给已有绑定且仍有授权 Actor 的私聊，不会广播凭据或
允许名单；尚未建立安全会话时没有飞书通知收件人。

微信配置通知同样只发送给已有授权绑定且当前存在安全回复上下文的私聊；缺少安全收件人来源时，
持久化配置通知失败关闭，不会退化为任意主动推送。

## Telegram 命令

- 会话：`/new`、`/resume`、`/sessions`、`/archived`、`/archive`、`/unarchive`
- Workspace：`/workspace`
- Turn：`/status`、`/stop`、`/queue <描述>`、`/rename`、`/compact`、`/fork`、`/review`
- 模型：`/model`、`/effort`、`/fast [on|off|status]`、`/plan [规划需求]`
- 状态：`/diff`、`/usage`、`/limits`、`/permissions`、`/goal`
- 扩展：`/skills`、`/mcp`、`/plugins`、`/rules <init|check>`
- 交互：`/stop` 会优先停止当前待处理交互，没有待处理交互时停止当前 Turn；`/whoami`

三个渠道只能选择预配置 Workspace，不能通过消息提交任意工作目录。命令和文件审批在 App Server
支持时提供“批准一次”“本次会话始终同意”和“拒绝”；命令审批收到 App Server 的精确规则提议时，
还会提供“始终允许此前缀”或带精确域名的“始终允许/拒绝”网络规则，由 App Server 保存对应规则。
网络专用审批会显示目标主机和协议，“本会话允许”也会标明其适用主机。
临时权限只允许当前 Turn。会话授权或持久规则必须由用户显式选择，未知、畸形或过期的高权限请求
会被拒绝或取消。
当前 Turn 运行时，普通消息会通过 `turn/steer` 立即追加；使用 `/queue <描述>` 可把纯文本
排到下一 Turn。队列按 Conversation 隔离，每个会话最多 10 条，只保存在 Gateway 内存中；
Turn 完成后逐条启动，Gateway 重启、Thread 切换或排队 Turn 启动失败时会清空，不写入 SQLite。
`/sessions [搜索词]` 与 `/archived [搜索词]` 在三个渠道统一最多显示 20 条会话，名称压缩为
单行并限制长度；超过上限时显示未展示数量和对应的搜索命令。
`/skills` 显示当前用户或 Workspace 直接安装且已启用的 Skill，不重复列出系统或插件附带 Skill；`/plugins` 只查询本机已安装插件，不加载远端插件市场目录。
`/fast on` 和 `/fast off` 与原生 Codex CLI 保持一致：既为下一次 Turn 显式选择服务层级，
也通过 App Server 保存用户级默认值，因此之后重启 `codexc remote resume` 不会恢复成旧的
Fast 默认状态。Turn 成功启动后，当前设置仍由 App Server Thread 保存，Gateway 重启或重建
服务后会随 Thread 恢复。原生 CLI 修改共享 Thread 的 Fast、模型或思考强度时，App Server
通过设置通知同步给 Gateway；Goal set/clear 请求成功后会立即同步本地显示，外部更新、清除和
Thread 恢复继续通过 App Server 通知校正。Gateway 只缓存当前 Goal 用于 `/status` 与回合结束
状态卡，不读取或轮询 Codex 会话文件。

`/plan` 与官方 Codex `/plan` 对齐：无参数时在 Default 与 Plan 间切换，设置在下一次 Turn
生效；`/plan <规划需求>` 会进入 Plan 并立即启动一个新 Turn。活动 Turn 不能中途切换模式，
需要先等待完成或停止。Plan 模式允许 Codex 使用官方 `request_user_input` 交互收集澄清信息，
三个渠道复用各自已有的用户输入交互。当前模式由 App Server 的 Thread 设置通知校正，
`/status` 和上线通知会显示 Default/Plan；Gateway 不另行持久化模式。

## 飞书私聊命令

飞书私聊的开发实现已复用上述全部平台无关会话命令，并另外提供 `/start`、`/help`、
`/whoami` 和
`/fs <status|doctor|revoke>`；旧的 `/feishu` 入口仍兼容。`status` 显示当前进程实际观测到的长连接、消息事件、
卡片回调、机器人菜单事件和当前 Actor OAuth 状态；`doctor` 只显示长连接、消息接收、卡片交互
和自定义菜单四项摘要。Doctor 会读取当前租户已开通权限和已发布配置，运行时已经收到的事件优先于
远端快照；缺少应用权限或菜单配置时显示一次性配置按钮，并只申请缺失权限。该动作以一次性令牌
绑定 App、Chat 和 Actor，完成官方应用授权及目标 App 与租户校验后，保留已有菜单并自动启用
`codexc_home` 事件菜单、追加长连接菜单事件和提交应用版本。存在待发布版本时拒绝覆盖；企业要求
审核时提示等待管理员批准。
已发布菜单只有在 `bot_menu_enable=true` 时才显示为“已启用”，节点存在但开关关闭时显示
“已添加，尚未启用”。命令在飞书授权和有界输入队列之后进入同一个
`ConversationCommandService`；未知或畸形斜杠命令会明确拒绝，不会作为普通消息提交给
Codex。上线通知、Turn 开始确认、短回复和命令结果使用 CardKit 2.0 静态 Markdown 卡片；
持续产生的模型正文使用 CardKit 2.0 原生流式卡片；该路径把每轮结束统计追加到同一终态卡片，
未进入流式路径时仍发送独立静态统计卡。操作事件忽略运行中间帧，在完成、失败或
拒绝时按会话时间线发送独立静态卡片，并显示 Core 已提供且经过脱敏和截断的命令、文件、工具
或搜索摘要；错误、过载和操作性提示保留纯文本。
`/start`、`/help` 和机器人自定义菜单的 `codexc_home` 事件会发送同一张分类命令中心卡片：
新会话、会话切换、状态、Fast、账户用量和额度位于“常用”，模型、思考强度、工作区、Goal 和 Plan 模式
位于“模型与工作区”，
“更多命令”入口位于“更多”。“更多命令”继续打开第二张分类卡片，按会话查询、能力与集成、
当前内容和飞书提供按钮，不再直接发送完整 `/help` 长文本。会话切换、会话列表、已归档、
模型、思考强度、Fast 和工作区会继续打开最多 18 项的选择卡；点击后仍由统一
`ConversationCommandService` 校验并执行，Fast 只有在明确选择开启或关闭后才会修改状态。
会话列表和归档列表的首项可继续打开搜索表单；重命名、追加下一 Turn、Review 和 Goal 使用同一个
有界输入卡片，项目规则只展示共享命令允许的生成与检查动作。输入卡片只保存短期 UI 上下文，
命令语法、状态和队列仍由 Application 的统一服务处理。选择卡和输入卡使用一次性令牌；未显示
在当前卡片中的动作或参数即使伪造回调也会拒绝。主卡与分类卡的只读动作可复用，直接新建、停止、
归档、压缩或分叉会话后整张卡片立即失效，避免平台重投或重复点击再次写入。菜单事件
本身不携带 Chat ID，因此只有当前 Actor 恰好匹配一个已授权私聊绑定时才会响应；事件和卡片
令牌均为有界内存状态，重启后清空。卡片动作调用同一个 `ConversationCommandService`，
不会把按钮伪装成用户文本，也不会在 Surface 中复制模型、会话或 Fast 状态逻辑。
Gateway 长连接就绪后，会向已有授权绑定发送静态 CardKit 上线通知；每轮结束会使用紧凑
CardKit Markdown 列出
`turn.completed` 已携带的用量和设置字段显示最近 Turn 上下文、缓存命中率、模型、思考强度、
Fast、上下文压缩、周限和 Goal。两条路径均不新增状态来源或持久化消息内容。
静态和流式 CardKit Markdown 均采用 5,000 个 Unicode 字符单元素上限，每个逻辑结果最多发送
5 张卡片，超出时明确标记截断；纯文本和 `post + md` 降级仍按 20,000 字节计量。会话列表最多
展示 20 条，长预览会规范空白并截断，可通过列表内的搜索卡片或
`/sessions <搜索词>`、`/archived <搜索词>` 缩小范围。
同一 Thread 的 `active → idle` 状态通过一条轻量交互卡片原地更新；蓝色表示运行中，绿色表示
空闲。重复 `active` 不产生额外更新，更新失败不自动重试，也不阻塞后续输出。
静态 CardKit 只在卡片实体尚未发送到 Chat、创建失败时安全降级为 `post + md`；消息创建失败
后不会改发另一种格式，以免非幂等重发产生重复消息。
流式增量以 300 ms 合并并继续经过同一 Chat 的有界顺序队列；可见操作结果或生成图片到达时会先
强制刷新同一 Turn 已暂存的正文，避免操作通知越过尚未展示的说明文字。单卡内容采用保守的 5,000
Unicode 字符上限，并在代码围栏跨卡时闭合和重开。流式卡片与失败回退富文本合计最多 5 条；
非终态流式输出最多占用前 4 条，为最终校正或失败回退保留第 5 条；达到预算或本地有界缓冲上限时
在最后一张消息明确标记截断。官方频控响应只跳过受限的中间更新，
保留累计正文和递增序列供后续自然增量继续，不主动重试；卡片创建或其他内容更新失败时会尽力结束已显示的卡片，
Turn 完成后再用剩余预算回退完整富文本；正常终态通过完整静态 CardKit 全量更新正文、追加结束
统计并关闭流式模式，避免客户端打字机动画未追平时丢失尾字或让独立统计消息抢先显示；
已显示完整内容后的终态更新失败不重复发送正文。
持续回复在飞书客户端可见原生流式更新的主路径已通过真实应用验收；真实限流、失败回退和
超长内容滚动仍待验收。
私聊图片使用同一授权、去重和顺序队列；连续图片在队列内静默一秒后合并为一次最多 4 张的
Application 输入，同一富文本内的多张图片也按原顺序组成一次输入。所有图片均只接受
PNG/JPEG，最大 10 MiB，下载后写入 `~/.codex-connect` 下的私有临时目录并定期清理；独立图片
及两张图片加说明文字的单 Turn 主路径已通过真实验收，三至四图上限仍待复验；UTF-8 文本文件输入已完成离线实现并
等待真实验收。飞书命令审批卡片及
`card.action.trigger` 动作回调已通过真实应用验收；
Thread 状态卡片更新及用户输入卡已通过真实应用验收；MCP form/URL elicitation 卡片已完成离线
实现并复用同一回调、一次性令牌和 Actor/Chat/消息绑定，但仍待真实验收。

用户级飞书能力通过官方 OAuth Device Flow 按需授权。具体能力必须先传入它实际需要的 Scope；
授权器检查应用已开通权限和安全凭据后端中的有效 Token，只申请当前能力尚缺的差集。应用即使
开放了更多权限，也不会被加入本次请求；没有具体能力需求时不会发起授权。实际请求会在卡片中
连同自动加入的 `offline_access` 完整列出后由当前消息 Actor 显式授权；按钮只接受
`https://accounts.feishu.cn` 精确 Origin 返回的完整授权地址，再使用飞书 AppLink 在客户端
侧边栏内完成授权；从有界应用权限响应中筛选后，最多支持 100 项用户 Scope 加
`offline_access`。Gateway
后台有限轮询、校验实际授权账号并原地更新结果卡片。该流程需要应用权限
`application:application:self_manage`。macOS Token 保存到系统 Keychain，Linux 保存到 Gateway
数据目录下的 AES-256-GCM 私有凭据文件，不进入配置、会话 SQLite、日志或平台消息；
`/fs status` 会区分授权进行中与已保存凭据，`/fs revoke` 会取消进行中的授权并清除当前
Actor 本地凭据；即使本地凭据已经损坏、无法解密，明确撤销仍会清除对应文件并记录脱敏告警。
Surface 停止会取消授权任务并最多等待 5 秒；若停止或存储错误与 Token 写入
竞态，则尝试恢复停止前的凭据，恢复失败会记录不含 Token 的警告。真实 Device Flow、身份校验
与安全写入及 Gateway 重启后的 Token 恢复已通过测试应用验收。当前 Surface 对话不依赖
用户 OAuth，也没有飞书 CLI 工具消费该 Token，因此当前不会主动发起用户授权；已有凭据保持不变，
可通过 `/fs revoke` 清除。

这组命令仍属于开发验证能力；Gateway 重启后的 Thread 绑定恢复已通过验收，仍需完成真实应用中
的帮助、选择器、状态修改、Diff 和错误参数等命令矩阵后，才能更新为公开支持。

如果已配置的 Workspace 目录被移动、删除或暂时不可访问，普通 `codexc ws add` 会停止并列出失效项，
避免误删暂时未挂载的目录。确认目录不再使用后，可执行 `codexc ws add --prune-missing`：
它会清理失效项、注册当前目录，并在原默认 Workspace 失效时恢复固定默认目录。
通过 `codexc` 管理时，默认 Workspace 固定为 `~/.codex-connect/workspace`；清理失效的默认项时会自动重建该目录，
不会把本次添加的项目设为默认。执行 `codexc ws add` 也会校正偏离该固定默认项的配置。
`codexc ws` 会继续列出目录已不存在或无法访问的注册项并标注状态；可使用
`codexc ws remove <序号|ID|名称>` 删除对应注册记录。该命令不会删除磁盘目录，
且不能删除固定默认 Workspace。

## 架构

```text
Codex App Server（独立进程，Unix WebSocket）
├── 原生 Codex TUI
└── Codex Connect Gateway
    ├── Codex Client / Conversation Core / Session Router
    ├── Application Commands / Approval / Policy / Storage / Event Bus
    └── Surfaces
        ├── Telegram
        ├── 飞书（配置启用时）
        └── 微信（配置启用时）
```

App Server 是 Thread、Turn 和 Item 的唯一事实来源。SQLite 只保存外部 conversation、Surface
账号、Workspace 与 Thread 的最小绑定。Surface 通过编译期内置插件注册表显式接入；Telegram
插件始终创建一个默认账号实例，飞书和微信插件只在有效配置明确启用时创建实例。插件 ID、实际
Surface ID 和 `surface + accountId` 会在启动装配时校验；当前不扫描目录或动态加载外部 npm
包。各平台通过统一服务和
`target + actorId` 授权上下文接入，
不修改 Conversation Core 或 Codex Client；授权同时按 Surface 账号隔离。Application 返回结构化
结果，平台 SDK、文案、消息格式和文件传输由各自适配器实现；未知内部错误不会原样发送到外部聊天。

模块设计见 [`src/README.md`](src/README.md) 及各目录文档，项目约束见 [AGENTS.md](AGENTS.md)。

## 源码开发

```bash
npm ci
cp config.example.toml config.toml
chmod 600 config.toml
# 编辑 config.toml，填写 Token、用户 ID 和真实 Workspace 绝对路径
npm run dev:all
```

`npm ci` 和 `npm install` 会为当前仓库启用受版本控制的 `.githooks/pre-commit`。
每次 `git commit` 前会自动执行完整提交检查；如需手动恢复 hook，运行
`npm run hooks:install`。
从干净源码仓库进行开发安装时运行 `npm run install:global`；该命令会按 lockfile
补齐本地构建依赖、启用 Git hook、生成 `dist/`，再把当前仓库链接为全局 `codexc`。
它不依赖 npm 自动放行本地包的生命周期脚本，因此兼容 npm 12 的脚本策略。

以后更新源码时，先确认没有运行中的 Turn，再执行：

```bash
git pull --ff-only
npm run install:global
codexc service install
codexc doctor
```

`service install` 会刷新服务定义并重启 App Server 与 Gateway。若更新后的 README 要求新的
Codex CLI 版本，先安装其中声明的精确 `@openai/codex` 版本，再安装服务。

常用验证：

```bash
npm run check
npm run lint
npm run docs:check
npm test
npm run test:coverage
npm run test:package
npm run protocol:check
npm run verify:commit
```

`npm run verify:commit` 是本地 hook 与 GitHub CI 共用的提交门禁，覆盖暂存差异格式、
类型与版本、全目录 Lint、文档链接和索引、全量测试、Shell 语法、npm tarball 安装冒烟，
干净源码全局安装冒烟，以及 macOS 上的 launchd 模板检查。不要使用
`git commit --no-verify` 绕过该门禁。

升级项目锁定的 Codex CLI 时，不要直接修改版本号。先安装精确目标 CLI，并在干净工作区运行：

```bash
npm run codex:upgrade -- <目标版本>
```

脚本会生成版本专属协议并同步 Gateway 版本，随后由 Codex 审查生成差异、修复业务适配并完成
验证。GitHub Actions 还会每天检查正式 Release，并用最新官方 Alpha 做隔离兼容性 Canary；
两者都会独立运行协议、类型、Lint、测试、真实合同、构建和打包检查，即使某项失败也继续收集
其他结果，并上传逐阶段日志、结构化结果、完整 Patch 和协议字段/RPC 影响摘要。预览阶段不会
修改稳定版文档，文档索引在正式适配完成后统一验证。Canary 结果只作预警，不改变正式基线。完整流程见
[`docs/codex-cli-upgrade.md`](docs/codex-cli-upgrade.md)。
官方 Release 解析经历有限网络重试后仍失败时，也会上传带运行 ID 的 `unresolved` 报告和解析
日志，再将任务标记为失败。

在项目目录或其子目录运行 `codexc rules init`，会定位最近的 Git/Node 项目根目录，读取存在的
`package.json` 脚本，并生成 `.codex/rules/default.rules`。生成器只允许只读 Git 检查和已存在的
`test`、`build`、`check`、`lint` 等验证脚本，不放行暂存、提交、推送、依赖安装、发布或服务管理。
已有文件默认不覆盖；明确使用 `--force` 才会重新生成。生成后会自动调用当前 Codex CLI 验证，
也可随时运行 `codexc rules check` 复查。规则与磁盘项目目录关联，不依赖该目录是否注册为
`codexc ws`；Codex 只在项目受信任时加载，生成或修改后需重启 Codex。
Telegram、飞书和微信均可在当前选中的授权 Workspace 中运行 `/rules init` 或 `/rules check`；
远程入口不会
向上搜索父项目，也不提供强制覆盖，并拒绝通过符号链接把规则写到 Workspace 外。

CI 使用隔离 `CODEX_HOME` 运行 Fast 默认值和共享 Thread 设置通知合同测试；该测试不需要登录，
也不会调用模型：

```bash
RUN_CODEX_CONTRACT=1 npm test -- --run tests/real-app-server.test.ts
```

使用当前用户配置的完整真实 App Server 冒烟测试同样不会调用模型：

```bash
RUN_CODEX_INTEGRATION=1 npm test -- --run tests/real-app-server.test.ts
```

## 文档索引

- [`docs/index.md`](docs/index.md)：Codex 官方文档、固定版本源码、协议数量与本项目实现映射。
- [`docs/channel-acceptance-matrix.md`](docs/channel-acceptance-matrix.md)：Telegram、飞书和微信
  的统一真实验收状态、待验收顺序与记录规则。
- [`docs/upstream-sources.md`](docs/upstream-sources.md)：微信与飞书本地上游源码的固定基线、
  本地优先规则和显式更新流程。
- [`docs/codex-cli-upgrade.md`](docs/codex-cli-upgrade.md)：CLI 协议生成、Codex 审查和验证流程。
- [`docs/surface-integration-guide.md`](docs/surface-integration-guide.md)：新增通讯渠道的组合式模块、授权、配置、审批与验证边界。
- [`docs/feishu-surface-plan.md`](docs/feishu-surface-plan.md)：飞书 Surface 的组合式模块设计、分阶段范围、风险和验收标准。
- [`docs/feishu-reference-index.md`](docs/feishu-reference-index.md)：飞书官方资料、SDK 版本基线、支持矩阵与本地实现映射。
- [`docs/weixin-surface-plan.md`](docs/weixin-surface-plan.md)：微信 ClawBot 官方协议基线、凭据边界、分阶段接入路径与停止条件。
- [`config.example.toml`](config.example.toml)：统一 Gateway 配置示例。
- [`src/`](src/README.md)：源码模块与边界。
- [`bin/`](bin/README.md)：npm CLI 入口。
- [`scripts/`](scripts/README.md)：配置、协议、打包和服务脚本。
- [`runtime/`](runtime/README.md)：CLI 与 Gateway 共享的运行时基础设施。
- [`launchd/`](launchd/README.md)：macOS 服务模板与控制。
- [`systemd/`](systemd/README.md)：Linux 用户服务模板与运行说明。
- [`tests/`](tests/README.md)：测试范围与真实集成测试。
- [`.githooks/`](.githooks/README.md)：提交前自动检查入口。
- [`.codex/rules/default.rules`](.codex/rules/default.rules)：受信任项目的安全命令预设。
- [`.github/workflows/`](.github/workflows/README.md)：CI 与 npm Trusted Publishing。

## License

[MIT](LICENSE)
