# 项目脚本

本目录保存 npm CLI 和开发流程调用的 Node.js、Shell 脚本。脚本处理本机配置、构建、协议生成和服务管理，不承载 Gateway 的会话业务逻辑。

## 配置与 Workspace

- `runtime-config.mjs` / `runtime-config.d.mts`：解析并声明用户数据目录和运行时路径，并初始化 `.codex-connect`；为只读诊断和
  独立项目命令提供不修改配置权限的必需/可选路径定位，可选定位只把文件不存在视为未初始化，
  但显式指定的配置文件缺失及其他文件系统错误仍失败；启动与写入流程显式收紧目录和配置文件权限。
- `source-update.mjs` / `source-update.d.mts`：在 `~/.codex-connect/codex-channels` 精确 Git
  源码安装布局下比较官方 `main` commit，拒绝脏仓库、自定义提交、非官方 origin、降级和 Codex CLI
  版本不匹配；交互终端遇到不匹配时以默认确认的 `Y/n` 询问是否全局安装精确 Codex CLI 版本，确认
  后先安装到随候选清理的临时目录完成真实合同检查，通过后才执行独立全局安装阶段并继续原更新
  事务；拒绝、临时或全局安装失败、合同失败及非交互调用均在停服和切换源码前失败，并显示精确
  错误或安装与重试命令。接受与候选协议
  基础版本一致的 `-rc.N` Gateway 候选版或 `-fixN` 修复版，Codex CLI 校验仍使用候选协议元数据中的
  正式版本；更新前返回不包含 origin 的修订计划，候选准备完成后再返回目标版本、服务中断要求和
  精确执行阶段，预检状态变化时在克隆或停服前拒绝执行；
  候选源码先在同盘临时仓库完成依赖安装、Gateway/WebUI 构建及新版本本地预检，之后才停止服务并
  使用实际 CLI 校验包含 `--config` 的候选公开合同、本地审批允许值及 Codex 根级和所有 Profile
  用户配置；无新提交与 Registry 安装也执行同一只读检查。不一致时在全局安装、停服和切换前失败，
  不自动迁移审批策略；通过后才安装全局 CLI 并原子切换源码，
  最后由新版本继续执行统一本地更新；成功路径显示有界 Git 阶段摘要并隐藏 npm/Vite
  明细，失败时保留对应工具输出；源码切换后刷新 npm 全局命令，并清理旧 `bin/codexc`、
  `.bin/codexc` 与 Shell PATH。阶段进度和失败对象包含已完成阶段、服务/源码恢复状态与修复建议，
  观察者或 CLI 展示异常不改变更新事务。Registry 安装直接委派现有本地更新，不修改程序包。
- `source-install-metadata.mjs` / `source-install-metadata.d.mts`：记录受管源码使用过的 npm 全局
  prefix，并从当前全局包路径识别其所属 prefix，供跨 Node.js 管理器更新和卸载使用。
- `source-uninstall.mjs` / `source-uninstall.d.mts`：校验当前进程、受管源码目录和命令入口归属后，
  先卸载后台服务，再删除 Git 仓库、已记录和当前包所属 npm prefix 中的全局命令及旧 Shell PATH；
  旧版未标记仓库只有在官方 origin、`main`、包名和干净状态均通过校验时才可认领。拒绝符号链接或
  不匹配路径，并保留配置、数据库、凭据、日志和输出。
- `source-shell-path.mjs` / `source-shell-path.d.mts`：只清理旧源码安装写入四类 Shell 配置文件的
  精确 Codex Connect PATH 行或配置块，不修改其他 PATH。
- `local-update.mjs` / `local-update.d.mts`：实现并声明 `codexc update` 的本地兼容更新；先只读严格
  校验 `config.toml`、状态库、指标库、计划任务库、会话展示缓存及核心服务定义的完整状态，并返回不含凭据的修订
  计划、是否需要中断服务及八阶段进度；预检与进度观察者异常不影响更新事务。服务已安装时在同一个
  App Server、Gateway 停机窗口内分别备份并更新配置和各数据库（包括计划任务库 v1→v2 以及可重建的会话展示缓存），离线复核
  后启动并通过 Socket 与监管拓扑确认核心服务稳定就绪；服务未安装且 Gateway 未运行时只执行离线
  更新，不擅自安装或启动，检测到
  `codexc start` 前台 Gateway 时则在任何写入前失败并提示先结束该进程。公开服务命令复用同一按
  目标健康检查，并为 App Server 初始化、正常渠道连接和订阅恢复保留 150 秒默认等待窗口。
  源码已经切换后刷新全局命令或本地更新失败时仍保留新源码与旧源码备份，并先尝试恢复核心服务；
  服务恢复也失败时同时报告两个错误；失败对象另附失败阶段、已完成阶段、已应用改动范围、服务恢复状态
  和修复建议，不要求调用方解析异常文案。
  未知配置、残缺结构或不受支持的 Schema 在写入前失败关闭；停机窗口内还会通过
  `backup-provider-migration.mjs` 先完整备份旧布局、现有新目录与被改写引用文件，再把受管
  第三方 Provider 的旧布局原子迁移到 `~/.codex-connect/providers/<id>/`，遇到新旧文件冲突或
  不安全权限时拒绝覆盖，迁移失败时恢复原有目录；随后遍历编译期 Provider 定义，按目录更新
  适配器执行，并按目录来源复用同一个下载 Promise。当前会刷新已配置 DeepSeek 与 OpenCode Go
  的受控模型目录，保留逐模型设置，并一次性把仍使用 OpenCode Go 旧默认 Flash 的账户与共享子代理
  切换到 Flash Vision Exp；目录清单记录迁移完成状态，避免以后覆盖用户主动选回 Flash 的决定；
  最后在私有备份后移除已废弃的 `[vision]` 配置段。
