# Windows 原生支持开发计划

本文记录 Codex Connect 在原生 Windows 上运行的事实边界、技术决策门槛、分阶段实现顺序和验收标准。
它是开发计划，不代表当前版本已经支持 Windows。公开支持范围仍以根目录 `README.md` 为准；在本文
全部发布门槛通过前，安装、Doctor 和文档必须继续明确拒绝或标记 Windows 未支持，不能以 npm 包能够
安装作为端到端可用的依据。

状态：进行中。已在 Windows 11 `10.0.22631`、Node.js `24.15.0` 与全局
`codex-cli 0.150.1` 上进入阶段四前台功能闭环；阶段一内部 IPC 安全验收和阶段三跨用户拒绝仍并行保留。
底层 UDS、官方 Proxy、原生 Remote TUI 与 Gateway 的 `WindowsProxyTransport` 已证明可以建立连接；平台端点
工厂也已接入主 Client 和 Provider Client 的组合根。Gateway Owner、App Server Supervisor 和
Provider Metrics 已收敛到共享私有 IPC 并通过 Windows 定向探针；后台服务、完整渠道/Provider 生命周期
和发布验证仍未完成。Windows 可执行文件与 npm shim 调用、精确持有 PID 的子进程树终止已经完成定向回归，配置与
共享私有文件的 SID/ACL 基础合同也已通过 tarball 冒烟；飞书用户 OAuth、微信 Bot、微信回复上下文和
第三方 Provider Key 已接入 DPAPI 主密钥保护；状态库、计划任务库、指标库、管理与 WebUI Token、媒体、
渠道输出和受管备份也已接入当前 SID 私有 ACL，Doctor 已能只读诊断该合同；真实 Remote TUI 已在普通
PowerShell PTY 中完成基础进入、显示与退出，交互式 Setup 主菜单也已完成显示和无修改取消。内部 IPC
完整安全验收、跨用户拒绝和业务闭环仍未完成，因此仍不能在 Windows 部署使用。`codexc start` 已能
在前台同时监管 App Server、统计代理与 Gateway，并在 `Ctrl+C` 后清理其进程树。

## 结论

Windows 支持不需要重写 Application、Conversation Core、Session Routing、Surface 或 SQLite 业务层，
但也不能只增加一个 PowerShell 安装脚本。当前阻断集中在平台运行时：App Server Transport、本地 IPC、
私有文件与凭据、可执行文件解析、进程树、后台服务、系统代理和交付验证。

锁定的 Codex 0.150.1 上游已经包含 Windows Unix Domain Socket 实现，原生 `codex --remote` 具备连接
该 Transport 的基础；本项目 Node Transport 仍按 POSIX Socket 文件类型、UID 和 mode 校验，不能直接
复用。上游另有回环 WebSocket 与 Capability Token，但官方仍将 WebSocket Transport 标为实验且不受
支持，不能在未经独立决策和真实合同验证时成为项目的正式 Windows 基线。

首选验证方向是保留上游 Windows UDS，并由官方 `codex app-server proxy --sock <PATH>` 为 Gateway
提供单连接字节桥接；原生 TUI 继续直接使用 `codex --remote unix://<PATH>`。如果固定版本的 Windows
Proxy 真实合同不成立，再评估受认证的回环 WebSocket。不能为了快速跑通而启动无认证 TCP App Server，
也不能退回每个渠道单独启动 stdio App Server，因为这会破坏共享 Thread、Provider 隔离实例和 Remote
TUI 的既有架构。

### 当前可用性判断

截至 2026-08-30，结论是“底层方案可行，项目尚不支持 Windows”，不能把当前分支作为可部署的
Windows 版本使用：

- 固定版 Codex App Server、官方 Proxy 与原生 Remote TUI 已在 Windows 建立真实连接，证明首选
  Transport 方向具备继续实现的基础。
- 当前 Gateway 在 Unix 保留 `UnixWebSocketTransport` 的 POSIX 安全检查，在 Windows 则通过
  `WindowsProxyTransport` 和官方 `app-server proxy --sock` 接入同一 UDS，不再对 Windows rendezvous
  执行不成立的 POSIX Socket 类型、UID 或 mode 判断。
- 独立的 `WindowsProxyTransport` 已通过构建产物和真实 App Server 合同，能够拥有官方 Proxy 子进程、
  完成初始化与只读 `thread/list`，并在客户端关闭后清理 Proxy；组合根已为主实例和 Provider 实例
  选择该实现；Supervisor、Gateway Owner 和 Provider Metrics 也已接入 Windows 私有 IPC，但完整安全
  验收尚未结束。
- Windows 上按仓库 `package-lock.json` 执行 `npm ci`、安装期 `prepare` 构建和
  `npm run check` 已通过。此前 pnpm 依赖树将飞书 SDK 的 Axios 解析为 1.20.0，触发 SDK
  `defaultHttpInstance` 与其 `HttpInstance` 的类型不兼容；npm 锁定树使用 Axios 1.18.1，不存在
  该错误。该差异是包管理器锁定结果，不是 Windows 或飞书 Surface 的平台限制。
- 经官方 Proxy 的 Ephemeral Thread 跨客户端读取、真实 Turn、一次命令审批和中断已通过；主实例与
  第二个 Provider App Server 的 Ephemeral Thread 隔离、可配置消息上限拒绝也已通过。原生 Remote TUI
  的基础进入、工作目录显示和正常退出已通过；Profile、会话、审批与渠道共享等同类交互、非提升私有
  SID 所有权以及 Gateway 生命周期仍未完成；生产 `WindowsProxyTransport`
  的默认 128 MiB 入站边界已由可控字节流夹具完成实测。剩余阶段一至阶段六门槛全部通过后，才能更新
  公开支持范围。
- Windows `PATHEXT`、`.cmd` / `.bat` npm shim、含空格路径及大小写不固定的环境变量键解析已通过定向
  测试；生产 Transport 通过 `PATH` 中的真实 `codex.cmd` 完成 App Server 合同，窄接口注入重构也已
  通过类型、Lint 和合同回归。tarball 安装冒烟现已完整通过；随后执行的干净源码安装仍因既有复制
  夹具用 `/` 分割 Windows 相对路径、遗漏整个 `scripts\` 目录而失败，属于尚未处理的 Windows CI 债务。

## 目标与非目标

### 目标

1. 原生 Windows 上可使用同一份 Gateway 配置完成 `init`、`setup`、`start`、`remote`、`doctor`、
   `service`、`update` 和卸载闭环。
2. Telegram、飞书和微信继续复用现有 Application/Core 与 Surface 行为，不建立 Windows 专属会话语义。
3. OpenAI、DeepSeek、OpenCode Go 和自定义第三方 Provider 继续使用相同的主实例、隔离实例、租约、
   指标代理和模型切换合同。
4. Windows 本地 IPC、凭据和私有文件达到与 Unix 当前用户隔离等价的安全结果；无法证明隔离时失败关闭。
5. 原生 `codex --remote` 与渠道客户端继续共享对应 App Server 的 Thread 和运行状态。
6. Windows 进入 CI、真实 App Server 合同、npm 安装冒烟、服务生命周期和发布验收，不依赖人工声称可用。

### 非目标

- 不把 WSL 当作原生 Windows 实现；WSL 可继续按 Linux 路径单独使用。
- 不在 Gateway 内复制 Codex Windows Sandbox、Workspace 权限或命令审批实现；这些仍由固定版本 App
  Server 提供，Gateway 只传递并验证既有协议设置。
- 不为了 Windows 重写业务 Store、会话状态机、消息渲染或 Provider 业务规则。
- 不在第一阶段同时提供 Windows Service 与 Task Scheduler 两套后台管理方式。
- 不用无认证回环端口、固定可猜测命名管道或仅依赖“同机访问”降低本地权限边界。
- 不为旧版 CLI 增加兼容分支；Windows 与其他平台使用项目锁定的同一精确 Codex CLI 版本。
- 不在真实 Windows 验证前修改 README 平台徽章、npm 发布声明或源码安装说明为“已支持”。

## 固定事实来源

- [`codex-cli 0.150.1 App Server README`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/README.md)：
  stdio、Unix Socket、实验 WebSocket 和 `app-server proxy` 的固定版本说明。
- [`codex-cli 0.150.1 UDS 实现`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/uds/src/lib.rs)：
  Unix 与 Windows 的跨平台 UDS 监听、连接和陈旧路径判断。
- [`codex-cli 0.150.1 WebSocket 认证`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-transport/src/transport/auth.rs)：
  Capability Token、签名 Bearer Token 和监听认证边界。
- [`docs/index.md`](index.md)：项目锁定协议、Transport 与真实 App Server 合同入口。
- [`src/codex-client/unix-websocket-transport.ts`](../src/codex-client/unix-websocket-transport.ts)：
  当前 Gateway 的 POSIX Unix WebSocket 连接与权限校验。
- [`runtime/app-server-runtime.mjs`](../runtime/app-server-runtime.mjs)、
  [`runtime/app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs)、
  [`runtime/gateway-owner.mjs`](../runtime/gateway-owner.mjs) 和
  [`src/provider-proxy/metrics-channel.ts`](../src/provider-proxy/metrics-channel.ts)：当前 App Server、监管、
  Gateway 所有权与 Provider 指标 IPC 链路。

