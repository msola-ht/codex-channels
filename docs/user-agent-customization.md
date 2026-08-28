# User-Agent 自定义设计

本文定义 Codex Connect 对 App Server 客户端身份和模型上游 `User-Agent` 的可配置方案。
当前仅完成设计，不表示配置字段、Setup 入口或运行时覆盖已经实现。

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

当前锁定的 Codex 0.150.1 会把 `clientInfo.name` 设为进程级 originator，把
`clientInfo.name` 和 `clientInfo.version` 组成 UA 后缀。模型请求的原始 UA 由 App Server
生成，结构近似为：

```text
codex_connect/0.150.1 (<系统与架构>) <终端标识> (codex_connect; <Gateway 版本>)
```

第一个 `0.150.1` 来自 App Server 的真实构建版本，不等于 `clientInfo.version`。Provider Proxy
收到该原始 Header 后，目前只移除 Hop-by-hop Header 和私有 Turn 元数据，再把 UA 原样转发到上游。
HTTP/SSE 与 WebSocket 都遵循这一行为。

模型数据通路和 Provider Proxy 由 App Server 服务进程持有；Gateway 主进程只接收可丢失的指标。
因此 UA 覆盖属于 App Server 服务配置，不能通过仅重启 Gateway 生效。

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
| `codex.client_identity.name` | `codex_connect` | `initialize.clientInfo.name` 和 App Server originator |
| `codex.client_identity.title` | `Codex Connect Gateway` | `initialize.clientInfo.title` |
| `codex.client_identity.version` | 当前 Gateway 版本 | `initialize.clientInfo.version` 和 App Server UA 后缀中的声明版本 |
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
  User-Agent = my_client/0.150.1 (<系统与架构>) <终端标识> (my_client; 1.0.0)

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

`codexc config` 的“系统设置”增加“请求身份”入口，依次提供：

1. App Server 客户端身份：编辑名称、标题和声明版本，允许单项恢复默认。
2. 模型上游 User-Agent：输入完整值、查看是否已自定义、恢复默认。

保存前显示影响范围，但不回显到聊天渠道：

```text
影响：全部受管 Provider 的新连接
生效：需要重启 Codex App Server；现有 Thread 不迁移
```

首期不增加独立 `codexc ua` 命令，也不在 `codexc setup` 的 Provider 页面重复入口。
脚本或自动化直接编辑 TOML；交互入口与配置文件使用同一校验和原子写入实现。

## 生命周期与多 Provider

- 客户端身份在每个 App Server 连接的 `initialize` 阶段设置，并会改变进程级 originator。
- 完整上游 UA 由每个受管 Provider Proxy 在构造出站请求时覆盖。
- 主 Provider、DeepSeek、OpenCode Go 多账户、自定义 Provider 和共享第三方子代理使用同一全局值。
- 修改任一字段后运行 `codexc service restart app-server`；需要同时刷新渠道状态时可运行
  `codexc service restart all`。仅运行 `codexc service restart gateway` 不会重建 Provider Proxy。
- 重启会结束 App Server 进程中的活动请求，因此 Setup 保存后只提示命令，不自动重启服务。
- 已有 Thread 的持久身份和 Provider 归属不修改；重启后恢复 Thread 时使用新的进程身份与出站 UA。

首期不支持按 Provider 或按账户分别设置 UA。若未来出现明确的上游兼容需求，应在 Provider 注册
边界设计独立覆盖优先级，并先解决同一共享代理承载多个 OpenCode Go 账户时的路由归属；不能把
Provider ID 字符串插值到全局 UA。

## 实现映射

后续实现应保持现有模块职责：

- `runtime/gateway-config.mjs` 与类型声明：增加严格 Schema、默认值和公共配置类型。
- `src/config`：补充运行语义与重载分类；这组变更要求重启 App Server，而不是只热加载 Gateway。
- `src/codex-client`：由组合根注入解析后的客户端身份，构造唯一一次 `initialize.clientInfo`；不得从
  TOML 直接读取配置。
- `src/provider-proxy`：由服务组合层注入可选完整 UA，在 HTTP 和 WebSocket 出站请求头的统一函数中
  覆盖；不得修改入站 Header 或指标载荷。
- `bin/codexc.mjs` 与配置脚本：把同一配置传给主代理、按需 Provider 代理和 OpenCode Go 共享代理，
  增加原子编辑入口与重启提示。
- `codexc doctor`：检查配置是否可解析并显示默认/自定义状态，不发送探测请求，不打印完整值。

不修改 Codex `~/.codex/config.toml`、Provider Profile、API Key 文件、数据库 Schema、指标协议或
Surface 配置。

## 验证计划

实现阶段至少覆盖：

1. 配置 Schema：默认值、四个字段、边界长度、控制字符、未知字段与原子写入失败。
2. Initialize 合同：缺省身份保持当前值；自定义身份精确进入 `clientInfo`；每次连接只初始化一次。
3. HTTP 代理：缺省时保留 App Server UA，自定义时上游收到精确覆盖值，私有元数据仍被移除。
4. WebSocket 代理：握手 Header 使用相同覆盖规则，不影响协议升级 Header 和子协议。
5. Provider 组合：主 Provider、按需 Provider、OpenCode Go 共享代理与 `agents.external` 都接收同一值。
6. 生命周期：重载分类要求重启 App Server；只重启 Gateway 后不得误报配置已生效。
7. Setup/Config：编辑、单项恢复、全部恢复、取消和无 TTY 输出均不泄露完整 UA。
8. 回归：请求指标、额度、压缩、第三方子代理和 Provider 空闲释放行为保持不变。

锁定版本真实 App Server 合同只验证 `clientInfo` 与官方返回 UA 的关系；完整上游覆盖使用本地代理
合同测试验证，不依赖外部模型服务。

## 验收标准

- 不配置新增字段时，现有配置文件、请求 UA 和所有 Provider 行为零变化。
- 配置客户端身份后，App Server 返回的 UA 包含新名称和声明版本，同时保留真实 Codex 构建版本。
- 配置 `upstream_user_agent` 后，HTTP 与 WebSocket 上游观察到的值与 TOML 字符串完全一致。
- 非法值在服务启动或交互保存前明确拒绝，不降级到默认值。
- 完整 UA 不进入指标数据库、日志、渠道消息或 PR 验证产物。
- 文档、配置示例、Setup 提示、模块 README 和测试在实现提交中同步更新。
