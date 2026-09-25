# 模型 API 转换

独立的纯 TypeScript 转换模块，不依赖 Provider、HTTP、App Server RPC、配置或存储。
每个请求必须携带完整输入，转换状态只存活于单次流式响应，不缓存会话历史。

- `index.ts`：公开 `responsesToChat`、`ChatToResponses` 与安全错误类型。
- `responses-to-chat.ts`：Responses 文本、用户内联图片、函数定义、调用和文本结果映射为 Chat 请求。
- `chat-to-responses.ts`：单选择 Chat 流转换为 Responses 文本、推理摘要、函数调用和用量事件。
- `validation.ts`：模型 API 信任边界的结构验证和不含报文的错误。

当前支持文本、用户内联 Base64 图片与函数工具（包括显式命名空间映射、调用还原和名称冲突检查），拒绝图片文件引用、远程图片 URL、工具图片结果、自由格式工具、加密推理、结构化输出、服务端会话引用和
其他未支持语义。推理等级控制尚未适配，只接受空控制或 `none`（不向上游发送思考开关）。
Chat 返回的 `reasoning` 和无签名 `reasoning_details` 明文以独立摘要保存和回传，同一增量的重复文本只保留一次，
冲突或带签名的推理明确拒绝，绝不伪装成加密内容。缓存计数缺失保持缺失。
流必须具有明确结束原因；长度截断映射为 incomplete，上游错误和断流不得生成 completed。
