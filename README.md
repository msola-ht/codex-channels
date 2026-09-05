# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hegenai/codexc)](https://www.npmjs.com/package/@hegenai/codexc)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。Gateway 与 `codexc remote` 共享同一个 Codex App Server，因此聊天渠道和原生 TUI 可以继续使用同一组 Thread、Workspace 和运行状态。

当前 `main` 开发基线：`0.153.4`；当前正式版：`0.150.1`。

完整安装、配置、渠道命令、服务管理、升级、排障和开发说明见[《Codex Connect 使用指导》](docs/user-guide.md)。

## 快速开始

安装正式版配套 CLI：

```bash
npm install -g @openai/codex@0.150.1
npm install -g @hegenai/codexc@0.150.1
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

Windows PowerShell 7：

```powershell
irm https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.ps1 | iex
```

源码安装的目录、更新、代理和 Windows 处理见[`源码安装与更新`](docs/source-install.md)。

## 常用入口

```bash
codexc setup                 # Codex 用户设置、Provider、渠道和项目技能
codexc config                # Gateway 显示、系统、服务、代理、WebUI 和指标设置
codexc service status        # 查看服务状态
codexc service restart all   # 重启 Gateway 与全部 App Server
codexc doctor                # 只读诊断
codexc sessions              # 交互式会话清理菜单
codexc sessions cleanup 3    # 预览 Turn 数较少的旧会话（交互终端加 --confirm 再确认）
codexc update                # 源码安装更新
codexc remote                # 连接 Gateway 共享的原生 TUI
```

计划清单工具在 `codexc setup → Codex 新会话默认值 → 计划清单工具` 中管理，默认关闭。它与 Gateway 的 `display.plan_updates` 渠道展示开关和 `/plan` 协作模式相互独立，具体说明见[使用指导](docs/user-guide.md#计划相关设置)。

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

## 专题文档

- [完整使用指导](docs/user-guide.md)
- [源码安装与更新](docs/source-install.md)
- [渠道展示与统计](docs/display.md)
- [错误字典](docs/errors.md)
- [WebUI](docs/webui.md)
- [DeepSeek](docs/deepseek.md)
- [OpenCode Go](docs/opencode-go.md)
- [Provider 接入指南](docs/provider-integration-guide.md)
- [官方协议与源码索引](docs/index.md)
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
