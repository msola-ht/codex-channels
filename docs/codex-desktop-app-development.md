# Codex Desktop App 共享 App Server 实施方案

## 当前结论

目标不是接入 Codex Remote Control，也不是让手机或另一台设备通过配对码控制本机。目标是让同一
台电脑上的 Codex Desktop App 与 `codex-channels` 同时连接本项目监管的同一个主 OpenAI App
Server，使 Desktop、渠道和 `codexc remote` 看到同一份 Thread、Turn、Item 与实时通知。

当前锁定的 Codex CLI 0.155.1 已支持多客户端连接同一 App Server；Codex Desktop App 当前构建还
包含未公开的 WebSocket 与强制 CLI 启动入口。macOS 使用强制 CLI 与受管 stdio Proxy，Windows
继续使用 `CODEX_APP_SERVER_WS_URL`。这些入口不属于公开稳定合同，因此功能必须默认关闭、严格做
平台兼容探测，并在入口消失或行为改变时失败关闭。官方 Remote Control 的云端配对、Environment
ID、二维码和移动端不进入本方案。

2026-09-16 的 macOS 实机验收确认该入口能够完成 Desktop 与渠道的 Thread 双向共享，但 Desktop
内置 `codex_app` MCP 还依赖 Desktop 启动后创建的私有 `CODEX_APP_TOOLS_PIPE_PATH` 和可信进程链。
现有服务直接注入真实 Pipe 时，MCP 连接链的祖先包含普通服务 Node，Desktop 因而返回
`untrusted-code-signing-identity`。后续隔离验证已经把问题收敛到进程链：项目锁定的 OpenAI 签名
Codex CLI 0.154.0 由 Desktop 随包的 OpenAI 签名 Node 托管时，同一 Pipe 成功启动
`codex_app` 0.1.0，并返回 38 个工具且无工具发现错误。这证明共享 App Server 不需要改由 Desktop
所有，也不需要修改应用包、伪造签名或增加 Pipe Relay；macOS 受管 stdio Proxy 动态交付 Pipe，
并只重启现有主 App Server 子进程以切换可信父进程链。

实现保留现有 App Server 服务、Provider 代理、指标采集、私有 UDS、Supervisor 和
`codexc remote` 架构。macOS Desktop 的 JSONL stdio 连接由受管 Proxy 转换为 WebSocket 文本帧，
再连接现有私有 UDS；Windows
在主 OpenAI App Server 前使用仅监听回环地址、带随机令牌的 WebSocket 桥。两条路径都不解析
JSON-RPC 业务方法，不维护 Thread 索引，不读取 Codex 会话文件。

## 当前实施状态

- 阶段一已在当前功能分支完成：严格配置、私有令牌、受认证回环桥、现有跨平台 Transport、主
  Provider 租约、服务生命周期、单元测试和真实 App Server 双客户端 Thread 共享合同已经落地。
- 阶段二的初版命令与旧 macOS 回环桥实现已经完成：`status`、配置事务、服务重启、兼容探测、桥
  就绪探测和 `open --env` 已落地。ChatGPT `26.908.70816` 已完成该路径的实机双向会话验收，
  Desktop 与渠道可以发现和继续同一 Thread，App Server 重启后可以恢复连接；但内置 `codex_app`
  MCP 启动失败，完整
  Desktop 兼容验收未通过，因此继续标记为 macOS 预览。
- 阶段三代码已经完成：Windows 不采用当前用户持久环境与 Explorer 激活，而是定位当前用户
  `OpenAI.Codex` 包内的正式可执行文件，直接创建只继承本次共享端点的 Desktop 子进程；安装包
  探测、兼容标记、同路径进程检查、子进程环境隔离与命令测试已经落地。Windows 实机双向验收
  尚未完成。
- 阶段四的自动化文档、全量测试、类型与边界检查、生产和测试 Lint、文档检查、真实 App Server
  合同、构建及 npm tarball / 干净源码安装冒烟已经通过；这些检查只覆盖桥和 App Server 协议，
  不覆盖打包 Desktop 的私有 `codex_app` 工具 Pipe。当前 macOS 环境没有 PowerShell 7，Windows
  探测脚本的语法与行为仍需由 Windows 门禁和实机验收确认。