- `upgrade-state.mjs`：仅在显式执行 `codexc state upgrade` 时备份并把状态数据库从 Schema v3
  升级到 v4，同时备份并显式升级计划任务数据库 v1→v2（`hourly`→`interval`），为统一更新入口提供
  只读版本检查；不自动迁移未知版本。运行时由 SqliteScheduledTaskStore 保持失败关闭。
- `metrics-database-access.mjs`：集中实现 `codexc metrics` 与 WebUI 共用的数据库状态、
  `run`、`turns`、`threads`、`report`、`export`、`quota` 和周额度只读查询；只打开只读 Store，不加载服务控制或数据库维护流程。
- `metrics-database.mjs` / `metrics-database.d.mts`：保留 `codexc metrics` 的兼容公开入口和 CLI，
  组合只读访问、输出渲染以及 `upgrade`、`reset`、`cleanup`、`prune` 等显式维护命令；查询复用 Observability
  只读端口，`status --json` 返回稳定的路径、Schema、兼容性与记录数，渲染复用
  `metrics-export-format.mjs`；运行、会话与聚合输出从现有 `compact` 明细
  派生上下文压缩模型、请求数、Token 和费用摘要，JSON/CSV 同时保留可视化字段；`export` CSV 用独立类型行区分请求历史额度快照
  与 OpenAI 当前额度估算摘要，避免重复附加全局状态；upgrade 要求 Gateway 停止并把 Schema v3..v10 备份后
  逐版本事务升级到 v11（v8 升级 v9 为 OpenCode Go 窗口快照新增 `quota_windows` 列，v9 升级 v10 为
  `subagent_threads.parent_turn_id` 新增可空父 Turn 关联，v10 升级 v11 新增运行级
  `subagent_turns`；历史运行归属不猜测），
  reset 要求 Gateway 停止、检查点回写、`0600` 备份后移除旧库，不迁移或覆盖原指标记录。
  服务状态无法确认、处于非停止状态或前台 Gateway
  指标 Socket 仍可连接时均拒绝 reset；`sync-reset` 备份并清零多端上报水位文件（保留
  设备 ID），默认同样要求 Gateway 已停止，`--restart-gateway` 时自动停止并重新启动
  Gateway，用于重放修复中心历史数据。`cleanup` 按 `[metrics.storage]` 或命令行覆盖值创建私有
  备份后清理最旧请求记录，可选 `--vacuum` 立即回收 SQLite 文件空间。
  `prune <provider>` 备份后删除本地与中心库中指定提供商（openai、deepseek、`ocg-<账户>` 或当前配置/私有备份中的自定义主 Provider）的全部请求
  行，并自动停止、重启 Gateway 与中心服务；任一步骤失败也会尝试把服务重新拉起，额度重置
  后可用它从零重新统计用量。
- `metrics-command-options.mjs` / `metrics-command-options.d.mts`：集中解析并预检 `codexc metrics` 的
  时间范围、分组、格式及维护命令参数，并向顶层帮助导出规范用法行；不访问配置、数据库或服务，
  `metrics-database.mjs` 保留原有公开入口与 `metricsRange` 导出。
- `channel-send-image-options.mjs`：集中解析 `codexc channel send-image` 参数，使顶层 CLI 在读取配置前拒绝非法输入。
- `channel-send-image.mjs`：`codexc channel send-image` 的实现，把本地图片复制到
  `data/channel-outbox/pending/` 并写入 manifest；由 Gateway 轮询后按 Thread 绑定
  会话发送并归档，详见 `docs/channel-image.md`。
- `session-cleanup.mjs` / `session-cleanup.d.mts`：实现并声明 `codexc sessions cleanup`，通过
  App Server 枚举多 Provider/Workspace，会话元数据过滤后按 Turn 上限和可选空闲天数预览、确认归档。
- `session-menu.mjs` / `session-menu.d.mts`：`codexc sessions` 无子命令时的交互菜单；收集 Turn 上限和空闲天数后调用
  会话清理 CLI，并保留清理命令自身的候选预览与最终确认。
- `metrics-export-format.mjs` / `metrics-export-format.d.mts`：指标导出的显示上下文（配置与
  汇率缓存）、币种换算、Token/费用/时间格式化与 Markdown/CSV 转义；币种模式解析与 Token
  格式复用 Application/Surface 导出，换算逻辑集中在 `convertCostToCny`。
- `metrics-output-renderer.mjs`：把指标查询结果渲染为 Markdown、JSON 或 CSV；集中处理报告、
  请求明细、Thread、Turn 与当前运行输出，不访问数据库、运行时配置或服务控制。
- `webui-command-options.mjs`：集中解析 `codexc webui` 监听参数，使顶层 CLI 与服务实现复用同一规则。
- `webui-server.mjs` / `webui-api.ts`：`codexc webui` 的 HTTP 服务与共享 API 类型；设置摘要接口
  复用 Config 脱敏投影与跨平台服务状态查询，只返回配置修订、非凭据字段和 Secret 配置状态；
  `/api/v1/management/services` 在同一 WebUI Bearer 鉴权下提供受管服务状态、版本和受限的最近错误摘要；
  `/api/v1/management/providers` 提供不含 URL、Profile 或凭据的 Provider 安全概览。
  管理设置接口复用 WebUI `Authorization: Bearer` 令牌，并保留精确 Origin、JSON 请求约束、限速和审计。
  默认回环监听并托管 `webui/dist` 静态前端；提供 `/api/v1/overview`、`/api/v1/threads`、
  `/api/v1/threads/:id/run|turns`、`/api/v1/requests`、`/api/v1/errors` 只读 JSON 接口；
  `/api/v1/global/*` 按 `[metrics.view]` 配置由服务端代理到中心服务（前端不接触令牌）；
  Threads 返回指标库首个请求开始时间，请求明细按受控字段在整个时间范围排序后偏移分页；
  `webui-api.ts` 声明接口响应类型，前端统一从该文件导入；监听参数优先取命令行，其次
  `config.toml` 的 `[webui]` 段，默认回环无令牌；绑定非回环地址（`0.0.0.0`）时必须设置
  配置 `token`，API 以 `Authorization: Bearer` 校验并采用常数时间比较；令牌不通过命令行传入。
