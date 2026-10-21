# Provider Proxy

本目录提供模型 Provider 的本地回环转发代理及私有指标通道。模型数据通路由 App Server 服务
持有，Gateway 只接收可丢失的脱敏请求指标，因此 Gateway 停止或重启不会中断模型请求。

## 文件

- `cline-web-search.ts`：受管 CLP 桥的同源独立搜索 HTTP 执行器，复用账户认证和代理 Agent，45 秒总期限、256 KiB 正文及 50 条结果边界，返回校验后的标题和 URL；取消关闭连接，无自动重试，错误仅输出固定 `clp_search_*` 分类。

受管 CLP 的 live 搜索由 `chat-bridge.ts` 在同一请求内执行普通函数→独立搜索→模型续答。搜索最多 4 次、显式输出预算逐轮扣减；每次续模型前复核目录，原始响应 ID、事件序号与输出索引连续，用量按已知各轮累计。多轮调用不发布将搜索等待计入解码时间的生成速率。混合搜索与客户端调用先整体校验，执行搜索并把尚未派发的客户端调用作为明确的 `not_executed` 结果内部续传，模型看过搜索结果后重新发起纯客户端调用；桥不执行客户端操作。诊断仅累计延期调用数量及固定 `serialized` 分类，不保存调用参数。cached/indexed/未知控制不降级为 live。通用 Chat、原生搜索诊断与 Relay 不启用此适配。

- `aggregate-proxy.ts`：单 App Server 的无状态 HTTP 聚合模型出口；以精确 `provider/model` slug
  选择主进程授权快照中的已启动本地 ProviderProxy（可带 `/go/<账户>`），出站改为真实模型和账户认证，
  Provider 前缀后的模型 ID 按源目录契约作为不透明 JSON 字段保留，不按 URL 路径解释。
  保留 Codex Thread/Turn 指标关联头。只监听 `127.0.0.1` 随机端口并接受认证的 POST `/responses`，
  拒绝 WebSocket、压缩正文和远端响应状态引用；正文限制 48 MiB，强制 `store=false`。
  不读取账户或目录文件，不直接访问真实上游，不重试或回退；发送前调用可选 `assertCurrent(signal)`
  复核快照，支持可取消的异步复核，变更返回 409 并提示等待安全应用或在 Gateway 未运行时重启。上传预算独立为 30 秒；
  快照复核预算独立为 15 秒；完成复核后由真实出站层负责首响应头等待，Codex 负责可见完整 Responses 事件的空闲等待。
  聚合不重复设置模型首响应头、socket 空闲或生成总期限；只有实际写入下游受阻时启动 30 秒交付预算，结束交付最多 5 秒。
  持续正常输出可超过 600 秒；客户端取消、服务关闭或交付停滞会取消内层请求。
  异步快照复核不是文件状态与网络提交的原子操作；完成后复核取消状态才提交本地请求。
  原样交付状态码和 JSON/SSE 正文，过滤跳级头和响应凭据头，取消、断流及关闭清理连接。
