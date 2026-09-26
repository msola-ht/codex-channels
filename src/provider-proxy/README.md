# Provider Proxy

本目录提供模型 Provider 的本地回环转发代理及私有指标通道。模型数据通路由 App Server 服务
持有，Gateway 只接收可丢失的脱敏请求指标，因此 Gateway 停止或重启不会中断模型请求。

## 文件

- `proxy.ts`：HTTP/SSE 与 WebSocket 转发、背压和连接生命周期协调。监听自动分配的回环地址，把精确
  `/responses` 与只读 `/models` 路径转发到上游；官方 OpenAI
  主代理提供只读 `GET /_codexc/image-upload-route`，通过正在运行的路由解析器核验默认
  ChatGPT 图片引用后端，不转发上游、不读取凭据、不生成模型指标；独立后端返回不支持。
  主代理还按当前锁定 Codex 0.156.1 的固定端点清单接受 POST `/alpha/search`、
  `/memories/trace_summarize`、`/images/generations`、`/images/edits`、
  `/realtime/calls`、`/live`，以及透明转发 `/v1/realtime`、`/v1/live` 和单段受限
  Call ID 的 `/v1/live/<call-id>` WebSocket。这些额外端点不解析为 Responses 指标；DeepSeek、
  OpenCode Go、CCG 与自定义第三方代理不启用该组 OpenAI 路径。代理保留端到端状态码与响应头；
  Authorization 只用于上游请求，不落日志、不进指标，
  `x-codex-turn-metadata` 只在本地读取、原样转发，Hop-by-hop Header 不透传；
  转发 SSE 或 WebSocket 响应时，在首字观测完成前解析合法事件类型，记录单请求单调时钟延迟；
  HTTP 使用 semantic 事件口径，WebSocket 使用 delta 与指定 done 事件口径，不要求文本非空。
  此后普通增量只扫描事件类型并立即透传，不等待指标处理；创建、上游 timing、完成、失败、不完整、额度和包装错误事件解析受控字段。WebSocket 从
  出站 `response.create` 提前记录有界的模型、服务层级与 `reasoning.effort`，完成事件再刷新最终
  模型、服务层级、状态及输入/缓存/输出/推理 Token Usage，因此提前断线的失败
  指标仍可归入请求模型；HTTP
  状态、超时、上游错误、完成事件前的客户端断开和 WebSocket 提前关闭同样产生受控失败指标，
  不保留错误正文；HTTP/SSE 已收到完成事件后的正常收尾断开不重复改写为失败或输出误报警；
  WebSocket 上游握手失败（如 429）也会生成 failed 指标并保留 HTTP 状态；即使尚未收到出站
  元数据，也会降级记录为空 Thread 的失败，避免这类错误完全不可见；
  后端在 WS 内返回的包装 error 事件（`status` + `error.type`）与关闭原因（usage limit /
  rate limit）同样归类为失败指标，用量上限这类错误不再落成笼统的断开记录；
  上游缺少 `Content-Type` 时只对合法 `response.*` SSE 事件进行正文识别，以恢复完成事件、模型和
  Usage；HTTP 2xx 仍未观察到这些信息时标为 `incomplete/response_not_observed`，不能污染成功请求汇总
  或成功率。通过普通 HTTP/WebSocket `/responses` 发送、由私有元数据
  `request_kind=compaction` 标记的 remote compaction v2 归为
  压缩操作；压缩操作以自身成功状态为准，不要求模型 Usage，但观测到的 Token 和额度快照
  与普通模型请求一样进入 `/metrics` 汇总、异常报告和会话指标。当前锁定 Codex 0.156.1 的 WebSocket 首轮
  `request_kind=prewarm` 使用 `generate=false` 建立并复用连接，不是模型推理请求；代理照常透明
  转发其私有元数据，但不把其完成事件、Usage 或耗时写入模型请求指标。
  OpenAI HTTP/SSE 只从明确的 `x-codex-primary/secondary-*` 白名单响应头提取 10,080 分钟周窗口，
  Responses WebSocket 只从 `codex.rate_limits` 事件提取同一窗口；百分比转换为定点整数并随当前
  请求指标投递，不保存完整 Header、事件正文或其他额度桶。
  普通增量不经过指标确认链；终态指标仍在对应完成事件转发前完成投递确认。从
  `x-codex-turn-metadata` 提取 `thread_id` / `turn_id` 用于按 Turn 关联，并只识别精确的
  `request_kind=compaction` 操作标记和不计指标的 `request_kind=prewarm`；其他值保持普通响应语义。
  SSE 单行使用 1,048,576 字符上限，非流式 JSON Responses 使用 1 MiB 临时上限解析相同元数据，
  正文和响应 ID 不进入指标；HTTP 请求正文不截取 `reasoning.effort`，普通 Thread 由组合层按
  Thread 设置回退；原生子代理复用父线程 Provider 线路，不设角色专用路径或配置值注入；
  超限或畸形响应只保留基础 HTTP 状态与错误分类。上游模型、服务层级及错误标识符只接受受限字符，
  不能把控制字符带入指标展示。WebSocket 在完成事件投递前先解除活动指标引用，
  避免紧随其后的关闭事件重复写入。
  外部额度窗口通过按账户缓存的后台刷新读取；请求完成只使用当时已有的快照，不等待额度接口；
  代理关闭时取消在途刷新并执行有上限的等待。
  其他路径、OpenAI 额外端点的非 POST 请求以及非 GET 的 `/models` 返回 404；监听地址强制为回环，
  上游空闲超时默认 60 秒并处理双向流式背压；客户端提前断开时取消上游请求。服务入口按统一
  `network.proxy` 选择传入上游 Agent。OpenCode Go、DeepSeek 与 CCG 的共享代理额外接受
  `/go/<账户>/responses|compact|models` 前缀：按前缀区分账户、转发时剥离前缀，并让 `onMetrics`
  携带账户标识供服务侧按具体账户 Provider Socket 上报。
