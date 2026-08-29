# Windows 原生支持开发计划

本文记录 Codex Connect 在原生 Windows 上运行的事实边界、技术决策门槛、分阶段实现顺序和验收标准。
它是开发计划，不代表当前版本已经支持 Windows。公开支持范围仍以根目录 `README.md` 为准；在本文
全部发布门槛通过前，安装、Doctor 和文档必须继续明确拒绝或标记 Windows 未支持，不能以 npm 包能够
安装作为端到端可用的依据。

状态：待开始。当前仅完成 Linux/macOS 代码链路与锁定上游 `codex-cli 0.150.1` 的静态审查，尚未在
真实 Windows 主机完成 Transport、服务、凭据、进程树和发布验证。

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
- 进程停止以 Unix 信号和进程组为主；Windows 尚无完整子进程树所有权与终止合同。
- Thread Writer Lock 仅在 Linux 通过 `/proc/<pid>/fd` 定位持有者；Windows 无法可靠展示或释放持锁进程。

### 路径、命令与代理

- 可执行文件解析不处理 `PATHEXT`、`.cmd`、`.exe`、反斜杠、盘符和 UNC 路径的完整组合。
- npm 全局 `codex`、`codexc` 和 `npm` 在 Windows 上通常通过 `.cmd` shim 暴露。
- 自动系统代理发现只覆盖 macOS 和 Linux；显式 TOML 与标准代理环境变量虽可复用，但尚无 Windows
  WinINET/WinHTTP 读取与验收。

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
| Windows UDS + `codex app-server proxy` | 使用固定版正式 UDS；原生 TUI 可直接共享；Gateway 不依赖 Node 直接连接 Windows UDS | 必须验证 Proxy 在 Windows 的握手、关闭、重连、128 MiB 上限和多 Provider 行为；Gateway 需把子进程 stdio 包装为单条 Duplex | 首选验证 |
| 回环 WebSocket + Capability Token | Node 与原生 TUI 都能连接；健康检查和认证参数已存在 | 固定版官方明确标为实验且不受支持；端口、Token 生命周期和服务发现增加复杂度 | 仅作为首选失败后的候选，不直接生产采用 |
| 每个 Gateway 使用 stdio App Server | 跨平台最简单 | 单客户端语义破坏共享 App Server、Remote TUI、Provider 租约和独立生命周期 | 拒绝 |
| 无认证回环 WebSocket | 实现快 | 同机其他进程可控制 App Server，违反当前安全边界 | 拒绝 |
| Gateway 自行实现 App Server 或会话代理 | 可完全控制 Transport | 复制官方状态机与协议，维护和安全风险不可接受 | 拒绝 |

阶段零必须在结果文档中记录最终选择、原始错误、固定 CLI 版本和复验命令。若首选与候选都不能满足
安全、共享会话和稳定性要求，Windows 工作进入阻塞状态，不通过降级语义宣告支持。

## 分阶段实施

### 阶段零：真实 Windows Transport 探针

状态：待开始。

- [ ] 在受支持的 Windows 版本和 Node.js 22.13+ 上安装精确 `@openai/codex@0.150.1`。
- [ ] 启动 `codex app-server --listen unix://<绝对路径>`，验证 Windows UDS 创建、陈旧路径恢复与关闭清理。
- [ ] 使用原生 `codex --remote unix://<绝对路径>` 完成初始化、新建 Thread、Turn、审批和中断。
- [ ] 使用 `codex app-server proxy --sock <PATH>` 完成标准 WebSocket Upgrade、双向 JSON-RPC、断线、重连、
  最大消息和关闭测试。
- [ ] 同时启动主实例与至少一个 Provider 隔离实例，验证路径隔离、Thread 隔离和 Remote TUI 共享。
- [ ] 验证 Proxy 子进程崩溃、App Server 崩溃、客户端先关闭和服务重启四种清理顺序不遗留占用。
- [ ] 如果 Proxy 失败，再单独验证回环 WebSocket + Capability Token；不得验证无认证 TCP 作为候选。
- [ ] 写出采用/拒绝决策和可重复探针，不修改稳定业务代码。