- `proxy.ts`：HTTP/SSE 与 WebSocket 转发、背压和连接生命周期协调。监听自动分配的回环地址，把精确
  `/responses` 与只读 `/models` 路径转发到上游；官方 OpenAI
  主代理提供只读 `GET /_codexc/image-upload-route`，通过正在运行的路由解析器核验默认
  ChatGPT 图片引用后端，不转发上游、不读取凭据、不生成模型指标；独立后端返回不支持。
  受管 DeepSeek 原生 Responses 代理的同一路由描述入口和 `POST /_codexc/image-upload`
  均要求 Runtime 确认的随机运行实例 Bearer 能力；HTTP 不授予能力，配置修订不能代替授权。
  POST 只接受 10 MiB 内 PNG/JPEG/WebP/GIF 原始字节、精确 Provider 修订和严格媒体签名，
  由 Runtime 材料回调复核运行设置快照、代次和私有凭据，再上传到官方 `/files`，只返回校验后的
  `file-api-...` 编号；不暴露 Key、上游错误或文件列表，最多四项并行，断线与关闭取消。
  本地上传整次预算为 30 秒，包含收图、材料复核及上游传输；上游 Files POST 自身上限为 60 秒，
  单次请求不自动重试。实例释放或重启撤销能力，上传失败不回退内联输入。
  主代理还按当前锁定 Codex 0.163.0 的固定端点清单接受 POST `/alpha/search`、
  `/memories/trace_summarize`、`/images/generations`、`/images/edits`、
  `/realtime/calls`、`/live`，以及透明转发 `/v1/realtime`、`/v1/live` 和单段受限
  Call ID 的 `/v1/live/<call-id>` WebSocket。这些额外端点不解析为 Responses 指标；DeepSeek、
  OpenCode Go、CCG 与自定义第三方代理不启用该组 OpenAI 路径。代理保留端到端状态码与响应头；
  CP 出站请求通过 `readModelCapabilities` 在同次目录复核中取得启用状态与默认采样，HTTP 和 WebSocket `response.create`
  只补齐请求中缺失的六种采样字段，显式零值或 null 保留；转储与指标仍观察客户端原始报文。
  Authorization 只用于上游请求，不落日志、不进指标，
  `x-codex-turn-metadata` 只在本地读取、原样转发，Hop-by-hop Header 不透传；
  转发 SSE 或 WebSocket 响应时，从提交发送起计响应时间、首内容与总耗时，并持续观察生成区间；两种传输共用非空内容白名单，
  首内容白名单包含思考、正文、拒绝文本和工具参数，不计空事件与状态事件；响应时间则可由上游状态或额度事件触发。
  普通增量持续提取有界计时元数据，不保存内容、不等待指标投递；创建、上游 timing、完成、失败、不完整、额度和包装错误事件解析受控字段。WebSocket 从
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
  与普通模型请求一样进入 `/metrics` 汇总、异常报告和会话指标。当前锁定 Codex 0.163.0 的 WebSocket 首轮
  `request_kind=prewarm` 使用 `generate=false` 建立并复用连接，不是模型推理请求；代理照常透明
  转发其私有元数据，但不把其完成事件、Usage 或耗时写入模型请求指标。
  OpenAI HTTP/SSE 只从明确的 `x-codex-primary/secondary-*` 白名单响应头提取 10,080 分钟周窗口，
  Responses WebSocket 只从 `codex.rate_limits` 事件提取同一窗口；百分比转换为定点整数并随当前
  请求指标投递；`quotaObservedAtMs` 保存响应头或有效额度事件到达的本地时刻，后续终态或失败
  不刷新该时间，无效事件不覆盖已有快照；缺失快照或历史未采集时为 null，不从请求时间推断。
  不保存完整 Header、事件正文或其他额度桶。
  普通增量不经过指标确认链；终态指标在对应完成事件转发前等待确认，最多 1 秒后退让并继续交付，为外层 5 秒收尾预算留出余量。指标 IPC 使用同一绝对期限，不因零碎确认字节续期。
  上游收到 WebSocket 关闭后，先交付已排队的终态再关闭客户端；收尾使用独立 5 秒预算，
  超时记录错误并释放连接，客户端断开或代理停止立即取消等待。
  从 `x-codex-turn-metadata` 提取 `thread_id` / `turn_id` 用于按 Turn 关联，并识别精确的
  `request_kind=compaction` 操作标记和不计指标的 `request_kind=prewarm`。
  官方 `thread_source=guardian_review` 的自动审查请求以完整、受限的 `parent_thread_id` / `parent_turn_id`
  归入触发任务，每次请求及用量仍只采集一次；缺任一父身份时保留无 Thread/Turn 的全局指标，不能创建独立用户会话。
  不以 reviewer 名称或普通子代理标签判断，不改出站元数据；与转储读取共用 Runtime 的纯元数据投影。
  IPC 的 `requestPurpose=autoApprovalReview` 与原始 `reviewerThreadId` / `reviewerTurnId` 进入指标库，
  缺失保持未知；审查请求仍不得更新用户轮次执行状态或继承父 Thread 的思考等级。其他来源保持原 Thread/Turn 归属。
  SSE 单行使用 1,048,576 字符上限，非流式 JSON Responses 使用 1 MiB 临时上限解析相同元数据，
  正文和响应 ID 不进入指标；HTTP 请求通过有界流式字段扫描采集实际 `reasoning.effort`，不缓存完整正文，
  不依赖转储。请求未提供有效值时，普通 Thread 由组合层按 Thread 设置回退；自动审查保持未知，
  不继承父任务等级，也不回填历史空值。原生子代理复用父线程 Provider 线路，不设角色专用路径或配置值注入；
  超限或畸形响应只保留基础 HTTP 状态与错误分类。上游模型、服务层级及错误标识符只接受受限字符，
  不能把控制字符带入指标展示。WebSocket 在完成事件投递前先解除活动指标引用，
  避免紧随其后的关闭事件重复写入。
  外部额度窗口通过按账户缓存的后台刷新读取；请求完成只使用当时已有的快照，不等待额度接口；
  采集端以 `{ windows, observedAtMs }` 返回实际成功采样时刻，代理原样保存，复用缓存不刷新观测时间；
  代理关闭时取消在途刷新并执行有上限的等待；关闭中拒绝重新启动，并发关闭共享在途任务，只有监听、刷新和转储资源全部确认后才记为完成。刷新等待超时报错并保留关闭状态，后续关闭可在实际刷新结算后重试，不重复关闭已确认的监听。生产 OpenAI 周额度与 OpenCode Go 外部窗口线路互斥；
  若两类独立来源快照同时存在，保留快照但观测时刻为 null，避免把一个来源的时间赋给另一来源。
  其他路径、OpenAI 额外端点的非 POST 请求以及非 GET 的 `/models` 返回 404；监听地址强制为回环，
  真实 HTTP 出站首响应头等待最多 300 秒，错误正文最多 5 秒，非流式正文最多 300 秒；Responses SSE/WS 的模型空闲由 Codex 消费完整事件控制，不以任意 socket 字节续期。Chat 桥外层不重复启动桥已负责的首响应头或正文预算。准备阶段最多 30 秒，WS 建连最多 15 秒；双向交付受阻最多 30 秒，终态交付和关闭收尾最多 5 秒。客户端提前断开时取消上游请求。上游在请求正文接收完整前返回 HTTP 错误时，停止转发上传正文，完整发送错误响应后关闭本跳连接；主动清理不重复上报失败指标。服务入口按统一
  共享代理解析结果选择传入上游 Agent（Codex `.env` 优先，不读取旧 TOML `[network]`）。OpenCode Go、DeepSeek 与 CCG 的共享代理额外接受
  `/go/<账户>/responses` 与 `/go/<账户>/models` 前缀：按前缀区分账户、转发时剥离前缀，并让 `onMetrics`
  携带账户标识供服务侧按具体账户 Provider Socket 上报。