- `websocket-backpressure.ts`：双向统计应用层待转发与 SDK 尚未确认发送的帧，1 MiB 或 64 帧开始暂停读取，
  回落到 256 KiB 且 16 帧以内恢复；握手和终态指标确认期间暂停相应方向。
  已从同一网络读取中解码的剩余帧仍受每方向 128 MiB / 4096 帧硬上限约束；超限或超过上游超时期限无发送进展时结束连接并报告错误。
  上游正常关闭前先排空已接受的终态和后续帧；客户端断开会取消确认等待并释放积压。
- `response-metrics-observer.ts`：从 HTTP Header、SSE/JSON 终态与 WebSocket 完成或关闭信息中
  归约单次请求指标和额度元数据；只接收受控输入并更新内存指标状态，不执行网络转发、持久化或
  平台输出。WebSocket 解析 `response.created` 与上游 timing 事件，在 `logical_turn` 且响应 ID
  同时匹配创建与终态时提供可选 `upstreamTtftMs`，不保留响应 ID 到指标记录。
  `firstContentMs` 与 `totalDurationMs` 共用提交上游请求时的单调时钟起点：HTTP 在调用上游 request 前启动（包含随后建连），WS 在连接就绪、调用 send 前启动。
  两者都排除路由解析、转储和发送前准备，WS 还排除等待连接就绪的时间。首内容计到首个符合条件事件的接收回调入口；
  总耗时到首次模型终态或结束/失败时冻结，经 IPC 传递且不依赖调用记录开关。未提交发送的路由或握手失败不提供两项耗时；
  不包含终态后投递、客户端显示或其他重试，与上游轮次 TTFT 独立。
  HTTP 排除 created/in_progress/failed/metadata，其余合法 response.* 语义事件计入；WS 计入 response.*.delta、output_text.done 与 function_call_arguments.done。
  纯错误、旁路额度/timing/metadata 与畸形报文不计入；完整展示口径见[WebUI 文档](../../docs/webui.md)。
  HTTP 有界扫描请求模型，WebSocket 读取出站模型，终态模型另存为 `responseModel`，不以请求模型补齐响应回显。
  两种传输同时采集出站 `service_tier` 为 `requestServiceTier`，不受响应层级覆盖，缺失为空；沿用指标 IPC 入库且不依赖调用转储。
  首内容观测后普通增量只扫描事件类型，需要指标正文的事件才解析 JSON；错误消息、标识符和
  `User-Agent` 继续执行既有限长与字符约束。