- macOS 完整兼容第二阶段的代码已经落地：受管 stdio Proxy、带独立能力版本的 Supervisor Host
  租约、内置插件布尔配置传递、签名与精确版本校验、主实例串行切换和状态均已完成；macOS 不再
  启动或探测回环桥。macOS 命令测试已经改为受管入口合同，Supervisor Host 租约、插件布尔值解析
  与现有 Windows 桥的定向测试均已通过。完整 Proxy 隔离合同以及源码部署后的真实 Desktop 启动、
  双向接续和服务重启自动恢复也已通过实机复核；当前发布状态仍是预览，Windows 实机路径尚未
  验收，完整提交门禁仍需在提交时由 pre-commit hook 执行。
- 2026-09-17 源码实机测试发现，受管入口错误地把 Desktop JSONL stdio 裸转发给
  WebSocket-over-UDS，导致 `initialize` 一直等待、Desktop 停在 `Codex is still starting`，并使
  `codex_app` 的 `tools/list` 超时。当前修复由项目 Proxy 自行完成 WebSocket 握手和 JSONL/文本帧
  边界转换；定向测试与锁定 Codex 0.154.0 的真实 `initialize` 合同已通过。源码重新部署后，打包
  Desktop 已通过受管启动、渠道到 Desktop、Desktop 到渠道以及 App Server 重启断线恢复测试；启动
  过程中不再出现 `codex_app` 工具发现错误或 `Codex is still starting` 卡住。

因此当前代码与本机可执行门禁已经完成，macOS 受管入口的会话双向共享、签名 Host、内置工具启动
和服务重启恢复均已通过；Windows 的会话共享、内置工具和平台专属检查仍未完成。
当前实现不能宣称全平台完成或正式支持。

## 事实基线

### 官方锁定版本

- 项目固定 `codex-cli 0.155.1`，协议与实现仍以 [`Codex 协议索引`](index.md)和
  `upstream/openai-codex` 的 `rust-v0.155.1` 锁定源码为准。下文 0.154.0 的实机结果是历史验收，
  不代表 0.155.1 已完成打包 Desktop 私有工具 Pipe 与签名链的实机复核。
- 官方远程客户端以 WebSocket 连接 App Server；每个连接独立执行一次
  `initialize` / `initialized`。
- Unix 客户端可以直接通过 WebSocket-over-UDS 连接。官方
  `codex app-server proxy --sock <path>` 只是 stdio 与 UDS 之间的裸字节中继；Windows
  `WindowsProxyTransport` 在该中继之上建立 WebSocket。Desktop 的 JSONL stdio 不能直接送入这个
  裸中继。
- 官方 `app-server daemon` 是实验性生命周期工具，会自行选择二进制、环境、控制 Socket 与更新
  方式。它不能代替本项目现有的 Provider 代理、指标采集和 Supervisor，因此本轮不采用。

### Desktop 兼容入口

- 当前 macOS Desktop 构建包含 `CODEX_APP_SERVER_WS_URL`、
  `CODEX_APP_SERVER_USE_LOCAL_DAEMON`、`CODEX_APP_SERVER_FORCE_CLI` 和 `CODEX_CLI_PATH`。
- `CODEX_APP_SERVER_USE_LOCAL_DAEMON` 依赖官方 daemon 的固定 Socket 与生命周期，并会受 Desktop
  配置覆盖影响；它不能连接本项目当前私有 Socket。
- `CODEX_APP_SERVER_WS_URL` 只用于 Windows 回环桥。macOS 设置 `CODEX_APP_SERVER_FORCE_CLI=1`
  与受管 `CODEX_CLI_PATH`，使 Desktop 启动项目 Proxy。
- 当前 Desktop 还会在自身进程内创建随机的 `CODEX_APP_TOOLS_PIPE_PATH`，供内置 `codex_app` MCP
  连接 Desktop 私有工具。该值在 Desktop 启动后产生，不属于公开 App Server RPC，也不会通过
  `CODEX_APP_SERVER_WS_URL` 连接传给外部 App Server。
