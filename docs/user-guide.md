# Codex Connect 使用指导

本文是 Codex Connect Gateway 的完整用户指导。根目录 [README.md](../README.md) 只保留安装入口、最短配置路径和常用链接；遇到具体问题时按本文或对应专题文档继续阅读。

## 1. 工作方式

Gateway 把 Telegram、飞书和微信消息接入本机 Codex App Server。`codexc remote` 连接的是同一个 App Server，因此原生 TUI 与聊天渠道共享 Thread、Workspace、模型提供商和实时运行状态。

App Server 是 Thread、Turn、Item 和会话历史的唯一事实来源。Gateway 只保存渠道与 Workspace 的最小绑定，不复制完整会话文件或消息正文。

## 2. 安装

### 已发布版本

安装配套的 Codex CLI 与 Gateway：

```bash
npm install -g @openai/codex@0.155.1
npm install -g @hegenai/codexc@0.155.1
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

`codexc setup` 是接入向导，管理模型 Provider、渠道和项目技能；`codexc config` 是日常设置入口，统一管理 Codex 新会话与用户偏好，以及 Gateway 显示、服务、代理、Workspace、WebUI 和本地指标存储。配置示例见 [`config.example.toml`](../config.example.toml)。

`codexc timezone` 设置模型可见时区，WebUI 同步跟随；网关默认也跟随，可用 `codexc timezone --gateway` 选择系统或自定义时区，细节见[`模型可见时区`](model-timezone.md)。

Telegram、飞书和微信至少启用一个。Telegram 需要 Bot Token 和允许用户；飞书需要应用凭据和允许的 `open_id`；微信需要扫码凭据、账号和允许用户，Setup 最终确认保存时会直接启用消息接收。

### 计划相关设置

在 `codexc config → Codex 新会话与用户偏好 → 计划清单工具` 中控制上游 `update_plan` 工具，默认关闭：

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

上游计划工具关闭时不会产生普通计划清单通知；`display.plan_updates` 不能替代它。修改后由新建或重新加载的 Codex Thread 读取；当前已加载的 Thread 保持不变，无需重启服务。

### 实验性上下文管理

在 `codexc config → Codex 新会话与用户偏好 → 实验性上下文管理` 中控制上游的实验性上下文管理，默认关闭：

```toml
[features.context_management]
experimental_mode = true
```

该值写入 Codex 用户配置 `~/.codex/config.toml`，不属于 Gateway 的 `~/.codex-connect/config.toml`。保存后由新建或重新加载的 Codex Thread 读取；当前已加载的 Thread 保持不变。它只对满足资格条件的官方 ChatGPT Codex 新会话生效，使用 API Key、自定义或第三方 Provider 的会话不会启用该能力。`codexc doctor` 只读显示当前开关状态和适用范围。

### TUI 空闲总结

在 `codexc config → Codex 新会话与用户偏好 → 空闲总结` 中控制 TUI 失去焦点后的自动回顾，默认写入关闭：

```toml
[tui]
auto_recap = false
```

关闭只影响自动回顾，手动 `/recap` 仍然可用；修改后由新启动的 TUI 读取，无需重启服务。

### 推理摘要

在 `codexc config → Codex 新会话与用户偏好 → 其他用户偏好` 中选择推理摘要。开发基线 0.155.1
在尚未配置时预选“关闭”，与配套 CLI 的新建本地 TUI 会话默认值一致；已有的显式选择继续保留。
不支持推理摘要的第三方 Provider 可能拒绝 `auto`、`concise` 或 `detailed`，遇到此类错误时
检查对应 Codex 配置或 Profile 的 `model_reasoning_summary`，显式选择 `none`。

首次运行包含 0.155.1 升级处理的 `codexc update` 时，会将 Codex 用户主配置的推理摘要统一设为
`none`，包括已有的 `auto/concise/detailed`；完成后可以在 Config 重新选择，后续更新不会再次覆盖。
独立 Profile 的显式覆盖保持不变。更新按当前 Codex 配置目录记录一次完成状态，写入失败会明确报错。

### 渠道会话空闲自动解除

在 `codexc config → 系统设置 → 会话空闲自动解除` 中设置渠道会话自动解除 Thread 绑定的全局
空闲阈值，默认 15 分钟：

```toml
[conversation]
idle_release_minutes = 15
```

该值对 Telegram、飞书和微信统一生效，允许 0–1440 分钟，0 表示关闭。用户消息、平台本地命令、
审批与输入交互和任何带目标会话的输出都会刷新活动时间；正在恢复的 Thread 不会被同时释放。
Provider 断线期间也会跳过扫描。
连续达到配置的空闲时间且没有任何输入和输出时，Gateway 才会在确认 Thread、原生 Queue、审批和子代理都已
空闲后取消订阅并解除前台绑定；如果此时 Gateway 已没有任何前台或后台绑定、进行中的 Provider 操作或
启动任务，还会关闭全部 Provider Client，并在每 60 秒一次的空闲复检中停止全部未被租约占用的
App Server 进程（包括主实例），后续请求会自动启动并重连；`codexc remote` 持有租约期间对应实例
不会被停止。解除后
当前渠道会收到一次“自动解除占用”提示；若 60 秒内没有新消息、`/r` 恢复或新的 Provider 操作，
Gateway 会在关闭 Client 和停止 App Server 前向所有已知授权渠道发送一次
“所有模型连接已空闲，空闲的 App Server 即将停止”的通知。
该通知只属于渠道空闲自动解除后的全局释放轮次；手动 `/new`、切换 Workspace 或 Provider、
后台任务结束等原因导致没有绑定并关闭 Client 时，不发送这条通知。
`idle_release_minutes = 0` 只关闭渠道会话自动解除；无任何绑定时的全局空闲停止仍会执行，其他
非自动解除触发的全局空闲轮次只记录日志，不发送渠道通知。共享 App Server 的原生 TUI 必须通过
`codexc remote` 启动；直接运行 `codex --remote unix://<socket>` 不持有生命周期租约，可能被停止。
此后直接发送消息只会开启新会话，不会接续旧 Thread；需要继续旧会话时直接使用提示中的
`/r <Thread ID>` 命令显式恢复；飞书显示为 CardKit 2.0 卡片，Telegram 为 HTML 面板，微信为
结构化文本。修改后需要重启 Gateway。

