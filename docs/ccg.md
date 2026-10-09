# CCG（CommandCode）

CCG 是 CommandCode 的受管 Responses Provider，支持在同一 Gateway 中配置多个账户。
每个账户使用显式 ID，Provider ID 为 `ccg-<accountId>`。
上游地址为 `https://api.commandcode.ai/provider/v1`，使用 CommandCode API Key，
关闭 Responses WebSocket，沿用第三方 Provider 的一次 HTTP 重试、零次流重连。
接口与认证参考 [CommandCode Provider 文档](https://commandcode.ai/docs/provider)。

## 接入与模型设置

运行 `codexc setup → 模型与提供商 → 第三方 Provider → CCG（CommandCode）`：

1. 选择切换模式或固定模式。
2. 填写账户 ID 并输入该账户的 CommandCode API Key。
3. 首个账户从 DS 官方下载完整模型目录并生成共享 CCG 目录；后续账户直接复用该目录，再分别选择默认模型。
4. 运行 `codexc restart all`，之后通过渠道 `/model` 选择 CCG 模型。

目录以 DS 官方 `models.json` 完整内容为基础，保留 Flash、Pro，并复制 Flash 的全部字段，
仅修改 `slug` 和 `display_name`，增加 `DeepSeek V4.1 Flash`。DS 自身的目录保持原样。
CCG 的模型 ID 按 [`provider-model-catalog.json`](../provider-model-catalog.json) 映射为
`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro` 与 `deepseek/deepseek-v4.1-flash`。
4.1 的提供商前缀见 [CommandCode 官方模型页](https://commandcode.ai/models/deepseek-v4-1-flash)。
思考等级、工具、提示词、上下文与输入能力均复用 DS Flash 内容；这不代表已通过 4.1 的真实 API 联调。
不请求 CommandCode `/models` 生成能力配置。写入前会在临时目录调用本机 Codex CLI 校验完整格式；
生成目录上限为 2 MiB，校验失败不会写入受管配置。

配置账户后，可用“管理共享模型（添加／启用／更新）”添加该上游实际支持的 Responses 模型、选择启用名单或显式刷新 DS 模板。手填时须确认准确模型 ID、上下文、思考等级、图片和工具能力；新增模型使用共享通用编程提示词，不从 Cline 目录猜测 CommandCode 的能力。所有账户和聚合共用最多 64 个启用模型，账户当前默认模型不可停用；须先调整默认设置。未勾选的条目从目录移除，重新启用需重新导入模板或填写模型。

保存前校验目录与所有账户默认值，备份 `models.json` 和 `models.manifest.json` 为同目录 `.backup`，再事务写入；取消、无效输入和可恢复写入失败保留原目录，并发冲突失败关闭。来源文件标记本次为用户配置。手工回退时先停止使用该目录的客户端和相关服务，成对恢复最近一次备份，再重启；按保存后的提示激活。账户增删或 Key 更新不会静默刷新目录。

后续通过 CCG 菜单的“修改默认模型与思考等级”或“默认模型与思考等级”调整默认值，
通过“模型上下文窗口”调整窗口占比。模型目录由 Setup 配置，更新器不刷新目录。
同一目录中引用某模型的账户 Profile 同步该模型的默认思考等级；选择其他模型的账户保留各自模型等级。
新目录不再包含账户默认模型时明确失败。

账户移除命令为 `codexc provider ccg remove <id>`，确认后移除该账户 Key 和运行配置，保留安装前备份及历史统计。
固定模式恢复原有主配置字段；Remote TUI 正在使用时须先退出。
仅支持当前多账户格式。

## 文件与运行模式

- 账户注册表：`~/.codex-connect/providers/ccg/accounts.json`。
- 切换模式 Profile：`~/.codex/sf-ccg-<账户>.config.toml`，每个账户独立保存 Key 和默认模型。
- 账户管理标记：`~/.codex-connect/providers/ccg/accounts/<账户>/managed.toml`。
- 账户安装前备份：`~/.codex-connect/providers/ccg/accounts/<账户>/backup/config.json`。
- 模型目录：`~/.codex-connect/providers/ccg/models.json`。
- 目录来源记录：同目录 `models.manifest.json`。

固定模式会在明确确认后备份并修改 Codex 主配置；切换模式使用独立受管 App Server，
共享 TUI 入口为 `codexc remote --profile sf-ccg-<账户>`。API Key 保存在对应账户的私有文件（Unix `0600`，Windows 私有 ACL），
只注入目标 App Server 子进程，不进入命令行参数或 Gateway TOML。
固定 Key 使用[独立私有版本与主配置 `env_key` 引用](provider-integration-guide.md#4-安全边界)，不写入共享主配置；旧明文配置须明确重新配置账户。
删除账户会移除其 Profile 和管理标记；固定模式仅恢复相关 Provider 设置，保留备份和其他设置。
删除前检查并停止对应 App Server；Remote TUI 正在占用、监管状态异常或停止失败时，不删除账户文件。删除后该账户历史 Thread 将不可恢复，历史统计保留。
删除最后一个账户时清理共享模型目录。删除默认账户前需先选择其他默认账户。
删除后重新安装会以当时的主配置建立新备份，旧备份保留为 `backup/config-<UUID>.json`；
切换模式账户每次进入固定模式时，都会以当时的主配置更新恢复基线并归档旧备份，避免恢复其他账户
已经退出的固定配置。固定模式内重新配置以及退出固定模式继续使用本次进入固定模式时的恢复基线。
原生子代理继承父线程的 Provider，不独立绑定账户；本项目不提供跨 Provider 子代理配置入口。
已配置 CCG 的原始备份缺失时，重新配置会报错，需先恢复原始备份。

当 OpenAI 官方未登录、已配置的第三方切换实例全部属于 CCG 时，新 Conversation 与未显式指定 Profile 的
`codexc remote` 使用注册表标记的默认账户；混合配置其他 Provider 时仍需显式选择。

当前 DeepSeek 模型不支持内置网页搜索；固定与切换模式均在受管 App Server 启动参数中关闭，
不改写基础配置。普通函数工具及 MCP 工具不受影响，见 [网页搜索边界](deepseek.md#网页搜索)。

## 账户额度

当前 Thread 使用 CCG 时，`/usage` 使用该 `ccg-<账户>` 的私有 Key 查询 Command Code 官方 CLI
当前使用的 `GET /alpha/whoami?limits=1` 与 `GET /alpha/billing/credits`。前一个接口只用于取得组织 ID，
后一个接口归约计划 ID、月度 Credits、额外充值、赠送余额，以及可用的 5 小时和 7 天窗口。
两个接口与 Provider 模型请求复用同一个账户 API Key；官方 CLI 的手动 Key 登录同样先用
`/alpha/whoami` 校验，不需要额外保存账户查询凭据。WebUI 控制台按账户分别展示 Credits 与窗口，
并支持与 DS、OCG 相同的逐账户刷新。
请求与其他账户适配器一样经过统一代理、10 秒超时、64 KiB 响应上限和严格 Schema 校验；失败只返回
稳定的“CCG 账户查询失败”，不传播 Key、响应正文或解析错误。身份响应必须确认成功，组织信息无效时
不继续查询个人额度；Credits 对象缺失或窗口结构无效时保留上次有效快照，不写入零余额。
有效 Credits 对象内缺失或为 `null` 的余额项按官方 CLI 视为零，总余额先求和再保留两位小数。

这些账户端点未列在公开的 [CommandCode Provider 文档](https://commandcode.ai/docs/provider) 中；本次
实现按官方 `command-code` CLI 1.62.1 的调用方式适配。当前没有可用 API Key，尚未执行真实账户请求。
上游调整 Alpha 接口后，
查询会明确失败，不影响模型请求和本地 `/metrics`。

CCG 复用现有按需启动、Provider 路由、模型设置及本地请求指标。每个账户拥有独立 App Server、
凭据和指标 Provider；全部账户共享一个统计代理，内部账户路径负责把请求归入对应 `ccg-<账户>`。
配置生成与 OCG 共用 `managed-model-provider-setup.mjs`，文件事务共用
`managed-provider-files.mjs`；账户行为与目录适配保留各自实现。
账户 Credits 与额度窗口按账户查询；本地 Token 与请求指标按 `ccg-<账户>` 隔离。

实际付费请求、上游工具调用与压缩仍需使用账户 Key 完成联调，文件能力声明不代表这些合同已通过。