- macOS 的工具 Pipe 会校验连接进程及其父级进程的代码签名。普通 Node 转发、符号链接和仅向现有
  服务子进程补传环境变量均未通过；但“签名 MCP Node → 签名 Codex 0.154.0 → 签名 Desktop Node”
  已通过真实 Pipe 验证。因此修复必须同时满足动态环境交付和可信父进程链，不能只补变量或转发
  Socket。
- Desktop 随包 Codex 为 `0.154.0-alpha.6.2`，与项目锁定协议基线不同，不能成为共享主 App
  Server。实施只能继续运行项目解析出的精确 Codex CLI 0.155.1 原生可执行文件；Desktop 随包内容
  只提供同一 OpenAI Team 签名的 Node 托管进程和 MCP 资源。
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
3. macOS 与 Windows 使用相同的命令语义并连接同一主 App Server；macOS 使用受管 stdio/UDS，
   Windows 使用受认证回环桥，平台连接边界保持明确分离。
4. 保留现有 OpenAI Provider 代理、上游指标、Supervisor、私有 UDS 与服务生命周期。
5. App Server 服务重启时关闭当前 Desktop 连接；Desktop 通过自身重连或重新打开恢复，不产生
   第二套会话状态。
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
macOS Desktop ─ JSONL stdio ─ 受管 Proxy ─ WebSocket/UDS ─┐
                                                          ├─ 主 OpenAI App Server
Windows Desktop ─ token WebSocket ─ 回环桥 ─ UDS ─────────┘          ▲
                                                              │
                                                Gateway / codexc remote