### 代理与权限

共享代理统一保存在当前 Codex Home 的 `.env`，默认 `~/.codex/.env`。执行
`codexc config → 网络代理`，或在 WebUI 设置页修改；批量输入留空保持原值，取消不写入。
CLI 单项和批量代理设置均可选择 `127.0.0.1:7890`、`127.0.0.1:7897` 或自定义完整 URL；两个本地选项使用 HTTP 协议。
例如：

```dotenv
HTTP_PROXY="http://127.0.0.1:7897"
HTTPS_PROXY="http://127.0.0.1:7897"
ALL_PROXY="socks5://127.0.0.1:7897"
NO_PROXY="localhost,127.0.0.1"
```

Codex、Gateway 渠道和模型统计代理共用该文件；修改后在任务结束时执行
`codexc service restart all`，独立 Codex 进程也需重新启动。Gateway 只读取四个代理变量，
不把文件中的其他变量注入自身环境。代理值使用字面值，美元符号使用单引号包围或反斜杠转义，
不支持代理值中的变量插值。原有注释、其他设置和未修改字段会保留。
`ALL_PROXY` 可保存 SOCKS5 地址，但必须同时在此文件配置 HTTP(S) 协议的 `HTTP_PROXY`，
供 Gateway 的 HTTP(S) 客户端使用；缺少时读取或保存都会明确报错。

`.env` 字段优先于继承的标准代理环境变量；同名大小写同时存在时大写优先。已有任一代理地址时，
不补读系统代理；仅有 `NO_PROXY` 时仍允许自动发现。Windows 不读取 WinINET/WinHTTP。
`codexc update` 会备份并迁移旧 TOML `[network]` 到 `.env`，成功后删除 `[network]`；
若待迁移值与 `.env` 已配置的值冲突则明确报错，不覆盖现有值。正常启动不再接受旧 `[network]`。
迁移按合并后的设置校验代理组合；写入和失败回滚都检查文件是否被其他操作改动。若回滚冲突，
保留当前 `.env` 与迁移备份并报错，核对后再重试更新。