- `proxy-delivery.ts`：HTTP/WS 写入、背压与关闭等待的有界交付；HTTP chunk 共用 string/Buffer 写入原语，write 返回背压后开始 drain 等待预算，保留调用方外层总预算。取消、断连和错误结束当前等待，模型等待与下游交付停滞分别计时。
- `response-metrics-observer.ts`：从 HTTP Header、SSE/JSON 终态与 WebSocket 完成或关闭信息中
  归约单次请求指标和额度元数据；只接收受控输入并更新内存指标状态，不执行网络转发、持久化或
  平台输出。WebSocket 解析 `response.created` 与上游 timing 事件，在 `logical_turn` 且响应 ID
  同时匹配创建与终态时提供可选 `upstreamTtftMs`，不保留响应 ID 到指标记录。
  `responseTimeMs`、`firstTokenMs` 与 `totalDurationMs` 从提交上游发送时刻计时，不含发送前路由、解析与 WS 连接等待；HTTP 提交后发生的连接等待计入耗时；Chat 桥以真实上游提交起点替换本地转发起点。
  `responseTimeMs` 到首个有效上游事件，`firstTokenMs` 到首段非空内容的接收回调入口，`totalDurationMs` 到首次终态或结束/失败。未提交发送不伪造耗时。
  指标通过 `timingBasis: "submitted"` 标记新起点，IPC 拒绝无标记的旧计时；指标独立于调用记录传递；调用索引复用同一观测，不从 trace 反推，不表示客户端显示时间。
  HTTP 有界扫描请求模型，WebSocket 读取出站模型，终态模型另存为 `responseModel`，不以请求模型补齐响应回显。
  HTTP JSON/SSE 与 WebSocket 共用终态提取 `usage_metadata.amount`，以可空 `responseUsageAmount`
  传递有界非负十进制字符串；保留精度和零值，缺失或畸形值为 null，不采集任意 metadata、换算单位或推断费用。
  两种传输同时采集出站 `service_tier` 为 `requestServiceTier`，不受响应层级覆盖，缺失为空；沿用指标 IPC 入库且不依赖调用转储。
  生成计时持续观察有界 Responses 事件；错误消息、标识符和
  `User-Agent` 继续执行既有限长与字符约束。
