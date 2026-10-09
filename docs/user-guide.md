# Codex Connect 使用指导

本文是 Codex Connect Gateway 的完整用户指导。根目录 [README.md](../README.md) 只保留安装入口、最短配置路径和常用链接；遇到具体问题时按本文或对应专题文档继续阅读。

## 1. 工作方式

Gateway 把 Telegram、飞书和微信消息接入本机 Codex App Server。`codexc remote` 连接的是同一个 App Server，因此原生 TUI 与聊天渠道共享 Thread、Workspace、模型提供商和实时运行状态。

App Server 是 Thread、Turn、Item 和会话历史的唯一事实来源。Gateway 的 StateStore 只保存渠道与 Workspace 的最小绑定，不复制完整会话历史。独立投递箱按[投递合同](delivery.md)加密保存待送达结果；显式开启的调用转储另按下文保存模型报文。

## 2. 安装

项目不再发布新的 npm 版本。使用 Git 源码安装器构建并注册全局 `codexc` 命令；npm 仍用于依赖安装、本地打包和配套 Codex CLI 安装。

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

所有 CLI 命令在结束或失败时显示“命令总耗时”，单位为秒并保留两位小数。计时统一写入 stderr，stdout 的 JSON、JSONL、版本号和导出内容不混入计时文本；主菜单每次执行的命令也单独计时。前台服务、日志跟随和交互命令的耗时包含运行及等待输入的时间，在命令返回时显示；强制终止进程时不保证输出。使用单调时钟，从命令分派开始，不包含 Node 加载 CLI 静态模块之前的启动时间。

在交互终端直接运行 `codexc` 打开主菜单，可进入初始化、接入、日常设置、工作区、后台服务、指标、清理、诊断，以及“运行与连接”中的 TUI、WebUI 和前台核心服务启动入口。交互菜单要求标准输入和标准输出均连接终端；输入重定向时，`config` 显示帮助，`timezone` 仅显示当前时区。配置路径查询明确使用 `codexc config paths [--json]`，终端与管道中的行为一致。非交互终端无参数时显示帮助，显式子命令继续供脚本调用。

在 `codexc` 主菜单选择“后台服务”可选择操作和目标。菜单调用顶层服务命令，`restart all` 包含已安装的 WebUI。
启停、状态和日志的 `all` 同样包含 App Server、Gateway、已安装的 WebUI 与 Relay；启动 Relay 要求已启用。启动逐项等待就绪，停止顺序为 WebUI、Relay、Gateway、App Server。
菜单日志显示最近 100 行，持续跟随仍使用 `codexc logs <目标> -f`。卸载后台服务需确认。

`codexc work` 菜单区分新建工作区、注册当前目录和注册已有目录；注册前显示实际目录并确认，不创建或删除已有目录。`codexc metrics` 菜单包含会话列表导出和历史额度窗口查询，清理与重置统一使用 `codexc cleanup`。上述操作菜单完成单项后可继续选择；“运行与连接”完成后返回该子菜单，退出后返回主菜单。Setup 和 Config 单项失败会显示错误并返回各自分类菜单，不自动重试写入。

```bash
codexc init
codexc setup
codexc config
```

Gateway 配置位于：

```text
~/.codex-connect/config.toml
```

首次运行 `codexc init` 会创建默认工作区 `~/.codex-connect/workspace`，并将其初始化为 Git 仓库，
不自动创建提交；已有 `.git` 会保留。Git 不可用或初始化失败时明确报错，并且不写入新配置，
修复后可重新运行。配置已存在时，重复运行保留现有配置和仓库，不为已有工作区补建仓库。

`codexc setup` 是接入向导，管理模型 Provider、渠道和项目技能；`codexc config` 是日常设置入口，统一管理 Codex 新会话与用户偏好，以及 Gateway 显示、运行参数、代理、WebUI 和本地指标存储；工作区使用 `codexc work`，后台服务使用顶层 `start/stop/restart/status/logs` 命令，也可从主菜单进入。配置示例见 [`config.example.toml`](../config.example.toml)。

`codexc config` 的“计划任务”直接选择开关；Telegram 消息格式位于“显示设置”，仅在配置 Bot 后显示。显示子项取消或选择“返回上一级”时回到显示设置；在显示设置中选择“返回”才回到 Config。日志等级统一在“高级设置 → 日志等级”选择，`debug` / `trace` 开启调试信息，`info` 恢复标准输出。

`codexc setup` 要求标准输入与提示输出均连接终端；不满足时在初始化用户目录前报错。`setup --jsonl` 仍需交互输入及终端 stderr，stdout 输出脱敏 JSON Lines，适合将操作结果重定向到文件，不是无人值守配置接口。

命令只接受当前入口：Provider 管理集中为 `codexc provider`，受管账户使用 `provider deepseek`、`provider opencode-go`、`provider ccg`；各家的可用操作以子命令帮助为准。OpenCode Go 的 `release` 只释放实例，后续请求可重新拉起，不禁用账户。会话归档、转储删除与指标维护集中为 `cleanup sessions`、`cleanup traffic`、`cleanup metrics`（含 `prune`、`reset`）。旧独立 Provider 命令、`sessions`、原领域下的清理命令、`setup --json` 和 `config --json` 均被移除，没有兼容别名。脚本读取配置路径使用 `config paths --json`；诊断使用 `doctor --json`。

Setup 仅按具体操作返回的激活范围提示重启。列出账户、停止账户等操作不会因经过模型菜单而附加“重启全部服务”；需要重启的配置修改会返回对应服务目标，Setup 不自动执行重启。

`codexc timezone` 设置模型可见时区，WebUI 同步跟随；网关默认也跟随，可用 `codexc timezone --gateway` 选择系统或自定义时区，细节见[`模型可见时区`](model-timezone.md)。

Telegram、飞书和微信至少启用一个。Telegram 需要 Bot Token 和允许用户；飞书需要应用凭据和允许的 `open_id`；微信需要扫码凭据、账号和允许用户，Setup 最终确认保存时会直接启用消息接收。

### 审批方式：手动审批与自动审查（Auto-review）

Codex 默认审批方式入口为 `codexc config → Codex 新会话与用户偏好 → Codex 默认审批方式`，或 WebUI
`设置 → 工作区与权限 → Codex 权限与工具`。选择自动审查保存 Codex 用户层 `approvals_reviewer = "auto_review"`，选择手动审批保存
`approvals_reviewer = "user"`。保存前须明确确认；WebUI 还要求预览产生的一次性确认令牌，并检查
当前用户配置修订。此操作只修改默认审批方式，沙盒、审批策略和网络权限继续独立设置。

Auto-review 由 Codex 审核需要审批的操作，并按其政策批准或拒绝；它不会把每项请求自动批准。
Gateway 不再按 Provider 或模型白名单限制自动审查；已配置的第三方和聚合 `agg` 均可选择。
审查请求继续由 Codex 原生机制处理，审查失败不会自动放行。开放本地选项不代表所有远端模型
都已验证兼容，实际执行仍取决于上游接口与模型能力。
页面显示的是全局用户偏好，未设置时保留继承状态；上游无覆盖时默认由用户审批。新建 Thread
由 App Server 合并配置，Profile、项目配置、显式参数和组织策略可能覆盖该偏好。
已经加载的 Thread 及恢复的历史会话保留自身审批方式，不随默认值切换；受管 Provider 独立实例
仍以各自有效配置为准。无需为了此偏好重启 Gateway。

Codex 用户默认和 Workspace 默认审批方式不依赖 Provider 或模型资格；Workspace 默认跨 Provider 共用。
新建、未加载恢复和分叉按已有权限继承规则传递审批方式，不因模型变化自动切回手动审批。
已加载会话保留实际审批方式、订阅及活动任务状态。Gateway 不因第三方身份拦截新执行。

