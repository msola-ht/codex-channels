# CLI 全链路审查记录

本文按命令逐项记录 CLI 的入口、参数、状态变化、热重载/热重启影响、错误路径、测试覆盖和结论。
审查阶段只记录事实与风险，不在单条记录中直接修改实现；全部命令完成后，再依据记录统一制定修复批次。

## 审查范围与口径

- `codexc service` 下的公开服务生命周期命令单独审查：`install`、`uninstall`、`start`、`stop`、`reload`、`restart`、`status`、`logs`。
- `codexc uninstall` 是源码安装卸载入口，与 `codexc service uninstall` 分开记录；前者最终会调用后者，但还会删除源码和全局命令。
- `gateway` 与 `service-app-server` 是服务模板内部入口，不属于公开 CLI；其进程行为已在 `start`、`service` 和 `update` 记录中覆盖，不重复伪装成用户命令。
- “热重载”仅指向运行中的 Gateway 发送配置重载信号；“热重启”指重启 Gateway 或 App Server，不等同于重建服务定义。

## 记录 01：`codexc service install`

### 入口与参数

- 公开入口：`codexc service install`，不接受位置参数。
- 顶层 CLI 先解析配置，再按平台进入 launchd、systemd 或 Windows 计划任务控制器。
- 主要阶段为：配置校验、平台预检、生成全部服务定义、激活核心服务、等待 App Server 与 Gateway 就绪。

### 状态变化

- 为 App Server、Gateway、WebUI、指标中心生成服务定义。
- 自动停止并重新激活核心服务；安装完成后等待 App Server 和 Gateway 的就绪状态。
- WebUI 与指标中心只生成定义，不自动启动。
- 不修改用户配置、数据库、凭据或指标记录。

### 热重载与热重启影响

| 项目 | 行为 |
| --- | --- |
| Gateway 热重载 | 不执行 |
| Gateway 热重启 | 可能在平台激活阶段发生 |
| App Server 重启 | 会发生 |
| WebUI/指标中心 | 仅写入定义，不启动 |

因此该命令不是“重新读取配置”，也不是单纯 Gateway 热重启，而是“服务定义重建 + 核心服务重新启动”。

### 错误路径与恢复

- 配置校验或平台预检失败时，不应写入新的服务定义。
- 生成定义成功、激活核心服务或就绪等待失败时，会恢复旧服务定义，并在已经尝试激活核心服务时再次按旧定义执行核心服务激活。
- 运行态恢复失败会报告 `manual-restore`，要求人工检查服务管理器和日志；定义回滚不等于服务进程已经恢复。

### 测试覆盖

- `tests/service-install-management.test.ts` 覆盖计划生成、阶段进度和阶段失败报告。
- 平台脚本测试覆盖安装动作与核心服务启动文案。
- 已覆盖：阶段失败后的定义恢复入口；仍未覆盖真实平台服务管理器在激活失败后的运行态恢复。

### 结论

主流程和“保留用户数据”的边界清楚；安装失败现在会尝试恢复定义和核心运行态，但恢复失败仍需人工处理。该命令明确归类为“安装并启动核心服务”，WebUI/指标中心只生成定义、不随安装启动。

## 记录 02：`codexc service uninstall`

### 入口与参数

- 公开入口：`codexc service uninstall`，不接受位置参数。
- `bin/codexc.mjs` 对该动作允许使用不完整或无效的 Gateway 配置，以便配置损坏时仍能卸载服务。
- 按平台委派给 launchd、systemd 或 Windows 计划任务控制器。

### 状态变化

- 解析并停止 App Server、Gateway、WebUI、指标中心的受管服务。
- 删除对应服务管理器定义：macOS 删除 LaunchAgent plist，Linux 删除 systemd 用户 unit，Windows 注销计划任务并删除定义文件及生成的 VBS 启动器。
- 保留 `~/.codex-connect` / `CODEX_CONNECT_HOME` 中的配置、数据库、凭据、日志和其他运行数据。
- 不删除源码目录、npm 全局命令或旧 Shell PATH；这些属于另一个 `codexc uninstall` 入口的职责。

### 热重载与热重启影响

| 项目 | 行为 |
| --- | --- |
| Gateway 热重载 | 不执行 |
| Gateway 热重启 | 不执行；会停止 Gateway |
| App Server 重启 | 不执行；会停止 App Server |
| WebUI/指标中心 | 停止并移除其服务定义 |

这是不可继续由服务管理器监管的停服操作，不应描述为热重启或配置重载。

### 错误路径与恢复

- 停止不存在的服务按“已停止”处理：launchd 通过 Job 查询跳过未加载任务，systemd 对 `LoadState=not-found` 跳过停止。
- macOS 使用 `stop_job` 后直接删除 plist；停止等待超时会使脚本失败，后续删除动作不会继续。
- Linux 现在会让 `disable --now` 失败直接中止并保留 unit 文件，避免服务仍在运行但定义已删除；后续仍需补统一的部分卸载结果对象。
- Windows 逐项停止、注销任务并删除定义；单项异常会中断后续项，当前没有已完成项清单或恢复提示。
- 顶层没有统一的部分卸载结果对象，也没有自动备份服务定义；用户数据虽保留，但服务恢复依赖重新执行 `service install`。

### 测试覆盖

- `tests/launchd-install.test.ts` 验证删除 launchd plist 且保留用户配置。
- `tests/systemd-install.test.ts` 验证缺失 unit 可安全停止、卸载删除 unit 且保留用户配置，并覆盖基本生命周期调用。
- `tests/windows-service-control.test.ts`（如平台可执行）覆盖计划任务控制器的基本动作。
- 未覆盖：部分卸载后的状态报告、跨平台失败恢复一致性、服务定义备份与恢复。

### 结论

服务定义删除范围明确，用户数据保留边界符合文案；Linux 现在会在停止或禁用失败时保留定义并失败关闭。跨平台仍缺少统一的部分卸载结果对象。该命令与 `service install` 应作为同一“服务定义事务”批次处理，但不能与源码卸载混为一个删除动作。

## 记录 03：`codexc service start`

### 入口与参数

- 公开入口：`codexc service start [gateway|app-server|webui|center|all]`，默认目标为 `all`。
- 顶层 CLI 对除卸载、停止、重载、状态和日志外的动作先完成有效 Gateway 配置加载；配置错误会在服务控制前失败关闭。
- `all` 通过统一服务目标表只解析 App Server 与 Gateway，不包含 WebUI 和指标中心。

### 状态变化

- launchd：必要时 bootstrap 未加载的 Job，再 kickstart 目标；核心目标按 App Server → Gateway 的顺序启动。
- systemd：按目标调用 `systemctl --user start`；核心 `all` 同样只启动 App Server 与 Gateway。
- Windows：读取受管 JSON 定义，必要时启动计划任务和宿主进程，并按 App Server Socket/监管状态等待。
- 核心目标启动后，顶层额外等待目标达到稳定就绪；已配置的 WebUI 与启用的指标中心会额外进行有界 HTTP 健康确认。

### 热重载与热重启影响

| 目标 | 行为 |
| --- | --- |
| `gateway` | 启动 Gateway；App Server 保持原状态；不是热重载 |
| `app-server` | 启动 App Server；Gateway 不自动启动；不是热重载 |
| `all` | 启动 App Server 与 Gateway，并等待二者稳定就绪 |
| `webui` / `center` | 启动独立服务；对已配置/启用的服务等待有界 HTTP 健康状态 |

