# 共享运行时基础设施

本目录保存 npm CLI 与已编译 Gateway 必须直接共享的稳定 JavaScript 模块，不承载会话业务。

- `model-name-comparison.mjs` / `model-name-comparison.d.mts`：CLI 与 WebUI 共用的请求/响应模型名称对照；区分一致、不一致和信息不足，不推断模型身份或别名。

- `config-event-queue.mjs`：以有界、版本化、原子更新的队列保存待投递配置事件。
- `config-event-queue.d.mts`：声明配置事件队列共享模块的 TypeScript 接口。
- `gateway-config.mjs`：安全解析、严格校验 Telegram、飞书私聊与微信私聊配置，并提供复用同一
  子 Schema 的严格 `[codex]` 局部校验；在保留已有注释的前提下合并缺失的 Schema 安全默认值，
  所有基于已读取文档的写入在同一同步配置文件锁内复核原文后再执行私有文件原子替换；需要同时
  更新 Gateway 配置与直接 API 凭据的同步管理事务复用该可重入锁，异步操作必须使用独立事务锁，
  拒绝并发覆盖，
  并以 `0600` 权限写入 CLI、脚本和 Gateway 共享的 TOML 配置。
- `gateway-config.d.mts`：声明共享 TOML 配置模块的 TypeScript 接口。
- `network-proxy.mjs`：按 TOML、标准环境变量和受支持系统代理的顺序解析统一代理环境，只返回
  实际解析出的大小写代理变量；集中按目标协议选择、校验 HTTP(S) 客户端代理并匹配
  `NO_PROXY`。系统自动发现只覆盖 macOS 和 GNOME；Windows 明确不读取 WinINET/WinHTTP，使用 TOML
  或标准代理环境变量。渠道显式代理优先于共享代理和 `NO_PROXY`。App Server 服务持有的刷新选择器
  会在启动时先校验当前目标的代理 URL，再缓存一次选择；Provider 上游连接失败后使缓存失效，让
  下一次请求异步重新读取系统代理，并发请求共享在途查询；服务停止时取消查询，关闭后不再选择路由。
  请求路径与持续观察复用异步 macOS/GNOME 查询，整轮截止时间为 2 秒。底层读取失败向调用方报告；
  观察器保留上次结果，选择器沿用启动发现的可选系统设置语义（如无 GNOME 的 Linux），但不吞掉关闭取消。
- `network-proxy.d.mts`：声明共享代理解析模块的 TypeScript 接口。
- `proxy-fetch.mjs` / `proxy-fetch.d.mts`：把共享 HTTP(S) 代理选择适配为 Fetch；命中
  `NO_PROXY` 时直连，否则按代理 URL 复用 Undici Dispatcher，供 Gateway 与 App Server 服务 Runtime
  共同使用。
- `model-provider-definitions.mjs` / `model-provider-definitions.d.mts`：集中保存编译期内置第三方
  Provider 的非敏感固定定义，供 Setup、CLI、Runtime 与 Bootstrap 复用；不包含 API Key。
  `loadManagedModelProviderDefinitions` 按定义的实例适配器保留所有单实例 Provider，并从 OpenCode
  Go 账户注册表动态生成 `ocg-<账户>` 实例；能力元数据固定声明实例展开、模型目录来源与
  更新、账户能力，允许显式无更新/无账户能力。账户实例继承共享定义；
  `loadManagedModelProviderWatcherDefinitions` 额外保留未配置的共享目录，watcher 再按 Provider ID
  合并并去重文件路径。
- `opencode-go-accounts.mjs` / `opencode-go-accounts.d.mts`：OpenCode Go 账户注册表
  （`accounts.json`）、账户目录与管理标记，以及已注册旧账户到 `ocg-<账户>` 与
  `sf-ocg-<账户>` 的迁移；默认账户只由注册表标记决定。Key 不进入注册表，邮箱或手机号仅用于本机展示。
- `model-provider-profile.mjs` / `model-provider-profile.d.mts`：按编译期 Provider 定义生成隔离的
  私有 Profile、Provider 配置和管理标记，并为自定义主 Provider 提供共享的块字段构造与
  config 编辑映射；DeepSeek、OpenCode Go 与自定义 Provider 共用一次 HTTP 重试、零次流重连的
  故障边界，避免 Codex 默认两层重试相乘；OpenAI 官方 Provider 保持 Codex 原生策略。
