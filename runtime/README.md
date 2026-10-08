# 共享运行时基础设施

本目录保存 npm CLI 与已编译 Gateway 必须直接共享的稳定 JavaScript 模块，不承载会话业务。

- `request-timing.mjs` / `request-timing.d.mts`：指标 IPC、存储、CLI 与 WebUI 共用的生成区间校验和观测速度计算；无 I/O、不依赖调试转储。
- `auto-review-metadata.mjs` / `auto-review-metadata.d.mts`：Provider 指标与转储读取共用的自动审查来源、父任务及原始审查身份投影；只接受明确的 `guardian_review` 来源和有界标识，不读取文件或推断缺失归属。
- `auto-review-provider-policy.mjs` / `auto-review-provider-policy.d.mts`：按已验证的 Provider 模型目录来源统一判定自动审查准入；只允许官方 OpenAI 和复用官方模型目录的自定义 Provider，供设置入口与会话执行门禁共用，不根据模型名称或认证方式推断支持。严格读取用于执行门禁；管理设置投影将读取失败标记为不可用及安全原因，只限制开启，不阻断其他设置或关闭、清除覆盖。

- `openai-credentials.mjs` / `openai-credentials.d.mts`：有界读取当前 Codex Home 登录缓存，仅在账户 ID 与官方额度账户一致时返回 `last_refresh` 凭证刷新时间；不返回凭据、不刷新登录、不读取订阅日期。

- `model-name-comparison.mjs` / `model-name-comparison.d.mts`：CLI 与 WebUI 共用的请求/响应模型名称对照；区分一致、不一致和信息不足，不推断模型身份或别名。

- `config-event-queue.mjs`：以有界、版本化、原子更新的队列保存待投递配置事件。
- `config-event-queue.d.mts`：声明配置事件队列共享模块的 TypeScript 接口。
- `gateway-config.mjs`：安全解析、严格校验 Telegram、飞书私聊与微信私聊配置；只读设置入口复用完整当前版本和结构 Schema，不要求 Gateway 启动前至少启用一个渠道，原启动校验仍保留该前置条件。提供复用同一
  子 Schema 的严格 `[codex]`、`[gateway]` 局部校验；网关时区接受 `system` 或 Node.js 支持的 IANA 名称。
  在保留已有注释的前提下合并缺失的 Schema 安全默认值，
  所有基于已读取文档的写入在同一同步配置文件锁内复核原文后再执行私有文件原子替换；需要同时
  更新 Gateway 配置与直接 API 凭据的同步管理事务复用该可重入锁，异步操作必须使用独立事务锁，
  拒绝并发覆盖；写入者可指定 `maximumBytes`，在保留注释后、原子替换前检查完整文件大小，
  并以 `0600` 权限写入 CLI、脚本和 Gateway 共享的 TOML 配置。
- `gateway-config.d.mts`：声明共享 TOML 配置模块的 TypeScript 接口。
- `chat-reasoning.mjs` / `chat-reasoning.d.mts`：无 I/O 的精确 Chat 关闭思考能力表及额外模型思考声明类型，供配置、管理和模型 API 共用。
- `model-relay-config.mjs` / `model-relay-config.d.mts`：可选 Relay 严格配置、可选中文用途名称、仅结算使用的历史身份摘要、每 Key 多提供商模型授权、思考策略及仅全局限流策略投影；服务默认关闭和回环监听，允许显式 IPv4 内网/通配绑定、保留停用身份，不生成凭据；不接受旧 Relay 配置字段。
- `network-proxy.mjs`：按 Codex `.env`、标准环境变量和受支持系统代理的顺序解析统一代理环境，只返回
  实际解析出的大小写代理变量；集中按目标协议选择、校验 HTTP(S) 客户端代理并匹配
  `NO_PROXY`。Codex `.env` 或环境变量提供任一 HTTP、HTTPS 或 ALL 代理地址时跳过系统读取，不补齐其他字段；
  仅有 `NO_PROXY` 时仍允许系统发现。该判断由启动、请求路径和后台观察共用。
  系统自动发现只覆盖 macOS 和 GNOME；Windows 明确不读取 WinINET/WinHTTP，使用 Codex `.env`
  或标准代理环境变量。渠道显式代理优先于共享代理和 `NO_PROXY`。App Server 服务持有的刷新选择器
  会在启动时先校验当前目标的代理 URL，再缓存一次选择；Provider 上游连接失败后使缓存失效，让
  下一次请求异步重新读取系统代理，并发请求共享在途查询；服务停止时取消查询，关闭后不再选择路由。
  选择器的只读 revision 随显式失效或已解析代理设置变化递增，供 Relay 异步准备后的实际出站复核使用。
  周期 `refresh()` 与在途查询合并，相同设置不撤销请求；显式失效期间返回的旧查询结果不能被新调用者使用。
  请求路径与持续观察复用异步 macOS/GNOME 查询，整轮截止时间为 2 秒。底层读取失败向调用方报告；
  观察器保留上次结果，选择器沿用启动发现的可选系统设置语义（如无 GNOME 的 Linux），但不吞掉关闭取消。