- `traffic-call-timing.ts`：记录单次调用从提交发送起的单调时钟耗时；只写调用响应索引，不进入指标 IPC 或数据库。
- `request-routing.ts`：集中维护回环监听地址校验、账户前缀解析、受支持路径白名单、上游路径拼接
  以及 HTTP/WebSocket 请求头过滤；不持有连接或指标状态。
  其中 `forwardedRequestHeaders` / `forwardedWebSocketHeaders` 在配置了
  `[codex].upstream_user_agent` 时使用服务启动时解析的生效值覆盖出站 `User-Agent`（仅 `follow_cli_version = true` 时更新官方格式中的 Codex 版本），缺省则原样透传 App Server 生成的 UA；
  不注入也不删除任何私有请求头，`x-responsesapi-include-timing-metrics` 只在客户端自己带上时透传；
  不影响私有元数据；该请求实际发往上游的 UA 由响应指标观察器写入指标记录，供 WebUI 请求明细读取。
- `metrics-channel.ts`：App Server 服务把单条有界指标写入 Gateway 拥有的当前用户私有 IPC；Unix 使用
  `0600` Socket，Windows 使用认证命名管道；接收端统一复用共享运行时管理监听与端点清理，
  启动时保护父目录权限，拒绝宽权限旧 Socket，删除旧端点前复核文件身份；启动失败清理后可在同一实例重试，
  显式关闭后不再接受启动。接收端校验、入队并完成实时归约后返回 `ok` 确认，仅表示已受理、不表示已落库；
  无效指标或入队拒绝返回 `rejected`。入队失败仍归约普通请求的实时计时，供完成卡降级使用；自动审查请求不归约到用户轮次。
  该确认顺序保证短回复的 Turn 完成事件不会抢先清理请求统计状态；Gateway 不在线时指标丢弃并继续模型响应。接收端拒绝
  不安全、无认证或已被活动进程占用的端点；Unix 公开端点由共享运行时独占发布并按 inode 清理，
  关闭旧监听不会按原公开路径自动删除已替换的文件或新监听端点。指标按换行完成单帧，发送端只把完整合法的 `ok` 帧视为受理；
  拒绝、未知或不完整确认、断连和超时返回受控错误，经代理既有错误回调记录后继续模型响应，不重试；未确认不证明指标一定丢失。
  不依赖 Windows named pipe 不具备的半关闭时序。发送异步读取并核验当前 Windows descriptor，
  descriptor/ACL、连接、认证、单帧发送和确认共用 1 秒预算；接收端最多持有 8 个连接，
  每连接也受 1 秒预算约束，认证前连接同样计入上限。只接受当前指标结构，必需的可空字段必须显式传入；缺字段的旧记录直接拒绝。
  解码仅投影已校验的请求字段和额度子字段；Provider、流量来源与入库时间不由此 IPC 声明，组合层按接收端确定 Provider。
- `traffic-dump.ts`：仅在 `[debug].model_traffic_dump` 开启时使用的模型报文旁路转储入口与 HTTP/WebSocket
  逻辑调用归约；`traffic-dump-storage.ts` 管理 V2 session、顺序写入和文件轮转，
  `traffic-dump-retention.ts` 管理历史批次保留，`traffic-dump-content.ts` 负责正文分片、终态解析、裁剪与凭据头脱敏。V2 为每个 writer
  session 建立私有目录：`interactions.jsonl` 只记录每次逻辑模型调用的请求与终态响应索引，正文按
  offset/bytes 引用轮转的 `payload-*.bin`，逐块 HTTP/SSE 与 WebSocket 传输记录写入独立
  `trace-*.jsonl`。HTTP 请求对应一次调用；同一 WebSocket 连接中的每个 `response.create` 分别对应
  一次调用。响应索引复用代理同一份 `firstTokenMs` 观测，精简模式也保留，不从 trace 反推。
  指标中的 `traffic` 使用同步分配的标签、writer session（时间戳加 128 位随机标识的十进制后缀）与 interaction；
  manifest、目录和指标共享同一身份，目录或文件冲突时停止采集，不覆盖已有文件或改绑已发出的引用。
  HTTP 和每次 WebSocket 调用分别绑定；未开启转储或 WS 握手失败、尚未创建逻辑调用时不提供关联。
  每个逻辑调用绑定开始时的 writer session；长驻进程约每 24 小时让新调用进入新 session，
  已在执行的并发调用继续在原 session 完成，因此请求与响应不会拆分。私有目录准备、ACL、文件创建与写入
  均异步执行，写队列先落正文再落索引；每个普通 writer 最多接受 14 MiB / 4096 项待写数据，
  其中 trace 最多占用 4 MiB，并为索引与 session 收尾保留 256 KiB / 128 项。
  trace 或正文达到旁路容量时分别告警并丢弃；正文首个缺口后的片段不再拼接，索引使用既有
  `payload.truncated` 标记，后续独立正文在队列释放后可继续采集。告警在同一队列排空前每类至多一次；
  同次调用的输出 trace 首次丢弃后不再追加其后缀，响应索引以可选 `traceTruncated` 标记缺口；
  WebSocket 下一次逻辑调用独立恢复采集。该标记不改写完整终态正文，读取端仅对依赖 trace 的输出提示不完整。
  索引达到硬上限仍停止采集，避免把缺索引视为成功。最多持有 128 个尚未退休的 session。
  Relay 两协议共享同一份 14 MiB / 4096 项待写预算、trace 配额与索引预留，容量丢弃与磁盘故障分别报告。
  排空完成到释放任务所有权之间入队的数据会继续调度，关闭等待全部已接受任务及后续调度排空后才释放文件。
  单次磁盘工作超过 5 秒时停止采集，
  报告不含路径或正文的故障分类，模型转发继续；关闭最多等待 5 秒，未确认结束时拒绝关闭并允许重试，
  迟到 I/O 仍由原 owner 持有并收尾。
  App Server 启动及新 session 建立时异步按 session
  最后活动时间与 `[debug].model_traffic_retention_days` 清理过期 V2 历史 session，`0` 关闭按时间清理。
  历史完整 session 仍按 Provider 约保留 320 MiB；清理在删除前复核同进程所有 writer 的活动目录，
  包含扫描期间新分配但尚未完成文件准备的 session；维护可取消且有时间和扫描项数上限。
  当前写入中的 session 不会被拆除，未知目录和旧版文件不会被自动删除；
  Authorization、Cookie 等凭据字段只保留认证
  方案。精简模式继续裁剪 `input` 与过大条目，并从 trace 丢弃 `.delta`；逻辑响应始终只保存
  `response.completed|failed|incomplete|error` 终态。写入失败时停止转储并经 `onError` 上报，模型请求继续正常转发。
