# 项目脚本

本目录保存 npm CLI 和开发流程调用的 Node.js、Shell 脚本。脚本处理本机配置、构建、协议生成和服务管理，不承载 Gateway 的会话业务逻辑。

## 配置与 Workspace

- `managed-provider-account-prompt.mjs` / `managed-provider-account-prompt.d.mts`：多账户添加共用预设与自定义 ID 交互。

- `runtime-config.mjs` / `runtime-config.d.mts`：解析并声明用户数据目录和运行时路径，并初始化 `.codex-connect`；为只读诊断和
  独立项目命令提供不修改配置权限的必需/可选路径定位，可选定位只把文件不存在视为未初始化，
  但显式指定的配置文件缺失及其他文件系统错误仍失败；启动与写入流程显式收紧目录和配置文件权限。
- `runtime-environment.mjs`：在已定位的用户配置上统一装配 Gateway、App Server 与管理脚本使用的
  `CODEX_CONNECT_HOME`、配置路径、Codex 可执行文件和代理环境；同时保留未合并系统代理的环境，供
  前台监管与 Gateway 服务子进程自行解析，避免自动发现结果变成固定环境覆盖。需要在配置损坏时仍可运行的服务恢复
  命令使用独立的最小控制环境。
- `desktop-app-command.mjs` / `desktop-app-command.d.mts`：实现公开 `codexc desktop-app` 的严格
  参数、只读状态、macOS ChatGPT Bundle 与 Windows 当前用户 `OpenAI.Codex` 包兼容探测、配置
  写入与回滚、App Server 服务重启、Windows 受认证桥就绪探测和单次环境启动；状态不输出桥令牌，两个
  平台均明确标为预览。macOS 启动时改用受管 stdio Proxy，不再依赖桥端口或令牌，并单独报告受管
  入口能力及内置工具 Host 是否已附加；启动前通过主 App Server 的官方已加载 Thread 清单和逐项状态
  读取检查持久及临时会话，并在活动 Turn 或 `codexc remote` 主实例租约存在时拒绝会触发子进程切换的启动；
  Thread 双向共享、签名 Host 隔离、正式受管启动与 App Server 重启恢复已通过 macOS 实机测试。
  Windows 尚未实机验收。
- `desktop-app-proxy.mjs`：只由 macOS Desktop 的 `CODEX_CLI_PATH` 启动；解析并受控传递 Desktop
  内置插件的布尔启用值，把动态工具 Pipe 通过私有 Supervisor 租约交给服务，再把 Desktop JSONL
  stdio 逐条转换为 WebSocket 文本帧并连接现有私有 UDS，
  自身退出时只释放租约和 Proxy，不终止共享 App Server。
- `windows-desktop-app-inspect.ps1`：只读查询当前用户 `OpenAI.Codex` 包、包内 Desktop 可执行文件
  和同路径进程状态，供 `desktop-app-command.mjs` 在 Windows 上失败关闭地判断能否启动。
- `source-update.mjs` / `source-update.d.mts`：比较受管源码与官方 `main` 的提交，在同盘候选目录构建并只读检查当前配置、数据库升级条件和精确 Codex CLI 合同；CLI 不匹配时确认后准备候选并校验，通过后才安装。统一负责停止核心服务、切换源码与全局命令、调用目标版本数据库升级入口、恢复服务并等待就绪；失败保留阶段信息和必要的旧源码备份，数据库升级未完成时不启动服务。无新提交或 npm 安装时同步配套 CLI 并执行必要的数据库升级，不更新 Gateway 包或用户设置。
- `source-install-metadata.mjs` / `source-install-metadata.d.mts`：记录受管源码使用过的 npm 全局
  prefix，并从当前全局包路径识别其所属 prefix，供跨 Node.js 管理器更新和卸载使用。
- `source-uninstall.mjs` / `source-uninstall.d.mts`：校验当前进程、受管源码目录和命令入口归属后，
  先卸载后台服务，再删除 Git 仓库、已记录和当前包所属 npm prefix 中的全局命令及旧 Shell PATH；
  旧版未标记仓库只有在官方 origin、`main`、包名和干净状态均通过校验时才可认领。拒绝符号链接或
  不匹配路径，并保留配置、数据库、凭据、日志和输出。
- `source-shell-path.mjs` / `source-shell-path.d.mts`：只清理旧源码安装写入四类 Shell 配置文件的
  精确 Codex Connect PATH 行或配置块，不修改其他 PATH。
- `local-installation.mjs` / `local-installation.d.mts`：检查 Gateway 配置、数据库和服务安装，提供稳定的数据库升级合同：`inspectDatabaseUpdates` 只读预检并返回 `required`，`applyDatabaseUpdates` 由更新器在停服后通过独立 Node 进程导入目标版本并调用。当前基线返回无需迁移，执行入口仅复核、不写库；未来具体迁移须在执行入口完成备份、事务及目标结构校验，保持入口兼容，供旧更新器调用。不支持的起始 Schema 明确报错，不存在的库由正常启动创建。另提供服务就绪检查，等待 Socket、监管拓扑与 Gateway 健康稳定。
- `state-database.mjs`：只读检查当前状态库和计划任务库的版本与结构，不提供升级或写入入口。
- `metrics-database-access.mjs`：集中实现 `codexc metrics` 与 WebUI 共用的数据库状态、
  `run`、`turns`、`threads`、`report`、`export`、`quota` 和周额度只读查询；通过 Observability
  统一查询服务访问只读 Store，不加载服务控制或数据库维护流程。
  普通只读查询在同一连接上校验 Schema 并读取，诊断入口独立统计总行数。
- `metrics-database.mjs` / `metrics-database.d.mts`：保留 `codexc metrics` 的兼容公开入口和 CLI，
  组合只读访问、输出渲染以及 `reset`、`cleanup`、`prune` 等显式维护命令；查询复用 Observability
  只读端口，`status --json` 返回稳定的路径、Schema、兼容性与记录数，渲染复用
  `metrics-export-format.mjs`；运行、会话与聚合输出从现有 `compact` 明细
  派生上下文压缩模型、请求数与 Token 摘要；删除旧计时与直接 API 分栏后的 JSON 合同使用
  report/export v3、run/turns v2、threads v1；期间查询 JSON 附加范围和筛选条件；JSON/CSV 同时保留可视化字段；
  `export` CSV 用独立类型行区分请求历史额度快照
  与 OpenAI 当前额度估算摘要，避免重复附加全局状态。
  reset 要求 Gateway 停止、检查点回写、`0600` 备份后移除旧库，不迁移或覆盖原指标记录。
  服务状态无法确认、处于非停止状态或前台 Gateway
  指标 Socket 仍可连接时均拒绝 reset。`cleanup` 按 `[metrics.storage]` 或命令行覆盖值创建私有
  备份后清理最旧请求记录，可选 `--vacuum` 立即回收 SQLite 文件空间。
  `prune <provider>` 备份后删除本地指标库中指定提供商（openai、deepseek、`ocg-<账户>` 或当前配置/私有备份中的自定义主 Provider）的全部请求
  行，并自动停止、重启 Gateway；任一步骤失败也会尝试把服务重新拉起，额度重置
  后可用它从零重新统计用量。
- `metrics-command-options.mjs` / `metrics-command-options.d.mts`：集中解析并预检 `codexc metrics` 的
  时间范围、组合筛选、分组、格式及维护命令参数，通过 Observability 的 `query/index` 无状态入口复用规范范围、日期解析与聚合维度，并向顶层帮助
  导出规范用法行；不访问配置、数据库或服务，
  `metrics-database.mjs` 保留原有公开入口与 `metricsRange` 导出。
- `channel-send-image-options.mjs`：集中解析 `codexc channel send-image` 参数，使顶层 CLI 在读取配置前拒绝非法输入。
- `channel-send-image.mjs`：`codexc channel send-image` 的实现，把本地图片复制到
  `data/channel-outbox/pending/` 并写入 manifest；由 Gateway 轮询后按 Thread 绑定
  会话发送并归档，详见 `docs/channel-image.md`。
