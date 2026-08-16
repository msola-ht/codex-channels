# 共享运行时基础设施

本目录保存 npm CLI 与已编译 Gateway 必须直接共享的稳定 JavaScript 模块，不承载会话业务。

- `config-event-queue.mjs`：以有界、版本化、原子更新的队列保存待投递配置事件。
- `config-event-queue.d.mts`：声明配置事件队列共享模块的 TypeScript 接口。
- `gateway-config.mjs`：安全解析、严格校验 Telegram、飞书私聊与微信私聊配置，并提供复用同一
  子 Schema 的严格 `[codex]` 局部校验；在保留已有注释的前提下合并缺失的 Schema 安全默认值，
  并复用统一私有文件原子替换，以 `0600` 权限写入 CLI、脚本和 Gateway 共享的 TOML 配置。
- `gateway-config.d.mts`：声明共享 TOML 配置模块的 TypeScript 接口。
- `network-proxy.mjs`：按 TOML、标准环境变量和受支持系统代理的顺序解析统一代理环境，只返回
  实际解析出的大小写代理变量；集中按目标协议选择、校验 HTTP(S) 客户端代理并匹配
  `NO_PROXY`。渠道显式代理优先于共享代理和 `NO_PROXY`。
- `network-proxy.d.mts`：声明共享代理解析模块的 TypeScript 接口。
- `model-provider-definitions.mjs` / `model-provider-definitions.d.mts`：集中保存编译期内置第三方
  Provider 的非敏感固定定义，供 Setup、CLI、Runtime 与 Bootstrap 复用；不包含 API Key。
- `model-provider-profile.mjs` / `model-provider-profile.d.mts`：按编译期 Provider 定义生成隔离的
  私有 Profile、Provider 配置和管理标记，避免 DeepSeek 与 OpenCode Go Setup 重复解释同一格式。
- `deepseek-pricing-baseline.json`：保存从 DeepSeek 官方价格页审查后的人民币每百万 Token 单价、
  北京时间峰谷区间和生效日期；Bootstrap 只读使用，自动检查只能通过 Draft PR 提议更新。
- `opencode-go-pricing-baseline.json`：保存 OpenCode Go 官方页面全部模型的美元每百万 Token 单价、
  长上下文档位、套餐包含用量、端点与 SDK 协议；运行时只为已开放模型生成请求价格快照。
- `model-provider-runtime.mjs`：通过编译期受控 Provider 描述读取 Setup 管理标记和私有 Profile；
  判定切换/固定模式的主 Provider、派生私有 Provider Socket，并向 DeepSeek 账户适配器提供同源
  凭据；读取并校验用户已有的 OpenAI 上游地址，并为 App Server 提供本机统计代理地址的参数替换。
  切换模式为不支持 Profile 选择器的 App Server 生成非敏感 `-c` 覆盖，固定模式从基础配置读取；
  共享第三方子代理只把当前选择 Provider 的 Key 注入主 App Server 子进程；每个 Provider 使用独立
  模型目录，并按模型读取上下文、默认思考等级与自动压缩阈值；受管 Profile、模型目录、管理标记和
  共享角色统一使用 `sf-` 文件前缀。
- `model-provider-runtime.d.mts`：声明受控模型 Provider 运行时接口。
- `app-server-runtime.mjs` / `app-server-runtime.d.mts`：从当前 TOML、数据目录和 Provider
  配置一次性派生主 Socket、可选 Provider Socket 与 Supervisor 拓扑，供启动、Doctor、远程终端
  和服务安装入口复用，避免各入口独立解释运行拓扑。
- `app-server-supervisor.mjs`：以当前用户私有 Unix Socket 持有 App Server 监管入口互斥锁，
  对前台启动器公开有界、版本化的 Provider 拓扑身份，并提供受控 Provider 按需启动请求；集中检查真实 WebSocket 健康状态，拒绝
  未受监管的活动 App Server，并安全保留失效 Socket；关闭时主动清理已接入连接，不因本地客户端
  保持连接而阻塞服务退出。
