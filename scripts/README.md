# 项目脚本

本目录保存 npm CLI 和开发流程调用的 Node.js、Shell 脚本。脚本处理本机配置、构建、协议生成和服务管理，不承载 Gateway 的会话业务逻辑。

## 配置与 Workspace

- `runtime-config.mjs` / `runtime-config.d.mts`：解析并声明用户数据目录和运行时路径，并初始化 `.codex-connect`；为只读诊断和
  独立项目命令提供不修改配置权限的必需/可选路径定位，可选定位只把文件不存在视为未初始化，
  但显式指定的配置文件缺失及其他文件系统错误仍失败；启动与写入流程显式收紧目录和配置文件权限。
- `local-update.mjs` / `local-update.d.mts`：实现并声明 `codexc update` 的本地兼容更新；先只读严格
  校验 `config.toml` 和两个数据库的版本、必需结构与明确迁移路径，再在同一个 App Server、Gateway
  停机窗口内分别备份并更新配置和数据库，离线复核后启动并通过 Socket 与监管拓扑确认核心服务稳定
  就绪；公开服务命令复用同一按目标健康检查，并为 App Server 初始化、正常渠道连接和订阅恢复保留
  150 秒默认等待窗口。
  未知配置、残缺结构或不受支持的 Schema 在写入前失败关闭。
- `upgrade-state.mjs`：仅在显式执行 `codexc state upgrade` 时备份并把状态数据库从 Schema v3
  升级到 v4，并为统一更新入口提供只读版本检查；不自动迁移未知版本。
- `metrics-database-access.mjs`：集中实现 `codexc metrics` 与 WebUI 共用的数据库状态、
  `run`、`turns`、`threads`、`report`、`export` 和周额度只读查询；只打开只读 Store，不加载服务控制或数据库维护流程。
- `metrics-database.mjs` / `metrics-database.d.mts`：保留 `codexc metrics` 的兼容公开入口和 CLI，
  组合只读访问、输出渲染以及 `upgrade`、`reset`、`cleanup`、`prune` 等显式维护命令；查询复用 Observability
  只读端口，渲染复用 `metrics-export-format.mjs`；运行、会话与聚合输出从现有 `compact` 明细
  派生上下文压缩模型、请求数、Token 和费用摘要，JSON/CSV 同时保留可视化字段；`export` CSV 用独立类型行区分请求历史额度快照
  与 OpenAI 当前额度估算摘要，避免重复附加全局状态；upgrade 要求 Gateway 停止并把 Schema v3 备份后
  起逐版本备份后事务升级到 v7，reset 要求 Gateway 停止、检查点回写、`0600`
  备份后移除旧库，不迁移或覆盖原指标记录。服务状态无法确认、处于非停止状态或前台 Gateway
  指标 Socket 仍可连接时均拒绝 reset；`sync-reset` 备份并清零多端上报水位文件（保留
  设备 ID），默认同样要求 Gateway 已停止，`--restart-gateway` 时自动停止并重新启动
  Gateway，用于重放修复中心历史数据。`cleanup` 按 `[metrics.storage]` 或命令行覆盖值创建私有
  备份后清理最旧请求记录，可选 `--vacuum` 立即回收 SQLite 文件空间。
  `prune <provider>` 备份后删除本地与中心库中指定提供商（openai、deepseek）的全部请求
  行，并自动停止、重启 Gateway 与中心服务；任一步骤失败也会尝试把服务重新拉起，额度重置
  后可用它从零重新统计用量。
- `metrics-command-options.mjs` / `metrics-command-options.d.mts`：集中解析并预检 `codexc metrics` 的
  时间范围、分组、格式及维护命令参数；不访问配置、数据库或服务，`metrics-database.mjs` 保留原有
  公开入口与 `metricsRange` 导出。
- `channel-send-image-options.mjs`：集中解析 `codexc channel send-image` 参数，使顶层 CLI 在读取配置前拒绝非法输入。
- `channel-send-image.mjs`：`codexc channel send-image` 的实现，把本地图片复制到
  `data/channel-outbox/pending/` 并写入 manifest；由 Gateway 轮询后按 Thread 绑定
  会话发送并归档，详见 `docs/channel-image.md`。
- `metrics-export-format.mjs` / `metrics-export-format.d.mts`：指标导出的显示上下文（配置与
  汇率缓存）、币种换算、Token/费用/时间格式化与 Markdown/CSV 转义；币种模式解析与 Token
  格式复用 Application/Surface 导出，换算逻辑集中在 `convertCostToCny`。