- `codex-proxy-env.mjs` / `codex-proxy-env.d.mts`：共享代理文件的读取、字面值校验和原子更新，
  只处理 Codex Home `.env` 中四个代理字段，保留其他内容；CLI 与 WebUI 的写入与回滚复用共享文件锁并在锁内比较原文，拒绝并发覆盖；读取和保存均校验完整代理组合。
- `network-proxy.d.mts`：声明共享代理解析模块的 TypeScript 接口。
- `proxy-fetch.mjs` / `proxy-fetch.d.mts`：把共享 HTTP(S) 代理选择适配为 Fetch；命中
  `NO_PROXY` 时直连，否则按代理 URL 复用 Undici Dispatcher，供 Gateway 与 App Server 服务 Runtime
  共同使用。
- `model-provider-definitions.mjs` / `model-provider-definitions.d.mts`：集中保存编译期内置第三方
  Provider 的非敏感固定定义，供 Setup、CLI、Runtime 与 Bootstrap 复用；不包含 API Key。
  `webSearch` 声明受管实例是否在启动参数中关闭内置网页搜索，不改写基础配置或模型目录的客户端工具检索能力。
  CCG 采用显式多账户实例与 DS 来源目录，通过 Command Code 账户接口
  查询 Credits 与 5 小时/7 天窗口；模型 ID
  支持上游命名空间，凭据按 Bearer 格式校验。
  `loadManagedModelProviderDefinitions` 按定义的实例适配器保留所有单实例 Provider，并从 DS、OpenCode
  Go、CCG 与 CLP 账户注册表动态生成 `ds-<账户>`、`ocg-<账户>`、`ccg-<账户>` 与 `clp-<账户>` 实例；能力元数据声明实例展开与账户能力。CLP 显式声明 Chat 上游，各账户共享服务拥有的本地转换桥；账户实例继承共享定义，共享代理键不在展开结果中，`sharedManagedProviderDefinition` 是回退到基础定义的唯一入口；CLP 接受合法 `cline-pass/` 模型 ID，并按共享目录校验成员身份；
  共享定义只描述目录与能力，不包含单账户 Profile；`loadManagedModelProviderWatcherDefinitions`
  保留共享目录及当前账户，watcher 只为实际账户监听 Profile 和管理标记，再按 Provider ID 合并并去重路径。
- `deepseek-accounts.mjs` / `deepseek-accounts.d.mts`：DS 账户注册表、账户 ID、私有文件路径与凭据变量名；运行实例使用 `ds-<账户>`，共用 DS 目录。
- `cline-pass-accounts.mjs` / `cline-pass-accounts.d.mts`：CLP 账户注册表、默认账户、私有路径与凭据变量名；运行实例使用 `clp-<账户>`，共享模型目录和 Chat 转换代理。
- `cline-pass-model-guard.mjs` / `cline-pass-model-guard.d.mts`：CLP Chat 桥每次出站前异步复核共享 Codex 目录中的模型成员身份；不缓存名单、不读取账户凭据或 Relay 目录，限制并发、读取大小和等待时间，取消后保留读取槽直到资源清理完成。
- `cline-pass-coding-instructions.mjs`：项目维护的非 Flash CLP 通用编程提示词，生成共享模型目录时写入；不声明模型身份、不授予权限或工具能力，不依赖 DS 下载。
- `aggregate-model-provider.mjs` / `aggregate-model-provider.d.mts`：从至少两个已配置的 API Key 切换提供商派生 `codexc-aggregate`
  拓扑成员、模型 slug、目录与启动参数；保留各模型元数据，拒绝主配置的全局窗口覆盖，复核账户与
  目录快照；公开源文件清单与内容指纹供安全刷新使用，只写可重建、无密钥的运行时 `aggregate-models.json`，不改账户或存储契约。
