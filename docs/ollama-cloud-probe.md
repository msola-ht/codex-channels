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
- 第六批针对独立 Relay 的选择对象补查 [Responses Create API](https://developers.openai.com/api/reference/resources/responses/methods/create)：锁定 `codex-api/src/common.rs` 只发送字符串 tool_choice；公开 ToolChoiceCustom／Function 对象为 type/name，allowed_tools 为 type/mode/tools。本地仅接受可按顶层精确身份确认的对象选择，拒绝自造 namespace 选择字段与隐式限定名称别名；命名空间工具的声明、调用、历史及 auto/required 仍支持，命名空间强制／白名单选择在缺少已确认表示时失败关闭。此资料补充没有替换锁定 CLI 或增加依赖。
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
3. 自动发现验证后的新增与独立手填共用通用编程提示词草稿；若另行明确选择 `official` 固定模板，仅更新其允许的提示词与运行设置，不从底座复制上游能力，也不复用 DS 官方端点限制。能力来自该精确模型的元数据与实际验证范围，模板来源单独记录；具体衔接见下节。
4. 本地工具声明沿用 `withThirdPartyLocalTools` 的 `send_user_message_async`、`clock` 投影；模板更新时保留这些声明。显式创建或更新时按现有第三方模板规则追加“使用中文回复用户”的审批要求。
5. `apply_patch_tool_type` 在 freeform 适配完成前为 `null`，完成后才允许设为 `freeform`。
6. 不声明未验证的 `web_search_tool_type`、`support_verbosity`、`supports_parallel_tool_calls` 或原生搜索能力。
7. 保存前使用现有 [model-catalog-validation.mjs](../scripts/model-catalog-validation.mjs) 调用本机 Codex 目录校验；校验失败不写入。
8. 保存前预览差异与同族账户影响，保存时绑定修订、备份旧目录并同步受影响账户的默认思考镜像，保存后回读；目录变化不自动重启服务，只提示需要的激活操作。无变化不写；回读或恢复结果不确定时报告 `save-unconfirmed`，不重试覆盖。

`/api/show` 是公开接口，不能用它验证 Key；Setup 的 Key 预检使用 `/api/balance`，并只处理受控状态码和错误分类。目录刷新可以只依赖公开接口，但这不会证明账户可用。`models.manifest.json` 应记录 `/v1/models`、`/api/tags`、`/api/show` 的来源、抓取时间和摘要，不写入 Key、余额或对话内容。

### 与统一模型管理的衔接

Ollama 元数据来源与提示词模板关联必须分别保存。新家族 manifest 的顶层 `source` 标识 `ollama-cloud`，可选 `modelDiscovery` 按精确模型 ID 保存三个固定来源 URL、抓取时间、集合及 show 摘要、tags 指纹、本地窗口策略和实际验证范围/时间；最多 64 项、总计 128 KiB，不保存凭据、对话或 marker。旧 manifest 没有此字段仍可读取，无迁移、不补写旧条目。逐模型 `modelTemplates` 仍采用现有 `{ source, model }` 合同，只保存用户明确选定的 `official` 提示词模板。`model` 是模板的精确来源 ID，不填 Ollama ID 或接口 URL。现有 [来源读取器](../runtime/model-template-bindings.mjs) 仅接受 `official`、`deepseek`、`cline`，不能把 `ollama-cloud` 直接写入逐模型模板来源而声称兼容。独立填写或继承模型不自动绑定模板；`templateUpdates` 继续记录实际确认的来源摘要与更新分组。来源、目录、备份和相关 Profile 必须由同一受管目录事务保存，移除模型同步裁剪该模型的关联和更新记录，其他来源快照保留。

首版 OLC 的 `official` 模板更新只开放提示词及用户明确选择的现有运行设置（有效上下文比例、压缩阈值、截断策略），保留未选字段、本地工具和已验证的模型能力；不开放从 `official` 覆盖能力。现有受管模板计划的 `capabilities` 分组会复制来源的图片、思考等级、最大窗口等字段，并不证明 Ollama 支持这些值。已有模型需要更新 Ollama 能力时，须先补齐按精确 ID 的元数据/验证投影、预览与修订合同，再复用目录 writer；未完成时明确不支持，不通过“发现新增”覆盖旧条目，也不借用 CLP 完整编辑器绕过。首次生成所用的提示词和本地工具仍按上一节投影。

| 衔接位置 | 当前限制与 OLC 必须补齐的内容 |
| --- | --- |
| [统一新增计划](../scripts/provider-model-additions.mjs) | 第四批已接入已注册 OLC 的读取、精确 ID、独立填写及同目录继承；第七批接通独立公开发现、费用确认后的单模型逐级 Responses 验证、全字段预览及追加保存，不落入 OCG 生成器。发现令牌不可保存，验证通过后生成仅含选中模型的新令牌；能力来源与提示词模板关联分开。 |
| [统一模板计划](../scripts/provider-model-template-management.mjs)、[目录投影](../scripts/provider-model-catalog.mjs) | 第四批 OLC 仅提供 `official` 固定底座及 prompts/settings 分组，拒绝 capabilities；来源候选和确认绑定同一底座修订和摘要，不借用 DS 能力投影。 |
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
- 第三批：余额适配和用户展示已完成关联及独立复审，已提交为 `0aa454b1`。采用官方 Balance 数字原文、10^-9 USD 整数单位精确求和，非负且最多 9 位小数，单项和合计均小于 10^12 USD；不支持的精度、负余额和旧百分比计划明确失败。查询使用精确账户凭据及 AccountQuery 期限/权限/错误合同，`/limits` 不开放。渠道短标签为 `OLC <账户>`，两类金额标为包含和已购额度剩余；不引入本地计费。
- 第三批隔离观察（Node 24.22.1）：主审确认 `0.1 + 0.2` 和纳美元求和保留十进制精度，负值、缺字段、字符串和超精度拒绝。独立复审以两个虚拟账户贯穿实际适配器、ProviderAccountService、快照写入端口及渠道格式化，分别使用各自 Key，`999999999999.123456788 + 0.000000001` 精确显示为 `999999999999.123456789`，OLC 无时区或周期行。移除一个注册账户后快照 API 不再返回其历史数据，该账户再查询为 configuration；响应后撤权保留原始拒绝，预先及途中取消均拒绝成功结果。超精度、合计溢出和 65537 字节响应为 invalid-response，403 为 authentication，429 为 rate-limited，均只有一次请求且公开错误不含上游正文。真实回环 HTTP 停滞正文在约 10009ms 以 timeout/response 结束，自有服务已关闭。
- 第三批浏览器观察由主审完成：已构建 WebUI 配合隔离账户响应，中英文卡片均保留 `USD 0.000000003` 及两类额度精度；手动刷新返回隔离 503 时显示更新失败和最后一次成功数据提示，旧余额保持不变。中文截图保留于 `output/playwright/ollama-balance/card-zh.png`，已检查字形和布局。其他 API 未提供真实服务；没有使用真实 Ollama Key 或运行中的 Gateway，Windows/macOS 与 CI 固定 Node 22.23.4 尚未实机观察。静态类型、定向 lint、i18n 与 WebUI 构建在主审阶段通过，仅表示对应工作流状态。
- 第四批：已注册 OLC 的统一模型管理已实现，完成主审关联检查及独立全链路复审，已提交为 `0ef83445`。CLI/WebUI 共用按 ID 独立填写、同目录继承、默认模型／共享思考／窗口、本地移除和模板更新事务；来源只接受顶层 `ollama-cloud` 与逐模型 `official`。模板只开放 prompts/settings，保留能力、本地工具与未选字段；未知来源拒绝。新增不自动关联模板，公开发现候选尚未验证，自动启用明确不支持；freeform、客户端 `tool_search` 与原生 `web_search` 声明分别限制，不能互相当作验证证据。该批尚未提供账户创建或真实 Responses 能力验证。
- 第四批隔离观察（Node 24.22.1）：两个虚拟账户的 CLI 新增保存后，WebUI 目录路由读取返回 200，精确保留 `deepseek-v4.1-flash:1017`，未绑定模板；WebUI 共用 mutation 继承保存成功。另一账户 Profile 保持不变，共享窗口调整使旧新增预览返回 stale-preview；CLI 默认设置只修改目标账户，另一账户默认模型移除为 default-model-protected。模板候选只有 official 和 prompts/settings，能力分组／DS 来源拒绝；提示词保存保留其他字段及来源元数据，无差异不写入，取消新增不写入。移除成功并保留其他来源数据；未知顶层来源在运行读取、新增、模板及移除均拒绝。最初隔离手构目录含 `web_search_tool_type:null`，被真实 Codex 目录校验拒绝；移除此无效字段后实际新增路径通过，生产新增编译本来省略该字段。类型、定向 lint、i18n、WebUI 构建和文档检查已通过；Windows/macOS 尚未观察，未调用真实模型或账户接口。
- 第四批补充反例：只选择 settings 时保留提示词及工具，来源没有压缩阈值时明确删除本地该字段并预览差异；移除已绑定模型同时裁剪其 modelTemplates/templateUpdates，保留另一模型关联和其他来源数据。空新增为 unchanged/none 且目录修改时间不变，预先取消以 AbortError 结束；非 official 关联、空思考等级、缺少 text、默认等级越界及原生搜索声明均被运行读取拒绝。隔离配置与任务目录交给主审继续浏览器观察，不启动共享 App Server。
- 第四批主审浏览器观察：隔离 WebUI 与任务自有 App Server 中，从 `deepseek-v4.1-flash:1017` 继承新增 `browser-model:1`，完成检查配置、预览及确认保存，页面快照显示 300000 文本窗口；runtime 另一入口读取两账户均为三个模型，两个账户原默认模型保持不变。界面禁用 freeform／客户端 tool_search，未展示自动发现新增选项。未启动 Gateway、未外发渠道消息、未请求模型；自有浏览器、WebUI 和 App Server 已关闭。截图保留于 `output/playwright/ollama-models/saved.png`，主审确认中文字形正常，但该图仅包含顶部视口；新增成功证据为页面快照和 runtime 回读。
- 第四批独立复审及故障观察：基于 `0aa454b1` 加本批修改，追踪 CLI/WebUI 的共享计划、默认值与目录范围、catalog/manifest/Profile 事务、显式恢复和 runtime material 消费，未发现本批运行实现需修复的问题；根据主审定位补齐 WebUI 用户文档遗漏的 OLC 可用性与限制。在独立复制的私有 fixture 中，catalog 替换后向 manifest 写入注入 EIO，返回 operation-failed，目录、来源、备份及两个 Profile 恢复原字节且 pending 清除；同阶段模拟后续 manifest 编辑则保留该编辑与 pending，runtime material 拒绝读取，rollback 拒绝覆盖。明确消除隔离后续编辑后，经另一账户 rollback 成功；写入及回滚均失败的另一场景保留 pending，解除故障后 keep 成功，两账户默认值不变。正常重命名保存后，另一账户 material 读取三个精确 ID 及 Responses-only；自动新增无手动定义返回 addition-unavailable，DS/OCG 下载器调用次数为零。上述故障仅注入任务自有 Node 进程及临时文件，不代表断电或各操作系统文件系统故障均已观察；没有新增测试或检查脚本。
- 实施阶段补充官方证据：[Balance](https://docs.ollama.com/api/balance.md) 明确 `included.balance_usd` 表示剩余包含额度、`purchased.balance_usd` 表示尚未过期的剩余已购额度，单位均为 USD；旧计划也可能仅返回 `included.session` / `included.weekly`，不能把缺失的金额当作零。精度、范围和负值策略已有上述隔离观察，真实账户响应仍待验收；上文原始快照的待确认状态保留其时点。
- 第五批：账户 add/reconfigure/default/remove 共用管理计划与既有私有文件事务，接入 CLI、Setup 第三方菜单和 WebUI；共享目录与每账户默认模型分开保存。首次目录仅开放明确手动定义，补齐中文审批提示和本地工具，不复制官方模型能力、不自动关联模板；已有目录新增账户须明确选模型，账户重配不能覆盖目录。固定模式沿官方版本化配置 writer 与私有凭据版本，移除仅针对准确实例并保留目录、备份及历史凭据。新 Key 在预览及实际保存各认证一次，提交重算不重复认证；固定 GET balance、有界 10 秒和 65536 字节、禁止重定向、不重试、不返回上游正文。无变化不请求、不写账户文件、不备份、不提示重启；首次目录预览绑定公共底座快照，未完成的目录事务阻止账户接入。实现待主审和独立全链路复审完成后提交，不代表真实上游请求已验收。
- 第五批隔离观察（Node 24.22.1）：CLI 添加 alpha 后 WebUI 后端读回；经第四批统一模型新增添加第二模型，再由 WebUI 后端添加 beta，CLI 列表读到两账户，各默认模型保持独立。真实 Codex 校验接受编译产物，确认 `web_search_tool_type` 完全省略；运行时同步修正为显式 null 也拒绝。固定模式通过官方 RPC writer 保存；期间另一主配置字段 `history.max_bytes=123456` 经官方 writer 修改，恢复 switching 后仍保留。另一个隔离 fixture 中固定模式首次创建和最后账户移除成功，主 Provider 恢复 openai，后来经官方 writer 修改的 `history.max_bytes=333333` 保留，注册表删除，共享目录、私有备份及凭据版本仍在。没有读取、迁移或修改 cp-ollama，也没有调用真实账户或推理接口。
- 第五批 Hack 与 HTTP 观察：同 Key 重配为 unchanged/none、认证次数为零；缺模型、未知模型／账户、重复账户、凭据环境变量名碰撞、未知请求字段、已有目录填写 initialModel、空思考等级、越界默认等级及不支持工具声明均拒绝。竞争默认账户变更使旧账户预览为 stale-preview；先移除默认账户为 default-account-conflict。认证后的公共底座变化使首次目录预览失效；没有注册账户时的未完成目录事务也拒绝。401/403 为 invalid-api-key，429 为 authentication-rate-limited，500、超大正文为 authentication-unavailable，停滞请求约 10002ms 返回 authentication-timeout；取消为 operation-cancelled。legacy session 计划缺 USD 仍通过认证。移除注入监管实例时只释放准确 Provider，目录字节保持不变。真实回环 HTTP 路由中初始预览和提交各一次认证，审计 recorded、target=olc-beta 且不含 Key；过期令牌为 409，浏览器断连后的认证取消保持 Profile 原字节且 snapshotReads=0。首次 HTTP 手工观察使用了不合法的模拟审计 sessionId，返回 degraded；换成正式 64 位指纹后为 recorded，未修改生产审计规则。
- 第五批主审浏览器观察：隔离提供商页编辑 beta，Key 留空，默认模型从 `manual-second:2026` 改为 `manual-model:1017`；预览明确 beta、保留 Key，确认后显示已保存。runtime 回读目标账户新模型，alpha 保持原模型；alpha Profile、catalog、manifest 的 SHA256 三项前后相同。截图 `output/playwright/ollama-accounts/saved.png` 已由主审查看，中文及页面布局正常；未启动 Gateway、未请求模型，任务自有浏览器、WebUI 与 App Server 均已停止。隔离 fixture 保留给独立复审，不把它当作真实上游证据。
- 第五批静态工作流：根类型检查、模块边界、ESLint、文档索引和 i18n 校验、Gateway 与 WebUI 构建及 WebUI lint 已通过。Windows/macOS、CI 固定 Node 22.23.4、真实代理连接、真实 Key 认证与 Responses 推理尚未观察；公开元数据自动生成目录、逐模型 Responses 验证、freeform 原生文件编辑及完整渠道／Relay 用户路径仍属后续批次。
- 第五批取消及无变化收尾：默认账户操作等待共享管理锁期间取消，拿锁后返回 AbortError，注册表原字节保持不变。最终 HTTP 路由在认证期间断连返回 AbortError，新增账户注册表仍不存在，任务拥有的 snapshotReads 为零；此取消跟踪仅加到 OLC 操作，不改变其他家族的期限。再次对浏览器编辑后的 beta 做省略字段重配，结果 unchanged/none、认证零次，账户相关文件内容和修改时间均相同。
- 第五批独立全链路复审：基于 `0ef83445` 加本批工作区修改，追踪 CLI/Setup/WebUI 输入、共享计划及确认绑定、目录/账户范围、私有事务、官方主配置 writer、默认账户与运行时读取。修复默认/移除在最终发布后发生竞争覆盖却仍报告成功的问题，三类保存统一核对预期文件内容；反例现为 `save-unconfirmed`，WebUI 映射 HTTP 500，保留竞争写入且不重试。修复移除在监管查询期间取消仍释放实例的问题，查询返回及释放前检查取消；同一反例释放次数由 1 变为 0，账户文件不变。共用监管辅助函数只增加可选 signal，不改变未传入 signal 的其他家族调用及期限。
- 第五批独立故障与正常路径：私有 fixture 中，重配写入 Profile 后向 marker 发布注入 EIO，事务恢复所有账户文件原字节；完整发布后阻止 Profile 回读，返回 `save-unconfirmed` 并保留新模型；写入开始后取消仍按事务完成，返回 `configured`。CLI 将 beta 设为默认再移除 alpha，WebUI 后端读取仅剩 beta，默认模型保持 `manual-model:1017`，仅释放 `olc-alpha`，共享目录字节不变。故障仅注入任务自有 Node 进程和临时数据，不代表断电或 Windows/macOS 文件系统恢复已观察。
- 第五批认证代理修复：CLI/Setup 直接入口原先只读取进程代理变量，遗漏 Codex `.env`；现复用共享代理读取与优先级解析。以内存替代 fetch 观察：`.env` 配置代理时创建 dispatcher，显式空值和 `NO_PROXY=ollama.com` 不使用 dispatcher，无效代理返回 `authentication-unavailable` 且 fetch 零次。经 CLI 重配虚拟 Key，预览和提交恰各一次认证且均选择配置代理，runtime 凭据读取与 WebUI 账户读取一致，CLI 输出不含 Key；没有建立真实代理连接或访问上游。独立修复后类型/模块边界、定向 ESLint、文档检查及差异空白检查通过。
- 第五批已提交为 `4c613672`。第六批以此为基线接通 freeform 双向适配，已完成主审关联检查与新一轮独立全链路复审修复，已本地提交为 `67b48a08`；未推送或部署。锁定 Codex 0.164.0 源码 HEAD 为 `6aaac694803004a63c6f393d153c96d22521a6b9`；`tools/src/tool_spec.rs`、`tools/src/responses_api.rs` 定义命名空间和 custom 声明，`protocol/src/models.rs` 定义 custom/function 历史及结构化结果，`codex-api/src/sse/responses.rs` 以 output_item.done 消费并分派原生工具。纯转换由 `model-api/ollama-freeform.ts` 负责，两个 HTTP 入口共用 `provider-proxy/direct-responses.ts` reader，可信 family storageId／Relay material 显式开启；不按 URL 或模型猜测，不把 Relay 引入 Codex 私有 agent_message/encrypted 归一化。
- 第六批能力及范围：保留已接受的 custom 声明及命名空间，支持按已确认顶层身份的强制选择和 allowed_tools 白名单，返回调用只匹配本请求明确身份，并按选择限制检查。配对 custom 历史包装单字段 input，文本及已知结构化结果数组保持原类型；普通 function 历史保留上游合同，只保留显式 call_id 以防 custom 借用。未知、延迟加载、tool_search、歧义身份、孤立／重复 custom 结果及加密 custom 历史在出站前失败关闭；不借 previous_response_id 补历史。没有 custom 声明时不启动响应归约；实际 OLC Proxy 普通请求的原始 JSON 空白及响应 sequence_number=900 字节均保持相同。原生 Codex 隔离请求实际带顶层 web_search，保持既有声明透传，不执行托管搜索、不自动修改全局搜索设置。目录首次／独立新增允许明确选择 null/freeform，默认关闭，继承只复制当前值；CLI、Setup、WebUI 和 runtime 守卫一致，旧目录不自动升级，模板仍仅 prompts/settings，搜索声明仍关闭。
- 第六批资源及观察点：单调用参数 1 MiB、最多 64 个工具调用、保留输入 2 MiB、最多 65536 个事件；SSE 单事件 1 MiB、解析缓冲 2 MiB、总字节及归约事件 32 MiB，非流式 JSON 8 MiB。完成必须是仅含一个字符串 input 的合法 JSON 对象；不接受重复键、parameters 别名、多字段、非字符串、空 arguments 或孤立 UTF-16 代理码。参数增量确认完整后才发出一次原始输入，重复完成及终态快照须一致；标准 custom 输入也走相同身份、状态和缓冲约束，表示类型保持 custom，增量延后至完整确认。所有下游 SSE event/type 同步且序号单调。复用 fatal UTF-8、多行 data、完整事件空闲、取消、背压和交付期限；拒绝未支持压缩，改写正文删除旧 Content-Length。原始上游字节进入 capture，原始解析值进入模型指标，随后转换；模型 completed／incomplete 保留，转换失败单独记录，不能把上游完成称为下游成功。沿用终态交付前单次提交指标：提交之后的终态写入／结束交付失败可能仅在转储和诊断可见，不重复投递或声称数据库必然记录该交付失败。Proxy 关闭取消并等待本次归约任务后再关闭转储。
- 第六批隔离 HTTP 观察（Node 24.22.1、本地合成模型上游）：真实 ProviderProxy `/responses` 和独立 ModelRelay `/v1/responses` 的 JSON／SSE 均把匹配 function_call 还原为 custom_tool_call；Proxy JSON 改写后旧 Content-Length 消失，Relay 自动按实际 JSON 重算。普通 function 保持 function；未设置 OLC 开关的另一 Proxy 保持 function 原报文及上游 SSE sequence_number=900。null／数组／数字请求均返回 400 provider_model_request_invalid。malformed JSON 参数两入口均为受控 502；SSE 畸形／半事件／终态冲突均不交付 response.completed，Proxy 断流，Relay 发受控 invalid_upstream_response 错误。终态冲突的模型 completed 与 incomplete 在 Proxy 指标保留并附 response_normalization；Relay 对应 capture.finish 分别是 completed/failed 和 incomplete/failed，原始采集可见 function_call，交付采集可见 custom_tool_call。
- 第六批原生 Codex 真实工具路径：任务 fixture `/tmp/olc-batch6-native-HGWkXA` 设置独立 CODEX_HOME、CODEX_CONNECT_HOME、CODEX_CONNECT_CONFIG_FILE，Codex 0.164.0 保持 workspace-write 与 never 审批，通过真实 ProviderProxy 和本地合成 HTTP 上游运行三轮。原生 apply_patch 第一次添加 native.txt、第二次更新，两个 file_change 均 completed，后续上游收到准确配对的 function_call(input JSON)／function_call_output，两个结果均 Exit code 0。进程 exit 0，磁盘实际内容为 `modified 中文🙂\n`（20 字节），主审独立读回一致；目标文件由原生 apply_patch 写入，没有使用 exec_command 代写。首次受限运行写文件失败且磁盘缺失，改用支持的 require_escalated 启动任务进程后成功；未关闭原生沙箱、未修改 /tmp/codex-daemon-0。CLI 实际请求固定 stream:true，因此 JSON 证据来自上述真实 HTTP 客户端，不能称为原生 CLI 非流式文件执行。合成模型最终文字不是成功证据；文件与原生工具结果才是。
- 第六批内联 Hack 观察：empty arguments、重复 input、parameters、多字段、非字符串、孤立 surrogate、非 JSON 空白、延迟声明、tool_search、缺 namespace、重名声明、孤立／重复／加密 custom 历史、none 强制选择违规、错误命名空间强制选择、缺 call_id、重用历史 call_id、普通 function／标准 custom 与转换调用复用 item id／output_index／call_id、重复 added、错误参数 output_index、跨 response 身份和缺完整终态均受控拒绝。并行顶层与 namespaced custom 逆序完成得到正确归属，重复 done 不再发输入，序号 3–9 连续；同名普通 apply_patch function 保持不改，JSON 工具项省略 id 仍可还原。结构化文本／图片结果数组保持数组，已撤出当前 tools 的普通 function 历史保持原样。单调用、总保留缓冲、65 个工具调用及 65536 事件反例分别触发边界，没有裸透传回退。
- 第六批取消、编码及 I/O 边界：Proxy 客户端取消、Relay 客户端取消及 Relay 提供商撤销在包装参数未完成时均没有 output_item.done／custom input delta／response.completed，三个上游连接均关闭。Relay active、pending、waiting、bytes 和 metricFailures 最终均为零；capture 分别记录 failed/disconnected/client_disconnected 与 failed/failed/request_revoked。真实 HTTP 上游把中文字 UTF-8 拆为 1 字节／1 字节／余下字节，并用多行 data 发送 JSON，输出完整保留中文与补充平面字符，正常 completed。gzip 编码、超过 8 MiB 的 JSON、超过 1 MiB 的 SSE 事件、event/type 不一致及非法 UTF-8 均受控拒绝且无 completed，SSE 已发送时断流；总事件 32 MiB 反例亦拒绝。实际 HTTP 历史回读看到唯一 input JSON 包装与原结构化结果数组；顶层 custom 的 allowed_tools required 选择正向还原成功。
- 第六批主审 WebUI 路径：沿用任务自有第五批 fixture，浏览器新增 freeform-browser:1，窗口 32768、none、无图片，明确点击文件编辑支持；tool_search 选项保持禁用。检查、预览、确认保存成功，runtime 共享目录回读新模型 patch=freeform/search=false，原两模型仍 patch=null/search=false；alpha/beta Profile SHA256 及账户默认模型未变。`npm --prefix webui run build` 通过；截图 `output/playwright/ollama-freeform/model-capabilities.png` 经主审查看中文布局正常，patch 值以实际 runtime 回读为证据。浏览器、WebUI、App Server 及本批自有模型服务和原生子进程均已停止。
- 第六批最终自审与静态工作流：根类型／模块边界、Gateway 完整构建、ESLint、文档检查（94 文件）、i18n（2277 中文源键，中英文键与占位符）及 diff 空白检查通过；WebUI 构建复用上述主审证据。初始目录生成分别接受 null 和 freeform，search 保持 false、web_search_tool_type 省略，search=true 为 invalid-input/initialModel；没有保存真实配置。标准 custom 表示保留且完成快照冲突拒绝，未知对象选择字段和无已确认形式的命名空间选择拒绝。Relay 请求归一化在 input 阶段完成，提交前仍复核 Key 与材料；共享 sender 在 HTTP 提交前失败时保留原诊断覆盖。未创建或修改测试、验证脚本或依赖；所有内联观察与异步进程结果均已收齐。
- 第六批独立复审修复：从账户初始定义、独立新增／继承、目录守卫、可信运行材料到 Proxy／Relay 请求、输出、原生工具分派和计量收尾重新追踪。锁定 CLI 的 `output_item.done` 与 `core/src/tools/router.rs` 不以工具 status 阻止分派，原实现会交付 incomplete／in_progress／failed 完成项；现拒绝显式未完成状态，非流式可执行工具要求 response.completed。未声明客户端 `tool_search_call`、local_shell_call、additional_tools 等不支持输出不再透传；被动输出仅接受 message／reasoning／web_search_call。标准 custom 先前漏检的孤立增量、包装／原生表示混用、错误索引、初始输入冲突、完成冲突、孤立代理码和超限输入均受控拒绝；JSON 全部输出共享 item ID 唯一性，SSE 终态不能丢失已观察的输出项。有效 allowed_tools 中 web_search 的无 name 选择不再误报缺名；仅保留选择声明，不执行搜索。类型注释同步明确 null/freeform。
- 第六批独立 HTTP 与计量观察：修复 Proxy 非流式在原 observer.finish 前提交未知状态、逐行原始观察无法读取多行 SSE 的问题；共享 reader 将转换前原始解析值送入既有指标归约，原始字节 capture 保持。真实回环 HTTP 的 JSON、包装 SSE、标准 custom SSE 在两个入口均成功；Proxy JSON 和多行 SSE 均记录 completed，input=3／output=4／total=7。JSON 非法 input 为受控 502，模型仍 completed／total=7 并记录 response_normalization；Relay 记录 completed 与 invalid_upstream_response。标准 custom 冲突、孤立增量、未完成 item、未声明搜索均不交付工具 done 或 completed，Proxy 断流（客户端可在响应头前收到 UND_ERR_SOCKET），Relay 发受控错误。已完整 done 后的冲突 incomplete 终态，两入口保留模型 incomplete／total=7 和交付失败；Relay 此时已交付过合法工具 done，后续终态错误不能撤销已交付工具。标准 custom 未完成时取消，两入口都未交付输入增量，两个上游连接关闭，Relay active／pending／waiting／bytes／metricFailures 全零。
- 第六批独立修复后的原生路径：新 fixture `/tmp/olc-batch6-review-native-IMRFzh` 使用三项隔离环境变量、真实 ProviderProxy 与仅回环合成上游；实际启动 `codex -a never exec --json --ephemeral --skip-git-repo-check --ignore-user-config -s workspace-write -C <fixture>/work`，model_provider、model、model_catalog_json 及 model_providers.review 各字段分别通过 `-c` 设置；synthetic-only Key、plugins=false、analytics.enabled=false。通过受支持的 require_escalated 启动，没有关闭沙箱。三轮 stream:true 中，原生 apply_patch 创建与修改均 file_change completed，两个历史工具结果均 Exit code 0；最终 native.txt 为预期 20 字节，hex=`6d6f64696669656420e4b8ade69687f09f99820a`，下一轮上游收到准确 function_call(input JSON)／function_call_output 配对。Codex exit 0，三条 Proxy 指标均 completed／total=20。原生进程、Proxy、回环上游均已关闭；没有通过命令代写目标文件。
- 第六批限制：没有真实 cp-ollama Key／账户或付费推理授权，未读取或修改真实配置、未调用真实 Ollama 模型与搜索、未部署或重启用户服务。真实云端 freeform 验收、公开元数据自动生成目录、逐模型 Responses 验证和 hosted-search 执行仍未完成；Windows/macOS、CI 固定 Node 22.23.4 与完整渠道路径没有实机观察。能力声明只说明本地选择，不证明真实上游可用。
- 第七批以 `67b48a08` 为基线：已接通已配置 OLC 账户的公开候选→明确选择具体账户和单模型→另行确认可能收费→逐级 Responses 普通函数/配对模拟结果文本续答→统一新增预览/确认/保存。首次账户仍手动创建。发现不推理，发现令牌不能保存且仅消费一次；每次付费提交复核精确账户材料、本地目录和底座，公开来源在验证首尾完整复核。主审指出原生 Codex 使用流式后，验证范围收紧为每级两轮 SSE、来源默认等级额外两轮 JSON，共最多十六次，每次 768 输出 Token/128 KiB，统一 90 秒含来源复核，无重试。共用 Provider Proxy 的公开 consumer 读取 Fetch 正文，额外核对实际 `output_item.done`、文本增量与终态一致；新 manifest 范围为 `responses-sse-and-json-default-roundtrip` 并记录 JSON 等级，不接受开发中旧 JSON-only 记录作当前范围。不执行工具，不宣称实际思考质量或长上下文。自动草稿使用通用编程提示词与已有本地工具，图片/freeform/搜索关闭；能力来源独立于明确选择的 official 提示词模板。保存沿用原受管事务、备份和回读，来源快照十分钟过期，不承诺远端与本地原子提交。主审、Astra 独立全链路复审及修复完成，已提交为 `3805c7d1`，正常提交 hook 用时 43.2 秒并通过，提交后工作区干净。
- 第七批初版 JSON-only 旧基线观察（Node 24.22.1、仅合成 metadata/Responses、虚拟 Key）：`runProviderModelAdditionSetup` 对 `auto-model:2026` 验证 `none/high`，发出四次 JSON 推理请求，费用与保存各确认一次，经真实 Codex 目录校验后返回 `catalog-updated`。WebUI 共用的 `loadProviderSettingsResource` 读到同一四模型目录及 alpha/beta 两账户；原三个模型内容、两个账户 Profile 与默认模型不变。主审浏览器随后在同一 fixture 明确选 beta 并添加 `browser-auto:2026`，捕获两次 JSON 请求且仅使用 beta；保存后五模型、原模型和两个 Profile 不变，备份 SHA256 与写前目录相同，截图 `output/playwright/ollama-discovery/saved-model.png` 已查看中文字形正常。此观察只证明旧 JSON-only 范围，不能代替收紧后的 SSE+JSON 验收；fixture `/tmp/olc-batch7.T9EaC6` 仅保留旧基线，不向生产格式增加兼容分支。
- 第七批初版 Hack 旧基线：公开发现的五个条目分别为两个可验证新候选、一个布尔思考待确认、一个缺工具排除及一个已保存 ID；保存候选为零且付费计数为零。未确认、伪造令牌、布尔思考及已保存 ID 在付费前拒绝；同一发现令牌两并发请求只有一项通过（四次 JSON 推理），另一项为 `addition-source-expired`。HTTP 200 错误结构、未调用函数、未完成工具项、错误模拟结果、HTTP 429 及超过 128 KiB 均无法确认且不保存；429 恰一次请求。公开来源中途变化返回 `stale-preview`；首次请求后通过既有账户事务轮换虚拟 Key，只发出一次推理便拒绝续请求。中途取消无法确认，预取消零推理；重复公开 ID 在零推理时拒绝。另一入口竞争修改窗口后，旧保存预览为 `stale-preview`；独立保存两个自动模型后，移除其中一个只裁剪目标 `modelDiscovery`，另一记录保持原值，beta runtime 读取启用集合一致。自动字段回读窗口/最大值均 393216、仅 text、patch=null、search=false、仅实际验证等级。旧反例 fixture `/tmp/olc-batch7-hack.DfVnGa` 保留，自有进程已退出；这些计数仅对应旧 JSON-only 实现。
- 第七批 SSE+JSON CLI 观察：从第五批无新来源字段的数据另建 `/tmp/olc-batch7-stream.LVg4Gb`，实际 CLI 新增入口对 `auto-sse:2026` 的 none/high 共发出六次合成请求（SSE 四次、high JSON 两次），明确确认费用及保存，经真实 Codex 校验返回 `catalog-updated`；WebUI 后端回读同一四模型目录，原三个模型及 alpha/beta Profile 均不变，新来源记录包含实际六请求、JSON high 及新 scope。该 fixture 已移交主代理用于收紧后的浏览器路径。相同发现令牌并发只一项 verified/六请求，另一项过期；仅终态 JSON 快照、缺失/未完成工具 done、终态与 done 冲突、文本 delta 冲突、event/type 不一致、半帧、超限和 HTTP 429 均无法确认；429 恰一次。SSE 两轮通过但 JSON 默认首轮错误时，第三次请求即阻断，未生成可保存候选。
- 第七批 SSE+JSON 浏览器观察：主代理在 `/tmp/olc-batch7-stream.LVg4Gb` 的实际模型页明确选择 beta、`browser-sse:2026` 与 high，确认费用提示每级两轮 SSE、默认 high 另加两轮 JSON/最多四次/90 秒；实际管理路由捕获 SSE 工具/续答及 JSON 工具/续答四次，全部账户为 beta。预览显示 SSE high/JSON high/四次，确认写入后 runtime 为五模型，新模型 context/max=393216、text/high、patch=null/search=false；旧四模型及两个 Profile 不变。目录备份 SHA256 `060e77cc828fe5f9a4fac21236699a8a510af38d7b380e5f7d5383ef8416b26d` 与写前相同，manifest 新 scope/JSON high/四次/时间 `2026-10-26T19:31:33.613Z`；实际审计读到 beta 的 requested/started 与 completed/verified。截图 `output/playwright/ollama-discovery/sse-json-saved.png` 经主代理查看中文字形正常；详情的共享目录代表 alpha 标签不是收费账户证据，收费账户由明确选择及捕获确认。WebUI 构建通过，自有浏览器/WebUI/App Server 均退出，精确 fixture 环境进程检查为空。此次合成列表顺序不变，来源排序修复由下面反例覆盖。
- 第七批新格式反例：另建 `/tmp/olc-batch7-streamhack.koxECp`，公开模型原始顺序每次反转仍可验证；七个等级共十六次，SSE 十四次/JSON 两次，实际请求输出预算均 768。tags digest 中途变化在四次请求后为 `stale-preview`，首个请求后通过原账户事务轮换虚拟 Key，后续提交拒绝且总计一次；取消一次请求后无法确认。竞争窗口更新使旧新增预览拒绝；分别保存两个新 scope 模型后移除目标，另一来源记录保持原值。真实等待统一期限的挂起合成请求在约 90002 毫秒结束为 inconclusive/cancelled-or-timeout，总计一次，无重试；自有 keepalive 已清理。旧的无 keepalive 尝试仅 Node exit 13，不作为超时成功证据。新 fixture 保留供独立复审，自有进程均已收齐。
- 第七批收费前准入：先构造完整合并目录及有界来源的预计结构，检查 64 项/2 MiB、manifest 格式与 128 KiB 来源容量，并使用现有原生 Codex 校验器；通过才消费发现令牌和开始网络验证，保存预览仍按当前修订重新验证。在上述新反例 fixture 中，经真实 Codex 校验及现有 writer 生成 64 模型、271362 字节的任务目录后，再验证新候选得到 `addition-source-too-large`，推理计数为零，runtime 仍为 64 模型，没有删除旧项腾空间。该 fixture 最终保留此容量状态，之前四模型的新格式反例证据对应其前序状态。
- 第七批公开兼容与来源修正：真实 `node bin/codexc.mjs provider ollama-cloud discover --json` 在隔离环境 exit 0，耗时约 7.87 秒，23 项中 11 candidate、11 unconfirmed、1 excluded，stable=true。随后产品命令处理器连续两轮公开读取共 54 个 metadata 请求，出站显式禁止非公开端点及 Authorization，0 Key/0 Responses；tags 及全部 show 摘要相同，原始 models 摘要不同。独立两次 `/v1/models` 逐字段对比确认只是 data 顺序变化，按 ID 字段不变。来源绑定据此使用已排序精确 ID、tags 和全部候选/show 指纹，原始 models hash 保留审计事实但不作为排序无关的修订依据；不放宽模型 ID、能力或 digest 变化检查。
- 第七批管理边界观察：验证前 requested 审计失败时零推理；验证完成后审计失败保留结果并返回 degraded，界面提醒勿为补审计重复付费。公开候选读取登记 owned read，关闭时已有读取从 1 项取消为 0，未写响应；在 load/verify 两条路径的慢请求体读取期间先关闭，再补齐正文，均返回 503、网络调用 0、owned reads 0。两分支在 await body 后再次检查关闭状态，避免关闭后迟到网络任务。
- 第七批 Astra 独立复审修复：沿 CLI/Setup、WebUI 认证/审计/取消、发现令牌、付费前准入、逐次材料复核、共享 writer/恢复、模板更新与移除、runtime 消费追踪后，对照锁定 Codex `codex-api/src/sse/responses.rs` 和 `protocol/src/models.rs`，发现诊断的 marker 往返成功不足以证明原生可消费。修复前内联合成反例中的错误 function metadata、message phase、annotations、终态 usage、SSE envelope、reasoning summary 六类均实际返回 verified/四请求；锁定源码会在事件或输出项反序列化时拒绝这些字段。仅在本批诊断中补齐实际消费字段的类型约束，分别在一或二请求返回 inconclusive，默认 JSON 阶段错误 usage 在第三请求停止；null cache-write 计数也在首请求拒绝。reasoning 与其他回放项一样必须具有实际 done，终态独有 reasoning 首请求拒绝；合法 `reasoning.content:text`、optional phase/metadata/usage 与完整 reasoning done 均保留支持。未改通用 reader，没有执行真实云端请求。
- 独立修复后的真实产品路径：从当前五模型样本仅复制必要配置/目录材料到 `/tmp/olc-batch7-astra.2STBj8`，三路径隔离、虚拟 Key。实际 `runProviderModelAdditionSetup` 对 beta 的 `astra-native:2026` 验证 none/high，十五次公开合成 metadata、六次合成 Responses，两次明确确认后由真实 Codex 目录校验及既有 writer 返回 catalog-updated；合法 optional 字段和 reasoning added/done 贯穿 SSE/JSON。WebUI 后端与 runtime 都读到六模型，旧五模型和 alpha/beta Profile 逐项相等，目录备份与写前字节相等（SHA256 `a216f05fd38a6310144220a0492834b875ea042e2effad59c238a783ca38ee88`），来源 JSON 等级 high、六请求、时间 `2026-10-26T19:44:12.850Z`。内联观察均结束，无自有服务或后台作业；本次没有重复浏览器观察，原新版浏览器输入仍属于合法字段范围。
- 第七批静态工作流：根类型/模块边界、Gateway 完整构建、定向 ESLint、文档索引（94 文件）、中英文 i18n（2304 源键及占位符）和 diff 空白检查通过；WebUI 完整构建由主代理完成且与新版浏览器输入一致。Astra 独立全链路复审及上述修复完成后，重新执行根 check（含模块边界）、修改脚本 ESLint、docs:check 与 diff 空白检查均通过；没有创建或修改测试、guard/probe 脚本或依赖，后由主代理正常提交为 `3805c7d1`，未推送或部署。
- 第七批边界：没有调用真实 Ollama 推理或搜索，没有读取/改写真实 cp-ollama Key、配置、账户或服务；真实云端逐模型能力与付费结果、图片、长上下文及 hosted-search 仍未验收。Windows/macOS、CI 固定 Node 22.23.4、真实代理连接与完整渠道路径未实机观察。CLI、浏览器与反例中的推理均为隔离合成响应，不能代替真实云端验收。
- 第八批以 `3805c7d1` 为基线：接通可信 OLC 的 live hosted 搜索；纯映射与响应状态由 model-api 持有，固定官方搜索 HTTP 及有界 Responses 多轮编排由 Provider Proxy 公开出口持有，Proxy/Relay 分别授权、复核和取消。不是 Chat 转换、MCP 或 web_fetch。模型轮完整校验后才交付搜索或客户端调用；同批客户端调用只返回明确 not_executed 的内部配对结果。每轮重新创建 freeform adapter，内部历史不二次包装，跨轮上游重复 call_0 重写为请求级唯一调用身份。外部单 response ID、连续输出索引及序号、单终态，成功搜索才发布 completed；历史仅降为可读查询，不补结果。显式输出预算逐轮扣除，无法计量或已耗尽时在搜索前停止；已知模型用量累加，未知不充零，缺必需计数的外部 usage 整项省略，多轮不发布生成速率。普通无搜索请求保留原始 JSON 字节及原输入合同。
- 第八批隔离 HTTP 观察（Node 24.22.1）：固定官方 hostname/path 通过仅本地的 synthetic Agent 回环，不发送真实云端请求。Proxy 与 Relay 的 JSON/SSE 四条入口都完成两模型轮、一次搜索，返回 200、web_search_call 和最终回答，usage 为 8/4/12；SSE 序号 0–12 连续且只有一个终态。另一次混合 JSON 中预算 10→8，required→auto，首轮客户端调用不出现在外部 output，内部 not_executed 与原调用逐一配对；两轮 cached/reasoning 分别累计为 2/2。三轮 freeform 混合观察中，上游每轮重用 call_0，原 custom 历史在第二、三轮始终是单层 {input:"raw patch"}，外部只发布最后纯客户端轮的唯一 custom 调用。
- 第八批原生路径：新 fixture `/tmp/olc-batch8-native.nJYfOO` 设置 CODEX_HOME、CODEX_CONNECT_HOME、CODEX_CONNECT_CONFIG_FILE，synthetic-only Key，原生 Codex 0.164.0 以 workspace-write/never、ignore-user-config、ephemeral 启动；通过受支持 escalation 执行，不关闭沙箱、不读内部 sessions。真实 ProviderProxy 两轮 SSE 中，原生 CLI 输出 web_search 的 item.started 与 item.completed，之后 agent_message 为“根据隔离搜索摘要，答案是 42。”，turn.completed 为 input8/output4，进程 exit0；内部第二模型请求实际含合成摘要。只产生一条 completed/total12 的外部指标。CLI 固定使用流式，非流式证据来自真实 HTTP 客户端。原生进程、Proxy 和本地上游均已关闭。
- 第八批 Hack：七类不能兑现的控制（external_web_access=false、indexed_web_access=true、filters、user_location、search_context_size、search_content_types、未知字段）都实际返回 400 且零模型/搜索出站。搜索 401→受控 authentication/502、429→rate_limit/429、畸形 results→invalid_response/502，不回传任意 SECRET 错误正文；合法空 results 正常续答。显式预算缺计数或耗尽均只发一模型轮、零搜索；none 违约、未知工具及上游伪造原生 search 均不执行搜索。重复搜索在五模型轮/四搜索后受控停止，材料撤销在一模型轮/一搜索后不续答。摘要 32769 字节被拒绝。客户端在搜索等待中断开后对应 socket 实际关闭，不再续答；refresh 永不返回时外部取消约16ms结束且零出站。模型 HTTP429 与搜索429分别观察，模型429具有实际首响应计时且首内容保持未知。
- 第八批普通路径回归观察：无 hosted 声明/历史、max_output_tokens=null、以及普通函数恰同内部名称的三种合法普通请求，真实 HTTP 上游收到的原始 JSON 空白和字节均完全一致，原始响应空白及 sequence_number=900 也保留。只有搜索历史而无当前声明时仅降为可读说明，null 预算保持原样，不触发搜索。
- 第八批消费及采集收尾：混合轮的畸形 message.content、phase、metadata、annotations、reasoning.summary、end_turn、重复 query 键和 SSE 工具 done/terminal 参数冲突，均实际一模型轮、零搜索并返回受控失败，已知 raw usage 仍计入指标。合法 passive 项续答成功，最终 end_turn=true/false 原值保留；多轮 usage_metadata 不把末轮金额伪装成总费。完整及部分缺计数的 JSON 回答均完成，外部 usage 省略；原生 CLI 的两次缺计数终态也都 exit0并显示回答，Gateway 指标分别为全 null 与仅 output3。CLI 自身在 turn.completed 打印零值是原生缺省展示，不能当作实际模型计数。普通无搜索 Relay 的 inactive adapter 关闭后，原来透传的 legacy 函数输出和其他响应字段继续保留。`/tmp/olc-batch8-capture-AbEsxK` 的实际产品转储中，Proxy/Relay 均每模型轮独立 request/response ID、无空外部记录，内部摘要确实入转储，未发现 synthetic Bearer；Relay capture 关闭后 active=0。真实搜索等待45008ms后恰一请求返回 olc_search_timeout；短 deadline 注入14ms取消 owner、零提交，但未等待完整十分钟总期限。
- 第八批搜索设置由主代理观察：CLI 与 WebUI 共用 `/tmp/olc-batch8-settings.0h2Jfa` 的两个虚拟账户；仅 beta live 保存影响其 Profile 和 startup 的 web_search="live"，alpha、共享目录和 manifest 摘要不变。无变化/取消字节不变，竞争 cached 更新使旧预览 stale-preview，inherit 删除独立覆盖。真实浏览器读取 beta live 并看到提示，截图 `output/playwright/ollama-search/settings-live.png` 已查看；随后 disabled→预览→确认写入，运行读取和 startup 同步为 disabled，alpha 仍无覆盖且目录/manifest 不变。fixture 最终为 beta disabled。WebUI 构建及 i18n2305 通过；主代理已关闭浏览器、临时 WebUI 和 App Server，精确 fixture 进程检查无残留。
- 第八批独立全链路复审：重新核对可信账户/目录材料、固定与切换实例、独立 Relay Key、live 声明/选择/历史、freeform 整轮验证、混合客户端延后、固定搜索 I/O、续答预算、单响应/native 消费、累计计量/采集和取消。确认原先已开始 SSE 后的搜索失败只断流（Proxy）或返回原生不认识的错误码（Relay），会被锁定 Codex 当作可重试。隔离原生 fixture `/tmp/olc-batch8-astra-native.mHNnVC` 在搜索401反例实际产生两模型轮/两搜索及 Reconnecting；修复后 `/tmp/olc-batch8-astra-native.csdjU8` 仅一模型轮/一搜索，直接 turn.failed，无搜索完成项。现在两 owner 都以单 canonical response.failed、invalid_prompt wire code 和具体错误 type 收尾；已成功搜索仍保留 completed，失败搜索不发 output_item.done。
- 独立修复后的实际观察：Proxy 与 Relay SSE 正常两模型轮/一搜索，序号0–12连续，usage6/4/10；认证失败序号0–4、单 failed、搜索status=failed且零done，已知usage3/2/5保留。注入120ms的整体期限取消挂起搜索后也得到同一失败终态，未实际等待十分钟。搜索成功后的材料撤销均一模型轮/一搜索后停止续答；Relay 用实际 admission.invalidateProvider 撤销租约。refresh 内 await stopListening 的反例实际解除等待，没有自等死锁；此时连接已关闭，不能交付失败终态。真正客户端断连关闭搜索连接并不续答，修复 Proxy 将这类情况误记为搜索故障的问题，保留 client_disconnected。Relay 各例收尾 active/pending/waiting/bytes/metricFailures 均零，所有自有网络连接最终关闭。
- 独立原生成功路径 `/tmp/olc-batch8-astra-native.p6e1qH`：虚拟 Key、临时 CODEX_HOME/CODEX_CONNECT_HOME/XDG_CONFIG_HOME、ignore-user-config/ephemeral/workspace-write/never；原生0.164.0经真实Proxy两轮SSE和合成官方搜索响应，显示搜索 started/completed及“隔离搜索结果为42。”，turn.completed input4/output4，exit0，只记录一条completed指标。没有真实云端请求或付费。首轮两次夹具启动分别因参数位置和 stdin 未关闭未发请求，另一次路径/v1错误为404；均已收齐退出，不作为产品成功证据。
- 独立错误消费与提示修复：Proxy/Relay 的精确 olc_search_* 码在真实失败指标中保留，IPC验证与SQLite写读合同不剥离这些码；WebUI原先只识别CLP，现补八类OLC中英文分类，最后模型HTTP200不掩盖搜索认证、限流或期限错误，本地断连仍优先。实际HTTP指标经现有分类器得到对应原因，并逐项读取两种语言文案；未重新观察浏览器错误列表布局。CLI首次账户提示及WebUI账户说明区分目录能力与实际web_search模式，引导live/disabled，不修改设置writer或默认值。
- 独立资源边界修复：两段各600000个反斜杠的custom历史，包装前body2,400,680字节、实际wire4,800,708字节，原逻辑真实提交过一轮超4MiB请求；改为对每轮freeform包装后的实际正文及input计量后，同输入零出站并受控拒绝。各300000个反斜杠的累计反例初轮wire2,400,708字节，实际一模型轮/一搜索后在第二模型轮前因累计输入超限停止。最终快照超900KiB的反例原先created seq0之后失败seq7且含未发布message，现先检查prospective snapshot，失败seq1且output为空。最终资源及序号修复后的原生正常路径 `/tmp/olc-batch8-astra-native.JDOauu` 再次两模型轮/一搜索、中文42、turn.completed input4/output4、exit0，正常消费保持。
- 独立交付竞态补充：在真实HTTP正文delta写入后、外层等待完成前通过微任务注入owner总期限，已预生成的最终事件会使旧失败序号跳为0/1/2/3/8。现改为共享编排及两个owner在实际提交时分配序号，未交付事件不占号；Proxy期限、Relay期限、Relay实际租约撤销三例均0–4连续且只有一个response.failed，不再提交模型。Relay此时已完整收到末轮模型结果，模型指标status保留completed，不能据此称外部响应成功；细分期限/撤销原因仍记录。真实断连或写入本身失败时保持关闭，不能保证错误送达。
- 第八批边界：官方动态文档和锁定 Codex 搜索声明、Search action、原生 SSE 消费合同已核对；实现不保存 Gateway 会话缓存或 StateStore 正文。启用模型报文转储时，每个真实模型轮独立采集，内部续答的查询、链接和摘要可能随模型请求持久化，不能宣称来源正文永不存盘；例行指标/日志不收这些正文。真实 Ollama 搜索、模型推理、账户权限/费用、Windows/macOS 与完整渠道展示均未观察，没有读取真实 cp-ollama 配置或 Key，没有部署或重启用户服务。fresh Astra 独立全链路复审及必要修复已完成，当前等待主代理最终核对；未提交。
- 第八批开发静态工作流：根 TypeScript/模块边界、Gateway 完整构建、定向 ESLint、文档94文件索引/链接及 diff 空白检查通过；没有创建或修改测试、guard/probe 脚本或依赖。所有自启内联观察进程、HTTP 服务、原生 Codex 与异步句柄均已收齐并结束，未手动运行 verify:commit。
- 独立修复后的静态工作流：根check/模块边界、完整Gateway构建、所改源码及Setup脚本ESLint、WebUI完整构建、i18n2321源键/中英文占位符、docs94文件和diff检查通过。一次在webui目录误调用不存在的i18n:check后，已从根目录运行正确入口并通过；没有弱化检查或维护冻结测试。
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
- 真实 Ollama 上游 freeform 适配后的原生 `apply_patch` 编辑；第六批本地合成上游路径已单独记录，不能代替真实上游验收。

## PR #308 合并后的关联复审

基于 `51066f6b` 读取共享模型目录/账户事务、定义注册与命名空间、CLI/WebUI 管理入口、账户适配器、Provider Proxy 与独立 Relay、锁定 Codex 工具声明和事件消费。确认并修正文档中的证据时态、固定模式实例数量、共享目录隔离、CLP 专属本地编辑限制、已有家族辅助函数、备份先后及金额精度假设。

协议反例分析补齐：包装 JSON 的 delta 不能原样改名为补丁增量；完成参数为空仍须拒绝；并行调用身份、重复终态、请求侧历史/选择、输出结构数组及 HTTP 头/背压/错误必须一并处理；取消不承诺回滚已执行工具。官方文档明确不支持 custom 历史重放，因此两轮往返仍是阻断验收条件。目录发现失败不等于下架，原生思考/图片元数据不等于 Responses 能力，账户变量归一化碰撞须拒绝。

本轮仅修改本文和根 `index.md`，不实现 OLC、不变更用户配置/目录/凭据或服务，也未进行收费推理与真实文件工具执行。原始探测快照未独立复现，待验证事项保持开放；文档静态检查只证明索引和链接一致。