- `metrics-output-renderer.mjs`：把指标查询结果渲染为 Markdown、JSON 或 CSV；集中处理报告、
  请求明细、Thread、Turn 与当前运行输出，不访问数据库、运行时配置或服务控制。
- `webui-command-options.mjs`：集中解析 `codexc webui` 监听参数，使顶层 CLI 与服务实现复用同一规则。
- `webui-server.mjs` / `webui-api.ts`：`codexc webui` 的只读 HTTP 服务与共享 API 类型。
  默认回环监听并托管 `webui/dist` 静态前端；提供 `/api/v1/overview`、`/api/v1/threads`、
  `/api/v1/threads/:id/run|turns`、`/api/v1/requests`、`/api/v1/errors` 只读 JSON 接口；
  `/api/v1/global/*` 按 `[metrics.view]` 配置由服务端代理到中心服务（前端不接触令牌）；
  Threads 返回指标库首个请求开始时间，请求明细按受控字段在整个时间范围排序后偏移分页；
  `webui-api.ts` 声明接口响应类型，前端统一从该文件导入；监听参数优先取命令行，其次
  `config.toml` 的 `[webui]` 段，默认回环无令牌；绑定非回环地址（`0.0.0.0`）时必须设置
  `--token` 或配置 `token`，API 以 `Authorization: Bearer` 校验并采用常数时间比较。
- `metrics-center-server.mjs`：`codexc center` 的多设备指标中心 HTTP 服务。
  接收各设备 Gateway 的增量上报（独立 Bearer 上报令牌校验、载荷校验、按 `device_id + local_id`
  upsert 覆盖写入），写入中心 SQLite（复用 `cloudflare/migrations/0001_init.sql` 表结构，
  WAL、`0600`），并提供 `/api/overview`、`/api/requests`、`/api/subagents`、
  `/api/devices`、`/api/health`；查询使用独立只读令牌，WebUI 通过 `/api/v1/global/*` 服务端代理读取，令牌不进入前端。
  子命令 `codexc center config` 交互设置 `[metrics.center]`、`codexc center info` 输出
  中心地址（含设备上报端点）、双令牌状态与运行状态；监听参数优先命令行，其次
  `config.toml` 的 `[metrics.center]` 段，默认回环 `127.0.0.1:8790`。
- `metrics-center-settings.mjs`：中心服务与指标脚本共用的轻量配置解析（命令行参数、
  `config.toml` 的 `[metrics.center]` 段与默认值），不依赖 Cloudflare 部署文件。
- `metrics-config-menu.mjs`：指标设置与中心服务设置的交互用例；集中管理本地保留策略、中心接入、
  上报参数、接入状态和中心监听配置，`config.mjs` 只保留顶层配置菜单编排与兼容重导出。
- `metrics-menu.mjs` / `metrics-menu.d.mts`：`codexc metrics` 无参数时的交互用例及注入边界声明；负责收集查询、导出、清理和重置参数，
  通过 CLI 注入的命令边界执行，不承载子进程或输出文件管理。
- `metrics-center-payload.mjs` / `metrics-center-payload.d.mts`：中心服务与历史 Cloudflare
  Worker 共用的上报载荷校验及类型声明。
- `metrics-center-schema.sql`：npm 发布包内中心 SQLite 的规范初始化 Schema；历史 Cloudflare
  D1 migration 保留部署参考，不作为生产中心运行时依赖。
- `setup.mjs`：使用 `@clack/prompts` 提供统一设置类别菜单，并把“模型渠道”“通讯渠道”和
  “技能”流程委派给具体适配器；模型渠道下区分 Codex 官方、DeepSeek、第三方 API 与图片识别。
- `codex-defaults-setup.mjs` / `codex-defaults-setup.d.mts`：从官方模型目录选择 Codex 全局默认模型和思考等级，通过独立 stdio
  App Server 的 `config/read` / `config/batchWrite` 更新用户 `config.toml`；不修改登录凭据或
  Gateway 的 Thread 默认模型。
- `codex-user-config.mjs` / `codex-user-config.d.mts`：统一创建隔离的 stdio App Server Client，把 Codex 官方默认值与
  `multi_agent_v2` / `agents.ds` 普通键级修改作为官方 `config/batchWrite` 事务写入用户配置；
  受控角色修改在同一 Client 中读取原始用户层及版本，并通过 `expectedVersion` 拒绝并发覆盖。
