# GitHub Actions

本目录保存仓库的持续集成工作流。

## 文件

- `ci.yml`：在 push、Pull Request 和手动触发时，分别使用 Ubuntu 与 macOS、Node.js 22.13.0 执行锁文件安装、类型和版本检查、单元测试，以及真实 tarball 隔离安装冒烟；Ubuntu 覆盖 systemd unit 渲染，macOS 额外校验 launchd 模板。
- `publish.yml`：推送与 Codex CLI 协议版本一致的 `v*` Tag 后，使用 npm Trusted Publishing 验证、构建并发布公开包，不保存长期 npm Token。

启用发布工作流前，需要在 npm 包的 Trusted Publisher 设置中绑定 GitHub 仓库 `msola-ht/codex-channels`、工作流文件 `publish.yml`，并允许 `npm publish`。工作流使用 GitHub OIDC 和 `id-token: write` 获取短期凭据。

工作流只申请 `contents: read`，Checkout 不保留写入凭据。同一分支的新运行会取消旧运行。依赖本机登录态和锁定 Codex CLI 的协议检查、真实 App Server 冒烟测试不在公共 Runner 上执行。

项目不维护独立版本号；`@hegenai/codexc`、Gateway 和发布 Tag 均直接使用锁定的 Codex CLI 版本。升级协议后运行 `npm run protocol:generate` 会自动同步版本，也可以单独执行 `npm run version:sync`。
