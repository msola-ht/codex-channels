# Codex CLI 升级决策

本页说明当前项目采用什么、为什么采用，以及哪些上游能力仍不接入，供下一次升级直接复核。
当前基线为 `codex-cli 0.163.0`；具体协议和实现以[支持矩阵](index.md#当前支持矩阵)为准，
升级步骤与门禁见[升级流程](codex-cli-upgrade.md)。本页不重复协议数量、命令参数或逐版本更新日志。

## 当前基线与升级取舍

**决定：采用 `0.163.0` 正式版本，保留现有渠道能力边界，不为本次升级新增实验功能。**
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
原生 `codex --remote` 本身不读取该注册表。在登记目录的子目录启动 Remote，
仍保留子目录 cwd；渠道按登记根目录精确查询和恢复，不能保证接续该 Thread。
`codexc remote --workspace <ID>` 使用登记根目录。此差异已沿
`scripts/codex-remote.mjs`、`src/session-routing/router.ts`、`src/codex-client/client.ts`
及上游 Thread 列表过滤实现核对，尚未运行复现，也没有证据将其归因于本次升级。
若扩展子目录互通，必须一并审查列表、恢复、嵌套工作区归属与权限，不能只放宽查询过滤。

## 全表复核范围与结论

本次 0.163.0 复核覆盖精确生成差异、Client 到 Core/Surface 的消费链、配置与权限恢复、动态工具
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
