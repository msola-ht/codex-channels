# Codex Desktop App 共享 App Server

## 当前结论

目标不是接入 Codex Remote Control，也不是让手机或另一台设备通过配对码控制本机。目标是让同一
台电脑上的 Codex Desktop App 与 `codex-channels` 同时连接本项目监管的同一个 App Server。
默认连接主 OpenAI 实例；切换模式可在启动时指定已配置的 Provider 隔离实例，使 Desktop、渠道和
`codexc remote` 共享该实例的 Thread、Turn、Item 与实时通知。
主 Provider 为 OpenAI 且 DS/CLP 均有切换账户时，还派生按需启动的虚拟 Provider
`codexc-aggregate`，把全部 DS/CLP 切换账户模型提供给同一个 Desktop 模型选择器。

当前锁定的 Codex CLI 0.160.1 已支持多客户端连接同一 App Server；Codex Desktop App 当前构建还
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
并只重启选中的 App Server 子进程以切换可信父进程链。

实现保留现有 App Server 服务、Provider 代理、指标采集、私有 UDS、Supervisor 和
`codexc remote` 架构。macOS Desktop 的 JSONL stdio 连接由受管 Proxy 转换为 WebSocket 文本帧，
再连接现有私有 UDS；Windows
在选中的 App Server 前使用仅监听回环地址、带随机令牌的 WebSocket 桥。两条路径都不解析
JSON-RPC 业务方法，不维护 Thread 索引，不读取 Codex 会话文件。

## 实现与验收状态

- macOS 已验收，操作者于 2026-10-07 确认；使用受管 stdio Proxy、私有 Supervisor Host 租约、签名校验与主实例串行切换。
- Windows 使用当前用户包探测、受认证回环桥与隔离启动环境，仍为开发预览，未完成实机双向验收。
- 启动时选择 Provider 隔离实例是新增能力，尚未完成 macOS 或 Windows 实机验收；下述主 OpenAI
  实例的历史验收不覆盖第三方模型目录、会话继续或内置工具兼容性。
- DS/CLP 聚合模式复用同一个受监管 App Server 与工具 Host；聚合 Thread 的跨模型历史兼容及
  Desktop 内置工具尚未完成实机观察。现有主实例验收不覆盖此路径。
- Linux 隔离观察使用真实 CLI 0.160.1、聚合 HTTP 出口、原 ProviderProxy 和 CLP Chat 桥，
  上游为本地可控服务而非真实账户。同一 Thread 完成 DS→CLP→DS，后续请求保留前轮历史，
  两家均完成 `pwd` 工具调用及结果回程，指标保留 Thread/Turn 和实际账户。
  设置不同目录窗口后，三轮实际有效窗口依次为 996147、124518、996147；服务入口另完成
  按需启动、私有 UDS 的 `config/read` / `model/list`、持租约拒绝释放及关租约后释放。
  这些观察不代表真实 DS/CLP 响应兼容性或 macOS/Windows Desktop UI 已完成验收。
- 本次 Linux 隔离观察使用真实 0.160.1 App Server，完成回环桥 → Supervisor 租约 →
  `initialize` / `config/read`：缺省目标持有 OpenAI 租约，显式 `demo` 读取到 `model_provider=demo`
  并只持有该实例租约；持租约时释放被拒绝，断开后租约清空。未知目标返回 HTTP 400，重复目标、
  未知参数和错误令牌返回 HTTP 401。未调用模型；该观察不覆盖 Windows Transport 或桌面 UI。
- 冷启动修复的隔离观察在目标启动前加入 3.4 秒受控等待：约 3.65 秒后进入桌面启动边界，
  经真实桥完成 0.160.1 `initialize` / `config/read` 并读到 `model_provider=demo`。
  桌面连接关闭但启动回调未返回时临时租约仍保护目标；命令成功、受控桌面启动失败和桥不可用后
  租约均清空。该观察替代了 Windows 桌面启动边界，不代表 Windows App 或 Windows Proxy 已实测。
- 2026-09-16/17 的 macOS 历史实测覆盖 Thread 双向共享、内置工具启动与 App Server 重启恢复；
  实测 CLI 为 0.154.0、ChatGPT 为 `26.908.70816`。这些结果不是当前 CLI 0.160.1 或任意新 App 构建的验收。
