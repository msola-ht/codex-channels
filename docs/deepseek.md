# DeepSeek 多账户

DeepSeek 账户使用独立 API Key、Profile 和按需启动的 App Server。同一批 DS 账户共用
DS 官方模型目录，OCG、CCG 的目录及增量模型保持独立。官方 `deepseek-flash` 已指向 V4.1 Flash，
DS 不另造 `deepseek-v4.1-flash` 模型 ID。

## 配置与移除

在 `codexc setup → 模型与提供商 → 第三方 Provider → DeepSeek 官方` 管理账户，
也可在 WebUI 账户设置中操作，或使用以下命令：

```bash
codexc deepseek account add work           # 新增账户，交互输入模式和 Key
codexc deepseek account reconfigure work   # 重新配置已有账户
codexc deepseek account list --json        # 列出账户与默认标记，不包含 Key
codexc deepseek account default work       # 选择默认账户
codexc deepseek account remove personal    # 确认后删除账户配置
codexc restart all                 # 应用配置变化
```

账户 ID 必须由用户填写，使用 1–32 位小写字母、数字、`-` 或 `_`，不自动创建 `main`。
首个账户标记为默认，后续可手动修改。不同 ID 不能生成相同的凭据环境变量名。
仅支持当前多账户格式。删除固定模式账户时只恢复该 Provider 管理的主配置字段，保留安装前备份与历史统计；Remote TUI 正在使用该实例时须先退出。写入失败会回滚本次文件变更。

请求与指标按精确的 `ds-<账户>` 身份归属，只恢复能映射到当前账户的 Thread。

## 文件与运行模式

| 文件 | 用途 |
| --- | --- |
| `~/.codex-connect/providers/deepseek/accounts.json` | 账户 ID 与默认标记，不含凭据 |
| `~/.codex/sf-ds-<账户>.config.toml` | 切换账户的模型、Provider 与私有 Key |
| `~/.codex-connect/providers/deepseek/accounts/<账户>/managed.toml` | 账户运行模式 |
| `~/.codex-connect/providers/deepseek/accounts/<账户>/backup/config.json` | 本次安装前的基础配置 |
| `~/.codex-connect/providers/deepseek/models.json` | 全部 DS 账户共用的官方模型目录 |
| `~/.codex-connect/providers/deepseek/models.manifest.json` | 目录来源和更新时间 |

切换模式保留 OpenAI 主配置，每个账户使用独立私有 Profile；固定模式在确认后修改 Codex
主配置，同一时刻只能有一个固定主 Provider。账户 Key 保存在 0600 私有配置中，仅进入目标
App Server 子进程，不进入账户注册表、命令行或日志。

删除账户保留历史统计和备份；仍有账户时保留共享模型目录，删除最后一个账户时清理目录。删除前检查并停止对应 App Server；Remote TUI
正在占用、监管状态异常或停止失败时，不删除账户文件。删除后该账户历史 Thread 将不可恢复。
若 RS 模型仍跟随 DS 上下文，删除最后一个账户前须先在 RS 设置关闭跟随；预览会列出阻止删除的 RS 提供商。
删除默认账户前需先选择其他默认账户；删除最后一个账户无需选择。
原生子代理继承父线程的 Provider，不独立绑定账户。固定账户删除或改为切换模式时
仅恢复受管 Provider 字段，保留其他主配置修改。删除后重新添加会建立新的恢复基线，旧备份归档保留。
切换账户每次进入固定模式时都会以当时主配置更新该账户的恢复基线，并把旧基线归档；固定模式内
重新配置继续使用本次进入时的基线。同一时刻仍只允许一个固定主 Provider，其他 DS 账户可保持切换模式。

## 模型与设置

DS 目录从官方安装脚本提取，不执行下载脚本。当前目录为 `deepseek-flash` 与
`deepseek-v4-pro`；实际选项以下载目录为准。新增账户复用已有 DS 目录，首次配置才下载；
模型目录由 Setup 配置，更新器不刷新目录。
已下线模型会切到目录默认模型，同时更新对应账户配置。
导入 DS 模板到自定义 Responses 或 CLP 时，目录自带的提示词（`model_messages.instructions_template`）随模型定义携带；deprecated 的顶层 `base_instructions` 只是旧客户端镜像，不单独保留。

通过账户菜单选择默认模型和思考等级，通过“模型上下文窗口”按模型名设置窗口比例。
账户分别选择默认模型；思考等级、上下文和能力字段存放在共享目录，同一模型的这些设置会影响
所有 DS 账户。切换 Profile 同步目录默认思考等级；原生角色独立保存自己的思考等级，目录更新不覆盖角色选择。
压缩使用上游默认，不写入独立自动压缩阈值。

切换账户的共享终端入口：

```bash
codexc remote --profile sf-ds-personal
```

