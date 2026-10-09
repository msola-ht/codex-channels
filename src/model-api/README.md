# 模型 API 转换

独立的纯转换模块，不依赖 Provider 账户材料、HTTP、App Server RPC、配置读写或存储。原生协议思考策略仅引用共享的无 I/O 能力元数据。
每个请求必须携带完整输入，转换状态只存活于单次流式响应，不缓存会话历史。

- `index.ts`：公开 `responsesToChat`、`ChatToResponses` 与安全错误类型。
- `responses-to-chat.ts`：Responses 文本、用户内联图片、函数与自由格式工具定义、调用、文本结果、Codex multi-agent v2 的 `agent_message` 输入项，以及工具结果内联图片到紧随 user 消息的映射。
- `chat-to-responses.ts`：单选择 Chat 流转换为 Responses 文本、推理摘要与正文、函数调用、自由格式调用、客户端检索调用和用量事件。
- `validation.ts`：模型 API 信任边界的结构验证和不含报文的错误。
- `direct-request.ts`：原生请求共用的模型、流式字段校验及思考控制字段冲突定位；协议专属规则留在各请求模块。
- `chat-request.ts`：独立 Relay 直接 Chat 请求保留：仅校验本地 model/messages/stream/n 边界，其他字段和值交给上游处理；提供安全字段路径错误及仅对明确支持的模型应用每 Key 关闭思考策略，不经过 Responses 转换。
- `chat-response.ts`：直接 Chat JSON/SSE 的单选择响应观察、工具结构与资源边界、终态与 Usage 归约，不构造交付响应；公开不含报文的响应校验错误类别及原生/转换链路共用的 `hasChatOutputContent` 首内容判定。
- `responses-request.ts`：原生 Responses 同步无状态请求边界，保留输入、工具和模型参数，接受布尔 store/background 并关闭上游存储及后台执行，按可信 Provider 对 DS 放行上游忽略的历史引用，不经过 Chat 转换；由 Relay 原生 Responses HTTP 路由调用。

直接 Chat 保留工具参数字符串，由客户端在执行前验证 JSON 与工具 Schema；支持最长 128 字符的函数名。`insufficient_system_resource`、`aborted` 与长度/过滤终态均记为 incomplete，原样交付；不将模型中断误判为协议错误。

以下限制针对 Responses 与 Chat 的转换链路；独立 Relay 的直接 Chat 请求使用上述保留合同。

当前支持文本、用户内联 Base64 图片、工具结果内联 Base64 图片、三类工具与 Codex multi-agent v2 的 `agent_message` 输入项。Chat 的 `tool` 消息只能携带文本，因此工具结果中的图片按原顺序收集，在该组工具结果之后作为紧随的一条 `user` 消息图片段写出，并行结果也只写出一条；结果文本仍留在对应的 `tool` 消息里，原图片位置与后续图片前使用相同的调用 ID 和图片序号标记，保留归属及图文对应关系；只有存在图片时才额外补充一条 `user` 消息。`agent_message` 是 Responses 私有输入项，Chat 上游没有等价类型，按可读正文降级为普通 `user` 消息：信封段与载荷段按原文拼接，`encrypted_content` 只作为不透明字符串搬运，不尝试解密、改写或伪造占位内容，内容为空或出现未知内容段时明确拒绝。锁定 CLI 的 `encrypted` 参数标记是 Responses 私有语义，转换时删除工具参数 schema 中的布尔标记，同名属性声明与其他 schema 字段保持原样。Responses `function` 保持函数调用，含显式命名空间映射、调用还原和名称冲突检查，超长名称使用稳定摘要短名并在输出中还原原始身份。自由格式 `custom` 工具在 Chat 侧以单字段 `input` 的 JSON 函数下发，语法声明只作说明、不参与校验，回程把该字段还原为 `custom_tool_call`。执行位置为 `client` 的 `tool_search` 以下发时的参数原样声明，回程还原为 `tool_search_call`；其结果带回的工具会在同一请求里补充声明，已检索工具的 `defer_loading: true` 在 Chat 声明中移除；仅原始名称、命名空间和工具类型完全相同才去重，转换名冲突明确拒绝，因为 Chat 上游没有“上游自动补工具”的等价机制。未映射的顶层工具声明（如 `web_search`、服务端 `tool_search`）及其 `tool_choice` 原样交给上游判断，不在本地丢弃或提前拒绝；这些声明不进入客户端执行身份表，回程不支持的工具调用仍明确失败。同样拒绝图片文件引用、远程图片 URL、加密推理、服务端会话引用和
其他未支持语义。Responses `text.format` 的 `json_schema` 按原样映射为 Chat `response_format`（名称、严格标记和 schema 逐字段校验）。`text.verbosity` 取值校验后忽略，因为 Chat 上游没有等价字段；其他文本控制明确拒绝。显式推理等级接受 `none/minimal/low/medium/high/xhigh/max`，纯转换先保存为 `reasoning.effort`，缺失时不生成控制参数；预算和摘要控制明确拒绝（`summary: none` 可省略）。受管 CLP 桥再调用共享 `clinePassChatReasoningControl`：精确 Flash 保留原字段，其他模型关闭使用 `reasoning.enabled=false`、指定等级使用 `reasoning_effort`。目录按模型筛选可选等级，枚举可转换不代表每个上游模型支持所有等级。
已映射的 `function`、`custom` 与客户端 `tool_search` 的强制工具选择同步转换为 Chat 函数选择，沿用声明的命名空间和长名称映射；未映射的选择交给上游。
命名空间子工具只接受 `function` 与 `custom`；`tool_search` 必须在顶层声明，其调用参数 `limit` 缺省或为 `null` 时使用 Codex 默认值。
Chat 返回的 `reasoning` 和无签名 `reasoning_details` 明文以独立摘要保存，并在请求历史中还原为 `reasoning`。
`reasoning_content` 通过 Responses `reasoning.content` 中的 `reasoning_text` 内容块和对应流事件保留，在工具续跑及后续用户轮次原文回传为 `reasoning_content`；完整正文存在时不以摘要替代或重复拼接。
同一增量的重复文本只保留一次，冲突或带签名的推理明确拒绝，绝不伪装成加密内容或补造推理占位文本。缓存计数缺失保持缺失。
流必须具有明确结束原因；长度截断和内容过滤映射为 incomplete，并收尾保留已生成文本，不发布部分工具调用，上游错误和断流不得生成 completed。
CLP 目录声明开关能力时，额外接受 Codex 自定义思考值 `enabled`，由桥映射为 `reasoning.enabled=true`；`none` 关闭，普通等级仍按既有上游映射。转换入口只有收到可信目录明确列出的选项才接受 `enabled`，并校验其他显式选择也属于该模型。未提供能力的通用转换不接受该值，独立 Relay 的原生 Chat/Responses 参数保留规则不变。
直接 Chat 与 Chat→Responses 共用 CLP 用量尾帧判定：已有结束原因后，仅接受带有效用量、相同结束原因和空 assistant delta（仅允许 assistant role 与空或 null content）的重复终态；不重复输出正文。新增正文、工具调用、推理字段或不同结束原因仍拒绝。