- `session-cleanup.mjs` / `session-cleanup.d.mts`：实现并声明 `codexc sessions cleanup`，通过
  App Server 枚举多 Provider/Workspace，按主会话真实轮数和整组可查询成员的空闲条件预览；所属 Provider 读取状态，后代参与绑定、活动、固定与 Workspace 检查，确认后每个父会话只发一次官方归档并核验结果。
- `cli-help.mjs`：校验公开命令的精确帮助路径，拒绝未知子命令和多余参数。
- `cli-menu.mjs` / `cli-menu.d.mts`：顶层导航、运行与连接子菜单和服务操作菜单，以及交互操作失败呈现；只分派现有命令，保留进程终止信号语义。
- `cleanup-menu.mjs` / `cleanup-menu.d.mts`：统一清理交互入口，复用会话参数菜单、指标维护菜单和现有执行命令；转储先预览再确认删除，Provider 指标按精确 ID 确认清理，单项完成后返回菜单。
- `session-menu.mjs` / `session-menu.d.mts`：统一清理菜单使用的会话归档参数收集；收集 Turn 上限和空闲天数后调用
  会话清理 CLI，并保留清理命令自身的候选预览与最终确认。
- `metrics-export-format.mjs` / `metrics-export-format.d.mts`：指标导出的 Token、汇总请求数与时间格式化，
  以及 Markdown/CSV 转义；紧凑数字和自适应耗时格式复用 Surface 纯函数导出，JSON/CSV 的毫秒数值不转换。
- `metrics-output-renderer.mjs`：把指标查询结果渲染为 Markdown、JSON 或 CSV；集中处理报告、
  请求明细、Thread、Turn 与当前运行输出，不访问数据库、运行时配置或服务控制。
- `webui-command-options.mjs`：集中解析 `codexc webui` 监听参数，使顶层 CLI 与服务实现复用同一规则。
- `webui-server.mjs` / `webui-api.ts`：`codexc webui` 的 HTTP 服务、共享 API 类型与管理路由组合入口；
  主服务托管静态前端和只读指标 API，并统一执行真实回环连接、精确 Origin、Bearer 鉴权、JSON 请求
  约束、限速、Provider 写事务锁及管理错误响应，再把已验证的请求分派给资源路由；服务进程时区跟随
  `[codex].timezone`，`/api/v1/time` 与页面时间展示随之切换。
- `webui-management-codex-route.mjs` / `webui-management-gateway-route.mjs` /
  `webui-management-provider-route.mjs` / `webui-management-task-route.mjs` /
  `webui-management-status-route.mjs`：分别处理 Codex 设置、Gateway 设置、Provider 与账户、管理任务、
  服务与上游状态资源；复用主服务传入的共享安全状态，不自行建立认证、限速、事务锁或错误出口。
  Provider 与账户路由通过私有 Gateway IPC 刷新账户，不读取 Provider 凭据或直接请求官方接口；状态
  快照按 DS、OCG、CCG 三家注册表补齐账户元数据和未刷新占位；状态路由返回受管服务安全摘要，并按
  5 秒 TTL 复用 App Server 进程级 User-Agent 探测结果。
- `webui-management-settings.mjs`：集中维护 WebUI 可编辑设置白名单、高风险设置分类、输入归一化和脱敏投影，供
  管理路由复用，避免把配置字段规则埋在 HTTP 服务中。
- `webui-traffic-route.mjs`：WebUI 的模型转储读取路由，列出 V2 逻辑调用摘要并提供单条请求与终态
  响应；默认跨批次按请求时间倒序分页，支持单批次筛选，明细按批次与编号定位，指标关联目标缺失时明确报错，不替换目标。
  只接受回环连接，只按已知标签和实际存在的 writer session 读取用户数据目录，不接受任意
  路径；正文超过上限时返回截断标记，独立 trace 按总字节与记录数分页。旧版逐帧 JSONL 不自动混读。
- `webui-management-providers.mjs`：将 Provider 管理状态裁剪为 WebUI 可展示的安全摘要；不读取或返回凭据正文。
- `webui-provider-settings-management.mjs`：复用主 Provider、受管 Provider 默认值与模型窗口、自定义 Provider 管理接口，为 WebUI 提供统一的资源投影、输入归一化、预览、确认后写入和结果脱敏；不读取或返回凭据正文。
- `webui-account-settings-management.mjs`：复用 OpenCode Go 账户 provisioning/management 和 DeepSeek 多账户管理接口，为 WebUI 提供账户资源投影、移除与配置预览、确认后写入和结果脱敏；不返回凭据正文。
- `webui-management-task-resource.mjs` / `webui-service-status.mjs`：管理任务资源快照、服务状态缓存和版本映射；任务预览与
  设置摘要共用同一服务状态查询，不重复启动平台服务管理器。
- `webui-management-operations.mjs` / `webui-http.mjs`：集中管理设置校验、管理错误、高风险路径分类、Provider 状态缓存，以及
  WebUI HTTP 响应、JSON 请求体、令牌鉴权和回环地址校验；主服务组合共享访问与错误边界并完成分派，
  具体资源处理留在对应管理路由。
- `webui-management-tasks.mjs` / `webui-management-tasks.d.mts`：白名单服务、指标维护和源码更新异步任务；
  只接受固定动作，任务由独立 `codexc` 子进程执行，状态按已验证的 WebUI 令牌或回环 Origin 隔离，输出不回传且支持取消。
  默认回环监听并托管 `webui/dist` 静态前端；提供 `/api/v1/time`（服务端时区与当前时间）、
  `/api/v1/overview`、`/api/v1/daily`、`/api/v1/threads`、
  `/api/v1/threads/:id/run|turns`、`/api/v1/requests`、`/api/v1/errors`、`/api/v1/providers` 只读 JSON 接口；
  Providers 返回指标库完整去重名单，指标查询支持重复 `provider` 参数形成多选范围；
  Overview 在同一读快照和截止时间下返回汇总、趋势与热力图；Daily 按 `range` 返回系统本地日聚合。
  Threads 返回指标库首个请求开始时间，
  请求明细按受控字段在整个时间范围排序后偏移分页；
  `webui-api.ts` 声明接口响应类型，前端统一从该文件导入；监听参数优先取命令行，其次
  `config.toml` 的 `[webui]` 段，默认回环无令牌；绑定非回环地址（`0.0.0.0`）时必须设置
  配置 `token`，API 以 `Authorization: Bearer` 校验并采用常数时间比较；令牌不通过命令行传入。
- `metrics-config-menu.mjs`：本地指标存储设置的交互用例；集中管理保留天数和最大记录数，
  返回统一 `activationResult` 及自动激活状态
  （`pending`/`applied`），`config.mjs` 只保留顶层配置菜单编排。
- `metrics-menu.mjs` / `metrics-menu.d.mts`：`codexc metrics` 无参数时的交互用例及注入边界声明；负责循环收集查询与导出参数，包括会话列表和历史额度窗口；独立维护参数函数只由统一清理菜单使用，
  通过 CLI 注入的命令边界执行，不承载子进程或输出文件管理。
- `setup.mjs`：使用 `@clack/prompts` 提供接入类别菜单和脱敏总览，并把“模型与提供商”“通讯渠道”
  和“项目技能”流程委派给具体适配器；模型与提供商下分 OpenAI 官方
  登录/恢复与第三方 Provider 两级，子模块返回时停留在所属层级；配置写入后的激活结果由
  `config-activation-result.mjs` 提供统一状态和目标定义。公开 CLI 的 `codexc setup --json` 将交互提示
  写入终端 stderr，并按每行一个事件把脱敏结果或错误写入 stdout；输入或提示输出不连接终端时明确拒绝，操作失败后可继续选择。默认 `codexc setup` 保持纯交互文本输出。
- `setup-summary.mjs` / `setup-summary.d.mts`：复用统一 Provider 管理状态读取 Codex 全局默认模型与思考等级，先返回
  不依赖终端输出的结构化脱敏总览，再由 CLI 包装器渲染；汇总主 Provider、可切换 Provider、第三方模型默认值、
  原生子代理、已启用渠道和用户技能数量，不显示 API Key、Token、应用凭据、
  允许名单、代理值或 Provider URL。
