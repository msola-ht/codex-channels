# Provider 模型 API 转发设计与边界

本文记录当前 Model Relay 的实现合同与验收边界。操作命令和配置示例以
[用户指南](user-guide.md#可选模型-api-转发)为准；文件职责以各模块 README 为准。
首版仅 CLP/Chat、三级限流、独立采集开关和旧管理页方案已被替代，不再作为执行计划保留；
逐批实施与故障修复记录可通过本文件的 Git 历史追溯。

## 当前范围

Relay 是独立可选服务，提供原生 Chat Completions、Responses 的 HTTP JSON/SSE 与受限模型列表。
客户端使用独立 Relay Key；上游账户和模型由已验证的配置绑定，不由请求正文或请求头选择。
不连接 App Server，不创建 Thread、Turn、审批、工作区或渠道消息，不执行客户端工具。

| 提供商 | 原生协议 | 材料来源 |
| --- | --- | --- |
| CLP | Chat | 共享受管账户的 API Key 与独立 Cline 转发目录；模型授权由 Key 保存 |
| DeepSeek | Chat / Responses | 受管账户的独立 API Key 与模型目录 |
| OpenCode Go、CCG | Responses | 受管账户的独立 API Key 与模型目录 |
| 自定义主/切换提供商 | Responses | 已注册配置、可独立读取的 API Key 与有效模型目录 |

官方 Codex OAuth 登录态尚未接入 Relay。[只读 Codex 登录转发](relay-codex-auth-development.md)
是独立设计稿，不能把其中的 Provider ID、WSS 传输或模型缓存读取当成现有能力。

默认禁用、回环监听，可显式选择 IPv4 局域网地址或 `0.0.0.0`；后者监听所有 IPv4 网卡，
不保证仅内网可达。跨不可信网络使用用户管理的加密隧道。入口不开放 App Server 或管理 IPC。
Relay 与 Gateway 同机部署，通过私有 IPC 提交指标；多进程仍共享宿主资源及上游账户额度。

## 架构与所有权

```mermaid
flowchart LR
  C[外部客户端] --> R[独立 Relay 服务]
  R --> A[鉴权与有界准入队列]
  A --> H[原生 Chat HTTP/SSE]
  A --> P[原生 Responses HTTP/SSE]
  H --> U[配置中的提供商上游]
  P --> U
  R -.有界指标 IPC.-> G[Gateway 单写者]
  G --> D[指标库]
```

| 模块 | 职责与边界 |
| --- | --- |
| [model-relay](../src/model-relay/README.md) | HTTP 入口、Key 鉴权、模型授权、全局准入、队列、撤销和单次指标结算 |
| [model-api](../src/model-api/README.md) | 请求形状、思考策略和协议观察；不读取配置、访问网络或执行工具 |
| [provider-proxy](../src/provider-proxy/README.md) | 共用 HTTP 生命周期、响应头/JSON 校验、背压、取消、协议交付及转储 |
| [runtime](../runtime/README.md) | 提供商材料、网络选择、配置发布、revision 复核、私有 IPC 和服务生命周期 |
| [observability](../src/observability/README.md) | 指标持久化与查询；Gateway 是唯一写入者 |
| [scripts](../scripts/README.md)、[WebUI](../webui/README.md) | 共用管理事务、命令、页面与受控服务操作 |

Chat 与 Responses 共用鉴权、队列、传输和指标基础能力，各自保留终态语义；不做协议互转、
自动协议探测、账户轮换或上游重试。Gateway 重启不停止 Relay 模型请求，但指标接收中断可能丢样本；
Relay 重启取消自身在途请求，不停止共享 App Server。

## 请求与交付链路

1. 限制连接、路径、方法、请求头与读取期限，校验单一 Bearer Key。
2. 原子预占有界上传/等待名额，捕获调用方、Key、代次、提供商、模型权限和取消信号。
3. 有界读取并验证正文，加入等待队列。
4. 按同 Key FIFO、跨 Key 轮转取得全局执行许可及可选速率令牌；上传未结束的 Key 不阻塞其他 Key。
5. 通过 Runtime 读取受信上游材料与网络目标；在异步准备后复核授权、revision、模型及取消状态，再按 Key 与模型覆盖策略处理思考字段。
6. 最后一次复核与创建上游连接之间没有异步间隔；只发送一次，不跟随重定向或自动重试。
7. 按原生协议交付 JSON/SSE，分别记录上游模型终态与客户端交付结果。
8. 释放许可并单次生成指标，放入有界发送器；客户端响应不等待指标 IPC 确认。

上传和等待使用独立预算，不占执行并发。执行许可覆盖出站准备、上游请求和客户端交付，
请求失败不返还已消费的速率令牌。取消后迟到的材料或网络结果不得出站或重复结算。

## API 与参数边界

仅开放 `POST /v1/chat/completions`、`POST /v1/responses` 和 `GET /v1/models`。
模型列表返回 Key 授权列表与对应提供商当前目录的交集；不提供响应读取、取消或服务端会话管理端点。

请求保留解析后的普通 JSON 字段和值，由上游判断模型专用参数、工具声明、图片与扩展内容。CLP Chat 的 `cline-pass/deepseek-v4.1-flash` 路由策略例外：鉴权确定 CLP 账户及该精确模型后，固定出站 `providerOptions.gateway.only = ["deepseek"]`，覆盖客户端同名值，其他合法字段保留；畸形路由对象在出站前拒绝，不取消限定重试。JSON 与 SSE 均适用，其他模型及 Provider 不注入；探测依据见 [CLP 路由记录](cline-pass.md#上游路由限定探测)。
Relay 不下载远程图片，不读取请求里的本机路径。具体本地边界如下：

| 字段或条件 | 当前处理 |
| --- | --- |
| `model` | 完整 `提供商/模型ID` 最多 265 字符，其中提供商最多 64 字符、模型部分最多 200 字符；模型部分非空、无首尾空白或受限控制字符，且通过 Key 授权与提供商目录校验 |
| `stream` | 只能为布尔值；省略时按 `false` 交付 JSON，不强制全部流式 |
| Chat `messages` | 非空对象数组；不设 256 项上限 |
| Chat `n` | 省略、`null` 或 `1`；当前单选择交付不接受其他值 |
| Responses `input` | 字符串或对象数组；缺失/为 null 时须有非空字符串 `instructions` |
| Responses `store` | 省略或布尔值，出站统一为 `false`，不因 `true` 拒绝 |
| Responses `background` | 省略或布尔值；传入时改为 `false`，省略时不补 |
| Responses 历史引用 | 官方 DS 原样透传；其他提供商拒绝非 null 的 `previous_response_id`、`conversation` |
| 正文预算 | 入站及处理后的请求受 1 MiB 上限约束；输入项不另设 256 条上限 |

DS 历史引用由上游按其无状态合同忽略，客户端仍须携带完整上下文；其他提供商的引用可能
读取共享账户历史，而 Relay 尚无响应/会话归属校验。提供商分支只来自鉴权绑定。
资料见 [DeepSeek 接入边界](deepseek.md#responses-兼容性边界)与
[官方 Responses 参数说明](https://api-docs.deepseek.com/guides/responses_api/)。

思考策略默认跟随客户端。Key 强制关闭仅对已登记的提供商、模型及协议组合生效；其他组合保留客户端参数，不阻止请求：通用 CLP Chat 使用 Cline 官方适配器的 `reasoning.enabled=false`；CLP 精确 DeepSeek 模型保留已验证的 `reasoning.effort=none`，DS Responses 使用 `reasoning.effort=none`，DS Chat 使用 `reasoning_effort=none`。
`extra_body` / `extraBody` 内的思考控制字段与关闭策略冲突时返回具体字段路径；
跟随客户端不增加该限制。不修改历史思考内容或隐藏上游输出。

普通端到端请求头透传；连接级头、客户端凭据、代理身份和 Codex/Relay 私有路由字段过滤，
由出站模块重建鉴权与传输头。响应头受白名单限制。诊断转储的脱敏规则不改变实际出站头。

两协议共享 HTTP 状态、Content-Type 和 JSON 解码检查，非法 JSON 返回
`invalid_upstream_json`。上游错误仅暴露受控分类，不返回未经约束的错误正文。
Chat 保留原始扩展字段与工具增量；流式结束后允许附带用量、重复相同结束原因且 delta 仅含空 content / assistant role 的统计尾帧，仍须收到 `[DONE]`。结束后追加内容、工具或不同结束原因仍拒绝；Responses 保留原生事件和 completed/failed/incomplete 终态。
终态前断流不得伪造成功；SSE 开始后用对应协议的失败事件结束，可写性丢失时只关闭并记录。
客户端应在有效终态后执行工具，上游完成不等于客户端已收到全部输出。

## CLP 转发模型目录与设置

Cline 的 Relay 模型来源独立于 Codex。WebUI「模型转发」中的「提供商模型」
首次打开时自动下载缺失的提供商目录，也可手动更新；所有 CLP 账户共享该目录。提供商每行一个“模型列表”按钮，弹窗只读展示调用 ID、输入格式及协议。
`GET /v1/models` 只返回 Key 授权与当前目录的交集。每把 Key 的 `models` 保存 1–256 个唯一的 `提供商ID/模型ID`，可跨提供商；新增目录条目不会自动授权。CLP 对外仅去掉 `cline-pass/`，出站通过目录精确匹配还原原始 ID；其他提供商保留完整上游模型部分。映射重名拒绝调用，无前缀别名、自动回退或协议转换。
同名模型可以分别用于 Relay 与 Codex，彼此设置互不覆盖。

上游密钥继续复用已有 CLP 账户，不需要额外申请。Relay 只读取账户注册、管理标记与凭据；
不读取或校验 Codex 模型目录、manifest、选中的模型、上下文同步状态或思考等级。
账户撤销、凭据轮换仍会撤销旧请求；仅修改 Codex 模型设置不会改变 Relay 的材料版本。
渠道仍由 Codex App Server 使用原有目录和工具执行流程。此拆分只覆盖 CLP；其他提供商维持原模型来源。
Relay 的请求采集、私有 IPC、Gateway 单写者及统计数据库不变，不重复经过 Codex Provider 统计代理。

模型文件来自 Cline 官方仓库：先查询 `main` 当前提交，再按该 SHA 下载
`sdk/packages/llms/src/catalog/catalog.generated.ts`，只解析 JSON 数据，不执行 TypeScript。
仅提取 `cline-pass/` 条目，保留名称、上下文、输出限制、能力及思考控制；不从相似模型名称推断。
下载使用共享代理、固定 HTTPS 来源、25 秒总预算和 16 MiB 上限，不跟随重定向，不发送账户凭据。
未知思考控制类型或等级、空目录和格式变化会拒绝整次更新。

目录保存为当前 Gateway TOML 同目录的 `cline-relay-models.json`（格式版本 1），不写入 Codex 模型目录或数据库。
界面显示来源提交与下载时间。更新先完整下载、校验，在管理事务内将旧文件备份至
`cline-relay-models.json.backup`，再原子替换；失败保留原目录，备份失败不替换。
需要回退目录时停止 WebUI，在保留私有权限的前提下用该 `.backup` 原子替换目录，再启动 WebUI；
目录回退不回退 Key 或配置。旧程序忽略该独立文件，无数据库迁移。
更新改变 Relay 可用模型集合，但不修改 Key 的模型授权或思考策略；上游目录移除的模型将不再可调用，其他模型保持可用。Relay 启用且配置 CLP 账户时会在后台自动下载缺失目录；首次打开 WebUI 转发设置页也会自动补齐；CLI 查询提供商或为已注册 CLP 账户创建／修改 Key 时，若目录缺失，会先下载再继续操作。下载完成前该账户暂不可用，不阻塞其他提供商；已有有效文件直接复用，不自动更新版本。每个服务实例或页面实例自动尝试一次，失败记录固定服务日志或页面提示，可手动重试。损坏文件需显式更新修复，不自动覆盖，不回退 Codex 目录。关闭服务或页面时取消未完成的下载，服务最多等待 2 秒。后台落盘前在管理锁内复核目录仍缺失，避免覆盖并发手动更新。仅下载时间变化而模型数据相同时不会撤销在途请求。从当前目录读取关闭思考能力，不新增持久配置。
配置预览绑定目录 revision，期间更新目录后必须重新预览。
CLI 自动下载在管理锁外进行，落盘前持锁复核目录仍缺失，避免阻塞 Key 撤销或覆盖并发更新。
WebUI 预览与确认保存均不自动下载目录；目录不可用时，保留原模型授权的改名仍可保存，改变授权则须通过当前目录校验。

`toggle` 允许选择关闭；`effort.values` 提供明确等级，`default` / `null` 不等同于关闭。
预算型控制保留在目录中，此版不转换为等级，也不新增预算设置；未声明可用等级时仅支持跟随客户端。
目录保留 `modalities.input/output`；模型列表优先采用显式输入类型，缺失时按 Cline 的能力映射显示文本、图片、视频及 PDF，音频只依据显式输入声明。无能力信息时显示“未声明”。旧下载文件可继续读取，重新下载时补齐此前未保留的 `modalities`，并沿用原目录备份与原子写入流程。输入标签描述上游声明，不扩展 Relay 请求协议。
工具等能力保留在下载目录中，当前界面展示输入类型与协议；不启用 Cline 的搜索工具，不修改客户端工具定义。
Cline 自身会从 OpenRouter 目录合并部分能力，目录仍可能与实际端点有差异。
思考策略只属于 Key：`passthrough` 保留客户端参数；`off` 仅对当前目录或静态能力明确支持的模型关闭思考，其他模型仍保留客户端参数。提供商不保存模型级策略或能力快照。保存授权与策略使用管理预览确认、revision、配置锁、私有备份和原子替换；失败保留原配置，生效确认失败明确报告。

## 身份、材料与资源

配置来自 Gateway TOML 的 `[model_relay]`。每个调用方对应一个 Key，可显式授权多个提供商的模型；
每把 Key 的模型集合、策略、凭据与代次独立。轮换后旧秘密失效，禁用、改绑、删除及材料变更
取消相关上传、等待和在途租约。模型目录与凭据始终由现有提供商模块解析，不复制账户管理。

CLI/WebUI 共用预览、确认、配置锁、revision、私有备份与原子保存。完整新 Key 只显示一次，
失败或响应丢失不能通过自动重复签发恢复。保存与运行态应用分别报告，不自动启动服务。

仅保留全局并发及分钟速率限制，账户和 Key 不另设限流层。`requests_per_minute=0` 只关闭速率限制，
不关闭并发和队列预算。上传/等待最多 32 项、正文总预算 16 MiB，正文验证后最多等待 30 秒。
队列只在内存中，重启不重放；这些限制不能提供 Token、费用或套餐硬预算。

删除或改绑保留最小历史身份摘要，用于旧调用指标结算及禁止身份复活；不保存正文或旧秘密。
摘要最多 4096 项并受配置大小约束，耗尽时拒绝整次操作。不删除提供商本身的配置或凭据。

## 指标、转储与管理诊断

每次实际出站只生成一个模型请求样本，保留真实提供商、调用方、Key、凭据代次与请求 UUID；
Thread/Turn 为空，不伪造成 Codex 会话。指标发送有界且不重试；`accepted` 仅表示接收确认，
不等于落盘，`unconfirmed` 也不能直接当作丢失。指标不能充当可靠账本。

Relay 与 Codex 共用全局 debug 转储开关与 production/debug 模式。V2 转储使用
`relay.chat` / `relay.responses` 标签，共用容量与待写预算；生产与调试模式均脱敏必要凭据，
保留普通头及关联信息。调试模式可对照入站、出站和实际交付；实际补入或覆盖 CLP 路由时记录 `provider_routing_pinned`，读取器和中英文 WebUI 同步识别，已符合限定时不误报；非法、截断、未采集与未交付分别显示。
普通头可能包含业务数据，不承诺识别任意自定义编码秘密。详细采集口径见
[WebUI 调用详情](webui.md)和[代理模块](../src/provider-proxy/README.md)。

运行状态区分已配置并发与运行快照，明确显示等待、准备、上游处理和交付，以及指标确认和采集状态。
私有控制 IPC v5 提供最多 64 行的当前请求快照；WebUI 队列侧栏通过 SSE 变化通知触发有界快照读取，
隐藏或关闭时取消订阅，失败不显示伪造零值。页面服务管理沿用现有预览/确认任务。

## 升级与回退

### 原生双协议与提供商公共接入

当前 Relay 配置不保存 `accounts` 或调用方 `provider` 字段，授权只来自 `callers[].models`。旧字段、升级及回退命令明确拒绝，不自动转换。提供商 ID 为 1–64 位 ASCII 字母、数字、下划线、连字符，模型部分最多 200 字符；保存与出站均核对实际目录。事务备份用于恢复失败，不得恢复已撤销的凭据。

指标库 v22→v23 不增删列、索引或历史记录，仅把 Relay CHECK 中 traffic_label 的允许值由 NULL/relay.chat 扩展为 NULL/relay.chat/relay.responses；保留三元组完整性、真实调用方、空 Thread/Turn 和请求 UUID 去重约束。v24 增加可空的单次响应用量原值；v25 增加与调用转储独立的上游诊断摘要，v26 新增官方轮次耗时与同步标记，v27 增加可空的额度快照接收时间 `quota_observed_at_ms`，历史值保持 NULL。显式升级支持完整 v20/v21/v22/v23/v24/v25/v26，运行时只接受 v27。升级先停写并取得数据库所有权锁，检查精确源 Schema、空间与 integrity_check，做 SQLite 一致性备份，校验 SHA-256、备份 Schema、完整性和逻辑数据摘要，再 BEGIN IMMEDIATE 迁移；v26 仅新增额度快照时间列并保留已有耗时表与同步标记，v25 还新增这两张表，v20 逐列追加缺失字段与索引，v21–v24 重建请求表并复制全部历史列及 ID，恢复 sqlite_sequence 和原索引。核对历史摘要后设置版本并提交；事务失败回滚且保留备份，提交后校验失败仍报告未完成、服务保持停止。已有辅助成本数据按现有合同原样保留。

回滚复用显式指标恢复入口：校验指定源备份的版本和 SHA-256，先一致性归档并校验当前 v27 数据库，再通过受控临时文件恢复选定 v20/v21/v22/v23/v24/v25/v26 备份。新版本请求和额度快照接收时间留在归档，不伪装为已迁入旧库；失败保留当前库及所有备份。V2 转储不转换、不删除；旧程序可能无法关联 Responses 标签，升级后仍可读取。配置回退与数据库回退分别执行，数据库恢复不得恢复任何配置或旧凭据。

服务公开目标仅接受 `relay`，内部服务名及 `service-model-relay` 入口保持不变。旧 Relay 限流、模型授权、策略及采集配置转换入口均已移除。指标数据库升级和恢复仍使用独立的数据管理入口，不删除历史记录。

## 验证范围与剩余限制

隔离回归覆盖双协议 JSON/SSE、提供商发现与撤销、Key 改绑/删除、等待公平性、背压、取消、
关闭、迟到材料、配置备份失败、指标单次结算、转储关联、v20/v21/v22 升级与回滚。
执行入口包括 `tests/model-relay-server.test.ts`、`tests/model-relay-runtime.test.ts`、
`tests/direct-chat-request.test.ts`、`tests/direct-responses-request.test.ts`、
`tests/request-metrics-relay-upgrade.test.ts`；测试范围以对应文件为准，本地提交走按范围选择的 `verify:commit`，PR CI 通过 `verify:ci` 执行完整回归。

2026-09-29 部署后只读核查已确认 DS Responses SSE/JSON、CLP Chat SSE/JSON 的既有成功调用，
实际指标库为 v23，提供商、状态、用量与转储可关联，Thread/Turn 为空。此证据限于当时部署与样本，
不代表后续提交均已部署，也不替代真实 failed/incomplete、撤销、过载、关闭竞态、局域网设备、
防火墙及多平台实机验收。隔离测试通过不能升级为真实账户或生产故障验证通过。