- `metrics-center-server.mjs`：`codexc center` 的多设备指标中心 HTTP 服务。
  接收各设备 Gateway 的增量上报（独立 Bearer 上报令牌校验、载荷校验、按 `device_id + local_id`
  upsert 覆盖写入），写入中心 SQLite（复用 `metrics-center-schema.sql` 表结构，
  WAL、`0600`），并提供 `/api/overview`、`/api/requests`、`/api/subagents`、
  `/api/quota?days=365`（也支持 `days=all`，按提供商、额度窗口、重置时间聚合多设备实际请求与估算）、`/api/devices`、`/api/health`；查询使用独立只读令牌，WebUI 通过 `/api/v1/global/*` 服务端代理读取，令牌不进入前端；
  `center info --json` 返回运行状态、端点和双令牌配置布尔值，不返回令牌或掩码片段。
  子命令 `codexc center config` 交互设置 `[metrics.center]`、`codexc center info` 输出
  中心地址（含设备上报端点）、双令牌状态与运行状态；监听参数优先命令行，其次
  `config.toml` 的 `[metrics.center]` 段，默认回环 `127.0.0.1:8790`。
- `metrics-center-settings.mjs`：中心服务与指标脚本共用的轻量配置解析（命令行参数、
  `config.toml` 的 `[metrics.center]` 段与默认值），不依赖 Cloudflare 部署文件。
- `metrics-config-menu.mjs`：数据中心与中心服务设置的交互用例；集中管理本地保留策略、中心接入、
  上报参数、接入状态和中心监听配置，返回统一 `activationResult` 及自动激活状态
  （`pending`/`applied`），`config.mjs` 只保留顶层配置菜单编排与兼容重导出。
- `metrics-menu.mjs` / `metrics-menu.d.mts`：`codexc metrics` 无参数时的交互用例及注入边界声明；负责收集查询、导出、清理和重置参数，
  通过 CLI 注入的命令边界执行，不承载子进程或输出文件管理。
- `metrics-center-payload.mjs` / `metrics-center-payload.d.mts`：中心服务与历史 Cloudflare
  Worker 共用的上报载荷校验及类型声明。
- `metrics-center-schema.sql`：npm 发布包内中心 SQLite 的规范初始化 Schema，子代理标注包含可空
  `parent_turn_id`；历史 Cloudflare D1 migration 保留部署参考，不作为生产中心运行时依赖。
- `setup.mjs`：使用 `@clack/prompts` 提供统一设置类别菜单和脱敏总览，并把“Codex 新会话默认值”
  “模型与提供商”“通讯渠道”和“项目技能”流程委派给具体适配器；模型与提供商下分 OpenAI 官方
  登录/恢复与第三方 Provider 两级，子模块返回时停留在所属层级；配置写入后的激活结果由
  `config-activation-result.mjs` 提供统一状态和目标定义。公开 CLI 的 `codexc setup --json` 将交互提示
  写入 stderr，并按每行一个事件把脱敏结果写入 stdout；默认 `codexc setup` 仍保持纯交互文本输出。
- `setup-summary.mjs` / `setup-summary.d.mts`：复用统一 Provider 管理状态读取 Codex 全局默认模型与思考等级，先返回
  不依赖终端输出的结构化脱敏总览，再由 CLI 包装器渲染；汇总主 Provider、可切换 Provider、第三方模型默认值、
  共享第三方子代理、直接 API Provider 数量、已启用渠道和用户技能数量，不显示 API Key、Token、应用凭据、
  允许名单、代理值或 Provider URL。
- `custom-primary-provider-setup.mjs` / `custom-primary-provider-setup.d.mts`：`codexc setup` 的“模型与提供商 → 第三方 Provider → 自定义 Responses Provider”；
  新增时可从 URL 主机名派生 Provider ID、输入自定义标识符或选择推荐的 `OpenAI`，编辑时保留所选候选 ID；引导填写
  上游 `base_url`、直接写入的 API Key、固定/切换模式、WebSocket 开关和上游模型 ID。模型 ID 当前
  必须属于 App Server 返回的 Codex 官方目录；不调用第三方 `/models`，不生成 `models.json` 或
  `model_catalog_json`，目录来源保留为可辨识的 `official` 接口。
  `OpenAI` 选项固定写入同名 `name` 以允许 Codex 使用远程压缩，上游仍须兼容对应接口。新增默认推荐
  切换模式，编辑保持原模式；确认预览明确显示配置位置、API Key 明文存储、默认思考等级和服务层级。固定模式通过 Codex
  `config/batchWrite` 原子写入并激活 `~/.codex/config.toml` 的自定义主 Provider；切换模式保持主
  Provider 为 `openai` 且不修改主配置，为每个 Provider 写入包含完整 Provider 块、Key、模型、
  `model_reasoning_effort = "medium"` 和服务层级的 0600 `~/.codex/sf-custom-<Provider ID>.config.toml`，
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
- `custom-primary-provider-management.mjs` / `custom-primary-provider-management.d.mts`：提供自定义主
  Provider 新增与编辑的无终端校验、脱敏预览和执行接口；用 `preserve` / `replace` 明确表达 Key
  操作，现有 Key 只在内部计划闭包中用于同 Origin 保留，不进入预览或执行结果。固定模式复用 Codex
  配置事务与 Profile 回滚，切换模式在写入前复核 Codex 配置版本、私有注册表和 Profile 快照，再在
  同一文件锁内原子写入私有 Profile，并统一返回生效动作和备份清理警告；CLI
  继续负责字段询问、危险修改确认和中文渲染。