- `skill-setup.mjs` / `skill-setup.d.mts`：`codexc setup` 的“技能”类别；列出项目 `.codex/skills` 下带
  `SKILL.md` 的技能，安装/覆盖到 `~/.agents/skills/<技能名>`（可用
  `CODEX_AGENTS_SKILLS_DIR` 覆盖目标目录），支持卸载；只复制技能目录本身，不修改
  hermes 运行时的 `.skill-lock.json`。
- `config.mjs`：`codexc config` 的顶层交互编排，覆盖配置文件中可安全编辑的参数：
  显示设置（操作详情、计划更新、全局价格显示方式）、系统设置（调试模式、审批超时、
  Sandbox、默认工作区与渠道新会话模型覆盖）、WebUI 设置（监听地址、端口、访问令牌）、指标设置
  （本地保留策略、本机接入中心并同时写入 `[metrics.sync]` 与 `[metrics.view]`、接入状态、上报参数
  `interval_seconds` / `batch_size`、停用接入）、
  Telegram 消息格式和配置路径查看；菜单修改前自动备份配置，非交互终端直接输出
  用户目录与配置文件路径。
- `config-display-menu.mjs`：独立管理操作详情、计划更新、全局价格币种和 Telegram 消息格式；
  只修改对应展示配置段。
- `config-system-menu.mjs`：独立管理调试入口、审批超时、全局 Sandbox、默认 Workspace 和
  Gateway 新 Thread 模型覆盖；调试实现仍委派给 `debug-setup.mjs`。
- `config-webui-menu.mjs`：独立管理 WebUI 监听地址、端口和访问令牌交互；保持公网监听必须配置
  令牌的失败关闭约束，`config.mjs` 只负责把顶层选择路由到该领域菜单。
- `config-workspace-menu.mjs`：管理 `codexc work` 的 Workspace Sandbox、审批策略与 Permission Profile；
  保持 Sandbox 与 Permission Profile 互斥，并只写回被选择的 Workspace 配置。
- `debug-setup.mjs`：在严格配置中原子切换 `logging.level` 的 `debug` / `info`，控制全局脱敏
  调试日志和渠道技术字段，不改写显示设置或凭据。
- `api-provider-setup.mjs` / `api-provider-setup.d.mts`：增改或删除多个 Responses 兼容第三方 API
  提供商，非敏感元数据写入主配置，API Key 按提供商隔离；拒绝删除仍被调用方引用的提供商，
  并可经确认显式转换旧单视觉配置。
- `vision-setup.mjs` / `vision-setup.d.mts`：为双 Provider 与仅 DeepSeek 模式选择已登记的第三方
  API 提供商和视觉模型；不复制 Endpoint 或 API Key，禁用视觉不删除共享提供商。
- `deepseek-setup.mjs`：复用共享的非敏感 DeepSeek Provider 定义，提供 OpenAI/DeepSeek 切换和
  仅 DeepSeek 两种安装模式；只下载、不执行
  DeepSeek 官方脚本，提取唯一模型目录 heredoc 并校验大小、JSON 与 Flash 模型后写入用户
  `CODEX_HOME`。切换模式保持 OpenAI 默认模型与认证不变，按 Codex 新版独立 Profile 文件格式把
  模型、Provider 与 API Key 写入 CLI 使用的 `deepseek.config.toml`，写入不含凭据的 Gateway
  管理标记，并自动开启 `features.multi_agent_v2`、注册 `agents.ds` 子代理角色；
  改为固定模式时只移除本项目管理的 `agents.ds`，不关闭可能供其他角色使用的功能开关；
  首次修改前记录原配置、同名 Profile、管理标记与角色文件是否存在并备份原文，固定模式显式
  确认后才覆盖默认 Provider，恢复选项可精确还原首次安装状态，并在保留的审计备份中记录已恢复
  生命周期。重复安装基于当前配置更新，不从首次备份回滚后续修改；退出固定模式时只还原 Setup
  管理的字段（含自动压缩阈值），恢复后新增的同名用户 Provider 不会被误判为旧版托管配置；
  角色配置事务失败时恢复本次安装前的目标文件，若目标已被其他进程修改则停止回滚并保留外部修改；
  安装与“修改自动压缩阈值”入口支持按上下文窗口百分比（10–95%，默认 60%）写入
  `model_auto_compact_token_limit` 或关闭自动压缩；固定模式的日常阈值修改使用官方键级配置事务，
  完整安装与备份恢复才执行文件级替换。
