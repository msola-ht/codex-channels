# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hegenai/codexc)](https://www.npmjs.com/package/@hegenai/codexc)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。

通过 `codexc remote` 启动的原生 Codex TUI 与聊天客户端按模型提供商共享同一个 Codex App
Server，因此可以继续使用对应的会话、Thread 和运行状态。

`main` 开发基线：`0.146.0`（尚未发布）
当前正式版：`0.145.0`
要求：macOS 或 Linux、Node.js 22.13+、已登录的 `codex-cli 0.145.0`

## 快速开始

安装配套版本：

```bash
npm install -g @openai/codex@0.145.0
npm install -g @hegenai/codexc@0.145.0
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

运行 `codexc setup`，按菜单配置通讯渠道。Gateway 与通讯渠道配置保存在：

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

每次 Turn 完成后会按实际可用数据展示耗时、上下文、缓存、首字延时、输出速度和提供商账户状态。

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

当前仅 `deepseek-v4-flash` 可用。配置文件、跨提供商切换行为、TUI 使用方式和账户指标说明见
[`DeepSeek 使用说明`](docs/deepseek.md)。

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

### 常用聊天命令

- 会话：`/new`、`/resume`、`/sessions`、`/archive`、`/unarchive`、`/pin`、`/unpin`
- Workspace：`/workspace`
- 运行：`/status`、`/stop`、`/queue <描述>`、`/compact`、`/fork`、`/review`
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 状态：`/diff`、`/usage`、`/limits`、`/permissions`、`/goal`
- 扩展：`/skill [名称或序号 任务]`、`/mcp`、`/plugins`、`/rules`
- 帮助：`/help`、`/whoami`

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
- Codex CLI 版本不一致：重新安装精确版本 `@openai/codex@0.145.0`。
- 飞书收不到消息或菜单不完整：在飞书私聊发送 `/fs doctor`。
- 需要查看参数：运行 `codexc -h` 或 `codexc <命令> -h`。

分享日志前请人工检查内容。Gateway 会脱敏已知凭据，但 App Server 原始日志可能包含命令、工作内容
或诊断上下文。

## 升级

```bash
npm install -g @hegenai/codexc@0.145.0
npm install -g @openai/codex@0.145.0
codexc service install
codexc doctor
```

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
