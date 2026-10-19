# 自定义提供商能力探测记录

本文记录用户授权的实际请求与观测结果，不代表所有模型、所有时间或整个提供商的能力保证。探测不修改提供商配置，不执行模型返回的工具，不发送仓库或现有会话内容。没有进行上下文极限测试、并发负载测试或自动重试压测。

本页作为下述端点、模型及请求形态的历史证据保留；现行配置与探测操作以
[提供商接入指南](../provider-integration-guide.md)为准。末节建议仅适用于所记录的观测条件，
未覆盖项不记为通过；需要采用相应能力时，再按当前配置和生产探测结果确认。

## 对象与方法

- 日期：2026-10-11（UTC）。
- Base URL：`http://192.168.50.54:8080/v1`。
- 模型：`qwen3.8-flash-next-iq3_s`；`GET /models` 返回此一个模型，认证通过。
- 凭据：由用户提供，仅在授权请求中使用；本文不记录密钥。
- 接口：分别请求 `/responses` 和 `/chat/completions`；不能由此判断 Responses 是原生实现还是服务端转换。
- 方法：直接调用模型 API，使用固定短文本、生成的简单 PNG 和模拟工具结果。单请求设超时与响应大小上限，不跟随重定向；未启动或修改 Gateway 服务。
- 输出：仅记录状态、结构校验、有限的结果判定与服务端用量字段，不保留完整上游正文或思考内容。
- 每项结论仅覆盖明确列出的请求形态。HTTP 200、参数回显或模型自述均不能单独证明能力有效。

## 第一阶段：基础与工具能力

| 项目 | Responses | Chat Completions | 证据与边界 |
| --- | --- | --- | --- |
| 基础文本与流式输出 | 通过 | 通过 | 返回 `OK`；分别收到文本增量及 `response.completed` / `[DONE]` |
| 函数工具调用 | 通过 | 通过 | 指定 `echo_probe`，工具名、参数及调用 ID 正确 |
| 工具结果回传 | 通过 | 通过 | 回传固定标记，模型正确复述；没有执行真实工具 |
| 图片输入 | 本次任务通过 | 本次任务通过 | 32×32 PNG 随机选中绿色，模型正确回答 `GREEN`；不代表复杂视觉任务质量 |
| 流式双工具调用 | 通过 | 通过 | 同一响应正确返回 `tool_alpha` 和 `tool_beta`；流正常结束 |
| 双工具结果回传 | 通过 | 通过 | 模型正确使用两份不同标记；这是协议检查，不是并发负载测试 |
| 自由格式 `apply_patch` | 通过 | 未直接探测 | 使用锁定 Codex 0.160.1 的 Lark 语法；收到合法 `custom_tool_call`，回传模拟结果后正确继续；没有写文件 |
| Responses WebSocket | 未连接 | 不适用 | 握手 HTTP 404；当前地址不建议启用 WS，不泛化为模型本身不支持 |
| 客户端 `tool_search` 输入项 | 接受 | 未直接探测 | 现有兼容性探测返回 HTTP 200；完整检索、发现及调用链另见后续阶段 |

工具检索与 WS 请求复用 [tool_search 探测](../../scripts/responses-tool-search-probe.mjs) 和 [WS 探测](../../scripts/responses-websocket-probe.mjs)。自由格式工具声明对照只读锁定源码中的 `core/src/tools/handlers/apply_patch_spec.rs` 和 `core/assets/tools/apply_patch.lark`；本记录不新增探测脚本或自动化测试。

## 第二阶段：思考参数

Responses 参数为 `reasoning.effort`，Chat Completions 为 `reasoning_effort`。

| 值 | Responses | Chat Completions | 本次观察 |
| --- | --- | --- | --- |
| `none` | 200 | 200 | 没有返回思考内容；Responses 报告 0 推理 Token |
| `off` | 200 | 200 | 同上 |
| `disabled` | 200 | 200 | 同上 |
| `minimal` | 200 | 200 | 同上；不能据此声明为有效的低强度思考档位 |
| `low` | 200 | 200 | 有思考内容；早期 Responses 请求未严格回复 `OK` |
| `medium` | 200 | 200 | 有思考内容 |
| `high` | 200 | 200 | 有思考内容 |
| `xhigh` | 200 | 200 | 有思考内容 |
| `max` | 200 | 200 | 有思考内容 |
| `on` | 400 | 400 | 参数拒绝 |
| `enabled` | 400 | 400 | 参数拒绝 |
| `invalid_probe_effort` | 400 | 400 | 无效值对照；不是任意字符串都接受 |

