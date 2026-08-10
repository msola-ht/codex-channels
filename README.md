# Codex Connect Gateway

[![CI](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml/badge.svg)](https://github.com/msola-ht/codex-channels/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@hegenai/codexc)](https://www.npmjs.com/package/@hegenai/codexc)
![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.13-339933?logo=nodedotjs&logoColor=white)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-555555)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

在 Telegram、飞书或微信中使用本机 Codex。

通过 `codexc remote` 启动的原生 Codex TUI 与聊天客户端按模型提供商共享同一个 Codex App
Server，因此可以继续使用对应的会话、Thread 和运行状态。

`main` 开发基线：`0.146.1`
当前正式版：`0.146.1`
要求：macOS 或 Linux、Node.js 22.13+、已登录的 `codex-cli 0.146.1`

## 快速开始

安装配套版本：

```bash
npm install -g @openai/codex@0.146.1
npm install -g @hegenai/codexc@0.146.1
```

初始化并配置通讯渠道：

```bash
codexc init
codexc setup
```

`codexc config` 提供交互式配置与设置菜单，覆盖配置文件中可安全编辑的参数：显示设置（操作
详情、计划更新、参考价人民币换算）、系统设置（调试模式、审批超时、Sandbox、默认工作区与
模型）、工作区设置（沙箱、审批策略、权限 Profile）、Telegram 消息格式，以及配置路径查看。
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

Linux 如需退出 SSH 后继续运行，再执行一次：

```bash
sudo loginctl enable-linger "$USER"
```

完成后，在已配置的聊天客户端中私聊机器人即可使用。发送 `/help` 查看聊天命令。

## 配置通讯渠道

运行 `codexc setup`，按菜单配置模型渠道、通讯渠道、系统设置和技能安装（把项目技能安装到
`~/.agents/skills` 供当前 Codex 环境加载）。Gateway 与通讯渠道配置保存在：

```text
~/.codex-connect/config.toml
```

