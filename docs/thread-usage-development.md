# OpenAI Thread 官方用量开发设计

本文定义 Codex CLI `0.148.0` 引入、并在当前锁定 `0.150.1` 复核的 `account/usage/read.threadId` 与 `threadUsage` 在 Gateway
中的采用方案。目标是在不新增聊天命令、不改变第三方 Provider 用量口径、不建立第二套账本的
前提下，让现有 `/usage` 同时展示 OpenAI 账户活动摘要和当前 Thread 的官方估算。

## 结论与范围

- 继续使用现有 `/usage`，不增加 `/usage thread` 或其他别名。
- 当前 `/usage` 选择 OpenAI 账户且 Conversation 已绑定 OpenAI Thread 时，查询账户活动摘要，
  并按同一活动 ChatGPT 账户查询该 Thread 的官方估算；两个结果在同一命令回复中分区展示。
- 没有当前 Thread 时只显示既有账户摘要，不发起 Thread 用量查询。
- 当前 Thread 属于 DeepSeek、OpenCode Go 或其他 Provider 时保持各自既有 `/usage` 行为，
  不调用 OpenAI App Server，也不显示伪造的统一估算。
- Thread 估算是可选增强。不可用或查询失败不得使已经成功取得的账户摘要丢失。
- 首期只查询当前精确 Thread ID，不递归查询或合计子代理 Thread，不写入本地指标数据库。

本设计不修改公开命令语法、Gateway 配置、StateStore 或指标 Schema。

## 固定事实来源

当前实现只以正式 Tag `rust-v0.150.1` 为准：

- [`app-server/README.md`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/README.md)：
  `account/usage/read` 传入有效 `threadId` 后，使用 App Server 当前活动账户查询一个 Thread 的
 估算 Credit、可选美元费用和用量分组；计费路由不可用时 `threadUsage` 为 `null`。
- [`account_processor.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/account_processor.rs)：
  只接受规范 Thread UUID，只允许 ChatGPT 后端认证，将后端 `403` / `404` 收敛为
  `threadUsage: null`，超时和其他错误返回 JSON-RPC 错误。
- [`account_thread_usage.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/account_thread_usage.rs)：
  活动 Workspace、规范 Thread ID、外部管理认证、不可用计费路由和非法 ID 合同。
- 本地生成类型：[`codex-protocol/generated/v2/`](../src/codex-protocol/generated/v2/)。字段名称、
  可空性和整数单位以生成类型为最终事实来源。

官方 TUI 只在 ChatGPT 后端认证且套餐为 Business、Enterprise 按量或 Enterprise Automation 时
主动查询这项数据。Gateway 不复制 TUI 的静态套餐白名单：App Server 的活动账户和后端计费路由
才是事实来源；返回 `null` 时标记官方计费估算不可用，并提示官方当前只向部分
Business/Enterprise 工作区开放，但不把本次不可用精确归因到某一种套餐或后端原因。

## 官方数据口径

`threadUsage` 包含：

- `threadId`：本次查询对应的规范 Thread ID。
- `estimatedUsageCreditsMicros`：官方估算 Credit，单位为百万分之一 Credit。
- `estimatedUsageUsdMicros`：可选官方美元估算，单位为百万分之一美元。
- `groups`：按模型、思考等级和速度拆分的 Credit 与可选 Token。
- Token 分组可包含 `netNewInputTokens`、`cachedInputTokens`、`inputTokens`、`outputTokens` 和
  `totalTokens`，字段缺失不解释为零。

该结果和本地 `/metrics` 的含义不同：

| 口径 | `/usage` Thread 官方估算 | `/metrics` 本地请求统计 |
| --- | --- | --- |
| 来源 | OpenAI 活动账户的计费后端 | Gateway Provider 代理与指标库 |
| Provider | 仅 OpenAI ChatGPT 后端 | OpenAI、DeepSeek、OpenCode Go |
| 金额 | 官方估算 Credit 与可选美元 | 按请求发生时价格快照计算的 API 参考费用 |
| 更新 | 可能在 Turn 完成后延迟结算 | 请求完成后由本地 Writer 持久化 |
| 子代理 | 协议只保证精确 Thread，不保证递归合计 | 会话累计递归纳入显式父子关系 |
| 历史 | 按需读取当前快照 | 按配置保留明细与时间范围聚合 |

因此不得把两类金额相减、合并成“真实账单”，也不得使用本地 API 参考价补齐官方缺失的美元字段。

## `/usage` 用户合同