- `aggregate-material-guard.mjs`：聚合实例拥有的有界工作线程；按去重文件清单校验私有权限与内容摘要，
  避免 Windows ACL 子进程阻塞模型转发和 Supervisor。取消等待不释放尚未完成的队列槽，实例释放时关闭线程。
- `ccg-accounts.mjs` / `ccg-accounts.d.mts`：CCG 账户注册表、默认账户、账户 ID、私有文件路径与凭据变量名；运行实例使用 `ccg-<账户>`，共用 CCG 目录与统计代理。
- `opencode-go-accounts.mjs` / `opencode-go-accounts.d.mts`：OpenCode Go 账户注册表
  （`accounts.json`）、账户目录与管理标记；默认账户只由注册表标记决定。Key 不进入注册表，邮箱或手机号仅用于本机展示。
- `managed-provider-account-options.mjs` / `managed-provider-account-options.d.mts`：CLI 和 WebUI 共用账户 ID 预设及新增输入校验，不访问文件或凭据。
- `managed-provider-account-registry.mjs` / `managed-provider-account-registry.d.mts`：复用 DS、OCG、
  CCG 的单一默认账户约束，并集中 DS/CCG 同构注册表记录与凭据变量冲突校验。
- `managed-provider-account-routing.mjs` / `managed-provider-account-routing.d.mts`：集中 DS、OCG、CCG、CLP 四家账户
  Provider 的账户 ID、共享统计代理键和同一家多账户默认选择；混合 Provider 不推断默认值。
- `model-provider-profile.mjs` / `model-provider-profile.d.mts`：按编译期 Provider 定义生成隔离的
  私有 Profile、Provider 配置和管理标记，并为自定义主 Provider 提供共享的块字段构造与
  config 编辑映射；DeepSeek、OpenCode Go、CCG 与自定义 Provider 共用一次 HTTP 重试、零次流重连的
  故障边界，避免 Codex 默认两层重试相乘；OpenAI 官方 Provider 保持 Codex 原生策略。
- `opencode-go-quota-windows.mjs` / `opencode-go-quota-windows.d.mts`：为 OpenCode Go 统计代理
  提供官方 5 小时/7 天/月度配额窗口 `resetsAt` 快照，以 `{ windows, observedAtMs }` 返回成功采样
  的窗口及本地接收时刻；缓存命中保持原时刻，真实请求成功后才更新。按最早 `resetsAt` 失效前缓存，失败时短时
  退避后重试，缺失或已过期的重置时间同样短时退避，避免每个模型请求重复查询；接受代理生命周期
  取消信号，快照随请求指标写入指标库供账户用量按周期归属本地 Token。
- `model-provider-runtime.mjs` / `model-provider-runtime.d.mts`：保留受控模型 Provider 运行时的稳定
  导出门面与 TypeScript 接口；`readManagedMarker` 提供单个 Provider 管理标记的只读查询，不读取其他账户注册表。门面不承载具体读取、写入或启动逻辑。
- `model-provider-relay-material.mjs`：公共 Relay 提供商发现与材料快照，复用受管及自定义 Provider 的注册、私有凭据和模型目录读取；提供原生协议集合、目录输入能力、CLP 独立转发目录与模型覆盖与思考声明、依赖路径和修订摘要，不读取 OAuth 或创建 App Server。
- `model-provider-managed-runtime.mjs`：通过受控 Provider 描述读取 Setup 管理标记和私有 Profile；
  管理每个受管 Provider 的独立模型目录，按模型读取或写入当前上下文、最大上下文与默认思考等级。
  自动压缩阈值保持上游原值，不参与上下文窗口换算；受管 Profile 必须
  镜像所选模型的默认思考等级。Profile 位于 `~/.codex`，模型目录、清单与管理标记位于
  `~/.codex-connect/providers/<id>/`。
