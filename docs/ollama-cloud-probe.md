# Ollama Cloud 探测与受管接入设计记录

探测日期：2026-10-26

文档复审基线：PR #308 合并后的 `main`（`51066f6b2b403ce0f499f6160ae040f8ee851e73`）。本次文档复核没有读取用户凭据、重放推理、修改 Provider 或部署服务；用量数字引用草稿及审查期间补充的查询快照，本轮未独立查询账户。

证据边界：下文端点状态、23 个模型、具体目录值和四次 `aborted` 来自本轮开始前已有草稿记录；原始脱敏请求/响应、日志关联 ID 和运行产物未随草稿提供，本轮没有独立复现。因此这些内容是 **2026-10-26 原始记录快照**，不是当前账户/会话状态的重新确认，也不能代替实现前的逐模型验收。源码结论、官方文档与设计要求另行标明。

目标：记录 Ollama Cloud（`https://ollama.com`）作为自定义 Provider 的实测范围，以及按方案 B 接入为独立受管多账户 Provider 家族的设计、接口利用方式、freeform 适配要求和待验证项。本文不包含 API Key、账户余额或模型对话正文。

适配范围：只处理 Responses（`wire_api=responses`）路径。原始记录中的 `cp-ollama` 已经使用 Responses，不需要切换协议；Chat Completions 仅作为接口对照，不纳入适配、验收或回退方案。非目标包括音频、Embeddings、本地 Ollama、Chat Completions 适配和任何从 `cp-ollama` 到受管账户的迁移。