- `traffic-call-timing.ts`：记录单次调用的单调时钟偏移，区分入口、转发、请求体收齐、响应头、WS 提交发送与结束；只写调用响应索引，不进入指标 IPC 或数据库；诊断节点仍以代理入口为零点，首内容与终态按发送偏移还原，发送前分段不参与速率计算。
- `request-routing.ts`：集中维护回环监听地址校验、账户前缀解析、受支持路径白名单、上游路径拼接
  以及 HTTP/WebSocket 请求头过滤；不持有连接或指标状态。
  其中 `forwardedRequestHeaders` / `forwardedWebSocketHeaders` 在配置了
  `[codex].upstream_user_agent` 时覆盖出站 `User-Agent`，缺省则原样透传 App Server 生成的 UA；
  不注入也不删除任何私有请求头，`x-responsesapi-include-timing-metrics` 只在客户端自己带上时透传；
  不影响私有元数据；该请求实际发往上游的 UA 由响应指标观察器写入指标记录，供 WebUI 请求明细读取。
- `metrics-channel.ts`：App Server 服务把单条有界指标写入 Gateway 拥有的当前用户私有 IPC；Unix 使用
  `0600` Socket，Windows 使用共享运行时提供的认证命名管道。接收端归约后返回确认，保证短回复的
  Turn 完成事件不会抢先清理请求统计状态；Gateway 不在线时指标直接丢弃并继续模型响应。
  指标发送采用绝对 1 秒确认预算，接收端持续返回不完整帧也不会延长等待；连接关闭立即结束确认等待。
  接收端拒绝不安全、无认证或已被活动进程占用的端点，并只清理自己创建的端点；指标按换行完成单帧并在归约后
  确认，不依赖 Windows named pipe 不具备的半关闭时序。
- `traffic-dump.ts`：仅在 `[debug].model_traffic_dump` 开启时使用的模型报文旁路转储入口与 HTTP/WebSocket
  逻辑调用归约；`traffic-dump-storage.ts` 管理 V2 session、顺序写入和文件轮转，
  `traffic-dump-retention.ts` 管理历史批次保留，`traffic-dump-content.ts` 负责正文分片、终态解析、裁剪与凭据头脱敏。V2 为每个 writer
  session 建立私有目录：`interactions.jsonl` 只记录每次逻辑模型调用的请求与终态响应索引，正文按
  offset/bytes 引用轮转的 `payload-*.bin`，逐块 HTTP/SSE 与 WebSocket 传输记录写入独立
  `trace-*.jsonl`。HTTP 请求对应一次调用；同一 WebSocket 连接中的每个 `response.create` 分别对应
  一次调用。响应索引复用代理同一份 `firstContentMs` 观测，精简模式也保留，不从 trace 反推。
  指标中的 `traffic` 使用转储实际创建的标签、writer session（包含目录冲突时的编号后缀）与 interaction，
  HTTP 和每次 WebSocket 调用分别绑定；未开启转储或 WS 握手失败、尚未创建逻辑调用时不提供关联。
  每个逻辑调用绑定开始时的 writer session；长驻进程约每 24 小时让新调用进入新 session，
  已在执行的并发调用继续在原 session 完成，因此请求与响应不会拆分。写队列先落正文再落索引，不改变
  转发、背压和指标采集；App Server 启动及新 session 建立时按 session
  最后活动时间与 `[debug].model_traffic_retention_days` 清理过期 V2 历史 session，`0` 关闭按时间清理。
  历史完整 session 仍按 Provider 约保留 320 MiB；当前写入中的 session 不会被拆除，未知目录和旧版文件不会被自动删除；
  Authorization、Cookie 等凭据字段只保留认证
  方案。精简模式继续裁剪 `input` 与过大条目，并从 trace 丢弃 `.delta`；逻辑响应始终只保存
  `response.completed|failed|incomplete|error` 终态。写入失败时停止转储并经 `onError` 上报，模型请求继续正常转发。
