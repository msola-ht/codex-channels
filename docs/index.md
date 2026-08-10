# Codex 官方文档与源码索引

本页用于定位 Codex App Server 的官方说明、`0.147.0` 固定版本源码，以及本项目对应实现。
它是查询入口，不替代生成协议类型，也不声明本项目支持官方协议的全部能力。

## 版本与数字

当前索引对应 [`src/codex-protocol/version.json`](../src/codex-protocol/version.json) 锁定的
`codex-cli 0.147.0`。生成时启用实验类型，但业务只采用固定版本官方 Plan 模式所需的
`collaborationMode/list` 与 `turn/start.collaborationMode`；其他实验类型不表示已支持。

| 数量 | 是什么 | 事实来源 |
| ---: | --- | --- |
| 723 | 当前 CLI 生成的 TypeScript 文件总数 | `src/codex-protocol/generated/` |
| 97 | 生成目录根层的公共、兼容和初始化类型 | `src/codex-protocol/generated/*.ts` |
| 625 | v2 请求、响应、通知和数据类型 | `src/codex-protocol/generated/v2/*.ts` |
| 1 | `serde_json` 辅助类型 | `src/codex-protocol/generated/serde_json/` |
| 136 | 客户端发给 App Server 的 Request 方法 | [`ClientRequest.ts`](../src/codex-protocol/generated/ClientRequest.ts) |
| 72 | App Server 发给客户端的 Notification 方法 | [`ServerNotification.ts`](../src/codex-protocol/generated/ServerNotification.ts) |
| 11 | App Server 发给客户端、需要回应的 Request 方法 | [`ServerRequest.ts`](../src/codex-protocol/generated/ServerRequest.ts) |
| 1 | 客户端发给 App Server 的 Notification，即 `initialized` | [`ClientNotification.ts`](../src/codex-protocol/generated/ClientNotification.ts) |
| 37 | Codex Client 适配边界使用的受控协议类型导出 | [`src/codex-protocol/index.ts`](../src/codex-protocol/index.ts) |
| 30 | 本项目直接调用的业务 Request 方法，不含连接层的 `initialize` | [`client.ts`](../src/codex-client/client.ts) |
| 5 | 本项目显式协调的 Server Request 类型 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts) |
| 14 | 本项目 TypeScript Gateway 的一级业务模块 | [`src/README.md`](../src/README.md) |

这里的数量描述协议结构，不等于本项目已实现的功能数。只有 `codex-client` 可以使用
`src/codex-protocol/index.ts` 的受控导出；生成目录可能包含尚未采用、实验中或仅供其他客户端
使用的类型，其他业务模块不得导入。

## 官方文档

