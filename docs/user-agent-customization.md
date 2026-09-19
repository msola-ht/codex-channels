# User-Agent 自定义设计

本文定义 Codex Connect 对 App Server 客户端身份和模型上游 `User-Agent` 的可配置方案。
对应配置字段已进入用户级 Gateway 配置 `[codex]`，运行时覆盖已实现（见下文）。

## 目标

- 默认以官方 `codex --remote` TUI 身份连接 App Server：`initialize.clientInfo` 声明
  `codex-tui` 与当前锁定 Codex CLI 版本，模型上游收到官方形态的 `User-Agent`；无需用户操作，
  Codex CLI 升级后自动跟随。
- 允许用户分别自定义 Gateway 初始化 App Server 时声明的客户端名称、标题和版本。
- 允许用户配置 App Server 进程上报的终端标识，补齐服务进程没有终端时模型上游 UA 中的
  `unknown`。
- 允许用户完整覆盖模型上游最终收到的 `User-Agent`，配置值与出站 Header 保持一致。
- 未配置任何自定义字段时使用上述默认身份，服务生命周期不因是否覆盖而变化。
- HTTP/SSE 与 WebSocket 请求使用相同规则，所有受管 Provider 使用同一全局配置。
- 保留真实 Codex App Server 构建版本，不通过 Gateway 配置伪造上游二进制版本。

## 当前链路

Gateway 连接 App Server 时通过 `initialize.clientInfo` 发送：

```text
name    = codex-tui
title   = null
version = 当前锁定 Codex CLI 版本（`src/codex-protocol/version.json`）
```

这是官方 `codex --remote` TUI 声明的客户端身份（`name = "codex-tui"`、`title = None`、
`version = env!("CARGO_PKG_VERSION")`），由 `src/codex-client` 按锁定版本派生，不写入用户配置，
因此升级 Codex CLI 后自动使用新版本。

当前锁定的 Codex 0.154.0 使用进程级全局 UA 状态：首个会改变全局身份的普通客户端
`initialize` 设置 originator 前缀（进程已设置或存在 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`
时不再覆盖），之后每次普通客户端 `initialize` 更新 `clientInfo.name; clientInfo.version`
组成的 UA 后缀。因此原生 TUI 与 Gateway 同时连接时，返回的 UA 可能是“前缀来自先连接
客户端、后缀来自最近连接客户端”的组合，不是只由发起连接自己的 `clientInfo` 决定。
下面示例按单个普通客户端（Gateway 默认身份）描述模型请求的原始 UA 结构：

```text
codex-tui/0.154.0 (<系统与架构>) <终端标识> (codex-tui; 0.154.0)
```

第一个 `0.154.0` 来自 App Server 的真实构建版本，不等于 `clientInfo.version`。Provider Proxy
收到该原始 Header 后，移除 Hop-by-hop Header 和私有 Turn 元数据；配置了 `upstream_user_agent`
时在该层覆盖整条 `User-Agent`，缺省则原样转发到上游。HTTP/SSE 与 WebSocket 遵循相同规则。

`<终端标识>` 由 App Server 进程按自身环境探测：`TERM_PROGRAM` 优先，其次各终端专有变量，最后
回退到 `TERM`，并且在进程内只解析一次。本机 App Server 由 launchd/systemd 服务进程启动，服务
定义不提供终端环境，因此缺省上报 `unknown`；原生 TUI 连接到同一个 App Server 时结果相同，因为
该字段在 App Server 进程而不是客户端进程生成。配置 `[codex].terminal_identity` 后，`codexc`
启动 App Server 时把终端名与版本写入子进程的 `TERM_PROGRAM` / `TERM_PROGRAM_VERSION`，重启
App Server 后模型上游 UA 即带该标识。该值由 `codexc config`、`codexc service install` 或
`codexc update` 按运行命令的终端探测后写入，也可以直接编辑 TOML。

模型数据通路在本机由 `codexc` 的 App Server 服务进程自建回环 Provider Proxy
（`runtime/app-server-service-runtime.mjs` 通过 `ProviderProxy` 创建并监听回环地址），App Server 子进程通过 `model_provider` 指向该回环
端点。Provider Proxy 持有模型转发和指标采集，因此上游 UA 覆盖发生在 `codexc` 服务进程内，
不能通过仅重启 Gateway 生效；必须重启 App Server 服务。

Gateway 自身作为 App Server 的 JSON-RPC 客户端，`initialize.clientInfo` 只声明本连接的
客户端身份；响应里的 `userAgent` 是 App Server 进程级全局 UA，Gateway 读回后仅用于启动和
调试展示。`thread/read` / `thread/list` 的 Thread 只有 `source`（如 `"cli"`），没有 UA 或
客户端信息字段，无法跨连接读取"原生 Codex TUI 那个连接"的 UA。要让多客户端共享同一
App Server 时模型上游收到的 UA 保持确定，可以配置 `upstream_user_agent`；默认身份下原生 TUI
与 Gateway 声明相同的 `codex-tui` 与当前锁定版本，进程级 UA 通常一致。

## 配置格式

建议在用户级 Gateway 配置 `~/.codex-connect/config.toml` 的 `[codex]` 下增加完整上游 UA，
并用子表保存 App Server 客户端身份：

```toml
[codex]
binary = "codex"
socket_path = "runtime/codex-app-server.sock"
sandbox = "workspace-write"
upstream_user_agent = "Mozilla/5.0 MyClient/1.0"
terminal_identity = "iTerm.app/3.5.14"