- `model-provider-management.mjs` / `model-provider-management.d.mts`：统一返回 OpenAI 默认值、当前主
  Provider、受管 Provider（含 OpenCode Go 账户）、自定义固定/切换/备份候选、受控模型目录和共享
  第三方子代理的脱敏管理状态；移除 API Key、私有 Profile 内容和子进程环境，并供 Setup 总览与主
  Provider CLI 列表共同复用。
- `model-provider-management-transaction.mjs` / `model-provider-management-transaction.d.mts`：统一
  串行 DeepSeek、OpenCode Go、自定义主 Provider、默认模型设置与共享第三方子代理的跨文件管理
  事务；同一异步调用链中的嵌套操作复用事务，避免角色切换与 Provider/账户删除交叉提交。
- `primary-provider-management.mjs` / `primary-provider-management.d.mts`：提供自定义主 Provider
  切换与删除的无终端预览和执行接口；预览仅返回脱敏目标、影响与生效动作，执行继续保护共享子代理
  正在使用的 Provider、校验显式模型属于 App Server 官方目录、保持配置/Profile/私有备份事务顺序，
  并以稳定错误码和结构化警告报告失败或备份清理部分成功。
- `primary-provider-config-transaction.mjs` / `primary-provider-config-transaction.d.mts`：统一自定义
  Provider 固定模式写入事务；切换与新增/编辑共同复用 Profile 移除、Codex 配置版本写入、响应丢失
  只读确认和安全回滚，避免两条管理链路复制高风险事务逻辑。
- `primary-provider-cli.mjs` / `primary-provider-cli.d.mts`：`codexc primary-provider` 的
  list / add / switch / remove 子命令；`list --json` 复用统一 Provider 管理状态并返回不含凭据的稳定主实例与候选摘要；
  switch / remove 复用 Provider 管理接口并只负责中文确认与结果渲染，add 复用自定义 Responses Provider Setup 的交互流程，
  Setup 菜单另提供候选选择编辑；`switch openai` 不运行登录直接恢复官方
  并把固定候选移入私有备份、保留切换 Provider，`switch <ID>` 把目标设为固定主 Provider；目标是切换
  Provider 时，交互菜单须经二次确认后移除其独立 Profile，已清理候选则从备份自动恢复并消费该备份项；Setup 可直接
  编辑备份候选并恢复、修改和激活，也可经二次确认删除备份候选。恢复、编辑或删除时先提交配置，
  成功后才消费同名备份；配置写入失败时保留原备份，配置已提交但清理失败时显示部分成功警告。备份
  不可安全读取时只允许编辑当前 config 候选，切换和删除失败关闭；注册表仍登记但 Profile 已缺失的
  切换 Provider 可由精确 `remove` 命令清理。删除切换 Provider 时同时清理同 ID 私有备份；Profile
  或注册项已经删除但备份无法安全清理时显示部分成功，不恢复已删除的切换配置。从第三方切回官方时清除第三方顶层模型，已在官方
  模式时保留官方模型。
- `primary-provider-usage.mjs`：`codexc primary-provider` 的规范帮助文案，供脚本与入口帮助共用，
  避免两份文案漂移。
- `agents.mjs`：提供不依赖终端提示的共享第三方子代理 Provider 列表、配置/停用预览与执行接口，
  `codexc agents` 复用该接口；`status --json` 返回稳定配置状态，Provider 与模型未配置时显式使用
  `null`，不要求 Gateway 已初始化。角色文件和 Codex 主配置复用统一 Provider 管理事务，避免与
  Provider/账户配置、切换或删除交叉提交；管理结果只包含脱敏选择和全部服务重启动作。
- `agents-setup.mjs` / `agents-setup.d.mts`：向 Setup 提供共享第三方子代理的受管或自定义 Provider、
  模型选择和停用确认，只编排 `agents.mjs` 的管理接口；自定义 Provider 当前使用其已配置模型。
- `official-login-setup.mjs` / `official-login-setup.d.mts`：`codexc setup` 的“模型与提供商 → OpenAI 官方 → 登录并恢复官方”；运行
  `codex login --device-auth` 完成官方登录（打开终端显示的链接并输入验证码），并通过
  `config/batchWrite` 把 `model_provider` 写回 `openai`，候选块移入私有备份并从 config 清理，
  之后可用 `primary-provider switch` 从备份恢复；同时移除冲突的顶层 `openai_base_url`，从第三方
  模式恢复时清除第三方顶层模型。设备登录完成后在统一 Provider 管理事务内重新读取配置与角色
  占用状态，再按最新配置修订备份并提交，避免登录期间的并发修改被旧快照覆盖。
- `codex-user-settings-management.mjs` / `codex-user-settings-management.d.mts`：统一返回不依赖终端的
  Codex 用户设置快照，并以配置版本保护的 `config/batchWrite` 受控修改默认模型与思考等级、Fast、计划清单工具，
  一起修改 Sandbox、审批和 Workspace Sandbox 网络权限，或一次原子写入核心默认值；Fast 仅作为
  OpenAI 主配置偏好写入。单独设置页可选择 `live`、`indexed`、`cached` 或 `disabled`，不读取第三方模型目录。
  第三方固定模式不开放官方默认模型、思考等级和 Fast；已有 `default_permissions` 时不混写传统 Sandbox 字段。
