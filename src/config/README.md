# Config

QQ 的 `[qq]` 配置复用共享严格 TOML Schema，仅在显式启用且 AppID、Secret、允许名单齐全时投影运行配置。
单聊名单新增热加载，删除、账号、凭据或启停变化要求重启 Gateway。可选 `groups` 独立配置群与成员名单，必须显式同意公开输出；不从单聊扫码身份推导群授权，任何群授权变化均要求重启，缺省不启用群。

Workspace 仅定义 `id`、`name` 和 `cwd`；执行权限由 App Server 原生配置及 Thread 继承规则决定，Gateway 不提供工作区权限覆盖字段。

本目录负责把共享运行时已完成结构校验的 TOML 文档转换为 Gateway 运行配置。
`follow_cli_version = true` 时通过共享 `codex-request-identity` 解析当前锁定版本；无标记或 false 时保留显式版本，读取不改写身份配置。
`display.model_aliases` 保留于共享配置，供控制台统计查询按原始模型 ID 归组，不投影为 Gateway
运行字段或注入 Surface。分组变化无需重启 Gateway，不改模型展示、目录、选择标识或请求模型 ID。
其中 `codexTimezone` 保留已有 `codex.timezone` 配置，供渠道启动卡展示，不修改 Gateway 进程时区。
`gatewayTimezone` 是解析后的网关时区：缺省使用 `codex.timezone`，`gateway.timezone = "system"`
保留进程继承的系统时区，其他值为自定义 IANA 名称；有效网关时区或 `codexTimezone` 变化要求重启
Gateway，以刷新进程时区或渠道启动卡配置。

## 文件

- `index.ts`：读取统一 TOML 配置，调用 `runtime/gateway-config.mjs` 的共享 Zod Schema 完成结构校验，再校验 Workspace 和 URL 等运行语义、合并自动发现的有效代理，并相对配置目录规范化路径；全部校验成功后，原子补入当前 Schema 缺失的安全默认字段。
- `config-change.ts`：定义结构化配置变更、作用域与优先级。
- `reload-classifier.ts`：比较两份已验证配置及 Bootstrap 检测的微信凭据变化，完整列出变化，并按热加载、Gateway 重启或服务重装
  的最高要求分类。

配置结构只在共享运行时边界验证一次，本目录只补充依赖文件系统和运行语义的校验。Gateway
读取前要求配置是当前用户拥有的非符号链接普通文件，且组和其他用户无权访问；配置父目录必须
由当前用户拥有并禁止组或其他用户写入。配置错误必须抛出 `ConfigurationError` 并阻止启动，
不能静默采用更宽松的权限、目录或网络默认值。Windows 使用 PowerShell 7 `pwsh` 与 .NET SID/ACL
校验表达等价结果，不读取没有安全意义的 POSIX mode；新建配置先收紧父目录，已有配置只校验、不
静默接管其他 Owner。
运行配置中的 `credentialsDirectory` 由配置文件父目录派生，供微信等凭据存储使用；飞书用户 OAuth 凭据由 Bootstrap 单独放在状态数据库父目录的 `credentials/feishu` 下，具体边界见飞书模块 README。
默认字段补齐只添加当前严格 Schema 已声明的缺失默认值，不覆盖已有配置，不补渠道凭据、身份或
允许名单，也不处理未知字段或不受支持的版本。运行语义校验失败、文件发生并发修改或原子写回失败时
不得修改原配置，并以配置错误失败关闭。

Telegram、飞书、微信和 QQ 至少需要启用一个。Telegram 表可缺失；可选 `enabled = false` 停用并保留凭据，
不创建 Telegram Surface；未设置 `enabled` 时按非空 Token 判断启用。显式启用必须有非空 Token，
启用时 `allowed_user_ids` 必须至少包含一个正整数。各渠道开关改变均要求重建 Gateway 连接。