- `traffic-dump-headers.ts`：Codex/Relay 全模式共用的纯头脱敏函数及 Relay 有界采集，保留普通请求/响应头和关联 ID，仅遮蔽凭据类值、URL 秘密与 CSP nonce，限制字段与整体大小，不修改出站头。
- `relay-dump-payload.ts`：Relay JSON/SSE 的共享脱敏与有界合并写入，供上游及客户端交付阶段复用。
- `index.ts`：公开代理、指标通道和稳定的脱敏单请求指标类型。
- `chat-io.ts`：Chat 桥和直接 Chat 共同使用的正文读取、取消等待、拉取式 SSE 分帧与下游背压；`readModelBody` 供启用名单复核保留原始 Buffer，`readChatBody` 保持文本返回。
- `direct-model-http.ts`：直接模型请求共用的 HTTP 出站生命周期、响应状态/Content-Type 校验与安全 JSON 解码，保留普通应用请求头并复用跳级头清理，覆盖凭据和传输头、剔除 Cookie/伪造身份；同步出站复核、实际 UA 观测、首包/空闲超时、取消和关闭清理，不负责协议转换、重试或指标发送。
- `direct-responses.ts`：原生 Responses JSON/SSE 交付，复用 HTTP 生命周期和 Responses 指标归约；非流式通过共享白名单识别首个非空输出，观测时间为整包解析校验后；保留事件、用量、终态与扩展字段，不生成 Chat DONE，断流不伪造成功；独立诊断回调仅提交有证据的错误阶段与内层错误，不推断 Chat 专属路由或结束原因。
- `cline-pass-routing.ts`：CLP 专属出站副本投影，按可选 `deepseek-flash` 请求快照固定 `providerOptions.gateway.only` 为 `deepseek`，保留请求模型 ID 和其他对象字段并拒绝畸形容器。未传快照时保留精确 Flash 模型默认分支，显式 `standard` 不固定路由。桥与 Relay 共用，独立 Relay 不读取受管快照，不处理网络或重试。
- `direct-chat.ts`：单次直接 Chat JSON/SSE 协议处理，复用公共 HTTP 生命周期；识别 CLP 显式成功的单层 JSON 包装后复用响应校验，可向注入的有界采集器提交已解析 Chat 报文；另经独立诊断回调提交受限请求指标摘要，关闭转储仍采集。

- `generation-timing.ts`：有界原生 Responses 与原始 Chat 生成区间观察器，不保留内容；区间完整时提供思考、正文、工具与并集毫秒摘要。Chat 在转换前采集，经已有请求级进程内通道传回指标，不依赖转储或改变转换器工具校验。共享 `runtime/request-timing.mjs` 负责入库前校验与显示速度计算。

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