- `codex-user-settings-setup.mjs` / `codex-user-settings-setup.d.mts`：`codexc setup` 的“Codex 新会话默认值”
  适配器，只负责选择、预览和中文结果；可单独设置计划清单工具、Plan 思考等级、推理摘要、输出详细程度、人格、
  更新检查和历史保存；第三方 Provider 的模型与凭据继续留在 Provider Setup。
- `codex-defaults-setup.mjs` / `codex-defaults-setup.d.mts`：从官方模型目录选择 Codex 全局默认模型和
  思考等级，写入复用统一用户设置管理接口；不修改登录凭据或 Gateway 的 Thread 默认模型。
- `model-provider-default-management.mjs` / `model-provider-default-management.d.mts`：提供受管 Provider
  默认模型、思考等级和自动压缩阈值的无终端校验、预览与执行接口；切换模式更新私有 Profile，固定
  模式与切换模式共用统一 Provider 管理事务；固定模式以用户配置修订为前置条件，响应丢失时先只读
  确认写入结果，仅在确认未生效时恢复模型目录，
  结果明确返回 App Server 重启动作。
- `model-provider-default-setup.mjs` / `model-provider-default-setup.d.mts`：负责受管 Provider 默认设置的
  Provider、模型、思考等级和自动压缩交互与中文渲染，写入复用管理接口；历史 Thread 仍保留创建时的模型。
- `codex-user-config.mjs` / `codex-user-config.d.mts`：统一创建隔离的 stdio App Server Client，把 Codex 官方默认值与
  `multi_agent_v2` / `agents.external` 普通键级修改作为官方 `config/batchWrite` 事务写入用户配置；
  受控角色修改在同一 Client 中读取原始用户层及版本，并通过 `expectedVersion` 拒绝并发覆盖。
- `skill-setup.mjs` / `skill-setup.d.mts`：`codexc setup` 的“项目技能”类别；列出项目 `.codex/skills` 下带
  `SKILL.md` 的技能，安装/覆盖到 `~/.agents/skills/<技能名>`（可用
  `CODEX_AGENTS_SKILLS_DIR` 覆盖目标目录），支持卸载；只复制技能目录本身，不修改
  hermes 运行时的 `.skill-lock.json`。
- `config.mjs`：`codexc config` 的顶层交互编排，先提供不显示凭据或代理值的配置总览，再覆盖
  配置文件中可安全编辑的参数：显示设置（操作详情、计划更新、全局价格显示方式）、系统设置
  （调试模式、审批超时、Sandbox、默认工作区与渠道新会话模型覆盖）、自动化（计划任务与
  Thread 分区管理员）、网络代理、日志等级与开发中功能、WebUI 设置（监听地址、端口、访问令牌）、数据中心
  （本地保留策略、本机接入数据中心并同时写入 `[metrics.sync]` 与 `[metrics.view]`、接入状态、上报参数
  `interval_seconds` / `batch_size`、停用本机接入）、
  Telegram 消息格式和配置路径查看；修改通过私有原子写入保存，非交互终端直接输出用户目录与
  配置文件路径；`--json` 不进入菜单或读取配置正文，只输出路径与文件存在状态。
- `config-summary.mjs`：把已经读取的严格配置投影为脱敏总览，只显示配置来源、有效开关、作用范围
  和已配置的代理字段名，不显示渠道凭据、访问令牌或代理值。
- `config-management.mjs` / `config-management.d.mts`：提供不依赖 prompts、TTY 或终端文案的 Gateway
  设置脱敏读取与明确修改接口；只接受受控的显示、系统、自动化、网络、高级、Telegram 格式、WebUI、
  指标和 Workspace 权限输入，返回稳定字段错误与精确生效动作，凭据和网络读取只显示是否已配置；
  读取同时返回原始文件修订，修改必须携带并在应用前复核；最终提交复用 Gateway Config 的共享写锁
  和锁内原文比较，避免菜单停留期间覆盖其他进程已保存的配置。
- `config-management-error.mjs`、`config-webui-management.mjs`、`config-metrics-management.mjs`、
  `config-workspace-management.mjs`：保存 Config 管理接口的共享稳定错误，以及 WebUI、指标和 Workspace
  的脱敏投影、输入校验与文档修改语义；CLI 菜单不再直接读写这些配置段。
- `config-advanced-menu.mjs`：管理计划任务、Thread 分区管理员、显式 HTTP(S) 代理、日志等级与
  开发中的 Plugin API；复用 Config 管理接口，管理员只能从已启用渠道的允许名单中选择，代理输入可见但既有值、输出和日志均不回显；HTTP、HTTPS 与通用代理支持一次性原子写入。
- `config-display-menu.mjs`：独立管理操作详情、计划更新、全局价格币种和 Telegram 消息格式；
  CLI 负责选择与渲染，读取、校验和写入复用 Config 管理接口。
- `config-system-menu.mjs`：独立管理调试入口、审批超时、Gateway 外部渠道 Sandbox、默认 Workspace 和
  Gateway 新 Thread 模型覆盖；调试实现仍委派给 `debug-setup.mjs`，两者复用同一 Config 管理接口。
- `config-webui-menu.mjs`：独立管理 WebUI 监听地址、端口和访问令牌交互；保持公网监听必须配置
  令牌的失败关闭约束，`config.mjs` 只负责把顶层选择路由到该领域菜单。
- `config-workspace-menu.mjs`：管理 `codexc work` 的 Workspace Sandbox、审批策略与 Permission Profile；
  保持 Sandbox 与 Permission Profile 互斥，并只写回被选择的 Workspace 配置。