- `model-provider-custom-runtime.mjs`：拥有 Codex 兼容／自定义 Responses Provider 候选备份和切换模式注册表，支持按目标 Provider 校验恢复状态，逐 Provider
  管理 `sf-custom-<id>` 私有 Profile；按 Provider 类型校验官方或独立 Responses 模型目录，并严格限制为单个目标 Provider
  块和直接 API Key 字段。注册表与 Profile 的增删改共用私有文件锁并支持执行前快照保护，
  Provider 块与 Key 不进入主配置。
- `model-provider-official-catalog.mjs`：独立管理 Codex 兼容 Provider 共用的官方模型目录；通过配置的
  Codex CLI 执行 `debug models --bundled`，校验后原子写入
  `~/.codex-connect/providers/custom/official-models.json`（0600），并统一注入 App Server 启动参数。
- `responses-context-sync.mjs` / `responses-context-sync.d.mts`：扩展现有 DS 目录与 Profile 事务，按模板关联同步 RS 与 CLP 上下文，保留私有恢复记录并提供整批恢复与预览目标。
- `model-provider-responses-catalog.mjs` / `model-provider-responses-catalog.d.mts`：校验手填模型定义、模板基础能力与最大上下文，生成版本化的独立目录，管理修订、私有备份与未完成写入标记；不保存凭据。
- `model-provider-startup-runtime.mjs`：判定切换/固定模式的主 Provider，派生私有 Provider Socket，
  为不支持 Profile 选择器的 App Server 生成非敏感 `-c` 覆盖，并只把当前 Provider 的 Key 注入目标
  子进程环境；读取并校验已有 OpenAI 上游地址，为统计代理替换 Provider 地址，同时统一 DeepSeek、
  OpenCode Go、CCG 的凭据读取。全部第三方 Provider 沿用一次 HTTP 重试、
  零次流重连的固定边界。
- `app-server-read.mjs`：连接本机 Codex App Server 并完成 `initialize` 握手，返回 App Server
  生成的完整 `User-Agent`；供 Doctor 的版本核验复用，Windows 使用已构建的 `codex-client`
  传输，其余平台走私有 Unix WebSocket，不承担会话业务。Doctor 以官方非全局客户端身份
  `codex_app_server_daemon` 握手，不改变 App Server 进程级 originator 或 UA 后缀。
- `desktop-app-bridge.mjs` / `desktop-app-bridge.d.mts`：在 Windows 功能显式启用时，为 Codex Desktop App
  提供只绑定 `127.0.0.1` 的受令牌保护 WebSocket 桥；每个下游连接复用现有跨平台 App Server
  Transport 与目标 Provider 租约，认证后只允许选择配置内的实例，只转发有序文本帧，不解析 JSON-RPC 或保存会话状态。Windows
  仍在锁定 Codex CLI 的裸字节 `app-server proxy --sock` 之上建立 WebSocket 并连接私有 UDS；同一
  模块还供 macOS 受管入口把 Desktop JSONL stdio 与 Unix WebSocket 文本帧按消息边界双向转换，
  连接前复用统一私有 Socket 校验，并使用校验后的物理目标。
- `desktop-app-host.mjs` / `desktop-app-host.d.mts`：只在 macOS Desktop Host 租约附加时校验当前
  用户私有工具 Pipe、正式 ChatGPT Bundle 的 OpenAI 签名 Node、项目锁定版本的 OpenAI 签名
  Codex 原生可执行文件，实际验证签名有效性及可信身份，并用签名 Node 托管选中的 App Server；
  Host 与原生子进程使用专属进程组，终止信号和超时强杀覆盖该组。只接受 Desktop 明确传入的内置插件
  布尔启用值，动态 Pipe 与附加状态不落盘。
- `terminal-identity.mjs`：按当前锁定 Codex CLI 的终端探测顺序从进程环境推导模型上游
  `User-Agent` 的终端标识（`TERM_PROGRAM[/版本]` 优先，其次各终端专有变量，最后 `TERM`），
  只读环境、不执行子进程；`detectTerminalUserAgentToken` 复现官方取值，供“一键设为官方 TUI
  身份”的 UA 文本使用，`detectTerminalIdentity` 只在结果可作为 `[codex].terminal_identity`
  记录时返回，供服务安装命令与 `codexc config` 复用。