- 本次操作者确认未附新的 CLI 与 Desktop 构建号，保留已有版本记录，不据此声明特定新版本组合已重测。
  Windows 尚未验收；平台验收结论分别记录，不宣称全平台正式支持。


## 事实基线

### 官方锁定版本

- 项目固定 `codex-cli 0.160.1`，协议与实现仍以 [`Codex 协议索引`](index.md)和
  `upstream/openai-codex-0.160.1` 的 `rust-v0.160.1` 锁定源码为准。下文 0.154.0 的实机结果是历史验收，
  不代表 0.160.1 已完成打包 Desktop 私有工具 Pipe 与签名链的实机复核。
- 官方远程客户端以 WebSocket 连接 App Server；每个连接独立执行一次
  `initialize` / `initialized`。
- Unix 客户端可以直接通过 WebSocket-over-UDS 连接。官方
  `codex app-server proxy --sock <path>` 只是 stdio 与 UDS 之间的裸字节中继；Windows
  `WindowsProxyTransport` 在该中继之上建立 WebSocket。Desktop 的 JSONL stdio 不能直接送入这个
  裸中继。
- 官方 `app-server daemon` 是实验性生命周期工具，会自行选择二进制、环境、控制 Socket 与更新
  方式。它不能代替本项目现有的 Provider 代理、指标采集和 Supervisor，因此本轮不采用。
- 锁定源码 [`core/src/session/step_settings.rs`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/session/step_settings.rs)
  的 `apply_update` 在模型改变时重新解析 `ModelInfo`，构成同 Provider 目录内换模型采用模型元数据
  的实现依据；[`model-provider/src/provider.rs`](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/model-provider/src/provider.rs)
  对自定义目录使用 `StaticModelsManager`，不能据此承诺运行中目录热刷新。这些源码依据不替代
  Desktop 跨模型历史与工具的实机验收。

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
  Server。实施只能继续运行项目解析出的精确 Codex CLI 0.160.1 原生可执行文件；Desktop 随包内容
  只提供同一 OpenAI Team 签名的 Node 托管进程和 MCP 资源。
- 这些变量没有公开稳定文档。支持结论只能按经过真实验收的 Desktop 版本与平台记录，不能把
  “安装包中存在字符串”解释为完成兼容。
- 两个公开开源实现都通过 `Get-AppxPackage -Name OpenAI.Codex` 定位 Windows 当前用户包，并直接
  创建包内 `ChatGPT.exe` / `Codex.exe` 子进程、注入仅属于该子进程的环境。这为本项目提供了实现
  依据，但不替代本项目在 Windows 上的真实 Desktop 验收。

## 目标与非目标

### 目标

1. Desktop、Gateway 与 `codexc remote` 共享选中 Provider App Server 的 Thread 和实时状态。
2. Desktop 新建或继续的空闲 Thread 可被渠道发现和继续；渠道新建或继续的 Thread 可在 Desktop
   中读取和继续。
3. macOS 与 Windows 使用相同的命令语义并连接选中的 App Server；macOS 使用受管 stdio/UDS，
   Windows 使用受认证回环桥，平台连接边界保持明确分离。
4. 保留现有 Provider 代理、凭据隔离、上游指标、Supervisor、私有 UDS 与服务生命周期。
5. App Server 服务重启时关闭当前 Desktop 连接；Desktop 通过自身重连或重新打开恢复，不产生
   第二套会话状态。
6. 完整兼容验收不能让 Desktop 随包提供的内置 MCP 从可用退化为失败；会话共享与 Desktop 工具
   等价性必须分别验证和报告。

### 非目标

- 不接入 Remote Control、移动端、二维码、配对码或云端 Environment。
- 不支持第三方主 Provider；主 Provider 仍必须为 `openai`，第三方通过切换模式的已配置账户实例
  或 DS/CLP 聚合实例连接。
- 聚合范围只包含 DS/CLP 切换账户，不合并 OpenAI、其他 Provider 或独立 Relay 目录。
  更换 App Server 实例必须完全退出 Desktop，再用 `codexc app --provider <ID>` 启动；
  聚合实例内已加载模型间切换无需退出。
