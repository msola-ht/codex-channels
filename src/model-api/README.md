# 模型 API 转换

独立的纯 TypeScript 转换模块，不依赖 Provider、HTTP、App Server RPC、配置或存储。
每个请求必须携带完整输入，转换状态只存活于单次流式响应，不缓存会话历史。

- `index.ts`：公开 `responsesToChat`、`ChatToResponses` 与安全错误类型。
- `responses-to-chat.ts`：Responses 文本、用户内联图片、函数与自由格式工具定义、调用和文本结果映射为 Chat 请求。
- `chat-to-responses.ts`：单选择 Chat 流转换为 Responses 文本、推理摘要与正文、函数调用、自由格式调用、客户端检索调用和用量事件。
- `validation.ts`：模型 API 信任边界的结构验证和不含报文的错误。

当前支持文本、用户内联 Base64 图片与三类工具。Responses `function` 保持函数调用，含显式命名空间映射、调用还原和名称冲突检查，超长名称使用稳定摘要短名并在输出中还原原始身份。自由格式 `custom` 工具在 Chat 侧以单字段 `input` 的 JSON 函数下发，语法声明只作说明、不参与校验，回程把该字段还原为 `custom_tool_call`。执行位置为 `client` 的 `tool_search` 以下发时的参数原样声明，回程还原为 `tool_search_call`；其结果带回的工具会在同一请求里补充声明，已检索工具的 `defer_loading: true` 在 Chat 声明中移除；仅原始名称、命名空间和工具类型完全相同才去重，转换名冲突明确拒绝，因为 Chat 上游没有“上游自动补工具”的等价机制。托管工具（如 `web_search`）与执行位置为服务端的 `tool_search` 在 Chat 协议下没有等价形态，按失败关闭拒绝。同样拒绝图片文件引用、远程图片 URL、工具图片结果、加密推理、结构化输出、服务端会话引用和
其他未支持语义。显式推理等级 `none/low/high/max` 映射为 Chat `reasoning.effort`，`none` 关闭思考，缺失时不生成控制参数；其他等级、预算和摘要控制明确拒绝（`summary: none` 可省略）。
命名空间子工具只接受 `function` 与 `custom`；`tool_search` 必须在顶层声明，其调用参数 `limit` 缺省或为 `null` 时使用 Codex 默认值。
Chat 返回的 `reasoning` 和无签名 `reasoning_details` 明文以独立摘要保存，并在请求历史中还原为 `reasoning`。
`reasoning_content` 通过 Responses `reasoning.content` 中的 `reasoning_text` 内容块和对应流事件保留，在工具续跑及后续用户轮次原文回传为 `reasoning_content`；完整正文存在时不以摘要替代或重复拼接。
同一增量的重复文本只保留一次，冲突或带签名的推理明确拒绝，绝不伪装成加密内容或补造推理占位文本。缓存计数缺失保持缺失。
流必须具有明确结束原因；长度截断和内容过滤映射为 incomplete，并收尾保留已生成文本，不发布部分工具调用，上游错误和断流不得生成 completed。