已有值不属于 `user` 或 `auto_review`、组织要求限制任一审批方式、组织禁用 Auto-review 或
策略读取不可用时，审批方式选择只读并拒绝写入，不把旧名 `guardian_subagent` 当作可编辑别名。
附加审批策略读取失败、超时或返回无效数据时，仅 Codex 默认审批方式只读，其他 Codex 用户设置仍可读取和修改。
飞书、Telegram 和微信会显示自动审查的开始及通过、拒绝、超时或中止状态。完成卡另列本轮任务和
当前会话的自动审查次数及结果分类，递归包含已确认归属的子代理；断线或历史缺失时明确显示已记录、
至少或未知。状态通知和计数只报告 App Server 的审查结果，具体口径见[渠道展示](display.md#完成汇报)。

飞书、Telegram 和微信可用 `/autoreview` 查询当前已绑定会话的实际审批方式，
用 `/autoreview on` 开启当前会话自动审查，或 `/autoreview off` 切回手动审批；
设置用于当前会话后续轮次；切换时须无运行任务或待处理交互。未绑定会话时只提示创建或恢复会话，
不会为配置操作创建 Thread。无法识别实际审批方式或旧值 `guardian_subagent` 时只读。
飞书命令中心的当前状态面板、当前会话审批方式面板和 Telegram `/autoreview` 查询结果提供当前会话按钮；按钮绑定原 Thread、Conversation 和用户，
五分钟内有效且只能提交一次，切换会话后须重新查询。只有 App Server 权威设置确认后才报告已切换；
未确认时不会自动重试，应重新用 `/autoreview` 核对实际状态。

飞书、Telegram 和微信可用 `/workspaceperm` 查询当前工作区的默认审批方式；
`/workspaceperm autoreview on` 开启自动审查，`off` 选择手动审批，`clear` 删除工作区覆盖。
该覆盖对新建、分叉、卸载后恢复的会话生效；已加载会话保留实际审批方式，须用 `/autoreview` 修改当前会话。
`clear` 只移除工作区覆盖；新会话跟随 Codex 默认，恢复历史会话可能保留其已保存设置，因此并非每次 `/resume` 都会继承新的默认值。
当前会话的实际审批方式仍由 `/status` 及启动、完成卡片展示。
飞书命令中心与 Telegram `/workspaceperm` 查询结果提供标明“工作区默认”的三种选择按钮，微信使用同一组文本命令。
按钮限时、一次性并绑定原工作区与当前用户；切换工作区后须重新查询。WebUI 的「工作区与权限」
同样支持自动审查、手动审批、跟随 Codex 默认，复用权限设置预览、配置版本校验和高风险确认。
本机可通过 `codexc work` 的工作区权限菜单设置同一覆盖，配置字段为
`[[workspaces]].approvals_reviewer`，仅接受 `auto_review` 或 `user`，删除该字段即跟随 Codex 默认。

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
| `display.plan_updates` | Telegram 与飞书是否把 `turn/plan/updated` 通知展示到渠道，默认开启 |
| `/plan` | 是否使用官方 Plan 协作模式 |

上游计划工具关闭时不会产生普通计划清单通知；`display.plan_updates` 不能替代它。修改后由新建或重新加载的 Codex Thread 读取；当前已加载的 Thread 保持不变，无需重启服务。

### 子代理规则与配置（可选）

入口为 `codexc config → Codex 新会话与用户偏好 → 子代理规则与配置（可选）`，仅对 OpenAI 主配置开放。
安装、更新和“配置核心默认值”不会自动应用这套预设；仅在主动选择并确认后写入。
可选择只写全局规则、只写 Codex 主配置，或同时写入。确认前显示实际路径和待写内容，
路径遵循 `CODEX_HOME`，通常为 `~/.codex/AGENTS.md` 和 `~/.codex/config.toml`。

规则只约束协作，主代理和子代理均继承当前生效的全局规则、项目规则、用户指令及环境权限。
全局和项目规则独立生效；子代理规则不能覆盖其中的安全、授权或交付要求。未启用或未使用子代理时，主代理完成同样的必要工作，任务不能以启用子代理为前提。
不启用、部分委派和全部委派的完成条件相同；不会因委派增加另一套验收标准、门禁或必经审查轮次。
仅主代理可以按收益、容量和任务依赖派发独立交付物，不强制经过全部模型或固定流水线；未委派工作由主代理承担。

按职责选择模型：规划、设计决策和独立审查使用 `gpt-6-astra / high`；实现、执行和故障诊断使用
`gpt-6.1-sol / high`；检索、事实摘要及步骤明确、低风险的简单任务使用 `gpt-6-luna / high`。
实质代码修改或非平凡执行使用 Sol，即使修改很短。每次派发显式选择模型和思考等级，仅使用这三个模型，
思考等级不超过 `high`；指定模型不可用时报告限制，由主代理完成能处理的工作，不静默替换模型或声称指定审查已发生。

每次使用 `fork_turns="none"`，简报包含目标、输入、已有证据、工作目录、范围、文件归属、依赖和预期输出，
携带适用全局规则、项目规则及协作规则的必要原文，不能只给规则路径。明确告知子代理：
`Do not spawn, invoke, or request any new subagents.`。子代理不得创建、调用或请求新子代理。
每个子代理从初次派发到交付或终止只执行一轮，该轮内负责职责范围中的调查、实现、故障诊断、修正、自审，
并回收外部工具和异步任务的结果；报告具体输出、证据、变更文件、阻塞和未观察行为，启动任务或只说“已完成”不构成交付。
不复用子代理、不追加任务、不重启已交付或终止的子代理，也不调用 `followup_task`。
后续追问、修正或审查可由主代理处理，或派发全新代理；接手前恢复成果、证据和任务句柄，结束冲突工作，明确移交文件及任务归属。

共享文件同一时间只有一个写入者，保留已有用户及代理改动。子代理仅在既定任务内与仍执行首轮的相关代理
交换依赖、接口、冲突和交接事实，仅在实际阻塞、需要共同决定或影响其他任务时发送消息，不通过协调追加任务或激活已结束代理。
优先等待完成通知并复用任务句柄；仅在必要时轮询，间隔按预计耗时、工具提示和交互响应需要决定。
时间流逝本身不构成重复执行、重新派发或声称有进展的理由。

主代理最终负责集成及当前任务适用的交付证据，核对输出是否存在、证据归属及是否仍适用，处理变更之间的相互影响。
实现修改需要相关反例与真实用户路径；规则或文档修改检查加载和消费路径；只读分析提供有来源的发现及不确定性，不额外要求运行验证。
子代理只在职责范围提供适用证据，不必各自重复完整用户路径；主代理复用有效证据，仅为变化、未解决疑点或集成风险追加观察。
项目既有强制流程继续适用，协作规则不扩大任务或外部操作授权。
这些是代理行为指令，不是运行时强制的模型限制；使用前应确认所用 Provider 支持这些模型。

主配置预设为：

```toml
[features.multi_agent_v2]
enabled = true
default_wait_timeout_ms = 600000

[agents]
default_subagent_model = "gpt-6.1-sol"
default_subagent_reasoning_effort = "high"
```

`agents` 默认值用于未显式指定模型的派发，具体任务分工由规则指导。
规则只更新专用托管段，保留其他内容；已有未托管的子代理章节需要先人工整理，避免叠加冲突。
两个文件不构成同一个原子事务，失败时按终端提示检查已写入部分。
入口不会自动重启服务；请在新的 Codex 会话中使用配置和规则。

### TUI 空闲总结

在 `codexc config → Codex 新会话与用户偏好 → 空闲总结` 中控制 TUI 失去焦点后的自动回顾，默认写入关闭：

```toml
[tui]
auto_recap = false
```

关闭只影响自动回顾，手动 `/recap` 仍然可用；修改后由新启动的 TUI 读取，无需重启服务。

### 推理摘要

Codex 0.156.1 已停用模型人格：CLI 与 WebUI 不再提供人格选择，保存其他偏好不会改写配置中已有的 `personality`。

在 `codexc config → Codex 新会话与用户偏好 → 其他用户偏好` 中选择推理摘要。开发基线 0.160.1
在尚未配置时预选“关闭”，与配套 CLI 的新建本地 TUI 会话默认值一致；已有的显式选择继续保留。
不支持推理摘要的第三方 Provider 可能拒绝 `auto`、`concise` 或 `detailed`，遇到此类错误时
检查对应 Codex 配置或 Profile 的 `model_reasoning_summary`，显式选择 `none`。

### 渠道会话空闲自动解除

在 `codexc config → 系统设置 → 会话空闲自动解除` 中设置渠道会话自动解除 Thread 绑定的全局
空闲阈值，默认 15 分钟：

```toml
[conversation]
idle_release_minutes = 15
```

该值对 Telegram、飞书和微信统一生效，允许 0–1440 分钟，0 表示关闭。用户消息、平台本地命令、
审批与输入交互和任何带目标会话的输出都会刷新活动时间；正在恢复的 Thread 不会被同时释放。
Provider 断线期间也会跳过对应 Thread；断线只取消该 Provider 的候选，其他 Provider 的扫描与补偿继续执行。
扫描保留 Thread 与活动时间快照，在取得会话锁及每次权威读取后复核；新输入、配置禁用、断线、
恢复或关闭会取消旧轮次。取消订阅后若出现新活动且连接仍可用，会恢复同一 Thread 的订阅；
恢复失败交给既有有界恢复任务，保留绑定且不发送解除成功提示。
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
空闲解除时按渠道会话保存 Provider、模型、思考等级和服务层级；Gateway 重启后直接发送消息仍沿用
这份偏好新建会话。断开后通过 `/model`、思考等级或 `/fast` 速度入口调整设置，会更新保存值。
恢复时若 Provider、模型或设置已不可用，会要求重新选择，不自动换账户或模型。
已有绑定仍以 App Server 的 Thread 设置为准；显式恢复同 Provider 历史会话继续沿用渠道偏好，
跨 Provider 恢复尊重目标 Thread，原生 Queue 存在时清除待生效覆盖。撤权、归档和跨渠道接管
等清理操作不会让旧偏好在重启后重新生效。状态库仅接受当前 Schema v6。
此后直接发送消息只会开启新会话，不会接续旧 Thread；需要继续旧会话时直接使用提示中的
`/r <Thread ID>` 命令显式恢复；飞书显示为 CardKit 2.0 卡片，Telegram 为 HTML 面板，微信为
结构化文本。修改后需要重启 Gateway。

### 代理与权限

共享代理统一保存在当前 Codex Home 的 `.env`，默认 `~/.codex/.env`。执行
`codexc config → 网络代理`，或在 WebUI「设置 → 网络与访问」修改；批量输入留空保持原值，取消不写入。
CLI 单项和批量代理设置均可选择 `127.0.0.1:7890`、`127.0.0.1:7897` 或自定义完整 URL；两个本地选项使用 HTTP 协议。
例如：

```dotenv
HTTP_PROXY="http://127.0.0.1:7897"
HTTPS_PROXY="http://127.0.0.1:7897"
ALL_PROXY="socks5://127.0.0.1:7897"
NO_PROXY="localhost,127.0.0.1"
```

Codex、Gateway 渠道和模型统计代理共用该文件；修改后在任务结束时执行
`codexc restart all`，独立 Codex 进程也需重新启动。Gateway 只读取四个代理变量，
不把文件中的其他变量注入自身环境。代理值使用字面值，美元符号使用单引号包围或反斜杠转义，
不支持代理值中的变量插值。原有注释、其他设置和未修改字段会保留。
`ALL_PROXY` 可保存 SOCKS5 地址，但必须同时在此文件配置 HTTP(S) 协议的 `HTTP_PROXY`，
供 Gateway 的 HTTP(S) 客户端使用；缺少时读取或保存都会明确报错。

`.env` 字段优先于继承的标准代理环境变量；同名大小写同时存在时大写优先。已有任一代理地址时，
不补读系统代理；仅有 `NO_PROXY` 时仍允许自动发现。Windows 不读取 WinINET/WinHTTP。
不支持旧 TOML `[network]`，更新器不会迁移或修改代理配置。

Workspace 只能从已登记项目中选择，并可分别设置 Sandbox、审批策略、Permission Profile 和默认审批方式；不会接受聊天用户提交的任意绝对路径。默认审批方式与当前会话实际设置的区别见[审批方式](#审批方式手动审批与自动审查auto-review)。

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
codexc provider list [--json]
codexc provider switch <Provider ID> [模型] [--yes]
```

`primary-provider switch` 会把主实例切换到目标 Provider，执行前会二次确认，并提示将改写
Codex 主配置的 `model_provider` / `model`；传 `--yes` 跳过确认（适合脚本化调用），
仅命令行 switch 支持 `--yes`，交互式 Setup 菜单仍会确认。

添加账户时，Setup 与 WebUI 已有的多账户配置入口均提供 `main`（主账户）、`work`（工作账户）、`other`（其他账户）和“自定义”；已占用的预设不再显示。名称仅作账户 ID，不决定默认账户或自动切换行为。

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
`codexc remote` 会按当前目录或显式 `--workspace` 选中的工作区传递权限及可选 `approvals_reviewer`；
显式传给 Codex 的 `-c approvals_reviewer=...` 或 `--approve-for-me` 优先于工作区默认审批方式。
Remote 不按 Provider 或模型限制自动审查，也不为审批资格固定模型或限制个人 Profile。
聚合入口仍保护其 Provider 与模型目录，防止透传参数替换路由。
Remote 的 `resume` 和继承式 `fork` 由原生 TUI 保留历史模型及审批方式，Codex 0.160.1 不应用启动参数中的 reviewer 覆盖；
恢复后应核对实际模型与审批方式。

### Codex Desktop App 共享（macOS / Windows 预览）

同一台 Mac 或 Windows 电脑上的 ChatGPT Desktop App 默认连接主 OpenAI App Server，也可在启动时
选择切换模式下已配置的 Provider 隔离实例。macOS 使用
受管 stdio Proxy 连接现有私有 UDS；Windows 使用受认证的本机回环桥。启用前必须完全退出
ChatGPT App，并确保主 Provider 是 OpenAI、App Server 后台服务已经安装；Windows 还需要
PowerShell 7 和当前用户安装的 `OpenAI.Codex` 包：

```bash
codexc app
codexc app --provider <Provider-ID>
codexc app --provider agg
```

首次运行会询问是否启用共享，并说明重启 App Server 可能中断现有连接与任务；默认拒绝。
确认后自动启用共享并启动 App，取消则不修改配置或服务。以后每次都使用同一命令启动，
不再询问或执行启用步骤；从 Dock 或开始菜单直接打开不会继承本次共享端点。
`--provider` 使用已配置的精确 Provider ID，聚合模式使用保留选择值 `agg`；省略时仍连接 OpenAI，
不记住上次选择，也不修改用户配置。切换 App Server 实例前必须完全退出 Desktop，再执行对应命令。
一次桌面连接固定到一个实例；聚合实例中的已加载模型可在 Desktop 模型选择器中切换，无需退出 App。
本项目不转移会话历史。上游恢复历史可能沿用历史 Provider，
桌面缓存和模型覆盖仍待实机验证；应在目标实例新建会话，不能认为旧会话已转换 Provider。选择目标不重启整个服务；
macOS 需要附加工具 Host 时只短暂重启目标实例。旧服务缺少选择能力时会提示先重启服务。

当至少有两个已配置的 API Key 切换提供商时，服务自动派生按需启动的
`codexc-aggregate`。公开命令只接受 `--provider agg`，不接受内部长 ID；状态 JSON、Thread 与绑定
仍使用 `codexc-aggregate`，无需迁移已有会话。无需添加同名账户或修改 Provider 配置；首次使用仍走上面的共享启用确认流程。
若已有 ID 为 `agg` 的自定义切换 Provider，桌面选择明确报冲突；该自定义 Provider 仍可通过 `codexc remote --profile sf-custom-agg` 访问。
聚合成员包含 DS、CLP、OCG、CCG 和自定义切换提供商，不包含官方 OAuth 主账户；多个同类账户也可以聚合。
Desktop 共享仍要求主 Provider 为 OpenAI。执行 `codexc app --provider agg` 后，同一模型目录包含这些成员的模型，
显示名称为 `Provider ID · 模型名称`。例如账户均名为 `main` 时，精确模型 ID 分别是
`ds-main/deepseek-flash` 和 `clp-main/cline-pass/deepseek-v4.1-flash`。
聚合使用一个 App Server 和现有工具 Host，各请求按选择的模型送至对应账户；网页搜索、模型 API
WebSocket 和自动重试关闭，独立 Relay 保持其原有模型目录和路由。

安装新代码后，旧 App Server 服务须按常规执行 `codexc restart appserver` 才能加载聚合能力；
Gateway 运行时会检测现有成员的 Key、配置和模型目录变更，并在活动 Thread 与客户端租约均允许时重建聚合实例、更新渠道模型菜单。
因此修改 DS 模型文件也会更新聚合目录；有活动或租约时先等待，快照变化后旧实例拒绝后续出站请求。
关闭占用的 Remote/Desktop 客户端并等待活动结束后可完成刷新；Gateway 未运行时需重启 App Server。
退出 Desktop 本身不会创建模型更新，只会释放租约、允许已有更新应用。Codex 主配置
`~/.codex/config.toml` 不属于聚合模型材料，不参与聚合设置监听或出站材料指纹校验。
聚合监听第三方账户注册、Profile、凭据、模型目录及其事务状态；主配置中的窗口覆盖与 Provider
冲突仍在材料加载、启动或应用时校验。主配置修改不会由聚合机制自动刷新；需按对应设置的生效方式
处理，要求重启 App Server 的配置仍须显式重启。
新增、移除切换成员属于拓扑变更，仍须重启 App Server 和 Gateway。生成文件保存在
`<dataDir>/runtime/aggregate-models.json`，是可重建的派生目录；应修改各提供商的源目录，不要直接编辑它。
聚合拒绝 Codex 主 `config.toml` 中全局 `model_context_window` 和 `model_auto_compact_token_limit`，
请先移除这两个覆盖，让每个模型采用自身目录设置；项目级同名配置仍可能覆盖目录值，使用前应检查。
请在聚合实例新建 Thread，旧单账户 Thread 不会迁移。本地可控上游已观察同一 Thread 跨模型
继续历史与命令工具结果回程；另已观察自定义提供商间切换及目录刷新后的同一 Thread 继续。真实云端提供商及 Desktop 内置工具仍待实机验收。
终端使用 `codexc remote --provider agg`，不能同时指定 `--profile`；也可简写为 `codexc remote -p agg`。
Desktop 启动和 `app status` 同样支持 `-p agg`。
Remote 的 `-p agg` 选择聚合实例，`-p <Profile>` 等同 `--profile <Profile>`，例如 `codexc remote -p sf-ds-main`；未配置的受管 Profile 会明确拒绝。
Desktop 的 `-p` 仍表示 Provider ID；两种命令均不允许重复或冲突选择。
启动时读取聚合服务端的默认模型与思考等级。使用 `-m`/`--model` 或 `-c model=...` 选择其他目录模型时，
自动采用目标模型的默认思考等级；`-m`/`--model` 优先于 `-c model=...`，重复配置覆盖以最后一项为准。
显式 `-c model_reasoning_effort=...` 优先；`--` 后的内容只作为原生 Codex 输入，不参与模型或思考等级选择。
渠道通过 `/model` 的“聚合提供商”目录选择同一组精确模型 ID，
在聚合 Thread 内换模型保留历史；从单账户切入聚合则创建新 Thread。聚合审批 reviewer 固定为
`user`，Remote 拒绝显式 `auto_review`。聚合 `/account`、`/limits` 明确返回不支持，
请求指标仍按真实成员账户记录，不生成虚拟账户快照。
会话清理只在发现聚合会话后才连接该实例，无法连接时明确跳过对应会话组。聚合纳入 Supervisor
与账户空闲回收；Remote 退出释放租约，其他客户端租约或活动仍可阻止回收，退出 Desktop 不保证立即停止实例。

需要诊断时使用 `codexc app status [--provider <Provider-ID>]`；非交互启用或指定 Windows 桥端口时，
使用 `codexc app enable [--port <端口>]`，再执行 `codexc app`。
关闭功能前同样先完全退出 App，再执行：

```bash
codexc app disable
```

`status --json` 保持脱敏。Windows 只输出不带令牌的回环地址；macOS 的 `port`、`endpoint`、
`tokenReady` 和 `bridgeReady` 不参与连接并返回空值或 `false`，另以 `toolHostSupported` 报告当前
App Server 服务是否支持受管入口。`toolHostAttached` 只在查询目标对应的 Desktop 已交付当前工具 Pipe 且 Host
租约仍连接时为 `true`。`running` 指桌面 App 进程；`primaryInstanceState` 另报告主 App Server
实例的 `running`、`released` 或 `unknown` 状态；`provider` 和 `providerInstanceState` 报告查询目标，
`desktopAppProvider` 报告 macOS 当前 Host 租约所属实例。状态查询不会唤醒已释放的实例。
Windows 状态不建立桥连接；共享启用且令牌可读取时 `bridgeReady: null` 表示未探测，实际连接检查在启动时执行。
`compatible` 仅表示启动入口探测通过，`toolHostAttached` 不表示 `codex_app` MCP 已就绪。
内置工具仍按 Desktop 传入的工具开关启用，不根据模型 Provider 或登录状态推断工具可用性。
如果 Desktop 日志出现 `dynamic_app_tools_peer_rejected reason=untrusted-process-ancestry`，
表示工具 Pipe 拒绝了进程祖先链，重复启用共享不能修复。当前 `26.1002.52244` 的聚合共享路径
已观察到这一故障，内置工具不可用；详见 [Desktop 验收状态](codex-desktop-app-development.md#实现与验收状态)。
共享功能要求主 Provider 为 OpenAI，第三方通过切换模式的账户实例或聚合实例接入；不接入
Remote Control 或手机配对。Desktop 的连接环境属于未公开兼容入口，当前功能是
预览；构建不兼容时命令会拒绝启用。

主 OpenAI 实例的 macOS 路径已由操作者确认验收，Windows 尚未验收；新增 Provider 选择在两个平台均未实机验收。
版本记录与范围见
[Desktop 验收状态](codex-desktop-app-development.md#实现与验收状态)。
macOS 上使用 ChatGPT `26.908.70816` 的既有实机验收已经确认 Desktop 与渠道可以双向发现、继续同一
Thread。新的 macOS 受管入口会把 Desktop stdio 连接代理到同一
私有 UDS，并在首次附加当前工具 Pipe 时短暂重启目标 App Server 子进程，以 OpenAI 签名的 Desktop
Node 托管项目锁定的 Codex CLI；开发基线为 0.160.1，既有私有 Pipe 与签名链实机验收使用 0.154.0，
升级后仍需单独复核。Desktop 传入的内置插件启用值会受控应用到目标实例，
Host 租约存在时空闲释放不会停止目标实例。目标实例已空闲释放时，`codexc app` 会先获取临时租约，
按需恢复实例并保护启动预检，再通过 App Server 的官方 `thread/loaded/list` 和 `thread/read`
检查全部已加载的持久及临时 Thread；临时租约会在打开 Desktop 前释放。发现活动 Thread、
`codexc remote` 目标实例租约，或无法完成
只读状态检查时都会拒绝启动，不会进入子进程切换。隔离实测已经确认该进程链可启动 `codex_app`。
macOS 已有验收结论；由于连接环境属于未公开兼容入口，功能仍保留预览定位，后续构建变化需按实际影响复核。
Windows 先以临时 Provider 租约等待目标实例就绪，再检查桥并启动桌面，成功或失败后释放临时租约。
启动失败时会区分实例未就绪和桥连接失败，不自动重启服务。它只查询当前用户的正式安装包，并直接创建带单次环境的包内 Desktop 子进程，
不写当前用户或系统级持久环境；Windows 的会话双向互通及内置工具兼容均尚未实机验收，不能据此
视为正式平台支持。

实现边界、阶段状态和验收标准见
[`Codex Desktop App 共享 App Server`](codex-desktop-app-development.md)。

### Computer Use 与浏览器排障

配置入口：`codexc config → Codex 新会话与用户偏好 → 电脑、浏览器与 MCP`，或 WebUI
「设置 → 工作区与权限」中的 Codex 权限与工具分区。两者修改同一份 Codex 用户配置，使用版本检查；WebUI 写入前需要预览并确认。

当前支持默认应用访问、浏览器历史访问和默认站点策略，以及配置中已有的 macOS Bundle ID、Windows AUMID
和站点规则。普通 MCP 可修改启用状态、启动/调用超时、工具允许/禁用列表与审批策略；已有单工具覆盖还可修改
审批和输出 token 上限。插件 MCP 只开放这些策略覆盖，不修改插件清单里的启动命令、环境和超时。
本页不负责新增 MCP、发现插件清单里的服务器或创建应用/站点规则；未列出的条目仍在 Codex 原生配置中管理。

“用户设置”与“App Server 合并配置”分别展示，未设置时不臆测上游默认值。合并结果来自用户配置管理连接，
不包含当前渠道 Thread 的 Workspace/Profile 覆盖，也不表示组织策略、工具审批或操作系统权限已经放行。
选择“移除用户设置”仅删除该字段；工具列表的 `[]` 是显式空列表，与删除字段不同。
审批模式 `auto` 按工具属性判断，`prompt` 每次询问，`writes` 对非只读工具询问，`approve` 免除此层工具审批；
应用/站点的 `allow` 不会取消其他审批。保存后在新会话中使用；已有 MCP 连接与桌面客户端不保证即时采用新配置。

`app status` 的 `toolHostAttached` 只描述上面的 Desktop 私有工具 Host，不能据此判断
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
codexc install
codexc status
codexc restart               # 等同 restart all，包含已安装的 WebUI
codexc restart gateway       # 只重启 Gateway
codexc logs -n 200
```

公开目标统一为 `gateway|appserver|webui|relay|all`，不接受 `app-server` 或 `model-relay` 作为 CLI 目标。
日常服务操作直接使用 `codexc <动作>`，不提供 `service` 子命令。
`codexc run` 在前台运行核心服务；`codexc start [目标]` 启动已安装后台服务。
`codexc install` 生成服务定义并启动核心服务；`codexc uninstall --services` 仅停止并卸载后台服务，
`codexc uninstall` 卸载整个受管程序，两者都保留用户数据。`codexc reload` 只通知 Gateway 重读配置。
Windows 重载成功表示 Gateway 已接受重读请求，不代表配置应用已经完成；若提示“重新加载结果未确认”，
应先核对服务日志与实际配置状态，不能据此认定请求没有执行。尚未接受的重载请求会在截止或连接断开时取消。

Windows 安装时若显式设置了 `CODEX_HOME`，该路径必须是已存在的目录，安装器会将规范化后的路径写入四个服务定义。更换目录后需要在设置了新值的终端重新运行 `codexc install`；已有定义不会被后台自动改写，安装失败沿用既有定义备份和恢复流程。

macOS 和 Linux 的服务定义为停止预留 50 秒，覆盖内部收尾预算；Linux 首次停止信号只发给服务主进程，由它协调子进程收尾，超时后由 systemd 清理剩余进程。已有安装仅更新程序并重启不会刷新服务定义；升级到包含这些模板变更的版本后，需在本机终端执行一次 `codexc install` 重新生成并激活定义。这会重启核心服务，请先安排停机窗口并记录各服务状态。macOS 已运行的 WebUI 还需执行 `codexc restart webui` 加载新 plist；首次卸载仍使用旧 Job 的期限。

Windows 启动前会检查服务定义所用的 PowerShell、原生构建产物、Node、CLI 入口及工作目录。缺失或不匹配时先返回修复提示，不启动任务；服务进程启动后的故障仍可能在宿主等待超时后报告。此时显示的“最近一次任务结果”不保证来自本次启动，请结合 `codexc logs` 判断。

`codexc restart [gateway|appserver|webui|relay|all]` 是唯一重启入口，默认 `all`。
`start`、`stop`、`restart` 另外为每个服务步骤显示耗时（秒，保留两位小数），失败步骤也显示耗时；启动步骤包含就绪检查。重启还会显示预检耗时。
单独指定目标时要求该后台服务已安装；`appserver` 包含受监管的 Provider 实例。
全部重启要求 Gateway 与 App Server 已安装，未安装的 WebUI、Relay 明确提示跳过；
已安装但未启用的 Relay 只停止，不重新启动。显式 `restart relay` 则重启 Relay 管理进程，监听仍由配置开关控制。

重启先检查配置、所选服务定义和服务管理器状态，全部预检通过后才停服。
停止顺序为 WebUI → Relay → Gateway → App Server；启动顺序为 App Server → Gateway → Relay → WebUI，
每项启动后先确认就绪，再启动下一项。WebUI 未显式配置时也检查默认地址的健康端点。
任一停止、启动或就绪检查失败立即中止，报告已完成、失败和未执行步骤，不自动回滚已完成的启停。
可用 `codexc status` 和 `codexc status webui` 检查状态，排除问题后重试。

`start/stop/status` 默认操作全部后台服务（含已安装 WebUI 及按安装与启用状态选择的 Relay），
`logs` 默认 Gateway。macOS 普通 `start` 不强制重启已运行的服务。
单独重启 Gateway 不停止共享 App Server；单独重启 App Server 时，仍运行的 Gateway 会按真实断线处理并重连。
渠道内禁止停止或重启 App Server，全部重启也必须在本机终端执行。
WebUI 内不执行包含自身的停止、重启或卸载任务；请在本机终端运行对应的 `codexc stop/restart webui`、`codexc stop/restart all` 或 `codexc uninstall --services`。

受管第三方 Provider 的模型目录、Profile 或管理标记变化会自动校验，并仅应用到当前 Gateway
已启用且受影响的 Provider。原生 TUI/Desktop 租约或该实例的权威活动 Thread 会推迟应用；
其他 Provider 的实例和活动轮次继续运行。目标实例重新读取启动材料，恢复连接和绑定并刷新模型
目录后才提示生效；失败保留待应用状态，冷却后重试，每 Provider 每次文件变化最多失败 12 次，
耗尽后等待下一次设置变化或 Gateway 重建。连续修改不会丢掉尚未应用的变化。
新 Gateway 启动后静默核对宿主的已应用指纹；相同指纹不动实例，未生效变化继续等待安全应用。
模型目录与默认值按 Provider 单独确认：已有实例读取 App Server 的实际目录，并使用宿主已应用的
默认设置；未运行实例只有在宿主确认相同文件指纹后才开放目录，不为读取目录启动实例。
某个 Provider 成功不会提前发布其他仍等待生效的目录。确认失败时保留原有已确认目录；重建后
没有可确认目录的 Provider 暂不可选。显式模型选择及已有 Thread 的实际模型继续保留。
停止或重建 Gateway 会取消未开始的操作；如果目标实例已经停止，监管会完成重新启动以恢复共享
实例，但已停止的 Gateway 不再刷新或发送成功提示。监管端未提供当前所需的定向应用能力时，操作明确失败并提示
重启 App Server 服务后重试，不自动改为整体重启。账户增删或 Provider 拓扑变化仍需显式管理服务。

Linux 使用 systemd 用户服务；Windows 使用当前用户计划任务和隐藏的 PowerShell 7 进程，不需要管理员权限。
Windows 计划任务的 `Ready` 表示等待启动；未检测到运行中的服务宿主时，`codexc status` 显示 `stopped`，不将任务的 `Ready` 当作服务就绪。
Windows 启动时，计划任务宿主等待 15 秒，App Server 应用就绪另行等待 60 秒，以覆盖配置、ACL 和实例初始化；监管确认主实例运行后再检查连接。应用等待超时会报告最后等待阶段，后续服务仍不会提前启动。
Windows 计划任务预检最多 10 秒、查询最多 5 秒、单次变更最多 15 秒。变更超时后只重新查询状态，不自动重做；计划任务状态不代表应用就绪，仍需通过 `codexc status` 确认。DPAPI 操作最多 5 秒，每次进程树终止命令最多 2 秒，超时明确报告结果未确认。
Gateway 与 App Server 监管进程从进入停止起最多等待 30 秒清理；Windows 宿主与前台包装层给子服务 35 秒（含 IPC 交付），外层最多等待 50 秒完成宿主回收，再按计划任务自身的 20 秒期限确认启动器停止。停止后的新重载会被拒绝；父进程控制 IPC 断开会停止其拥有的服务，不影响普通客户端断开时共享 App Server 的独立运行。正常清理失败以非零状态退出；进程树回收不等于已完成原生 App Server 的活动轮次排空。
WebUI 和服务操作使用的 Windows 异步状态查询整体预算为 25 秒，包含 Job 宿主、计划任务查询、权限检查和宿主通信，超时后另行有界回收本次查询进程树；回收失败会明确报告退出未确认。App Server 健康检查对静默 Proxy 单独限制握手等待，使用与服务相同的 Codex 程序及环境，清理失败会返回错误。
Windows 受管 Codex、查询和维护进程由 Job Object 管理，先加入 Job 再运行，包装进程先退出也会回收后代；计划任务停止还需确认外层启动器已停止。IPC 超时属于状态未知，不作为停止成功。私有路径只支持本地盘上的普通目录，拒绝祖先 junction 等重解析点；Proxy 每次连接均校验私有 Socket 目录并固定目录句柄。
原生 helper 还持有实际调用者的进程句柄，调用者异常退出时也回收其受管子树。Proxy 连接期间，Socket 目录内会有自动删除的 `.codexc-socket-*.guard` 文件，用于阻止空目录原地转换为重解析点；正常关闭或进程退出后由系统清理，不应在连接期间手动删除。只读 Doctor/ACL 检查不会创建该文件。
WebUI 取消任务失败时保留进程归属，恢复为可再次取消的运行状态并显示错误，继续阻止同一操作者提交重叠任务；不会一直停留在“取消中”或冒充已取消。若进程随后退出但未确认完整回收，则报告失败并要求检查实际状态。
Gateway 创建渠道前会初始化并收紧媒体暂存根目录 `uploads`，再由各渠道初始化自己的子目录。
已有目录必须属于当前用户且不是符号链接或重解析点；不满足时拒绝启动，不自动接管所有权。

Windows 私有配置 ACL 修复：

以下修复命令仅处理 Codex Home 顶层 TOML，不是任意数据目录的权限修复入口。

```powershell
codexc security repair
```

该命令只处理当前 Codex Home 顶层的普通 `.toml` 文件，不修改配置内容。主 `config.toml` 所有者与写入权限有效时保留上游读取权限并跳过修复；其余需要修复的文件关闭 ACL 继承，
仅保留当前用户、SYSTEM 与 Administrators 完全控制。若文件归 Administrators 所有，只有当前用户
已有完全控制权限且文件不含拒绝规则时，才把所有者恢复为当前用户；其他用户所有的文件明确拒绝。
使用普通用户终端执行即可；无权限或不满足条件时保留失败信息，不自动提权。
修复逐文件执行，后续文件失败不会撤销此前已成功收紧的权限，处理失败原因后可以重新执行。
日常启动和 Doctor 校验不会自动接管文件。修复后运行 `codexc doctor`，再重试启动服务。
启动或读取 Codex Home 顶层 TOML 时，若发现所有者或访问规则不符合对应文件要求，错误会直接提示
`codexc security repair`。超时、PowerShell 缺失、目录权限问题及修复命令自身失败不重复给出这条建议。

Windows 原生 Codex 会原子替换主配置，沙箱也会为 Codex Home 配置读取权限。Gateway 对共享 `config.toml` 检查所有者和写入完整性，允许只读继承；这不代表文件内容仅当前用户可读。Provider 独立 Profile、凭据、备份及 Gateway 配置仍使用严格私有权限。不要通过递归收紧整个 Codex Home 来修复单个文件，也不要将沙箱组加入通用信任名单。

Provider 配置事务的写入与回滚保留共享主配置已有的 DACL；同名备份仍按私有文件处理。显式指定 Gateway 配置路径时，不因首次保存而收紧已存在的父目录。若共享配置替换结果无法确认，命令会报告保留的恢复目录及可能存放新内容的临时路径；先核对当前配置、恢复目录内的原文件和仍存在的临时文件，不要直接删除目录或反复重试。

Windows ACL 检查在当前命令进程内复用 PowerShell，每次仍重新检查实际权限。计划任务状态批量读取；服务按依赖顺序启动并保留就绪检查。`doctor` 文本模式立即显示标题及检测阶段，`--json` 仍仅在完成后输出一份 JSON。

Windows 的 Gateway、Provider 设置检查、Remote、配置命令及 Desktop 桥接统一使用命令解析与进程树回收接口，支持 npm 安装的 Codex 启动入口。Provider 定向应用失败时，App Server 日志会记录 `provider-settings-apply-failed` 和受控错误代码；重启后的“已安全应用”只确认当前设置，不代表后续热更新路径也已验证。

Provider 添加过程中若报错，不代表账户已经保存；修复原因后需重新完成添加，服务重启不会补做失败的配置事务。已配置但模型目录尚未确认的 Provider 会在渠道模型列表显示“暂不可用”，目录确认成功后再开放真实模型。

源码安装的日常升级统一使用：

```bash
codexc update
codexc doctor
```

安装和更新统一从本机终端执行。本地源码更新后重新执行 `npm run install:global`，该命令不自动停启服务，具体顺序见[本地工作树安装与部署](source-install.md#本地工作树安装与部署)。

官方安装器和本地 `npm run install:global` 在默认 Codex CLI 缺失或版本不符时自动同步项目锁定版本，无需先初始化或配置渠道；随后执行 `codexc init`、`codexc setup`、`codexc install`。显式 `CODEX_BINARY` 由操作者管理，本地安装遇到版本不符时拒绝替换。
更新发现默认 CLI 缺失或版本不匹配时会询问是否安装，确认后先校验临时候选，再更新全局 CLI；
非交互调用会给出精确版本安装命令并退出，不静默安装。

更新先检查源码、公开合同、当前配置和数据库结构，通过后在一个停机窗口完成程序及配套 Codex CLI 安装与服务恢复。仅接受当前 Schema，不迁移或改写数据库。更新会将 Codex 用户层 `features.daemon_auto_start` 设为 `false`，包括版本无需更新时；不停止已有官方后台。其他用户偏好与 Provider 模型目录不改写，不支持的配置或 Schema 明确报错。新安装由正常初始化创建当前结构。详细流程见[源码安装与更新](source-install.md)。

### 本机清理与归档

统一交互入口：

```bash
codexc cleanup
```

清理菜单包含归档、转储删除、过期指标清理、Provider 指标清理和重置五项，完成或取消后返回菜单。下表另列出独立的投递核对命令：

| 维护项目 | 直接命令 | 执行条件与结果 |
| --- | --- | --- |
| 归档短会话及子会话 | `codexc cleanup sessions <最大轮数>` | 停止 Gateway、保留 App Server；预览并确认后归档 |
| 删除请求与响应转储 | `codexc cleanup traffic` | 先预览，确认删除需停止全部 App Server 与 Relay；永久删除当前配置目录下全部转储 |
| 清理旧指标 | `codexc cleanup metrics --restart-gateway` | 备份清理；显式 `--restart-gateway` 会停止后启动 Gateway（原先停止也会启动），交互菜单则按原状态恢复 |
| 核对未确认渠道结果 | `codexc delivery status` / `codexc delivery list` | 先停止 Gateway；明确重发、确认送达与停写备份见[投递箱运维](delivery.md) |
| 清理指定 Provider 的指标 | `codexc cleanup metrics prune <provider>` | 输入区分大小写的精确 ID 并确认；备份清理，Gateway 按原状态恢复 |
| 重置整个指标库 | `codexc cleanup metrics reset` | 先停止 Gateway；确认后备份并重建指标库 |

`codexc cleanup -h` / `--help` 显示说明，非交互终端不会执行清理。会话归档、旧指标清理和指标库重置会在确认后临停运行中的 Gateway；转储删除先预览并确认，再询问临停 Gateway、Relay 和 App Server。结束、取消或失败后按原状态恢复，原先停止的服务不会被启动；恢复失败会报告具体服务和手动启动命令。底层命令仍检查实际进程已退出，不终止前台自行运行的进程。执行失败会报告错误并返回清理菜单。

会话归档示例：先停止 Gateway，保留 App Server，预览“主会话不超过 3 轮、整组可查询成员至少空闲 7 天”的候选：

```bash
codexc stop gateway
codexc cleanup sessions 3 --idle-days 7
```

核对后在交互终端执行，命令会重新扫描并再次询问确认：

```bash
codexc cleanup sessions 3 --idle-days 7 --confirm
codexc start gateway
```

交互归档统一从 `codexc cleanup → 归档短会话及子会话` 进入。菜单在 Gateway 运行时先询问是否临时停止，保留 App Server；预览后的归档仍需确认。完成、取消或失败后恢复原先运行的 Gateway，原先停止则保持停止；恢复失败会提示手动启动。前台自行运行的 Gateway 仍须退出，菜单不终止非受管进程。`codexc cleanup sessions` 无参数显示用法。不指定 `--idle-days` 就没有会话年龄限制。
轮数阈值只计算主会话，子孙轮数不累加；派生子孙随官方归档，Fork 独立筛选。
活动、固定、渠道绑定或状态无法确认的成员会使整组跳过。归档保留历史，不是永久删除；
官方操作可能部分成功，执行期间不要在其他客户端操作候选会话。完整筛选及核验口径见[展示说明](display.md)。

### 卸载

卸载但保留用户数据：

```bash
codexc uninstall
```

源码卸载不要求配置文件有效；仍会检查受管安装身份并保留用户配置和数据。

npm 安装版也可以使用 `codexc uninstall --services` 后执行 `npm uninstall -g @hegenai/codexc`。

## 6. 渠道命令

在聊天中发送 `/help` 查看当前渠道完整命令。常用命令包括：

- 会话：`/new`、`/resume`、`/sessions`、`/archived`、`/rename`、`/archive`、`/unarchive`、`/pin`、`/unpin`
- Workspace：`/workspace`、`/workspaceperm`
- 运行：`/status`、`/stop`、`/queue`、`/revert`、`/compact`、`/fork`、`/review`、`/release`
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 工作区审批方式：`/workspaceperm autoreview <on|off|clear>`
- 当前会话审批方式：`/autoreview [on|off]`
- 状态：`/diff`、`/usage`、`/metrics`、`/limits`、`/permissions`、`/goal`
- 扩展：`/agents`、`/skill`、`/plugin`、`/mcp`、`/hooks`
- 帮助：`/help`、`/whoami`

`/stop` 会优先中断当前活动 Turn；飞书和 Telegram 同时取消当前待处理交互，原生 Queue 中的排队项保留，可通过 `/queue` 管理。`/resume` 和 `/new` 切换时，旧任务仍可在后台运行，结果与审批继续返回原聊天。Queue 由 App Server 持久保存，不由 Gateway 建立第二套消息正文队列。
存在原 Thread 时，`/new` 的结果会显示 `恢复会话：/r <Thread ID>`，可直接复制该命令恢复旧会话。

`/r` 的完整 ID、短 ID、名称和序号都只在当前工作区查找。恢复其他工作区的历史前，
请先使用 `/work` 切换到会话所属工作区；恢复不会自动切换工作区或改写历史会话的目录。
恢复时如果历史目录或实际权限与工作区不一致，会解除该绑定；下一条普通消息在当前工作区新建会话。
`/fast on` 选择 Fast，`/fast ultrafast` 选择独立的 Ultrafast，`/fast off` 回到 Standard，
`/fast status` 查看当前档位；无参数时在 Standard 与 Fast 之间切换，当前为 Ultrafast 时回到 Standard。
加速档位必须由 App Server 的当前模型目录明确提供；模型、账号或 Provider 不支持时拒绝开启，不回退为其他档位。
设置在下一次 Turn 生效；主 Provider 同时保存 Codex 用户级默认值，独立 Provider 不改写主实例默认值。
飞书加速菜单按模型能力展示可选档位，Telegram 和微信使用相同命令语义。可用性和消耗以账号及上游规则为准；
目标 Provider 与当前 Workspace 的有效 `features.fast_mode` 关闭时，渠道在写入前拒绝开启 Fast/Ultrafast，仍允许 `/fast off`。Gateway 不替用户打开该功能开关，最终以 App Server 返回状态为准。
本地 `codexc config → Codex 新会话与用户偏好 → 默认加速档位` 和 WebUI 的 Codex 设置同样提供
Standard/Fast/Ultrafast；只按当前模型能力提供加速选项，功能开关关闭时仅允许选择 Standard。
未显式配置时显示“跟随上游默认”，不会把它等同于明确的 Standard。配置入口沿用预览/确认和配置修订检查，
只影响新建或重新加载的 Thread；渠道 `/fast` 另外设置当前会话的下一 Turn。
已配置模型不在可用目录中时保留原模型标识并提示先选择有效模型，不借用其他模型的加速能力；
未配置模型时只采用目录明确标注的默认模型。模型不可用时仍可选择 Standard 退出加速。
`/model` 选择 OpenAI 模型会关闭下一轮的 Fast/Ultrafast，回到 Standard，并同步保存为 Codex 用户默认值，避免 `all` 重启后
重新开启；需要时可用 `/fast on` 或 `/fast ultrafast` 再打开。选择第三方模型不修改 OpenAI 的加速默认值。
`/resume`（及 `/r`）、`/sessions` 和 `/archived` 的当前页会话会优先显示本机指标/缓存中的 Turn 轮数；打开列表不等待历史扫描。该轮数与 WebUI 相同，按本机已记录模型请求的不同 Turn 统计；本地没有记录时不会猜测数量。需要完整官方历史计数时，`codexc cleanup sessions` 仍会按候选读取。

计划任务是 Gateway 自有功能，不是 App Server 原生计划 RPC。启用方式和确认语法见 [`计划任务开发设计`](scheduled-tasks-development.md)。

### Hook 列表、信任与启停

飞书、Telegram 和微信共用 `/hooks`，按当前 Workspace 查询当前会话所属 Provider 的
App Server；尚未绑定会话时使用已确定的模型 Provider，无法确定时先用 `/model` 选择。
飞书、Telegram 提供操作按钮，三个渠道均可使用文本命令：

```text
/hooks
/hooks page 2
/hooks <列表返回的选择编号>
/hooks trust <选择编号>
/hooks enable <选择编号>
/hooks disable <选择编号>
/hooks confirm <预览返回的确认码>
```

列表显示来源、触发事件、启用与信任状态；详情展示经过安全处理的审查信息。
选择编号固定到本次列表，不是可随排序变化重新解释的序号。信任、启用、停用均先生成预览，
再由同一操作者明确确认；选择与确认五分钟过期，Gateway 重启后失效。
确认时 Workspace、会话或 Provider 与预览不一致，Hook 定义/状态改变或用户配置版本变化时，需重新审查。
受管 Hook 只读。仅信息完整的 command Hook 可以在渠道逐项信任；MCP Tool、prompt 和 agent
处理器的完整输入未由列表接口提供，需在本地审查。命令信息被脱敏或截断、来源不明时，渠道也不提供信任操作，
请在本地 Codex `/hooks` 审查。微信还会检查命令、匹配条件和来源路径能否原样展示；需要替换 Markdown 符号时不允许渠道信任，手动输入信任或确认命令也不能绕过。已信任的非受管项仍可启停。不能通过此入口注册 Hook、部署脚本或一次性信任全部 Hook。

**信任和启用是独立状态。** 新增或变更的非受管 Hook 需要信任当前定义；信任一个已停用 Hook
不会替它开启。信任哈希对应配置定义，不覆盖所引用脚本的文件内容。
这些操作持久写入 Codex Home 的用户配置。项目的主实例和 Provider 隔离实例共用该配置，
因此会影响其他 Provider 和使用相同 Hook 的会话，并非仅当前聊天的一次授权。
Gateway 数据库不保存另一份 Hook 定义、脚本或信任状态。

写入后通过官方协议协调已连接及正在连接的实例刷新运行配置，并回读列表核对结果，通常不需要重启。
每次新建连接或重连时均刷新，覆盖未连接实例及 Gateway 重启后仍存活的独立实例；不会为刷新而启动未使用的 Provider。刷新请求使用空编辑，不复制或重写 Hook 状态。
某实例刷新请求失败时，结果明确提示“已保存，刷新未确认”及对应 Provider；下一次使用该实例前再次尝试刷新，失败则拒绝继续操作。
首次连接的刷新失败会先清理本次 Client 连接，清理成功后可重新接入；清理未确认时保持拒绝接入，需检查连接清理错误，不会通过终止共享 App Server 绕过。
“设置成功”只表示保存、回读状态匹配且协调的刷新请求已返回成功，不保证上游内部所有 Thread 刷新成功，也不表示 Hook 已执行；
实际运行仍看后续 Hook 完成通知。Hook 状态写入中断或结果不明时不会自动重试，旧选择和确认全部失效，先重新执行 `/hooks` 核对。
列表警告、配置加载错误与空列表分别提示，不向渠道转发上游原始错误正文。

Windows、macOS、Linux 使用同一管理协议；脚本路径、解释器和会话 Shell 仍由实际 App Server
环境决定，信任操作不会修正平台不兼容的命令。此入口不改变 Windows 代理或 Unix Socket 生命周期。

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

### OpenAI 重置券 CLI

Gateway 和主 App Server 可用、已登录 ChatGPT 时，可在本机使用：

```bash
codexc reset-credit list          # 实时列表，日期为 UTC 并明确标注
codexc reset-credit list --json   # 机器可读的账户 ID、数量与可用券明细
codexc reset-credit use           # 交互选券、预览并确认
codexc reset-credit use <券ID>    # 指定券后预览并确认
```

命令不依赖 WebUI 进程。取消或中断已获取的预览会尝试通过私有 IPC 释放记录，清理失败会明确提示并由 5 分钟有效期兜底。消费必须在交互终端明确确认，默认取消；不支持 `--yes` 或非交互消费。
预览展示账户、券名称、官方说明和到期时间；Gateway 复核账户与券状态后单次执行，5 分钟预览过期需重新操作。
中断、超时或丢失消费响应时不自动重试，先重新运行 `list` 核对官方状态。消费结果与账户快照刷新结果分开显示。
API Key 账户、未知类型或未提供明细的券不可使用。渠道使用 `/limits reset` 查询、`/limits reset use <券ID>` 预览，再按返回的 `/limits reset confirm <令牌>` 确认或 `/limits reset cancel <令牌>` 取消。飞书和 Telegram 的 `/limits` 提供“查看重置券”按钮；列表可点选、翻页、刷新，预览提供“确认使用”和“取消”按钮，无需复制令牌。微信使用文字命令，飞书和 Telegram 也保留文字入口；令牌仅限原用户、会话、工作区及当前 Thread，5 分钟过期，重启失效。WebUI 操作见[重置券使用](webui.md#openai-重置券使用)。

### 正常发图与图片引用

照常在渠道发送图片即可，不需要额外命令。使用 OpenAI ChatGPT 登录时，Gateway 上传已校验的
原图并以官方 `fileId` 提交；App Server 保存引用，后续历史继续使用引用。自动引用目前要求
实际模型代理与账户均使用默认 ChatGPT 后端，且账户路由策略为 `NO_CONSTRAINT`；
`us`、`us_cr` 或后端不一致时会在上传前报错。
API Key、第三方 Provider 和独立自定义 OpenAI 后端保持内联图片输入。Actor、Workspace、模型能力和媒体大小限制继续适用。

图片引用会跳过 App Server 的本地缩放，不能视为与普通原生 TUI 的图片预处理完全相同。
普通准备阶段每阶段最多等待 60 秒；每张图片的字节传输最多 5 分钟，包含最多 5 次尝试及退避等待，完成确认最多 30 秒。多张图片依次处理，可通过 `/stop` 取消；主动取消、连接关闭与阶段超时分别提示。
账户或路由变化、上传失败会报告对应环节；网络异常不会统一归因于登录失效，
可按[渠道日志说明](display.md)中的图片诊断字段定位。
字节 PUT 按锁定上游策略对暂时性网络异常及 HTTP 502/503/504 有界重试，尊重服务端等待时间；只重传相同上传地址的相同字节，不重新创建文件或重复提交模型请求，不回退 Base64。远端图片没有自动删除入口，保留时间和跨重启可用性不作保证；
此功能不提供文件管理、按编号下载或用户手动编号输入。
实现、验证范围与限制见[图片引用决策](codex-cli-upgrade-decisions.md#图片文件引用需求阻塞与实现边界)。

部署后需要确认自动引用时，先按[模型请求转储](#模型请求转储)开启调用详情记录。为避免历史条目或
长字段被裁剪，可临时把 `model_traffic_input_items` 和 `model_traffic_item_max_bytes` 都设为 `0`，
重启 App Server 后在新会话中发送一张图片，再发送一条只引用前图的纯文本追问。用下面的命令分别
展开首次发图和后续追问对应的模型调用：

```bash
codexc traffic
codexc traffic --exchange <首次发图编号>
codexc traffic --exchange <后续追问编号>
```

首次请求应包含 `input_image.file_id`，且不包含该图片的 `data:image/...;base64`。后续请求可能在
完整历史中继续携带同一 `file_id`，也可能通过 `previous_response_id` 增量接续而完全不再携带图片；
两者都属于官方历史复用。后续请求重新出现该图片的 Base64 才表示自动引用未生效。模型能够回答
后续追问只能证明上下文可用，不能单独证明首次请求已经使用 `fileId`。转储包含未脱敏的会话正文、
工具输出和代码，验证后恢复原来的裁剪配置并关闭转储，不要分享原始文件。

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
codexc status
codexc logs -n 100
```

常见处理：

- 配置修改未生效：`codexc reload`。
- 只重启 Gateway：`codexc restart gateway`；共享 App Server 与活动 Thread 会保留。
- Codex CLI 版本不一致：按 `codexc update` 或错误提示安装精确版本后重试。
- Codex CLI 报 `Missing optional dependency`：平台原生包缺失，按提示带 `--include=optional` 重装项目锁定版本，先确认 `codex --version` 成功；不要把该错误当作版本号或 PATH 冲突。见[源码安装与更新](source-install.md#本地工作树安装与部署)。
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
codexc restart appserver
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
时间自动清理。未知文件和未知目录不会自动删除。

转储默认按下一节的体积控制规则裁剪，不会把每次请求重发的完整会话历史原样落盘。流被提前终止时，
该逻辑调用会得到 `failed` 或 `incomplete` 终态及明确的 `errorScope`；已收到的传输块仍在 trace 中。

正文与索引分开存储，直接读不方便；用 `codexc traffic` 渲染成人可读文本：

```bash
codexc traffic                                 # 列出最新 session 中的逻辑模型调用
codexc traffic --exchange 12                   # 展开某次调用的一条请求和一个终态响应
codexc traffic --all --grep deepseek-flash     # 只显示匹配关键字的逻辑调用并展开正文
codexc traffic --exchange 12 --max-bytes 2000  # 限制每段正文的显示长度
codexc traffic --follow                        # 从现有文件末尾开始持续输出新写入的记录，按 Ctrl-C 停止
codexc cleanup traffic                         # 预览全部可清理转储，不删除
codexc cleanup traffic --confirm               # 停止全部 App Server 与 Relay 后永久删除预览范围
```

摘要行包含调用编号、时间、请求路径或 WebSocket URL、线程、轮次、模型和终态；详情固定分为“请求”
与“响应”，并补充参数、Token 用量和已完成输出条目。列表区分模型列表查询、连接预热与模型请求。
不传路径时读取 `traffic/` 中最新标签的最新 writer session；也可以用 `--dir` 指定根
目录，或传入一个 V2 session 目录。仅支持 V2 session。`codexc traffic -h` 列出全部选项。
`cleanup` 会预览默认 `traffic/` 或 `--dir` 指定目录中可识别的全部 V2 session，
未知文件与目录不处理。实际删除只允许当前配置的数据目录下的 `traffic/`；先运行
`codexc stop relay` 和 `codexc stop appserver`，再加 `--confirm`。删除不可恢复，完成后可按需运行
`codexc start appserver`，此前启用的 Relay 可按需运行 `codexc start relay`。

同一份转储也能在 `codexc webui` 的「转储」页查看：摘要列表与 `codexc traffic` 使用同一套解析，
点开某条即进入该条的请求参数、实际输出与用量摘要。终态未携带输出时，从已存 trace 的完成条目
提取；原始正文、诊断信息与传输 trace 默认收起，数据不会回写。页面地址保留标签、writer session、调用编号与分页位置，
返回列表回到原处；App Server 重启后也不会把旧列表中的编号解析成新 session 的同号调用。
该页只接受本机回环访问，展示内容同样是未脱敏原文（转储裁剪过的条目会显示对应的截断标记）。页面
同时显示自动保留天数，并提供“清空转储”的预览确认入口；实际删除前必须先停止全部 App Server 与 Relay。

### 转储体积控制

首个请求或未采用增量接续的请求可能携带完整会话历史，长会话一轮就有几 MB；使用 WebSocket
`previous_response_id` 接续时，后续请求也可能只携带本轮增量。转储对实际出现的 `input` 按下面的
规则裁剪后落盘，不需要额外配置：

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
# 按改动选择类型、Lint 或文档检查
npm run check
```

开发阶段按影响选择类型、Lint、文档检查或构建。提交 Hook 自动运行 `npm run verify:commit`
选择必要检查，PR CI 使用 `npm run verify:ci` 执行完整静态检查与构建。
具体入口见[CI 流程](../.github/workflows/README.md)，无需每次修改都手动运行全部检查。

协议升级必须先查阅 [`docs/index.md`](index.md)、官方固定 Tag 和 [`上游源码维护规则`](upstream-sources.md)，不得把生成类型存在误认为 Gateway 已支持。完整项目文档索引见 [`index.md`](../index.md)。

项目命令规则预授权只读 Git 状态、差异、日志、声明的验证入口和绑定渠道图片发送；`git branch`、`git remote` 不整体预授权，按当前执行权限处理。

## 可选模型 API 转发

`codexc relay` 管理独立 Relay 的调用方和访问密钥；`status`、`callers` 只读，
`issue` 签发、`rotate` 轮换、`disable --caller ID` 撤销。新秘密只在保存后显示一次。
`enable`/`disable` 保存服务开关并确认当前进程生效；进程未运行时明确显示仅保存，
通过 `codexc start relay` 启动；停止、重启、状态和日志也使用 `relay` 目标。指标库只接受当前 Schema，新安装直接创建。

Relay 默认禁用、回环监听；可显式使用 IPv4 局域网监听，跨不可信网络使用自己管理的加密隧道。提供原生 Chat Completions 与 Responses JSON/SSE 和
受限模型列表，不提供 App Server 的 Agent、Thread、Turn、工具执行或文件访问。
客户端使用 `/v1/chat/completions` 或 `/v1/responses` 选择原生协议；不会互转或自动重试另一协议。
`codexc relay providers` 和管理页展示账户的实际协议能力：CLP 为 Chat，DS 为 Chat/Responses，其他已接入的 Responses 提供商为 Responses。
自定义主/切换 Provider 必须有可独立读取的 API Key 和有效模型目录；不借用 Codex OAuth 登录态。
Responses 只提供同步无状态创建；`store` 可省略或传布尔值，出站统一设为 `false`，传 `true` 时会关闭存储后继续转发，不因该值拒绝请求。非布尔值仍报参数错误；调试调用详情记录入站与出站差异。
`background` 可省略或传布尔值，传入时统一设为 `false`，继续在当前请求内交付结果，不因 `true` 报错；省略时不补字段。
官方 DS 的 `previous_response_id`、`conversation` 原样转发，由上游按其无状态合同忽略；客户端仍需在 `input` 中携带所需完整历史，引用不会恢复上下文。其他 Responses 提供商仍拒绝服务端会话引用：多个 Relay Key 可共享上游账户，当前没有响应/会话归属校验，不能通过引用读取共享账户历史。Relay 不提供响应管理端点。
普通参数、工具声明和远程图片交由上游处理；Chat 保留原始响应字段与工具增量，客户端须等待有效终态后才执行工具。
完整双协议、提供商接入与升级回滚合同见[转发设计与边界](provider-api-relay-development.md)。
局域网交互设置：运行 `codexc relay listen`，或进入 `codexc config` → 模型转发监听，选择关闭、仅本机、局域网（0.0.0.0）或指定内网 IP。确认后自动备份、原子保存并向运行中的 Relay 确认生效，保留 Key 和现有端口。若服务未运行，会提示启动命令，不自动安装或启动。配置被其他操作修改时拒绝覆盖，请重新进入菜单。

手动设置：先备份当前实际使用的配置文件并校验备份，再在已有 `[model_relay]` 段设置 `host = "192.168.1.10"`（替换为服务器的内网地址），或 `host = "0.0.0.0"`。不要重复创建同名 TOML 段。保留现有 Key、并发及其他字段；默认端口为 4119。支持 10/8、172.16/12、192.168/16 的规范 IPv4 地址，IPv6 当前仅支持回环 `::1`。不接受域名、URL 或公网 IP 字面量。

运行中的 Relay 会刷新监听配置；配置无效或绑定失败时停止接收请求，不自动换地址。初次启用使用 `codexc relay enable`，已安装的服务使用 `codexc start relay`，通过 `codexc relay status` 确认 `configurationValid`、`enabled`、`listening` 均为 true。改变监听地址会取消旧请求，应在空闲时操作。客户端 Base URL 填 `http://192.168.1.10:4119/v1`，API Key 使用已签发的 Relay Key，模型选择该 Key 允许的 ID。

`0.0.0.0` 监听所有 IPv4 网卡，不是客户端地址，也不保证仅内网可达；自行限制防火墙来源，不做公网端口映射。HTTP 中 Key 和正文未加密，跨不可信网络使用加密隧道。此设置不开放 App Server、控制 IPC 或指标 IPC，不改变 WebUI 的监听与管理授权。

客户端可携带当前 Key 调用 `GET /v1/models` 查看获准且仍在提供商目录中的模型。WebUI 请求页面来源显示“Codex / 转发”，可按来源与真实调用方筛选；接收确认不代表指标已落盘，交付完成不证明客户端已收到。
请求列表优先显示 Key 的当前中文用途名称，长名称省略显示，悬停或聚焦可查看完整名称与调用方 ID；未命名或已移除的调用方仍显示原 ID。名称仅用于展示，筛选和历史指标继续使用稳定 ID，不回写历史记录。

WebUI 侧栏「模型转发」提供独立 Key 管理页。每个用途对应一把 Key，名称支持中文，内部调用方 ID 在新建时自动生成并保持不变。按提供商分组勾选一个或多个模型，可跨多个提供商，再选择「跟随客户端」或「强制关闭（支持的模型）」。多把 Key 可以使用同一账户，策略互不影响。
Key 列表显示原生 Chat/Responses 协议；双协议账户同时显示两者。模型选择中的文本、图片、音频标签来自现有目录，未声明时不推断能力；标签不改变上游参数处理。
账户凭据在 WebUI「模型管理 → 账户与凭据」维护，自定义提供商的地址与凭据在「模型管理 → 提供商」编辑；Relay 页不复制上游秘密。新建、编辑、轮换、停用和删除使用居中弹窗，先预览再确认，
完整新 Key 只显示一次，关闭后无法再次查看；响应丢失时先刷新确认记录，不能自动重复签发。
若返回 `cleanupStatus: "failed"` 或页面提示管理锁清理失败，修改已经保存；先保存新 Key，再检查数据目录权限和磁盘，不要重复签发。读取失败可直接刷新；编辑时错误及刷新入口显示在弹窗内。刷新保留草稿，但检测到版本变化会禁止保存，须明确选择“重新加载并丢弃草稿”再编辑、预览，避免覆盖其他端修改。上游能力暂不可读取时保留现有策略，可仅改名或切换到可用提供商；不会把未知状态当作模型不支持。
「查看调用」进入现有请求列表并精确筛选用途。停用后重新使用须轮换生成新秘密。

模型权限只保存在 `model_relay.callers[].models`，每把 Key 必须选择 1–256 个唯一调用 ID。提供商模型目录只读，不保存全局启用列表或思考策略；目录新增模型不会自动扩大任何 Key 的权限。旧 Relay 字段与升级、回退命令均不受支持，不做自动转换。

CLI 使用同一管理逻辑，例如：

```bash
codexc relay providers
codexc relay issue --caller translation --key translation-key --model clp-main/deepseek-v4.1-flash --reasoning off --name "沉浸式翻译"
codexc relay edit --caller translation --reasoning passthrough
```

`issue` / `edit` 可通过 `--name "中文名称"` 设置 1–64 字符的用途名称，不含控制字符或首尾空白。名称可重复、可修改，身份仍以 caller_id 区分；改名不会取消请求或更改历史指标。旧记录未设名称时显示调用方 ID。

`issue` 使用可重复的 `--model 提供商/模型ID` 选择模型；`edit --model ...` 替换该 Key 的完整授权列表，省略时保留原范围。调用 ID 使用本项目提供商前缀，CLP 对外去掉上游的 `cline-pass/`：例如 `clp-main/deepseek-v4.1-flash`，出站精确恢复目录中的 `cline-pass/deepseek-v4.1-flash`。不接受无提供商前缀的名称、不猜测上游 ID；映射重名时拒绝调用。Key 可以同时授权 Chat 和 Responses 提供商，请使用各自支持的原生端点。

`codexc relay delete --caller ID` 删除调用方并撤销 Key，取消其旧请求；历史指标和转储不删除。WebUI 的“删除”先预览再确认。改绑或删除会保留仅用于旧调用指标结算的历史身份摘要，不含秘密，不能用于请求鉴权；删除后新建必须使用新的 callerId 和 keyId。不删除上游账户或凭据。摘要最多 4096 条，同时受配置文件 1 MiB 限制；达到上限时拒绝整次操作，不静默清除历史摘要。

CLP 转发使用独立于 Codex 的 Cline 模型目录。在 WebUI「模型转发 → 提供商模型」首次使用自动下载缺失的模型文件，之后可手动更新；点击提供商行的“模型列表”打开弹窗，只读查看调用模型 ID、目录声明的输入格式及协议；模型授权和思考策略在 Key 编辑弹窗中设置。已有上游账户密钥继续复用，无须申请新 Key。目录补齐前 CLP 转发暂不可用；自动下载失败可手动重试，不回退 Codex 模型文件。见[转发模型目录与设置](provider-api-relay-development.md#clp-转发模型目录与设置)。

强制关闭支持目录显式声明 `none` 的 CLP 模型、CLP 的精确模型 `cline-pass/deepseek-v4.1-flash`，以及 DS 的 `deepseek-flash` / `deepseek-v4-pro`，只对当前请求中明确支持的模型生效。未声明或不支持关闭的模型继续使用客户端原参数，仍可能产生思考内容；不会阻止 Key 保存。
关闭策略覆盖顶层思考控制参数，通用 CLP Chat 实际出站为 `reasoning.enabled=false`；CLP 精确模型 `cline-pass/deepseek-v4.1-flash` 保留已验证的 `reasoning.effort=none`，DS Responses 使用 `reasoning.effort=none`，DS Chat 使用 `reasoning_effort=none`；不改历史消息或隐藏上游思考响应。
嵌套 `extra_body` / `extraBody` 的思考控制字段与关闭策略冲突时明确拒绝；跟随客户端不增加此限制。
Chat 和 Responses 的冲突错误均定位到完整字段路径，例如 `extra_body.reasoning`。
修改 Key 模型授权或思考策略会取消该 Key 的旧请求。配置保存与运行态应用分开报告，不会自动启动服务。

Relay 的 Chat 请求保留模型参数、消息内容和扩展字段，由所选上游判断是否支持；远程图片 URL
也由上游处理，Relay 不主动抓取。仅本地模型授权、JSON 对象/消息结构、stream 布尔、单选择
n=1 和请求大小等边界由 Relay 校验；Chat 消息和 Responses 输入项不设条数上限，仍受 1 MiB 请求正文预算限制；省略 stream 时默认 JSON。请求参数不能改变本机账户、
凭据或上游地址。参数透传不代表当前模型支持所有能力，响应仍遵循已记录的单选择 JSON/SSE 合同。

Relay 保留普通应用请求头（例如 User-Agent、HTTP-Referer、X-Title），入口密钥不会转发给上游。
上游 Authorization 和传输头由 Relay 控制；Cookie、代理凭据、转发来源与内部身份头剔除。

在 WebUI“请求明细”点击唯一的“查看调用详情”：已采集报文直接打开现有转储视图；未关联时仅显示“未关联”，不提供详情链接。Relay 没有 Codex 会话或轮次，HTTP 200 不等于客户端交付成功。出站 User-Agent 只记录新调用实际发送的值，缺失时不推断客户端类型。

Codex 和 Relay 共用 `[debug].model_traffic_dump`，默认关闭。在 WebUI 的 Gateway 系统设置或 `codexc config` 系统设置中，用“记录调用详情”控制采集，用“调用记录模式”选择生产或调试；不再单独按 Key 开启。只记录启用后实际出站的调用，不补录历史。

只接受当前全局采集配置，未知字段明确拒绝；不提供旧采集配置转换命令。

模式复用已有裁剪参数：生产预设为 `model_traffic_input_items = 3`、`model_traffic_item_max_bytes = 65536`，调试预设为 `0/0`；仅两项都为 0 时视为调试。自定义非零裁剪值仍受支持，切换模式才会写入预设值。Codex 沿用现有精简/完整转储，Relay 生产记录出站请求与上游响应，调试为所有调用方增加入站、交付及实际处理记录。调试没有 Key 限定或自动到期；排查完可手动恢复生产或关闭采集。Codex 更改在重启 App Server 后生效，运行中的 Relay 在配置刷新后用于新请求；已开始采集的请求按开始时的模式完成。

Codex/Relay 在生产和调试模式均保留普通请求/响应头及关联 ID，不按未知字段或诊断格式隐藏。仅遮蔽凭据类头、明显的 Bearer/Basic/Digest 值、URL 用户信息与敏感查询参数/片段、CSP nonce；未知业务头原样记录，可能包含用户业务信息，转储仅用于本机排查。模式仅影响正文裁剪及采集阶段，不决定普通头可见性。新规则只影响后续采集，旧记录无法还原已遮蔽值。Relay 每个头值最多 1 KiB，全部头最多 16 KiB；Codex 保持既有头容量；超限与正文截断明确标记。Relay 调试模式每侧请求最多 512 KiB、每侧响应最多 4 MiB，合计仍为 1 MiB/8 MiB；不是网络抓包。交付完成表示本地 HTTP 写入完成，不等于客户端已处理。鉴权/准入失败且未实际出站的请求不新增调用转储或指标。

Relay 生产记录脱敏后的出站 Chat/Responses 参数、输入和上游 JSON/SSE；请求与响应头遵循上述必要脱敏规则。翻译原文、回答及自由文本内的秘密仍会保存。请求正文最多 1 MiB、响应 8 MiB；Relay 共用 512 MiB 磁盘和 16 MiB 待写预算。保留天数统一使用 `[debug].model_traffic_retention_days`，默认 30 天，0 关闭按时间清理但保留 Relay 容量上限。首次启用在取消/超时边界内等待异步容量初始化，随后按实际已写及待写字节记账，并为在途调用预留空间。后台清理保护活动批次及扫描期间新建批次，整理期间继续采集；容量不足、写入故障或超限会留下日志或截断标记。写入故障会停止本进程后续采集，排除故障并重启 Relay 后恢复，模型转发继续。

停止采集不删除已有文件。指标库只接受当前 Schema，不提供跨版本升级或回退。不要恢复旧配置覆盖当前凭据。

模型转发管理页显示配置并发上限及运行状态，点击“刷新”更新服务状态，左侧“模型转发”下的二级菜单“请求队列”独立展示当前请求及执行阶段。配置上限不代表运行进程已应用；服务停止或状态无法确认时，不显示虚假的零队列。

Relay 支持 JSON 非流式调用，不要求客户端启用流式。失败响应提供 `code`、`phase`、
`request_id` 和已知的 `upstream_status`；除带安全 `param` 的入口字段错误外，`message` 也包含这些定位信息。
`X-Relay-Request-Id` 可与指标记录关联。`invalid_upstream_*` 表示上游响应类型或字段校验失败；
例如上游 HTTP 200 配合 `invalid_upstream_tools` 表示工具响应字段校验未通过，并非上游返回了 502。
Chat 和 Responses 的 JSON/SSE 内容无法解析为 JSON 时统一返回 `invalid_upstream_json`，不回显上游原文。
WebUI 请求列表的失败状态提示可查看错误码；诊断不包含请求内容、密钥或上游错误原文。
上游 429/503 提供的 `Retry-After` 在为受限整数秒或规范 HTTP 日期时会保留，客户端可据此退避；Relay 不自动重试。
Chat 的长度限制、内容过滤、`insufficient_system_resource` 和 `aborted` 终态原样交付，指标与新转储记为未完整完成。
工具参数字符串原样保留，客户端须在执行工具前验证 JSON 与参数含义；Relay 不执行工具或补齐参数。
Chat 与 Responses 的非流式首内容耗时在整包解析校验后观测，不是上游实际生成首 Token 的时间；空内容不填此值。

Relay 返回 403 `model_not_allowed` 时，请使用当前 Key 的 `GET /v1/models` 返回的精确模型 ID，
包括提供商前缀。模型必须同时位于 Key 授权列表和 Provider 的有效模型目录中；此类拒绝发生在出站前，
不会新增上游调用指标，也不表示 CLP 返回了 403。

Relay 的 JSON 非流式响应同时接受标准 Chat 对象和 CLP 的 `{success:true,data:...}` 包装；
客户端收到的仍是标准 Chat 响应。包装失败或内部响应不合法时返回明确错误，不当作成功生成。

Relay 只执行全局限流，不与本机 App Server 的代理共用计数。`[model_relay]` 的
`max_concurrency` 可设为 1–32，默认 10；`requests_per_minute` 可设为 0–600，默认 0
（关闭分钟与突发限制）；`burst` 为 1–32，默认 10，仅在分钟速率为正数时生效。
提供商提供只读模型目录，Key 管理身份及跨提供商的模型授权；提供商和 Key 均不单独设置执行限额。鉴权失败保护始终保留。

Chat 与 Responses 请求在全局并发或令牌不足时排队：上传和等待合计最多 32 个，正文预算合计 16 MiB。
上传前每个请求先预留 1 MiB，正文验证后按原始请求正文的实际字节释放多余预算；单请求原始正文
及处理后序列化的出站正文均不超过 1 MiB。计数和字节预算任一达到上限都会拒绝，所以不能保证同时接受
32 个大请求。上传限时 15 秒，正文验证后的等待最长 30 秒，均计入请求总期限 300 秒。
同一 Key 先入先出，不同 Key 轮转；没有每 Key 数量上限。`GET /v1/models` 不排队，仍受全局限额。

队列满返回 HTTP 429 `relay_queue_full`，等待超时返回 HTTP 429 `relay_queue_timeout`，
并带 `upstream_attempted:false`；未出站的拒绝、超时和撤销不会进入模型调用指标。
客户端断开、Key 撤销或 Relay 关闭时取消等待，不自动重试；队列仅在内存中，重启不恢复。
`codexc relay status` 返回执行数 `active` 及 `queue.pending`（上传与等待）、`queue.waiting`
（已验证正文的等待）、`queue.bytes`（正文预留预算），不包含请求正文。WebUI 左侧“模型转发”下的“请求队列”可查看实时阶段与等待情况，详见[WebUI](webui.md)。

Relay 只支持当前严格配置，不接受旧账户模型列表、Key 单提供商字段、分层限流或独立采集字段。控制 IPC 为 v6，更新后需重启相关进程；新旧进程混用时确认结果为 `unconfirmed`，不能据此认定撤销已生效。配置备份不得覆盖当前凭据和撤销记录。

### 渠道文本附件

飞书、微信、Telegram 的独立文本文件输入上限为 1,000,000 字节，要求有效 UTF-8；
网关自动清理常见终端转义序列，不按文件后缀判断文本内容。清理后不超过 32 KiB 的正文直接提交；
较大文本保存到网关数据目录的私有 uploads 子目录，由同机 Codex 工具按路径搜索、分段读取，
不把全文放入当前输入。读取仍受当前权限约束，网关不会自动扩权。

暂存文件随机命名，保留 24 小时；每个渠道暂存目录最多 50 个文件、50,000,000 字节。
运行时每分钟清理过期文件，重启时也清理；停止期间文件保留至下次启动清理。
附件不是永久会话历史，过期后需重新发送。更换执行机器不会自动复制附件。
飞书支持独立文件及富文本 `media` 文件资源，每条最多 4 个文本附件，总大小不超过 1,000,000 字节；任一文件失败则整组不提交。富文本资源未提供原文件名时使用“附件-N.txt”显示标签，标签不代表实际文件格式；仍按内容严格校验。
PDF、Office 和压缩包不在文本解析范围内。