Chat 桥复用公共端到端请求头过滤器，保留 Provider 的普通附加头；转换正文后重写 Host、Content-Length、Content-Type 和内容协商字段，移除原正文编码与仅本地使用的诊断关联头。

`chat-diagnostics.ts` 白名单提取有界的上游模型、标识、路由、费用与用量明细，经请求级进程内回调在终态交付前提交给代理，写入独立 `chat_diagnostics` trace 事件；随机关联编号随本地 HTTP 传递，观察器随请求关闭清理；不进入 App Server 输出。指标订阅不依赖转储是否开启，仅投影受校验的实际上游、尝试次数、结束原因、错误阶段及内层上游错误摘要，经私有 IPC 独立入库；不保存诊断中的标识、费用、正文或路由历史。桥的工具参数转换失败时另提交 `conversion.toolArguments.length` 与 `conversion.toolArguments.shape`（`empty`/`invalid_json`/`not_object`）：只描述参数形态，绝不包含参数正文，也不改变对客户端交付的错误文案。转储同时把同一次调用诊断里的 `routing.finalProvider` 作为可选 `upstreamProvider` 写入 V2 响应索引，供调用列表在模型名旁展示上游标签；请求明细列表从指标库独立读取同名字段；没有诊断或字段缺失时不写入，也不推断。

`chat-errors.ts` 按 Cline 官方错误合同归类 HTTP 与流内错误，限制错误正文读取大小，仅返回固定文案和白名单错误码；HTTP 错误可携带经验证的 Retry-After，由 Chat 桥及原生 Relay 交付，不自动重试。桥将上游 429/503 的受限整数秒或规范 HTTP 日期交给外层 Codex，错误正文超时或使用不支持的压缩编码时不丢失该建议，畸形值不转发。

公开入口导出 `chatUpstreamError` 与 `chatStreamError`，供 Scripts 的主动搜索诊断复用结构化错误分类；调用方传入实际出站工具及真实 HTTP 状态，诊断不另行解析固定包装或改变状态优先级。

Chat 桥与直接 Chat 调用将实际出站工具声明交给错误分类器。HTTP 400 或流内 `invalid_request_error` 明确拒绝 `tools.N.type`，且该位置实际为 `web_search` 时，返回固定 `web_search_unsupported` 文案与关闭原生搜索的建议；同时支持实测 Cline `stream_initialization_failed` 固定包装内的有界 HTTP 400 JSON 原因。不转发原始错误正文，不从工具名称相似度或任意错误文本推断能力，不改写请求或自动重试；其他 HTTP 状态仍优先决定认证、限流及服务错误分类。

本地模型请求期限统一使用 `ModelRequestTimeoutError`：上传为 HTTP 408 `upload_timeout`，准备为 HTTP 504 `preparation_timeout`，上游响应头/正文/完整事件为 HTTP 504 `upstream_timeout`，交付/收尾为 HTTP 504 `delivery_timeout`。可发送结构化错误时附带 `timeout_stage`（`upload/prepare/headers/body/stream/delivery/terminal`）；已发送 HTTP 响应头时不改写状态，透明转发中断仅关闭连接并记录受控错误。已完成生成的指标不被交付失败覆盖。
HTTP 错误保存实际 `upstreamStatus`，状态优先确定错误类别及重试性质；400 只允许上下文超限、内容过滤或上述已确认的原生搜索拒绝细分，不让正文覆盖认证和可用性。原生 HTTP/WS 交付失败先记录明确原因再关闭，后续清理保留首次失败及其时间。流量转储复用 `errorScope` 的 `timeout_<stage>` 值记录本地超时，读取端仅映射已知阶段；指标数据库与既有转储结构不变，不回填历史。
Relay 转储的最终模型结果由请求宿主传入，与同一请求的指标共用一次投影；采集器只保存报文、诊断与终态时间，不维护另一套结果推断。`completed` 与交付 `failed/disconnected` 可以同时成立，详情分别解释生成结果和交付状态。
`chat-io.ts` 的 JSON 正文及 SSE 增量读取使用严格 UTF-8 解码，跨分片字符保留解码状态；入站编码错误为受控请求失败，直接上游编码错误为 `invalid_upstream_encoding`。错误诊断正文解码失败仍保留 HTTP 分类与安全退避头。消费者在协议终态停止读取，不继续等待终态后的尾流。