- 不复制 Desktop UI，不让渠道模拟 Desktop 的审批界面，不跨连接转发审批决定。
- 不支持两端同时向同一活动 Thread 写入。App Server 的活动状态仍是唯一依据；发现活动 Turn 时
  另一端只能观察、排队或等待完成。
- 不读取、修改或迁移 `~/.codex/sessions`、SQLite 会话库或 Desktop 私有文件。
- 不承诺 Desktop 的未公开环境变量长期存在；版本不兼容时不回退到私有 stdio App Server。

## 架构与数据流

```text
macOS Desktop ─ JSONL stdio ─ 受管 Proxy ─ WebSocket/UDS ─┐
                                                          ├─ 选中 Provider App Server
Windows Desktop ─ token WebSocket ─ 回环桥 ─ UDS ─────────┘          ▲
                                                              │
                                                Gateway / codexc remote
```

macOS Proxy 和 Windows 桥都不终止 JSON-RPC 语义，Desktop 自己发送 `initialize`；它们不能替
Desktop 生成、删除、重写或缓存业务消息。macOS Proxy 只在 JSONL 行与 WebSocket 文本帧之间保留
一一对应的消息边界；Windows 桥只转发文本帧，二进制帧以 WebSocket `1003` 关闭，单帧上限为
128 MiB。

两个平台的每个转发方向最多保留 128 条、合计 128 MiB 的消息，包含正在发送的消息；macOS 未完成的 JSONL 行也限制为 128 MiB。单次发送等待最多 5 秒，容量或超时失败明确终止当前连接，不丢弃消息后继续会话、不自动重放写请求。Windows 桥以 `1013` 通知转发不可用并释放 Transport 与租约；macOS Proxy 返回失败并清理输入监听。恢复连接仍由 Desktop 或操作者处理。

Windows 桥在连接期间持有选中 Provider 租约；macOS 带内置工具插件配置的连接持有 Desktop Host
租约。这些租约存在时，空闲释放不能终止目标实例。macOS 未携带插件配置的普通连接直接代理到
目标实例，不持有长期租约，也不阻止空闲释放；`codexc app` 的启动预检
会先通过临时租约恢复实例，并在打开 Desktop 前释放该租约。显式关闭插件的 `false` 配置仍走
Host 租约路径。macOS 最后一个 Host 租约关闭时只清除服务内存中的临时 Pipe 附加状态，不终止
共享实例；Windows 桥连接关闭时释放上游 Transport 与租约。App Server 服务关闭时停止接受
新连接并有限等待现有生命周期操作。

桌面退出不会清除已运行子进程的启动环境。旧实例会保留原 Host/Pipe 直到正常空闲释放或后续
受控重启，切到另一实例也不强制中断旧实例任务；不能据租约释放宣称旧实例内置工具仍可用。
后续重新启动该实例时不会复用已清除的临时附加状态。

macOS Host 附加串行处理全局 Desktop 目标和目标 Provider 的生命周期，恢复已释放的受管实例，再查询权威活动状态，
切换前重查普通租约与请求取消；发现外来实例、活动任务或租约占用时拒绝接管。该检查不构成对
所有外部客户端启动 Turn 的原子锁。可信 Host 与原生 Codex 使用专属进程组，退出超时后的强制
终止覆盖该组，不影响其他服务。签名校验实际验证签名有效性、可信锚与 OpenAI 身份；Proxy
连接前复用统一私有 Socket 校验，并连接经验证的物理目标。

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

Windows 使用独立的私有凭据文件，不改变 StateStore、指标库或计划任务数据库 Schema。
本次 Provider 选择不持久化只描述 `codexc app` 启动行为。各实例仍使用共享 Codex Home；
Desktop 经上游配置 RPC 保存设置时可能写入共享用户配置，而非 Provider 私有 Profile，须纳入实机验收。

### DS/CLP 聚合模型目录