- `app-server-runtime.mjs` / `app-server-runtime.d.mts`：从当前 TOML、数据目录和 Provider
  配置一次性派生主 Socket、受管或自定义切换 Provider Socket 与 Supervisor 拓扑，供启动、Doctor、远程终端
  和服务安装入口复用；Windows 同时校验最终 UDS 路径长度，避免各入口独立解释运行拓扑。
- `app-server-service-runtime.mjs`：持有内部 App Server 服务入口的 Provider 统计代理、主实例与隔离
  实例子进程、按需启动/释放、Supervisor、可选 Desktop App 桥和退出清理生命周期；不额外打开 Codex
  特性，也不改写上游私有请求头。Provider Proxy 在每次出站请求时使用当前缓存的代理路由；
  上游连接失败会使系统代理发现结果失效，下一次请求可采用代理软件启动后才写入的系统代理，无需重启
  模型代理。App Server 自身发出的账户额度请求不经过 Provider Proxy；Gateway 的系统代理观察器仅
  提示操作者在所有客户端任务结束后重新启动 Gateway 与 App Server，不自动刷新子进程环境。Codex `.env` 和标准代理环境
  变量仍保持最高优先级。CLI 与脚本只负责准备已校验的运行环境和默认 Workspace。
  受管 Provider 设置应用只刷新目标实例的启动参数与私有环境；释放运行实例前通过临时 Client
  读取全部已加载 Thread 的权威状态，并复核租约与取消。活动任务、原生租约和读取失败均阻止重启；
  已开始释放后完成目标恢复，恢复失败保留重试意图并如实标记未运行；原本未运行实例只刷新材料。
  账户拓扑变化仍要求显式服务管理。
  宿主仅在内存持有管理标记、实际 Profile 与模型目录内容的已应用指纹及该代默认模型；Gateway 重建时可重新核对，
  相同内容返回 `changed: false` 并保持现有连接，读取期间或重启期间的新变化不会冒充已应用。
  普通按需启动同样重读并校验目标材料，实例就绪后才确认基线；运行实例不会因 ensure 被自动重启。
  释放子进程即失效其基线，后续原生租约启动采用新材料；释放后调用方取消仍完成恢复并记录实际成功的基线。
- `gateway-service-runtime.mjs`：持有内部 Gateway 服务子进程及其 reload、终止、退出信号转发；受管服务
  启动前的 App Server 就绪等待由服务命令脚本注入。
- `app-server-unix-socket.mjs` / `app-server-unix-socket.d.mts`：校验固定 CLI 的 Unix rendezvous 链接、规范路径 SHA-256、受保护目录及真实 Socket 的权限和属主；Transport 与监管探测共用，连接仅使用校验后的物理路径，失效链接保留时不操作其目标。
- `private-ipc.mjs` / `private-ipc.d.mts`：为 Gateway Owner、账户操作、Delivery 控制、Relay 控制与指标、
  队列通知、Provider Metrics 和 App Server Supervisor 提供共享的当前用户私有 IPC。
  Unix 在同目录临时名字上监听，设置 `0600` 后通过独占硬链接发布原端点；绑定名保留到监听关闭，
  防止其他实例提前复用该名字后被旧监听删除。正常关闭清理绑定名与仍归自身所有的公开端点，
  避免 Node/libuv 关闭时按公开路径自动删除替代文件；公开端点仍按属主与 inode 检查管理。
  临时路径不长于原路径；公开 Unix 路径拒绝 NUL，Linux 最多 107 字节、macOS 最多 103 字节，避免发布不可连接的长端点。
  发布竞争不覆盖已有端点，不支持 Socket 硬链接的文件系统明确启动失败。
  异常退出可能留下绑定名及公开端点；公开端点沿既有占用探测恢复，不扫描删除无法证明归属的随机名字。
  Windows 使用默认仅创建用户与管理员可访问的命名管道，并在当前 SID 私有描述文件中保存随机管道名和随机
  认证令牌，连接首帧必须认证，关闭时只删除当前所有者发布的描述文件。
  Relay 指标与控制查询共用单次 JSON 请求生命周期：调用方指定回应字节上限、绝对截止时间及可选取消信号，
  统一关闭连接和清理等待，不重试；业务版本、关联 ID、确认结果和持久化含义由调用方验证。