Chat 桥与直接模型适配器共用 `direct-model-http.ts` 的成功响应校验：媒体类型忽略大小写、去除参数后精确匹配 JSON/SSE；请求明确发送 `Accept-Encoding: identity`，成功响应仅接受缺省或 `identity` 编码。其他编码返回 `invalid_upstream_encoding`，不把压缩字节当作 UTF-8。直接 Chat/Responses 调用可通过 `maximumResponseBytes` 收紧成功响应的完整正文、SSE 帧及累计字节预算，供短请求探测使用；错误正文仍使用既有 64 KiB 上限。原生 Responses 透明代理保持上游传输合同。

受管 CLP 桥在真正发起 HTTP 请求前调用 Runtime 注入的当前模型目录复核；停用或未知模型返回 `409 clp_model_disabled`，缺少复核器或无法安全读取目录返回 `503 clp_catalog_unavailable`，使用固定中文提示并阻止上游请求。共享账户与聚合经过同一检查，已提交请求不强行中断；非 CLP 桥和 Relay 独立目录不受影响。

自定义 `cp-*` 的 Runtime 守卫还复用配置读取器的版本 5 和完整目录一致性校验，并拒绝目录 `.pending` 与全局上下文同步未完成状态；HTTP/WS 复用相同回调，不把合法 slug 单独视为有效目录。

DS/OCG/CCG 和自定义目录提供商由 Runtime 向 `ProviderProxy` 注入同源目录复核；CLP 在桥内执行。HTTP 在路由解析后、有界读取正文并复核模型再提交；Responses WS 每个 `response.create` 在连接可用后、发送前按顺序复核。停用返回 `409 provider_model_disabled`，目录不可用返回 `503 provider_catalog_unavailable`；WS 包装为 error 后关闭连接，已提交请求不撤回。HTTP 正文上限 48 MiB、上传预算 30 秒，目录复核预算 30 秒；全代理最多四项授权准备，WS 单帧限制 48 MiB、排队与连接队列各限制 96 MiB且最多 16 帧。官方 OpenAI、Codex 兼容 Provider 的共享官方只读目录与独立 Relay 不注入此目录复核。
HTTP／WS 保留请求中的 hosted `web_search` 与 `tool_choice`，不依赖模型目录的扩展声明；搜索是否启用由 Codex 配置决定，执行支持由上游判断。采样与私有项归一化不改变该合同。聚合先恢复真实模型 ID，再经过对应 Provider 代理。通用 Chat 桥透传未映射的顶层声明；受管 CLP 对 live `web_search` 使用独立搜索适配，并接受 search 查询历史，其他 hosted 历史仍按转换边界拒绝。
除官方 OpenAI 端点外的 Responses 上游（受管 DS/OCG/CCG、自定义 Provider 与自定义 `cp-*`）在提交前归一化 Codex 私有输入项：`agent_message` 降级为普通 `user` 消息，工具参数 schema 中的布尔 `encrypted` 标记被删除，无法转换的私有项按 `400 provider_model_request_invalid` 失败关闭，不退回透传（与 Chat 桥一致）。HTTP 与 Responses WS 都只替换发往上游的字节，转储与指标仍记录客户端原始报文；未发生改写时沿用原始字节。正文改写后按实际字节重写 `content-length`；没有目录守卫的第三方上游沿用同一 48 MiB 正文上限、30 秒上传预算与四项准备上限，压缩正文仍拒绝。
Responses WS 归一化同样要求文本 JSON 消息且单条不超过 48 MiB；无守卫上游也在 WebSocket 接收层限制消息大小（含分片累计），并受同一等待队列上限约束。HTTP 目录复核与归一化共用一次正文解析。官方 `openai` 路由（含 `openai_base_url` 覆盖）不归一化，该端点理解 Codex 私有输入项；独立 Relay 的出站请求来自外部调用方自带报文，同样不归一化。

