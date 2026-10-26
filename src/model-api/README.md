# 模型 API 转换

独立的纯转换模块，不依赖 Provider 账户材料、HTTP、App Server RPC、配置读写或存储。原生协议思考策略仅引用共享的无 I/O 能力元数据。
每个请求必须携带完整输入，转换状态只存活于单次流式响应，不缓存会话历史。

显式 `clineWebSearch` 选项把 live `web_search` 映射为内部查询函数，返回固定域名限制；该选项与上游原生能力诊断分开。`ChatToResponses` 的 hosted-search 接口校验整轮工具、发出原生搜索生命周期并在同一响应中继续下一模型轮，累计用量且保留未知计数；HTTP 由 Provider Proxy 执行。混合调用先执行搜索，同批客户端调用不交付执行，而以固定 `not_executed` 工具结果告知模型尚未派发，要求看过搜索结果后单独重新发起；完整 assistant 调用组与全部配对结果一起续传，内部调用 ID 按响应、模型轮次及工具序号重写以避免上游跨轮重用。后续纯客户端调用才还原交给 Codex，内部搜索不发布为客户端函数，不代替审批或伪造执行成功。历史 search 查询可降为可读记录，缺失结果不补造；搜索来源仍仅在当前请求续答可用，不承诺跨请求保留，来源链接不合成为未经验证的引用注解。

自定义模型添加时的能力探测通过公开入口复用 `responsesToChat`，确保短请求的工具与思考参数编码和运行时通用 Chat 桥一致；探测的网络、凭据及配置写入仍归 Scripts 管理入口负责。

`clinePassChatReasoningControl` 的第三个可选参数接收受管 CLP 的请求格式快照 `standard`／`deepseek-flash`。省略时仅按精确原 Flash ID 选择默认格式；显式 Flash 快照可用于新增 ID，标准快照可覆盖原 Flash 默认，未知值拒绝。`enabled` 在两种快照下均映射为 `reasoning.enabled=true`。原生 Chat Relay 由共用材料携带同一快照，仅用于 Key 的等级／关闭策略；跟随客户端仍保留原参数，不执行 Responses 转换。

- `index.ts`：公开 `responsesToChat`、`ChatToResponses`、`normalizeResponsesRequest` 与安全错误类型。
- `responses-to-chat.ts`：Responses 文本、用户内联图片、函数与自由格式工具定义、调用、文本结果、Codex multi-agent v2 的 `agent_message` 输入项，以及工具结果内联图片到紧随 user 消息的映射。
- `codex-private-items.ts`：Codex 私有输入项与参数标记的共享语义；`agentMessageText` 按可读正文拼接信封与载荷，`stripEncryptedMarker` 只删除 schema 节点的布尔 `encrypted` 标记并报告是否发生改写。
- `responses-normalize.ts`：面向第三方 Responses 上游的正文归一化；把 `agent_message` 降级为普通 `user` 消息并删除工具参数 schema 中的 `encrypted` 标记，未改写时报告 `changed: false`。
- `ollama-freeform.ts`：显式 OLC 的独立纯适配；保留当前 custom 声明及工具选择，按精确名称和命名空间还原 JSON/SSE 调用，按本请求 call_id 包装配对历史。单调用参数 1 MiB、同时工具调用 64 个、保留输入 2 MiB、事件 65536 个及总事件 32 MiB；包装参数必须是仅含字符串 input 的 JSON 对象，重复键、孤立代理码、身份冲突和不一致完成失败关闭。标准 custom 与包装 custom 均有界累积，确认完整后才发出一次原始输入；显式未完成工具状态及不支持的客户端工具输出拒绝，非流式可执行工具要求 completed，终态输出不能遗漏已观察项。所有下游事件重新生成单调序号；HTTP、原始采集和取消清理由 provider-proxy 持有。此入口不处理 Codex 私有 agent_message/encrypted 标记，不开放工具搜索或执行托管搜索。
- `ollama-web-search.ts`：可信 OLC hosted live 搜索的纯声明、选择、历史与单响应状态。只接受可兑现的 live 控制，内部函数名和命名空间冲突失败关闭；历史搜索仅降为可读查询，不补结果或自动执行。整轮工具经 freeform 归约校验后，重写所有调用和输出身份；混合同批客户端工具只生成明确 not_executed 的内部配对结果，后续纯客户端轮才发布完成项。保持唯一 response ID、单调序号、连续输出索引及单终态，搜索状态反映实际执行。显式输出预算逐轮扣除已知消耗，用量缺失保持未知，外部终态仅在三个必需计数均已知时附 usage；内部指标仍可保留独立已知计数。不缓存跨请求正文。初始/逐轮请求 4 MiB、累计模型输入 4 MiB、单轮输出 64 项/768 KiB、最终快照 900 KiB；HTTP、授权、取消和搜索结果读取由 Provider Proxy 持有。
- `chat-to-responses.ts`：单选择 Chat 流转换为 Responses 文本、推理摘要与正文、函数调用、自由格式调用、客户端检索调用和用量事件。
- `validation.ts`：模型 API 信任边界的结构验证和不含报文的错误；转换错误可选携带有界的诊断事实（如工具参数的长度与 `empty`/`invalid_json`/`not_object` 形态分类），只描述形态，不含参数正文或用户内容。
- `direct-request.ts`：原生请求共用的模型、流式字段校验、思考控制字段冲突定位及显式关闭字段覆盖；协议专属等级映射留在各请求模块。
- `chat-request.ts`：独立 Relay 直接 Chat 请求保留：仅校验本地 model/messages/stream/n 边界，其他字段和值交给上游处理；按当前 Key 的精确模型策略覆盖等级或关闭字段，原有自动关闭仍受能力限制，不经过 Responses 转换。
- `chat-response.ts`：直接 Chat JSON/SSE 的单选择响应观察、工具结构与资源边界、终态与 Usage 归约，不构造交付响应；公开不含报文的响应校验错误类别及原生/转换链路共用的 `hasChatOutputContent` 首内容判定。
- `responses-request.ts`：原生 Responses 同步无状态请求边界，保留输入、工具和模型参数，接受布尔 store/background 并关闭上游存储及后台执行，按可信 Provider 对 DS 放行上游忽略的历史引用，不经过 Chat 转换；由 Relay 原生 Responses HTTP 路由调用。