Workspace 只能从已登记项目中选择，并可分别设置 Sandbox、审批策略或 Permission Profile；不会接受聊天用户提交的任意绝对路径。

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
codexc primary-provider switch <Provider ID> [模型] [--yes]
```

`primary-provider switch` 会把主实例切换到目标 Provider，执行前会二次确认，并提示将改写
Codex 主配置的 `model_provider` / `model`；传 `--yes` 跳过确认（适合脚本化调用），
仅命令行 switch 支持 `--yes`，交互式 Setup 菜单仍会确认。

DeepSeek、OpenCode Go、自定义 Provider 和多账户说明分别见 [`DeepSeek 使用说明`](deepseek.md)、[`OpenCode Go 使用说明`](opencode-go.md)、[`Provider 接入指南`](provider-integration-guide.md) 和 [`OpenCode Go 多账户`](opencode-go-multi-account.md)。

继续使用聊天会话：

```bash
codexc remote
codexc remote resume
codexc remote --profile sf-ds-<账户> resume
```

直接运行 `codex` 会创建独立 TUI，不共享 Gateway Thread；需要共享会话时使用 `codexc remote`。跨 Provider 切换会创建目标 Provider 的新 Thread，不复制原 Provider 历史。
直接运行 `codex --remote unix://<socket>` 不持有生命周期租约，空闲释放可能停止对应实例；
共享 App Server 的 TUI 请统一使用 `codexc remote`。

### Codex Desktop App 共享（macOS / Windows 预览）

同一台 Mac 或 Windows 电脑上的 ChatGPT Desktop App 可以连接主 OpenAI App Server。macOS 使用
受管 stdio Proxy 连接现有私有 UDS；Windows 使用受认证的本机回环桥。启用前必须完全退出
ChatGPT App，并确保主 Provider 是 OpenAI、App Server 后台服务已经安装；Windows 还需要
PowerShell 7 和当前用户安装的 `OpenAI.Codex` 包：

```bash
codexc desktop-app status
codexc desktop-app enable
codexc desktop-app open
```

以后每次都使用 `codexc desktop-app open` 启动；从 Dock 或开始菜单直接打开不会继承本次共享端点。
关闭功能前同样先完全退出 App，再执行：

```bash
codexc desktop-app disable
```

`status --json` 保持脱敏。Windows 只输出不带令牌的回环地址；macOS 的 `port`、`endpoint`、
`tokenReady` 和 `bridgeReady` 不参与连接并返回空值或 `false`，另以 `toolHostSupported` 报告当前
App Server 服务是否支持受管入口。`toolHostAttached` 只在 Desktop 已交付当前工具 Pipe 且 Host
租约仍连接时为 `true`。共享功能只支持主 OpenAI App Server，不接入
Remote Control、手机配对或第三方 Provider。Desktop 的连接环境属于未公开兼容入口，当前功能是
预览；构建不兼容时命令会拒绝启用。

macOS 上使用 ChatGPT `26.908.70816` 的实机验收已经确认 Desktop 与渠道可以双向发现、继续同一
Thread。新的 macOS 受管入口会把 Desktop stdio 连接代理到同一
私有 UDS，并在首次附加当前工具 Pipe 时短暂重启主 App Server 子进程，以 OpenAI 签名的 Desktop
Node 托管项目锁定的 Codex CLI；开发基线为 0.155.1，既有私有 Pipe 与签名链实机验收使用 0.154.0，
升级后仍需单独复核。Desktop 传入的内置插件启用值会受控应用到共享主实例，
Host 租约存在时空闲释放不会停止主实例。`desktop-app open` 会先通过 App Server 的官方
`thread/loaded/list` 和 `thread/read` 检查全部已加载的持久及临时 Thread；发现活动 Thread、
`codexc remote` 主实例租约，或无法完成
只读状态检查时都会拒绝启动，不会进入子进程切换。隔离实测已经确认该进程链可启动 `codex_app`，
服务重启恢复和退出重开仍需按
当前 Desktop 构建完成实机复核，因此支持级别
继续是预览。Windows 只查询当前用户的正式安装包，并直接创建带单次环境的包内 Desktop 子进程，
不写当前用户或系统级持久环境；Windows 的会话双向互通及内置工具兼容均尚未实机验收，不能据此
视为正式平台支持。

