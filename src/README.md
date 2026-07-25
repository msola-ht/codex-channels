# Gateway 源码

`src/` 是单一 TypeScript Gateway 的业务源码。`main.ts` 只启动配置生命周期入口；`version.json` 保存运行时版本。

## 模块索引

- [`application/`](application/README.md)：跨模块用例编排。
- [`approval/`](approval/README.md)：App Server 交互请求与审批协调。
- [`bootstrap/`](bootstrap/README.md)：依赖装配和进程生命周期。
- [`codex-client/`](codex-client/README.md)：Transport、JSON-RPC 和 App Server API。
- [`codex-protocol/`](codex-protocol/README.md)：生成协议类型、受控导出和版本基线。
- [`config/`](config/README.md)：统一 TOML 配置解析和边界验证。
- [`conversation-core/`](conversation-core/README.md)：Thread、Turn、Item 状态归约和输出事件。
- [`event-bus/`](event-bus/README.md)：有界异步队列和消费者隔离。
- [`observability/`](observability/README.md)：结构化日志与脱敏。
- [`policy/`](policy/README.md)：Telegram 用户与 Workspace 授权边界。
- [`session-routing/`](session-routing/README.md)：外部 Conversation、Workspace 与 Codex Thread 路由。
- [`storage/`](storage/README.md)：最小绑定状态的可替换存储。
- [`surfaces/`](surfaces/README.md)：外部平台适配器。

依赖方向保持为 `Surface -> Application/Core <- Codex Client`，由 `bootstrap` 负责组合具体实现。每个一级模块通过自己的 `index.ts` 暴露公开能力，跨模块不得导入内部实现文件。核心模块不得依赖 Telegram、SQLite 或 launchd。Thread 生命周期端口和稳定快照由
`session-routing` 拥有，`codex-client` 负责把固定版本官方响应映射到该边界；Routing 不反向依赖
Client 或生成协议。Turn、Review 和 Goal 的执行端口与稳定结果由 `application` 拥有，Client
只在适配边界构造官方输入和解释响应。模型目录、思考强度和服务层级的稳定类型同样由
`application` 拥有，Client 负责裁剪官方模型目录并封装 Fast 默认值配置。账户用量与额度查询
同样由 Application 窄端口承接，Client 统一选择官方多桶或兼容单桶响应并
输出稳定摘要。其余扩展查询、通知和审批协议隔离按
[`Codex CLI 协议边界收敛计划`](../docs/architecture-convergence-plan.md) 分阶段推进。