项目内 `upstream/openai-codex` 必须保持在 `rust-v0.150.1` 对应提交
`90854393966b21e9ebfd21b122334eb09a20c93d`。实施期间不得以官方 `main` 的新行为替代固定版本合同；
若 Windows 所需能力只存在于后续正式版，应先走 Codex CLI 正式升级流程。

## 当前阻断清单

### App Server 与本地 IPC

- `codex.socket_path` 和所有 Provider 实例都被解析为 `.sock` 文件路径。
- Gateway 连接前要求父目录 mode、UID 和 `Stats.isSocket()` 满足 POSIX 条件。
- App Server Supervisor、Gateway 单实例所有权和 Provider 指标通道同样依赖 Unix Socket、inode、UID
  与 `chmod 0600/0700`。
- Windows 上游 UDS 的 rendezvous 路径不具有本项目当前假设的 POSIX Socket 文件语义。

### 服务与进程

- 服务安装、状态、日志和更新只实现 systemd 与 launchd，其他平台稳定失败关闭。
- 进程停止在 Unix 使用信号和进程组；Windows 已建立只面向调用方持有 PID 的精确子进程树终止合同，
  但完整前台与后台服务验收仍未完成。
- Thread Writer Lock 在 Linux 通过 `/proc/<pid>/fd` 定位持有者；Windows 已通过 Restart Manager 以
  PID 和启动时间定位并复核精确持有者，完整渠道释放闭环仍待阶段四验收。

### 路径、命令与代理

- 可执行文件解析已经处理 `PATHEXT`、`.cmd`、`.exe`、反斜杠、盘符、含空格路径和 UNC 组合。
- npm 全局 `codex`、`codexc` 和 `npm` 在 Windows 上通常通过 `.cmd` shim 暴露。
- 自动系统代理发现只覆盖 macOS 和 GNOME；Windows 明确不读取 WinINET/WinHTTP，使用已有显式 TOML
  与标准代理环境变量，并由 Doctor 显示该边界。

### 私有文件与凭据

- 飞书用户 OAuth、微信 Bot 凭据和微信回复上下文只实现 macOS Keychain 与 Linux 加密文件后端。
- 第三方 Provider API Key、管理凭据、配置、数据库、任务库、指标库、媒体临时文件和多个运行时目录
  使用 POSIX mode、UID 与 `O_NOFOLLOW` 等安全条件。
- Windows 上接受 `chmod` 调用不等于已经建立等价 NTFS ACL；不能只跳过现有检查。

### 测试与发布

- CI 只运行 Ubuntu 和 macOS；真实 App Server 合同只在 Ubuntu 执行。
- 提交门禁直接调用 Bash 检查 Shell 脚本，npm 包冒烟按 Unix 可执行入口验证。
- 发布包未通过 `package.json.os` 阻止 Windows 安装，但包内也没有 Windows 服务资产。这只是“可下载”，
  不是“可运行”。
- 源码安装只有 POSIX Shell 入口，并明确拒绝 Windows。

## 设计原则

### 保持业务层不感知平台

Windows 差异只进入 `runtime`、`scripts`、`codex-client` Transport 和 Bootstrap 组合根。Application、
Core、Policy、Session Routing、Storage 与 Surface 不得出现 `win32` 分支。平台能力通过现有公开端口
或最小新增端口注入，不能让业务模块读取命名管道、Windows SID、DPAPI 或服务管理器输出。

### 复用现有结构化服务合同

当前服务安装已经具有检查、计划、执行、进度和结果合同。Windows 只增加平台执行适配器，不复制一套
CLI 菜单，也不靠解析 PowerShell、`sc.exe` 或 `schtasks.exe` 的中文/英文输出判断成功。服务状态必须
返回与 systemd/launchd 相同的稳定结构化字段。

### 安全结果等价，不追求实现形式相同

- Unix 用 owner-only 目录和 Socket；Windows 可使用带当前 SID ACL 的命名管道或文件，并在需要时增加
  一次性/进程级 Capability Token。
- macOS 用 Keychain、Linux 用 AES-256-GCM 私有文件；Windows 可以使用 DPAPI 保护主密钥，再复用现有
  AES-256-GCM 记录格式。
- 所有认证材料不得进入命令行、日志、平台消息、StateStore 或普通配置快照。
- 仅靠随机管道名、回环地址或“机器只有一个用户”不能替代认证和权限校验。

### 先验证上游合同，再确定公开配置

Transport 可行性尚未在真实 Windows 主机验证，因此阶段零完成前不新增 `codex.transport`、
`pipe_name`、`listen_url` 等公开配置。默认端点应由运行时安全生成；只有用户确有稳定配置需求且安全
边界明确时，才通过独立配置设计增加字段。

## 候选 Transport 决策

| 方案 | 优点 | 风险 | 当前决策 |
| --- | --- | --- | --- |
| Windows UDS + `codex app-server proxy` | 使用固定版正式 UDS；原生 TUI 可直接共享；Gateway 不依赖 Node 直接连接 Windows UDS | 必须继续验证重连和完整生命周期；Gateway 需把子进程 stdio 包装为单条 Duplex | 采用方向；生产 Transport、主/Provider 选择、真实只读合同和 128 MiB 入站边界已通过 |
| 回环 WebSocket + Capability Token | Node 与原生 TUI 都能连接；健康检查和认证参数已存在 | 固定版官方明确标为实验且不受支持；端口、Token 生命周期和服务发现增加复杂度 | 仅作为首选失败后的候选，不直接生产采用 |
| 每个 Gateway 使用 stdio App Server | 跨平台最简单 | 单客户端语义破坏共享 App Server、Remote TUI、Provider 租约和独立生命周期 | 拒绝 |
| 无认证回环 WebSocket | 实现快 | 同机其他进程可控制 App Server，违反当前安全边界 | 拒绝 |
| Gateway 自行实现 App Server 或会话代理 | 可完全控制 Transport | 复制官方状态机与协议，维护和安全风险不可接受 | 拒绝 |

阶段零必须在结果文档中记录最终选择、原始错误、固定 CLI 版本和复验命令。若首选与候选都不能满足
安全、共享会话和稳定性要求，Windows 工作进入阻塞状态，不通过降级语义宣告支持。

## 分阶段实施

### 阶段零：真实 Windows Transport 探针

状态：Transport 选型与最小真实合同已完成；完整 Remote TUI、Provider 共享和异常生命周期验收仍在进行中。

- [x] 在 Windows 11 `10.0.22631` 和 Node.js `24.15.0` 上确认精确
  `@openai/codex@0.150.1`；Transport 探针只使用全局 Codex CLI 与 Node.js 内置模块，不依赖
  Gateway 构建产物。
- [x] 启动 `codex app-server --listen unix://<绝对路径>`，验证 Windows UDS 创建、失效 rendezvous
  同路径重建与关闭后的进程清理；Windows rendezvous 本身由上游保留，不按 POSIX Socket 文件删除。
- [ ] 使用原生 `codex --remote unix://<绝对路径>` 完成初始化、新建 Thread、Turn、审批和中断。
- [x] 使用 `codex app-server proxy --sock <PATH>` 完成标准 WebSocket Upgrade、双向 JSON-RPC、断线、重连、
  最大消息和关闭测试。