- `opencode-go-quota-windows.mjs` / `opencode-go-quota-windows.d.mts`：为 OpenCode Go 统计代理
  提供官方 5 小时/7 天/月度配额窗口 `resetsAt` 快照；按最早 `resetsAt` 失效前缓存，失败时短时
  退避后重试，缺失或已过期的重置时间同样短时退避，避免每个模型请求重复查询；接受代理生命周期
  取消信号，快照随请求指标写入指标库供账户用量按周期归属本地 Token。
- `model-provider-runtime.mjs` / `model-provider-runtime.d.mts`：保留受控模型 Provider 运行时的稳定
  导出门面与 TypeScript 接口，不承载具体读取、写入或启动逻辑。
- `model-provider-managed-runtime.mjs`：通过受控 Provider 描述读取 Setup 管理标记和私有 Profile；
  管理每个受管 Provider 的独立模型目录，按模型读取或写入当前上下文、最大上下文与默认思考等级。
  历史目录中的自动压缩阈值只用于迁移为上下文窗口，当前目录不再管理压缩阈值；受管 Profile 必须
  镜像所选模型的默认思考等级。Profile 位于 `~/.codex`，模型目录、清单与管理标记位于
  `~/.codex-connect/providers/<id>/`。
- `model-provider-custom-runtime.mjs`：拥有自定义主 Provider 候选备份和切换模式注册表，逐 Provider
  管理 `sf-custom-<id>` 私有 Profile；仅接受 Codex 官方模型目录来源，并严格限制为单个目标 Provider
  块和直接 API Key 字段。服务启动时通过配置的 Codex CLI 执行 `debug models --bundled`，把官方目录
  原子写入 `~/.codex-connect/providers/custom/official-models.json`（0600）；注册表与 Profile 的增删改
  共用私有文件锁并支持执行前快照保护，Provider 块与 Key 不进入主配置。
- `model-provider-startup-runtime.mjs`：判定切换/固定模式的主 Provider，派生私有 Provider Socket，
  为不支持 Profile 选择器的 App Server 生成非敏感 `-c` 覆盖，并只把当前 Provider 的 Key 注入目标
  子进程环境；读取并校验已有 OpenAI 上游地址，为统计代理替换 Provider 地址，同时统一 DeepSeek、
  OpenCode Go 与共享第三方子代理的凭据和角色配置读取。全部第三方 Provider 沿用一次 HTTP 重试、
  零次流重连的固定边界。
- `app-server-read.mjs`：连接本机 Codex App Server 并完成 `initialize` 握手，返回 App Server
  生成的完整 `User-Agent`；供 Doctor 的版本核验复用，Windows 使用已构建的 `codex-client`
  传输，其余平台走私有 Unix WebSocket，不承担会话业务。Doctor 以官方非全局客户端身份
  `codex_app_server_daemon` 握手，不改变 App Server 进程级 originator 或 UA 后缀。
- `desktop-app-bridge.mjs` / `desktop-app-bridge.d.mts`：在 Windows 功能显式启用时，为 Codex Desktop App
  提供只绑定 `127.0.0.1` 的受令牌保护 WebSocket 桥；每个下游连接复用现有跨平台 App Server
  Transport 与主 Provider 租约，只转发有序文本帧，不解析 JSON-RPC 或保存会话状态。Windows
  仍在锁定 Codex CLI 的裸字节 `app-server proxy --sock` 之上建立 WebSocket 并连接私有 UDS；同一
  模块还供 macOS 受管入口把 Desktop JSONL stdio 与 Unix WebSocket 文本帧按消息边界双向转换。
- `desktop-app-host.mjs` / `desktop-app-host.d.mts`：只在 macOS Desktop Host 租约附加时校验当前
  用户私有工具 Pipe、正式 ChatGPT Bundle 的 OpenAI 签名 Node、项目锁定版本的 OpenAI 签名
  Codex 原生可执行文件，并用签名 Node 托管原主 App Server；只接受 Desktop 明确传入的内置插件
  布尔启用值，动态 Pipe 与附加状态不落盘。
