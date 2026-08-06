# 项目脚本

本目录保存 npm CLI 和开发流程调用的 Node.js、Shell 脚本。脚本处理本机配置、构建、协议生成和服务管理，不承载 Gateway 的会话业务逻辑。

## 配置与 Workspace

- `runtime-config.mjs`：解析用户数据目录和运行时路径，并初始化 `.codex-connect`；为只读诊断提供
  不修改配置权限的路径定位，启动与写入流程仍显式收紧目录和配置文件权限。
- `upgrade-state.mjs`：仅在显式执行 `codexc state upgrade` 时备份并把状态数据库从 Schema v3
  升级到 v4；不自动迁移未知版本。
- `metrics-database.mjs` / `metrics-database.d.mts`：实现并声明只读 `codexc metrics` 的
  `status`、`run`、`turns`、`threads`、`report`、`export`、`upgrade` 与 `reset`；查询复用 Observability
  只读端口，渲染复用 `metrics-export-format.mjs`；运行、会话与聚合输出从现有 `compact` 明细
  派生上下文压缩模型、请求数、Token 和费用摘要，JSON/CSV 同时保留可视化字段；`export` CSV 用独立类型行区分请求历史额度快照
  与 OpenAI 当前额度估算摘要，避免重复附加全局状态；upgrade 要求 Gateway 停止并把 Schema v3 备份后
  事务升级到 v4，reset 要求 Gateway 停止、检查点回写、`0600`
  备份后移除旧库，不迁移或覆盖原指标记录。服务状态无法确认、处于非停止状态或前台 Gateway
  指标 Socket 仍可连接时均拒绝 reset。
- `metrics-export-format.mjs` / `metrics-export-format.d.mts`：指标导出的显示上下文（配置与
  汇率缓存）、币种换算、Token/费用/时间格式化与 Markdown/CSV 转义；币种模式解析与 Token
  格式复用 Application/Surface 导出，换算逻辑集中在 `convertCostToCny`。
- `webui-server.mjs` / `webui-api.ts`：`codexc webui` 的只读 HTTP 服务与共享 API 类型。
  默认回环监听并托管 `webui/dist` 静态前端；提供 `/api/v1/overview`、`/api/v1/threads`、
  `/api/v1/threads/:id/run|turns`、`/api/v1/requests`、`/api/v1/errors` 只读 JSON 接口；
  `webui-api.ts` 声明接口响应类型，前端统一从该文件导入；绑定非回环地址时建议提供
  `--token` 访问令牌，API 以 `Authorization: Bearer` 校验并采用常数时间比较。
- `setup.mjs`：使用 `@clack/prompts` 提供统一设置类别菜单，并把“模型渠道”“通讯渠道”和
  “系统设置”流程委派给具体适配器；模型渠道下区分 DeepSeek、第三方 API 与图片识别，系统设置
  提供全局调试模式入口。
- `config.mjs`：`codexc config` 的交互式配置与设置菜单，覆盖配置文件中可安全编辑的参数：
  显示设置（操作详情、计划更新、按提供商的价格显示方式）、系统设置（调试模式、审批超时、
  Sandbox、默认工作区与模型）、Telegram 消息格式和配置路径查看；非交互终端直接输出用户目录
  与配置文件路径。
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
  `CODEX_HOME`。切换模式保持基础配置不变，按 Codex 新版独立 Profile 文件格式把模型、Provider
  与 API Key 写入 CLI 使用的 `deepseek.config.toml`，并写入不含凭据的 Gateway 管理标记；
  首次修改前记录原配置和同名 Profile 是否存在并备份原文，固定模式显式
  确认后才覆盖默认 Provider，恢复选项可精确还原首次安装状态，并在保留的审计备份中记录已恢复
  生命周期。重复安装基于当前配置更新，不从首次备份回滚后续修改；退出固定模式时只还原 Setup
  管理的字段（含自动压缩阈值），恢复后新增的同名用户 Provider 不会被误判为旧版托管配置；
  安装与“修改自动压缩阈值”入口支持按上下文窗口百分比（10–95%，默认 60%）写入
  `model_auto_compact_token_limit` 或关闭自动压缩。
- `deepseek-setup.d.mts`：声明 DeepSeek Setup 的公开脚本类型。
- `terminal-prompter.mjs`：为各通讯渠道 Setup 提供最小的终端文本、确认和可见凭据输入接口。
- `telegram-setup.mjs`：独立完成 Telegram Bot Token 验证、一次性私聊配对、用户 ID 获取和用户配置写入；
  复用统一 TOML、环境变量和系统代理解析；交互输入的 Token 在当前终端明文显示，但验证错误
  继续脱敏；新建 Bot 仅引导使用官方 BotFather。