### OpenAI 且存在当前 Thread

命令先保留既有账户活动摘要，再追加独立区块：

```text
OpenAI Codex 账户用量摘要：
……

当前 Thread 官方估算：
- Credits：46
- 估算费用：$1.82
- 计费 Token：输入 100 · 缓存 20 · 输出 40
- gpt-5.4 · high · fast：46 Credits

官方估算可能延迟更新；本地请求明细与子代理累计请查看 /metrics。
```

- Credit 和美元按百万分之一单位转换，使用有界小数，不用浮点结果反推原始整数。
- 只有所有分组都提供对应 Token 字段时才显示该项合计；部分缺失时省略，不按零累计。
- 分组逐行显示模型、思考等级、速度和 Credit；缺失维度显示“其他”。最多展示 8 组，并显示
  尚未展示的组数，避免渠道消息无界增长。
- `estimatedUsageUsdMicros` 为 `null` 时省略美元行，不显示“$0”。
- 不显示原始 Thread ID、活动账户 ID、Workspace ID 或后端错误正文。

### Thread 估算不可用

`threadUsage: null` 时仍完整显示账户摘要，并追加：

```text
当前 Thread 的官方计费估算不可用；该能力目前仅向部分 Business/Enterprise 工作区开放。
```

不得声称套餐一定不支持，也不得建议切换 Provider、重新登录或充值，因为当前锁定的 `0.150.1` 合同没有提供
不可用原因。

### Thread 查询失败

账户摘要已成功而 Thread 查询超时、过载或返回其他错误时，继续返回账户摘要，并追加：

```text
当前 Thread 官方估算暂时无法查询，请稍后重试 /usage。
```

错误日志只保留既有 JSON-RPC 安全元数据，不把上游响应或认证信息放入渠道文案。账户摘要自身查询
失败时保持现有 `/usage` 失败行为，不用 Thread 估算掩盖主查询错误。

### 没有当前 Thread 或第三方 Provider

- 没有绑定 Thread：OpenAI `/usage` 只显示账户摘要，不追加“不可用”提示。
- DeepSeek 与 OpenCode Go：保持当前余额、配额窗口和本地模型用量展示，不出现 OpenAI Thread
  估算区块。

## 请求编排

OpenAI 且存在当前 Thread 时，账户摘要和 Thread 估算是两个独立的只读
`account/usage/read` 请求：

1. 账户请求继续发送 `params: undefined`。
2. Thread 请求发送 `params: { threadId }`，Thread ID 只能取自当前已授权 Conversation 的绑定，
   不接受外部用户输入。
3. 两个请求可以并行，以免 Thread 可选查询串行增加 `/usage` 延迟。
4. 账户请求是主结果；Thread 请求使用 `Promise.allSettled` 等等价失败隔离。主结果失败时命令失败，
   Thread 结果失败时返回上述稳定降级状态。
5. 两个请求都属于安全只读查询，可复用现有有界过载重试；不增加业务层轮询或无界重试。

官方 TUI 会在 Turn 完成后按结算窗口再次读取，但 Gateway 首期不复制后台轮询。用户主动执行
`/usage` 时读取当时权威快照；需要刷新时再次执行同一命令。这样不会给每个 Turn 增加额外网络
请求，也不会让后台任务长期占用生命周期。

## 稳定类型与模块落点

### `codex-protocol`

- 从受控入口只新增实际直接使用的 `GetAccountTokenUsageParams`；既有
  `GetAccountTokenUsageResponse` 内部引用生成的 Thread 用量类型，不额外扩大受控出口。
- `account/usage/read` 已是现有稳定方法；本次只采用它从 0.148.0 起提供、并在当前 0.150.1 复核的可选参数和响应字段，
  不增加实验握手或运行时兼容层。

### `codex-client`

- `client.ts` 增加 `accountThreadUsage(threadId)`，发送精确参数并复用只读过载重试。
- `account-adapter.ts` 把生成响应映射为稳定 Application 结果：
  - 校验响应 `threadId` 与请求完全一致。
  - 校验 Credit、美元和 Token 为非负有限整数；`null` 保持未知。
  - 校验模型、思考等级和速度是 `null` 或有界非空字符串。
  - `threadUsage` 缺失或为 `null` 都映射为 `unavailable`，不兼容旧服务器；运行版本门禁仍要求
    精确 `0.150.1`。
- Adapter 不生成渠道文案、不访问指标库、不缓存估算。

### `application`

- `account-port.ts` 增加稳定 `AccountThreadUsage` 与
  `available | unavailable | failed` 可辨识状态。
