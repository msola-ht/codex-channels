# User-Agent 自定义设计

本文定义 Codex Connect 对 App Server 客户端身份和模型上游 `User-Agent` 的可配置方案。
对应配置字段已进入用户级 Gateway 配置 `[codex]`，运行时覆盖已实现（见下文）。

## 目标

- 允许用户分别自定义 Gateway 初始化 App Server 时声明的客户端名称、标题和版本。
- 允许用户完整覆盖模型上游最终收到的 `User-Agent`，配置值与出站 Header 保持一致。
- 未配置任何自定义字段时保持当前身份、请求头和服务生命周期不变。
- HTTP/SSE 与 WebSocket 请求使用相同规则，所有受管 Provider 使用同一全局配置。
- 保留真实 Codex App Server 构建版本，不通过 Gateway 配置伪造上游二进制版本。

## 当前链路

Gateway 连接 App Server 时通过 `initialize.clientInfo` 发送：

```text
name    = codex_connect
title   = Codex Connect Gateway
version = 当前 Gateway 版本
```

当前锁定的 Codex 0.153.4 使用进程级全局 UA 状态：首个会改变全局身份的普通客户端
`initialize` 设置 originator 前缀（进程已设置或存在 `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`
时不再覆盖），之后每次普通客户端 `initialize` 更新 `clientInfo.name; clientInfo.version`
组成的 UA 后缀。因此原生 TUI 与 Gateway 同时连接时，返回的 UA 可能是“前缀来自先连接
客户端、后缀来自最近连接客户端”的组合，不是只由发起连接自己的 `clientInfo` 决定。
下面示例按单个普通客户端（Gateway 默认身份）描述模型请求的原始 UA 结构：

```text
codex_connect/0.153.4 (<系统与架构>) <终端标识> (codex_connect; <Gateway 版本>)
```

第一个 `0.153.4` 来自 App Server 的真实构建版本，不等于 `clientInfo.version`。Provider Proxy
收到该原始 Header 后，移除 Hop-by-hop Header 和私有 Turn 元数据；配置了 `upstream_user_agent`
时在该层覆盖整条 `User-Agent`，缺省则原样转发到上游。HTTP/SSE 与 WebSocket 遵循相同规则。

模型数据通路在本机由 `codexc` 的 App Server 服务进程自建回环 Provider Proxy（`codexc.mjs`
通过 `ProviderProxy` 创建并监听回环地址），App Server 子进程通过 `model_provider` 指向该回环
端点。Provider Proxy 持有模型转发和指标采集，因此上游 UA 覆盖发生在 `codexc` 服务进程内，
不能通过仅重启 Gateway 生效；必须重启 App Server 服务。

Gateway 自身作为 App Server 的 JSON-RPC 客户端，`initialize.clientInfo` 只声明本连接的
客户端身份；响应里的 `userAgent` 是 App Server 进程级全局 UA，Gateway 读回后仅用于启动和
调试展示。`thread/read` / `thread/list` 的 Thread 只有 `source`（如 `"cli"`），没有 UA 或
客户端信息字段，无法跨连接读取"原生 Codex TUI 那个连接"的 UA。要让多客户端共享同一
App Server 时模型上游收到的 UA 保持确定，必须配置 `upstream_user_agent`，不能只依赖
`client_identity`。

## 配置格式

建议在用户级 Gateway 配置 `~/.codex-connect/config.toml` 的 `[codex]` 下增加完整上游 UA，
并用子表保存 App Server 客户端身份：

```toml
[codex]
binary = "codex"
socket_path = "runtime/codex-app-server.sock"
sandbox = "workspace-write"
upstream_user_agent = "Mozilla/5.0 MyClient/1.0"

[codex.client_identity]
name = "my_client"
title = "My Codex Client"
version = "1.0.0"
```

