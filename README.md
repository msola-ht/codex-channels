# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hegenai/codexc)](https://www.npmjs.com/package/@hegenai/codexc)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。

通过 `codexc remote` 启动的原生 Codex TUI 与聊天客户端按模型提供商共享同一个 Codex App
Server，因此可以继续使用对应的会话、Thread 和运行状态。

`main` 开发基线：`0.148.0`
当前正式版：`0.148.0`
要求：macOS 或 Linux、Node.js 22.13+、已登录的 `codex-cli 0.148.0`

## 快速开始

安装配套版本：

```bash
npm install -g @openai/codex@0.148.0
npm install -g @hegenai/codexc@0.148.0
```

也可以在 Linux 或 macOS 上把官方 `main` 分支 Git 仓库安装到
`~/.codex-connect/codex-channels`：

```bash
curl -fsSL https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.sh | sh
```

安装器会从源码构建并注册 npm 全局 `codexc` 命令，不修改 Shell PATH。目录、环境检测、更新和失败处理见
[`Git 源码安装`](docs/source-install.md)。

初始化并配置通讯渠道：

```bash
codexc init
codexc setup
```

`codexc config` 提供脱敏配置总览，并可交互调整 Gateway 的显示、系统、自动化、网络、WebUI
和指标设置；在脚本或管道中运行时会输出用户目录与配置文件路径。

注册需要让 Codex 操作的项目：

```bash
cd /absolute/path/to/project
codexc work add
```

安装后台服务并检查：

```bash
codexc service install
codexc doctor
codexc service status
```

Linux 安装后台服务时会检查并尝试启用 systemd linger，使服务在系统启动且用户尚未登录时也能
运行。当前用户没有启用权限时，安装会停止并显示需要管理员执行的精确命令；执行后重新运行
`codexc service install`。

完成后，在已配置的聊天客户端中私聊机器人即可使用。发送 `/help` 查看聊天命令。

## Setup 配置

运行 `codexc setup`，可先查看不显示凭据的配置总览，再按菜单配置模型与提供商、共享第三方子代理、
通讯渠道和项目技能（安装到 `~/.agents/skills` 供当前 Codex 环境加载）。Gateway 与通讯渠道配置保存在：

```text
~/.codex-connect/config.toml
```

Telegram、飞书和微信至少配置并启用一个即可启动 Gateway。Telegram 以非空 `bot_token` 表示启用；
Token 缺失或留空时不创建 Telegram 连接，也不要求 `allowed_user_ids`。填入 Token 后必须同时配置
至少一个允许用户，避免 Bot 在没有授权边界时启动。

渠道准备事项：

- Telegram：准备 BotFather 创建的 Bot Token；向导会生成配对入口以获取用户 ID。
- 飞书：可扫码创建或选择企业自建应用，也可手工输入 App ID 和 App Secret；扫码配置只把本次扫码
  用户设为允许用户，不沿用旧应用名单。配置后先在终端运行 `codexc doctor` 检查权限、消息事件和
  待发布版本。机器人已经能接收私聊后，可发送 `/fs doctor` 检查运行观测和菜单。
- 微信：通过向导扫码保存凭据；确认账号和允许用户后，将配置中的 `weixin.enabled` 改为
  `true`，再运行 `codexc service reload`。

配置示例见 [`config.example.toml`](config.example.toml)。修改配置后运行：

```bash
codexc service reload
```

无法直连 OpenAI 的网络需要配置 HTTP(S) 代理。Gateway 优先使用 `config.toml`，其次读取
`HTTPS_PROXY` / `HTTP_PROXY` 等标准环境变量和当前系统代理：

```toml
[network]
https_proxy = "http://127.0.0.1:7890"
```

运行 `codexc doctor` 可确认 OpenAI 请求会走代理还是直连；修改代理后运行
`codexc service install`，重新生成包含当前网络环境的后台服务。Gateway 启动时还会做一次
OpenAI 传输探测；连接失败时会在
已有授权会话的上线通知中提醒检查代理，但不会停止 Gateway。

### 可选设置

```toml
[display]
operation_updates = "compact"
plan_updates = true
reasoning = true
price_currency = "cny"
```

`operation_updates` 控制操作过程详情，`plan_updates` 控制计划更新，`reasoning` 控制“思考中”
状态卡显示，`price_currency` 统一选择人民币或美元。完整显示与统计口径见
[`docs/display.md`](docs/display.md)。