- `app-server-supervisor.mjs`：以当前用户私有 IPC 持有 App Server 监管入口互斥锁，
  各平台监听与端点清理统一委托 `private-ipc.mjs`；关闭仍先销毁租约连接，再等待在途 Provider 操作，关闭后拒绝重启同一 Owner。
  对前台启动器公开有界、版本化的 Provider 拓扑身份，并提供主 App Server 与受控 Provider 的按需
  启动、释放与 Remote TUI 生命周期租约（`ensureProvider` / `releaseProvider` / `leaseProvider`），
  并为 macOS Desktop 受管 stdio Proxy 提供带独立能力版本的可信 Host 租约；全局串行附加到选中的 Provider，该租约阻止目标实例被
  空闲释放，最后一个租约关闭后清除未来启动所用的临时 Pipe 附加状态；
  拓扑同时区分已配置、运行中、主动释放和持有租约的实例。租约由私有 Socket 连接持有，断开时自动撤销，
  存在租约时拒绝释放；同一实例的启动、释放与租约获取串行执行，释放结果明确区分已释放、
  租约占用和实例未运行，启动、释放与账户删除遇到旧版或无效监管响应时失败关闭并提示重启服务。
  `applyProviderSettings` 使用独立能力版本，在相同 Provider 队列内执行有界设置应用；返回已应用或
  租约／任务占用。调用方断开会取消准备，已经释放的实例仍由 Owner 完成恢复；旧宿主缺少能力时
  明确失败，不回退到全局重启。租约在排队前登记，异步检查期间的新租约同样阻止应用。
  应用及占用结果可附宿主已确认的 `snapshot`（指纹与默认模型）；未确认时省略，不从新磁盘设置推断旧实例默认值。
  `readAppServerProviderSettingsFingerprint` 提供同源只读指纹比较，供调用方关联一次捕获的目录；IPC 不保存或返回目录副本。
  Gateway 还据此避免把主动释放
  误判为意外断线。入口集中检查真实 WebSocket 健康状态，拒绝
  未受监管的活动 App Server；Windows 通过官方 `app-server proxy` 检查 UDS 健康并把失效 rendezvous
  留给固定版 App Server 原地恢复，Unix 继续安全保留失效 Socket；关闭时主动清理已接入连接，不因本地客户端
  保持连接而阻塞服务退出，同时等待已经开始的 Provider 生命周期操作收尾且拒绝启动排队操作。
- `provider-proxy-runtime-registry.mjs` / `provider-proxy-runtime-registry.d.mts`：按共享代理键合并并发
  启动，保存已启动代理及其 Provider 使用者，并提供统一查询、移除和关闭遍历入口，避免 DS、OpenCode Go
  与 CCG 多账户同时启动时重复创建或过早关闭共享代理。
- `app-server-supervisor.d.mts`：声明 App Server 监管拓扑与健康检查接口。
- `gateway-owner.mjs` / `gateway-owner.d.mts`：按当前配置文件持有独立于 Provider 和指标通道的
  私有 Gateway 所有权 IPC，保证同一配置只能运行一个 Gateway，并安全清理失效入口；所有权
  建立与应用就绪使用不同状态，应用开始停止时立即撤销就绪；公开同源健康探针供本地更新确认
  Gateway 已完成应用启动且尚未进入关闭流程。
