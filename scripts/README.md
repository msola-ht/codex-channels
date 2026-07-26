# 项目脚本

本目录保存 npm CLI 和开发流程调用的 Node.js、Shell 脚本。脚本处理本机配置、构建、协议生成和服务管理，不承载 Gateway 的会话业务逻辑。

## 配置与 Workspace

- `runtime-config.mjs`：解析用户数据目录和运行时路径，并初始化 `.codex-connect`。
- `setup.mjs`：使用 `@clack/prompts` 提供统一设置类别菜单，并从“通讯渠道”把流程委派给具体适配器。
- `terminal-prompter.mjs`：为各通讯渠道 Setup 提供最小的终端文本、确认和可见凭据输入接口。
- `telegram-setup.mjs`：独立完成 Telegram Bot Token 验证、一次性私聊配对、用户 ID 获取和用户配置写入；
  复用统一 TOML、环境变量和系统代理解析；交互输入的 Token 在当前终端明文显示，但验证错误
  继续脱敏；新建 Bot 仅引导使用官方 BotFather。
- `feishu-setup.mjs`：提供手动输入凭据和 Device Authorization 扫码两种方式；扫码时由飞书授权页
  选择新建或已有企业自建应用，只申请私聊文本所需权限和事件。两种方式都验证凭据与 Bot 身份，
  并原子保存 App ID、App Secret 和允许的用户 Open ID；二维码和短期授权状态不持久化。
- `feishu-application.mjs`：为 Setup 与 Doctor 提供带有限超时的飞书凭据/Bot 身份只读探测，
  不建立消息长连接，并把 SDK 错误和残缺响应收敛为不含敏感详情的稳定错误。
- `workspace-config.mjs`：读取、检查和原子更新 TOML 中的 Workspace 配置，通过 `runtime/config-event-queue.mjs` 保证 Gateway 重启窗口内的 Workspace 新增通知可恢复；支持列出失效项、删除注册记录，并恢复固定默认 Workspace。
- `workspace-add.mjs`：把指定目录或命令调用目录注册为 Workspace，支持 `--prune-missing` 清理失效配置。

## 开发与协议

- `dev-all.mjs`：开发模式下复用或启动 App Server，再启动 Gateway。
- `codex-remote.mjs`：为原生 `codex --remote` 选择 Socket 和工作目录。
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
- `run-upgrade-validation.mjs`：为正式升级预览和 Alpha Canary 独立运行协议、类型、Lint、测试、
  真实合同、构建和打包检查；单项失败后继续其他阶段，并保存逐项日志和结构化结果。预览阶段不
  改稳定版文档，因此明确跳过文档索引检查。
- `write-upgrade-report.mjs`：把 CI 中生成的升级工作树写成 Markdown 摘要、文件清单、统计和
  二进制安全 Patch，并比较 `HEAD` 生成协议的 RPC 名称和顶层字段结构，合并逐阶段结果；生成
  或验证失败且没有差异时仍会输出报告。
- `protocol-schema.mjs`：在同一文件系统临时生成、逐文件比较并安全替换协议类型目录。
- `generate-protocol.mjs`：先在临时目录调用当前 Codex CLI 生成协议，成功后替换协议类型、
  记录版本并同步 npm/Gateway 版本。
- `check-protocol.mjs`：校验本机 Codex CLI 版本，并重新生成到临时目录确认类型逐文件一致。
- `check-gateway-version.mjs`：校验 npm 包和 Gateway 版本都与 Codex CLI 协议版本一致。
- `check-docs.mjs`：校验 Markdown 本地链接、根文档索引、源码模块索引、协议数字和相关目录文件
  索引，并拒绝已移除的文档名称。
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
- `sync-gateway-version.mjs`：以锁定的 Codex CLI 协议版本同步 `package.json`、锁文件和 Gateway 运行时版本；不维护独立版本号。
- `doctor.mjs`：检查 npm 包、Node、Codex CLI、当前 TOML 配置、Workspace、飞书凭据/Bot 身份、
  Unix WebSocket、`initialize.userAgent` 中的运行中 App Server 版本与系统服务状态，不输出
  完整 User-Agent、飞书上游响应或敏感配置内容。
- `install-launchd.mjs`：渲染并安装 launchd plist；代理由 CLI 服务入口在每次启动时解析。
- `launchd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载两个 launchd 服务；启停、
  重启、状态和日志支持 `gateway`、`app-server`、`all` 目标，日常重启默认只更新 Gateway；
  检测到不支持的旧标签时明确拒绝启动。
- `install-systemd.mjs`：渲染并安装 Linux systemd 用户服务 unit；代理由 CLI 服务入口在每次启动时解析。
- `systemd-control.sh`：安装、启停、热加载、查看状态与日志，以及卸载两个 systemd 用户服务；
  与 launchd 使用相同的目标和默认值，用户数据始终保留。

脚本不得把凭据写入 npm 安装目录；用户配置、SQLite、配置事件队列、Socket 和日志必须留在用户级 `.codex-connect`。