运行 `codexc config` 选择「指标设置 → 本机接入中心」，即可把多台设备的脱敏指标汇总到中心。
服务端配置、令牌边界和数据说明见 [`docs/metrics-sync.md`](docs/metrics-sync.md)。

在 `codexc config` 中选择“系统设置 → 调试模式”，可开启脱敏的运行阶段、耗时和统计详情。
后台服务运行时会自动重启 Gateway，未运行时在下次启动生效；前台运行时需重新启动。
调试内容不会包含消息正文、凭据或审批内容。

Codex 0.148.0 的 Plugin API 仍在开发中，Gateway 默认关闭。需要调试时可在
`codexc config` 中选择“高级设置 → Plugin API”，或显式配置：

```toml
[experimental]
plugin_api = true
```

使用 `/plugin` 查看已安装项并发起调试任务；使用 `/mcp` 查看 Server、工具、资源、认证状态或
刷新配置。完整命令、限制和渠道显示规则见 [`docs/display.md`](docs/display.md)，协议采用范围见
[`docs/index.md`](docs/index.md)。

### Codex 官方

在 `codexc setup` 中选择“模型与提供商 → OpenAI 官方 → 默认模型与思考等级”，可从当前 Codex 模型目录设置全局默认模型和
思考等级。设置通过 App Server 写入 `~/.codex/config.toml`，不修改 Codex 登录状态；完成后运行
`codexc service restart all`，让新 App Server 会话使用新的默认值。

### 自定义第三方 Provider

运行 `codexc setup`，选择“模型与提供商 → 第三方 Provider → 自定义 Responses Provider”，可新增或编辑 OpenAI Responses
兼容 Provider，并选择保留官方 OpenAI 的切换模式或仅使用第三方的固定模式。Provider ID、模型与认证、
配置文件、安全限制和模式切换边界见
[`第三方模型 Provider 接入指南`](docs/provider-integration-guide.md)。常用管理命令：

```bash
codexc primary-provider list [--json]                # 查看配置
codexc primary-provider add                          # 新增 Provider
codexc primary-provider switch openai                # 切回官方主 Provider
codexc primary-provider switch <Provider ID> [模型]  # 切换主 Provider
codexc primary-provider remove <Provider ID>         # 删除 Provider
```

切换模式下，终端使用 `codexc remote --profile custom-<Provider ID>` 连接对应隔离实例；
`sf-custom-<Provider ID>` 是内部 Codex Profile 名称，不作为 `codexc remote` 的公开参数。
固定或切换模式的自定义 Provider 也可在 Setup 的“共享第三方子代理”中设为
`agents.external`；当前使用该 Provider 时必须先切换或停用子代理，才能恢复官方模式或删除 Provider。

旧版单文件 `sf-custom.config.toml` 不自动迁移；删除旧配置后重新运行 Setup 即可。

修改后运行：

```bash
codexc service restart all
```

旧会话仍使用创建时的 Provider；切换后请先 `/new` 创建新会话，新配置才会生效。若之前用
`/model` 选过模型，先执行 `/model clear` 清除会话偏好，否则它仍会覆盖配置文件默认值。

### DeepSeek

在 `codexc setup` 中选择“模型与提供商”，可以配置 OpenAI 与 DeepSeek 切换模式、仅 DeepSeek 模式
或恢复原配置；选择“受管 Provider 模型设置”可按 Provider 和模型设置默认模型、思考等级与自动压缩阈值，
选择“共享第三方子代理”可切换其 Provider 与模型或停用 `agents.external`。DeepSeek 两种模式都会
默认启用该共享子代理；配置后运行：

```bash
codexc service restart all
```

聊天中使用 `/model` 切换；当前渠道模型会在切换 Workspace、新会话或同 Provider 历史会话时继续
用于下一 Turn，显式恢复不同 Provider 的历史会话时仍尊重该 Thread 的 Provider。终端使用
`codexc remote --profile deepseek`。模型限制、原生视觉、自动压缩、
子代理和跨 Provider 行为见 [`DeepSeek 使用说明`](docs/deepseek.md)。

从旧版外部识图升级时，`codexc update` 会先创建私有备份，再自动移除
`~/.codex-connect/config.toml` 中整个 `[vision]` 配置段，避免严格 Schema 拒绝启动。
`api_providers` 及其按提供商保存的 API Key 会继续保留；旧 `credentials/vision/` 凭据不再读取，
也不会自动删除。

### OpenCode Go