实现边界、阶段状态和验收标准见
[`Codex Desktop App 共享 App Server 实施方案`](codex-desktop-app-development.md)。

### Computer Use 与浏览器排障

配置入口：`codexc config → Codex 新会话与用户偏好 → 电脑、浏览器与 MCP`，或 WebUI
设置页的 App Server 卡片。两者修改同一份 Codex 用户配置，使用版本检查；WebUI 写入前需要预览并确认。

当前支持默认应用访问、浏览器历史访问和默认站点策略，以及配置中已有的 macOS Bundle ID、Windows AUMID
和站点规则。普通 MCP 可修改启用状态、启动/调用超时、工具允许/禁用列表与审批策略；已有单工具覆盖还可修改
审批和输出 token 上限。插件 MCP 只开放这些策略覆盖，不修改插件清单里的启动命令、环境和超时。
本页不负责新增 MCP、发现插件清单里的服务器或创建应用/站点规则；未列出的条目仍在 Codex 原生配置中管理。

“用户设置”与“App Server 合并配置”分别展示，未设置时不臆测上游默认值。合并结果来自用户配置管理连接，
不包含当前渠道 Thread 的 Workspace/Profile 覆盖，也不表示组织策略、工具审批或操作系统权限已经放行。
选择“移除用户设置”仅删除该字段；工具列表的 `[]` 是显式空列表，与删除字段不同。
审批模式 `auto` 按工具属性判断，`prompt` 每次询问，`writes` 对非只读工具询问，`approve` 免除此层工具审批；
应用/站点的 `allow` 不会取消其他审批。保存后在新会话中使用；已有 MCP 连接与桌面客户端不保证即时采用新配置。

`desktop-app status` 的 `toolHostAttached` 只描述上面的 Desktop 私有工具 Host，不能据此判断
独立 Computer Use 或浏览器插件是否可用。`/mcp health` 可以检查当前 Thread 的 MCP 连接，
但工具已注册、原生应用列表可读、浏览器扩展可发现，都不代表窗口或标签页操作已经成功。

探测时应分别读取原生窗口与浏览器标签页。原生返回 `cgWindowNotFound` 时检查桌面锁屏与目标窗口；
浏览器扩展可发现但读取标签页超时，应继续检查扩展连接，不能直接判为缺少授权。系统辅助功能、
屏幕录制授权和上游应用／网站授权分别管理；Gateway 的批准按钮只回应实际收到的 App Server
请求，不代替系统授权，不解锁桌面，也不自行维护另一套网站允许名单。

飞书 MCP 工具审批区分“拒绝”和“取消”；“本会话允许”“始终允许”只在上游提供相应范围时出现，
“允许一次”不会升级为持久授权。Computer Use 操作说明与过程显示见[渠道展示](display.md)。

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

本地源码通过 `npm run install:global` 安装后，运行 `codexc update` 同步已安装包要求的
Codex CLI。版本不匹配时会询问是否安装，确认后先校验临时候选，再更新全局 CLI 和本地配置；
非交互调用会给出精确版本安装命令并退出，不静默安装。

更新会先检查官方 `main`、Codex CLI 公开合同、用户设置、数据库和服务状态，再在停机窗口中更新并恢复服务。数据库阶段同时处理状态库、指标库和可重建的会话展示缓存；缓存版本不兼容时会先备份再重建，不影响会话正文。`codexc update` 会提示计划清单工具当前状态；`codexc doctor` 只读诊断计划清单工具与实验性上下文管理。详细边界见 [`Codex CLI 升级流程`](codex-cli-upgrade.md) 和 [`升级决策记录`](codex-cli-upgrade-decisions.md)。