聚合拓扑由 OpenAI 主 Provider 与当前 DS/CLP 切换账户派生，不增加账户或 TOML 配置字段。
`desktop_app.enabled` 仍控制 Desktop 共享；首次选择聚合时沿用既有启用确认流程。服务启动时
不启动聚合 App Server，选择 `codexc-aggregate` 后复用现有 Supervisor、私有 UDS 和 macOS
Host 生命周期按需启动一个实例。
普通会话清理通过官方跨 Provider 列表发现历史，遇到聚合会话后才连接聚合实例；聚合配置
不满足启动条件时明确跳过对应会话组，不让未使用聚合的普通清理在扫描前失败。
Remote 通过 `--provider codexc-aggregate` 取得实例租约，不能同时指定 Profile；启动时从该实例
读取默认模型与思考等级。渠道模型目录注册同一个 Provider，聚合内部切换保留 Thread，
持久化绑定恢复仍按该 Provider 路由。聚合纳入 Gateway 账户空闲回收，活动与租约阻止提前释放；
退出 Desktop 不承诺立即停止实例。聚合没有单一账户额度，账户查询明确不支持且不写虚拟快照；
模型请求指标保留实际 DS/CLP 账户，不重复生成聚合 Provider 错误样本。

聚合从各账户受管目录保留模型能力、上下文、压缩阈值、提示词与思考设置，显示名加
`Provider ID · 模型名称`，精确 slug 使用 `<Provider ID>/<原模型 slug>`。例如：

- `ds-main/deepseek-flash`
- `clp-main/cline-pass/deepseek-v4.1-flash`

目录包含当前全部 DS/CLP 切换账户，账户内模型不另造别名。聚合 HTTP 代理按精确 slug 白名单
还原原模型 ID，路由至原 ProviderProxy；CLP 继续通过现有 Chat 桥转换。每次请求用目标账户
真实 Key 替换本地随机认证令牌，不维护对话历史。聚合关闭模型 API WebSocket、网页搜索及
自动重试；审批 reviewer 使用 `user`，Remote 拒绝显式 `auto_review`；独立 Relay 不接入聚合路由。

唯一新增磁盘材料为 `<dataDir>/runtime/aggregate-models.json`，它是无密钥、可重建的派生目录；
账户注册表、私有 Profile、Gateway TOML 和数据库格式均不变。目录在实例启动时加载，账户、
Key 或模型设置变化后，快照校验拒绝后续出站请求并要求重启 App Server 服务，不热刷新列表。
每请求的私有文件与 ACL 复核由有界工作线程执行，共享目录去重；等待支持取消与 15 秒截止时间。
首包和空闲预算分别为 DS 65 秒、CLP 310 秒，响应总预算独立为 600 秒。
安装新代码后的旧服务也须按常规重启才能加载聚合能力。

为避免全局设置压平模型窗口，聚合启动拒绝 Codex 主 `config.toml` 顶层的
`model_context_window` 和 `model_auto_compact_token_limit`。项目级同名配置仍可能覆盖模型目录值，
使用前须检查。该边界不表示所有层级的上游配置覆盖均已由聚合实例消除。

## Windows 回环桥安全边界

1. HTTP Server 只绑定 `127.0.0.1`，只接受精确路径 `/codex-app-server` 的 WebSocket Upgrade。
2. Upgrade 必须携带精确查询参数 `token`；使用恒定时间比较验证。可选 `provider` 只能选择已配置
   的实例，缺省为主实例。重复或未知参数、无效令牌或未配置 Provider 均拒绝，不进入 App Server。
3. 不接受 HTTP 业务请求、CORS、浏览器 Cookie、代理转发头、子协议或远端绑定。
4. 日志只记录启动、关闭、连接数量、平台和稳定错误类别，不记录 URL、请求头、帧内容或令牌。
5. 每个方向串行发送，保持单连接消息顺序；任一方向错误或关闭时关闭另一方向并释放全部资源。
6. 并发连接数限制为 4。超过上限时在握手前拒绝；该值是固定的本机资源边界，不作为用户配置。
7. 服务关闭等待上限沿用现有 5 秒生命周期；超时后终止桥接 Socket 与 Windows Proxy 子进程。

## Desktop 连接与命令

公开命令 `codexc app`，日常统一使用 `codexc app`，所有层级支持 `-h` / `--help`：

```text
codexc app [--provider <Provider ID>]
codexc app enable [--port <1-65535>]
codexc app disable
codexc app status [--provider <Provider ID>] [--json]
```

