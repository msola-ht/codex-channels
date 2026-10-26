# 项目脚本

显示预设使用 `display.preset`，输入 `{ preset: "concise" | "standard" | "detailed" | "full", selector?: MessageDisplaySelector }`。省略目标应用全局，范围复用现有严格目标及启用、授权和可写检查；未知键、`null`、`custom` 和非法目标拒绝。共享定义和支持矩阵来自 `runtime/message-display-policy.mjs`，一次原子事务设置本层全部支持字段，保留其他目标、日志、调用采集、模型分组及 Telegram 格式；微信只写三项。全局有效值已匹配时 none，不补齐缺省；范围则固定显式字段，即使原有效值已匹配也仍属于变更。读取返回 computed `display.preset`、`display.globalScope` 和各 `scope.preset`，不保存标签。CLI 全局及范围字段菜单、WebUI 高风险单次确认、revision、备份、审计、读回、取消与 no-op 共用既有事务；全局激活按真正改变字段和已启用消费者计算，范围按覆盖数组判定。字段仍可单独编辑或恢复继承，无独立预设继承动作。

常规通知管理由 `config-display-menu.mjs`、`config-management.mjs` 和 `config-display-management.mjs` 共同提供，全局 `display.routine-notifications` 显式 set boolean/inherit，范围字段 `routine_notifications` 支持四渠道单聊。共享读取区分有效值与覆盖，缺省开启不物化；保存沿 revision、私有备份和读回，取消和未变化不写。WebUI 高风险确认、API allowlist 及读回核对共用相同契约。启用任一渠道时全局有效值变化要求重启 Gateway，隐式 true/显式 true 互换只 reload，范围数组整体判定；回退前清除全局及覆盖 routine_notifications，不自动迁移。

本目录保存 npm CLI 和开发流程调用的 Node.js、Shell 脚本。脚本处理本机配置、构建、协议生成和服务管理，不承载 Gateway 的会话业务逻辑。