从包含直接 API Provider 预留注册表的旧版升级时，`codexc update` 会识别旧 Schema 自动补入的
顶层空数组 `api_providers = []`，并在停机窗口备份配置后移除，避免运行中的旧 Gateway 再次补入
该默认值而阻断候选预检。配置包含一个或多个 `[[api_providers]]` 表时仍会失败关闭；先备份
`~/.codex-connect/config.toml` 并手工删除这些表后再更新，不会隐式迁移非空 Provider 配置。历史
`~/.codex-connect/credentials/api-providers/` 文件不会再被读取，也不会自动删除；确认不再需要后可自行处理。

从仍包含远程指标中心的旧源码直接更新时，`codexc update` 会在候选预检中识别
`[metrics.sync]`、`[metrics.center]` 和 `[metrics.view]`，切换后先停止并注销旧的本机指标中心
后台服务，再备份 `config.toml` 并移除这些旧配置段。更新不会删除旧的中心 SQLite 或同步水位文件；
如不再需要，可在确认备份后自行处理。

仓库源码删除不会自动删除已经部署到外部平台的旧指标中心。曾使用项目历史 Cloudflare 示例时，
还需在对应 Cloudflare 账户中分别退役 Worker `codex-metrics-sync`、Pages 项目
`codex-metrics-viewer`，并在确认历史数据不再需要或已导出后删除 D1 数据库 `codex-metrics`。

卸载但保留用户数据：

```bash
codexc uninstall
```

npm 安装版也可以使用 `codexc service uninstall` 后执行 `npm uninstall -g @hegenai/codexc`。

## 6. 渠道命令

在聊天中发送 `/help` 查看当前渠道完整命令。常用命令包括：

- 会话：`/new`、`/resume`、`/sessions`、`/archived`、`/rename`、`/archive`、`/unarchive`、`/pin`、`/unpin`
- Workspace：`/workspace`、`/workspaceperm`
- 运行：`/status`、`/stop`、`/queue`、`/revert`、`/compact`、`/fork`、`/review`、`/release`
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 状态：`/diff`、`/usage`、`/metrics`、`/limits`、`/permissions`、`/goal`
- 扩展：`/agents`、`/skill`、`/plugin`、`/mcp`、`/rules`
- 帮助：`/help`、`/whoami`

`/stop` 会优先中断当前活动 Turn；`/resume` 和 `/new` 切换时，旧任务仍可在后台运行，结果与审批继续返回原聊天。Queue 由 App Server 持久保存，不由 Gateway 建立第二套消息正文队列。
存在原 Thread 时，`/new` 的结果会显示 `恢复会话：/r <Thread ID>`，可直接复制该命令恢复旧会话。

`/r` 的完整 ID、短 ID、名称和序号都只在当前工作区查找。恢复其他工作区的历史前，
请先使用 `/work` 切换到会话所属工作区；恢复不会自动切换工作区或改写历史会话的目录。
恢复时如果历史目录或实际权限与工作区不一致，会解除该绑定；下一条普通消息在当前工作区新建会话。
`/model` 选择 OpenAI 模型会关闭下一轮的 Fast，并同步保存为 Codex 用户默认值，避免 `all` 重启后
重新开启；需要时可用 `/fast on` 再打开。选择第三方模型不修改 OpenAI 的 Fast 默认值。
`/resume`（及 `/r`）、`/sessions` 和 `/archived` 的当前页会话会优先显示本机指标/缓存中的 Turn 轮数；打开列表不等待历史扫描。该轮数与 WebUI 相同，按本机已记录模型请求的不同 Turn 统计；本地没有记录时不会猜测数量。需要完整官方历史计数时，`codexc sessions cleanup` 仍会按候选读取。
可使用 `codexc sessions cleanup <最大轮数>` 预览并按轮数批量归档短会话；追加 `--idle-days <天数>` 可进一步要求会话连续空闲达到指定天数（两个条件同时满足）。在交互终端追加 `--confirm` 后会再次展示候选并询问确认。执行前需停止 Gateway；命令覆盖配置中的全部 Workspace 和 Provider，Provider 不可连接时失败关闭，使用本机轮数缓存，归档不会永久删除会话。

计划任务是 Gateway 自有功能，不是 App Server 原生计划 RPC。启用方式和确认语法见 [`计划任务开发设计`](scheduled-tasks-development.md)。

## 7. 指标、WebUI 与图片