- [ ] 同时启动主实例与至少一个 Provider 隔离实例，验证路径隔离、Thread 隔离和 Remote TUI 共享。
- [ ] 验证 Proxy 子进程崩溃、App Server 崩溃、客户端先关闭和服务重启四种清理顺序不遗留占用。
- [x] 官方 Proxy 已通过，因此拒绝启用回环 WebSocket + Capability Token 备选；不得验证无认证 TCP 作为候选。
- [x] 写出采用/拒绝决策和可重复探针；阶段零探针不依赖 Gateway 构建产物，稳定业务代码适配在选型后实施。

验收门槛：至少一次真实 Windows 运行记录证明选定 Transport 支持 Gateway 和原生 TUI 共享同一 App
Server；失败路径有界结束，无悬挂请求、明文 Token、残留进程或错误 Thread 推断。

#### 首轮实机记录：2026-08-29

本轮 Transport 探针使用全局 npm 安装中的原生 `codex.exe`，未使用 Gateway 项目依赖或构建产物，
也未启动 Gateway。随后只读检查了工作区已有依赖并运行项目检查与构建。结果如下：

- `codex app-server --listen unix://<绝对路径>` 可以在 Windows 创建 UDS rendezvous；该路径表现为
  0 字节 reparse point。Node.js `lstat` 对它返回 `EACCES`，证明当前依赖 `Stats.isSocket()`、UID 和 mode
  的 `UnixWebSocketTransport` 不能直接用于 Windows。
- App Server 被中断后没有残留 `codex.exe`、Node.js 或代理进程，但 rendezvous 仍保留。固定版 App
  Server 可以在同一路径重新启动并恢复服务，因此“陈旧路径可恢复”通过，“正常关闭删除端点”未通过，
  第二项保持未完成。
- [`windows-app-server-proxy-probe.mjs`](../scripts/windows-app-server-proxy-probe.mjs) 连续两次通过
  `app-server proxy --sock <PATH>` 获得 `HTTP/1.1 101 Switching Protocols`，完成双向
  `initialize` / `initialized` 和只读 `thread/list`；每次客户端关闭后 Proxy 子进程均退出。
- 独立 Proxy 被中断后，App Server 仍可接受新的 Upgrade 和 JSON-RPC。反向关闭不对称：App Server
  进程退出后，已初始化 Proxy 仍保持存活；`--hold-ms 60000` 后再次发送 `thread/list`，10 秒内没有
  响应，探针以明确超时结束并终止 Proxy。生产适配器必须拥有 Proxy 子进程，以请求超时或独立健康
  检查触发终止和重建，不能把 Proxy 进程存活解释为 App Server 健康。
- 原生 `codex --remote unix://<绝对路径>` 成功显示 `0.150.1` TUI、Windows 工作目录和模型，随后
  Ctrl+C 正常退出；本轮未发送消息，因此尚未验证新建 Thread、Turn、审批和中断。
- 工作区普通目录中的 rendezvous 继承了过宽 ACL；改在仅当前 SID 具有 FullControl 的私有父目录后，
  同一 Proxy 合同继续通过。由于本工具会话使用提升令牌，文件 Owner 显示为 Administrators，普通用户
  所有权仍须在非提升 PowerShell 复验；随机路径本身不能替代权限隔离。
- 根目录已有完整 pnpm 链接依赖树，`npm ls --include=dev --depth=0 --global=false` 退出码为 0；未重装
  依赖，也未修改现有 `pnpm-lock.yaml`。`npm run check` 和 `npm run build` 均因四处相同的飞书 SDK
  `AxiosInstance` / `HttpInstance` TypeScript 不兼容而失败，构建产物未生成。该问题先单独定位依赖解析
  与源码基线，不能把它未经证据归类为 Windows 平台故障。

可重复的 Proxy 合同命令为：

```powershell
node scripts/windows-app-server-proxy-probe.mjs `
  --codex <原生-codex.exe-绝对路径> `
  --socket <运行中-App-Server-UDS-绝对路径> `
  --cwd <Workspace-绝对路径> `
  --hold-ms 0
```

采用决策仍为“首选继续验证”。下一批必须覆盖非提升当前 SID 私有目录、Ephemeral Thread 跨客户端
可见性、Proxy 与 App Server 异常关闭顺序、消息上限、Provider 隔离，以及需要真实 Turn 的审批与中断。

#### 第二轮实机记录：2026-08-29

本轮扩展同一零依赖探针，在当前 SID 私有父目录中启动一个固定版 App Server，并分别使用全新的官方
Proxy 连接验证真实模型 Turn、审批和中断。每个非只读场景使用 Ephemeral Thread，结束后调用
`thread/unsubscribe`，探针不输出 Thread ID、消息正文或命令正文。结果如下：

- 最小 Turn 使用只读 Sandbox 和 `approvalPolicy: "never"`，提示禁止工具调用并只返回一个短词；
  `thread/start`、`turn/start` 与 `turn/completed` 完整通过，最终状态为 `completed`。
- 审批场景使用 workspace-write Sandbox 和 `approvalPolicy: "untrusted"`，只请求执行一次
  `node --version`。探针收到一次 `item/commandExecution/requestApproval`，通过服务端提供的
  结构化 `commandActions` 精确确认命令后返回一次性 `accept`；Turn 最终状态为 `completed`。
  两次较早复验因探针只接受裸命令字符串而主动返回 `decline`，均未执行命令；这证明 Windows
  App Server 会为审批展示提供 Shell 包装，同时保留可用于严格校验的结构化动作。
- 中断场景在 `turn/start` 返回后立即发送 `turn/interrupt`，最终
  `turn/completed.turn.status` 为 `interrupted`。
- 首次 Turn 尝试因探针在未协商 Experimental API 时发送 `historyMode`，被 App Server 以
  `thread/start.historyMode requires experimentalApi capability` 明确拒绝。移除该非必需实验字段后
  三个场景通过；该错误属于探针参数，不是 Windows Transport 故障。
- 结束后测试 App Server 已停止，按本轮 Socket 命令行检查残留进程数量为 0；Windows rendezvous
  reparse point 仍保留，与首轮关闭清理结果一致。

本轮完成的是 Gateway 候选 Proxy Transport 的协议链路，不等同于原生 `codex --remote` TUI 已完成
Turn、审批和中断，也不代表 Gateway 已能在 Windows 启动。下一批保留 Provider 隔离、最大消息和
非提升 SID 复验；真实 Turn、审批和中断不再阻塞 Proxy 方案选择。

#### 第三轮实机记录：2026-08-29

本轮验证源码依赖安装与构建，不修改飞书 Surface 或依赖版本：

- 初始 pnpm 链接依赖树中 `@larksuiteoapi/node-sdk@1.73.0` 解析 Axios 1.20.0；SDK 运行时通过响应
  拦截器返回 `resp.data`，但导出的 `defaultHttpInstance` 仍声明为 Axios 实例。Axios 1.20.0 的
  返回类型不再满足 SDK 自己的 `HttpInstance`，导致四处 TypeScript 错误。
- 仓库 `package-lock.json` 锁定 Axios 1.18.1。使用 `npm ci` 重建依赖后，飞书类型错误消失；没有
  修改 `package.json`、`package-lock.json` 或用户现有 `pnpm-lock.yaml`，也没有为 Windows 增加
  飞书专属分支。
- 第一次 `npm ci` 在安装 Hook 时失败：Git 索引中的 `.githooks/pre-commit` 为 `100755`，但
  Windows NTFS 的 Node.js `stat().mode` 不提供 POSIX 执行位。Hook 安装器现只在非 Windows 平台
  检查 `0o111`；Windows 仍要求文件存在并设置当前仓库的 `core.hooksPath=.githooks`，不影响
  Linux/macOS 原有检查。
- 第二次 `npm ci` 完整通过，包括安装期 `prepare-package.mjs`、Windows `npm.cmd` 子进程和
  `tsc -p tsconfig.build.json`。随后 `npm run check`、Git Hook 定向测试、相关脚本 ESLint 和
  `npm run docs:check` 均通过。
- npm 报告当前锁定依赖树存在 1 个 moderate 和 2 个 high 漏洞；本轮没有运行
  `npm audit fix`，因为依赖升级不属于 Windows Transport 适配范围。

#### 第四轮实机记录：2026-08-29