### `enable`

1. 验证原始配置的当前版本与 Schema，再检查平台为 macOS 或 Windows、主 Provider 为 `openai`、Desktop 已安装且当前未运行。
2. macOS 检查强制 CLI、CLI 路径、工具 Pipe 和内置插件配置标记；Windows 检查 WebSocket 入口。
3. Windows 创建或验证私有桥令牌；macOS 不创建令牌。原子写入 `[codex.desktop_app]` 并保留其余
   TOML 注释和字段。
4. 不写当前用户或系统级持久环境；平台连接参数只由 `codexc app` 注入本次 Desktop 子进程。
5. 重启 App Server 服务；Windows 先通过临时主 Provider 租约等待实例就绪，再检查桥连接并释放
   临时租约；macOS 只依赖 Supervisor 和私有 UDS。
6. 任一步失败时按修改前快照恢复配置；令牌文件可保留。

### `disable`

1. 验证原始配置，并要求 Desktop 已关闭；资源读取失败不代表进程已退出，无法确认运行状态时拒绝操作。
2. 移除整个 `[codex.desktop_app]` 子表并重启 App Server 服务；Windows 同时关闭桥。
3. 不修改当前用户或系统级环境，不删除 Thread、配置文件、令牌文件或 App Server Socket。

### `status`

只读报告以下结构化事实：平台是否支持、Desktop 是否安装和运行、兼容入口是否存在、配置是否启用、
主 Provider 是否为 OpenAI、App Server 服务状态，以及下一步动作。macOS 另报告受管 Host 协议
能力与当前租约状态，另以 `primaryInstanceState` 报告主实例 `running`、`released` 或 `unknown`，
`provider` / `providerInstanceState` 报告指定目标，`desktopAppProvider` 报告当前 macOS Host 租约所属实例。
不通过查询唤醒实例；`running` 字段仍表示 Desktop 进程。Windows 状态不建立桥连接，避免获取租约
时恢复实例；共享已启用且令牌可读取时 `bridgeReady` 为 `null`，表示未探测，启动命令才实际检查桥连接。两个平台都只报告采用单次启动环境，不尝试
读取运行中 Desktop 的进程环境。只有 Windows JSON 输出不带查询参数的回环 URL。

### `codexc app`

- `--provider` 接受切换模式下配置的精确 Provider ID（包含账户隔离 ID），以及主 OpenAI 且
  DS/CLP 均有切换账户时派生的 `codexc-aggregate`，缺省连接主 OpenAI。
  参数仅对本次启动生效，不写入 TOML、Desktop 配置或系统环境；普通模型名称和任意 Socket 路径均不接受。
  选择其他实例不重启整个服务，macOS 需要替换子进程时只处理目标实例。
  旧服务不支持 Provider 选择能力时拒绝启动并提示重启服务，不静默连接主实例。
- 尚未启用时，在本机交互终端提示启用共享会重启 App Server、可能中断连接与任务，默认拒绝。
  确认后复用 `enable` 的配置、就绪检查与失败回滚流程，然后启动 App；取消则不修改配置或服务。
  非交互调用必须先显式执行 `enable`。已启用时直接进入启动检查，不重复启用或重启服务。
- 启用成功后若启动检查或 App 启动失败，保留已生效的共享配置，排除问题后可再次执行 `codexc app`。
- 先验证原始配置，再进行平台兼容探测和服务检查；不能通过覆盖 Desktop 子表来接受未知字段或不支持的配置版本。
- Desktop 已运行时拒绝，提示先完全退出；不强制结束用户进程。
- macOS 在启动前先拒绝仍由 `codexc remote` 持有的目标实例租约，再获取临时 Provider 租约，
  按需恢复空闲释放的目标实例，并防止预检期间再次释放；通过官方 `thread/loaded/list`
  分页枚举全部已加载的持久及临时 Thread，并逐项使用 `thread/read` 读取状态；
  存在活动 Thread 或无法完成只读检查时拒绝启动，不进入
  会短暂替换目标 App Server 子进程的 Pipe 附加阶段。所有路径都关闭临时租约，且必须在打开 Desktop
  之前完成，以免阻止后续 Host 附加。Windows 不执行该检查，因为其桥接不替换子进程。