### 小算术复核

请求：计算 `(37 × 24) + (19 × 16) − 127`，只返回最终整数；正确答案为 `1065`。使用 Responses，输出预算 768 Token。首次精确格式判定失败后，重复请求仅提取数字检查，确认不是 Markdown 或标点造成的误判。

| 档位 | 复核返回 | 服务端报告推理 Token |
| --- | --- | --- |
| `none` | `1141`，错误 | 0 |
| `off` | `1141`，错误 | 0 |
| `minimal` | `1141`，错误 | 0 |
| `medium` | `1065`，正确 | 65 |

这支持“关闭与开启存在可观察差异”，不证明内部实现、不构成质量基准，也不能证明 `low/medium/high/xhigh/max` 对应五种不同预算。单题或几次请求的 Token 数不能用于强度排序。

## 第三阶段：进一步探测

本阶段新增 13 次短模型请求，全部返回 HTTP 200；思考参数使用 `medium`。检查实际调用结构、关联关系和最终结果，不只检查状态码。

| 项目 | Responses | Chat Completions | 观测结果 |
| --- | --- | --- | --- |
| 客户端工具检索（顶层补入工具声明） | 通过，3 次请求 | 未直接探测 | 返回 `tool_search_call`，顶层补入发现工具后正确调用，再正确使用工具结果；未隔离验证检索结果中的工具加载 |
| 命名空间同名工具 | 通过，2 次请求 | 未直接探测 | `alpha.lookup` 与 `beta.lookup` 的命名空间、调用 ID 和回传结果均未混淆 |
| 连续工具调用与思考历史回传 | 通过，4 次请求 | 通过，4 次请求 | 连续三轮依赖调用均正确；回传三轮思考历史后，最终输出正确且没有额外调用 |

### 客户端工具检索（顶层补入工具声明）

1. 初始只声明客户端 `tool_search`，要求检索 `lookup_probe_marker` 并查询键 `K7`。设置 `tool_choice: required`。
2. 实际收到 `reasoning` 和 `tool_search_call`；`execution` 为 `client`，有 `call_id`，参数包含 `query`。
3. 回传 `tool_search_output`，其中包含新函数声明；同时在下一次请求的 `tools` 中加入该函数，选择模式改为 `auto`。原始响应输出项全部随历史回传。
4. 模型正确调用 `lookup_probe_marker`，参数为 `key: K7`。
5. 回传模拟结果 `MARKER_67291`，最终回复与该标记完全一致。

本次观察覆盖显式在顶层补入工具声明后的调用与结果回传，不能证明上游能仅从 `tool_search_output` 加载发现工具。锁定 Codex 的延迟工具不会在检索后提升为顶层直接工具，因此本记录不足以证明真实延迟发现链路通过。生产探测现已移除顶层补入，Responses 仅从检索结果提供发现工具；Chat 则由共享转换层提取检索结果并声明函数。不涉及服务端联网检索，也不依赖服务端自动保存会话。

### 命名空间同名工具

- 声明 `alpha` 和 `beta` 两个 `namespace`，各自包含同名函数 `lookup`，参数均为 `key: K7`。
- 要求同一轮调用两者，实际收到两项 `function_call`；两项 `name` 均为 `lookup`，`namespace` 分别为 `alpha`、`beta`，各自包含调用 ID。
- 分别回传 `A_942` 和 `B_617`，模型输出的 JSON 对应为 `alpha: A_942`、`beta: B_617`，没有交叉。
- 此项不代表 Chat Completions 原生支持 Responses 命名空间，也不把项目 Chat 转换层的能力算成此端点已验证的原生能力。

### 连续调用与思考历史

