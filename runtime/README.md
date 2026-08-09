# 共享运行时基础设施

本目录保存 npm CLI 与已编译 Gateway 必须直接共享的稳定 JavaScript 模块，不承载会话业务。

- `config-event-queue.mjs`：以有界、版本化、原子更新的队列保存待投递配置事件。
- `config-event-queue.d.mts`：声明配置事件队列共享模块的 TypeScript 接口。
- `gateway-config.mjs`：安全解析、严格校验 Telegram、飞书私聊与微信私聊配置，在保留已有
  注释的前提下合并缺失的 Schema 安全默认值，并以 `0600` 权限原子写入 CLI、脚本和 Gateway
  共享的 TOML 配置。
- `gateway-config.d.mts`：声明共享 TOML 配置模块的 TypeScript 接口。
- `network-proxy.mjs`：按 TOML、标准环境变量和受支持系统代理的顺序解析统一代理环境，只返回
  实际解析出的大小写代理变量；集中按目标协议选择、校验 HTTP(S) 客户端代理并匹配
  `NO_PROXY`。渠道显式代理优先于共享代理和 `NO_PROXY`。
- `network-proxy.d.mts`：声明共享代理解析模块的 TypeScript 接口。
- `model-provider-definitions.mjs` / `model-provider-definitions.d.mts`：集中保存编译期内置模型
  Provider 的非敏感固定定义，供 Setup、CLI、Runtime 与 Bootstrap 复用；不包含 API Key。
- `model-provider-runtime.mjs`：通过编译期受控 Provider 描述读取 Setup 管理标记和私有 Profile；
  判定切换/固定模式的主 Provider、派生私有 Provider Socket，并向 DeepSeek 账户适配器提供同源
  凭据；读取并校验用户已有的 OpenAI 上游地址，并为 App Server 提供本机统计代理地址的参数替换。
  切换模式为不支持 Profile 选择器的 App Server 生成非敏感 `-c` 覆盖，并只在子进程环境提供
  Key；固定模式从基础配置读取。
- `model-provider-runtime.d.mts`：声明受控模型 Provider 运行时接口。
- `app-server-supervisor.mjs`：以当前用户私有 Unix Socket 持有 App Server 监管入口互斥锁，
  对前台启动器公开有界、版本化的 Provider 拓扑身份；集中检查真实 WebSocket 健康状态，拒绝
  未受监管的活动 App Server，并安全保留失效 Socket；关闭时主动清理已接入连接，不因本地客户端
  保持连接而阻塞服务退出。
- `app-server-supervisor.d.mts`：声明 App Server 监管拓扑与健康检查接口。
- `gateway-owner.mjs` / `gateway-owner.d.mts`：按当前配置文件持有独立于 Provider 和指标通道的
  私有 Gateway 所有权 Socket，保证同一配置只能运行一个 Gateway，并安全清理失效入口。
- `project-rules.mjs`：生成并检查项目级 Codex 命令规则；Gateway 使用精确 Workspace 根目录，
  并拒绝通过符号链接把写入转移到 Workspace 外。
- `project-rules.d.mts`：声明共享项目规则模块的 TypeScript 接口。
- `agent-roles.mjs`：读取 `~/.codex/config.toml` 的 `[agents]` 配置，返回带描述的子代理角色
  列表，供渠道 `/agents` 命令展示与调用；不含任何角色实现。
- `agent-roles.d.mts`：声明共享子代理角色配置模块的 TypeScript 接口。
- `codex-home.mjs` / `codex-home.d.mts`：统一解析 Codex 用户目录（`CODEX_HOME` 或
  `~/.codex`），供 CLI、脚本、Runtime 与 Bootstrap 复用。
- `api-provider-credential.mjs` / `api-provider-credential.d.mts`：按第三方 API 提供商 ID 隔离
  API Key，并严格校验私有目录、文件所有者、权限与符号链接。
- `vision-credential.mjs` / `vision-credential.d.mts`：只供 Setup 显式转换旧单视觉凭据；新的
  Gateway 调用不再读取该路径。

这里的模块同时被 `bin/`、`scripts/`、`src/config` 和 `src/bootstrap` 使用，必须保持无平台 SDK 依赖，并随 npm 包发布。