共享代理由 Codex Home 的 `.env` 统一保存，供 Telegram、飞书、微信和模型统计代理共用，按 `.env`、标准代理环境变量、受支持系统代理的
顺序合并；系统自动发现当前只支持 macOS 和 GNOME，Windows 不读取 WinINET/WinHTTP，需使用 `.env`
或标准代理环境变量。Bootstrap 再按每个请求的目标协议和 `NO_PROXY` 选择直连或 HTTP(S) 代理。Telegram
私有 `proxy_url` 只覆盖 Telegram，并优先于共享代理和 `NO_PROXY`。项目不修改系统代理，也不
安装、配置或重启 sing-box；仅 SOCKS `ALL_PROXY` 仍不受 HTTP(S) 客户端支持。

`display.operation_updates` 是 Telegram、飞书与 QQ 的操作过程显示模式：`full` 显示完整详情、
状态、耗时和退出码，`compact` 显示单行状态、耗时、退出码和最多 160 个字符的详情摘要，
`hidden` 抑制 `operation.updated` 的平台输出。默认值为 `compact`，旧布尔字段由严格 Schema 拒绝。
三种模式都不影响审批、错误、最终回复和 Turn 完成事件；启用 Telegram、飞书或 QQ 时变化需要重启 Gateway，
不需要重装或重启 App Server，只启用微信或未配置渠道时变化不要求重启。微信为保留单次回复窗口预算
不发送任何操作过程事件（包括终态），该设置对微信没有效果。

`display.plan_updates` 是自动计划展示开关，默认开启；显式设为 `false` 可关闭。开启后只影响官方
`turn/plan/updated` 在 Telegram、飞书与 QQ 的展示，不影响 Core 保存最新计划，也不切换 `/plan` 协作模式；
微信不展示结构化计划。与 `display.operation_updates` 相同，只有启用 Telegram、飞书或 QQ 时变化才要求
重启 Gateway。

上游模型是否能够产生这些通知由 Codex 用户配置的 `tools.update_plan.enabled` 控制，默认关闭；通过
`codexc config → Codex 新会话与用户偏好 → 计划清单工具` 修改。该设置写入 `~/.codex/config.toml`，与 Gateway
的 `display.plan_updates` 分开管理；`codexc update` 会在合同预检时提示当前状态，`codexc doctor` 只读诊断该项。
变化由新建或重新加载的 Codex Thread 读取；当前已加载的 Thread 保持不变，不需要重启 Gateway 或 App Server。

`display.reasoning` 是“思考中”状态展示开关，默认关闭；显式设为 `true` 时 Telegram、飞书和 QQ 发送
思考状态，微信继续不主动发送，其余输出保持不变。启用 Telegram、飞书或 QQ 时变化需要重启 Gateway，
不需要重启 App Server；只启用微信或未配置渠道时不要求重启。

`logging.level` 是全局日志级别；`debug` 与 `trace` 同时启用全局调试模式，`info`、`warn`、
`error` 和 `fatal` 关闭调试模式。调试模式允许各模块记录受约束的类型、阶段、耗时和结果；
消息正文、请求参数、上游响应、凭据和审批内容
仍不得进入日志。可通过 `codexc config` 的“高级设置 → 日志等级”选择完整等级，变化需要重启
Gateway，不需要重启 App Server。