[codex.client_identity]
name = "my_client"
title = "My Codex Client"
version = "1.0.0"
```

全部字段可选，缺失时分别使用当前默认值：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `codex.client_identity.name` | `codex-tui` | `initialize.clientInfo.name`；影响进程级 UA 前缀（由首个普通客户端或环境覆盖决定） |
| `codex.client_identity.title` | `null` | `initialize.clientInfo.title` |
| `codex.client_identity.version` | 当前锁定 Codex CLI 版本 | `initialize.clientInfo.version`；普通客户端初始化会更新进程级 UA 后缀，升级后自动跟随 |
| `codex.upstream_user_agent` | 不覆盖 | Provider Proxy 发给模型上游的完整 UA；缺省时上游收到 App Server 按默认身份生成的官方 TUI UA |
| `codex.terminal_identity` | 不设置 | App Server 进程上报的终端标识（`终端名` 或 `终端名/版本`）；缺省时由 App Server 自行探测，服务进程探测不到则为 `unknown` |

不提供追加、模板、环境变量或自动拼接模式。`upstream_user_agent` 一旦存在，就完整替换出站
`User-Agent`；删除该字段后恢复 App Server 生成的官方 TUI UA。这样可以保证“配置什么，上游就
收到什么”，同时避免多个模式产生难以判断的组合结果。

`terminal_identity` 只影响 App Server 自己生成的 UA 前缀，`upstream_user_agent` 仍然完整覆盖
出站 Header；两者同时配置时上游只看后者。终端标识不进入 Gateway 的 `initialize.clientInfo`，
写错不会改变 Gateway 身份。

## 生效结果

使用上述示例时，请求链路为：

```text
Gateway -> App Server initialize
  clientInfo = my_client / My Codex Client / 1.0.0

App Server -> 本地 Provider Proxy
  User-Agent = my_client/0.154.0 (<系统与架构>) iTerm.app/3.5.14 (my_client; 1.0.0)

本地 Provider Proxy -> 模型上游
  User-Agent = Mozilla/5.0 MyClient/1.0