验收门槛：至少一次真实 Windows 运行记录证明选定 Transport 支持 Gateway 和原生 TUI 共享同一 App
Server；失败路径有界结束，无悬挂请求、明文 Token、残留进程或错误 Thread 推断。

### 阶段一：平台运行时与内部 IPC

状态：等待阶段零。

- [ ] 把“App Server 端点”从裸 `socketPath` 收敛为平台无关描述，由组合根选择 Unix 或 Windows 实现。
- [ ] 保留现有 Unix WebSocket 实现和安全检查，不以 Windows 修改放宽 macOS/Linux 边界。
- [ ] 根据阶段零结论新增 Proxy Transport 或受认证 WebSocket Transport；连接仍复用 Base Transport 与
  JSON-RPC 层，不复制初始化和消息分流。
- [ ] 将 Gateway Owner、App Server Supervisor 和 Provider Metrics 的本地 IPC 收敛到共享端口。
- [ ] Windows 内部 IPC 使用命名管道或等价本地机制，并验证当前用户隔离、认证首帧、大小上限、超时、
  陈旧端点、占用、并发连接和所有者清理。
- [ ] Doctor 输出实际 Transport、端点健康和安全状态，但不得显示完整路径中的敏感随机材料或 Token。

验收门槛：主实例、多 Provider 实例、Supervisor 租约、Gateway 单实例和指标投递在 Windows 真实合同
中通过；Unix 现有测试和真实合同不变。

### 阶段二：路径、可执行文件和进程生命周期

状态：等待阶段一。

- [ ] 可执行文件解析支持 `PATHEXT`、`.exe`、`.cmd`、`.bat`、盘符、反斜杠、空格路径和 UNC 路径，
  并继续拒绝目录、缺失目标和不受支持的输入。
- [ ] 所有需要 npm 的子进程在 Windows 使用解析后的 `npm.cmd`，不依赖 Shell 自动补后缀。
- [ ] 建立平台进程树端口；Windows 使用可证明所有权的 Job Object 或经审查的精确 PID 树终止方式。
- [ ] STOP、超时、Gateway 关闭、Provider 释放和更新中断都必须终止属于本次运行的完整子进程树，不能
  杀死无关 `codex` 进程。
- [ ] 为 Thread Writer Lock 增加 Windows 持有者定位与脱敏命令展示；无法确认所有者时继续失败关闭。
- [ ] 系统代理支持显式配置和标准环境变量；是否加入 WinINET/WinHTTP 自动发现由独立探针决定，未实现
  时 Doctor 必须明确显示“未自动读取”，不能静默声称直连。

验收门槛：含空格的用户目录、npm shim、自定义 Provider、STOP、上游超时和异常退出均有 Windows
测试；运行结束没有遗留 App Server、Proxy 或 Provider Proxy。

### 阶段三：Windows 私有存储与凭据

状态：等待阶段一，可与阶段二后半部分并行。

- [ ] 定义当前 Windows SID 私有目录/文件的检查和原子写入合同，拒绝符号链接、危险 reparse point、
  非当前用户可写路径和无法确认 ACL 的目标。
- [ ] 评估 DPAPI、Windows Credential Manager 和受审查依赖；新增依赖、持久化格式与回滚方案须另行
  说明并取得确认。
- [ ] 首选使用 DPAPI 保护每个数据目录的随机主密钥，复用现有 AES-256-GCM 记录载荷和严格解析。
- [ ] 接入飞书用户 OAuth、微信 Bot 凭据、微信回复上下文及第三方 Provider API Key。
- [ ] 覆盖管理凭据、WebUI/指标 Token、配置、数据库、计划任务库、媒体临时文件、输出和备份的私有
  文件结果；不只修复渠道 Token Store。
- [ ] `codexc doctor` 校验 ACL、所有者、凭据后端和损坏状态，不读取或回显凭据正文。

验收门槛：凭据可跨 Gateway 重启恢复、撤销后不可恢复、损坏时失败关闭；另一普通 Windows 用户无法
读取或替换私有文件。迁移不是首期要求，不自动导入其他操作系统的 Keychain 或加密文件。

### 阶段四：前台 Windows 功能闭环

状态：等待阶段一至三。

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