- `AccountQueryPort` 增加精确 Thread 查询；OpenAI Provider Adapter 可接收当前 Thread 上下文，
  第三方 Adapter 不新增伪实现。
- `ConversationService.providerAccountUsage` 先通过当前绑定确定 Provider 与 Thread；只为 OpenAI
  账户选择且实际绑定也属于 OpenAI 的情况传递内部 Thread ID，保持既有待生效 Provider 选择、
  Actor、Workspace 和 Conversation 授权链路。
- 账户摘要和 Thread 查询并行但失败隔离；Application 不解析完整协议响应。

### `surfaces`

- 三个 Surface 继续共用 `conversation-command-format.ts` 的结构化结果格式化，不分别实现估算逻辑。
- `/help`、命令菜单和公开语法不变；只需更新 `/usage` 的说明文字和展示合同测试。
- 分组和提示在共享 Formatter 中有界生成，平台 Renderer 只负责既有 Markdown/卡片转换。

### `observability` 与存储

- 不修改 `request-metrics.sqlite3` Schema，也不向其写入官方估算。
- 不修改业务 StateStore、配置文件、更新脚本或数据库迁移。
- `/metrics`、完成卡片、子代理完成卡片和 CLI 指标报表保持现有本地口径。

## 子代理边界

`account/usage/read` 的 App Server 参数一次只接受一个 Thread ID，当前固定文档和测试没有声明父
Thread 的结果递归包含子代理。首期必须按“当前精确 Thread 官方估算”展示，不能标为“会话总账”。

不使用本地 `subagent_threads` 关系逐个调用官方接口并自行求和，原因是：

- 不能证明父 Thread 官方结果是否已经包含部分子代理，存在重复计算风险。
- 多个 Thread 的后端结算时间可能不同，合计不是同一时点快照。
- 子代理数量会把一次 `/usage` 放大成无界外部请求。

用户需要包含子代理的本地请求、Token 和参考费用累计时继续使用 `/metrics`。只有后续官方协议明确
提供父子聚合语义或批量返回的归属合同，才重新评估官方子代理合计。

## 验证链路

实现至少覆盖：

1. Client 请求参数：账户摘要仍为 `undefined`，Thread 查询精确发送 `{ threadId }`，两者只读过载
   重试行为一致。
2. Adapter：完整结果、美元缺失、空分组、部分 Token 缺失、`threadUsage` 缺失/`null`、Thread ID
   不匹配、负数/非整数和异常字符串。
3. Provider：OpenAI 当前 Thread 触发双查询；无 Thread 只查账户；DeepSeek/OpenCode Go 不调用
   OpenAI Thread 查询。
4. Application：账户主查询失败保持失败；Thread 可选查询失败收敛为 `failed`，不丢账户摘要。
5. Formatter：可用、不可用、失败、缺失美元、Token 部分缺失、8 组截断和三渠道一致文案。
6. 真实 App Server 合同：在条件式 `RUN_CODEX_INTEGRATION=1` 环境验证精确 0.150.1 接受规范
   `threadId`、非法 ID 失败关闭，以及认证环境允许时返回 `unavailable` 或匹配请求 ID 的结构化结果；
   未配置 ChatGPT 认证或计费路由时必须明确记为跳过/不可用，不能伪报成功结果。
7. 定向测试通过后运行 `npm run check`、`npm run lint`、`npm run docs:check` 和协议检查；提交时由
   pre-commit 统一运行 `npm run verify:commit`。

## 完成标准与停止条件

完成标准：

- `/usage` 语法不变，OpenAI 当前 Thread 的官方估算在可用时稳定展示。
- Thread 查询不可用或失败不破坏账户摘要；第三方 Provider 没有额外 OpenAI 请求。
- 官方估算与本地 `/metrics` 口径、子代理范围和结算延迟均明确展示。
- 没有新增持久化字段、后台轮询、第二套账本或跨 Provider 估算。
- 协议支持矩阵、模块 README、展示文档和测试与实现一致。

遇到以下任一情况停止实施并重新审查：

- 为显示 Thread 估算必须读取 Codex 内部会话文件或绕过当前 Conversation 绑定。
- App Server 返回的 Thread ID 与请求不一致，或需要客户端推断计费归属。
- 需要把官方估算写入本地指标库才能完成主路径。
- Thread 可选查询失败无法与账户主查询隔离。
- 第三方 Provider 需要调用 OpenAI 账户接口或伪造等价字段才能统一展示。