```

Provider Proxy 物理接收到的仍是 App Server 生成的原始 UA；完整覆盖发生在构造上游 HTTP 或
WebSocket 请求时。内部指标、Thread、Turn 和 App Server 协议版本继续使用真实运行信息，不能从
自定义 UA 反推安装版本。

## 校验边界

配置继续由严格 Schema 在共享运行时边界一次性验证，非法值使服务失败关闭：

- `client_identity.name`：1–64 个 ASCII 字符，采用 HTTP token 字符集
  `A-Z`、`a-z`、`0-9`、`.`、`_`、`-`，首字符必须是字母或数字。
- `client_identity.title`：去除首尾空白后 1–128 个可显示字符，禁止换行和其他控制字符。
- `client_identity.version`：1–64 个 ASCII 字符，允许字母、数字、`.`、`_`、`+`、`-`，
  首字符必须是字母或数字；不强制语义化版本。
- `upstream_user_agent`：1–512 个可显示 ASCII 字符，不允许首尾空白、CR、LF、Tab 或其他控制
  字符；验证通过后按原值写入 Header，不再修剪或改写。
- `terminal_identity`：最长 64 个字符的 `终端名` 或 `终端名/版本`，允许字母、数字、`.`、`_`、
  `-`，`/` 只能出现一次且两侧都非空，两段均须以字母或数字开头。

该能力只允许修改 `User-Agent`，不扩展为任意 Header 配置，也不接受凭据插值。生效 UA 会随每条
请求写入本地 `model_request_metrics.user_agent` 并只在本机 WebUI 展示；不进入渠道消息、完成
卡片或普通日志，Doctor 和 Setup 仍只显示“默认/已自定义”状态，避免把用户可能误填的内容复制到
渠道或诊断输出。

## Setup 与命令体验

官方 TUI 身份是默认行为，不需要在 Setup、WebUI 或配置文件中操作。`codexc config` 的“系统设置”
仍保留“一键设为官方 TUI 身份”入口，形态为显式覆盖：

一键设为官方 TUI 身份：在单次受 revision 保护的原子写入中把客户端身份写成
`codex-tui / 当前锁定版本`，并把模型上游 `User-Agent` 预填为按当前系统与终端信息生成的
官方格式值（`codex-tui/<version> (<os>; <arch>) <终端标识> (codex-tui; <version>)`），
可编辑后保存。预填值基于运行 `codexc config` 的当前系统和终端信息；tmux/zellij 等无法
还原上游终端探测、或平台架构命名与上游 `os_info` 不一致时，可能与原生 TUI 实际输出不同，
适合作为与原生 TUI 出站一致的起点。保存后配置里会写死当时的版本，不再跟随 Codex CLI 升级；
删除 `[codex].client_identity` 与 `[codex].upstream_user_agent` 即可回到默认身份。其他自定义
身份或 UA 仍可直接编辑 TOML。

保存显式覆盖后由统一配置激活通知提示：该设置同时改变 Gateway 客户端连接与 App Server 出站
Provider Proxy，需要 `codexc service restart all`；App Server 不会自动重启，受管 Gateway
会按既有配置热载机制自行重建连接，前台 Gateway 需手动重启。现有 Thread 不使用新身份或
UA。回显不出现在聊天渠道。

首期不增加独立 `codexc ua` 命令，也不在 `codexc setup` 的 Provider 页面重复入口。
脚本或自动化直接编辑 TOML；交互入口与配置文件使用同一校验和原子写入实现。

终端标识的取值来自运行命令的终端，而不是常驻进程：`codexc config` → 系统设置 →
“模型上游终端标识” 预填运行该命令的终端探测结果（`TERM_PROGRAM[/版本]` 优先，其次各终端
专有变量，最后 `TERM`），可编辑后保存，留空则删除 `terminal_identity` 并回到 App Server
自行探测；`codexc service install` 在生成服务定义前、`codexc update` 在真正重启核心服务前，
于 `terminal_identity` 未配置且能探测到终端时按运行该命令的终端自动补入并打印一行，已配置时
不覆盖，因此记录下来的值在下一次 App Server 启动时立即生效；`codexc update` 已是最新版本、
本次不重启服务时不写入。补入失败只打印一次失败原因并继续当前命令，不阻塞安装或更新。其余
服务命令（`start`、`restart`、`reload`、`stop`、`status`、`logs`、`uninstall`）不改写该配置。
WebUI 在“官方 TUI 请求身份”分区提供同一字段，手工填写后与客户端身份、上游 UA 一起原子写入。

探测不到终端或只探测到 `TERM=dumb`（渠道会话、计划任务、服务进程内执行等）时不会写入任何
猜测值，此时需要手工填写目标终端标识。两者都只写显式配置，默认身份不依赖它们。

## 生命周期与多 Provider

- `client_identity` 在每个 App Server 连接的 `initialize` 阶段声明；进程级 UA 前缀由首个
  普通客户端或环境覆盖决定，UA 后缀会被后续普通客户端初始化更新，多客户端下不是某个
  连接独享的字段。默认身份与官方 TUI 声明一致，两者同时连接时后缀相同。
- `codexc doctor` 的版本核验以官方非全局客户端身份 `codex_app_server_daemon` 握手，不改变
  App Server 进程级 originator 或 UA 后缀。
- 完整上游 UA 由每个受管 Provider Proxy 在构造出站请求时覆盖。
- `terminal_identity` 只在 App Server 服务进程启动子进程时写入环境，进程内终端探测只解析一次，
  因此修改后必须重启 App Server（受管服务下即 `codexc service restart all` 中的 App Server 目标）。
- 主 Provider、DeepSeek、OpenCode Go 多账户、自定义 Provider 和共享第三方子代理使用同一全局值。
- 默认身份随 Codex CLI 升级自动变化，只需重启 `codexc service restart all` 即可生效；显式覆盖任一
  字段后运行 `codexc service restart all`，同时应用 Gateway 身份与上游 UA；仅运行
  `codexc service restart gateway` 不会重建 Provider Proxy，只重启
  App Server 时 Gateway 身份依赖受管自动重载或前台手动重启。
- 重启 App Server 会结束其进程中的活动请求，因此 Setup 保存后只提示命令，不自动重启
  App Server；受管 Gateway 会按既有配置热载机制自行重建连接，前台 Gateway 需手动重启。
- 已有 Thread 的持久身份和 Provider 归属不修改；重启后恢复 Thread 时使用新的进程身份与出站 UA。

首期不支持按 Provider 或按账户分别设置 UA。若未来出现明确的上游兼容需求，应在 Provider 注册
边界设计独立覆盖优先级，并先解决同一共享代理承载多个 OpenCode Go 账户时的路由归属；不能把
Provider ID 字符串插值到全局 UA。

## 实现映射

当前实现保持现有模块职责：

- `runtime/gateway-config.mjs` 与类型声明：`[codex].client_identity`、`[codex].upstream_user_agent`、
  `[codex].terminal_identity` 的严格 Schema、默认值和公共配置类型。
- `src/config`：运行语义与重载分类；`client_identity` 在 Gateway 建立连接时使用并触发
  Gateway 重建；`upstream_user_agent` 不属于 Gateway 运行配置，只在 App Server 服务进程
  启动 Provider Proxy 时读取；`terminal_identity` 同样不属于 Gateway 运行配置，只在 App Server
  服务进程启动时读取并翻译成终端探测读取的环境变量。
- `src/codex-client`：由组合根 `src/bootstrap/gateway-component-graph.ts` 注入解析后的 `codexClientIdentity`（可缺省），
  在 `json-rpc.ts` 构造唯一一次 `initialize.clientInfo`；缺省字段取 `protocol-info.ts` 从
  `src/codex-protocol/version.json` 派生的 `codex-tui` 与锁定 Codex CLI 版本；不得从 TOML
  直接读取配置。`thread/start` 不再携带 `serviceName`，与官方 TUI 传入 `None` 的行为一致，
  避免在 App Server 会话遥测中保留 Gateway 标识。
- `src/provider-proxy`：由 `runtime/app-server-service-runtime.mjs` 注入可选完整 UA，在 HTTP 和 WebSocket 出站请求头的
  统一函数中覆盖；不修改入站 Header，但把该请求实际发往上游的 UA 一并写入指标记录
  `model_request_metrics.user_agent`（Schema v13 引入，当前 Schema v16，限长 512），供 WebUI 请求明细逐条展示。
- `runtime/terminal-identity.mjs`：按当前锁定 Codex CLI 的探测顺序从进程环境推导终端标识；
  `detectTerminalUserAgentToken` 复现官方取值供 UA 文本预填使用，`detectTerminalIdentity`
  只在结果可作为 `terminal_identity` 记录时返回，探不到终端或只探测到 `dumb` 时返回 `null`。
- `runtime/app-server-service-runtime.mjs`：App Server 服务进程启动每个 Provider Proxy 时统一读取
  `[codex].upstream_user_agent`，主代理、按需 Provider 代理和 OpenCode Go 共享代理复用同一值；
  启动主 App Server 与 Provider App Server 前把 `[codex].terminal_identity` 写入子进程的
  `TERM_PROGRAM` / `TERM_PROGRAM_VERSION`，未配置时保持环境原样；`codexc service install`
  在生成服务定义前、`codexc update` 在重启服务前，若 `terminal_identity` 未配置且运行命令的
  终端可探测，则由 `scripts/service-command.mjs` 按该终端补入配置；其余服务命令不改写该配置。
- `scripts/config-management.mjs`、`scripts/config-system-menu.mjs`：通过 `codexc config` 的
  「系统设置 → 一键设为官方 TUI 身份」用当前系统与终端信息生成官方格式 `User-Agent`，
  在单次受 revision 保护的原子写入中同时保存 `codex-tui` 客户端身份与上游 UA，给出
  `codexc service restart all` 提示；该入口只写显式覆盖，默认身份不依赖它，也不再提供单项目
  编辑入口；「系统设置 → 模型上游终端标识」用同一写入接口单独保存 `terminal_identity`，预填
  运行命令的终端探测结果并允许编辑，留空即删除该字段。设置读取接口在 `officialTuiIdentity`
  下额外返回派生默认值（`defaults`），供 CLI 与 WebUI 显示未配置时实际生效的身份，界面不把
  默认值写回配置。
- `runtime/app-server-read.mjs`：连接本机 App Server 完成一次 `initialize` 握手并返回完整
  `User-Agent`，供 Doctor 以 `codex_app_server_daemon` 非全局身份复用，不打印或缓存完整值。
- `scripts/webui-management-status-route.mjs`：`/api/v1/management/upstream-user-agent` 返回模型上游实际使用的
  `User-Agent` 与取值来源；配置覆盖优先，否则用同一非全局身份读取 App Server 生成的 UA，
  App Server 未运行时返回不可用状态而不是让接口失败。
- `codexc doctor`：只显示「默认/已自定义」状态，不发送探测请求，不打印完整值。

不修改 Codex `~/.codex/config.toml`、Provider Profile、API Key 文件、数据库 Schema、指标协议或
Surface 配置。

## 验证计划

本次改动不新增测试文件或用例，只在默认行为变化处同步已有断言：

- `npm run check`：类型与版本一致性，覆盖 `GatewayConfig`、`ClientInfo` 注入签名和
  Provider Proxy 选项类型。
- 配置定向测试：`config`、`config-management`、`config-menu`、`runtime-config` 验证 Schema、
  原子写入与 `codexc config` 菜单回归。
- 终端标识定向检查：非法 `terminal_identity` 在保存前被 Schema 拒绝；配置后启动的 App Server
  子进程带 `TERM_PROGRAM`，模型上游 UA 的终端标识随之变化。
- `json-rpc` 定向测试：缺省身份为 `codex-tui` 与当前锁定 Codex CLI 版本，标题为 `null`，
  `thread/start` 不携带 `serviceName`。
- 真实 App Server 合同测试：`initialize.userAgent` 以 `codex-tui/` 开头。
- `provider-proxy` 定向测试：缺省时 UA 原样透传；HTTP 与 WebSocket 覆盖仅在配置后生效。

已确认不新增协议方法；默认身份变化只调整 `initialize.clientInfo` 的既有取值，`thread/start`
去掉 `serviceName` 是本次唯一删除的协议字段，两者都已由真实 App Server 合同测试覆盖。上游 UA
覆盖仍只改变本地 Provider Proxy 出站 Header，不改入站 Header、指标载荷或
Codex `~/.codex/config.toml`。跨连接读取"原生 Codex TUI 的 UA"不在支持范围，原因是锁定协议
不暴露其他客户端身份，见「当前链路」。

## 验收标准

- 不配置 `[codex].client_identity` 与 `[codex].upstream_user_agent` 时，Gateway 声明 `codex-tui`
  与当前锁定 Codex CLI 版本，上游收到官方 TUI 形态的 UA，Codex CLI 升级后无需改配置即使用新版本。
- 配置 `terminal_identity` 并重启 App Server 后，模型上游 UA 的终端标识等于该值；未配置或
  删除该字段时，服务进程探测不到终端仍上报 `unknown`，不写死任何默认终端。
- 显式配置的字段覆盖对应默认值，未覆盖的字段仍取默认值。
- `client_identity` 出现在 Gateway 的 `initialize.clientInfo` 声明中，并参与 App Server 进程级
  UA 后缀；跨客户端共享同一 App Server 时不作为确定性出站依据。
- 配置 `upstream_user_agent` 后，HTTP 与 WebSocket 上游观察到的值与 TOML 字符串完全一致，
  多客户端下同样确定。
- 非法值在服务启动或交互保存前明确拒绝，不降级到默认值。
- 完整 UA 不进入指标数据库、日志、渠道消息或 PR 验证产物。
- 文档、配置示例、Setup 提示、模块 README 和测试在实现提交中同步更新。