- `custom-primary-provider-setup.mjs` / `custom-primary-provider-setup.d.mts`：`codexc setup` 的“模型与提供商 → 第三方 Provider”下 Codex 兼容与自定义 Responses Provider 共用设置流程；
  新增时可从 URL 主机名派生 Provider ID、输入自定义标识符或选择推荐的 `OpenAI`，编辑时保留所选候选 ID；引导填写
  上游 `base_url`、直接写入的 API Key、固定/切换模式、WebSocket 开关和上游模型 ID。Codex 兼容入口从官方目录校验，服务启动时导出官方快照；自定义 Responses 入口
  收集逐模型能力并生成独立目录。两者均不调用第三方 `/models`。
  `OpenAI` 选项固定写入同名 `name` 以允许 Codex 使用远程压缩，上游仍须兼容对应接口。新增默认推荐
  切换模式，编辑保持原模式；确认预览明确显示配置位置、API Key 明文存储、默认思考等级和服务层级。固定模式通过 Codex
  `config/batchWrite` 原子写入并激活 `~/.codex/config.toml` 的自定义主 Provider；切换模式保持主
  Provider 为 `openai` 且不修改主配置，为每个 Provider 写入包含完整 Provider 块、Key、模型、
  官方目录的 `medium` 或自定义目录声明的思考等级和服务层级的 0600 `~/.codex/sf-custom-<Provider ID>.config.toml`，
  并通过私有显式注册表支持多个隔离实例。Gateway 管理的 DeepSeek、OpenCode Go 与自定义
  Provider 固定使用 `request_max_retries = 1`、`stream_max_retries = 0`，即首次 HTTP 请求失败后
  最多再试一次，流中断不自动重连，避免 Codex 默认 HTTP 重试与流重连相乘；已有配置也由 App Server
  服务启动参数施加同一边界。自定义固定模式不能保留其他自定义切换 Profile；转为固定
  模式前用户须先删除其他自定义切换 Provider。受管切换 Provider 可共存；受管固定模式必须先恢复
  官方模式，写入响应丢失时只读确认固定配置事务。只支持
  `experimental_bearer_token` 直接写入 API Key（明文入 0600 config）。远程上游强制 HTTPS，HTTP 仅允许本机回环地址。同一 URL Origin 编辑时留空
  保留原 Key，Origin 变化时强制重新输入且写入前不复用旧 Key；新增拒绝覆盖 config 或私有备份中的已有 Provider ID。
  无效旧 URL 按不可复用 Key 处理，允许输入新 URL 与新 Key 修复。保留其他候选块，只移除与自定义
  主 Provider 冲突的顶层 `openai_base_url`。
- `responses-model-templates.mjs` / `responses-model-templates.d.mts`：读取官方 Codex、DeepSeek 模板，交互勾选并映射平台模型 ID；两类均复制基础模型能力并独立保留最大上下文，不导入工具元数据。DeepSeek 另保留 `model_messages.instructions_template` 提示词；官方 Codex 模板不导入源指令。
- `responses-websocket-probe.mjs` / `responses-websocket-probe.d.mts`：按锁定 Codex 协议探测第三方 Responses WS 握手、预热及可选文字请求；复用代理，限制超时与响应大小，取消时释放连接，不保存凭据或原始响应。
- `responses-websocket-setup.mjs` / `responses-websocket-setup.d.mts`：新增、编辑自定义 Provider 时选择自动检测或手动 WS 开关，模型请求须确认可能计费，结果只进入最终保存预览。
- `model-catalog-validation.mjs` / `model-catalog-validation.d.mts`：RS 与 CCG 共用的保存前 Codex 模型目录合同校验，使用隔离临时目录，限制运行时间并清理临时文件。
- `responses-model-setup.mjs` / `responses-model-setup.d.mts`：交互收集自定义 Responses 模型列表与能力。
- `responses-provider-recovery.mjs` / `responses-provider-recovery.d.mts`：在共享管理锁内校验当前配置，完成未结束的模型目录保存或回滚目录备份。
- `custom-primary-provider-management.mjs` / `custom-primary-provider-management.d.mts`：提供自定义主
  Provider 新增与编辑的无终端校验、脱敏预览和执行接口；用 `preserve` / `replace` 明确表达 Key
  操作，现有 Key 只在内部计划闭包中用于同 Origin 保留，不进入预览或执行结果。固定模式复用 Codex
  配置事务与 Profile 回滚，切换模式在写入前复核 Codex 配置版本、私有注册表和 Profile 快照，再在
  同一文件锁内原子写入私有 Profile，并统一返回生效动作和备份清理警告；CLI
  继续负责字段询问、危险修改确认和中文渲染。
- `model-provider-management.mjs` / `model-provider-management.d.mts`：统一返回 OpenAI 默认值、当前主
  Provider、受管 Provider（含 OpenCode Go 账户）、自定义固定/切换/备份候选和受管模型目录的
  脱敏管理状态；移除 API Key、私有 Profile 内容和子进程环境，并供 Setup 总览与主
  Provider CLI 列表共同复用；同时按 `CODEX_HOME/auth.json` 是否存在返回 OpenAI 官方登录状态，
  未检测到鉴权文件时按未登录处理。
- `model-provider-management-transaction.mjs` / `model-provider-management-transaction.d.mts`：统一
  串行 DeepSeek、OpenCode Go、自定义主 Provider 与默认模型设置的跨文件管理
  事务；同一异步调用链中的嵌套操作复用事务，避免 Provider 设置与账户删除交叉提交。
- `primary-provider-management.mjs` / `primary-provider-management.d.mts`：提供自定义主 Provider
  切换与删除的无终端预览和执行接口；预览仅返回脱敏目标、影响与生效动作，执行校验显式模型属于 App Server 官方目录、保持配置/Profile/私有备份事务顺序，
  并以稳定错误码和结构化警告报告失败或备份清理部分成功。
- `primary-provider-config-transaction.mjs` / `primary-provider-config-transaction.d.mts`：统一自定义
  Provider 固定模式写入事务；切换与新增/编辑共同复用 Profile 移除、Codex 配置版本写入、响应丢失
  只读确认和安全回滚，避免两条管理链路复制高风险事务逻辑。
- `primary-provider-cli.mjs` / `primary-provider-cli.d.mts`：`codexc primary-provider` 的
  list / add / switch / remove / recover 子命令；`list --json` 复用统一 Provider 管理状态并返回不含凭据的稳定主实例与候选摘要；
  switch / remove 复用 Provider 管理接口并负责中文确认与结果渲染；所有 switch（含恢复官方、从备份恢复、
  切换 Provider 转固定）都会先经二次确认，并提示将改写主配置的 model_provider / model；命令行 switch
  传 --yes 跳过确认（仅命令行，Setup 菜单仍确认）；
  add 复用共用 Provider Setup，`--custom-models` 选择自定义目录；recover 明确选择保留或回滚未完成目录，
  Setup 菜单另提供候选选择编辑；`switch openai` 不运行登录直接恢复官方
  并把固定候选移入私有备份、保留切换 Provider，`switch <ID>` 把目标设为固定主 Provider；目标是切换
  Provider 时会移除其独立 Profile，已清理候选则从备份自动恢复并消费该备份项；Setup 可直接
  编辑备份候选并恢复、修改和激活，也可经二次确认删除备份候选。恢复、编辑或删除时先提交配置，
  成功后才消费同名备份；配置写入失败时保留原备份，配置已提交但清理失败时显示部分成功警告。备份
  不可安全读取时只允许编辑当前 config 候选，切换和删除失败关闭；注册表仍登记但 Profile 已缺失的
  切换 Provider 可由精确 `remove` 命令清理。删除切换 Provider 时同时清理同 ID 私有备份；Profile
  或注册项已经删除但备份无法安全清理时显示部分成功，不恢复已删除的切换配置。从第三方切回官方时清除第三方顶层模型，已在官方
  模式时保留官方模型。
