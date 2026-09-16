# Codex Desktop App 共享 App Server 实施方案

## 当前结论

目标不是接入 Codex Remote Control，也不是让手机或另一台设备通过配对码控制本机。目标是让同一
台电脑上的 Codex Desktop App 与 `codex-channels` 同时连接本项目监管的同一个主 OpenAI App
Server，使 Desktop、渠道和 `codexc remote` 看到同一份 Thread、Turn、Item 与实时通知。

当前锁定的 Codex CLI 0.154.0 已支持多客户端连接同一 App Server；Codex Desktop App 当前构建还
包含未公开的 `CODEX_APP_SERVER_WS_URL` 连接入口。这个入口不属于公开稳定合同，因此功能必须默认
关闭、严格做版本兼容探测，并在入口消失或行为改变时失败关闭。官方 Remote Control 的云端配对、
Environment ID、二维码和移动端不进入本方案。

2026-09-16 的 macOS 实机验收确认该入口能够完成 Desktop 与渠道的 Thread 双向共享，但同时触发了
新的停止条件：Desktop 内置 `codex_app` MCP 依赖 Desktop 进程运行后创建的私有
`CODEX_APP_TOOLS_PIPE_PATH`，独立运行的共享 App Server 既无法通过公开 App Server 协议取得该值，
也不处于 Desktop 接受的可信进程上下文。向独立 App Server 直接注入真实 Pipe 后仍被 Desktop 以
`untrusted-code-signing-identity` 拒绝。因此本文记录的回环桥只能作为会话共享预览，不能视为完整
Desktop 兼容方案；在新的进程所有权设计通过审查前停止继续扩展当前桥。

实现保留现有 App Server 服务、Provider 代理、指标采集、私有 UDS、Supervisor 和
`codexc remote` 架构。在主 OpenAI App Server 前增加一个仅监听回环地址、带随机令牌的 WebSocket
桥；Desktop 连接桥，桥为每个下游连接建立一个到现有私有 UDS 的独立上游连接并原样转发文本帧。
桥不解析 JSON-RPC 业务方法，不维护 Thread 索引，不读取 Codex 会话文件。

## 当前实施状态

- 阶段一已在当前功能分支完成：严格配置、私有令牌、受认证回环桥、现有跨平台 Transport、主
  Provider 租约、服务生命周期、单元测试和真实 App Server 双客户端 Thread 共享合同已经落地。
- 阶段二的命令与 macOS 实现已经完成：`status`、配置事务、服务重启、兼容探测、桥就绪探测和
  `open --env` 已落地。ChatGPT `26.908.70816` 已完成实机双向会话验收，Desktop 与渠道可以发现
  和继续同一 Thread，App Server 重启后可以恢复连接；但内置 `codex_app` MCP 启动失败，完整
  Desktop 兼容验收未通过，因此继续标记为 macOS 预览。
- 阶段三代码已经完成：Windows 不采用当前用户持久环境与 Explorer 激活，而是定位当前用户
  `OpenAI.Codex` 包内的正式可执行文件，直接创建只继承本次共享端点的 Desktop 子进程；安装包
  探测、兼容标记、同路径进程检查、子进程环境隔离与命令测试已经落地。Windows 实机双向验收
  尚未完成。
- 阶段四的自动化文档、全量测试、类型与边界检查、生产和测试 Lint、文档检查、真实 App Server
  合同、构建及 npm tarball / 干净源码安装冒烟已经通过；这些检查只覆盖桥和 App Server 协议，
  不覆盖打包 Desktop 的私有 `codex_app` 工具 Pipe。当前 macOS 环境没有 PowerShell 7，Windows
  探测脚本的语法与行为仍需由 Windows 门禁和实机验收确认。

因此当前代码与本机可执行门禁已经完成，macOS 会话双向共享已经通过，但 macOS 完整 Desktop
兼容失败；Windows 的会话共享、内置工具和平台专属检查均未完成。当前实现不能宣称全阶段完成或
正式支持。

## 事实基线

### 官方锁定版本

- 项目固定 `codex-cli 0.154.0`，协议与实现仍以 [`Codex 协议索引`](index.md)和
  `upstream/openai-codex` 的 `rust-v0.154.0` 锁定源码为准。
- 官方远程客户端以 WebSocket 连接 App Server；每个连接独立执行一次
  `initialize` / `initialized`。
