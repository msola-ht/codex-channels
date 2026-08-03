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
- [`observability/`](observability/README.md)：结构化日志与脱敏模型请求指标库。
- [`policy/`](policy/README.md)：Surface Actor 与 Workspace 授权边界。
- [`provider-proxy/`](provider-proxy/README.md)：模型 Provider 本地回环转发代理与流式计时。
- [`session-routing/`](session-routing/README.md)：外部 Conversation、Workspace 与 Codex Thread 路由。
- [`storage/`](storage/README.md)：最小绑定状态的可替换存储。
- [`surfaces/`](surfaces/README.md)：外部平台适配器。

依赖方向保持为 `Surface -> Application/Core <- Codex Client`，由 `bootstrap` 负责组合具体实现。每个一级模块通过自己的 `index.ts` 暴露公开能力，跨模块不得导入内部实现文件。核心模块不得依赖任何平台 SDK、SQLite 或服务管理器。Thread 生命周期端口和稳定快照由
`session-routing` 拥有，`codex-client` 负责把固定版本官方响应映射到该边界；Routing 不反向依赖
Client 或生成协议。Turn、Review 和 Goal 的执行端口由 `application` 拥有；Goal 的稳定状态类型
由 `conversation-core` 统一定义，供请求结果和通知归约共同使用，Client 只在适配边界构造官方输入
和解释响应。模型信息、思考强度和服务层级的稳定类型同样由
`application` 拥有，Client 负责裁剪官方模型目录并封装 Fast 默认值配置。Provider 账户能力
由 Application 的编译期注册窄端口承接：OpenAI 通过 Client 选择官方多桶或兼容单桶响应，
DeepSeek 由 Bootstrap 具体适配器查询官方余额；未知 Provider 不回退到 OpenAI。直接安装 Skill
查询也已在 Client 边界完成路径与 Scope 裁剪；显式调用只把
实时解析且通过校验的 Skill 引用交给 Application，Surface 不接触本机路径。MCP 状态查询
已裁剪为按当前 Thread 获取的名称、认证状态和工具数量，Plugin 查询只输出已安装项的名称与
启用状态，Permission Profile 查询只输出稳定的目录选项。

切换模式复用完整 `CodexAppServerClient`，由 Provider 路由层按官方 Thread `modelProvider` 选择
OpenAI 主 App Server 或独立 Provider App Server；Session Routing、Application、Core、Approval、
Storage 和 Surface 不复制实现。固定模式仍只有一个由基础配置决定 Provider 的主实例。

Client 把 Thread 路由通知与 Turn、Item、Goal、Token、账户、额度、MCP 和 warning 等通知转换为
稳定事件；`conversation-core` 不解析原始协议。Client 同样解码和编码五类 Server Request，
`approval` 只拥有稳定请求、授权语义和用户决定。生产源码只有 Client 导入生成协议，
Bootstrap 通过 Client 读取版本并向 Surface 注入纯字符串；受控协议导出和模块依赖测试会阻止
协议或具体 Client 再次泄漏。Storage、Policy、Event Bus、Observability、Config、Surface 和
Bootstrap 的当前边界分别以本索引中的模块 README 为准。
