# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hegenai/codexc)](https://www.npmjs.com/package/@hegenai/codexc)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。

通过 `codexc remote` 启动的原生 Codex TUI 与聊天客户端按模型提供商共享同一个 Codex App
Server，因此可以继续使用对应的会话、Thread 和运行状态。

`main` 开发基线：`0.146.0`
当前正式版：`0.146.0`
要求：macOS 或 Linux、Node.js 22.13+、已登录的 `codex-cli 0.146.0`

## 快速开始

安装配套版本：

```bash
npm install -g @openai/codex@0.146.0
npm install -g @hegenai/codexc@0.146.0
```

初始化并配置通讯渠道：

```bash
codexc init
codexc setup
```

注册需要让 Codex 操作的项目：

```bash
cd /absolute/path/to/project
codexc ws add
```

安装后台服务并检查：

```bash
codexc service install
codexc doctor
codexc service status
```

Linux 如需退出 SSH 后继续运行，再执行一次：

```bash
sudo loginctl enable-linger "$USER"
```

完成后，在已配置的聊天客户端中私聊机器人即可使用。发送 `/help` 查看聊天命令。

## 配置通讯渠道

运行 `codexc setup`，按菜单配置模型渠道、通讯渠道和系统设置。Gateway 与通讯渠道配置保存在：

```text
~/.codex-connect/config.toml
```

渠道准备事项：

- Telegram：准备 BotFather 创建的 Bot Token；向导会生成配对入口以获取用户 ID。
- 飞书：可扫码创建或选择企业自建应用，也可手工输入 App ID 和 App Secret；配置后可在飞书
  私聊发送 `/fs doctor` 检查权限、事件和菜单。
- 微信：通过向导扫码保存凭据；确认账号和允许用户后，将配置中的 `weixin.enabled` 改为
  `true`，再运行 `codexc service reload`。

配置示例见 [`config.example.toml`](config.example.toml)。修改配置后运行：

```bash
codexc service reload
```

### 显示设置

```toml
[display]
operation_updates = "compact"
plan_updates = true
```

- `operation_updates`：`full` 显示完整操作详情，`compact` 显示摘要，`hidden` 隐藏操作过程。
- `plan_updates`：是否显示 Codex 计划，默认开启。

### 调试模式

在 `codexc setup` 中选择“系统设置 → 调试模式”可全局开启或关闭脱敏调试信息。开启后会把
`[logging].level` 设为 `debug`，同时启用 Gateway 各模块的脱敏调试日志，并在渠道中显示
`/vision` 的接收延迟与 Gateway 处理耗时；关闭后恢复为 `info`，隐藏这些技术字段。修改后只需
重启 Gateway：

```bash
codexc service restart gateway
```

调试日志只记录受约束的类型、阶段、耗时和结果，不记录消息正文、请求参数、上游响应、凭据或
审批内容。分享日志前仍需人工检查。

每次 Turn 完成后按“本次运行”“当前会话”和可选的“账户状态”分开展示：运行区把统计代理捕获到
的本 Turn 全部模型请求聚合为请求次数、累计模型耗时、缓存命中、完整运行耗时和不含推理的综合输出
速度；会话区保留上下文、压缩次数、Goal 与 Git 分支；
DeepSeek 还会展示最后一次请求的
可观测首字延时，以及整轮综合思考速度与含推理生成速度。原生 OpenAI 账户对应的 Codex Provider
明确显示为“OpenAI 官方”，与直接 API 的自定义提供商区分。`/metrics` 可查看当前 Thread 最近
Turn 的请求用量及最近一次视觉等直接 API 请求；它不会替代 `/status` 的 App Server 上下文统计。

### DeepSeek

在 `codexc setup` 中选择“模型渠道”，填写 DeepSeek API Key，然后选择：

- OpenAI + DeepSeek 切换模式：保留 OpenAI 默认配置，聊天中使用 `/model` 切换；终端使用
  `codexc remote --profile deepseek` 连接共享的 DeepSeek App Server。
- 仅 DeepSeek 固定模式：让原生 Codex、IDE 和 Gateway 默认使用 DeepSeek。
- 恢复安装前配置：撤销 Setup 管理的 DeepSeek 配置。

配置或恢复后运行：

```bash
codexc service restart all
```

当前仅 `deepseek-v4-flash` 可用且只支持文字输入；图片应先切换到支持图片的 OpenAI 模型。配置文件、
跨提供商切换行为、TUI 使用方式和账户指标说明见
[`DeepSeek 使用说明`](docs/deepseek.md)。

需要让不支持图片的模型处理图片时，先在 `codexc setup` 的“模型渠道 → 第三方 API”中添加一个
Responses 中转接口和独立 API Key，再到“图片识别”中选择该提供商与模型 ID。可保存多个中转并
显式切换；这些中转只供图片识别等直接 API 功能使用，不会加入 `/model` 或 Codex App Server。
双 Provider 与仅 DeepSeek 模式使用同一条代理链路：
视觉模型识别后把受控结果交给原会话回答。默认不开启，配置与安全边界见
[`图片识别代理`](docs/vision.md)。

## 日常使用

### 管理项目

```bash
codexc ws                           # 列出 Workspace
codexc ws add                       # 注册当前目录
codexc ws remove <序号|ID|名称>      # 删除注册，不删除项目文件
```