- Unix 客户端可以直接通过 WebSocket-over-UDS 连接。Windows 使用官方
  `codex app-server proxy --sock <path>` 把 stdio WebSocket 转到同一私有 UDS。
- 官方 `app-server daemon` 是实验性生命周期工具，会自行选择二进制、环境、控制 Socket 与更新
  方式。它不能代替本项目现有的 Provider 代理、指标采集和 Supervisor，因此本轮不采用。

### Desktop 兼容入口

- 当前 macOS Desktop 构建包含 `CODEX_APP_SERVER_WS_URL`、
  `CODEX_APP_SERVER_USE_LOCAL_DAEMON`、`CODEX_APP_SERVER_FORCE_CLI` 和 `CODEX_CLI_PATH`。
- `CODEX_APP_SERVER_USE_LOCAL_DAEMON` 依赖官方 daemon 的固定 Socket 与生命周期，并会受 Desktop
  配置覆盖影响；它不能连接本项目当前私有 Socket。
- `CODEX_APP_SERVER_WS_URL` 可以让 Desktop 作为普通 WebSocket 客户端连接指定端点，是本方案唯一
  使用的 Desktop 私有入口。
- 当前 Desktop 还会在自身进程内创建随机的 `CODEX_APP_TOOLS_PIPE_PATH`，供内置 `codex_app` MCP
  连接 Desktop 私有工具。该值在 Desktop 启动后产生，不属于公开 App Server RPC，也不会通过
  `CODEX_APP_SERVER_WS_URL` 连接传给外部 App Server。
- macOS 的工具 Pipe 还校验连接进程的代码签名或可信启动上下文。普通 Node 转发、符号链接、直接
  注入真实 Pipe，以及由独立真实 App Server 拉起的 MCP 进程均未通过该校验；因此补传环境变量或
  增加 Socket Relay 不是可用修复。
- 这些变量没有公开稳定文档。支持结论只能按经过真实验收的 Desktop 版本与平台记录，不能把
  “安装包中存在字符串”解释为完成兼容。
- 两个公开开源实现都通过 `Get-AppxPackage -Name OpenAI.Codex` 定位 Windows 当前用户包，并直接
  创建包内 `ChatGPT.exe` / `Codex.exe` 子进程、注入仅属于该子进程的环境。这为本项目提供了实现
  依据，但不替代本项目在 Windows 上的真实 Desktop 验收。

## 目标与非目标

### 目标

1. Desktop、Gateway 与 `codexc remote` 共享主 OpenAI App Server 的 Thread 和实时状态。
2. Desktop 新建或继续的空闲 Thread 可被渠道发现和继续；渠道新建或继续的 Thread 可在 Desktop
   中读取和继续。
3. macOS 与 Windows 使用相同的桥接协议、安全边界和命令语义；平台差异只留在 Desktop 启动与
   环境注入层。
4. 保留现有 OpenAI Provider 代理、上游指标、Supervisor、私有 UDS 与服务生命周期。
5. App Server 服务重启时关闭所有桥接连接；Desktop 通过自身重连或重新打开恢复，不产生第二套
   会话状态。
6. 完整兼容验收不能让 Desktop 随包提供的内置 MCP 从可用退化为失败；会话共享与 Desktop 工具
   等价性必须分别验证和报告。

### 非目标

- 不接入 Remote Control、移动端、二维码、配对码或云端 Environment。
- 不让 Desktop 连接第三方主 Provider 或按需 Provider 隔离实例；首期只支持主 Provider 为
  `openai`。
- 不复制 Desktop UI，不让渠道模拟 Desktop 的审批界面，不跨连接转发审批决定。
- 不支持两端同时向同一活动 Thread 写入。App Server 的活动状态仍是唯一依据；发现活动 Turn 时
  另一端只能观察、排队或等待完成。
- 不读取、修改或迁移 `~/.codex/sessions`、SQLite 会话库或 Desktop 私有文件。
- 不承诺 Desktop 的未公开环境变量长期存在；版本不兼容时不回退到私有 stdio App Server。

## 架构与数据流

```text
Codex Desktop App
  │  ws://127.0.0.1:<port>/codex-app-server?token=<secret>
  ▼
Desktop App Bridge（App Server 服务内）
  │
  ├─ macOS/Linux: WebSocket over private UDS
  └─ Windows: codex app-server proxy --sock <private UDS>
  ▼
主 OpenAI App Server
  ▲                 ▲
  │                 │
Gateway          codexc remote
```