在 `codexc setup` 的“模型与提供商”中可配置独立 OpenCode Go Provider，并支持同一 Gateway 内
多个账户（各自 Key、各自套餐额度）；当前开放 `deepseek-v4-flash`、
`deepseek-v4-flash-vision-exp` 和 `deepseek-v4-pro`，支持保留
OpenAI 的切换模式和仅 OpenCode Go 固定模式。账户管理命令：

```bash
codexc opencode-go account add <id>
codexc opencode-go account list [--json]
codexc opencode-go account remove <id>
codexc opencode-go account default <id>
codexc opencode-go account stop <id>
```

它与 DeepSeek 官方配置、凭据和价格独立；所有账户共享一个统计代理，每个账户的隔离 App Server
按需启动、空闲 5 分钟自动释放（释放后会通知渠道一次，再次使用自动拉起）。也可作为共享
`agents.external` 子代理（只指向默认账户）。聊天使用 `/model` 选择
“OpenCode Go（账户）”模型，终端使用 `codexc remote --profile opencode-go`（默认账户）或
`--profile opencode-go-<账户>`；`/usage`
只展示当前 Thread 账户的额度，WebUI 按账户分别展示。配置、协议范围和官方全模型价格维护见
[`OpenCode Go 使用说明`](docs/opencode-go.md) 与
[`多账户实现`](docs/opencode-go-multi-account.md)。

## 日常使用

### 管理项目

```bash
codexc work                          # 交互式管理 Workspace
codexc work add                      # 注册当前目录
codexc work list [--json]            # 列出 Workspace
codexc work remove <序号|ID|名称>    # 删除注册，不删除项目文件
```

聊天客户端只能选择已经注册的 Workspace，不能提交任意本机目录。

运行 `codexc work` 可为 Workspace 单独配置沙箱、审批策略或权限 Profile；聊天中使用
`/workspaceperm` 查看或修改。

### 在终端继续会话

```bash
cd /absolute/path/to/project
codexc remote
codexc remote resume
codexc remote --profile deepseek resume
```

`codexc remote` 连接 Gateway 使用的 App Server。直接运行 `codex` 或 `codex --profile sf-deepseek`
会启动独立 TUI，不共享 Gateway Thread。当前目录位于已注册 Workspace 内，或显式使用
`--workspace <ID>` 时，Remote TUI 会沿用该 Workspace 的沙盒、审批策略或权限 Profile；未匹配
Workspace 时使用全局 Sandbox 与按需审批。显式传给 Codex 的权限参数仍优先。
未受管的个人 Codex Profile 仍可提供模型等设置；如需覆盖 Workspace 权限，须显式传入对应的
Codex 权限参数。

### 查看指标 WebUI

```bash
codexc webui                          # 启动本地只读指标 WebUI（默认 http://127.0.0.1:8787/）
codexc webui --host 0.0.0.0 --token 令牌  # 非回环地址必须提供令牌
```

WebUI 只读指标数据库；监听、令牌、远程访问与后台服务说明见 [`docs/webui.md`](docs/webui.md)。

### 发送图片到渠道

```bash
codexc channel send-image /tmp/截图.png                   # 自动选择唯一绑定会话
codexc channel send-image /tmp/截图.png --thread <Thread ID>  # 指定会话
```

把本地 PNG/JPEG 图片交给 Gateway，由 Thread 绑定渠道的机器人凭据发送回对应会话，
不依赖 lark-cli 等外部工具。详细说明见 [`docs/channel-image.md`](docs/channel-image.md)。

### 管理后台服务

```bash
codexc start                          # 前台启动 App Server 与 Gateway（调试用）
codexc service status                 # 查看全部核心服务
codexc service status --json          # 输出统一的 macOS/Linux 服务状态对象
codexc service reload                 # 重新读取配置
codexc service restart                # 只重启 Gateway
codexc service restart all            # 重启 Gateway 和 App Server
codexc service start webui            # 启动 WebUI 后台服务
codexc service start center           # 启动指标中心后台服务
codexc service logs                   # 查看 Gateway 日志
codexc service logs all -n 200        # 查看全部核心服务最近 200 行日志
```

`start`、`stop` 和 `status` 默认操作全部核心服务；`restart` 和 `logs` 默认只操作 Gateway。运行
`codexc service -h` 查看完整用法。WebUI 与指标中心不并入 `all`，需要时单独启动。
服务操作会等待目标真正就绪；失败时按提示查看状态和日志。

