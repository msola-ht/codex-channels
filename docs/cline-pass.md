# CLP（Cline Pass）

通过 `codexc setup` → 模型与提供商 → 第三方 Provider → Cline Pass 官方配置。
支持多个 CLP 账户，各账户使用独立 API Key，支持固定与切换模式。首次配置从 Cline 官方目录生成 Codex 多模型目录；勾选 Flash 时优先作为默认，否则以所选模型在官方目录中的第一项作为默认，CLI 保存前明确显示。
Setup 和 WebUI 设置页均可添加、重新配置、设置默认及移除账户。账户 ID 为 1–32 位小写字母、数字、`-` 或 `_`；映射后凭据变量名相同的 ID 不可同时使用，例如 `a-b` 与 `a_b`。
Flash 的上下文、图片、思考等级与提示词复用仓库 `runtime/model-catalog-deepseek.json` 中的 `deepseek-flash`，不读取任一 DS 账户目录，无需手填上下文；模板的 `model_messages` 随模型定义带入。其他模型使用 Cline 声明的各自上下文、图片能力、思考控制和通用编程提示词，不复制 DS 能力。显式创建或更新目录时补全缺失的基础提示词并固化，读取已有目录不注入新模板。
保留 Cline 目录声明的 `none` 思考选项和 Chat 转换边界；请求关闭不保证上游停止内部推理，不复制原生搜索等服务端能力。
通过模型管理选择 CLP 与模型修改窗口。所有 CLP 账户共用模型目录、思考等级及上下文；账户各自选择默认模型，凭据和请求统计仍独立。不联动 DS 或其他提供商。
所有 Cline 账户共用一份 Codex 模型目录。独立 Relay 保持自己的原生 Cline 目录，可下载／更新模型文件，并在每把 Key 下逐模型设置[思考策略](provider-api-relay-development.md#clp-转发模型目录与设置)，不写入 Codex 目录。更新密钥保留共用模型的上下文及默认思考等级。

已有账户通过 `codexc setup → 模型与提供商 → 第三方 Provider → Cline Pass 官方` 的发现／添加模型入口扩展共用模型名单，无需删除账户、重新输入 Key。只列出尚未加入本地目录的候选，默认不勾选；空格勾选、回车确认，再预览所选新增模型的完整内容及影响账户并保存。发现只添加新模型，已有条目完整保留；下载目录缺失的旧模型也不会自动移除，没有新增时不写文件和备份。更新已有模型请在 CLI 模型管理或 WebUI 选择“更新模板”，明确提示词／能力范围后对比保存，见[账户模板更新](provider-integration-guide.md#对比并更新账户模型模板)。首次在 CLI 配置时也提供多选，Flash 可用时默认勾选它，但允许只选择其他模型；更换 Key 沿用共用名单。聚合从同一目录读取启用模型。移除使用独立的本地移除入口；任何 CLP 账户的当前默认模型均须先切换再移除。取消操作不写入配置。WebUI 首次配置仍生成完整的受支持目录。

未启用 Flash 时，新增账户和刷新目录不要求 DS 模板，也不要求 Cline 目录包含 Flash。重新启用 Flash 时校验仓库 DS 模板；失败保留原目录。

CLP 自动审查不再受本地审批模型白名单限制；模型仍须符合正常目录与路由要求。
审查沿用现有 Chat 桥和 Codex 审批机制，失败不会自动放行；各远端模型的兼容性须以实际执行为准。
默认设置见[审批方式](user-guide.md#审批方式手动审批与自动审查auto-review)。

停用会约束所有 CLP 账户及聚合的后续请求。普通 CLP 桥每次出站前安全读取 CLP 共用目录：模型不在启用名单中返回 `409 clp_model_disabled`，目录缺失、模型集合结构无效或无法安全读取时返回 `503 clp_catalog_unavailable`，均不请求上游。旧 Thread 或原生客户端显式指定停用模型也会被拒绝，须重新选择已启用模型，不自动换模型。已经发往上游的请求不强行中断；聚合另保留已有快照变更拒绝与安全刷新机制。重新启用后普通桥无需重启即可读取新名单，菜单和模型能力仍按原刷新生命周期应用。Relay 独立目录与授权不受本名单影响。

隔离实际 App Server 观察：启用模型完成一轮；停用后，当前 Thread 继续和 App Server 重启后恢复同一 Thread 均返回明确的 409，未调用上游；重新启用、重新加载模型能力后，同一 Thread 再次完成。上游为本地回环服务，本观察不代表 Windows 或云端模型验收。

此操作下载固定 SHA 的官方元数据，先校验完整目录、启用名单和当前默认模型，再备份原 `models.json` 与 `models.manifest.json` 为同目录 `.backup` 文件并事务写入。发生可恢复写入失败时回滚；并发修改导致无法安全回滚时明确报错，保留文件供核对，不覆盖其他写入。新目录若移除账户当前默认模型或其默认思考等级，更新失败并保留原目录，须先调整默认设置。需要手工回退时，先停止使用 CLP 的客户端及相关服务，成对恢复这两个备份后重启；备份仅覆盖最近一次更新。停用模型后其条目从派生目录移除，重新启用按当前官方资料生成参数。

仅加入明确声明文本、工具能力、有效上下文及可映射思考控制的模型；暂不支持的条目在 CLI 输出原因。最多启用 64 个模型，候选目录超过 64 个时仍可选择其中的子集。声明思考开关的模型提供 `none`（关闭）和 `enabled`（开启），同时声明等级时保留对应等级；仅有开关的新模型默认关闭。不按模型名称推断能力，没有可映射控制或只有预算控制的模型暂不加入。图片仅声明桥支持的图片输入，不把官方目录中的音频、视频、PDF 声明为 Codex 可用能力。目录可被 Codex 加载不等同于每个云端模型已经完成工具续跑验收。

生成文件位于 `~/.codex-connect/providers/clp/models.json`，同目录保存 `models.manifest.json`；所有 CLP 账户与聚合读取同一份模型内容。运行中的 Gateway 会在活动与租约允许后应用目录变化；未运行 Gateway 时按菜单提示重启服务。新增账户、重新配置 Key 和更新 Relay 目录均不会覆盖已有 Codex 模型目录。当前账户独立目录须先按[目录整理](provider-integration-guide.md#旧共享目录账户升级)合并引用，再安装并启动新版；来源存在差异时拒绝自动选择。

切换模式按账户使用 `sf-clp-<账户>.config.toml` Profile 和独立 App Server；固定模式修改 Codex 主配置并保留该账户的初始备份。
固定 Key 使用[独立私有版本与主配置 `env_key` 引用](provider-integration-guide.md#4-安全边界)，App Server 与独立 Relay 复用同一引用；旧明文配置须明确重新配置账户。
Key 使用现有私有文件机制保存，不写入 Gateway TOML 或命令行。配置文件位于 Codex Home，目录与管理标记
位于 `~/.codex-connect/providers/clp-<账户>/`。配置变更后按 Setup 提示重启服务；切换模式通过
现有 Provider 选择入口使用 `clp-<账户>`，终端使用 `codexc remote -p clp-<账户>`，
Desktop 使用 `codexc app -p clp-<账户>`。两个入口也接受已登记的 `sf-clp-<账户>` Profile 名，
Remote 保留 `--profile sf-clp-<账户>`；两个入口默认连接主实例。
家族索引 `providers/clp/accounts.json` 只保存 ID 和默认标记；各 Provider 的管理标记和备份位于 `providers/clp-<账户>/`。
默认账户用于渠道默认选择，已有会话不自动更换账户，也不因额度不足轮换密钥。删除账户前须先把默认标记交给其他账户（仅剩一个账户时可直接删除）。
删除会停止对应受管实例并移除账户配置与管理标记，保留共用模型目录、来源清单、初始配置备份和历史统计；该账户的历史会话不再可用。

仅支持当前多账户结构。遇到不支持的管理标记或 Profile 会明确拒绝读取，不自动删除数据。
配置写入复用受管事务和失败回滚，不迁移已有 Provider 数据或数据库。

主 Provider 为 OpenAI，且至少有两个 API Key 切换提供商时，可使用 `codexc app --provider agg`。
该按需实例的桌面目录包含 DS、CLP、OCG、CCG 和自定义切换提供商；CLP 的精确模型 ID 形如
`clp-main/cline-pass/deepseek-v4.1-flash`，显示名称包含账户 Provider ID。已加载模型间切换无需退出
Desktop，更换 App Server 实例仍须完全退出。聚合请求复用现有 CLP Chat 桥，每次用目标账户真实 Key
替换本地令牌；关闭网页搜索和模型 API WebSocket，经过 Codex 的请求统一采用原生重试策略，不改变独立 Relay 的目录及路由；Relay 自身不自动重试。
终端也可用 `codexc remote --provider agg`，渠道从 `/model` 的“聚合提供商”目录选择；
同一聚合 Thread 内切换保留历史，账户额度查询不合并，请求指标按真实账户记录。
安装新代码或增删成员后须重启相关服务；现有成员的 Key、模型目录变更由运行中的 Gateway 检测，待活动和租约释放后刷新，旧快照在等待期间拒绝
后续出站。旧单账户 Thread 不迁移，请在聚合实例新建 Thread。隔离观察已通过实际 Codex App Server、聚合代理与 Chat 桥完成同一 Thread 的 GLM → 另一 CLP 账户 MiMo 切换，两轮均完成且第二轮保留历史；上游响应来自本地回环服务，不能据此认定真实云端模型或 Desktop 工具已完成验收。窗口覆盖与共享前提见 [Desktop 共享说明](user-guide.md#codex-desktop-app-共享macos--windows-预览)。

## Chat 转换边界

非 Flash 的 CLP 模型使用项目内 `runtime/third-party-coding-instructions.mjs` 维护的通用编程提示词，通过目录的 `model_messages.instructions_template` 加载；新增 OCG/CCG 手填模型及新增非 DS 自定义 Responses 模型复用同一资源。内容覆盖任务范围、上下文延续、仓库规则、工具使用、权限、用户数据保护、验证与交付；不声明具体模型身份，不强制新增测试、委派或提交，工具与能力仍以实际环境和模型目录为准。它参考 DS 模板的协作主题独立编写。精确 Flash 使用仓库 DS 模板；显式生成目录时还补全基础提示词，既有目录读取保持其已保存内容。

Flash 投影继承 DS 模型定义中的说明、思考等级说明、提示词、上下文及压缩／截断默认值等受支持字段，再覆盖 CLP 的 ID、名称、`none` 思考等级、自由格式补丁和工具检索声明。图片输入仍可用，但 `supports_image_detail_original` 明确为 `false`，因为 Chat 桥只接受 `auto`、`low`、`high`；不把 DS Responses 的原图能力声明为 CLP 可用。该投影不是原始 DS JSON 的逐字段复制：旧字段沿用当前 Codex 的规范表示，未证实适用于 CLP 的 DS 压缩兼容标识 `comp_hash` 不继承。

首次生成 CLP 共用目录时采用当前模板；已有账户需在模型管理中执行“更新模板”，选择提示词或能力范围，预览后保存，沿用目录备份与激活流程。能力更新可补齐模型说明、思考等级说明和摘要默认值等元数据；当前上下文、默认思考等级、工具、采样及压缩／截断设置仍保留本地值。发现模型、更新代码或重新配置 Key 不会覆盖现有条目；旧会话是否采用新的基础提示词还取决于客户端的会话恢复行为，不能只凭目录已更新就认定生效。Chat 桥仅转换请求中实际携带的指令，不再次追加这份提示词。

锁定 Codex 仅支持 Responses。App Server 仍配置 `wire_api = "responses"`，服务拥有的本地回环代理
把完整请求转换后发送至 `https://api.cline.bot/api/v1/chat/completions`，再把 Chat SSE 转换回 Responses。
Gateway 重启不会终止该桥或共享 App Server。转换逻辑独立在 `src/model-api`，可以供其他 Chat Provider 复用。

支持文本、用户图片输入、函数工具（含命名空间）及文本结果、明文推理展示和 Token 用量。自由格式 `custom` 工具以单字段 `input` 的 JSON 函数下发，声明 `grammar`（lark）格式时其语法原文保留在工具说明中，回程还原为 `custom_tool_call`；执行位置为 `client` 的 `tool_search` 回程还原为 `tool_search_call`，其结果带回的工具在同一请求内补充声明，并移除已发现工具的 `defer_loading` 标记。CLP 共用目录声明 `apply_patch_tool_type: freeform`，模型改用自由格式 `apply_patch` 工具修改文件，渠道据此显示「修改文件」卡片；CLP 共用目录同时开启 `supports_search_tool`，客户端 `tool_search` 可检索并按需加载命名空间工具。已有模型须按模板更新的保留规则查看差异；工具配置不在模板能力覆盖范围内，无需删除账户。`text.format` 的 `json_schema` 按原样映射为 Chat `response_format`，因此 TUI 的线程标题生成等结构化请求无需关闭。未映射的顶层工具声明（含服务端 `tool_search`、`web_search`）及其 `tool_choice` 原样交给 CLP 判断，本地不丢弃也不提前拒绝；这不表示 CLP 或模型支持其执行。不为这些声明注册客户端工具，回程不支持的工具调用仍明确失败。远程 compaction、加密或带签名的推理和 WebSocket 仍不支持；外部函数形式的工具仍按函数调用处理。
边界案例可对照 [CLIProxyAPI 的 Responses 转换器（固定提交 9bdde54）](https://github.com/router-for-me/CLIProxyAPI/tree/9bdde54b59d1af70ae0534a0ef61b2c3361a1257/internal/translator/openai/openai/responses)，仅作实现参考，不作为 Codex 协议来源或运行时依赖。
CLP 按上游不拒绝的标准开放参数透传：`text.verbosity` 映射为 Chat 顶层 `verbosity`，`service_tier` 与 `client_metadata` 原值传递，由上游判断，不再由桥按值提前拒绝或丢弃。精确 Flash 模板声明详细程度可选、默认 `medium`，不声明 `priority`、`flex` 等加速或服务档位；参数允许透传不能作为服务档位能力证据。其他 CLP 模型仍沿用各自目录声明，不因 Flash 的探测结果自动增加这些选项。旧目录中曾注入的服务档位通过“更新模板 → 能力”展示删除差异，明确确认后清除；只更新提示词或运行设置不清除其他声明。新建及发现新增使用同一投影，默认服务档位仍保持标准。

`prompt_cache_key` 经 Chat 桥按原字符串透传；省略或 null 不生成字段，其他类型按已观察到的上游要求在本地拒绝。该字段仅是上游缓存路由提示，不保证命中，也不改变账户隔离。2026-10-17 经临时放行后的实际 CLP 桥探测，详细程度 low／medium／high、服务档位 default／auto／priority／flex、元数据对象均完成；这些字段的非法值也未被上游拒绝，因此不以 HTTP 200 推断其效果。缓存键为数值或对象时，上游返回 HTTP 200 流内失败，桥交付 `response.failed`，未报告成功。

Chat 的 `reasoning` 与无签名 `reasoning_details` 明文映射为推理摘要，并随请求历史回传为 `reasoning`。若上游使用 `reasoning_content`，则通过 Responses 的 `reasoning.content` 保留完整正文，后续还原为 `reasoning_content`，不以摘要替代。工具续跑及下一用户轮次均保留请求历史中的推理；同一增量中的重复文本只保留一次，内容冲突时明确失败。
[DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)要求携带 `tools` 的 Chat 请求完整回传历史推理，即使某轮没有调用工具。CLP 按 Cline 的实际返回字段转换；DeepSeek 官方账户使用原生 Responses，见 [DeepSeek](deepseek.md)。
用户图片支持 PNG、JPEG、WebP、GIF 的内联 Base64 Data URL，保留多图与文本顺序，沿用渠道的图片校验。
工具结果中的内联图片不能放进 Chat 的 `tool` 消息，转换时按原顺序收集，在该组工具结果之后作为紧随的一条 `user` 消息图片段写出，并用相同的调用 ID 与图片序号标记关联原 `tool` 文本位置和图片；并行结果只写出一条，结果文本仍留在对应 `tool` 消息里，因此上下文中的截图不会再让整次请求失败。
不支持图片文件引用、远程图片 URL 或 `detail: original`；`auto`、`low`、`high` 原样传递。
新账户从模板生成自己的图片能力和思考等级。
Flash 思考等级支持 `none`、`low`、`high`、`max`，新配置默认 `high`；等级通过 Chat `reasoning.effort` 原样传递，包括 `none`；不因一次观察自动改成其他关闭格式。其他模型按官方目录声明生成选项：普通等级使用 `reasoning_effort`，`none` 使用 `reasoning.enabled=false`，开关选项 `enabled` 使用 `reasoning.enabled=true`，不发送 `reasoning_effort=enabled`。桥在出站前按当前启用目录复核选项，未声明的选项明确拒绝。优先默认 `high`，没有时使用目录投影的第一个合法等级；仅有开关时默认 `none`。只有精确 Flash 模型请求限定 DeepSeek 上游路由，其他模型由 Cline 按模型 ID 路由。

当前关闭限制：历史记录中，相同的 `reasoning.effort=none` 和 `gateway.only=["deepseek"]` 在 2026-10-14 04:56 UTC 返回 `deepseek` 路由、0 推理 Token；12:22 UTC 返回的路由已变为 `openai-compatible-private`、模型为 `private/deepseek-v4p1-flash-contributor`，报告 145 推理 Token。这是路由变化与失效同时出现的证据，不能据此确定服务端变更机制或某次本地提交为根因。2026-10-15 12:27 UTC 经授权直接请求同一 Cline 上游，固定文本、模型、路由限定及 `max_tokens=64`，各执行一次：旧 `none` 返回思考正文和 15 推理 Token；`enabled=false` 不返回思考正文但报告 27 推理 Token；不设控制返回思考正文和 16 推理 Token。三次均为上述私有路由、HTTP 200、`finish_reason=stop`，收到流终帧。该对比支持新参数影响正文返回，但不证明内部推理已关闭，也不替代部署后完整客户端链路验证。

2026-10-16 00:45:40–00:46:02 UTC，通过 WebUI 共用的 `probeRelayReasoning` 入口对 `clp-main/deepseek-v4.1-flash` 原生 Chat 执行九项检测，每项一次、固定文本 `Reply with exactly OK.`、`max_tokens=64`，沿用 Flash 路由限定。所有项目均为 HTTP 200、completed，整组未提前停止；响应模型均为 `vmc/deepseek-v4p1-flash-contributor-fallbacks`。基线、`reasoning.effort=none`、`reasoning_effort=none`、`thinking.type=disabled` 均报告推理/输出 13/16 并返回思考正文；`reasoning.enabled=false` 为 13/16、不返回思考正文；顶层 `enable_thinking=false` 为 24/27；模板 `chat_template_kwargs.enable_thinking=false` 为 15/18；Google 零预算为 24/27，后三项均返回思考正文。新增组合 `reasoning.enabled=false` 加 `thinking.type=disabled` 为 15/18、不返回思考正文，仍未观察到推理用量归零。组合对应 [Cline 官方参数规则](https://github.com/cline/cline/blob/23791b9323aadd91d7dbaea8a8fa262cd2f7ad0b/sdk/packages/llms/src/providers/routing/provider-option-rules.ts) 中通用关闭与 DeepSeek 家族规则的合并；源码依据不证明云端执行了关闭。此次直接调用检测后端，未操作浏览器保存或修改账户设置；没有采集路由元数据，不能仅凭响应模型名称判定实际 Provider。

已有目录需通过“更新模板”明确选择能力参数，预览后保存才会增加开关选项；安装代码和发现新模型不改写已有条目，默认选择保留。聚合继承同一目录，仍按已有活动和租约条件刷新。回退到不支持 `enabled` 的旧版本前，先把相关默认值和会话选择改为 `none`，再按上述成对目录备份流程回退。此开关适配仅用于受管 CLP 的 Responses→Chat 桥；不自动改写其他提供商的原生 Responses 参数或独立 Relay 的客户端参数。
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

2026-10-16 00:51 UTC 追加三次短请求核查（固定文本、`max_tokens=64`、单次限时 15 秒），响应中的 `choices[].delta.provider_metadata.gateway.routing` 均报告 `resolvedProvider=finalProvider=openai-compatible-private`，响应模型均为 `vmc/deepseek-v4p1-flash-contributor-fallbacks`。组合关闭加 `gateway.only=["deepseek"]` 返回推理/输出 14/18、不返回思考正文；`providerOptions.deepseek.thinking.type=disabled` 加相同限定返回 22/25、有思考正文；将组合关闭的允许列表改为不存在的 `codexc-nonexistent-provider`，仍返回 13/16、无思考正文。三次均 HTTP 200、completed 且收到流终帧。负对照表明当前 CLP Flash 路径未执行请求中的 Provider 限制，下面 2026-10-02 的成功限定仅为历史观察。

[Vercel 虚拟模型文档](https://vercel.com/docs/ai-gateway/models-and-providers/virtual-models)说明 `vmc/` 用于虚拟模型，虚拟模型配置的 `only` 和同名 Provider 参数优先于请求。该机制与本次现象一致，但未取得 Cline 私有虚拟模型配置，不能确定是 Cline 转发层、虚拟模型覆盖还是最终私有服务造成思考关闭失效。本项目仅保证发出路由限定，不保证云端执行；没有通过切换未授权模型或直接复用 Cline 凭据访问 Vercel 来绕过该路径。

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

模型窗口直接写入 CLP 共用目录，不复制广播到多份模型文件。若旧版本有未完成事务，先使用原版本的恢复入口处理，再执行目录整理；不要删除事务记录绕过保护。

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