- `management-access.mjs`、`management-confirmations.mjs`、`management-audit.mjs`、
  `management-security.mjs` / `management-security.d.mts`：本机管理适配器复用的无 HTTP 安全基础，
  覆盖高风险确认、Origin、限速、请求上限、安全响应头和脱敏审计；WebUI 管理路由复用其中的请求约束、
  限速和审计原语，认证直接使用 WebUI Bearer 令牌。
- `debug-setup.mjs`：在严格配置中原子写入 `logging.level`；Setup 的调试开关使用 `debug` / `info`，
  Config 的高级设置复用同一写入函数选择完整日志等级，不改写显示设置或凭据。
- `api-provider-management.mjs` / `api-provider-management.d.mts`：提供不依赖终端交互的直接 API
  Provider 脱敏列表、输入校验、增改和删除事务；返回值只包含 `hasApiKey`，不返回凭据，供 Setup
  与后续受保护的管理界面复用。
- `api-provider-setup.mjs` / `api-provider-setup.d.mts`：编排多个 Responses 兼容直接 API Provider
  的新增、编辑、删除 prompts，并调用共享管理用例；当前没有运行时调用方，保留给后续明确设计的
  直接 API 功能。
- `deepseek-setup.mjs`：复用共享的非敏感 DeepSeek Provider 定义，提供 OpenAI/DeepSeek 切换和
  仅 DeepSeek 两种安装模式；安装与恢复均提供脱敏预览、明确确认和无终端事务接口，CLI 只负责询问与展示；只下载、不执行
  DeepSeek 官方脚本，提取唯一模型目录 heredoc 并校验大小、JSON 与全部受控模型后写入
  `~/.codex-connect/providers/deepseek/`。切换模式保持 OpenAI 默认模型与认证不变，按 Codex 新版独立 Profile 文件格式把
  模型、Provider 与 API Key 写入 CLI 使用的 `sf-deepseek.config.toml`，模型目录与管理标记写入
  `~/.codex-connect/providers/deepseek/`，并自动开启 `features.multi_agent_v2`、把共享
  `agents.external` 子代理切换到 DeepSeek；
  首次修改前记录原配置、同名 Profile、管理标记与角色文件是否存在并备份原文，固定模式显式
  确认后才覆盖默认 Provider，恢复选项可精确还原首次安装状态，并在保留的审计备份中记录已恢复
  生命周期。重复安装基于当前配置更新，不从首次备份回滚后续修改，并保留仍受支持的默认模型、
  逐模型思考等级和自动压缩百分比；目录上下文更新时按原百分比重算阈值。退出固定模式时只还原 Setup
  管理的字段（含自动压缩阈值），恢复后新增的同名用户 Provider 不会被误判为旧版托管配置；
  安装事务按写入阶段更新并发保护快照，失败时恢复本次安装前的目标文件，若目标已被其他进程修改则停止回滚并保留外部修改；
  安装时为初始模型设置自动压缩阈值；后续通过各 Provider 菜单的“修改模型设置”或统一的“第三方
  模型设置”按模型维护 10–90% 阈值，写入模型目录的 `auto_compact_token_limit`，不再使用会覆盖
  全部模型的 Profile 顶层阈值。`codexc update` 首次看到仍使用旧默认 Flash 的 Profile 与同
  Provider 共享子代理时，事务迁移到 Flash Vision Exp，并把一次性迁移记录写入模型目录清单；
  已选择其他模型或记录已存在时保留用户选择，重复 Setup 不删除该记录。
- `deepseek-catalog-baseline.json`：保存人工对照 DeepSeek 官方 Codex 安装脚本审查后的模型完整指纹、
  上下文、输入模态、思考等级、搜索、并行工具和最低客户端版本；运行时仍只开放编译期定义明确
  列出的模型。
- `deepseek-setup.d.mts`：声明 DeepSeek Setup 的公开脚本类型。
- `managed-model-provider-setup.mjs` / `managed-model-provider-setup.d.mts`：复用第三方 Provider 的
  受管模型目录默认值/逐模型设置保留、切换 Profile、固定配置、恢复影响摘要与稳定错误逻辑；DeepSeek 与
  OpenCode Go 共同复用，账户注册和历史备份格式仍由各自适配层负责。
- `opencode-go-account-files.mjs` / `opencode-go-account-files.d.mts`：集中 OpenCode Go 账户私有文件
  路径、受限读取、快照和并发保护回滚原语，供账户新增、删除、目录刷新与恢复事务复用。
- `opencode-go-account-management.mjs` / `opencode-go-account-management.d.mts`：提供 OpenCode Go
  默认账户切换、运行实例停止与账户删除的无终端预览和执行接口；默认切换同步更新正在使用 OpenCode Go
  的共享子代理并保留失败回滚，停止明确区分未运行、Remote TUI 占用和已停止，删除在明确确认后保留私有备份并执行多文件回滚。
- `opencode-go-account-provisioning.mjs` / `opencode-go-account-provisioning.d.mts`：提供 OpenCode Go
  账户新增/重新配置的脱敏预览与无终端执行接口；内部完成目录下载、首次备份、Key 写入、切换/固定模式配置和多文件事务回滚。
- `opencode-go-setup.mjs` / `opencode-go-setup.d.mts`：OpenCode Go 多账户管理
  （add/list/remove/default/stop，供 `codexc opencode-go account` 调用）与 Setup 菜单；`list --json`
  返回不含 Key 与 Profile 路径的稳定账户摘要；新增/重新配置复用账户 provisioning 接口，默认切换、停止和删除复用账户管理接口；配置切换/固定模式
  或通过脱敏预览、明确确认与无终端执行接口恢复首次配置前状态，从同一受审查来源
  生成共享模型目录并复用共享子代理机制，
  但不复用凭据、Provider 身份或价格；兼容独立目录引入前的备份状态，重复配置时保留仍受支持的
  默认模型与逐模型设置；为 `codexc update` 提供共享目录刷新和旧默认模型的事务迁移，已主动选择
  Pro 的账户保持不变。