直接 Chat 保留工具参数字符串，由客户端在执行前验证 JSON 与工具 Schema；支持最长 128 字符的函数名。`insufficient_system_resource`、`aborted` 与长度/过滤终态均记为 incomplete，原样交付；不将模型中断误判为协议错误。

以下限制针对 Responses 与 Chat 的转换链路；独立 Relay 的直接 Chat 请求使用上述保留合同。

Responses 转 Chat 保留 `temperature`、`top_p`、`top_k`、`min_p`、`presence_penalty`、`repetition_penalty` 六个采样字段，
只接受有限数字或显式 null；省略字段不生成参数，显式零值和 null 原样传给 Chat 上游。模型目录默认值由调用方在转换前按精确模型补齐。
受管 CLP 桥把 `prompt_cache_key` 的字符串原样传给上游，省略或 null 不生成字段，其他类型明确拒绝；其他 Chat 提供商保留原有忽略行为。不把缓存路由提示解释为缓存命中保证，也不生成跨账户共享键。

第三方 Responses 上游不认识 Codex 私有输入项与参数标记，`normalizeResponsesRequest` 用与 Chat 转换相同的语义改写正文：`agent_message` 降级为普通 `user` 消息（可读信封正文原样保留，`id`/`author`/`recipient` 随降级丢弃），工具参数 schema（含命名空间子工具）里的布尔 `encrypted` 标记被删除。其余字段逐字透传，未知条目交给上游判断；私有项内容为空或出现未知内容段时明确拒绝（失败关闭，不退回透传）。该归一化只用于第三方 Responses 上游，官方 OpenAI 路由保持原文透传。

