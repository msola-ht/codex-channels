# Codex CLI 升级决策

本页说明当前项目采用什么、为什么采用，以及哪些上游能力仍不接入，供下一次升级直接复核。
当前源码基线为 `codex-cli 0.164.0`；具体协议和实现以[支持矩阵](index.md#当前支持矩阵)为准，
升级步骤与门禁见[升级流程](codex-cli-upgrade.md)。本页不重复协议数量、命令参数或逐版本更新日志。

## 0.164.0 升级决策

**决定：采用 `0.164.0` 正式版，并同步修复关联业务合同；不扩大渠道能力或实验协议范围。**
初筛后继续沿会话、账户、目录、审批、计划任务、服务、Provider 和输出链路审查，确认下列关联问题。
精确目标 CLI 在隔离目录安装，已通过项目升级预检、协议生成及生成复核；版本和生成结果已合入当前工作区。
业务适配阶段未替换全局 CLI、重启共享服务或部署；用户随后完成部署，新增观察见“部署后验收”。
审查分支为 `chore/codex-0.164.0-review`，本地代码起点
`5e3a5a4abe4eed6261dc44ef20c57a4a9fc29228`。目标固定提交与资料入口见
[上游来源](upstream-sources.md)，以下上游路径均相对目标固定目录的 `codex-rs/`。

### 修复前发现与方案依据

本表保留修复前的触发链、方案分析及源码位置，便于复核原因；当前实现与实际观察见“实施结果”。
其中数字快照问题最终采用完整 ID 方案，服务档位最终固定用户选择并单独记录有效值，均已落实。

| 用户影响与触发条件 | 升级决定与本地边界 | 证据与实施要求 |
| --- | --- | --- |
| 同一会话并行查询两个任务的 Run 列表后，按数字重试可能操作错误任务 | 优先消除动态工具对共享数字快照的依赖。建议工具只接受完整 Task/Run ID，工具查询不覆写人类 `/schedule` 的选择快照；或设计显式快照令牌绑定原目标 | `scheduled-task-service.ts:439` 将 runs(A)、runs(B) 写入同一个 Conversation+Actor 的 `runSnapshots`，`:575` 的数字解析只取最后一份。工具结果复用 `conversation-scheduled-task-command-format.ts:50`、`:66`，两份列表都给出序号并允许按序号 retry。当两项均 uncertain 时，`retry("1")` 可领取另一项并在 `scheduled-tasks/sqlite-store.ts:460` 解除其 uncertain。Actor 检查和调度串行锁不能识别这个选错目标；单纯串行工具执行也不能区分两份同号结果。旧共享快照已存在，0.164 动态工具并行使隐含串行使用假设不再成立 |
| 保存的 Fast/Ultrafast 未实际生效，却被设置通知显示成当前执行档位，并进入偏好或计划任务快照 | 在 Client→Routing 稳定合同区分已选档位与有效/未确认档位；设置通知更新选择，展示不得冒充实际生效。任务和偏好分别明确固定用户选择还是当前有效值，不清除上游保存选择 | 0.164 `core/src/session/mod.rs:925` 保存原始选择，`session/session.rs:664` 的有效快照仍过滤；`app-server/src/bespoke_event_handling.rs:1249` 又用 selected 值覆盖设置通知。本地 `notification-thread-state.ts:103`→`thread-state-sync.ts:30`→`router.ts:334` 混用同一 serviceTier；`core.ts:568` 及 Surface 显示 Fast，`model-selection-service.ts:514` 捕获偏好，`gateway-component-graph.ts:1042`→`scheduled-task-service.ts:287`→`scheduled-task-executor.ts:251` 保存并重传。实际请求仍由上游过滤，未发现绕过能力；旧版显式设置亦有潜在混淆，新版扩大到启动配置与历史恢复。`thread/read` 现有快照不足以读回有效 tier，不能只凭 model/list 推断 feature 允许 |
| 新学术套餐会导致额度读取失败、账户与额度通知丢弃，并影响快照及 Luna Reserve 后台轮询 | 同步新增 `sci`、`sci_plus`，不能回退成其他套餐或推断权益 | 上游 `app-server-protocol/schema/typescript/PlanType.ts` 新增枚举；本地 `src/codex-client/account-adapter.ts:231`、`:383` 与 `notification-parse-helpers.ts:36` 使用白名单。实施须同步 `application/account-port.ts`、`conversation-core/events.ts` 的套餐类型、查询与通知解析；下游 `provider-account-service.ts`、`luna-reserve-service.ts:381` 和 `bootstrap/gateway-component-graph.ts:2200` 共用该转换。Surface/WebUI 已可显示原始字符串，正式标签另须补齐中英文字典 |
| Hook 目录包含模型请求前后事件时，整个 `/hooks` 查询失败，依赖目录的管理操作受阻，完成通知被丢弃 | 同步 `preModelRequest`、`postModelRequest` 两处白名单，保留现有信任、启停确认和 hash/version 校验 | 上游 `v2/HookEventName.ts` 新增枚举；本地 `hook-adapter.ts:9`、`:41` 在 `entry.hooks.map(toHookEntry)` 中抛错，影响详情、trust/enable/disable 预览、确认及回读；`notification-conversation-events.ts:166` 另行过滤完成通知。Application/Core 的 eventName 已为 string，Surface 按字面显示，这些边界无需再引入枚举 |
| Plugin 内容变化能使 Hook 信任失效，原有统一提示却称哈希不覆盖脚本内容 | 区分普通配置 Hook 与 Plugin Hook 的信任文案，并调整 modified 的说明；保留 opaque currentHash 透传、复核及写后回读 | `hooks/src/engine/discovery.rs:730` 返回 declaration/content 组合指纹，`app-server/src/config_manager_service.rs:364` 负责拆写，`hooks/src/engine/plugin_trust.rs:51` 执行时验证。`surfaces/conversation-hook-command-format.ts:59` 和 `docs/user-guide.md` 的旧说明须同步调整。内容指纹是 best-effort source identity，排除虚拟环境、字节码等运行产物，不能承诺所有依赖完整性；Gateway 不自己扫描或拆 hash |

套餐修复还必须覆盖 `application/conversation-event-coordinator.ts:89` 的账户通知消费：
`account.updated` 触发 Luna Reserve 账户状态清理，通知被丢弃会跳过这一步。
账户快照只有成功读取才更新，失败保留旧观测时间，不能当成刷新成功。`limits_json` 为 JSON
载荷，不需要为新增套餐改变指标数据库结构；Plugin 的 eligiblePlanTypes 本来就是字符串标签。

另有一项较低优先级的展示缺口：上游 `protocol/src/openai_models.rs:790` 新增
`model_messages.permissions.approved_prefixes`，缺省/null 使用内置文本、空字符串抑制该段。
现已补齐 `runtime/model-catalog-presentation.mjs` 的只读投影及 WebUI 中英文标签，官方和第三方
提示词查询共同展示此项，保留空值含义；不修改模型模板或写入权限。

公开 CLI 合同已由精确目标 CLI 刷新：项目实际转发参数的快照仅版本变化。
`cli/src/main.rs` 新增 `migrate-nfs-db`，上游明确拒绝其 remote 模式；本项目不开放或执行该数据库迁移。

### 明确收益与随 CLI 采用的变化

| 用户或管理员得到什么 | 决策和本地入口 | 固定源码证据及限制 |
| --- | --- | --- |
| 恢复会话、回退历史后保留已选设置 | 随 CLI 采用；保持 Client 恢复请求不注入全局模型默认值，Router 从权威响应刷新设置 | `app-server/src/request_processors/thread_processor.rs` 恢复 service tier、reasoning summary、personality，Revert 重建配置保留当前模型等；`persisted_resume_settings.rs::latest_persisted_model_settings` 按 Thread 身份选择历史快照。本地 `src/codex-client/client.ts::resumeThread` 和 `src/session-routing/router.ts::resumeInWorkspace` 已遵循这一方向。历史压缩查找修复亦拟随 CLI 采用，不读取或复制官方会话文件 |
| 长会话压缩失败时避免残缺摘要污染和 panic | 随 CLI 采用，不在 Gateway 修补官方历史 | 官方 Release 的 #53932、#55581；本轮未复现压缩失败。Core 仍只消费官方 Item/Turn 状态，不将上游修复当作本地补偿成功 |
| 沙箱失败后的提权重试接受新的自动审批 | 随 CLI 采用，保留现有安全摘要和审查次数语义 | `core/src/tools/orchestrator.rs` 不把 Guardian 首次批准当作更高权限重试的授权，并按实际升级权限重新审查；本地 `notification-review.ts` 与 `bootstrap/auto-approval-review-notifications.ts` 按独立 review ID 消费、去重，不把同一工具的多次审查合并为一次，也不扩大人工授权范围 |
| 多个计划任务工具请求不必互相等待 | 在修复上表目标选择歧义后采用并行语义，保留每请求授权、确认和取消 | `core/src/tools/handlers/dynamic.rs::supports_parallel_tool_calls` 新增 true；本地 RPC 和每调用 AbortController 的身份隔离可保留，但这不能证明共享选择快照安全。创建、删除仍须各自确认；并发提交和乱序取消列入升级验收，不承诺模型调用顺序等于写入顺序 |
| CLI 跨子命令配置覆盖不丢失，原生 TUI 操作更方便 | 随 CLI 采用；继续使用 `codexc remote`，不复制 `/presets` 或原生 `/model` 到渠道 | `cli/src/config_override_args.rs` 收集各层配置覆盖；Release 的行内模型/权限选择、图片预览和排队权限修复属于 TUI。需以目标 CLI 刷新合同并观察 Remote 路径 |
| 官方工具目录和 MCP 凭据刷新更高效 | 随 CLI 默认采用，不增加本地凭据存储或模型协议转换 | `features/src/lib.rs` 将 `incremental_tools` 和 `mcp_oauth_refresh_coordination` 设为 Stable/默认开启；`core/src/session/step_context.rs:53` 还要求 use_responses_lite。本地 `app-server-service-runtime.mjs:557`→`third-party-model-catalog.mjs:64` 将第三方运行目录设为 false，因而不会仅因升级把 Lite 私有工具项送入第三方 Chat/Responses 桥。官方与第三方仍须分别验收 |
| 平台安全与后台资源管理改善 | 随 CLI 采用，不改 Gateway 服务所有权 | Release 的 macOS 路径别名/符号链接检查、Windows 代理认证、远程凭据遮蔽、daemon 日志和安装目录清理属于对应上游执行链路；不能算作 Gateway 自有代理、日志或服务修复。本轮未做各平台实机观察 |

### 暂不接入的能力

| 用户价值 | 决定与理由 |
| --- | --- |
| 导出本机诊断 ZIP，便于排障 | 暂不接入新增稳定 `feedback/save`。渠道没有获授权的诊断导出入口；诊断可能包含敏感材料，不能把新增方法直接暴露给外部 Actor |
| 在原会话之外生成实验样本或预测结果 | 暂不接入实验 `thread/sample`、其取消接口及预测分支 MCP 开关。当前 Thread/Fork/Queue 合同不需要这些能力，不扩大受控例外 |
| 用文件引用表达生成图片及其输入图 | 后续按用户选择接入第一阶段：在所属 Thread/Item 内存事件中原样保留 `fileId`；飞书/Telegram 对仅有引用且已完成的图片明确提示内容不可获取，持久输出移除引用并保留该状态。有 `savedPath` 继续沿原有图片校验、快照及发送链路；微信保持过滤普通操作事件。尚不接入文件解析、下载、Base64 回退或模型回传，也不传播 `inputImages`。上游默认 App Server 使用内联附件存储，UI 引用与 Core 模型图片准备分开；协议兼容不等于已验证远端文件解析或实际生成发送。 |
| 解释或展示 MCP 工具列表扩展元数据、管理 Desktop 存储要求 | `McpServerStatus.toolListMeta` 后续按用户选择仅在详情链路内部保留，见下文“MCP 工具目录元数据内部透传”记录；仍不解释键或展示，概览不携带。`ApplicationRequirements.storage` 的 defaultProjectParent/projectlessWorkspaceRoot 是 Desktop 存储位置，不是文件系统权限；Client 的 configRequirements 投影不消费 application，不改变 Gateway Workspace Registry 或 StateStore |
| 为请求附加 Responses 客户端元数据或语音产品会话 ID | 不接入实验 `TurnStartParams/TurnSteerParams.responsesapiClientMetadataPatch`、`ThreadRealtimeStartParams.voiceSessionId`；现有调用没有消费者，也不在受控例外内 |
| 使用冻结云技能目录、启动配置发现、运行时注册、WebSocket 压缩或跨执行环境复制文件 | 当前共享本机 App Server 路径无对应需求，不主动启用实验功能或扩大初始化协商；继续原有实例租约与服务生命周期 |
| 迁移 NFS 上的官方 SQLite 数据库 | 不接入、不执行实验 `migrate-nfs-db`。官方数据库由 App Server 管理；若以后确有运维需求，先独立制定备份、恢复与授权方案 |

### 生成图片引用第一阶段接入

后续授权范围为实时 Item 通知的引用兼容与内容不可获取提示。`fileId` 不进入模型输入、
下载调用或持久载荷；App Server 历史读取没有新增图片引用重放，Journal 仅恢复提示状态。
有路径的图片沿用既有快照和发送合同，不增加存储版本或隐式迁移。

直接运行通知适配→Core→输出快照/解码，观察到非空引用原样保留、持久载荷移除引用、
恢复后保留不可获取状态；空值、非字符串、外部伪造状态不被采纳，未绑定 Thread 不输出，
进行中与失败状态不误报图片已生成。子代理独立审查了来源、路由、历史与投递边界。
本地截获平台端口的飞书/Telegram `Outbox.deliver` 观察覆盖 full/compact/hidden、实时与恢复、
路径优先、取消及平台端口失败：引用型完成结果只产生固定文字提示；有效 PNG 路径仍提交图片；
取消不调用发送端口，发送失败不产生 confirmed 检查点；非法相对路径不回退引用。微信继续过滤。
这些是隔离的入口运行观察，没有真实模型生成或平台外发，远端附件解析仍未实现和验证。
重复上游完成通知可能重复投递，沿用既有语义，不承诺按 Item 恰好发送一次。
提交前复审补齐 Telegram started→completed 的显示收尾：已有运行中操作记录时，
完成事件更新同一记录为内容不可获取提示，避免独立通知后仍留下运行中状态。
直接运行真实 Outbox 入口并截获平台端口，观察到一次运行中消息发送、一次同消息编辑，
完成投递检查点为 started→confirmed；没有实际外发。

#### 部署后真实生图观察

用户报告部署重启后，于 2026-10-23 再次执行内置 `image_gen.imagegen`，生成橘猫窗边看雨图片，
用户确认飞书收到。调用转储批次 `openai-2026-10-23T12-43-02-889Z-340218083288114190300152994059562140568`
的第 7 次调用为 `POST /images/generations`，请求模型 `gpt-image-2`，HTTP 200、completed，
耗时 27.45 秒，响应 4,138,070 字节；工具返回本地图片保存目录。
这里的部署状态来自用户报告，未独立核验运行产物的提交身份。

生图轮次 `01a168c9-d09f-7351-b8f2-7b172efe6cb7` 的调用 #8 含一张内嵌图片、无 `file_id`；
下一轮 `01a168ca-9e6a-7ca1-bad5-502f793bb205` 的调用 #9 不含内嵌图片或 `file_id`，
其 `previous_response_id` 精确指向 #8 的响应。两条请求读取均未截断，确认本次生成图片只补入一次，
下一轮使用响应接续，没有重复上传。此证据不代表所有未来轮次或上下文重建场景。

真实生图与用户确认的飞书送达已观察；本次原始图片完成 Item 的 `fileId`/`savedPath` 字段未直接读取，
因此不能将该观察认定为仅引用分支的线上验收。运行配置为 `operation_updates = "compact"`；
飞书实现不展示普通操作的 running 状态，但本次日志不足以单独解释完成摘要未显示的原因。
本地磁盘保存、客户端附件引用、模型图片输入与 `previous_response_id` 接续是不同合同；
后续继续核对附件解析入口，不把已有本地文件或响应接续误称为可解析的 `fileId`。

### 全链路关联审查覆盖

以下记录本轮审查的输入、处理和最终消费关系；“未发现需调整”仅指这些固定源码路径，
不等于已经运行新版本。协议形状审查复用仍有效的前次证据，关联语义由本轮补全。

| 边界 | 已核对的链路与结论 | 剩余风险或适配范围 |
| --- | --- | --- |
| 会话恢复与回退 | `thread/resume` 无模型默认覆盖→`thread-adapter` 权威响应→Router 绑定/目录/权限校验；Revert 的历史 summary、分页游标、确认快照及 Queue 指纹继续保留。上游 Thread Queue/状态/read-state 实现两版相同，新增 sample 被 loaded/list 隐藏 | 不复制上游历史或新增平行会话索引；服务档位的 selected/effective 分叉必须按上表调整 |
| 通知、终态与取消 | Client 同订阅 started/completed 证据→Core 观察窗口→绑定与渠道归约；断线、取消订阅及 Thread 关闭使旧窗口失效，旧 Turn 终态不结束新 Turn。上游 outgoing 克隆优化未改显式目标顺序；压缩只在成功后提交历史，本地按完整压缩 Item 计数，不依赖被删除 warning | 新版真实断线、压缩失败、Lite 中断与原生 TUI 并用尚未观察；不得用 RPC 返回代替权威终态 |
| 审批及指标 | 上游提权重审重新分配 UUID→Client 安全摘要→Bootstrap 精确父子归属/去重→SQLite 按 Thread/Turn/review ID 保存→Surface；同一 Item 的独立审查不会合并。内部 attempt retry 仍只对应一个 report，不建立人工交互或结束原 Turn | 本地 durationMs 仍由通知墙钟差计算，不能宣称已采用上游内部的单调耗时修复；真实提权拒绝、重审与渠道结果待观察 |
| 动态工具与计划任务 | Provider 命名空间请求 ID→唯一 Actor/前台 Thread 校验→独立取消→Application 令牌→Store/调度领取→Executor 权限与最终 RPC 提交守卫。创建/删除须人工确认，后台不注册工具且拒绝递归，Store 对容量/重叠/uncertain 原子裁决 | 身份、取消及容量保护不解决共享序号选错目标；工具接口、工具结果、人工命令快照和文档须一起调整 |
| 账户和模型目录 | 账户查询/通知→Application 清理与快照→后台轮询→指标 JSON→渠道/WebUI；model/list 每次按目标 Provider 查询。上游登录/登出后失效模型目录，瞬时刷新失败保留同身份最后成功目录及原 freshness，认证失败清空显式 Provider 目录 | 套餐值按上表全链补齐；非空模型列表不证明远端刷新成功。新 approved_prefixes 展示遗漏单独处理，不改用户模型模板 |
| Hook/MCP/Plugin/Skill | Hook 目录、预览、确认、配置版本/hash 复核、原样写入、写后回读和跨实例配置修订；MCP 带 Thread 查询及 loginId/Provider/Thread/server 关联；Plugin 仅 installed/mention；Skill 仍筛 cwd/enabled/user-repo scope 与非 Plugin 直接安装项 | Hook 新事件与信任文案必须调整；不解析 toolListMeta、不接入 Desktop storage、不扩大 OAuth、市场安装或 Skill 别名。企业认证与跨实例刷新尚无运行观察 |
| 共享服务与 Transport | Runtime 主/隔离实例仍使用 `app-server --listen unix://...`，Supervisor 与 Remote 持有租约；Unix/Windows Proxy 客户端均未请求 `x-codex-app-server-compression`，0.164 服务端仅在客户端明确协商时启用 zstd，因此继续文本协议。Socket 受保护路径与绑定所有权规则保留 | 不需因服务端新增压缩而添加本地解码器。上游 TUI 仅将通过校验的官方默认 Socket 识别为 LocalDaemon；项目默认路径不同，未改变默认 Remote 所有权。若管理员把 socket_path 指向官方默认地址，须单独确认 TUI 的本地配置/恢复语义，不以默认路径的结论覆盖这种配置 |
| Provider 请求与指标 | Runtime 第三方目录关闭 Lite→现有 Responses/Chat 桥；官方 HTTP/WS 路径和端到端头转发、响应状态/Usage/配额观测保留。上游 prompt_cache_key 可省略且与 session-id 分开，本地 Chat 转换已允许省略；模型请求归属仍取受控 Thread/Turn 元数据，不靠 cache key。model-provider-info 的超时/重试默认未变 | 不新增代理端点或替上游重试；认证构造失败可在请求到达代理前结束，此时只能由 Turn 错误反映，不能虚构模型请求指标。运行时注册为默认关闭的实验能力，本轮不启用 |
| 图片与可靠投递 | 上游落盘/历史投影→Client savedPath→Core→共享文件校验及有界快照→飞书/Telegram 图片出口；微信保持现有事件过滤与独立显式图片发送 | fileId/inputImages 不扩大本地能力；三个平台真实网络投递未观察 |

### 上游数据处理与回退约束

本次源码适配没有读取或修改用户数据。未来首次运行 0.164 时，Plugin Hook 的
列表发现或执行可能通过 `PluginHookTrust.matches_hash`→`migrate_legacy_trust` 为旧信任建立
**用户配置所在目录的 `.hook-trust/<identity>`**；实际位置由配置层的 User 文件决定，不能只假设
主 Codex Home 根目录。显式信任还会由 App Server 写入 `hooks.state.*.trusted_content_hash`。
因此正式升级不能承诺“完全不产生用户数据变化”。

- **升级前**：确认实际用户配置与 Profile 文件、对应 `.hook-trust` 目录及使用它们的 App Server；在另行授权的停写窗口，以私有权限做一致备份并记录原运行状态、CLI 版本和受管源码版本。本轮不执行停服或备份，也不解析内部会话文件。
- **升级中**：由官方 App Server 管理信任基线，Gateway 不复制迁移逻辑、不清理旧基线、不批量重新信任；旧内容无法确认或配置发生变化时保留数据并停止相关操作。
- **失败恢复与回退**：保留新旧程序、备份、现有配置及新信任产物，先确认全部相关写入方停止，再决定恢复哪一个一致版本；不直接覆盖升级后新增修改或删除 `.hook-trust` 来绕过检查。旧版 HookStateToml 从源码看可忽略新增字段，但回退会失去新版内容校验，不等于安全语义保持；尚未实际验证回退。
- **数据库边界**：两版 `state/migrations` 无新增 SQL 文件，本轮发现不要求更改 Gateway StateStore 或指标 Schema；上游 SQLite busy retry、journal 保留和 NFS 回收策略不是本地迁移授权。服务档位方案也不得自行改写已有任务/偏好来猜测历史意图；若实施决定改变磁盘合同或恢复语义，先补充具体数据方案。

### 审查证据与验收范围

本轮已核对官方正式 Release、两个固定版本的源码、随仓 App Server 文档、签入的 TypeScript
Schema，以及受影响的本地消费者。随后使用精确 CLI 的 `--experimental` 生成结果复核：
新增八个生成文件，新增三个 Client Request 方法：稳定 `feedback/save`，
实验 `thread/sample`、`thread/sample/cancel`；没有新增 Server Request、Server Notification 或
Client Notification 方法。App Server README 两版相同，不能替代类型与源码审查。

动态工具已沿 RPC 派发、每调用身份、Application 确认令牌和调度提交边界检查；
`scheduled-tasks/scheduler.ts::runManual` 在等待串行队列和容量检查后、claim 前复核调用有效性。
Guardian 已核对上游重审权限与本地 review ID 投影；恢复已核对请求省略覆盖、权威响应及绑定校验。
这些是源码结论，不是在线模型、渠道投递或竞争条件的运行观察。

验收范围如下；是否实际观察以本节的实施结果为准，不以源码分析代替：

1. 用隔离的精确 `0.164.0` CLI 运行项目升级 dry-run、协议生成、公开 CLI 合同刷新及现有静态门禁；逐项复核生成差异，再更新当前支持矩阵和版本索引。
2. 先落实动态工具精确目标选择、服务档位语义分离、套餐及 Hook 全链适配，再刷新 CLI 合同；补齐 Plugin 信任文案和上游数据计划。复核图片仍可从 `savedPath` 形成可用产物，不依赖现已可缺省的 `result`。
3. 观察显式恢复、断线恢复与 Revert 后的模型、思考等级、service tier、权限和原生 Queue；包含历史设置与全局默认不同、保存的档位不被当前模型/feature 支持的场景，确认状态展示及计划任务捕获语义一致。
4. 观察并行 `schedule_task` 的独立确认、逆序完成、单调用取消、整轮中断与容量限制；特别用两个不同任务的同序号 uncertain Run 验证不会选错目标，并观察工具查询与人工 `/schedule` 交错。确认取消不会误伤另一调用或继续提交迟到写入。
5. 观察 Guardian 拒绝和提权重新审查的独立结果，以及普通 Turn 的实际回复与图片输出；确认新增套餐的查询、通知、快照及账户状态清理，新增 Hook 查询/管理/完成通知及 Plugin 内容变更后的信任结果。不新增或修复测试文件。
6. 对 Windows/macOS、企业 MCP、远程 executor、真实平台发送等不可用环境明确留待验证；不把 Linux 静态检查当作这些路径的成功证据。

源码适配阶段未访问用户 Thread/数据库，未执行发布和部署；用户部署后的专项观察另见下文。

### 实施结果

- 动态工具仅接受完整 Task/Run ID，工具 list/runs 不读写人工数字快照；人工 `/schedule` 继续使用自己的列表序号。
  修复前隔离的实际 Store/Scheduler 路径复现 runs(A/B) 后按 A 的 `1` 却派发 B；修复后经真实工具 Handler、
  Application 和内存 SQLite 观察到完整 ID 分别派发 A/B，工具查询不覆盖人工选择，数字、短 ID、名称及跨 Actor ID 被拒绝。
  创建/删除仍先预览、由人工确认才写入；重复令牌拒绝，Turn 结束撤销未交付的预览，容量不足不解除旧 uncertain Run。
- 档位合同拆为用户选择、选择是否已知和有效档位。通知只确认选择，生命周期空值仅确认有效 Standard，
  不反推选择；竞争通知、断线及提交后无法确认的有效值显示未知。固定保存偏好/任务时拒绝未知选择，自动空闲释放保留绑定，普通对话仍可继续。
  新显式选择保留提交前能力检查，恢复的已保存选择交由上游过滤；新任务已确认的 Standard 编码为 `default`，旧任务 null 仍继承，未迁移数据。
  同一 Thread 显式恢复不固定捕获旧选择，未知时仍可恢复，已有待提交思考等级保留；目标有原生 Queue 时沿用清理待提交偏好的既有规则。
  隔离的实际 Router/Core/ConversationService 入口观察确认：未知选择仍可提交普通消息；`/fast off` 后提交显式 default；
  设置通知在收件时同步归约，异步处理不重放旧设置；竞争通知不被生命周期响应覆盖，断线后选择失效。
  257 条其他 Thread 设置变化超过有界记录容量后，恢复不再保留旧有效 Fast 确认；已知选择仍保留。
  未绑定的新显式选择在目录移除档位或功能关闭时分别拒绝，历史选择保持原值；空闲释放返回 busy 且不取消订阅，
  提交失败保留 pending，撤权后不新增默认值写入。上述端口采用隔离注入，不等于在线模型或渠道实测。
- 独立复查补齐四个关联缺口：首次绑定的 capture/restore 保留新显式选择的进程内来源，失败重试仍复核功能开关与模型目录；
  `turn/start` 成功响应仅在提交前设置快照仍为当前值时更新选择；Luna Reserve 在选择未知时延后恢复，保留原模型记录；
  设置通知及 Luna Reserve 的设置观察移到同步收件阶段，避免旧队列事件重新确认过时选择或覆盖断线状态。
  来源标记没有进入持久化 Schema，同步观察只更新内存状态及计时器，不等待平台输出。
  经实际 MemoryBindingStore、Router、ModelSelectionService、Core、ConversationService 及展示函数的隔离调用，
  首次提交失败后关闭功能或移除档位均返回 `model.selection.expired`，没有新增 Turn RPC；恢复能力后重试成功。
  迟到成功响应遇新通知仍显示“已选 Ultrafast；有效档位未知”，遇断线仍显示“未知（用户选择未知）”；
  连续通知的旧队列事件与断线后队列事件均未覆盖最新状态。
  Luna Reserve 的隔离调用在读取前或读取中选择变未知时，后续均恢复 ordinary 模型及 fast 选择（两次设置写入、两条通知）；
  真实用户改选则保留用户设置（一次设置写入、一条通知），没有错误恢复旧模型。
  独立复查另沿动态工具授权/确认/取消与 SQLite 领取、协议新增字段的实际消费者、套餐/Hook/图片及所有档位展示路径核对合同，
  未新增其他确定性代码修复；当前专题的固定源码基线已更新，历史实际观察仍保留当时版本。
- SCI/SCI Plus 已贯通稳定类型、查询与通知白名单、渠道及 WebUI 标签。隔离输入观察到两种套餐均保留原值并显示正确名称，
  账户及额度通知均进入对应事件；未批准套餐仍拒绝。没有使用真实 SCI 账户，未据此宣称额度后端或 Luna Reserve 在线轮询已验收。
- 使用独立 Codex Home 和精确 0.164.0 的真实 App Server，经项目 StdioTransport、Client、Hook 用例及文本渲染入口，
  列出了用户来源的两个新事件和插件来源的 PreModelRequest；预览→确认→写后回读返回 trusted，重复令牌报 `hooks.review-expired`。
  插件信任值含 declaration/content 两部分，修改临时插件 README 后再次读取返回 modified，所有自有进程已关闭。
  Hook 完成通知的隔离输入分别产出两个新事件，未知事件仍忽略；未触发在线模型实际执行 Hook，未观察多 Provider 刷新。
- `approved_prefixes` 的共同投影保留空字符串、忽略缺省/null，非字符串明确拒绝；WebUI 中英文标签已同步。
  未修改用户模型目录，未把只读投影观察当作浏览器端交互验收。
- 图片消费以仓库内已有 PNG 进行隔离观察：传入仅含 fileId 和 savedPath、没有 result 的 Item，Client 仍投影路径，
  持久输出快照保存 1166 字节 PNG 并移除原路径，不暴露 fileId；Telegram 允许持久投递、微信按既有策略忽略。
  相对路径与非图片文件分别被拒绝为 invalid-path、unsupported-image；未调用真实图片模型或平台发送。
- 真实 App Server 在全局选择 Fast、功能开关关闭的临时配置下返回 `serviceTier: null`、idle Thread，印证不能从有效空值反推用户选择。
  模型端点仅指向不可用的本地端口，未使用用户凭据或调用付费模型。

精确协议、公开 CLI 合同、类型与版本、模块边界、Lint、Gateway/WebUI 构建、文档索引、中英文键及 Shell 语法检查已执行；
首轮档位提交检查和通知竞争窗口修改已补做类型、Lint 与 Gateway 构建复核；独立复查补充修改的最终静态状态以正常提交门禁结果为准。
统一报告位于本轮临时目录 `/tmp/codexc-0164-validation/validation-results.json`，其中文档阶段按脚本设计跳过，文档检查随后单独通过。
静态工作流状态不代替上述行为证据。
上述实施阶段尚未观察真实模型回复、Guardian 提权重审、在线动态工具整轮取消、原生 TUI 与渠道并用、真实图片生成/平台发送、企业 MCP、
Windows/macOS 服务及回退恢复。部署后的新增证据及仍未验证的边界见下节，不追溯改写实施阶段的观察。

### 2026-10-23 部署后验收

用户完成部署后，对提交 `52917ac6976d9d66e7b5b6fd61183397e19630de` 对应的安装产物和运行实例进行审查。
本节记录实际命令输出及协议观察的摘要；此阶段验收未修改全局配置、原有会话或重启共享服务。
后续原生 TUI 补验经用户单独授权保存一条验收目录信任记录，详见下节。

- **版本和产物**：全局 Gateway、CLI 及实际 App Server 握手均为 `0.164.0`；运行中 App Server 二进制与安装文件一致。
  按 package.json 打包清单逐字节核对 4,493 个文件，无缺失或差异。使用已部署 CLI 执行 `npm run protocol:check`，
  生成类型与公开 CLI 合同均通过。Doctor 返回 38 项成功、0 项失败。
- **服务及渠道**：Linux 的 App Server、Gateway、Model Relay、WebUI 均运行，验收前后 PID 未变，自动重启计数均为 0。
  本次 Gateway 启动日志观察到飞书 `text.completed/final_answer` 与 `turn.completed` 的投递任务结果均为 `completed`。
  一条启动期 `account.updated` 展示因归属校验取消，观察窗口内未重复；日志不足以确认具体变化字段，不认定为升级缺陷。
  WebUI 首页及引用的 8 个静态资源返回 200，无令牌 API 返回 401；没有浏览器交互或管理写入验收。
- **双连接档位**：使用已安装的 Client、Router 和同步归约模块，连接真实 App Server；绑定只存在于独立的 MemoryBindingStore。
  第二连接修改专用 Thread 为 Fast 后，通知实际值为 `priority`；改回 Standard 为 `default`。
  连续通知后保留最新 Standard，设置通知不确认有效档位。关闭自有连接并显式调用订阅失效入口后，选择变未知、有效值清除；
  重新连接恢复后取得权威 Standard。该观察不是网络意外断线，也未操作原生 TUI 界面。
  初次恢复空 Thread 返回 `no rollout found`，包括 ephemeral 和尚未持久化的普通 Thread；没有将这些失败标为通过。
  后续通过官方归档/取消归档持久化本任务空 Thread，才完成无模型请求的恢复观察。
- **一次真实模型请求**：用户另行明确允许可能消耗额度的请求后，仅提交一次 `gpt-6.1-sol`、Standard、`low` 请求，
  精确收到 `CODEXC_0164_OK`；无工具调用、审批请求或错误通知，Turn 为 `completed`。
  验收 Thread 为 `01a16848-32de-71a3-96e8-4e0875761fa7`，Turn 为 `01a16848-32ec-73d3-b4b3-ce86da19d92b`。
  官方历史回读仅有该 Turn，记录耗时 5,764 ms；完成后 Thread 为 idle、activeTurnId 为 null。
  关闭连接并显式失效订阅状态后选择未知，重新连接恢复后仍为 `low` 和 Standard，且重新确认有效档位。
  此请求通过已安装协议客户端执行，没有经过生产 ConversationService 的消息入口或发送到聊天渠道；渠道投递证据来自前述真实会话日志。
- **清理与限制**：三个持久验收 Thread 均通过官方接口归档，ephemeral 验收连接已取消订阅，所有自有连接关闭、临时工作区清理。
  当前计划任务配置关闭，未启用或派发任务。Luna Reserve 真实额度切换、Guardian 提权重审、在线动态工具整轮取消、
  原生 TUI 与渠道并用、新 Hook 在线执行、多 Provider 刷新、真实图片生成/发送、企业 MCP、Windows/macOS 服务及回退恢复仍未观察。
  已有隔离证据仅在输入和实现未变的范围内复用，不将部署健康或一次普通请求扩大为这些边界的验收。

### 2026-10-23 Queue/Revert 与原生 TUI 补验

仍以 `52917ac6976d9d66e7b5b6fd61183397e19630de` 的实现和 `0.164.0` CLI 为输入；没有新增或修改测试文件，
没有修改生产代码、启用计划任务、增加外部模型请求或重启共享服务。

- **Queue/Revert 联合观察**：使用独立临时 Codex Home、真实 App Server、项目 StdioTransport/Client 和回环模拟 Responses SSE 端点。
  第一 Turn 完成，第二 Turn 保持活动时入队 A/B、编辑 A、排序为 B/A；重复 ID 排列返回 `reorder-conflict`，活动时启动队列返回 `busy`。
  中断第二 Turn 后两项仍在，编辑结果和顺序保留。将当前设置改为 medium/Standard 后 Revert 到第二 Turn 之前，
  官方历史只剩第一条 completed，Queue 仍为 B/A，本地响应端点请求数仍为 2，未因 Revert 自动派发。
  Resume 返回 medium/Standard，随后两项被上游自动派发并完成，Queue 清空；后两次本地响应请求实际携带 medium。
  观察覆盖 Client→官方 Queue/历史/设置→通知与回读，不包含渠道的 Revert 预览/确认、真实模型或生产数据库。
  自有 App Server、HTTP 端点均关闭，临时数据清理。
- **原生 TUI 与第二客户端**：通过 `codexc remote` 租约入口恢复上一节真实请求的同一个验收 Thread。
  首次遇目录信任和 Hook 审查时未接受信任并退出；临时信任覆盖被自动审批拒绝，命令未执行。
  用户随后明确允许信任空目录 `/tmp/codexc-live-turn-4eoX07`、拒绝 Hook，再次启动时按该范围确认。
  TUI 显示既有 `CODEXC_0164_OK` 和 low；另一协议连接把该 Thread 改为 medium/Standard 后，TUI 底栏实际更新为 medium；
  恢复 low/Standard 后底栏也恢复 low。TUI 正常退出，官方回读仍只有原来的一个 completed Turn，Thread idle、无活动 Turn。
  此证据覆盖原生界面接收另一客户端设置，不等于生产聊天渠道与 TUI 并发提交或 Revert 确认的联合验收。
  验收 Thread 已重新归档、目录已清理，用户授权保存的该目录信任记录保留；未确认新 Hook 信任。
- **备份和回退状态**：只读核对安装/更新代码及已知配置目录、Gateway backups 目录的候选名称和修改时间，未读取备份内容。
  观察到的候选早于本次升级，未取得本次升级前配置、Profile 与 Hook 信任目录一致备份的证据；不能据此断言其他位置没有备份。
  源码更新保留旧源码、已知指标迁移产生数据库备份，不等于自动备份上述用户配置。
  状态保留为“升级前备份未确认、回退演练未执行”；下一步需取得实际备份位置和对应时点，再在另行授权的维护窗口核验恢复。
- **该阶段服务状态**：四个共享服务 PID 未变，均运行且自动重启计数为 0。继续补验及剩余边界见下节。

### 2026-10-23 确认、断线与失败路径补验

用户继续授权验证后，沿用上述代码和 CLI 基线。使用真实隔离 App Server、项目实际模块、内存绑定与回环模拟模型，
没有新增外部模型请求、生产配置写入或服务重启，也没有新增测试文件。

- **Revert 应用入口及一次性确认**：经实际 ConversationCommandService、ConversationService、Router、Core、
  状态同步与事件协调链路，先完成两条 Turn，再从 `revert list` 生成预览。错误 Actor、错误 Conversation、
  已消费令牌均返回 `revert.confirmation-invalid`；撤销注入的 Actor 授权后拒绝执行。
  预览后新增活动 Turn 使旧确认失效；另一次预览后加入 `KEEP_QUEUE`，确认返回 `revert.concurrent`。
  重新预览显示一个受影响 Turn、一个 Queue 条目及正确活动 Turn；确认收到 `thread.reverted`，活动 Turn 为 interrupted，
  官方历史恢复到原两条 completed，Queue 保留。重复确认被拒绝；显式启动 Queue 后完成并清空，历史共三条。
  共四次本地模型请求，无外部调用。这覆盖共享命令入口和应用授权守卫，Actor 授权为隔离注入，
  不等于飞书、微信、Telegram 的真实身份鉴别、按钮回调与网络投递已验收。
- **意外断线和恢复**：在独立 App Server 前设置任务自有私有 Unix Socket 代理，仅切断该代理连接。
  实际触发一次 `onDisconnect`；原 App Server 及活动模型请求继续运行。Router 选择标为未知、有效值清除，
  待提交 high 偏好保留。断线期间第二连接将同一 Thread 改为 medium/Standard，重连 Resume 后取得新设置，
  high 待提交偏好仍保留。释放原模型响应后，收到与原活动 Turn ID 相同的 completed 通知，随后 Thread idle。
  总请求数始终为两次，没有重提活动请求。元数据 `thread/read` 不含 Turns，不能据其空 activeTurnId 确认活动身份；
  重连后未观察 started，Client 也未把该 completed 标为同订阅的终态证明，符合现有观察窗口约束。
  此处真实执行 Client 重连、Router 恢复及订阅失效回调，没有运行生产 Bootstrap 的整个自动重连协调器。
  首次准备时对目录未收录的本地模型显式选择 high 思考等级，返回 `model.current.missing`，已清理；
  后续改为恢复 pending 快照以观察断线保留，不能将此结果表述为显式思考等级选择成功。
- **新 Hook 未信任状态与请求终态**：独立 Codex Home 声明仅输出固定文字的 PreModelRequest/PostModelRequest，
  实际目录均返回 untrusted，警告和错误数均为零。保持未信任，不写 Hook 信任记录。
  本地模型依次正常完成、返回预设 HTTP 400、保持响应并由 Client 中断，实际终态分别为 completed、failed、interrupted；
  共三次本地请求、零 Hook 完成通知。该观察支持未信任状态下的通知行为，不证明已信任 Hook 的执行与完成投影。
  首次人工调用误读 ThreadSession 字段，官方拒绝缺失 threadId；修正调用后才完成上述观察，没有修改产品实现。
  用户此前拒绝信任 Hook 的限制继续保留，未把“允许验证所有”解释为重新信任用户 Hook。
- **清理**：上述自有 App Server、Socket 代理和 HTTP 服务均已关闭，临时目录删除；未读取官方内部会话文件。

该阶段仍未观察的边界及下一步（后续补证见“可行项扩展验收”）：

| 边界 | 当前限制与后续条件 |
| --- | --- |
| 生产计划任务、动态工具整轮并行取消 | 生产开关关闭；已有 Store/Scheduler/Handler 隔离证据，但没有生产动态工具全过程。后续需专用启用环境和任务投递目标，不能直接改变现有生产开关 |
| Reserve 真实额度切换、SCI 真实账户 | 本次没有对应额度状态或 SCI 账户；保留类型、通知、隔离恢复证据，待具备账户条件再观察 |
| Guardian 提权重审、压缩失败、Lite 中断 | 未构造对应官方运行条件；源码审查不能替代真实重审、长上下文与 Lite 执行观察 |
| 已信任 Hook 执行、多 Provider 配置刷新、企业 MCP | 保留此前隔离配置写入/内容变更证据；本阶段未信任 Hook，无多实例或企业认证验收环境 |
| 真实图片生成/发送、渠道按钮、WebUI 管理交互 | 已有图片消费与静态资源证据；没有指定本次图片发送目标或执行这些管理写入，不以内部入口调用代替平台实测 |
| Windows/macOS、远程 executor | 当前只有 Linux 环境；未扩展现有受控协议或把 Linux 结果外推 |
| 回退恢复 | 尚无本次升级前一致备份证据；先确认实际备份和时点，不能用升级后新备份伪装升级前状态或覆盖现有用户数据 |

这些项目保留为未验证，并不表示发现对应故障；本次补验未确认新的产品代码缺陷。

### 2026-10-23 可行项扩展验收

用户要求继续完成当前能做的验证后，以文档提交 `7b2d1374`、实现提交 `52917ac6976d9d66e7b5b6fd61183397e19630de`
和精确 `0.164.0` CLI 为输入继续补证。以下模型输出均来自回环模拟服务；没有新增付费模型请求、
用户 Hook 信任、生产任务启用、渠道外发或生产服务重启。未新增测试文件或修改冻结测试。

- **动态工具并行和取消**：真实 App Server 在同一 Turn 发出两个 `schedule_task` 请求，经现有 Handler、
  Tool Service、Application 和临时真实 SQLite。两个请求同时进入权限读取，先放行 B 后 A，B 先返回时 A 仍等待；
  结果携带各自 call_id 和不同确认令牌，确认前任务数为零，仅人工确认 B 后保存一条 B，A 单独取消。
  两个 rename 等待查询期间官方中断，收到 interrupted 后再放行，均失败且没有改名。
  同一 RPC 连接提前回答一项请求以模拟并发处理方解决，官方 Item failed 只取消该 Handler，另一项仍成功写入；
  没有将其描述为第二客户端的 `serverRequest/resolved` 实测。
  权限准备、首次归属检查、已生成未交付预览三个窗口中断后，分别没有交付预览、没有继续读取或执行、撤销真实令牌；
  该令牌随后确认返回 `scheduled-task.confirmation.invalid`。任务自有 App Server 真正退出后，等待中的请求也未继续执行。
  已提交的 SQLite 写入在取消后保留，Handler 明确未确认结果，不承诺回滚。
  两个真实 run 请求继续进入 Scheduler，第一项停在容量查询、第二项排队；中断后查询次数仍为一，
  Executor 执行数及持久 Run 数均为零。异步窗口由人工门闩控制，未观察真实模型自主选工具、生产确认控件或后台跨平台执行。
- **压缩失败与重启恢复**：先完成含 `ORIGINAL_USER_EVIDENCE` 和 `ORIGINAL_REPLY_1` 的真实 Turn，
  随后通过 Client `compactThread` 请求压缩。本地模型输出 `DISCARDED_PARTIAL_SUMMARY` 后断流，
  官方报告 `stream disconnected before completion: stream closed before response.completed`，压缩 Turn failed，
  未发出 contextCompaction 完成 Item。重启任务自有 App Server、Resume 同一 Thread 后继续成功，
  后续请求保留原用户输入及原回复，不含残缺摘要。共三次本地模型请求；未读取内部会话文件。
  此证据覆盖手动本地压缩失败，不能外推到远端 Lite 或所有自动压缩失败方式。
- **实际自动重连协调器**：使用生产 GatewayReconnectCoordinator、BindingRestoreCoordinator、ProviderRoutingClient、
  Client、UDS、Router 和 Core。已完成一轮的空闲 Thread 断线后，第一次握手的 connected 回调等待期间再次切断连接；
  两次真实断线、两次重连握手，只发出 lost/lost/restored，最终成功 attempt=2，旧代次没有恢复确认。
  恢复后 pendingBinding 和 isRestoring 均为 false，router.ensure 返回同一 Thread，下一轮真实完成；
  历史恰两条 completed，总共两次本地模型请求，恢复没有重放第一轮。
  绑定恢复端口首轮注入失败时，只重试恢复，不重复握手；这一端口重试观察与前述成功订阅观察分开。
  真实退避期间 stop 用时 2 ms，随后 650 ms 无新握手或 restored。
  保留真实退避计时、每次握手失败时再注入断线，第十二次在约 138 秒发生，最终握手 12 次、恢复 0 次、停止回调 1 次；
  重复断线未重置预算。关闭等待在途检查、握手和恢复，主动释放不重连，以及设置恢复再次断线均有隔离端口观察。
  当前 dist 与六个相关源模块的转译结果一致；未启动整个 GatewayApplication，额度预热、监管释放登记及交互取消端口为注入。
  自动恢复成功场景为已有历史的空闲 Thread；活动 Turn 仍只具有上一节 Client/Router 手动恢复证据。
- **空 Thread 恢复边界**：零 Turn 新 Thread 断线后，官方读取仍为 idle，但 Resume 返回 `no rollout found for thread id`；
  BindingRestore 保留绑定并安排 pending 重试，连接协调器同时可发布 connection.restored。
  因而连接恢复不能被理解为所有 Thread 已可用。主代理随后用另一真实隔离 Thread 显式失效订阅，
  实际 restoreSubscriptions 返回同一错误且 bindingRemoved=false；后续 router.ensure 返回 `conversation.busy`，
  文案为“会话订阅正在恢复，请稍后重试”。显式 newSession 后 ensure 创建了不同 Thread 并回读 idle，零模型请求。
  这是已复现的空会话恢复使用问题，涉及 `src/session-routing/router.ts` 的未订阅准入及
  `src/bootstrap/binding-restore-coordinator.ts` 的暂时失败重试。建议后续明确区分连接恢复与订阅不可恢复，
  提供显式新建的操作提示并评估重试收敛；不得仅凭错误文案自动删除绑定、改写历史或隐式创建替代会话。
  相关本地模块在上述两个提交间未变，这不足以证明上游未变或确定升级归因；本轮未据此修改产品实现。
- **人工审批与 Guardian 提权重审**：真实本地 Responses 工具调用进入 Client 解码、ApprovalCoordinator 和 Core，
  人工端口拒绝后协议返回 decline，命令 Operation declined，后续模型收到 `Rejected("rejected by user")`，Turn completed、Thread idle。
  未知 kind 的隔离输入同样安全拒绝。Guardian 由 stock CLI 自动发出真实审查请求，本地模拟模型返回结构化 deny 时，
  started/completed 使用同一 review ID，Client 投影 denied；没有进入人工审批请求。
  在任务临时 execpolicy prompt 规则和 read-only 沙箱下，安全 printf 写任务自有路径，首次实际审查输入为
  `sandbox_permissions=use_default`，review `a0854bf2-3ba0-4854-892a-c2df2edda477` approved（50 ms）；
  沙箱失败后的第二次同 Item 审查输入为 `require_escalated`，review `de0f3c97-a5f9-46cc-8eef-460cc0b92bdf` denied（52 ms）。
  两次审查具有独立 ID，没有合并或沿用首审批准；最终命令 declined、主 Turn completed、目标文件不存在。
  四次请求均为回环（主请求、两次 Guardian、主请求）；结构化审查决定由本地端点固定，不能代表真实审查模型判断质量，
  也未覆盖 Bootstrap 审查指标落库和真实渠道卡片。
- **多实例 Hook 配置刷新**：两个独立真实 App Server 共用任务临时 Codex Home，配置不同 Provider，
  经实际 ProviderRoutingClient 禁用临时 PreModelRequest 后，两实例均读到 disabled，刷新失败列表为空。
  提交前守卫拒绝时配置版本不变；人工注入 B 刷新失败后，返回 `refreshFailedProviders:["b"]`，B 后续操作也拒绝准入；
  恢复刷新端口后 B 成功回读新状态。旧配置版本写入被官方拒绝，未覆盖新状态。
  Hook 始终 untrusted，信任写入和模型请求均为零；只验证启停和刷新，不验证 Hook 执行。
  最初启动尝试退出码为 1，未取得根因证据，已清理；带启动诊断的后续完整观察成功，不把首次失败隐去或归因为产品缺陷。
- **真实浏览器管理路径**：使用独立临时 WebUI、空指标库和已安装 Chromium；Playwright CLI 仅临时安装，未改项目依赖。
  无令牌进入登录页，错误令牌被拒绝；正确令牌遇缺少指标库时显示服务不可用，创建临时当前 Schema 空库后登录成功。
  空闲设置预览取消后文件未变；显示详情从 compact 确认为 full，刷新仍为 full。
  下一次浏览器预览期间，用 CLI 共用配置模块先保存 compact，旧确认显示“配置或确认已过期”，文件和回读仍为 compact。
  计划任务保持关闭，未启动服务操作。此处竞争写入来自 CLI 共用模块，没有操作 CLI 菜单。
- **新增提示词浏览器展示**：临时模型目录的 `permissions.approved_prefixes` 经真实管理 API、模型详情及提示词页，
  显示中文“已批准命令前缀”；含 `<script>` 的输入保持纯文本，DOM 中没有对应脚本节点。
  改为空字符串并重新加载后显示“字段已提供，但内容为空”，没有冒充缺省或内置文本。
  隔离环境未运行 App Server，模型页面的 Codex 设置和 Provider 设置请求返回 503；提示词独立读取成功，
  不能因此声称整个模型管理页面无错误。浏览器快照与控制台输出保留在 `output/playwright/upgrade-0164-20261023/`（未纳入提交）。

上述动态工具实例、SQLite Worker、Scheduler、压缩及 Hook 实例、浏览器和临时 WebUI 均已关闭，
任务临时配置和临时浏览器工具安装均清理；保留的浏览器输出不包含用户凭据或业务数据。

扩展后仍未验收的条件与边界：

| 边界 | 已有证据与剩余条件 |
| --- | --- |
| 生产计划任务、真实渠道确认与发送 | 并行/取消已补真实隔离 App Server→业务模块→SQLite/Scheduler；生产开关保持关闭，未指定专用外发目标或执行生产任务 |
| 完整生产自动重连 | 实际协调器已恢复空闲 Thread 并继续完成下一轮；完整 GatewayApplication、监管释放状态、额度预热及活动 Turn 联合路径未全量运行，活动 Turn 保留此前独立恢复证据 |
| Guardian 后续消费与真实模型判断 | 协议、权限重审、Client/审批/Core 已观察；统计持久化和渠道卡片未因此验收，模拟 allow/deny 不证明真实模型判断 |
| Lite 中断、远端自动压缩 | 手动本地压缩失败及重启已观察；第三方路径按合同关闭 Lite，不为验收扩展现有功能或调用未授权远端模型 |
| Reserve 真实额度、SCI、企业 MCP | 无对应账户、额度状态或企业认证环境；保留此前隔离类型/状态证据 |
| 已信任 Hook 执行 | 禁用/启用、跨实例刷新、失败恢复已补；用户拒绝 Hook 信任仍有效，不执行用户 Hook |
| Windows/macOS、远程 executor、回退 | 当前为 Linux；缺其他实机及本次升级前一致备份，不以模拟或新备份替代 |

上述扩展验收阶段只修正文档，未改产品代码；当时留下的空 Thread 恢复问题已进入下节关联修复。

### 2026-10-23 空 Thread 恢复关联修复

用户随后授权全链路审查分析修复。以 `7b2d1374` 后的工作区为输入，核对 Client → Provider 路由 →
Session Router → Binding Restore → Application 提交、Queue 守卫与三个 Surface 的共用错误展示，
并区分普通前台、保留后台和运行中计划任务的恢复合同。只读上游合同调查与独立关联复查已完成；
复查发现的新建偏好保留、后台任务不能暂停及前台转后台重新调度要求均已纳入最终实现。

锁定 `0.164.0` 的 `thread_processor.rs::resume_running_thread` 仍先读取持久历史再建立订阅，
`thread_resume_rejects_unmaterialized_thread` 明确覆盖尚未物化的 Thread；`0.163.0` 已有同一限制，
因此不将该问题归因为本次升级新增回归。`thread/read` 返回 live idle 或预分配 path 不证明历史已保存、订阅已恢复。
Client 仅把 `thread/resume` 的 `-32600` 且完整消息匹配当前请求 Thread ID 的缺失历史错误映射为
`thread.resume.history-unavailable`；错误分类不等于“已删除”或“必然零 Turn”。

实现保留原绑定和数据，只在内存标记订阅不可用：前台暂停定时恢复，普通输入及提交守卫给出明确提示；
用户可新建，或在历史可用后显式恢复。成功恢复或解绑清除暂停记录。新建仍保留模型偏好合同，
速度档位未知时先要求用户明确选择，不默认改成 Standard。后台和运行中计划任务继续原恢复重试，
前台转后台时重新调度；不自动重跑已提交任务。恢复日志分别记录成功和待恢复数量，不再用绑定数量冒充恢复成功。
无持久化格式变更、历史扫描、自动命名或隐式替换 Thread。

使用任务自有临时 Codex Home、真实 `0.164.0` App Server、实际 Client/Router/Binding Restore/
Application/Core 模块和回环 Responses 输出，人工执行得到：

- **失败准入及暂停**：零 Turn Thread 恢复返回稳定错误，原绑定保留；首次恢复调用数为 1，
  调度后等待超过首轮退避并再执行普通恢复检查，额外恢复调用数为 0。普通提交及 Workspace 提交守卫均返回
  `thread.resume.history-unavailable`，模型请求数为 0。
- **真实新建路径**：Application 新建先返回 `fast.selection.unknown`；明确 `/fast off` 后新建并提交，
  新 Thread 与旧 ID 不同、旧暂停和 pending 均清除，Turn `completed`，回环模型请求数为 1。
  同一新 Thread 写入历史后再失效订阅、执行恢复和下一次 Application 提交，原 ID 不变，第二轮 `completed`。
- **显式恢复清理**：用户明确命名空 Thread 后，Router 显式恢复同一 ID，暂停、pending、restoring 均为 false；
  随后 Application 提交完成一轮，有历史后 Application `/resume` 也保持同一 ID。
  另一轮“命名后立即通过 Application 列表选择恢复”返回 `session.selector.not-found`，未将其记为成功，
  也不把命名当作保证立即出现在列表的修复路径；该限制不影响已完成的新建路径。
- **后台及暂时故障**：将暂停的绑定通过实际 Store 转为后台，再调用恢复调度，首轮退避后实际增加 1 次恢复请求，
  绑定和 pending 保留。人工注入暂时 Transport 错误后，旧历史错误标记清除、原绑定保留，首轮自动重试后共 2 次尝试。
  此处观察了实际调度器对后台身份的处理；生产 Application 转后台回调的连接经源码复核，未启动完整生产 Gateway。
- **Hack 边界**：直接调用实际 Client，错误码不符、其他 Thread ID、额外后缀及普通 Error 均保持原错误，
  只有精确合同映射新分类。在等待中的恢复请求返回前撤销 `shouldRestore`，迟到失败不产生记录，
  结果 failures 为 0、historyError 为 false、原绑定不变。

上述隔离实例与回环服务均已关闭，任务临时目录已清理。新运行没有外部模型费用、渠道发送、Hook 信任或生产重启。
`npm run build`、`npm run check`、受影响 TypeScript 的 ESLint 和文档索引检查通过；这些仅是静态流程状态。
真实渠道提示投递、生产全组合根、运行中定时任务恢复以及 Windows/macOS 原生环境未在本修复中实测；
后台计划任务分支只完成调用链和合同审查，不能用普通后台绑定观察替代。上述观察在修复提交前完成，本次未部署。

### MCP 工具目录元数据内部透传

用户在升级后选择只做内部字段保留。沿 `mcpServerStatus/list(detail: full)` → Client 适配器 →
`McpServerDetail` → Provider 路由 → Application 详情查询已保留 `toolListMeta`，仍按锁定上游的
“对应工具目录第一页 `_meta`，不可用时为 null”解释。概览不增加字段；不解释元数据键、展示、记录正文、
持久化、注入模型或改变执行权限。使用本地递归 JSON 类型隔离生成协议，不增加 RPC 或数据库格式。
仅新增详情字段及本地只读类型，概览/健康投影、权限判断、配置刷新、OAuth 与资源读取沿用原合同。
Client 从 JSON-RPC 解码后的值直接传递，不递归解释或合并元数据；缺失字段拒绝而不是默认为 null。

在 `af6239a2` 后的工作区，使用任务自有 Codex Home、真实 `0.164.0` App Server 和两个回环 HTTP MCP 服务观察：
两服务各返回两页工具，A 的第一页含嵌套元数据、第二页给不同元数据，B 不提供 `_meta`。
经实际 Client、ProviderRoutingClient、Application 扩展查询，A 完整保留第一页值，B 返回 null，
两者均有 2 个工具且未混用元数据。概览没有此字段，健康摘要和渠道共用详情渲染没有带出标记、
敏感内容哨兵或 HTML 字符串，现有服务器名与工具仍可显示。入口授权拒绝后没有新增 MCP 请求。
模型请求及工具执行均为零；自有 App Server、HTTP 服务和临时目录已清理，不访问用户 MCP 或改生产配置。

人工构造 RPC 响应补查：null、空对象、false、0、空字符串、数组及嵌套值均原样保留；
`__proto__`/`constructor` 仅作为数据，未改变对象原型。缺少字段返回固定错误 `Codex 响应缺少 MCP toolListMeta`。
两页 MCP Server 状态响应分别保留 A/B 归属，每页均带原 Thread ID 和 full 查询参数。
这些响应构造观察与上述原生运行分开；未新增或修改测试文件。真实用户 MCP 的业务元数据、
多 Provider 实例切换和真实渠道投递未因此验收，现有原样 Provider 转发及三个 Surface 共用显式字段渲染经源码核对。

## 延续的基线取舍

以下记录 `0.163.0` 已采用且本轮继续保留的行为，以及原版本观察；不能当作 `0.164.0` 的实测。
**既有决定：保留现有渠道能力边界，不为升级新增无需求的实验功能。**
源码、生成协议、公开 CLI 合同和 CI 已同步。升级实施阶段未修改全局 CLI 或运行中的共享服务；
操作者随后已完成部署与重启，部署后只读审查确认运行版本为 `0.163.0`。
部署状态不替代下文各项功能的行为验收。

采用 [0.163.0 正式 Release](https://github.com/openai/codex/releases/tag/rust-v0.163.0)，
固定提交 `83086188ae0614bd882818ff1aa23f3194962012`；本地目录及原基线提交见
[上游来源](upstream-sources.md)。以下源码位置均相对该固定版本目录，
比较起点为 `0.162.1`。Release 使用 `0.162.0` 比较起点，不能直接把所有发布条目算成本次收益。

### 现有路径的采用方式

| 用户或管理员得到什么 | 决策与本地入口 | 固定源码证据及实施要求 |
| --- | --- | --- |
| 多 Workspace 共用后台时，无目录配置查询的辅助加载也不受启动项目配置干扰 | 随 CLI 采用作用域修复；保持 `src/codex-client/client.ts` 的全局读取无 cwd、Workspace 查询显式 cwd | `config_manager_service.rs` 的全局读取本体原先已排除项目层；本次修复 `config_manager.rs::load_latest_config(None)` 的辅助加载。`model/list` 仍按实例启动配置与 Provider 目录工作，`permissionProfile/list` 保留明确 Workspace，不能把它们一并描述为全局目录变更 |
| 中断正在执行的 Code Mode 时，其单元和嵌套工具也能停止 | 随 CLI 采用，不复制取消器；检查 `src/codex-client/client.ts` 的 `turn/steer`、`turn/interrupt` 和 Core 最终状态 | `codex-rs/features/src/lib.rs` 将 `code_mode_interrupt` 从默认关闭改为 Stable/默认开启；`instant_interrupt` 在项目原基线已默认开启，不能重复计为新增。实施时观察中断后终态、剩余工具和迟到输出 |
| 恢复会话时保留 App Server 原生权限及受管策略 | 移除前台 Client 的网关权限默认覆盖；新建按目录加载原生配置，恢复及分叉沿用官方权限继承 | `codex-rs/app-server/src/request_processors/thread_processor.rs` 处理无覆盖恢复及持久 Profile；Gateway 仍核对目录、Thread 身份和活动状态，后台另保留无人值守准入，不把用户层配置显示当成旧 Thread 实际权限 |
| 执行 Shell 命令继续使用官方支持的路径 | 随 CLI 移除定制 zsh 后端；不新增旧后端兼容；保持 `scripts/codex-remote.mjs` 的官方 `--remote` 入口 | `codex-rs/features/src/lib.rs` 将 `shell_zsh_fork` / `unified_exec_zsh_fork` 标为 Removed 并提示忽略；`core/src/config/mod.rs` 不再使用 `zsh_path`。项目运行脚本未注入这些配置；已用精确 CLI 刷新合同，受控公开参数内容无变化 |

已审查精确 CLI 生成差异与固定源码：现有 `thread/resume`、`turn/steer`、`turn/interrupt` 和审批
请求/响应未发生破坏性字段变更。新增两个 Request、一个 Notification 和八个生成文件；
`ThreadListResponse.readStates` / `ThreadReadResponse.readState` 仅随官方生成，不进入业务投影，
`thread/readState/changed` 在现有通知适配器中安全忽略。Server Request 和 Client Notification 未变，
受控导出和业务调用范围不变，无需新增业务兼容分支。Realtime voice、输出注解及加密回放字段
只同步生成结构，不新增语音、回放或明文持久化能力。

关联审查发现并修复了现有 `schedule_task` 的取消缺口：工具回调等待 Thread 或任务查询时，原
Turn 或动态工具可能已被上游取消，旧实现仍会继续修改任务或安排运行。现在从首次异步检查前
登记原请求身份，在权威终态、请求解决、断线及关闭时撤销，并将有效性检查传到计划任务用例和
调度提交边界，拒绝迟到确认。此修复不增加动态工具能力，也不承诺回滚已经提交的写入。
具体生命周期见[计划任务说明](scheduled-tasks-development.md#前台工具与自然语言创建)。
再次关联审查补齐了执行端口内部的异步窗口：后台新建排队、投递准入和 Provider 准备之后，
仍须在 Client 的 `thread/start` / `turn/start` 实际发送前复核；提交前取消收敛为中断，
不再让已取消的工具启动后台 Turn，也不把已发写请求的响应当作可取消的准备工作。

### 明确收益与随 CLI 采用的内部变化

- **命令完成和输出回收更可靠。** 上游修复子进程持有输出管道造成的拖延，以及远程进程末尾输出丢失；
  当前 Gateway 经 App Server 消费命令 Item，拟随 CLI 采用，实施时观察末次输出与完成事件顺序。
  不把上游 exec-server 修复当成本项目独立 Relay 或 Surface 投递修复。
- **官方执行环境的网络检查更严格。** 拟随 CLI 采用 DNS 前授权、重复 Host 拒绝和凭据别名检查修复；
  固定版 `codex-rs/network-proxy/src/http_proxy.rs` 已在路由前拒绝重复 Host。
  仅对实际启用官方受管网络代理的执行链路生效，不改变默认启用状态，也不修复 Gateway Provider Proxy
  或独立 Relay。不修改 Gateway 代理规则或扩大授权；本轮未逐条运行网络攻击场景。
- **原生终端设置和剪贴板更易用。** `/config`、leader 快捷键、Windows/WSL 剪贴板改进随配套 CLI 使用；
  不复制到渠道或 WebUI。只读工具并行、Guardian 和打包体积改进留在上游内部，
  不改变 Gateway 的并发、审批或持久化所有权。此处收益依据官方 Release，未做各平台实机观察。

### 暂不采用及重新评估条件

| 用户可获得的候选能力 | 本次决定与原因 | 重新评估条件 |
| --- | --- | --- |
| 列表中排除指定 Thread，便于展示固定分组 | 不传新增稳定字段 `thread/list.excludedThreadIds`；当前列表无手工排序集合需求，维持既有 Workspace/Provider/source 过滤 | 有明确分组需求时再接入；官方上限 100，重复项计数，不得截断后假装完整 |
| 跨窗口保存已读/未读位置 | 不接入实验 `thread/readState/update`、`thread/readState/changed` 或 readState 投影；渠道送达与用户阅读不是同一事件 | 明确阅读确认入口后再设计按 Thread 的 revision 冲突处理；不得盲目重试或增加本地平行会话索引 |
| 按 ID 读取历史 Item | 不接入实验 `thread/items/read`，继续分页 Turn 历史与 Revert；不扩大现有受控协议例外 | 现有历史接口不能满足明确业务需求时重新评估 |
| 用父线程配置和历史创建预测分支、保留工具输出或关联远程执行连接 | 不接入 `thread/fork.experimentalPredictionMode`、`TurnToolOutput.retain` 或 `environment/add.websocketRequestId`；预测分支要求 ephemeral 且不能带配置覆盖，与当前显式目录和权限的 fork 用途不符，其余两项没有本地消费者 | 有明确预测、上下文保留或远程 executor 需求后单独设计；不把远程 executor 的连接标识用于 Gateway App Server 请求关联 |
| 从终端重启官方后台 | 不接管 `/daemon`；项目 Supervisor 继续拥有服务生命周期 | 继续遵循既有 daemon 专项决策；`codex-rs/tui/src/app/daemon_menu.rs` 要求 managed daemon，不能把这项功能宣传为 `codexc remote` 的服务管理能力 |
| 隐藏发给模型的日期和时区 | 不新增 `include_environment_context_time` 设置入口；上游默认 true，保留 `runtime/app-server-service-runtime.mjs` 注入 TZ 的现有方案 | 确有隐藏时间需求再评估；若用户在上游配置关闭该项，设置 TZ 不会强制重新显示日期/时区 |
| 后台预压缩、额外凭据遮蔽和新的子代理上下文策略 | 不自动打开 `async_compaction`、`credential_masking`、`subagent_default_context_limits` 等新开关，不增加配置 UI | 分别有延迟、安全或上下文需求，并明确 Provider 支持与资源边界后单独评估 |

### 本次观察与验收边界

使用临时安装的精确 CLI、独立 Codex Home 与两个临时 Workspace，通过构建后的项目
`CodexAppServerClient` / `StdioTransport` 交互连接真实 App Server，未读取用户凭据或会话。
模型后端只指向本机不可用端口，没有调用付费模型或发送渠道消息。

- 全局思考等级读到 `medium`，Workspace A/B 分别读到 `low` / `high`，即使服务从 A 启动也保持区分。
- 创建 paginated Thread、改名并读回；Turn 提交后列表能查到该 Thread，另一个 Workspace 的列表为空。
- 关闭并重新启动任务自有实例，将原 workspace-write Thread 显式以 read-only 恢复，返回
  `settingsMatch: true`、`sandbox: read-only`，名称和 Thread 身份保留。
- Hack：对已加载 Thread 请求不存在的权限 Profile，上游保留实际只读配置，Client 返回
  `settingsMatch: false`；已核对 Router 的拒绝绑定分支，未把成功 RPC 当作权限设置成功。
  Queue 页大小为 0 时 Client 明确拒绝，输出“Codex Queue 列表页大小必须在 1 到 100 之间”。
- 在 `turn/start` 响应后立刻中断，曾收到 `-32600: no active turn to interrupt`；随后确认
  `turn/started` 和活动状态后显式中断，收到同一 Turn 的 `turn/completed: interrupted`，
  现有适配器产出 `turn.completed`，Thread 最终为 idle。没有增加自动重试来掩盖该时序边界。
  这仅观察到无可用模型后端时的 Turn 取消，不证明正在执行的 Code Mode 嵌套工具已被实测停止。
- 再次审查后的隔离交互：通过真实 Provider 路由创建只读 Thread，提交守卫通过且返回 idle；
  在另一次 Thread 启动的 Provider 准备期间取消，返回 `manual-cancel-during-provider-preparation`。
  经真实投递准入包装器调用 Turn 启动后立即取消，返回 `manual-cancel-during-turn-admission`；
  随后官方 Thread 读取仍为 idle，`thread/turns/list` 返回尚无首条用户消息、Thread 未 materialized 的
  `-32600`，没有把它当作空历史成功响应。这些观察覆盖最终提交守卫，不覆盖模型实际发起动态工具的整链路。

尚未观察真实渠道/在线模型回答、运行中 Code Mode 单元取消、远程命令迟到输出、各项网络攻击、
Windows/macOS 运行及 Desktop 私有连接。本次不新增测试或测试脚本，不把静态检查与构建当作这些路径的验收。
本次动态工具取消修复已沿请求登记、通知撤销、任务写入和调度提交边界做源码审查；未通过在线模型
实际触发 `schedule_task` 并重现取消竞争，前述普通 Turn 中断观察不替代这一整链路观察。
旧版 TUI 多行异步问题修复与 LocalDaemon 功能检查修复继续随 CLI 保留；它们不是本次新增收益。
不新增渠道功能、模型代理能力、官方 daemon 生命周期或旧协议兼容，不自动安装到生产环境。

### 延续的消息与权限合同

以下是此前已采用并继续保留的能力，不是本次新增功能；其中实际观察保持原版本范围。

| 范围与用途 | 当前决定与实现入口 | 证据与边界 |
| --- | --- | --- |
| 稳定回答后仍可继续工作 | Client/Core 保留 `partial_answer`，三渠道按正文投递；不算最终回答，飞书不挂整轮完成页脚 | `MessagePhase` 与官方 partial-answer 合同；未知阶段仍保持未知，不伪造最终阶段 |
| 用户设置和清除 Goal 后留下明确授权来源 | 既有 `/goal` set/clear 调用发送 `origin: "user"` | `thread_goal_processor.rs` 仅为显式 user 来源记录用户指令；自动来源不得冒充用户，写入仍不重试 |
| 子代理开始卡显示启动设置 | 消费 started 活动的 `model`、`reasoningEffort`，Provider 单独核验 Thread 归属 | 不以稍后 Thread 配置覆盖启动快照；未知保持空，继续卡仍展示读取时设置；不改变持久化指标结构 |
| 更准确保留审批限制和动作归属 | 随 CLI 获得 Guardian 用户限制保留、检查点恢复和评分对应动作修复 | 不扩展 Gateway 自动授权；不宣称保证中文输出，不接入额外 Decisions 服务或其凭据 |
| CP 接收新版提示词形状 | 既有 Responses 透传和 Chat 桥继续接收 `input` 内 developer 消息 | 基础提示词从顶层 `instructions` 移入 input；0.162.0 隔离 CLI 的标准 Responses 请求已观察到 developer→system 映射。自定义目录默认不启用 Responses Lite，其专属 reasoning context 和工具注入不纳入 Chat 桥支持范围，不通过放宽校验冒充兼容 |
| 原生终端和工具执行更可靠 | 随 CLI 获得模型默认值、Retry-After、CRLF、Linux/Windows 沙箱及 MCP 修复 | 不改变 Gateway 重试、OS 权限和服务所有权；非当前平台仍需实机确认 |
| 官方 daemon 生命周期 | 继续暂缓接管，现有服务管理与更新器维持职责；更新器已有关闭 `features.daemon_auto_start` 的护栏 | [专项审查](archive/codex-daemon-review.md)的 0.160.0 隔离实测保留原版本；操作者部署 `0.163.0` 不代表接管了官方 daemon |

本次不新增 Thread prediction、附件所属 Thread 反查、Bedrock GovCloud、浏览器扩展请求头、
环境必需 Skill、远程环境或 worktree 管理入口；这些能力没有当前渠道需求或超出现有授权边界。
既有 `parentTurnId` / `rootTurnId` 不代替已确认的子代理归属，用户直接发起 Turn 不伪造父轮。
`reviewTarget` 不开启拒绝后续做，MCP OAuth `loginId` 不扩展已有登录流程。
Fast/Ultrafast 分别读取 `fast_mode` / `ultrafast_mode`，结合 `configRequirements/read` 的独立档位合同和受管功能策略；目录能力与对应开关同时允许才可选择。默认值、偏好恢复、渠道命令、配置向导与 WebUI 共用这一语义，不自动打开开关。
自定义 Provider 的实时联网与 V2 远程压缩能力覆盖暂不接入配置界面，也不自动打开；未配置时遵守上游默认。
这里指 `model_providers.<id>.capabilities.external_web_access` 和 `capabilities.remote_compaction`，
不是已有 `web_search` 用户偏好。固定主配置保留上游解析路径，但受管自定义切换 Profile 的
白名单不接受 `capabilities`，加入后会明确拒绝；不能把无设置界面理解为所有入口均支持手工配置。
固定模式的消费路径已做源码核对，尚未在线验收，详见[Provider 能力边界](provider-integration-guide.md#扩展能力与高级设置)。
新子代理规则只使用 `fork_turns="none"`，与上游取消部分历史 fork 的指导一致。

使用目标 CLI 按项目固定选项生成协议，复核受控导出与现有业务边界。
静态检查、构建和人工验收要求遵循[升级流程](codex-cli-upgrade.md)，实际结果保存在对应 PR。
上游修复随版本获得；未观察的远程 Windows、真实渠道和在线账户场景不算本次验收。
Desktop 按平台记录：macOS 已由操作者确认验收，Windows 尚未验收；具体版本证据见
[Desktop 验收状态](codex-desktop-app-development.md#实现与验收状态)，不将平台确认扩写为本次 Linux 环境的实测。

## 延续采用的能力与边界

### 既有适配与内部修复

以下适配在 0.160.0 已接入，继续在当前基线保留；不属于本次新增能力。

| 用户得到什么 | 现有决定与实现入口 | 验证边界 |
| --- | --- | --- |
| 正确读取 Pro Max 账户和用量 | `PlanType` 包含 `promax`；Client 账户/通知解析、Application/Core 类型、渠道与 WebUI 中英文展示继续支持，未知套餐仍失败关闭 | 账户读取与通知适配；套餐名不授予权益、不触发自动换模 |
| 确认向已有高权限终端继续输入 | 上游默认启用 stdin 审批；Client 独立解码 `writeStdin`，Approval 以独立 stdin 类型通过现有 Surface 交互处理，完整转义预览；仅一次批准或中止 | 真实 App Server 模拟模型后端驱动 exec → stdin，验证身份、输入与批准/中止；超大预览、持久授权、缺失合同和未知类型安全拒绝 |
| 自定义 Provider 只展示其实际目录 | 随 CLI 采用显式模型目录权威性修复，保持 `model_catalog_json` → `model/list` → 本地选择器链路 | 不补回被上游移除的错误内置模型；Provider 运行行为与模型目录另行验收 |
| 原生终端保持后台 Provider 与用户设置 | 随 CLI 采用远程 TUI Provider、推理摘要、verbosity 和历史列表修复 | 保留显式 `--remote`、Workspace 授权和 Provider 隔离 |
| 理解带错误的中断结果 | 错误码包含 `flexUnavailable`、`tooManyDenials`，中断 Turn 也可能带错误；保留现有 Client/Core 清洗和错误传递 | 不将其映射成账户耗尽、不盲目重试写请求 |
| 后台服务启动、执行和日志更可靠 | 随精确 CLI 吸收 SQLite、沙箱、网络与平台进程修复 | 不修改本项目 StateStore/schema；本地验证不等于其他平台实机验收 |

stdin 的上游依据为 `core/src/unified_exec/stdin_approval.rs`、`core/src/tools/approvals.rs`、
`app-server/src/bespoke_event_handling.rs` 及对应测试。空输入与部分中断控制输入不需要审批；
保留授权或策略变化才可能要求重新审批，无法满足新的 denied-read 约束时上游拒绝。
App Server 将内部 argv 编码为 shell 转义字符串，Gateway 不按空格拆分或执行它；展示完整
JSON 转义表示，合计超过 3000 UTF-8 字节即中止。审批绑定 Thread、Turn、Item 与 RPC 请求，
独立 callback ID 在 Client 边界必需；会话或永久授权不能作为一次输入的回应。

### 随配套 CLI 获得的内部改进

| 能力与用途 | 采用边界 |
| --- | --- |
| 原生终端重连后恢复输入 | 随 CLI 获得 TUI 修复，不是 Gateway Queue 修复；渠道仍只使用 App Server Queue，不引入正文副本或自动重发 |
| Plugin 缓存与日志空间回收 | 随 CLI 获得上游内部改进，不新增本地缓存、数据库维护或 Plugin 管理入口 |

### 既有适配的接入边界

| 能力与用途 | 决策与理由 |
| --- | --- |
| CLI 与后台包独立运行、更新 | 原生 daemon 有生命周期轻量化收益，但当前暂缓接入；独立安装早已存在，`0.157.0` 改变符合条件的交互 CLI 默认启动方式。当前仍由项目 Supervisor 和 `codexc` 后台服务命令监管；显式 `--remote` 为权威目标，不并行引入第二个所有者。原生支持 `update --from-cli` 固定版本，接入须先解决配置、代理与自动续做边界 |
| 上游 Provider gateway OAuth | 上游已提供三个 RPC 与通知，但不是本项目 Gateway/CLP 登录。继续不导出、不新增登录 UI、不设置 `explicitGatewayOauth`；该初始化开关会持续影响共享进程授权策略，未来接入需另审查连接顺序、登录归属和取消 |
| 历史 Item 锚点查询 | 不接入 `thread/items/list`；保留当前分页 Turn 历史和 Revert |
| 定向 MCP 服务、应用账户资源 | 可选 `serverName`、`target` 暂不传；`httpOrigin` 不整包透传，现有健康摘要与资源读取保持受控 |
| 远程执行环境 bearer token、Realtime 新字段 | 未接入能力，不增加凭据保存、远程执行或实时语音入口 |
| 无项目会话、即时中断与其他 Guardian 扩展 | 保持渠道 Workspace 授权和现有中断合同；Auto-review 设置及状态统计的已采用范围见下节，`autoApprovalReview/strictReviewRequired` 等额外能力仍不接入；TUI 专属体验随 CLI 使用 |
| 上游上传重试与超时 | Gateway 图片引用上传是独立 HTTP 链路，不能宣称自动获得该修复；保留账户/路由核验、分阶段超时、取消及既有同一 Blob PUT 的有界重试，不重试文件创建或 Turn 提交 |

daemon 的固定源码、完整调用链、双实例与持久 Thread 恢复实测，以及生产替换验收条件见
[原生 daemon 接入审查](archive/codex-daemon-review.md)。已确认重启可在 Gateway 重连前自动发起
续做模型请求，启动命令的普通 `-c` 覆盖不能直接代替当前 Provider 参数注入；本次不切换服务。`codexc update` 统一将用户层 `features.daemon_auto_start` 设为 `false`，
包括版本无需更新的路径；已有官方后台不停止，其他偏好保留，避免原生终端自动另起后台。

### 协议与用户能力

| 上游能力 | 现有决定与收益 | 验证与限制 |
| --- | --- | --- |
| Auto-review 审批方式与审查状态 | 支持 Codex 原生用户/项目配置和当前 Thread 的显式选择；展示实际审批方式、实时审查状态及本轮/会话递归分类计数，审查模型请求归入明确的触发任务 | 稳定设置字段及受控实验策略/状态投影；历史缺失不补推，未知状态只读，设置与人工批准不混用。协议和验证入口见[支持矩阵](index.md#当前支持矩阵)，渠道实机范围见[验收矩阵](channel-acceptance-matrix.md) |
| 恢复响应增加实际协作模式 | 从稳定 `thread/resume.collaborationMode` 恢复 Default/Plan，显式接续、自动接续和重连不再固定为 Default | Client/Router 消费实际恢复模式；缺失或未知模式明确拒绝 |
| 模型人格停用 | 移除 CLI/WebUI 人格选择和偏好写字段，避免无效设置；其他偏好保存保留原配置值 | 偏好投影、预览与事务保持一致；旧人格写请求明确报错，不迁移用户配置 |
| 图片支持文件引用 | 共享 Queue 与历史把 URL/fileId 图片都裁剪为不可编辑的图片摘要 | Surface 提供受限 Data URL；OpenAI ChatGPT 由 Client 上传后使用官方 fileId，API Key 与第三方保留内联路径，详见下节 |
| Thread 禁用 Plugin 列表 | 现有设置与 Turn 写入不发送空列表覆盖服务端值 | 现有 RPC 合同；字段当前不代表上游已经过滤全部 Plugin 能力，不新增 Plugin 管理入口 |
| MCP 服务能力与 App UI 元数据 | 保留生成类型，现有适配器只输出受控健康和工具摘要 | MCP/Item 投影；任意 JSON、嵌入 UI 不进入渠道 |
| 异步纯文本与问题 | 问题走现有协调器，纯文本走过程消息，均不充当最终答复 | 通知与 Core 归约保持一致；不自动开启实验工具开关 |
| 登录代理、MCP OAuth 503、模型目录认证刷新、Plan/流式/子代理修复 | 随精确 CLI 吸收上游修复，继续使用官方状态和错误 | 不复制刷新、重试、调度或会话文件；在线认证恢复另需真实网络验证 |
| Socket、沙箱、Guardian、压缩、TLS 与性能修复 | 适配新的确定性 Unix Socket 链接，严格校验物理路径、0700 目录、0600 Socket 与属主；Transport 和监管共用校验 | Linux 运行行为另行验收；macOS/Windows 专属安全行为需要各平台实机验收 |

### 模型目录与原生终端

- 现有 `model/list` 和模型选择器接受账户实际返回的 `gpt-6-sol`、`gpt-6-luna`；不硬编码可用性或默认模型。
- 每个模型保持自己的思考等级。固定目录中 Sol 支持 low 至 ultra，Luna 支持 low 至 max；运行时仍以服务端目录为准。
- 原生 TUI 的 Luna 用量提示随 CLI 获得。Gateway 的 Luna Reserve 仍依赖精确隐藏 `gpt-reserve` 和账户权益，不能改为自动切换 `gpt-6-luna`。

### 能力分类与决定

以下按固定版本源码、生成协议和本项目入口区分已采用、受限采用与未接入能力。未接入项必须说明
缺的是上游通路、本项目实现还是验收；受限采用项必须写明允许范围。生成字段、内部函数和公开 RPC
不能相互替代。下表记录决策，不是新增功能排期。

| 能力 | 上游实际状态 | 本项目决定与后续条件 |
| --- | --- | --- |
| 原生图片引用复用 | 图片输入支持引用；隔离真实 App Server 已验证直接转发 `fileId`、历史与 Queue 保留以及重启恢复。默认内联存储不提供文件编号解析，且没有专用上传、解析 RPC | 用户要求避免重复 Base64，不需要文件管理命令；当前账户已验证编号识图，后续请求引用方式按既有探测记录；新增官方认证及路由校验后接入自动引用，明确上传原图与官方内联缩放的差异，详见下节 |
| `rollout/compress` | 实验 RPC，触发本机冷 Rollout 文件的后台压缩，仅支持本地 Thread Store；响应只确认触发，锁与冷却可能使本次任务跳过 | 本次不增加维护入口；不能替代已支持的 `thread/compact/start` 上下文压缩，也不能显示“压缩完成”。如需磁盘维护，单独审查实验范围与执行结果表达 |
| Daybreak 与访问计划 | `model/list.availableAccessPrograms` 是目录元数据；`thread/start.daybreakEnabled` 与 `turn/start.cyberAccessProgram` 是实验字段，设置不授予权限；省略 Turn 选择保留官方自动行为 | 本次不增加展示或显式选择入口；只读展示可独立评估，显式选择须有账户权益、批准的实验范围和实际行为验收，不能由模型名称推导权限 |
| 账户 `workspaceRouting` | `account/read` 的实验响应字段，包含账户 ID、后端地址及区域路由策略；上游已有解析与认证路由逻辑 | 仅允许图片上传账户与路由校验，不增加 Gateway 账户路由选择器，不自行覆盖后端策略；其他用途须单独审查，不能把本地 Workspace 当成 ChatGPT 账户 Workspace |
| 设备公钥验证 | 实验 `userVerification/*` RPC；`enroll` 只创建或复用本地凭据并返回公开元数据，后端登记由调用者完成 | 当前缺少设备交互、后端登记和挑战响应的完整接入；保持拒绝不支持的验证请求。新增公钥字段不代表渠道已经能够完成验证 |
| MCP App UI | Item 提供资源 URI 和显示模式，工具调用与资源读取已有上游接口；这些元数据本身不提供 WebUI 宿主 | 本次不嵌入交互界面；本项目已有 MCP 状态、资源读取和审批继续保留。若接入，需另做资源加载、界面隔离、消息桥及工具授权，不能把 URI 直接作为任意页面展示 |
| Plugin 市场管理 | 上游已有 `plugin/install`、`plugin/uninstall` 等实际 RPC，公开名称保持不变 | 市场管理明确未接入，不是上游缺接口；保留已安装查询、本地搜索与 mention，以及已有 Plugin 所属 MCP 的受限策略设置。后者不提供安装、Plugin 根启停或 `disabledPluginIds` 执行阻断；新增市场管理须完成来源、安装范围、授权和生命周期合同 |
| `disabledPluginIds` | 可保存 Thread 禁用列表；固定版协议明确说明尚不据此过滤 Plugin 能力 | 不提供“禁用即可阻止执行”的开关；现有写请求省略该字段，避免清空其他客户端保存的值，待上游落实过滤语义后重评 |
| Realtime 与持续语音 | 上游有实验性的会话启动、音频输入、输出及事件协议 | 本项目缺持续媒体传输、取消、断线恢复和交互合同；明确未接入。已有一次性音频输入保持支持 |
| 官方 daemon | 上游已有跨平台实现，生命周期仍属实验协议 | 本项目继续由 `codexc` 后台服务命令监管；不同时管理第二套 App Server 生命周期，未来替换需独立设计和验收 |
| 全屏 TUI、主题、搜索复制、Mermaid/公式、原生用量与 Worktree | 属于原生客户端体验，是否可用仍取决于对应平台和账户 | 随配套 CLI 使用；本次不在 Gateway/WebUI 重做，不能统称为“上游未实现”或“本次漏接” |
| 删除的 `thread/rollback` | 上游移除的旧方法，本项目原本没有调用 | 更新生成类型即可；继续采用分页历史与 `thread/revert`，不因此接入 `thread/items/list` |

上述协议的实验标记见固定源码 `protocol/common.rs` 和 v2 `thread.rs`、`turn.rs`、`account.rs`；
文件、维护及 UI 定义见[固定版本源码索引](index.md#固定版本官方源码)。

### 图片文件引用：需求、阻塞与实现边界

用户最终明确的需求是正常发图时自动使用原生图片引用，避免后续模型请求反复携带同一张图的
Base64；不要求文件管理、下载入口或单独命令。此前上传与下载探测仅为内部传输研究，
不能将其扩大为产品需求。固定版输入可携带 `image.fileId`，具体依据：

- App Server 的 `message_processor.rs` 与 MCP 刷新装配均使用 `passthrough_image_store()`；
  `attachment-store` 的默认实现只返回内联字节，官方测试确认按编号解析返回 `NotFound`。
  但已有文件引用会跳过内联图片准备，离线真实 App Server 探测已证实直接发送到模型后端；不能将默认
  `resolve()` 的结果等同于 `image.fileId` 无法提交。
- 原生 TUI 的 `image_submission.rs` 将本地图片快照转为内联输入；Gateway 的 API Key 与第三方 Provider 保持此输入方式。不能声称普通原生发图已经普遍使用文件编号。
- `mcp_openai_file.rs` 有另一条供 Apps 工具参数使用的上传链路，要求 Codex 后端的 ChatGPT
  认证：向配置的 ChatGPT 基地址 `POST /files`（`use_case: codex`），向返回的上传地址
  `PUT` 字节，再 `POST /files/{id}/uploaded` 确认，返回文件编号和下载地址。
  这是工具参数的文件上传；在线探测确认当前账户可上传并即时下载，模型后端也接受其编号，
  较大图片在线识图对照也通过，但尚无独立按编号重新取回及地址刷新合同，不能直接拿来建立通用图片文件库。
- `thread/attachment/add|list|remove` 管理关联记录，不创建或删除底层资源；生成/编辑图片的
  `images/generations`、`images/edits` 也不是通用文件存储 RPC。

隔离的 `0.156.1` App Server 与本地模拟 Responses 后端完成了以下探测：

- `image.fileId` 转为出站 `input_image.file_id`，分页历史保留原引用。
- 活动 Turn 入队后能列出引用；中断、进程重启和恢复后，历史及 Queue 仍保留引用，显式启动后继续转发。
- 缺少 `url/fileId` 时 RPC 拒绝；空字符串 `fileId` 仍会到达后端，新增 Gateway 入口须在边界拒绝空值。
- 模拟后端返回文件无效错误时 Turn 明确失败；后端错误继续由 Gateway 现有清洗边界处理。

上述离线结果只证明协议传递与持久化，使用测试编号且未进行真实上传、登录或付费推理；
模拟成功响应不代表图片被读取。
空闲 Queue 会自动派发，持久化探测须用活动 Turn 入队再中断，不能用一次空列表推断图片丢失。

后续在线探测确认当前 ChatGPT 账户可通过 Apps 链路上传，并使用确认响应的签名地址即时下载；
下载字节与原图一致。首轮小图的直接 HTTP Luna 请求与 Data URL 对照均误识别为全蓝；
后续获授权使用 512×256 图时，两种方式均正确识别左红右蓝，证实当前账户的上传编号可用于
该模型的图片输入。小图误识别的根因仍未确定，不据此推导尺寸阈值或全部图片支持保证。
这些请求未经过 Gateway 或 `0.156.1` App Server；未验证独立按编号取回、地址刷新和跨账户拒绝。
脱敏响应、夹具、复现步骤与未执行项见[图片文件引用探测记录](archive/codex-image-fileid-probe.md)。

本需求的验收以模型出站请求为准：首次取得图片引用后，请求应携带 `input_image.file_id` 而不是
`image_url` Base64。后续工具循环和普通文本 Turn 可以在完整历史中继续携带同一 `file_id`，也可以
通过 `previous_response_id` 增量接续而不再携带图片；两种路径都不得重新发送该图片的 Base64。
正常发图交互保持不变，不增加 `/image` 命令，不要求用户管理编号，不新增下载或文件管理界面。

固定 App Server 默认注入内联存储，普通 Data URL 提交不会自动产出可复用文件编号。
因此需要内部一次性上传或可返回文件编号的官方存储实现；仅在 Gateway 缓存 Data URL，
或者省略下一条用户消息中的图片，都不能消除 App Server 历史中已有的 Base64。
当前决定：为 OpenAI ChatGPT Thread 接入提交前上传，使用官方 `getAuthStatus` 获取 App Server
当前令牌，以获授权的受控实验字段 `account/read.workspaceRouting` 核验账户、后端和路由约束。
不读取 `auth.json`，上传前后检查账户与令牌；账户通知触发异步合并复核，身份未变时继续，
实际变化或核验失败才取消，断线直接取消未完成操作。
通过 `config/read` 定位当前 App Server 生效的回环模型代理，直连其只读
`/_codexc/image-upload-route`，根据运行中的解析器确认模型后端，提交前再次确认。
自定义独立后端保留内联图片；当前自动引用只支持代理确认的默认 `https://chatgpt.com`
后端且账户策略为 `NO_CONSTRAINT`；`us`、`us_cr` 即使地址相同也在上传前拒绝。
当前回环模型地址不会启用官方 Codex Backend 的区域路由处理，不能仅凭相同域名推断 Header 一致。
账户后端与模型代理不一致也明确拒绝，不把账户查询结果当成模型实际路由。
本地核验不发送凭据、不经过外部 HTTP 代理，也不记录模型请求指标。
创建文件及完成确认携带认证和路由，签名存储地址 PUT 不携带账户凭据，全部禁止重定向。
完成响应明确要求 `retry` 时有界轮询；同一签名地址、同一图片字节的 Blob PUT 对受控网络错误或
502/503/504 最多尝试五次，并遵守传输预算与服务端重试间隔。文件创建和 Turn 写请求不自动重试。

直接传入 fileId 会跳过官方图片准备；本实现明确上传渠道已校验的原图，不复制官方缩放算法，
不声称与内联路径预处理完全相同。API Key、第三方 Provider 保留内联路径。
不建立跨消息缓存，后续纯文本轮次的引用由 App Server 历史负责；用户重新发送图片会重新上传。
上传受 4 个并发任务及既有图片数量和大小边界约束；普通阶段预算 60 秒、字节传输 5 分钟、
完成确认 30 秒，不能表述为全链路 60 秒总超时。`/stop`、关闭、解绑和账户变化取消准备。
提交 Turn 后等待结果，取消上传不用于推断或撤销已提交的服务端写操作。

2026-09-23 的飞书实机验收进一步确认：Gateway 首次
发图经 ChatGPT 默认后端向模型提交 `input_image.file_id`，没有提交 Base64；后续纯文本 Turn 使用
`previous_response_id` 增量接续且没有重复图片，模型仍能引用前图。该结果限定当前账户、
`NO_CONSTRAINT` 路由和当次 OpenAI 模型，不替代其他渠道、账户、路由或模型的验收。

按编号下载、签名地址刷新和文件管理不再作为本需求的交付条件。内部上传仍须说明远端保留风险，
引用过期或失效须明确失败，不能盲目重传产生新文件。Platform 文件 API 不作为 ChatGPT 文件
引用的隐式替代；此前认证与取回研究保留在[探测记录](archive/codex-image-fileid-probe.md)。

### 验收边界

图片引用的飞书首次提交与后续复用证据保留在上节及探测记录。Telegram、微信、其他在线模型、
认证刷新及 Desktop 私有工具均须独立验收；上游修复随 CLI 获得，不代表每项修复都已实测。
当前提交的本地门禁、CI 与部署状态以对应 PR 和部署记录为准，不把旧批次结果算作当前验证。



## 决策原则

- 先保证已有能力在新版本正常工作，再选择有明确用户价值的新能力；生成类型存在不代表已经支持。
- Thread、历史、Queue、Goal 与工具执行继续由 App Server 管理；Gateway 负责渠道、授权、路由和展示。
- 上游内部修复随配套 CLI 获得，不在 Gateway 复制调度、认证刷新、模型重试或会话恢复逻辑。
- 只锁定一个正式 CLI 版本，不增加旧协议兼容层。新增审批或身份验证没有完整交互合同前不开放。

## 当前采用

| 范围 | 项目取舍与收益 | 依据与边界 |
| --- | --- | --- |
| 共享会话与模型设置 | 渠道与原生 TUI 共用 App Server 的会话、模型和运行状态，避免维护第二套历史 | [协议支持矩阵](index.md#当前支持矩阵)；Workspace 与 Provider 归属仍由 Gateway 校验 |
| Hook 列表与受控管理 | 三渠道 `/hooks` 可查看详情、确认精确版本信任并启停已有 Hook | [协议支持矩阵](index.md#当前支持矩阵)；限定授权 Workspace、Provider 与 Actor，配置写入带版本检查并回读，不提供任意 Hook 执行或创建入口 |
| 原生 Queue、分页历史与 Revert | 排队输入保存在 App Server；用户可选择历史边界回退 | [Queue 与 Revert](thread-queue-revert-development.md)；回退不恢复工作区文件，不接入 Item 分页或正文搜索 |
| Default／Plan 与计划清单 | 复用官方协作模式，同时允许用户独立管理计划工具和渠道展示 | [使用指导](user-guide.md#计划相关设置)；工具是否可用、是否展示、采用哪种协作模式分别控制 |
| 多代理活动与结果 | 展示上游子代理活动，并将完成结果关联到发起的父 Turn | [渠道展示](display.md)；不复制子代理调度，成功归属采用官方完成信号 |
| 异步用户问题 | 三个渠道在任务继续执行时收集选项或自由文本，回答作为普通输入提交原 Thread | [异步问题](display.md#异步问题)；仅当前前台会话，不作为审批或最终回复；工具可用性由上游模型目录决定，不提供跨客户端回答同步 |
| MCP 与 Plugin | 提供 MCP 状态、健康摘要、刷新、OAuth 和只读资源；查询当前 Workspace 已安装 Plugin，并通过 mention 调用 | [协议支持矩阵](index.md#当前支持矩阵)；Plugin 调用仅支持 OpenAI Thread，不开放市场管理 |
| 电脑、浏览器与工具设置 | 管理原生访问策略、已有 MCP 策略及单工具输出预算，展示 CUA 操作开始与终态 | [配置范围](user-guide.md#computer-use-与浏览器排障)；复用配置 RPC、MCP Item 与审批，不自建桌面控制协议，不替代系统授权或证明连接健康 |
| 用户偏好 | 管理模型、思考等级、Fast、摘要、空闲回顾、计划工具等已接入设置 | [使用指导](user-guide.md)；通过带用户层版本检查的配置写入，不向渠道暴露任意配置覆盖 |
| 账户用量与请求指标 | 官方账户／Thread 用量用于查看上游估算；本地指标用于观察实际代理请求 | [Thread 用量](thread-usage-development.md)、[展示口径](display.md)；两种来源不合并，不自行计算第三方官方费用 |
| Luna Reserve | 在后端权益允许且普通用量耗尽时切换当前会话，满足条件后切回 | [恢复条件](display.md#luna-reserve-自动回退)；失败消息由用户重发，原模型只保存在进程内，不承诺跨重启自动切回 |
| 媒体与错误展示 | 采用已有图片、一次性音频、结构化错误和模型生命周期提示，改善渠道可理解性 | [协议支持矩阵](index.md#当前支持矩阵)；音频按模型能力校验，提示不推导额外权限或自动换模 |
| 上游运行时修复 | 吸收压缩、恢复、MCP、账户缓存、Goal、Guardian 和平台执行修复 | 随精确 CLI 获得；上游实现依据与本项目实际验收范围分别记录，不能把升级版本等同于全部场景验收 |

实验协议采用范围与[受控协议边界](index.md#受控协议边界)一致，仅包含 Plan、Queue、Revert、
前台计划任务动态工具、图片上传账户路由和 Auto-review 六类。Auto-review 仅限受控策略判断与
审查状态投影，不消费 `autoApprovalReview/strictReviewRequired` 或扩大协商。图片上传只读取 `account/read.workspaceRouting`
核验当前账户、后端和路由约束，不开放账户或路由选择器。动态工具仅允许新前台 Thread 注册顶层 `schedule_task`，
调用须归属已绑定会话与唯一授权 Actor；创建、删除仍需确认，后台任务拒绝递归调用。
不向旧 Thread 注入，不采用 `additionalContext`，也不开放任意动态工具或其他命名空间。

## 当前不采用

以下是持续有效的产品与架构取舍，针对 Gateway 的公开接入；不表示这些功能在上游均未实现。
字段和不完整通路的具体状态以上面的分类为准，不把它们统一解释为“只差前端入口”。

| 能力 | 不采用的原因与范围 |
| --- | --- |
| Project 项目管理 | 本次不接入实验 Project CRUD；名称、目录登记与 Workspace 有部分重叠，但 Project 不承担渠道目录准入或权限恢复。接入价值与边界见下节，不能仅用 projectId 替代 Workspace |
| 自定义 Thread 分区管理 | 不接入自定义分区 CRUD，仅以 `thread/section/move` 使用官方内置置顶；当前不提供全局分区管理入口 |
| 外部 Agent 会话导入、正文搜索与独立历史库 | 上游有 `externalAgentConfig/import*` 与实验 `thread/search*`，本项目未调用；现有 `/sessions search` 使用 `thread/list.searchTerm` 匹配会话标题，不检索消息正文。不读取、复制其他客户端会话文件，也不另建正文索引。通过 App Server 发现和接续原生 Thread 仍属已支持能力 |
| Realtime 与持续语音 | 当前只有受控一次性媒体输入，没有持续音频输出、实时传输和恢复合同 |
| Touch ID、设备身份验证及高权限新请求 | 渠道没有设备签名与挑战响应合同；不声明未实现的扩展，未知或未协商请求明确拒绝或取消 |
| 尚未支持的新交互模式 | 已有 `form`、`openai/form`、URL elicitation 和用户问题继续按支持矩阵处理；这里仅指未建立输入预览、请求归属和响应合同的新交互，不将现有表单笼统列为未接入 |
| Plugin 市场搜索、安装、卸载、发布与分享 | 不调用官方 `plugin/search` 等市场管理接口；现有 `/plugin list … search …` 只过滤已安装目录。CLI／WebUI 已有 Plugin 所属 MCP 的工具审批、允许／禁用工具及输出预算设置，不等于市场管理或 Plugin 执行总开关 |
| 直接注入工具输出与原生 TUI 专用动态任务工具 | 不调用 `thread/inject_items`，不新增无归属执行入口。已有 Hook 列表及受控启停、Gateway `schedule_task` 动态工具属于上节列明的范围，不能笼统声称 Hook 管理或所有动态工具均未接入；MCP 输出预算配置继续支持 |
| Bedrock、远程执行 Host 与独立第三方搜索 | 上游有 Bedrock 设置和 Environment 接口，本项目未接入这些专用认证与执行管理入口；已有 Bedrock 账户类型与认证通知识别仅用于状态解析，不构成专用接入支持。现有通用 Provider 配置不等于已验证这些专用能力，也不新增独立搜索 API |
| 官方 daemon 生命周期 | 当前暂缓接入，保留研究结论；须满足[专项审查](archive/codex-daemon-review.md)的配置、代理、恢复与版本验收条件，不同时维护两个进程所有者 |
| 任意目录／配置覆盖 | 渠道只选择授权 Workspace 和受控设置，不因后台原生化开放任意主机操作 |
| Gateway 自动代批、企业管控写入与应用网络要求管理 | 不自动替用户批准高权限请求，不提供组织策略写入；已有 Config 的显式审批策略选择、单次/会话/协议支持的持久授权继续保留。`never` 表示不请求审批，不代表 Gateway 自动批准 |
| Memory 管理、Thread 附件记录、反馈上传与尚未采用的模型／用量元数据 | 上游有 `memory/status|reset`、`thread/attachment/*`、`feedback/upload`，本项目无对应调用；附件记录不是文件上传。已有模型能力、生命周期、服务层级和账户／Thread 用量继续支持，不能把所有元数据一并列为未采用 |
| 原生 TUI 界面与平台专属体验 | 由配套 CLI 提供，不在 Gateway 复制终端、任务面板、Worktree 或编辑器交互 |

### Workspace 与上游 Project 的职责

Workspace 保留为渠道可选目录和 Conversation 路由配置；Thread、历史与执行权限
仍由 App Server 管理。当前是 Surface Actor 准入加全局 Workspace 注册表，不是逐 Actor 的
独立工作区 ACL；登记 cwd 也不等于建立操作系统沙箱。

固定版 Project 保存名称、多个 roots、排序和 Thread 分组。`thread/start` 仅核验 projectId
对应项目存在，cwd、运行根目录及权限另行处理；Thread 归入 Project 不要求 cwd 位于其 roots。
删除 Project 只解除分组，不删除 Thread 或磁盘目录。Codex `[projects."/path"].trust_level`
又是独立的项目配置可信度设置，不能作为渠道访问许可。
依据为固定源码 `app-server-protocol/src/protocol/v2/project.rs`、
`app-server/src/request_processors/thread_processor.rs`、`state/src/runtime/projects.rs` 和
`config/src/config_toml.rs`（均位于 `codex-rs/`）。

因此，本次保留全局配置读取无 cwd、Workspace 查询显式 cwd；前台移除网关权限覆盖，恢复仍
核对实际响应。Project 的实验状态不是永久拒绝理由；未来若需要与官方客户端共用项目
名称、多根目录或 Thread 分组，应优先评估上游作为项目数据来源，避免两边重复维护。
接入前仍须确定渠道准入、执行目录选择、项目变化与删除后的绑定处理，以及不同 Provider
实例间的项目身份；不能把 Project 分组直接提升为授权。

共享范围也须区分：`codexc remote --workspace` 读取 Gateway 注册表选择目录，不注入权限默认值，
原生 `codex --remote` 本身不读取该注册表。在登记目录的子目录普通新建 Remote 会话，
仍保留子目录 cwd；恢复／派生未显式选目录时不再注入 `-C`，由原生 Remote 处理目录继承与新建回退；
渠道按登记根目录精确查询和恢复，不能保证接续子目录 Thread。
`codexc remote --workspace <ID>` 使用登记根目录。此差异已沿
`scripts/codex-remote.mjs`、`src/session-routing/router.ts`、`src/codex-client/client.ts`
及上游 Thread 列表过滤实现核对。Remote 的普通新建、恢复、派生和显式 `-C` 已通过隔离的
0.163.0 App Server 与真实 TUI 入口观察：新建使用启动目录，恢复／派生保留会话目录，显式目录覆盖生效。
渠道的子目录恢复限制尚未运行复现，也没有证据将其归因于本次升级。
若扩展子目录互通，必须一并审查列表、恢复、嵌套工作区归属与权限，不能只放宽查询过滤。

## 全表复核范围与结论

此前 0.163.0 复核覆盖精确生成差异、Client 到 Core/Surface 的消费链、配置与权限恢复、动态工具
取消、模型请求到 Provider Proxy/Relay 的边界，以及安装更新、启动版本核验、CI 和文档合同。
本页开头记录的隔离运行观察仍有效；静态关联审查不等于重新执行所有既有能力的验收。
此前全表复核中的能力分类、持续不采用与重新评估条件继续作为既有决定保留。
0.160.0 原生 daemon 专项源码审查和隔离实测作为历史依据保留。
各表项目数会随基线和决策变化，不作为完整性的人工校验值；
完整性由固定版本源码、生成协议、支持矩阵和实现入口交叉复核。
核对方式为固定版本源码与生成协议、本地调用与控制路径及支持矩阵；
产品边界与重评条件按现有职责复核，不将“有上游接口”自动解释为应当接入。
这项表格复核不自动补齐在线、平台和渠道实机验收；已完成的飞书
图片自动引用验收及其他剩余项以“验收与发布状态”和渠道验收矩阵为准。

已确认的实施边界包括：Queue/Revert 写请求不盲目重试；异步回答仍作为普通输入提交；
Luna Reserve 的原模型记录只在内存中；Config 使用用户层版本校验；`/responses/compact`
旧代理路径拒绝；已采用的媒体、模型和用量字段不因未采用其他元数据而被取消。
本页保留的三项既有决定仍适用，相关行为依据继续由支持矩阵和专题文档维护。

此前全表复核中发现的落地差异已修正：根规则和协议索引列明既有前台 `schedule_task` 与图片上传账户
路由的精确受控范围；CLI 菜单已清理人格设置的残留提示。现有功能与本页决策保持一致，原生图片
文件引用仍受前述上游通路限制，在线与各平台验收按“验收与发布状态”单独跟踪。

## 何时重新评估

仅在下面条件成立时复核相关决定，不把候选项当成已排期功能。

| 需求或触发条件 | 复核范围 |
| --- | --- |
| 需要与官方客户端共用项目名称、多根目录或 Thread 分组 | 评估 Project 作为项目数据来源，保留渠道准入与路由；核验实验协议、项目变更/删除、Provider 实例身份及数据处理方案，不另建平行分组索引 |
| 需要在渠道接续从工作区子目录启动的原生 Thread | 明确 cwd 与登记目录的关系，一并审查列表、恢复、嵌套工作区和权限；不把 Project 归属或路径前缀直接当作访问许可 |
| 图片引用需要区域路由、更多账户／模型或远端生命周期能力 | 分别核验官方路由约束传递、目标模型与编号互通、编号过期、取回和删除合同；不以当前默认后端的成功推导其他范围，也不把文件管理作为既有交付内容 |
| 现有 stdin 审批与表单合同仍无法承载的新交互需求 | `writeStdin` 已在 0.160.0 接入；只复核超出现有合同的输入与新表单，明确预览、一次性请求、取消与跨客户端失效 |
| 未来明确恢复原生 daemon 接入工作 | 当前暂缓；恢复时按专项审查先设计 Provider 配置/数据归属和代理生命周期，再验证自动续做、精确版本更新与平台监管；不是立即启用官方自动更新 |
| 用户需要在活动 Turn 中修改设置，或执行现有入口无法承载的长命令 | 分别评估活动 Turn 设置和线程 Shell 超时，明确与下一 Turn 偏好及普通工具执行的区别 |
| 认证等待难以理解，或特定 MCP 登录／资源读取出现实际兼容问题 | 分别评估认证恢复提示、OAuth 注册策略、Hosted App 资源归属；不顺带引入营销通知或凭据管理 |
| Plugin 生产支持或审批来源协议发生变化 | 核实固定版本官方限制及可信来源字段，不根据工具名称或事件先后推断命令来源 |
| 受管模型策略确实影响当前部署 | 评估如何只读说明限制，不把策略信息映射为自动批准或未经确认的模型切换 |
| MCP 协议升级影响 App Server 对 Gateway 暴露的状态或请求 | 仅适配受影响的公开边界，不实现独立 MCP Client |

长会话 Fork 等已有功能的验证缺口属于行为验收工作；出现实际回归时复核，
不作为新增功能长期挂在候选列表中。

## 仍有效的既有升级决定

### 摘要、压缩与生成能力

继续保留三项会影响用户或后续升级的决定：

- **摘要默认关闭。** 未配置时预选 `none`；更新器不改写用户已有选择，配置仍由 Config 管理。

- **压缩使用当前 Responses 通路。** 移除旧 `/responses/compact` 代理路由，旧请求返回 404；
  按请求类型统计压缩。压缩失败时上游保留输入，不代表输入执行成功，Gateway 不自动重发。
- **新生成能力不自动开放。** 设备验证取消、Thread 附件记录、记忆状态和反馈元数据继续留在
  生成层；原生实时语音、daemon 更新和 Bedrock 凭据命令不增加 Gateway 入口。

### 验证依据

| 验证层次 | 本页的使用方式 |
| --- | --- |
| 固定版本上游源码与测试 | 证明字段含义和上游内部行为，定位见[官方源码索引](index.md#固定版本官方源码) |
| 本项目静态检查与源码审查 | 核对类型、协议结构与本地入口；行为验收另行记录，入口见[支持矩阵](index.md#当前支持矩阵) |
| 发布与实机验收 | 以对应 PR、CI、发布说明和[渠道验收矩阵](channel-acceptance-matrix.md)为准；跳过项不计通过，旧版本实测不直接算作新版本结果 |

Desktop 私有工具 Pipe、签名链、Windows/WSL 实机和在线第三方模型行为，不能仅凭协议或构建
检查通过宣告可用。具体限制分别见[Desktop 方案](codex-desktop-app-development.md)与渠道验收矩阵。

## 后续维护

每次升级只做三件事：

1. 按[升级流程](codex-cli-upgrade.md)核对官方正式 Release、生成差异和受影响实现，完成必要验证。
2. 更新本页的当前取舍与基线影响：改变决定时说明新范围和理由，仍有效的决定不按版本重复抄写。
3. 在升级 PR 与对应发布说明保存本次采用、不采用、风险和实际验证结果；本页只链接证据，不累积阶段性日志。

历史逐版本细节保留在 Git 历史与发布说明中。需要理解当前范围的关键变化是：自定义分区曾在
0.147.0 接入，0.153.4 撤回，保留置顶；0.150.0 未接入的电脑／浏览器能力，现在仅采用上表所列
原生配置与既有 MCP 展示、审批路径，未扩展成独立桌面控制服务。