- macOS 使用 `/usr/bin/open --env CODEX_APP_SERVER_FORCE_CLI=1 --env CODEX_CLI_PATH=<受管入口>
  -a ChatGPT` 启动，并传入随包资源、签名 Node 路径和 `CODEX_CONNECT_DESKTOP_PROVIDER`。受管入口只接受 Desktop 实际提供的工具 Pipe
  和内置插件布尔启用值；不使用 `launchctl setenv`，也不连接回环桥。
- Windows 通过 PowerShell 7 查询当前用户 `OpenAI.Codex` 包，限定包内已验证的
  `app\ChatGPT.exe` 或 `app\Codex.exe`，然后使用直接子进程创建且只修改子进程环境副本；不把
  私有 URL 放入命令行，不委托给已运行的 Explorer，也不写注册表级用户环境。
- Windows 启动前先获取目标 Provider 的临时租约，按 Supervisor 的有界等待恢复实例，随后才
  检查桥并启动桌面；临时租约覆盖该过程，成功或失败后均释放。桥自身的连接租约独立持有。
  桥探测外层等待为 30 秒，覆盖内部最长 15 秒的租约获取及 10 秒的 Windows Proxy 连接阶段，
  不再用 3 秒探测截断正常启动。实例启动失败与桥连接失败分别报告，不自动重启整套服务。
- Windows 实机合同未证明包内可执行文件可靠继承环境并保持运行前，不把该平台标为正式支持，也
  不要求注销或重启系统作为成功条件。

## Thread、Turn 与审批语义

- App Server 仍是唯一事实来源。Desktop、Gateway 和 TUI 各自建立连接并独立订阅 Thread。
- 连接期间目标 Socket 固定，模型目录来自目标 App Server，不拼接其他实例的模型；本项目不复制
  历史、不重写 Thread 的 Provider。Socket 选择不是 RPC 层的 Provider 强制隔离：锁定上游允许
  `thread/list` 显式请求多个 Provider，`thread/resume` 也可能沿用历史的 Provider。Desktop
  是否会从缓存恢复其他 Provider 的 Thread、传入模型覆盖，以及第三方是否能使用内置工具，均须实机确认。
  使用时应在目标实例新建会话，不以连接参数推断历史会话已转换 Provider。
- 聚合实例的目录由 DS/CLP 账户目录派生，在上游仍归属同一个 `codexc-aggregate` Provider。
  旧单账户 Thread 不迁移，必须新建聚合 Thread 再用；目录内模型切换的实现依据不证明历史中的
  reasoning 或工具内容跨模型兼容，尚无该路径及聚合 Desktop 内置工具的实机验收。
- Desktop 创建、恢复、归档、改名或更新 Thread 后，Gateway 只根据官方通知和后续
  `thread/list` / `thread/read` 观察结果，不从桥连接事件推断业务状态。
- 渠道自动接续仍执行现有来源、Workspace、活动状态和绑定独占检查；桥不绕过这些检查。
- 同一 Thread 的活动 Turn 不能被第二端无条件追加新 Turn。普通渠道补充输入通过 `turn/steer` 进入活动 Turn，显式 `/queue` 才进入 App Server Queue；
  Desktop 如何呈现 Queue 由官方客户端决定。
- Server Request 由产生请求的 App Server 连接处理。Desktop 发起 Turn 的命令、文件、权限、用户
  输入或 MCP 请求留在 Desktop；Gateway 发起 Turn 的请求仍走现有渠道审批。桥不广播、不转移、
  不代答审批。
- 一个客户端解决请求后，其他客户端只根据官方通知更新状态；桥不构造跨客户端失效事件。

## macOS 实机验收记录

2026-09-16 至 2026-09-17 使用 ChatGPT `26.908.70816` 与 Codex CLI `0.154.0` 验证。
表内命令按当前 `app` 名称描述对应操作，不表示当时已验证当前命令解析或当前 CLI 基线：