- `prepare-deepseek-catalog-proposal.mjs` / `prepare-deepseek-catalog-proposal.d.mts` /
  `deepseek-catalog-baseline.json`：复用 Setup 的官方
  下载器，比较排序后的模型完整指纹与上下文、输入模态、思考等级、搜索、并行工具、最低客户端版本
  等有限审查字段，输出候选基线、结构化结果、摘要和失败日志所需现场。模型提示词只参与哈希，不复制
  到仓库；脚本不修改运行时受控模型列表。
- `prepare-deepseek-pricing-proposal.mjs` / `prepare-deepseek-pricing-proposal.d.mts`：有界下载
  DeepSeek 官方价格 HTML，按模型、计价表头、北京时间峰谷文字和生效日期解析语义化表格，与
  `runtime/deepseek-pricing-baseline.json` 比较后输出候选基线、结构化差异、来源哈希和失败报告；
  页面缺列、重复模型、时间重叠或结构无法确认时失败关闭，不在 Gateway 请求路径抓取网页。
- `deepseek-setup.d.mts`：声明 DeepSeek Setup 的公开脚本类型。
- `terminal-prompter.mjs`：为各通讯渠道 Setup 提供最小的终端文本、确认和可见凭据输入接口。
- `telegram-setup.mjs`：独立完成 Telegram Bot Token 验证、一次性私聊配对、用户 ID 获取和用户配置写入；
  复用统一 TOML、环境变量和系统代理解析；交互输入的 Token 在当前终端明文显示，但验证错误
  继续脱敏；新建 Bot 仅引导使用官方 BotFather。
- `feishu-setup.mjs`：提供手动输入凭据和 Device Authorization 扫码两种方式；扫码时由飞书授权页
  选择新建或已有企业自建应用，只申请私聊接收与发送、流式卡片、应用自管理检测、受控配置写入和
  命令中心所需权限、事件与回调。
  两种方式都验证凭据与 Bot 身份，并原子保存 App ID、App Secret 和允许的用户 Open ID；扫码模式
  只保存本次扫码用户，不合并旧名单或追加其他用户；二维码和短期授权状态不持久化。扫码保存后立即
  保留已有菜单并自动发布 `codexc_home` 悬浮菜单、长连接
  事件与卡片回调；失败时保留连接配置，并提示先使用终端 `codexc doctor` 检查、再重新扫码选择
  当前应用恢复，不能依赖尚未收到消息的 `/fs doctor`。手动凭据流程也先由终端 Doctor 检查。
- `weixin-setup.mjs`：从统一 Setup 菜单执行连接替换风险确认、微信扫码和严格结果裁剪，把
  Bot Token 原子写入微信独立安全凭据后端，并只向 TOML 写入禁用态账号与允许用户元数据；
  Setup 不直接启动消息 Surface，操作者显式启用配置并重载 Gateway 后生效。
- `feishu-application.mjs`：为 Setup 与 Doctor 提供带有限超时的飞书凭据/Bot 身份、应用权限、
  消息事件和待审核版本只读探测，不建立消息长连接，并把 SDK 错误和残缺响应收敛为不含敏感详情的
  稳定错误。
- `workspace-command.mjs`：实现 `codexc work` 的参数校验、交互菜单和目录创建，并调用统一的 Workspace 权限设置用例；CLI 入口只负责分发。
- `workspace-config.mjs`：读取、检查和原子更新 TOML 中的 Workspace 配置，通过 `runtime/config-event-queue.mjs` 保证 Gateway 重启窗口内的 Workspace 新增通知可恢复；支持列出失效项、删除注册记录，并恢复固定默认 Workspace。
- `agents.mjs` / `agents.d.mts`：`codexc agents` 的执行脚本与公开声明，在 `~/.codex/config.toml` 中开启或关闭
  `features.multi_agent_v2` 并注册单次 `agents.ds` 角色；角色说明要求主模型以
  `fork_turns=1` 传入当前用户消息；非托管同名角色会失败关闭，不会被覆盖。启用时先原子生成
  无凭据角色文件，再通过带用户层版本校验的官方键级配置事务更新主配置，事务失败时恢复角色文件；
  显式禁用同样拒绝删除非托管同名角色。App Server 服务启动时原子刷新角色文件为
  本机 DeepSeek 统计代理地址，同时写入禁止
  解析加密正文和等待后续消息的受控指令。普通服务退出保留文件以维持 Codex 配置可解析，显式
  禁用、改为固定模式或恢复配置时删除；只读 `status` 不依赖 Gateway 配置。