```bash
codexc metrics status
codexc metrics threads
codexc metrics report --range 30d --group models
codexc metrics export --range 30d --format json
codexc webui
codexc traffic
```

WebUI 默认展示本机脱敏指标；回环监听未配置令牌时可直接使用设置页，显式配置令牌后所有 API 都会验证，非回环监听必须配置令牌。详情见 [`WebUI`](webui.md)。

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

### 模型请求转储

需要查看模型请求和响应的完整字段时，运行 `codexc config`，选择“系统设置 → 调用详情记录 → 开启”，
再按提示重启 App Server。也可以手工设置：

```toml
[debug]
model_traffic_dump = true
model_traffic_retention_days = 30
```

```bash
codexc service restart app-server
```

App Server 发给统计代理的模型调用会写入 `~/.codex-connect/traffic/` 下的 V2 私有 session 目录；
HTTP 的一次请求对应一条逻辑调用，同一 WebSocket 连接中的每个 `response.create` 也分别对应一条。
每条逻辑调用只保存一条请求索引和一个完成、失败或不完整终态响应，原始 HTTP/SSE 块、WebSocket
握手和双向帧另存为默认不展示的 trace。HTTP 请求头
`x-codex-turn-metadata`、WebSocket 首帧 `client_metadata` 里的 `thread_id` 与 `turn_id`
可以对齐到具体会话和轮次。转储是统计代理的旁路复制，不改变转发路径、指标采集和流式背压，
也不是抓包代理。Authorization、Cookie 等凭据字段只保留认证方案，替换为 `<redacted>`。

每个 session 的 `manifest.json` 声明精确版本，`interactions.jsonl` 保存小型索引，正文通过
offset/bytes 引用轮转的 `payload-*.bin`，原始传输轨迹位于 `trace-*.jsonl`。正文和 trace 文件达到
64 MiB 后轮转；长驻进程约每 24 小时让新逻辑调用进入新的 writer session，已在执行的并发调用继续
写入原 session，因此请求与响应不会被拆分。
同一 Provider 的历史完整 session 约保留 320 MiB，当前写入 session 不在中途删除。
转储写入失败时只停止转储并在日志中报错，模型请求继续正常转发。转储包含 prompt、工具输出和代码，
排查完成后关闭开关并删除 session，不要分享原始转储。

`model_traffic_retention_days` 默认 `30`。App Server 服务每次启动，以及开启转储后建立新 writer
session 时，都会按 session 最后活动时间删除超过该天数的可识别 V2 历史批次；启动清理即使当前已
关闭转储也会执行。清理以完整 session 为单位，含保留期内记录的批次会整体保留；设为 `0` 可关闭按
时间自动清理。旧版逐帧 JSONL、未知文件和未知目录不会自动删除。升级后首次启动会按同一规则处理
已有 V2 历史批次；需要回滚到不识别该键的旧版时，先从 `[debug]` 删除
`model_traffic_retention_days`。

转储默认按下一节的体积控制规则裁剪，不会把每次请求重发的完整会话历史原样落盘。流被提前终止时，
该逻辑调用会得到 `failed` 或 `incomplete` 终态及明确的 `errorScope`；已收到的传输块仍在 trace 中。

正文与索引分开存储，直接读不方便；用 `codexc traffic` 渲染成人可读文本：

```bash
codexc traffic                                 # 列出最新 session 中的逻辑模型调用
codexc traffic --exchange 12                   # 展开某次调用的一条请求和一个终态响应
codexc traffic --all --grep deepseek-flash     # 只显示匹配关键字的逻辑调用并展开正文
codexc traffic --exchange 12 --max-bytes 2000  # 限制每段正文的显示长度
codexc traffic --follow                        # 从现有文件末尾开始持续输出新写入的记录，按 Ctrl-C 停止
codexc traffic cleanup                         # 预览全部可清理转储，不删除
codexc traffic cleanup --confirm               # 停止全部 App Server 后永久删除预览范围
```