| 项目 | 结果 | 结论 |
| --- | --- | --- |
| `app`、`app enable/status` | 通过 | 配置、令牌、桥、单次启动环境和服务重启主路径可用 |
| Desktop 与渠道双向发现并继续 Thread | 通过 | 两端连接同一主 OpenAI App Server |
| App Server 重启后的 Desktop 恢复 | 通过 | 重启期间渠道收到断线提示，主实例就绪后自动重连并继续双向接续 |
| Desktop 内置 `codex_app` MCP | 通过 | 签名 Host 隔离探针返回 38 个工具；修复后的受管启动不再出现 Pipe 缺失、`tools/list` 超时或启动卡住 |
| 签名 Host 隔离合同 | 通过 | 受管 stdio Proxy 连接同一 UDS，`codex_app` 0.1.0 返回 38 个工具且无错误 |
| 完整 macOS Desktop 受管入口 | 通过 | 源码部署后的启动、双向接续和服务重启恢复已实测；仍须使用 `codexc app` 注入单次启动环境 |

打包 Desktop 创建的私有工具 Pipe、代码签名校验和内置 MCP 生命周期需作为独立实机门槛验收。

## 平台实现

### macOS

- Desktop 探测限定正式 `ChatGPT.app`，读取 Bundle 版本和资源内兼容入口，不修改签名内容。
- App Server 上游继续使用现有 WebSocket-over-UDS。
- `open --env` 改为同时设置 `CODEX_APP_SERVER_FORCE_CLI=1` 和受管 `CODEX_CLI_PATH`。受管入口把
  Desktop 的 JSONL stdio 逐条转换为 WebSocket 文本帧并连接现有私有 UDS，同时把动态工具 Pipe
  通过当前用户私有 Supervisor
  连接交给服务；Desktop 提供的内置插件布尔启用值原样受控应用到目标实例。该平台不启动回环
  桥，不创建桥令牌，也不解析 JSON-RPC 业务消息。
- 用户从 Dock 直接重新启动时不会经过受管入口，可能回到 Desktop 私有 App Server；`status` 的 `toolHostAttached` 仅报告当前工具 Host 租约，不能证明任意 Desktop 进程的环境；需通过 `codexc app` 启动。

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
- `runtime/aggregate-model-provider.mjs`：派生 DS/CLP 聚合成员、目录与启动参数，拒绝全局窗口覆盖，
  对账户和模型材料做快照复核，只写无密钥的运行时目录。
- `runtime/aggregate-material-guard.mjs`：在有界工作线程中复核私有材料与 ACL，取消、截止时间及关闭由服务持有。
- `src/provider-proxy/aggregate-proxy.ts`：对精确聚合模型 ID 执行本地认证、白名单 HTTP 路由和账户
  Key 替换，复用原 ProviderProxy 与 CLP Chat 桥，不承载 App Server RPC 或历史。
- `runtime/gateway-config.mjs` 与声明文件：严格 `[codex.desktop_app]` Schema 和安全默认值。
- `scripts/desktop-app-command.mjs` 与声明文件：平台化兼容探测、配置事务、服务控制、状态与单次环境
  启动；macOS 不读取桥令牌或探测桥端口。
- `scripts/desktop-app-proxy.mjs`：macOS Desktop 的受管 CLI 入口；只接受 App Server 启动调用，
  校验本次启动的 Provider，无内置工具插件配置时连接目标实例，带配置时先获取 Desktop Host 租约；在标准输入输出
  与目标 App Server Unix WebSocket 之间转换文本消息，不解析 JSON-RPC 业务字段。
- `runtime/desktop-app-host.mjs` 与声明文件：校验 Desktop 动态 Pipe、签名 Node 和精确 Codex 原生
  可执行文件，并用签名 Node 托管目标 App Server 子进程；动态 Pipe 状态只保存在服务内存中。
- `runtime/app-server-supervisor.mjs` 与声明文件：增加有界、独立能力版本化的 macOS Desktop Host
  租约，串行切换目标 App Server 子进程并等待原私有 UDS 恢复就绪；租约阻止空闲释放，最后一个租约
  关闭后清除未来启动使用的临时附加状态。
- `scripts/windows-desktop-app-inspect.ps1`：只读查询当前用户安装包、固定包内可执行文件和同路径
  进程状态，不读取或修改其他用户与应用目录。