- `primary-provider-usage.mjs`：`codexc primary-provider` 的规范帮助文案，供脚本与入口帮助共用，
  避免两份文案漂移。
- `official-login-setup.mjs` / `official-login-setup.d.mts`：`codexc setup` 的“模型与提供商 → OpenAI 官方 → 登录并恢复官方”；运行
  `codex login --device-auth` 完成官方登录（打开终端显示的链接并输入验证码），并通过
  `config/batchWrite` 把 `model_provider` 写回 `openai`，候选块移入私有备份并从 config 清理，
  之后可用 `primary-provider switch` 从备份恢复；同时移除冲突的顶层 `openai_base_url`，从第三方
  模式恢复时清除第三方顶层模型。设备登录完成后在统一 Provider 管理事务内重新读取配置与角色
  占用状态，再按最新配置修订备份并提交，避免登录期间的并发修改被旧快照覆盖。
- `codex-tool-settings.mjs` / `codex-tool-settings.d.mts`：投影电脑、浏览器和已有 MCP 的用户设置与合并配置，定义可编辑字段与校验；插件 MCP 只接受原生策略覆盖，不返回启动配置和凭据。
- `codex-user-settings-management.mjs` / `codex-user-settings-management.d.mts`：统一返回不依赖终端的
  Codex 用户设置快照，并以配置版本保护的 `config/batchWrite` 受控修改默认模型与思考等级、Fast、计划清单工具、TUI 空闲总结，
  一起修改 Sandbox、审批和 Workspace Sandbox 网络权限，或一次原子写入核心默认值；Fast 仅作为
  OpenAI 主配置偏好写入。单独设置页可选择 `live`、`indexed`、`cached` 或 `disabled`，不读取第三方模型目录。
  第三方固定模式不开放官方默认模型、思考等级和 Fast；已有 `default_permissions` 时不混写传统 Sandbox 字段。
- `codex-user-settings-setup.mjs` / `codex-user-settings-setup.d.mts`：`codexc config` 的“Codex 新会话与用户偏好”
  适配器，只负责选择、预览和中文结果；可单独设置计划清单工具、TUI 空闲总结、Plan 思考等级、推理摘要（未配置时默认 `none`）、输出详细程度、
  更新检查和历史保存；第三方 Provider 的模型与凭据继续留在 Provider Setup。
- `codex-defaults-setup.mjs` / `codex-defaults-setup.d.mts`：从官方模型目录选择 Codex 全局默认模型和
  思考等级，写入复用统一用户设置管理接口；不修改登录凭据或 Gateway 的 Thread 默认模型。
- `model-provider-default-management.mjs` / `model-provider-default-management.d.mts`：提供受管 Provider
  默认模型与思考等级的无终端校验、预览与执行接口；写默认模型时保留模型目录中已有的上下文窗口，
  窗口由「模型上下文窗口」按模型名统一管理；切换模式更新私有 Profile，固定模式与切换模式共用统一
  Provider 管理事务；固定模式以用户配置修订为前置条件，响应丢失时先只读确认写入结果，仅在确认未生效
  时恢复模型目录，结果明确返回 App Server 重启动作。
- `model-window-management.mjs` / `model-window-management.d.mts`：提供受管模型上下文窗口的无终端
  校验、预览与执行接口；按模型 slug 去重，同名模型跨 Provider 共享同一窗口占比，写入经
  `writeManagedModelWindowGlobal` 在各 Provider 的 `max_context_window` 一致时换算 `context_window`
  并广播到所有提供该模型的 Provider，并复用统一 Provider 管理事务；
  同名模型在跨 Provider 窗口占比或最大窗口不一致时，预览暴露冲突与被覆盖值，最大窗口不一致失败关闭，
  结果明确返回 App Server 重启动作。
- `model-window-setup.mjs` / `model-window-setup.d.mts`：`codexc setup` 的“模型上下文窗口”入口；
  按模型名选择受管模型并设置窗口占比（10–100%，100% 为模型官方窗口），写入复用
  `model-window-management.mjs` 的全局广播，同名模型在所有 Provider 共用同一值，结果返回 App Server 重启动作。
- `model-provider-default-setup.mjs` / `model-provider-default-setup.d.mts`：负责受管 Provider 默认设置的
  Provider、模型与思考等级交互与中文渲染，写入复用管理接口；第三方 Provider 总菜单会先选择 Provider，DeepSeek 与 OpenCode Go 子菜单则复用同一入口并预选当前 Provider。上下文窗口不在本流程，转到
  `model-window-setup.mjs`；历史 Thread 仍保留创建时的模型。
- `codex-user-config.mjs` / `codex-user-config.d.mts`：统一创建隔离的 stdio App Server Client，把 Codex 官方默认值与
  `multi_agent_v2` 普通键级修改作为官方 `config/batchWrite` 事务写入用户配置；
  用户设置修改在同一 Client 中读取原始用户层及版本，并通过 `expectedVersion` 拒绝并发覆盖。
- `skill-setup.mjs` / `skill-setup.d.mts`：`codexc setup` 的“项目技能”类别；列出项目 `.codex/skills` 下带
  `SKILL.md` 的技能，安装/覆盖到 `~/.agents/skills/<技能名>`（可用
  `CODEX_AGENTS_SKILLS_DIR` 覆盖目标目录），支持卸载；只复制技能目录本身，不修改
  hermes 运行时的 `.skill-lock.json`。
- `config.mjs`：`codexc config` 的顶层交互编排，统一提供 Codex 新会话与用户偏好，以及不显示凭据
  或代理值的 Gateway 配置总览和可安全编辑的参数：显示设置（操作详情、计划更新、默认关闭的思考状态）、系统设置
  （模型请求转储、审批超时、Sandbox、默认工作区、渠道新会话模型覆盖与官方 TUI 身份）、计划任务、网络代理、日志等级与开发中功能、WebUI 设置（监听地址、端口、访问令牌）、指标存储
  （本地保留天数与最大记录数）、
  Telegram 消息格式和配置路径查看；修改通过私有原子写入保存，非交互终端直接输出用户目录与
  配置文件路径；`--json` 不进入菜单或读取配置正文，只输出路径与文件存在状态。
- `config-summary.mjs`：把已经读取的严格配置投影为脱敏总览，只显示配置来源、有效开关、作用范围
  和已配置的代理字段名，不显示渠道凭据、访问令牌或代理值。
- `config-management.mjs` / `config-management.d.mts`：提供不依赖 prompts、TTY 或终端文案的 Gateway
  设置脱敏读取与明确修改接口；只接受受控的显示、系统（含一键官方 TUI 身份与模型上游终端标识）、自动化、网络、
  高级、Telegram 格式、WebUI、指标和 Workspace 权限输入，返回稳定字段错误与精确生效动作，
  凭据和网络读取只显示是否已配置；
  网络操作只更新共享 Codex `.env`，不写入 Gateway TOML；读取返回覆盖两个文件的修订，
  修改必须携带并在应用前复核；其他设置的最终提交复用 Gateway Config 的共享写锁
  和锁内原文比较，避免菜单停留期间覆盖其他进程已保存的配置；`applyTerminalIdentityFromEnvironment`
  在 `[codex].terminal_identity` 未配置且运行命令的终端可探测时按该终端补入，供
  `codexc service install` 与 `codexc update` 复用；`codexc config` 与 WebUI 改用同一探测
  结果预填，由用户确认后写入。
- `config-management-error.mjs`、`config-webui-management.mjs`、`config-metrics-management.mjs`、
  `config-workspace-management.mjs`：保存 Config 管理接口的共享稳定错误，以及 WebUI、指标和 Workspace
  的脱敏投影、输入校验与文档修改语义；CLI 菜单不再直接读写这些配置段。
- `config-advanced-menu.mjs`：管理计划任务、显式 HTTP(S) 代理、日志等级与
  开发中的 Plugin API；日志等级统一通过 `debug-setup.mjs` 写入，代理输入可见但既有值、输出和日志均不回显；HTTP、HTTPS 与通用代理支持一次性原子写入 Codex `.env`，与 WebUI 共用 Config 管理入口。
