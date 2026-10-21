# CLP（Cline Pass）

## 网页搜索适配

受管 CLP 的模型代理把 Codex `web_search` 转成内部普通函数调用，再以同一账户凭据请求 Cline `/search/websearch`，把返回的标题和 URL 交给模型续答。只在请求声明搜索且模型实际调用时执行；`disabled` 不声明搜索，也不会发出搜索请求。请在提供商联网搜索中选择 `live`；`cached`、`indexed`、地域、上下文档位及图片搜索控制不能映射，明确拒绝而不扩大联网范围。支持 `filters.allowed_domains` 的普通域名名单，模型不能覆盖名单。

搜索和模型续答共享一个 Responses 响应，返回原生 `web_search_call` 生命周期，并累计各轮模型用量。请求指定 `tool_choice: none` 或强制其他工具时，即使上游错误返回搜索调用也会在联网前拒绝。答复使用模型生成的 Markdown 来源链接，不伪造字符范围引用。锁定 Codex 的历史只保留搜索查询，原始结果不会持久化为另一套历史；后续完整输入可继续转换。`open_page`、`find_in_page` 和加密搜索历史尚不支持。

每个模型请求最多搜索 4 次，单次搜索期限 45 秒，正文最多 256 KiB、最多 50 个结果；整条响应保留 16 MiB 转换预算，并扣减显式输出 Token 预算。搜索失败、无效响应或预算耗尽均明确失败，不伪装成成功；用户取消或代理关闭会取消当前搜索和后续模型调用。关闭并行工具声明；上游若仍在同轮混合返回搜索与客户端工具，先校验全部调用再执行搜索，将同批客户端调用以明确的 `not_executed` 结果交回模型，要求结合搜索结果单独重新发起，避免直接失败或让未执行调用缺少配对结果。该批客户端工具没有执行，也没有触发审批；后续纯客户端调用才交给 Codex 按原有权限处理。桥不缓存跨请求历史，搜索结果只保证在本次内部续答可见。

混合协调仍受同一请求的搜索次数和输出预算约束，不增加无限重试；诊断记录 `conversion.webSearchCoordination=serialized` 及 `conversion.webSearchDeferredClientCalls` 累计数量，不记录调用参数或搜索正文。旧记录中的 `clp_search_mixed_tools` 仍可显示，新请求不再仅因合法工具混合返回就报该错误。强制指定其他工具或 `none` 时，违反选择的搜索仍在联网前拒绝。

搜索认证、额度、权限、限流、超时和协议错误分别用 `clp_search_*` 错误码记录，WebUI 用固定的中英文文案展示，不记录原始错误正文。永久流内失败使用 Codex 可识别的非重试码，细分原因保留在错误类型中；搜索后空续答也不会被标记为成功。独立搜索可在 Cline 用量页单列为 `Web Search`；是否计费由当前账户和上游决定。

该适配只用于受管 CLP 的 Responses→Chat 桥，不改写独立 Relay 或通用 Chat 提供商。WebUI“检测原生网页搜索”仍检测上游原生工具格式，不检测此适配，原生格式被拒绝不代表独立搜索不可用。升级代码后需按现有流程重启 App Server 才加载新桥；代码修改不自动重启服务或修改搜索设置。