- `terminal-identity.mjs`：按当前锁定 Codex CLI 的终端探测顺序从进程环境推导模型上游
  `User-Agent` 的终端标识（`TERM_PROGRAM[/版本]` 优先，其次各终端专有变量，最后 `TERM`），
  只读环境、不执行子进程；`detectTerminalUserAgentToken` 复现官方取值，供“一键设为官方 TUI
  身份”的 UA 文本使用，`detectTerminalIdentity` 只在结果可作为 `[codex].terminal_identity`
  记录时返回，供安装、更新服务的命令与 `codexc config` 复用。
- `app-server-runtime.mjs` / `app-server-runtime.d.mts`：从当前 TOML、数据目录和 Provider
  配置一次性派生主 Socket、受管或自定义切换 Provider Socket 与 Supervisor 拓扑，供启动、Doctor、远程终端
  和服务安装入口复用；Windows 同时校验最终 UDS 路径长度，避免各入口独立解释运行拓扑。
- `app-server-service-runtime.mjs`：持有内部 App Server 服务入口的 Provider 统计代理、主实例与隔离
  实例子进程、按需启动/释放、Supervisor、可选 Desktop App 桥和退出清理生命周期；启动 App Server 时
  用 `--enable runtime_metrics` 打开客户端特性，使上游 timing 事件由 App Server 自己请求、代理原样
  透传。Provider Proxy 在每次出站请求时使用当前缓存的代理路由；
  上游连接失败会使系统代理发现结果失效，下一次请求可采用代理软件启动后才写入的系统代理，无需重启
  模型代理。App Server 自身发出的账户额度请求不经过 Provider Proxy；Gateway 的系统代理观察器仅
  提示操作者在所有客户端任务结束后重新启动 Gateway 与 App Server，不自动刷新子进程环境。TOML 和标准代理环境
  变量仍保持最高优先级。CLI 与脚本只负责准备已校验的运行环境和默认 Workspace。
- `gateway-service-runtime.mjs`：持有内部 Gateway 服务子进程及其 reload、终止、退出信号转发；受管服务
  启动前的 App Server 就绪等待由服务命令脚本注入。
- `private-ipc.mjs` / `private-ipc.d.mts`：为 Gateway Owner、App Server Supervisor 和 Provider
  Metrics 提供共享的当前用户私有 IPC。Unix 保留 `0600` Socket、属主和 inode 清理合同；Windows
  使用默认仅创建用户与管理员可访问的命名管道，并在当前 SID 私有描述文件中保存随机管道名和随机
  认证令牌，连接首帧必须认证，关闭时只删除当前所有者发布的描述文件。
- `app-server-supervisor.mjs`：以当前用户私有 IPC 持有 App Server 监管入口互斥锁，
  对前台启动器公开有界、版本化的 Provider 拓扑身份，并提供主 App Server 与受控 Provider 的按需
  启动、释放与 Remote TUI 生命周期租约（`ensureProvider` / `releaseProvider` / `leaseProvider`），
  并为 macOS Desktop 受管 stdio Proxy 提供带独立能力版本的可信 Host 租约；该租约阻止主实例被
  空闲释放，最后一个租约关闭后清除未来启动所用的临时 Pipe 附加状态；
  拓扑同时区分已配置、运行中、主动释放和持有租约的实例。租约由私有 Socket 连接持有，断开时自动撤销，
  存在租约时拒绝释放；同一实例的启动、释放与租约获取串行执行，释放结果明确区分已释放、
  租约占用和实例未运行，启动、释放与账户删除遇到旧版或无效监管响应时失败关闭并提示重启服务。
  Gateway 还据此避免把主动释放
  误判为意外断线。入口集中检查真实 WebSocket 健康状态，拒绝
  未受监管的活动 App Server；Windows 通过官方 `app-server proxy` 检查 UDS 健康并把失效 rendezvous
  留给固定版 App Server 原地恢复，Unix 继续安全保留失效 Socket；关闭时主动清理已接入连接，不因本地客户端
  保持连接而阻塞服务退出，同时等待已经开始的 Provider 生命周期操作收尾且拒绝启动排队操作。