如果目标已运行，平台行为通常是保持运行（launchd 的 `kickstart -k` 可能重新拉起进程），因此不能把 `start` 解释为纯幂等的“确保运行”或配置重载。

### 错误路径与恢复

- 未安装或服务定义缺失时，各平台控制器返回失败；Windows 会明确提示重新执行 `codexc service install`。
- 核心服务启动后在就绪等待超时，命令返回失败并带状态/日志排查建议；已启动的进程不会由顶层自动回滚或停止。
- App Server 与 Gateway 分步启动时，前者成功、后者失败会留下部分启动状态；没有统一的部分成功结果对象。
- WebUI/指标中心启动命令返回成功但进程随后立即退出时，当前命令不会感知，需另行执行 status/logs。

### 测试覆盖

- `tests/launchd-install.test.ts`、`tests/systemd-install.test.ts` 覆盖核心与独立目标的启动调用、目标筛选和基础文案。
- `tests/local-update.test.ts` 覆盖核心 App Server/Gateway 就绪检查、稳定窗口和超时排查文案。
- Windows 控制器测试覆盖定义读取和核心启动路径（受平台执行条件限制）。
- 未覆盖：核心部分成功后的统一结构化结果、WebUI/指标中心真实平台启动后的健康确认、已运行目标重复 start 的跨平台一致语义。

### 结论

核心启动路径有较完整的配置校验和稳定就绪等待；目标语义也明确，`all` 不包含独立 WebUI/指标中心属于既有设计。独立服务现在对已配置/启用目标做健康等待；Linux/macOS 已在多目标动作失败时收集失败目标并输出部分失败摘要，Windows 启动也会收集失败目标，但跨平台仍未形成统一 JSON 动作结果和回滚契约。

## 记录 04：`codexc service stop`

### 入口与参数

- 公开入口：`codexc service stop [gateway|app-server|webui|center|all]`，默认目标为 `all`。
- 允许在 Gateway 配置无效或缺失时执行，以便故障状态下仍可停服。
- `all` 通过服务目标表只解析核心 App Server 与 Gateway，不包含 WebUI/指标中心；独立服务需要显式指定目标。

### 状态变化

- launchd、systemd、Windows 均按目标停止受管服务，不删除服务定义。
- 核心 `all` 按 Gateway → App Server 的停止顺序执行，避免 Gateway 在 App Server 之前继续接收新请求。
- 停止后不等待新的“已停止健康状态”窗口，也不修改配置、数据库、凭据或运行数据。
- systemd 对明确不存在的 unit 视为已停止；launchd 对未加载 Job 直接跳过；Windows 需要读取定义并执行宿主/计划任务停止。

### 热重载与热重启影响

| 目标 | 行为 |
| --- | --- |
| `gateway` | 停止 Gateway，App Server 保持运行 |
| `app-server` | 停止 App Server，Gateway 可能失去后端连接 |
| `all` | 停止 Gateway 与 App Server |
| `webui` / `center` | 停止对应独立服务 |

该命令是明确停服，不属于热重载或热重启；Gateway 停止不应主动终止共享 App Server，只有显式目标包含 App Server 时才停止它。

### 错误路径与恢复

- launchd 停止等待 Job 卸载有超时；超时会失败并保留定义。
- systemd `stop_unit` 会传播停止失败，不会删除 unit；这与 `service uninstall` 的静默吞错行为不一致。
- Windows 停止宿主失败会抛错并中断后续目标；没有部分完成清单，也不自动重试。
- 多目标顺序执行时，前一个目标成功、后一个失败会留下部分停服状态；顶层没有统一结构化结果或恢复建议。
- 停止不存在服务的“成功”语义跨平台基本一致，但 Windows 缺失定义更倾向于报错，存在轻微平台差异。

### 测试覆盖

- `tests/launchd-install.test.ts`、`tests/systemd-install.test.ts` 覆盖默认 `all`、单目标停止、停止顺序和缺失服务处理。
- `tests/codexc-cli-suite.ts` 覆盖 App Server 服务角色下禁止停用核心服务的安全边界。
- Windows 控制器实现有核心停止路径，但当前仓库没有同等独立的 Windows 停止集成测试文件。
- 未覆盖：部分停止后的结构化状态、停止后残留进程检测、Windows 缺失定义与其他平台的统一策略。

### 结论

停止命令的目标边界和数据保留原则清楚，核心停止顺序合理；主要问题不是正常路径，而是部分失败缺少统一结果，且 Windows 对缺失定义的处理与 Unix 平台不完全一致。后续修复应与卸载命令共享“先确认停止、失败不掩盖、返回部分结果”的生命周期契约，但不能把 `stop` 扩展为删除定义。

## 记录 05：`codexc service reload`

### 入口与参数

- 公开入口：`codexc service reload`，不接受服务目标；固定针对 Gateway。
- 顶层允许在 Gateway 配置无效时进入服务控制脚本，但 Gateway 进程自身只有在能成功读取新配置时才会应用变更。
- 三个平台都通过 Gateway 监管入口或 SIGHUP 请求重新读取配置。

### 状态变化

- launchd：要求 Gateway Job 已加载；发送 SIGHUP 成功时只触发 Gateway 重新读取。若 Job 已加载但当前进程不能接收信号，则失败并提示用户显式启动，不再调用 `start_job` 隐式启动 Gateway。
- systemd：要求 Gateway unit 处于 active，否则失败；向主进程发送 HUP。
- Windows：读取 Gateway 定义，通过私有控制入口发送 `reload` 请求；入口不存在或响应不成功时失败，不自动启动。
- Gateway 收到重载后按配置分类器处理：可热加载项直接应用；涉及连接或运行时资源的项由监管模式自动重启 Gateway；涉及 App Server 服务定义的项保留旧配置并要求重新安装服务。

### 热重载与热重启影响

| 配置变化 | Gateway 行为 |
| --- | --- |
| Workspace/允许名单等可热加载项 | 原进程应用，不重启 |
| Surface 凭据、模型、指标、存储等连接/运行项 | 监管模式退出，由服务管理器重启 Gateway |
| Codex binary、Socket、网络代理 | 保留旧配置，要求 `service install` 重建定义 |
| 无变化 | 记录“配置没有变化”，不重启 |

因此“reload”不是保证无重启的操作；它是向 Gateway 发出重载请求，最终是否热加载或热重启由分类器决定。

### 错误路径与恢复

- systemd/Windows 在 Gateway 未运行时明确失败并提示先启动。
- launchd 在 Gateway Job 已加载但进程不存在或无法接收信号时会隐式启动 Gateway，和另外两平台不一致，也可能造成用户未预期的启动行为。
- Gateway 读取新配置失败时保留旧配置并记录错误；服务命令本身通常只能知道信号/控制请求是否送达，不能直接返回配置分类或最终重启结果。
- Gateway 因 restart 分类退出时，监管服务可能自动拉起；命令没有统一等待重启完成或返回新旧配置状态。

### 测试覆盖

- `tests/launchd-install.test.ts` 覆盖 launchd 重载成功和“无可接收进程时自动启动”的恢复路径。
- `tests/systemd-install.test.ts` 覆盖 unit 未运行时失败以及 HUP 调用。
- Windows 控制器实现覆盖控制入口失败文案，但没有与 launchd/systemd 对齐的跨平台契约测试。
- `src/config/reload-classifier.ts` 和 `src/bootstrap/config-lifecycle.ts` 的单元测试覆盖分类与旧配置保留，但未覆盖 CLI 发起重载后服务管理器最终状态的端到端结果。