聊天客户端只能选择已经注册的 Workspace，不能提交任意本机目录。

### 在终端继续会话

```bash
cd /absolute/path/to/project
codexc remote
codexc remote resume
codexc remote --profile deepseek resume
```

`codexc remote` 连接 Gateway 使用的 App Server。直接运行 `codex` 或 `codex --profile deepseek`
会启动独立 TUI，不共享 Gateway Thread。

### 管理后台服务

```bash
codexc service status              # 查看全部服务
codexc service reload              # 重新读取配置
codexc service restart             # 只重启 Gateway
codexc service restart all         # 重启 Gateway 和 App Server
codexc service logs                # 查看 Gateway 日志
codexc service logs all -n 200     # 查看全部服务最近 200 行日志
codexc service logs -f             # 持续跟踪 Gateway 日志
```

`start`、`stop` 和 `status` 默认操作全部服务；`restart` 和 `logs` 默认只操作 Gateway。运行
`codexc service -h` 查看完整用法。

服务重启建议从本机终端执行。聊天 Turn 内重启 Gateway 可能使过程或完成消息落在重连窗口；渠道内
执行 `codexc service restart app-server` 或 `codexc service restart all` 会被拒绝。需要重启 App
Server 时必须从本机终端执行。

Codex Provider 请求和外部视觉 API 请求的脱敏指标使用同一个独立数据库。视觉指标只保存提供商、
模型、状态、HTTP 状态、耗时与 Token；不保存图片、提示词或识别正文。查看状态或处理版本不兼容：

```bash
codexc metrics status
codexc service stop gateway
codexc metrics reset              # 先保留 0600 旧库备份，再重建
codexc service start gateway
```

`metrics reset` 不修改会话状态库；Gateway 运行时会拒绝执行，旧指标不会隐式迁移。

### 常用聊天命令

- 会话：`/new`、`/resume`、`/sessions`、`/archive`、`/unarchive`、`/pin`、`/unpin`
- Workspace：`/workspace`
- 运行：`/status`、`/stop`、`/queue <描述>`、`/compact`、`/fork`、`/review`
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 状态：`/diff`、`/usage`、`/metrics`、`/limits`、`/permissions`、`/goal`
- 扩展：`/skill [名称或序号 任务]`、`/mcp`、`/plugins`、`/rules`
- 图片：`/vision <下一批要求>`；多图：`/vision <2–4> <要求>`，收齐自动提交；失败重试：`/vision retry`；取消：`/vision cancel`
- 帮助：`/help`、`/whoami`

飞书中需要引用其他消息时，请直接回复目标消息后发送要求。Gateway 不解析飞书“复制消息链接”，
收到这类链接会在创建 Turn 前明确拒绝。

任务运行中也可以使用 `/resume` 或 `/new` 切换会话：原任务会继续在后台运行，结果和审批仍返回
当前聊天并标记所属 Thread；同一聊天最多保留 3 个后台任务。普通消息只发送给当前前台 Thread，
需要继续操作后台任务时使用 `/resume` 将其切回前台。

`/vision` 确认消息会显示平台消息到达 Gateway 的接收延迟和 Gateway 处理耗时，均以毫秒计；
前者包含渠道投递或轮询等待，后者截至回复进入渠道发送队列，不包含平台最终送达客户端的时间。
接收延迟依赖平台与 Gateway 主机时钟同步；主机未启用 NTP 时，该值可能包含系统时钟偏差。

命令、文件修改和额外权限默认不会自动批准。审批、用户输入和 MCP 交互会逐项显示，并绑定当前
用户、会话和 Turn。

## 排查问题

```bash
codexc doctor
codexc service status
codexc service logs -n 100
```

常见处理：

- 修改配置后没有生效：运行 `codexc service reload`。
- 单个聊天渠道断线：其他渠道会继续运行，可用 `codexc service logs -f` 查看恢复记录。
- 只需重启 Gateway：运行 `codexc service restart`，共享 App Server 和活动 Thread 会保留。
- Codex CLI 版本不一致：重新安装精确版本 `@openai/codex@0.146.0`。
- 飞书收不到消息或菜单不完整：在飞书私聊发送 `/fs doctor`。
- 需要查看参数：运行 `codexc -h` 或 `codexc <命令> -h`。

分享日志前请人工检查内容。Gateway 会脱敏已知凭据，但 App Server 原始日志可能包含命令、工作内容
或诊断上下文。

## 升级

```bash
npm install -g @hegenai/codexc@0.146.0
npm install -g @openai/codex@0.146.0
codexc service install
codexc doctor
```

如果升级后提示状态数据库仍是 Schema 3，先只停止 Gateway，再显式备份升级并重新启动：

```bash
codexc service stop gateway
codexc state upgrade
codexc service start gateway
```

`codexc state upgrade` 不会修改 Codex Thread，只新增后台绑定存储；命令会显示升级前数据库备份路径。

npm 包与 Codex CLI 使用相同版本。正式 npm 包和 GitHub Release 均发布成功后，发布工作流会自动
同步本页安装版本。

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

完整项目文档见 [`index.md`](index.md)。

## License

[MIT](LICENSE)