桥终止下游和上游各自的 WebSocket 握手，但不终止 JSON-RPC 语义。每个 Desktop 连接对应一个独立
上游连接，Desktop 自己发送 `initialize`；桥不能替它生成、删除、重写或缓存任何 JSON-RPC 消息。
只转发文本帧，二进制帧以 WebSocket `1003` 关闭。单帧上限与官方远程客户端一致，为 128 MiB。

每个桥接连接在建立上游前获取主 Provider 租约，关闭两个方向的连接和 Windows Proxy 子进程后
释放租约。这样空闲释放不能在 Desktop 正在连接时终止主实例；App Server 服务关闭时先停止接受
新连接，再有限等待现有连接关闭，最后关闭 Supervisor 与 Provider 代理。

## 配置与私有状态

在用户唯一配置 `~/.codex-connect/config.toml` 的 `[codex]` 下增加严格子表：

```toml
[codex.desktop_app]
enabled = false
port = 47821
```

- `enabled` 默认 `false`。只有主 Provider 为 `openai` 时才能启动桥，否则 App Server 服务明确失败。
- `port` 必须是 `1..65535`，只监听 `127.0.0.1`；不支持 `0.0.0.0`、主机名、远端 URL、动态端口或
  TLS 配置。
- 端口是部署参数，不在实现中作为不可修改常量使用；`47821` 只是 Schema 安全默认值。

首次启用时在 Gateway 数据目录创建 `credentials/desktop-app-bridge-token`：

- 内容为密码学随机令牌，原子写入；Unix 权限为 `0600`，Windows 使用当前用户私有 ACL。
- 文件存在时复用，不因服务重启轮换，以便 Desktop 环境保持有效。
- 文件缺失时生成；文件不是普通文件、权限不安全、为空或格式无效时失败关闭，不静默替换。
- `disable` 移除整个 `[codex.desktop_app]` 子表；两个平台都不写持久 Desktop 环境，因此没有系统
  环境需要清理。不删除令牌文件，删除用户数据不属于该命令。
- 令牌、完整 WebSocket URL、查询参数和 Desktop 环境值不得进入日志、Doctor 文本、JSON 状态、
  异常或平台消息。

这增加一个独立的私有凭据文件，不改变 StateStore、指标库或计划任务数据库 Schema。回滚旧版本前
先关闭功能并删除配置子表；保留的令牌文件不会被旧版本读取，可以由用户在服务停止后手工删除。

## 回环桥安全边界

1. HTTP Server 只绑定 `127.0.0.1`，只接受精确路径 `/codex-app-server` 的 WebSocket Upgrade。
2. Upgrade 必须携带精确查询参数 `token`；使用恒定时间比较验证。缺失、重复、格式无效或不匹配
   均返回通用 `401` 后关闭，不进入 App Server。
3. 不接受 HTTP 业务请求、CORS、浏览器 Cookie、代理转发头、子协议或远端绑定。
4. 日志只记录启动、关闭、连接数量、平台和稳定错误类别，不记录 URL、请求头、帧内容或令牌。
5. 每个方向串行发送，保持单连接消息顺序；任一方向错误或关闭时关闭另一方向并释放全部资源。
6. 并发连接数限制为 4。超过上限时在握手前拒绝；该值是固定的本机资源边界，不作为用户配置。
7. 服务关闭等待上限沿用现有 5 秒生命周期；超时后终止桥接 Socket 与 Windows Proxy 子进程。

## Desktop 连接与命令

新增公开命令 `codexc desktop-app`，所有层级支持 `-h` / `--help`：

```text
codexc desktop-app enable [--port <1-65535>]
codexc desktop-app disable
codexc desktop-app status [--json]
codexc desktop-app open
```

### `enable`

1. 检查平台为 macOS 或 Windows、主 Provider 为 `openai`、Desktop 已安装且当前未运行。
2. 检查 Desktop 构建包含 `CODEX_APP_SERVER_WS_URL` 兼容入口；无法确认时不修改配置或系统环境。
3. 创建或验证私有桥令牌，原子写入 `[codex.desktop_app]`，保留其余 TOML 注释和字段。
4. 不写当前用户或系统级持久环境；共享端点只由 `open` 注入本次 Desktop 子进程。
5. 重启 App Server 服务并等待桥就绪；Gateway 不需要重启。
6. 任一步失败时按修改前快照恢复配置；令牌文件可保留。

