# CLP（Cline Pass）

通过 `codexc setup` → 模型与提供商 → 第三方 Provider → Cline Pass 官方配置。
支持多个 CLP 账户，各账户使用独立 API Key，支持固定与切换模式。首次配置从 Cline 官方目录生成 Codex 多模型目录；勾选 Flash 时优先作为默认，否则以所选模型在官方目录中的第一项作为默认，CLI 保存前明确显示。
Setup 和 WebUI 设置页均可添加、重新配置、设置默认及移除账户。账户 ID 为 1–32 位小写字母、数字、`-` 或 `_`；映射后凭据变量名相同的 ID 不可同时使用，例如 `a-b` 与 `a_b`。
Flash 的上下文、图片、思考等级与提示词复用 DS 的 `deepseek-flash`：优先读取本地 DS 目录，缺失时读取官方安装脚本中的目录并与 Cline 配置一并保存为本地共享 DS 模板，不执行脚本，无需手填上下文；目录自带的提示词（`model_messages.instructions_template`）随模板带入 Flash。其他模型使用 Cline 声明的各自上下文、图片能力、思考控制和通用编程提示词，不复制 DS 能力。
保留 Cline 已验证的 `none` 思考等级和 Chat 转换边界，不复制原生搜索等服务端能力。
通过“模型上下文窗口”统一修改 `deepseek-flash`，同步 DS、同名受管模型、CLP 和已启用 DS 跟随的第三方自定义模型；不同模型不联动思考等级。
所有 Cline 账户共享同一份 Codex 模型目录。独立 Relay 可下载／更新 Cline 模型文件，并按账户设置[独立模型目录和思考策略](provider-api-relay-development.md#clp-转发模型目录与设置)，不写入 Codex 目录。添加账户或更新密钥保留已有上下文及思考等级；调整上下文仍使用统一的模型窗口设置。

已有账户通过 `codexc setup → 模型与提供商 → 第三方 Provider → Cline Pass 官方 → 选择启用模型／更新共享目录` 扩展或更新模型，无需删除账户、重新输入 Key。空格勾选、回车确认，再预览最终名单并保存；默认勾选当前启用项，新增模型不自动勾选。首次在 CLI 配置时也提供多选，Flash 可用时默认勾选它，但允许只选择其他模型；已有账户新增或更换 Key 沿用共享名单。所有 CLP 账户与聚合共用选择，未勾选项不进入运行时目录。账户当前默认模型必须保留；要停用它，先在模型设置中更换默认模型。取消多选或放弃保存不会写入配置。WebUI 首次配置仍生成完整的受支持目录，启用名单在 CLI 调整。

未启用 Flash 时，新增账户和刷新目录不读取、下载或要求 DS 模板，也不要求 Cline 目录包含 Flash。重新启用 Flash 时才校验或下载 DS 模板，缺失模板与 CLP 目录在同一次事务中保存；失败保留原目录。

CLP 自动审查不再受本地审批模型白名单限制；模型仍须符合正常目录与路由要求。
审查沿用现有 Chat 桥和 Codex 审批机制，失败不会自动放行；各远端模型的兼容性须以实际执行为准。
默认设置见[审批方式](user-guide.md#审批方式手动审批与自动审查auto-review)。

停用会同时约束普通 CLP 与聚合的后续请求。普通 CLP 桥每次出站前安全读取当前共享目录：模型不在启用名单中返回 `409 clp_model_disabled`，目录缺失、模型集合结构无效或无法安全读取时返回 `503 clp_catalog_unavailable`，均不请求上游。旧 Thread 或原生客户端显式指定停用模型也会被拒绝，须重新选择已启用模型，不自动换模型。已经发往上游的请求不强行中断；聚合另保留已有快照变更拒绝与安全刷新机制。重新启用后普通桥无需重启即可读取新名单，菜单和模型能力仍按原刷新生命周期应用。Relay 独立目录与授权不受本名单影响。

隔离实际 App Server 观察：启用模型完成一轮；停用后，当前 Thread 继续和 App Server 重启后恢复同一 Thread 均返回明确的 409，未调用上游；重新启用、重新加载模型能力后，同一 Thread 再次完成。上游为本地回环服务，本观察不代表 Windows 或云端模型验收。

此操作下载固定 SHA 的官方元数据，先校验完整目录、启用名单和当前默认模型，再备份原 `models.json` 与 `models.manifest.json` 为同目录 `.backup` 文件并事务写入。发生可恢复写入失败时回滚；并发修改导致无法安全回滚时明确报错，保留文件供核对，不覆盖其他写入。新目录若移除账户当前默认模型或其默认思考等级，更新失败并保留原目录，须先调整默认设置。需要手工回退时，先停止使用 CLP 的客户端及相关服务，成对恢复这两个备份后重启；备份仅覆盖最近一次更新。停用模型后其条目从派生目录移除，重新启用按当前官方资料生成参数。

仅加入明确声明文本、工具能力、有效上下文及可映射思考控制的模型；暂不支持的条目在 CLI 输出原因。最多启用 64 个模型，候选目录超过 64 个时仍可选择其中的子集。声明思考开关的模型提供 `none`（关闭）和 `enabled`（开启），同时声明等级时保留对应等级；仅有开关的新模型默认关闭。不按模型名称推断能力，没有可映射控制或只有预算控制的模型暂不加入。图片仅声明桥支持的图片输入，不把官方目录中的音频、视频、PDF 声明为 Codex 可用能力。目录可被 Codex 加载不等同于每个云端模型已经完成工具续跑验收。

生成文件仍在 `providers/clp/models.json`，聚合读取这份目录。运行中的 Gateway 会在活动与租约允许后应用目录变化；未运行 Gateway 时按菜单提示重启服务。安装代码、重新配置 Key 和更新 Relay 目录均不会隐式覆盖已有 Codex 模型目录。现有账户保留原目录，须执行上述显式更新。

切换模式按账户使用 `sf-clp-<账户>.config.toml` Profile 和独立 App Server；固定模式修改 Codex 主配置并保留该账户的初始备份。
固定 Key 使用[独立私有版本与主配置 `env_key` 引用](provider-integration-guide.md#4-安全边界)，App Server 与独立 Relay 复用同一引用；旧明文配置须明确重新配置账户。
Key 使用现有私有文件机制保存，不写入 Gateway TOML 或命令行。配置文件位于 Codex Home，目录与管理标记
位于 `~/.codex-connect/providers/clp/`。配置变更后按 Setup 提示重启服务；切换模式通过
现有 Provider 选择入口使用 `clp-<账户>`，终端使用 `codexc remote -p clp-<账户>`，
Desktop 使用 `codexc app -p clp-<账户>`。两个入口也接受已登记的 `sf-clp-<账户>` Profile 名，
Remote 保留 `--profile sf-clp-<账户>`；两个入口默认连接主实例。
账户注册表 `accounts.json` 只保存 ID 和默认标记；各账户的管理标记和备份位于 `accounts/<账户>/`。
默认账户用于渠道默认选择，已有会话不自动更换账户，也不因额度不足轮换密钥。删除账户前须先把默认标记交给其他账户（仅剩一个账户时可直接删除）。
删除会停止对应受管实例，保留初始配置备份和历史统计，该账户的历史会话不再可用；其他账户及共享目录保留。仅在删除最后一个账户时删除 Cline 共享模型目录，DS 模板保留。

仅支持当前多账户结构。遇到不支持的管理标记或 Profile 会明确拒绝读取，不自动删除数据。
配置写入复用受管事务和失败回滚，不迁移已有 Provider 数据或数据库。

主 Provider 为 OpenAI，且至少有两个 API Key 切换提供商时，可使用 `codexc app --provider agg`。
该按需实例的桌面目录包含 DS、CLP、OCG、CCG 和自定义切换提供商；CLP 的精确模型 ID 形如
`clp-main/cline-pass/deepseek-v4.1-flash`，显示名称包含账户 Provider ID。已加载模型间切换无需退出
Desktop，更换 App Server 实例仍须完全退出。聚合请求复用现有 CLP Chat 桥，每次用目标账户真实 Key
替换本地令牌；关闭网页搜索、模型 API WebSocket 和自动重试，不改变独立 Relay 的目录及路由。
终端也可用 `codexc remote --provider agg`，渠道从 `/model` 的“聚合提供商”目录选择；
同一聚合 Thread 内切换保留历史，账户额度查询不合并，请求指标按真实账户记录。
安装新代码或增删成员后须重启相关服务；现有成员的 Key、模型目录变更由运行中的 Gateway 检测，待活动和租约释放后刷新，旧快照在等待期间拒绝
后续出站。旧单账户 Thread 不迁移，请在聚合实例新建 Thread。隔离观察已通过实际 Codex App Server、聚合代理与 Chat 桥完成同一 Thread 的 GLM → 另一 CLP 账户 MiMo 切换，两轮均完成且第二轮保留历史；上游响应来自本地回环服务，不能据此认定真实云端模型或 Desktop 工具已完成验收。窗口覆盖与共享前提见 [Desktop 共享说明](user-guide.md#codex-desktop-app-共享macos--windows-预览)。

## Chat 转换边界

非 Flash 的 CLP 模型使用项目内 `runtime/third-party-coding-instructions.mjs` 维护的通用编程提示词，通过目录的 `model_messages.instructions_template` 加载；新增 OCG/CCG 手填模型及新增非 DS 自定义 Responses 模型复用同一资源。内容覆盖任务范围、上下文延续、仓库规则、工具使用、权限、用户数据保护、验证与交付；不声明具体模型身份，不强制新增测试、委派或提交，工具与能力仍以实际环境和模型目录为准。它参考 DS 模板的协作主题独立编写，不在运行时读取或下载 DS 提示词。精确 Flash 仍使用 DS 模板，既有自定义 Responses 目录的缺省值不变。

新建共享目录时采用当前提示词；已有账户需在 CLP 菜单执行“选择启用模型／更新共享目录”，沿用目录备份与激活流程。更新代码或重新配置 Key 不会覆盖现有目录；旧会话是否采用新的基础提示词还取决于客户端的会话恢复行为，不能只凭目录已更新就认定生效。Chat 桥仅转换请求中实际携带的指令，不再次追加这份提示词。

锁定 Codex 仅支持 Responses。App Server 仍配置 `wire_api = "responses"`，服务拥有的本地回环代理
把完整请求转换后发送至 `https://api.cline.bot/api/v1/chat/completions`，再把 Chat SSE 转换回 Responses。
Gateway 重启不会终止该桥或共享 App Server。转换逻辑独立在 `src/model-api`，可以供其他 Chat Provider 复用。

支持文本、用户图片输入、函数工具（含命名空间）及文本结果、明文推理展示和 Token 用量。自由格式 `custom` 工具以单字段 `input` 的 JSON 函数下发，声明 `grammar`（lark）格式时其语法原文保留在工具说明中，回程还原为 `custom_tool_call`；执行位置为 `client` 的 `tool_search` 回程还原为 `tool_search_call`，其结果带回的工具在同一请求内补充声明，并移除已发现工具的 `defer_loading` 标记。CLP 共享目录声明 `apply_patch_tool_type: freeform`，模型改用自由格式 `apply_patch` 工具修改文件，渠道据此显示「修改文件」卡片；CLP 共享目录同时开启 `supports_search_tool`，客户端 `tool_search` 可检索并按需加载命名空间工具。已有账户可通过“更新共享模型目录”补齐这些声明，无需删除账户。`text.format` 的 `json_schema` 按原样映射为 Chat `response_format`，因此 TUI 的线程标题生成等结构化请求无需关闭；`text.verbosity` 没有 Chat 等价字段，取值校验后忽略。未映射的顶层工具声明（含服务端 `tool_search`、`web_search`）及其 `tool_choice` 原样交给 CLP 判断，本地不丢弃也不提前拒绝；这不表示 CLP 或模型支持其执行。不为这些声明注册客户端工具，回程不支持的工具调用仍明确失败。远程 compaction、加密或带签名的推理、Fast 和 WebSocket 仍不支持；外部函数形式的工具仍按函数调用处理。
边界案例可对照 [CLIProxyAPI 的 Responses 转换器（固定提交 9bdde54）](https://github.com/router-for-me/CLIProxyAPI/tree/9bdde54b59d1af70ae0534a0ef61b2c3361a1257/internal/translator/openai/openai/responses)，仅作实现参考，不作为 Codex 协议来源或运行时依赖。
Chat 的 `reasoning` 与无签名 `reasoning_details` 明文映射为推理摘要，并随请求历史回传为 `reasoning`。若上游使用 `reasoning_content`，则通过 Responses 的 `reasoning.content` 保留完整正文，后续还原为 `reasoning_content`，不以摘要替代。工具续跑及下一用户轮次均保留请求历史中的推理；同一增量中的重复文本只保留一次，内容冲突时明确失败。
[DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)要求携带 `tools` 的 Chat 请求完整回传历史推理，即使某轮没有调用工具。CLP 按 Cline 的实际返回字段转换；DeepSeek 官方账户使用原生 Responses，见 [DeepSeek](deepseek.md)。
用户图片支持 PNG、JPEG、WebP、GIF 的内联 Base64 Data URL，保留多图与文本顺序，沿用渠道的图片校验。
工具结果中的内联图片不能放进 Chat 的 `tool` 消息，转换时按原顺序收集，在该组工具结果之后作为紧随的一条 `user` 消息图片段写出，并用相同的调用 ID 与图片序号标记关联原 `tool` 文本位置和图片；并行结果只写出一条，结果文本仍留在对应 `tool` 消息里，因此上下文中的截图不会再让整次请求失败。
不支持图片文件引用、远程图片 URL 或 `detail: original`；`auto`、`low`、`high` 原样传递。
新账户复用共享目录中的图片能力和思考等级。
Flash 思考等级支持 `none`、`low`、`high`、`max`，新配置默认 `high`；选择的等级通过 Chat `reasoning.effort` 原样传递，`none` 明确关闭思考。其他模型按官方目录声明生成选项：普通等级使用 `reasoning_effort`，`none` 使用 `reasoning.enabled=false`，开关选项 `enabled` 使用 `reasoning.enabled=true`，不发送 `reasoning_effort=enabled`。桥在出站前按当前启用目录复核选项，未声明的选项明确拒绝。优先默认 `high`，没有时使用目录投影的第一个合法等级；仅有开关时默认 `none`。只有精确 Flash 模型限定 DeepSeek 上游路由，其他模型由 Cline 按模型 ID 路由。

已有目录需通过“选择启用模型／更新共享目录”显式刷新才会增加开关选项；安装代码不自动改写目录，已有默认选择保留。聚合继承同一目录，仍按已有活动和租约条件刷新。回退到不支持 `enabled` 的旧版本前，先把相关默认值和会话选择改为 `none`，再按上述成对目录备份流程回退。此开关适配仅用于受管 CLP 的 Responses→Chat 桥；不自动改写其他提供商的原生 Responses 参数或独立 Relay 的客户端参数。
未传入思考选项时沿用上游默认值；需要开启思考时，选择目录提供的 `enabled` 或非 `none` 等级。
非 OpenAI Provider 的上下文压缩沿用锁定 Codex 的本地压缩路径，不伪造远程压缩结果。

2026-09-26 隔离线上验证：`cline-pass/deepseek-v4.1-flash` 在 `low` 等级连续 4 次请求完成客户端
工具检索、命名空间函数调用、固定工具结果回传及下一轮输入。请求经过项目的双向转换器，工具不在本机执行。
本次上游返回的思考字段为 `reasoning`，后续 Chat 请求按原字段回传并成功完成；这验证了 Cline 对外接口，
不能据此断言其内部转发给 DeepSeek 时使用的字段。原生 DS `reasoning_content` 与本字段不混写。
补测仅在 Responses 的 `tool_search_output` 中提供工具定义，转换器补充 Chat 函数声明后，
上游仍能调用该工具，并正确还原命名空间。

请求正文上限 16 MiB，单个 SSE 缓冲上限 2 MiB，单次响应转换状态有界；桥的单次请求预算为 300 秒，覆盖正文接收、路由等待及上游处理；面向桥的统计代理额外保留 5 秒用于终态发送，避免抢先截断桥的错误响应。客户端取消和服务关闭会中止正文读取及上游请求，已取消的路由等待不会在迟到结果返回后发起请求。
不支持的语义明确失败，不保存第二份历史。上游 HTTP 错误、流内错误、截断和缺少结束标记均不报告成功。
错误消息不回显上游报文或凭据。调用记录保存转换前后的 Responses 视图，不额外存储 Chat 报文。

输入和输出 Token 来自上游 `usage`；缓存来自 `prompt_tokens_details.cached_tokens`，没有该字段时显示未知。
账户用量通过 Cline 官方 `GET /api/v1/users/me/plan/usage-limits` 查询，使用已配置的 Key，支持固定和切换模式。
WebUI 账户卡片和渠道 `/usage` 显示 5 小时、7 天、月度窗口的已用比例及重置时间，并复用现有账户刷新入口。
只展示官方返回的比例与重置时间，不推算 Token 总额度、Credits 余额或套餐续费日期。窗口未返回重置时间时仍显示额度比例，不推算倒计时；已返回的时间必须有效。三个已知窗口必须齐全且唯一；
上游新增的其它窗口类型不进入 CLP 展示口径，避免上游扩展导致整张额度卡片不可用。
额度、重置时间、刷新状态和请求统计按账户分别记录；查询失败保留该账户上次有效快照，其他账户不受影响。删除账户后隐藏对应卡片，保留历史统计。
Gateway 加载账户适配器并通过账户快照链路提供额度查询。

## 调用诊断与错误

### 上游路由限定探测

2026-10-02（UTC）使用当前默认 CLP 账户，对官方 Chat Completions 端点进行了三次隔离短请求，
模型均为 `cline-pass/deepseek-v4.1-flash`，关闭思考、输出上限 32 Token、使用 SSE。
只发送固定测试文本，没有调用工具、修改生产配置或重启服务。

| 请求差异 | 结果 | 上游返回的路由证据 |
| --- | --- | --- |
| 不传路由限定 | 正常完成 | `resolvedProvider` 与 `finalProvider` 均为 `baseten` |
| `providerOptions.gateway.only = ["deepseek"]` | 正常完成 | 两字段均为 `deepseek` |
| `providerOptions.gateway.only = ["codexc-nonexistent-provider"]` | 无生成内容，流内 `stream_initialization_failed` | 没有成功路由记录；HTTP 状态仍为 200，不能据此判定成功 |

路由字段来自 `choices[].delta.provider_metadata.gateway.routing`，不是根据模型名称、回答内容或
耗时推断。正负对照表明本次 Cline 接口执行了该限制；单组样本不能证明长期可用性或随机路由概率。
参数是 Chat 请求体中的嵌套对象：

```json
{"providerOptions":{"gateway":{"only":["deepseek"]}}}
```

[Vercel 官方路由文档](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options)
定义了 `only` 的上游允许列表语义；Cline 透传行为以上述实测为依据。项目在 CLP 的 Responses 转 Chat
与 Relay 直接 Chat（JSON/SSE）两条出站链路仅对精确 `cline-pass/deepseek-v4.1-flash` 设置该参数；同时要求受管 CLP 身份，其他模型与
Provider 不受影响。Relay 对该模型覆盖客户端已有的 `only`，保留其他合法对象字段；`providerOptions` 或
其 `gateway` 不是对象时在出站前返回 400。限定失败不自动撤销参数或重试。路由规则由
Provider Proxy 公共能力提供，通用协议转换器保持独立；Relay 调用转储记录实际注入后的出站请求；调试模式同时保留原始入站正文，并在实际补入或覆盖
路由时标记 `provider_routing_pinned`，WebUI 显示「已将 CLP 上游限定为 DeepSeek」。已有单一
`deepseek` 限定不重复标记。未记录的标记不补推，WebUI 按转储实际字段展示。
源码更新后，App Server 与已启用的 Relay 在重启时加载当前规则，按安装更新指南操作。

上下文同步复用现有事务与私有恢复记录。若同步失败且自动回滚未完成，停止相关服务后可执行 `codexc provider recover clp-<账户> rollback`（恢复原值）或 `keep`（保留新值）；恢复整个关联事务后再重启服务。

工具名称与命名空间拼接超过 Chat 的 64 字符限制时，转换层使用稳定短名，返回时还原原始工具身份；历史调用和指定工具选择使用相同映射。

开启调用详情记录后，Chat 桥会额外保留有界、白名单筛选的上游诊断信息：原始模型名、请求/响应标识、实际提供商、路由尝试与备用提供商、缓存与多模态 Token 明细、各口径费用。字段按上游原名保存，未返回的值不推算；备用提供商不表示本次实际调用，费用也不等同于套餐扣费。不会保存完整 Chat 报文、凭据、会话标识或任意上游元数据。
这些信息经桥接与代理之间的请求级进程内回调写入 V2 trace 的 `chat_diagnostics` 事件；本地 HTTP 仅携带随机关联编号，诊断信息在终态交付前提交，不透传给 App Server，不进入 Token 指标或数据库。历史请求无法补录。
WebUI 调用详情的“Chat 上游信息”展示上述字段；受长度或条目上限影响时明确提示。长度限制或内容过滤导致的不完整响应会保留已生成的回答和思考文本，但不会发布不完整的工具调用。

错误处理依据 [Cline 官方错误文档](https://docs.cline.bot/api/errors)：HTTP 400/401/402/403/404/429/500/502/503 返回固定的安全说明，读取错误正文最多 64 KiB，未知或不可解析正文按 HTTP 状态归类。HTTP 200 中的顶层 `error` 或 `choices[].error` / `finish_reason: error` 转为失败终态，保留已知 `context_length_exceeded`、`content_filter`、`rate_limit`、`server_error` 分类；HTTP 200 但不是 SSE 响应按服务异常归类且不读取正文；桥自身的 300 秒请求预算在正文接收阶段耗尽时返回 HTTP 408 `request_timeout` 并关闭未完成的请求连接；正文接收完成后耗尽按 `upstream_timeout` 归类并给出重试建议。请求 ID、HTTP 状态、错误阶段和是否适合稍后重试进入诊断记录，不保留任意错误原文或 metadata。生成桥不自动重试；认证、权限和额度错误需先处理配置或账户，临时限流和服务异常仅提供重试建议。Codex 仍使用既有有限重试策略。

调用详情的 `chat_diagnostics` 同时保留受限的 `upstreamError.code/type/request_id`，与本地归类的 `error.code/stage/retryable` 分开。Chat 桥与原生 Chat Relay 共用采集逻辑。对于已观测到的 `stream_initialization_failed`，仅当说明以 `Failed to create stream:` 开头且不超过 64 KiB 时，解析其首个 `{` 起的完整 JSON 尾部，白名单提取 `error.code/type`、`error.param.type/statusCode` 到 `upstreamError.cause.*`；不记录说明原文、其他 metadata 或凭据，不根据嵌入字段改变错误归类和重试行为。畸形或超限说明不解析；保留真实 HTTP 状态，内部 429 不覆盖 HTTP 200。此诊断依赖模型流量转储开启，不追溯改写历史记录。

WebUI 调用详情在响应区直接展示错误摘要及已记录的上游错误码、内部错误类型/状态和请求 ID，无需展开原始 JSON。限流、认证、权限、额度、上下文、内容过滤、服务异常和超时使用固定说明；未知错误明确显示原因未确定，不根据 HTTP 200 判定生成成功。


## 来源与验证

- [Cline Chat API](https://docs.cline.bot/api/chat-completions)：认证、消息、函数工具、流和用量。
- [CLP](https://docs.cline.bot/getting-started/clinepass)：套餐和模型入口。

2026-09-25（UTC）线上验收：`cline-pass/deepseek-v4.1-flash` 经本地转换桥和统计代理完成文本、
推理历史回传、两个带命名空间的并行函数调用和结果续写。输入、输出、推理及缓存 Token 字段均正常转换；
首次短请求返回缓存计数 0；随后部署后的 8 次线上请求均成功，实际缓存命中及工具调用续写已确认。首次隔离验收未修改运行中的服务或用户配置。
同日通过临时 Codex Home 中的真实 App Server、转换桥和 Cline 线上模型验证内联 PNG 识图，模型正确识别图片颜色并正常完成。
同日线上接口验证 `none`、`low`、`high`、`max` 均正常完成，`none` 返回 0 推理 Token，其余等级返回推理，非法等级返回流内错误。
真实 App Server 经转换桥连接 Cline 的完整链路也验证了默认 `high` 产生推理，以及同一 Thread 切换 `none` 后不再产生推理。

Codex 0.160.1 的真实 App Server 经 Chat 桥连接 `cline-pass/deepseek-v4.1-flash`，已观察到
`autoApprovalReview` 完成，受审命令 `printf REVIEW_OK` 退出码为 0；独立 API 的虚构提示注入与
外传案例返回 `deny`。这些样本不证明完整安全性，也不代表真实渠道 UI 已完成验收。

普通 `/api/v1/models` 未列出该 Pass 模型，但直接调用成功；
[官方推荐目录](https://api.cline.bot/api/v1/ai/cline/recommended-models) 的 `clinePass` 列出该模型并描述为 1M 上下文。
未做满窗口测试；本地配置使用 DS Flash 模板的精确窗口参数。

2026-09-25 已使用现有 API Key 确认官方额度接口返回三个窗口的 `percentUsed` 与 `resetsAt`；接口来源为 [Cline 账户控制台](https://app.cline.bot/)。

2026-09-26（UTC）已使用现有 API Key 验证结构化输出映射：同一请求携带 `text.format` 对应的 Chat `response_format` 时，
`cline-pass/deepseek-v4.1-flash` 在关闭思考、无工具的条件下返回符合 schema 的 `{"title": "…"}`；省略该字段时返回普通说明文本，
确认映射是 TUI 线程标题生成可用的前提。同日线上调用转储曾出现本地统计代理按 60 秒空闲超时截断、且上游响应头未到达的失败；
桥使用 300 秒请求预算，外层统计代理额外保留 5 秒用于接收终态，由桥完成该阶段的错误归类。