本轮在同一 App Server 上保持主 Proxy 的 Ephemeral Thread 订阅，并由探针内部启动第二个独立官方
Proxy。第二个连接完成自己的 WebSocket Upgrade、初始化与 `thread/read`，读取结果的 Thread ID 与
主连接创建的 ID 一致；ID 只在两个本地进程间传递，没有写入配置或输出。主连接随后
`thread/unsubscribe`，两个 Proxy 均退出；测试 App Server 停止后，按本轮 Socket 检查关联残留进程
数量为 0。该结果证明 Windows UDS + 官方 Proxy 支持 Gateway 与另一个协议客户端同时观察活动
Ephemeral Thread；原生 TUI 交互仍需单独完成。

#### 第五轮实机记录：2026-08-29

本轮把已验证的字节桥接收敛为生产 Transport，并接入 Gateway 的 Codex Client 组合根：

- `WindowsProxyTransport` 在 Windows 启动固定 Codex 可执行文件的
  `app-server proxy --sock <PATH>` 子进程，将其标准输入输出包装为单条 Duplex，再交给现有 `ws`、
  `BaseTransport` 和 `JsonRpcClient`；初始化、消息分流和业务请求没有复制。
- Transport 明确拥有 Proxy 生命周期：握手失败会终止子进程，客户端关闭会先关闭 WebSocket、再结束
  字节流和 Proxy，并为退出设置有界等待；非 Windows 平台明确拒绝该实现。默认 WebSocket 消息上限
  与官方 Remote Transport 保持 128 MiB，但边界载荷实测仍未完成。
- 使用 `npm run build` 的实际产物连接隐藏启动的固定版 App Server，完成一次 `initialize`、
  `initialized` 和只读 `thread/list`；关闭后按精确 Socket 命令行检查，Proxy 残留数量为 0。
- 同一合同已加入 `tests/real-app-server.test.ts` 的 Windows 条件用例。首次测试因 Node.js
  `existsSync` 无法识别 UDS reparse point 而等待超时；改为枚举已知私有父目录中的精确端点名后通过，
  没有放宽 Transport 的安全判断。
- 平台无关的本机 App Server 端点工厂在 Unix 保留 `UnixWebSocketTransport`，在 Windows 选择
  `WindowsProxyTransport`；Gateway 主 Client、受管 Provider 和自定义切换 Provider 均通过同一工厂装配。
- Windows 真实合同同时启动主实例和第二个 Provider App Server；主实例创建的 Ephemeral Thread 在
  Provider 实例中不可读取。另一个合同把接收上限压到 64 字节，初始化响应被有界拒绝并完成清理；
  这证明上限执行路径成立，但不等同于默认 128 MiB 满载实测。
- `npm run check`、相关源码与合同测试的定向 ESLint、`npm run build`，以及
  `RUN_CODEX_INTEGRATION=1` 下的 Windows Proxy Transport 真实合同均通过；真实合同只执行只读请求，
  未启动模型 Turn。

当前小批次证明生产 Transport、平台选择和 Client 组合根成立。非提升 SID 私有目录、服务异常后的
重建、默认 128 MiB 满载边界，以及 Supervisor、Gateway Owner、Provider Metrics 等内部 IPC 仍是
后续门槛。

#### 第六轮实机记录：2026-08-29

本轮为零依赖探针增加分片消息场景，以 1 MiB WebSocket Fragment 和零值 Mask Key 分段写入，避免为
单个大请求同时保留 JSON 字符串、未遮罩 Buffer、遮罩副本和整帧副本。实测结果如下：

- 1 MiB 和 64 MiB 的客户端到 App Server JSON-RPC 请求均被完整接收，并返回未知方法的结构化错误，
  证明分片帧本身成立。
- 96 MiB、`128 MiB - 1` 和 128 MiB 请求均在写入期间由 App Server 关闭连接；官方 Proxy 随后退出，
  stderr 只报告底层连接被重置。默认可重复场景因此固定为 64 MiB 接受、96 MiB 拒绝，用于记录锁定版
  App Server 的请求边界区间，不伪造尚未定位的精确阈值。
- 该方向是 Gateway 到 App Server 的请求大小，不等同于 `ws` 客户端接收 App Server 大型 Thread/Item
  响应时配置的 128 MiB 上限。生产 Transport 的小阈值拒绝合同已通过，但默认 128 MiB 接收满载仍保持
  未完成，不能用本轮结果替代。
- 探针对超限时的 stdin EOF 进行有界收敛，结构化记录 `proxy-exit`，结束后按本轮运行目录检查关联
  `codex.exe` / `node.exe` 残留数量为 0。

这一区分说明收发方向具有不同边界；后续 128 MiB 接收合同应由可控 App Server 响应夹具完成，不能
继续用超大未知请求反推。

#### 第七轮开发记录：2026-08-29（暂停点）

本轮开始处理 Windows 可执行文件与 npm shim。独立验证先复现了 Node.js 在 Windows 直接启动
`codex.cmd` 时的 `EINVAL`，随后把可执行文件解析和实际启动命令拆开：解析器按 `PATHEXT` 查找
`.exe`、`.cmd` 和 `.bat`，忽略 npm 同目录中无扩展名的 POSIX shim；结构化调用在需要时通过
`ComSpec` 启动批处理 shim。完成该小批次时，可执行文件定向测试、Stdio Transport 测试，以及使用
`PATH` 中真实 `codex` shim 的生产 App Server Transport 合同均已通过。

随后将同一结构化调用接入版本检查、Stdio Transport、Doctor、官方登录、项目规则和主/Provider
App Server 启动入口。模块边界测试发现 `codex-client` 不允许直接反向导入 `runtime/executable.mjs`；
为保持现有依赖方向，代码已改为由组合根通过 `codex-process.ts` 的窄接口注入调用描述。该最后一次
重构已经写入工作区，但用户暂停时尚未重新执行 `npm run check`、相关 ESLint、模块边界测试或真实
App Server 合同，因此不能把组合接入描述为已验证完成。

暂停前还记录了一个独立测试夹具问题：`official-login-setup` 的既有测试在 Windows 仍生成
`fake-codex.sh`，文件不具备 Windows 可执行语义，测试以 `EFTYPE` 失败。恢复工作时应先完成以下最小
回归，不从此处直接扩展到内部 IPC：

1. 运行类型检查、相关 ESLint 和模块边界测试，确认窄接口注入没有破坏模块依赖与调用类型。
2. 将官方登录测试夹具调整为 Windows 可执行的 `.cmd`，或复用已注入的结构化调用夹具，再复验登录、
   Gateway 版本检查、Stdio 和可执行文件定向测试。
3. 再次使用 `PATH` 中的真实 `codex` shim 运行 Windows App Server 合同；通过后才更新阶段二勾选状态。

此暂停点不影响第五轮已经通过的绝对 `codex.exe` Proxy Transport 合同，也不改变“项目尚不支持
Windows”的公开结论。

#### 第八轮开发记录：2026-08-30

恢复后先完成了暂停点要求的回归。`npm run check`、相关生产代码 ESLint、可执行文件与升级脚本定向
测试均通过；使用 `PATH` 中真实 `codex.cmd` 的生产 `WindowsProxyTransport` 再次完成初始化和只读
`thread/list`，退出后 App Server、Proxy 和临时目录残留均为 0。`codex-client` 继续只依赖注入的
`CreateCodexProcessInvocation`，没有反向导入运行时模块。

结构化可执行文件调用已扩展到 `codexc remote`、协议生成与检查、源码安装/更新/卸载、WebUI 开发、
升级验证、源码与 npm 包冒烟以及提交门禁。Windows 解析 `PATH`、`PATHEXT` 与 `ComSpec` 时按环境变量
键名大小写不敏感处理，兼容从 `process.env` 展开的 `Path`；批处理 shim 仍通过解析后的 `ComSpec`
启动，不依赖 Shell 自动补后缀。生产入口审计未发现剩余的裸 npm/Codex 子进程启动。协议正文比较只
归一化 CRLF 与 LF，`npm run protocol:check` 已通过。