接口依据：[Cline SDK 独立搜索实现](https://github.com/cline/cline/blob/c269dbb7f97256d53d4aedabb6c245b9ec54b1b6/sdk/packages/llms/src/providers/vendors/cline.ts)。其他 `vercel:*` 搜索及 Browserbase Fetch 虽可由上游内部执行，但 Chat 回包不含原始工具结果，本适配不自动回退至这些工具。

## 账户配置

通过 `codexc setup → 模型与提供商 → 第三方提供商 → Cline Pass 官方` 添加和管理账户。支持固定与切换模式、多账户及独立 API Key；账户 ID 为 1–32 位小写字母、数字、`-` 或 `_`，映射后的凭据变量名不能冲突，例如 `a-b` 与 `a_b` 不可共存。编辑时预选当前模式，Key 留空保留；保存前预览账户、模式及凭据操作，无变化不写入、不备份、不要求重启。

CLP 不再下载 Cline 官方生成目录。首次配置使用仓库 DS 模板和 `provider-model-catalog.json` 中明确的固定映射：

| CLP 调用 ID | 本地模板 | 请求处理 |
| --- | --- | --- |
| `cline-pass/deepseek-v4.1-flash` | `deepseek-flash` | Flash 思考格式及 DeepSeek 路由限定 |
| `cline-pass/deepseek-v4.1-flash-1017` | `deepseek-flash` | Flash 思考格式及 DeepSeek 路由限定 |
| `cline-pass/deepseek-v4-pro` | `deepseek-v4-pro` | 标准 Cline Chat 格式 |

模板提供提示词、上下文、压缩／截断及模型能力的起点，CLP 投影关闭 Chat 桥不支持的 original 图片精度和思考摘要控制，不复制 DS Responses 的服务档位或专属协议字段。固定映射不是逐模型云端验收结论；路由限定只保证本地发出相应参数，不保证上游执行，见[路由观察](#上游路由限定探测)。CLI 可选择初始启用模型，Flash 被选中时优先作为新账户默认，否则使用所选名单中的第一项；WebUI 首次配置采用全部固定模型。

已有共用目录继续使用保存的内容，不因升级、重新配置 Key 或添加账户而覆盖。所有 CLP 账户共用 `~/.codex-connect/providers/clp/models.json` 和 `models.manifest.json`，默认模型按账户独立设置；共享模型的上下文、思考及提示词修改会影响同族账户，不联动原生 DS、CCG 或 OCG。

CLI 和 WebUI 使用统一的“添加模型”流程：填写准确 ID 与名称，选择“独立填写”或“继承已有模型”，再预览完整新增内容与影响账户并确认保存。名称默认取 ID 最后一个路径段。独立填写明确声明上下文、思考等级与默认值、图片、自由格式 `apply_patch` 和客户端 `tool_search`，使用通用编程提示词；仅支持思考开关时选择 `none/enabled`。CLP ID 须以 `cline-pass/` 开头，且需自行确认 Cline Chat Completions 支持文本和工具调用。保存不调用模型、不证明上游可用，重复 ID 明确拒绝。

继承一次性复制当前目录中来源模型的提示词、上下文、压缩／截断、思考和工具能力，并保存来源的请求格式与路由快照；不复制凭据或模板关联。发送 ID 始终为新填写的值，来源后续编辑或移除不影响副本。Flash 模式使用 `reasoning.effort` 并发出 DeepSeek 路由限定，标准模式使用通用 Cline 映射。请求快照保存在可选 `cline_request_profile: standard | deepseek-flash` 中，未知值失败关闭；未保存该字段的已有模型仍只对精确原 Flash ID 使用历史默认分支。

“添加内置 DS 模型”只追加选中的固定模型，已有条目保持原值；没有新增或取消时不写入、不备份。其他模型均按 ID 添加。既有 Cline 来源记录仍可读取，不隐式转换或删除；“更新模板”从仓库读取本地 DS 模板，显式选择来源与更新范围后对比保存，不联网下载 Cline 目录。候选仅在当前进程保留十分钟，绑定目录修订；过期或目录变化须重新读取。更新提示词、能力或上下文与压缩设置各自仅影响确认范围，当前上下文和默认思考等本地设置依现有模板更新合同保留。

CLI 的“本地编辑已有模型”直接读取保存内容，不下载模板，ID、请求快照、其他模型及未选字段保持不变。完整本地编辑当前由 CLI 提供，WebUI 保留名称、上下文、默认值和模板更新入口。当前任一账户的默认模型须先切换后才能移除；最后一个模型也不能移除。

CLP Relay 与渠道读取同一份受管模型目录和请求快照，仍使用原生 Chat 协议及各 Key 的精确模型授权、独立思考策略。添加目录条目不自动授权；移除会限制 Relay 后续调用，目录材料变化可能撤销在途请求。旧 `cline-relay-models.json` 及其备份不再读取或自动清理；升级后应先核对曾只存在于旧 Relay 目录中的模型，明确按 ID 加入共用目录。Key 中原有授权不会被重写。

目录保存沿用原有备份、修订校验和事务恢复：显式修改前备份 `models.json` 与 `models.manifest.json`，可恢复失败回滚；并发修改或结果不确定时保留恢复材料，不覆盖后续写入、不自动重试。手工回退须先停止使用该目录的客户端及服务，成对核对和恢复备份，再按服务管理流程重启；备份仅保留最近一次修改。回退到旧版本前还需恢复该版本支持的目录来源格式，旧 Relay 独立目录可在旧版本中继续使用。保存不自动重启服务，按结果提示刷新 App Server；Relay 按材料修订刷新，Key 授权仍单独管理。

普通 CLP Chat 桥每次出站前安全读取共用目录：模型缺失返回 `409 clp_model_disabled`；目录缺失、无效或无法安全读取返回 `503 clp_catalog_unavailable`，均不请求上游，也不自动换模型。旧 Thread 显式指定已移除模型仍会被拒绝；重新加入后桥可读取新名单，菜单和能力仍按正常刷新生命周期应用。模型请求是否已出站与后续目录变化分开处理，不假装取消已完成的云端操作。

切换模式使用 `sf-clp-<账户>.config.toml` 和独立 App Server；固定模式修改 Codex 主配置，保留初始备份。账户凭据、管理标记与备份位于 `~/.codex-connect/providers/clp/clp-<账户>/`，家族注册表 `providers/clp/accounts.json` 仅保存 ID 与默认标记。Key 通过独立私有版本和主配置 `env_key` 引用保存，不写入 Gateway TOML 或命令行；旧明文配置须明确重新配置。

终端通过 `codexc remote -p clp-<账户>`，Desktop 通过 `codexc app -p clp-<账户>` 使用已登记账户；也接受对应的 `sf-clp-<账户>` Profile，Remote 保留 `--profile`。默认账户用于渠道初始选择，不改变已有会话，也不因额度不足轮换密钥。移除账户前需交出默认标记，最后一个账户可直接移除；操作停止对应受管实例并删除账户配置与标记，保留共用模型目录、来源、初始备份及历史统计，该账户历史会话不再可用。

仅支持现有多账户布局；不支持的标记、历史布局或未完成事务明确拒绝，不自动迁移或删除。CLP 自动审查使用既有 Chat 桥及 Codex 审批机制，失败不自动放行，远端兼容性仍以实际执行为准。聚合提供商保持关闭，旧材料和历史保留，不自动停止运行中的服务。

## Chat 转换边界

`clp_search_unsupported_controls` 表示转换阶段拒绝了搜索参数，本次模型与搜索请求尚未发往上游。错误消息区分 `external_web_access`、`indexed_web_access`、`user_location`、`search_context_size` 和 `search_content_types`；未知字段只显示固定分类，不回显字段名或值。地域等控制即使设置为 live 仍会被拒绝，需要移除对应控制。开启调用详情时，脱敏诊断保留 `conversion.webSearchControl`，不保存搜索正文。

独立填写的 CLP 模型使用项目内 `runtime/third-party-coding-instructions.mjs` 的通用编程提示词，与 CCG／OCG 和自定义提供商的独立草稿共用。其内容覆盖任务范围、上下文、仓库规则、工具、权限、数据保护和交付，不声明模型身份或强制测试、委派与提交。固定 CLP 的 Flash 与 Pro 则分别使用映射所指 DS 模板；继承模型保留所选来源当前保存的提示词。既有目录不因代码更新重新套用任何模板。

Flash 投影继承 DS 模型定义中的说明、思考等级说明、提示词、上下文及压缩／截断默认值等受支持字段，再覆盖 CLP 的 ID、名称、`none` 思考等级、自由格式补丁和工具检索声明。图片输入仍可用，但 `supports_image_detail_original` 明确为 `false`，因为 Chat 桥只接受 `auto`、`low`、`high`；不把 DS Responses 的原图能力声明为 CLP 可用。该投影不是原始 DS JSON 的逐字段复制：旧字段沿用当前 Codex 的规范表示，未证实适用于 CLP 的 DS 压缩兼容标识 `comp_hash` 不继承。

首次生成 CLP 共用目录时采用当前模板；定义编译后从固定底座 `experimental_supported_tools` 补齐 `send_user_message_async`、`clock` 两项本地声明，异步提问实际工具名仍为 `request_user_input_async`。Flash 主提示词保留 DS 来源正文和显式空值，执行来源身份中性化、缺失辅助提示词补全与独立审批中文要求，不追加额外中文时钟指导；源 JSON 快照不改。

已有账户需在模型管理中执行“更新模板”，选择提示词或能力范围，预览后保存，沿用目录备份与激活流程。能力更新可补齐模型说明、思考等级说明和摘要默认值等元数据，并仅合并来源的上述两项本地工具声明；其他工具能力、当前上下文、默认思考等级、采样及压缩／截断设置仍保留本地值。仅更新提示词不改工具声明，清除旧中文时钟尾段须明确选择提示词；未选范围保持原值。发现模型、更新代码或重新配置 Key 不会覆盖现有条目；旧会话是否采用新的基础提示词还取决于客户端的会话恢复行为，不能只凭目录已更新就认定生效。Chat 桥仅转换请求中实际携带的指令，不再次追加这份提示词。

锁定 Codex 仅支持 Responses。App Server 仍配置 `wire_api = "responses"`，服务拥有的本地回环代理
把完整请求转换后发送至 `https://api.cline.bot/api/v1/chat/completions`，再把 Chat SSE 转换回 Responses。
Gateway 重启不会终止该桥或共享 App Server。转换逻辑独立在 `src/model-api`，可以供其他 Chat Provider 复用。

支持文本、用户图片输入、函数工具（含命名空间）及文本结果、明文推理展示和 Token 用量。自由格式 `custom` 工具以单字段 `input` 的 JSON 函数下发，声明 `grammar`（lark）格式时其语法原文保留在工具说明中，回程还原为 `custom_tool_call`；执行位置为 `client` 的 `tool_search` 回程还原为 `tool_search_call`，其结果带回的工具在同一请求内补充声明，并移除已发现工具的 `defer_loading` 标记。CLP 共用目录声明 `apply_patch_tool_type: freeform`，模型改用自由格式 `apply_patch` 工具修改文件，渠道据此显示「修改文件」卡片；CLP 共用目录同时开启 `supports_search_tool`，客户端 `tool_search` 可检索并按需加载命名空间工具。已有模型须按模板更新的保留规则查看差异；除上述两项本地声明外，其他工具配置不在模板能力覆盖范围内，无需删除账户。`text.format` 的 `json_schema` 按原样映射为 Chat `response_format`，因此 TUI 的线程标题生成等结构化请求无需关闭。受管 CLP 的 hosted `web_search` 由桥适配为普通函数，并调用同账户的独立 `/search/websearch`；仅支持 live 文本查询及域名过滤，详见下节。其他未映射工具（如服务端 `tool_search`）仍原样交给上游判断，不承诺执行或回程支持。远程 compaction、加密或带签名的推理和 WebSocket 仍不支持；外部函数形式的工具仍按函数调用处理。
边界案例可对照 [CLIProxyAPI 的 Responses 转换器（固定提交 9bdde54）](https://github.com/router-for-me/CLIProxyAPI/tree/9bdde54b59d1af70ae0534a0ef61b2c3361a1257/internal/translator/openai/openai/responses)，仅作实现参考，不作为 Codex 协议来源或运行时依赖。
CLP 按上游不拒绝的标准开放参数透传：`text.verbosity` 映射为 Chat 顶层 `verbosity`，`service_tier` 与 `client_metadata` 原值传递，由上游判断，不再由桥按值提前拒绝或丢弃。固定 DS 模板声明详细程度可选、默认 `medium`，不声明 `priority`、`flex` 等加速或服务档位；参数允许透传不能作为服务档位能力证据。其他 CLP 模型仍沿用各自目录声明，不因固定模型的声明自动增加这些选项。旧目录中曾注入的服务档位通过“更新模板 → 能力”展示删除差异，明确确认后清除；只更新提示词或运行设置不清除其他声明。新建及固定 DS 候选使用同一投影，默认服务档位仍保持标准。

`prompt_cache_key` 经 Chat 桥按原字符串透传；省略或 null 不生成字段，其他类型按已观察到的上游要求在本地拒绝。该字段仅是上游缓存路由提示，不保证命中，也不改变账户隔离。2026-10-17 经临时放行后的实际 CLP 桥探测，详细程度 low／medium／high、服务档位 default／auto／priority／flex、元数据对象均完成；这些字段的非法值也未被上游拒绝，因此不以 HTTP 200 推断其效果。缓存键为数值或对象时，上游返回 HTTP 200 流内失败，桥交付 `response.failed`，未报告成功。

Chat 的 `reasoning` 与无签名 `reasoning_details` 明文映射为推理摘要，并随请求历史回传为 `reasoning`。若上游使用 `reasoning_content`，则通过 Responses 的 `reasoning.content` 保留完整正文，后续还原为 `reasoning_content`，不以摘要替代。工具续跑及下一用户轮次均保留请求历史中的推理；同一增量中的重复文本只保留一次，内容冲突时明确失败。
[DeepSeek 思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/)要求携带 `tools` 的 Chat 请求完整回传历史推理，即使某轮没有调用工具。CLP 按 Cline 的实际返回字段转换；DeepSeek 官方账户使用原生 Responses，见 [DeepSeek](deepseek.md)。
用户图片支持 PNG、JPEG、WebP、GIF 的内联 Base64 Data URL，保留多图与文本顺序，沿用渠道的图片校验。
工具结果中的内联图片不能放进 Chat 的 `tool` 消息，转换时按原顺序收集，在该组工具结果之后作为紧随的一条 `user` 消息图片段写出，并用相同的调用 ID 与图片序号标记关联原 `tool` 文本位置和图片；并行结果只写出一条，结果文本仍留在对应 `tool` 消息里，因此上下文中的截图不会再让整次请求失败。
不支持图片文件引用、远程图片 URL 或 `detail: original`；`auto`、`low`、`high` 原样传递。
新账户从模板生成自己的图片能力和思考等级。
Flash 思考等级支持 `none`、`low`、`high`、`max`，新配置默认 `high`；Flash 请求配置将等级通过 Chat `reasoning.effort` 原样传递，包括 `none`，并限定 DeepSeek 上游路由；不因一次观察自动改成其他关闭格式。标准请求配置普通等级使用 `reasoning_effort`，`none` 使用 `reasoning.enabled=false`，由 Cline 按模型 ID 路由。两种配置的开关选项 `enabled` 均使用 `reasoning.enabled=true`，不发送 `reasoning_effort=enabled`。没有显式请求配置时，仅精确 Flash ID 使用 Flash 分支；继承副本按其保存的 `cline_request_profile` 处理。桥在出站前按当前启用目录复核选项，未声明的选项明确拒绝。固定 DS 条目沿用仓库模板的默认等级；手填及继承使用其明确保存的等级。

当前关闭限制：历史记录中，相同的 `reasoning.effort=none` 和 `gateway.only=["deepseek"]` 在 2026-10-14 04:56 UTC 返回 `deepseek` 路由、0 推理 Token；12:22 UTC 返回的路由已变为 `openai-compatible-private`、模型为 `private/deepseek-v4p1-flash-contributor`，报告 145 推理 Token。这是路由变化与失效同时出现的证据，不能据此确定服务端变更机制或某次本地提交为根因。2026-10-15 12:27 UTC 经授权直接请求同一 Cline 上游，固定文本、模型、路由限定及 `max_tokens=64`，各执行一次：旧 `none` 返回思考正文和 15 推理 Token；`enabled=false` 不返回思考正文但报告 27 推理 Token；不设控制返回思考正文和 16 推理 Token。三次均为上述私有路由、HTTP 200、`finish_reason=stop`，收到流终帧。该对比支持新参数影响正文返回，但不证明内部推理已关闭，也不替代部署后完整客户端链路验证。

2026-10-16 00:45:40–00:46:02 UTC，通过 WebUI 共用的 `probeRelayReasoning` 入口对 `clp-main/deepseek-v4.1-flash` 原生 Chat 执行九项检测，每项一次、固定文本 `Reply with exactly OK.`、`max_tokens=64`，沿用 Flash 路由限定。所有项目均为 HTTP 200、completed，整组未提前停止；响应模型均为 `vmc/deepseek-v4p1-flash-contributor-fallbacks`。基线、`reasoning.effort=none`、`reasoning_effort=none`、`thinking.type=disabled` 均报告推理/输出 13/16 并返回思考正文；`reasoning.enabled=false` 为 13/16、不返回思考正文；顶层 `enable_thinking=false` 为 24/27；模板 `chat_template_kwargs.enable_thinking=false` 为 15/18；Google 零预算为 24/27，后三项均返回思考正文。新增组合 `reasoning.enabled=false` 加 `thinking.type=disabled` 为 15/18、不返回思考正文，仍未观察到推理用量归零。组合对应 [Cline 官方参数规则](https://github.com/cline/cline/blob/23791b9323aadd91d7dbaea8a8fa262cd2f7ad0b/sdk/packages/llms/src/providers/routing/provider-option-rules.ts) 中通用关闭与 DeepSeek 家族规则的合并；源码依据不证明云端执行了关闭。此次直接调用检测后端，未操作浏览器保存或修改账户设置；没有采集路由元数据，不能仅凭响应模型名称判定实际 Provider。

已有目录的开关选项继续保留；当前固定 DS 模板只声明其原有思考等级，不额外增加 `enabled`。手填新增时可明确声明开关，继承沿用来源快照；安装代码和添加其他模型不改写已有条目或默认选择。聚合入口当前关闭。回退到不支持 `enabled` 的旧版本前，先把相关默认值和会话选择改为 `none`，再按上述成对目录备份流程回退。此开关适配用于受管 CLP 的 Responses→Chat 桥；Relay 的逐 Key 策略另按其原生 Chat 合同处理，不自动改写其他提供商的原生 Responses 参数。
未传入思考选项时沿用上游默认值；需要开启思考时，选择目录提供的 `enabled` 或非 `none` 等级。
非 OpenAI Provider 的上下文压缩沿用锁定 Codex 的本地压缩路径，不伪造远程压缩结果。

2026-09-26 隔离线上验证：`cline-pass/deepseek-v4.1-flash` 在 `low` 等级连续 4 次请求完成客户端
工具检索、命名空间函数调用、固定工具结果回传及下一轮输入。请求经过项目的双向转换器，工具不在本机执行。
本次上游返回的思考字段为 `reasoning`，后续 Chat 请求按原字段回传并成功完成；这验证了 Cline 对外接口，
不能据此断言其内部转发给 DeepSeek 时使用的字段。原生 DS `reasoning_content` 与本字段不混写。
补测仅在 Responses 的 `tool_search_output` 中提供工具定义，转换器补充 Chat 函数声明后，
上游仍能调用该工具，并正确还原命名空间。

请求正文上限 48 MiB，单个 SSE 缓冲上限 2 MiB，单次响应转换状态有界。2026-10-21 使用最小生成请求和
不可见填充字段直接验证 Cline Chat 入口接受了 48 MiB 请求体；官方文档未公布固定正文上限，因此不能
据一次探测推导所有模型、账户或上游 Provider 的上限。桥的单次请求预算为 300 秒，覆盖正文接收、
路由等待及上游处理；面向桥的统计代理额外保留 5 秒用于终态发送，避免抢先截断桥的错误响应。
客户端取消和服务关闭会中止正文读取及上游请求，已取消的路由等待不会在迟到结果返回后发起请求。
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
与 Relay 直接 Chat（JSON/SSE）两条出站链路都消费共用目录中的请求快照：`deepseek-flash` 设置该参数，`standard` 不固定路由；未保存快照的旧条目仅对精确 `cline-pass/deepseek-v4.1-flash` 使用历史默认。其他
Provider 不受影响。Relay 对需要限定的模型覆盖客户端已有的 `only`，保留其他合法对象字段；`providerOptions` 或
其 `gateway` 不是对象时在出站前返回 400。限定失败不自动撤销参数或重试。路由规则由
Provider Proxy 公共能力提供，通用协议转换器保持独立；Relay 调用转储记录实际注入后的出站请求；调试模式同时保留原始入站正文，并在实际补入或覆盖
路由时标记 `provider_routing_pinned`，WebUI 显示「已将 CLP 上游限定为 DeepSeek」。已有单一
`deepseek` 限定不重复标记。未记录的标记不补推，WebUI 按转储实际字段展示。
源码更新后，App Server 与已启用的 Relay 在重启时加载当前规则，按安装更新指南操作。

模型窗口直接写入 CLP 共用目录，不复制广播到多份模型文件。历史目录迁移事务须使用产生该事务的对应旧版本恢复；当前模型设置事务仍使用其既有恢复入口。不要删除事务记录绕过保护。

工具名称与命名空间拼接超过 Chat 的 64 字符限制时，转换层使用稳定短名，返回时还原原始工具身份；历史调用和指定工具选择使用相同映射。

开启调用详情记录后，Chat 桥会额外保留有界、白名单筛选的上游诊断信息：原始模型名、请求/响应标识、实际提供商、路由尝试与备用提供商、缓存与多模态 Token 明细、各口径费用。字段按上游原名保存，未返回的值不推算；备用提供商不表示本次实际调用，费用也不等同于套餐扣费。不会保存完整 Chat 报文、凭据、会话标识或任意上游元数据。
这些信息经桥接与代理之间的请求级进程内回调写入 V2 trace 的 `chat_diagnostics` 事件；本地 HTTP 仅携带随机关联编号，诊断信息在终态交付前提交，不透传给 App Server，不进入 Token 指标或数据库。历史请求无法补录。
WebUI 调用详情的“Chat 上游信息”展示上述字段；受长度或条目上限影响时明确提示。长度限制或内容过滤导致的不完整响应会保留已生成的回答和思考文本，但不会发布不完整的工具调用。

错误处理依据 [Cline 官方错误文档](https://docs.cline.bot/api/errors)：HTTP 400/401/402/403/404/429/500/502/503 返回固定的安全说明，读取错误正文最多 64 KiB，未知或不可解析正文按 HTTP 状态归类。HTTP 200 中的顶层 `error` 或 `choices[].error` / `finish_reason: error` 转为失败终态，保留已知 `context_length_exceeded`、`content_filter`、`rate_limit`、`server_error` 分类；HTTP 200 但不是 SSE 响应按服务异常归类且不读取正文；桥自身的 300 秒请求预算在正文接收阶段耗尽时返回 HTTP 408 `request_timeout` 并关闭未完成的请求连接；正文接收完成后耗尽按 `upstream_timeout` 归类并给出重试建议。请求 ID、HTTP 状态、错误阶段和是否适合稍后重试进入诊断记录，不保留任意错误原文或 metadata。生成桥不自动重试；认证、权限和额度错误需先处理配置或账户，临时限流和服务异常仅提供重试建议。Codex 仍使用既有有限重试策略。

调用详情的 `chat_diagnostics` 同时保留受限的 `upstreamError.code/type/request_id`，与本地归类的 `error.code/stage/retryable` 分开。Chat 桥与原生 Chat Relay 共用采集逻辑。对于已观测到的 `stream_initialization_failed`，仅当说明以 `Failed to create stream:` 开头且不超过 64 KiB 时，解析其首个 `{` 起的完整 JSON 尾部，白名单提取 `error.code/type`、`error.param.type/statusCode` 到 `upstreamError.cause.*`；不记录说明原文、其他 metadata 或凭据。诊断采集本身不改变分类；错误分类器仅对固定包装中的 HTTP 400、精确工具索引和明确类型拒绝识别为 `web_search_unsupported`，规则见[错误说明](errors.md)。主动搜索诊断复用该分类及实际出站工具，明确拒绝显示“不支持”。畸形或超限说明不解析；保留真实 HTTP 状态，内部 429 不覆盖 HTTP 200。调用详情诊断依赖模型流量转储开启，不追溯改写历史记录。

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