### 结论

重载的配置分类和 Gateway 内部失败关闭逻辑清楚；主要问题是平台行为分裂：macOS 会在特定失败路径隐式启动 Gateway，Linux/Windows 则要求用户先启动。该差异正是“没有发启动却被启动”的高风险来源，应在后续统一生命周期修复中收敛为一致语义。另一个改进点是命令结果应区分“请求已送达”“已热加载”“将由监管器重启”三种状态，而不是统一显示已通知。

## 记录 06：`codexc service restart`

### 入口与参数

- 公开入口：`codexc service restart [gateway|app-server|webui|center|all]`，默认目标为 `gateway`。
- 核心目标需要有效 Gateway 配置；服务角色为 `app-server` 时禁止重启 App Server 或包含 App Server 的 `all`，避免渠道内自断连接。
- 顶层对核心目标（Gateway、App Server、all）执行稳定就绪等待；已配置的 WebUI 与启用的指标中心额外执行有界 HTTP 健康检查。

### 状态变化

- launchd：对目标 Job 执行 `kickstart -k`，由 launchd 直接替换运行进程；不先 bootout。
- systemd：对目标 unit 执行 `systemctl --user restart`。
- Windows：先停止目标宿主/计划任务，再按定义重新启动并等待宿主；App Server 还等待 Socket 与监管入口就绪。
- `gateway` 默认只重启 Gateway，App Server 保持运行；`app-server` 重启后 Gateway 依赖自动重连；`all` 按停止/启动顺序重启两个核心服务。

### 热重载与热重启影响

| 目标 | 行为 |
| --- | --- |
| `gateway` | Gateway 热重启级别的进程替换，App Server 不动 |
| `app-server` | App Server 重启，Gateway 保持运行并等待重连 |
| `all` | App Server 与 Gateway 都重启 |
| `webui` / `center` | 独立服务重启，不属于 Gateway 热重载 |

这是明确的重启命令，不发送配置 HUP，也不重新生成服务定义。

### 错误路径与恢复

- 目标服务未安装或定义缺失时，平台控制器失败；Windows 会在读取定义阶段明确提示重新安装。
- 停止成功、重新启动失败时没有自动恢复旧进程或统一回滚；核心就绪等待超时也不会主动停止新进程。
- `all` 的 App Server/Gateway 是分阶段操作，任一阶段失败都会留下部分重启状态；CLI 没有结构化列出已完成和未完成目标。
- Windows 对 App Server 使用宿主与 Socket 双重等待，launchd/systemd 依赖顶层统一等待；独立服务的健康检查依赖配置端点可访问。
- 用户看到“重启操作已完成”后，核心服务可能仍处于等待稳定窗口，实际最终失败需要从后续状态/日志确认。

### 测试覆盖

- launchd/systemd 安装测试覆盖默认 Gateway、单 App Server、`all` 的目标筛选和调用顺序。
- `tests/local-update.test.ts` 覆盖顶层核心服务就绪等待与超时。
- `tests/codexc-cli-suite.ts` 覆盖 App Server 服务角色安全拒绝、未受管服务提醒和参数错误。
- 未覆盖：停止后启动失败的进程回滚、跨平台最终状态契约、真实平台独立服务健康失败路径、核心部分重启的结构化结果。

### 结论

目标语义和安全拒绝边界清楚，默认只重启 Gateway 也符合“Gateway 停止不得终止共享 App Server”的项目约束。主要风险仍是重启不是事务：停止成功后启动失败会留下停服状态，且核心目标缺少统一部分结果对象。独立服务已加入健康等待，但真实平台失败路径仍需补充。

## 记录 07：`codexc service status`

### 入口与参数

- 公开入口：`codexc service status [gateway|app-server|webui|center|all]`，默认目标为 `all`。
- 支持 `--json`；顶层 JSON 入口改走统一的 `scripts/service-status.mjs`，普通文本输出则直接委派平台控制脚本。
- 状态查询允许配置缺失或无效，以便诊断服务定义和进程状态。

### 状态变化

- 只读查询，不启动、停止、重启、重载或修改服务定义/用户数据。
- JSON 结果统一包含 `platform`、`target`、`healthy`、`services[]`，每项包含目标、名称、标识符、`loaded`、`running`、`state` 和 PID。
- Windows JSON 额外检查宿主控制入口和 App Server Socket；Linux JSON 读取 systemd 的 Load/Active/Sub/MainPID；macOS JSON 读取 launchd Job 状态。
- 默认 `all` 仍只检查核心 App Server 与 Gateway；WebUI/指标中心必须显式指定。

### 热重载与热重启影响

- 完全只读，不触发热重载或热重启，也不因服务异常自动拉起进程。
- 查询 Gateway 的 `running`/`healthy` 不会验证配置是否已热加载完成；配置分类和监管重启状态仍需看 Gateway 日志。

### 错误路径与恢复

- JSON 模式下，服务缺失通常返回结构化 `loaded=false/running=false/healthy=false`；平台查询工具本身异常才返回错误。
- 普通文本模式存在平台差异：macOS `launchctl print` 成功即视为已加载，不区分 Job 已加载但进程已停止；Linux `systemctl status` 反映 unit 状态；Windows 文本模式显示任务/宿主状态。
- 因此 macOS 普通 `status` 可能在进程不运行时返回成功，和 JSON 的 `healthy=false` 不一致。
- `all` 不含独立服务，用户可能看到核心健康但 WebUI/指标中心未安装或已停止；需要分别查询才能发现。
- 状态查询失败只报告当前平台错误，不提供统一的 `start`/`logs` 操作建议（JSON 消费者也需自行解释）。

### 测试覆盖

- `tests/codexc-cli-suite.ts` 覆盖 systemd JSON 的 loaded/running/缺失状态、普通文本错误去重以及参数校验。
- `tests/launchd-install.test.ts`、`tests/systemd-install.test.ts` 覆盖平台脚本的基础 status 调用。
- Windows 状态实现覆盖结构化字段和 RPC/Socket 健康检查，但没有完整的跨平台结果契约测试。
- 未覆盖：macOS 普通 status 对 stopped Job 的误报、普通文本与 JSON 一致性、独立服务默认可见性和统一排障建议。

### 结论

JSON 状态模型是目前最完整、最适合后续自动化的事实接口；普通文本仍受平台脚本历史行为影响，尤其 macOS 只判断 Job 是否加载，可能把未运行服务显示为正常。多目标动作现在会报告失败目标，但文本和 JSON 仍不是同一动作结果模型；后续应让文本输出复用同一健康模型，并明确 `all` 是核心服务集合还是全部受管服务，避免与用户对 WebUI/指标中心的预期冲突。

## 记录 08：`codexc service logs`

### 入口与参数

- 公开入口：`codexc service logs [gateway|app-server|webui|center|all] [--follow|-f] [--lines|-n <1..10000>]`，默认目标为 `gateway`。
- 参数在顶层先解析；未知参数、非法行数和多余目标会在读取配置前失败。
- `all` 通过服务目标表只解析核心 App Server 与 Gateway，不包含 WebUI/指标中心。

### 状态变化