1. [Codex App Server](https://learn.chatgpt.com/docs/app-server)：协议定位、Transport、
   JSON-RPC 消息、初始化、Thread/Turn/Item、审批、通知和 Schema 生成的主文档。
2. [Codex 开源组件](https://learn.chatgpt.com/docs/open-source)：官方开源范围和仓库入口。
3. [Codex 高级配置](https://developers.openai.com/codex/config-advanced#profiles)：独立
   `profile-name.config.toml` 的加载顺序、命名与 `--profile` 用法。
4. [OpenAI Codex 仓库](https://github.com/openai/codex)：当前官方源码；排查本项目锁定协议时，
   优先读取 [`upstream/openai-codex`](upstream-sources.md) 的固定本地副本；本地副本缺失时
   再打开下面固定到 `rust-v0.147.0` 的链接，不能直接以 `main` 为准。

官方文档定义产品和协议行为；本项目实际字段必须以当前锁定 CLI 生成的 TypeScript 类型为准。
如果两者看起来不一致，先检查文档是否描述了更新版本，再审查固定版本源码和生成差异。

## 固定版本官方源码

以下链接固定到 OpenAI Codex `rust-v0.147.0`：

| 查询目标 | 官方源码 | 主要内容 |
| --- | --- | --- |
| App Server 总览 | [`app-server/README.md`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/README.md) | 启动方式、协议和开发入口 |
| JSON-RPC 消息总表 | [`rpc.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/rpc.rs) | Client Request、Server Notification、Server Request |
| 协议公共类型 | [`common.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/protocol/common.rs) | 初始化、ID、通用协议结构 |
| v2 协议入口 | [`v2/mod.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/protocol/v2/mod.rs) | v2 模块与受支持类型汇总 |
| Thread | [`thread.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) | Thread 请求、响应和生命周期 |
| Turn | [`turn.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs) | Turn 启动、追加、停止和状态 |
| 用户输入 | [`user_input.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/protocol/src/user_input.rs) | 文本、图片、一次性音频、Skill 与 Mention 输入 |
| Item | [`item.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs) | 消息、命令、文件、工具等 Item |
| 图片生成 Item 与产物 | [`image_generation.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/ext/items/src/image_generation.rs)、[`artifact.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/ext/image-generation/src/artifact.rs) | `ImageGenerationItem.savedPath` 与生成图片落盘目录 |
| 权限协议 | [`permissions.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs) | 临时权限、命令网络上下文与持久规则结构 |
| MCP 协议 | [`mcp.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs) | MCP 状态与 form、openai/form、URL elicitation |
| 通知 | [`notification.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server-protocol/src/protocol/v2/notification.rs) | v2 Notification 参数 |
| Transport | [`transport.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/transport.rs) | stdio、WebSocket 和连接收发 |
| 初始化处理 | [`initialize_processor.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/request_processors/initialize_processor.rs) | `initialize` 握手与能力协商 |
| Thread 请求处理 | [`thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/request_processors/thread_processor.rs) | Thread 请求的运行时实现 |
| Thread 分区处理 | [`thread_sections.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/request_processors/thread_sections.rs) | 内置 Pinned 分区、自定义分区与生命周期约束 |
| Thread 订阅生命周期 | [`thread_lifecycle.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs) | 订阅、空闲卸载与 `thread/closed` |
| Turn 请求处理 | [`turn_processor.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/request_processors/turn_processor.rs) | Turn 启动、追加、停止和状态 |
| 配置请求处理 | [`config_processor.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/request_processors/config_processor.rs) | `config/read`、批量写入与用户配置热加载 |
| 模型目录测试 | [`model_list.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/model_list.rs) | 可见模型、分页和远端目录合同 |
| DeepSeek Codex 接入 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex) | Responses Provider、配置字段、官方脚本和当前支持模型 |
| DeepSeek Responses 指南 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/guides/responses_api) | 无状态会话、流式事件、输入与工具兼容性、缓存及用量字段 |
| DeepSeek 创建响应接口 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/api/create-response) | `POST /responses` 请求字段、响应结构与 SSE 终止事件 |
| DeepSeek 账户余额 | [DeepSeek 官方余额接口](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/) | `GET /user/balance` 的可用状态、币种与余额字段；不提供 Codex 周限或历史 Token 汇总 |
| 账户请求处理 | [`account_processor.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/request_processors/account_processor.rs) | 账户 Token 用量与额度读取 |
| 账户测试 | [`account.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/account.rs) | 用量读取、认证与错误合同 |
| 额度测试 | [`rate_limits.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/rate_limits.rs) | 单桶、多桶、消费控制与重置券合同 |
| Skill 列表测试 | [`skills_list.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/skills_list.rs) | CWD、Scope、缓存、Plugin Skill 与变更通知合同 |
| MCP 请求处理 | [`mcp_processor.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/request_processors/mcp_processor.rs) | Thread 配置上下文、精简清单、排序与分页 |
| MCP 工具审批 | [`mcp_tool_call.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/core/src/mcp_tool_call.rs) | 工具审批 elicitation 元数据、会话与持久授权响应 |
| MCP 状态测试 | [`mcp_server_status.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/mcp_server_status.rs) | 工具原名、项目级配置、实时元数据与精简清单合同 |
| Plugin 请求处理 | [`plugins.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/request_processors/plugins.rs) | 已安装查询、本地与远端来源、CWD 和安装建议 |
| Plugin 列表测试 | [`plugin_list.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/plugin_list.rs) | 已安装过滤、安装建议、Marketplace 与功能开关合同 |
| Catalog 请求处理 | [`catalog_processor.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/src/request_processors/catalog_processor.rs) | Permission Profile 的 CWD 配置归并、allowed 状态和分页 |
| Permission Profile 测试 | [`permission_profile_list.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/permission_profile_list.rs) | 内置、自定义、项目级 Profile 与分页合同 |
| 用户输入测试 | [`request_user_input.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/request_user_input.rs) | 问题、自动解决时限、响应与跨客户端失效合同 |
| MCP elicitation 测试 | [`mcp_server_elicitation.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/mcp_server_elicitation.rs) | 三种 elicitation 模式、能力协商与响应合同 |
| Thread 设置测试 | [`thread_settings_update.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/thread_settings_update.rs) | 模型、思考等级和服务层级通知合同 |
| Thread 分区测试 | [`thread_sections.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/thread_sections.rs)、[`thread_metadata_update.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/thread_metadata_update.rs) | 内置 Pinned 分区、移动、列表状态、迁移与分页保持合同 |
| 上下文压缩测试 | [`compaction.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/compaction.rs) | 手动与自动压缩、`contextCompaction` Item 开始和完成通知合同 |
| Unix WebSocket 测试 | [`connection_handling_websocket_unix.rs`](https://github.com/openai/codex/blob/rust-v0.147.0/codex-rs/app-server/tests/suite/v2/connection_handling_websocket_unix.rs) | Unix Socket WebSocket 行为 |

## 当前支持矩阵

本表列出项目当前主动调用或消费的协议能力。未列出的生成类型不能直接视为已支持能力。

| 能力 | 当前使用的官方方法或通知 | 本项目入口与验证 |
| --- | --- | --- |
| 初始化与连接 | `initialize`、`initialized` | [`codex-client/`](../src/codex-client/README.md)、[`doctor.mjs`](../scripts/doctor.mjs)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts)；发送消息受生成的 `ClientRequest` / `ClientNotification` 约束，初始化通过 `extensions` 显式声明已实现的 `openai/form`，Doctor 只从 `initialize.userAgent` 提取运行中 App Server 的实际版本并与锁定版本比较 |
| Thread 生命周期 | `thread/list.modelProviders`、`thread/read`、`thread/start`、`thread/resume`、`thread/fork`、`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/unsubscribe`、`thread/name/set`、`thread/metadata/update`、`thread/section/move`、`thread/compact/start`、`thread/closed`、`thread/archived`、`thread/deleted` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 把官方 `section`、`modelProvider` 映射为稳定快照，并仅把官方内置 Pinned 分区投影为 `isPinned`；Thread 列表显式传空 Provider 过滤，确保当前 Workspace 的 OpenAI 与第三方 Thread 都可见并可用于冷恢复定位。[`conversation-service.ts`](../src/application/conversation-service.ts) 通过共享 `/pin`、`/unpin` 把当前 Thread 移入或移出内置 Pinned 分区；移动前原样回写当前 Git SHA，借助官方元数据路径把刚创建的加载中 Thread 无损协调进持久 Store，再由读回结果验证，三个 Surface 的会话列表仍固定项优先；运行中 `/resume` 或 `/new` 保留原 Thread 订阅并将其作为有界后台任务，输出与审批继续路由到原 Conversation，新输入只进入前台 Thread；跨渠道接管仍要求新旧渠道空闲、无排队消息或待处理交互且 Workspace 相同。固定状态只保存在 App Server，StateStore 仅保存前台及运行中后台的最小绑定；[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 把生命周期通知映射为 [`session-routing/`](../src/session-routing/README.md) 的稳定事件；[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`sqlite-binding-store.test.ts`](../tests/sqlite-binding-store.test.ts)、[`approval.test.ts`](../tests/approval.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Thread 设置与 Provider 路由 | `thread/start.modelProvider`、`thread/fork.modelProvider`、`thread/settings/updated`、`model/list`、`config/read`、`config/batchWrite`、实验 `collaborationMode/list` | [`model-port.ts`](../src/application/model-port.ts) 与 [`collaboration-mode-port.ts`](../src/application/collaboration-mode-port.ts) 定义稳定设置边界，[`model-adapter.ts`](../src/codex-client/model-adapter.ts) 映射 App Server 目录，[`deepseek-catalog.ts`](../src/codex-client/deepseek-catalog.ts) 只在 Provider 已启用时映射 Setup 下载的官方 DeepSeek 目录；切换模式保持 OpenAI 基础配置不变，把 DeepSeek 模型、Provider 与 Key 隔离在独立 Profile。由于固定版本不允许 Profile 选择器用于 `app-server`，服务入口校验该私有 Profile 后，通过官方 `-c` 进程覆盖和仅对子进程可见的 Key 环境变量启动独立 DeepSeek App Server。[`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts) 按官方 `modelProvider` 路由 Thread/Turn，隔离 Server Request ID 和单 Provider 重连；第三方账户通知不进入 OpenAI 账户状态，无法关联 Thread 的 MCP 与 warning 全局通知携带 Provider 来源并只投递到对应 Provider 会话。对应 App Server 在进程启动时加载自己的模型目录，避免进程级模型元数据管理器对 Thread 级目录覆盖使用 fallback。`codexc remote` 连接主实例；切换模式的 `--profile deepseek` 由本项目规范化，既改连 DeepSeek Socket，也保留给 Remote TUI 加载第三方认证配置。Flash 可选择，Pro 保留为明确不可用且不可切换的展示项；跨 Provider 选择保留并解绑原 Thread，在下一条消息中以目标模型目录的默认思考等级创建新 Provider Thread，不继承原 Provider 设置，不 Fork 或复制 Provider 专属历史；同一 Provider 内模型选择仍作为下一 Turn 覆盖并保留兼容思考等级。Application 在创建或追加 Turn 前按模型目录检查图片和音频能力，避免文本模型静默接收占位输入。官方设置通知没有携带可变 Provider 时，Router 保留已确认的 Provider；[`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`model-selection-service.test.ts`](../tests/model-selection-service.test.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`deepseek-catalog.test.ts`](../tests/deepseek-catalog.test.ts)、[`deepseek-setup.test.ts`](../tests/deepseek-setup.test.ts)、[`model-provider-runtime.test.ts`](../tests/model-provider-runtime.test.ts)、[`collaboration-mode-service.test.ts`](../tests/collaboration-mode-service.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts) |
| Turn 控制 | `turn/start`、实验 `turn/start.collaborationMode`、`turn/steer`、`turn/interrupt`、`turn/started`、`error`、`turn/completed` | [`turn-port.ts`](../src/application/turn-port.ts) 定义稳定执行、结构化 Skill 输入与 Default/Plan 覆盖端口，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 编码请求与响应，[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射生命周期通知、校验官方 `Turn.durationMs` 并统一脱敏、限长可显示的错误；显式 Skill 调用同时发送 `$<skill-name>` 文本标记和官方 `skill` 输入项，活动 Turn 不允许切换协作模式；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Item 与流式输出 | `item/started`、`item/completed`、`item/agentMessage/delta` | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 分类稳定 Item 事件，[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts) 生成脱敏操作摘要，并只把官方 `imageGeneration.savedPath` 映射为生成图片产物，[`core.ts`](../src/conversation-core/core.ts) 只归约稳定输入；模型代理计时不可用时，输出速度仍由 Client 在通知边界记录接收时间戳、Core 按 Thread 归约最后一次模型响应中不含推理的输出 Token 与最终回答流式时长，不消费新协议字段；[`generated-image.ts`](../src/surfaces/generated-image.ts) 对三渠道共用的生成图片本地读取执行绝对路径、无符号链接、普通文件、10 MiB 与 PNG/JPEG 签名校验；同一读取校验也用于 `codexc channel send-image` 提交的渠道 spool 图片；[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`operation-adapter.test.ts`](../tests/operation-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`telegram-outbox.test.ts`](../tests/telegram-outbox.test.ts)、[`feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts)、[`weixin-outbox.test.ts`](../tests/weixin-outbox.test.ts)、[`channel-image-spool.test.ts`](../tests/channel-image-spool.test.ts)、[`channel-send-image.test.ts`](../tests/channel-send-image.test.ts) |
| 子代理活动与终态 | `subAgentActivity`、子线程 `turn/completed`、`item/completed` 的 `collabAgentToolCall.receiverThreadIds` 与 `agentsStates` | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 只在 Item 完成阶段把官方活动类型映射为稳定事件，避免开始与完成阶段重复登记；[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts) 把官方接收线程和状态映射为不含代理消息正文的稳定操作事件。[`subagent-completion-tracker.ts`](../src/bootstrap/subagent-completion-tracker.ts) 登记生成的子代理线程，并以 App Server 自动订阅后发送的子线程 `turn/completed`、官方中断活动及旧版工具终态结算指标；已观察到模型指标且终态后出现父线程官方 `wait` Item 时，再等待 Writer 当前持久化水位并立即发布，使该等待操作稳定先于完成卡片；尚无指标或终态后未出现父线程等待时保留有界收敛窗口，极快子线程先完成后登记时短期有界保留终态。先前的 `wait` 不会加速之后才终止的并行子代理。指标到达和静默时间不推断终态。无指标发布零统计，读取失败显示统计不可用。三个 Surface 的紧凑操作模式共用同一策略，只保留子代理启动和失败，抑制成功的等待与交互操作；完成卡片展示模型、请求、Token、费用及全量计价均价，缓存、推理、费用分项和模型请求聚合耗时仅在调试模式展示。[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`subagent-completion-tracker.test.ts`](../tests/subagent-completion-tracker.test.ts)、[`lifecycle-presentation.test.ts`](../tests/lifecycle-presentation.test.ts)、[`request-metrics-store.test.ts`](../tests/request-metrics-store.test.ts)、[`telegram-outbox.test.ts`](../tests/telegram-outbox.test.ts)、[`feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts)、[`weixin-outbox.test.ts`](../tests/weixin-outbox.test.ts) |
| 上下文压缩 | `thread/compact/start`、`contextCompaction` Thread Item 与 `item/completed` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 从恢复历史提取压缩 Item ID，[`core.ts`](../src/conversation-core/core.ts) 合并实时完成 Item 并去重，[`conversation-service.ts`](../src/application/conversation-service.ts) 公开总次数；[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`telegram-format.test.ts`](../tests/telegram-format.test.ts)、[`telegram-outbox.test.ts`](../tests/telegram-outbox.test.ts)。生成类型中的 `thread/compacted` 已标记废弃，统计不依赖它；当前 Item 不提供手动/自动触发来源，因此只显示总次数 |
| 警告 | `warning`（Thread 目标或全局） | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射并统一脱敏、限长消息，[`core.ts`](../src/conversation-core/core.ts) 只负责目标路由；[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts) |
| Diff、计划产物与 Review | `turn/diff/updated`、`turn/plan/updated`、`review/start` | Review 目标与结果由 [`turn-port.ts`](../src/application/turn-port.ts) 定义，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 映射；Diff/计划产物通知经 [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 转成稳定事件后由 Core 归约。计划还通过结构化 `plan.updated` 输出，默认由三个 Surface 展示，`display.plan_updates = false` 时关闭；计划产物通知与切换官方 Plan 协作模式是两个独立边界 |
| Goal | `thread/goal/get`、`thread/goal/set`、`thread/goal/clear`、`thread/goal/updated`、`thread/goal/cleared` | [`turn-port.ts`](../src/application/turn-port.ts) 定义执行端口，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 映射请求结果，[`conversation-service.ts`](../src/application/conversation-service.ts) 在 set/clear 成功后立即同步 Core，[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 把外部变更与恢复通知转换为稳定 Core 事件；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 审批和用户输入 | 命令、文件、权限、用户输入、MCP elicitation 共 5 类 Server Request；MCP 工具审批按 form 的 `mcp_tool_call` 元数据区分，并只返回上游提供的 `session` / `always` 范围；`thread/start`、`thread/resume` 按 Workspace 权限传 `approvalPolicy` / `sandbox` / `permissions`（`permissions` 与 `sandbox` 互斥）；已授权用户可通过渠道 `/workspaceperm` 查看或修改当前 Workspace 权限 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts) 负责协议解码与编码，[`approval/`](../src/approval/README.md) 负责稳定授权语义，各 Surface 只实现平台交互，[`router.ts`](../src/session-routing/router.ts) 把配置权限映射为 Thread 启动参数，[`workspace-permission-writer.ts`](../src/bootstrap/workspace-permission-writer.ts) 写回配置并校验互斥；[`approval.test.ts`](../tests/approval.test.ts)、[`feishu-interactions.test.ts`](../tests/feishu-interactions.test.ts)、[`telegram-interactions.test.ts`](../tests/telegram-interactions.test.ts)、[`weixin-interactions.test.ts`](../tests/weixin-interactions.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`workspace-permission-writer.test.ts`](../tests/workspace-permission-writer.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Skill、MCP 与 Plugin | `skills/list`、`turn/start` 与 `turn/steer` 的 `input.skill`、`mcpServerStatus/list`、`plugin/installed`、MCP 状态通知 | Skill、MCP 和 Plugin 查询分别由 [`skill-port.ts`](../src/application/skill-port.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`plugin-port.ts`](../src/application/plugin-port.ts) 及对应 Client 适配器隔离；Skill 列表不向 Surface 暴露路径，显式调用按当前 CWD 重新解析已启用的用户或项目 Skill，并校验名称与绝对路径后交给 Application；Telegram、飞书和微信统一使用 `/skill` 查看编号列表、`/skill <名称或序号> <任务>` 调用，不维护渠道私有选择状态；MCP 通知由 [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射并脱敏，再由 [`runtime-status-format.ts`](../src/surfaces/runtime-status-format.ts) 生成共享稳定语义；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`feishu-adapter.test.ts`](../tests/feishu-adapter.test.ts)、[`telegram-image-input.test.ts`](../tests/telegram-image-input.test.ts)、[`weixin-conversation-adapter.test.ts`](../tests/weixin-conversation-adapter.test.ts) |
| 用量、额度与权限 | OpenAI：`account/usage/read`、`account/rateLimits/read`、账户通知；DeepSeek：`GET /user/balance`；权限：`permissionProfile/list` | [`account-port.ts`](../src/application/account-port.ts) 与 [`provider-account-service.ts`](../src/application/provider-account-service.ts) 按当前 Thread 的 `modelProvider` 返回 Token 用量、额度、第三方余额或明确不支持；OpenAI [`account-adapter.ts`](../src/codex-client/account-adapter.ts) 接受固定版本完整 `PlanType`，其中 `ent26` 显示为 Enterprise；`/limits` 仅在官方响应包含 10,080 分钟窗口与有效重置时间，且本机统计代理在相同重置周期观测到额度正向变化时，用 [`request-metrics-port.ts`](../src/application/request-metrics-port.ts) 按相邻快照区间估算每 1% Token 与 API 参考费用；DeepSeek [`deepseek-account-adapter.ts`](../src/bootstrap/deepseek-account-adapter.ts) 通过共享 [`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs) 从切换 Profile 或固定基础配置读取 Key、复用统一代理并裁剪官方余额；Thread Token/上下文统计保持 Provider 通用，OpenAI 周限不附加到第三方 Thread；账户通知仍由 [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射，Permission Profile 由 [`permission-port.ts`](../src/application/permission-port.ts) 与 [`permission-adapter.ts`](../src/codex-client/permission-adapter.ts) 隔离；[`provider-account-service.test.ts`](../tests/provider-account-service.test.ts)、[`deepseek-account-adapter.test.ts`](../tests/deepseek-account-adapter.test.ts)、[`conversation-command-format.test.ts`](../tests/conversation-command-format.test.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts) |
| 全 Provider 模型代理与速度统计 | App Server 服务数据通路，不新增 RPC | [`provider-proxy/`](../src/provider-proxy/README.md) 由 App Server 服务持有，为 OpenAI 主实例及可选 DeepSeek 实例自动分配独立回环代理；[`app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs) 以私有监管 Socket 独占并证明精确 Provider 拓扑，前台只复用完成真实 WebSocket 握手的受监管实例，裸 App Server、重复监管入口和重复 Gateway 均失败关闭。代理流式转发 HTTP/SSE、Responses WebSocket、HTTP `/responses/compact` 与只读 `/models`，保留上游状态与端到端 Header，并剥离本地 Turn 元数据；[`bin/codexc.mjs`](../bin/codexc.mjs) 复用统一网络代理、保留显式 `openai_base_url`，再通过 [`withOpenAiBaseUrl`](../runtime/model-provider-runtime.mjs) 或 [`withProviderBaseUrl`](../runtime/model-provider-runtime.mjs) 把对应 App Server 指向本机代理。首 Token、推理、Usage、文本与函数/自定义工具参数输出的首尾时间经 `0600` 私有 Unix Socket 投递并在响应完成事件前确认归约，[`bootstrap/app.ts`](../src/bootstrap/app.ts) 把指标同时送入有界持久化 Writer 与稳定 Core 事件；缺少 `Content-Type` 时仅按合法 `response.*` SSE 正文恢复元数据，HTTP 与 WebSocket 客户端断开都保留为中断失败，上游 WebSocket 断流与 HTTP `429/5xx` 同为可重试失败并在 Turn 完成时归入自动重试，HTTP 2xx 仍未观察到可解析完成事件、模型和 Usage 时归为 `incomplete/response_not_observed`，不冒充成功请求；旧版 `/responses/compact` 与 Codex 0.146 默认在普通 HTTP/WebSocket `/responses` 上用私有 `request_kind=compaction` 标记的 remote compaction v2 都归为压缩请求，其 Usage、费用和额度快照仍进入会话及全局汇总、异常报告与周额度估算。Core 不读取 SQLite，按 Turn 聚合全部关联请求的次数并在存在异常尝试时拆分完成、中断、未完整观测和失败数量，同时统计累计模型耗时、缓存、不含推理的综合输出速度和总价；DeepSeek 额外在调试模式开启时展示最后请求首字延时，并始终展示整轮综合思考/生成速度，OpenAI 不以隐藏推理或摘要时间估算详细计时。Bootstrap 的 [`model-pricing-catalog.ts`](../src/bootstrap/model-pricing-catalog.ts) 启动时读取私有缓存并异步刷新 LiteLLM 价格目录，失败时回退到 Sub2API 使用的 `Wei-Shaw/model-price-repo` 镜像；每个新请求只保存发生时的 USD API 参考价格快照，历史不回算，ChatGPT 订阅请求不冒充真实账单。[`reference-cost-summary.ts`](../src/bootstrap/reference-cost-summary.ts) 在 Turn 完成时合并持久化历史和当前实时计价，避免延迟写入造成重复或遗漏。`/metrics` 经 Application [`request-metrics-port.ts`](../src/application/request-metrics-port.ts) 只读查询当前 Thread 最近 Turn 聚合和最近直接 API，并在最近运行与会话累计中对所有 Provider 按本机实际用量展示均价（每 100M Token）；`global/providers/models` 在独立指标库内统一聚合 Codex Provider 与直接 API 的自然日、周、月、最近 24 小时至 365 天或全部保留历史记录，缓存、输出速度、TTFT 平均/P50/P95 和总价都保留有效样本覆盖，总价按全局 `price_currency` 统一显示（默认人民币），先出总计、再列出输入、缓存、输出三项价格明细，不显示目录静态单价；跨价格档位聚合时明确标记多档价格，分组最多展示请求量最高的 20 项；`errors` 使用相同时间范围，以全部模型请求为失败率分母，并按提供商、模型、状态、HTTP 状态和错误类型展示异常次数与最近发生时间，未发起上游请求的 Turn 级失败（如用量上限）与 WebSocket 握手失败同样计入；请求累计输入不冒充 App Server 上下文。Observability Store 默认保留 365 天且最多 1,000,000 行，可由 `[metrics.storage]` 调整，并提供先备份、后按日期或行数清理的 `codexc metrics cleanup`；同时提供不获取写锁的只读模式和每页最多 500 条的稳定 ID 分页，`codexc metrics` 的 `report`、`export`、`run`、`turns`、`threads` 都支持 Markdown/JSON/CSV 三格式导出，`report` 与 `export` 还支持自定义本地自然日区间（默认写入 `~/.codex-connect/output/<日期>/`），`threads` 提供会话归纳总览（模型、思考等级、Token 与总价），`turns` 提供每次对话明细，MD 报表按 `price_currency` 配置换算币种并显示本地时间，JSON/CSV 保留原始币种、nanos 与 ISO 时间；[`scripts/webui-server.mjs`](../scripts/webui-server.mjs) 提供 `codexc webui` 本地 WebUI，复用同一只读查询能力并直接使用 Observability Store 的分页与错误查询，默认只监听回环地址，绑定非回环地址（`0.0.0.0`）时必须设置访问令牌（`--token` 或 `[webui] token`），前端构建产物随 npm 包发布，不直接读取业务会话库；WebUI 也可作为独立后台服务由 `codexc service start webui` 管理，不并入 `all`。Gateway 停止时实时卡片指标可丢失但模型请求不中断；[`provider-proxy.test.ts`](../tests/provider-proxy.test.ts)、[`provider-proxy-metrics.test.ts`](../tests/provider-proxy-metrics.test.ts)、[`provider-metrics-composition.test.ts`](../tests/provider-metrics-composition.test.ts)、[`model-pricing-catalog.test.ts`](../tests/model-pricing-catalog.test.ts)、[`request-metrics-store.test.ts`](../tests/request-metrics-store.test.ts)、[`metrics-database.test.ts`](../tests/metrics-database.test.ts)、[`reference-cost-summary.test.ts`](../tests/reference-cost-summary.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`conversation-command-format.test.ts`](../tests/conversation-command-format.test.ts)、[`model-provider-runtime.test.ts`](../tests/model-provider-runtime.test.ts)、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts) |
| 真实合同 | Fast 默认值、Skill/MCP/Plugin/Permission 稳定查询、结构化 Skill Turn 输入、MCP 工具审批元数据与持久范围往返、Default/Plan 预设与 Plan Turn 设置通知、共享 Thread 设置通知、跨客户端 Thread 固定状态、Turn 启动结果、跨客户端 Goal 请求与通知、重连后 resume Goal 恢复、双客户端连接恢复 | [`real-app-server.test.ts`](../tests/real-app-server.test.ts) |

完成卡片中的“思考次数”表示本轮明确返回推理 Usage 且推理输出大于零的模型请求数；上游未返回
推理 Usage 时不猜测。用户界面的费用统一以 `**费用**：总价` 列表块显示，底层仍按当次 API 价格快照计算。

当前生成协议还包含文件系统 RPC、独立命令执行、登录、Marketplace、App、Realtime、
Remote Control、动态工具、Attestation 和实验能力等类型；它们没有因此自动成为 Gateway
公开能力。采用其中任何能力前，必须先审查对应 Server Request、Notification、安全边界和真实合同。

### 输入与语音边界

| 输入或交互 | 固定 CLI 0.147.0 | Gateway 当前状态 | 边界 |
| --- | --- | --- | --- |
| 文本 | `turn/start`、`turn/steer` 的稳定 `UserInput.text` | Telegram、飞书、微信已支持 | 由 Application 的 `TurnInput.text` 进入统一 Turn |
| 本地图片 | `turn/start`、`turn/steer` 的稳定 `UserInput.localImage` | 三渠道受限 PNG/JPEG 已支持；不支持图片的模型可显式启用视觉代理 | Surface 完成下载、签名和大小校验后，Application 只接收临时本地图片路径；原生支持时直接提交，不支持时统一调用视觉配置引用的第三方 Responses API 提供商及其隔离私有 Key，结果按已完成但不可信的文字观察进入原 Thread；第三方 API 注册表不接入 App Server、`modelProvider` 或 `/model`，视觉只是首个显式调用方。三渠道 `/vision <要求>` 只在 Surface 内存中按 Actor 与 Conversation 预设下一批图片的文字输入，`/vision <2–4> <要求>` 显式收集指定数量并在收齐后自动提交；外部识别失败后 `/vision retry` 可在五分钟内复用同一 Actor 与 Conversation 最近一次失败任务的原要求和临时图片，成功、新任务、取消、过期或停止时清除且不持久化；图片流程状态采用统一结构化消息并由各渠道转换格式；外部识别超过 10 秒后提供有界心跳，完成时展示配置的提供商名称、响应体实际视觉模型 ID 及上游实际返回的基础 Token 用量；本地实测 API 耗时仅在调试模式开启时展示；内部同时裁剪完成状态、上游时间戳差、服务层级、缓存与推理 Token，思考等级按当前 Thread 模型设置透传给视觉请求并同步记录，然后把不含图片、提示词、响应正文和识别结果的脱敏请求指标写入独立指标库；已有 Thread 时关联 `thread_id`，调用先于 Codex Turn，因此 `turn_id` 为 `NULL`；兼容的 `begin/done/cancel` 仍可处理数量未知的收集，不新增 App Server RPC；[`vision.md`](vision.md)、[`api-provider-setup.test.ts`](../tests/api-provider-setup.test.ts)、[`vision-port.test.ts`](../tests/vision-port.test.ts)、[`vision-command.test.ts`](../tests/vision-command.test.ts)、[`surface-input-coalescer.test.ts`](../tests/surface-input-coalescer.test.ts)、[`responses-vision-adapter.test.ts`](../tests/responses-vision-adapter.test.ts)、[`vision-setup.test.ts`](../tests/vision-setup.test.ts) |
| 一次性音频 | 稳定 `UserInput.audio` / `UserInput.localAudio`；模型目录用 `inputModalities` 声明实际能力；固定源码支持 WAV、MP3、M4A、WebM 与 OGG 本地音频 | 三渠道平台接收与受限转换已实现；当前可见模型均未声明 `audio`，原始音频不属于当前端到端支持 | Surface 先验证可信时长、最长 5 分钟、最大 20 MiB 与格式并写入一小时私有临时文件；Application 再按当前或下一 Turn 模型的 `inputModalities` 检查 `audio`，缺失时在 `turn/start` / `turn/steer` 前明确拒绝。微信可信转写仍作为文本提交；SILK 明确拒绝 |
| 实时语音 | 实验 `thread/realtime/start`、`appendAudio`、`appendSpeech`、`stop` 及 Realtime 通知 | 禁止接入 | 当前项目只允许 Plan 所需实验协议；不得导出、调用或消费 Realtime 业务能力 |
| ChatGPT Voice / 语音听写 | 官方桌面应用产品能力，不是当前 CLI 命令入口 | 不属于 Gateway | 不用平台模拟实现第二套 Codex 实时会话或语音输出 |

Application 的 `TurnInput` 是只含 `text`、`localImage` 与 `localAudio` 的封闭联合；模型目录
只把 `text`、`image`、`audio` 三种官方输入能力映射为稳定类型，包含 `localAudio` 的提交必须
先通过当前模型能力检查。Codex Client 只映射这三个稳定输入变体。模块边界测试同时禁止生产 Client 调用 `thread/realtime/*`，Surface
不得把平台音频地址、密钥、实时音频或未验证的编解码数据带入 Application/Core。

## 本项目实现映射

| 要查的问题 | 本项目入口 | 验证入口 |
| --- | --- | --- |
| CLI、运行中 App Server 和生成协议是否一致 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`protocol-info.ts`](../src/codex-client/protocol-info.ts)、[`doctor.mjs`](../scripts/doctor.mjs) | `npm run protocol:check`、`codexc doctor`、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts) |
| Unix WebSocket 如何连接 | [`codex-client/`](../src/codex-client/README.md) | [`unix-websocket-transport.test.ts`](../tests/unix-websocket-transport.test.ts) |
| JSON-RPC 如何分流和清理请求 | [`json-rpc.ts`](../src/codex-client/json-rpc.ts) | [`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Turn、Review 和 Goal 如何隔离官方协议 | [`turn-port.ts`](../src/application/turn-port.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Thread/Turn/Item 如何适配并归约 | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`input-events.ts`](../src/conversation-core/input-events.ts)、[`core.ts`](../src/conversation-core/core.ts) | [`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 多 Provider Thread 如何选择 App Server | [`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts)、[`app.ts`](../src/bootstrap/app.ts)、[`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs) | [`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`model-provider-runtime.test.ts`](../tests/model-provider-runtime.test.ts)、[`gateway-startup-cleanup.test.ts`](../tests/gateway-startup-cleanup.test.ts) |
| 官方 Thread 如何进入稳定业务边界 | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts)、[`thread-port.ts`](../src/session-routing/thread-port.ts) | [`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Thread 路由通知如何隔离 | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) | [`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Workspace、Conversation、Thread 如何绑定 | [`session-routing/`](../src/session-routing/README.md) | [`session-router.test.ts`](../tests/session-router.test.ts)、[`module-boundaries.test.ts`](../tests/module-boundaries.test.ts) |
| 模型、思考等级和 Fast 如何隔离并同步 | [`model-port.ts`](../src/application/model-port.ts)、[`model-adapter.ts`](../src/codex-client/model-adapter.ts)、[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) | [`model-selection-service.test.ts`](../tests/model-selection-service.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 原生与第三方账户指标如何隔离和扩展 | [`account-port.ts`](../src/application/account-port.ts)、[`provider-account-service.ts`](../src/application/provider-account-service.ts)、[`account-adapter.ts`](../src/codex-client/account-adapter.ts)、[`deepseek-account-adapter.ts`](../src/bootstrap/deepseek-account-adapter.ts) | [`provider-account-service.test.ts`](../tests/provider-account-service.test.ts)、[`deepseek-account-adapter.test.ts`](../tests/deepseek-account-adapter.test.ts)、[`conversation-command-format.test.ts`](../tests/conversation-command-format.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts) |
| 直接安装 Skill 查询与显式调用如何隔离 | [`skill-port.ts`](../src/application/skill-port.ts)、[`turn-port.ts`](../src/application/turn-port.ts)、[`skill-adapter.ts`](../src/codex-client/skill-adapter.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP 状态查询如何隔离 | [`mcp-port.ts`](../src/application/mcp-port.ts)、[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`telegram-format.test.ts`](../tests/telegram-format.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 已安装 Plugin 查询如何隔离 | [`plugin-port.ts`](../src/application/plugin-port.ts)、[`plugin-adapter.ts`](../src/codex-client/plugin-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`telegram-format.test.ts`](../tests/telegram-format.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Permission Profile 查询如何隔离 | [`permission-port.ts`](../src/application/permission-port.ts)、[`permission-adapter.ts`](../src/codex-client/permission-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`telegram-format.test.ts`](../tests/telegram-format.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Server Request 如何适配并协调 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`approval/`](../src/approval/README.md)、各 Surface 的 `interactions.ts` | [`approval.test.ts`](../tests/approval.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`telegram-interactions.test.ts`](../tests/telegram-interactions.test.ts)、[`feishu-interactions.test.ts`](../tests/feishu-interactions.test.ts)、[`weixin-interactions.test.ts`](../tests/weixin-interactions.test.ts) |
| 各模块如何装配和管理生命周期 | [`bootstrap/`](../src/bootstrap/README.md) | [`gateway-startup-cleanup.test.ts`](../tests/gateway-startup-cleanup.test.ts) |
| Telegram 如何适配核心事件 | [`surfaces/telegram/`](../src/surfaces/telegram/README.md) | [`tests/README.md`](../tests/README.md) |
| 新通讯渠道如何按模块接入 | [`通讯渠道 Surface 接入指南`](surface-integration-guide.md)、[`surfaces/`](../src/surfaces/README.md) | [`module-boundaries.test.ts`](../tests/module-boundaries.test.ts)、[`surface-manager.test.ts`](../tests/surface-manager.test.ts) |
| 与真实 App Server 的合同是否一致 | [`real-app-server.test.ts`](../tests/real-app-server.test.ts) | `RUN_CODEX_CONTRACT=1 npm test -- --run tests/real-app-server.test.ts` |

## 当前架构边界

当前协议隔离已经完成：`codex-protocol` 保存精确版本生成类型，`codex-client` 负责 Transport、
JSON-RPC、请求、通知和 Server Request 的协议适配；Application、Conversation Core、
Session Routing、Approval 和 Surface 只使用各自拥有的稳定类型与窄端口。非测试生产源码只有
Client 可以导入 `codex-protocol`，模块依赖测试会阻止生成协议或具体 Client 再次泄漏。

内部模块继续遵守各目录 README 和根 `AGENTS.md` 的现行边界：StateStore 只保存最小绑定，
Policy 同时校验 Surface、账号、Actor 与 Workspace，Event Bus 和 Surface 输出使用有界队列，
Observability 统一脱敏，Config 严格失败关闭，Bootstrap 是唯一组合根。Gateway 停止只断开
Client 与 Surface，不终止共享 App Server。

## 查询顺序

1. 先从本页按问题找到官方概念和本项目模块。
2. 查协议字段时打开生成的 `ClientRequest.ts`、`ServerNotification.ts` 或 `ServerRequest.ts`，
   再沿具体类型文件查看参数，不能凭官方 `main` 分支或记忆手写字段。
3. 查行为语义时阅读官方 App Server 文档，再优先查看 `upstream/openai-codex` 中
   `rust-v0.147.0` 固定版本实现和测试；本地副本缺失或基线不符时才使用上面的固定版本链接。
4. 查本项目行为时从模块 `index.ts` 和 README 进入，最后运行对应测试或真实合同测试。

协议升级从 [`Codex CLI 升级流程`](codex-cli-upgrade.md) 开始，使用
`npm run codex:upgrade -- <目标版本>` 生成差异，再由 Codex 审查适配，并同步本页的版本、数量、
固定版本源码链接和支持矩阵。`npm run docs:check` 会自动核对上表的协议和模块数字；也可用以下
命令手动复核：

每日 Alpha Canary 只对官方 Pre-release 做隔离前向兼容测试，不改变本页记录的稳定版本、数量、
固定版本链接或支持矩阵；它和正式升级提案会独立运行各项兼容检查，并保存逐阶段结果、日志、
完整 Patch 和协议结构影响摘要。自动提案阶段不修改本页稳定基线，因此文档索引检查明确跳过；正式
Release 发布并完成适配后必须重新运行正式升级流程和完整提交检查。Release 解析在有限网络
重试后仍失败时，工作流保留 `unresolved` 失败报告，不生成或猜测协议版本。

```bash
find src/codex-protocol/generated -type f -name '*.ts' | wc -l
rg -o '"method": "[^"]+"' src/codex-protocol/generated/ClientRequest.ts | wc -l
rg -o '"method": "[^"]+"' src/codex-protocol/generated/ServerNotification.ts | wc -l
rg -o '"method": "[^"]+"' src/codex-protocol/generated/ServerRequest.ts | wc -l
rg -c '^export type ' src/codex-protocol/index.ts
```