- `app-server-supervisor.d.mts`：声明 App Server 监管拓扑与健康检查接口。
- `gateway-owner.mjs` / `gateway-owner.d.mts`：按当前配置文件持有独立于 Provider 和指标通道的
  私有 Gateway 所有权 Socket，保证同一配置只能运行一个 Gateway，并安全清理失效入口；所有权
  建立与应用就绪使用不同状态，应用开始停止时立即撤销就绪；公开同源健康探针供本地更新确认
  Gateway 已完成应用启动且尚未进入关闭流程。
- `service-targets.mjs` / `service-targets.d.mts`：集中声明公开服务目标、systemd unit、launchd
  label、核心服务范围和启停顺序，供 CLI、平台控制脚本、安装器与 Doctor 复用。
- `process-lifecycle.mjs` / `process-lifecycle.d.mts`：统一判断子进程存活、向活动子进程转发信号、
  解释同步子进程的启动错误/退出码/终止信号和成对安装/移除进程信号监听；可标记失败已由子命令
  展示，避免嵌套 CLI 重复报错。具体关闭超时和资源清理仍由各生命周期所有者决定。
- `cli-presentation.mjs` / `cli-presentation.d.mts`：集中定义公开 CLI 的成功、失败、提示和处理
  状态标签、颜色、输出流路由和换行，Doctor 检查项另用通过；统一遵守 TTY 与 `NO_COLOR`，
  重定向输出保持纯文本。
- `executable.mjs` / `executable.d.mts`：统一选择配置或安装环境中的 Codex 路径，并从绝对/相对
  路径或受控 `PATH` 解析本机可执行文件；供 CLI、Bootstrap、服务安装器和 Doctor 复用，不依赖
  平台固定位置的 `which`。
- `project-rules.mjs`：生成并检查项目级 Codex 命令规则；Gateway 使用精确 Workspace 根目录，
  并拒绝通过符号链接把写入转移到 Workspace 外。
- `project-rules.d.mts`：声明共享项目规则模块的 TypeScript 接口。
- `agent-roles.mjs`：读取 `~/.codex/config.toml` 的 `[agents]` 配置，返回带描述的子代理角色
  列表，供渠道 `/agents` 命令展示与调用；不含任何角色实现。
- `agent-roles.d.mts`：声明共享子代理角色配置模块的 TypeScript 接口。
- `codex-home.mjs` / `codex-home.d.mts`：统一解析 Codex 用户目录（`CODEX_HOME` 或
  `~/.codex`），供 CLI、脚本、Runtime 与 Bootstrap 复用。
- `private-file.mjs` / `private-file.d.mts`：为 Codex Home 内 App Server 无法管理的 Profile、模型目录、
  管理标记、子代理配置和可丢弃运行时缓存提供统一的新建 `0700` 父目录、`0600` 文件及随机临时
  文件原子替换；
  `~/.codex/config.toml` 的普通键级设置仍统一交给官方 `config/batchWrite`。
- `api-provider-credential.mjs` / `api-provider-credential.d.mts`：按第三方 API 提供商 ID 隔离
  API Key，严格校验私有目录、文件所有者、权限与符号链接，并复用统一私有文件原子替换。
- `vision-credential.mjs` / `vision-credential.d.mts`：只供 Setup 显式转换旧单视觉凭据；新的
  Gateway 调用不再读取该路径；旧凭据更新同样复用统一私有文件原子替换。
- `workspace-permission.mjs` / `workspace-permission.d.mts`：统一 Workspace 的 Sandbox、审批策略
  与 Permission Profile 更新及互斥规则，供 CLI、Config 菜单和渠道写入适配器复用。

这里的模块同时被 `bin/`、`scripts/`、`src/config` 和 `src/bootstrap` 使用，必须保持无平台 SDK 依赖，并随 npm 包发布。