- 只读日志，不启动、停止、重启或重载服务。
- macOS 读取运行目录下 Gateway/App Server/WebUI/指标中心的 stdout 与 error 日志文件；`--follow` 使用 `tail -F`。
- Linux 读取 systemd 用户 Journal；`--follow` 交给 `journalctl --follow`。
- Windows 从服务定义中的 stdout/stderr 日志路径读取；跟随模式使用 PowerShell 日志脚本。
- 默认显示最近 100 行，范围限制为 1–10000 行。

### 热重载与热重启影响

- 完全不触发热重载或热重启；跟随日志只保持当前 CLI 进程运行。
- 日志内容可反映 Gateway 收到 HUP 后是热加载、受监管重启还是拒绝新配置，但命令本身不解释这些状态。

### 错误路径与恢复

- 找不到日志时返回失败，并提示先启动服务、检查状态；不会隐式启动服务。
- macOS 文件日志可能同时显示普通日志与错误日志，`all` 还可能出现多文件交错，当前没有统一时间/服务前缀。
- Linux Journal 查询由系统工具决定；Journal 不可用或权限不足时返回底层错误。
- Windows 服务定义缺失/无效时失败并提示重新安装，即使日志文件本身仍可能存在。
- `--follow` 是长驻操作，没有 CLI 内置超时；终止依赖用户发送信号，平台脚本未额外汇总退出原因。

### 测试覆盖

- `tests/codexc-cli-suite.ts` 覆盖参数校验、默认 Gateway、行数边界和 systemd 日志参数。
- `tests/launchd-install.test.ts`、`tests/systemd-install.test.ts` 覆盖普通/跟随模式调用以及 `all` 的核心目标筛选。
- Windows 日志读取实现有单元级路径逻辑，但缺少跨平台长驻跟随和日志缺失契约测试。
- 未覆盖：文件日志多源排序、统一服务/时间前缀、敏感字段脱敏回归和跟随进程的信号关闭验证。

### 结论

日志命令的参数边界、只读性质和“不隐式启动”原则清楚；主要可用性问题是不同平台日志来源和格式不统一，文件日志多源混排时不易判断来源。后续应保持 `logs` 只读，不把它与状态/启动耦合；若统一输出，优先增加服务名与时间前缀及敏感字段验证，而不是改变底层日志保留策略。

## 记录 09：`codexc setup`

### 入口与参数

- 公开入口：`codexc setup [--json]`；默认进入交互菜单，`--json` 保留交互输入并把提示写入 stderr、结果以 JSON Lines 写入 stdout；`-h/--help` 输出说明。
- 顶层仅负责启动 Setup 总菜单，菜单分为配置总览、Codex 新会话默认值、模型与提供商、通讯渠道、项目技能五类。
- 各类别再委派到独立 Setup 模块；取消和返回通过统一结果值回到上一级菜单。

`--json` 的机器输出协议按“每行一个事件”处理，stdout 不出现 Clack 提示、状态标签或堆栈文本：

- 完成一个类别时输出 `{ "event": "result", "category": "channels|codex_user|models|skills", "result": { ... } }`；`result` 沿用子模块的公开字段，并包含统一的 `activation` 与 `activationResult`（若该操作无需激活则不强行添加）；子模块没有结果时使用 `result: null`。
- 用户取消顶层菜单时输出 `{ "event": "cancelled" }`；未处理异常输出 `{ "event": "error", "message": "..." }`，同时进程返回非零状态；错误消息会做凭据字段脱敏并限制长度。
- 令牌等敏感字段不会进入 stdout；生成令牌结果只保留“已生成”标记。需要人阅读的提示、进度和失败文案全部写入 stderr。
- 该协议是结果流，不是配置导出；脚本应按 `event` 判断状态，不能依赖提示文本或行数。

### 状态变化

- 配置总览只读显示脱敏状态。
- Codex 默认值、Provider、渠道和技能设置由子模块分别写入 Codex 用户配置、Gateway `config.toml`、凭据存储或技能目录。
- Setup 本身没有跨类别事务、统一修订号或统一“本次修改清单”；一次交互只能保证当前子模块的写入原子性。
- 子模块写入后返回统一激活结果；Setup 默认只输出后续生效命令，不自动执行服务重载/重启。

### 热重载与热重启影响

- Setup 菜单本身不触发通用热重载或热重启；数据中心 Config 是显式注入服务回调的例外。
- 配置写入提示已统一复用 `activationResult`：渠道配置区分 Gateway 重建，Codex 默认值/第三方 Provider 指向 `restart all` 或 `restart app-server`，涉及服务环境的设置要求重新安装服务。
- 运行中的 Gateway 可能自动重载配置并自行退出，由监管器重启；前台进程需要用户手动重启。Setup 不等待最终生效状态；`--json` 会逐项输出脱敏的结构化激活结果。

### 错误路径与恢复

- 菜单选择取消不会写入当前未确认的设置；子模块验证失败通常在写入前退出。
- 跨模块连续修改时，前一个模块已成功、后一个模块失败不会回滚前一个修改；Setup 没有汇总部分成功状态。
- 某些设置依赖 App Server 返回模型目录或用户配置版本；服务未运行、版本变化或连接失败时错误来自子模块，顶层不统一归一化。
- 统一结果已消除大部分重启建议的语义差异；Setup 已提供 JSON Lines 结果流，仍需由服务生命周期执行器补齐跨平台多目标部分失败后的统一结构化动作结果。

### 测试覆盖

- `tests/setup.test.ts` 覆盖总菜单分类、返回/取消、模型与渠道子菜单委派和模块调用参数。
- 各 Setup 子模块有独立测试，覆盖输入验证、确认取消和部分配置写入。
- 未覆盖：跨模块部分成功后的统一摘要、服务未运行时的交互引导、Setup 完成后验证实际运行状态；各子模块激活类别、可执行命令和 JSON Lines 结果已有统一结果测试。

### 结论

Setup 的职责拆分和返回路径清楚，脱敏总览与确认机制符合边界；主要子模块返回统一激活结果，`--json` 通过 stderr/stdout 分流避免污染机器输出。后续应保留模块边界，只补齐服务动作结果，不把所有写入合并成大事务。

## 记录 10：`codexc config`

### 入口与参数

- 公开入口：`codexc config` 进入日常设置交互菜单；`codexc config --json` 仅输出用户目录、配置路径和文件是否存在。
- 交互菜单包含配置总览、显示、系统、自动化、网络、高级、WebUI、数据中心、Telegram 格式和路径查看。
- 非 TTY 环境不进入交互，直接输出路径并返回；不隐式修改配置。

### 状态变化

- 各设置子菜单通过 `updateGatewaySetting` 按配置修订号写回 TOML，并由具体模块决定激活方式。
- “数据中心”同时管理本机上报/查看接入、上报参数、本机保留策略、中心监听、双令牌生成与停用。
- 中心令牌生成会原子写入新的设备上报令牌和全局查看令牌，并按“先上报、后查看”的顺序输出；旧令牌立即失效。
- 配置菜单不直接执行通用重启；仅在注入的回调存在时，对中心、Gateway、WebUI 执行对应服务重启。

### 热重载与热重启影响

| 设置类别 | 当前激活行为 |
| --- | --- |
| Gateway 可热加载项 | 由运行中 Gateway 自动读取 |
| 本机上报/查看、指标存储、WebUI 相关 | 通常重启 Gateway 和/或 WebUI |
| 中心监听、中心双令牌、中心数据库 | 重启指标中心 |
| App Server 用户默认值/第三方 Provider | 子菜单提示另行重启 App Server 或全部核心服务 |