- `config-display-menu.mjs`：独立管理操作详情、计划更新、默认关闭的渠道思考状态和 Telegram 消息格式；
  CLI 负责选择与渲染，读取、校验和写入复用 Config 管理接口。
- `config-system-menu.mjs`：独立管理模型请求转储及其保留天数、审批超时、Gateway 外部渠道 Sandbox、默认 Workspace、
  Gateway 新 Thread 模型覆盖、一键官方 TUI 身份、模型上游终端标识与模型可见时区；模型请求转储独立写入
  `[debug].model_traffic_dump` / `model_traffic_retention_days` 并要求重启 App Server；终端标识预填运行该命令的终端探测结果并允许
  编辑，留空即删除配置；模型可见时区与网关时区分别复用 `codexc timezone` 与 `codexc timezone --gateway`。
- `timezone-command.mjs`：实现公开 `codexc timezone`，解析 IANA 时区名称与 `--system` / `--json`，
  交互入口只列常见时区，并提供「恢复系统时区」与「其他（手动输入 IANA 名称）」两个动作项，
  在边界校验格式与存在性后通过 Config 管理接口写入 `[codex].timezone`，并提示 App Server、Gateway 与
  WebUI 的重启要求；缺省不写入配置，非交互终端只报告当前值，`codexc config` 的系统设置菜单复用同一实现。
  `--gateway` 管理 `[gateway].timezone`：缺省跟随 App Server，`--system` 选择独立系统时区，
  IANA 名称设置自定义时区，`--follow-app-server` 删除独立设置；修改后提示重启网关。
- `config-webui-menu.mjs`：独立管理 WebUI 监听地址、端口和访问令牌交互；保持公网监听必须配置
  令牌的失败关闭约束，`config.mjs` 只负责把顶层选择路由到该领域菜单。
- `config-workspace-menu.mjs`：管理 `codexc work` 的 Workspace Sandbox、审批策略与 Permission Profile；
  保持 Sandbox 与 Permission Profile 互斥，并只写回被选择的 Workspace 配置。
- `management-access.mjs`、`management-confirmations.mjs`、`management-audit.mjs`、
  `management-security.mjs` / `management-security.d.mts`：本机管理适配器复用的无 HTTP 安全基础，
  覆盖高风险确认、Origin、限速、请求上限、安全响应头和脱敏审计；WebUI 管理路由复用其中的请求约束、
  限速和审计原语，配置了 WebUI 令牌时直接使用 Bearer 令牌认证。
- `debug-setup.mjs`：在严格配置中原子写入 `logging.level`；Config 高级设置选择完整日志等级，不改写显示设置或凭据。
- `ccg-setup.mjs` / `ccg-setup.d.mts`：CCG 多账户配置、`codexc ccg account remove` / `legacy remove` 确认移除入口、默认账户及删除入口；账户隔离 Key/Profile/App Server 并共享目录与统计代理，写入前使用 Codex CLI 校验完整目录，目录思考等级同步账户 Profile，原生角色保留独立设置。
- `provider-model-catalog.mjs` / `provider-model-catalog.d.mts`：以 DS 完整目录生成 OCG/CCG 目录，保留原模型并复制 Flash 增加 V4.1；模型 ID 与显示名来自根目录 `provider-model-catalog.json`。
- `managed-provider-files.mjs` / `managed-provider-files.d.mts`：OCG 与 CCG 共用的私有文件读取、写入、快照、逐文件并发复核和失败回滚。
- `managed-provider-account-runtime.mjs` / `managed-provider-account-runtime.d.mts`：DS、OCG、CCG 共用账户实例检查与释放，删除前检查监管状态和 Remote TUI 租约。
- `deepseek-setup.mjs` / `deepseek-setup.d.mts`：下载并提取 DS 官方目录，保留目录字段和窗口设置；导出账户菜单与目录刷新入口。
- `deepseek-account-management.mjs` / `deepseek-account-management.d.mts`：DS 账户配置、默认账户与删除事务；旧单账户只提供确认后移除入口，保留备份、现有新账户及历史统计，不保留迁移入口。
- `deepseek-account-setup.mjs` / `deepseek-account-setup.d.mts`：DS Setup 菜单与 `codexc deepseek account` 入口，复用管理事务和既有模型设置菜单。
- `deepseek-catalog-baseline.json`：保存人工对照 DeepSeek 官方 Codex 安装脚本审查后的模型完整指纹、
  上下文、输入模态、思考等级、搜索、并行工具和最低客户端版本；`digest` 是模型条目紧凑 JSON 的
  SHA-256。该文件只作为审查留档，运行时开放哪些模型以 Setup 下载的官方目录为准。
- `managed-model-provider-setup.mjs` / `managed-model-provider-setup.d.mts`：复用第三方 Provider 的
  受管模型目录默认值/逐模型设置保留、切换 Profile、固定配置、恢复影响摘要与稳定错误逻辑；OCG 与
  CCG 共用完整模式配置生成，DeepSeek 复用配置原语，账户注册和历史备份格式仍由各自适配层负责。
- `opencode-go-account-files.mjs` / `opencode-go-account-files.d.mts`：集中 OpenCode Go 账户私有文件
  路径与 Profile 文件名；私有文件事务使用 `managed-provider-files.mjs`。
- `opencode-go-account-management.mjs` / `opencode-go-account-management.d.mts`：提供 OpenCode Go
  默认账户切换、运行实例停止与账户删除的无终端预览和执行接口，以及旧单账户与旧注册账户的显式移除事务；默认切换只更新注册表，
  停止明确区分未运行、Remote TUI 占用和已停止，删除在明确确认后保留私有备份并执行多文件回滚；
  删除默认账户前必须先指定其他默认账户；删除最后一个账户会清理共享模型目录，固定模式账户只恢复其管理的主配置字段，保留无关子代理。
- `opencode-go-account-provisioning.mjs` / `opencode-go-account-provisioning.d.mts`：提供 OpenCode Go
  账户新增/重新配置的脱敏预览与无终端执行接口；内部完成目录下载、每个账户进入固定模式时的恢复基线更新与旧基线归档、Key 写入、切换/固定模式配置和多文件事务回滚；同一家可保留一个固定账户与其他切换账户。
  生成模型目录时继承已配置 Provider 的同名模型全局窗口占比，避免新账户回落到 OCG 默认值。
- `opencode-go-setup.mjs` / `opencode-go-setup.d.mts`：OpenCode Go 多账户管理
  （add/list/remove/default/stop，供 `codexc opencode-go account` 调用）与 Setup 菜单；`legacy remove` 移除旧单账户，旧注册账户复用 `account remove`；`list --json`
  返回不含 Key 与 Profile 路径的稳定账户摘要；新增/重新配置复用账户 provisioning 接口，默认切换、停止和删除复用账户管理接口；配置切换/固定模式
  或通过脱敏预览、明确确认与无终端执行接口恢复首次配置前状态，从同一受审查来源
  生成共享模型目录；恢复只接受字段完整的当前备份状态，重复配置时保留仍受支持的
  默认模型与逐模型设置。
- `terminal-prompter.mjs`：为各通讯渠道 Setup 提供最小的终端文本、确认和可见凭据输入接口，并允许
  长流程通过 `AbortSignal` 中止尚未完成的问题。
- `telegram-setup.mjs`：把 Telegram Bot 来源、长轮询冲突确认、允许名单输入和中文输出适配到
  `telegram-setup-session.mjs` 的结构化会话；复用统一 Codex `.env`、环境变量和系统代理解析；交互输入的
  Token 在当前终端明文显示，但验证错误继续脱敏；新建 Bot 仅引导使用官方 BotFather。
- `telegram-setup-session.mjs` / `telegram-setup-session.d.mts`：提供所有者绑定的 Telegram Setup
  开始、状态、自动配对、允许名单预览、确认与取消接口；Bot Token 和一次性配对码只保存在有期限的
  进程内会话中，状态、预览和结果不返回 Token，取消和超时通过 grammY `AbortSignal` 中止验证或
  长轮询，确认时检查 Telegram 配置未被并发改动后再原子写入。