摘要行包含调用编号、时间、请求路径或 WebSocket URL、线程、轮次、模型和终态；详情固定分为“请求”
与“响应”，并补充参数、Token 用量和已完成输出条目。列表区分模型列表查询、连接预热与模型请求。
不传路径时读取 `traffic/` 中最新标签的最新 writer session；也可以用 `--dir` 指定根
目录，或传入一个 V2 session 目录。旧版逐帧 JSONL 原样保留但不自动迁移或混读，重启 App Server
后会生成 V2 session；回滚旧版本时旧文件仍可继续使用。`codexc traffic -h` 列出全部选项。
`cleanup` 会预览默认 `traffic/` 或 `--dir` 指定目录中可识别的全部 V2 session 和旧版逐帧 JSONL，
未知文件与目录不处理。实际删除只允许当前配置的数据目录下的 `traffic/`；先运行
`codexc service stop app-server`，再加 `--confirm`。删除不可恢复，完成后可按需运行
`codexc service start app-server`。

同一份转储也能在 `codexc webui` 的「转储」页查看：摘要列表与 `codexc traffic` 使用同一套解析，
点开某条即进入该条的请求参数、实际输出与用量摘要。终态未携带输出时，从已存 trace 的完成条目
提取；原始正文、逐条用量归因与传输 trace 默认收起，数据不会回写。页面地址保留标签、writer session、调用编号与分页位置，
返回列表回到原处；App Server 重启后也不会把旧列表中的编号解析成新 session 的同号调用。
该页只接受本机回环访问，展示内容同样是未脱敏原文（转储裁剪过的条目会显示对应的截断标记）。页面
同时显示自动保留天数，并提供“清空转储”的预览确认入口；实际删除前必须先停止全部 App Server。

### 转储体积控制

每次请求都会重发完整会话历史，长会话一轮就有几 MB；转储默认按下面的规则裁剪后落盘，不需要额外
配置：

```toml
[debug]
model_traffic_dump = true
model_traffic_input_items = 3
model_traffic_item_max_bytes = 65536
model_traffic_retention_days = 30
```

- `model_traffic_input_items`（默认 `3`）：只保留请求 `input` 数组末尾这么多条完整条目，更早的
  条目合并成一条 `{"type": "omitted", "omitted_items": …, "omitted_bytes": …}` 摘要；
  `0` 表示按原样保留整个 `input`；
- `model_traffic_item_max_bytes`（默认 `65536`，即 64 KiB）：单个数组条目（请求 `input` 条目、
  响应 `output` 条目、其中嵌套的数组元素）和超长字符串字段超过该字节数时只保留头尾各一半，替换为
  `{"type": "truncated", "bytes": …, "head": …, "tail": …}` 标记；`0` 表示不限制。它独立于
  `model_traffic_input_items` 生效，只设上限不会折叠 `input`。
- `model_traffic_retention_days`（默认 `30`）：App Server 启动及新 writer session 建立时，按最后活动
  时间清理超过天数的完整 V2 历史批次；`0` 关闭按时间清理。按 Provider 约 320 MiB 的体积上限继续生效。

精简开启时还会折叠响应里重复回显的 `response.instructions` 与 `response.tools`
（`<omitted N 字节>` 占位），并丢弃逐条流式增量事件
（`response.output_text.delta`、`response.reasoning_text.delta`、
`response.function_call_arguments.delta` 等以 `.delta` 结尾的事件）不再写入转储，它们的完整文本
由同一条目的 `*.done` 事件和 `response.completed.response.output` 承载。请求头、请求体其它字段、
`model`、保留的响应事件和事件顺序保持完整。需要逐个字段核对原文时，把两项参数都设为 `0` 按原样
转储。这些参数都在 App Server 启动时读取，改完需要重启服务；使用 `codexc traffic` 查看时不需要
额外参数，折叠、截断与丢弃结果会直接显示在对应位置。

开启精简时正文先整段缓冲再折叠，然后按 1 MiB 分片写入；单个正文超过 32 MiB 时退化为按原样分片，
避免为超大正文占用过多内存。

WebSocket 提供方（OpenAI 官方）同样生效：客户端 `response.create` 帧的 `input` 按同样规则保留
末尾条目，上游 `response.created`、`response.in_progress`、`response.completed` 里重复的工具与
指令回显按同样规则折叠，`.delta` 帧直接跳过。

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