接入方向已经确定为方案 B：新增独立的受管多账户 Provider 家族，而不是把 Ollama Cloud 注册成内置 `ollama`，也不把现有 `cp-ollama` 直接改造成受管账户。方案 B 不包含迁移，也不需要迁移；现有 `cp-ollama` 继续按现状使用。本文记录设计、接口利用方式、freeform 适配要求及下文分批实施进度；原始文档复审阶段未修改代码，当前实施不修改现有账户配置或运行中的 Provider。相关合同见[第三方模型 Provider 接入指南](provider-integration-guide.md)、[CCG](ccg.md)、[OpenCode Go](opencode-go.md)和[开发规则](development-rules.md#development-workflow)。

## 原始记录中的接入状态

原始记录描述 Ollama Cloud 已作为以下自定义 Provider 接入；本表不要求新账户复用这些名称、路径或凭据：

| 项目 | 当前值 |
| --- | --- |
| Provider ID | `cp-ollama` |
| 上游地址 | `https://ollama.com/v1` |
| 协议 | `responses` |
| 模型 | `deepseek-v4.1-flash:1017` |
| 当前 Profile | `~/.codex/sf-cp-ollama.config.toml` |
| 模型目录 | `~/.codex-connect/providers/cp-ollama/models.json` |

原始记录称当时 App Server 通过 `cp-ollama` 发起 `/responses` 请求，收到 HTTP `200`、流式及完成事件。这只支持所记录的普通调用路径，不代表所有工具可用；本轮未重新确认运行会话。

## 官方资料与本地合同

- 2026-10-26 查阅 [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)：直连地址为 `https://ollama.com/v1`，支持无状态 Responses；明确不支持有状态 Responses、该路径的内置网页搜索和 custom/freeform 工具历史重放。后续必须显式携带历史，不以 `previous_response_id` 或 `conversation` 替代；不能把 custom 声明返回 HTTP `200` 当作工具往返兼容。
- [Ollama Cloud](https://docs.ollama.com/cloud) 说明云端模型请求使用 `/api/tags` 返回的名称，区别于本地 CLI 的 `:cloud` 名称。余额和费用的具体字段语义仍以待确认状态保留，不能从这两页推导。
- [OpenAI Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events) 定义 custom 工具增量的 `delta`、完成事件的 `input` 及 `item_id` / `output_index` / `sequence_number`。这些字段描述原始工具输入，不是 function 的 JSON 包装字符串。
- 本地 Codex 锁定源码为 `rust-v0.164.0`、提交 `6aaac694803004a63c6f393d153c96d22521a6b9`，本轮已核对 HEAD。`codex-rs/protocol/src/models.rs` 的 `ResponseItem::CustomToolCall`、`codex-rs/codex-api/src/sse/responses.rs` 的事件消费及 `codex-rs/core/src/tools/spec_plan.rs` 的工具注册是客户端合同依据。线上文档不替换该锁定版本。
- 本项目实际归一化入口为 [Responses 请求归一化](../src/model-api/responses-normalize.ts)，HTTP 转发与观察点见 [Provider Proxy](../src/provider-proxy/proxy.ts)。独立 [Model Relay](../src/model-relay/README.md) 不经过该 Proxy 实例，也不归一化 Codex 私有输入项；不能假定改动 Proxy 后 Relay 自动兼容。

## 凭据与探测范围

本节保留原始探测的范围说明；其中“当前”“本轮”指原始探测时点，不是本次文档复核执行过的操作。后续探测结果同样受顶部证据边界约束。

- 使用当前 Profile 中已配置的凭据；Key 未写入本记录、仓库配置或命令行参数。
- 当前 `cp-ollama` 是自定义 Profile，认证字段为 Codex 的 `experimental_bearer_token`；方案 B 不复用这种自定义 Profile 的明文写入方式，受管账户改用私有凭据版本。
- 未调用会改变远端状态的模型创建、拉取、推送、删除等管理端点。
- 推理探测使用短提示和小输出上限；未做长上下文、并发限流或大规模工具调用压力测试。
- 未验证真实账单结算、额度耗尽后的行为或 Key 轮换流程。
- 本轮未修改 Provider 实现；`codexc provider list --json` 在当前沙箱中因尝试 `chmod /root/.codex-connect/config.toml` 返回 `EROFS`，因此改用配置文件和流量转储核对。

## 结论

原始记录称当时 Key 通过认证，并完成以下自定义 Provider 路径；本轮未重新认证或复现：

- OpenAI Responses 非流式与 SSE 流式调用。
- Function 工具声明、模型发起工具调用、显式历史回传工具结果。
- 图片输入（Responses 的 `input_image`）。
- 思考等级参数；原生 `/api/chat` 的 `think` 参数仅作对照。
- JSON Schema 结构化输出。
- 额度与用量查询。

以下结论只描述当前自定义 Provider 的实测能力，不代表方案 B 首版会开放同一范围；方案 B 的账户用量和模型能力以本文后续章节为准。

Chat Completions 也完成过对照探测，但本轮适配只针对 Responses；Chat 的请求格式、思考预算和图片结果不进入后续实现或验收。

仍需注意以下协议差异：

- Responses 返回的 `output_tokens_details.reasoning_tokens` 在各种思考等级下均观察到 `0`，即使响应包含 reasoning summary；不能用该字段判断思考 Token 或计算准确费用。
- Responses 的 `max_output_tokens` 会把思考 Token 计入输出预算，预算过小时可能返回 `status=incomplete` 或正文为空。
- 请求 `tool_choice: "required"` 或 `"none"` 时，Responses 响应体仍回显 `tool_choice: "auto"`。实际工具调用需要结合输出项判断，不能只相信回显字段。
- 原始记录中，自定义/freeform 工具被上游表示为 `function_call`，参数包在 JSON 中（例如 `{"input":"..."}` 或 `{"parameters":"..."}`），而不是标准的 `custom_tool_call`。该记录称直接调用 Codex 的 `apply_patch` 工具四次均输出 `aborted`，目标文件未创建，随后通过 `exec_command` 调用 `apply_patch` CLI 编辑草稿。这不能作为原生 freeform 工具通过验证的证据。
- 模型详情报告的上游上下文为 `1048576`，当前自定义模型目录声明的是 `393216`。当前会话读取的是后者；若要使用更大窗口，需要审查并修改模型目录，不能只依据上游元数据推断已生效。

普通调用的历史成功不能覆盖 freeform 的失败，也不足以证明所有日常编辑任务可用。接入独立受管家族前，需要补充额度映射、错误分类、用量口径和工具兼容性处理；未完成时不得标记为已验收。

## 端点结果

| 方法与路径 | 状态 | 观测结果 |
| --- | --- | --- |
| `GET /v1/models` | `200` | 返回 23 个模型；未认证也可读取 |
| `GET /v1/models/deepseek-v4.1-flash:1017` | `200` | 模型存在，`owned_by=ollama` |
| `GET /api/tags` | `200` | 返回公开模型列表；未认证也可读取 |
| `POST /api/show` | `200` | 返回模型能力与上下文元数据；未认证可读取 |
| `GET /api/balance` | `200` | 返回账户余额与周期额度 |
| `GET /api/usage?range=24h` | `200` | 返回请求数、Token 与费用汇总及小时桶 |
| `POST /v1/responses` | `200` | 非流式、SSE 流式、工具调用、图片输入和结构化输出均通过 |
| `POST /v1/chat/completions` | `200` | 仅作对照；不纳入本轮适配 |
| `POST /v1/completions` | `200` | 支持该路径；小预算下可能因思考 Token 耗尽而返回空文本 |
| `POST /v1/embeddings` | `404` | `path "/v1/embeddings" not found` |
| `POST /v1/audio/speech` | `404` | `path "/v1/audio/speech" not found` |

未认证访问 `/api/balance` 与 `/api/usage?range=24h` 返回 `401 {"error":"invalid credentials"}`；`/v1/models`、`/api/tags` 和 `/api/show` 属于公开读取路径。

## 模型细节

`POST /api/show` 对 `deepseek-v4.1-flash:1017` 返回：

| 字段 | 值 |
| --- | --- |
| 上下文长度 | `1048576` |
| 参数规模 | `763205315794` |
| 量化 | `FP8` |
| 能力 | `completion`、`thinking`、`tools`、`vision` |
| 思考取值 | `false`、`low`、`high`、`max` |
| 默认思考 | `high` |

Responses 的 `reasoning.effort` 实测接受 `none`、`low`、`high`、`max`。原生 `/api/chat` 的 `think` 实测接受 `false`、`low`、`high`、`max` 和 `medium`，其中 `think=false` 不再返回 `message.thinking`。上游接受参数不等于可以保证内部零推理，只表示该参数未被拒绝且响应形态发生了变化。

## 关键探测记录

- Responses 最小非流式请求返回 `status=completed`、`output_text=OK`，并包含 reasoning summary。
- Responses SSE 依次出现 `response.created`、`response.in_progress`、输出项、文本/推理 delta、`response.completed`；文本增量与最终文本一致。
- Chat Completions SSE 返回增量文本和 reasoning 增量，并以 `[DONE]` 结束（仅作对照）。
- Function 工具的流式响应包含 `response.function_call_arguments.delta` 与 `response.function_call_arguments.done`，最终参数可完整拼接。
- 工具结果通过 Responses 显式历史回传后，模型能基于结果生成最终文本。
- 32x32 纯色 PNG 通过 Responses 的 `input_image` 传入，模型正确返回颜色。
- `text.format` 的 `json_schema` 在 `reasoning.effort=none` 且预算充足时返回可解析 JSON；思考开启且预算不足时会先耗尽 Token。
- 未知模型返回 `404` 和结构化 `not_found_error`，但该响应的 `content-type` 为 `text/html`；未知路径返回 `404`；非法请求体返回 `400` 和 `invalid_request_error`。
- Codex 实际传给上游的 `apply_patch` 是 `type=custom`，上游却返回 `type=function_call`、`arguments={"input":"..."}`；客户端侧该调用输出为 `aborted`，目标文件未创建。现有记录可以确认模型能发起工具调用，但 freeform 结果表示与客户端执行之间的具体拒绝条件仍需结合客户端日志确认。

## 模型发现与目录生成

`/v1/models`、`/api/tags` 和 `/api/show` 的职责不同。受管目录生成应把三者组合使用：前者提供 OpenAI 兼容 ID，后者补充能力与上下文，`/api/tags` 用于快速能力和指纹核对。

### 接口职责

| 接口 | 认证 | 主要字段 | 适用 | 不适用 |
| --- | --- | --- | --- | --- |
| `GET /v1/models` | 公开 | `id`、`object`、`created`、`owned_by` | 发现精确模型 ID；校验 ID 是否存在 | 判断上下文、图片、工具、思考等级或 freeform 能力 |
| `GET /api/tags` | 公开 | `name`、`model`、`modified_at`、`size`、`digest`、`details`、`capabilities` | 快速列出模型；能力预筛；记录摘要与变化指纹 | 作为上下文窗口或完整思考等级的唯一来源 |
| `POST /api/show` | 公开 | `capabilities`、`details`、`thinking`、`model_info` | 补全目录的上下文、思考取值、默认值和量化信息 | 验证 API Key；验证真实 Responses 工具行为 |
| `GET /api/balance` | 需要认证 | `included`、`purchased` | 账户余额；Key 预检 | 模型能力 |
| `GET /api/usage?range=24h` | 需要认证 | `totals`、`buckets` | 账户用量和上游费用 | 模型目录 |

关键边界：`/v1/models`、`/api/tags` 和 `/api/show` 都是公开读取路径，不能用它们判断 Key 是否有效。Key 预检必须使用 `/api/balance` 或 `/api/usage`，并只按状态码和受控错误分类处理。

`GET /v1/models/<id>` 可用于精确存在性检查（当前模型返回 `200`，未知模型返回结构化 `404`），但仍不提供上下文、图片或工具能力。目录生成不必逐个调用该路径，因为 `/v1/models` 已经给出完整 ID 集合；它更适合诊断“某个精确 ID 是否仍存在”。

### 观测样本

`/v1/models` 当前返回 23 个模型。`/api/tags` 与 `/v1/models` 的集合一致，但 `/api/tags` 额外提供 `digest`、`size` 和 `capabilities`。`/api/show` 的部分结果如下：

| 模型 | 上下文 | `thinking.values` | 默认思考 | 能力 | 量化 |
| --- | --- | --- | --- | --- | --- |
| `deepseek-v4.1-flash:1017` | `1048576` | `false`、`low`、`high`、`max` | `high` | `completion`、`thinking`、`tools`、`vision` | `FP8` |
| `deepseek-v4.1-flash` | `1048576` | `false`、`low`、`high`、`max` | `high` | `completion`、`thinking`、`tools`、`vision` | `FP8` |
| `gemma4:31b` | `262144` | `false`、`true` | `false` | `completion`、`thinking`、`tools`、`vision` | `BF16` |
| `kimi-k3` | `1048576` | `false`、`low`、`high`、`max` | `max` | `completion`、`thinking`、`tools`、`vision` | `MXFP4` |
| `gpt-oss:20b` | `131072` | `low`、`medium`、`high` | `medium` | `completion`、`thinking`、`tools` | `MXFP4` |
| `clef:27b` | `65536` | 无 | 无 | `decision`、`vision` | `BF16` |

`clef:27b` 缺少 `completion` 和 `tools`，不能作为 Codex 的普通对话或工具模型，目录生成时应自动排除。`gpt-oss:20b` 没有 `vision`，目录中不得声明图片输入。

`deepseek-v4.1-flash` 与 `deepseek-v4.1-flash:1017` 的 `size` 相同，但 `digest` 不同。不能按名称、大小或去掉标签后的前缀自动判定为同一模型；模型 ID 必须按上游原样保存，标签不去除。若上游没有明确返回别名关系，就按两个独立候选处理并分别验证。

`/api/show` 还可能完全缺少 `thinking` 字段。只读复核中，`mistral-large-3:675b` 返回 `completion`、`tools`、`vision` 但没有 `thinking`；`mistral-large-4` 的 `capabilities` 包含 `thinking`，但 `thinking` 明细仍然缺失。因此 `capabilities` 不能替代 `thinking.values`，缺失时必须标记为待人工确认，不能自动生成或推断为 `none`。

### 生成流程

1. `GET /v1/models` 取得精确 ID 集合。
2. `GET /api/tags` 按 `name` 建立索引，核对集合差异，记录 `digest`、`size`、`modified_at` 和 `capabilities`。
3. 对每个候选 ID 调用 `POST /api/show`，从 `model_info` 中按实际架构键读取 `context_length`，例如 `deepseek_v41.context_length`、`gemma4.context_length`、`kimi-k3.context_length`。不要假设架构键固定为某个模型名。
4. 过滤：必须包含 `completion`；工具模型必须包含 `tools`；思考取值必须能映射到 Codex 支持的等级；上下文必须是正安全整数。过滤结果不自动启用，只在预览中展示。
5. 生成目录草稿，逐项展示来源字段、映射结果、被排除项和原因；用户明确选择模型后才写入 `models.json`。
6. 同目录写入 `models.manifest.json`，记录来源 URL、抓取时间、`/api/tags` 的 `digest` 集合或摘要，以及生成器版本；不写入 API Key、账户余额或对话内容。
7. 运行时只读取已保存的目录和 Profile，不在每次模型请求前调用 `/v1/models` 或 `/api/show`。刷新目录必须走模型目录事务，并保留备份。

三次接口读取不是原子快照。集合不一致、重复 ID、某个 show 失败或刷新途中模型变化时，记录待确认项并停止受影响模型的写入；不得把部分失败当作模型已下架，更不能整表覆盖后删除旧模型。所有下载均限制 HTTPS 固定来源、响应字节、总期限和并发，公开发现无需携带账户 Key。目录预览绑定本地目录、账户默认值及来源修订，保存前再核对；同族共享修改影响所有账户，不能只验证当前账户默认模型。

### 映射规则

| 上游字段 | 目录字段 | 规则 |
| --- | --- | --- |
| `/v1/models` 的 `id` | `slug` | 原样保存，不裁剪 `:tag`，不按 `/` 或 `:` 自动拆分 |
| `model_info["<arch>.context_length"]` | `context_window`、候选 `max_context_window` | 按实际返回的完整键名读取，不假设存在嵌套架构对象；作为候选值，不自动抬高 |
| `thinking.values` 中的 `false` | `supported_reasoning_levels` 的 `none` 候选 | 必须先确认该精确模型的 Responses `reasoning.effort=none`；原生 `think=false` 不直接证明兼容 |
| `thinking.values` 中的字符串 | `supported_reasoning_levels` 候选 | 只接受 Codex 已支持的 `none`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，再逐模型核对 Responses 支持；未知值不生成 |
| `thinking.values` 只有 `false`、`true` | 暂不自动生成 | 布尔开关没有确定的等级映射，需人工确认；不能编造 `low`、`high` 或 `max` |
| `thinking` 字段缺失 | 暂不自动生成 | 标记为待人工确认；不能从 `capabilities` 推断为 `none` 或某个等级 |
| `thinking.default` | `default_reasoning_level` | 必须落在映射后的等级集合内；`false` 映射为 `none`；不满足则跳过 |
| `capabilities` 包含 `vision` | `input_modalities` 的 `image` 候选 | 这是上游元数据声明；该精确模型完成 Responses 图片验证后才启用 |
| `capabilities` 包含 `tools` | 不直接映射 | 只表示上游声明工具能力，不能推出 `apply_patch`、`web_search` 或 `supports_search_tool` |
| `details.quantization_level` | 仅展示/清单 | 不参与模型选择或计费 |
| `capabilities` 不包含 `completion` | 排除 | 例如 `clef:27b` |

自定义目录定义上限为 64 个模型；[Codex 目录校验](../scripts/model-catalog-validation.mjs) 另有 2 MiB 字节上限，不能把模型数量上限等同于完整准入。受管目录实现时须核对相关数量和字节预算。原始快照的 23 个候选不保证全部可用。`gemma4:31b` 只有布尔思考值，不能自动生成 Codex 思考等级；[managed-provider-model-edit.mjs](../scripts/managed-provider-model-edit.mjs) 虽使用 `allowReasoningToggle: true`，当前入口仅允许 CLP 账户，不能直接用于 OLC。若扩展 OLC，须明确 `enabled` 的请求投影并完成该模型的 Responses 验证；不能把本地目录能解析当成上游兼容。`kimi-k3` 的 `max` 也只能作为该模型经验证后的默认候选，不是家族默认值。

### 上下文窗口

`/api/show` 对当前模型报告 `1048576`，当前 `cp-ollama` 目录声明的是 `393216`。当前会话读取的是目录值，所以上游元数据不能证明会话已经使用更大窗口。受管目录生成不能直接把 `context_window` 和 `max_context_window` 改成 `1048576`；需要先决定以下之一：

- 继续使用经过审查的 `393216`，把 `1048576` 作为待验证的上限；
- 通过真实的较长输入验证 `1048576` 可用后，再以模型目录事务同时更新窗口和上限；
- 使用明确的本地策略上限，并在 manifest 中记录该上限来自本地策略而不是上游元数据。

在完成选择前，不把上游上下文值写成已生效的会话能力。

## 账户接口映射

`/api/balance` 的受控响应结构（不记录金额）：

| 路径 | 类型 | 用途 |
| --- | --- | --- |
| `included.balance_usd` | 数字 | 当前包含额度剩余 |
| `included.allowance_usd` | 数字 | 当前周期包含额度 |
| `included.period.from`、`included.period.until` | 字符串 | 当前周期起止 |
| `purchased.balance_usd` | 数字 | 已购买额度剩余 |

`/api/usage?range=24h` 的受控响应结构：

| 路径 | 类型 | 用途 |
| --- | --- | --- |
| `range`、`scope`、`granularity` | 字符串 | 范围元数据；当前观测为 `24h`、`self`、`hour` |
| `from`、`until` | 字符串 | 查询范围 |
| `totals.request_count` | 整数 | 请求数 |
| `totals.usage_usd` | 数字 | 上游报告的费用 |
| `totals.input_tokens`、`cached_input_tokens`、`output_tokens` | 整数 | 上游 Token 汇总 |
| `buckets[]` | 数组 | 按小时桶，字段与 `totals` 对应 |

候选 `ProviderAccountUsage` 映射（待验证）：

字段语义来自字段名和一次只读观测（`included.balance_usd <= included.allowance_usd`），不是官方文档确认。写入适配器前需要验证“剩余额度”假设。

- 使用 `kind: "balance"`，`provider` 为具体账户 Provider ID。
- `currency` 为 `USD`。
- `totalBalance` 为 `included.balance_usd + purchased.balance_usd`。
- `grantedBalance` 为 `included.balance_usd`。
- `toppedUpBalance` 为 `purchased.balance_usd`。
- `ProviderBalance` 的金额是十进制字符串。[DeepSeek 适配器](../src/bootstrap/deepseek-account-adapter.ts) 的 `decimal` 只校验有界字符串语法，不提供数字求和或固定小数精度规则。OLC 实现前须确定字段精度、范围和负余额语义；使用明确的十进制单位做受控求和与格式化，拒绝无法无损表达的数据，不用浮点相加后随意 `toFixed`，不把缺失、负值或无效值默认为零。
- `401` 应通过 [AccountQuery](../src/bootstrap/account-query.ts) 映射为受控查询失败，不返回伪造余额，也不回退到默认账户；`available` 只在成功解析后为 `true`。
- 适配器通过 `loadConfiguredProviderCredential(provider, environment)` 读取具体 `olc-<account>` 的私有 Key，不读取默认账户的 Key。

`included.allowance_usd` 和 `included.period` 没有直接对应 `ProviderBalance` 的字段。第一版 `/usage` 只展示三类金额，不显示周期额度百分比或重置时间；若需要展示周期，应单独设计适配器输出和界面，不把周期强行塞进 `credit-usage`。`/limits` 对 Ollama Cloud 保持不支持。

`/api/usage` 的上游费用和小时桶当前也没有对应的 `ProviderAccountUsage` 字段。项目不在本地计算价格，`/usage` 的本地 Token 统计继续由指标库按 Provider 过滤。第一版不把上游费用混入本地统计；后续若需要，必须新增明确的展示合同并验证账户过滤。

### 计费时段与单价

[Ollama Pricing](https://ollama.com/pricing) 在 2026-10-26 的页面口径是：工作日 `12:00–18:00 UTC` 为峰时；工作日 `12:00` 前、`18:00` 后以及周末全天为谷时。原文为 “Off-peak pricing apply outside 12:00 and 18:00 UTC on weekdays and all day on weekends.”。实现、展示和验收都应使用 UTC 规则，不按本机时区推断。

`deepseek-v4.1-flash` 的官方单价如下，单位为美元/百万 Token：

| 时段 | 输入 | 缓存输入 | 输出 |
| --- | --- | --- | --- |
| 峰时 | `$0.30` | `$0.006` | `$1.20` |
| 谷时 | `$0.15` | `$0.003` | `$0.60` |

审查期间补充的原始快照标注时间为 2026-10-26 `16:45 UTC`，即周一峰时，并记录小时桶从 `13:00 UTC` 开始、共 313 个请求。本轮未独立读取这些桶，不能仅凭查询时刻确认全部请求适用峰时价格；还需核对完整桶范围、模型归属以及带版本模型 `deepseek-v4.1-flash:1017` 与价格表模型的映射。

仅在确认总输入包含缓存输入、三类 Token 互不重复且所有请求适用同一组单价后，可按以下公式核算；单价单位为美元/百万 Token：

`((总输入 − 缓存输入) × 输入单价 + 缓存输入 × 缓存单价 + 输出 × 输出单价) / 1,000,000`

在这些前提下，不能把总输入直接乘输入单价，也不能用一个“混合单价”反推其他时段。`/api/usage` 的 `totals.usage_usd` 是快照中的上游报告费用，是否为最终结算金额尚未确认；本地 `reasoning_tokens` 不参与该公式。此处只核算记录，不新增本地定价功能。

补充快照中的 24 小时汇总为：输入 `41,095,168`、缓存输入 `39,881,860`、输出 `278,116`，上游 `usage_usd` 为 `0.93862 USD`。本轮用整数运算核对公式：假设上述前提成立且全部按峰时计价，结果为 `0.93702276 USD`，与报告费用相差 `0.00159724 USD`（约 `0.17%`）；全部按谷时计价则为 `0.46851138 USD`。差异原因未定位，不能归因为舍入或查询窗口边界，也不能据此确认字段语义。这是条件化算术核对，不是账单验证或未来费用保证。

## freeform 工具适配要求

这是方案 B 完整编码能力验收的前置阻塞项。账户与目录框架可先实现，但不能在 freeform 未验收时宣布方案 B 完整可用。

### 观测事实

- Codex 向 Ollama 发送的 `apply_patch` 工具声明是 `type: "custom"`，并带有 `format: { type: "grammar", syntax, definition }`；不是普通 `function`。
- Ollama 接受该请求并返回 `200`，但把该调用表示为 `function_call`：
  - `response.output_item.added` 和 `response.output_item.done` 的 `item.type` 为 `function_call`，`name` 为 `apply_patch`；
  - `item.arguments` 是可解析 JSON，键为 `input`，值是原始补丁文本；
  - 流式路径同时使用 `response.function_call_arguments.delta` 和 `response.function_call_arguments.done`。
- 原始记录称当时直接调用 Codex 原生 `apply_patch` 四次均输出 `aborted`，目标文件未创建；普通 `function` 工具（如 `exec_command`）正常。本次文档复核未重放这些调用。
- `function_call` 与已声明 custom 工具的结果类型不匹配，是源码合同支持的风险；四次 `aborted` 的精确原因仍缺少可关联的客户端诊断。本轮不能据此排除审批、取消、工具分派或其他执行阶段，也不能把拟议转换写成已经证明可修复这些失败。

### 双向映射

| 位置 | 当前表示 | 适配后 |
| --- | --- | --- |
| 请求工具声明 | `type: "custom"`、`name: "apply_patch"`、`format` | 上游已接受时可保留；若改为普通函数声明，必须使用单个字符串参数并让模型返回原始补丁文本 |
| `response.output_item.added` | `function_call`，`arguments` 为空字符串 | `custom_tool_call`，`input` 为空字符串；保留 `name`、`call_id`、`id`、`status`、`output_index` |
| `response.output_item.done` | `function_call`，`arguments` 为 `{"input":"..."}` | `custom_tool_call`，`input` 为解包后的原始补丁文本 |
| 流式参数增量 | `response.function_call_arguments.delta` 的 JSON 包装片段 | 按调用累计有界参数；不能只改事件名后原样输出。完成并解包后发送原始输入的 custom delta，见下文 |
| 流式参数完成 | `response.function_call_arguments.done` | `response.custom_tool_call_input.done`，`arguments` 解包为 `input` |
| 终止快照 | `response.completed` / `response.incomplete` 的 `response.output[]` | 同步改写其中的 custom 工具项，保证增量与最终快照一致 |
| 历史回传 | Codex 发送 `custom_tool_call` / `custom_tool_call_output` | 转成上游可接受的 `function_call` / `function_call_output`；`custom_tool_call` 的 `input` 重新包装为 `{"input":"..."}` |
| 非流式响应 | 普通 JSON 的 `output[]` | 与流式终止快照使用同一改写规则 |
| 无法解包 | `arguments` 不是含单个字符串 `input` 的对象 | 失败关闭，返回受控错误；不把包装 JSON 当补丁文本，不静默执行 |

原始记录称 `response.output_item.added` 的 `arguments` 长度为 `0`，完成事件才包含完整 JSON。`added` 可接受空参数并输出空 `input`；`done` 和终止快照必须包含可解包的完整对象，空字符串同样是无效完成参数，不能用“非空才校验”绕过。上文出现过的 `parameters` 包装没有足够一致证据，不作为 `input` 的隐式别名；新增支持需独立确认协议。

响应适配只匹配同一次请求中明确声明为 custom 的工具身份（含命名空间），不能仅凭 `name=apply_patch` 改写普通函数。维护有界的 `item_id` / `call_id` / `output_index` 对应关系，防止并行调用、重复完成及跨响应串用；未知或歧义身份失败关闭。已有标准 custom 项保持原表示，普通 function 项不改写。通过 OLC 显式能力开关启用，不按 URL、模型名或所有第三方 Provider 猜测；嵌套/延迟工具声明仅在确认其当前协议形态后支持。

### 流式与代理边界

现有 ProviderProxy 的 Responses 路径以字节透传为主。[proxy.ts](../src/provider-proxy/proxy.ts) 在 `upstreamResponse.on("data")` 中依次调用 `exchange.responseChunk`、`metricsObserver.observeChunk` 和 `writeResponseChunk`。SSE 事件可能跨 chunk，不能直接在每个 chunk 上做 JSON 解包。[readModelFrames](../src/provider-proxy/chat-io.ts) 当前用于 Chat 桥，复用前须核对其对 Responses 事件名、多行 data、UTF-8 跨块、终态和错误的合同，不能仅因同为 SSE 就直接替换。

首版采用“每个 custom 调用有界缓冲完整 JSON 参数，完成后解包一次”的方案：例如两个上游 delta `{"input":"*** Begin` 与 ` Patch\\n..."}` 不是可执行补丁增量，不能直接重命名事件发送。验证完整对象仅有一个字符串 `input` 后，发出解码后的输入 delta 和 done，再交付该项完成事件。`arguments.done`、`output_item.done` 与终止快照的重复表示必须一致且只输出一次输入；终态缺少完整参数不伪造成功。其他独立输出项仍按原事件次序传送；若合成事件使数量变化，统一生成单调的下游 `sequence_number`，不能复用造成重复序号。此策略改变 custom 输入的显示延迟，不改变其原始文本。

新增改写必须：

- 按事件边界解析，不缓存完整响应；新增或复用有界 Responses SSE 事件组装器，明确单事件、单增量和缓冲区的字节上限；
- 在 `output_item.added` 允许空 `arguments`，在 `done` 和终止快照才要求可解包；
- 保持事件顺序、`output_index`、`call_id` 和背压，不改变文本、推理和普通 function 工具事件；
- 处理请求取消、上游断流、客户端断开和半事件，不能在改写缓冲中无限等待；
- 同时覆盖 HTTP/SSE 和非流式 JSON；非流式 JSON 需要完整缓冲，必须定义响应大小上限和超限行为；
- 明确单调用参数、并行调用数、全响应累计缓冲的上限及清理；超限拒绝，不退回未归一化的半段内容。改写正文后移除或重算 `Content-Length`，拒绝未实现解码的压缩响应；同步 SSE `event:` 与 JSON `type`，不能只改其中一处；
- 明确原始转储与指标的观察点：建议转储和指标继续观察原始上游字节，下游写入前再做归一化；若无法同时保留，必须明确记录转储显示的是改写后内容，不能声称仍是原始上游；
- 现有指标归约器已经同时识别 `function_call` 和 `custom_tool_call`，改写后仍应保持可归约；
- 对 `done` 或终止快照中 malformed `arguments`、缺失 `call_id`、非字符串 `input` 失败关闭，并输出不含补丁正文的受控错误。

HTTP 响应头或部分 SSE 已发出后，不能再返回一个新的 HTTP JSON 错误或伪造 `response.completed`；应按支持的流错误/断流合同结束，指标保留原模型终态与转换/交付失败的区别。上游已完成不证明下游正确接收，不能仅靠原始指标观察器提前把归一化失败记为交付成功。请求/响应字节发生改写时，明确指标各计数的上游/下游口径。

Model Relay 使用独立的 [server.ts](../src/model-relay/server.ts) 和模型 API 发送链；如果首版开放 OLC Relay，必须通过模块公开出口复用同一纯转换能力，并单独接入 Relay 的材料修订、Key 授权、取消、背压和错误映射。未接线前不能把 Proxy 的成功视为 Relay 兼容，不通过引入 Codex 私有输入归一化来绕过 Relay 边界。OLC 的 WebSocket 仍显式关闭。

### 请求侧历史

Codex 在后续请求中可能发送 `custom_tool_call` 和 `custom_tool_call_output`。当前 [normalizeResponsesRequest](../src/model-api/responses-normalize.ts) 只处理 `agent_message` 降级和工具参数 `encrypted` 标记，没有 custom 工具历史转换。

需要在同一请求归一化阶段增加：

- `custom_tool_call` → `function_call`，`input` 包装为 `{"input":"..."}`；
- `custom_tool_call_output` → `function_call_output`，保留 `call_id` 和 `output`；
- 仅对启用该响应归一化能力的 OLC 请求生效，不能让其他第三方 Responses 上游误收包装后的参数。

历史转换必须按请求中显式 custom 调用及 `call_id` 配对，不凭工具名改写普通函数输出；孤立输出、重复 ID、命名空间歧义和无法表示的结果失败关闭，不从其他请求或账户补全。结果可能是文本或结构化内容数组，不能无条件压成字符串。还须核对 `tool_choice` 的 custom 选择、工具白名单和请求声明是否与最终上游表示一致；不支持的组合在请求发出前拒绝，不默默放宽选择条件。官方无状态边界要求显式历史，不能靠上游保存响应来补齐。

完成后必须用两轮真实请求验证：第一轮发起 `apply_patch`，第二轮携带工具结果继续，确认历史回传不会再次触发 `aborted`。

### 兼容前的工作方式

适配完成前，新建 OLC 目录应显式设 `apply_patch_tool_type: null`（定义层对应 `applyPatchToolType: null`）。锁定 Codex 在该字段非空时注册原生工具；已有目录不能仅删除定义字段便声称当前 Thread 已生效，应走明确的目录保存与实例/新 Thread 激活流程。`exec_command` 是否可用仍取决于实际工具与授权，不能替代原生 freeform 验收。本次文档审查不调整现有 `cp-ollama`。

### 验收

- 非流式和 SSE 流式各完成一次真实文件创建/修改，且由 Codex 原生 `apply_patch` 执行；
- 下一轮请求携带 `custom_tool_call_output` 历史时，模型能基于结果继续；
- malformed `arguments` 返回受控错误，目标文件不变；
- 参数尚未完整确认前取消，不发出可执行的完成项，并释放转换缓冲与事件等待；若其他工具已执行或本次工具已开始执行，取消不保证文件回滚，必须按实际工具结果记录已发生副作用；
- 普通 function 工具、图片输入和文本流不受影响；
- 不新增测试文件；使用真实用户路径和现有静态检查作为证据。

## 网页搜索适配设计（待实现）

2026-10-26 核对 [Ollama 网页搜索官方文档](https://docs.ollama.com/capabilities/web-search)：Ollama 提供独立的搜索与网页读取 API，使用账户 API Key；这不等于 `/v1/responses` 支持内置 `web_search`。本轮只核对文档，没有调用搜索服务或验证当前账户额度。

| 能力 | 官方接口 | 输入与结果 |
| --- | --- | --- |
| 网页搜索 | `POST https://ollama.com/api/web_search` | `query`；可选 `max_results` 默认 5、最多 10；返回 `results[]` 的标题、URL 和内容摘要 |
| 网页读取 | `POST https://ollama.com/api/web_fetch` | `url`；返回标题、正文和链接 |

### 借鉴 CLP 的执行流程

目标是在 OLC 的 Responses 路径中适配客户端声明的 hosted `web_search`。参考 [CLP 转换合同](cline-pass.md#chat-转换边界)和 [model-api 职责](../src/model-api/README.md)，执行流程为：

`Responses 搜索声明 → 内部普通函数声明 → 模型产生搜索调用 → 代理调用 Ollama 搜索 API → 配对回传结果 → 继续 Responses 生成 → 交付搜索生命周期及回答`

这需要请求、响应和工具执行共同适配，不是仅修改 JSON 参数。CLP 的 `cline_provider_options` 只覆盖其出站 `providerOptions`，不能替代搜索执行器；OLC 也不改走 Chat Completions，不直接套用 `ChatToResponses`。纯工具映射和响应状态放在 `model-api`，账户凭据、HTTP 执行与取消由 Provider Proxy 的生命周期所有者负责，通过模块公开出口组合。正式实现前核对锁定 Codex 的搜索事件合同，不直接伪造 App Server 事件。

### 范围与约束

- 首版拟支持 live 文本搜索。官方搜索接口未声明域名过滤、地域、缓存搜索或搜索上下文大小控制；遇到这些无法兑现的控制须在出站前明确拒绝，不沿用 CLP 的域名过滤承诺，也不静默删除参数。`tool_choice` 与工具身份同步映射，未知选择失败关闭。
- 网页读取作为单独的后续能力保留，不自动把 `web_search` 的所有 open/find 动作映射为 `web_fetch`；启用前明确 URL 准入、动作语义和输出合同。官方 MCP 示例是另一种客户端接法，本方案不自动安装或注册 MCP。
- 仅在可信 OLC 能力明确启用且请求声明搜索时执行，内部函数身份不得与用户工具冲突。搜索使用当前具体账户的凭据，续答沿用同一模型及授权，不回退其他账户；凭据只发送到固定官方搜索服务，不发送到结果网址。
- 同批搜索与客户端工具调用借鉴 CLP 的处理：先搜索，同批客户端调用不派发，以明确的 `not_executed` 结果告知模型后重新决策；完整保留调用组与配对结果，后续纯客户端调用才交给 Codex。不得执行客户端文件/命令工具或伪造其成功，调用 ID 必须在多轮和并行调用间保持唯一关联。
- SSE 必须先有界收齐并校验整轮工具调用，再决定搜索或交付客户端执行；在尚不确定是否混合调用时，不向客户端发布可执行的工具完成项。内部 ID 与外部 `response_id`、item ID、`output_index`、`sequence_number` 分别映射，跨轮连续且终态一致，不能透传每轮上游的独立响应身份。
- 内部续答显式携带完整必要历史，不使用 `previous_response_id`，不建立跨请求会话缓存。搜索来源只作为当前请求的外部资料，不当作系统指令；来源链接不能直接伪造成正文的精确引用注解。后续请求缺失搜索正文时不得补造结果。
- 后续外部请求中的 `web_search_call` 历史须在 OLC 请求边界显式处理：可读查询只作为历史说明，不自动重搜、不当作尚待执行的函数，也不假设上游接受原生搜索项。锁定 Codex 的 `WebSearchAction::Search` 只有查询字段，不能依赖额外的 `sources` 在会话恢复后完整保存；来源正文仅在本次内部续答保留，不写入 Gateway 会话存储。
- Ollama 搜索结果包含 `content` 摘要；现有 [CLP 搜索执行器](../src/provider-proxy/cline-web-search.ts) 解析的是 `data.results`，只投影标题和 URL。OLC 必须按自己的顶层 `results` 合同解析并有界保留摘要，不能只替换 CLP 的请求地址；摘要与来源 URL 保持逐条关联，拒绝畸形结构和非法 URL，不把摘要称作网页全文。
- 整次请求共享取消信号和总期限，另设搜索次数、模型轮次、并发、结果字节及累计上下文上限。取消、断连、授权失效或预算耗尽后不继续搜索/续答；不无限重试，不把 HTTP 200、空响应体或畸形结果当成搜索成功。合法空结果与查询失败分别表示。
- `max_output_tokens` 是整次外部请求的预算，内部续答须扣除此前各轮已报告的输出消耗；显式预算下计数缺失或已耗尽时停止续答，不能为每轮重新分配全额。初轮强制搜索完成后，将内部续答的对应强制选择调整为允许回答的模式，避免强制搜索循环；上游违背 `tool_choice: none` 发起搜索时也不得执行。每次搜索和模型续答前复核账户授权与目录材料，变化时停止，不拼接新旧配置。
- 对外只交付一个一致的 Responses 响应：内部轮次的终态不提前结束外部响应；SSE 与非流式路径同步处理调用身份、搜索生命周期、最终快照与错误。累计各轮已知模型用量，缺失计数保持未知；搜索费用不编造成模型 Token 或余额扣减，日志不泄露查询正文、原始网页或凭据。
- 独立 Model Relay 不经过 Proxy 实例；若提供相同搜索能力，须独立接入共享转换与执行接口，并核对 Key 授权和材料失效。未接入时明确不支持，不因渠道路径可用就宣称 Relay 可用。

### 验收与状态

实施时观察真实用户路径：Codex 发起搜索、官方 API 返回结果、模型据此续答、客户端显示对应搜索状态；SSE 与非流式分别核对。反例覆盖不支持的控制、账户隔离、混合工具、空结果、畸形响应、认证失败、限流、超时、取消和轮数耗尽，确认不误执行客户端工具、不提前完成、不重复派发，且用量无漏计或重复累计。不新增测试或探针文件。

当前仅完成设计记录。尚未验证账户搜索权限、费用/限额、真实 API 输出、搜索事件还原及完整往返；实现并验收前不得标记为已支持。网页读取仍是单独待设计能力。

## 方案 B：受管多账户接入设计（分批实施中）

方案 B 复用现有受管 Provider 管道，新增一个独立家族。它不修改 `cp-ollama`，也不把 Ollama Cloud 注册成 Codex 内置的 `ollama`；内置 `ollama` 的 Provider ID 已被保留，继续面向本地 Ollama 语义。方案 B 不包含迁移：`cp-ollama` 与新受管账户互不导入、互不转换。

### 身份与路径

| 项目 | 方案 |
| --- | --- |
| 家族/存储 ID | `ollama-cloud` |
| 账户 Provider ID | `olc-<account>` |
| 账户 ID | 1–32 位小写字母、数字、`-` 或 `_` |
| Profile | `sf-olc-<account>` |
| Profile 文件 | `sf-olc-<account>.config.toml` |
| 环境变量 | `CODEX_CONNECT_OLLAMA_CLOUD_<ACCOUNT>_API_KEY` |
| 显示名称 | `Ollama Cloud <account>` |
| 上游地址 | `https://ollama.com/v1` |
| 协议 | `responses` |
| WebSocket | `false`，显式声明 |

目录布局：

- `~/.codex-connect/providers/ollama-cloud/models.json`：全家族共用模型目录；
- `~/.codex-connect/providers/ollama-cloud/models.manifest.json`：来源、抓取时间、摘要和生成器版本；
- `~/.codex-connect/providers/ollama-cloud/accounts.json`：账户注册表，字段为 `id`、`default`；空注册表表示尚未配置账户，非空时必须且只能有一个默认账户；
- `~/.codex-connect/providers/ollama-cloud/olc-<account>/managed.toml`：账户管理标记；
- `~/.codex-connect/providers/ollama-cloud/olc-<account>/backup/config.json`：初始配置备份；
- `~/.codex-connect/providers/ollama-cloud/olc-<account>/primary-credentials/<version>.json`：私有凭据版本。

共享目录中的思考等级、上下文窗口和模型启用情况由同族账户共用；默认模型属于具体账户。账户添加、重配、移除、默认账户切换和模型管理都必须复用现有的受管事务、修订校验和备份恢复流程，不另写一套写入器。

`<ACCOUNT>` 使用既有账户模块的 `-` 转 `_`、转大写规则；例如 `a-b` 与 `a_b` 会产生同一变量名，不能同时登记。复用 [validateBasicManagedProviderAccounts](../runtime/managed-provider-account-registry.mjs) 的 ID 与凭据变量双重唯一性校验，不能仅验证正则。固定模式的实际主配置位于 Codex Home 的 `config.toml`；表中独立 Profile 主要描述切换模式，备份和恢复仍按所选模式处理。

### Provider 定义与账户模块

- 在 `runtime/model-provider-definitions.mjs` 新增冻结定义：`id: "olc"`、`storageId: "ollama-cloud"`、`baseUrl`、`wireApi: "responses"`、`apiKeyEnvironmentKey`、`supportsWebsockets: false`、`capabilities: { accountAdapter: "ollama-cloud", instanceAdapter: "ollama-cloud-accounts" }`；在 `managedProviderAccountFamilies` 中登记唯一的 `aggregateMaterialOrder`，聚合入口仍保持关闭。
- 更新 `runtime/model-provider-definitions.d.mts`：`ManagedModelProviderId` 增加 `"olc" | \`olc-${string}\``，账户/实例适配器联合增加 `"ollama-cloud"` 与 `"ollama-cloud-accounts"`，并导出新定义和账户展开函数。
- 与 CCG 一样，基础定义不设置全局 `defaultModel` 或 `defaultReasoningEffort`；每个账户必须显式选择目录中的模型，避免把当前 `deepseek-v4.1-flash:1017` 或 `kimi-k3` 的 `max` 误当成全家族默认。
- 新增 `runtime/ollama-cloud-accounts.mjs`，提供账户 ID 校验、Provider ID、Profile 名、环境变量名、账户目录、标记路径、注册表路径和加载函数；注册表复用 `validateBasicManagedProviderAccounts`。
- 将家族登记到 `managedProviderAccountFamilies`，并提供 `ollamaCloudAccountDefinition(accountId)`，将基础定义展开为 `olc-<account>` 的运行时定义。
- 在 `src/bootstrap/managed-provider-capabilities.ts` 增加账户适配器分支；新增 `src/bootstrap/ollama-cloud-account-adapter.ts`。
- `runtime/model-provider-custom-runtime.mjs` 目前只对 `ds-`、`clp-`、`ccg-`、`opencode-go` 做硬编码命名空间保留；`managedProviderDefinitions(environment)` 只包含已展开的账户定义，空注册表时不会保留 `olc-*`。必须新增 `olc` 命名空间检查，不能只依赖注册。
- `runtime/app-server-service-runtime.mjs`、`runtime/model-provider-startup-runtime.mjs` 等启动路径应通过定义和账户注册表取得 Key 环境变量，不新增硬编码的 Ollama 分支。

### 校验规则

现有受管校验不能直接复用：

- Key 校验当前对非 CCG/CLP 家族要求 `sk-` 前缀；原始记录中的 Ollama Key 不符合该前缀。拟为 `ollama-cloud` 使用独立的非空 Bearer 文本语法 `[A-Za-z0-9._~+/-]+=*`、长度上限 4096；这是本地准入策略，不是官方 Key 格式保证，不按一个样本固定长度，也不放宽其他家族。语法通过不表示认证成功。
- 模型 ID 校验当前区分 CCG、CLP 和其他家族；其他家族的默认分支不接受冒号。OLC 需要独立分支接纳已确认的精确 ID，例如 `deepseek-v4.1-flash:1017`；总长度最多 200 字符，与现有模型管理和 Relay 模型部分上限一致，继续拒绝控制字符、零宽格式字符、孤立代理字符和首尾空白。上游发现超限 ID 时在候选预览中明确排除，不截断后保存。
- 模型 ID 是上游不透明标识，不做大小写折叠、标签裁剪或别名替换。
- 默认模型必须属于共享目录；删除、停用和默认模型保护沿用现有规则。
- 目录必须至少包含 1 个模型并通过现有 Codex 目录校验；自定义定义当前限制 64 个，受管目录须确认实际数量与字节上限。每个模型必须有非空思考等级、合法默认等级、正上下文窗口和 `text` 输入能力；`vision` 元数据与该模型的 Responses 图片验证同时成立后才加入 `image`。

### 模型目录生成

新增独立的目录生成器，例如 `scripts/ollama-cloud-catalog.mjs`，不要让现有 DS 模板下载器承担 Ollama 的语义：

1. 读取 `/v1/models`、`/api/tags` 和 `/api/show`；`/api/show` 逐模型调用需要有界并发、`429` 处理和失败分类，不能一次性无界并发。
2. 按上一节的规则过滤、映射和记录排除原因。
3. 明确提示词模板来源，使用选定的固定 `official` 模板生成 `model_messages`，能力则来自 Ollama 元数据及该精确模型的验证结果；不从底座复制上游能力，也不复用 DS 官方端点限制。模板更新须增加 `ollama-cloud` 的来源读取和允许范围分支，不能落入现有 DS 来源投影；具体衔接见下节。
4. 本地工具声明沿用 `withThirdPartyLocalTools` 的 `send_user_message_async`、`clock` 投影；模板更新时保留这些声明。显式创建或更新时按现有第三方模板规则追加“使用中文回复用户”的审批要求。
5. `apply_patch_tool_type` 在 freeform 适配完成前为 `null`，完成后才允许设为 `freeform`。
6. 不声明未验证的 `web_search_tool_type`、`support_verbosity`、`supports_parallel_tool_calls` 或原生搜索能力。
7. 保存前使用现有 [model-catalog-validation.mjs](../scripts/model-catalog-validation.mjs) 调用本机 Codex 目录校验；校验失败不写入。
8. 保存前预览差异与同族账户影响，保存时绑定修订、备份旧目录并同步受影响账户的默认思考镜像，保存后回读；目录变化不自动重启服务，只提示需要的激活操作。无变化不写；回读或恢复结果不确定时报告 `save-unconfirmed`，不重试覆盖。

`/api/show` 是公开接口，不能用它验证 Key；Setup 的 Key 预检使用 `/api/balance`，并只处理受控状态码和错误分类。目录刷新可以只依赖公开接口，但这不会证明账户可用。`models.manifest.json` 应记录 `/v1/models`、`/api/tags`、`/api/show` 的来源、抓取时间和摘要，不写入 Key、余额或对话内容。

### 与统一模型管理的衔接

Ollama 元数据来源与提示词模板关联必须分别保存。新家族 manifest 的顶层 `source` 标识 `ollama-cloud`，其他来源快照字段在实现时定义有界结构，记录前述三个接口及候选摘要；逐模型 `modelTemplates` 仍采用现有 `{ source, model }` 合同，只保存用户明确选定的 `official` 提示词模板。`model` 是模板的精确来源 ID，不填 Ollama ID 或接口 URL。现有 [来源读取器](../runtime/model-template-bindings.mjs) 仅接受 `official`、`deepseek`、`cline`，不能把 `ollama-cloud` 直接写入逐模型模板来源而声称兼容。独立填写或继承模型不自动绑定模板；`templateUpdates` 继续记录实际确认的来源摘要与更新分组。来源、目录、备份和相关 Profile 必须由同一受管目录事务保存，移除模型同步裁剪该模型的关联和更新记录，其他来源快照保留。

首版 OLC 的 `official` 模板更新只开放提示词及用户明确选择的现有运行设置（有效上下文比例、压缩阈值、截断策略），保留未选字段、本地工具和已验证的模型能力；不开放从 `official` 覆盖能力。现有受管模板计划的 `capabilities` 分组会复制来源的图片、思考等级、最大窗口等字段，并不证明 Ollama 支持这些值。已有模型需要更新 Ollama 能力时，须先补齐按精确 ID 的元数据/验证投影、预览与修订合同，再复用目录 writer；未完成时明确不支持，不通过“发现新增”覆盖旧条目，也不借用 CLP 完整编辑器绕过。首次生成所用的提示词和本地工具仍按上一节投影。

| 衔接位置 | 当前限制与 OLC 必须补齐的内容 |
| --- | --- |
| [统一新增计划](../scripts/provider-model-additions.mjs) | 受管读取和独立填写目前只允许 CCG/OCG/CLP；发现的非 CCG 默认分支调用 OCG 生成器。OLC 须显式增加读取、ID 校验、独立填写/继承及 Ollama 候选分支，禁止仅放宽白名单后落入 OCG 路径。 |
| [统一模板计划](../scripts/provider-model-template-management.mjs)、[目录投影](../scripts/provider-model-catalog.mjs) | `allowedTemplate`、`loadSourceTemplates`、字段分组与预览/执行必须共同支持 OLC；现有 DS 投影只接受 DS/CCG/OCG。读取 `official` 提示词不代表允许复制其能力，来源候选和确认须绑定同一摘要。 |
| [目录事务](../runtime/model-provider-managed-runtime.mjs)、[模型管理读取](../scripts/provider-model-management.mjs) | 核对新 manifest 被列表、详情、默认设置、移除及恢复共同接受；保持共享目录和账户默认模型边界，不新增平行 writer 或改写其他家族来源。 |
| [WebUI 管理路由](../scripts/webui-management-provider-route.mjs)及其类型/界面 | 账户来源、操作可用性、来源选项和确认投影与共用计划一致；不显示后端尚未支持的能力更新或高级编辑入口。 |

### 账户用量

新增的账户适配器通过 `loadConfiguredProviderCredential(provider, environment)` 读取具体 `olc-<account>` 的私有凭据，调用 `/api/balance`，按上一节候选映射为 `balance`。`401` 通过 `AccountQuery` 映射为受控查询失败，不返回伪造余额，也不回退到默认账户；`available` 只在成功解析后为 `true`。`/limits` 保持不支持，第一版 `/usage` 只展示 USD 余额，不展示周期或重置时间。

第一版不把 `/api/usage` 的上游费用接入 `/usage`，也不在本地计算价格；本地 Token 统计继续来自指标库并按 Provider 过滤。若后续要展示周期额度或上游费用，需要先扩展 `ProviderAccountUsage` 的合同和所有展示端，不在目录生成阶段隐式加入。

### 运行模式与隔离

- 同时支持固定模式和切换模式：固定模式仅一个由基础配置选定 Provider 的主 App Server；切换模式才按具体 `olc-<account>` 展开 Provider 隔离实例和私有 Profile，不在固定模式为所有账户另启实例。
- 共享模型目录和思考等级；账户各自保存默认模型。
- 受管 Key 只进入目标子进程环境或私有凭据文件，不进入 Gateway 配置、命令行、日志或平台消息；启动时剥离其他 Provider 的 Key。
- 模型守卫在提交前复核目录，未知或已停用模型返回 `409 provider_model_disabled`，目录不可用返回 `503 provider_catalog_unavailable`，不回退到其他模型。
- 当前 `cp-ollama` Profile 使用 `request_max_retries = 4`、`stream_max_retries = 5`；受管 Profile 需明确沿用或调整，并补充 `429`/`5xx`、超时和流中断的分类，未验证前不承诺自动重试。
- 重复思考保护按现有第三方 Provider 通用路径继承；实现时确认 `olc-*` 不被当作 OpenAI 官方 Provider。
- 继承现有 60 秒全局空闲关闭、按需重连、租约保护和自动解除通知，不新增 Ollama 专属生命周期。

### 入口与文档

| 责任 | 需要同步的位置 | 说明 |
| --- | --- | --- |
| Provider 定义与账户 | `runtime/model-provider-definitions.mjs`、`runtime/model-provider-definitions.d.mts`、`runtime/ollama-cloud-accounts.mjs`、`runtime/model-provider-managed-runtime.mjs` | 定义、类型联合、账户展开、`aggregateMaterialOrder` |
| 命名空间保留 | `runtime/model-provider-custom-runtime.mjs` | 显式保留 `olc` / `olc-*`，不能只依赖已展开账户 |
| Bootstrap 适配 | `src/bootstrap/managed-provider-capabilities.ts`、`src/bootstrap/ollama-cloud-account-adapter.ts` | 适配器分支、余额查询、受控错误 |
| Setup | `scripts/ollama-cloud-setup.mjs`、`scripts/setup.mjs` | 菜单、Key 预检、目录生成、Profile、备份 |
| 模型管理 | `scripts/provider-model-setup.mjs`、`scripts/provider-model-additions.mjs`、`scripts/managed-provider-model-management.mjs`、`scripts/provider-model-catalog.mjs`、`scripts/provider-model-template-management.mjs` | 新增/编辑/移除、模板来源、目录校验 |
| WebUI | `scripts/webui-api.ts`、`scripts/webui-management-provider-route.mjs`、`scripts/webui-account-settings-management.mjs` | 来源/操作类型、账户加载、configure/default/remove |
| 展示 | `src/surfaces/provider-format.ts` | 渠道短标签 `OLC <account>` 和目录展示名前缀 |
| Freeform | `src/model-api/responses-normalize.ts`、`src/provider-proxy/proxy.ts` | 请求侧历史转换、响应侧 SSE/JSON 归一化 |
| 网页搜索 | `src/model-api/`、`src/provider-proxy/` | Responses 工具映射、独立搜索执行、内部续答、外部响应生命周期及累计用量；参见网页搜索适配设计 |
| Relay | `src/model-api/`、`src/model-relay/server.ts`、Relay 材料组合入口 | 通过公开接口接入共享转换；独立核对身份、材料版本、错误与交付，不能假定 Proxy 改动自动覆盖 |
| 文档 | 见下方“文档影响矩阵” | 不能只更新根索引和 `docs/index.md` |

基础定义使用 `definition.id=olc`，展开账户使用 `definition.id=olc-<account>`；两者的 `storageId=ollama-cloud` 相同。复用已有 `managedProviderAccountFamilyForDefinition` 等家族能力入口，逐项区分具体账户键与共享目录键，不另建重复判断函数。注册定义不表示 WebUI、CLI 模型新增、本地编辑和模板管理自动可用。CLI 子命令名称需在实现前确定；`codexc provider ollama-cloud` 只是建议，当前不能执行，不增加未经实现的帮助入口。

### 文档影响矩阵

该矩阵是待实现后的联动清单，不是已经完成的更新。

| 文档 | 需要更新 | 当前状态 |
| --- | --- | --- |
| `README.md` | 多账户 Provider 列表、Provider 专题链接 | 待实现后更新 |
| `docs/user-guide.md` | `provider` 子命令、账户菜单、模型管理、模板更新、Relay 协议说明 | 待更新 |
| `docs/display.md` | `OLC <账户>` 短标签、余额展示、按需运行 Provider 列表 | 待更新 |
| `docs/errors.md` | `model.provider.default-missing` 的账户列表 | 待更新 |
| `docs/index.md` | Provider 路由、Profile 名称、账户用量适配器、目录校验、支持矩阵相关段落 | 待逐段核对 |
| `docs/provider-integration-guide.md` | 受管家族列表、日常模型管理、异步提问/时钟、重复思考保护、目录布局、模板更新 | 待逐段核对 |
| `docs/upstream-sources.md` | Ollama 官方 API 文档来源、审查日期和版本 | 待补充 |
| `runtime/README.md` | 新账户模块和命名空间保留 | 待更新 |
| `scripts/README.md` | Setup、目录生成和模型管理入口 | 待更新 |
| `src/bootstrap/README.md` | 新账户适配器 | 待更新 |
| `src/model-api/README.md` | Responses 请求归一化的新能力 | 待更新 |
| `src/provider-proxy/README.md` | 响应归一化、事件边界和转储观察点 | 待更新 |
| `src/model-relay/README.md` | OLC 显式能力、独立发送链及共享转换边界 | 待实现后更新 |
| `index.md` | 文档索引描述 | 已更新描述，链接保留 |
| `docs/ollama-cloud.md` | 实现后的正式 Provider 专题文档 | 待实现后创建 |

### 数据、备份与回滚

- 方案 B 新增 `ollama-cloud` 家族文件；固定模式还需按现有确认事务更新 Codex 主配置，切换模式写独立 Profile。不得修改 `cp-ollama` 的 Profile、目录、凭据或自定义 Provider 注册表；固定模式与既有自定义切换 Provider 冲突时明确拒绝，不自动切换或清理。
- 不做迁移，也不需要迁移：不读取、导入、转换或迁移 `cp-ollama` 的 Profile、目录、凭据、账户或会话绑定；不提供迁移入口、兼容别名或旧数据转换。`cp-ollama` 作为独立自定义 Provider 保留；受管 `olc-*` 账户只能新建，二者不自动关联。
- 新增账户先完成现有资源预检、明确写集合和私有备份，再由现有事务协调凭据版本、主配置/Profile、标记和注册表；不照文档列表手写顺序写入。预览绑定账户/模式/Key 版本及目录修订。明确失败按原恢复合同处理；写入结果未知时保留现场和版本，不假定失败或覆盖后续修改。
- 目录写入前备份，保存后回读；结果不确定时停止并保留备份，不自动重试。
- 账户移除保留凭据版本和备份；不删除历史 Thread，不静默替换失效模型。
- 不修改 StateStore schema，不新增迁移路径或迁移标记。

### 实施顺序

以下是整个 Ollama Cloud 家族的接入步骤，搜索只是其中一项。以[第三方模型统一管理方案](unified-model-management-design.md#当前链路与后续统一方案)、[提供商接入指南](provider-integration-guide.md#3-实现步骤)为共用合同；本节是待实施清单，不表示这些入口已存在。每一步完成后记录实际产物、读取/消费路径与未观察边界，再推进依赖它的步骤。

1. **确定首批模型与上游合同。** 固定 `https://ollama.com/v1`、Responses-only、禁用 WS；选一个精确模型 ID，核对文本、普通工具往返、思考等级与上下文，再决定图片、freeform、搜索是否启用。公开模型发现与账户认证分开记录；先确认 `/api/balance` 的认证及金额语义，不能把草稿快照或 HTTP 200 当成账户验收。未确认的能力保持关闭或阻断对应功能，不自动选择替代模型。
2. **注册家族、账户身份和类型。** 按“Provider 定义与账户模块”接入 `olc`、`ollama-cloud`、`olc-<account>`，登记定义、能力联合、实例展开和空注册表下的命名空间保留。复用注册表校验和路径生成，确认账户 ID 与环境变量都唯一、默认账户唯一；聚合继续关闭。完成标准：现有定义读取器能解析具体账户和共享目录，未知能力、重复身份明确拒绝。
3. **准备目录候选与来源。** Ollama 下载器只负责官方元数据发现与候选映射，不负责另起保存流程。首建用选定候选生成草稿；后续发现只追加明确选择的新模型，不重建旧条目。按“与统一模型管理的衔接”显式接入新增和模板分支，分开记录能力元数据与提示词来源。独立填写与同目录继承接入共用新增计划，模板来源明确绑定，继承不凭空复制来源关联；保留原采样、窗口、默认等级及未选能力。目录是启用集合，不新增禁用表或第二份可写模型清单。候选受字节、数量、期限和来源摘要约束，Codex 目录校验通过才可进入保存计划。
4. **接通账户 Setup 与凭据事务。** 在标准 Setup/管理入口选择账户、模式、Key、模型及默认等级，先预检和预览，再由既有账户事务完成私有凭据版本、备份、注册表和主配置/Profile 的写入与回读。新账户复用已有共享目录，Key 重配不刷新模型；取消或无变化不写入。固定模式与现有配置冲突时拒绝，过期预览或轮换后的旧凭据版本拒绝。初建账户事务和后续目录设置事务分别使用各自恢复合同，不假定是一种事务。
5. **接通运行实例与基础模型请求。** 通过标准运行组合传入准确目录、Key 环境和采样默认值；固定模式使用主实例，切换模式按账户隔离。Provider Proxy 的 Responses 入口复用私有输入归一化、目录守卫、取消、错误分类和指标观察；不把 OLC 识别为官方 OpenAI。使用 `codexc remote` 的受管租约链路验证首个普通问答与 function 工具往返，并观察正常关闭/重连；不另建终端界面或专属服务管理器。
6. **完成 freeform 双向适配。** 按前文合同补齐工具声明、参数解包、SSE/JSON 输出、显式历史、工具选择与终态一致性，并与基础归一化组合，避免二次改写。只有原生 `apply_patch` 完成真实文件编辑和下一轮结果续答后，才为已验证模型声明 `freeform`；在此之前保持显式 `null`。错误与取消时不能交付畸形或未完成的可执行补丁。
7. **接入统一模型管理的全部适用操作。** CLI 和 WebUI 共用 load/preview/apply 计划及现有 writer；覆盖列表/详情、按 ID 新增、发现候选、显示名称、上下文、账户默认模型、共享默认等级、模板更新及本地移除。WebUI 复用认证、Origin、管理锁、审计、会话绑定的一次性确认和保存后回读；不能直接暴露交互式 CLI callback。预览列出同族账户和 Relay 影响，保护所有相关默认引用及最后模型，移除同步裁剪 manifest 来源。通用完整高级编辑器与 CLP 专属“请求改写”不因接入 OLC 自动获得支持，不显示不可执行的入口。
8. **接通用量和用户展示。** 由 Bootstrap 按精确账户注册窄适配器，复用 AccountQuery 的期限、提交前守卫与有界读取；仅在余额语义和金额精度验证后启用 USD 映射，失败不回退其他账户或伪造零余额。核对 CLI/WebUI、渠道 `/model`、`/usage`、短标签、模型详情和 `/limits` 不支持提示；模型显示名不自动加平台前缀，账户标签与模型名分别呈现。
9. **接通独立 Relay。** 将 OLC 接入共享目录与账户材料组合，核对原生 Responses 路由、逐 Key 模型授权和材料修订。复用模型 API 公开转换能力，独立接入 freeform/搜索所需执行链，不连接 App Server 会话能力。添加模型不自动扩大 Key 授权；移除只限制目录消费，不清空原授权，重新加入可能恢复原授权可达性。目录变更后核对在途撤销与后续调用，明确拒绝未支持的协议或能力。
10. **接通网页搜索及现有搜索设置。** 按前文搜索设计实现声明映射、官方 API 执行、内部续答和对外响应；搜索与客户端 `tool_search` 是不同能力，不用后者的目录开关替代。复用[独立提供商搜索模式](provider-integration-guide.md#独立提供商的搜索模式)：切换模式按精确账户 Profile 保存覆盖，固定模式读取主配置全局值，不按共享模型目录保存策略。首版只实现 live；跟随全局后解析出的 cached/indexed 等未支持模式明确拒绝，不自动改成 live。配置保存不等于能力探测或即时生效，沿用现有激活和搜索事务恢复合同。
11. **完成恢复、平台与真实路径核对。** 按下方验收条件观察新建/第二账户、Key 重配、目录修改、旧预览拒绝、取消、无变化、移除及相关恢复；固定和切换模式分别验证，核对 macOS/Linux/Windows 现有凭据权限与服务分支。模型停用后的旧会话或任务按使用时守卫报错，不扫描并迁移所有引用。写入不确定时保留恢复材料，不重试覆盖；不能用目录恢复处理账户、搜索或历史迁移事务。没有环境的路径逐项标为未观察，不用静态检查代替。
12. **同步文档并交付。** 更新下方影响矩阵中的当前合同和正式 `docs/ollama-cloud.md`，记录准确的启用模型、能力、配置入口、激活要求、错误及回滚步骤。运行适用的现有类型/边界、lint、文档检查，整理真实路径与反例结果；全部待实现项按实际状态标注。提交、推送和部署仅在对应授权范围内执行；本轮只修订设计文档，不执行这些接入步骤。

在 freeform 适配未完成前，可以先用 `apply_patch_tool_type: null` 完成方案 B 的其他部分，但不能把 freeform 能力标为已支持。

### 实现后的用户接入步骤

以下操作依赖上述实现与验收完成，当前版本不能照此创建 OLC 受管账户；不提供尚不存在的 `codexc provider ollama-cloud` 命令。

1. 在 Ollama 官方账户创建 API Key，确认目标模型及账户权限；在项目支持的私有凭据输入界面填写，避免把 Key 放入命令参数、文档或日志。
2. 从 `codexc setup → 模型与提供商` 或实现后的 WebUI 提供商入口选择 Ollama Cloud，新建账户 ID，选择固定/切换模式。现有 `cp-ollama` 保持原状，不选择导入或迁移；发现模式冲突先按已有管理流程处理，不绕过检查。
3. 查看已保存共享目录或首次发现候选，选择已验证模型、上下文、思考等级及本账户默认模型。第二账户复用同族目录；预览共享参数影响，不把设置默认账户误当成设置默认模型。
4. 核对预览的配置目标、凭据更新、备份和生效要求后确认保存；等待回读成功。出现 `save-unconfirmed` 或 pending 时停止编辑，保留文件和对应恢复材料，按其所属事务核对，不重复点击保存。
5. 按结果提示，在现有任务和租约允许时通过标准服务入口激活 App Server；仅重启 Gateway 不能保证模型配置生效。切换模式使用已注册的 `codexc remote -p olc-<account>` 或在渠道 `/model` 选择账户模型；固定模式使用主实例的标准入口，不为其他账户另外启动实例。用新建或适用的冷恢复 Thread 核对实际 Provider、模型和思考设置。
6. 先完成普通问答与 function 工具往返，再分别验证已开启的图片、原生 `apply_patch` 和搜索。搜索通过现有“提供商联网搜索”入口设置；固定模式去全局设置，切换模式可设账户覆盖。仅在能力已验收时选择 live，保存后按提示激活，不以菜单可选或 HTTP 200 判断搜索已执行。
7. 需要 Relay 时，通过现有 Relay 管理单独授权准确的 OLC 模型并验证请求；账户接入和目录新增不自动授权外部 Key。通过 `/usage` 核对相应账户，保留不支持与查询失败的真实提示。
8. 后续模型增删、窗口、默认值和模板更新均走统一模型管理的预览/确认流程。回退前保留目录与 manifest、账户配置和对应事务备份，核对后续修改及版本支持；按所属恢复入口处理，不拿旧备份覆盖新编辑。移除账户前交接默认账户并处理租约，不删除历史会话、指标或现有 `cp-ollama`。

### 验收条件

- `/model` 能看到 `olc-<account>` 前缀的模型，并按账户选择默认模型；
- 固定模式使用唯一主实例，切换模式使用所选账户隔离实例；两种模式分别验证支持的 `codexc remote` 入口与租约，不把 `-p` 选择解释为固定模式可另启所有账户；
- `/usage` 显示 USD 余额，且不泄露 Key 或原始响应；
- 普通 function 工具、图片输入和文本流正常；
- freeform 适配完成后，原生 `apply_patch` 能真实创建/修改文件；未完成时目录明确不声明 freeform；
- 未知、已停用或不在目录中的模型请求被拒绝，不回退；
- 多账户的默认模型、凭据和切换实例互不串用；同族目录刻意共享，修改影响与默认思考镜像同步必须正确，其他家族目录不受影响；
- 上下文窗口的来源和生效值有明确记录；
- `OLC <account>` 短标签、WebUI 账户操作、模板更新和本地工具声明可用；
- `thinking` 缺失模型有明确的排除或人工配置结果，布尔开关映射经过验证；
- `429`/`5xx`、超时和流中断的重试口径有记录，且未验证范围明确；
- `/usage` 的余额语义、金额格式和 `/limits` 不支持行为与文档一致；
- 不把 Responses 的 `reasoning_tokens` 用于计费或思考量判断，也不依赖 `tool_choice` 回显判断实际工具行为；
- 不使用 Chat Completions 作为适配或回退路径。

方案 B 当前进入分批实施；完成上述验收前不能把受管多账户 Ollama 标记为已验收。

### 实施进度（2026-10-26）

按用户授权逐批实现、关联审查、Astra 独立复审及反例核对后提交；不推送或部署，不改动现有 `cp-ollama`。每批复用现有事务与检查，不新增或维护测试。

- 第一批：账户家族基础已完成关联复审与修复。新增 `olc` 定义、`ollama-cloud` 共享目录身份、账户注册表读取和 `olc-*` 命名空间保留；没有默认模型，WS 关闭。Bootstrap 已识别家族分支，余额适配及精度未验收前不登记账户查询适配器、不提供 usage/limits。此批不提供账户创建入口，不表示模型请求已验收。
- 第一批隔离观察：临时私有目录中配置 `main` / `other` 两账户，`remote` 参数解析入口将 `sf-olc-other` 解析为 `olc-other`，默认路由选择 `olc-main`；启动材料生成各自 Key 环境变量和 `supports_websockets=false`，Relay 材料读取选择 `other` 的独立虚拟 Key、共享目录及 Responses-only。悬空注册表链接曾被误判为空账户，已修复为明确拒绝；公开权限注册表、跨账户凭据引用和未登记账户也明确拒绝。未启动 App Server、未调用模型或余额 API，Windows/macOS 私有文件适配与服务运行尚未实机观察。
- 后续批次：目录保存及统一模型管理；Setup/CLI/WebUI 账户事务与运行请求；freeform 双向转换和独立 Relay；搜索、余额与完整用户路径。每批具体边界按实际调用链调整，不能遗漏上文实施顺序的适用项。
- 第二批：只读公开模型发现已完成关联与独立全链路复审，已提交为 `dfb21cd0`。`codexc provider ollama-cloud discover [--json]` 读取三个官方接口，最多 64 个模型、3 个并发详情请求、90 秒总期限、单响应 2 MiB 和总响应 16 MiB；不重试 429 或其他失败，不携带 Key，不写配置。首尾复核模型集合及 tags 指纹；缺少 thinking、纯布尔开关或缺失上下文标为待确认，两来源能力一致且缺少 completion/tools 时排除。输出仅是候选，上下文使用明确的本地 393216 上限，不声明已经验证的图片、思考、freeform 或搜索能力。后续目录保存与模型管理仍待接线。
- 第二批独立观察：修复了 tags 声明工具能力、show 缺失工具能力时误判为确定排除的问题；同一反例现在返回 `unconfirmed`，两来源一致缺失时仍返回 `excluded`。累计超过 16 MiB 拒绝；3 个详情请求在途中取消后全部结束，活动数回到 0，未启动剩余请求；302 拒绝且未重试。公开 CLI 的 JSON 和文本路径均完成，返回稳定的 23 个模型（11 个候选、1 个排除、11 个待确认），保留 `deepseek-v4.1-flash:1017`，其上游窗口为 1048576、候选窗口为 393216。Node 24.22.1 的禁用生命周期打包预览确认新脚本及依赖入口被包含；本机没有 CI 固定的 Node 22.23.4，未观察该版本打包或 Windows/macOS 执行，也未等待完整 90 秒超时。没有调用需凭据的推理或账户接口。
- 官方资料已重新核对：直连地址、无状态 Responses、freeform 历史和内置搜索限制与本文一致。尚未使用账户凭据调用模型或余额接口。
- 第三批：余额适配和用户展示已完成关联及独立复审，等待提交。采用官方 Balance 数字原文、10^-9 USD 整数单位精确求和，非负且最多 9 位小数，单项和合计均小于 10^12 USD；不支持的精度、负余额和旧百分比计划明确失败。查询使用精确账户凭据及 AccountQuery 期限/权限/错误合同，`/limits` 不开放。渠道短标签为 `OLC <账户>`，两类金额标为包含和已购额度剩余；不引入本地计费。
- 第三批隔离观察（Node 24.22.1）：主审确认 `0.1 + 0.2` 和纳美元求和保留十进制精度，负值、缺字段、字符串和超精度拒绝。独立复审以两个虚拟账户贯穿实际适配器、ProviderAccountService、快照写入端口及渠道格式化，分别使用各自 Key，`999999999999.123456788 + 0.000000001` 精确显示为 `999999999999.123456789`，OLC 无时区或周期行。移除一个注册账户后快照 API 不再返回其历史数据，该账户再查询为 configuration；响应后撤权保留原始拒绝，预先及途中取消均拒绝成功结果。超精度、合计溢出和 65537 字节响应为 invalid-response，403 为 authentication，429 为 rate-limited，均只有一次请求且公开错误不含上游正文。真实回环 HTTP 停滞正文在约 10009ms 以 timeout/response 结束，自有服务已关闭。
- 第三批浏览器观察由主审完成：已构建 WebUI 配合隔离账户响应，中英文卡片均保留 `USD 0.000000003` 及两类额度精度；手动刷新返回隔离 503 时显示更新失败和最后一次成功数据提示，旧余额保持不变。中文截图保留于 `output/playwright/ollama-balance/card-zh.png`，已检查字形和布局。其他 API 未提供真实服务；没有使用真实 Ollama Key 或运行中的 Gateway，Windows/macOS 与 CI 固定 Node 22.23.4 尚未实机观察。静态类型、定向 lint、i18n 与 WebUI 构建在主审阶段通过，仅表示对应工作流状态。
- 实施阶段补充官方证据：[Balance](https://docs.ollama.com/api/balance.md) 明确 `included.balance_usd` 表示剩余包含额度、`purchased.balance_usd` 表示尚未过期的剩余已购额度，单位均为 USD；旧计划也可能仅返回 `included.session` / `included.weekly`，不能把缺失的金额当作零。精度、范围和负值策略已有上述隔离观察，真实账户响应仍待验收；上文原始快照的待确认状态保留其时点。
- 数据处理沿用上文备份与回滚方案：新家族新增文件、现有事务预览/备份/回读，不迁移、导入或覆盖 `cp-ollama`；结果不确定时保留现场，不自动重试。

## 后续要求

1. 按上文“实施顺序”接入完整家族。账户、目录和基础请求可先实现，freeform 完成前保持显式关闭；不把该阶段标记为完整编码能力已验收。
2. 完成 Responses 的 freeform 适配，并用 Codex 原生 `apply_patch` 做真实文件编辑及下一轮历史往返；不能用 `exec_command` 改文件代替该验证。受管多账户、统一管理、Relay 和搜索分别记录各自接线与验收结果，不以其中一条成功覆盖其他路径。
3. 明确上下文窗口以 `1048576` 还是当前目录中的 `393216` 为准；调整必须经过模型目录事务，不直接手改运行文件。
4. 在完成上述验证前，区分“原始记录中的自定义 Provider 普通路径曾成功”和“新增受管 Provider 已验收”；本轮未复现前者，也尚未实现后者。
5. 不自动开放 `/v1/models` 返回的全部 23 个模型；每个候选模型都需要独立的 Responses 能力验证和明确启用。

## 本轮审查后的状态

已纳入本文的审查修正：

- 把“保留 ID 已包含 `olc-*`”改成必须新增命名空间检查，避免空注册表时被自定义 Provider 占用；
- 补充 `.d.mts` 类型联合、`aggregateMaterialOrder` 和 `olc`/`ollama-cloud` 键差异；
- 补齐模型新增、模板管理、WebUI 账户操作、短标签和文档影响矩阵；
- 增加 `thinking` 字段缺失、布尔开关与受管 `enabled` 路径的处理规则；
- 增加 freeform 的 `added` 空参数、SSE 事件边界、原始转储观察点、非流式缓冲和请求侧历史转换；
- 把余额映射标为待验证，并补充金额格式、`401`、周期和 `/limits` 限制；
- 补充重试/限流、精确错误码和多账户空注册表语义。
- 明确方案 B 不做 `cp-ollama` 迁移，也不提供导入、转换或兼容别名；受管账户只能新建。

仍未验证：

- `429`/`5xx` 的实际重试行为、超时和流中断恢复；
- `1048576` 长上下文是否真实可用；
- 全部 23 个模型的 Responses、工具和图片能力；
- 客户端侧 `aborted` 的精确校验条件；
- WebUI、渠道短标签和模板更新的实际渲染/交互；
- freeform 适配后的真实原生 `apply_patch` 编辑。

## PR #308 合并后的关联复审

基于 `51066f6b` 读取共享模型目录/账户事务、定义注册与命名空间、CLI/WebUI 管理入口、账户适配器、Provider Proxy 与独立 Relay、锁定 Codex 工具声明和事件消费。确认并修正文档中的证据时态、固定模式实例数量、共享目录隔离、CLP 专属本地编辑限制、已有家族辅助函数、备份先后及金额精度假设。

协议反例分析补齐：包装 JSON 的 delta 不能原样改名为补丁增量；完成参数为空仍须拒绝；并行调用身份、重复终态、请求侧历史/选择、输出结构数组及 HTTP 头/背压/错误必须一并处理；取消不承诺回滚已执行工具。官方文档明确不支持 custom 历史重放，因此两轮往返仍是阻断验收条件。目录发现失败不等于下架，原生思考/图片元数据不等于 Responses 能力，账户变量归一化碰撞须拒绝。

本轮仅修改本文和根 `index.md`，不实现 OLC、不变更用户配置/目录/凭据或服务，也未进行收费推理与真实文件工具执行。原始探测快照未独立复现，待验证事项保持开放；文档静态检查只证明索引和链接一致。