聊天使用 `/model` 选择 `DS <账户>` 下的模型。同账户切模型保持 Thread，跨账户选择会保留并
解绑旧 Thread，下一条消息在目标账户新建 Thread，不复制历史。每个账户的 App Server 按需启动，
DS 账户共用一个统计代理，通过内部账户路径区分请求并上报到各账户指标 Socket。

## 网页搜索

2026-09-26 核对的官方 [Responses 兼容性说明](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)
将内置 `web_search` 列为忽略，[Codex 接入配置](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/)
也明确设置 `web_search = "disabled"`。早期版本的搜索实测不能代表当前模型支持。

Gateway 对 DS 官方、OCG、CCG、CLP 四个受管 DeepSeek 入口统一关闭内置网页搜索，
覆盖固定主实例和切换账户实例的启动参数；
渠道与 `codexc remote` 共用该实例。已有账户更新代码并重启 App Server 后生效，
无需重写基础配置或账户 Profile，也不改变 OpenAI 或自定义 Responses Provider 的搜索设置。
该限制不承诺覆盖绕过受管服务的独立 Codex 进程，亦不自动把搜索转交 OpenAI。

目录中的 `supports_search_tool` 是客户端工具检索能力，和内置网页搜索不同，继续保留官方值。
普通函数工具及 Codex 本地管理的 MCP 工具不因关闭网页搜索而被禁用。
历史 `web_search_call` 仍可随 `input` 回传，但不代表能发起新的内置搜索。

## Responses 兼容性边界

官方 API 无状态，不支持 `previous_response_id`、`conversation` 和响应存储，由 Codex 带回历史。
支持普通函数工具；自由格式 `custom` 只接受 `apply_patch`，不能把任意自定义工具都视为受支持。
`parallel_tool_calls` 参数被忽略，并行调用始终开启；`text.format` 支持，`text.verbosity` 不生效。
`reasoning.summary` 可传入但不生成摘要，推理历史使用下文的明文正文。
目录声明用于配置客户端，不替代上游 API 合同；Gateway 不把受忽略参数解释为已实现能力。

DS 目录生成时明确设置 `support_verbosity: false`、`default_verbosity: null`、
`supports_reasoning_summary_parameter: false` 和 `default_reasoning_summary: "none"`，
移除锁定 Codex 已不使用的 `supports_reasoning_summaries` 声明。保留完整思考正文、工具能力与提示词。
已有账户可通过 Setup 的“重新配置账户”或 `codexc deepseek account reconfigure <账户>` 应用；
复用本地目录，不重新下载，不重置模型、思考等级或上下文设置。共享目录会惠及同机所有 DS 账户，
写入失败按现有配置事务恢复原文件；完成后重启 App Server 生效。启动、Doctor 和源码更新器不隐式改写目录。

2026-09-26 隔离线上验证：`deepseek-flash`、`low` 思考等级连续 4 次 Responses 请求均成功，
依次覆盖客户端 `tool_search`、检索结果回传与命名空间函数调用、固定工具结果回传、下一轮用户输入。
工具未在本机执行；后续请求保留全部已返回的 `reasoning.content`，包括最终回答轮次的思考。
另以仅在 `tool_search_output` 中提供工具定义的两轮请求补测：明确要求调用后，
上游返回了对应命名空间的函数调用，确认不必在顶层重复声明已检索工具。
因此保留官方目录的 `supports_search_tool`，不因兼容性表未逐项列出便关闭客户端工具检索。
该验证不代表 OCG、CCG 接口也已验证，亦不覆盖所有模型或参数组合。

原生 Responses 把 `developer` 视同 `user`；CLP 的 Chat 适配将 `developer` 转成 `system`。
两条线路的指令角色语义不同；任意自由格式工具也不能从 CLP 的函数转换能力推导为 DS 原生支持。

## App Server 与 Thread

切换模式由同一个后台服务监管 OpenAI 主 App Server 和各账户隔离的 App Server。服务启动时只
启动主实例；原生子代理复用父线程所在 Provider 实例。首次选择 DeepSeek 模型、
恢复其 Thread 或使用 DeepSeek Remote TUI 时，监管入口才读取并校验私有 Profile，按需启动隔离
App Server。该账户 API Key 只进入需要它的 App Server 子进程环境，不进入命令行、服务定义或
日志；其他 Provider 的 Key 不会随之注入。

Gateway 根据 Thread 的 `modelProvider` 路由新建、恢复、Turn、Review、Goal、MCP 和审批请求。
跨 Provider 不能原地修改正在使用的 Thread，因此 `/model` 的跨 Provider 选择会：

1. 保留并解绑当前 Thread。
2. 在下一条消息中为目标 Provider 新建 Thread。
3. 不复制可能包含 Provider 专属 reasoning、工具结果或加密内容的历史。