中心设置改动在正式 CLI 中会自动调用 `codexc service restart center`；本机接入改动会自动重启 Gateway 与 WebUI。若自动重启失败，配置保留并抛错提示手动命令。

### 错误路径与恢复

- 配置修订冲突、非法端口/令牌/地址、令牌相同或空值会在写入前拒绝。
- 中心监听 `0.0.0.0` 时强制要求查看令牌和设备上报令牌；清除令牌前要求先改回回环监听。
- 自动重启失败不会回滚已写入配置；中心与本机接入菜单返回 `activationState: pending/applied`，失败仍抛出可操作错误并保留手动命令。
- `config --json` 不是脱敏完整配置导出，只能用于定位路径；Setup 的 `--json` 是交互结果流，不应被误解为配置导出。
- Config 和 Setup 仍能修改部分相同设置，但底层写入器与激活结果已复用；跨入口确认流程和服务动作结果仍未完全统一。

### 测试覆盖

- `tests/config-menu.test.ts` 覆盖菜单选择、路径输出和部分设置委派。
- `tests/metrics-config-menu.test.ts`（及相关指标配置测试）覆盖中心连接、双令牌、生成顺序、校验和自动重启回调。
- 各显示、系统、网络、WebUI 子菜单有独立输入与配置写入测试。
- 未覆盖：自动重启失败后的跨模块统一摘要、Config 与 Setup 的重复入口契约、跨多个设置连续修改的部分成功摘要。

### 结论

Config 更适合日常运维，数据中心配置已具备双令牌生成、自动重启和有界健康确认；配置菜单现在与写入器共享激活结果，失败时保留配置并返回待生效状态。Setup 已支持 `--json` 结果流，但服务生命周期结果仍需继续统一；不应再复制一套激活语义。

## Setup + Config 联合审查

### 共同覆盖范围

| 配置领域 | Setup | Config | 当前状态 |
| --- | --- | --- | --- |
| Gateway 基础/显示/权限 | 首次或跨领域设置 | 日常修改 | 底层激活结果和主要文案已统一；`codexc setup --json` 输出脱敏结构化结果 |
| 模型与 Provider | OpenAI、第三方 Provider、共享子代理 | 部分运行参数/数据中心关联项 | 主要 Setup 子模块和 `codexc setup --json` 已返回 `activation`/`activationResult`；服务动作仍未统一结构化 |
| 通讯渠道 | 首次配置和恢复 | 日常渠道参数/格式 | Gateway 内部热加载分类已有测试；平台服务最终状态仍未统一返回 |
| 数据中心 | 由 Setup 进入 Provider/子代理流程 | 本机上报、查看令牌、中心服务、WebUI | 正式 Config 可自动重启并确认；独立 `center config` 仍是保存与重启两个命令 |
| 项目技能/Workspace | Setup 负责入口 | Config 不负责 | 边界清楚，不应互相复制 |

### 统一交互结论

1. Setup 应定位为首次安装、跨领域配置和能力发现；Config 应定位为已运行系统的日常调整与状态查看。
2. 两个入口可以共享底层设置模块和修订校验，但不应各自复制写入、验证、重启判断逻辑。
3. 每次写入都应返回统一激活结果：`无需处理`、`Gateway 热加载`、`Gateway 重启`、`App Server 重启`、`服务重装`、`下次启动生效`。当前 Config 写入器与 Setup 子模块已返回该对象；公开 Setup 通过 `--json` 以 JSON Lines 暴露，默认交互模式仍只显示中文文本。
4. 自动重启成功时显示“配置已保存并已生效”；自动重启失败时显示“配置已保存但尚未生效”，同时给出精确恢复命令。当前数据中心菜单已实现，通用多目标服务动作仍缺少统一部分成功摘要。
5. Setup 和 Config 的文案应统一使用“数据中心”“设备上报令牌”“全局查看令牌”“中心服务”，避免“指标中心/中心/本机接入”在同一流程中交替造成误解。

### 后续修复批次

- 第一批：抽取共享的激活结果模型和文案，统一 Setup/Config/Provider/数据中心的重启提示。
- 第二批：补充自动重启后的健康确认和失败状态返回；不把失败的服务启动伪装成配置已生效。
- 第三批：减少重复菜单入口，只保留职责不同但底层复用的必要路径，并为 JSON/交互输出定义同一字段语义。

## 记录 11：`codexc init`

### 入口与参数

- 公开入口：`codexc init`，不接受参数；已有配置时仍可重复执行。
- 顶层调用 `initializeUserData`，工作区默认为当前进程目录的真实路径，仅在首次创建时写入默认 Workspace。

### 状态变化

- 首次创建用户目录、`runtime`、`data`、`workspace` 子目录，并收紧为当前用户私有权限。
- 原子写入默认 `config.toml`；已有配置不会覆盖，但会重新检查并修正配置文件/父目录权限。
- 不创建指标数据库、状态数据库或服务定义，不启动/停止/重启任何服务。
- 输出配置目录、配置文件和首次创建的默认 Workspace；首次创建后提示继续执行 Setup 与 service install。

### 热重载与热重启影响

- 完全不触发热重载或热重启；初始化只准备磁盘和默认配置。
- 若 Gateway 已运行，重复 `init` 可能只进行权限检查，不会通知运行中的进程重新读取配置。

### 错误路径与恢复

- 参数错误、配置路径不是普通文件/符号链接、父目录权限不安全或文件不属于当前用户时失败关闭。
- 首次创建过程中若后续目录或配置写入失败，当前实现没有统一清理已创建目录的回滚；可能留下不完整用户目录，下一次执行需依赖现有错误重新处理。
- 显式 `CODEX_CONNECT_CONFIG_FILE` 时数据目录取配置文件父目录；目录权限管理范围与默认 `~/.codex-connect` 不同，用户需自行保证父目录安全。

### 测试覆盖

- 初始化逻辑由 CLI 套件和运行时配置测试覆盖首次创建、重复执行、默认字段及权限校验。
- 未覆盖：创建中途失败后的残留目录恢复、已运行 Gateway 时重复初始化的行为说明、显式配置文件父目录的跨平台权限契约。

### 结论

`init` 是幂等的本地引导命令，职责边界清晰且不会误启动服务；主要风险是首次初始化的多步文件操作不是完整事务。后续可补失败清理或明确“部分初始化可重试”的状态提示，但不应把 `init` 与 Setup 或 service install 自动串联，避免隐式启动。

## 记录 12：`codexc start`

### 入口与参数

- 公开入口：`codexc start`，不接受参数；前台运行 App Server 与 Gateway 组合。
- 顶层通过 `scripts/dev-all.mjs` 启动统一 App Server 监管入口，再以受监管子进程启动 Gateway。

### 状态变化

- 读取并校验当前配置，创建私有 runtime 目录。
- 若已有同拓扑监管入口则复用；若检测到非 codexc App Server、部分 Provider 或拓扑不一致，则拒绝补启动。
- App Server Socket 就绪后才启动 Gateway；Gateway 因配置变更返回退出码 75 时，只重启 Gateway 并保持 App Server。
- 前台进程收到 SIGINT/SIGTERM 时按进程树停止 Gateway 与 App Server 监管子进程；不写服务定义。

### 热重载与热重启影响