- `index.ts`：公开代理、指标通道和稳定的脱敏单请求指标类型。

模块只依赖 Node 内置 HTTP/HTTPS 与共享私有 IPC 能力，不接触平台 SDK、数据库或协议生成类型；
`bin/codexc.mjs` 把代理装配到 App Server 服务生命周期，`bootstrap` 只把收到的指标组合到
`observability` 独立指标库和 `conversation-core` 的稳定请求统计输入事件。
App Server 服务立即为主 Provider 创建独立代理，并在可选切换 Provider 首次使用时按需创建对应
代理；OpenCode Go、DeepSeek 与 CCG 各自的全部账户共享各自一个代理（内存 HTTP Server，不随账户增长），账户隔离 App
Server 的 `base_url` 带 `/go/<账户>` 前缀。不暴露手工监听配置。
服务通过共享运行时的私有监管 Socket 独占完整 App Server 拓扑；前台只能复用监管身份和
Provider 拓扑匹配且已完成 WebSocket 握手的实例。Gateway 另以配置级所有权 Socket 全局互斥，
不把 Provider 指标 Socket 当作进程锁；裸实例与重复 Gateway 均失败关闭。
OpenAI 保留用户配置的 `openai_base_url`；没有显式上游时，按官方认证请求 Header 选择 ChatGPT
或 API 上游。主代理启动失败时 App Server 服务失败关闭；按需 Provider 代理启动失败时本次选择
明确失败。两者都不会绕过统计代理静默直连上游。运行中动态上游路由解析失败时，HTTP 请求及
WebSocket 升级返回 502 并报告内部错误，不退出监管进程；后续请求可以重新解析已修正的代理。
Responses/压缩路由解析失败也记录 `provider_proxy_route_error` 指标：HTTP 保留请求头中的 Thread/Turn 与账户归属，
WebSocket 升级失败按握手失败记录，不推断尚未收到的模型调用元数据。转储记录 `upstream_route` 错误；
HTTP 生成失败交互索引，WebSocket 仅保留握手 trace，不伪造 `response.create`。`/models` 和其他非 Responses 端点不计模型请求。
`resolveUpstream` 支持异步解析；等待期间保留 HTTP 请求体，关闭代理会清理待升级连接，
客户端已断开或代理已关闭时不再建立上游连接。

## Chat 上游

`chat-diagnostics.ts` 白名单提取有界的上游模型、标识、路由、费用与用量明细，经请求级进程内回调在终态交付前提交给代理，写入独立 `chat_diagnostics` trace 事件；随机关联编号随本地 HTTP 传递，观察器随请求关闭清理；不进入 App Server 输出或指标。转储同时把同一次调用诊断里的 `routing.finalProvider` 作为可选 `upstreamProvider` 写入 V2 响应索引，供调用列表与请求明细列表在模型名旁展示上游标签；没有诊断或字段缺失时不写入，也不推断。

`chat-errors.ts` 按 Cline 官方错误合同归类 HTTP 与流内错误，限制错误正文读取大小，仅返回固定文案和白名单错误码，不自动重试。

`chat-bridge.ts` 管理 Chat HTTP 连接、SSE 分帧、背压、取消和有限超时，通过 `model-api/index.ts` 调用纯转换模块。转换覆盖 Responses 的 `function`、`namespace`、自由格式 `custom` 工具与执行位置为 `client` 的 `tool_search`（含其结果带回的工具声明）；托管工具与执行位置为服务端的 `tool_search` 在 Chat 协议下没有等价形态，按失败关闭拒绝。
Runtime 在统计代理后装配本地 Chat 桥，两者共同归属 App Server 服务生命周期；转换后的 Responses 事件复用现有指标采集。
