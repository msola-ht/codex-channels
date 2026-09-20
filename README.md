# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hegenai/codexc)](https://www.npmjs.com/package/@hegenai/codexc)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows%20Preview-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。Gateway 与 `codexc remote` 共享同一个 Codex App Server，因此聊天渠道和原生 TUI 可以继续使用同一组 Thread、Workspace 和运行状态。

当前 `main` 开发基线：`0.155.1`（尚未发布）；当前正式版：`0.154.0`。

完整安装、配置、渠道命令、服务管理、升级、排障和开发说明见[《Codex Connect 使用指导》](docs/user-guide.md)。

## 快速开始

安装正式版配套 CLI：

```bash
npm install -g @openai/codex@0.154.0
npm install -g @hegenai/codexc@0.154.0
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
本地开发源码执行 `npm run install:global` 后，再运行 `codexc update` 同步配套 Codex CLI 和本地配置。
首次执行 0.155.1 的 `codexc update` 会将用户主配置的推理摘要设为关闭，后续更新保留重新选择的值，见[推理摘要设置](docs/user-guide.md#推理摘要)。

## 常用入口

```bash
codexc setup                 # Codex 用户设置、Provider、渠道和项目技能
codexc config                # Gateway 显示、系统、自动化、代理、WebUI 和本地指标存储
codexc timezone              # 模型可见的时区与当前日期（App Server 与 WebUI）
codexc service status        # 查看服务状态
codexc service restart all   # 重启 Gateway 与全部 App Server
codexc doctor                # 只读诊断
codexc metrics               # 查询、导出和维护本机模型请求指标
codexc traffic               # 查看模型请求与响应转储（列表、详情、跟随或确认清理）
codexc webui                 # 启动本地指标与设置 WebUI
codexc sessions              # 交互式会话清理菜单
codexc sessions cleanup 3    # 预览 Turn 数较少的旧会话（交互终端加 --confirm 再确认）
codexc update                # 源码安装更新
codexc remote                # 连接 Gateway 共享的原生 TUI
codexc desktop-app status    # 检查 Desktop App 共享连接与 macOS 内置工具 Host（预览）
```

计划清单工具在 `codexc setup → Codex 新会话默认值 → 计划清单工具` 中管理，默认关闭。它与 Gateway 的 `display.plan_updates` 渠道展示开关和 `/plan` 协作模式相互独立，具体说明见[使用指导](docs/user-guide.md#计划相关设置)。

符合 OpenAI 后端权益的账户在普通用量耗尽后，会把当前 Session 自动切换到 Luna Reserve；当前 Gateway 进程持续运行、账户和 Thread 未切换且原模型仍可用时，会在普通用量恢复后切回。失败的消息需要重新发送，细节见[渠道展示与本地指标](docs/display.md#luna-reserve-自动回退)。

模型请求指标保存在本机 `request-metrics.sqlite3`，由 `codexc metrics` 和本地 WebUI 读取；当前部署不包含远程指标中心或云端同步服务。

## 配置位置

Gateway 配置：

```text
~/.codex-connect/config.toml
```

Codex 用户配置：

```text
~/.codex/config.toml
```

配置示例见[`config.example.toml`](config.example.toml)。不要把 Token、Cookie 或 Authorization Header 写入日志或提交到仓库。
旧版自动补入的空 `api_providers = []` 会由更新器备份后移除；非空旧配置需按[使用指导](docs/user-guide.md#5-后台服务与更新)手工处理。

## 专题文档

- [完整使用指导](docs/user-guide.md)
- [源码安装与更新](docs/source-install.md)
- [渠道展示与本地指标](docs/display.md)
- [错误字典](docs/errors.md)
- [本地指标 WebUI](docs/webui.md)
- [DeepSeek](docs/deepseek.md)
- [OpenCode Go](docs/opencode-go.md)
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
