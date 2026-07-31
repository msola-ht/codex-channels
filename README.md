# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hegenai/codexc)](https://www.npmjs.com/package/@hegenai/codexc)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。

Gateway 与原生 Codex TUI 按 Provider 连接同一个 Codex App Server，因此对应 Provider 的会话、
Thread 和运行状态可以在聊天客户端与终端之间继续使用。

`main` 开发基线：`0.146.0`（尚未发布）
当前正式版：`0.145.0`
要求：macOS 或 Linux、Node.js 22.13+、已登录的 `codex-cli 0.145.0`

## 快速开始

安装 Codex CLI 和 Gateway：

```bash
npm install -g @openai/codex@0.145.0
npm install -g @hegenai/codexc@0.145.0
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

## 配置 DeepSeek

运行 `codexc setup`，选择“模型提供方”，填写 DeepSeek API Key 后选择：

- OpenAI + DeepSeek 切换模式：保留 OpenAI 为原生 Codex 默认；终端使用 `codex` 启动 OpenAI，
  使用 `codex --profile deepseek` 启动 DeepSeek。基础 `~/.codex/config.toml` 完全保持不变，
  DeepSeek 的模型、Provider 和 API Key 只保存在 `~/.codex/deepseek.config.toml`；三个聊天渠道
  仍可在 `/model` 中逐会话选择模型。
- 仅 DeepSeek 固定模式：把原生 Codex 默认模型改为 `deepseek-v4-flash`，CLI、TUI、IDE 和 Gateway
  都默认使用 DeepSeek。
- 恢复安装前配置：恢复首次安装前的原始文件；如果原来没有配置文件则移除 Setup 创建的配置，
  同时清理下载的模型目录。

Setup 从 DeepSeek 官方安装脚本下载并提取模型目录，校验后写入
`~/.codex/deepseek.models.json`；该文件不随项目或 npm 包发布。目前 DeepSeek 官方仅声明
`deepseek-v4-flash` 支持 Codex；Pro 会在 `/model` 中显示为“暂不可用”，且在官方支持前不能切换。

切换模式把模型、Provider 和 API Key 都写入权限为 `0600` 的官方新版 Profile 文件
`~/.codex/deepseek.config.toml`，并写入一个不含凭据的 Gateway 管理标记；不会改写 OpenAI 基础配置、
默认模型或登录凭据。后台服务在同一个既有服务目标内监管两个隔离的 App Server：OpenAI 主实例
保持原生登录和 TUI 共享；服务入口从私有 Profile 校验 DeepSeek 配置，再通过 App Server 支持的
进程级 `-c` 覆盖加载模型目录和 Provider，并只在子进程环境中提供 Key。Key 不进入命令行、
服务定义或日志。固定模式则按其含义直接在基础配置中注册并选中 DeepSeek，同时不强制改变 Codex
的登录方式。首次修改前，原配置及原有同名 Profile 会备份到
`~/.codex/backup-codex-connect-deepseek/`。切换到另一 Provider 时不能原地修改正在
使用的 Thread；渠道会保留并解绑当前 Thread，在下一条消息中为所选 Provider 新建 Thread，
不复制可能包含 Provider 专属 reasoning、工具结果或加密内容的历史。旧 Thread 可通过 `/resume`
恢复；同一 Provider 内切换模型仍在当前 Thread 的下一次 Turn 生效。
Setup 完成或恢复后运行 `codexc service restart all`，让服务入口按当前模式重建 App Server，并让
Gateway 重新连接。Gateway 按 Thread 的官方 `modelProvider` 把新建、恢复、Turn、Review、Goal、
MCP 和审批请求路由到对应实例；模型目录由对应 App Server 启动配置一次性加载，不再依赖无效的
Thread 级冷恢复覆盖。任一 Provider 单独断线时，只重连并恢复该侧绑定。

TUI 和 `/status` 中的 Token、上下文窗口、缓存和压缩次数始终来自当前 Thread，适用于 OpenAI
与第三方 Provider；它们不是账户余额。OpenAI 的 Fast 与周限不会显示在 DeepSeek 或未知 Provider
上。`/usage` 按当前 Thread 的 Provider 查询账户信息：
OpenAI 显示 Codex Token 汇总，DeepSeek 使用官方余额接口显示 API 可用状态与余额；`/limits`
当前只对 OpenAI 提供额度窗口，未接入账户能力的后续 Provider 会明确显示不支持，不会回退为
OpenAI 数据。

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
codexc remote --profile deepseek resume   # 切换模式：继续 DeepSeek Thread
```

原生 TUI 与聊天客户端共享对应 Provider 的 App Server 和 Thread。
切换模式下，`codexc remote` 连接 OpenAI 主实例，`codexc remote --profile deepseek` 连接隔离的
DeepSeek 实例；两者都可使用 `resume` 恢复各自 Provider 的渠道 Thread。独立、不共享 Gateway
Thread 的 TUI 仍可直接运行 `codex --profile deepseek`。固定模式只有一个 DeepSeek 主实例，直接
使用 `codexc remote`。

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

服务重启建议从本机终端执行。聊天 Turn 内执行 `codexc service restart` 会主动断开当前 Gateway，
过程或完成消息可能落在重连窗口；不要在渠道内执行 `codexc service restart all`，因为它会同时
终止正在执行该命令的 App Server。

### 常用聊天命令

- 会话：`/new`、`/resume`、`/sessions`、`/archive`、`/unarchive`、`/pin`、`/unpin`
- Workspace：`/workspace`
- 运行：`/status`、`/stop`、`/queue <描述>`、`/compact`、`/fork`、`/review`
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 状态：`/diff`、`/usage`、`/limits`、`/permissions`、`/goal`
- 扩展：`/skill [名称或序号 任务]`、`/mcp`、`/plugins`、`/rules`
- 帮助：`/help`、`/whoami`

`/resume` 选择已被其他渠道绑定的 Thread 时，只在原渠道和当前渠道都空闲、没有排队消息、
待处理审批或用户输入且 Workspace 相同时自动转移绑定。原渠道会收到解绑通知；运行中的任务不会被接管。
项目不建立跨渠道身份映射；同一 Workspace 中各渠道已授权的用户都具备上述空闲 Thread 接管能力。

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
- 单个聊天渠道暂时断线：Gateway 会保持其他渠道运行，并对故障渠道独立退避重连；可用
  `codexc service logs -f` 查看断线与恢复记录。
- Gateway 需要重启：运行 `codexc service restart`，共享 App Server 和活动 Thread 会保留。
- Codex CLI 版本不一致：重新安装精确版本 `@openai/codex@0.145.0`。
- 飞书收不到消息或菜单不完整：在飞书私聊发送 `/fs doctor`。
- 需要查看命令参数：运行 `codexc -h` 或 `codexc <命令> -h`。

分享日志前请人工检查内容。Gateway 日志会脱敏已知凭据，但 App Server 原始日志可能包含命令、工作内容或诊断上下文。

## 升级

升级 npm 包后重新安装服务并诊断：

```bash
npm install -g @hegenai/codexc@0.145.0
npm install -g @openai/codex@0.145.0
codexc service install
codexc doctor
```

npm 包与 Codex CLI 使用相同版本。正式 npm 包和 GitHub Release 均发布成功后，发布工作流会
自动把本页安装命令同步到新版本。

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