- `bin/codexc.mjs`：公开命令、帮助与路由。
- `runtime/README.md`、`scripts/README.md`、`bin/README.md`：新增文件与公开入口索引。
- `README.md` 与 `docs/user-guide.md`：只写用户操作、当前限制和排障，不复制内部桥协议。
- `docs/index.md`：记录共享 App Server 行为、官方基线与实现映射。
- `docs/windows-support-development.md`：记录受认证桥不替换固定 UDS Transport，以及 Windows 实机
  验收状态。

## macOS 工具 Host 生命周期

Supervisor 只接受当前用户、已配置的目标 Provider、已启用配置、同属当前用户的 Unix Socket Pipe，
以及正式 ChatGPT Bundle 内固定的 OpenAI 签名 Node。Codex 原生可执行文件须匹配项目锁定 CLI
版本并属于 OpenAI Team；这不是 Desktop App 版本白名单，App 通过实际入口和签名探测。

首次附加与不同 Pipe 的切换串行重启目标 App Server 子进程，等待原 UDS 恢复后才返回成功。
同一 Provider、同一 Pipe 重连不重复切换，另一个目标仍持有 Host 租约时拒绝附加。启动命令先检查目标实例租约和全部已加载 Thread，活动或状态未知时
失败关闭；切换会短暂断连，Gateway、Desktop 与终端依赖各自重连逻辑恢复。

动态 Pipe、Bundle 路径与附加状态只保存在进程内。服务重启先按普通模式就绪，Desktop 重新启动
受管入口后再附加。入口退出释放自己的租约与 Proxy 子进程，不终止共享 App Server；下一次启动
须使用有效新 Pipe。服务重启后的 Desktop 自动重连必须由对应版本的真实验收证明。


## 验收标准

功能只有同时满足以下条件才算完成：

1. 未启用时无 TCP 监听、无 Desktop 环境修改，现有 Gateway、TUI、Provider 与指标行为不变；
   macOS 启用后同样不新增 TCP 监听。
2. 非法路径、缺失或错误令牌、第五个并发连接、二进制帧和非 OpenAI 主 Provider均失败关闭。
3. Desktop 与渠道能够双向发现并继续对方创建的空闲 Thread，且看到同一 Thread ID 与 Turn 结果。
4. 活动 Thread 不发生双写；审批仍由发起 Turn 的客户端处理。
5. Provider 指标、主实例监管、空闲释放、`codexc remote` 和 Gateway 重启恢复按原有边界工作。
6. 服务停止、桥连接断开和 Windows Proxy 退出后清理其所属监听、租约和转发子进程；macOS Host
   租约关闭时保留仍运行的共享实例，按前述空闲释放策略管理。失效 Pipe 不得用于后续实例启动。
7. 日志、状态、错误、JSON、配置与平台消息中均不出现桥令牌或完整 URL。
8. macOS 与 Windows 各自在真实 Desktop 上通过；任一平台未通过时必须单独标为预览或不支持，
   不能宣称全平台完成。
9. Desktop 随包提供的 `codex_app` MCP 在共享模式下通过实机验证。
10. macOS 受管路径必须继续使用项目锁定的 Codex CLI 0.160.1；不得以 Desktop 随包的预发布 CLI
    替换协议事实来源，也不得让动态 Pipe、完整启动环境或工具消息进入日志与状态输出。

## 失败与回滚

- Desktop 兼容入口缺失、进程正在运行、主 Provider 非 OpenAI、macOS Host 能力不匹配，或 Windows
  端口占用、令牌文件不安全、桥无法连接私有 UDS 时，拒绝相应操作并保留原状态。
- 桥运行失败不回退到 Desktop 私有 App Server，不启动官方 daemon，不开放无认证端口。
- 禁用时恢复配置；没有持久环境需要清理，也不强制结束 Desktop。

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

## 私有入口变化时的处置

macOS 当前采用 OpenAI 签名 Node 托管选中 App Server、受管 stdio Proxy 交付动态 Pipe 的路径。
若官方私有入口或签名信任链发生变化，停止启用并等待明确的上游合同；不伪造签名、不修改应用包，
也不自动降级成缺失内置工具的“完整兼容”模式。Windows 仍须单独实机验收。
