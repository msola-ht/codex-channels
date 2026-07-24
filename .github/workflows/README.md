# GitHub Actions

本目录保存仓库的持续集成工作流。

## 文件

- `ci.yml`：在 push、Pull Request 和手动触发时，分别使用 Ubuntu 与 macOS、Node.js 22.13.0
  执行与本地 pre-commit hook 相同的 `npm run verify:commit`，覆盖提交差异、类型和版本、生产与测试
  Lint、文档链接和索引、全量测试、Shell、真实 tarball 与干净源码安装冒烟及平台模板检查。
  独立的 App Server 合同任务安装锁定的 Codex CLI 0.145.0，检查协议版本与生成类型，并使用隔离
  `CODEX_HOME` 验证 Fast 默认值的跨客户端读取和新 Thread 状态。
- `codex-upgrade-preview.yml`：每天自动检查，也可手动选择 `openai/codex` 正式发行版本；留空
  则使用最新正式 Release。项目已经同步时跳过，发现更新时安装对应 npm CLI、生成协议与版本
  差异，把基线提交、文件清单和统计写入 Job Summary，并上传清单、统计、完整 Patch 和摘要
  Artifact。生成失败时仍先上传日志和现场，再把任务标为失败。该工作流拒绝 Draft、Pre-release
  和降级，不提交或部署。
- `codex-alpha-canary.yml`：每天选择 `openai/codex` 最高版本号的官方 Alpha，在临时 Runner
  生成协议，运行协议一致性、类型、全量测试和隔离 App Server 合同测试。成功或失败都会上传
  安装、生成、验证日志及完整差异，失败后任务标红；结果只作前向兼容预警，不进入正式版本基线。
- `publish.yml`：推送与 Codex CLI 协议版本一致的 `v*` Tag 后，执行同一完整提交检查，再使用 npm Trusted Publishing 发布公开包，不保存长期 npm Token。

启用发布工作流前，需要在 npm 包的 Trusted Publisher 设置中绑定 GitHub 仓库 `msola-ht/codex-channels`、工作流文件 `publish.yml`，并允许 `npm publish`。工作流使用 GitHub OIDC 和 `id-token: write` 获取短期凭据。

工作流只申请 `contents: read`，Checkout 不保留写入凭据。同一分支的新运行会取消旧运行。隔离 App Server 合同测试不读取 Runner 登录态、不调用模型；依赖账号、模型列表或指定 fixture Thread 的完整真实集成测试仍只在本机按需执行。

GitHub Actions 使用 `npm ci --ignore-scripts`，不会修改 Runner 的 Git hook 配置；随后直接调用
`npm run verify:commit`。本地 `npm ci`、`npm install` 或 `npm run hooks:install` 则启用
仓库内 `.githooks/pre-commit`，两端共享同一个检查入口。

项目不维护独立版本号；`@hegenai/codexc`、Gateway 和发布 Tag 均直接使用锁定的 Codex CLI
正式发行版本。升级预览只认 `openai/codex` GitHub Release 中非 Draft、非 Pre-release 的
`rust-v<版本>`；生成后仍由 Codex 按 `docs/codex-cli-upgrade.md` 审查和适配。完成升级时必须
同步更新 `ci.yml` 中 App Server 合同任务安装的 Codex CLI 精确版本。Alpha Canary 是隔离测试，
不得据此修改 `main` 的协议基线、公开接口或固定版本文档。
