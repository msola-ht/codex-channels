# GitHub Actions

本目录保存仓库的持续集成工作流。

## 文件

- `ci.yml`：在 push、Pull Request 和手动触发时，分别使用 Ubuntu 与 macOS、Node.js 22.13.0 执行锁文件安装、类型和版本检查、单元测试、构建及 npm 包内容检查；macOS 额外校验 launchd 模板。

工作流只申请 `contents: read`，Checkout 不保留写入凭据。同一分支的新运行会取消旧运行。依赖本机登录态和锁定 Codex CLI 的协议检查、真实 App Server 冒烟测试不在公共 Runner 上执行。
