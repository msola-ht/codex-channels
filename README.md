# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hegenai/codexc)](https://www.npmjs.com/package/@hegenai/codexc)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20Preview-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。Gateway 与 `codexc remote` 共享同一个 Codex App Server，因此聊天渠道和原生 TUI 可以继续使用同一组 Thread、Workspace 和运行状态。

当前 `main` 开发基线：`0.155.1`；当前正式版：`0.155.1`。

完整安装、配置、渠道命令、服务管理、升级、排障和开发说明见[《Codex Connect 使用指导》](docs/user-guide.md)。

## 快速开始

安装正式版配套 CLI：

```bash
npm install -g @openai/codex@0.155.1
npm install -g @hegenai/codexc@0.155.1
```

初始化、配置并安装后台服务：

```bash
codexc init
codexc setup
codexc work add
codexc service install
codexc doctor
```

源码安装：

```bash
curl -fsSL https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.sh | sh
```

Windows PowerShell 7（开发验证入口，尚未纳入公开正式支持）：

```powershell
irm https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.ps1 | iex
```

源码安装的目录、更新、代理和 Windows 处理见[`源码安装与更新`](docs/source-install.md)。
本地开发源码执行 `npm run install:global` 后，再运行 `codexc update` 同步配套 Codex CLI。

## 常用入口

```bash
codexc setup                 # Provider、渠道和项目技能接入
codexc config                # Codex 新会话偏好与 Gateway 日常设置
codexc cleanup               # 统一交互归档会话、清理转储和维护指标
codexc timezone              # App Server 与 WebUI 时区；--gateway 设置网关时区
codexc service status        # 查看服务状态
codexc service restart all   # 重启 Gateway 与全部 App Server
codexc doctor                # 只读诊断
codexc metrics               # 查询和导出本机模型请求指标
codexc traffic               # 查看模型请求与响应转储
codexc webui                 # 启动本地指标与设置 WebUI
codexc sessions              # 交互式会话归档菜单
codexc update                # 更新受管源码、同步配套 CLI 并检查数据库升级
codexc remote                # 连接 Gateway 共享的原生 TUI
codexc desktop-app status    # 检查 Desktop App 共享连接与 macOS 内置工具 Host（预览）
```

首次接入使用 `setup`，日常设置使用 `config`，数据维护使用 `cleanup`。清理菜单的五项操作、服务启停要求和会话归档示例见[本机清理与归档](docs/user-guide.md#本机清理与归档)。在聊天渠道发送 `/help` 查看可用命令。

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
DS、OCG、CCG 支持多账户，在 `codexc setup → 模型与提供商` 中管理。旧单账户需要先确认移除再重新添加，更新器不执行账户迁移；具体命令见下面的提供商文档。

## 专题文档

- [完整使用指导](docs/user-guide.md)
- [源码安装与更新](docs/source-install.md)
- [渠道展示与本地指标](docs/display.md)
- [错误字典](docs/errors.md)
- [本地指标 WebUI](docs/webui.md)
- [DeepSeek 多账户管理](docs/deepseek.md)
- [OpenCode Go](docs/opencode-go.md)
- [CCG（CommandCode）](docs/ccg.md)
- [Provider 接入指南](docs/provider-integration-guide.md)
- [官方协议与源码索引](docs/index.md)
- [Codex Desktop App 共享 App Server 实施方案](docs/codex-desktop-app-development.md)
- [项目文档索引](index.md)

## 本地开发

```bash
git clone https://github.com/msola-ht/codex-channels.git
cd codex-channels
npm ci
npm run check
npm run lint
npm run docs:check
npm test
```

协议升级、上游参考仓库和真实 App Server 合同必须遵循[`上游源码维护规则`](docs/upstream-sources.md)与[`Codex CLI 升级流程`](docs/codex-cli-upgrade.md)。

## License

[MIT](LICENSE)