- 声明 `step_probe(token)`，要求串行调用三次；第一轮传 `START`，之后每轮必须使用上一轮工具结果作为参数。
- 工具结果依次为 `S1_384`、`S2_759`、`FINAL_206`，全部为本地模拟字符串，没有工具副作用。
- Responses 每轮把返回的完整 `output`（包含 `reasoning` 和调用项）以及 `function_call_output` 加入下一轮历史。
- Chat Completions 每轮把完整 assistant 消息（包含返回的思考内容和 `tool_calls`）以及 `tool` 结果加入历史。
- 两种接口三轮均只返回一个正确的依赖调用，三轮均有思考内容；最后一次请求正确回复 `FINAL_206`，额外工具调用数为 0。
- 本项只有短历史、完整客户端回传，不验证长上下文容量、服务端 `previous_response_id` 会话保存或加密思考内容回传。

## 第四阶段：输出约束与图片补测

本阶段新增 25 次串行短请求：22 次 HTTP 200，3 次 HTTP 400。400 均来自 Chat 的工具调用与 JSON Schema 同时启用场景。请求使用内存生成的图片与固定字符串，没有新增探测脚本、图片文件或自动化测试。

| 项目 | Responses | Chat Completions | 观测结果与边界 |
| --- | --- | --- | --- |
| `tool_choice: none` | 通过 | 通过 | 提示明确要求调用工具，但实际没有工具调用 |
| `tool_choice: auto` 无需调用 | 通过 | 通过 | 提示要求直接回复 `AUTO_OK`；实际完全匹配且无调用 |
| JSON Schema 基础输出 | 通过 | 通过 | 检查必需字段、字符串及整数枚举、无额外字段 |
| 声明工具但禁用调用时的 Schema | 通过 | 通过 | 同时携带工具声明和输出格式，`tool_choice: none`，结果符合 Schema |
| 提示与 Schema 冲突 | 本次保持约束 | 本次保持约束 | 要求忽略 Schema 并返回纯文本；实际仍返回符合 Schema 的 JSON |
| 启用工具调用并携带 Schema | 通过完整两步链路 | 拒绝 | Chat 指定函数、`auto`、`required` 均返回 400；详见下文 |
| 中文与特殊字符流式输出 | 通过 | 通过 | 拼接后的正文逐字匹配，且收到正常结束标记 |
| 两张图片的顺序 | 通过 | 通过 | 第一张蓝色、第二张红色，输出精确为 `BLUE,RED` |
| 图片数字识别 | 本次任务通过 | 本次任务通过 | 从生成的黑字白底图片正确读出 `742` |
| 工具结果中的图片 | 通过两步链路 | 未直接探测 | Responses 返回正确函数调用后，读取图片工具结果并精确回复 `BLUE` |

### 结构化输出与工具调用的组合限制

- Responses 使用 `text.format`，Chat 使用 `response_format`，两者均声明 `json_schema` 和 `strict: true`。
- 基础请求要求 `marker: SCHEMA_728`、`count: 7`，两种接口均输出正确 JSON；在声明工具但设置 `tool_choice: none` 时同样通过。
- 冲突提示要求忽略 Schema、只返回 `BYPASS_462`；Schema 要求 `marker: VALUE_639`、`count: 7`。两种接口均满足 Schema，没有返回该纯文本。这个样本支持约束有效，不证明所有 JSON Schema 关键字或任意对抗提示均受到强制约束。
- Responses 在第一轮同时声明 Schema、工具和指定函数选择，正确返回 `get_marker` 调用；第二轮回传模拟结果 `VALUE_639` 并禁用继续调用，最终 JSON 的字段、枚举、类型和无额外字段检查均通过。
- Chat 使用相同工具与输出约束，指定函数时返回 400；随后分别改成 `auto`、`required` 仍返回 400，错误类型均为 `invalid_request_error`。后两次错误信息同时指向工具与 Schema 的不兼容，未保留完整上游错误正文。
- Chat 对照请求移除输出 Schema 后，指定 `get_marker` 正常返回正确调用；下一轮回传模拟结果，同时设置 Schema 和 `tool_choice: none`，输出正确 JSON。这证实该端点可分两步完成，但不能把它登记为“工具调用与结构化输出可同时启用”。
- 本阶段基础约束与字符流使用 `none`，冲突提示、实际工具链及图片请求使用 `medium`。没有推断该限制是否由模型、推理服务或协议转换层导致，也没有修改项目配置。