## 开发与协议

- `dev-all.mjs`：开发模式下复用完整的现有 App Server 拓扑，或通过唯一的内部
  `service-app-server` 入口启动主 App Server、已配置的隔离 Provider App Server 及对应统计代理，
  再启动 Gateway；只复用私有监管身份、Provider 拓扑和真实 WebSocket 健康检查一致的实例，
  Gateway 进程再通过与 Provider 无关的配置级所有权 Socket 拒绝所有入口的重复实例。部分拓扑或裸
  App Server 失败关闭；脚本统一收敛自身启动错误，已经由内部服务入口展示的失败不重复包装。
- `codex-remote.mjs`：为原生 `codex --remote` 选择 Provider Socket 和工作目录；切换模式下规范化
  `--profile deepseek`，既选择隔离实例，也保留 Profile 供 Remote TUI 完成第三方 Provider 认证；
  配置错误由脚本稳定展示，Codex 子进程的终止信号原样向上传播。
- `prepare-codex-upgrade.mjs`：在干净工作区校验精确目标 CLI，调用现有协议生成和版本同步，
  完成基础一致性检查后把差异交给 Codex 审查。
- `codex-release-api.mjs`：为稳定版和 Alpha 解析器调用 GitHub Release API；请求或响应正文
  读取发生网络异常，以及遇到 429 和 5xx 时做三次有限重试，不在错误中输出凭据或上游正文。
- `resolve-codex-release.mjs`：通过 GitHub Release API 解析或验证 `openai/codex` 正式发行版，
  拒绝 Draft、Pre-release 和版本不匹配。
- `resolve-codex-alpha.mjs`：从官方 GitHub Pre-release 列表选择最高版本号的 Alpha，只供隔离
  Canary 使用，不改变正式版本基线。
- `analyze-upgrade-protocol.mjs`：比较 `HEAD` 与升级工作树中的生成协议，报告 RPC 名称、顶层
  类型字段和生成文件变化；只陈述结构差异，不推断行为语义。
- `run-upgrade-validation.mjs`：为正式升级提案和 Alpha Canary 独立运行协议、类型、Lint、测试、
  真实合同、构建和打包检查；单项失败后继续其他阶段，并保存逐项日志和结构化结果。预览阶段不
  改稳定版文档，因此明确跳过文档索引检查。
- `write-upgrade-report.mjs`：把 CI 中生成的升级工作树写成 Markdown 摘要、文件清单、统计和
  二进制安全 Patch，并比较 `HEAD` 生成协议的 RPC 名称和顶层字段结构，合并逐阶段结果；生成
  或验证失败且没有差异时仍会输出报告。
- `check-upgrade-pr-description.mjs`：正式升级 PR 转为 Ready 后，检查描述已把自动占位内容
  替换为本项目的收益、采用项、不采用项及风险与验证；Draft 和普通 PR 跳过。
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
  服务端消息 ID 与 `client_id` 形状，不把回送内容写入日志或 Fixture。
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
- `check-gateway-version.mjs`：校验 npm 包和 Gateway 版本都与 Codex CLI 协议版本一致。
- `check-docs.mjs`：校验项目 Markdown 本地链接、根 `index.md` 文档索引、源码模块索引、协议数字和相关目录
  文件索引，并拒绝已移除的文档名称；常规项目文档检查排除 `.codex/skills/**` 附带的技能参考资料。
- `codex-rules.mjs`：向 CLI 重新导出 `runtime/project-rules.mjs` 的项目定位、规则生成与检查能力。
- `install-git-hooks.mjs`：只为当前源码仓库设置 `.githooks`，不修改用户全局 Git 配置。
- `verify-commit.mjs`：为 pre-commit hook 与 GitHub CI 串行执行统一的完整提交检查。
- `validate-config.mjs`：在安装系统服务前使用已构建的 Gateway 配置模块执行完整校验。

## 构建、打包与服务

- `clean-dist.mjs`：构建前清理 `dist/`。
- `install-global-source.mjs`：显式准备干净源码并通过禁用隐式生命周期脚本的 npm 全局安装
  完成开发入口链接，避免 npm 12 脚本策略跳过构建，并自动执行 webui 子项目依赖安装与
  前端构建（`webui/dist`）。
- `webui-dev.mjs`：仓库根目录 `npm run webui:dev` 的一键开发入口，并行启动
  `codexc webui`（API）与 Vite dev server，任一子进程退出时统一清理另一个进程。