- `queue-events.mjs` / `queue-events.d.mts`：投递箱、Relay、账户快照与请求指标共用的有界私有变化通知流；独立订阅连接、首次失效通知、100 毫秒合并、心跳、取消与背压清理，只传变化类型。
- `metrics-events.mjs` / `metrics-events.d.mts`：按配置文件路径派生相互独立的请求指标与账户快照通知端点，供 Gateway 写入器与 WebUI 订阅共用；不携带指标或账户数据。
- `delivery-control.mjs` / `delivery-control.d.mts`：投递箱私有在线管理与变化通知 IPC（`watchDeliveryChanges`）；Unix 使用系统 `/tmp` 规范目录下的当前用户私有短目录，以投递目录规范路径的 SHA-256 确定端点，连接前校验父目录及 Socket 所有者和权限；Windows 继续使用私有描述文件及认证管道。最多 50 条修订绑定的重试/忽略请求，限制连接数、报文大小和等待时间；只输出受控结果，已发送请求的响应丢失不允许离线回退或自动重试。
- `gateway-account-refresh.mjs` / `gateway-account-refresh.d.mts`：提供 v2 私有账户 IPC，支持 Provider 刷新及 OpenAI 重置券列表、预览、取消和消费；
  WebUI 提交精确 Provider ID、券 ID 或短期操作 ID，Gateway 使用现有账户适配器和统一代理查询，并保持指标库单写入者；
  公开错误文案按受控原因生成，不透传内部 message；调用方取消或连接结束时取消该等待，
  关闭主动取消刷新并释放 IPC 任务，不等待不响应取消的回调。
- `service-targets.mjs` / `service-targets.d.mts`：集中声明公开服务目标、systemd unit、launchd
  label、Windows 计划任务名称、核心服务范围和启停顺序，供 CLI、平台控制脚本、安装器与 Doctor
  复用。
- `process-lifecycle.mjs` / `process-lifecycle.d.mts`：统一判断子进程存活、向活动子进程转发信号、
  按温和终止、强制终止和有限终态等待关闭单个子进程；显式注册的 Unix 独立进程组用于 Desktop
  Host 及其原生子进程的共同终止，其他子进程仍按原 PID 处理。Windows 对调用方精确持有的 PID 使用系统
  `taskkill.exe /T` 终止该子进程树，避免批处理 Shim 退出后遗留 Codex 后代，且不扫描或结束其他 Codex
  进程；前台 `codexc run` 的父子 Node 进程先通过仅父子可用的 IPC 请求正常关闭 Gateway、Supervisor
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
- `agent-roles.mjs`：读取 `~/.codex/config.toml` 的 `[agents]` 配置，返回带描述的子代理角色
  列表，供渠道 `/agents` 命令展示与调用。
- `agent-roles.d.mts`：声明原生子代理角色查询模块的 TypeScript 接口。
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
  `providers/`，供 Setup 与 Runtime 复用。
- `private-file.mjs` / `private-file.d.mts`：为 App Server 无法管理的 Profile、模型目录、
  管理标记和可丢弃运行时缓存提供统一的新建 `0700` 父目录、`0600` 文件及随机临时
  文件原子替换；私有读取在同一描述符上使用 `O_NOFOLLOW`、`fstat` 校验普通文件、大小、权限与属主，
  避免路径校验后被符号链接替换；Windows 使用解析后的 PowerShell 7 `pwsh` 调用结构化 SID/ACL
  适配器，单次调用超过 2 秒即终止并拒绝操作；原子写入前同时收紧父目录，严格私有路径关闭继承，只允许当前 SID、SYSTEM 和
  Administrators 完全控制；状态库、任务库、指标库、媒体、渠道输出和受管备份复用同一合同；
  App Server Socket 目录通过 `secureAppServerSocketDirectorySync` 将已受信任目录收紧为锁定 CLI 要求的单条当前 SID 可继承完全控制权限；其他目录写入与父目录读取接受并保留此更严格权限，不向 Socket 目录重新添加 SYSTEM/Administrators。
  `~/.codex/config.toml` 的普通键级设置仍统一交给官方 `config/batchWrite`。
  `WindowsPrivatePathError` 区分 ACL 检查超时、输出超限、进程启动失败和检查进程失败，附有界路径及操作类型；结构化拒绝只展示允许列表内的原因和阶段，不透传原始 PowerShell 异常或输出；服务定义读取保留该诊断。
  `repairWindowsPrivateFileSync` 仅供显式 `security repair` 使用：管理员所有的普通文件须有当前 SID 完全控制且无拒绝规则，才能恢复当前用户所有权；常规读取和写入不放宽所有者校验。
  Codex Home 顶层 TOML 的所有者、继承和访问规则拒绝会附带修复命令；目录、进程故障与修复操作自身失败不误报同一建议。
  异步配置读取额外只读校验父目录，检测读取期间变化；Windows 在同一次异步调用中持有禁止写入和替换的只读文件句柄并检查文件、父目录 ACL，不修复权限、不缓存校验结果，支持取消及有界读取。默认读取上限仍为 1 MiB，CLP 模型目录可显式选择不超过 2 MiB 的上限，两平台使用同一字节限制。