### 图片与字符完整性边界

- 两张 64×64 纯色 PNG 按蓝、红顺序输入。问题未给出颜色答案，两种接口均正确保留顺序；没有验证大量图片或复杂跨图推理。
- 320×152 图片使用简单点阵绘制数字 `742`，问题只要求读出图片中的数字；两种接口均精确回答 `742`。不代表中文 OCR、手写字、文档布局或自然图片识别质量。
- Responses 首轮强制调用 `get_probe_image`，次轮以 `function_call_output.output` 中的 `input_image` 回传蓝色 PNG；关闭工具调用后准确回答 `BLUE`。Chat 的工具结果图片转换路径未执行，不以此推断 Chat 原生工具消息支持图片。
- 字符流样本包含中文、全角标点、换行、双引号、反斜杠、`é` 和非 BMP 字符 `𝄞`。Responses 文本增量与 Chat 内容增量分别拼接后与原文完全一致，结束分别为 `response.completed` 和 `[DONE]`。未测中途断线、主动取消或恢复。

## 第五阶段：思考 Token 用量字段

针对“Chat 是否能传回思考数量”新增 3 次短请求，均为 HTTP 200。使用相同算术提示、`medium` 和 768 Token 输出预算；Chat 分别请求非流式和流式，流式明确设置 `stream_options.include_usage: true`。

| 接口 | 输入 Token | 输出 Token | 总 Token | 单独思考 Token | 思考内容 |
| --- | --- | --- | --- | --- | --- |
| Chat 非流式 | 40 | 71 | 111 | 未返回 | 有 |
| Chat 流式 | 40 | 71 | 111 | 未返回 | 有 |
| Responses 非流式 | 40 | 71 | 111 | 65 | 本轮只核对用量 |

- Chat 的 `usage` 只有 `prompt_tokens`、`completion_tokens`、`total_tokens`、`prompt_tokens_details`，没有 `completion_tokens_details.reasoning_tokens`，也没有顶层 `usage.reasoning_tokens`。因此当前端点的 Chat 可以传思考内容，却没有提供单独的思考 Token 数；缺失不能记为 0。
- Responses 返回 `usage.output_tokens_details.reasoning_tokens: 65`。同题两接口的输入、输出和总量一致，符合 Chat 输出总数可能包含思考的情况，但不能仅凭数值一致证明所有请求的计费或 Token 分类方式。
- 项目 [Chat 转 Responses](../../src/model-api/chat-to-responses.ts) 已将 `completion_tokens_details.reasoning_tokens` 映射到 `output_tokens_details.reasoning_tokens`；[Chat 直接响应解析](../../src/model-api/chat-response.ts) 也读取该字段。[请求转换](../../src/model-api/responses-to-chat.ts) 已请求流式用量，[响应指标观察](../../src/provider-proxy/response-metrics-observer.ts) 从转换后的字段读取思考用量。当前实测缺失发生在上游 Chat 响应，不是这些映射遗漏。
- 本轮直接检查 API 与相关代码，没有运行 WebUI、渠道展示或完整持久化链路，不据此确认缺失用量在每个展示入口都被正确标记。未按字符数估算或伪造思考 Token 数。

## 第七阶段：默认采样参数与本地请求链路

向当前 `llm` 提供商的 Responses 接口同时发送 `temperature=1.0`、`top_p=0.95`、`top_k=20`、`min_p=0.0`、`presence_penalty=0.0`、`repetition_penalty=1.0`，返回 HTTP 200、`completed` 和准确的 `OK`。响应顶层回显 `temperature=1`、`top_p=0.95`，未回显其余四项。随后分别将六项替换为非法字符串，六次请求均返回 HTTP 400，错误均指向对应参数。这证明该接口接受这些数值并校验参数类型，不证明每项对实际采样分布的影响。

使用隔离配置，实际完成 CLI 六项预填确认、目录事务保存和回读，并由本机 Codex 解析生成目录；未修改实际提供商配置或重启已安装服务。保存的采样值仅存在于模型定义，未添加到 Codex 的生成模型字段。