本轮没有修改既有测试。模块边界、官方登录、Stdio、源码安装和源码更新的部分 Windows 测试夹具仍
使用 `/` 分割路径、`.sh`、未注入的 `.cmd` 或无扩展名 POSIX 可执行文件，会在 Windows 失败；这些是
后续 Windows CI 夹具债务，不能据此声称全量测试通过。完成 WebUI 构建后，`npm run test:package`
已经越过 npm shim、tarball 安装、CLI 帮助与文件检查，最终在 `validate-config` 的 POSIX 私有文件 mode
检查处失败，确认下一处真实发布阻断属于阶段三 NTFS SID/ACL，而不是 npm shim。

#### 第九轮实机记录：2026-08-30

本轮完成生产 `WindowsProxyTransport` 默认 128 MiB 入站边界。固定版官方资料确认
`app-server proxy` 只在 stdin/stdout 与 UDS 之间桥接原始字节，Proxy 后方仍承载标准 WebSocket Upgrade
和文本帧；由于本地锁定的 `upstream/openai-codex` 副本不存在，本轮只读取项目索引中固定到
`rust-v0.150.1` 的官方 App Server README、Unix Socket 和 WebSocket Transport 源码，没有使用
官方 `main` 行为。

新增的 `windows-proxy-inbound-limit-probe.mjs` 以本地可控 WebSocket 字节流子进程替代上游响应端，
但仍由构建产物中的真实 `WindowsProxyTransport` 创建进程、执行 Upgrade、接收文本帧并应用 `ws`
的 `maxPayload`。夹具不连接模型、不创建 Thread，也不输出载荷正文。1 MiB 小合同先验证了夹具自身的
接收/超限路径；随后默认合同完整接收 134217728 字节，并对 134217729 字节返回
`max-payload-error`。这补齐的是 App Server 到 Gateway 的接收方向；第六轮记录的 64/96 MiB 区间仍
描述 Gateway 到固定版 App Server 的发送方向，两者不互相替代。

#### 第十轮实机记录：2026-08-30

本轮开始阶段三的配置与共享私有文件 SID/ACL 基础合同。Windows 运行时只解析并调用 PowerShell 7
的 `pwsh`，不调用 Windows PowerShell 5.1，也不解析本地化的 `icacls` 文本。随包发布的
`windows-private-acl.ps1` 从 stdin 接收固定 JSON 请求，通过 .NET `FileSystemAclExtensions` 读取和
设置安全描述符，并只向 Node 返回结构化结果；路径或底层错误不进入普通 CLI 输出。

严格私有目录和文件必须由当前用户 SID 拥有、关闭 ACL 继承，并只允许当前 SID、SYSTEM 与内置
Administrators 完全控制；显式配置文件的父目录保留原 Unix 合同，只允许其他主体读取/遍历，不能
写入、删除或改写 ACL。Owner 不一致时失败关闭，不尝试接管所有权；符号链接和 reparse point 同样
拒绝。新建 Gateway 配置会在创建配置锁前收紧父目录，原子临时文件在替换前收紧自身 ACL。

