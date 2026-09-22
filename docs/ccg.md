# CCG（CommandCode）

CCG 是 CommandCode 的受管 Responses Provider，Provider ID 为 `ccg`。
上游地址为 `https://api.commandcode.ai/provider/v1`，使用 CommandCode API Key，
关闭 Responses WebSocket，沿用第三方 Provider 的一次 HTTP 重试、零次流重连。
接口与认证参考 [CommandCode Provider 文档](https://commandcode.ai/docs/provider)。

## 接入与模型设置

运行 `codexc setup → 模型与提供商 → 第三方 Provider → CCG（CommandCode）`：

1. 选择切换模式或固定模式。
2. 输入 CommandCode API Key。
3. 从 DS 官方下载完整模型目录，生成 CCG 目录后选择默认模型。
4. 运行 `codexc service restart all`，之后通过渠道 `/model` 选择 CCG 模型。

目录以 DS 官方 `models.json` 完整内容为基础，保留 Flash、Pro，并复制 Flash 的全部字段，
仅修改 `slug` 和 `display_name`，增加 `DeepSeek V4.1 Flash`。DS 自身的目录保持原样。
CCG 的模型 ID 按 [`provider-model-catalog.json`](../provider-model-catalog.json) 映射为
`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro` 与 `deepseek/deepseek-v4.1-flash`。
4.1 的提供商前缀见 [CommandCode 官方模型页](https://commandcode.ai/models/deepseek-v4-1-flash)。
思考等级、工具、提示词、上下文与输入能力均复用 DS Flash 内容；这不代表已通过 4.1 的真实 API 联调。
不请求 CommandCode `/models` 生成能力配置。写入前会在临时目录调用本机 Codex CLI 校验完整格式；
生成目录上限为 2 MiB，校验失败不会写入受管配置。

后续通过 CCG 菜单的“修改默认模型与思考等级”或“受管 Provider 模型设置”调整默认值，
通过“模型上下文窗口”调整窗口占比。重新配置及 `codexc update` 会从 DS 获取最新基础目录，
重新生成 CCG 文件并保留仍有效的逐模型设置；更新不会自动切换到新增的 4.1。
新目录必须仍支持共享第三方子代理当前的模型和思考等级，否则先切换或停用该角色再导入。

## 文件与运行模式

- 切换模式 Profile：`~/.codex/sf-ccg.config.toml`，保留主配置。
- 模型目录：`~/.codex-connect/providers/ccg/models.json`。
- 目录来源记录：同目录 `models.manifest.json`。
- 管理标记：同目录 `managed.toml`。
- 本次安装前的主配置备份：同目录 `backup/config.json`。

固定模式会在明确确认后备份并修改 Codex 主配置；切换模式使用独立受管 App Server，
共享 TUI 入口为 `codexc remote --profile sf-ccg`。API Key 保存在 0600 私有配置，
只注入目标 App Server 子进程，不进入命令行参数或 Gateway TOML。
删除入口移除 CCG 受管文件；固定模式仅恢复相关 Provider 设置，保留备份和其他设置。
删除后重新安装会以当时的主配置建立新备份，旧备份保留为 `backup/config-<UUID>.json`；
同一次安装中的重新配置和模式切换继续使用该次安装的原始备份。
正在被共享第三方子代理使用时，先切换或停用该角色再删除。
已配置 CCG 的原始备份缺失时，重新配置会报错，需先恢复原始备份。

CCG 复用现有按需启动、Provider 路由、模型设置及本地请求指标；当前为单个受管实例。
配置生成与 OCG 共用 `managed-model-provider-setup.mjs`，文件事务共用
`managed-provider-files.mjs`；账户行为与目录适配保留各自实现。
不自动创建 `agents.external`；可通过现有共享第三方子代理入口显式选择 CCG。
没有接入官方余额或配额接口，账户查询明确显示不支持；本地 Token 与请求指标仍按 `ccg` 隔离。

本地配置、模型目录、运行参数和回滚由 [`ccg-setup.test.ts`](../tests/ccg-setup.test.ts) 验证。
实际付费请求、上游工具调用与压缩仍需使用账户 Key 完成联调，文件能力声明不代表这些合同已通过。