Telegram、飞书和微信至少配置并启用一个即可启动 Gateway。Telegram 以非空 `bot_token` 表示启用；
Token 缺失或留空时不创建 Telegram 连接，也不要求 `allowed_user_ids`。填入 Token 后必须同时配置
至少一个允许用户，避免 Bot 在没有授权边界时启动。

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
price_currency = "cny"
```

- `operation_updates`：`full` 显示完整操作详情，`compact` 显示摘要，并只保留子代理启动与失败、
  隐藏成功的等待和交互操作，`hidden` 隐藏操作过程。
- `plan_updates`：是否显示 Codex 计划，默认开启。
- `price_currency`：模型价格显示币种，全局统一为 `cny`（人民币）或 `usd`（美元），默认 `cny`，
  不再按提供商混合显示。选择 `cny` 时获取并持久化 USD/CNY 汇率（每 6 小时刷新，优先
  `open.er-api.com`，失败回退 ECB；拉取失败时继续使用最后一次成功缓存，缓存也不可用时才回退
  显示 USD）。换算按最近一次汇率近似，不按历史汇率回算。

### 多设备指标同步

每台设备可把本地脱敏指标增量上报到中心汇总。运行 `codexc config` 选择
「指标设置 → 本机接入中心」即可配置上报与 WebUI 全局视图（写入 `[metrics.sync]` 和
`[metrics.view]`）；Gateway 定时按水位上报请求记录和子代理标注，失败自动退避重试。
VPS 上用 `codexc center config` 配置 `[metrics.center]` 的独立设备上报令牌与只读查看令牌、
`codexc center info` 查看中心地址，再运行 `codexc center` 校验令牌并写入中心 SQLite；每台设备的 WebUI 控制台
通过 `[metrics.view]` 按设备范围查看累计用量。详细配置与载荷见
[`docs/metrics-sync.md`](docs/metrics-sync.md)。

### 调试模式

在 `codexc setup` 中选择“系统设置 → 调试模式”可全局开启或关闭脱敏调试信息。开启后会把
`[logging].level` 设为 `debug`，在渠道中展示 `/vision` 接收延迟、启动通知的“运行环境”、
Turn 与视觉完成通知的 Token 子项、Turn 完成通知的费用子项与货币换算对照、
“模型请求聚合耗时”、“最后请求首事件延迟”和视觉“视觉 API 耗时”等技术字段；关闭后恢复为
`info`，完成通知仍保留 Token 与费用总计。
修改后只需重启 Gateway：

```bash
codexc service restart gateway
```

调试日志只记录受约束的类型、阶段、耗时和结果，不记录消息正文、请求参数、上游响应、凭据或
审批内容。完整展示口径见 [`docs/display.md`](docs/display.md)。

每次 Turn 完成后按“本次运行”“当前会话累计”和可选的“账户状态”分开展示请求次数、Token、
缓存命中、速度、思考次数与总价；`/metrics` 可查看当前 Thread 最近运行聚合以及
`global|providers|models|errors` 的时间范围汇总。展示与统计口径见
[`docs/display.md`](docs/display.md)。

统计代理识别到的上下文压缩仍计入这些总计，并另外显示压缩次数、实际请求模型、Token 与参考费用，
方便区分普通回复和压缩开销。

OpenAI `/limits` 会在存在完整周窗口且统计代理观测到相邻额度增长时，按增长区间内的请求
Token 与价格快照估算每 1% 周额度对应的 Token、API 参考费用及剩余额度可用量。估算只覆盖
本机代理捕获的请求，其他客户端在两次快照之间的用量可能造成偏差，也不代表订阅实际扣款。

### Plugin 与 MCP 调试

Codex 0.147.0 的 Plugin API 仍标记为开发中。Gateway 默认开启已安装 Plugin 的调试入口；如需
关闭，在配置中设置并重启 Gateway：

```toml
[experimental]
plugin_api = false
```

- `/plugin`：列出当前 Workspace 已安装的 Plugin 及启用状态。
- `/plugin <名称、完整 ID 或序号> <任务>`：仅在 OpenAI Thread 中使用官方 `mention` 输入调用
  已启用且可用的 Plugin。
- 不开放 Plugin 搜索、市场、安装、卸载或分享；`codexc doctor` 会显示该开发中开关的状态。
- `/mcp`：列出当前 Thread 的 MCP Server；`/mcp <名称或序号>` 查看工具、资源与模板详情；
  上游多行长描述会先归一化并有界展示。
- `/mcp login <名称或序号>`：启动 OAuth 登录并返回授权地址。
- `/mcp resource <名称或序号> <URI>`：只读读取资源；整次最多检查前 8 个内容，文本合计最多展示
  8,000 字符并明确标记截断或省略，二进制只显示 MIME 和 Base64 字符数，不通过聊天命令直接
  调用 MCP Tool。

信息类聊天指令输出统一为 Markdown 列表：`##` 标题、`###` 小节、`-` 字段列表、明细缩进嵌套；
`/metrics` 用 `**Token**：总计` 与 `**费用**：总价` 列表块分节，费用先出总计、再列出明细；
`/diff` 与操作结果保持原文。三渠道分别用飞书卡片 Markdown、Telegram HTML 和微信结构化字段渲染。

### DeepSeek

在 `codexc setup` 中选择“模型渠道”，填写 DeepSeek API Key，然后选择：

- OpenAI + DeepSeek 切换模式：保留 OpenAI 默认配置，聊天中使用 `/model` 切换；终端使用
  `codexc remote --profile deepseek` 连接共享的 DeepSeek App Server。
- 仅 DeepSeek 固定模式：让原生 Codex、IDE 和 Gateway 默认使用 DeepSeek。
- 恢复安装前配置：撤销 Setup 管理的 DeepSeek 配置。
- 修改自动压缩阈值：按上下文窗口百分比（10–95%，默认 60%）设置或关闭 DeepSeek 的自动压缩，
  写入 `model_auto_compact_token_limit` 与 `model_auto_compact_token_limit_scope = "total"`；
  安装流程也会在填写 API Key 后询问该设置。修改后需要重启 App Server 生效。

配置或恢复后运行：

```bash
codexc service restart all
```

当前仅 `deepseek-v4-flash` 可用且只支持文字输入；未启用外部图片识别时，图片会在创建 Turn 前被
拒绝，此时应先切换到支持图片的模型。配置文件、跨提供商切换行为、TUI 使用方式和账户指标说明见
[`DeepSeek 使用说明`](docs/deepseek.md)。