- `feishu-setup.mjs`：把手动凭据输入、Device Authorization 二维码、允许名单确认和中文输出适配到
  `feishu-setup-session.mjs` 的结构化会话；扫码时由飞书授权页选择新建或已有企业自建应用，只申请
  私聊接收与发送、流式卡片、应用自管理检测、受控配置写入和命令中心所需权限、事件与回调。
- `feishu-setup-session.mjs` / `feishu-setup-session.d.mts`：提供所有者绑定的飞书 Setup 开始、状态、
  脱敏预览、确认与取消接口；手动与扫码两种方式都验证凭据和 Bot 身份，扫码授权、Bot 验证与终端
  等待共用整体期限及真实 `AbortSignal`。App Secret 与短期授权只由进程内会话持有，确认时检查飞书
  配置未被并发改动后再原子保存；扫码模式只保存本次扫码用户，并在保存后保留已有菜单、自动发布
  `codexc_home` 悬浮菜单、长连接事件与卡片回调。远程配置失败时保留已保存的连接配置，并返回脱敏
  警告供终端提示通过 `codexc doctor` 和重新扫码恢复。
- `weixin-setup.mjs`：从统一 Setup 菜单执行连接替换风险确认、微信扫码和严格结果裁剪，把
  终端输入输出适配到 `weixin-setup-session.mjs` 的结构化会话，把 Bot Token 原子写入微信独立安全凭据后端，
  最终确认后向 TOML 写入启用态账号与允许用户元数据；
  Setup 不直接启动消息 Surface，由 Gateway 配置变更处理或下次启动生效。
- `weixin-setup-session.mjs` / `weixin-setup-session.d.mts`：提供所有者绑定的微信 Setup 开始、状态、
  配对码提交、确认与取消接口；二维码和凭据只保存在有期限的进程内会话中，状态与保存预览不返回
  Bot Token，取消和超时会中止底层请求并丢弃临时状态，确认时检查微信配置未被并发改动后复用原子
  凭据/配置回滚事务；写入异常时同时核对原子替换的文件身份和目标配置，不能用旧配置值相同判定提交成功。
- `feishu-application.mjs`：为 Setup 与 Doctor 提供带有限超时的飞书凭据/Bot 身份、应用权限、
  消息事件和待审核版本只读探测，不建立消息长连接，并把 SDK 错误和残缺响应收敛为不含敏感详情的
  稳定错误。
- `workspace-command.mjs`：实现 `codexc work` 的参数校验、交互菜单、目录创建与已有目录注册，并调用统一的 Workspace 权限设置用例；
  `list --json` 返回稳定的 Workspace 注册摘要；CLI 入口只负责分发。
- `workspace-config.mjs`：读取、检查和原子更新 TOML 中的 Workspace 配置，通过 `runtime/config-event-queue.mjs` 保证 Gateway 重启窗口内的 Workspace 新增通知可恢复；支持列出失效项、删除注册记录，并恢复固定默认 Workspace。

## 开发与协议

- `dev-all.mjs`：开发模式下复用完整的现有 App Server 拓扑，或通过唯一的内部
  `service-app-server` 入口立即启动主 App Server；已配置的隔离 Provider App Server
  在首次选择模型、恢复 Thread 或使用对应 Remote TUI 时由监管入口按需启动。统计代理也按 Provider
  使用情况启动；原生子代理复用父线程实例与代理；
  随后再启动 Gateway。只复用私有监管身份、Provider 拓扑和真实 WebSocket 健康检查一致的实例，
  Gateway 进程再通过与 Provider 无关的配置级所有权 Socket 拒绝所有入口的重复实例。部分拓扑或裸
  App Server 失败关闭；脚本统一收敛自身启动错误，已经由内部服务入口展示的失败不重复包装。
- `codex-remote-options.mjs` / `codex-remote-options.d.mts`：在读取 Gateway 配置前解析
  `codexc remote` 自有的 Workspace 与受管 Provider Profile 参数；受管 Provider 只使用与磁盘文件及
  原生 Codex 一致的 `sf-*` 规范名称，旧的无前缀名称只返回明确替换提示，并尊重 `--` 后原样传给 Codex 的参数边界。
  无显式 Profile 且官方未登录时解析唯一第三方 Profile；候选全部为同一家 DS、OCG 或 CCG 账户时使用注册表默认账户，
  其他多个候选要求明确选择，不修改主配置。
- `codex-remote.mjs`：为原生 `codex --remote` 选择 Provider Socket 和工作目录；切换模式下识别
  与原生 Codex 及磁盘文件相同的 `sf-*` Provider Profile 名称，选择对应隔离实例并供 Remote TUI
  完成第三方 Provider 认证；同时按当前目录或显式
  `--workspace` 解析有效 Sandbox、审批策略与 Permission Profile，第三方 Profile 不复制权限，
  用户显式传给 Codex 的权限参数优先，未受管的个人 Profile 也沿用匹配的 Workspace 权限；
  Workspace 的 `untrusted` 保留给 App Server Thread，但在没有显式审批覆盖时拒绝映射为固定版 CLI
  已退役的公开参数，不静默改成更宽松策略；
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
- `run-upgrade-validation.mjs`：为正式升级提案独立运行协议、类型、Lint、测试、
  真实合同、Gateway/WebUI 构建和打包检查；单项失败后继续其他阶段，并保存逐项日志和结构化结果。预览阶段不
  改稳定版文档，因此明确跳过文档索引检查；测试与真实合同复用一次成功的 Gateway 构建，tarball 安装复用 Gateway/WebUI 产物，前置构建失败时跳过依赖检查并保留失败结果，干净源码安装独立执行。
- `write-upgrade-report.mjs`：把 CI 中生成的升级工作树写成 Markdown 摘要、文件清单、统计和
  二进制安全 Patch，并分别比较 `HEAD` 生成协议的 RPC/顶层字段结构和受控公开 CLI 合同，合并
  逐阶段结果；生成或验证失败且没有差异时仍会输出报告。
- `check-pr-description.mjs`：所有 Ready PR 至少在新增、修复、改动之一说明具体变化，无内容分类可省略，保留章节不得为空或仅有占位；正式升级 PR 还要把自动占位内容替换为本项目的收益、采用项、不采用项及风险与验证。
  Draft PR 暂时跳过，转为 Ready 时由同一门禁重新检查。
- `protocol-schema.mjs`：在同一文件系统按指定稳定/实验模式临时生成、逐文件比较并安全替换协议类型目录。
- `generate-protocol.mjs`：先在临时目录调用当前 Codex CLI 的 `generate-ts --experimental`，
  成功后替换协议类型、记录版本与实验状态并同步 npm/Gateway 版本；实验生成只服务于受控 Plan 边界。
- `check-protocol.mjs`：校验本机 Codex CLI 版本，并按记录的实验状态重新生成到临时目录确认类型逐文件一致。
- `weixin-qr-contract-probe.mjs`：隔离二维码合同探针；默认离线显示帮助，只有显式
  `qr --live` 并再次确认连接替换风险后才访问固定微信端点，严格裁剪状态、限制官方重定向域名
  并有限取消；不注册 Surface、不写配置或凭据，也不属于公开 `codexc` 命令。
- `weixin-updates-contract-probe.mjs`：从已验证的微信安全凭据执行一次显式 `once --live`
  `getupdates` 长轮询，只报告消息数量、字段形状、项目类型、上下文令牌存在性和
  `message_id` 精度；`sequence --live` 只在内存把首轮游标传给第二轮并比较重放数量和游标推进；
  `replay --live` 再次复用首轮游标，判断第二批消息是否重放及返回游标是否一致；
  不输出或保存正文、完整身份、Token、上下文令牌和游标。