- 通过临时启动的生产 Provider Proxy 向真实上游发送请求，默认请求回显 `temperature=1`、`top_p=0.95`；显式指定 `temperature=0`、`top_p=0.7` 时回显对应值。两次均为 HTTP 200，但仅后一次准确回复 `OK`，不以此比较采样质量。
- 同一路径请求目录外模型得到 `409 provider_model_disabled`；隔离目录存在真实未完成写入事务时得到 `503 provider_catalog_unavailable`。事务随后回滚，隔离目录最终清理。
- 生产 Responses 转 Chat 桥返回 HTTP 200 和 `response.completed`；临时 Relay 从隔离目录加载采样配置后，原生 Responses、Chat 两种入口均返回 HTTP 200 和准确的 `OK`。
- 当前上游 WebSocket 握手再次返回 HTTP 404，未能观察 WebSocket 采样注入的上游交付。实现与 HTTP 共用缺失字段补齐逻辑，源码审查不等于该传输的实测通过。
- 非法采样值在保存前拒绝；实际提交小数 `top_k=1.5` 后目录摘要未变且未留下 pending 标记。已有采样设置在独立问题选择 No 后保持不变。

以上观察覆盖目录配置、请求构造及交付，不覆盖原生 TUI 完整任务、Windows/macOS 服务启动或实际采样算法。没有新增测试文件、执行模型工具或保存完整上游正文。

## 分支审查后的检索探测修正与复核

审查发现第三阶段在顶层补入发现工具会掩盖上游是否能从 `tool_search_output` 加载工具。修正后的生产探测已移除此补入，第二、三轮 Responses 的顶层仅保留检索工具，Chat 沿用共享转换层从历史检索结果生成函数声明。

通过现有 `cp-llm` 连接对同一模型重新操作 CLI 的 `tool_search` 单项探测，使用 `medium`：请求超时，显示“无法确认”，没有“采用本项检测结果”选项。选择“不声明支持”后，返回草稿的 `supportsSearchTool` 为 `false`，采用结果列表为空；没有保存或改动用户配置。另一次 Chat 生产探测也因请求超时返回 `inconclusive`。提前取消的调用返回 `cancelled` 与“模型能力检测已取消”，没有发出请求。

这些观察确认失败与取消不会被判为支持，不能证明修正后的完整发现链路在此上游通过；本轮没有重试、执行模型工具或新增测试文件。

## 基于本次观测的配置建议与未覆盖范围

- 优先选择 Responses + HTTP/SSE；当前 WS 握手未通过，保持关闭。
- 当前端点的 Chat 未返回单独思考 Token 用量，Responses 有返回；需要准确统计该字段时优先 Responses。此限制只针对本次端点与模型，不是所有 Chat 提供商的限制。
- 普通函数工具、自由格式工具、简单图片输入、多图顺序、简单数字 OCR 及 Responses 图片工具结果已有上述范围内的实测证据。
- 两种接口的基础 JSON Schema 输出通过；Responses 的工具调用与 Schema 组合链路通过。Chat 的同时启用组合被拒绝，只验证了先调用工具、再禁用调用并添加 Schema 的分步方案。
- 思考关闭优先用项目标准值 `none`，开启优先用已观察到差异的 `medium`；`off/disabled` 的上游接受不构成本项目新增别名的理由。
- 其他档位记录为请求兼容，分档效果未确认；不要自动填入一个宣称强度分级已验证的目录。
- 第三阶段的客户端 `tool_search` 观察包含顶层补入工具声明，不能单独作为启用真实延迟发现能力的依据；应通过修正后的逐项探测重新确认。
- 按用户要求不测上下文上限和并发容量。尚未覆盖最大输出长度、联网搜索、Chat 图片工具结果转换、复杂视觉、完整 JSON Schema 关键字、断流取消恢复或长时间稳定性。
- 直接 API 请求通过不等于原生 Codex 完整任务、渠道投递或生产服务已经验收。服务端、模型、地址、凭据或协议变化后，原证据可能不再适用。

相关合同见 [第三方提供商接入指南](../provider-integration-guide.md)。
