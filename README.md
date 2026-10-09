# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20Preview-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。Gateway 与 `codexc remote` 共享同一个 Codex App Server，因此聊天渠道和原生 TUI 可以继续使用同一组 Thread、Workspace 和运行状态。

当前 `main` 开发基线：`0.160.1`。项目通过 Git 源码安装和更新，不再发布新的 npm 版本。

完整安装、配置、渠道命令、服务管理、升级、排障和开发说明见[《Codex Connect 使用指导》](docs/user-guide.md)。

## 快速开始

安装 Node.js 22.13+、Git 和 npm 后，从官方 `main` 安装：

```bash
curl -fsSL https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.sh | sh
```

初始化、配置并安装后台服务：

```bash
codexc init
codexc setup
codexc work add
codexc install
codexc doctor
```

Windows PowerShell 7（开发验证入口，尚未纳入公开正式支持）：

```powershell
irm https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.ps1 | iex
```

源码安装的目录、更新、代理和 Windows 处理见[`源码安装与更新`](docs/source-install.md)。
官方安装器与本地 `npm run install:global` 都会将缺失或版本不符的默认 Codex CLI 同步为项目锁定版本，随后运行 `codexc init`、`codexc setup`、`codexc install`。
安装和更新统一从本机终端执行。官方受管仓库用 `codexc update` 更新；本地工作树更新后重新运行 `npm run install:global`，服务停启见[本地工作树安装与部署](docs/source-install.md#本地工作树安装与部署)。
仍使用 `service` 命名空间的旧版需先按[源码安装与更新说明](docs/source-install.md)手动安装新版本，不能直接用旧更新器跨越此次命令改版。

## 常用入口

```bash
codexc                       # 交互主菜单（非交互终端显示帮助）
codexc setup                 # Provider、渠道和项目技能接入
codexc config                # Codex 新会话偏好与 Gateway 日常设置
codexc cleanup               # 统一交互归档会话、清理转储和维护指标
codexc timezone              # App Server 与 WebUI 时区；--gateway 设置网关时区
codexc work                  # 新建或注册已有工作区、管理权限
codexc                       # 主菜单 → 后台服务
codexc run                   # 前台运行核心服务
codexc start                 # 启动全部后台服务，含已安装 WebUI 与已启用 Relay
codexc status                # 查看全部后台服务状态
codexc restart               # 重启全部后台服务：Gateway、App Server、WebUI、已启用 Relay
codexc restart gateway       # 只重启 Gateway
codexc doctor                # 只读诊断
codexc metrics               # 查询和导出本机模型请求指标
codexc relay status          # 查询可选模型 API 转发进程
codexc traffic               # 查看模型请求与响应转储
codexc reset-credit list     # 查询 OpenAI 可用重置券；use 交互确认使用
codexc webui                 # 启动本地指标与设置 WebUI
codexc update                # 更新受管源码、同步配套 CLI 并校验当前数据库
codexc uninstall             # 自动识别并卸载当前程序，保留用户数据
codexc remote                # 连接 Gateway 共享的原生 TUI
codexc remote -p ds-main     # 用已配置的完整 Provider ID 连接隔离实例
codexc app      # 启动共享 Desktop App；首次确认后自动启用（预览）
codexc app -p ds-main # 本次连接已配置的隔离实例；切换前退出 Desktop（预览）
codexc app --provider agg # API Key 切换提供商聚合到同一桌面模型目录（预览）
codexc remote --provider agg # 终端使用相同聚合目录；渠道从 /model 选择
```

首次接入使用 `setup`，日常设置使用 `config`，数据维护使用 `cleanup`。清理菜单的五项操作、服务启停要求和会话归档示例见[本机清理与归档](docs/user-guide.md#本机清理与归档)。在聊天渠道发送 `/help` 查看可用命令。
Desktop 聚合模式的账户前提、重启要求和会话限制见 [Desktop 共享说明](docs/user-guide.md#codex-desktop-app-共享macos--windows-预览)。
`remote` 与 `app` 的 `-p` / `--provider` 共用 Provider ID、已登记的规范 `sf-*` Profile 名称及
`agg` / `sf-agg` 选择；两个入口默认连接主实例。完整规则与 Remote 的个人 `--profile` 用法见[用户指南](docs/user-guide.md)。

## 配置位置

Gateway 配置：

```text
~/.codex-connect/config.toml
```

Codex 用户配置：

```text
~/.codex/config.toml
```

共享代理通过 `codexc config → 网络代理` 设置，保存在 `~/.codex/.env`，见[代理设置](docs/user-guide.md#代理与权限)。

配置示例见[`config.example.toml`](config.example.toml)。不要把 Token、Cookie 或 Authorization Header 写入日志或提交到仓库。
DS、OCG、CCG、CLP 使用当前多账户结构，在 `codexc setup → 模型与提供商` 中添加和管理；具体命令见下面的提供商文档。

## 专题文档

- [完整使用指导](docs/user-guide.md)
- [源码安装与更新](docs/source-install.md)
- [渠道展示与本地指标](docs/display.md)
- [关键结果投递与离线恢复](docs/delivery.md)
- [错误字典](docs/errors.md)
- [本地指标 WebUI](docs/webui.md)
- [DeepSeek 多账户管理](docs/deepseek.md)
- [OpenCode Go](docs/opencode-go.md)
- [CCG（CommandCode）](docs/ccg.md)
- [CLP（Cline Pass）](docs/cline-pass.md)
- [Provider 模型 API 转发：原生 Chat/Responses、提供商接入、调用方密钥与指标](docs/provider-api-relay-development.md)
- [Provider 接入指南](docs/provider-integration-guide.md)
- [官方协议与源码索引](docs/index.md)
- [Codex Desktop App 共享 App Server](docs/codex-desktop-app-development.md)
- [渠道图片输入与支持范围](docs/user-guide.md#正常发图与图片引用)
- [项目文档索引](index.md)

## 本地开发

```bash
git clone https://github.com/msola-ht/codex-channels.git
cd codex-channels
npm ci
# 按改动选择类型、Lint 或文档检查
npm run check
```

本地提交自动执行按改动范围选择的静态检查与构建；PR CI 执行跨平台静态检查与构建。
完整检查入口为 `npm run verify:ci`，具体范围见[CI 流程](.github/workflows/README.md)。
本项目不新增或维护自动化测试。交付须记录具体反例尝试及实际输出，并观察至少一条真实用户路径；
无法观察的行为须明确说明。测试结果、静态检查与构建均不能替代这些行为证据。

协议升级和上游参考仓库必须遵循[`上游源码维护规则`](docs/upstream-sources.md)与[`Codex CLI 升级流程`](docs/codex-cli-upgrade.md)。

## License

[MIT](LICENSE)
