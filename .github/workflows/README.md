# GitHub Actions

本目录保存仓库的持续集成工作流。

## 文件

- `ci.yml`：在 push、Pull Request 和手动触发时，分别使用 Ubuntu 与 macOS、Node.js 22.13.0
  执行与本地 pre-commit hook 相同的 `npm run verify:commit`，覆盖提交差异、类型和版本、生产与测试
  Lint、文档链接和索引、全量测试、Shell、真实 tarball 与干净源码安装冒烟及平台模板检查。
  独立的 App Server 合同任务安装锁定的 Codex CLI 0.146.0，检查协议版本与生成类型，并使用隔离
  `CODEX_HOME` 验证 Fast 默认值的跨客户端读取和新 Thread 状态。
- `codex-upgrade-preview.yml`：每日及手动检查 `openai/codex` 正式发行版本；版本留空时使用
  最新正式 Release。项目已经同步时跳过，发现更新时安装对应 npm CLI、生成协议与版本
  差异，独立运行协议、类型、Lint、全量测试、真实合同、构建和打包检查，把逐项结果写入 Job
  Summary，并上传结构化结果、逐阶段日志、协议结构影响、清单、统计、完整 Patch 和摘要
  Artifact。单项失败不阻止其他检查，最终仍把任务标为失败。该工作流拒绝 Draft、Pre-release
  和降级；自动检查全部通过时，独立的最小写权限 Job 将已验证 Patch 提交到自动化分支并创建
  Draft PR，同版本已有开放提案时不重复创建。它不自动转为 Ready、合并、发布或部署。官方
  Release 解析失败时仍上传以 `unresolved-<run id>` 命名的失败 Artifact 和 `resolve.log`，
  不会因目标版本为空丢失现场。
- `codex-upgrade-pr.yml`：在正式升级 PR 打开、更新、编辑或转为 Ready 时检查描述；Draft
  阶段允许自动占位内容，Ready 后必须写清对本项目的收益、本次采用、本次不采用及风险与验证。
  普通 PR 不受此检查影响。
- `codex-alpha-canary.yml`：每天选择 `openai/codex` 最高版本号的官方 Alpha，在临时 Runner
  生成协议，并使用与正式预览相同的独立兼容检查和报告。成功或失败都会上传完整现场，失败后
  任务标红；Release 解析失败同样保留 `unresolved` 报告；结果只作前向兼容预警，不进入正式
  版本基线。
- `publish.yml`：推送与 Codex CLI 协议版本一致的 `v*` Tag 后，执行同一完整提交检查，再使用
  npm Trusted Publishing 发布公开包，不保存长期 npm Token。合并升级 PR 或普通 push 不会发布；
  GitHub Release、本机安装、服务重启和部署也不由该工作流执行。完整收尾步骤见
  [`docs/codex-cli-upgrade.md`](../../docs/codex-cli-upgrade.md)。

启用发布工作流前，需要在 npm 包的 Trusted Publisher 设置中绑定 GitHub 仓库 `msola-ht/codex-channels`、工作流文件 `publish.yml`，并允许 `npm publish`。工作流使用 GitHub OIDC 和 `id-token: write` 获取短期凭据。

除正式升级提案的 Draft PR Job 外，工作流只申请 `contents: read`，Checkout 不保留写入凭据。
Draft PR Job 单独申请 `contents: write` 和 `pull-requests: write`，只用于推送自动化升级分支和
创建提案。同一升级工作流串行运行，不在推送分支或创建 PR 时取消前一轮。隔离 App Server 合同
测试不读取 Runner 登录态、不调用模型；依赖账号、模型列表或指定 fixture Thread 的完整真实集成
测试仍只在本机按需执行。

仓库 Settings → Actions → General 需要允许 GitHub Actions 创建 Pull Request，但默认工作流
权限继续保持只读。自动提案使用仓库 `GITHUB_TOKEN`，不保存长期 PAT；GitHub 可能要求维护者批准
该自动 PR 的首次 CI 运行。

GitHub Actions 使用 `npm ci --ignore-scripts`，不会修改 Runner 的 Git hook 配置；随后直接调用
`npm run verify:commit`。本地 `npm ci`、`npm install` 或 `npm run hooks:install` 则启用
仓库内 `.githooks/pre-commit`，两端共享同一个检查入口。

项目不维护独立版本号；`@hegenai/codexc`、Gateway 和发布 Tag 均直接使用锁定的 Codex CLI
正式发行版本。升级提案只认 `openai/codex` GitHub Release 中非 Draft、非 Pre-release 的
`rust-v<版本>`；生成后仍由 Codex 按 `docs/codex-cli-upgrade.md` 审查和适配。完成升级时必须
同步更新 `ci.yml` 中 App Server 合同任务安装的 Codex CLI 精确版本。Alpha Canary 是隔离测试，
不得据此修改 `main` 的协议基线、公开接口或固定版本文档。自动提案阶段因此将文档索引检查记录为
跳过；正式适配后必须由 `npm run verify:commit` 完成文档和全部提交门禁。
