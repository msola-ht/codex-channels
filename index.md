# 项目索引

按文档职责查阅：使用指南与现行合同说明当前行为；验收记录维护观察及缺口；待实施方案和历史记录不作为功能已支持或任务已获授权的依据。
文档维护方式见[文档生命周期](docs/development-rules.md#documentation-placement)。历史记录统一放入 `docs/archive/`；现行合同、活动方案和开放验收记录保留在现行目录。

## 使用与配置

- [`README.md`](README.md)：最短安装入口、常用命令和专题导航。
- [`docs/user-guide.md`](docs/user-guide.md)：完整安装、配置、渠道使用、服务管理、升级、本机清理、排障和开发指导。
- [`config.example.toml`](config.example.toml)：Gateway 配置示例。
- [`provider-model-catalog.json`](provider-model-catalog.json)：OCG/CCG 基于 DS 目录扩展 V4.1 的模型 ID 与显示名映射。
- [`startup-network-policy.json`](startup-network-policy.json)：首次网络探测与启动恢复的时限、退避参数。
- [`docs/display.md`](docs/display.md)：渠道展示口径、`/metrics` 命令与调试模式说明。
- [`docs/deepseek.md`](docs/deepseek.md)：DeepSeek 配置模式、终端使用、Provider 切换、网页搜索能力与运行统计。
- [`docs/archive/deepseek-upload-remediation.md`](docs/archive/deepseek-upload-remediation.md)：历史记录，DeepSeek 图片上传调用身份、运行实例一致性、材料 Worker 的关联修复、独立复查与隔离观察。
- [`docs/opencode-go.md`](docs/opencode-go.md)：OpenCode Go 独立 Provider、按需运行与官方目录模型。
- [`docs/cline-pass.md`](docs/cline-pass.md)：CLP 配置、Chat 转换边界与用量。
- [`docs/ccg.md`](docs/ccg.md)：CCG 多账户接入、账户模型目录、额度查询与固定/切换模式。
- [`docs/errors.md`](docs/errors.md)：错误码字典、日志字段约定与排查示例。
- [`docs/webui.md`](docs/webui.md)：本地指标 WebUI 的命令、架构、页面、API、低风险设置、边界与安全。
- [`docs/channel-image.md`](docs/channel-image.md)：渠道图片发送的固定方式、spool 目录与安全边界。
- [`docs/video-analysis-mcp.md`](docs/video-analysis-mcp.md)：独立视频分析 MCP、授权目录、Strata 接口及 Codex 配置。
- [`docs/source-install.md`](docs/source-install.md)：Linux/macOS 与 Windows PowerShell Git 源码安装、目录、更新和失败边界。

## 协议与现行设计

- [`docs/unified-model-management-design.md`](docs/unified-model-management-design.md)：第三方模型统一管理的现行合同、设计取舍、关联审查结论与证据边界，明确默认保护、调用影响与暂不支持范围。
- [`docs/delivery.md`](docs/delivery.md)：关键结果投递箱的容量、状态、离线核对与备份恢复。
- [`docs/management-interface-security.md`](docs/management-interface-security.md)：本机管理写接口的 Bearer 认证、Origin、修订、防重放、任务与审计边界。
- [`docs/windows-support-development.md`](docs/windows-support-development.md)：Windows 开发预览的
  当前边界、实现入口、验证范围与正式发布门槛。
- [`docs/codex-desktop-app-development.md`](docs/codex-desktop-app-development.md)：Codex Desktop App
  与 Gateway 共享主 OpenAI App Server 的桥接架构、安全合同、跨平台边界与实机验收限制。
- [`docs/index.md`](docs/index.md)：Codex 协议基线、支持矩阵和实现入口。
- [`docs/upstream-sources.md`](docs/upstream-sources.md)：Codex、飞书与微信的上游源码基线及待升级候选。
- [`docs/codex-cli-upgrade-decisions.md`](docs/codex-cli-upgrade-decisions.md)：当前项目的采用范围、
  不采用原因、重新评估条件与基线升级影响。
- [`docs/thread-queue-revert-development.md`](docs/thread-queue-revert-development.md)：原生 Thread Queue、
  分页历史与 Revert 的授权边界和验收链路。
- [`docs/thread-usage-development.md`](docs/thread-usage-development.md)：
  OpenAI Thread 官方估算合入现有 `/usage` 的数据口径、降级、模块与验证边界。
- [`docs/scheduled-tasks-development.md`](docs/scheduled-tasks-development.md)：计划任务的宿主调度、
  App Server 执行边界、持久化、安全状态机与验收范围。
- [`docs/surface-integration-guide.md`](docs/surface-integration-guide.md)：新增通讯渠道指南。
- [`docs/provider-integration-guide.md`](docs/provider-integration-guide.md)：新增第三方模型
  Provider 的标准流程、安全边界、当前目录布局与旧版本恢复边界、用户配置主 Provider 支持和验收清单。
- [`docs/provider-api-relay-development.md`](docs/provider-api-relay-development.md)：Provider 模型 API
  当前转发合同：独立服务、原生 Chat/Responses、提供商接入、鉴权与队列、指标与转储、数据格式及验收边界。
- [`docs/user-agent-customization.md`](docs/user-agent-customization.md)：默认官方 TUI 客户端
  身份、App Server 上报终端标识与模型上游 User-Agent 覆盖的配置、生命周期、安全边界和验证方案。
- [`docs/model-timezone.md`](docs/model-timezone.md)：模型请求里 environment context 的时区与日期
  来源、`codex.timezone` 配置、`codexc timezone` 命令、WebUI 时间跟随与生效边界。
- [`docs/opencode-go-multi-account.md`](docs/opencode-go-multi-account.md)：OpenCode Go
  多账户实现（账户文件、CLI/Setup、账户代理、会话切换与租约生命周期）。
- [`docs/feishu-surface-plan.md`](docs/feishu-surface-plan.md)：飞书 Surface 当前设计决策与停止条件。
- [`docs/feishu-reference-index.md`](docs/feishu-reference-index.md)：飞书资料与实现映射。
- [`docs/weixin-surface-plan.md`](docs/weixin-surface-plan.md)：微信 Surface 当前设计决策与停止条件。

## 验收与开放补证

- [`docs/project-closeout-review.md`](docs/project-closeout-review.md)：五轮收尾审查汇总与逐批处理状态，记录 45 项问题、关联证据、修复建议、关闭条件及运行验证边界。
- [`docs/project-closeout-remediation-plan.md`](docs/project-closeout-remediation-plan.md)：Astra 分批关联复审与26批历史修复记录；包含基于main的169文件整分支审查、M01–M04本地修复提交、保留风险与实际观察；暂停推送PR，10万条以上请求全面审查待用户部署重启后开始。
- [`docs/project-closeout-file-inventory.csv`](docs/project-closeout-file-inventory.csv)：1,146 项逐文件关联阅读证据，清单范围已全部完成；不代表问题修复或运行验收。
- [`docs/webui-component-remediation.md`](docs/webui-component-remediation.md)：WebUI 组件浏览器发现、关联修复、A 独立复查与最终证据；保留未观察的 UI 验收范围。
- [`docs/ipc-readiness-development.md`](docs/ipc-readiness-development.md)：IPC 读取与启动恢复改造的阶段计划、关联审查、观察证据及平台限制。
- [`docs/channel-acceptance-matrix.md`](docs/channel-acceptance-matrix.md)：Telegram、飞书和微信的持续验收入口，分别记录已观察能力与未完成平台边界。
- [`docs/codex-desktop-app-acceptance.md`](docs/codex-desktop-app-acceptance.md)：Desktop 专项验收主记录，保留 Linux 证据及 macOS、Windows 等开放事项。
- [`docs/provider-transaction-review.md`](docs/provider-transaction-review.md)：Provider 事务修复的历史证据与仍开放的 V03/V04 环境补证清单。

## 待实施方案

- [`docs/relay-codex-auth-development.md`](docs/relay-codex-auth-development.md)：Model Relay 复用本机 Codex 登录态的候选设计，尚未实施；保留 WSS、头部与授权等待决边界。

## 历史审查与研究记录

以下记录保留原基线、结论及未观察限制；其中的旧执行顺序不是当前开发流程，重新使用证据前须确认适用范围。

- [`docs/archive/global-settings-consolidation.md`](docs/archive/global-settings-consolidation.md)：全局设置归纳的历史实施步骤、三轮 Astra 关联审查、隔离观察与交付边界；现行合同见 WebUI 与用户指南。

- [`docs/archive/webui-review-plan.md`](docs/archive/webui-review-plan.md)：WebUI W01–W16 审查、10 项整改、逐批复查及完成后相对 `main` 的 A 独立审查历史；保留提交、隔离观察和未观察边界，现行合同见 WebUI 文档。

- [`docs/archive/cli-review.md`](docs/archive/cli-review.md)：CLI 两轮审查及六批修复的历史记录；25 条确认发现与三项文案澄清已处理，保留逐批独立复查、提交、实际观察及平台限制。
- [`docs/archive/consolidation-review.md`](docs/archive/consolidation-review.md)：已完成统一治理的历史审查、决策依据和证据限制；U16 的现行 IPC 边界维护在 Runtime 文档。
- [`docs/archive/chain-verification-review.md`](docs/archive/chain-verification-review.md)：已完成 L01–L19 阶段的历史审查、修复与证据记录；保留未观察边界，不作为新一轮计划。
- [`docs/archive/codex-daemon-review.md`](docs/archive/codex-daemon-review.md)：原生 daemon 的历史研究与隔离观察，保留未采用原因和重新评估条件。
- [`docs/archive/codex-image-fileid-probe.md`](docs/archive/codex-image-fileid-probe.md)：原生图片引用的历史脱敏观察、复现条件及验收限制；现行使用入口见记录内链接。
- [`docs/archive/custom-provider-capability-probe.md`](docs/archive/custom-provider-capability-probe.md)：特定提供商在记录时的能力与思考参数观察，不代表当前服务或所有提供商的支持保证。

## 源码与运行

- [`src/README.md`](src/README.md)：源码模块与边界。
- [`webui/README.md`](webui/README.md)：WebUI 前端模块、组件约定与开发入口。
- [`src/delivery/README.md`](src/delivery/README.md)：独立持久投递模块及公开接口。
- [`src/model-api/README.md`](src/model-api/README.md)：纯模型 API 消息与流式转换模块。
- [`src/model-relay/README.md`](src/model-relay/README.md)：独立模型 API 的身份、准入与撤销模块。
- [`src/surfaces/README.md`](src/surfaces/README.md)：通讯渠道公共边界。
- [`bin/README.md`](bin/README.md)：npm CLI 入口。
- [`runtime/README.md`](runtime/README.md)：CLI 与 Gateway 共享运行时。
- [`scripts/README.md`](scripts/README.md)：配置、构建、验证和服务脚本。
- [`launchd/README.md`](launchd/README.md)：macOS 服务模板与控制。
- [`systemd/README.md`](systemd/README.md)：Linux 用户服务模板与控制。

## 工程约束

- [`AGENTS.md`](AGENTS.md)：常驻项目边界、安全与交付约束，以及按任务触发的规则入口。
- [`docs/development-rules.md`](docs/development-rules.md)：按需读取的开发流程、关联修复、文档生命周期，以及协议、存储、授权、服务、验证与交付规则。
- [`docs/codex-cli-upgrade.md`](docs/codex-cli-upgrade.md)：Codex CLI 升级与发布的专题流程，保留版本、协议及发布授权要求。
- [`.githooks/README.md`](.githooks/README.md)：提交前检查。
- [`.github/workflows/README.md`](.github/workflows/README.md)：CI 与升级提案工作流。
- [`.codex/rules/default.rules`](.codex/rules/default.rules)：项目安全命令预设。
- [`LICENSE`](LICENSE)：MIT License。
