# 项目索引

## 使用与配置

- [`README.md`](README.md)：安装、配置、日常使用、排障和升级。
- [`config.example.toml`](config.example.toml)：Gateway 配置示例。
- [`docs/display.md`](docs/display.md)：渠道展示口径、`/metrics` 命令与调试模式说明。
- [`docs/deepseek.md`](docs/deepseek.md)：DeepSeek 配置模式、终端使用、Provider 切换、网页搜索能力与运行统计。
- [`docs/vision.md`](docs/vision.md)：双 Provider 与仅 DeepSeek 的图片识别代理配置和安全边界。
- [`docs/errors.md`](docs/errors.md)：错误码字典、日志字段约定与排查示例。
- [`docs/webui.md`](docs/webui.md)：本地只读指标 WebUI 的命令、架构、页面、API、边界与安全。
- [`docs/metrics-sync.md`](docs/metrics-sync.md)：多设备指标增量同步的本地配置、载荷与边界。
- [`docs/channel-image.md`](docs/channel-image.md)：渠道图片发送的固定方式、spool 目录与安全边界。
- [`docs/source-install.md`](docs/source-install.md)：Linux/macOS Git 源码安装、目录、更新和失败边界。

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
- [`cloudflare/README.md`](cloudflare/README.md)：曾用的 Cloudflare Worker + D1 + Pages 中心方案（已停用，保留参考）。
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