- 不执行热重载；启动后的 Gateway 处于 supervised 模式，配置要求重建连接时由前台编排器自动重启 Gateway。
- 不会自动安装后台服务，也不会影响已存在的独立 WebUI/指标中心服务。

### 错误路径与恢复

- App Server Socket 在超时前未就绪、已有非受管实例、部分拓扑或 Gateway 启动失败时失败关闭，并尝试终止本次创建的子进程。
- Gateway 异常退出会停止 App Server 并返回失败；配置重启退出码 75 是唯一自动循环重启例外。
- 现有同拓扑监管入口复用时，前台停止会终止自己持有的子进程，但不会验证该监管入口是否由当前命令创建，存在复用生命周期需要额外确认的语义。

### 测试覆盖

- `tests/codexc-cli-suite.ts` 覆盖拓扑复用、非受管实例拒绝、部分 App Server 拒绝、Socket 未就绪、Gateway 重启和信号清理。
- 未覆盖：复用已有监管入口后的所有权交接、前台退出与后台服务同时存在时的冲突提示。

### 结论

前台启动的拓扑检查和失败清理较完整，且与后台服务入口分离；主要需要在最终生命周期文档中明确“前台 supervised”和“后台受管服务”不可混用，并补充复用监管入口的所有权说明，避免用户以为 `start` 会安装或接管后台服务。

## 记录 13：`codexc remote`

### 入口与参数

- 公开入口：`codexc remote [--workspace ID] [Codex 参数...]`；Gateway 参数解析只拦截 Workspace 和受管 Provider Profile，其余参数透传给原生 Codex CLI。
- 受管 Profile 使用规范 `sf-*` 名称；旧名称、Provider ID 和保留 Profile 会明确报错，不提供隐式别名。
- Workspace 必须来自配置注册表；未指定时按当前目录匹配最长路径的 Workspace。

### 状态变化

- 读取 Gateway 配置与 Workspace，解析权限覆盖，连接主 App Server 私有 Socket。
- 选择第三方 Profile 时，通过 App Server 监管入口申请 Provider lease，按需启动隔离 Provider，再以对应 Profile 运行 Codex TUI。
- TUI 退出后释放 Provider lease；不写 Gateway 配置、服务定义或指标数据库。

### 热重载与热重启影响

- 不触发 Gateway 热重载/热重启；Provider lease 的按需启动/释放属于 App Server 监管生命周期。
- Gateway 或 App Server 重启会使远程 TUI 连接断开，由原生 Codex CLI 自身处理退出/重连，不由 `remote` 自动恢复会话。

### 错误路径与恢复

- Workspace 不存在、权限策略不受支持、Profile 未配置或拓扑不一致时失败关闭。
- 原生 Codex CLI 非零退出会透传明确退出码；信号退出会保留信号语义。
- Provider lease 获取成功但 TUI 启动失败时，`finally` 释放 lease；若释放失败只记录为清理错误，不改变原始退出原因。

### 测试覆盖

- `tests/codexc-cli-suite.ts` 覆盖 Workspace/权限透传、错误退出、信号、受管 DeepSeek/OpenCode/自定义 Profile 路由和 lease 清理。
- 未覆盖：Gateway/App Server 重启期间 TUI 的用户提示、多个远程客户端竞争同一 Provider lease 的完整交互。

### 结论

`remote` 主要是严格参数边界和 Provider 路由适配器，未复制会话状态；安全和清理路径较完整。后续只需在统一生命周期文档中说明服务重启会断开远程 TUI，不应让该命令承担自动接续或后台服务管理职责。

## 记录 14：`codexc work`

### 入口与参数

- 公开入口支持交互菜单，以及 `list [--json]`、`add [--id] [--name] [--cwd] [--prune-missing]`、`remove <序号|ID|名称>`。
- `--cwd` 会解析为真实目录；ID/名称由配置校验和规范化逻辑生成，拒绝重复或非法值。

### 状态变化

- `add`/`remove` 原子更新 Workspace 注册，并维护默认 Workspace；删除只删注册，不删磁盘目录。
- 新增 Workspace 会写入配置事件队列，供运行中的 Gateway 热加载并向渠道通知；清理失效项会丢弃对应事件。
- `list` 与 `--json` 只读，不触发服务操作。

### 热重载与热重启影响

- 注册、删除和权限调整通常触发 Gateway 配置热加载；不重启 App Server。
- 如果变化被分类器判定为需重建连接，运行中的 Gateway 可能由监管器自动重启；前台进程需手动重启。

### 错误路径与恢复

- 缺失目录默认拒绝，只有显式 `--prune-missing` 才清理失效注册。
- 固定默认 Workspace 不能删除；删除当前默认项会自动切换到保留的默认项。
- 配置写入失败会尝试撤销已入队事件；目录创建后注册写入失败时，新目录可能保留但不会自动删除。

### 测试覆盖与结论

- CLI 套件覆盖增删、缺失清理、默认切换、事件队列、权限透传和参数错误；风险主要是目录创建与配置写入的跨文件事务不完整。
- Workspace 命令边界清晰，后续只需统一“热加载/重启”提示和失败后孤儿目录处理，不应让 remove 删除磁盘目录。

## 记录 15：`codexc rules`

### 入口与参数

- 支持 `rules init [--force]` 和 `rules check [--json]`，只在当前项目根目录操作 `.codex/rules/default.rules`。
- 项目根由当前目录向上查找 `.git` 或 `package.json`；规则目录、文件和父目录为符号链接时拒绝。

### 状态变化

- `init` 根据项目 `package.json` 中的安全脚本生成规则文件；默认不覆盖已有文件，`--force` 才允许重写。
- 生成后立即调用 Codex `execpolicy check` 验证；`check` 只读调用同一检查。
- 不修改 Gateway 配置、服务定义、数据库或运行进程；规则生效需要重启 Codex 客户端。

### 热重载与热重启影响

- 不触发 Gateway 热重载或热重启，也不影响 App Server。
- 项目规则由 Codex 客户端在后续进程中加载，和 Gateway 的配置生命周期完全独立。

### 错误路径与恢复

- 已存在规则未加 `--force` 时失败；检查失败返回结构化错误码（JSON）或明确文本。
- 生成文件成功但随后 `execpolicy check` 失败时不会自动删除新文件，可能留下未验证规则。
- Codex 可执行文件不可用、规则路径不安全或项目根不可解析时失败关闭。

### 测试覆盖与结论

- CLI 套件覆盖 force、符号链接、JSON 失败、规则检查信号和安全脚本白名单。
- 主要风险是“写入后验证失败”缺少回滚；后续可补临时文件验证后原子替换，但不应把规则检查与服务重启混合。

## 记录 16：`codexc agents`

- 交互入口管理共享第三方 `agents.external` 角色，配置/停用前要求选择已配置 Provider 与受控模型并确认。
- 只写 Provider 私有配置中的角色字段，不复制 API Key 到消息、状态库或 Gateway 配置；变更后统一提示 `codexc service restart all`。
- 不直接重启服务；运行中的 Gateway/App Server 在重启前继续使用旧角色。Provider/模型不存在、配置冲突或停用非本项目管理角色时失败或无操作。
- 测试覆盖 Provider 选择、模型校验、启停和文案；未覆盖重启失败后的配置状态。结论：边界清楚，需纳入 Setup/Config 的统一激活文案。

## 记录 17：`codexc primary-provider`

