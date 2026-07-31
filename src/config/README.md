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

`network` 表由 Telegram、飞书和微信共用，按显式 TOML、标准代理环境变量、受支持系统代理的
顺序合并；Bootstrap 再按每个请求的目标协议和 `NO_PROXY` 选择直连或 HTTP(S) 代理。Telegram
私有 `proxy_url` 只覆盖 Telegram，并优先于共享代理和 `NO_PROXY`。项目不修改系统代理，也不
安装、配置或重启 sing-box；仅 SOCKS `ALL_PROXY` 仍不受 HTTP(S) 客户端支持。

`display.operation_updates` 是 Telegram、飞书与微信共用的操作过程显示模式：`full` 显示完整详情、
状态、耗时和退出码，`compact` 显示单行状态、耗时、退出码和最多 160 个字符的详情摘要，
`hidden` 抑制 `operation.updated` 的平台输出。默认值为 `compact`，旧布尔字段由严格 Schema 拒绝。
三种模式都不影响审批、错误、最终回复和 Turn 完成事件；变化需要重启 Gateway，不需要重装或
重启共享 App Server。微信只发送终态操作，不发送 `running` 更新。

`display.plan_updates` 是自动计划展示开关，默认关闭。开启后只影响官方
`turn/plan/updated` 的平台展示，不影响 Core 保存最新计划，也不切换 `/plan` 协作模式。
变化需要重启 Gateway，不需要重启共享 App Server。

飞书配置表当前只定义私聊 Surface 所需的 `enabled`、`app_id`、`app_secret` 和
`allowed_open_ids`。整表缺失或 `enabled = false` 时运行配置不包含飞书账号；启用时四项必须
同时有效，Open ID 不得重复。群 Chat、`@Bot` 和其他未支持字段仍由严格 Schema 拒绝。
启用状态或凭据变化需要重启 Gateway，允许 Open ID 集合可热加载；允许名单收窄时同时清理该飞书
账号下已撤权 Actor 的绑定。

微信 Setup 写入默认禁用的 `weixin` 表，只包含 `enabled`、账号 ID 和允许用户 ID；Bot Token
位于独立安全凭据后端。整表缺失或 `enabled = false` 时运行配置不包含微信账号；显式启用后
账号或启用状态变化需要重启 Gateway；允许用户新增可热加载，允许名单收窄需要重启 Gateway，
并在重新组合 Surface 时清理被撤权 Actor 的绑定和 App Server 订阅。
