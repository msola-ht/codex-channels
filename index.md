# 项目索引

## 使用与配置

- [`README.md`](README.md)：安装、配置、日常使用、排障和升级。
- [`config.example.toml`](config.example.toml)：Gateway 配置示例。
- [`docs/deepseek.md`](docs/deepseek.md)：DeepSeek 配置模式、终端使用、Provider 切换与运行统计。
- [`docs/vision.md`](docs/vision.md)：双 Provider 与仅 DeepSeek 的图片识别代理配置和安全边界。

## 协议与设计

- [`docs/index.md`](docs/index.md)：Codex 协议基线、支持矩阵和实现入口。
- [`docs/channel-acceptance-matrix.md`](docs/channel-acceptance-matrix.md)：Telegram、飞书和微信验收状态。
- [`docs/upstream-sources.md`](docs/upstream-sources.md)：飞书与微信上游源码基线。
- [`docs/codex-cli-upgrade.md`](docs/codex-cli-upgrade.md)：Codex CLI 升级流程。
- [`docs/codex-cli-upgrade-decisions.md`](docs/codex-cli-upgrade-decisions.md)：各正式版本对本项目的
  采用、暂缓和拒绝决策。
- [`docs/surface-integration-guide.md`](docs/surface-integration-guide.md)：新增通讯渠道指南。
- [`docs/feishu-surface-plan.md`](docs/feishu-surface-plan.md)：飞书 Surface 当前设计决策与停止条件。
- [`docs/feishu-reference-index.md`](docs/feishu-reference-index.md)：飞书资料与实现映射。
- [`docs/weixin-surface-plan.md`](docs/weixin-surface-plan.md)：微信 Surface 当前设计决策与停止条件。

## 源码与运行

- [`src/README.md`](src/README.md)：源码模块与边界。
- [`src/surfaces/README.md`](src/surfaces/README.md)：通讯渠道公共边界。
- [`bin/README.md`](bin/README.md)：npm CLI 入口。
- [`runtime/README.md`](runtime/README.md)：CLI 与 Gateway 共享运行时。
- [`scripts/README.md`](scripts/README.md)：配置、构建、验证和服务脚本。
- [`tests/README.md`](tests/README.md)：测试范围与集成验证。
- [`launchd/README.md`](launchd/README.md)：macOS 服务模板与控制。
- [`systemd/README.md`](systemd/README.md)：Linux 用户服务模板与控制。

## 工程约束

- [`AGENTS.md`](AGENTS.md)：项目开发约束。
- [`.githooks/README.md`](.githooks/README.md)：提交前检查。
- [`.github/workflows/README.md`](.github/workflows/README.md)：CI 与发布工作流。
- [`.codex/rules/default.rules`](.codex/rules/default.rules)：项目安全命令预设。
- [`LICENSE`](LICENSE)：MIT License。