涉及 Provider、进程控制或服务安装时遵循[跨平台变更规则](../docs/development-rules.md#cross-platform-changes)。CLI、Setup、WebUI 的等价配置操作遵循[多入口配置管理规则](../docs/development-rules.md#multi-entry-configuration-management)，复用所属业务模块的管理计划与执行契约；平台控制脚本只处理服务管理器差异。预览通过不能代替执行前状态校验，写入成功不能代替运行时可消费或服务就绪。模板变化须同步核对全新安装、既有定义重装、失败恢复及 WebUI/Relay 状态，不能只验证当前主机平台。

## 配置与 Workspace

- `model-base-management.mjs` / `model-base-management.d.mts`：CLI 与 WebUI 共用的公共底座读取、候选导出、字段对比、确认保存与资源关闭。导出复用受管子进程并有总期限，候选有界且绑定底座修订，确认不重新获取；私有备份、进程间锁、原子替换和回读区分保存事实与结果不确定。见[公共底座更新](../docs/deepseek.md#公共底座更新)。
- `model-base-command.mjs`：`codexc model-base status/update` 与 Setup 公共底座入口；完整显示字段前后值，支持只预览 JSON，写入须交互确认。
- `webui-management-model-base-route.mjs`：公共底座 GET、预览与保存路由，复用管理认证、限速、单次确认及审计；绑定候选与预览，断连取消自有导出，服务关闭等待自有进程收尾。

- `qq-passive-observation.mjs`：用户明确要求保留的源码工作区手动探测入口，不纳入 npm 包或正式 CLI。
  正式 QQ 禁用且配置生效后，用 `--run` 启动；Gateway 的其他渠道可继续运行，独立 QQ 探测锁阻止同配置同账号的重复探测。
  默认 `--run` 最多 180 秒等待唯一允许用户的随机口令，使用原消息 ID 被动回复一次；另有固定数量文字样例、重复序号/次数、
  310 秒延迟回复及自有网络连接中断恢复模式，不自动重试业务请求；检测到 QQ 启用、凭据或名单变化取消。
  QQ 协议通过 Surface 公共加载入口取得；此脚本与正式 `qq-menu-setup.mjs` 获准导入 Bootstrap 的 QQ 网络所有者，复用正式代理及清理语义，不加载 Gateway 组合根。
  退出关闭自有资源并释放探测锁，不占用 Gateway 所有权，不启停服务或调用 App Server。
  具体步骤与观察限制见 [QQ 消息开发流程](../docs/qq-message-contract.md#手动被动探测)。

- `cli-operation-progress.mjs`：CLI 共用的分组标题与阶段展示；终端使用不读取 stdin 的行内动画，重定向、CI 和 dumb 终端使用纯文本。支持延迟显示、选择输出流或静默，以及沿用调用方取消信号。阶段完成必须等待实际操作结束，取消后由调用方收尾，进度层不直接退出进程。
- `cli-lifecycle-command.mjs`：更新、程序卸载、Doctor 与指标/数据维护的 CLI 父子进程协作；就绪握手后通过私有 IPC 转发取消，子进程在安全边界检查取消，父进程等待事务收尾并退出，不用强制终止代替取消。指标导出可把子进程标准输出直接写入私有文件。
- `installation-command.mjs`：安装入口共用的异步命令执行器；避免同步子进程冻结进度，交互模式保留有界诊断尾部并在失败时展示，非交互模式实时输出日志，取消时终止自己启动的进程树。供源码安装器和本地安装复用，不管理后台服务。
- `source-build.mjs`：首装 Shell/PowerShell 与更新器共用的源码构建阶段；无需已安装依赖即可加载，显式处理 ignore-scripts、根依赖/Hook/Gateway/WebUI 构建与产物检查。各入口保留命令执行、取消和安装事务所有权。
- `cli-command-worker.mjs`：安装命令、更新准备命令、服务控制器、Doctor、Desktop 平台查询与 WebUI 管理任务共用的 Unix 进程组监管入口，重导出并转交 Runtime 的 `owned-command-worker.mjs` 实现；等待后代输出管道关闭，保留组长身份以支持取消升级为强制终止，不把直接子进程退出当作整组完成。管理任务可显式转发 stdin 协作取消，其他调用方仍忽略输入。Windows 保留调用方已有的进程所有权机制。

- `video-analysis-mcp.mjs`：独立 stdio 视频分析 MCP 入口，`runVideoMcp` 供独立入口 `strata-video-mcp` 及 `codexc video-mcp` 在当前进程调用，仍支持直接运行脚本；拥有初始化、单请求准入、取消、总超时和标准流退出，不连接 App Server 或 Gateway。新增 Strata 预设保存独立命令 `strata-video-mcp`，由标准 MCP 宿主 PATH 选择安装，不保存 Node 版本或脚本路径。配置见[视频分析 MCP](../docs/video-analysis-mcp.md)。
- `mcp-setup.mjs`：`codexc config → 工具与 MCP` 的添加、编辑、删除交互入口。添加支持 stdio、Streamable HTTP、AnySearch 搜索和 Strata 视频预设；预设只问必要信息，通用类型保留自定义字段。编辑仅修改选定用户 MCP 字段，保留其他设置与凭据；删除只移除选定用户配置条目，不操作插件、包或附件。三种操作共用脱敏摘要、最终确认、带修订的配置事务及回读校验，拒绝同名添加，不自动重试写入。AnySearch Key 保存为 Bearer Header；Strata 固定文件引用模式及分析时限，从有效 Gateway 配置推导渠道附件目录，最终确认后复核并准备私有权限。不自动安装、启动或重启服务。
- `video-analysis-client.mjs`：视频 MCP 的严格环境配置、本机路径校验（授权目录内文件名/绝对路径，或 `STRATA_VIDEO_ROOT=any` 时的任意绝对路径，渠道附件目录内的路径始终拒绝）、有界读取及 Strata Files/Responses 请求；默认使用有界内存 file_id 映射、共享上传及一次明确失效恢复，显式 url 模式兼容旧部署；通过 `instructions` 发送通用视频分析规则，用户问题保持原样，可用有界 `context` 补充同一视频追问线索；预算由上游管理，支持显式思考等级，白名单提取用量及失败分类，只在完整 `completed` 响应中提取分析文字，不接受任意远程视频 URL，不执行模型返回的内容。

- `managed-provider-account-prompt.mjs` / `managed-provider-account-prompt.d.mts`：多账户添加共用预设与自定义 ID 交互；DS、CCG、CLP 编辑共用当前模式预选、Key 留空保留及脱敏保存确认。

- `runtime-config.mjs` / `runtime-config.d.mts`：解析并声明用户数据目录和运行时路径，并初始化 `.codex-connect`；为只读诊断和
  独立项目命令提供不修改配置权限的必需/可选路径定位，可选定位只把文件不存在视为未初始化，
  但显式指定的配置文件缺失及其他文件系统错误仍失败；首次创建配置前初始化同级 `workspace/` 与 `group/` 的 Git 仓库，
  注册 `codex-connect` 与 `group`，默认项保持前者。保留已有 `.git` 且不创建提交，任一初始化失败不写入配置；
  已有配置不补建或补注册工作区，`group` 注册不赋予群聊能力。`requireUserConfig` 的只读模式校验现有权限但不修复，用于安装预检与就绪查询；启动与写入流程显式收紧目录和配置文件权限。
- `runtime-environment.mjs`：在已定位的用户配置上统一装配 Gateway、App Server 与管理脚本使用的
  `CODEX_CONNECT_HOME`、配置路径、Codex 可执行文件和代理环境；同时保留未合并系统代理的环境，供
  前台监管与 Gateway 服务子进程自行解析，避免自动发现结果变成固定环境覆盖。需要在配置损坏时仍可运行的服务恢复
  命令使用独立的最小控制环境。
- `desktop-app-command.mjs` / `desktop-app-command.d.mts`：实现公开 `codexc app` 的严格
  参数（端口仅 Windows、十进制整数）、通过 `provider-selection.mjs` 统一映射的单次启动 Provider 选择、只读状态、macOS ChatGPT Bundle 与 Windows 当前用户 `OpenAI.Codex` 包兼容探测、配置
  写入与回滚、App Server 服务重启、Windows 目标实例临时租约、受认证桥就绪探测和单次环境启动；Windows
  租约覆盖探测与启动并在所有结果下释放，状态不输出桥令牌，两个
  平台均明确标为预览。macOS 启动时改用受管 stdio Proxy，不再依赖桥端口或令牌，并单独报告受管
  入口能力及内置工具 Host 是否已附加，明确这些状态不代表 MCP 工具就绪；启动前持有临时 Provider 租约，按需恢复已释放的实例，
  通过官方已加载 Thread 清单和逐项状态读取检查持久及临时会话，并在活动 Turn 或 `codexc remote`
  目标实例租约存在时拒绝会触发子进程切换的启动；打开 Desktop 前释放临时租约。
  平台命令异步执行，限制 15 秒和 1 MiB 输出；资源标记单遍异步扫描，活动 Thread 检查设置 30 秒总预算。
  检查与启动进度延迟显示，JSON 状态禁用进度；取消等待自有查询和租约收尾。
  首次确认绑定配置原文、Provider 与运行目标；写入前在配置锁内重验，异步激活和失败恢复再次检查，过期目标拒绝继续。
  macOS 的具体构建实机验收边界见 `docs/codex-desktop-app-development.md`，Windows 尚未实机验收。
- `desktop-app-proxy.mjs`：只由 macOS Desktop 的 `CODEX_CLI_PATH` 启动；解析并受控传递 Desktop
  内置插件的布尔启用值和本次 Provider；无插件配置时恢复目标实例但不持有长期租约，带配置时把动态工具 Pipe
  通过私有 Supervisor Host 租约交给服务，显式 `false` 仍走 Host 租约路径。把 Desktop JSONL
  stdio 逐条转换为 WebSocket 文本帧并连接现有私有 UDS，自身退出时清理 Proxy 和持有的租约，
  不终止共享 App Server。
- `windows-desktop-app-inspect.ps1`：只读查询当前用户 `OpenAI.Codex` 包、包内 Desktop 可执行文件
  和同路径进程状态，供 `desktop-app-command.mjs` 在 Windows 上失败关闭地判断能否启动。
- `source-update.mjs` / `source-update.d.mts`：从本机终端更新受管官方 `main`；跨平台独占锁阻止并发更新，候选克隆启用长路径支持。先构建并只读检查配置、数据库结构和精确 CLI 合同，CLI 不匹配时确认后同步。记录 App Server、Gateway、Relay、WebUI 状态，按依赖顺序停服；刷新源码与全局命令后，只恢复原本运行的服务，Relay 还须保持启用，WebUI 还须未被配置关闭。恢复前再次校验 CLI 版本和配置、数据库，失败保留阶段及必要备份。无新提交或本地构建包只同步配套 CLI，不更新 Gateway 包；关闭 daemon 自动启动，其他用户偏好和模型目录不变。
  已安装包按自身来源记录识别受管源码，不因旧受管目录残留而覆盖本地构建包。更新预检核对当前 npm prefix、运行包和已安装服务定义的程序路径，拒绝刷新范围外的服务路径；停服前及切换前复核旧目录身份、HEAD、origin 和工作树状态，换仓库时合并保留完整安装 prefix 归属。成功后也保留旧源码副本并返回 backupPath，避免删除外部并发修改。候选依赖安装禁用隐式生命周期，随后显式构建一次；仅在 npm 有效配置未禁用脚本时安装 Git hooks。
  更新专用只读计划仅接受当前结构或精确 v31/v32/v33/v34 指标库；停服后重新核对配置路径、库版本及文件身份，再调用包内 `metrics-database-upgrade.mjs`，在库旁建立完整私有备份并单事务升级。未知结构拒绝，不影响运行时严格校验。迁移开始后安装未就绪时禁止旧服务恢复，并保留数据库备份候选位置与候选源码；本地/同提交路径迁移后，源码入口同时刷新全局命令。普通无迁移的本地更新仍不更新 Gateway 包。
- `source-install-metadata.mjs` / `source-install-metadata.d.mts`：记录受管源码使用过的 npm 全局
  prefix，并在已安装包记录精确源码来源，从当前全局包路径识别其所属 prefix，供安装归属核对和跨 Node.js 环境卸载使用。
- `source-uninstall.mjs` / `source-uninstall.d.mts`：统一识别受管源码、本地工作树构建包与 npm 全局包，先卸载后台服务，再卸载当前包及来源匹配的已记录包；只有路径、来源与受管标记均匹配才删除仓库。拒绝符号链接、身份冲突和执行中替换，保留普通工作树和用户数据。
- `local-installation.mjs` / `local-installation.d.mts`：检查 Gateway 配置、数据库和服务安装；`inspectDatabases` 只读校验当前 Schema，拒绝其他版本，不存在的库由正常启动创建。独立的 `inspectDatabasesForUpdate` 只读识别精确 v31/v32/v33/v34 指标升级计划，不在预检中写数据。另提供服务就绪检查，等待 Socket、监管拓扑与 Gateway 健康稳定；仅在监管拓扑匹配且实例已运行时连接 Socket，空闲释放状态不启动 Proxy 探测，不匹配或尚未启动的实例继续等待。
- `state-database.mjs`：提供状态库与计划任务库的只读版本/结构检查，只接受当前 Schema；已有只读连接可复用同一校验入口，供渠道图片提交和会话归档在读取绑定前检查。
- `metrics-database-upgrade.mjs`：更新安装层的指标 v31/v32/v33/v34 → v35 只读计划与离线执行，精确校验、Writer 锁、私有完整备份、单事务转换和保留数据核对；`database-upgrades/metrics-to-v35.mjs` 是显式离线入口。`metrics-schema-v31.mjs`、`metrics-schema-v32.mjs`、`metrics-schema-v33.mjs`、`metrics-schema-v34.mjs` 由 `database-upgrades/generate-historical-schemas.mjs` 从锁定历史源码生成，仅用于显式升级前核验。
- `metrics-schema-v31.mjs`：从锁定历史提交生成的 v31 结构，仅供更新安装层识别和转换，不向运行时增加旧版兼容。
- `metrics-schema-v32.mjs`：从锁定历史提交生成的 v32 结构，仅供同一显式升级入口精确校验，保留已有请求大小。
- `metrics-schema-v33.mjs`：从锁定历史提交生成的 v33 结构，仅供同一显式升级入口精确校验，保留已有生图请求。
- `metrics-schema-v34.mjs`：从锁定历史提交生成的 v34 结构，仅供显式升级核验，保留已有上游地址，新增行为摘要不回填历史。
- `metrics-database-access.mjs`：集中实现 `codexc metrics` 与 WebUI 共用的数据库状态、
  `run`、`turns`、`threads`、`report`、`export`、`quota` 和周额度只读查询；通过 Observability
  统一查询服务访问只读 Store，不加载服务控制或数据库维护流程。
  普通只读查询在同一连接上校验 Schema 并读取；分页、聚合与额度组合结果共享只读快照，诊断入口独立统计总行数。
- `metrics-database.mjs` / `metrics-database.d.mts`：提供 `codexc metrics` 的公开入口和 CLI，
  组合只读访问、输出渲染以及 `reset`、`cleanup`、`prune` 等显式维护命令；查询复用 Observability
  只读端口，`status --json` 返回稳定的路径、Schema、兼容性与记录数，渲染复用
  `metrics-export-format.mjs`；运行、会话与聚合输出从现有 `compact` 明细
  派生上下文压缩模型、请求数与 Token 摘要；删除旧计时与直接 API 分栏后的 JSON 合同使用
  report/export v3、run/turns v2、threads v1；期间查询 JSON 附加范围和筛选条件；JSON/CSV 同时保留可视化字段；
  `export` CSV 用独立类型行区分请求历史额度快照
  与 OpenAI 当前额度估算摘要，避免重复附加全局状态。
  reset 要求 Gateway 明确停止、持锁前后完整 Schema 校验、检查点回写及独占复制 `0600` 备份后
  才移除被重置的当前库；备份或权限保护失败保留原库，不迁移或覆盖原指标记录。
  服务状态无法确认、处于非停止状态或前台 Gateway
  指标 Socket 仍可连接时均拒绝 reset。`cleanup` 按 `[metrics.storage]` 或命令行覆盖值创建私有
  备份后清理最旧请求记录，可选 `--vacuum` 立即回收 SQLite 文件空间。
  `prune <provider>` 备份后删除本地指标库中指定提供商（区分大小写的精确 Provider ID，含历史记录对应的 ID）的全部请求
  行，Gateway 按执行前的运行状态恢复；额度重置
  后可用它从零重新统计用量。
  cleanup/prune 在任何维护写入前校验完整当前 Schema，并在检查点、备份、删除与 VACUUM 期间持有统一 writer 锁；备份不覆盖既有文件。裁剪计时会撤销对应 Thread 历史完整标记。
  提交后的 VACUUM、计数、关闭、释放锁或恢复服务失败通过 MetricsMaintenanceError 保留提交状态、数量、备份及失败阶段；CLI 非零退出仍打印结果，未知提交不报告成功，不自动重放删除。
- `metrics-command-options.mjs` / `metrics-command-options.d.mts`：集中解析并预检 `codexc metrics` 的
  时间范围、组合筛选、分组、格式及维护命令参数，通过 Observability 的 `query/index` 无状态入口复用规范范围、日期解析与聚合维度，并向顶层帮助
  导出规范用法行；不访问配置、数据库或服务，
  `metrics-database.mjs` 保留原有公开入口与 `metricsRange` 导出。
- `channel-send-image-options.mjs`：集中解析 `codexc channel send-image` 参数，使顶层 CLI 在读取配置前拒绝非法输入；显式 --format image|markdown 默认 image，markdown 在绑定解析后限定 QQ 并写 version 2 图片请求。
- `channel-send-file-options.mjs`：显式文件发送参数解析，支持 file/video/voice 类型，拒绝相对路径、重复选择和未知参数。
- `channel-send-file.mjs`：复用现有配置与前后台绑定读取，四渠道目标的文件经公开安全读取与共享 channelFilePolicy 校验后复制到独立 `channel-file-outbox`，原子发布携带 mediaType 的 version 1 manifest；微信仅 file/video，其他类型差异与回滚见 [`渠道文件`](../docs/channel-file.md)。
- `channel-send-image.mjs`：`codexc channel send-image` 的实现，校验配置与状态库 Schema，解析前台或后台 Thread 绑定；通过 Surface 公开入口校验并有界读取本地图片，私有原子写入
  状态库目录下的 `channel-outbox/pending/` 后发布 manifest，失败时清理本次暂存；由 Gateway 轮询后按 Thread 绑定
  会话发送并归档，详见 `docs/channel-image.md`。
- `session-cleanup.mjs` / `session-cleanup.d.mts`：实现并声明 `codexc cleanup sessions`，通过
  主 App Server 按 Workspace 枚举全部 Provider 历史，最多并行检查四组候选；跨已连接实例核对活动状态，已移除 Provider 的历史仍可由共享历史连接维护。后代参与绑定、活动、固定与 Workspace 检查，确认后每个父会话只发一次官方归档，批次结束按 Workspace 复用官方双状态根列表核验。
  执行确认后的失败、部分成功、未确认、复核跳过及缓存清理失败返回非零状态，逐组结果保留，不自动重试或回滚。
- `cli-command-usage.mjs`：共享纯帮助文案与服务动作目录，不加载命令执行实现。
- `cli-help.mjs`：校验公开命令的精确帮助路径，拒绝未知子命令和多余参数。
- `delivery-command.mjs`：仅执行 status/list 时从 Surface 窄诊断入口加载载荷解码与屏障策略，避免帮助及其他 CLI 命令加载平台 SDK；通过 Surface 公开入口复用持久输出分类，离线查看独立投递箱的计数、事件身份、阻塞策略与检查点，并根据明确参数重发或确认送达；status/list 打开时会恢复遗留 sending 为 uncertain 并清理中断的渲染暂存，不是只读查询；不输出正文、不自动清理未确认记录。
- `cli-menu.mjs` / `cli-menu.d.mts`：八项顶层导航及运行连接、状态服务、数据维护、程序维护子菜单；与主帮助共用分类口径。连接菜单列出已注册工作区和实际可用的 Provider 拓扑，普通隔离实例使用规范 Profile 名分派，聚合项受共享暂停门禁隐藏；按平台隐藏不可用的 Desktop 与权限修复。循环保留上次选择，维护写操作需确认；只分派现有命令，保留进程终止信号语义。
- `cleanup-menu.mjs` / `cleanup-menu.d.mts`：统一清理交互入口，复用会话参数菜单、指标维护菜单和现有执行命令；转储先预览再确认删除，Provider 指标按精确 ID 确认清理，单项完成后返回菜单。
- `maintenance-services.mjs` / `maintenance-services.d.mts`：交互清理共用的服务状态检查、停服确认与逆序恢复；取消覆盖停止、维护和恢复全程，子命令通过私有 IPC 在安全边界收尾，恢复后才返回取消状态，不停止非受管进程。
- `session-menu.mjs` / `session-menu.d.mts`：统一清理菜单使用的会话归档参数收集；收集 Turn 上限和空闲天数后调用
  会话清理 CLI；确认后临停运行中的受管 Gateway，结束后按原状态恢复，保留清理命令自身的候选预览与最终确认。
- `metrics-export-format.mjs` / `metrics-export-format.d.mts`：指标导出的 Token、汇总请求数与时间格式化，
  以及 Markdown/CSV 转义；紧凑数字和自适应耗时格式复用 Surface 纯函数导出，JSON/CSV 的毫秒数值不转换。
  指标和转储报告的时区标签只返回 IANA 名称，避免以当前 UTC 偏移描述跨夏令时的历史记录。
- `metrics-output-renderer.mjs`：把指标查询结果渲染为 Markdown、JSON 或 CSV；集中处理报告、
  请求明细、Thread、Turn 与当前运行输出，不访问数据库、运行时配置或服务控制。
- `metrics-export-limits.mjs` / `metrics-export-stream.mjs` / `metrics-export-worker.mjs`：CLI 与 WebUI 共用的只读导出 Worker、资源预算和分块背压；在同一 SQLite 快照中读取聚合与排序游标，不重复计算每页聚合。WebUI 显式请求版本化帧流，由 HTTP 导出入口包装数据、完成和受控错误终帧，浏览器确认完成后还原 JSON；默认 HTTP 与 CLI 保留原格式。取消和服务停止关闭读取与 Worker，未确认退出的任务继续占用并发名额；Windows 还确认 ACL 辅助进程退出。
- `webui-metrics-read.mjs`：普通指标读取的白名单 Worker 宿主，全进程最多两个读取、无排队；初始化 10 秒、读取 30 秒、关闭确认 3 秒分别计时。取消、超时与失败只输出受控错误，真实 Worker 退出后才释放名额。读取期限用于发起取消，不保证同步原生 SQLite 已停止；退出确认超时返回不可用并保留原始取消/超时 `reasonCode`，仍占用原名额等待真实退出。
- `webui-metrics-worker.mjs`：普通 WebUI 指标任务的只读执行入口，复用现有 Store/QueryService，在单任务快照读取完整分页、精确总数与相关聚合；不截断结果或修改数据库。Windows ACL 辅助进程退出确认后才交付成功结果。
- `webui-command-options.mjs`：集中解析 `codexc webui` 监听参数，使顶层 CLI 与服务实现复用同一规则。
- `webui-server.mjs` / `webui-api.ts`：`codexc webui` 的 HTTP 服务、共享 API 类型与管理路由组合入口；
  服务入口同时接收终端信号与父进程 `codexc-stop`，统一关闭 HTTP 监听、通知连接与尚未发送请求的浏览器预连接，并取消导出和投递只读 Worker；活动请求按共享停止预算收尾。超时关闭剩余连接并记录非零状态，后台读取或 Windows ACL 辅助进程未确认退出时保留归属，实际退出后再结束服务。Windows CLI 包装层异步转发停止消息。
  主服务托管静态前端和只读指标 API，子代理列表提供全局已登记关系与按父 Thread 的直接子级查询，并统一执行监听模式对应的管理访问边界（回环连接，或 `0.0.0.0` 下强制 Bearer）、精确 Origin、Bearer 鉴权、JSON 请求
  约束、限速、Provider 写事务锁及管理错误响应，再把已验证的请求分派给资源路由；服务进程时区跟随
  `[codex].timezone`，`/api/v1/time` 与页面时间展示随之切换。正常页面和未构建回退页统一设置
  同源脚本 CSP、`frame-ancestors 'none'`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`
  与 `no-store`；内联样式仅为现有组件渲染所需放行，脚本不开放内联。
  请求列表、错误汇总与单次运行详情的相关查询共享同一只读数据库快照，避免并发写入造成响应内部不一致。
  概览读取模型统计分组配置，按原始模型 ID 合并并提供原始模型成员明细，不向展示层注入映射；
  概览与调用采集开关共用可取消的进行中私有配置读取，不缓存配置或权限判断。
- `webui-official-model-catalog.mjs` / `webui-official-model-catalog.d.mts`：读写当前 Codex Home 的 `models_cache.json`，按精确模型修改上下文；目录列表只投影展示字段、25 项白名单详情、加速说明及明确的速度倍率，审批仅返回模式和文本来源状态；提示正文通过独立的可见模型与修订校验入口读取。预览修订、私有备份、锁内复核及保存后回读共用存储边界。刷新仅执行当前 CLI 的 `debug models`，由上游决定缓存复用、联网获取与写回，不将可能回退的 stdout 覆盖缓存，执行后对比可见模型字段。导出子进程受超时、输出预算与取消管理；终止失败有界返回错误，仍保留进程归属并拒绝后续缓存写入，服务关闭先尝试有界清理，失败后等待实际退出。
  上下文共享计划计算同值，锁内复核后返回 `unchanged`，不备份或替换缓存，审计和前端反馈使用相同语义。
- `webui-management-official-model-route.mjs`：OpenAI 缓存读取、上下文修改和当前配置目录刷新的预览/确认路由；独立 prompts GET 按可见模型 ID 与缓存修订返回白名单提示正文，最多 512 项，不返回任意配置或缓存归属元数据，正文不写日志。当前配置命令只在确认、备份后执行，展示真实缓存前后差异。复用管理鉴权、限速、一次性确认及审计，同一服务内操作互斥，关闭服务时取消并等待自有导出进程与写入收尾。
- `webui-management-codex-route.mjs` / `webui-management-gateway-route.mjs` /
  `webui-management-provider-route.mjs`（账户刷新随 HTTP 断开取消私有 IPC 等待，上游认证失败保持 502；单账户刷新复用 Store 精确 Provider 查询，整表同步保留账户增删与来源告警；响应附加同账户的 OpenAI 凭证刷新时间，不写入快照） / `webui-management-task-route.mjs` /
  `webui-management-status-route.mjs`：分别处理 Codex 设置、Gateway 设置、Provider 与账户、管理任务、
  服务与上游状态资源；复用主服务传入的共享安全状态，不自行建立认证、限速、事务锁或错误出口。
  Provider 与账户路由通过私有 Gateway IPC 刷新账户，不直接请求官方接口；凭证刷新时间仅通过 runtime 读取器
  获取匹配账户的登录缓存 `last_refresh`，不向浏览器返回凭据。账户
  来源清单独立读取各家账户注册表、OpenAI 鉴权文件存在性和主配置选择，不依赖模型目录或指标库，来源错误分别返回；
  快照按 DS、OCG、CCG、CLP 四家注册表补齐账户元数据和未刷新占位；状态路由返回受管服务安全摘要，并按
  5 秒 TTL 复用 App Server 进程级 User-Agent 探测结果。
- `webui-management-settings.mjs`：集中维护 WebUI 可编辑设置白名单、高风险设置分类、输入归一化和脱敏投影，供
  管理路由复用，避免把配置字段规则埋在 HTTP 服务中。
- `webui-logs-route.mjs`：服务日志只读路由，固定服务白名单、限量尾部读取、凭据脱敏和读取超时；Linux 将用户 journald JSON 裁剪为消息、级别、时间与来源，macOS/Windows 读取运行目录内标准输出与错误输出。
- `service-log-sanitizer.mjs`：服务日志和状态摘要共用的纯安全文本投影，隐藏认证头、Cookie、常见凭据字段及URL凭据；处理结构化与普通文本，不读取文件、不调用服务管理器。摘要在投影后压缩和截断，日志路由保留原公开导出。
- `webui-logger.mjs`：WebUI 后台诊断的共享 Pino Logger，复用 Observability 公开入口的凭据脱敏和受限错误序列化，携带服务、模块和事件字段。
- `webui-traffic-route.mjs`：WebUI 的模型转储读取路由，列出 V2 逻辑调用摘要并提供单条请求与终态
  响应；默认跨批次按请求时间倒序分页，支持单批次筛选，明细按批次与编号定位，指标关联目标缺失时明确报错，不替换目标。
  只接受回环连接，只按已知标签和实际存在的 writer session 读取用户数据目录，不接受任意
  路径；精确明细按文档支持的标签/session 目录定位并核对 manifest，不枚举无关批次。正文超过上限时返回截断标记，独立 trace 按总字节与记录数分页。仅支持 V2 session。
  HTTP 断连、10 秒期限与服务停止传至共同读取上下文，进程最多并行两个读取；目录、索引、正文与轨迹共享工作预算，资源实际关闭后才释放名额，关闭入口等待该服务归属的读取完成。正文优先于可选诊断；仅可选事件/后续调用扫描的工作预算耗尽返回显式不完整状态，未知事件总数为 null 并停止后续翻页，取消、期限、损坏与身份错误仍失败关闭。
- `webui-traffic-events.mjs`：按提供商及批次过滤转储文件变化，合并通知到只读 SSE；仅对相关批次建立非递归目录监听，监听首次目录创建、清理及重建，订阅关闭即释放文件监听与心跳，不读取正文或轮询 App Server。
- `reset-credit-command.mjs`：`codexc reset-credit` 查询与交互确认入口，复用 Gateway 私有账户 IPC，不依赖 WebUI。
- `webui-reset-credit-route.mjs`：OpenAI 重置券实时列表、预览及消费确认路由，复用管理鉴权、限速、一次性令牌和审计，通过 Gateway 私有账户 IPC 执行。
- `webui-management-providers.mjs`：将 Provider 管理状态裁剪为 WebUI 可展示的安全摘要；不读取或返回凭据正文。
- `webui-provider-settings-management.mjs`：复用主 Provider、受管 Provider 默认值与模型窗口、自定义 Provider 管理接口，为 WebUI 提供统一的资源投影、输入归一化、预览、确认后写入和结果脱敏；只读展示各提供商主配置的网页搜索模式和配置来源；不读取或返回凭据正文。
- `webui-custom-model-probe.mjs`：鉴权后的逐模型能力检测入口，限制并发、请求大小和取消生命周期；保留凭据仅可用于原 Origin，检测结果不直接写入配置。
- `webui-account-settings-management.mjs`：复用 OpenCode Go 账户 provisioning/management、DeepSeek 与 CLP 多账户管理接口，为 WebUI 提供账户资源投影、移除与配置预览、确认后写入和结果脱敏；账户投影包含 runtime 规范 Provider ID，并按该 ID 关联默认模型，不返回凭据正文。
- `webui-management-task-resource.mjs` / `webui-service-status.mjs`：管理任务资源快照、服务状态缓存和版本映射；任务预览与
  设置摘要共用同一服务状态查询，不重复启动平台服务管理器。
- `webui-management-operations.mjs` / `webui-http.mjs`：集中管理设置校验、管理错误、高风险路径分类、Provider 状态缓存，以及
  WebUI HTTP 响应、JSON 请求体、令牌鉴权和回环地址校验；主服务组合共享访问与错误边界并完成分派，
  具体资源处理留在对应管理路由。
  Codex／Provider 只读管理快照共享 20 秒取消期限与 HTTP 断开处理，关闭 WebUI 会取消并等待其自有连接清理；预览、确认与写入保持各自事务边界。本地模型目录另由 Provider 路由直接投影文件，不依赖完整管理快照。
  Provider 摘要保留 5 秒缓存与在途合并，单个 HTTP 取消不撤销其他等待者，最后一个等待者离开才取消共享读取；共享操作另有总预算及关闭归属，超时或取消的结果不进入缓存。Codex 已提交写入后的独立回读也接受只读预算与关闭取消，不撤销或重放写入。
  管理错误仅映射显式领域类型的稳定代码与安全文案；未知异常返回 500，不将其消息、代码或字段直接公开。冲突返回 409，目标缺失返回 404，明确依赖不可用返回 503。
- `account-management-error.mjs`：DeepSeek、CLP 及账户运行状态适配器共享的输入、冲突与恢复失败分类；WebUI 只消费其受控代码和字段，不公开底层异常。
- `webui-management-task-command.mjs`：Runner 自有维护命令，通过标准输入跨平台请求协作取消；返回请求标识绑定的受控提交/收尾状态，不返回原始输出。任务环境的内部 `CODEX_CONNECT_MANAGEMENT_TASK=1` 使下游控制器保留在同一自有进程树内，不扩展公开命令。
- `webui-management-tasks.mjs` / `webui-management-tasks.d.mts`：白名单服务、指标和调用记录维护异步任务；
  只接受固定动作和字段，显式输入/占用错误使用 `ManagementTaskInputError`，未知异常不公开原文。
  任务由包内维护 Worker 执行，状态按已验证的 WebUI 令牌或归一化回环 Origin 隔离，不回传原始输出；先协作取消，10 秒宽限后在总退出预算内收尾同一自有进程树。Unix 登记进程组，Windows 由所有者辅助程序及 Job 管理后代；Windows 树终止异步执行，多个任务不依次阻塞事件循环。未确认退出保留归属、错误与再次取消入口。WebUI 关闭先拒绝新任务再等待现有任务，取消或强制中断不冒充回滚成功。
  Runner 通过同一回调记录启动和终态审计，`auditStatus` 保留任何阶段的降级；列表、详情及 WebUI
  任务反馈均消费该状态。变更订阅在审计结果确定后通知，审计失败不阻断通知或覆盖任务结果。
  默认回环监听并托管 `webui/dist` 静态前端；提供 `/api/v1/time`（服务端时区与当前时间）、
  `/api/v1/overview`、`/api/v1/daily`、`/api/v1/threads`、
  `/api/v1/threads/:id/run|turns|subagents`、`/api/v1/requests`、`/api/v1/errors`、`/api/v1/providers` 只读 JSON 接口；
  Providers 返回指标库完整去重名单，指标查询支持重复 `provider` 参数形成多选范围；
  Overview 在同一读快照和截止时间下返回汇总、趋势与热力图；Daily 按 `range` 返回系统本地日聚合。
  Threads 只对主会话汇总和分页，返回首个请求开始时间和不受请求筛选影响的直接子代理数；Turns 返回每轮精确关联的直接子代理数。Subagents 对已登记父子关系独立分页，包含尚无请求的子代理；指定 `parentTurnId` 时，行统计、总计和模型分布仅包含精确关联的子 Turn，否则为子线程自身全部保留历史。官方耗时保留缺失语义，子轮次导航有界且标记截断。当前页通过 Gateway 私有 IPC 读取已有连接的权威 Thread 状态，不唤醒 Provider；状态失败显示未知，不影响历史指标。
  请求明细按受控字段在整个时间范围排序后偏移分页；
  `webui-api.ts` 声明接口响应类型，前端统一从该文件导入；监听参数优先取命令行，其次
  `config.toml` 的 `[webui]` 段，默认回环无令牌；绑定非回环地址（`0.0.0.0`）时必须设置
  配置 `token`，API 以 `Authorization: Bearer` 校验并采用常数时间比较；令牌不通过命令行传入。
- `metrics-config-menu.mjs`：本地指标存储设置的交互用例；集中管理保留天数和最大记录数，
  返回统一 `activationResult` 及自动激活状态
  （`pending`/`applied`），`config.mjs` 只保留顶层配置菜单编排。
- `metrics-menu.mjs` / `metrics-menu.d.mts`：`codexc metrics` 无参数时的交互用例及注入边界声明；按报告、会话、请求、额度、存储状态排列，循环中保留上次选项；运行汇总和会话 Turn 导出共用会话选择与手动 ID 输入；独立维护参数函数只由统一清理菜单使用，
  通过 CLI 注入的命令边界执行，不承载子进程或输出文件管理。
- `init-wizard.mjs`：`codexc init` 在交互终端下的初始化向导；先显示环境检测结果（Codex CLI 版本、
  官方登录、通讯渠道、默认模型、默认 Workspace 与可选功能状态），再按需循环复用 `setup.mjs` 的接入向导，
  可连续配置模型与渠道，选择“完成接入”后进入 Codex 设置菜单，复用用户偏好、官方 TUI 身份与时区设置，
  单项完成、返回或失败后可继续选择，选择“完成 Codex 设置”后继续；该菜单取消会中止初始化；
  逐项询问 WebUI 后台服务、调用详情记录与模型转发监听（默认沿用当前状态、首次初始化默认关闭，通过
  Config 管理接口写入 `[webui] enabled`，可选项确认绑定展示修订，全部确认后在配置锁内核对并写入；调用详情记录仅在变化时写入，模型转发监听选“是”才进入
  `model-relay-listen-menu.mjs`），在接入向导类别菜单取消即中止本向导（子流程取消只结束该子流程），
  尚未启用渠道时跳过安装，最后询问
  是否执行 `codexc install`；`bin/codexc.mjs` 在安装成功后按配置补启动 WebUI，并对已有但不可用的配置
  失败关闭、不修改数据。非交互调用不进入本模块，只创建用户目录、默认与群聊预备工作区仓库及初始配置。
- `setup.mjs`：使用 `@clack/prompts` 提供接入类别菜单和脱敏总览，并把“模型与提供商”“通讯渠道”
  和“项目技能”流程委派给具体适配器；“完成接入”正常退出，与顶层“取消”区分。总览与具体流程在选中后按需加载，注入回调优先。模型与提供商下分 OpenAI 官方
  登录/恢复与第三方提供商两级，子模块返回时停留在所属层级；第三方设置分为统一模型管理和各提供商账户接入，默认模型、共享思考等级与目录窗口集中在模型管理，自定义接入合并为一个入口；配置写入后的激活结果由
  `config-activation-result.mjs` 提供统一状态和目标定义，只转换子模块显式返回的激活范围，不为查询或取消操作推断重启。公开 CLI 的 `codexc setup --jsonl` 将交互提示
  写入终端 stderr，并按每行一个事件把脱敏结果或错误写入 stdout；完成接入返回 `result` 事件的 `action: completed`。输入或提示输出不连接终端时明确拒绝，操作失败后可继续选择。默认 `codexc setup` 保持纯交互文本输出。
- `channel-settings-setup.mjs`：Setup 的四渠道独立启停入口，复用 Config 管理的修订保护、严格校验和原子保存；停用保留凭据和授权配置，禁止停用最后一个渠道，取消不写入。只返回 Gateway 重启生效范围，不直接管理服务。
- `setup-summary.mjs` / `setup-summary.d.mts`：复用统一 Provider 管理状态读取 Codex 全局默认模型与思考等级，先返回
  不依赖终端输出的结构化脱敏总览，再由 CLI 包装器渲染；汇总主 Provider、可切换 Provider、第三方模型默认值、
  原生子代理、已启用渠道和用户技能数量，不显示 API Key、Token、应用凭据、
  允许名单、代理值或 Provider URL。
- `custom-primary-provider-setup.mjs` / `custom-primary-provider-setup.d.mts`：`codexc setup` 的“模型与提供商 → 第三方提供商 → 自定义提供商”共用设置流程；新增时选择官方或自定义模型目录。
  已有自定义模型提供商先选择模型管理或连接设置，取消子操作回编辑小节；模型管理复用 `provider-model-setup.mjs`，连接编辑保留模型与默认值，不重问模型能力或工具探测。
  新增时可从 URL 主机名派生 Provider ID、输入自定义标识符或选择推荐的 `OpenAI`，编辑时保留所选候选 ID；引导填写
  上游 `base_url`、直接写入的 API Key、固定/切换模式、上游接口（Responses 直连或 Chat Completions 由网关转换）、WebSocket 开关、客户端检索检测和上游模型 ID。选择 Chat Completions 时强制关闭 WebSocket 并跳过检索检测（检索与工具由 Chat 桥适配）。Codex 兼容入口从官方目录校验，服务启动时导出官方快照；自定义提供商入口
  收集逐模型能力并生成独立目录。两者均不调用第三方 `/models`。
  `OpenAI` 选项固定写入同名 `name` 以允许 Codex 使用远程压缩，上游仍须兼容对应接口。新增默认推荐
  切换模式，编辑保持原模式；确认预览明确显示配置位置、API Key 明文存储、默认思考等级和服务层级。固定模式通过 Codex
  `config/batchWrite` 原子写入并激活 `~/.codex/config.toml` 的自定义主 Provider，主配置仅保存 `env_key` 引用，Key 写入
  `~/.codex-connect/providers/custom/<ID>/primary-credentials/<版本>.json` 当前用户私有文件（`cp-` Provider 使用 `providers/<ID>/primary-credentials/`）；切换模式保持主
  Provider 为 `openai` 且不修改主配置，为每个 Provider 写入包含完整 Provider 块、Key、模型、
  官方目录的 `medium` 或自定义目录声明的思考等级和服务层级的 0600 私有 Profile：自定义目录提供商使用 `~/.codex/sf-cp-<名称>.config.toml`，Codex 兼容类型使用 `~/.codex/sf-custom-<Provider ID>.config.toml`，
  并通过私有显式注册表支持多个隔离实例。Gateway 管理的 DeepSeek、OpenCode Go 与自定义
  Provider 新配置写入 `request_max_retries = 4`、`stream_max_retries = 5`，与锁定 Codex 默认一致；
  App Server 启动统一第三方与聚合的实际重试值并回读核验，不改写既有文件。
  网络重连及 WS→HTTP 降级由 Codex 原生策略控制，不承诺整个 Turn 的固定发送次数。自定义固定模式不能保留其他自定义切换 Profile；转为固定
  模式前用户须先删除其他自定义切换 Provider。受管切换 Provider 可共存；受管固定模式必须先恢复
  官方模式，写入响应丢失时只读确认固定配置事务。只支持
  独立 API Key，切换模式在私有 Profile 使用 `experimental_bearer_token`，固定模式使用私有凭据与 `env_key`。Unix 文件为 0600，Windows 使用私有 ACL。
  上游 `base_url` 接受不带凭据、查询和片段的 HTTP(S) 地址，HTTP 会以明文出站并在保存预览中标记。同一 URL Origin 编辑时留空
  保留原 Key，Origin 变化时强制重新输入且写入前不复用旧 Key；新增拒绝覆盖 config 或私有备份中的已有 Provider ID。
  无效旧 URL 按不可复用 Key 处理，允许输入新 URL 与新 Key 修复。保留其他候选块，只移除与自定义
  主 Provider 冲突的顶层 `openai_base_url`。
- `responses-model-templates.mjs` / `responses-model-templates.d.mts`：为显式模板更新和受管固定模型生成读取当前有效公共底座，并从仓库 DS 原始目录按该底座补全模板，不读取当前 CLI 官方名单或账户目录。独立新增使用 `model-catalog.mjs` 的通用草稿，不再维护另一套模板草稿接口。
- `custom-model-capability-probe.mjs` / `custom-model-capability-probe.d.mts`：CLI 与 WebUI 共用的单项工具探测；按用户选择验证 apply_patch 或 tool_search 的调用及模拟结果接续，不执行返回的工具。另支持一次有界流式原生 web_search 诊断，上游可能实际搜索并计费，仅完整结构化搜索证据算通过；结构化工具拒绝复用 Provider Proxy 分类器及实际出站工具索引，覆盖 HTTP、顶层和选择项流错误；使用手填思考等级和安全结果，不写配置。
  工具探测的每步非流式成功响应必须声明与请求精确相同的模型 ID；缺失、无效或错模型返回无法确认，不以请求 ID 代替响应证据，也不自动解析模型别名。
- `custom-model-capability-setup.mjs` / `custom-model-capability-setup.d.mts`：CLI 逐模型、逐项询问 apply_patch 和 tool_search，支持手动选择或显式探测本项；用户选择采用结果后才回填草稿，最终复用 Provider 预览和目录事务。原生网页搜索默认跳过，仅诊断，不回填工具能力或改变搜索策略。
- `provider-web-search-probe.mjs` / `provider-web-search-probe.d.mts`：已配置提供商共用的原生网页搜索诊断，按目录修订和明确账户解析模型、协议及凭据；CLP 读取共享模型目录中已保存的思考格式和请求改写，与正常桥保持一致，不自动补入路由。复用单请求探测引擎，不写目录或搜索策略，不自动刷新登录或启动服务。CLI 和 WebUI 共用同一执行入口。
- `provider-web-search-setup.mjs`：Config 与 Setup 共用的提供商联网搜索菜单，按精确账户选择并展示当前模式，复用 `provider-web-search-management.mjs` 的预览确认、备份事务和回读；共用全局配置的提供商提示转到用户偏好菜单。取消或无变化不写入，不执行搜索探测或服务重启。
- `responses-websocket-probe.mjs` / `responses-websocket-probe.d.mts`：按锁定 Codex 协议探测第三方 Responses WS 握手、预热及可选文字请求；复用代理，限制超时与响应大小，取消时释放连接，不保存凭据或原始响应。
- `responses-websocket-setup.mjs` / `responses-websocket-setup.d.mts`：新增、编辑 Codex 兼容 Provider 时选择自动检测或手动 WS 开关，模型请求须确认可能计费，结果只进入最终保存预览；CP 自定义提供商仅手动选择 WS 开关。
- `responses-tool-search-probe.mjs` / `responses-tool-search-probe.d.mts`：用一次极短 Responses 请求探测第三方上游是否接受 Codex 的 `tool_search` 输入项；复用代理与 WSS/HTTP 同源设置，限制超时与响应大小，只回结构化结论，不回传上游正文。
- `model-catalog-validation.mjs` / `model-catalog-validation.d.mts`：Provider 保存前的 Codex 模型目录合同校验；先将自身新建的隔离临时目录设为私有，再写入目录数据，限制运行时间并清理临时文件，不修改系统 TEMP 根目录权限。
- `responses-model-setup.mjs` / `responses-model-setup.d.mts`：新提供商从共用独立草稿填写准确 ID、名称、窗口及能力，使用通用编程提示词；已有模型按设置组编辑，未选项保留。已配置提供商的新模型由统一添加入口处理，编辑不夹带添加或移除。高级设置保留现有能力、提示词、压缩／截断及采样编辑，工具诊断仍需单独明确触发。
- `provider-model-selection.mjs` / `provider-model-selection.d.mts`：CLP、OCG、CCG、自定义提供商共用的 1–64 个模型多选、预览确认与默认模型保护。
- `managed-provider-model-management.mjs` / `managed-provider-model-management.d.mts`：CCG、OCG、CLP 和自定义目录共用按 ID 添加的 CLI 交互、独立填写／继承选择、全字段预览及确认保存。继承只复制当前提供商保存的快照，CLP 附带请求格式及可选请求改写；不关联模板。受管提供商另可明确追加 DS 模板映射，已有模型保持原值，取消返回目录菜单。
- `managed-provider-model-edit.mjs` / `managed-provider-model-edit.d.mts`：CLP 已保存模型的本地读取、按字段差异预览与锁内保存，不依赖远程模板或模型 ID 匹配。保留精确 ID、请求格式、来源关联及未改字段；复用受管目录事务、备份、回读与同族账户等级镜像。
- `managed-provider-model-edit-setup.mjs` / `managed-provider-model-edit-setup.d.mts`：CLI 本地编辑 CLP 已有模型，按设置组选项修改并确认前后差异；支持思考开关 `enabled`，不新增模型、不下载模板，不提供 CLP 不支持的采样、原图或摘要控制。
- `cline-pass-request-options-setup.mjs` / `cline-pass-request-options-setup.d.mts`：CLI 编辑 CLP 模型级 `providerOptions` 出站覆盖，只提供 JSON 输入和格式校验，字段原样透传；预览差异并在备份后保存，不发起模型请求。
- `provider-model-management.mjs` / `provider-model-management.d.mts`：CLI/WebUI 共用的提供商目录能力、本地移除、单模型窗口及显示名称预览和锁内保存；修改绑定 Provider、模型和目录修订，并显示家族共用账户范围。显示名称修改保留模型 ID、默认值及能力参数，无变化不写入；自定义修改仅重编译已保存定义，不重新应用提示词模板；官方共享目录只读。WebUI 从对应保存目录投影完整能力，按目录身份、精确模型 ID 和内容修订读取白名单提示词。列表不携带提示正文。保护账户和 Gateway 显式默认值、非空目录及文件修订；受管修改纳入账户目录／来源持久恢复，自定义写入统一前后摘要 pending 与回读校验。
  列表投影受控移除原因，区分账户默认、目录默认及活动主提供商的 Gateway 显式默认；CLI/WebUI 共用判断，执行仍在锁内复核。
- `provider-model-template-management.mjs` / `provider-model-template-management.d.mts`：DS、CLP、CCG、OCG 和 CP 的统一模板候选、明确来源、分组差异预览及锁内执行。CLP 使用仓库 DS 模板，不下载 Cline 目录；既有 Cline 关联保留读取，更新时主动选择本地来源。候选绑定目标修订并在十分钟内复用，更新只覆盖所选范围，保留当前上下文、默认等级和未选字段。
- `provider-model-additions.mjs` / `provider-model-additions.d.mts`：CCG、OCG、CLP 和自定义目录共用的新增候选、全字段预览及执行计划。独立填写使用共用通用提示词草稿；继承同目录保存快照，不复制凭据或模板绑定。候选十分钟失效并绑定环境、账户、连接和目录修订；锁内复核、原生事务保存及回读，旧模型和默认选择保留。CLP 固定候选读取仓库 DS 模板，不访问 Cline 官方目录；Chat 能力受桥转换合同约束。
- `provider-model-setup.mjs` / `provider-model-setup.d.mts`：Setup 的统一模型管理菜单，复用显示名称编辑、移除、自定义模型专用保存、受管默认设置，以及 CCG／OCG／CLP／自定义提供商按 ID 独立填写或继承添加；受管提供商另保留固定 DS 候选入口。名称编辑展示固定模型 ID、旧名称、新名称及共享账户，确认后调用共用保存接口。已有自定义模型可单独选择工具能力探测，明确选择才发请求，采用结果仍走修订检查和预览保存。五类独立目录均可选择来源、对比并更新模板；自定义允许提示词、运行设置及本地工具，受管另有能力参数；默认仅选择提示词。逐字段预览差异，长内容显示 JSON 长度与 SHA-256 摘要并可在确认前展开，确认后保存，无差异不写入；不自动重启服务。
- `responses-provider-recovery.mjs` / `responses-provider-recovery.d.mts`：在共享管理锁内先拒绝未完成的目录整理，再校验当前配置，完成未结束的自定义模型目录保存或受管账户设置事务；两种记录仅接受 v2，旧版记录保留并提示使用对应原版本恢复。固定 CP 允许未设置或候选模型支持的独立思考等级，切换 Profile 仍须匹配目录默认等级；受管恢复核对准确目录／Profile 路径及前后值，拒绝覆盖后续修改。
- `custom-primary-provider-management.mjs` / `custom-primary-provider-management.d.mts`：提供自定义主
  Provider 新增与编辑的无终端校验、脱敏预览和执行接口；用 `preserve` / `replace` 明确表达 Key
  操作，现有 Key 只在内部计划闭包中用于同 Origin 保留，不进入预览或执行结果。固定模式复用 Codex
  配置事务与 Profile 回滚，切换模式在写入前复核 Codex 配置版本、私有注册表和 Profile 快照，再在
  同一文件锁内原子写入私有 Profile；整体保存绑定包含连接与凭据状态的预览修订，CLI 编辑另复核打开时的文件快照，拒绝旧草稿覆盖并发修改。切换模式在预览前要求可读取的主配置。统一返回生效动作和备份清理警告；CLI
  继续负责字段询问、危险修改确认和中文渲染。自定义模型定义校验失败转换为 `invalid-catalog`，WebUI 返回参数错误且不写入；内部异常和写入未确认仍保留原有错误语义。
  已有 CP 的连接专用计划拒绝模型字段，保留目录、所选模型及独立思考默认值；CLI 与 WebUI 共用此接口。计划先判断实际连接、认证及配置副作用，再为真实变化分配凭据版本；无变化仍在锁内复核预览修订，返回 unchanged/none，不重写业务材料或恢复快照，保留管理锁和审计。存在真实变化的连接保存前使用现有私有 Provider 快照，回读失败返回 `save-unconfirmed`，须核对快照人工恢复，不生成模型目录 pending。
  CLI 单模型工具能力保存使用内部 `preserveDefaults` 选项，只保存目录并回读原连接选择；不重写 Profile／主配置或连接恢复快照。普通整表模型编辑仍可明确修改默认模型。
- `model-provider-management.mjs` / `model-provider-management.d.mts`：统一返回 OpenAI 默认值、当前主
  Provider、受管 Provider（含 OpenCode Go 账户）、自定义固定/切换/备份候选和受管模型目录的
  脱敏管理状态；移除 API Key、私有 Profile 内容和子进程环境，并供 Setup 总览与主
  Provider CLI 列表共同复用；同时按 `CODEX_HOME/auth.json` 是否存在返回 OpenAI 官方登录状态，
  未检测到鉴权文件时按未登录处理。
  `loadProviderWebSearchSettings` 只读投影主 config 的搜索值（`source=global`，包括固定提供商）及切换 Provider 各自 config 的顶层值（`source=provider`），使用 `ready`／`error` 状态；独立 config 缺项为跟随全局。不推断会话实际模式，核心配置校验仍由原管理状态加载负责。
- `provider-web-search-management.mjs` / `provider-web-search-management.d.mts`：精确已配置切换 Provider 的搜索模式预览与确认保存，直接更新其 config 顶层 `web_search`，跟随全局只删除该字段；固定提供商共用主配置，要求在通用设置修改。复用 Provider 事务锁、资源修订及一次性确认，聚合与路径输入拒绝。写前生成唯一私有备份和 `<config>.search-pending`，逐文件快照保护、原子写及失败回滚，成功回读后移除记录；不确定结果保留恢复材料，不自动重试或重启服务。旧独立搜索文件不读取、不迁移、不删除。
- `model-provider-management-transaction.mjs` / `model-provider-management-transaction.d.mts`：统一
  串行 DeepSeek、OpenCode Go、自定义主 Provider 与默认模型设置的跨文件管理
  事务；同一异步调用链中的嵌套操作复用事务，避免 Provider 设置与账户删除交叉提交。
- `primary-provider-management.mjs` / `primary-provider-management.d.mts`：提供自定义主 Provider
  切换与删除的无终端预览和执行接口；预览仅返回脱敏目标、影响与生效动作，执行校验显式模型属于 App Server 官方目录、保持配置/Profile/私有备份事务顺序，
  并以稳定错误码和结构化警告报告失败或清理部分成功。删除结果分别保留 configuration、backup/credentials/catalog/metadata 清理状态及 activation；目录与元数据独立清理，精确 ID 可重试孤立材料。CLI 已确认的切换预览在事务内重新比对，目标或影响变化时要求重新确认。切换只加载目标 Provider，删除只依赖注册表与
  Profile 原文，其他 Provider 目录不可读不阻塞本次操作；管理模式整体校验与目标自身目录校验保持失败关闭。
- `primary-provider-config-transaction.mjs` / `primary-provider-config-transaction.d.mts`：统一自定义
  Provider 固定模式写入事务；切换与新增/编辑共同复用 Profile 移除、Codex 配置版本写入、响应丢失
  只读确认和安全回滚，避免两条管理链路复制高风险事务逻辑。
  固定保存先创建不可变私有凭据版本，成功后主配置引用该版本；明确未引用时删除本次新文件，未知结果保留新旧版本。
  移除切换 Profile 前另将本次主配置、Profile、注册表与预期修改保存到 Provider 数据目录的
  `profile-conversion-backups/<随机 ID>.json`，校验私有目录及备份回读后才继续。快照不覆盖、不自动清理或恢复，结果未知时供人工核对。
- `primary-provider-cli.mjs` / `primary-provider-cli.d.mts`：`codexc provider` 的
  list / add / switch / remove / recover 子命令；`list --json` 复用统一 Provider 管理状态并返回不含凭据的稳定主实例与候选摘要；
  switch / remove 复用 Provider 管理接口并负责中文确认与结果渲染；直接 remove 清理未完成时输出结果后返回非零，Setup 保留部分成功并继续菜单。所有 switch（含恢复官方、从备份恢复、
  切换 Provider 转固定）都会先经二次确认，并提示将改写主配置的 model_provider / model；命令行 switch
  传 --yes 跳过确认（仅命令行，Setup 菜单仍确认）；
  add 复用共用 Provider Setup，`--custom-models` 选择自定义目录；recover 明确选择保留或回滚未完成目录，
  Setup 统一管理两类目录，新增先选目录类型，取消表单回目录选择，目录选择返回提供商菜单；另提供候选选择编辑；`switch openai` 不运行登录直接恢复官方
  并把固定候选移入私有备份、保留切换 Provider，`switch <ID>` 把目标设为固定主 Provider；目标是切换
  Provider 时会移除其独立 Profile，已清理候选则从备份自动恢复并消费该备份项；Setup 可直接
  编辑备份候选并恢复、修改和激活，也可经二次确认删除备份候选。恢复、编辑或删除时先提交配置，
  成功后才消费同名备份；配置写入失败时保留原备份，配置已提交但清理失败时显示部分成功警告。备份
  不可安全读取时只允许编辑当前 config 候选，切换和删除失败关闭；注册表仍登记但 Profile 已缺失的
  切换 Provider 可由精确 `remove` 命令清理。删除切换 Provider 时同时清理同 ID 私有备份；Profile
  或注册项已经删除但备份无法安全清理时显示部分成功，不恢复已删除的切换配置。从第三方切回官方时清除第三方顶层模型，已在官方
  模式时保留官方模型。
- `primary-provider-usage.mjs`：`codexc provider` 的规范帮助文案，供脚本与入口帮助共用，
  避免两份文案漂移。
- `official-login-setup.mjs` / `official-login-setup.d.mts`：`codexc setup` 的官方设备登录入口；登录前预览共享 Provider 切换计划，受管固定模式须先改为切换模式。登录完成后重新核对确认范围与配置修订，再提交官方恢复；自定义候选备份、第三方默认模型、模型目录和思考设置清理与 `codexc provider switch openai` 保持一致。
  登录子进程异步运行，输出跟随交互输出流，不混入 Setup JSONL；失败、信号取消或输出异常均停止后续配置写入，并清理自有进程。
- `codex-tool-settings.mjs` / `codex-tool-settings.d.mts`：投影电脑、浏览器和已有 MCP 的用户设置与合并配置，定义可编辑字段与异步校验；导出共用 MCP 审批模式及 Strata 实际目标/时限校验供编辑向导使用；未知继承或宿主范围明确拒绝，不将普通 MCP 套用视频预算。插件 MCP 只接受原生策略覆盖，不返回启动配置和凭据。
- `codex-user-settings-management.mjs` / `codex-user-settings-management.d.mts`：思考等级保留原始覆盖或未配置，不以目录默认值替代。上下文窗口与自动压缩阈值独立使用精确 Token 正整数或 null，预览与写入不经过百分比换算，不接受旧百分比字段；不可解释的存储数值读取失败而不修改文件。统一返回不依赖终端的
  Codex 用户设置快照，并以配置版本保护的 `config/batchWrite` 受控修改默认模型与思考等级、Standard/Fast/Ultrafast、计划清单工具、TUI 空闲总结，
  按显式字段修改 Sandbox、审批和 Workspace Sandbox 网络权限，省略字段保留原值与继承状态；CLI 整组确认仍提交完整三项，一键批量配置仍要求完整权限，或一次原子写入默认值与用户偏好（已有 Permission Profile 时保留权限）；加速档位仅作为
  OpenAI 主配置偏好写入。单独设置页可选择 `live`、`indexed`、`cached` 或 `disabled`，不读取第三方模型目录。
  第三方固定模式不开放官方默认模型、思考等级和加速档位；已有 `default_permissions` 时不混写传统 Sandbox 字段。
  预览与执行按用户层原值计算实际 edits；等值返回 unchanged、willChange=false、activation=none，不调用写入。缺省与显式默认值分开，清除仅移除用户覆盖；策略及工具合并状态校验仍先执行。
  普通偏好支持仅提交所选字段和显式 null 清除覆盖；只有设置非空 Plan 思考等级需要 OpenAI 模型资格。快照分开提供模型、加速可用性及原始用户模型，未知枚举列入 unsupportedFields。
  写响应仅保留 status/version，同 Client 回读核对本次 edits 与写入版本，明确区分 confirmed/unknown；保存未确认不重试，okOverridden 提示高优先级覆盖。工具确认绑定相关合并目标的安全 hash，执行前再次核对，不返回命令或凭据。
  写响应丢失或不能确认的原生写异常返回受控 save-unconfirmed，提示可能已保存、先重读且不直接重提；版本冲突和已知写前拒绝分别保留冲突或无效设置语义，CLI/Setup 与 WebUI 一致。
  Fast 按模型目录精确 `priority`/`fast` ID、Ultrafast 按 `ultrafast` ID 开放，纯目录匹配与 Application、WebUI 共用 `runtime/service-tier.mjs`，预览和写入前重新校验所选模型及 Client 投影的独立开关；`fast_mode` / `ultrafast_mode` 分别结合合并配置与受管策略，不自动修改开关。设置页保留原始配置档位，关闭档位仍可退出到 Standard。
  快照保留已配置但不可用的模型 ID，未配置时只采用目录显式默认模型，不回退到其他条目；CLI/WebUI 提示先选有效模型，仍允许 Standard 退出加速。
  全局 Auto-review 默认值不按 Provider 白名单限制；原生配置值不受支持、组织策略限制或策略无法读取时保持只读。
- `codex-user-settings-setup.mjs` / `codex-user-settings-setup.d.mts`：`codexc config` 的“Codex 新会话与用户偏好”适配器。
  导出共用的工具访问入口，供“工具与 MCP → 电脑、浏览器与已有 MCP”与用户偏好中的原入口调用，复用相同的读取、预览和写入流程。
  分类菜单先显示，选择具体设置后再读取 App Server 状态；返回或取消不启动临时 App Server，默认模型入口不重复预读。
  只负责选择、预览和中文结果；“配置默认值与用户偏好”统一收集模型、加速、权限、Plan 思考等级、推理摘要（未配置时默认 `none`）、输出详细程度、更新检查与历史保存，最后确认并批量写入，中途取消不保存。
  “普通用户偏好”逐次选择单字段，复用管理层预览、修订保护与结果；显式继承清除覆盖，保留 false，第三方也可使用，非空 Plan 思考等级仍需官方模型资格。旧值区分未设置与不支持，不把显示默认写回；取消不写入。
  可单独设置计划清单工具、TUI 空闲总结与 Auto-review 审批审核人；Auto-review 单独显式确认，受管限制或未知值拒绝修改。
  第三方 Provider 的模型与凭据继续留在 Provider Setup。
- `codex-defaults-setup.mjs` / `codex-defaults-setup.d.mts`：从官方模型目录选择 Codex 全局默认模型和
  思考等级，写入复用统一用户设置管理接口；不修改登录凭据或 Gateway 的 Thread 默认模型。
  保存回读未知或被高优先级覆盖时返回 `activationResult: null`，保留保存事实提示，不制造 `none` 的未写入结论；真实无变化才使用 `none`。
- `codex-subagents-setup.mjs` / `codex-subagents-setup.d.mts`：Config 中显式选择的子代理规则与配置入口，
  预览后按选择写入 Codex Home 的 `AGENTS.md` 托管规则段和主配置；主配置复用版本化 `config/batchWrite`。
  配置预览检测用户层已有子代理默认模型与思考等级覆盖并提示人工处理，保留这些键；仅写规则不读配置并提示未检查覆盖。
  规则默认 Sol/high，Luna/max 处理明确低风险任务，Astra/high 按需使用；主代理负责决策、整合及针对性复核。
  模板管理显式用户约束交接、单轮生命周期、异步回收及审查覆盖；不固定二审或全量重读，不盲目省略模型参数回退。
  完成要求继承当前全局和项目规则，详细策略见用户指南；运行时模型和角色配置仍独立生效。
  安装、更新和默认值与用户偏好配置均不自动应用该预设。
- `model-provider-default-management.mjs` / `model-provider-default-management.d.mts`：提供受管 Provider
  默认模型与思考等级的无终端校验、版本化预览与确认保存接口；预览区分账户默认模型、同族共享模型等级及 Profile 镜像范围，保存拒绝过期预览。写默认模型时保留模型目录中已有的上下文窗口，
  窗口由「模型管理 → 所属提供商 → 模型上下文窗口」按精确 Provider ID 和模型管理；切换模式更新私有 Profile，固定模式与切换模式共用统一
  Provider 管理事务；固定模式以用户配置修订为前置条件，响应丢失时先只读确认写入结果，仅在主 Provider 未变且确认未生效
  且目录写入后的相关文件无后续修改时恢复模型目录。写入返回后仍回读主配置及同族账户默认选择、共享思考等级，不确定时返回 `save-unconfirmed`，不自动重试；执行阶段未知异常不对外暴露原文，结果明确返回 App Server 重启动作。
- `model-window-setup.mjs` / `model-window-setup.d.mts`：`codexc setup` 模型管理中的“模型上下文窗口”入口，按所选提供商限制可编辑目录；
  按提供商和模型选择受管模型，通过 128K、256K、384K、512K、1M 预设或自定义
  Token 数设置窗口；预设按模型最大窗口过滤，可直接选择最大窗口，自定义范围为 1024 至模型最大值。
  选择窗口前读取目录修订并显示目标提供商、模型及受影响账户；与添加自定义模型复用 `responses-model-setup.mjs` 的窗口选择交互。
  CLI 与 WebUI 共用 `provider-model-management.mjs` 的 `model.context` 预览、确认和事务保存；确认前显示窗口差异及账户范围，取消不写入，目录或账户变化拒绝旧编辑。结果返回 App Server 重启动作。
- `model-provider-default-setup.mjs` / `model-provider-default-setup.d.mts`：负责受管 Provider 默认设置的
  Provider、模型与思考等级交互与中文渲染，写入复用管理接口；统一模型管理与账户子菜单先明确所选账户，进入时允许取消返回所属菜单。上下文窗口不在本流程，转到
  `model-window-setup.mjs`；历史 Thread 仍保留创建时的模型。确认前展示默认模型与共享思考等级的差异和影响账户；保存时在管理锁内复核预览修订，成功提示使用实际执行结果。
- `codex-user-config.mjs` / `codex-user-config.d.mts`：WebUI 只读配置先从监管器取得主 Provider 的短租约，按需恢复空闲释放的主 App Server，读取及连接清理完成后释放租约；不创建临时 App Server。监管入口确实缺失时仍可连接已显式运行的独立主实例，协议不兼容或探测失败不得绕过租约。UA、指标、服务状态及本地目录展示不主动唤醒。CLI 事务创建隔离的 stdio App Server Client，把 Codex 官方默认值与
  `multi_agent_v2` 普通键级修改及更新器关闭 daemon 自动启动作为官方 `config/batchWrite` 事务写入用户配置；
  用户设置修改在同一 Client 中读取原始用户层及版本，并通过 `expectedVersion` 拒绝并发覆盖。
  读取、预览和写入共用临时客户端归属；只读生命周期接受取消信号，关闭自有连接及 Proxy，不终止共享服务。关闭失败保留客户端，由后续操作或 WebUI 关闭重试，未确认前不能创建替代客户端。已确认写入不因清理失败改判为写入失败；输出固定清理告警，不自动重复写入。Unix stdio 创建并登记独立进程组，包装器退出不等于整组退出。
  WebUI 最终关闭通过 `closeCodexUserConfigClients` 禁止新客户端操作，等待已准入操作结算后再处理残留清理；不取消已提交写入，也不在写入仍持有客户端时确认后台退出。
  所有 CLI 用户设置、MCP 与官方登录统一解析 Gateway 显式 Codex binary，配置为默认 `codex` 时才采用 `CODEX_BINARY`；默认 Codex Home 尚不存在时
  从用户主目录启动并由 Codex 初始化默认目录，显式 `CODEX_HOME` 仍要求已存在且为目录。
- `skill-setup.mjs` / `skill-setup.d.mts`：`codexc setup` 的“项目技能”类别；列出项目 `.codex/skills` 下带
  `SKILL.md` 的技能，安装/覆盖到 `~/.agents/skills/<技能名>`（可用
  `CODEX_AGENTS_SKILLS_DIR` 覆盖目标目录），支持卸载；只复制技能目录本身，不修改
  hermes 运行时的 `.skill-lock.json`。覆盖确认绑定目标快照，同父目录先准备候选再替换；旧树保留在隐藏操作目录并输出恢复位置，失败恢复不覆盖已存在目标。
  卸载确认同样绑定目标、父身份与内容修订；执行时复核并将原树保留到 skills 根目录之外的私有隔离目录，不递归删除。移走后发现并发变化时报告未确认和保留位置，不覆盖重新出现的目标，不自动恢复或清理材料。
- `config.mjs`：`codexc config` 的顶层交互编排，按作用范围提供 Codex 用户偏好、工具与 MCP、Gateway 显示与会话、身份时区、调用记录、计划任务、网络代理、服务访问、日志高级功能与指标存储，以及脱敏总览和路径查询。MCP 添加、编辑、删除与已有工具策略管理同组，Relay/WebUI 访问设置同组；保留损坏 Gateway 配置时的 Codex、MCP 和路径入口。循环记住上次选择；修改复用既有保存流程，非交互终端无参数时显示帮助。
  `paths [--json]` 不进入菜单或读取配置正文，只输出绝对路径与文件存在状态，不创建配置。子菜单与总览在选中后按需加载，路径查询和取消不加载这些实现。
- `config-summary.mjs`：把已经读取的严格配置投影为脱敏总览，有效默认值来自共享 Schema，原始配置保留未配置与显式配置的区别；与设置管理共用调用记录预设分类及实际裁剪值投影，只有 3/65536 与 0/0 分别标为生产与调试，其余显示自定义；只显示配置来源、有效开关、作用范围
  和已配置的代理字段名，不显示渠道凭据、访问令牌或代理值。
- `config-management.mjs` / `config-management.d.mts`：渠道新会话模型通过异步 `updateGatewayDefaultModelSetting` 校验当前主实例目录与配置修订后预览或保存；同步入口拒绝该设置，清除覆盖可离线执行。目录读取与 Gateway 写入分属不同资源，不提供跨资源原子事务。提供不依赖 prompts、TTY 或终端文案的 Gateway
  设置接口；官方身份一键设置持久写入 `follow_cli_version`，WebUI 可开关，终端单项修改保留标记；无标记或 false 时显式版本固定。
  设置脱敏读取与明确修改在读取快照及写入前复用当前版本的完整结构校验，拒绝未知字段和非法值，校验不回填默认值或替换带注释来源的原文对象；只接受受控的显示、系统（含一键官方 TUI 身份与模型上游终端标识）、自动化、网络、
  高级、Telegram 格式、WebUI、指标和默认 Workspace 输入，返回稳定字段错误与精确生效动作，
  身份与时区候选字段的 Schema 失败映射为受控输入错误，旧配置校验、未知字段路径与 IO 失败仍保留内部错误分类；
  字符串配置明确拒绝布尔、数字、对象和数组，不将非法类型折为清除；默认模型必须显式提供 value。
  身份编辑保持成组替换，代理批量编辑保持省略字段不变，仅合同允许的 null 或空字符串表达清除。
  凭据和网络读取只显示是否已配置；
  网络操作只更新共享 Codex `.env`，不写入 Gateway TOML；读取返回覆盖两个文件的修订，
  修改必须携带并在应用前复核；其他设置的最终提交复用 Gateway Config 的共享写锁
  和锁内原文比较，避免菜单停留期间覆盖其他进程已保存的配置；`applyTerminalIdentityFromEnvironment`
  在 `[codex].terminal_identity` 未配置且运行命令的终端可探测时按该终端补入，供
  `codexc install` 与 `codexc update` 复用；`codexc config` 与 WebUI 改用同一探测
  结果预填，由用户确认后写入。
- `config-management-error.mjs`、`config-webui-management.mjs`、`config-metrics-management.mjs`：
  保存 Config 管理接口的共享稳定错误，以及 WebUI、指标的脱敏投影、输入校验与文档修改语义；
  切换 WebUI 为全网卡监听且尚无令牌时，共享逻辑生成随机令牌并与地址一起保存；也支持经确认显式重新生成。预览仅返回脱敏状态，写入响应只提供本次生成的令牌。CLI 菜单不直接读写这些配置段。
- `config-advanced-menu.mjs`：管理计划任务、显式 HTTP(S) 代理与日志等级；日志等级统一通过 `debug-setup.mjs` 写入，代理输入可见但既有值、输出和日志均不回显；HTTP、HTTPS 与通用代理支持一次性原子写入 Codex `.env`，与 WebUI 共用 Config 管理入口。
- `config-display-menu.mjs`：独立管理模型统计分组、操作详情（含仅失败或拒绝）、子代理显示、流式显示、计划更新、默认关闭的渠道思考状态、完成通知、消息详情和 Telegram 消息格式；完成、子代理、流式和消息详情支持显式设置与删除字段恢复缺省，消息详情缺省基础、子代理和流式缺省开启但均不物化，微信目标支持完成通知和消息详情。流式仅控制 Telegram、飞书与 QQ 单聊正文增量预览；不改变完整正文、附件、授权或原窗口和交付义务。消息详情独立于日志和调用采集，只控制启动运行环境及完成/子代理统计子项。提供范围覆盖的目标、存储值、有效值和来源确认，复用预览、修订保护、私有备份及保存后读回；旧版回退前显式清除全局及覆盖 `presentation_detail`、`streaming` 并核对后续修改；模型分组仅用于控制台汇总，保留原模型明细，重新读取即生效；
- `config-display-management.mjs`：CLI 与 WebUI 共用的显示范围投影和显式 set/inherit 编辑，复用配置事务并提供每个目标实际支持的字段；只读当前 Schema 绑定并按当前飞书账号与 Actor 名单取得私聊物理 Chat，QQ 仅从配置取得单聊，微信从当前启用账号与允许名单取得精确私聊，Telegram 不猜历史绑定的聊天类型。目标不可读与缺失分别表示，停用或移除后的已有合法覆盖可显式清除；旧 QQ 群覆盖由共享严格 Schema 拒绝，不提供恢复继承入口。
  “过程说明”通过 `display.commentary` 的显式 set boolean/inherit 管理，缺省开启不物化，读取区分有效 `commentaryEnabled` 与本层 `commentaryOverride`。Telegram、飞书与 QQ 单聊支持，微信覆盖拒绝且不显示字段。CLI 和 WebUI 共用修订、私有备份、预览与读回；有效值变化且上述渠道任一启用时重启 Gateway，否则 reload；隐式 true 与显式 true 互换只 reload，范围数组整体保守判定。取消、未变化不写；回退前清除全局及覆盖 commentary，核对后续修改。语义与交付边界见[渠道展示](../docs/display.md#过程显示范围与继承)。
  CLI 负责选择与渲染，读取、校验和写入复用 Config 管理接口。
- `config-system-menu.mjs` / `config-system-menu.d.mts`：以受控分组分别提供 Gateway 会话、身份与时区、调用记录入口，分组越界选择明确拒绝；向 Workspace 菜单公开默认项设置，复用配置修订与生效通知。管理模型请求转储及其保留天数、审批超时、默认 Workspace、
  Gateway 新 Thread 模型覆盖、一键官方 TUI 身份、模型上游终端标识与服务时区；模型请求转储独立写入
  `[debug].model_traffic_dump` / 既有裁剪模式参数 / `model_traffic_retention_days` 并要求重启 App Server；终端标识预填运行该命令的终端探测结果并允许
  编辑，留空即删除配置；服务时区与网关时区分别复用 `codexc timezone` 与 `codexc timezone --gateway`。
- `timezone-command.mjs`：实现公开 `codexc timezone`，解析 IANA 时区名称与 `--system` / `--json`，
  交互入口只列常见时区，并提供「恢复系统时区」与「其他（手动输入 IANA 名称）」两个动作项，
  在边界校验格式、Node.js 时区支持和可用的系统时区库后通过 Config 管理接口写入 `[codex].timezone`，并提示 App Server、Gateway 与
  WebUI 的重启要求；缺省不写入配置，非交互终端只报告当前值，`codexc config` 的身份与时区菜单复用同一实现。
  `--gateway` 管理 `[gateway].timezone`：缺省跟随 App Server，`--system` 选择独立系统时区，
  IANA 名称设置自定义时区，`--follow-app-server` 删除独立设置；修改后提示重启网关。
  写入 JSON 同步返回 action、activation 与结构化 activationResult；等值不写入且不提示重启。
- `config-webui-menu.mjs`：独立管理 WebUI 启用状态、监听地址、端口和访问令牌交互；启用状态写入
  `[webui] enabled` 并据此决定 `codexc start/restart all` 是否启动 WebUI；保持公网监听必须配置
  令牌的失败关闭约束，`config.mjs` 只负责把顶层选择路由到该领域菜单。
- `management-access.mjs`、`management-confirmations.mjs`、`management-audit.mjs`、
  `management-security.mjs` / `management-security.d.mts`：本机管理适配器复用的无 HTTP 安全基础，
  覆盖高风险确认、Origin、限速、请求上限、安全响应头和脱敏审计；WebUI 管理路由复用其中的请求约束、
  限速和审计原语，配置了 WebUI 令牌时直接使用 Bearer 令牌认证。
- `debug-setup.mjs`：在严格配置中原子写入 `logging.level`；Config 日志与高级功能选择完整日志等级，不改写显示设置或凭据。
- `ccg-setup.mjs` / `ccg-setup.d.mts`：CCG 多账户配置、默认账户及 `codexc provider ccg remove` 删除入口；账户隔离 Key/Profile/App Server 与统计代理，模型目录由 CCG 账户共用，写入前使用 Codex CLI 校验完整目录，目录思考等级同步账户 Profile，原生角色保留独立设置。
- `provider-model-catalog.mjs` / `provider-model-catalog.d.mts`：原生 DS、CCG、OCG 的模板投影，以及 CLP 固定 DS ID 映射和模板绑定。CLP 从仓库 DS 元数据编译 Chat 能力，明确保存 Flash／标准请求快照，不继承 DS Responses 原图、摘要、服务档位或未支持的协议字段。
  DS、CCG、OCG 的初建及模板更新共用按目标家族区分的来源投影；仅 DS 官方账户关闭 verbosity 与摘要声明，CCG／OCG 保留源声明，不将 DS 官方端点限制套用到其他平台。
- `managed-provider-files.mjs` / `managed-provider-files.d.mts`：Provider 文件事务必须提供当前运行环境；统一访问器绑定文件归属，快照携带内存中的读取与写入闭包。主 Codex 配置通过用户层 `config/read` 与带 `expectedVersion` 的 `config/batchWrite` 发布实际变化的字段，禁止全文件替换；回滚只逆转本次字段并再次校验版本。固定模式先纳入不可变私有凭据再发布引用；未知写入先回读，不自动重放，无法确认时保留私有文件、凭据及备份并阻止自动回滚。已确认失败时先恢复已有文件，失败保留新增恢复资料并停止后续删除；未纳入快照的更新明确拒绝，不改变持久化备份格式。
- `managed-provider-account-plan.mjs` / `managed-provider-account-plan.d.mts`：受管账户固定模式与自定义切换注册表的兼容性检查；DS、CCG、CLP 共用编辑的模式、凭据保留和变化计算，拒绝缺失默认模型，预览不暴露凭据。账户计划快照包含相关配置、注册表及当前固定凭据版本，以私有 HMAC 修订绑定预览，执行时拒绝过期确认，不公开凭据摘要。
- `managed-provider-account-runtime.mjs` / `managed-provider-account-runtime.d.mts`：DS、OCG、CCG 共用账户实例检查与释放，删除前检查监管状态和 Remote TUI 租约。使用用户配置定位主 Socket，源码拆分入口直接运行时也遵守显式配置文件、用户数据目录与默认用户配置的优先级，不回退仓库配置。
- `deepseek-setup.mjs` / `deepseek-setup.d.mts`：下载并提取 DS 官方目录，构建时复用 `runtime/model-catalog.mjs` 收紧无效 verbosity/摘要声明，保留其他能力与窗口设置；调用方取消覆盖请求、正文读取及重试等待，取消后不重试。拒绝响应时释放正文；不导入账户菜单或管理事务。
- `update-model-templates.mjs`：源码仓库维护入口；默认仅下载 DS 官方目录，用已保存公共底座补全提示词并报告字段差异，保持底座及其来源不变。`--update-base` 在当前 Codex 环境运行锁定 CLI 的 `debug models`（不带 `--bundled`），按输出顺序提取第一个模型，记录实际模型 ID，用已保存 DS 原始目录重新补全，不下载 DS；导出使用 CLI 配置、认证与缓存策略，可能联网或更新缓存。两种操作均默认只对比仓库快照，`--write` 在隔离的 Codex 加载校验后才保存所选更新。复用快照须与来源哈希一致；不更新已配置账户，不执行下载脚本，不进入安装包命令入口。操作与边界见[DS 模板维护](../docs/deepseek.md#仓库模板维护)。
- `deepseek-account-management.mjs` / `deepseek-account-management.d.mts`：DS 多账户配置、默认账户与删除事务；新建目录记录逐模型来源关联，重新配置保留已有目录，不隐式补全模板。首次下载及复用目录均在账户文件写入前通过当前 Codex 完整目录校验。
- `deepseek-account-setup.mjs` / `deepseek-account-setup.d.mts`：DS Setup 菜单与 `codexc provider deepseek` 入口，复用管理事务和既有模型设置菜单。
- `deepseek-catalog-baseline.json`：保存人工对照 DeepSeek 官方 Codex 安装脚本审查后的模型完整指纹、
  上下文、输入模态、思考等级、搜索、并行工具和最低客户端版本；`digest` 是模型条目紧凑 JSON 的
  SHA-256。该文件只作为审查留档，运行时开放哪些模型以 Setup 下载的官方目录为准。
- `managed-model-provider-setup.mjs` / `managed-model-provider-setup.d.mts`：复用第三方 Provider 的
  受管模型目录默认值/逐模型设置保留、切换 Profile、固定配置与稳定错误逻辑；OCG 与
  CCG 共用完整模式配置生成，DeepSeek 复用配置原语，账户注册和历史备份格式仍由各自适配层负责。
- `opencode-go-account-files.mjs` / `opencode-go-account-files.d.mts`：集中 OpenCode Go 账户私有文件
  路径与 Profile 文件名；私有文件事务使用 `managed-provider-files.mjs`。
- `opencode-go-account-management.mjs` / `opencode-go-account-management.d.mts`：提供 OpenCode Go
  默认账户切换、运行实例停止与当前账户删除的无终端预览和执行接口；默认切换只更新注册表，
  停止明确区分未运行、Remote TUI 占用和已停止，删除在明确确认后保留私有备份并执行多文件回滚；
  删除计划在监管器等待前捕获注册表、Profile、标记及固定模式恢复材料，停止前和写入前复核，拒绝覆盖等待期间的外部修改；
  删除默认账户前必须先指定其他默认账户；删除时仅清理账户配置与管理标记，保留共用模型目录与来源记录，固定模式账户只恢复其管理的主配置字段，保留无关子代理。
- `opencode-go-account-provisioning.mjs` / `opencode-go-account-provisioning.d.mts`：提供 OpenCode Go
  账户新增/重新配置的脱敏预览与无终端执行接口；内部完成目录下载、每个账户进入固定模式时的恢复基线更新与旧基线归档、Key 写入、切换/固定模式配置和多文件事务回滚；同一家可保留一个固定账户与其他切换账户。
  联系方式可省略，重配保留已有展示字段；省略 Key 仅允许已有账户沿用可安全读取的凭据。预览包含模式前后值与凭据操作，修订绑定实际配置和私有凭据，无变化仍校验完整模型目录，但不写入或要求重启。
  执行计划在首次异步等待前捕获既有文件快照，目录下载和 CLI 校验后仍使用原快照，外部修改不会成为旧计划的新回滚基线。
  首次接入从官方模板生成共用目录，新增账户和重配均复用已有目录，不继承其他 Provider 的同名模型窗口。
- `opencode-go-setup.mjs` / `opencode-go-setup.d.mts`：OpenCode Go 多账户管理
  （add/list/reconfigure/remove/default/release，供 `codexc provider opencode-go` 调用）与统一账户 Setup 菜单；列表和实例释放仅保留直接命令，模型操作委托统一模型管理；`list --json`
  返回不含 Key 与 Profile 路径的稳定账户摘要；新增/重新配置复用账户 provisioning 接口，默认切换、停止和删除复用账户管理接口；配置切换/固定模式
  从同一受审查来源分别生成账户模型目录；重复配置时保留仍受支持的
  默认模型与逐模型设置。
- `channel-setup-presentation.mjs`：三个通讯渠道共用的 Clack 选择、输入、确认与取消适配器，以及微信、飞书共用的紧凑二维码渲染；保留完整模块、使用 L 级纠错，终端过窄或渲染失败时向调用方报告错误，由渠道取消扫码会话并返回向导。
- `terminal-prompter.mjs`：为本机维护命令统一提供 Clack 确认接口，保留调用方的默认选项；取消确认不执行操作，
  `AbortSignal` 中止返回 `AbortError`，关闭时释放在途交互；非终端调用要求使用显式参数。
- `telegram-setup.mjs`：把 Telegram Bot 来源、长轮询冲突确认、允许名单输入和中文输出适配到
  `telegram-setup-session.mjs` 的结构化会话；复用统一 Codex `.env`、环境变量和系统代理解析；交互输入的
  Token 使用隐藏输入，验证错误继续脱敏；新建 Bot 仅引导使用官方 BotFather。
- `telegram-setup-session.mjs` / `telegram-setup-session.d.mts`：提供所有者绑定的 Telegram Setup
  开始、状态、自动配对、允许名单预览、确认与取消接口；Bot Token 和一次性配对码只保存在有期限的
  进程内会话中，状态、预览和结果不返回 Token，取消和超时通过 grammY `AbortSignal` 中止验证或
  长轮询；验证时拒绝已设置 Webhook 的 Bot，不自动解除已有接入。请求前及确认时校验配置版本和结构，确认时检查 Telegram 配置未被并发改动并校验候选配置后再原子写入。
- `feishu-setup.mjs`：把手动凭据输入、Device Authorization 二维码、允许名单确认和中文输出适配到
  `feishu-setup-session.mjs` 的结构化会话；扫码时由飞书授权页选择新建或已有企业自建应用，只申请
  私聊接收与发送、流式卡片、应用自管理检测、受控配置写入和命令中心所需权限、事件与回调。
- `feishu-setup-session.mjs` / `feishu-setup-session.d.mts`：提供所有者绑定的飞书 Setup 开始、状态、
  脱敏预览、确认与取消接口；手动与扫码两种方式都验证凭据和 Bot 身份，扫码授权、Bot 验证与终端
  等待共用整体期限及真实 `AbortSignal`。App Secret 与短期授权只由进程内会话持有，确认时检查飞书
  配置未被并发改动后再原子保存；请求前及写入前校验配置版本与结构，手动模式仅在 App ID 相同时提供原允许名单。扫码模式只保存本次扫码用户，并在保存后保留已有菜单、自动发布
  `codexc_home` 悬浮菜单、长连接事件与卡片回调。远程配置失败时保留已保存的连接配置，并返回脱敏
  警告供终端提示通过 `codexc doctor` 和重新扫码恢复。
- `weixin-setup.mjs`：从统一 Setup 菜单执行连接替换风险确认、微信扫码和严格结果裁剪，把
  终端输入输出适配到 `weixin-setup-session.mjs` 的结构化会话，把 Bot Token 原子写入微信独立安全凭据后端，
  最终确认后向 TOML 写入启用态账号与允许用户元数据；
  Setup 不直接启动消息 Surface，由 Gateway 配置变更处理或下次启动生效。
- `weixin-setup-session.mjs` / `weixin-setup-session.d.mts`：提供所有者绑定的微信 Setup 开始、状态、
  配对码提交、确认与取消接口；二维码和凭据只保存在有期限的进程内会话中，状态与保存预览不返回
  Bot Token，取消和超时会中止底层请求并丢弃临时状态，确认时检查微信配置未被并发改动后复用原子
  凭据/配置回滚事务；扫码前及凭据写入前校验配置版本与结构。凭据写入未确认成功时保留现有材料，不补偿写回旧值或删除；仅已确认的凭据写入才进入后续配置失败的既有恢复分支。未知配置写入异常时同时核对原子替换的文件身份和目标配置，不能用旧配置值相同判定提交成功。
  三个渠道会话均保留已确认配置提交后的锁释放告警，不把已保存降为普通保存失败；终端显示后续处理提示，Setup JSONL 保留 warnings。
- `feishu-application.mjs`：为 Setup 与 Doctor 提供带有限超时的飞书凭据/Bot 身份、应用权限、
  消息事件和待审核版本只读探测，不建立消息长连接，并把 SDK 错误和残缺响应收敛为不含敏感详情的
  稳定错误；每次凭据验证使用独立 Token 缓存，鉴权和 Bot 查询均受请求期限与会话取消约束。
- `feishu-registration.mjs` / `feishu-registration-worker.mjs`：在独立 Worker 内复用锁定 SDK 的扫码注册，限定注册开始和轮询请求期限；父端取消、失败或完成后等待 Worker 终止，不在后台遗留注册请求，也不更改主进程的 SDK HTTP 默认值。
- `qq-registration.mjs` / `qq-registration-worker.mjs`：迁入旧 QQ 分支的扫码基础模块，使用锁定 Connector 并等待自有 Worker 退出，不自行写配置。
- `qq-setup.mjs`：QQ 单聊扫码或手工配置入口，复用私有 TOML、修订检查和激活提示。含 `qq.groups` 或旧 QQ 群显示覆盖的配置在修改前明确拒绝，不迁移或改写。取消或配置并发变化不保存。另提供独立的单聊机器人常驻菜单配置操作，选中后才加载相关实现。
- `qq-menu-setup.mjs`：复用已有 QQ 凭据、共享代理网络和协议客户端，通过全局 `/v2/menu` 为单聊新增只填入 `/help` 的 Codex 菜单。严格保留四种已知菜单和顺序，未知字段、同名冲突或满十项拒绝；同值不写。预览确认后重读本机凭据/代理及远程版本/完整内容，PUT 后回读核对版本与计划；允许平台为 send_message 补充 HTTPS icon，保留既有图标。平台未配置时实测返回 `{menu:{}}` 且无版本，保留该明确空态，不虚构版本。平台无 CAS，仍有复核与 PUT 之间的并发窗口，不自动重试或回滚不确定写入。独立关闭客户端与网络，不打开 WebSocket、不写 TOML、不重启 Gateway；当前账号菜单保存已只读确认，用户已确认手机显示，桌面端支持范围未确认。
- `workspace-command.mjs`：实现 `codexc work` 的参数校验、交互菜单、目录创建与已有目录注册，不保存或写入执行权限；
  默认工作区选择复用 `config-system-menu.mjs` 的版本化配置写入，移除操作仅移除注册；本次菜单循环保留上次选择。
  `list --json` 返回稳定的 Workspace 注册摘要；CLI 入口只负责分发。
- `workspace-config.mjs`：读取、检查和原子更新 TOML 中的 Workspace 配置，通过 `runtime/config-event-queue.mjs` 保证 Gateway 重启窗口内的 Workspace 新增通知可恢复；支持列出失效项、删除注册记录，并恢复固定默认 Workspace。交互菜单按精确 ID 移除，避免数字 ID 被解释为列表序号；目录状态复用共享只读检查。
  添加和移除在配置事务内捕获旧事件 ID，提交后只确认该快照，避免同 ID 重新注册的新通知被清除。配置已提交后的清理失败保留新增事件；结果分别携带配置收尾、队列锁及旧事件清理状态，CLI 先报告保存事实，再提示核对与清理，不自动重放写入。

## 开发与协议

- `dev-all.mjs`：开发模式下复用完整的现有 App Server 拓扑，或通过唯一的内部
  `service-app-server` 入口立即启动主 App Server；已配置的隔离 Provider App Server
  在首次选择模型、恢复 Thread 或使用对应 Remote TUI 时由监管入口按需启动。统计代理也按 Provider
  使用情况启动；原生子代理复用父线程实例与代理；
  随后再启动 Gateway；源码与构建入口均使用包目录的绝对路径，配置可位于仓库外。只复用私有监管身份、Provider 拓扑和真实 WebSocket 健康检查一致的实例，
  Gateway 进程再通过与 Provider 无关的配置级所有权 Socket 拒绝所有入口的重复实例。部分拓扑或裸
  App Server 失败关闭；脚本统一收敛自身启动错误，已经由内部服务入口展示的失败不重复包装。
- `provider-selection.mjs` / `provider-selection.d.mts`：Remote 与 Desktop 共用的纯 Provider 选择映射；
  配置读取由默认参数提供，可注入已读取的定义。完整 Provider ID 与已登记的规范 `sf-*` Profile 名精确匹配，
  不剥除前缀推测目标；当前共享门禁关闭聚合，`agg`／`sf-agg`／`codexc-aggregate` 明确拒绝。返回 Provider 与可选规范 Profile，不修改配置。
- `codex-remote-options.mjs` / `codex-remote-options.d.mts`：在读取 Gateway 配置前解析
  `codexc remote` 自有的 Workspace、Provider 与 Profile 参数；`-p` / `--provider` 使用共享选择映射，
  与 `--profile` 互斥，重复选择失败关闭。`--profile` 保留原生个人 Profile 与已登记规范受管 Profile；
  旧受管 Profile 名返回明确替换提示，并尊重 `--` 后原样传给 Codex 的参数边界。
  `codexRemoteDirectoryArgs` 按锁定版原生根参数区分实际 `resume`／`fork` 子命令与参数值，
  处理根提示词、图片多值、其他子命令及 `--` 边界；只有未显式选目录的恢复／派生不注入 `-C`。
  原生参数与子命令判定表以 0.163.0 为基线，升级 CLI 时需同步核对。
  显式快捷命令 `r` 经同一子命令定位逻辑展开为 `resume`，复用其目录语义；参数值、
  其他子命令的参数及 `--` 后的文字保持原样。
  分离写法的图片参数按原有边界转为重复的 `--image=路径`，避免提取 Gateway 参数后吞掉命令；
  附着写法不消费后续位置参数，与锁定版 Clap 解析一致。
  不根据 OpenAI 登录状态自动选择第三方，不修改主配置。
- `codex-remote.mjs`：为原生 `codex --remote` 选择 Provider Socket 和工作目录；未显式选择时连接主实例，
  显式 Provider 通过共享映射选择相应 Socket 和规范 `sf-*` Profile，连接对应隔离实例并供 Remote TUI
  完成第三方 Provider 认证；受管及自定义切换 Provider 统一使用原生 Profile 加载，包括其中的搜索设置。
  普通新建注入当前目录，未显式选目录的恢复／派生保留原生 Remote 的目录继承、列表与新建回退；
  显式 `--workspace`／`-C` 始终传入目录覆盖。第三方 Profile 不复制权限，
  不注入 Gateway 权限；原生显式参数与个人 Profile 由 Codex 自行处理；
  聚合入口当前关闭，内部实现保留：聚合选择复用共享 Runtime 拓扑与 Supervisor 按需租约，不生成磁盘 Profile；启动前通过已有
  Codex Client 读取服务端默认模型与目录，投影启动设置，避免本地 OpenAI 默认模型覆盖聚合目录。
  透传 `-m`/`--model` 或 `-c model=...` 选择目录内精确模型时，按 Codex 的最终模型优先级使用目标模型的默认思考等级；
  服务端默认模型保留服务端思考等级，显式 `-c model_reasoning_effort=...` 优先，并尊重 `--` 参数边界。
  不再追加独立搜索覆盖参数；搜索值随对应 Profile 加载，用户显式透传参数继续按原生优先级处理。
  自动审查沿用原生配置或用户显式设置，不按 Provider 或模型过滤、降级，也不为此固定请求模型。
  Remote 恢复及继承式分叉保留历史实际模型和 reviewer。
  聚合目录和 Provider 不允许由透传参数替换；
  配置错误由脚本稳定展示，Codex 子进程的终止信号原样向上传播。
- `prepare-codex-upgrade.mjs`：在干净工作区校验精确目标 CLI，调用现有协议生成和版本同步，
  完成基础一致性检查后把差异交给 Codex 审查。
- `codex-release-api.mjs`：为稳定版解析器调用 GitHub Release API；请求或响应正文
  读取发生网络异常，以及遇到 429 和 5xx 时做三次有限重试，不在错误中输出凭据或上游正文。
- `resolve-codex-release.mjs`：通过 GitHub Release API 解析或验证 `openai/codex` 正式发行版，
  拒绝 Draft、Pre-release 和版本不匹配。
- `analyze-upgrade-protocol.mjs`：比较 `HEAD` 与升级工作树中的生成协议，报告 RPC 名称、顶层
  类型字段和生成文件变化；只陈述结构差异，不推断行为语义。
- `codex-public-cli-contract.mjs`：从锁定 CLI 的公开帮助提取 Remote 实际转发参数（包括 Permission
  Profile 使用的 `-c/--config`）的存在性、别名、参数形状和枚举值，校验根级和所有 Profile 用户
  设置审批值与快照一致；升级时刷新受控快照并按新增、删除、签名变化
  和枚举变化生成独立影响报告，不把 App Server 内部枚举误当成公开 CLI 合同。
- `run-upgrade-validation.mjs`：为正式升级提案独立运行协议、类型、Lint 与
  Gateway/WebUI 构建；单项失败后继续其他阶段，并保存逐项日志和结构化结果。预览阶段不
  改稳定版文档，因此明确跳过文档索引检查。
- `write-upgrade-report.mjs`：把 CI 中生成的升级工作树写成 Markdown 摘要、文件清单、统计和
  二进制安全 Patch，并分别比较 `HEAD` 生成协议的 RPC/顶层字段结构和受控公开 CLI 合同，合并
  逐阶段结果；生成或验证失败且没有差异时仍会输出报告。
- `check-pr-description.mjs`：所有 Ready PR 至少在新增、修复、改动之一说明具体变化，无内容分类可省略，保留章节不得为空或仅有占位；正式升级 PR 还要把自动占位内容替换为本项目的收益、采用项、不采用项及风险与验证。
  Draft PR 暂时跳过，转为 Ready 时由同一门禁重新检查。
- `protocol-schema.mjs`：在同一文件系统按指定稳定/实验模式临时生成、逐文件比较并安全替换协议类型目录。
- `generate-protocol.mjs`：先在临时目录调用当前 Codex CLI 的 `generate-ts --experimental`，
  成功后替换协议类型、记录版本与实验状态并同步 npm/Gateway 版本；实验生成只服务于 `docs/index.md` 明确列出的受控协议边界。
- `check-protocol.mjs`：校验本机 Codex CLI 版本，并按记录的实验状态重新生成到临时目录确认类型逐文件一致。
- `weixin-qr-contract-probe.mjs`：直接执行时提供隔离二维码合同探针；默认离线显示帮助，只有显式
  `qr --live` 并再次确认连接替换风险后才访问固定微信端点，严格裁剪状态、限制官方重定向域名
  并有限取消；不注册 Surface、不写配置或凭据，也不属于公开 `codexc` 命令。
  该文件同时导出正式 `weixin-setup.mjs` 与 `weixin-setup-session.mjs` 使用的二维码客户端和
  登录流程，随 npm 包分发；导入不会执行独立探针入口，不能按无调用的历史脚本删除。
- `gateway-version-policy.mjs`：无 I/O 的 Gateway/Codex 基础版本兼容谓词，供静态门禁和源码更新候选校验共用；不承担稳定版选择或防降级排序。
- `check-gateway-version.mjs`：校验 npm 包与 Gateway 运行时版本一致，并要求正式版本、`-rc.N`
  候选版或 `-fixN` 修复版使用与 Codex CLI 协议相同的基础版本。
- `check-runtime-boundaries.mjs`：静态校验源码模块允许依赖、公开入口、循环、Surface 隔离、协议受控导出
  与未支持 API 约束；同时校验 `runtime <- scripts <- bin` 的目录依赖方向，并要求三者访问已编译
  `src` 能力时只使用按调用方列明的精确入口。该检查由 `npm run check` 执行。
- `check-docs.mjs`：校验项目 Markdown 本地链接、根 `index.md` 文档索引、源码模块索引、协议数字和相关目录
  文件索引，并拒绝已移除的文档名称；常规项目文档检查排除 `.codex/skills/**` 附带的技能参考资料。
- `install-git-hooks.mjs`：只为当前源码仓库设置 `.githooks`，不修改用户全局 Git 配置。
- `webui-i18n.mjs`：静态读取 WebUI 中英文文案字典，检查键与占位符，并按 Git 基线输出包含术语表的增量翻译任务 JSON；不执行字典代码、不调用翻译服务、不写回译文。
- `verification-scope.mjs`：读取本地提交或指定 Git 基线的改动文件，供检查入口选择静态检查范围。
- `verify-commit.mjs`：本地 `verify:commit` 按改动范围执行必要静态检查与构建；从 WebUI TypeScript 配置及源码导入追踪共享声明、浏览器实际加载的实现和传递依赖，避免漏掉 WebUI 构建。`verify:ci` 执行完整静态检查与构建。
  Unix 平台对安装脚本及两个服务控制脚本逐文件执行 `bash -n`，任一文件失败即阻止后续检查。
  WebUI 共享 API 类型 `webui-api.ts` 纳入根 TypeScript 与 ESLint 类型检查；共享输入变更触发
  WebUI 构建、Lint 和翻译字典检查，字典检查脚本自身变更也触发字典检查。共享依赖缺失或配置无法解析时直接拒绝继续。
  macOS 枚举四类 launchd 模板，替换共享停止预算的整数占位符后通过标准输入交给 `plutil`；预算、服务清单或模板渲染入口变化也触发此检查。模板检查不代替安装和服务运行观察。
  输出选中范围、每个阶段及全部检查的累计耗时。类型检查使用 TypeScript 原生增量缓存，覆盖源码及其依赖；
  缓存位于 `node_modules/.cache/codexc/check.tsbuildinfo`，可删除后重建，不缓存后续版本和边界检查。
  需要构建产物时，在完整类型检查成功后才清理并构建 Gateway，使用 `--noCheck` 避免重复类型分析；
  独立 `npm run build` 保留完整类型检查。
- `config-backup.mjs`：调用方持有配置锁并验证目标后，执行私有备份、同步及逐字节校验，再原子保存，可传递完整文件容量上限；供 Relay 管理等配置写入使用。
- `traffic-command-options.mjs` / `traffic-command-options.d.mts`：集中解析并预检 `codexc traffic` 的
  转储目录、逻辑调用编号、正文长度、关键字、跟随与清理参数，使顶层 CLI 在读取配置前拒绝非法输入，
  并向顶层帮助导出规范用法行。
- `traffic-cleanup.mjs` / `traffic-cleanup.d.mts`：实现并声明 `codexc cleanup traffic`；默认只预览
  已识别的 V2 session，确认全部 App Server 与 Relay 已停止后才按 `--confirm` 永久删除，
  菜单传入首次预览的范围指纹，停止检查后复核预览范围及目录/manifest 身份，逐项删除前再复核；未识别文件与目录保持不变。菜单内调用与维护服务共享取消信号，直接命令保留子进程收尾协议。
- `traffic-command.mjs`：`codexc traffic` 的实现，把 V2 逻辑调用索引与正文引用渲染成人可读文本；
  每个编号固定展示一条请求和一个终态响应，支持编号、关键字、正文上限与持续跟随；不修改转储文件。
- `traffic-dump-reader.mjs`：V2 转储共享读取实现，Relay debug v1 补充入站/交付阶段且拒绝未知版本，严格读取 `manifest.json`、`interactions.jsonl` 与
  payload 引用，按批次和逻辑调用编号配对产出摘要和详情；`codexc traffic` 与 WebUI 共用。
  manifest 只接受当前四个字段，扫描路径不受字段覆盖；各读取入口拒绝链接、非普通文件与打开时替换，
  manifest 限制 1 MiB、索引和 trace 每行限制 16 MiB。WebUI
  使用可取消的异步目录、manifest、文件流与分块正文读取，整次 HTTP 读取共享 128 MiB、10 万记录/正文分片、2 万目录项及 2048 次文件读取尝试预算；CLI 每页与详情复用同一预算，整次命令按页读取，清理预览不使用该上下文。WebUI 摘要
  分页复用进程内偏移索引，按批次有界归并且允许访问全部历史 offset；对当前页有界读取请求正文以投影思考等级，与详情共用参数解析，不回写转储；单条详情只保留目标调用。
  正文和独立 trace 均有界读取；客户端 WebSocket 关闭明细只定位同连接关闭事件，并在本次详情持有的固定调用快照内，按当前 writer 的原始 Thread/Turn、账户与目标筛选、读回核对一个后续调用，额外正文最多读取 1 MiB，不改写原始状态或推断取消原因。`describeDumpTrace` 通过目标事件偏移单独读取当前页，不重读正文、无关调用或聚合输出。详情的 `diagnosticsComplete` 与 `tracePage.complete` 分别表示可选聚合和事件页是否完整；单目标聚合超限仍可访问已索引的后续事件页。`summarizeDumpExchange` 提供精确摘要，`summarizeDumpChanges` 按请求落盘位置和固定水位提供有界增量页，保留未完成尾行的重读位置，不把提前分配的调用 ID 当写入顺序。Turn State 字符数仅在单次调用诊断中提取，指标列表不读取调用索引。只识别当前 V2 格式。
- `traffic-offset-index.mjs`：列表、精确详情与诊断共享的可丢弃 V2 偏移索引，不落磁盘、不缓存正文或响应头。数字哈希表与固定宽行保存同批次每个 ID 最后一条请求和响应的位置，另按请求时间、ID、落盘位置及原始关联身份哈希排序；身份哈希只选择候选，读取端仍核对完整身份。每个 trace 文件只保存 interaction/连接关闭关联键和记录位置，按键及原始位置排序，二分定位目标事件计数和页。完整固定水位读取后才发布索引。全进程两类索引共用最多两个构建、256 个缓存项、128 MiB 活跃索引分配（包括行、哈希表、排序临时空间与每项元数据预留）；单构建另限 30 秒、512 MiB 累计读取和 200 万行，单行 16 MiB，扫描/解析临时对象另有字节上界，不把该值当作进程 RSS 上限。只淘汰无引用且未构建项；重复请求共享同源文件构建，HTTP 取消不终止其他请求的共享工作，5 秒无后续访问取消冷建，服务停止取消并等待全部文件句柄关闭。源身份与固定前缀摘要复核覆盖替换、截断和伪追加；正常追加重新校验旧前缀，只解析新增尾部。合法无换行尾 JSON 仍纳入快照，后续追加会重新构建；损坏残尾暂不发布，等待完整追加。trace 冷建保留核心正文并标明待重试，资源上限保留正文并明确诊断不完整；取消、损坏或源身份失败仍拒绝读取。
  请求、响应和 trace 行另保存原始字节的 128 位摘要，计入同一内存预算；固定快照期间读回目标行时核对摘要，防止同 inode 改写加增长混入旧快照，无需每页重扫全前缀。`acquireDumpSnapshot` 为命令级分页提供不透明借用句柄，调用方最终释放；跨轮增量身份带缓存代次，已验证前缀的正常追加（包括合法无换行尾补换行后的重建）保持代次，非增量重建或缓存回收后不能证明原游标则明确失效。长期跟随可能先触及共享 256 项缓存边界，需要重新开始读取，不能把更大的批次跟踪上限当作可同时常驻的索引数量。
- `traffic-dump-presentation.mjs`：从已有 V2 请求接口识别协议、请求头识别客户端自报名称，从正文投影每次调用的元数据、参数、用量和错误，从响应索引投影失败阶段；`requestActivity` 复用输出归约器，从本次响应及请求末尾生成有界工具/回复行为摘要，不使用历史工具或工具声明。Reader 为列表、单条和增量额外读取至多 256 KiB 响应，详情复用已读取正文并遵守相同上限，缺失与截断不推断完整行为；从终态或
  独立 trace 提取有界输出，重组 WebSocket 分片与 SSE 事件；HTTP 分片缺号后停止拼接，读取端结合响应索引的可选 `traceTruncated` 标记呈现不完整输出，完整终态正文不受 trace 缺片影响。Chat 按 choice 和工具 index 拼接文本、思考、拒绝说明和工具参数，投影工具调用与结果关联，异常内容保留 JSON；投影请求输入、声明工具与参数对照，并分开提取本次调用的服务端模型声明和安全缓冲候选及来源；仅从同次调用的单调时钟节点计算阶段，不与上游轮次或旧墙钟相减，不回写转储。
  失败阶段读取结果为稳定标识；`formatFailureStage` 仅供 CLI 中文呈现，WebUI 使用自己的中英文字典。未知标识明确回退为未知阶段，不通过文案匹配解释历史记录。

## 构建、打包与服务

- 根目录 `install.sh`：在 Linux/macOS 上克隆 Codex Connect 官方 `main`，把完整 Git 仓库安装
  到 `~/.codex-connect/codex-channels`，检测 npm 与 Codex CLI，CLI 缺失或版本不符时同步项目精确版本，
  并检查登录状态；随后完成依赖、Gateway/WebUI 构建和 npm 全局命令注册。不覆盖现有源码目录、
  配置或数据，也不写入 Shell PATH。
- `clean-dist.mjs`：构建前清理 `dist/`。
- `build-windows-native.mjs` / `build-windows-native.ps1`：Windows 的 `postbuild` 使用现有 PowerShell 7 将共享 C# 编译为 `dist/windows-native/CodexcWindows.dll` 并生成一致性清单；首装器确认生命周期启用后也先调用该生成器，以便在完整构建前保护安装目录。其他平台及显式禁用生命周期脚本时不编译。产物随 `dist/` 打包，运行时只加载。编译失败不留下有效清单。
- `sandbox-dependencies.mjs` / `sandbox-dependencies.d.mts`：`install.sh` 与本地源码全局安装共用的沙盒系统依赖检查；macOS 检查固定系统 Seatbelt 入口，Linux 缺少 `bwrap` 时通过 apt-get/dnf 补装，并检查锁定 Codex 所需的 `--perms`。不改变 Codex 权限或系统安全策略；普通用户仅使用非交互 sudo，无授权时给出人工处理步骤。
- `install-global-source.mjs`：显式准备干净源码、自动执行 webui 子项目依赖安装与前端构建
  （`webui/dist`），再生成临时 npm tarball 并通过禁用隐式生命周期脚本的 npm 全局安装；安装结果
  不链接或依赖源码目录，并避免 npm 12 脚本策略跳过构建；源码更新可用内部 `--prepared` 复用已
  验证的 Gateway/WebUI 构建结果，避免重复构建；入口产物必须是非符号链接的普通文件。Windows 在两条路径打包前均验证原生 DLL 与当前源码、宿主环境匹配且可加载；缺失时失败，不隐式重建。注册全局 Gateway 前按协议元数据同步缺失或版本不符的默认 Codex CLI；CLI 安装显式包含平台可选依赖，执行失败与版本不符分别报告。显式二进制无效或版本不符时失败关闭，不依赖渠道配置。
- `source-install-summary.mjs`：安装成功后共用的只读下一步指引；区分配置不存在、已有普通配置文件和无法确认状态，不把配置存在视为服务就绪，不修改配置或启动服务。构建、依赖检查阶段不加载该模块或输出初始化建议；指引生成失败不改变已完成安装的结果。
- `webui-dev.mjs`：仓库根目录 `npm run webui:dev` 的一键开发入口，并行启动
  `codexc webui`（API）与 Vite dev server，任一子进程退出时统一清理另一个进程。
- `package-path.mjs`：提供不依赖第三方包的 npm 包根目录解析。
- `prepare-package.mjs`：源码仓库安装或 npm 打包前按 lockfile 补齐缺失的本地构建依赖、
  启用仓库 Git hooks、构建源码，并验证已安装包包含运行入口；显式 `--ignore-scripts` 时不执行准备，兼容仍调用 prepare 的 npm 版本。
- `sync-gateway-version.mjs`：升级 Codex CLI 协议时把 `package.json`、锁文件和 Gateway 运行时
  版本重置为新的正式基础版本；Gateway 候选发行和修复发行可分别在该基础版本后使用受控的
  `-rc.N` 或 `-fixN` 后缀。任一后缀 Tag 发布并核验后，`main` 必须通过独立 PR 恢复无后缀基础
  版本；历史发布记录由对应 Release 保留，当前安装入口统一使用源码。
- `doctor-output.mjs` / `doctor-output.d.mts`：把已收集的诊断项转换为结构化报告并渲染终端文本；文本阶段标题、进度、完成状态与结果统一写入 stdout，JSON 模式仅输出报告，不执行环境探测。
- `doctor.mjs`：检查 npm 包、Node、Linux PATH 中的 `bubblewrap`、Codex CLI、当前 TOML 配置、
  OpenAI 主提供商使用的配置、环境变量或系统代理路由（不显示代理地址或凭据）、
  Workspace、飞书凭据/Bot 身份、
  微信配置与 Bot 凭据、只读消息游标检查点（不修复权限）、允许用户的加密回复上下文覆盖数和最近保存时间，
  以及微信运行时启用状态；缺少 `bubblewrap` 时说明内置 helper 回退并输出发行版安装命令，
  文本模式立即输出标题、向 stderr 提示检测阶段，按诊断领域逐步输出失败、提示和处理建议，交互终端区分颜色并汇总各状态数量；独立 App Server 与服务查询最多四项并发且按原顺序展示，查询命令有超时和 1 MiB 输出上限，飞书 SDK 按需加载；
  Doctor 不自动安装或修改 AppArmor，不调用
  `getupdates`，不显示 Token、`context_token` 或游标；
  主 Unix WebSocket、已配置 Provider 的切换或固定配置、实际模型目录、Provider Socket、
  监管身份与 Provider 拓扑、`initialize.userAgent` 中的运行中 App Server 版本与系统服务状态，
  同一次诊断复用已解析的自定义 Provider 拓扑和同次监管检查的空闲释放状态；Windows 计划任务与宿主在系统服务阶段批量查询，系统服务汇总复用本次主 App Server 握手结果并独立确认 Gateway 就绪；已确认运行的 Provider 直接握手，不再先建立第二条 Proxy 探测连接，不缓存跨命令的 ACL 结果；
  `--json` 输出完整脱敏检查数组、分类计数与健康状态；不输出完整 User-Agent、飞书
  上游响应或敏感配置内容。
- `service-install-context.mjs` / `service-install-context.d.mts`：后台服务安装器共用的配置、
  默认 Workspace、主 Socket、Codex/Node 可执行文件及服务 PATH 解析；读取计划不修改磁盘，执行时才把
  运行目录创建为 `0700`；已有目录也须先通过类型、链接与属主校验，再应用共享平台私有保护。显式 `CODEX_HOME` 按锁定上游规则校验为已存在的目录并规范化；Windows 服务定义保存该目录，未设置时保留上游默认目录语义。
- `service-install-management.mjs` / `service-install-management.d.mts`：把服务安装拆成配置校验、平台
  预检、定义原子写入、核心服务激活和就绪确认五个结构化阶段；返回不含配置凭据的修订计划、进度、
  完成阶段、稳定恢复动作和最终结果。Linux systemd 与 macOS launchd 共用任务契约，但继续由各自
  控制脚本实现 linger、Job 检测及服务管理，不解析 Shell 文案推断结果；Windows 使用当前用户计划任务及受管宿主，并校验私有定义与就绪状态。
  控制器异步执行并提供输出回调；取消在阶段边界生效，当前操作完成后执行既有恢复，恢复不继承取消信号。
  三平台定义保存显式规范化 Codex Home，未设置时不写环境项；systemd ExecStart 关闭变量展开，路径按字面传递，其他字段保留原转义规则。
  Windows 定义包含解析后的 App Server Socket，缺失时拒绝跳过就绪检查；预检通过私有文件边界读取旧 JSON/VBS 快照，安装激活先停止核心服务与 Relay 再启动，保留 WebUI 运行状态。首次或旧定义不完整的安装在激活失败后保留新定义供诊断，完整旧定义恢复失败时保留原始阶段与两层错误。
- `service-command.mjs` / `service-command.d.mts`：公开 `appserver`、`relay` 目标映射到内部 `app-server`、`model-relay` 服务标识；实现顶层后台服务命令和隐藏的 Gateway/App Server/Relay 服务入口装配；Relay 在启动和关闭期间持续接收停止信号及父进程控制，取消传入资源 owner；集中解析
  服务目标与日志参数（行数限定为 1 到 10000 的十进制整数）、选择三平台控制器、限制 App Server 内的自中断操作，并在启动后复用统一就绪
  检查；顶层 `restart` 统一预检、停止与逐项启动就绪，默认包含已安装且未关闭的 WebUI，失败报告剩余步骤并中止。Windows 重启批量查询全部所选计划任务，启动和停止在当前进程调用同一控制器，复用权限检查宿主，避免每一步重新启动 Node 与 ACL 宿主；不缓存权限结论、不改变服务顺序和就绪检查。Model Relay 内部入口接收父进程 `codexc-stop`，完成资源关闭后退出。CLI 只保留帮助展示和命令分派。
  `start`、`stop`、`restart` 共用逐服务步骤计时，单调时钟覆盖控制器及启动就绪等待；完成或失败均输出步骤耗时，重启单独报告预检耗时。命令总耗时由 CLI 统一输出。批量目标继续使用共享服务选择与顺序；`start all` 说明按配置跳过的 WebUI 与 Relay，`restart all` 说明只停止不重启的可选服务；Windows、启动和重启在首个失败后中止，Linux/macOS 的 `stop all` 保留尝试其余目标后汇总失败的行为。
  WebUI 就绪校验有界健康 JSON、服务身份与受管进程 PID（或其直接父进程），拒绝重定向和其他进程的成功响应。
- `config-activation-result.mjs` / `config-activation-result.d.mts`：把配置写入器的内部激活范围转换为
  稳定的状态、目标和可执行命令列表，供 Config、Setup 与自动化复用；Codex 用户偏好使用
  `next-thread / codex`、`next-tui / codex` 和 `next-thread-and-tui / codex` 分别表示新 Thread、
  新启动 TUI 或两类生命周期读取，Workspace 注册表使用 `reload / gateway`，
  App Server 重启动作使用 `restart / app-server`，App Server 时区使用
  `restart / app-server-gateway-webui` 并列出三个服务的重启命令；本模块不承载服务控制。
- `config-activation-notice.mjs` / `config-activation-notice.d.mts`：统一配置写入后的生效提示，区分新会话读取、
  Gateway 自动重新读取、需要重建 Gateway 或 App Server，以及需要通过 `codexc install`
  重新生成服务环境的变化；WebUI 的专属重启要求继续单独提示；同时重启 App Server、Gateway 和 WebUI 的指令先停止 Gateway，再重启 App Server、启动 Gateway，最后重启 WebUI。
- `launchd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载 App Server、Gateway、WebUI 与可选 Relay 的 launchd 服务；启停、
  状态和日志支持 `gateway`、`app-server`、`webui`、`model-relay`、`all` 内部目标，
  启动 `all` 时排除配置中关闭的 WebUI，停止、状态与日志仍包含已安装的 WebUI；状态判定只把预期运行的服务计入异常，
  配置不可读时退回“已安装即可选服务必需”并在 stderr 说明降级；安装动作仍只启动核心服务与已启用 Relay，
  普通启动不强制终止已运行的进程，重启由服务命令层组合单目标停止与启动；模板为 App Server 与 Gateway 注入各自服务角色，公开 CLI 据此
  拒绝 App Server 内的自重启；
  检测到不支持的旧标签时明确拒绝启动。
- `service-target-query.mjs`：把共享服务目录中的 systemd unit 或 launchd label 逐行提供给平台
  控制脚本，避免 Shell 维护第二份服务标识；状态判定使用容错的 `status-required` 顺序。
- `service-status.mjs` / `service-status.d.mts`：通过 systemd 属性、launchd Job 字段或 Windows 计划任务
  生成统一基础 JSON 服务状态；Windows 额外核对受管进程和核心 RPC 端点。目标异常时保留可解析输出
  并返回非零状态，查询器故障则失败关闭。
  管理接口的最近错误只提取显式 CLI 失败、error/fatal 级结构化记录和非工具类 tracing 错误，
  忽略进度、耗时提示、告警及 Codex 工具调用错误；先复用日志安全投影脱敏，再压缩为空格并对每条限制240字，合并最近最多三条且总长度不超过600字。
  macOS/Windows 同时检查受管 stdout/stderr 日志的有界尾部，按文件更新时间选择含错误的日志；
  文件日志目录与安装器、日志页面一致，取当前配置中主 App Server Socket 的父目录；配置不可读或该目录不是普通目录时不返回文件摘要，不回退旧默认目录猜测来源。
  Linux 从最近 100 条 journal 记录中按应用日志级别分类，不以 journal 的流优先级替代应用级别。
  journal 时间戳前缀只在 journal 读取边界移除，普通文件日志中的错误正文保持完整。
  macOS 文本状态也复用该解析，区分已加载与实际运行。
  Windows 异步查询的整体预算为 25 秒，包含 Job 宿主、ACL 冷启动、内部查询与宿主 IPC 阶段；超时只回收本次查询的 Job 子树，回收失败明确报告退出未确认。
- `cli-status.mjs`：让 systemd/launchd 控制脚本复用公开 CLI 的成功、失败、提示和处理状态前缀、
  TTY 颜色及 `NO_COLOR` 规则；日志和数据内容不经过状态渲染。
- `systemd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载 App Server、Gateway、WebUI 与可选 Relay 的 systemd 用户服务；
  安装前确保当前用户的 linger 已启用并复查，使用户未登录时也能随系统启动，无法启用则在修改
  unit 状态前失败并显示管理员处理命令；与 launchd 使用相同的目标、服务角色和默认值，启动 `all` 时排除
  配置中关闭的 WebUI，停止、状态与日志仍包含已安装的 WebUI，状态判定只把预期运行的服务计入异常，
  配置不可读时退回“已安装即可选服务必需”并在 stderr 说明降级；
  安装动作单独保留 WebUI 停启状态。停止不存在的 Unit 与 launchd 一样按已停止处理；
  卸载先完整查询全部目标，只跳过已确认不存在且未运行的 Unit，定义缺失但仍运行时仍先停止；管理器故障、查询不完整或停止/禁用失败时保留全部服务定义，用户数据始终保留。
- `windows-service-control.mjs` / `windows-service-control.d.mts`：读取用户级 Windows 服务定义，
  通过计划任务控制脚本执行 App Server、Gateway、WebUI 与 Relay 的安装、启停、状态、日志
  与卸载；
  核心服务状态同时检查监管进程存活、RPC 可达性及服务定义完整性。
  非跟随日志按固定块后向定位最近行，再按打开文件的大小快照流式输出，保留超长行并限制内存；末尾换行不额外算空行，读取期间截短明确失败。跟随仍使用 PowerShell Tail。
  Windows 使用 Task Scheduler COM 精确查找任务并批量读取状态，宿主 IPC 并发查询；只把任务不存在识别为缺失，权限和调度器错误明确失败。批量启停遇到首个失败即停止后续操作，并报告已完成和未执行目标。
  计划任务预检、查询和普通变更分别限制为 10、5、15 秒；停止在同一 PowerShell 与 COM 连接内执行并确认任务停止，确认预算 20 秒，外层含启动开销最多 25 秒，避免每轮确认新建 PowerShell。之后仍检查宿主退出。变更超时只补一次有界状态查询并报告结果未确认，不重复变更，不把任务状态当作应用就绪。
  App Server 启动等待向共享检查入口传入主 Socket 路径，由该入口统一派生监管地址；实例已空闲释放时也检查同一监管入口。
  启动前在定义指定的 PowerShell 中校验原生 DLL、Node、启动器、实际 CLI 入口和工作目录，确定性错误先于任务启动返回，不输出定义解析异常中的环境值。计划任务宿主启动等待 15 秒，App Server 应用就绪独立等待 60 秒；监管确认主实例运行后才启动连接探测。宿主超时后只补一次任务状态查询，最近任务结果明确不保证属于本次启动；运行期故障仍需结合日志判断。
- `windows-service-host.mjs` / `windows-service-host.d.mts`：计划任务启动的 Windows 服务宿主，按 JSON 定义启动并监管单个
  Node 服务进程，转发控制请求并把标准输出、错误输出写入用户级运行日志。
- `windows-service-launcher.ps1`：Windows 计划任务调用的 PowerShell 启动器，设置受控环境后
  转交服务宿主，不依赖当前终端目录或用户 Shell 配置。
- `windows-scheduled-task.ps1`：创建、启动、查询和删除当前用户计划任务；任务通过
  `wscript.exe` 以隐藏窗口运行对应 VBS 启动器，避免服务进程占用可见终端窗口。
- `windows-log-follow.ps1`：按服务目标跟随读取用户级运行日志，供 `codexc logs` 使用。

脚本不得把凭据写入 npm 安装目录；用户配置、SQLite、配置事件队列、Socket 和日志必须留在用户级 `.codex-connect`。

`session-cleanup.mjs` 实现 `codexc cleanup sessions`：Gateway 停止时通过 App Server 枚举全部
Workspace/Provider，按主会话真实轮数筛选，不使用展示缓存决定资格。后代通过 `ancestorThreadId`
查询未归档与已归档成员，执行前重新检查会话组及绑定；仅在交互终端 `--confirm` 确认后向父会话
发送一次官方归档。根会话只扫描一份共享历史，轮数超过阈值时不再扫描后代；扫描与执行显示进度。结果核验在写入批次后集中读取各 Workspace 的已归档/未归档根列表，各组再独立读取后代。结果区分可查询成员已核验、部分完成、未归档、未确认与跳过，已确认归档的成员失效展示缓存，不重试写入或自动回滚。
扫描连接在建连前登记，连接失败也进入清理；关闭未确认时保留客户端并输出独立告警，不覆盖归档结果。同进程再次扫描前先重试旧连接清理，仍失败时不创建替代连接。

- `cline-pass-setup.mjs` / `cline-pass-setup.d.mts`：CLP 多账户交互菜单、模型多选、名单预览与确认；保留账户默认模型，委托账户管理模块执行后显示激活提示。
- `cline-pass-account-management.mjs` / `cline-pass-account-management.d.mts`：CLI/WebUI 共用的 CLP 固定／切换配置、默认账户与移除预览和私有文件事务。新目录从仓库 DS 模板生成固定映射与来源关联，已有目录、默认选择和凭据保持各自合同；不下载 Cline 目录。

- `model-relay-listen-menu.mjs`：CLI 与 Config 一级菜单共用的监听交互入口，关闭/本机/局域网/指定 IP，保存前确认和配置修订检查，不自动安装或启动服务。
- `model-relay-command.mjs` / `model-relay-command.d.mts`：Relay CLI 参数与帮助、队列状态、上游能力及调用方查询、签发/编辑改绑/轮换/停用/删除、中文用途名称及每 Key 多提供商模型授权，不提供旧格式转换命令。
- `model-relay-management.mjs` / `model-relay-management.d.mts`：CLI/WebUI 共享 Relay 管理，脱敏资源、Key 多提供商模型授权与思考策略管理、目录输入能力与策略能力、只读预览、版本检查、配置锁/备份/原子保存及 IPC 生效确认；只在实际保存后返回一次新秘密；Relay 专用事务保留已保存结果并单独标记锁清理失败。
- `webui-management-relay-route.mjs`：Relay 管理 GET/preview/apply 与队列 SSE 路由，复用管理鉴权、确认、Provider 事务和脱敏审计；GET 复用 CLI 私有状态查询并只返回受控运行与队列摘要。
- `relay-reasoning-probe.mjs` / `relay-reasoning-probe.d.mts`：WebUI 按目录版本与公开模型 ID 发起一次基线及八种关闭参数对比；复用真实 Provider 材料、代理、出站策略和 Chat/Responses 观察器，CLP 按精确模型读取同一材料快照的请求配置，使探测路由与实际 Relay 一致。顺序请求、不重试，限制单次/总预算及真实响应字节，以有界 NDJSON 流逐项返回进度、思考可见性、用量和受控状态，不保存服务器配置或正文。
- `webui-queue-events.mjs`：账户快照、请求指标、Relay、渠道投递与管理任务共用的鉴权后 SSE 转接、订阅总量限制及 WebUI 关闭清理；通知不携带指标、队列或任务内容。`closeQueueStreams` 禁止新订阅并等待已有 watch 结束，收尾完成前继续占用八个订阅名额之一。
- `webui-management-delivery-route.mjs`：渠道投递箱鉴权 SSE 变化通知、只读分页查询、按需限定内容预览及单条重试/批量重试或忽略确认；复用管理鉴权、限速、记录修订、一次性令牌和审计，在线操作通过投递私有 IPC 交给 Gateway 单写者，确认未发送命令且 Gateway 不可连接时才使用 Journal 维护模式独占锁，持锁复核完整记录修订，不恢复其他记录或清理图片，列表不返回正文或平台检查点内容；单条内容预览及只读批量摘要认证解密后仅返回显式展示字段，摘要批次消耗读取配额，批量操作在同一事务中复核全部修订。
  只读查询交给有界 Worker，连接断开取消读取；批量正文先记录修订基线，再逐条在短事务内核对修订并读取，解密和消费确认不持有数据库读锁。管理写入的确认、审计和结果未知处理仍由原接口负责。
- `service-selection.mjs` / `service-selection.d.mts`：统一三平台服务定义路径，将已安装的可选 WebUI、Relay 纳入 all；启动 all 时排除配置中关闭的 WebUI 与未启用的 Relay，停止、状态与日志仍包含已安装的可选服务，健康判定同样允许关闭的可选服务保持停止；状态查询经容错的 `status-required` 顺序取预期运行集合，配置不可读时退回“已安装即可选服务必需”并在 stderr 说明降级，使诊断不因配置损坏中断；安装动作排除 WebUI，服务顺序由 Runtime 服务目录定义。

指标库只接受当前 Schema。查询与导出支持 `--source owned|relay`、`--caller ID`。