切换模式还可以把 DeepSeek 注册为 Codex 子代理角色，让 multi_agent_v2 子代理请求自动计入
模型指标与费用统计：

```bash
codexc agents enable-deepseek    # 开启 multi_agent_v2 并注册单次 agents.ds 角色
codexc agents status             # 查看当前状态
codexc agents disable-deepseek   # 移除角色并关闭 multi_agent_v2
```

DS 角色仅处理当前用户消息中的单次完整任务，调用使用 `fork_turns=1`，不支持补发或并行拆分。
角色文件由 App Server 服务启动时生成、退出时清理，不写 API Key；详见
[`DeepSeek 使用说明`](docs/deepseek.md)。

需要让不支持图片的模型处理图片时，先在 `codexc setup` 的“模型渠道 → 第三方 API”中添加一个
Responses 中转接口和独立 API Key，再到“图片识别”中选择该提供商与模型 ID。可保存多个中转并
显式切换；这些中转只供图片识别等直接 API 功能使用，不会加入 `/model` 或 Codex App Server。
双 Provider 与仅 DeepSeek 模式使用同一条模型统计代理链路。视觉模型识别后把受控结果交给原
会话回答。默认不开启，配置与安全边界见
[`图片识别代理`](docs/vision.md)。

## 日常使用

### 管理项目

```bash
codexc work                          # 交互式管理 Workspace（别名：codexc ws）：列出/新增/删除/权限；新增创建在 ~/.codex-connect/<id>-work 且不影响默认
codexc work add                      # 注册当前目录
codexc work list                     # 列出 Workspace
codexc work remove <序号|ID|名称>    # 删除注册，不删除项目文件
```

聊天客户端只能选择已经注册的 Workspace，不能提交任意本机目录。

每个 Workspace 还可以在 `config.toml` 中配置独立权限：`sandbox`（只读 / 工作区写 / 完全访问）、
`approval_policy`（按需审批 / 不信任 / 免审批）和权限 Profile `permissions`（与 `sandbox` 互斥）。
不配置时使用全局默认；`/workspace` 会显示当前配置的权限，已授权用户还可在渠道内用
`/workspaceperm` 查看或修改当前工作区权限（沙箱、审批策略、权限 Profile），写回后热加载，
对新建或恢复的 Thread 生效。

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
codexc webui --port 8788              # 指定端口
codexc webui --host 0.0.0.0 --token 令牌  # 绑定非回环地址（必须提供访问令牌）
```

WebUI 只读指标数据库，提供控制台（本机与多设备用量合并查看）、Threads、请求明细与
错误页面；默认只监听回环地址，
绑定非回环地址（`0.0.0.0`）时必须提供 `--token`，否则拒绝启动。监听地址、端口与令牌
也可通过 `codexc config` 的「WebUI 设置」或 `config.toml` 的 `[webui]` 段配置，
命令行参数优先。SSH 隧道、反向代理与 Cloudflare Tunnel 走回环地址可保持无令牌。
详细说明见 [`docs/webui.md`](docs/webui.md)。

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
codexc service logs -f                # 持续跟踪 Gateway 日志
codexc service logs webui             # 查看 WebUI 日志
```

`codexc start` 的前台模式与后台服务复用同一个 App Server 监管入口，因此 OpenAI、切换模式和
仅 DeepSeek 固定模式都会经过对应的本机统计代理。现有 App Server 只有通过私有监管 Socket
证明 Provider 拓扑一致并完成真实 WebSocket 握手后才会复用；裸 App Server、部分拓扑、重复
监管入口都会明确拒绝。Gateway 另以当前配置文件对应的私有所有权 Socket 全局互斥，不受
Provider 或 `CODEX_HOME` 切换影响；重复启动会保留当前正在运行的进程。
前台模式收到 `SIGINT` 或 `SIGTERM` 时先按所有权链路优雅停止，5 秒仍未退出才终止并等待本次
前台启动创建的进程组退出；已经由后台服务持有并被前台复用的 App Server 不会被终止。

