# Git 源码安装

Linux 与 macOS 可以把 Codex Connect 官方 `main` 分支作为完整 Git 仓库安装到：

```text
~/.codex-connect/codex-channels
```

配置、数据库、凭据、Socket、日志和输出仍使用 `~/.codex-connect` 下原有目录，不写入 Git
仓库。Windows Transport 与后台服务尚未支持，因此安装脚本会明确拒绝其他平台。

## 安装

先安装 Node.js 22.13 或更高版本、Git 和 npm，然后运行：

```bash
curl -fsSL https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.sh | sh
```

安装器先在 `~/.codex-connect` 的私有临时目录完成克隆、依赖安装、Gateway 与 WebUI 构建和版本
校验；`main` 中 `package.json` 的版本必须与本机 Codex CLI 一致。成功后才移动为
`codex-channels`。已有同名目录或 `~/.codex-connect/bin/codexc` 时不会覆盖。
安装前会显示 npm 版本和全局目录，并检测已有的 npm 全局版 `@hegenai/codexc` 及当前 `codexc`
命令来源；检测只用于提示，不会自动卸载或修改已有 npm 包。
Codex CLI 是 Gateway 的必需运行时。安装器找不到 `codex` 时，会通过 npm 安装与 `main` 项目版本
一致的 `@openai/codex`；已有版本不匹配时失败关闭，不自动覆盖。安装器使用固定版本官方
`codex login status` 检查登录状态；未登录或状态检查错误不阻止源码安装，用户需先运行该命令诊断，
并在未登录时执行 `codex login`。npm 全局 `bin` 不在 PATH 时，自动安装后会明确停止并提示修正。
脚本会为当前 Shell 配置 `~/.codex-connect/bin`。交互式 Zsh/Bash 安装完成后会询问是否立即进入
已加载源码命令的新 Shell；确认后无需重新打开终端。拒绝、使用其他 Shell 或在非交互环境安装时，
按输出提示重新打开终端或手工更新 PATH。随后执行：

```bash
codexc init
codexc setup
codexc service install
```

源码入口直接运行仓库内 `bin/codexc.mjs`，不会注册 npm 全局包。安装前已有的 npm 全局版不会被
自动卸载；需要清理时由用户显式执行 `npm uninstall -g @hegenai/codexc`。

## 更新

日常更新统一使用：

```bash
codexc update
```

源码模式要求仓库无本地修改或自定义提交，且 `origin` 保持官方 HTTPS 地址。命令比较官方 `main`
与当前 checkout 的 commit；发现新提交后，在临时克隆中确认当前 HEAD 可快进到新 HEAD、项目版本
与本机 Codex CLI 一致，并完成 `npm ci`、Gateway/WebUI 构建以及候选源码对当前配置和数据库的只读
预检。只有这些步骤全部通过，才停止核心服务并切换源码；新源码随后复用统一配置与数据库更新流程
并恢复服务。同一版本号下的修复提交也会更新。npm 安装模式继续只更新配置和数据库，不修改 npm 包。

源码切换前失败不会影响当前仓库和服务。切换后本地更新失败时，新源码会保留，旧仓库保存在错误
消息给出的 `codex-channels.pre-update-*` 路径，避免自动回退到可能不兼容新 Schema 的旧程序。