服务重启建议从本机终端执行。聊天 Turn 内重启 Gateway 可能使过程或完成消息落在重连窗口。渠道内
会拒绝安装或卸载服务、停止 Gateway/App Server，以及重启 App Server；对应的 `all` 操作同样拒绝。
渠道内仍可查看状态和日志、重新加载或启动服务、只重启 Gateway，以及管理独立的 WebUI/指标中心。
需要执行被拒绝的操作时，按提示复制命令到本机终端运行。
Gateway 会自动监听第三方 Provider 的模型目录与 Profile 变化，校验通过并在无活动 Turn 时自动
重启 App Server；该自动重启由服务自身触发，渠道内手动重启 App Server 仍被拒绝。

查看、导出或清理脱敏指标：

```bash
codexc metrics status
codexc metrics status --json                     # 稳定 JSON 数据库状态
codexc metrics threads                            # 会话归纳总览（模型、Token、费用）
codexc metrics report --range 30d --group models  # 聚合汇报
codexc metrics export --range 30d --format json   # 脱敏明细导出；--thread 可按 Thread 过滤
codexc metrics reset                              # 先保留 0600 旧库备份，再重建
codexc metrics cleanup --keep-days 90 --restart-gateway # 备份并按自定策略清理
```

导出格式、时间范围、价格换算、保留策略和数据边界见 [`docs/display.md`](docs/display.md)；
多设备修复与同步命令见 [`docs/metrics-sync.md`](docs/metrics-sync.md)。

脚本还可使用 `codexc agents status --json` 查看共享第三方子代理状态，使用
`codexc center info --json` 查看不含令牌内容的指标中心运行与端点信息，使用
`codexc service status [目标] --json` 获取 macOS launchd 或 Linux systemd 的统一服务状态，使用
`codexc doctor --json` 获取完整的脱敏诊断检查结果，使用 `codexc rules check --json` 获取项目规则
校验结果，使用 `codexc config --json` 获取配置路径与文件存在状态。

### 常用聊天命令

- 会话：`/new`、`/resume`、`/sessions`、`/archived`、`/rename`、`/archive`、`/unarchive`、`/pin`、`/unpin`、`/section`
- Workspace：`/workspace`、`/workspaceperm`
- 运行：`/status`、`/stop`、`/queue add <文本>`、`/queue list [页码]`、`/queue update <ID 或列表序号> <文本>`、`/queue delete <ID 或列表序号>`、`/queue reorder <ID 或列表序号> <位置>`、`/queue start [ID 或列表序号]`、`/revert list [页码]`、`/revert <Turn ID 或列表序号>`、`/revert confirm <一次性令牌>`、`/compact`、`/fork`、`/review`、`/release`；Queue 由 App Server 持久保存，容量最多 100 条
- 计划任务：在 `codexc config` 中选择“自动化 → 计划任务”启用后使用 `/schedule` 查看；启用后新建的前台 Thread 可由 Agent 调用 `schedule_task` 工具创建确认预览，飞书和 Telegram 提供确认/取消按钮，微信使用 `/schedule confirm <令牌>`；既有 Thread 不会为注入工具而自动切换，仍可使用 `/schedule <自然语言>`、`/schedule add interval <N>m|h <时区> <文本>`、`/schedule add once <日期> <时间> <时区> <文本>` 等命令；支持每 N 分钟、每天、工作日、每周、每月与一次性，完整语法与安全边界见 [`docs/scheduled-tasks-development.md`](docs/scheduled-tasks-development.md)
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 状态：`/diff`、`/usage`、`/metrics`、`/limits`、`/permissions`、`/goal`
- 扩展：`/agents`、`/skill`、`/plugin`、`/mcp`、`/rules`
- 图片：直接发送 PNG/JPEG/WebP/非动画 GIF；当前模型不支持图片时，先用 `/model` 切换到支持图片的模型
- 帮助：`/help`、`/whoami`

飞书中需要引用其他消息时，请直接回复目标消息后发送要求。Gateway 不解析飞书“复制消息链接”，
收到这类链接会在创建 Turn 前明确拒绝。

任务运行中也可以使用 `/resume` 或 `/new` 切换会话：原任务会继续在后台运行，结果和审批仍返回
当前聊天并标记所属 Thread；同一聊天最多保留 3 个后台任务。普通消息只发送给当前前台 Thread，
需要继续操作后台任务时使用 `/resume` 将其切回前台。

`/sessions` 与 `/archived` 支持分页和组合筛选；`/pin` 与 `/unpin` 管理当前会话的内置 Pinned 状态，
`/section` 查看 App Server 原生全局分区，自定义分区写操作需要配置管理员。完整语法以 `/help` 为准，协议与安全边界见
[`docs/index.md`](docs/index.md)。