### `disable`

1. 要求 Desktop 已关闭。
2. 移除整个 `[codex.desktop_app]` 子表，重启 App Server 服务并确认桥已关闭。
3. 不修改当前用户或系统级环境，不删除 Thread、配置文件、令牌文件或 App Server Socket。

### `status`

只读报告以下结构化事实：平台是否支持、Desktop 是否安装和运行、兼容入口是否存在、配置是否启用、
主 Provider 是否为 OpenAI、App Server 服务与桥端口是否可连接，以及下一步动作。两个平台都只
报告采用单次启动环境，不尝试读取运行中 Desktop 的进程环境。
JSON 中 URL 只输出 `ws://127.0.0.1:<port>/codex-app-server`，不带查询参数。

### `open`

- 只在配置、兼容探测、服务与桥全部就绪时启动 Desktop。
- Desktop 已运行时拒绝，提示先完全退出；不强制结束用户进程。
- macOS 使用 `/usr/bin/open --env CODEX_APP_SERVER_WS_URL=<url> -a ChatGPT` 启动，环境只传给本次
  新进程；不使用 `launchctl setenv` 污染整个登录会话。
- Windows 通过 PowerShell 7 查询当前用户 `OpenAI.Codex` 包，限定包内已验证的
  `app\ChatGPT.exe` 或 `app\Codex.exe`，然后使用直接子进程创建且只修改子进程环境副本；不把
  私有 URL 放入命令行，不委托给已运行的 Explorer，也不写注册表级用户环境。
- Windows 实机合同未证明包内可执行文件可靠继承环境并保持运行前，不把该平台标为正式支持，也
  不要求注销或重启系统作为成功条件。

## Thread、Turn 与审批语义

- App Server 仍是唯一事实来源。Desktop、Gateway 和 TUI 各自建立连接并独立订阅 Thread。
- Desktop 创建、恢复、归档、改名或更新 Thread 后，Gateway 只根据官方通知和后续
  `thread/list` / `thread/read` 观察结果，不从桥连接事件推断业务状态。
- 渠道自动接续仍执行现有来源、Workspace、活动状态和绑定独占检查；桥不绕过这些检查。
- 同一 Thread 的活动 Turn 不能被第二端无条件追加新 Turn。渠道补充输入继续使用 App Server Queue；
  Desktop 如何呈现 Queue 由官方客户端决定。
- Server Request 由产生请求的 App Server 连接处理。Desktop 发起 Turn 的命令、文件、权限、用户
  输入或 MCP 请求留在 Desktop；Gateway 发起 Turn 的请求仍走现有渠道审批。桥不广播、不转移、
  不代答审批。
- 一个客户端解决请求后，其他客户端只根据官方通知更新状态；桥不构造跨客户端失效事件。

## macOS 实机验收记录

2026-09-16 使用 ChatGPT `26.908.70816` 与 Codex CLI `0.154.0` 验证：

| 项目 | 结果 | 结论 |
| --- | --- | --- |
| `desktop-app enable/open/status` | 通过 | 配置、令牌、桥、单次启动环境和服务重启主路径可用 |
| Desktop 与渠道双向发现并继续 Thread | 通过 | 两端连接同一主 OpenAI App Server |
| App Server 重启后的 Desktop 恢复 | 通过 | Desktop 保持共享端点并重新连接 |
| Desktop 内置 `codex_app` MCP | 失败 | 缺少 `CODEX_APP_TOOLS_PIPE_PATH`；直接注入后仍被可信进程校验拒绝 |
| 完整 macOS Desktop 兼容 | 未通过 | 当前只能发布为会话共享预览 |

自动化真实 App Server 合同只能证明两个普通 App Server Client 通过桥共享 Thread，不能模拟打包
Desktop 创建的私有工具 Pipe、代码签名校验或内置 MCP 生命周期。后续验收必须把这部分列为独立
实机门槛，不能再用双 Client 合同替代。

## 平台实现

### macOS

- Desktop 探测限定正式 `ChatGPT.app`，读取 Bundle 版本和资源内兼容入口，不修改签名内容。
- App Server 上游继续使用现有 WebSocket-over-UDS。
- `open --env` 只负责本次启动。用户从 Dock 直接重新启动时可能回到 Desktop 私有 App Server；
  `status` 必须显示环境未受管，文档要求通过 `codexc desktop-app open` 启动。