- `windows-private-acl.ps1`：Windows 私有路径 ACL 适配器；stdin/stdout 明确使用 UTF-8，不继承控制台代码页；只读取固定 JSON 请求，通过 .NET
  ACL 类型设置或校验 Owner、访问规则、继承、文件类型与 reparse point，并返回结构化结果，不解析
  本地化命令输出。写操作按绝对路径使用有界命名 Mutex 串行化 ACL 识别与更新，避免并发写入重新放宽 Socket 目录权限。
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

这里的模块同时被 `bin/`、`scripts/`、`src/config` 和 `src/bootstrap` 使用，必须保持无平台 SDK 依赖，并随本地 npm 打包产物安装，不向 npm Registry 发布新版本。

- `model-relay-control.mjs` / `model-relay-control.d.mts`：独立 Relay 的 v6 私有状态（含队列等待时长、超时计数及采集状态）/配置摘要确认 IPC，另提供只读 queue 操作（携带运行配置、启用、监听状态、用途名称及必需的可空入站思考等级，最多 64 行、128 KiB 响应），有界连接、帧和等待，不传递秘密；拒绝旧版本和旧队列行结构，更新后须正常重启 Relay 和 WebUI。独立 `.events` 端点推送队列变化，订阅不占用管理命令连接。
- `model-relay-model-id.mjs` / `model-relay-model-id.d.mts`：公共调用 ID 的解析与目录映射，CLP 对外去掉上游前缀，保留出站精确原始 ID。
- `model-relay-listen-host.mjs` / `model-relay-listen-host.d.mts`：配置与 HTTP 服务共用的纯监听地址校验，接受回环、RFC1918 IPv4 和显式 IPv4 通配地址，不解析 DNS 或选择网卡。
- `model-relay-paths.mjs` / `model-relay-paths.d.mts`：按配置路径派生控制与指标端点。
- `model-relay-material-reader.mjs` / `model-relay-material-worker.mjs`：单 Worker 按固定用途读取 Provider 材料或指标身份快照；串行、可取消、有界，不阻塞调用线程。指标身份准备限时 750 毫秒，不返回凭据或身份哈希。配置两次读取间发生原子替换时丢弃快照并完整重读一次，持续变化或校验失败则拒绝，不延长原有截止时间。
- `model-relay-metrics-authorization.mjs` / `model-relay-metrics-authorization.d.mts`：Gateway 指标身份异步鉴权，最多保留 8 个检查；读取当前配置中的活动/历史身份，校验提供商和已签发代次；取消或关闭后的迟到鉴权结果不得通过。
- `model-relay-service.mjs` / `model-relay-service.d.mts`：独立进程组合与生命周期、材料刷新/撤销、共享网络出口选择和可选 V2 Relay 转储 owner；未变化配置不重复发布准入策略，代理连接池跟随全局并发上限；复用全局 debug 开关、裁剪模式和保留天数；不复用 App Server 的代理实例。
  服务诊断通过 `dist/observability/index.js` 的安全 Logger 输出服务、模块、事件和受限错误字段，不输出原始异常正文。

公开服务命令通过 `service-targets.mjs` 的 `serviceCommandTarget` 将内部 `model-relay`、`app-server` 标识显示为 `relay`、`appserver`；平台服务标识和已有定义文件保持稳定。目录中的 `all` 覆盖全部目标，必需服务检查通过 `core` 属性明确筛选。

- `cline-relay-catalog.mjs` / `cline-relay-catalog.d.mts`：独立 Cline 转发模型文件的严格校验、只读快照与思考能力投影；不读取 Codex 模型目录。

- `cline-relay-catalog-update.mjs` / `cline-relay-catalog-update.d.mts`：固定来源的目录下载、格式解析、备份和原子替换；供自动初始化与显式更新共用。
- `cline-relay-catalog-bootstrap.mjs` / `cline-relay-catalog-bootstrap.d.mts`：服务拥有的缺失目录单次后台初始化，复用管理锁，取消、失败报告与限时关闭；不覆盖并发更新。