Plugin 查询与调用不再读取 Gateway 配置开关；共享严格 Schema 拒绝旧的
`experimental.plugin_api` 及 `[experimental]` 表，不自动忽略或迁移，结构校验失败时不补全或改写原文件。
升级前的配置备份、显式清理及回退步骤集中见[使用指导](../../docs/user-guide.md#3-初始化与配置)。

`scheduled_tasks.enabled` 控制 Gateway 计划任务执行层，默认关闭。开启时才创建独立私有
`scheduled-tasks.sqlite3`、恢复既有 Run 并启动领取循环；关闭时不创建数据库，也不接管普通
Thread 的 Server Request。变化需要重启 Gateway，不需要重装或重启 App Server。

`conversation.idle_release_minutes` 控制渠道会话自动解除 Thread 绑定的全局空闲阈值，默认
15 分钟，允许范围为 0–1440，0 表示关闭。所有渠道统一使用该值；用户消息、渠道命令、
平台本地命令、审批与输入交互、流式回复、完成卡片或其他带目标会话的输出都会刷新活动时间；
0 只关闭渠道会话自动解除；无任何绑定时的全局空闲释放仍会停止未被租约占用的 App Server。
正在后台恢复或 Provider 断线的 Thread 会被跳过，避免与订阅恢复竞态。Gateway 每 60 秒检查一次前台绑定，
只有活动 Turn、原生 Queue、待处理交互或待结算子代理运行时才强行保留并刷新活动时间；释放前
会取消 App Server 订阅，将前台解绑、未绑定会话模型偏好和“下一条普通消息必须新建 Thread”标记
原子写入，再清理旧的 Revert/Queue 选择；模型偏好在重启后继续沿用。普通消息只能开启新会话，提示会直接显示
`/r <Thread ID>`，显式执行该命令
才能恢复旧 Thread。配置为 0 时不会创建定时器、活动订阅或记录活动状态；变化需要重启 Gateway，
不需要重启 App Server。全局空闲释放每 60 秒复检一次，会在关闭 Client 后停止监管入口中未被租约
占用的运行实例（含主实例和仅由 `codexc remote` 启动的实例）；服务进程保持运行，后续使用按需启动。

Thread 分区使用当前固定分区与置顶设置；严格 Schema 拒绝 `[thread_sections]` 等未定义字段。

`[[workspaces]]` 只支持 `id`、`name`、`cwd`。沙箱、审批策略和 Permission Profile 由 App Server
原生配置与 Thread 状态负责；Gateway 不保存全局 `codex.sandbox` 或工作区权限覆盖。
严格 Schema 拒绝这些旧字段，不静默迁移；备份、显式清理和回退步骤见用户指南。

模型统计代理由 App Server 服务自动装配：主 Provider 随服务启动，切换 Provider 在首次使用时
按需启动，不属于用户配置；其上游网络请求继续复用 Codex `.env`、标准环境变量与受支持系统代理的统一解析结果，不接受旧 `[network]` 表。
`codex.default_model` 只覆盖当前主 Provider 的渠道新会话默认模型；模型不在该 Provider 目录中时
明确报错，不按同名模型回退到其他 Provider。

`metrics.storage.retention_days` 与 `metrics.storage.max_rows` 控制独立请求指标库的自动清理，
默认分别为 365 天和 1,000,000 行，允许范围为 1–3650 天、1,000–10,000,000 行；达到任一上限
后删除最旧记录。变化需要重启 Gateway，不改变 SQLite Schema；手工立即清理使用
`codexc cleanup metrics`，该命令先创建私有备份。

`codexc config` 统一管理 Codex 新会话与用户偏好，以及以上严格 Schema 已支持且适合日常操作的
Gateway 设置，并提供不显示凭据、令牌或代理值的配置总览。Codex 设置入口不依赖 Gateway 配置已经
初始化或可解析；选择 Gateway 设置时仍会明确报告对应配置错误。需要重建渠道连接的变化在后台 Gateway 运行时自动重启，未运行时在下次
启动生效，前台进程需重新启动；
显式网络代理写入 Codex `.env`，保存后按激活提示运行 `codexc restart all`，运行时重新读取
代理配置，无需重建服务定义。Codex 官方与第三方 Provider 配置仍由 `codexc setup` 管理。

飞书配置表当前只定义私聊 Surface 所需的 `enabled`、`app_id`、`app_secret` 和
`allowed_open_ids`。整表缺失或 `enabled = false` 时运行配置不包含飞书账号；启用时四项必须
同时有效，Open ID 不得重复。群 Chat、`@Bot` 和其他未支持字段仍由严格 Schema 拒绝。
启用状态或凭据变化需要重启 Gateway，允许 Open ID 集合可热加载；允许名单收窄时同时清理该飞书
账号下已撤权 Actor 的绑定。

微信 Setup 在最终确认保存后写入已启用的 `weixin` 表，只包含 `enabled`、账号 ID 和允许用户 ID；Bot Token
位于独立安全凭据后端。整表缺失或 `enabled = false` 时运行配置不包含微信账号；显式启用后
账号或启用状态变化需要重启 Gateway；允许用户新增可热加载，允许名单收窄需要重启 Gateway，
并在重新组合 Surface 时清理被撤权 Actor 的绑定和 App Server 订阅。