### Windows

- Desktop 探测使用当前用户已安装的正式 ChatGPT 包，不扫描或修改应用安装目录。
- 每个桥接连接复用项目现有 `createAppServerTransport`，由
  `WindowsProxyTransport` 启动锁定 Codex CLI 的 `app-server proxy --sock`；不开放 App Server
  TCP 监听，不放宽 UDS ACL。
- `Get-AppxPackage` 只查询当前用户包；启动时从父进程环境副本移除同名大小写变体，再写入唯一的
  `CODEX_APP_SERVER_WS_URL`。命令不修改用户级或系统级环境、不要求管理员权限、不操作其他用户、
  不写真实令牌到 TOML 或命令行。
- Windows 保持开发预览。命令只有在当前用户包、兼容入口和桥均通过运行时检查时才可用；必须在
  普通用户环境完成真实 Desktop 双向验收后，才能改为正式支持。

### Linux

当前没有官方 Codex Desktop App 支持目标，命令明确返回不支持。桥不因 Linux 可运行 Gateway
而自动启用；若官方 Desktop 后续支持 Linux，必须重新完成兼容探测和真实验收。

## 实现落点

- `runtime/desktop-app-bridge.mjs` 与声明文件：令牌文件、回环 WebSocket Server、认证、每连接
  Transport、帧转发、租约与关闭。
- `runtime/app-server-service-runtime.mjs`：仅在配置启用且主 Provider 为 OpenAI 时装配桥，并纳入
  App Server 服务关闭顺序。
- `runtime/gateway-config.mjs` 与声明文件：严格 `[codex.desktop_app]` Schema 和安全默认值。
- `scripts/desktop-app-command.mjs` 与声明文件：兼容探测、配置事务、服务控制、状态与平台单次环境
  启动。
- `scripts/windows-desktop-app-inspect.ps1`：只读查询当前用户安装包、固定包内可执行文件和同路径
  进程状态，不读取或修改其他用户与应用目录。
- `bin/codexc.mjs`：公开命令、帮助与路由。
- `runtime/README.md`、`scripts/README.md`、`bin/README.md`：新增文件与公开入口索引。
- `README.md` 与 `docs/user-guide.md`：只写用户操作、当前限制和排障，不复制内部桥协议。
- `docs/index.md`：记录共享 App Server 行为、官方基线、实现映射与真实合同。
- `docs/windows-support-development.md`：记录受认证桥不替换固定 UDS Transport，以及 Windows 实机
  验收状态。

## 分阶段实施

### 阶段一：桥接核心与配置

1. 增加严格配置、私有令牌文件和回环认证 WebSocket Server。
2. 使用现有跨平台 App Server Transport 为每个 Desktop 连接建立独立上游。
3. 接入主 Provider 租约、App Server 服务启动/关闭与就绪状态。
4. 增加单元测试：配置默认值与拒绝、认证、路径、并发、文本转发、二进制拒绝、顺序、半连接
   失败、租约释放和有限关闭。
5. 增加真实 App Server 合同：两条桥接连接各自初始化，一端创建 Thread，另一端读取并收到状态。

阶段一完成后，桥仍默认关闭，没有 Desktop 环境写入和公开启用命令。

### 阶段二：macOS 命令与真实 Desktop 验收

1. 增加 `desktop-app enable|disable|status|open` 与帮助。
2. 实现 ChatGPT Bundle 探测、兼容入口检查和 `open --env` 启动。
3. 完成配置与服务重启事务、冲突恢复和脱敏状态输出。
4. 实机验证双向发现、空闲 Thread 继续、活动 Turn 观察、审批归属、App Server 重启和禁用回滚。
5. 分别记录会话共享与内置工具验收；只有两者都通过才能声明完整兼容，部分通过只能作为边界明确
   的预览或回滚。

### 阶段三：Windows 启动适配与真实 Desktop 验收

1. 实现当前用户安装包探测、包内可执行文件与兼容入口校验，以及直接子进程单次环境启动。
2. 在普通用户、非提权终端验证 Desktop 继承环境和 `WindowsProxyTransport` 每连接清理，确认
   私有 URL 不进入命令行、用户环境或系统环境。
3. 验证用户切换、服务重启、端口冲突、已有同名父进程环境、禁用回滚和跨用户访问拒绝。
4. Windows 验收前保持明确的 `preview` 支持级别，不用 macOS 结果代替。