- `provider-proxy-runtime-registry.mjs` / `provider-proxy-runtime-registry.d.mts`：按共享代理键合并并发
  启动，保存已启动代理及其 Provider 使用者，并提供统一查询、移除和关闭遍历入口，避免 OpenCode Go
  多账户同时启动时重复创建或过早关闭共享代理。
- `app-server-supervisor.d.mts`：声明 App Server 监管拓扑与健康检查接口。
- `gateway-owner.mjs` / `gateway-owner.d.mts`：按当前配置文件持有独立于 Provider 和指标通道的
  私有 Gateway 所有权 IPC，保证同一配置只能运行一个 Gateway，并安全清理失效入口；所有权
  建立与应用就绪使用不同状态，应用开始停止时立即撤销就绪；公开同源健康探针供本地更新确认
  Gateway 已完成应用启动且尚未进入关闭流程。
- `gateway-account-refresh.mjs` / `gateway-account-refresh.d.mts`：提供独立的私有账户刷新 IPC；
  WebUI 只提交精确 Provider ID，Gateway 使用现有账户适配器和统一代理查询，并保持指标库单写入者；
  关闭时停止接收新连接并等待已开始的刷新收尾。
- `service-targets.mjs` / `service-targets.d.mts`：集中声明公开服务目标、systemd unit、launchd
  label、Windows 计划任务名称、核心服务范围和启停顺序，供 CLI、平台控制脚本、安装器与 Doctor
  复用。
- `process-lifecycle.mjs` / `process-lifecycle.d.mts`：统一判断子进程存活、向活动子进程转发信号、
  按温和终止、强制终止和有限终态等待关闭单个子进程；Windows 对调用方精确持有的 PID 使用系统
  `taskkill.exe /T` 终止该子进程树，避免批处理 Shim 退出后遗留 Codex 后代，且不扫描或结束其他 Codex
  进程；前台 `codexc start` 的父子 Node 进程先通过仅父子可用的 IPC 请求正常关闭 Gateway、Supervisor
  和私有端点，超时或 IPC 不可用时才回到精确 PID 树终止；多个 Windows Console 信号处理器并发终止
  同一进程树时，以精确 PID 已不存在作为完成结果；
  同时解释同步子进程的启动错误、退出码和终止信号，并成对安装或移除进程信号监听。App Server 服务
  入口收到退出信号后停止监管请求、等待已开始的
  Provider 操作，并对全部子进程执行有限终止。可标记失败已由子命令展示，避免嵌套 CLI 重复报错。
  具体关闭超时和资源清理仍由各生命周期所有者决定。
- `cli-presentation.mjs` / `cli-presentation.d.mts`：集中定义公开 CLI 的成功、失败、提示和处理
  状态标签、颜色、输出流路由和换行，Doctor 检查项另用通过；统一遵守 TTY 与 `NO_COLOR`，
  重定向输出保持纯文本。
- `executable.mjs` / `executable.d.mts`：统一选择配置或安装环境中的 Codex 路径，并从绝对/相对
  路径或受控 `PATH` 解析本机可执行文件；Windows 按大小写不敏感的环境变量键读取 `PATH`、`PATHEXT`
  和 `ComSpec`，选择原生可执行文件或 `.cmd` / `.bat` shim，并以结构化调用描述交给 Codex/npm 子进程
  入口，避免依赖 Shell 自动补后缀。供 CLI、Bootstrap、服务安装器和 Doctor 复用，不依赖平台固定
  位置的 `which`。
- `project-rules.mjs`：生成并检查项目级 Codex 命令规则；Gateway 使用精确 Workspace 根目录，
  并拒绝通过符号链接把写入转移到 Workspace 外；CLI 的 JSON 模式可静默底层 Codex 展示，普通模式
  继续原样转发检查输出。
- `project-rules.d.mts`：声明共享项目规则模块的 TypeScript 接口。
- `agent-roles.mjs`：读取 `~/.codex/config.toml` 的 `[agents]` 配置，返回带描述的子代理角色
  列表，供渠道 `/agents` 命令展示与调用；不含任何角色实现。