- 子命令：`list [--json]`、`add`、`switch <Provider ID> [模型]`、`remove <Provider ID>`；新增/编辑使用交互配置，列表支持脱敏 JSON。
- 自定义 Provider 保存在私有 Provider 目录和备份中；切换/删除通过预览、确认、修订检查和备份清理，官方凭据不被删除。
- 切换、删除后不自动重启，统一提示 `codexc service restart all`；运行服务继续使用旧 Provider，服务重启后才加载新主 Provider。
- 失败路径有回滚和私有备份清理告警，测试覆盖较完整。主要风险是“配置已更新但服务仍旧值”的时间窗口，需与 Config/Setup 统一激活结果文案。

## 记录 18：`codexc opencode-go`

- `account add/list/remove/default/stop` 管理 OpenCode Go 多账户；账户 ID 严格校验，列表可 JSON 脱敏输出。
- 账户、模型目录、Profile 和共享子代理角色保存在 Provider 私有目录；新增/删除/切换经过预览、确认、事务备份，设备主配置不写入明文 Key。
- 账户变更通常提示重启 Gateway 与 App Server；不自动重启，运行中的会话继续使用原 Provider/账户。
- 测试覆盖账户事务、默认切换、删除回滚、旧布局迁移和 Profile；主要风险仍是配置已变更但服务未激活，需与主 Provider/Setup 统一激活状态文案。

## 记录 19：`codexc update`

- 仅支持无参数；源码安装时先检查官方仓库、版本、脏工作区和 Codex 合同，再在临时候选仓库构建/验证，最后进入停服窗口切换源码。
- 服务已安装时备份并更新配置、状态/指标/计划任务数据库和 Provider 布局，离线复核后启动核心服务并等待拓扑稳定；服务未安装且 Gateway 未运行时只做离线更新。
- 失败对象包含阶段、已完成阶段、源码/服务恢复状态和建议；会尝试恢复旧源码/服务，不删除用户数据。
- 主要风险是长事务跨源码、服务和多数据库，恢复失败时现场复杂；测试与文档覆盖广。结论：属于完整更新事务，后续只需把服务生命周期记录中的安装/重启结果与 update 的恢复对象统一。

## 记录 20：`codexc uninstall`

- 受管源码安装卸载：先校验源码归属、Git 状态和命令入口，再调用 `service uninstall`，删除源码、已记录 npm prefix 中的全局命令和旧 PATH。
- 保留配置、数据库、凭据、日志和输出；符号链接、不匹配路径、脏官方旧仓库均拒绝删除。
- 不执行热重载/热重启，而是先停并移除全部后台服务；任一服务卸载失败会阻止后续源码删除。
- 测试覆盖受管/旧版/脏仓库和数据保留。主要风险是服务卸载的跨平台部分失败语义继承前述问题；应保持“先服务、后源码”的顺序并输出部分结果。

## 记录 21：`codexc state`

- 唯一子命令 `state upgrade`，升级状态库 Schema 3→4，并同步升级计划任务库 v1→v2；只接受无参数。
- 先检查结构和版本，使用事务与私有备份；当前版本则幂等返回，无需修改。
- 不自动停止或重启服务；运行中的 Gateway 可能占用数据库，升级失败需由用户在停服窗口重试。
- 未知版本、结构不完整或备份/事务失败会失败关闭，不做隐式迁移。测试覆盖版本、备份和计划任务升级；主要风险是缺少“必须先停 Gateway”的前置检查，需与 metrics/state 维护命令统一。

## 记录 22：`codexc metrics` 顶层入口

- 无参数时进入交互菜单，非 TTY 输出帮助；有子命令时先做集中参数校验，再委派只读查询或维护脚本。
- 查询类：`run`、`turns`、`threads`、`report`、`export`、`quota`；维护类：`status`、`upgrade`、`reset`、`sync-reset`、`cleanup`、`prune`。
- 查询不加载服务控制；维护命令按子命令要求停服/备份，`--restart-gateway` 通过专用包装显式改变生命周期。
- 顶层统一支持 Markdown/JSON/CSV（按子命令约束）和本地日期范围；参数错误在读库前失败。
- 主要风险：交互菜单的 `cleanup` 默认走 `cleanup-restart`，与命令行默认要求 Gateway 停止的文案不完全一致；维护子命令的服务重启/恢复语义需逐条核对。后续记录 23 起按子命令审查。

## 记录 23：`codexc metrics status`

- 只读检查指标库路径、是否存在、Schema、兼容性和记录数量；支持稳定 JSON。
- 不启动/停止 Gateway，不获取写锁以外的维护锁，不修改数据库。
- 数据库不存在时返回可创建/兼容状态；Schema 不支持或结构缺失时失败关闭。
- 测试覆盖 JSON、缺失库和错误去重。结论：边界清楚，风险低；后续只需统一状态字段与 WebUI/中心状态文案。

## 记录 24：`codexc metrics upgrade`

- 默认要求 Gateway 已停止；逐版本事务升级指标库并创建 `0600` 备份，未知 Schema 失败关闭。
- `--restart-gateway` 显式停止、升级、再启动 Gateway；启动失败会尝试恢复但不回滚已升级数据库。
- 不重启 App Server/中心服务。测试覆盖版本链和备份；风险是恢复阶段与 service 生命周期结果未统一。

## 记录 25：`codexc metrics reset`

- 要求 Gateway 停止且指标 Socket 不可连接；检查点后把旧库重命名为带版本/时间备份，保留数据，下一次启动创建新库。
- 不自动重启服务；无库时幂等成功。数据库归档成功但后续启动失败不会恢复旧库，需人工回滚。
- 测试覆盖停止检查、备份和空库；风险低但需统一维护失败提示。

## 记录 26：`codexc metrics sync-reset`

- 备份并清零多端上报水位文件，保留设备 ID；默认要求 Gateway 停止，`--restart-gateway` 才自动停启并重放上报。
- 不删除本地/中心指标；中心按 `(device_id, local_id)` 覆盖。失败时水位与服务恢复未形成统一事务结果。
- 测试覆盖水位保留和重启包装；需与 prune/cleanup 共享服务状态契约。

## 记录 27：`codexc metrics cleanup`

- 按日期、保留天数或最大行数清理最旧请求，先备份，可选 `--vacuum`；默认要求 Gateway 停止。
- `--restart-gateway` 自动停启 Gateway；交互菜单默认调用该包装，和 CLI 默认语义不一致。
- 清理失败会尝试重新启动，但可能留下部分删除；测试覆盖参数和错误传播。高优先级是统一“是否自动重启”入口文案。

## 记录 28：`codexc metrics prune <provider>`

- 严格校验 Provider ID，备份后删除本地与中心库该 Provider 请求；执行前读取 Gateway/中心服务状态，仅对原本运行的服务执行停止与恢复。
- 原本未运行的服务保持停止，不再因维护命令隐式启动；服务状态无法确认时失败关闭。
- 失败路径仍尝试恢复原本运行的服务，但不恢复已删除数据；测试覆盖 Provider 校验、备份和“停止状态保持停止”。后续可再统一显式重启选项与生命周期结果。

## 记录 29：`codexc metrics run <Thread ID>`

- 只读聚合指定 Thread 最近运行与会话累计，支持 Markdown/JSON/CSV 和 `--stdout`；默认写入私有 output 目录。
- 不触发服务生命周期，不修改数据库；Thread 不存在或无指标时明确失败/空结果。
- 测试覆盖格式、费用、Token 和上下文汇总。风险主要是历史请求与当前运行口径需在文案中持续区分。