当前支持文本、用户内联 Base64 图片、工具结果内联 Base64 图片、三类工具与 Codex multi-agent v2 的 `agent_message` 输入项。Chat 的 `tool` 消息只能携带文本，因此工具结果中的图片按原顺序收集，在该组工具结果之后作为紧随的一条 `user` 消息图片段写出，并行结果也只写出一条；结果文本仍留在对应的 `tool` 消息里，原图片位置与后续图片前使用相同的调用 ID 和图片序号标记，保留归属及图文对应关系；只有存在图片时才额外补充一条 `user` 消息。`agent_message` 是 Responses 私有输入项，Chat 上游没有等价类型，按可读正文降级为普通 `user` 消息：信封段与载荷段按原文拼接，`encrypted_content` 只作为不透明字符串搬运，不尝试解密、改写或伪造占位内容，内容为空或出现未知内容段时明确拒绝。锁定 CLI 的 `encrypted` 参数标记是 Responses 私有语义，转换时删除工具参数 schema 中的布尔标记，同名属性声明与其他 schema 字段保持原样。Responses `function` 保持函数调用，含显式命名空间映射、调用还原和名称冲突检查，超长名称使用稳定摘要短名并在输出中还原原始身份。自由格式 `custom` 工具在 Chat 侧以单字段 `input` 的 JSON 函数下发，语法声明只作说明、不参与校验，回程把该字段还原为 `custom_tool_call`。执行位置为 `client` 的 `tool_search` 以下发时的参数原样声明，回程还原为 `tool_search_call`；其结果带回的工具会在同一请求里补充声明，已检索工具的 `defer_loading: true` 在 Chat 声明中移除；仅原始名称、命名空间和工具类型完全相同才去重，转换名冲突明确拒绝，因为 Chat 上游没有“上游自动补工具”的等价机制。除显式 `clineWebSearch` 适配的 `web_search` 外，未映射的顶层工具声明（如服务端 `tool_search`）及其 `tool_choice` 原样交给上游判断，不在本地丢弃或提前拒绝；这些声明不进入客户端执行身份表，回程不支持的工具调用仍明确失败。同样拒绝图片文件引用、远程图片 URL、加密推理、服务端会话引用和
其他未支持语义。Responses `text.format` 的 `json_schema` 按原样映射为 Chat `response_format`（名称、严格标记和 schema 逐字段校验）。受管 CLP 桥使用 `clinePass: true`，把 `text.verbosity` 映射为顶层 `verbosity`，并原值透传 `service_tier`、`client_metadata`，由上游判断参数值；其他 Chat 提供商仍校验后忽略 `text.verbosity`，仅接受默认／自动服务档位，不透传这组控制。其他文本控制明确拒绝。显式推理等级接受 `none/minimal/low/medium/high/xhigh/max`，纯转换先保存为 `reasoning.effort`，缺失时不生成控制参数；预算和摘要控制明确拒绝（`summary: none` 可省略）。受管 CLP 桥再调用共享 `clinePassChatReasoningControl`：保存的 Flash 请求配置保留 `reasoning.effort`（包括 `none`），标准配置关闭使用 `reasoning.enabled=false`、指定等级使用 `reasoning_effort`；未保存请求配置时沿用精确 Flash ID 的默认分支。目录按模型筛选可选等级，枚举可转换不代表每个上游模型支持所有等级。
非 CLP 的通用 Chat 上游默认按 `structuredOutputWithTools: "prompt"` 调用转换：请求同时带工具时把 schema 追加到首条 system 消息（要求最终答复为符合 schema 根类型及字段约束的单个 JSON 值，工具照常调用）并省略 `response_format`，保留工具声明；托管 CLP 上游已验证接受两者并存，继续使用 `response_format`。该降级由提示词而非上游校验保证：桥不校验最终文本是否为 JSON，非 JSON 答复仍以 `response.completed` 交付，降级事实以 `conversion.structuredOutput=prompt` 进入请求诊断。
已映射的 `function`、`custom` 与客户端 `tool_search` 的强制工具选择同步转换为 Chat 函数选择，沿用声明的命名空间和长名称映射；未映射的选择交给上游。
命名空间子工具只接受 `function` 与 `custom`；`tool_search` 必须在顶层声明，其调用参数 `limit` 缺省或为 `null` 时使用 Codex 默认值。
Chat 返回的 `reasoning` 和无签名 `reasoning_details` 明文以独立摘要保存，并在请求历史中还原为 `reasoning`。
`reasoning_content` 通过 Responses `reasoning.content` 中的 `reasoning_text` 内容块和对应流事件保留，在工具续跑及后续用户轮次原文回传为 `reasoning_content`；完整正文存在时不以摘要替代或重复拼接。
同一增量的重复文本只保留一次，冲突或带签名的推理明确拒绝，绝不伪装成加密内容或补造推理占位文本。缓存计数缺失保持缺失。
流必须具有明确结束原因；长度截断和内容过滤映射为 incomplete，并收尾保留已生成文本，不发布部分工具调用，上游错误和断流不得生成 completed。经历托管搜索内部续答后发布的客户端调用使用当前 Responses 响应范围内的新 `call_id`，避免上游跨 HTTP 轮重用 ID 与已有历史冲突；客户端结果沿该 ID 正常配对，不缓存映射。
每帧先校验正文、推理、整组工具增量及结束原因，再提交内容生命周期；终态先完成工具项、空响应与累计用量检查，再关闭内容和发布整组调用。失败仍为此前已交付的正文或推理产生完整 Item 收尾，不将失败帧的新内容或合法半组工具提前发布。合法用量是独立接收证据，可随失败响应保留；最新非法计数清除本轮旧快照，累计超出安全整数范围时省略用量，不能以零或部分轮次代替总量。缺失轮次用量和等待下一模型轮的范围语义保持不变。转换器返回完成事件不代表网络已送达；客户端断开或交付失败时，不能据此宣称 App Server 已保存历史，也不伪造尚未完成的托管搜索终态。
CLP 目录声明开关能力时，额外接受 Codex 自定义思考值 `enabled`，由桥映射为 `reasoning.enabled=true`；`none` 关闭，普通等级仍按既有上游映射。转换入口只有收到可信目录明确列出的选项才接受 `enabled`，并校验其他显式选择也属于该模型。未提供能力的通用转换不接受该值，独立 Relay 的原生 Chat/Responses 参数保留规则不变。
直接 Chat 与 Chat→Responses 共用 CLP 用量尾帧判定：已有结束原因后，仅接受带有效用量、相同结束原因和空 assistant delta（仅允许 assistant role 与空或 null content）的重复终态；不重复输出正文。新增正文、工具调用、推理字段或不同结束原因仍拒绝。
