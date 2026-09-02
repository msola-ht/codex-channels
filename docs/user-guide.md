# Codex Connect 使用指导

本文是 Codex Connect Gateway 的完整用户指导。根目录 [README.md](../README.md) 只保留安装入口、最短配置路径和常用链接；遇到具体问题时按本文或对应专题文档继续阅读。

## 1. 工作方式

Gateway 把 Telegram、飞书和微信消息接入本机 Codex App Server。`codexc remote` 连接的是同一个 App Server，因此原生 TUI 与聊天渠道共享 Thread、Workspace、模型提供商和实时运行状态。

App Server 是 Thread、Turn、Item 和会话历史的唯一事实来源。Gateway 只保存渠道与 Workspace 的最小绑定，不复制完整会话文件或消息正文。

## 2. 安装

### 已发布版本

安装配套的 Codex CLI 与 Gateway：

```bash
npm install -g @openai/codex@0.150.1
npm install -g @hegenai/codexc@0.150.1
```

安装或升级后，重启服务并检查：

```bash
codexc service restart all
codexc doctor
```

### Git 源码安装

Linux/macOS：

```bash
curl -fsSL https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.sh | sh
```

Windows PowerShell 7：

```powershell
irm https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.ps1 | iex
```

源码安装会构建项目并注册全局 `codexc` 命令。目录、代理、Windows ACL、源码更新和失败恢复见[源码安装与更新](source-install.md)。

## 3. 初始化与配置

```bash
codexc init
codexc setup
codexc config
```

Gateway 配置位于：

```text
~/.codex-connect/config.toml
```

`codexc setup` 管理 Codex 用户设置、模型 Provider、渠道和项目技能；`codexc config` 管理 Gateway 显示、服务、代理、Workspace、WebUI 和指标中心。配置示例见 [`config.example.toml`](../config.example.toml)。

Telegram、飞书和微信至少启用一个。Telegram 需要 Bot Token 和允许用户；飞书需要应用凭据和允许的 `open_id`；微信需要扫码凭据、账号和允许用户，并将 `weixin.enabled` 设为 `true`。

### 计划相关设置

在 `codexc setup → Codex 新会话默认值 → 计划清单工具` 中控制上游 `update_plan` 工具，默认关闭：

```toml
[tools.update_plan]
enabled = true
```

三个设置不要混淆：

| 设置 | 作用 |
| --- | --- |
| `tools.update_plan.enabled` | 模型是否拥有创建/更新待办清单的工具，默认关闭 |
| `display.plan_updates` | Gateway 是否把 `turn/plan/updated` 通知展示到渠道，默认开启 |
| `/plan` | 是否使用官方 Plan 协作模式 |

上游计划工具关闭时不会产生普通计划清单通知；`display.plan_updates` 不能替代它。修改 Codex 用户设置后运行 `codexc service restart all`。

### 代理与权限

无法直连 OpenAI 时，在 Gateway 配置中设置 HTTP(S) 代理：

```toml
[network]
https_proxy = "http://127.0.0.1:7890"
```

Windows 不自动读取 WinINET/WinHTTP，只使用 TOML 或标准代理环境变量。Workspace 只能从已登记项目中选择，并可分别设置 Sandbox、审批策略或 Permission Profile；不会接受聊天用户提交的任意绝对路径。

## 4. Workspace、Provider 与终端

登记项目：

```bash
cd /absolute/path/to/project
codexc work add
codexc work list [--json]
```

管理模型 Provider：

```bash
codexc setup
codexc primary-provider list [--json]
codexc primary-provider switch <Provider ID> [模型]
```

DeepSeek、OpenCode Go、自定义 Provider 和多账户说明分别见 [`DeepSeek 使用说明`](deepseek.md)、[`OpenCode Go 使用说明`](opencode-go.md)、[`Provider 接入指南`](provider-integration-guide.md) 和 [`OpenCode Go 多账户`](opencode-go-multi-account.md)。

继续使用聊天会话：

```bash
codexc remote
codexc remote resume
codexc remote --profile sf-deepseek resume
```

直接运行 `codex` 会创建独立 TUI，不共享 Gateway Thread；需要共享会话时使用 `codexc remote`。跨 Provider 切换会创建目标 Provider 的新 Thread，不复制原 Provider 历史。

## 5. 后台服务与更新

安装、检查和重启：

```bash
codexc service install
codexc service status
codexc service restart all
codexc service logs -n 200
```

默认情况下 `start`、`stop`、`status` 操作全部核心服务；`restart`、`logs` 默认只操作 Gateway。App Server 与 Gateway 是独立目标，渠道内禁止停止或重启 App Server。

Linux 使用 systemd 用户服务；Windows 使用当前用户计划任务和隐藏的 PowerShell 7 进程，不需要管理员权限。Windows 私有配置 ACL 修复：