## 记录 30：`codexc metrics turns <Thread ID>`

- 只读导出 Thread 每次对话明细，保留请求、Token、费用、速度和耗时；无写入/重启。
- 分页/格式校验在入口完成；错误不会改变指标库。测试覆盖多 Turn 聚合；风险低。

## 记录 31：`codexc metrics threads`

- 只读列出指标库中有记录的会话及对话/请求数，支持导出格式和标准 output 目录。
- 不验证 App Server 当前 Thread 状态，也不修改绑定；已归档/历史 Thread 仍可显示。
- 测试覆盖排序和导出；需在最终文档强调“指标库历史”不是 App Server 会话事实源。

## 记录 32：`codexc metrics report`

- 只读聚合报表，默认最近 30 天，可按自然日区间和 global/providers/models 分组，支持三种格式。
- 费用按统一币种换算，保留有效样本覆盖；不触发服务或写库。参数范围和日期互斥校验集中处理。
- 风险是大范围 `all` 输出可能很大，当前依赖分组上限和导出文件；需保持文案说明为历史统计。

## 记录 33：`codexc metrics export`

- 只读导出脱敏请求记录，支持时间范围、Thread、JSON/CSV/Markdown；默认写入 `0600` output 文件，`--stdout` 才输出终端。
- 不包含凭据/Authorization 等敏感字段；失败会删除未完成输出文件。测试覆盖格式、转义和文件权限。
- 主要风险是用户误把导出视为可恢复数据库；文案应继续明确这是脱敏快照。

## 记录 34：`codexc metrics quota`

- 只读查询 OpenAI/OpenCode Go 历史额度窗口，按真实重置时间归并，支持日期范围和导出格式。
- 估算使用本地观测请求与额度快照，不触发服务、不改库；缺少额度信息时返回未提供而非猜测。
- 多设备/多渠道聚合依赖中心上报的 Provider、窗口、设备标识；标识不一致会造成重复卡片。后续需和中心 Schema/设备命名审查一起处理。

## 记录 35：`codexc channel send-image`

- 只接受受支持图片路径及可选会话参数，入口先校验路径、大小和格式，再复制到私有 `channel-outbox/pending` 并写 manifest。
- Gateway 轮询后按 Thread 绑定发送并归档；CLI 不直接调用平台 API，不触发服务重启。
- 文件不存在、越界、符号链接或无会话绑定时失败关闭；发送失败保留可观察的 outbox 状态。
- 测试覆盖路径安全、队列顺序和归档。结论：边界清晰，风险集中在 outbox 长期堆积与失败重试策略。

## 记录 36：`codexc webui`

- 启动只读指标 HTTP 服务，监听参数优先命令行/配置，非回环地址必须配置访问令牌；不提供写 API。
- 读取本地指标库并代理中心全局 API，前端不接触令牌；前台退出清理 HTTP 资源。
- 不触发 Gateway/App Server 重启；作为后台服务时由 `service start/restart webui` 管理。
- 测试覆盖参数、令牌、API 只读和错误中文化；主要风险是 WebUI 与中心数据时间/设备标识口径需统一。

## 记录 37：`codexc center`

- 启动/配置多设备指标中心；接收 Bearer 上报、按 `(device_id, local_id)` upsert，查询接口使用独立查看令牌。
- `info/config/upgrade` 分别只读、写配置、升级数据库；配置变更不会由顶层自动重启，`codexc config` 注入回调时才自动重启 center。
- 非回环监听强制双令牌；错误失败关闭，令牌不输出到 info JSON。主要风险是中心配置写入与服务重启不是统一事务。

## 记录 38：`codexc doctor`

- 只读诊断当前配置、目录权限、数据库、服务、Provider 和 Surface 状态；支持文本/JSON，禁止改写配置。
- 服务/数据库异常只报告修复建议，不自动重启或修复；敏感值脱敏。
- 测试覆盖结构错误、权限和 JSON；风险是诊断项多、文案需与 service/metrics 状态字段统一。

## 记录 39：`codexc security`

- 显式修复用户目录、配置、数据库、Socket 和日志私有权限；不修改业务配置，不启动服务。
- 权限不满足或符号链接路径失败关闭；修复后需重新运行 doctor 验证。
- 结论：安全边界清楚，后续只需补跨平台权限结果统一。

## 记录 40：`codexc version`

- `version/-v/--version` 只输出 CLI/Gateway 版本信息，不访问配置或服务，不触发重启。
- 参数错误明确失败；版本来源为源码/包元数据。结论：风险低，无需纳入生命周期修复。

## 交互、文案、重复与耦合专项审查

### 交互

- Setup、Config、`primary-provider`、`opencode-go`、`center config` 存在重复入口，但确认、返回、取消和生效方式不一致。
- 保存后有的模块自动重启，有的只提示命令，有的要求重新安装服务；用户无法在确认前知道会影响哪些进程。
- 建议统一为“取消不写入；保存显示配置结果；随后显示激活结果；激活失败保留配置并给出恢复命令”。
- Setup 定位首次和跨领域配置，Config 定位日常修改，独立 CLI 定位脚本化操作；三者共享底层设置，不复制入口语义。

### 文案

- “指标中心/数据中心/中心服务”“设备名/显示名称/上报名”“查看令牌/全局查看令牌”“已保存/已生效/已就绪”存在混用。
- 统一使用：数据中心、中心服务、设备名称、设备 ID、设备上报令牌、全局查看令牌、配置已保存、配置已生效、服务已就绪。
- 所有配置修改统一输出：`配置`、`生效`、`操作` 三行；不再混用“请重启”“启动操作已完成”等无法判断健康状态的文案。
- “已启动”只代表进程启动，“已就绪”必须代表健康检查通过；“配置已保存”不代表“配置已生效”。

### 重复

- Config、metrics 维护、Update 和平台脚本仍分别触发停启/重启；平台脚本已补最小的部分失败摘要，但尚未集中为统一生命周期执行器。
- Setup 子模块、Provider 命令和 Config 各自拼接重启提示；应共用激活结果和消息键。
- 服务目标、默认目标、Provider 名称和令牌说明分散在 CLI、脚本、README、docs；应保留一个规范定义，其他文档只引用结论。

### 耦合

- Config 菜单直接持有 Gateway/WebUI/Center 重启回调，配置交互层耦合服务生命周期；菜单应只返回配置变更与激活需求。
- metrics 维护脚本直接控制 Gateway/Center，导致 `prune` 无条件启动原本未运行的服务；服务停启应移到应用层并恢复原状态。
- 顶层 CLI、平台脚本和 Windows 状态检查重复判断 running/healthy；应由服务生命周期端口返回统一状态。
- WebUI、中心 API、CLI 各自解释 Provider、设备、窗口和周期；应由查询层生成统一 DTO，展示层只负责渲染。

### 收敛方案

只新增三个共享边界：`activation-result`（配置激活结果）、`service-lifecycle`（服务状态/原状态恢复/健康确认）、`metrics-dimension`（Provider/账户/窗口/设备/周期）。不引入大型框架，不改变现有公开命令名称。

修复顺序固定为：先解除服务生命周期耦合，再统一 Setup/Config 激活结果和文案，然后规范指标维度和额度聚合，最后收敛入口帮助与文档。这样可避免先改 UI 后因状态模型变化返工。