- `feishu-setup.mjs`：提供手动输入凭据和 Device Authorization 扫码两种方式；扫码时由飞书授权页
  选择新建或已有企业自建应用，只申请私聊发送、流式卡片、应用自管理检测、受控配置写入和命令中心
  所需权限、事件与回调。
  两种方式都验证凭据与 Bot 身份，并原子保存 App ID、App Secret 和允许的用户 Open ID；二维码和
  短期授权状态不持久化。扫码保存后立即保留已有菜单并自动发布 `codexc_home` 悬浮菜单、长连接
  事件与卡片回调；失败时保留连接配置并提示通过 `/fs doctor` 恢复。手动凭据流程仍由
  `/fs doctor` 完成应用授权与发布。
- `weixin-setup.mjs`：从统一 Setup 菜单执行连接替换风险确认、微信扫码和严格结果裁剪，把
  Bot Token 原子写入微信独立安全凭据后端，并只向 TOML 写入禁用态账号与允许用户元数据；
  Setup 不直接启动消息 Surface，操作者显式启用配置并重载 Gateway 后生效。
- `feishu-application.mjs`：为 Setup 与 Doctor 提供带有限超时的飞书凭据/Bot 身份只读探测，
  不建立消息长连接，并把 SDK 错误和残缺响应收敛为不含敏感详情的稳定错误。
- `workspace-config.mjs`：读取、检查和原子更新 TOML 中的 Workspace 配置，通过 `runtime/config-event-queue.mjs` 保证 Gateway 重启窗口内的 Workspace 新增通知可恢复；支持列出失效项、删除注册记录，并恢复固定默认 Workspace。
- `workspace-add.mjs`：把指定目录或命令调用目录注册为 Workspace，支持 `--prune-missing` 清理失效配置。

## 开发与协议

- `dev-all.mjs`：开发模式下复用或启动主 App Server 与已配置的隔离 Provider App Server，再启动 Gateway。
- `codex-remote.mjs`：为原生 `codex --remote` 选择 Provider Socket 和工作目录；切换模式下规范化
  `--profile deepseek`，既选择隔离实例，也保留 Profile 供 Remote TUI 完成第三方 Provider 认证。
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
  完成开发入口链接，避免 npm 12 脚本策略跳过构建。
- `package-path.mjs`：提供不依赖第三方包的 npm 包根目录解析。
- `prepare-package.mjs`：源码仓库安装或 npm 打包前按 lockfile 补齐缺失的本地构建依赖、
  启用仓库 Git hooks、构建源码，并验证已安装包包含运行入口。
- `smoke-source-prepare.mjs`：在不含 `node_modules` 和 `dist` 的临时源码副本中验证显式源码
  全局安装命令会完成构建并生成 `codexc` 入口。
- `smoke-package.mjs`：生成实际 tarball，在隔离目录安装并执行公开的 `codexc` 入口与配置预检。
- `check-release-tag.mjs`：要求 Git Tag 与 `package.json` 版本严格一致，防止发布错版。
- `sync-published-readme.mjs`：把受控的 README 正式版本与安装命令渲染为已发布版本；拒绝
  预发布、降级、高于开发基线和缺少受控标记的文档。
- `sync-gateway-version.mjs`：以锁定的 Codex CLI 协议版本同步 `package.json`、锁文件和 Gateway 运行时版本；不维护独立版本号。
- `doctor.mjs`：检查 npm 包、Node、Codex CLI、当前 TOML 配置、Workspace、飞书凭据/Bot 身份、
  微信配置与 Bot 凭据、消息游标检查点、允许用户的加密回复上下文覆盖数和最近保存时间，
  以及微信运行时启用状态；Doctor 不调用 `getupdates`，不显示 Token、`context_token` 或游标；
  主 Unix WebSocket、已配置 Provider 的切换或固定配置、实际模型目录、Provider Socket、
  `initialize.userAgent` 中的运行中 App Server 版本与系统服务状态，不输出完整 User-Agent、飞书
  上游响应或敏感配置内容。
- `install-launchd.mjs`：渲染并安装 launchd plist；代理由 CLI 服务入口在每次启动时解析。
- `launchd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载两个 launchd 服务；启停、
  重启、状态和日志支持 `gateway`、`app-server`、`all` 目标，日常重启默认只更新 Gateway；模板为
  App Server 与 Gateway 注入各自服务角色，公开 CLI 据此拒绝 App Server 内的自重启；
  检测到不支持的旧标签时明确拒绝启动。
- `install-systemd.mjs`：渲染并安装 Linux systemd 用户服务 unit；代理由 CLI 服务入口在每次启动时解析。
- `systemd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载两个 systemd 用户服务；
  与 launchd 使用相同的目标、服务角色和默认值，用户数据始终保留。

脚本不得把凭据写入 npm 安装目录；用户配置、SQLite、配置事件队列、Socket 和日志必须留在用户级 `.codex-connect`。
