# 图片识别代理

Gateway 保留 Codex App Server 原生图片输入；只有当前模型目录不支持 `image` 时，才按显式配置
把已经由 Surface 校验的 PNG/JPEG 交给视觉识别适配器，并将受控文字结果提交到原 Thread。

当前模型原生支持图片时不会经过代理。当前模型不支持图片时，Gateway 把用户原始提示作为观察重点，
连同最多四张图片交给外部视觉模型，再将严格裁剪的识别结果送回原 Thread 完成回答。视觉模型只做
客观观察、文字提取和不确定项标注，不分析、核实或回答用户问题。该流程不创建额外的
Codex Thread，也不区分 OpenAI、DeepSeek 或 OpenCode Go 模式。外部请求发起后，渠道会明确提示图片
数量和本条要求已经发送到视觉 API；原生图片输入不会显示这条提示。

手机端不方便在图片说明中同时填写任务时，可以先发送：

```text
/vision 分析图片中的报错原因
```

再于五分钟内发送图片。要求按通讯渠道账号、Conversation 和 Actor 隔离，只保存在 Gateway
内存中，只用于下一批最多四张图片；普通文字不会消费它。重复设置会替换旧要求，发送
`/vision cancel` 可取消，超时、Gateway 重启或 Surface 停止时自动清除。图片本身带有说明文字时，
预设要求和说明会一起提交。原生支持图片的模型收到同一次 `text + localImage` 输入；不支持图片的
模型继续使用下述外部视觉接口，不新增 App Server RPC 或 Thread。

微信客户端的一张图片就是一条独立消息。需要把多个独立图片消息作为同一次输入时，先声明数量：

```text
/vision 3 比较这些图片的差异
```

随后逐张发送指定的 2–4 张图片，渠道会逐张确认进度，收齐后自动提交，不需要完成命令。
全局调试模式开启时，`/vision` 要求确认会显示毫秒级“接收延迟”和“Gateway 处理”：接收延迟从
平台消息创建时间计算到 Gateway 接收入口，Gateway 处理从接收入口计算到确认回复进入渠道发送队列。它们用于区分平台
投递/轮询与本机处理，不包含回复进入平台后最终送达客户端的时间；平台时间缺失或时钟倒退时省略
无法可靠计算的字段。接收延迟依赖平台与 Gateway 主机时钟同步；主机未启用 NTP 时，该值可能
包含系统时钟偏差，不能单独作为渠道投递性能结论。调试模式可通过
`codexc config` 的“系统设置 → 调试模式”控制，关闭时不展示这两个技术字段。
收集、收齐、提交、识别和完成消息使用统一的“标题 + 字段列表”结构，由飞书渲染为 Markdown、
Telegram 转成兼容 HTML、微信转成富文本。收齐时先显示“正在自动提交”；外部请求发起后立即显示
“正在识别”。请求超过 10 秒时发送首次识别心跳，之后每 20 秒报告一次已等待时间。完成消息显示
实际发给 Responses API 的视觉模型 ID；Gateway 实测的 API 往返耗时仅在调试模式开启时显示。上游响应提供标准
`usage.input_tokens`、`usage.output_tokens` 或 `usage.total_tokens` 时以 `**Token**：总计` 列表块显示 Token 用量，
缺失字段不估算。同一份脱敏请求指标会写入独立模型指标库；已有 Thread 时关联该 Thread，视觉调用
发生在 Codex Turn 创建之前，因此不伪造 `turn_id`。组合根按响应中的实际模型解析当次价格快照，
`/metrics` 只据此显示 API 参考费用，不把它冒充第三方中转的实际账单。
完成消息和 `/metrics` 同时显示所选第三方 API 提供商名称；`/metrics` 会把最近一次视觉调用单独列为“直接 API”，
不混入最近 Turn 的模型请求累计。

外部视觉识别失败后，可以在五分钟内发送 `/vision retry`，复用当前渠道、Conversation 和 Actor
最近一次失败任务的原要求与临时图片，不需要重新上传。重试开始时即消费该记录；如果上游再次失败，
会重新保留为最近一次失败任务。识别成功、发送新的图片任务、`/vision cancel`、五分钟过期、
Gateway 重启或 Surface 停止都会清除旧记录。重试记录只保存在有界内存中，不复制图片，不能跨
Actor、Conversation 或渠道使用。