同一账户的 Thread 可通过 `/resume` 恢复。同一 Provider 内切换模型时不新建 Thread，选择在下一次 Turn
生效。切换 Workspace、新会话或同 Provider 历史 Thread 时，渠道会在内存中保留当前模型、思考
等级和服务层级并用于下一 Turn。切换 Workspace 后下一条消息会新建 Thread，不自动接续目标 Workspace 的历史
Thread；显式恢复不同 Provider 的历史 Thread 时尊重该 Thread 的 Provider。
跨 Provider 新建 Thread 使用目标模型目录的默认思考等级；当前 DeepSeek 默认是 `high`。

任一 Provider 意外断开时，Gateway 只重连并恢复该侧绑定。任一受监管 App Server 子进程异常退出
时，App Server 服务会共同重建受监管实例；Gateway 全局空闲策略关闭 Client 不属于异常退出，
不会触发共同重建。

## 用量与运行统计

- `/status` 的 Token、有效上下文窗口、缓存和压缩次数来自当前 Thread，不代表账户余额。
- Turn 完成摘要按同一 Turn 的全部模型请求聚合请求结果、Token、缓存命中与压缩摘要，并在官方
  `Turn.durationMs` 可用时显示本轮总耗时；另显示已落库请求的平均首 Token 时间和请求平均输出速度，
  样本范围与缺失处理统一见[完成汇报](display.md#完成汇报)，不从转储补算。
- 官方返回的推理 Token 计数仍与所有 Provider 一样展示；指标库不保存推理正文；显式开启的模型调用转储可能保存原始内容，详见[转储说明](user-guide.md#模型请求转储)。
- OpenAI Fast 和周限不会显示在 DeepSeek Thread 上。
- `/usage` 在 OpenAI Thread 中显示 Codex Token 汇总，在 DeepSeek Thread 中调用官方余额接口。
- WebUI 控制台按 `ds-<账户>` 分别展示余额并逐账户刷新；默认标记来自 DS 注册表。
- `/metrics` 从独立指标库读取当前 Thread 最近 Turn 和整个 Thread 的请求累计；输入量是多次请求的
  累计值，不表示当前上下文占用。`/metrics providers|models|errors 24h|7d|30d|90d|all` 按统一口径聚合，
  不为 DeepSeek 建立专属统计表。Gateway 不在本地计算或估算 DeepSeek 价格与费用，`/metrics` 只展示
  请求、Token、异常和官方账户数据。
- `/limits` 当前只支持 OpenAI；DeepSeek 不会回退显示 OpenAI 限额。
- DeepSeek 不支持 Fast，执行 `/fast on` 或 `/fast off` 会明确拒绝。

## 推理历史回传

DeepSeek 官方账户使用原生 Responses API。Gateway 代理透传请求和响应，由 Codex 保存并在工具续跑及后续用户轮次的 `input` 中带回 `reasoning.content`，无需转换成 Chat 字段。
官方 [Responses 说明](https://api-docs.deepseek.com/zh-cn/guides/responses_api/)以 `reasoning_text` 正文承载推理，不接受以 `summary` 或 `encrypted_content` 替代。
官方 [思考模式说明](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)中的 `reasoning_content` 要求针对 Chat API：携带 `tools` 时必须回传历史各轮推理，没有 `tools` 时该字段会被忽略。
CLP 的 Chat 转换和字段保留方式见 [Cline Pass](cline-pass.md)。本地压缩之后，以 Codex 实际保留的上下文为准，Gateway 不另存历史或补造已丢弃的推理。

## 图片识别

`deepseek-flash` 原生接受当前渠道校验后的 PNG/JPEG/WebP/非动画 GIF 图片，并通过现有 App Server
Turn 输入处理；项目仍采用更严格的最多四张、单张 10 MiB、整批 20 MiB 边界，不开放图片 URL、
Files API 或其他图片入口。图片 Token 由 DeepSeek 按尺寸换算并随标准 Usage 返回，Gateway
继续使用上游 Usage 统计，不自行按像素估算。

Pro 仍为文字模型，收到图片时会在 Turn 前明确拒绝；需要看图时使用 `/model` 切换到
`deepseek-flash`。Gateway 不再把图片转交给另一套外部视觉 API。


固定模式下，DeepSeek 代理服务于主 App Server；切换模式按需启动。原生子代理复用父线程所在实例与统计代理。代理支持项目当前使用的
HTTP/SSE、Responses WebSocket、压缩和模型目录请求，复用统一网络代理，并保留用户已有的
`openai_base_url` 上游。认证 Header、请求正文和响应正文只做内存转发，不写入指标或日志。
Gateway 停止或重启时计时指标可能丢失，但模型请求不会因此中断。

## 应用配置

完成安装、更新 API Key、切换模式或恢复后，从本机终端运行：

```bash
codexc restart all
codexc doctor
```

渠道内不能重启 App Server。需要检查运行状态时使用：

```bash
codexc status all
codexc logs all -n 200
```
