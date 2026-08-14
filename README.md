# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hegenai/codexc)](https://www.npmjs.com/package/@hegenai/codexc)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。

通过 `codexc remote` 启动的原生 Codex TUI 与聊天客户端按模型提供商共享同一个 Codex App
Server，因此可以继续使用对应的会话、Thread 和运行状态。

`main` 开发基线：`0.147.0`
当前正式版：`0.147.0`
要求：macOS 或 Linux、Node.js 22.13+、已登录的 `codex-cli 0.147.0`

## 快速开始

安装配套版本：

```bash
npm install -g @openai/codex@0.147.0
npm install -g @hegenai/codexc@0.147.0
```

初始化并配置通讯渠道：

```bash
codexc init
codexc setup
```

`codexc config` 提供交互式配置与设置菜单，覆盖配置文件中可安全编辑的参数：显示设置（操作
详情、计划更新、参考价人民币换算）、系统设置（调试模式、审批超时、Sandbox、默认工作区与
渠道新会话模型覆盖）、工作区设置（沙箱、审批策略、权限 Profile）、Telegram 消息格式，以及配置路径查看。
在脚本或管道中运行时会直接输出用户目录与配置文件路径。

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

## 配置通讯渠道

运行 `codexc setup`，按菜单配置模型渠道、通讯渠道和技能安装（把项目技能安装到
`~/.agents/skills` 供当前 Codex 环境加载）。Gateway 与通讯渠道配置保存在：

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

### 可选设置

```toml
[display]
operation_updates = "compact"
plan_updates = true
price_currency = "cny"
```

`operation_updates` 控制操作过程详情，`plan_updates` 控制计划更新，`price_currency` 统一选择
人民币或美元。完整显示与统计口径见 [`docs/display.md`](docs/display.md)。

运行 `codexc config` 选择「指标设置 → 本机接入中心」，即可把多台设备的脱敏指标汇总到中心。
服务端配置、令牌边界和数据说明见 [`docs/metrics-sync.md`](docs/metrics-sync.md)。

在 `codexc config` 中选择“系统设置 → 调试模式”，可开启脱敏的运行阶段、耗时和统计详情。
修改后运行 `codexc service restart gateway`。调试内容不会包含消息正文、凭据或审批内容。

Codex 0.147.0 的 Plugin API 仍在开发中，Gateway 默认关闭。需要调试时显式开启并重启 Gateway：

```toml
[experimental]
plugin_api = true
```

使用 `/plugin` 查看已安装项并发起调试任务；使用 `/mcp` 查看 Server、工具、资源、认证状态或
刷新配置。完整命令、限制和渠道显示规则见 [`docs/display.md`](docs/display.md)，协议采用范围见
[`docs/index.md`](docs/index.md)。

### Codex 官方

在 `codexc setup` 中选择“模型渠道 → Codex 官方”，可从当前 Codex 模型目录设置全局默认模型和
思考等级。设置通过 App Server 写入 `~/.codex/config.toml`，不修改 Codex 登录状态；完成后运行
`codexc service restart all`，让新 App Server 会话使用新的默认值。

### DeepSeek

在 `codexc setup` 中选择“模型渠道”，可以配置 OpenAI 与 DeepSeek 切换模式、仅 DeepSeek 模式
或恢复原配置。切换模式会自动启用 `multi_agent_v2` 并注册 `ds` 子代理角色；配置后运行：

```bash
codexc service restart all
```

聊天中使用 `/model` 切换；终端使用 `codexc remote --profile deepseek`。模型限制、自动压缩、
子代理和跨 Provider 行为见 [`DeepSeek 使用说明`](docs/deepseek.md)；外部识图见
[`图片识别代理`](docs/vision.md)。

## 日常使用

### 管理项目

```bash
codexc work                          # 交互式管理 Workspace
codexc work add                      # 注册当前目录
codexc work list                     # 列出 Workspace
codexc work remove <序号|ID|名称>    # 删除注册，不删除项目文件
```

聊天客户端只能选择已经注册的 Workspace，不能提交任意本机目录。

Workspace 可单独配置沙箱、审批策略或权限 Profile；聊天中使用 `/workspaceperm` 查看或修改。

### 在终端继续会话

```bash
cd /absolute/path/to/project
codexc remote
codexc remote resume
codexc remote --profile deepseek resume
```

`codexc remote` 连接 Gateway 使用的 App Server。直接运行 `codex` 或 `codex --profile deepseek`
会启动独立 TUI，不共享 Gateway Thread。

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

把本地 PNG/JPEG 图片交给 Gateway，由当前飞书/微信/Telegram 会话的机器人凭据发送，
不依赖 lark-cli 等外部工具。详细说明见 [`docs/channel-image.md`](docs/channel-image.md)。

### 管理后台服务

```bash
codexc start                          # 前台启动 App Server 与 Gateway（调试用）
codexc service status                 # 查看全部服务
codexc service reload                 # 重新读取配置
codexc service restart                # 只重启 Gateway
codexc service restart all            # 重启 Gateway 和 App Server
codexc service start webui            # 启动 WebUI 后台服务
codexc service start center           # 启动指标中心后台服务
codexc service logs                   # 查看 Gateway 日志
codexc service logs all -n 200        # 查看全部服务最近 200 行日志
```

`start`、`stop` 和 `status` 默认操作全部服务；`restart` 和 `logs` 默认只操作 Gateway。运行
`codexc service -h` 查看完整用法。WebUI 与指标中心不并入 `all`，需要时单独启动。
核心服务执行安装、启动或重启后，CLI 会等待 App Server 监管拓扑、WebSocket 与 Gateway
应用就绪状态稳定；超时会返回失败并提示查看对应状态和日志，不会把服务管理器已接受命令
直接当作服务健康。

