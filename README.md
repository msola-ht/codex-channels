# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hegenai/codexc)](https://www.npmjs.com/package/@hegenai/codexc)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。

Gateway 与原生 Codex TUI 连接同一个 Codex App Server，因此会话、Thread 和运行状态可以在聊天客户端与终端之间继续使用。

当前版本：`0.146.0`
要求：macOS 或 Linux、Node.js 22.13+、已登录的 `codex-cli 0.146.0`

## 快速开始

安装 Codex CLI 和 Gateway：

```bash
npm install -g @openai/codex@0.146.0
npm install -g @hegenai/codexc@0.146.0
```

初始化并按提示配置 Telegram、飞书或微信：

```bash
codexc init
codexc setup
```

注册需要让 Codex 操作的项目：

```bash
cd /absolute/path/to/project
codexc ws add
```

安装后台服务并检查状态：

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

## 配置渠道

推荐直接运行：

```bash
codexc setup
```

设置向导会验证凭据和允许使用的账号，并把配置保存到：

```text
~/.codex-connect/config.toml
```

各渠道的注意事项：

- Telegram：准备 BotFather 创建的 Bot Token；向导会生成配对入口以获取用户 ID。
- 飞书：可扫码创建或选择企业自建应用，也可手工输入 App ID 和 App Secret；配置后可在飞书私聊发送 `/fs doctor` 检查权限、事件和菜单。
- 微信：通过向导扫码保存凭据；确认账号和允许用户后，将配置中的 `weixin.enabled` 改为 `true`，再运行 `codexc service reload`。

配置示例见 [`config.example.toml`](config.example.toml)。修改配置后执行：

```bash
codexc service reload
```

### 显示设置

```toml
[display]
operation_updates = "compact"
plan_updates = false
```

- `operation_updates`：`full` 显示完整操作详情，`compact` 显示摘要，`hidden` 隐藏操作过程。
- `plan_updates`：是否在聊天中显示 Codex 计划。开启后，飞书在同一 Turn 内固定更新一张计划卡；Telegram 和微信发送计划及步骤完成进度。

配置、数据库、日志、Socket 和临时文件都保存在 `~/.codex-connect`，不会写入全局 npm 包目录。Gateway 不读取或复制 Codex 的完整会话文件。

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
```

原生 TUI 与聊天客户端共享 App Server 和 Thread。

### 管理后台服务

```bash
codexc service status              # 查看全部服务
codexc service reload              # 重新读取配置
codexc service restart             # 只重启 Gateway
codexc service restart all         # 重启 Gateway 和 App Server
codexc service logs                # 查看 Gateway 日志
codexc service logs all -n 200     # 查看两项服务最近 200 行日志
codexc service logs -f             # 持续跟踪 Gateway 日志
```

`start`、`stop` 和 `status` 默认操作全部服务；`restart` 和 `logs` 默认只操作 Gateway。运行 `codexc service -h` 查看完整用法。

### 常用聊天命令

- 会话：`/new`、`/resume`、`/sessions`、`/archive`、`/unarchive`
- Workspace：`/workspace`
- 运行：`/status`、`/stop`、`/queue <描述>`、`/compact`、`/fork`、`/review`
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 状态：`/diff`、`/usage`、`/limits`、`/permissions`、`/goal`
- 扩展：`/skills`、`/mcp`、`/plugins`、`/rules`
- 帮助：`/help`、`/whoami`

命令、文件修改和额外权限默认不会自动批准。同一聊天中的审批、用户输入和 MCP 交互会逐项显示，
不同聊天互不阻塞。批准操作会绑定当前用户、会话和 Turn；过期或无法验证的请求会被拒绝。

## 排查问题

先运行：

```bash
codexc doctor
codexc service status
codexc service logs -n 100
```

常见处理：

- 修改配置后没有生效：运行 `codexc service reload`。
- Gateway 需要重启：运行 `codexc service restart`，共享 App Server 和活动 Thread 会保留。
- Codex CLI 版本不一致：重新安装精确版本 `@openai/codex@0.146.0`。
- 飞书收不到消息或菜单不完整：在飞书私聊发送 `/fs doctor`。
- 需要查看命令参数：运行 `codexc -h` 或 `codexc <命令> -h`。

分享日志前请人工检查内容。Gateway 日志会脱敏已知凭据，但 App Server 原始日志可能包含命令、工作内容或诊断上下文。

## 升级

升级 npm 包后重新安装服务并诊断：

```bash
npm install -g @hegenai/codexc
codexc service install
codexc doctor
```

如果新版本要求不同的 Codex CLI，请安装 README 声明的精确版本。

## 源码开发

```bash
git clone https://github.com/msola-ht/codex-channels.git
cd codex-channels
npm ci
cp config.example.toml config.toml
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
