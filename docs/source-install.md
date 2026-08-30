# Git 源码安装

Linux、macOS 与 Windows 可以把 Codex Connect 官方 `main` 分支作为完整 Git 仓库安装到：

```text
~/.codex-connect/codex-channels
```

配置、数据库、凭据、Socket、日志和输出仍使用 `~/.codex-connect` 下原有目录，不写入 Git
仓库。Windows 使用 PowerShell 7 和当前用户计划任务；在全部 Windows 发布门槛通过前，该入口仍属于
开发验证，不代表项目已经公开支持 Windows。

## 安装

先安装 Node.js 22.13 或更高版本、Git 和 npm，然后运行：

```bash
curl -fsSL https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.sh | sh
```

Windows PowerShell 7 使用仓库根目录的安装器：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
& .\install.ps1
```

该脚本要求 Git、Node.js 22.13+、npm 和固定版本 Codex CLI；缺少 Codex CLI 时会通过 `npm.cmd`
安装精确版本。它只使用当前用户目录，不要求管理员权限；安装失败会清理临时目录和不完整源码。
默认克隆官方 `main`；本地开发验证可显式传入 `-Repository <本地仓库路径> -Branch <分支>`，该参数不改变
正式安装默认值。安装器会在 Git checkout 时启用长路径支持，以覆盖 Windows 深层源码目录。

安装器先在 `~/.codex-connect` 的私有临时目录完成克隆、依赖安装、Gateway 与 WebUI 构建和版本
校验；`main` 中 `package.json` 的版本必须与本机 Codex CLI 一致。成功后才移动为
`codex-channels`。已有同名目录时不会覆盖。安装前会显示 npm 版本和全局目录，并检测已有的 npm
全局版 `@hegenai/codexc` 及当前 `codexc` 命令来源；源码构建完成后会用当前 `main` 构建结果替换
当前 Node.js 环境中的同名全局包。
Codex CLI 是 Gateway 的必需运行时。安装器找不到 `codex` 时，会通过 npm 安装与 `main` 项目版本
一致的 `@openai/codex`；已有版本不匹配时失败关闭，不自动覆盖。安装器使用固定版本官方
`codex login status` 检查登录状态；未登录或状态检查错误不阻止源码安装，用户需先运行该命令诊断，
并在未登录时执行 `codex login`。npm 全局 `bin` 不在 PATH 时，自动安装后会明确停止并提示修正。
安装器把构建产物打成临时 npm 包并安装到 `npm prefix --global`，因此不会把源码路径显示为 npm
依赖，也不会写入 `.zshrc`、`.bashrc` 或 `.profile`。安装使用当前 Node.js 环境的全局目录；使用
fnm、nvm 等版本管理器时，切换 Node.js 版本也会切换对应的全局命令。随后执行：

```bash
codexc init
codexc setup
codexc service install
```

Git 仓库用于跟踪和构建 `main`，日常命令由构建后的 npm 全局包提供。安装器会给仓库写入仅位于
`.git/config` 的受管标记和本次 npm 全局目录，不修改工作树。

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

候选源码完成构建和只读预检后，如其要求的 Codex CLI 版本与本机不一致，交互终端会显示当前版本和
目标版本，并询问是否现在全局安装精确的 `@openai/codex` 版本；提示为 `[Y/n]`，直接回车表示确认。
安装成功并复核版本后继续同一次源码更新。输入 `N/n`、安装失败或从脚本/管道等非交互终端运行时，
不停止服务、不切换源码，并显示可手动执行的安装与重试命令。

源码切换前失败不会影响当前仓库和服务。切换后刷新全局命令或本地更新失败时，新源码会保留，旧
仓库保存在错误消息给出的 `codex-channels.pre-update-*` 路径，避免自动回退到可能不兼容新 Schema
的旧程序；命令仍会尝试恢复已停止的核心服务，恢复也失败时会同时报告更新与服务错误。

更新会显示当前与远程 `main` 提交、候选源码克隆、构建预检和切换结果。依赖安装与构建成功时只显示
阶段摘要；失败时输出对应工具的完整错误。源码切换后会重新打包并刷新 npm 全局命令。旧版
`~/.codex-connect/bin/codexc`、`.bin/codexc` 入口及其 Shell PATH 配置会在首次更新时清理。

## 卸载

```bash
codexc uninstall
```

该命令先卸载后台服务，再删除受管 Git 仓库及安装、更新时记录的 `@hegenai/codexc` 全局包，并
清理旧安装写入 `.zshrc`、`.bashrc`、`.bash_profile` 或 `.profile` 的 Codex Connect PATH 配置块。
`config.toml`、数据库、凭据、日志和输出保留；Codex CLI 不会被删除。命令只接受带受管标记的源码
安装；旧版未标记仓库必须同时满足官方 origin、`main` 分支、正确包名且无未提交修改。遇到符号
链接、不匹配的源码目录或非本项目旧入口时会拒绝删除。直接从 npm Registry 安装的版本仍使用
`codexc service uninstall` 和 `npm uninstall -g @hegenai/codexc`。