- `model-provider-file-layout.mjs` / `model-provider-file-layout.d.mts`：把旧第三方文件迁移到统一
  `~/.codex-connect/providers/<id>/` 布局，并把 Provider 根级上下文、思考等级和自动压缩阈值
  迁入各自模型目录，切换模式 Profile 再镜像所选模型的默认思考等级。
- `backup-provider-migration.mjs` / `backup-provider-migration.d.mts`：在迁移前把旧布局文件、
  现有新布局 Provider 目录与被改写引用文件完整复制到 `~/.codex-connect/backups/` 下带时间戳的
  备份目录，再执行文件布局与模型设置迁移；遇到新旧并存时先把现有 Provider 目录移到备份内
  的 `original-providers/`，迁移失败时恢复原目录。默认只预演，需显式 `--apply` 才写入；
  `codexc update` 的停机窗口会自动以 `--apply` 方式调用。
- `terminal-prompter.mjs`：为各通讯渠道 Setup 提供最小的终端文本、确认和可见凭据输入接口，并允许
  长流程通过 `AbortSignal` 中止尚未完成的问题。
- `telegram-setup.mjs`：把 Telegram Bot 来源、长轮询冲突确认、允许名单输入和中文输出适配到
  `telegram-setup-session.mjs` 的结构化会话；复用统一 TOML、环境变量和系统代理解析；交互输入的
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
  并只向 TOML 写入禁用态账号与允许用户元数据；
  Setup 不直接启动消息 Surface，操作者显式启用配置并重载 Gateway 后生效。
- `weixin-setup-session.mjs` / `weixin-setup-session.d.mts`：提供所有者绑定的微信 Setup 开始、状态、
  配对码提交、确认与取消接口；二维码和凭据只保存在有期限的进程内会话中，状态与保存预览不返回
  Bot Token，取消和超时会中止底层请求并丢弃临时状态，确认时检查微信配置未被并发改动后复用原子
  凭据/配置回滚事务。
- `feishu-application.mjs`：为 Setup 与 Doctor 提供带有限超时的飞书凭据/Bot 身份、应用权限、
  消息事件和待审核版本只读探测，不建立消息长连接，并把 SDK 错误和残缺响应收敛为不含敏感详情的
  稳定错误。
- `workspace-command.mjs`：实现 `codexc work` 的参数校验、交互菜单和目录创建，并调用统一的 Workspace 权限设置用例；
  `list --json` 返回稳定的 Workspace 注册摘要；CLI 入口只负责分发。
- `workspace-config.mjs`：读取、检查和原子更新 TOML 中的 Workspace 配置，通过 `runtime/config-event-queue.mjs` 保证 Gateway 重启窗口内的 Workspace 新增通知可恢复；支持列出失效项、删除注册记录，并恢复固定默认 Workspace。
- `agents.mjs` / `agents.d.mts`：`codexc agents` 的执行脚本与公开声明，在 `~/.codex/config.toml` 中开启或关闭
  `features.multi_agent_v2` 并注册单次共享 `agents.external` 角色；命令按已配置的受管或自定义 Provider 与模型
  更新同一角色，角色说明要求主模型以 `fork_turns=1` 传入当前用户消息；非托管同名角色会失败关闭，不会被覆盖。启用时先原子生成
  无凭据角色文件，再通过带用户层版本校验的官方键级配置事务更新主配置，事务失败时恢复角色文件；
  显式禁用同样拒绝删除非托管同名角色。App Server 服务启动时原子刷新角色文件为
  当前 Provider 的本机统计代理地址，只把该 Provider 的 Key 注入主 App Server 子进程，同时写入禁止
  解析加密正文和等待后续消息的受控指令。普通服务退出保留文件以维持 Codex 配置可解析，显式
  禁用或恢复首次配置时删除；只读 `status` 不依赖 Gateway 配置。

## 开发与协议

- `dev-all.mjs`：开发模式下复用完整的现有 App Server 拓扑，或通过唯一的内部
  `service-app-server` 入口立即启动主 App Server；已配置的隔离 Provider App Server
  在首次选择模型、恢复 Thread 或使用对应 Remote TUI 时由监管入口按需启动。统计代理也按 Provider
  使用情况启动；共享 `agents.external` 当前选择的 Provider 会预先启动统计代理以保证子代理可用；
  随后再启动 Gateway。只复用私有监管身份、Provider 拓扑和真实 WebSocket 健康检查一致的实例，
  Gateway 进程再通过与 Provider 无关的配置级所有权 Socket 拒绝所有入口的重复实例。部分拓扑或裸
  App Server 失败关闭；脚本统一收敛自身启动错误，已经由内部服务入口展示的失败不重复包装。
- `codex-remote-options.mjs` / `codex-remote-options.d.mts`：在读取 Gateway 配置前解析
  `codexc remote` 自有的 Workspace 与受管 Provider Profile 参数；受管 Provider 只使用与磁盘文件及
  原生 Codex 一致的 `sf-*` 规范名称，旧的无前缀名称只返回明确替换提示，并尊重 `--` 后原样传给 Codex 的参数边界。
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
  真实合同、构建和打包检查；单项失败后继续其他阶段，并保存逐项日志和结构化结果。预览阶段不
  改稳定版文档，因此明确跳过文档索引检查和仅用于发布前的 README 同步测试。
