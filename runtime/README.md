# 共享运行时基础设施

本目录保存 npm CLI 与已编译 Gateway 必须直接共享的稳定 JavaScript 模块，不承载会话业务。

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
  `NO_PROXY`。渠道显式代理优先于共享代理和 `NO_PROXY`。
- `network-proxy.d.mts`：声明共享代理解析模块的 TypeScript 接口。
- `model-provider-definitions.mjs` / `model-provider-definitions.d.mts`：集中保存编译期内置第三方
  Provider 的非敏感固定定义，供 Setup、CLI、Runtime 与 Bootstrap 复用；不包含 API Key。
  `loadManagedModelProviderDefinitions` 按定义的实例适配器保留所有单实例 Provider，并从 OpenCode
  Go 账户注册表动态生成 `opencode-go-<账户>` 实例；能力元数据固定声明实例展开、模型目录来源与
  更新、计价、账户和汇率需求，允许显式无更新/无计价/无账户能力。账户实例继承共享定义；
  `loadManagedModelProviderWatcherDefinitions` 额外保留未配置的共享目录，watcher 再按 Provider ID
  合并并去重文件路径。
- `opencode-go-accounts.mjs` / `opencode-go-accounts.d.mts`：OpenCode Go 账户注册表
  （`accounts.json`）、账户目录与管理标记，以及旧版单账户配置原地迁移为默认账户
  `opencode-go`（新增账户才使用 `opencode-go-<账户>`）；Key 不进入注册表。
- `model-provider-profile.mjs` / `model-provider-profile.d.mts`：按编译期 Provider 定义生成隔离的
  私有 Profile、Provider 配置和管理标记，并为自定义主 Provider 提供共享的块字段构造与
  config 编辑映射，避免 DeepSeek、OpenCode Go 与自定义 Setup 重复解释同一格式。
- `deepseek-pricing-baseline.json`：保存从 DeepSeek 官方价格页审查后的人民币每百万 Token 单价、
  北京时间峰谷区间、周末规则和生效日期；Bootstrap 只读使用，自动检查只能通过 Draft PR 提议更新。
- `opencode-go-pricing-baseline.json`：保存 OpenCode Go 官方页面全部模型的美元每百万 Token 单价、
  Peak/Off-Peak 时段（UTC）、长上下文档位、套餐包含用量、端点与 SDK 协议，并明确记录未给出
  数值价格的限时免费模型；运行时只为已开放且有数值价格的模型按请求时间生成请求价格快照。
- `opencode-go-quota-windows.mjs` / `opencode-go-quota-windows.d.mts`：为 OpenCode Go 统计代理
  提供官方 5 小时/7 天/月度配额窗口 `resetsAt` 快照；按最早 `resetsAt` 失效前缓存，失败时短时
  退避后重试，缺失或已过期的重置时间同样短时退避，避免每个模型请求重复查询；快照随请求指标
  写入指标库供账户用量按周期归属本地 Token。
- `model-provider-runtime.mjs`：通过受控 Provider 描述读取 Setup 管理标记和私有 Profile；
  判定切换/固定模式的主 Provider、派生私有 Provider Socket，并向 DeepSeek 账户适配器提供同源
  凭据；自定义主 Provider 的私有候选备份按普通私有文件同样校验类型、属主、权限、大小和符号链接；
  自定义切换模式使用显式私有注册表和逐 Provider 的 `sf-custom-<id>` 私有 Profile，仅接受 Codex
  官方模型目录来源，并严格限制为单个目标 Provider 块和直接 API Key 字段；注册表与 Profile 的增删改
  共用私有文件锁并支持执行前快照保护，Provider 块与 Key 不进入主配置；Remote TUI
  通过公开 `custom-<id>` 名称映射到该内部 Profile；后台 App Server 则使用加载器生成的非敏感 `-c`
  覆盖，并只把 Key 注入目标子进程环境，因为锁定版 App Server 不接受 `--profile`；
  读取并校验用户已有的 OpenAI 上游地址，并为 App Server 提供本机统计代理地址的参数替换。
  切换模式为不支持 Profile 选择器的 App Server 生成非敏感 `-c` 覆盖，固定模式从基础配置读取；
  共享第三方子代理支持受管与自定义 Provider，只把当前选择 Provider 的 Key 注入主 App Server 子进程；每个受管 Provider 使用独立
  模型目录，并按模型读取上下文、默认思考等级与自动压缩阈值；受管 Profile 镜像所选模型的默认
  思考等级，校验必须与模型目录一致；Profile 与共享角色使用 `~/.codex` 下的 `sf-` 前缀文件，
  模型目录、清单与管理标记存放在 `~/.codex-connect/providers/<id>/`。
- `model-provider-runtime.d.mts`：声明受控模型 Provider 运行时接口。
- `app-server-runtime.mjs` / `app-server-runtime.d.mts`：从当前 TOML、数据目录和 Provider
  配置一次性派生主 Socket、受管或自定义切换 Provider Socket 与 Supervisor 拓扑，供启动、Doctor、远程终端
  和服务安装入口复用，避免各入口独立解释运行拓扑。
