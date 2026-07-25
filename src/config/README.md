# Config

本目录负责把共享运行时已完成结构校验的 TOML 文档转换为 Gateway 运行配置。

## 文件

- `index.ts`：读取统一 TOML 配置，调用 `runtime/gateway-config.mjs` 的共享 Zod Schema 完成结构校验，再校验 Workspace 和 URL 等运行语义、合并自动发现的有效代理，并相对配置目录规范化路径。
- `config-change.ts`：定义结构化配置变更、作用域与优先级。
- `reload-classifier.ts`：比较两份已验证配置，完整列出变化，并按热加载、Gateway 重启或服务重装
  的最高要求分类。

配置结构只在共享运行时边界验证一次，本目录只补充依赖文件系统和运行语义的校验。配置错误必须抛出 `ConfigurationError` 并阻止启动，不能静默采用更宽松的权限、目录或网络默认值。

飞书配置表当前只定义阶段 1 私聊所需的 `enabled`、`app_id`、`app_secret` 和
`allowed_open_ids`。整表缺失或 `enabled = false` 时运行配置不包含飞书账号；启用时四项必须
同时有效，Open ID 不得重复。群 Chat、`@Bot` 和其他阶段 2 字段仍由严格 Schema 拒绝。
启用状态或凭据变化需要重启 Gateway，允许 Open ID 集合可热加载；允许名单收窄时同时清理该飞书
账号下已撤权 Actor 的绑定。