全部字段可选，缺失时分别使用当前默认值：

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `codex.client_identity.name` | `codex_connect` | `initialize.clientInfo.name`；影响进程级 UA 前缀（由首个普通客户端或环境覆盖决定） |
| `codex.client_identity.title` | `Codex Connect Gateway` | `initialize.clientInfo.title` |
| `codex.client_identity.version` | 当前 Gateway 版本 | `initialize.clientInfo.version`；普通客户端初始化会更新进程级 UA 后缀 |
| `codex.upstream_user_agent` | 不覆盖 | Provider Proxy 发给模型上游的完整 UA |

不提供追加、模板、环境变量或自动拼接模式。`upstream_user_agent` 一旦存在，就完整替换出站
`User-Agent`；删除该字段后恢复 App Server 原始 UA。这样可以保证“配置什么，上游就收到什么”，
同时避免多个模式产生难以判断的组合结果。

## 生效结果

使用上述示例时，请求链路为：

```text
Gateway -> App Server initialize
  clientInfo = my_client / My Codex Client / 1.0.0

App Server -> 本地 Provider Proxy
  User-Agent = my_client/0.153.4 (<系统与架构>) <终端标识> (my_client; 1.0.0)

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

该能力只允许修改 `User-Agent`，不扩展为任意 Header 配置，也不接受凭据插值。配置值不进入请求
指标、完成卡片或普通日志；Doctor 和 Setup 只显示“默认/已自定义”状态，避免把用户可能误填的
内容复制到渠道或诊断输出。

## Setup 与命令体验

`codexc config` 的“系统设置”保留“一键设为官方 TUI 身份”入口：

一键设为官方 TUI 身份：在单次受 revision 保护的原子写入中把客户端身份设为
`codex-tui / 当前锁定版本`，并把模型上游 `User-Agent` 预填为按当前系统与终端信息生成的
官方格式值（`codex-tui/<version> (<os>; <arch>) <终端标识> (codex-tui; <version>)`），
可编辑后保存。预填值基于运行 `codexc config` 的当前系统和终端信息；tmux/zellij 等无法
还原上游终端探测、或平台架构命名与上游 `os_info` 不一致时，可能与原生 TUI 实际输出不同，
适合作为与原生 TUI 出站一致的起点。其他自定义身份或 UA 仍可直接编辑 TOML 的
`[codex].client_identity` 与 `[codex].upstream_user_agent`。

保存后由统一配置激活通知提示：该设置同时改变 Gateway 客户端连接与 App Server 出站
Provider Proxy，需要 `codexc service restart all`；App Server 不会自动重启，受管 Gateway
会按既有配置热载机制自行重建连接，前台 Gateway 需手动重启。现有 Thread 不使用新身份或
UA。回显不出现在聊天渠道。

首期不增加独立 `codexc ua` 命令，也不在 `codexc setup` 的 Provider 页面重复入口。
脚本或自动化直接编辑 TOML；交互入口与配置文件使用同一校验和原子写入实现。

## 生命周期与多 Provider

- `client_identity` 在每个 App Server 连接的 `initialize` 阶段声明；进程级 UA 前缀由首个
  普通客户端或环境覆盖决定，UA 后缀会被后续普通客户端初始化更新，多客户端下不是某个
  连接独享的字段。
- `codexc doctor` 的版本核验以官方非全局客户端身份 `codex_app_server_daemon` 握手，不改变
  App Server 进程级 originator 或 UA 后缀。
- 完整上游 UA 由每个受管 Provider Proxy 在构造出站请求时覆盖。
- 主 Provider、DeepSeek、OpenCode Go 多账户、自定义 Provider 和共享第三方子代理使用同一全局值。
- 一键设置或直接修改任一字段后运行 `codexc service restart all`，同时应用 Gateway 身份与
  上游 UA；仅运行 `codexc service restart gateway` 不会重建 Provider Proxy，只重启
  App Server 时 Gateway 身份依赖受管自动重载或前台手动重启。
- 重启 App Server 会结束其进程中的活动请求，因此 Setup 保存后只提示命令，不自动重启
  App Server；受管 Gateway 会按既有配置热载机制自行重建连接，前台 Gateway 需手动重启。
- 已有 Thread 的持久身份和 Provider 归属不修改；重启后恢复 Thread 时使用新的进程身份与出站 UA。

首期不支持按 Provider 或按账户分别设置 UA。若未来出现明确的上游兼容需求，应在 Provider 注册
边界设计独立覆盖优先级，并先解决同一共享代理承载多个 OpenCode Go 账户时的路由归属；不能把
Provider ID 字符串插值到全局 UA。

## 实现映射

当前实现保持现有模块职责：

- `runtime/gateway-config.mjs` 与类型声明：`[codex].client_identity`、`[codex].upstream_user_agent`
  的严格 Schema、默认值和公共配置类型。
- `src/config`：运行语义与重载分类；`client_identity` 在 Gateway 建立连接时使用并触发
  Gateway 重建；`upstream_user_agent` 不属于 Gateway 运行配置，只在 App Server 服务进程
  启动 Provider Proxy 时读取。
- `src/codex-client`：由组合根 `src/bootstrap/app.ts` 注入解析后的 `codexClientIdentity`，构造
  唯一一次 `initialize.clientInfo`；不得从 TOML 直接读取配置。
- `src/provider-proxy`：由 `bin/codexc.mjs` 注入可选完整 UA，在 HTTP 和 WebSocket 出站请求头的
  统一函数中覆盖；不得修改入站 Header 或指标载荷。
- `bin/codexc.mjs`：App Server 服务进程启动每个 Provider Proxy 时统一读取
  `[codex].upstream_user_agent`，主代理、按需 Provider 代理和 OpenCode Go 共享代理复用同一值。
- `scripts/config-management.mjs`、`scripts/config-system-menu.mjs`：通过 `codexc config` 的
  「系统设置 → 一键设为官方 TUI 身份」用当前系统与终端信息生成官方格式 `User-Agent`，
  在单次受 revision 保护的原子写入中同时保存 `codex-tui` 客户端身份与上游 UA，给出
  `codexc service restart all` 提示；不再提供单项目编辑入口。
- `runtime/app-server-read.mjs`：连接本机 App Server 完成一次 `initialize` 握手并返回完整
  `User-Agent`，供 Doctor 以 `codex_app_server_daemon` 非全局身份复用，不打印或缓存完整值。
- `codexc doctor`：只显示「默认/已自定义」状态，不发送探测请求，不打印完整值。

不修改 Codex `~/.codex/config.toml`、Provider Profile、API Key 文件、数据库 Schema、指标协议或
Surface 配置。

## 验证计划

本次改动遵循项目「禁止新增或修改测试文件」的约定，基于现有测试验证：

- `npm run check`：类型与版本一致性，覆盖 `GatewayConfig`、`ClientInfo` 注入签名和
  Provider Proxy 选项类型。
- 配置定向测试：`config`、`config-management`、`config-menu`、`runtime-config` 验证 Schema、
  原子写入与 `codexc config` 菜单回归。
- `json-rpc` 与 `provider-proxy` 定向测试：缺省身份仍为 `codex_connect`，缺省时 UA 原样透传；
  HTTP 与 WebSocket 覆盖仅在配置后生效。

已确认不新增协议方法或 App Server 行为变化，上游 UA 覆盖仅改变本地 Provider Proxy 出站 Header，
不改入站 Header、指标载荷或 Codex `~/.codex/config.toml`。跨连接读取"原生 Codex TUI 的 UA"
不在支持范围，原因是锁定协议不暴露其他客户端身份，见「当前链路」。

## 验收标准

- 不配置新增字段时，现有配置文件、请求 UA 和所有 Provider 行为零变化。
- `client_identity` 出现在 Gateway 的 `initialize.clientInfo` 声明中，并参与 App Server 进程级
  UA 后缀；跨客户端共享同一 App Server 时不作为确定性出站依据。
- 配置 `upstream_user_agent` 后，HTTP 与 WebSocket 上游观察到的值与 TOML 字符串完全一致，
  多客户端下同样确定。
- 非法值在服务启动或交互保存前明确拒绝，不降级到默认值。
- 完整 UA 不进入指标数据库、日志、渠道消息或 PR 验证产物。
- 文档、配置示例、Setup 提示、模块 README 和测试在实现提交中同步更新。