`start`、`stop` 和 `status` 默认操作全部服务；`restart` 和 `logs` 默认只操作 Gateway。运行
`codexc service -h` 查看完整用法。WebUI 与指标中心是独立后台服务，不并入 `all`：
`codexc service install` 只生成这两类服务单元并启动 App Server 与 Gateway，需要时用
`codexc service start webui`、`codexc service start center` 单独启动。
WebUI 服务读取 `[webui]` 配置，要求指标数据库为当前 Schema（升级后先执行
`codexc metrics upgrade`）；指标中心读取 `[metrics.center]` 配置。

公开管理命令的状态行统一使用 `[成功]`、`[失败]`、`[提示]` 和 `[处理]`；交互终端按类别着色，
管道或日志输出不包含 ANSI 颜色。路径、标识符、列表、日志和其他可继续解析的数据保持原始格式。

服务重启建议从本机终端执行。聊天 Turn 内重启 Gateway 可能使过程或完成消息落在重连窗口；渠道内
执行 `codexc service restart app-server` 或 `codexc service restart all` 会被拒绝。需要重启 App
Server 时必须从本机终端执行。

Codex Provider 请求和外部视觉 API 请求的脱敏指标使用同一个独立数据库。视觉指标只保存提供商、
模型、思考等级、状态、HTTP 状态、耗时、Token 与当次价格快照；不保存图片、提示词或识别正文。查看状态或
处理版本不兼容：

```bash
codexc metrics status
codexc metrics threads                            # 会话归纳总览（模型、Token、费用）
codexc metrics turns <Thread ID>                  # 导出会话每次对话汇总
codexc metrics run <Thread ID>                    # 本次运行汇总（最近运行 + 会话累计）
codexc metrics report --range 30d --group models  # 聚合汇报
codexc metrics report --range yesterday --group providers --stdout # 昨天自然日
codexc metrics report --from 2026-08-01 --to 2026-08-08 --stdout   # 自定义自然日范围
codexc metrics export --range 30d --format json   # 脱敏明细导出；--thread 可按 Thread 过滤
codexc service stop gateway
codexc metrics upgrade --restart-gateway          # 自动停 Gateway、备份升级并重新启动
codexc metrics reset                              # 先保留 0600 旧库备份，再重建
codexc metrics sync-reset --restart-gateway       # 备份并清零多端上报水位，重放修复中心历史
codexc metrics cleanup --keep-days 90 --restart-gateway # 备份并按自定策略清理
codexc metrics prune openai                       # 备份并清理指定提供商请求指标（自动重启 Gateway 与中心）
codexc service start gateway
```

`run`、`turns`、`threads`、`report`、`export` 都支持 `--format markdown|json|csv`（export 默认
json，其余默认 markdown），默认写入 `~/.codex-connect/output/<日期>/`，文件名统一为
`<命令>[-短ThreadID]-<YYYYMMDD-HHmmss>[-序号].<格式>`，同一秒重名时保留两份并追加序号；
加 `--stdout` 输出到标准输出。导出使用只读
连接，可在 Gateway 运行时执行；`--range` 支持 `today`、`yesterday`、`this-week`、`last-week`、
`this-month`、`last-month`、`24h`、`7d`、`30d`、`90d`、`365d` 和 `all`；CLI 的 `report`、
`export` 还支持同时使用 `--from YYYY-MM-DD --to YYYY-MM-DD` 查询服务器本地时区的自然日范围。
输出包含固定格式版本、时间范围和脱敏请求
字段，不包含提示词、消息、图片、响应正文、凭据或上游响应 ID。`report` 与 `export` 的
Markdown、JSON、CSV 还包含 OpenAI 统计代理最后观测到的当前周额度区间和每 1% 采样状态；JSON 格式版本为 v2。
`run`、`turns`、`threads` 和 `report` 会单列上下文压缩模型、请求数、Token 与参考费用；`export`
JSON/CSV 明细保留 `operation=compact`，Markdown 明细也显示操作类型。
`export` CSV 使用 `type=request|weekly_quota_summary` 区分请求与当前额度摘要：请求行只携带该次
请求实际捕获的历史额度快照，当前额度和每 1% 估算只写入一条独立摘要行，避免可视化重复计数。
Markdown 报表的费用按 `display.price_currency` 统一换算显示（人民币依赖汇率缓存），时间显示为
服务器本地时区；JSON 与 CSV 保留原始
币种、nanos 与 ISO 时间，并按相同配置附加 `*CostCnyNanos` 换算列（如 `totalCostCnyNanos`），
便于统计和直接查看人民币金额；报告 CSV 同时保留 Provider、模型及异常分组，文本单元格会中和
电子表格公式前缀。
`metrics upgrade` 支持把现有指标库从 Schema v3/v4/v5/v6 显式升级到 v7 并保留旧记录；Gateway 已停止时
可直接运行，不便单独管理服务时可加 `--restart-gateway` 自动完成停止、升级和重新启动。`metrics reset`
用于归档并重建不支持的版本。两者都不修改会话状态库，Gateway 运行时会拒绝执行。
`metrics prune <provider>` 备份本地与中心指标库后，删除其中指定提供商（当前支持 openai、
deepseek）的全部请求行并自动重启 Gateway 与中心服务，适合额度重置后重新开始统计。
本地库默认保留 365 天且最多 1,000,000 行，可通过 `[metrics.storage]` 的 `retention_days`、
`max_rows` 调整；达到任一上限后每 100 次写入清理最旧记录。`metrics cleanup` 可按配置或
`--before`、`--keep-days`、`--max-rows` 立即备份并清理，`--vacuum` 立即回收文件空间。