- `weixin-send-contract-probe.mjs`：显式 `reply --live` 后从一条已授权完成态微信文本中仅在
  内存取得回复目标和 `context_token`，按固定 `v2.4.6` 合同发送一条短文本；不接受命令行
  Token、用户 ID 或正文；`sequence --live` 使用同一上下文连续发送两条固定短文本，第二条
  包含 Unicode、emoji 和 Markdown 符号；不输出或保存消息、游标、回复上下文、`client_id`
  或完整身份，首条发送失败时不继续；`limit --live` 只发送一条固定 4000 字符中文消息，
  验证官方宿主分片值而不探测未知最大上限；`echo --live` 发送固定回复后再轮询一次，只检查
  服务端消息 ID 与 `client_id` 形状，不把回送内容写入日志或 Fixture；`reject --live` 仅在
  内存把上下文令牌改成同长度无效值后调用一次发送接口，预期返回 `ret: -2`，不应产生可见消息。
- `weixin-typing-contract-probe.mjs`：显式 `lifecycle --live` 后从一条已授权完成态微信文本中
  仅在内存取得回复目标和 `context_token`，按固定 `v2.4.6` 合同调用 `getconfig` 获取临时
  `typing_ticket`，再执行开始、5 秒续期和取消输入状态；不输出或保存消息、游标、回复上下文、
  票据、Token 或完整身份，不注册常驻 Surface。
- `weixin-image-contract-probe.mjs`：显式 `download --live` 后从一条已授权完成态微信图片中
  仅在内存取得固定 `v2.4.6` CDN 下载参数，限定官方 CDN、响应正文和 10 MiB 明文上限，
  按消息提供的 key 执行 AES-128-ECB 解密并验证 PNG/JPEG 签名；不输出或保存图片、下载地址、
  查询参数、key、Token、游标或完整身份，不注册常驻 Surface。
- `weixin-file-contract-probe.mjs`：显式 `download --live` 后从一条已授权完成态微信文件中
  仅在内存取得固定 `v2.4.6` CDN 下载参数，限定官方 CDN，并以 20 MiB 作为本探针的明文内存
  安全上限；按消息提供的 key 执行 AES-128-ECB 解密，只报告大小、声明长度和 MD5 是否匹配、
  文件名形状及由扩展名推断的 MIME，不输出或保存文件名、文件正文、MD5、下载地址、查询参数、
  key、Token、游标或完整身份，不注册常驻 Surface。
- `weixin-image-send-contract-probe.mjs`：显式 `send --live` 或 `file --live` 后从一条已授权
  完成态微信文本中仅在内存取得回复上下文；前者生成固定 PNG，后者生成固定 UTF-8 文本文件，
  均按固定 `v2.4.6` 合同申请官方 CDN 上传地址、AES-128-ECB 加密并以二进制 `POST` 上传，
  再发送单张图片或单个一般文件消息；上传缺少下载参数时有限重试，4xx 立即失败；不输出或保存
  媒体正文、上传地址、参数、key、Token、游标或完整身份，不注册常驻 Surface。
- `check-gateway-version.mjs`：校验 npm 包与 Gateway 运行时版本一致，并要求正式版本、`-rc.N`
  候选版或 `-fixN` 修复版使用与 Codex CLI 协议相同的基础版本。
- `check-runtime-boundaries.mjs`：校验 `runtime <- scripts <- bin` 的目录依赖方向，并要求三者访问已编译
  `src` 能力时只使用按调用方列明的精确入口；该检查由 `npm run check` 执行。
- `check-docs.mjs`：校验项目 Markdown 本地链接、根 `index.md` 文档索引、源码模块索引、协议数字和相关目录
  文件索引，并拒绝已移除的文档名称；常规项目文档检查排除 `.codex/skills/**` 附带的技能参考资料。
- `install-git-hooks.mjs`：只为当前源码仓库设置 `.githooks`，不修改用户全局 Git 配置。
- `verify-commit.mjs`：为 pre-commit hook 与 GitHub CI 串行执行统一的完整提交检查，并输出每个
  阶段及全部检查的累计耗时；完整测试已经成功构建 Gateway 后，日常门禁只复用该产物执行 tarball
  安装冒烟。干净源码安装保留在独立 `npm run test:package`、正式发布和升级验证中。
- `validate-config.mjs`：在安装系统服务前使用已构建的 Gateway 配置模块执行完整校验。
- `traffic-command-options.mjs` / `traffic-command-options.d.mts`：集中解析并预检 `codexc traffic` 的
  转储目录、逻辑调用编号、正文长度、关键字、跟随与清理参数，使顶层 CLI 在读取配置前拒绝非法输入，
  并向顶层帮助导出规范用法行。
- `traffic-cleanup.mjs` / `traffic-cleanup.d.mts`：实现并声明 `codexc traffic cleanup`；默认只预览
  已识别的 V2 session 与旧版逐帧 JSONL，确认全部 App Server 已停止后才按 `--confirm` 永久删除，
  未识别文件与目录保持不变。
- `traffic-command.mjs`：`codexc traffic` 的实现，把 V2 逻辑调用索引与正文引用渲染成人可读文本；
  每个编号固定展示一条请求和一个终态响应，支持编号、关键字、正文上限与持续跟随；不修改转储文件。
- `traffic-dump-reader.mjs`：V2 转储共享读取实现，严格读取 `manifest.json`、`interactions.jsonl` 与
  payload 引用，按批次和逻辑调用编号配对产出摘要和详情；`codexc traffic` 与 WebUI 共用。WebUI 摘要
  分页用有界堆只保留当前页之前的候选，并限制 offset 上限；单条详情只保留目标调用。正文和独立 trace
  均有界读取；`describeDumpTrace` 为 WebUI 事件翻页单独读取轨迹，不重读正文或聚合输出；`describeDumpTurnStates` 按精确批次与编号独立读取字符数，不阻塞列表摘要接口。旧版逐帧 JSONL 明确报错，不隐式迁移或混读。
- `traffic-dump-presentation.mjs`：从已有 V2 正文投影每次调用的元数据、参数、用量和错误，从响应索引投影失败阶段；从终态或
  独立 trace 提取有界的完成输出，重组 WebSocket 分片与 SSE 事件；投影请求输入、声明工具与参数对照，并分开提取本次调用的服务端模型声明和安全缓冲候选及来源；仅从同次调用的单调时钟节点计算阶段，不与上游轮次或旧墙钟相减，不回写转储。

## 构建、打包与服务

- 根目录 `install.sh`：在 Linux/macOS 上克隆 Codex Connect 官方 `main`，把完整 Git 仓库安装
  到 `~/.codex-connect/codex-channels`，检测 npm 与 Codex CLI，缺少 Codex CLI 时安装项目精确版本，
  并检查登录状态；随后完成依赖、Gateway/WebUI 构建和 npm 全局命令注册。不覆盖现有源码目录、
  配置或数据，也不写入 Shell PATH。
- `clean-dist.mjs`：构建前清理 `dist/`。
- `install-global-source.mjs`：显式准备干净源码、自动执行 webui 子项目依赖安装与前端构建
  （`webui/dist`），再生成临时 npm tarball 并通过禁用隐式生命周期脚本的 npm 全局安装；安装结果
  不链接或依赖源码目录，并避免 npm 12 脚本策略跳过构建；源码更新可用内部 `--prepared` 复用已
  验证的 Gateway/WebUI 构建结果，避免重复构建。
- `webui-dev.mjs`：仓库根目录 `npm run webui:dev` 的一键开发入口，并行启动
  `codexc webui`（API）与 Vite dev server，任一子进程退出时统一清理另一个进程。
- `package-path.mjs`：提供不依赖第三方包的 npm 包根目录解析。
- `prepare-package.mjs`：源码仓库安装或 npm 打包前按 lockfile 补齐缺失的本地构建依赖、
  启用仓库 Git hooks、构建源码，并验证已安装包包含运行入口。
- `smoke-source-prepare.mjs`：在不含 `node_modules` 和 `dist` 的临时源码副本中验证显式源码
  全局安装命令会完成构建、保留模型目录与启动网络策略资源并生成 `codexc` 入口；失败时保留 stdout 与 stderr。