`chat-bridge.ts` 按 Runtime 的受管 CLP 身份映射模型思考参数，并仅对精确 Flash 模型限定 DeepSeek 上游；其他 Chat Provider 不注入。它管理 Chat HTTP 连接、SSE 分帧、背压、取消和有限超时，通过 `model-api/index.ts` 调用纯转换模块。转换覆盖 Responses 的 `function`、`namespace`、自由格式 `custom` 工具、执行位置为 `client` 的 `tool_search`（含其结果带回的工具声明）与 Codex multi-agent v2 的 `agent_message` 输入项；`agent_message` 降级为普通 `user` 消息，Responses 私有的 `encrypted` 参数标记不下发；除受管 CLP 的 live 网页搜索适配外，未映射的顶层工具声明及其 `tool_choice` 原样交给上游判断，不为它们注册客户端执行身份；回程不支持的工具调用仍明确失败。`text.format` 的 `json_schema` 映射为 Chat `response_format`，`text.verbosity` 校验后忽略。
上游接口为 `chat_completions` 的自定义第三方 Provider 复用同一桥，按通用分支运行（不 pin CLP 路由、不读 CLP 目录、思考等级按通用形状发送）；这类 Provider 的 WebSocket 关闭，客户端检索与连接器工具由桥转换。通用分支在请求同时带工具时把 `text.format` 的 schema 追加到首条 system 消息并省略 `response_format`，因为部分 Chat 上游拒绝两者并存；托管 CLP 已验证接受，继续使用 `response_format`。该降级只由提示词保证，桥不校验最终文本，`conversion.structuredOutput=prompt` 记录在请求诊断中；模型侧仍由统计代理按 Provider 目录拒绝目录外或已停用模型。
上述按精确 Flash ID 选择格式和路由是未保存请求快照时的默认行为。受管 CLP 通过同次启用目录读取取得思考选项和可选 `clineRequestProfile`：`deepseek-flash` 使用 Flash 格式并限定 DeepSeek 上游，`standard` 使用通用格式且不固定路由，出站始终保留用户新增的模型 ID。所有显式思考选项须属于当前模型；只有声明开关的目录允许 `enabled`，出站转换为 `reasoning.enabled=true`。未知选项或请求快照在出站前拒绝，目录不可读时失败关闭；直接 Chat/Responses Relay 保留自己的参数合同，不套用此目录或转换。
Runtime 在统计代理后装配本地 Chat 桥，两者共同归属 App Server 服务生命周期；转换后的 Responses 事件复用现有指标采集。统一阶段预算来自 `runtime/model-request-policy.mjs`：上传 30 秒、准备 30 秒、真实上游首响应头 300 秒、完整 Chat 数据事件空闲 300 秒；没有生成总期限。正文接收超时返回 408 `upload_timeout`；上游等待超时返回 504 `upstream_timeout`。交付受阻最多 30 秒，终态与失败交付使用独立 5 秒预算，外层统计代理不再以 305 秒计时抢先截断。完整数据事件空闲不因注释心跳或不完整字节续期；下游背压期间暂停上游事件等待。工具转换仍保留完整校验后发布的合同；转换前有 Chat 帧不等于 Codex 已看到 Responses 事件，长时间没有可交付事件时仍受 Codex 自身的 300 秒空闲限制，不伪造保活事件。

所有账户的 Chat 桥在同一进程共享 192 MiB 请求正文保留预算：读取正文前按有效
`Content-Length` 预留，缺失或 chunked 时按单请求最大 48 MiB 预留，因此最多四个最大请求同时准备；
小型请求按实际声明长度准入。生成、交付及取消清理完成后才释放。超限返回
`503 chat_bridge_capacity_exceeded`，不排队、不自动重试；这不是 Node 总内存上限。每座桥拥有独立随机本地身份，统计代理覆盖客户端同名身份头，桥校验后才准入；该头不进入 resolver 或模型上游，原有 `Authorization` 语义不变。关闭等待本桥在途处理结束。

- `relay-traffic-dump.ts`：Relay Chat/Responses JSON/SSE 脱敏采集，复用 V2 存储与 ChatDiagnostics 白名单采集；JSON（含成功包装）读取 message、SSE 读取 delta 中的上游诊断，终态按同一 interaction 写入既有 chat_diagnostics 与 upstreamProvider，缺失不推断；所有账户共享容量和待写预算，按协议使用 relay.chat/relay.responses 标签，共享两协议容量和待写预算；`prepare(signal)` 在取消边界内异步初始化容量，服务组合层在其后复核全局采集设置；`setRetentionDays` 使用全局保留天数，`open(provider, signal, debug)` 复核取消后立即尝试采集，首次容量初始化期间跳过并报告 initializing，不等待磁盘；共享存储报告实际接受的写入量，在途调用单独预留预算；后台单任务清理历史并保护活动及新建批次，整理期间继续采集；维护与关闭各有 5 秒预算，采集失败不影响模型交付；`diagnostics()` 提供当前 owner 状态、活动数与容量跳过累计，不推断历史未采集原因。
- `relay-metric.ts`：直接模型调用的最小跨进程指标合同，不包含消息正文或凭据。
- `relay-metrics-channel.ts`：版本化、受限帧与连接的私有指标 IPC；显式接收/拒绝，未知确认不判定为丢失；异步接收任务最多 8 个，断连时取消，任务实际结束才释放名额。
  协议/生成/交付状态及转储标签严格要求字符串枚举，不以强制转换接受数组，避免畸形样本进入批次影响其他指标。