### 常用聊天命令

- 会话：`/new`、`/resume`、`/sessions`、`/archived`、`/rename`、`/archive`、`/unarchive`、`/pin`、`/unpin`
- Workspace：`/workspace`、`/workspaceperm`
- 运行：`/status`、`/stop`、`/queue <描述>`、`/compact`、`/fork`、`/review`
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 状态：`/diff`、`/usage`、`/metrics [session|global|providers|models|errors] [today|yesterday|this-week|last-week|this-month|last-month|24h|7d|30d|90d|365d|all]`、`/limits`、`/permissions`、`/goal`
- 扩展：`/agents [角色名称或序号 任务]`、`/skill [名称或序号 任务]`、
  `/plugin [名称、完整 ID 或序号 任务]`、`/mcp [名称或序号]`、
  `/mcp login <名称或序号>`、`/mcp resource <名称或序号> <URI>`、`/rules`
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

`codexc doctor` 先完成全部检测，再按基础环境、配置文件、通讯渠道、扩展能力、Workspace、
App Server 和系统服务分组，只展示失败、提示与处理建议；成功项只计入结尾汇总。交互终端中
失败、提示和处理建议使用不同颜色，管道或日志输出不包含 ANSI 颜色。Doctor 检查项使用
`[通过]`，与管理命令的操作成功状态区分。Doctor 保持只读；Linux
的 PATH 中缺少 `bubblewrap` 时会额外输出 `[处理]` 安装建议，但不会自动安装软件、修改
AppArmor 或重启服务。App Server 检查同时验证监管身份和当前 Provider 拓扑；裸实例或拓扑不一致
会提示重启整套服务，不再只因 `initialize` 握手成功而显示健康。

常见处理：

- 修改配置后没有生效：运行 `codexc service reload`。
- 单个聊天渠道断线：其他渠道会继续运行，可用 `codexc service logs -f` 查看恢复记录。
- 只需重启 Gateway：运行 `codexc service restart`，共享 App Server 和活动 Thread 会保留。
- Codex CLI 版本不一致：重新安装精确版本 `@openai/codex@0.146.1`。
- 飞书收不到消息或菜单不完整：在飞书私聊发送 `/fs doctor`。
- 需要根据日志定位错误：错误码与日志字段约定见 [`docs/errors.md`](docs/errors.md)。
- 需要查看参数：运行 `codexc -h` 或 `codexc <命令> -h`。

分享日志前请人工检查内容。Gateway 会脱敏已知凭据，但 App Server 原始日志可能包含命令、工作内容
或诊断上下文。

## 升级

```bash
npm install -g @hegenai/codexc@0.146.1
npm install -g @openai/codex@0.146.1
codexc service install
codexc doctor
```

如果升级后提示状态数据库版本不兼容（当前为 Schema v4），先只停止 Gateway，再显式备份升级并
重新启动：

```bash
codexc service stop gateway
codexc state upgrade
codexc service start gateway
```

`codexc state upgrade` 不会修改 Codex Thread，只新增后台绑定存储；命令会显示升级前数据库备份路径。

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