- `agent-roles.d.mts`：声明共享子代理角色配置模块的 TypeScript 接口。
- `codex-home.mjs` / `codex-home.d.mts`：统一解析 Codex 用户目录（`CODEX_HOME` 或
  `~/.codex`），并检测 Codex 官方鉴权文件 `auth.json` 是否存在，供 CLI、脚本、Runtime 与
  Bootstrap 复用。
- `thread-writer-lock.mjs` / `thread-writer-lock.d.mts`：定位并安全结束持有 Codex 线程写锁
  （`~/.codex/thread-writer-locks/<thread>.lock`）的本地进程；Linux 通过 `/proc` 按打开描述符
  与命令行识别持锁方，Windows 通过 PowerShell 7 调用 Restart Manager 按文件句柄取得 PID 与进程
  启动时间，并只展示可执行路径；`/release force` 只放行入口可执行文件为 `codex`、且发送终止前
  二次核验 PID 与启动时间均未变化的持锁方，供恢复诊断复用且不删除锁文件。
- `windows-thread-writer-lock.ps1`：Windows Thread Writer Lock 的 Restart Manager 适配器；返回文件
  持有进程的 PID、启动时间和可执行路径，并在终止前通过同一进程对象复核启动时间。
- `connect-home.mjs` / `connect-home.d.mts`：统一解析 Gateway 数据目录（`CODEX_CONNECT_HOME`
  或 `~/.codex-connect`），并提供受管第三方 Provider 存储根目录
  `providers/`，供 Setup、迁移脚本与 Runtime 复用。
- `private-file.mjs` / `private-file.d.mts`：为 App Server 无法管理的 Profile、模型目录、
  管理标记、子代理配置和可丢弃运行时缓存提供统一的新建 `0700` 父目录、`0600` 文件及随机临时
  文件原子替换；私有读取在同一描述符上使用 `O_NOFOLLOW`、`fstat` 校验普通文件、大小、权限与属主，
  避免路径校验后被符号链接替换；Windows 使用解析后的 PowerShell 7 `pwsh` 调用结构化 SID/ACL
  适配器，原子写入前同时收紧父目录，严格私有路径关闭继承，只允许当前 SID、SYSTEM 和
  Administrators 完全控制；状态库、任务库、指标库、媒体、渠道输出和受管备份复用同一合同；
  `~/.codex/config.toml` 的普通键级设置仍统一交给官方 `config/batchWrite`。
- `windows-private-acl.ps1`：Windows 私有路径 ACL 适配器；只从 stdin 读取固定 JSON 请求，通过 .NET
  ACL 类型设置或校验 Owner、访问规则、继承、文件类型与 reparse point，并返回结构化结果，不解析
  本地化命令输出。
- `private-file-lock.mjs` / `private-file-lock.d.mts`：为跨越异步配置事务的私有文件更新提供
  PID 所有权、陈旧锁回收和替换锁保护，锁目录与锁文件同样使用当前平台私有权限，供 Provider 管理与
  微信配置/凭据事务串行写入。
- `windows-dpapi.mjs` / `windows-dpapi.d.mts` / `windows-dpapi.ps1`：通过 PowerShell 7 调用
  `ProtectedData` 的 `CurrentUser` 作用域保护和解保护小型二进制主密钥；只接受 Base64 JSON stdin/stdout，
  不把输入或底层异常写入日志。
- `windows-secure-record.mjs` / `windows-secure-record.d.mts`：Windows 版本化安全凭据记录；每个凭据
  目录持有一个 DPAPI 保护的随机 256-bit 主密钥，记录继续使用随机 IV 的 AES-256-GCM，文件名只含
  记录键摘要，目录和文件同时复用当前 SID 私有 ACL 与原子替换。
- `workspace-permission.mjs` / `workspace-permission.d.mts`：统一 Workspace 的 Sandbox、审批策略
  与 Permission Profile 更新及互斥规则，供 CLI、Config 菜单和渠道写入适配器复用。

这里的模块同时被 `bin/`、`scripts/`、`src/config` 和 `src/bootstrap` 使用，必须保持无平台 SDK 依赖，并随 npm 包发布。