- `write-upgrade-report.mjs`：把 CI 中生成的升级工作树写成 Markdown 摘要、文件清单、统计和
  二进制安全 Patch，并分别比较 `HEAD` 生成协议的 RPC/顶层字段结构和受控公开 CLI 合同，合并
  逐阶段结果；生成或验证失败且没有差异时仍会输出报告。
- `check-pr-description.mjs`：所有 Ready PR 必须写清新增、修复和改动，没有对应内容时明确写
  “无”；正式升级 PR 还要把自动占位内容替换为本项目的收益、采用项、不采用项及风险与验证。
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
- `check-docs.mjs`：校验项目 Markdown 本地链接、根 `index.md` 文档索引、源码模块索引、协议数字和相关目录
  文件索引，并拒绝已移除的文档名称；常规项目文档检查排除 `.codex/skills/**` 附带的技能参考资料。
- `codex-rules.mjs`：向 CLI 重新导出 `runtime/project-rules.mjs` 的项目定位、规则生成与检查能力。
- `install-git-hooks.mjs`：只为当前源码仓库设置 `.githooks`，不修改用户全局 Git 配置。
- `verify-commit.mjs`：为 pre-commit hook 与 GitHub CI 串行执行统一的完整提交检查，并输出每个
  阶段及全部检查的累计耗时；完整测试已经成功构建 Gateway 后，日常门禁只复用该产物执行 tarball
  安装冒烟。干净源码安装保留在独立 `npm run test:package`、正式发布和升级验证中。
- `validate-config.mjs`：在安装系统服务前使用已构建的 Gateway 配置模块执行完整校验。

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
  全局安装命令会完成构建并生成 `codexc` 入口。
- `smoke-package.mjs`：生成实际 tarball，在隔离目录安装，验证 WebUI 前端产物，并执行公开的
  `codexc` 入口与配置预检。
- `check-release-tag.mjs`：要求 Git Tag、`package.json` 与 README 发布版本及安装命令严格一致，
  README 尚未完成对应发布提交时失败关闭。
- `sync-published-readme.mjs`：把受控的 README 正式版、`-rc.N` 候选版或 `-fixN` 修复版及安装命令
  渲染为对应发布状态；RC 独立保留当前正式安装说明并使用目标正式 Codex CLI，fix 独立保留正式
  安装说明；拒绝其他预发布、降级、高于开发基线和缺少受控标记的文档。
- `sync-gateway-version.mjs`：升级 Codex CLI 协议时把 `package.json`、锁文件和 Gateway 运行时
  版本重置为新的正式基础版本；Gateway 候选发行和修复发行可分别在该基础版本后使用受控的
  `-rc.N` 或 `-fixN` 后缀。任一后缀 Tag 发布并核验后，`main` 必须通过独立 PR 恢复无后缀基础
  版本以兼容旧版源码更新器；已发布版本的安装入口继续由 README 和 Release 保留。
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
- `install-launchd.mjs` / `install-systemd.mjs`：保留可直接生成平台服务定义的兼容脚本，实际模板计划、
  转义与原子写入统一复用服务安装管理接口；代理仍由 CLI 服务入口在每次启动时解析。
- `service-install-context.mjs` / `service-install-context.d.mts`：systemd 与 launchd 安装器共用的配置、
  默认 Workspace、主 Socket、Codex/Node 可执行文件及服务 PATH 解析；读取计划不修改磁盘，执行时才把
  运行目录创建为 `0700`。
- `service-install-management.mjs` / `service-install-management.d.mts`：把服务安装拆成配置校验、平台
  预检、定义原子写入、核心服务激活和就绪确认五个结构化阶段；返回不含配置凭据的修订计划、进度、
  完成阶段、稳定恢复动作和最终结果。Linux systemd 与 macOS launchd 共用任务契约，但继续由各自
  控制脚本实现 linger、旧 Job 检测及服务管理，不解析 Shell 文案推断结果；Windows 明确失败关闭。
- `config-activation-result.mjs` / `config-activation-result.d.mts`：把配置写入器的内部激活范围转换为
  稳定的状态、目标和可执行命令列表，供 Config、Setup 与自动化复用，不承载服务控制。
- `config-activation-notice.mjs` / `config-activation-notice.d.mts`：统一 Gateway 配置写入后的生效提示，区分自动重新读取、需要重建
  Gateway 连接，以及需要通过 `codexc service install` 重新生成 App Server 服务环境的变化；
  WebUI 与指标中心的专属重启要求继续单独提示。
- `launchd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载四个 launchd 服务；启停、
  重启、状态和日志支持 `gateway`、`app-server`、`webui`、`center`、`all` 目标，
  WebUI 与指标中心独立不并入 `all`，
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
- `systemd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载四个 systemd 用户服务；
  安装前确保当前用户的 linger 已启用并复查，使用户未登录时也能随系统启动，无法启用则在修改
  unit 状态前失败并显示管理员处理命令；与 launchd 使用相同的目标、服务角色和默认值，WebUI
  与指标中心独立不并入 `all`；停止不存在的 Unit 与 launchd 一样按已停止处理，用户数据始终保留。
- `windows-service-control.mjs` / `windows-service-control.d.mts`：读取用户级 Windows 服务定义，
  通过计划任务控制脚本执行 App Server、Gateway、WebUI 和指标中心的安装、启停、重启、状态、日志
  与卸载；核心服务状态同时检查监管进程存活、RPC 可达性及服务定义完整性。
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
Workspace/Provider，先按 Thread 元数据过滤活动/近期会话，再复用会话轮数缓存，并仅在交互终端
`--confirm` 二次询问通过后归档符合 Turn 上限的旧会话；可用 `--idle-days` 增加空闲天数条件；不会从渠道触发。