服务重启建议从本机终端执行。聊天 Turn 内重启 Gateway 可能使过程或完成消息落在重连窗口。渠道内
会拒绝安装或卸载服务、停止 Gateway/App Server，以及重启 App Server；对应的 `all` 操作同样拒绝。
渠道内仍可查看状态和日志、重新加载或启动服务、只重启 Gateway，以及管理独立的 WebUI/指标中心。
需要执行被拒绝的操作时，按提示复制命令到本机终端运行。

查看、导出或清理脱敏指标：

```bash
codexc metrics status
codexc metrics threads                            # 会话归纳总览（模型、Token、费用）
codexc metrics report --range 30d --group models  # 聚合汇报
codexc metrics export --range 30d --format json   # 脱敏明细导出；--thread 可按 Thread 过滤
codexc metrics reset                              # 先保留 0600 旧库备份，再重建
codexc metrics cleanup --keep-days 90 --restart-gateway # 备份并按自定策略清理
```

导出格式、时间范围、价格换算、保留策略和数据边界见 [`docs/display.md`](docs/display.md)；
多设备修复与同步命令见 [`docs/metrics-sync.md`](docs/metrics-sync.md)。

### 常用聊天命令

- 会话：`/new`、`/resume`、`/sessions`、`/archived`、`/rename`、`/archive`、`/unarchive`、`/pin`、`/unpin`、`/section`
- Workspace：`/workspace`、`/workspaceperm`
- 运行：`/status`、`/stop`、`/queue <描述>`、`/compact`、`/fork`、`/review`
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 状态：`/diff`、`/usage`、`/metrics`、`/limits`、`/permissions`、`/goal`
- 扩展：`/agents`、`/skill`、`/plugin`、`/mcp`、`/rules`
- 图片：`/vision <下一批要求>`；多图：`/vision <2–4> <要求>`，收齐自动提交；失败重试：`/vision retry`；取消：`/vision cancel`
- 帮助：`/help`、`/whoami`

飞书中需要引用其他消息时，请直接回复目标消息后发送要求。Gateway 不解析飞书“复制消息链接”，
收到这类链接会在创建 Turn 前明确拒绝。

任务运行中也可以使用 `/resume` 或 `/new` 切换会话：原任务会继续在后台运行，结果和审批仍返回
当前聊天并标记所属 Thread；同一聊天最多保留 3 个后台任务。普通消息只发送给当前前台 Thread，
需要继续操作后台任务时使用 `/resume` 将其切回前台。

`/sessions` 与 `/archived` 支持分页和组合筛选；`/pin` 与 `/unpin` 管理当前会话的内置 Pinned 状态，
`/section` 查看 App Server 原生全局分区，自定义分区写操作需要配置管理员。完整语法以 `/help` 为准，协议与安全边界见
[`docs/index.md`](docs/index.md)。

命令、文件修改和额外权限默认不会自动批准。审批、用户输入和 MCP 交互会逐项显示，并绑定当前
用户、会话和 Turn。

## 排查问题

```bash
codexc doctor
codexc service status
codexc service logs -n 100
```

`codexc doctor` 完成全部检测后，只展示失败、提示与处理建议，并保持只读。

常见处理：

- 修改配置后没有生效：运行 `codexc service reload`。
- 单个聊天渠道断线：其他渠道会继续运行，可用 `codexc service logs -f` 查看恢复记录。
- 只需重启 Gateway：运行 `codexc service restart`，共享 App Server 和活动 Thread 会保留。
- Codex CLI 版本不一致：重新安装精确版本 `@openai/codex@0.147.0`。
- 飞书完全收不到消息：先在终端运行 `codexc doctor`；如提示权限、消息事件或版本未生效，重新运行
  `codexc setup`，扫码时选择当前应用并完成授权、审核和发布。机器人能接收私聊但菜单不完整时，
  再发送 `/fs doctor`。
- 需要根据日志定位错误：错误码与日志字段约定见 [`docs/errors.md`](docs/errors.md)。
- 需要查看参数：运行 `codexc -h` 或 `codexc <命令> -h`。

分享日志前请人工检查内容。Gateway 会脱敏已知凭据，但 App Server 原始日志可能包含命令、工作内容
或诊断上下文。

## 升级

```bash
npm install -g @hegenai/codexc@0.147.0
npm install -g @openai/codex@0.147.0
codexc service install
codexc update
codexc doctor
```

`codexc update` 会先只读校验 `config.toml` 以及状态库、指标库的版本与必需结构；预检通过后自动停止
App Server 与 Gateway，在停机窗口内备份并补齐当前配置 Schema 明确定义的缺失安全参数、分别备份并
执行受支持的数据库迁移，再次离线校验后恢复核心服务并确认其真实就绪。未知配置字段、结构残缺或
没有明确迁移路径的数据库版本会失败关闭。该命令不安装 npm 包，也不修改 Codex Thread 或
`~/.codex/config.toml`。

该命令必须从本机终端执行，不能在渠道 Turn 或其他运行中的 Codex 服务进程内调用。

单库排障仍可使用 `codexc state upgrade` 或 `codexc metrics upgrade`，日常版本升级只需运行
`codexc update`。

npm 包与 Codex CLI 使用相同版本。正式发布时先在发布提交中同步本页版本与安装命令，通过
`main` CI 后再创建 Tag、发布 npm 和 GitHub Release；Release 不会自动修改 README。

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