- `package-path.mjs`：提供不依赖第三方包的 npm 包根目录解析。
- `prepare-package.mjs`：源码仓库安装或 npm 打包前按 lockfile 补齐缺失的本地构建依赖、
  启用仓库 Git hooks、构建源码，并验证已安装包包含运行入口。
- `smoke-source-prepare.mjs`：在不含 `node_modules` 和 `dist` 的临时源码副本中验证显式源码
  全局安装命令会完成构建并生成 `codexc` 入口。
- `smoke-package.mjs`：生成实际 tarball，在隔离目录安装并执行公开的 `codexc` 入口与配置预检。
- `check-release-tag.mjs`：要求 Git Tag、`package.json` 与 README 正式版本及安装命令严格一致，
  README 尚未完成正式发布提交时失败关闭。
- `sync-published-readme.mjs`：把受控的 README 正式版本与安装命令渲染为已发布版本；拒绝
  预发布、降级、高于开发基线和缺少受控标记的文档。
- `sync-gateway-version.mjs`：以锁定的 Codex CLI 协议版本同步 `package.json`、锁文件和 Gateway 运行时版本；不维护独立版本号。
- `doctor.mjs`：检查 npm 包、Node、Linux PATH 中的 `bubblewrap`、Codex CLI、当前 TOML 配置、
  Workspace、飞书凭据/Bot 身份、
  微信配置与 Bot 凭据、消息游标检查点、允许用户的加密回复上下文覆盖数和最近保存时间，
  以及微信运行时启用状态；缺少 `bubblewrap` 时说明内置 helper 回退并输出发行版安装命令，
  完成全部检测后按诊断领域只输出失败、提示和处理建议，交互终端区分颜色并汇总各状态数量；
  Doctor 不自动安装或修改 AppArmor，不调用
  `getupdates`，不显示 Token、`context_token` 或游标；
  主 Unix WebSocket、已配置 Provider 的切换或固定配置、实际模型目录、Provider Socket、
  监管身份与 Provider 拓扑、`initialize.userAgent` 中的运行中 App Server 版本与系统服务状态，
  不输出完整 User-Agent、飞书
  上游响应或敏感配置内容。
- `install-launchd.mjs`：渲染并安装 launchd plist；Codex 路径复用共享可执行文件解析，代理由 CLI
  服务入口在每次启动时解析。
- `service-install-context.mjs`：systemd 与 launchd 安装器共用的配置、默认 Workspace、主 Socket、
  Codex/Node 可执行文件及服务 PATH 解析；运行目录统一创建为 `0700`，平台模板和转义仍各自维护。
- `config-activation-notice.mjs`：统一 Gateway 配置写入后的生效提示，明确运行中自动重新读取并在必要时
  自动重启，未运行时由下次启动加载，并统一使用 CLI 提示状态渲染；WebUI、指标中心和 App Server
  的专属重启要求继续单独提示。
- `launchd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载四个 launchd 服务；启停、
  重启、状态和日志支持 `gateway`、`app-server`、`webui`、`center`、`all` 目标，
  WebUI 与指标中心独立不并入 `all`，
  日常重启默认只更新 Gateway；模板为 App Server 与 Gateway 注入各自服务角色，公开 CLI 据此
  拒绝 App Server 内的自重启；
  检测到不支持的旧标签时明确拒绝启动。
- `install-systemd.mjs`：渲染并安装 Linux systemd 用户服务 unit；Codex 路径复用共享可执行文件
  解析，代理由 CLI 服务入口在每次启动时解析。
- `service-target-query.mjs`：把共享服务目录中的 systemd unit 或 launchd label 逐行提供给平台
  控制脚本，避免 Shell 维护第二份服务标识。
- `cli-status.mjs`：让 systemd/launchd 控制脚本复用公开 CLI 的成功、失败、提示和处理状态前缀、
  TTY 颜色及 `NO_COLOR` 规则；日志和数据内容不经过状态渲染。
- `systemd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载四个 systemd 用户服务；
  安装前确保当前用户的 linger 已启用并复查，使用户未登录时也能随系统启动，无法启用则在修改
  unit 状态前失败并显示管理员处理命令；与 launchd 使用相同的目标、服务角色和默认值，WebUI
  与指标中心独立不并入 `all`，用户数据始终保留。

脚本不得把凭据写入 npm 安装目录；用户配置、SQLite、配置事件队列、Socket 和日志必须留在用户级 `.codex-connect`。