```powershell
codexc security repair
```

源码安装的日常升级统一使用：

```bash
codexc update
codexc doctor
```

更新会先检查官方 `main`、Codex CLI 公开合同、用户设置、数据库和服务状态，再在停机窗口中更新并恢复服务。数据库阶段同时处理状态库、指标库和可重建的会话展示缓存；缓存版本不兼容时会先备份再重建，不影响会话正文。`codexc update` 会提示计划清单工具当前状态；`codexc doctor` 只读诊断该设置。详细边界见 [`Codex CLI 升级流程`](codex-cli-upgrade.md) 和 [`升级决策记录`](codex-cli-upgrade-decisions.md)。

卸载但保留用户数据：

```bash
codexc uninstall
```

npm 安装版也可以使用 `codexc service uninstall` 后执行 `npm uninstall -g @hegenai/codexc`。

## 6. 渠道命令

在聊天中发送 `/help` 查看当前渠道完整命令。常用命令包括：

- 会话：`/new`、`/resume`、`/sessions`、`/archived`、`/rename`、`/archive`、`/unarchive`、`/pin`、`/unpin`、`/section`
- Workspace：`/workspace`、`/workspaceperm`
- 运行：`/status`、`/stop`、`/queue`、`/revert`、`/compact`、`/fork`、`/review`、`/release`
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 状态：`/diff`、`/usage`、`/metrics`、`/limits`、`/permissions`、`/goal`
- 扩展：`/agents`、`/skill`、`/plugin`、`/mcp`、`/rules`
- 帮助：`/help`、`/whoami`

`/stop` 会优先中断当前活动 Turn；`/resume` 和 `/new` 切换时，旧任务仍可在后台运行，结果与审批继续返回原聊天。Queue 由 App Server 持久保存，不由 Gateway 建立第二套消息正文队列。
`/resume`、`/sessions` 和 `/archived` 的当前页会话会显示已记录的 Turn 轮数；轮数读取失败时不会阻塞列表，近期结果会从本机派生缓存复用。新 Turn 开始时旧轮数会失效，Turn 完成后 Gateway 会针对该会话自动回填最新值。
可使用 `codexc sessions cleanup <最大轮数>` 预览并按轮数批量归档短会话；追加 `--idle-days <天数>` 可进一步要求会话连续空闲达到指定天数（两个条件同时满足）。在交互终端追加 `--confirm` 后会再次展示候选并询问确认。执行前需停止 Gateway；命令覆盖配置中的全部 Workspace 和 Provider，Provider 不可连接时失败关闭，使用本机轮数缓存，归档不会永久删除会话。

计划任务是 Gateway 自有功能，不是 App Server 原生计划 RPC。启用方式和确认语法见 [`计划任务开发设计`](scheduled-tasks-development.md)。

## 7. 指标、WebUI 与图片

```bash
codexc metrics status
codexc metrics threads
codexc metrics report --range 30d --group models
codexc metrics export --range 30d --format json
codexc webui
```

WebUI 只读展示脱敏指标；非回环监听必须配置令牌。多设备指标中心使用 `codexc config` 配置，详情见 [`WebUI`](webui.md) 和 [`指标同步`](metrics-sync.md)。

从本机向绑定渠道发送图片：

```bash
codexc channel send-image /tmp/screenshot.png
codexc channel send-image /tmp/screenshot.png --thread <Thread ID>
```

只接受经过安全校验的 PNG/JPEG，具体限制见 [`渠道图片`](channel-image.md)。

## 8. 排障

```bash
codexc doctor
codexc doctor --json
codexc service status
codexc service logs -n 100
```

常见处理：

- 配置修改未生效：`codexc service reload`。
- 只重启 Gateway：`codexc service restart`；共享 App Server 与活动 Thread 会保留。
- Codex CLI 版本不一致：按 `codexc update` 或错误提示安装精确版本后重试。
- 飞书无消息：先运行 `codexc doctor`，再检查应用权限、消息事件发布和允许用户。
- Windows ACL 失败：运行 `codexc security repair`，再运行 `codexc doctor`。
- 日志需要脱敏后再分享；不要分享 Token、Cookie、Authorization Header 或完整命令工作内容。

错误码见 [`错误字典`](errors.md)，渠道展示口径见 [`展示说明`](display.md)，协议与支持矩阵见 [`官方文档与源码索引`](index.md)。

## 9. 开发与验证

```bash
git clone https://github.com/msola-ht/codex-channels.git
cd codex-channels
npm ci
npm run check
npm run lint
npm run docs:check
npm test
```

协议升级必须先查阅 [`docs/index.md`](index.md)、官方固定 Tag 和 [`上游源码维护规则`](upstream-sources.md)，不得把生成类型存在误认为 Gateway 已支持。完整项目文档索引见 [`index.md`](../index.md)。