`/revert` 只对新建的分页历史 Thread 开放，必须先列出目标 Turn，再预览并使用一次性令牌确认；它只回退
App Server 历史，不恢复工作区文件。完整边界与条件式真实合同见 [`docs/thread-queue-revert-development.md`](docs/thread-queue-revert-development.md)。

`/release` 查看当前会话的 Codex Thread 是否被其他客户端占用；确认后 `/release force` 会结束占用进程并
自动重试恢复，App Server 子进程被结束时服务会自动重启。

命令、文件修改和额外权限默认不会自动批准。审批、用户输入和 MCP 交互会逐项显示，并绑定当前
用户、会话和 Turn。

## 排查问题

```bash
codexc doctor
codexc doctor --json
codexc service status
codexc service logs -n 100
```

`codexc doctor` 完成全部检测后，只展示失败、提示与处理建议，并保持只读。

常见处理：

- 修改配置后没有生效：运行 `codexc service reload`。
- 单个聊天渠道断线：其他渠道会继续运行，可用 `codexc service logs -f` 查看恢复记录。
- 独立 `codex` 正在使用聊天绑定的同一 Thread：Gateway 仍会启动并提示该会话被占用；退出独立
  `codex` 后，Gateway 会自动恢复订阅并再次提示。终端需要共享会话时使用 `codexc remote`。
- 只需重启 Gateway：运行 `codexc service restart`，共享 App Server 和活动 Thread 会保留。
- Codex CLI 版本不一致：重新安装精确版本 `@openai/codex@0.148.0`。
- 飞书完全收不到消息：先在终端运行 `codexc doctor`；如提示权限、消息事件或版本未生效，重新运行
  `codexc setup`，扫码时选择当前应用并完成授权、审核和发布。机器人能接收私聊但菜单不完整时，
  再发送 `/fs doctor`。
- 需要根据日志定位错误：错误码与日志字段约定见 [`docs/errors.md`](docs/errors.md)。
- 需要查看参数：运行 `codexc -h` 或 `codexc <命令> -h`。

分享日志前请人工检查内容。Gateway 会脱敏已知凭据，但 App Server 原始日志可能包含命令、工作内容
或诊断上下文。

## 升级与卸载

```bash
npm install -g @hegenai/codexc@0.148.0
npm install -g @openai/codex@0.148.0
codexc service install
codexc update
codexc doctor
```

日常升级统一使用 `codexc update`。Git 源码安装会更新官方 `main` 并刷新 npm 全局命令，后台服务
已安装时会自动停止并恢复；未安装时只离线更新配置和数据库。旧版第三方 Provider 文件会在停机
窗口内先自动备份，再迁移到 `~/.codex-connect/providers/<id>/`；已配置的 DeepSeek 与 OpenCode Go
会同步刷新受控官方模型目录并保留逐模型设置；首次升级时，OpenCode Go 仍使用旧默认 Flash 的账户
会自动切换到 Flash Vision Exp，已主动选择 Pro 的账户不变，迁移完成后再手动选回 Flash 也会保留；
已废弃的 `[vision]` 配置段会在备份后自动移除。
该命令必须从本机终端执行。详细
流程和失败处理见
[`Git 源码安装`](docs/source-install.md)。

卸载 Git 源码、对应 npm 全局命令和旧 Shell PATH 配置，并保留用户数据：

```bash
codexc uninstall
```

npm 全局版使用 `codexc service uninstall` 卸载后台服务，再执行
`npm uninstall -g @hegenai/codexc`。

npm 包与 Codex CLI 使用相同版本。

## 源码开发

```bash
git clone https://github.com/msola-ht/codex-channels.git
cd codex-channels
npm ci
cp config.example.toml config.toml
chmod 600 config.toml
```

编辑 `config.toml`，填写渠道凭据、允许用户和 Workspace 的绝对路径，然后启动：

```bash
npm run dev:all
```

常用验证：

```bash
npm run check
npm run lint
npm run docs:check
npm test
npm run verify:commit
```

从当前源码安装全局命令：

```bash
npm run install:global
```

该命令会同时构建 Gateway 与 WebUI 前端（`webui/dist`），之后
`codexc webui` 可直接启动。

完整项目文档见 [`index.md`](index.md)。

## 联系方式

微信扫码联系：

![微信二维码](assets/wechat-qr.png)

二维码图片存放在 [`assets/wechat-qr.png`](assets/wechat-qr.png)，替换该文件即可更新。

## License

[MIT](LICENSE)
