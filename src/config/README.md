# Config

本目录负责把共享运行时已完成结构校验的 TOML 文档转换为 Gateway 运行配置。

## 文件

- `index.ts`：读取统一 TOML 配置，调用 `runtime/gateway-config.mjs` 的共享 Zod Schema 完成结构校验，再校验 Workspace 和 URL 等运行语义、合并自动发现的有效代理，并相对配置目录规范化路径；全部校验成功后，原子补入当前 Schema 缺失的安全默认字段。
- `config-change.ts`：定义结构化配置变更、作用域与优先级。
- `reload-classifier.ts`：比较两份已验证配置，完整列出变化，并按热加载、Gateway 重启或服务重装
  的最高要求分类。

配置结构只在共享运行时边界验证一次，本目录只补充依赖文件系统和运行语义的校验。Gateway
读取前要求配置是当前用户拥有的非符号链接普通文件，且组和其他用户无权访问；配置父目录必须
由当前用户拥有并禁止组或其他用户写入。配置错误必须抛出 `ConfigurationError` 并阻止启动，
不能静默采用更宽松的权限、目录或网络默认值。
运行配置中的安全凭据目录固定由配置文件父目录派生，与可自定义的 SQLite 数据库路径相互独立。
默认字段补齐只添加当前严格 Schema 已声明的缺失默认值，不覆盖已有配置，不补渠道凭据、身份或
允许名单，也不处理未知字段或不受支持的版本。运行语义校验失败、文件发生并发修改或原子写回失败时
不得修改原配置，并以配置错误失败关闭。

Telegram、飞书和微信至少需要启用一个。Telegram 表可缺失；`bot_token` 缺失或空白时运行配置
将其视为未启用，不创建 Telegram Surface，也不要求允许用户列表。Token 非空时
`allowed_user_ids` 必须至少包含一个正整数。飞书和微信继续以各自的 `enabled` 字段决定是否启用。

`network` 表由 Telegram、飞书和微信共用，按显式 TOML、标准代理环境变量、受支持系统代理的
顺序合并；Bootstrap 再按每个请求的目标协议和 `NO_PROXY` 选择直连或 HTTP(S) 代理。Telegram
私有 `proxy_url` 只覆盖 Telegram，并优先于共享代理和 `NO_PROXY`。项目不修改系统代理，也不
安装、配置或重启 sing-box；仅 SOCKS `ALL_PROXY` 仍不受 HTTP(S) 客户端支持。

`display.operation_updates` 是 Telegram、飞书与微信共用的操作过程显示模式：`full` 显示完整详情、
状态、耗时和退出码，`compact` 显示单行状态、耗时、退出码和最多 160 个字符的详情摘要，
`hidden` 抑制 `operation.updated` 的平台输出。默认值为 `compact`，旧布尔字段由严格 Schema 拒绝。
三种模式都不影响审批、错误、最终回复和 Turn 完成事件；变化需要重启 Gateway，不需要重装或
重启 App Server。微信只发送终态操作，不发送 `running` 更新。

`display.plan_updates` 是自动计划展示开关，默认开启；显式设为 `false` 可关闭。开启后只影响官方
`turn/plan/updated` 的平台展示，不影响 Core 保存最新计划，也不切换 `/plan` 协作模式。
变化需要重启 Gateway，不需要重启 App Server。

`display.price_currency` 统一控制渠道与指标输出使用人民币或美元。人民币显示依赖 Gateway 持有的
汇率刷新组件，因此币种变化需要重启 Gateway，不需要重启 App Server。

`logging.level` 是全局日志级别；`debug` 与 `trace` 同时启用全局调试模式，`info`、`warn`、
`error` 和 `fatal` 关闭调试模式。调试模式允许各模块记录受约束的类型、阶段、耗时和结果，并在
渠道中展示 `/vision` 接收与 Gateway 处理耗时；消息正文、请求参数、上游响应、凭据和审批内容
仍不得进入日志。可通过 Setup 的“系统设置 → 调试模式”在 `debug` 与 `info` 间切换，变化需要
重启 Gateway，不需要重启 App Server。

`experimental.plugin_api` 控制 Codex 0.147.0 开发中 Plugin 调试入口，默认关闭；未显式开启时
`/plugin` 的列表与调用在 Application 边界失败关闭，不发送 `plugin/installed` 或 mention
请求。变化需要重启 Gateway，不需要重启 App Server；Doctor 始终显示开关状态与风险提示。

`thread_sections.administrators` 是全局 Thread 分区写操作的 Actor 允许名单，条目格式为
`telegram:<用户 ID>`、`feishu:<open_id>` 或 `weixin:<用户 ID>`。默认空数组；未配置时
`/section` 只允许列表和会话筛选，新建、重命名、移动、移出与删除失败关闭。每个管理员必须属于
对应已启用渠道的用户允许名单，否则配置校验失败。变化需要重启 Gateway。

`[[workspaces]]` 除 `id`、`name`、`cwd` 外支持可选的工作区权限：`sandbox`（
`read-only` / `workspace-write` / `danger-full-access`）、`approval_policy`（
`untrusted` / `on-request` / `never`）和 `permissions`（App Server 命名权限 Profile）。
`permissions` 与 `sandbox` 必须互斥，同时配置时失败关闭。权限只作用于该 Workspace 新建或
恢复的 Thread 启动参数，不影响已绑定 Thread；权限变化按 `workspace.registry` 热加载，不要求
重启 Gateway。`danger-full-access` 和 `never` 是显式放开的完全权限选项，仅应在明确可信的
Workspace 上配置。

模型统计代理由 App Server 服务按已启用 Provider 自动装配，不属于用户配置；其上游网络请求继续
复用 `network` 与标准代理环境变量。

`metrics.storage.retention_days` 与 `metrics.storage.max_rows` 控制独立请求指标库的自动清理，
默认分别为 365 天和 1,000,000 行，允许范围为 1–3650 天、1,000–10,000,000 行；达到任一上限
后删除最旧记录。变化需要重启 Gateway，不改变 SQLite Schema；手工立即清理使用
`codexc metrics cleanup`，该命令先创建私有备份。

`api_providers` 保存多个直接 API 调用使用的 Responses 提供商 ID、名称和精确 HTTPS Endpoint；
API Key 由 Setup 按提供商保存到独立私有凭据文件。它们不属于 Codex `modelProvider`，不接入
App Server 或 `/model`。`vision.mode` 默认为 `disabled`；`responses_api` 只保存提供商引用和
视觉模型，引用不存在时配置失败关闭。提供商或视觉配置变化需要重启 Gateway，不需要重启
App Server；配置文件不保存 API Key。

飞书配置表当前只定义私聊 Surface 所需的 `enabled`、`app_id`、`app_secret` 和
`allowed_open_ids`。整表缺失或 `enabled = false` 时运行配置不包含飞书账号；启用时四项必须
同时有效，Open ID 不得重复。群 Chat、`@Bot` 和其他未支持字段仍由严格 Schema 拒绝。
启用状态或凭据变化需要重启 Gateway，允许 Open ID 集合可热加载；允许名单收窄时同时清理该飞书
账号下已撤权 Actor 的绑定。

微信 Setup 写入默认禁用的 `weixin` 表，只包含 `enabled`、账号 ID 和允许用户 ID；Bot Token
位于独立安全凭据后端。整表缺失或 `enabled = false` 时运行配置不包含微信账号；显式启用后
账号或启用状态变化需要重启 Gateway；允许用户新增可热加载，允许名单收窄需要重启 Gateway，
并在重新组合 Surface 时清理被撤权 Actor 的绑定和 App Server 订阅。