```

macOS Proxy 和 Windows 桥都不终止 JSON-RPC 语义，Desktop 自己发送 `initialize`；它们不能替
Desktop 生成、删除、重写或缓存业务消息。macOS Proxy 只在 JSONL 行与 WebSocket 文本帧之间保留
一一对应的消息边界；Windows 桥只转发文本帧，二进制帧以 WebSocket `1003` 关闭，单帧上限为
128 MiB。

两条平台路径都在连接期间持有主 Provider 租约，空闲释放不能终止主实例。macOS 最后一个 Host
租约关闭时只清除服务内存中的临时 Pipe 附加状态，不终止共享主实例；Windows 桥连接关闭时释放
上游 Transport 与租约。App Server 服务关闭时停止接受新连接并有限等待现有生命周期操作。

## 配置与私有状态

在用户唯一配置 `~/.codex-connect/config.toml` 的 `[codex]` 下增加严格子表：

```toml
[codex.desktop_app]
enabled = false
port = 47821
```

- `enabled` 默认 `false`。只有主 Provider 为 `openai` 时才能启用，否则 App Server 服务明确失败。
- `port` 是 Windows 桥参数，必须是 `1..65535`，只监听 `127.0.0.1`；macOS 保留同一严格配置结构，
  但不读取该端口、不启动 TCP 监听。
- 端口是 Windows 部署参数，不在实现中作为不可修改常量使用；`47821` 只是 Schema 安全默认值。

Windows 首次启用时在 Gateway 数据目录创建 `credentials/desktop-app-bridge-token`；macOS 不创建或
读取该令牌：

- 内容为密码学随机令牌并原子写入；Windows 使用当前用户私有 ACL。
- 文件存在时复用，不因服务重启轮换，以便 Desktop 环境保持有效。
- 文件缺失时生成；文件不是普通文件、权限不安全、为空或格式无效时失败关闭，不静默替换。
- `disable` 移除整个 `[codex.desktop_app]` 子表；两个平台都不写持久 Desktop 环境，因此没有系统
  环境需要清理。不删除令牌文件，删除用户数据不属于该命令。
- 令牌、完整 WebSocket URL、查询参数和 Desktop 环境值不得进入日志、Doctor 文本、JSON 状态、
  异常或平台消息。

Windows 增加一个独立的私有凭据文件，不改变 StateStore、指标库或计划任务数据库 Schema。回滚旧版本前
先关闭功能并删除配置子表；保留的令牌文件不会被旧版本读取，可以由用户在服务停止后手工删除。

## Windows 回环桥安全边界

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
2. macOS 检查强制 CLI、CLI 路径、工具 Pipe 和内置插件配置标记；Windows 检查 WebSocket 入口。
3. Windows 创建或验证私有桥令牌；macOS 不创建令牌。原子写入 `[codex.desktop_app]` 并保留其余
   TOML 注释和字段。
4. 不写当前用户或系统级持久环境；平台连接参数只由 `open` 注入本次 Desktop 子进程。
5. 重启 App Server 服务；Windows 继续等待桥就绪，macOS 只依赖 Supervisor 和私有 UDS。
6. 任一步失败时按修改前快照恢复配置；令牌文件可保留。

### `disable`

1. 要求 Desktop 已关闭。
2. 移除整个 `[codex.desktop_app]` 子表并重启 App Server 服务；Windows 同时关闭桥。
3. 不修改当前用户或系统级环境，不删除 Thread、配置文件、令牌文件或 App Server Socket。

### `status`

只读报告以下结构化事实：平台是否支持、Desktop 是否安装和运行、兼容入口是否存在、配置是否启用、
主 Provider 是否为 OpenAI、App Server 服务状态，以及下一步动作。macOS 另报告受管 Host 协议
能力与当前租约状态；Windows 报告桥端口是否可连接。两个平台都只报告采用单次启动环境，不尝试
读取运行中 Desktop 的进程环境。只有 Windows JSON 输出不带查询参数的回环 URL。

### `open`

- 只在配置、平台兼容探测与对应服务路径就绪时启动 Desktop。
- Desktop 已运行时拒绝，提示先完全退出；不强制结束用户进程。
- macOS 在启动前先拒绝仍由 `codexc remote` 持有的主实例租约，再通过官方
  `thread/loaded/list` 分页枚举全部已加载的持久及临时 Thread，并逐项使用 `thread/read` 读取状态；
  存在活动 Thread 或无法完成只读检查时拒绝启动，不进入
  会短暂替换主 App Server 子进程的 Pipe 附加阶段。Windows 不执行该检查，因为其桥接不替换子进程。
- macOS 使用 `/usr/bin/open --env CODEX_APP_SERVER_FORCE_CLI=1 --env CODEX_CLI_PATH=<受管入口>
  -a ChatGPT` 启动，并传入随包资源与签名 Node 路径。受管入口只接受 Desktop 实际提供的工具 Pipe
  和内置插件布尔启用值；不使用 `launchctl setenv`，也不连接回环桥。
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

2026-09-16 至 2026-09-17 使用 ChatGPT `26.908.70816` 与 Codex CLI `0.154.0` 验证：

| 项目 | 结果 | 结论 |
| --- | --- | --- |
| `desktop-app enable/open/status` | 通过 | 配置、令牌、桥、单次启动环境和服务重启主路径可用 |
| Desktop 与渠道双向发现并继续 Thread | 通过 | 两端连接同一主 OpenAI App Server |
| App Server 重启后的 Desktop 恢复 | 通过 | 重启期间渠道收到断线提示，主实例就绪后自动重连并继续双向接续 |
| Desktop 内置 `codex_app` MCP | 通过 | 签名 Host 隔离探针返回 38 个工具；修复后的受管启动不再出现 Pipe 缺失、`tools/list` 超时或启动卡住 |
| 签名 Host 隔离合同 | 通过 | 受管 stdio Proxy 连接同一 UDS，`codex_app` 0.1.0 返回 38 个工具且无错误 |
| 完整 macOS Desktop 受管入口 | 通过 | 源码部署后的启动、双向接续和服务重启恢复已实测；仍须使用 `codexc desktop-app open` 注入单次启动环境 |

自动化真实 App Server 合同只能证明两个普通 App Server Client 通过桥共享 Thread，不能模拟打包
Desktop 创建的私有工具 Pipe、代码签名校验或内置 MCP 生命周期。后续验收必须把这部分列为独立
实机门槛，不能再用双 Client 合同替代。

## 平台实现

### macOS

- Desktop 探测限定正式 `ChatGPT.app`，读取 Bundle 版本和资源内兼容入口，不修改签名内容。
- App Server 上游继续使用现有 WebSocket-over-UDS。
- `open --env` 改为同时设置 `CODEX_APP_SERVER_FORCE_CLI=1` 和受管 `CODEX_CLI_PATH`。受管入口把
  Desktop 的 JSONL stdio 逐条转换为 WebSocket 文本帧并连接现有私有 UDS，同时把动态工具 Pipe
  通过当前用户私有 Supervisor
  连接交给服务；Desktop 提供的内置插件布尔启用值原样受控应用到共享主实例。该平台不启动回环
  桥，不创建桥令牌，也不解析 JSON-RPC 业务消息。
- 用户从 Dock 直接重新启动时不会经过受管入口，可能回到 Desktop 私有 App Server；`status` 必须
  显示环境未受管，文档继续要求通过 `codexc desktop-app open` 启动。

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
而自动启用；配置中启用 `[codex.desktop_app]` 时 App Server 服务明确拒绝启动，不静默忽略该配置。
若官方 Desktop 后续支持 Linux，必须重新完成兼容探测和真实验收。

## 实现落点

- `runtime/desktop-app-bridge.mjs` 与声明文件：令牌文件、回环 WebSocket Server、认证、每连接
  Transport、帧转发、租约与关闭，以及 macOS Desktop JSONL stdio 到私有 Unix WebSocket 的消息
  边界转换。
- `runtime/app-server-service-runtime.mjs`：macOS 装配受管 Host，Windows 在配置启用且主 Provider
  为 OpenAI 时装配桥，并纳入 App Server 服务关闭顺序。
- `runtime/gateway-config.mjs` 与声明文件：严格 `[codex.desktop_app]` Schema 和安全默认值。
- `scripts/desktop-app-command.mjs` 与声明文件：平台化兼容探测、配置事务、服务控制、状态与单次环境
  启动；macOS 不读取桥令牌或探测桥端口。
- `scripts/desktop-app-proxy.mjs`：macOS Desktop 的受管 CLI 入口；只接受 App Server 启动调用，
  获取 Desktop Host 租约后在标准输入输出与主 App Server Unix WebSocket 之间转换文本消息，不
  解析 JSON-RPC 业务字段。
- `runtime/desktop-app-host.mjs` 与声明文件：校验 Desktop 动态 Pipe、签名 Node 和精确 Codex 原生
  可执行文件，并用签名 Node 托管主 App Server 子进程；动态 Pipe 状态只保存在服务内存中。
- `runtime/app-server-supervisor.mjs` 与声明文件：增加有界、独立能力版本化的 macOS Desktop Host
  租约，串行切换主 App Server 子进程并等待原私有 UDS 恢复就绪；租约阻止空闲释放，最后一个租约
  关闭后清除未来启动使用的临时附加状态。
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

### 阶段五：macOS 完整兼容修订

1. `desktop-app open` 在 macOS 使用受管 CLI 入口，不再让 Desktop 直接把本机 App Server 的
   `CODEX_APP_TOOLS_PIPE_PATH` 丢在外部共享连接之外；Windows 启动路径本轮不改。
2. 受管入口只从 Desktop 继承当前启动生成的 Pipe 与随包资源路径，通过现有私有 Supervisor Socket
   建立租约。请求必须限定当前用户、主 Provider `openai`、已启用配置、类型为 Socket 且同属当前
   用户的 Unix 路径，以及正式 ChatGPT Bundle 内固定的签名 Node；不接受任意监听地址或远端路径。
3. App Server 服务解析项目当前使用的 Codex CLI 原生可执行文件，要求版本为 0.155.1，并验证
   Codex 与托管 Node 都属于 OpenAI Team。主 App Server 的参数、Provider 代理、指标环境、工作目录
   和私有 UDS 均保持原样，只把直接父进程替换为签名 Node。
4. 首次收到新 Pipe 时，Supervisor 串行终止并重启主 App Server 子进程，等待同一 UDS 恢复后才
   向 Desktop 入口返回成功。相同 Pipe 的重连不得重复重启；不同 Pipe 代表新的 Desktop 启动，必须
   完成一次明确切换。切换期间 Gateway、Desktop 与 `codexc remote` 依赖现有重连逻辑恢复。
5. 动态 Pipe、Bundle 资源路径和附加状态不落盘，不写入用户 Codex 配置、Gateway 配置或 StateStore。
   App Server 服务重启后先按普通模式就绪；Desktop 检测到 stdio Proxy 退出后重新启动受管入口，
   由同一 Pipe 重新附加并切换可信托管。该重连行为必须通过真实 Desktop 验收，不能只靠进程模型
   推断。
6. Desktop 入口退出时释放 Supervisor 租约并终止自己持有的 Proxy 子进程，不结束共享 App Server。
   Pipe 失效后的下一次 `open` 必须用新 Pipe 重新附加，不能复用旧路径或静默启动 Desktop 私有
   App Server。
   首次附加和 Pipe 切换会短暂重启主 App Server 子进程；`desktop-app open` 必须先检查主实例租约与
   全部已加载 Thread 的活动状态，状态不空闲或无法确认时失败关闭，且不能把切换伪装成无中断操作。
7. 先运行现有类型、Lint、文档、服务与真实 App Server 合同，再在 ChatGPT `26.908.70816` 上实机
   验证 Thread 双向共享、`codex_app` 工具目录、App Server 服务重启恢复、Desktop 完全退出后重开
   和禁用回滚。Windows 保持原预览状态，本阶段不据 macOS 结果改变其支持结论。

## 验收标准

功能只有同时满足以下条件才算完成：

1. 未启用时无 TCP 监听、无 Desktop 环境修改，现有 Gateway、TUI、Provider 与指标行为不变；
   macOS 启用后同样不新增 TCP 监听。
2. 非法路径、缺失或错误令牌、第五个并发连接、二进制帧和非 OpenAI 主 Provider均失败关闭。
3. Desktop 与渠道能够双向发现并继续对方创建的空闲 Thread，且看到同一 Thread ID 与 Turn 结果。
4. 活动 Thread 不发生双写；审批仍由发起 Turn 的客户端处理。
5. Provider 指标、主实例监管、空闲释放、`codexc remote` 和 Gateway 重启恢复合同保持通过。
6. 服务停止、macOS Host 租约关闭、桥连接断开和 Windows Proxy 退出后没有遗留监听、租约或子进程；
   失效 Pipe 不得用于后续主实例启动。
7. 日志、状态、错误、JSON、配置与平台消息中均不出现桥令牌或完整 URL。
8. macOS 与 Windows 各自在真实 Desktop 上通过；任一平台未通过时必须单独标为预览或不支持，
   不能宣称全平台完成。
9. Desktop 随包提供的 `codex_app` MCP 在共享模式下保持可用；`bridgeReady`、Thread 双向共享或
   自动化双 Client 合同均不能替代该项实机验证。
10. macOS 受管路径必须继续使用项目锁定的 Codex CLI 0.155.1；不得以 Desktop 随包的预发布 CLI
    替换协议事实来源，也不得让动态 Pipe、完整启动环境或工具消息进入日志与状态输出。

## 失败与回滚

- Desktop 兼容入口缺失、进程正在运行、主 Provider 非 OpenAI、macOS Host 能力不匹配，或 Windows
  端口占用、令牌文件不安全、桥无法连接私有 UDS 时，拒绝相应操作并保留原状态。
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
   App Server 无法在保持锁定 CLI、Provider 代理、指标、Supervisor 和私有 UDS 的同时使用内置
   工具。

原第 7 项阻碍已被隔离实测解除：可信托管不改变 App Server 所有权或协议版本，且无需 Pipe Relay、
签名绕过和应用包修改。若正式用户路径不能复现同一签名链、需要 Desktop 预发布 CLI，或服务重启后
不能恢复，则重新触发该停止条件并保留当前会话共享预览。

## 下一阶段决策边界

完整双向兼容采用以下已经验证的 macOS 路径，不在现有 JSON-RPC 回环桥中注入私有工具语义：

1. App Server 仍由本项目服务和 Supervisor 所有，只把主子进程的直接父进程换成 Desktop 随包的
   OpenAI 签名 Node；Desktop 通过受管 stdio Proxy 连接原私有 UDS，并以私有租约交付动态 Pipe。
2. 等待 OpenAI 提供受支持的外部 App Server 工具 Pipe 交接或等价公开接口；在此之前不推断私有
   变量的兼容承诺。
3. 保留当前预览作为明确的“会话共享模式”，接受该模式不提供内置 `codex_app` MCP；不得在状态、
   README 或发布说明中称为完整 Desktop 兼容。

第 1 项的隔离验证已经成立，阶段五按该边界实施。第 2、3 项仍是停止条件触发后的回退选择，不与
可信托管并行建立第二套会话或工具状态。
