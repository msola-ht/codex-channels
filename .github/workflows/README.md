# GitHub Actions

本目录保存仓库的持续集成工作流。

## 文件

- `ci.yml`：在 Pull Request 和手动触发时，使用 Ubuntu 与 macOS、Node.js 22.13.0 执行与本地
  pre-commit hook 相同的 `npm run verify:commit`，并使用 Windows latest 执行独立的构建、类型、文档、
  PowerShell 语法和 CLI 帮助冒烟。Windows Job 不运行 Unix 专属服务检查。Branch Protection 要求 PR 的当前
  merge ref 通过全部门禁并禁止直接写入 `main`，因此 push 不再重复运行同一检查。检查覆盖提交
  差异、类型和版本、生产与测试 Lint、文档链接和索引、全量测试、Shell、真实 tarball 安装冒烟
  及平台模板检查；tarball 冒烟复用同次完整测试已经生成的 Gateway 构建产物和 npm 下载缓存，每次仍在新的临时目录安装依赖，干净源码安装不进入
  日常 PR 门禁，并在日志中记录各阶段与全部检查耗时。
  独立的 App Server 合同任务安装锁定的 Codex CLI 0.156.1，检查协议版本与生成类型，并使用隔离
  `CODEX_HOME` 验证 Fast 默认值的跨客户端读取和新 Thread 状态。真实工具合同需要 Linux user namespace；
  合同 Job 与升级预览 Job 参照锁定版 [Codex CI 设置](https://github.com/openai/codex/blob/rust-v0.156.1/.github/actions/setup-ci/action.yml)，
  在临时 Ubuntu Runner 启用 `kernel.unprivileged_userns_clone`，并在该项存在时关闭
  `kernel.apparmor_restrict_unprivileged_userns`。这是运行器准备，不关闭 Codex 文件或网络沙箱，
  不修改用户服务、生产配置或 GitHub Token 权限。
- `codex-upgrade-preview.yml`：每日及手动检查 `openai/codex` 正式发行版本；版本留空时使用
  最新正式 Release。项目已经同步时跳过，发现更新时安装对应 npm CLI、生成协议与版本
  差异，在安装根目录与 WebUI 锁定依赖后独立运行协议、类型、Lint、全量测试、真实合同、Gateway/WebUI
  构建和打包检查；当前工作树构建成功后供测试与 tarball 安装复用，前置失败明确跳过依赖项，干净源码安装独立验证。把逐项结果写入 Job
  Summary，并上传结构化结果、逐阶段日志、协议结构影响、清单、统计、完整 Patch 和摘要
  Artifact。单项失败不阻止其他检查，最终仍把任务标为失败。该工作流拒绝 Draft、Pre-release
  和降级；自动检查全部通过时，独立的最小写权限 Job 将已验证 Patch 提交到自动化分支并创建
  Draft PR，同版本已有开放提案时不重复创建。它不自动转为 Ready、合并、发布或部署。官方
  Release 解析失败时仍上传以 `unresolved-<run id>` 命名的失败 Artifact 和 `resolve.log`，
  不会因目标版本为空丢失现场。
- `codex-upgrade-pr.yml`：统一检查 PR 描述；Draft 阶段允许模板或自动占位内容，所有 Ready PR
  至少在新增、修复、改动之一说明具体变化，无内容分类可省略，保留章节不得为空或仅有占位。正式 Codex CLI 升级 PR 还必须写清
  对本项目的收益、本次采用、本次不采用及风险与验证。Job 名 `Project benefits and tradeoffs`
  为兼容 main 的现有 Branch Protection 保留。
项目不再发布 npm 包，也不提供 Tag 触发的发布工作流。`package.json` 设置 `private: true`；npm 仍用于依赖安装、源码构建和本地 tarball 安装验证。历史 Tag 和 npm 包保持不变。GitHub Release 如需创建，按[升级与发布指南](../../docs/codex-cli-upgrade.md)取得明确授权后手动处理。

除 Codex 正式升级的 Draft PR Job 外，工作流只申请 `contents: read`，
Checkout 不保留写入凭据。Draft PR Job 单独申请 `contents: write` 和 `pull-requests: write`，
只用于推送对应自动化分支和创建提案。隔离 App Server 合同测试不读取 Runner
登录态、不调用模型；依赖账号、模型列表或指定 fixture Thread 的完整真实集成测试仍只在本机按需执行。

仓库 Settings → Actions → General 需要允许 GitHub Actions 创建 Pull Request；默认工作流权限
继续保持只读。自动提案使用仓库 `GITHUB_TOKEN`，不保存长期 PAT。

安装 WebUI 的任务将根目录和 `webui/package-lock.json` 一起纳入 npm 缓存键。
GitHub Actions 分别对根目录和 `webui` 使用 `npm ci --ignore-scripts`，不会修改 Runner 的 Git
hook 配置；随后直接调用 `npm run verify:commit`。本地 `npm ci`、`npm install` 或
`npm run hooks:install` 则启用仓库内 `.githooks/pre-commit`，两端共享同一个检查入口。

项目不维护独立基础版本号；`@hegenai/codexc`、Gateway 和发布 Tag 使用锁定的 Codex CLI
正式发行版本，候选版和修复版只允许增加受控的 `-rc.N` 或 `-fixN` 后缀。升级提案只认
`openai/codex` GitHub Release 中非 Draft、非 Pre-release 的
`rust-v<版本>`；生成后仍由 Codex 按 `docs/codex-cli-upgrade.md` 审查和适配。升级时必须
同时审查 Artifact 的 `public-cli-impact.md` 与 `protocol-impact.md`，前者报告本项目实际转发参数
及枚举值的新增、删除和变化，后者报告 App Server 生成协议结构；两者不能互相替代。完成升级时必须
同步更新 `ci.yml` 中 App Server 合同任务安装的 Codex CLI 精确版本。自动提案阶段不修改稳定版
文档，因此将文档索引检查记录为跳过；正式适配后必须由 `npm run verify:commit` 完成文档和全部
提交门禁。

真实 App Server 合同还覆盖自定义 Responses Provider：两个独立模型目录、配置读取、模型选择与函数工具往返；升级验证复用同一合同。