适配器优先采用响应体 `model` 作为实际识别模型，缺失或格式不安全时才回退请求配置值；响应体
存在 `status` 时必须为 `completed`，避免把不完整输出交给当前模型。`created_at`、`completed_at`、
`service_tier`、缓存命中/写入 Token 和推理输出 Token 会经过类型与范围裁剪；基础 Token 进入当前
请求的完成事件，提供商 ID、实际模型、状态、HTTP 状态、耗时、上游时间戳及可用 Usage 进入独立
指标库。缓存写入 Token 暂不属于指标库 Schema，完整识别结果仍不持久化。
`/vision cancel` 会丢弃尚未提交的收集。旧的 `/vision begin <要求>` 与 `/vision done` 继续兼容，
用于无法预先确定图片数量的场景。手动收集同样按 Actor 与 Conversation 隔离，仅保存在
内存中，五分钟无新图片即过期，Gateway 重启或 Surface 停止时直接丢弃。Telegram 原生相册和
飞书同一富文本多图仍可直接作为平台批次一次提交，不需要手动收集。

## 配置

运行 `codexc setup`，先选择“模型与提供商 → 第三方 API”添加一个或多个 Responses 兼容中转，
分别填写提供商 ID、显示名称、精确接口地址和 API Key；再选择“图片识别 → 外部视觉 API”，
从已登记的提供商中选择一个并填写视觉模型 ID。重复设置图片识别即可显式切换提供商。
第三方 API 注册表不接入 Codex App Server，不会出现在 `/model`，也不改变 DeepSeek 配置。

```toml
[[api_providers]]
id = "vision-relay"
name = "视觉中转"
protocol = "responses"
endpoint = "https://vision.example/v1/responses"

[vision]
mode = "responses_api"
provider = "vision-relay"
model = "视觉模型"
```

`endpoint` 必须是 HTTPS，只有本机回环地址允许 HTTP。接口必须接受 Responses 风格的
`input_image` Data URL 和严格 JSON Schema 输出，且不能把凭据放在 URL Query。每个提供商的
API Key 单独保存到 `credentials/api-providers/<ID>/api-key`，不写入 Gateway 配置、数据库或日志。
禁用图片识别不会删除共享提供商或其 Key；删除提供商前必须先让所有调用方解除引用。旧版单视觉
地址和 `credentials/vision/` Key 只会在“第三方 API → 添加或更新”中经确认显式转换，转换成功后
清理旧 Key。修改后需要重启 Gateway，不需要重启 App Server。

## 安全与失败边界

- 三渠道继续沿用最多四张、单张 10 MiB、整批 20 MiB、PNG/JPEG 签名和私有临时文件限制。
- 图片、提示词、API Key、上游响应正文、响应 ID 和识别结果不写入 SQLite 或结构化日志。
- 识别进度只发送到发起请求的 Conversation；心跳只保存在当前请求计时器中，完成、失败或进程
  停止时取消。指标库只接收脱敏的提供商 ID、模型、思考等级、状态、HTTP 状态、耗时、上游时间戳、
  Token 和当次价格快照；视觉请求继承当前 Thread 的思考等级并在支持时透传
  `reasoning.effort`，没有 Thread 关联或未设置时记为空；
  已有 Thread 时保存 `thread_id`，视觉调用先于 Codex Turn，因此 `turn_id` 为 `NULL`。
- 识别耗时是 Gateway 从发起 HTTP 请求到读取并解析响应的本地观测值，不冒充上游内部处理时长；
  上游时间戳差值仅作为内部观测。Token 用量只裁剪响应体中非负安全整数，不根据图片大小或文本
  长度推算。
- `/vision` 待处理要求、手动多图收集和最近一次失败的重试记录不写入 SQLite、配置或日志，不跨
  Actor、Conversation 或 Gateway 重启恢复。
- 各提供商 API Key 的目录和文件分别限制为 `0700`、`0600`，符号链接、错误所有者或开放权限
  失败关闭；禁用识图不删除可能被其他 API 功能复用的提供商 Key。
- 图片中的文字和指令始终标为不可信资料，不能升级为系统或开发者指令。
- 识别结果明确标记为已经完成的视觉观察，原 Thread 不应搜索工作区或无条件要求用户重新上传；
  默认不调用网页搜索、命令或其他工具；只有原始问题明确要求搜索、核实或调用工具时才执行，
  只有识别结果中的不确定项确实影响结论时才请求补图。
- 原始用户提示作为提取重点直接交给视觉模型，不由另一个模型规划、替代或改写；视觉模型不得
  执行其中的分析、核实、搜索或操作要求。
- 外部响应最大 1 MiB，识别等待有明确超时；错误不会把上游正文发送给渠道。
- 超时覆盖建立连接、等待响应头和读取完整响应正文；同一 Gateway 最多同时执行两个外部识图
  请求，超出后直接提示繁忙，不建立无界等待队列。
- 视觉请求超时默认为 120 秒，可通过 `[vision] timeout_seconds` 在 30–600 秒范围内调整；
  超时和失败会在日志中记录 `errorType`、`httpStatus` 与受控说明，渠道只显示稳定重试文案。
- `mode = "disabled"` 是默认值；此时不支持图片的模型继续在创建 Turn 前明确拒绝。