- `smoke-package.mjs`：生成实际 tarball，在隔离目录安装，验证 WebUI 前端产物，并执行公开的
  `codexc` 入口与配置预检，并加载安装后的 Setup 模块，检查其传递依赖是否完整打包。安装目录和依赖树每次重建，下载缓存沿用 npm 配置，避免重复下载；干净源码安装仍使用独立缓存。
- `sync-gateway-version.mjs`：升级 Codex CLI 协议时把 `package.json`、锁文件和 Gateway 运行时
  版本重置为新的正式基础版本；Gateway 候选发行和修复发行可分别在该基础版本后使用受控的
  `-rc.N` 或 `-fixN` 后缀。任一后缀 Tag 发布并核验后，`main` 必须通过独立 PR 恢复无后缀基础
  版本以兼容旧版源码更新器；历史发布记录由对应 Release 保留，当前安装入口统一使用源码。
- `doctor-output.mjs` / `doctor-output.d.mts`：把已收集的诊断项转换为结构化报告并渲染终端文本，不执行环境探测。
- `doctor.mjs`：检查 npm 包、Node、Linux PATH 中的 `bubblewrap`、Codex CLI、当前 TOML 配置、
  OpenAI 主提供商使用的配置、环境变量或系统代理路由（不显示代理地址或凭据）、
  Workspace、飞书凭据/Bot 身份、
  微信配置与 Bot 凭据、消息游标检查点、允许用户的加密回复上下文覆盖数和最近保存时间，
  以及微信运行时启用状态；缺少 `bubblewrap` 时说明内置 helper 回退并输出发行版安装命令，
  完成全部检测后按诊断领域只输出失败、提示和处理建议，交互终端区分颜色并汇总各状态数量；
  Doctor 不自动安装或修改 AppArmor，不调用
  `getupdates`，不显示 Token、`context_token` 或游标；
  主 Unix WebSocket、已配置 Provider 的切换或固定配置、实际模型目录、Provider Socket、
  监管身份与 Provider 拓扑、`initialize.userAgent` 中的运行中 App Server 版本与系统服务状态，
  `--json` 输出完整脱敏检查数组、分类计数与健康状态；不输出完整 User-Agent、飞书
  上游响应或敏感配置内容。
- `service-install-context.mjs` / `service-install-context.d.mts`：systemd 与 launchd 安装器共用的配置、
  默认 Workspace、主 Socket、Codex/Node 可执行文件及服务 PATH 解析；读取计划不修改磁盘，执行时才把
  运行目录创建为 `0700`。
- `service-install-management.mjs` / `service-install-management.d.mts`：把服务安装拆成配置校验、平台
  预检、定义原子写入、核心服务激活和就绪确认五个结构化阶段；返回不含配置凭据的修订计划、进度、
  完成阶段、稳定恢复动作和最终结果。Linux systemd 与 macOS launchd 共用任务契约，但继续由各自
  控制脚本实现 linger、旧 Job 检测及服务管理，不解析 Shell 文案推断结果；Windows 明确失败关闭。
- `service-command.mjs`：实现公开 `service` 子命令和隐藏的 Gateway/App Server 服务入口装配；集中解析
  服务目标与日志参数、选择三平台控制器、限制 App Server 内的自中断操作，并在启动后复用统一就绪
  检查。CLI 只保留帮助展示和命令分派。
- `config-activation-result.mjs` / `config-activation-result.d.mts`：把配置写入器的内部激活范围转换为
  稳定的状态、目标和可执行命令列表，供 Config、Setup 与自动化复用；Codex 用户偏好使用
  `next-thread / codex`、`next-tui / codex` 和 `next-thread-and-tui / codex` 分别表示新 Thread、
  新启动 TUI 或两类生命周期读取，Workspace 权限使用 `reload / gateway`，
  App Server 重启动作使用 `restart / app-server`，App Server 时区使用
  `restart / app-server-gateway-webui` 并列出三个服务的重启命令；本模块不承载服务控制。
- `config-activation-notice.mjs` / `config-activation-notice.d.mts`：统一配置写入后的生效提示，区分新会话读取、
  Gateway 自动重新读取、需要重建 Gateway 或 App Server，以及需要通过 `codexc service install`
  重新生成服务环境的变化；WebUI 的专属重启要求继续单独提示。
- `launchd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载三个当前 launchd 服务；启停、
  重启、状态和日志支持 `gateway`、`app-server`、`webui`、`all` 目标，
  WebUI 独立不并入 `all`，
  日常重启默认只更新 Gateway；模板为 App Server 与 Gateway 注入各自服务角色，公开 CLI 据此
  拒绝 App Server 内的自重启；
  检测到不支持的旧标签时明确拒绝启动。
- `service-target-query.mjs`：把共享服务目录中的 systemd unit 或 launchd label 逐行提供给平台
  控制脚本，避免 Shell 维护第二份服务标识。
- `service-status.mjs` / `service-status.d.mts`：通过 systemd 属性、launchd Job 字段或 Windows 计划任务
  生成统一基础 JSON 服务状态；Windows 额外核对受管进程和核心 RPC 端点。目标异常时保留可解析输出
  并返回非零状态，查询器故障则失败关闭。
- `cli-status.mjs`：让 systemd/launchd 控制脚本复用公开 CLI 的成功、失败、提示和处理状态前缀、
  TTY 颜色及 `NO_COLOR` 规则；日志和数据内容不经过状态渲染。
- `systemd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载三个当前 systemd 用户服务；
  安装前确保当前用户的 linger 已启用并复查，使用户未登录时也能随系统启动，无法启用则在修改
  unit 状态前失败并显示管理员处理命令；与 launchd 使用相同的目标、服务角色和默认值，WebUI
  独立不并入 `all`；停止不存在的 Unit 与 launchd 一样按已停止处理，用户数据始终保留。
- `windows-service-control.mjs` / `windows-service-control.d.mts`：读取用户级 Windows 服务定义，
  通过计划任务控制脚本执行 App Server、Gateway 和 WebUI 的安装、启停、重启、状态、日志
  与卸载；
  核心服务状态同时检查监管进程存活、RPC 可达性及服务定义完整性。
- `windows-service-host.mjs`：计划任务启动的 Windows 服务宿主，按 JSON 定义启动并监管单个
  Node 服务进程，转发控制请求并把标准输出、错误输出写入用户级运行日志。
- `windows-service-launcher.ps1`：Windows 计划任务调用的 PowerShell 启动器，设置受控环境后
  转交服务宿主，不依赖当前终端目录或用户 Shell 配置。
- `windows-scheduled-task.ps1`：创建、启动、查询和删除当前用户计划任务；任务通过
  `wscript.exe` 以隐藏窗口运行对应 VBS 启动器，避免服务进程占用可见终端窗口。
- `windows-log-follow.ps1`：按服务目标跟随读取用户级运行日志，供 `codexc service logs` 使用。
- `windows-app-server-proxy-probe.mjs`：Windows App Server 代理连接的只读探针，用于确认
  代理端点、初始化握手和 RPC 可达性。
- `windows-proxy-inbound-limit-probe.mjs`：验证 Windows 代理入口对回环地址和入站连接限制的
  只读探针，不修改系统或服务配置。

脚本不得把凭据写入 npm 安装目录；用户配置、SQLite、配置事件队列、Socket 和日志必须留在用户级 `.codex-connect`。

`session-cleanup.mjs` 实现 `codexc sessions cleanup`：Gateway 停止时通过 App Server 枚举全部
Workspace/Provider，按主会话真实轮数筛选，不使用展示缓存决定资格。后代通过 `ancestorThreadId`
查询未归档与已归档成员，执行前重新检查会话组及绑定；仅在交互终端 `--confirm` 确认后向父会话
发送一次官方归档。结果区分可查询成员已核验、部分完成、未归档、未确认与跳过，已确认归档的成员失效展示缓存，不重试写入或自动回滚。

- `cline-pass-setup.mjs` / `cline-pass-setup.d.mts`：CLP 多账户固定/切换配置、默认账户与移除，CLI/WebUI 共用预览和私有写入事务；共享 DS Flash 模板与统一上下文设置。