- `app-server-supervisor.mjs`：以当前用户私有 Unix Socket 持有 App Server 监管入口互斥锁，
  对前台启动器公开有界、版本化的 Provider 拓扑身份，并提供受控 Provider 按需启动、释放与
  Remote TUI 生命周期租约（`ensureProvider` / `releaseProvider` / `leaseProvider`）；拓扑同时区分
  已配置、运行中、主动释放和持有租约的 Provider。租约由私有 Socket 连接持有，断开时自动撤销，
  存在租约时拒绝释放；同一 Provider 的启动、释放与租约获取串行执行，释放结果明确区分已释放、
  租约占用和实例未运行，旧版或无效监管响应对账户删除失败关闭。Gateway 还据此避免把主动释放
  误判为意外断线。入口集中检查真实 WebSocket 健康状态，拒绝
  未受监管的活动 App Server，并安全保留失效 Socket；关闭时主动清理已接入连接，不因本地客户端
  保持连接而阻塞服务退出，同时等待已经开始的 Provider 生命周期操作收尾且拒绝启动排队操作。
- `app-server-supervisor.d.mts`：声明 App Server 监管拓扑与健康检查接口。
- `gateway-owner.mjs` / `gateway-owner.d.mts`：按当前配置文件持有独立于 Provider 和指标通道的
  私有 Gateway 所有权 Socket，保证同一配置只能运行一个 Gateway，并安全清理失效入口；所有权
  建立与应用就绪使用不同状态，应用开始停止时立即撤销就绪；公开同源健康探针供本地更新确认
  Gateway 已完成应用启动且尚未进入关闭流程。
- `service-targets.mjs` / `service-targets.d.mts`：集中声明公开服务目标、systemd unit、launchd
  label、核心服务范围和启停顺序，供 CLI、平台控制脚本、安装器与 Doctor 复用。
- `process-lifecycle.mjs` / `process-lifecycle.d.mts`：统一判断子进程存活、向活动子进程转发信号、
  按温和终止、强制终止和有限终态等待关闭单个子进程，解释同步子进程的启动错误/退出码/终止信号
  和成对安装/移除进程信号监听；App Server 服务入口收到退出信号后停止监管请求、等待已开始的
  Provider 操作，并对全部子进程执行有限终止。可标记失败已由子命令展示，避免嵌套 CLI 重复报错。
  具体关闭超时和资源清理仍由各生命周期所有者决定。
- `cli-presentation.mjs` / `cli-presentation.d.mts`：集中定义公开 CLI 的成功、失败、提示和处理
  状态标签、颜色、输出流路由和换行，Doctor 检查项另用通过；统一遵守 TTY 与 `NO_COLOR`，
  重定向输出保持纯文本。
- `executable.mjs` / `executable.d.mts`：统一选择配置或安装环境中的 Codex 路径，并从绝对/相对
  路径或受控 `PATH` 解析本机可执行文件；供 CLI、Bootstrap、服务安装器和 Doctor 复用，不依赖
  平台固定位置的 `which`。
- `project-rules.mjs`：生成并检查项目级 Codex 命令规则；Gateway 使用精确 Workspace 根目录，
  并拒绝通过符号链接把写入转移到 Workspace 外；CLI 的 JSON 模式可静默底层 Codex 展示，普通模式
  继续原样转发检查输出。
- `project-rules.d.mts`：声明共享项目规则模块的 TypeScript 接口。
- `agent-roles.mjs`：读取 `~/.codex/config.toml` 的 `[agents]` 配置，返回带描述的子代理角色
  列表，供渠道 `/agents` 命令展示与调用；不含任何角色实现。
- `agent-roles.d.mts`：声明共享子代理角色配置模块的 TypeScript 接口。
- `codex-home.mjs` / `codex-home.d.mts`：统一解析 Codex 用户目录（`CODEX_HOME` 或
  `~/.codex`），供 CLI、脚本、Runtime 与 Bootstrap 复用。
- `thread-writer-lock.mjs` / `thread-writer-lock.d.mts`：定位并安全结束持有 Codex 线程写锁
  （`~/.codex/thread-writer-locks/<thread>.lock`）的本地进程；Linux 通过 `/proc` 按打开描述符
  与命令行识别持锁方，向渠道展示前剥离凭据参数；`/release force` 只放行入口可执行文件为
  `codex`、且发送信号前二次核验身份未变化的持锁方，供恢复诊断复用且不删除锁文件。
- `connect-home.mjs` / `connect-home.d.mts`：统一解析 Gateway 数据目录（`CODEX_CONNECT_HOME`
  或 `~/.codex-connect`），并提供受管第三方 Provider 存储根目录
  `providers/`，供 Setup、迁移脚本与 Runtime 复用。
- `private-file.mjs` / `private-file.d.mts`：为 App Server 无法管理的 Profile、模型目录、
  管理标记、子代理配置和可丢弃运行时缓存提供统一的新建 `0700` 父目录、`0600` 文件及随机临时
  文件原子替换；私有读取在同一描述符上使用 `O_NOFOLLOW`、`fstat` 校验普通文件、大小、权限与属主，
  避免路径校验后被符号链接替换；
  `~/.codex/config.toml` 的普通键级设置仍统一交给官方 `config/batchWrite`。
- `private-file-lock.mjs` / `private-file-lock.d.mts`：为跨越异步配置事务的私有文件更新提供
  PID 所有权、陈旧锁回收和替换锁保护，供 Provider 管理与微信配置/凭据事务串行写入。
- `api-provider-credential.mjs` / `api-provider-credential.d.mts`：按第三方 API 提供商 ID 隔离
  API Key，严格校验私有目录、文件所有者、权限与符号链接，并复用统一私有文件原子替换。
- `workspace-permission.mjs` / `workspace-permission.d.mts`：统一 Workspace 的 Sandbox、审批策略
  与 Permission Profile 更新及互斥规则，供 CLI、Config 菜单和渠道写入适配器复用。

这里的模块同时被 `bin/`、`scripts/`、`src/config` 和 `src/bootstrap` 使用，必须保持无平台 SDK 依赖，并随 npm 包发布。