### 阶段四：文档与完整门禁

1. 同步 README、用户指南、协议矩阵、Windows 边界和模块索引。
2. 运行定向测试、`check`、生产与测试 Lint、`docs:check`、真实 App Server 合同、构建和 npm
   tarball 安装冒烟。
3. macOS 与 Windows 分别记录实机 Desktop 版本、构建、启动方式和双向验收结果。

## 验收标准

功能只有同时满足以下条件才算完成：

1. 未启用时无 TCP 监听、无 Desktop 环境修改，现有 Gateway、TUI、Provider 与指标行为不变。
2. 非法路径、缺失或错误令牌、第五个并发连接、二进制帧和非 OpenAI 主 Provider均失败关闭。
3. Desktop 与渠道能够双向发现并继续对方创建的空闲 Thread，且看到同一 Thread ID 与 Turn 结果。
4. 活动 Thread 不发生双写；审批仍由发起 Turn 的客户端处理。
5. Provider 指标、主实例监管、空闲释放、`codexc remote` 和 Gateway 重启恢复合同保持通过。
6. 服务停止、桥连接断开和 Windows Proxy 退出后没有遗留监听、租约或子进程。
7. 日志、状态、错误、JSON、配置与平台消息中均不出现桥令牌或完整 URL。
8. macOS 与 Windows 各自在真实 Desktop 上通过；任一平台未通过时必须单独标为预览或不支持，
   不能宣称全平台完成。
9. Desktop 随包提供的 `codex_app` MCP 在共享模式下保持可用；`bridgeReady`、Thread 双向共享或
   自动化双 Client 合同均不能替代该项实机验证。

## 失败与回滚

- Desktop 兼容入口缺失、进程正在运行、端口占用、令牌文件不安全、主
  Provider 非 OpenAI或桥无法连接私有 UDS 时，拒绝启用并保留原状态。
- 桥运行失败不回退到 Desktop 私有 App Server，不启动官方 daemon，不开放无认证端口。
- 禁用时恢复配置；没有持久环境需要清理，也不强制结束 Desktop。
- 回滚代码前先执行 `codexc desktop-app disable`。该命令移除 `[codex.desktop_app]`；旧版本会
  忽略保留的私有令牌文件。

## 停止条件

出现以下任一情况，停止实现并重新审查，不用兼容分支掩盖：

1. Desktop 不再接受 `CODEX_APP_SERVER_WS_URL`，或必须修改应用签名/安装内容才能接入。
2. Desktop 只接受无认证远端端点，且不能携带查询令牌。
3. 共享连接要求复制、修改或锁定 Codex 会话文件。
4. 多客户端连接在锁定 App Server 版本不能保持独立初始化、通知或 Server Request 归属。
5. Windows 包内可执行文件无法在不提权、不修改持久环境、不要求注销的前提下可靠继承端点。
6. 实现需要绕开现有 Provider 代理、指标、Supervisor、私有 UDS 或固定 Windows Proxy
   Transport。
7. 当前 macOS Desktop 的私有工具 Pipe 要求受信任的连接进程上下文，导致本项目独立运行的共享
   App Server 无法使用内置工具。

第 7 项已在 macOS 实机验收中触发。当前桥接实现停止在会话共享预览，不继续增加 Pipe Relay、
签名绕过、应用包修改或静默禁用内置 MCP。

## 下一阶段决策边界

若继续追求完整双向兼容，需要先新建设计文档并审查以下方案，不在当前桥上直接试改：

1. 由 Desktop 的可信进程上下文启动主 App Server，再为 Gateway 与 `codexc remote` 提供受控接入；
   这会改变 App Server 的进程所有权、服务重启、Provider 代理、指标、Supervisor、私有 UDS 与
   Windows 启动边界。
2. 等待 OpenAI 提供受支持的外部 App Server 工具 Pipe 交接或等价公开接口；在此之前不推断私有
   变量的兼容承诺。
3. 保留当前预览作为明确的“会话共享模式”，接受该模式不提供内置 `codex_app` MCP；不得在状态、
   README 或发布说明中称为完整 Desktop 兼容。

优先评估第 1 项是否能在不破坏现有共享 App Server 事实来源和 Provider 边界的前提下成立；若不能，
当前预览只能保留第 3 项的有限范围，或整体回滚。