当前非提升会话实测确认临时目录 Owner 等于当前 SID，目录、文件和配置父目录验证均通过，且没有
临时目录残留。`npm run check`、相关 ESLint 与 `pwsh` 语法检查通过；`npm run test:package` 的 tarball
构建、隔离安装、CLI、配置预检和指标检查完整通过。后续干净源码安装因
`smoke-source-prepare.mjs` 使用 `relative.split("/")` 过滤 Windows 路径，临时副本缺少整个
`scripts\` 目录而失败；本轮按全局规则未修改测试脚本。数据库、媒体、凭据后端、Doctor 与另一普通
Windows 用户访问拒绝仍未验证，因此阶段三第一项保持未勾选。

#### 第十一轮实机记录：2026-08-30

本轮把 Gateway Owner、App Server Supervisor 和 Provider Metrics 从各自重复的 Unix Socket 生命周期
收敛到 `runtime/private-ipc.mjs`。Unix 继续使用属主、`0600` mode、inode 对比和安全陈旧端点清理；
Windows 使用 Node.js named pipe，并把随机管道名和 256-bit 随机认证令牌发布到当前 SID 私有描述文件。
Node 默认 named pipe 安全描述符只允许创建用户和管理员访问，本实现不启用会向 Everyone 扩权的
`readableAll` / `writableAll`；每个连接还必须在 1 秒内通过有界 JSON 首帧认证。

Windows 11 实机定向探针已通过 Gateway 活跃/就绪状态、重复实例拒绝、未认证连接拒绝和所有者清理；
Supervisor 已通过拓扑读取、Provider 启动、租约阻止释放、租约关闭后释放；Provider Metrics 已通过
真实编译产物的有界指标投递与确认。探针同时发现 Windows named pipe 不能沿用指标客户端先半关闭写端
再等待 ACK 的 Unix 时序，现已改为换行帧完成后回写确认；认证解析只计算首个换行前的认证帧，不会把
同批到达的业务帧误计入 256 字节认证上限。`npm run check` 与 `npm run build` 已通过。
既有 IPC 测试仍有 Windows 专属失败：它们直接对逻辑 `.sock` 路径执行 Unix mode、`net.connect`、
超长 Unix 路径或私有原始 `net.Server` 检查；当前全局规则禁止修改测试文件，本轮保留为阶段六 CI 债务。

另一普通 Windows 用户的跨 SID 拒绝、陈旧描述文件竞争、Doctor 展示和完整 Gateway/App Server 生命周期
尚未完成，因此 Windows 内部 IPC 的完整安全验收项仍保持未勾选，公开支持范围不变。

#### 第十二轮实机记录：2026-08-30

本轮移除 App Server 端点准备和健康检查对 Windows `lstat/isSocket/uid/mode` 的错误依赖。固定版上游
Windows UDS 只把 rendezvous 路径存在作为陈旧信号，并由 App Server 在绑定时恢复；Gateway 因此先
确保父目录使用当前 SID 私有 ACL，再通过官方 `codex app-server proxy --sock` 的真实 WebSocket 握手
判断端点是否健康。活动端点仍拒绝覆盖；不健康的 Windows rendezvous 不由 Node 重命名或删除，继续
交给锁定版 App Server 原地恢复。Unix 的文件类型、属主、权限和失效 Socket 保留逻辑不变。

Windows 11 实机探针已通过缺失端点、不受监管活动端点拒绝、App Server 退出、同路径重新绑定、Proxy
握手和 Proxy 清理；运行结束没有遗留本轮 App Server 或 Proxy 进程。下一步进入真实 `codexc start`
前台闭环，继续处理实际启动链上的平台阻断。

#### 第十三轮实机记录：2026-08-30

本轮建立共享 Windows 进程树终止端口。调用方只向当前 `ChildProcess` 句柄记录的精确 PID 调用系统
`taskkill.exe /T`，不枚举进程名、不扫描其他 Codex 实例；Windows 控制台进程拒绝非强制终止并返回
128 时，对同一个 PID 树立即使用 `/F`。Unix 继续沿用原有信号行为。Gateway/App Server 生命周期、
Provider 释放、官方 Proxy 健康探针以及生产 Windows/Stdio Transport 已接入该共享终止能力；
Codex Client 仍由组合根注入窄端口，没有反向依赖 Runtime。

Windows 11 三层 Node 进程树实机探针通过：持有的根进程和后代均退出，同时启动的无关 Node 进程保持
存活，随后由探针单独清理。服务重启超时也已改用同一终止端口；开发启动器、Gateway/App Server
关闭、Provider 释放、Proxy 清理和前台更新中断均通过共享生命周期入口收敛。定向 ESLint 与
`npm run check` 通过；完整服务与更新实机闭环留待对应阶段验收。

#### 第十四轮实机记录：2026-08-30

本轮为 Windows 增加 Thread Writer Lock 持有者定位。PowerShell 7 适配器通过系统 Restart Manager
的 [`RmRegisterResources`](https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmregisterresources)
注册锁文件，再通过 [`RmGetList`](https://learn.microsoft.com/windows/win32/api/restartmanager/nf-restartmanager-rmgetlist)
读取实际占用它的进程；返回身份同时包含 PID 和 Restart Manager 提供的进程
启动时间。渠道只接收该进程的可执行路径，不读取或展示 Windows 原始命令行，避免参数凭据泄露。
`/release force` 仍只允许 `codex` / `codex.exe`，二次检查必须同时匹配 PID 与启动时间；最终终止在
同一个 .NET `Process` 对象上再次校验启动时间，不按名称扫描进程，也不删除锁文件。识别失败、多个
持有者或无法读取可执行路径时继续失败关闭。

Windows 11 真实文件句柄探针通过：Restart Manager 精确识别持有临时锁文件的 `node.exe` 及启动时间，
按该身份终止后锁恢复为空闲。PowerShell AST 语法检查、定向 ESLint 和 `npm run check` 均通过。
该探针验证底层身份与终止合同；真实 Codex `/release force` 渠道闭环仍归阶段四验收。

#### 第十五轮决策记录：2026-08-30

Windows 首期不自动读取 WinINET/WinHTTP。现有代理优先级保持为显式 `[network]` TOML、标准大小写
代理环境变量、受支持系统自动发现；Windows 在第三层明确返回空结果，不新增 PAC 求值、注册表与
WinHTTP 合并优先级，也不把系统代理静默写回配置或服务定义。用户在 Windows 通过 TOML 或
`HTTPS_PROXY` / `HTTP_PROXY` 配置即可复用现有 HTTP(S)、`NO_PROXY`、渠道和 Provider 路径。

根 README、Config/Runtime 模块说明和 `codexc doctor` 已统一该边界。Doctor 无论检测到代理、被
`NO_PROXY` 直连或未检测到代理，都会明确说明 Windows 系统代理未自动读取。`scripts/doctor.mjs`
语法检查和定向 ESLint 通过；真实外部代理连通性仍归渠道与 Provider 验收，不在本轮联网发送请求。

#### 第十六轮实机记录：2026-08-30

本轮使用系统现有的本机管理共享执行只读 UNC 探针，没有创建共享或修改 Windows 设置。当前
`C:\Program Files\nodejs\node.exe` 对应的 `\\localhost\C$\Program Files\nodejs\node.exe` 可读；
共享 `resolveExecutable` 保留并返回该 UNC 路径，随后通过结构化调用成功执行 `node --version`，
退出码为 0，输出与当前 Node.js `24.15.0` 一致。由此确认带空格 UNC 可执行路径的解析与启动主路径。

阶段二各实现子项现已完成；完整 STOP、Provider、更新和渠道组合仍在后续前台/服务阶段做场景验收，
不因单项探针把 Windows 公开状态改为可部署。

#### 第十七轮实机记录：2026-08-30

经用户明确批准，本轮采用无新增依赖的 Windows 凭据格式：PowerShell 7 调用 .NET
[`ProtectedData`](https://learn.microsoft.com/dotnet/standard/security/how-to-use-data-protection)
并固定使用 `DataProtectionScope.CurrentUser` 保护每个凭据目录的随机 256-bit 主密钥；业务记录继续
使用随机 96-bit IV、128-bit Tag 的 AES-256-GCM。主密钥和记录文件均为严格版本 1 JSON 封套，未知
键、版本、保护方式、算法、Base64、密文或 Tag 损坏全部失败关闭。Windows 文件和目录继续复用当前
SID 私有 ACL，写入使用临时文件原子替换；macOS Keychain 和 Linux 原始 32-byte 主密钥/二进制记录
格式未改动，不执行跨平台迁移。

飞书用户 OAuth Token、微信 Bot Token、微信回复上下文和第三方 Provider API Key 已接入该后端。
Windows 11 实机探针在四条路径写入不同标记凭据，递归扫描全部落盘文件未发现任何明文；新 Node
进程成功恢复全部四条凭据，随后逐项撤销并确认全部不可再读取。DPAPI 独立保护/解保护探针、PowerShell
AST、`npm run build` 和类型检查均通过。另一普通 Windows 用户的 DPAPI/ACL 拒绝仍需独立账户验收，
其余私有存储与 Doctor 状态转入下一批收口，因此阶段三整体仍进行中。

#### 第十八轮实机记录：2026-08-30

本轮完成 Windows 私有存储生产写入点审计，并把仍只依赖 POSIX `0600/0700` 的路径接入共享
`private-file` SID/ACL 合同。状态 SQLite、计划任务 SQLite 及其备份、指标 SQLite、锁库、WAL 父目录、
指标同步水位、管理/WebUI Token、Gateway 配置、渠道图片 spool、Surface 媒体临时文件、Provider
迁移备份和更新数据库/配置备份现在都会关闭 ACL 继承，并只允许当前 SID、SYSTEM 与 Administrators
完全控制。SQLite Schema、备份格式和 macOS/Linux 行为未改变。

Windows 11 代表性探针用实际编译产物依次创建状态库、计划任务库与备份、指标库与锁库，并迁移既有
媒体文件和渠道输出文件；7 个目录和 7 个文件全部通过共享 ACL 校验，探针目录在验证后按精确路径清理。
`npm run check`、`npm run build` 和相关文件定向 ESLint 均通过。阶段三只剩另一普通 Windows 用户的
读取/替换拒绝验收，以及 Doctor 对 ACL、所有者、凭据后端和损坏状态的只读诊断。

#### 第十九轮实机记录：2026-08-30

本轮把 `codexc doctor` 的私有权限检查改为平台合同：Unix 继续核对 `0700/0600`，Windows 调用共享
SID/ACL 校验，不再把 NTFS 上无意义的 POSIX mode 当作结论。Doctor 只读检查配置、状态目录与数据库、
指标数据库、凭据目录、媒体暂存目录和渠道输出目录；WebUI、指标中心查看 Token 与设备 Token 只报告
是否配置，不输出内容。Windows 还执行一次不落盘的 DPAPI `CurrentUser` 保护/恢复探针；已配置的微信、
回复上下文和第三方 API 凭据仍通过现有严格 Store 读取验证格式与损坏状态，错误只显示脱敏结论。

隔离临时配置的 Windows 11 实机探针中，配置文件 ACL、DPAPI 后端和 6 项私有目录/数据库检查全部通过；
完整 Doctor 因探针未启动 App Server 而保持非零退出码，该无关失败未被掩盖。类型检查和 Doctor 定向
ESLint 通过。阶段三实现项现已完成，只剩使用另一普通 Windows 账户证明无法读取或替换当前用户私有
文件的独立实机验收。

#### 第二十轮实机记录：2026-08-30

阶段四前台命令审计确认唯一剩余的显式平台代码阻断位于 Doctor 的 App Server 健康检查：原实现仍用
`existsSync` 和 Unix WebSocket 直连。现已在 Windows 复用生产 `createAppServerTransport`，通过官方
`codex app-server proxy --sock` 完成 `initialize`；Codex npm `.cmd` shim 继续使用共享
`executableInvocation`，Proxy 子进程关闭复用精确进程树终止端口。Unix Doctor 保留原直连行为。

真实 Windows App Server 探针中，Doctor 的 initialize 握手和 `0.150.1` 精确版本检查均通过，且没有
遗留 App Server 或 Proxy 进程。`init`、`setup`、`start`、`remote`、`work`、`config`、`doctor`、
`metrics`、`webui`、`center` 十个公开入口的 `-h` 全部退出 0；隔离配置下 `config --json`、
`work list --json`、`metrics status --json` 和 `center info --json` 全部返回有效 JSON。该结果只完成
命令入口与只读前台主路径，不替代交互式 Setup、Remote TUI、WebUI 启动和三个渠道业务闭环。

#### 第二十一轮实机记录：2026-08-30

本轮在隔离的当前 SID 私有配置与数据目录中，通过公开 `codexc` 前台入口分别启动 WebUI 和指标中心。
WebUI 使用动态空闲回环端口，根页面返回 `200 text/html`；指标中心使用另一动态回环端口和临时私有
SQLite，`/api/health` 返回 `200 application/json`。随后使用共享 Windows 精确进程树终止端口关闭两者，
两个监听端口均不可再连接、两个子进程均已退出，探针数据按验证后的精确临时路径清理。

该探针确认 WebUI 与指标中心的前台启动、HTTP 响应、SQLite 初始化和关闭清理主路径，不代表非回环
令牌访问、浏览器完整页面交互或后台服务已验收。Remote TUI 的基础交互已在下一轮验证；Setup 业务
写入与三个渠道仍需要真实配置或平台凭据，因此保留为后续人工/真实合同门槛。

#### 第二十二轮实机记录：2026-08-30

本轮使用本机锁定的官方 `codex-cli 0.150.1` 和真实 PowerShell PTY，在隔离 Gateway 配置与临时 App
Server 上运行公开入口 `codexc remote --no-alt-screen`。TUI 成功显示 OpenAI Codex 版本、当前仓库工作
目录和模型信息；未发送任何用户消息或模型请求，按 `Ctrl+C` 后 `codexc remote` 以退出码 0 返回。
随后停止临时 App Server，共享 Socket 健康探针确认端点已不可连接，两个经验证位于 `%TEMP%` 的探针
目录均已按精确路径删除。

首次探针使用过长的随机临时目录时，官方 App Server 明确返回
`path must be shorter than SUN_LEN`；改用 79 字符的 Socket 路径后通过。该结果不需要修改 Remote
调用实现，但说明 Windows UDS 仍必须在含空格、长用户名和显式长配置目录场景下单独验证路径长度与
失败提示；该边界已在第二十五轮收敛为启动前校验。Provider Profile、共享历史会话、审批、模型与
思考等级同渠道一致仍归阶段四后续业务验收。

#### 第二十三轮实机记录：2026-08-30

本轮在另一份 `%TEMP%` 隔离配置中，通过真实 PowerShell PTY 运行公开入口 `codexc setup`。Setup 成功
显示“配置总览、Codex 用户设置、模型与提供商、通讯渠道、项目技能、取消”六项主菜单；使用方向键选择
“取消”后显示 `Setup 已取消` 并以退出码 0 返回。取消前后配置文件长度和最后写入时间保持一致，证明该
只读进入/取消路径没有改写配置；探针目录随后按验证过的精确路径删除。

该结果只完成交互菜单渲染、键盘导航和安全取消，不替代 Codex 用户设置事务、Provider 写入、渠道扫码
或 Token 保存等真实配置闭环。后续涉及渠道和第三方 Provider 的写入仍必须使用对应真实凭据验收。

#### 第二十四轮实机记录：2026-08-30

本轮在短路径隔离配置中验证公开入口 `codexc start`。`init` 默认生成的待 Setup 配置没有启用渠道，
Gateway 按既有严格 Schema 明确拒绝“至少需要配置一个通讯渠道”；此前已启动的 App Server 与模型统计
代理仍全部退出，Socket 与动态回环端口均不可再连接。该结果是探针前置条件不成立，不是 Windows
Gateway 启动失败，也没有为测试而放宽生产配置校验。

随后只在隔离配置中加入格式有效的临时 Telegram 标识，并把 HTTP(S) 代理固定到本机拒绝连接端口，
确保探针不会向外部平台发送请求。真实前台运行中，App Server、模型统计代理和 Gateway 均完成启动；
Gateway 通过 `windows-uds-proxy` 连接 App Server，并报告 Windows 平台信息，App Server Socket 与统计
代理端口同时可连接。网络目录、汇率、连通性与 Telegram 鉴权按预期在本机代理处失败，但不阻止核心
前台生命周期就绪。

首次按 `Ctrl+C` 停止时发现 Windows Console 会同时向父子 Node 进程投递信号，多个生命周期处理器并发
终止同一棵进程树。后执行的 `taskkill /F` 因目标已被另一处理器结束而返回 128，但 Node 子进程对象的
退出字段尚未更新，旧实现因此误报“Windows 子进程树终止失败”。共享进程生命周期现在只在
`taskkill` 非零后以 `process.kill(pid, 0)` 查询同一精确 PID：`ESRCH` 表示并发终止已经完成；PID 仍存在
时继续保留原失败。修复后重复完整启动并按一次 `Ctrl+C` 停止，不再打印异常栈；Gateway PID、App
Server Socket 和统计代理端口全部消失，探针目录也已按精确路径删除。

#### 第二十五轮实机记录：2026-08-30

本轮核对锁定提交 `90854393966b21e9ebfd21b122334eb09a20c93d` 的官方 `codex-rs/uds` 与其锁定
`uds_windows 1.1.0` 源码。Windows `sockaddr_un.sun_path` 固定为 108 字节，路径按 Win32 UTF-8
文件系统字符串编码；依赖在字节数大于等于 108 时返回 `path must be shorter than SUN_LEN`。实机构造
ASCII 精确边界后，107 字节 Socket 成功监听，108 字节稳定拒绝，与锁定源码一致。

共享 App Server Runtime 现在在 Windows 解析主 Socket 后立即按 UTF-8 字节校验，并对所有追加
Provider ID 后缀的最终 Socket 路径逐一复核。Gateway 组合根在创建每个 Transport 前执行同一校验；
Remote TUI 在获取 Provider 租约前校验所选最终路径。路径过长时不启动 App Server、Proxy、Gateway 或
Provider 租约，也不隐式搬移端点，而是报告当前字节数、必须小于 108，并提示在 `config.toml` 中缩短
`codex.socket_path` 且为 Provider 后缀预留空间。

内存探针确认 ASCII 和中文路径均按 UTF-8 字节计数，107 接受、108 拒绝。公开 `codexc start` 使用
108 字节绝对 Socket 的隔离配置时，在输出可操作错误后以退出码 1 返回，未创建 rendezvous 或启动模型
统计代理。该前置校验保持 Unix 路径解析和既有配置结果不变。

### 阶段一：平台运行时与内部 IPC

状态：Transport 与内部 IPC 实现子项已完成；阶段整体仍等待内部 IPC 完整安全验收。

- [x] 把“App Server 端点”从裸 `socketPath` 收敛为平台无关描述，由组合根选择 Unix 或 Windows 实现。
- [x] 保留现有 Unix WebSocket 实现和安全检查，不以 Windows 修改放宽 macOS/Linux 边界。
- [x] 根据阶段零结论新增 Proxy Transport 或受认证 WebSocket Transport；连接仍复用 Base Transport 与
  JSON-RPC 层，不复制初始化和消息分流。
- [x] 将 Gateway Owner、App Server Supervisor 和 Provider Metrics 的本地 IPC 收敛到共享端口。
- [ ] Windows 内部 IPC 使用命名管道或等价本地机制，并验证当前用户隔离、认证首帧、大小上限、超时、
  陈旧端点、占用、并发连接和所有者清理。
- [ ] Doctor 输出实际 Transport、端点健康和安全状态，但不得显示完整路径中的敏感随机材料或 Token。

验收门槛：主实例、多 Provider 实例、Supervisor 租约、Gateway 单实例和指标投递在 Windows 真实合同
中通过；Unix 现有测试和真实合同不变。

### 阶段二：路径、可执行文件和进程生命周期

状态：实现子项已完成；阶段整体仍等待阶段一完整安全验收，并在阶段四至六执行组合回归。

- [x] 可执行文件解析支持 `PATHEXT`、`.exe`、`.cmd`、`.bat`、盘符、反斜杠、空格路径和 UNC 路径，
  并继续拒绝目录、缺失目标和不受支持的输入。
- [x] 所有需要 npm 的子进程在 Windows 使用解析后的 `npm.cmd`，不依赖 Shell 自动补后缀。
- [x] 建立平台进程树端口；Windows 使用可证明所有权的 Job Object 或经审查的精确 PID 树终止方式。
- [x] STOP、超时、Gateway 关闭、Provider 释放和更新中断都必须终止属于本次运行的完整子进程树，不能
  杀死无关 `codex` 进程。
- [x] 为 Thread Writer Lock 增加 Windows 持有者定位与脱敏命令展示；无法确认所有者时继续失败关闭。
- [x] 系统代理支持显式配置和标准环境变量；是否加入 WinINET/WinHTTP 自动发现由独立探针决定，未实现
  时 Doctor 必须明确显示“未自动读取”，不能静默声称直连。

当前子项记录：`PATHEXT`、`.exe`、`.cmd` / `.bat`、盘符、反斜杠、含空格和 UNC 路径、大小写不固定的
Windows 环境变量键、真实 `PATH` npm/Codex shim 和生产调用入口均已验证。既有 Windows 测试夹具
兼容问题另列为 CI 债务，不改变生产调用子项的结论。

验收门槛：含空格的用户目录、npm shim、自定义 Provider、STOP、上游超时和异常退出均有 Windows
测试；运行结束没有遗留 App Server、Proxy 或 Provider Proxy。

### 阶段三：Windows 私有存储与凭据

状态：实现项已完成；只剩另一普通 Windows 用户的跨用户拒绝实机验收。

- [ ] 定义当前 Windows SID 私有目录/文件的检查和原子写入合同，拒绝符号链接、危险 reparse point、
  非当前用户可写路径和无法确认 ACL 的目标。
- [x] 评估 DPAPI、Windows Credential Manager 和受审查依赖；新增依赖、持久化格式与回滚方案须另行
  说明并取得确认。
- [x] 首选使用 DPAPI 保护每个数据目录的随机主密钥，复用现有 AES-256-GCM 记录载荷和严格解析。
- [x] 接入飞书用户 OAuth、微信 Bot 凭据、微信回复上下文及第三方 Provider API Key。
- [x] 覆盖管理凭据、WebUI/指标 Token、配置、数据库、计划任务库、媒体临时文件、输出和备份的私有
  文件结果；不只修复渠道 Token Store。
- [x] `codexc doctor` 校验 ACL、所有者、凭据后端和损坏状态，不读取或回显凭据正文。

验收门槛：凭据可跨 Gateway 重启恢复、撤销后不可恢复、损坏时失败关闭；另一普通 Windows 用户无法
读取或替换私有文件。迁移不是首期要求，不自动导入其他操作系统的 Keychain 或加密文件。

### 阶段四：前台 Windows 功能闭环

状态：命令入口、只读 CLI、Doctor/App Server、WebUI、指标中心和 Remote TUI 基础前台主路径已通过；
`codexc start` 的 App Server/统计代理/Gateway 前台启动和中断清理、Setup 主菜单与无修改取消已通过；
交互式配置写入、Remote Profile/共享会话/审批与渠道/Provider 业务闭环仍待验收。

- [ ] `codexc init`、`setup`、`config`、`work`、`start`、`remote`、`doctor`、`metrics`、`webui` 和
  `center` 在前台运行方式下闭环。
- [ ] Telegram、飞书、微信分别完成授权、普通消息、图片、审批、追加输入、STOP、完成卡片和重启恢复。
- [ ] OpenAI、DeepSeek、OpenCode Go、自定义第三方 Provider 和第三方子代理完成模型切换、思考等级、
  Provider 隔离、指标统计和上游失败退出。
- [ ] Workspace Sandbox、审批策略、网络权限和工作目录由真实 App Server 合同验证，不由 Gateway
  自行模拟 Windows 权限。
- [ ] 计划任务在 Gateway 前台持续运行期间完成创建、确认、触发、投递和重启恢复；前台进程关闭后不
  宣称仍会执行。

验收门槛：不依赖 WSL、Git Bash 或管理员 Shell；普通 PowerShell/Windows Terminal 用户可完成主路径。
本阶段完成后仍只能称“Windows 前台预览支持”，不能称后台服务完整可用。

### 阶段五：后台服务、安装、更新与卸载

状态：等待阶段四。

- [ ] 在 Task Scheduler 用户任务与 Windows Service 中选择一种首期正式方案；选择前明确管理员要求、
  登录前/后启动、失败重启、日志、环境变量、凭据访问和卸载语义。
- [ ] 复用现有服务计划、修订、阶段进度、结构化结果和恢复状态，只新增 Windows 执行适配器。
- [ ] `codexc service install|start|stop|restart|status|logs|uninstall` 与既有目标和默认值保持一致。
- [ ] App Server 独立于 Gateway；重启 Gateway 不得终止共享 App Server，`all` 才按现有合同处理全部
  核心服务。
- [ ] 提供 PowerShell 源码安装入口，或明确首期只支持 npm 安装；不能要求用户执行 POSIX `install.sh`。
- [ ] `codexc update` 完成候选构建、配置/数据库预检、服务停启、CLI 精确版本安装提示和失败恢复。
- [ ] 卸载只删除受管程序与服务，保留配置、数据库、凭据、日志和输出，除非用户明确选择数据清理。

验收门槛：普通用户权限和需要提升权限的路径分别测试；安装、更新、崩溃恢复、系统重启和卸载没有
遗留服务、明文凭据、错误 PATH 或失去管理的进程。

### 阶段六：CI、发布与公开支持

状态：等待阶段五。

- [ ] CI 增加 `windows-latest`，先拆分跨平台检查与 Unix 专属检查，不通过跳过全部测试制造绿色结果。
- [ ] Windows 运行类型检查、Lint、文档、全量跨平台单测、npm tarball 安装和 CLI 分级帮助冒烟。
- [ ] Windows 安装精确 Codex CLI，运行选定 Transport 的真实 App Server 合同。
- [ ] 增加 Windows 服务模板/任务、私有凭据、路径、进程树、Provider 隔离和渠道主路径测试。
- [ ] 发布候选在真实 Windows 主机完成安装、重启、Doctor、Remote TUI、三个渠道和至少两个 Provider
  的人工验收，并保存不含凭据的记录。
- [ ] 只有全部门槛通过后才更新 README 平台徽章、要求、安装/更新/卸载说明、`docs/source-install.md`、
  发布说明、模块索引和 Doctor 文案。
- [ ] npm 包在 Windows 能力未完成时继续明确报未支持；完成后再决定是否增加 `os` 元数据或平台安装
  预检，不用包元数据代替运行时 Doctor。

验收门槛：Windows CI 是必过项，真实候选验收可复现，Linux/macOS 完整门禁继续通过；发布说明准确
区分前台预览、后台正式支持和仍未支持的边界。

## 共享验收矩阵

| 链路 | 必须验证的 Windows 行为 |
| --- | --- |
| App Server | 精确版本、初始化一次、主/Provider 隔离实例、重连、共享 Thread、128 MiB 上限、关闭清理 |
| Remote TUI | 官方与第三方 Profile、工作目录、Sandbox、审批、模型和思考等级与渠道一致 |
| Gateway | 单实例、配置热重载、Surface 顺序、过载、STOP、优雅关闭、异常恢复 |
| Provider | OpenAI/DeepSeek/OpenCode Go/自定义第三方路由、代理、超时、有限重试、指标归属 |
| 私有数据 | 当前 SID 隔离、原子替换、损坏拒绝、凭据撤销、数据库和备份权限 |
| 服务 | 安装、状态、日志、启动、停止、重启、系统重启、更新恢复、卸载 |
| 渠道 | Telegram、飞书、微信的授权、收发、媒体、审批、追加、完成和计划任务投递 |
| CLI | PowerShell、Windows Terminal、空格路径、盘符、UNC、npm `.cmd` shim、JSON 输出与中文文案 |

## 停止条件

出现以下任一情况时，停止扩大实现并回到设计审查：

1. 固定版上游无法在 Windows 提供可共享且有安全边界的 App Server Transport。
2. 需要复制 App Server 的 Thread/Turn/审批状态机才能让 Gateway 连接。
3. Windows 私有文件或 IPC 无法证明只允许当前用户，且只能通过放宽安全默认值运行。
4. 需要管理员权限才能完成所有前台主路径，而没有可用的普通用户方案。
5. Windows 改动要求降低 Linux/macOS 现有 Socket、凭据、进程或服务安全检查。
6. 真实合同只能依赖官方未支持的实验 Transport，且没有明确接受该风险的独立决策。

## 回滚与兼容

- 阶段一至四不改变 SQLite Schema，Windows 失败可停用新平台适配器并保留用户数据。
- 新凭据格式必须带独立版本和后端标识；写入前保留可恢复状态，失败不删除旧记录。
- Unix 默认 Transport、Socket 路径和服务模板保持不变；Windows 代码不能改变已有 macOS/Linux 配置
  的解析结果。
- 公开配置一旦新增字段，必须说明默认值、跨平台含义、升级处理和回滚；阶段零前不新增。
- Windows 服务卸载不删除配置和数据；版本回退遇到新格式时必须明确拒绝，不能隐式降级或丢弃。

## 接力规则

每完成一个阶段或可验证小批次，立即更新本文状态、复选框、采用/拒绝决策和真实验证命令。上下文
切换后先读取本文、当前工作区差异、`docs/index.md`、`runtime/README.md`、`scripts/README.md`、
`src/codex-client/README.md` 和相关测试，再继续下一项。阶段零没有完成前不得开始批量加入 `win32`
分支；阶段六没有完成前不得修改公开支持范围或发布 Windows 正式版。
