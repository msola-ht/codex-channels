# Codex 官方文档与源码索引

本页用于定位 Codex App Server 的官方说明、`0.150.1` 固定版本源码，以及本项目对应实现。
它是查询入口，不替代生成协议类型，也不声明本项目支持官方协议的全部能力。

## 版本与数字

当前索引对应 [`src/codex-protocol/version.json`](../src/codex-protocol/version.json) 锁定的
`codex-cli 0.150.1`。生成时启用实验类型，但业务只采用固定版本官方 Plan 模式所需的
`collaborationMode/list`、`turn/start.collaborationMode`、原生 Thread Queue 六请求与
`thread/queue/changed`、Thread 分页历史与 Revert 所需的
`thread/turns/list`、`thread/revert`、`thread/reverted`，以及由配置开关控制的开发中
`plugin/installed` 与 Turn `mention` 调用；其他实验类型不表示已支持。

| 数量 | 是什么 | 事实来源 |
| ---: | --- | --- |
| 812 | 当前 CLI 生成的 TypeScript 文件总数 | `src/codex-protocol/generated/` |
| 98 | 生成目录根层的公共、兼容和初始化类型 | `src/codex-protocol/generated/*.ts` |
| 713 | v2 请求、响应、通知和数据类型 | `src/codex-protocol/generated/v2/*.ts` |
| 1 | `serde_json` 辅助类型 | `src/codex-protocol/generated/serde_json/` |
| 156 | 客户端发给 App Server 的 Request 方法 | [`ClientRequest.ts`](../src/codex-protocol/generated/ClientRequest.ts) |
| 81 | App Server 发给客户端的 Notification 方法 | [`ServerNotification.ts`](../src/codex-protocol/generated/ServerNotification.ts) |
| 11 | App Server 发给客户端、需要回应的 Request 方法 | [`ServerRequest.ts`](../src/codex-protocol/generated/ServerRequest.ts) |
| 1 | 客户端发给 App Server 的 Notification，即 `initialized` | [`ClientNotification.ts`](../src/codex-protocol/generated/ClientNotification.ts) |
| 68 | Codex Client 适配边界使用的受控协议类型导出 | [`src/codex-protocol/index.ts`](../src/codex-protocol/index.ts) |
| 45 | 本项目直接调用的业务 Request 方法，不含连接层的 `initialize` | [`client.ts`](../src/codex-client/client.ts) |
| 5 | 本项目显式协调的 Server Request 类型 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`bootstrap/scheduled-task-tool-request.ts`](../src/bootstrap/scheduled-task-tool-request.ts) |
| 15 | 本项目 TypeScript Gateway 的一级业务模块 | [`src/README.md`](../src/README.md) |

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
   再打开下面固定到 `rust-v0.150.1` 的链接，不能直接以 `main` 为准。

官方文档定义产品和协议行为；本项目实际字段必须以当前锁定 CLI 生成的 TypeScript 类型为准。
如果两者看起来不一致，先检查文档是否描述了更新版本，再审查固定版本源码和生成差异。

## 固定版本官方源码

以下链接固定到 OpenAI Codex `rust-v0.150.1`：

| 查询目标 | 官方源码 | 主要内容 |
| --- | --- | --- |
| App Server 总览 | [`app-server/README.md`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/README.md) | 启动方式、协议和开发入口 |
| JSON-RPC 消息总表 | [`rpc.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/src/rpc.rs) | Client Request、Server Notification、Server Request |
| 协议公共类型 | [`common.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/src/protocol/common.rs) | 初始化、ID、通用协议结构 |
| v2 协议入口 | [`v2/mod.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/src/protocol/v2/mod.rs) | v2 模块与受支持类型汇总 |
| Thread | [`thread.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) | Thread 请求、响应和生命周期 |
| Turn | [`turn.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/src/protocol/v2/turn.rs) | Turn 启动、追加、停止和状态 |
| 用户输入 | [`user_input.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/protocol/src/user_input.rs) | 文本、图片、一次性音频、Skill 与 Mention 输入 |
| Item | [`item.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/src/protocol/v2/item.rs) | 消息、命令、文件、工具等 Item |
| 图片生成 Item 与产物 | [`image_generation.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/ext/items/src/image_generation.rs)、[`artifact.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/ext/image-generation/src/artifact.rs) | `ImageGenerationItem.savedPath` 与生成图片落盘目录 |
| 官方模型 API 端点 | [`search.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/codex-api/src/endpoint/search.rs)、[`images.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/codex-api/src/endpoint/images.rs)、[`memories.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/codex-api/src/endpoint/memories.rs)、[`realtime_call.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/codex-api/src/endpoint/realtime_call.rs)、[`realtime_websocket/methods.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs) | OpenAI 搜索、图片、记忆摘要、Realtime HTTP 与 WebSocket 的固定请求后缀；Provider Proxy 只按该版本显式放行，不接受任意 OpenAI API 路径 |
| 权限协议 | [`permissions.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs) | 临时权限、命令网络上下文与持久规则结构 |
| MCP 协议 | [`mcp.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs) | MCP 状态与 form、openai/form、URL elicitation |
| Plugin 协议 | [`plugin.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs) | 开发中 Plugin 已安装、目录与安装类型；本项目只采用已安装响应 |
| 通知 | [`notification.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server-protocol/src/protocol/v2/notification.rs) | v2 Notification 参数 |
| Transport | [`transport.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/transport.rs) | stdio、WebSocket 和连接收发 |
| 初始化处理 | [`initialize_processor.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/initialize_processor.rs) | `initialize` 握手与能力协商 |
| Server Diagnostics 处理 | [`diagnostics.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/diagnostics.rs) | 实验、无内容的进程与运行时快照；本项目未采用 |
| Thread 请求处理 | [`thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/thread_processor.rs) | Thread 请求的运行时实现 |
| Thread 分页历史与 Revert | [`thread_revert.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/thread_revert.rs) | `thread/turns/list`、`thread/revert`、`thread/reverted`，分页历史、活动 Turn 中断与状态恢复 |
| Thread 队列处理 | [`thread_queue_processor.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/thread_queue_processor.rs) | 实验 `thread/queue/*` 的持久提交队列；本项目已采用六请求和 `thread/queue/changed`，通过 Client/Application 窄端口接入 |
| Thread 分区处理 | [`thread_sections.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/thread_sections.rs) | 内置 Pinned 分区、自定义分区与生命周期约束 |
| Thread 订阅生命周期 | [`thread_lifecycle.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/thread_lifecycle.rs) | 订阅、空闲卸载与 `thread/closed` |
| Turn 请求处理 | [`turn_processor.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/turn_processor.rs) | Turn 启动、追加、停止和状态 |
| 配置请求处理 | [`config_processor.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/config_processor.rs) | `config/read`、批量写入与用户配置热加载 |
| 模型目录测试 | [`model_list.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/model_list.rs) | 可见模型、分页和远端目录合同 |
| DeepSeek Codex 接入 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex) | Responses Provider、配置字段、官方脚本和当前支持模型 |
| DeepSeek Responses 指南 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/guides/responses_api) | 无状态会话、流式事件、原生图片输入、工具兼容性、缓存及用量字段 |
| DeepSeek 图像理解 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/guides/vision) | 视觉模型、图片输入格式、Token 计量与限制 |
| DeepSeek 创建响应接口 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/api/create-response) | `POST /responses` 请求字段、响应结构与 SSE 终止事件 |
| DeepSeek 账户余额 | [DeepSeek 官方余额接口](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/) | `GET /user/balance` 的可用状态、币种与余额字段；不提供 Codex 周限或历史 Token 汇总 |
| OpenCode Go | [OpenCode Go 官方文档](https://opencode.ai/docs/go/) | Provider 基础地址、模型端点、全模型美元价格、长上下文档位与套餐包含用量 |
| 账户请求处理 | [`account_processor.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/account_processor.rs) | 账户 Token 用量与额度读取 |
| 账户测试 | [`account.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/account.rs) | 用量读取、认证与错误合同 |
| Thread 用量测试 | [`account_thread_usage.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/account_thread_usage.rs) | `account/usage/read.threadId` 与估算用量合同；本项目按当前精确 Thread 采用，不递归合计子代理 |
| 额度测试 | [`rate_limits.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/rate_limits.rs) | 单桶、多桶、消费控制与重置券合同 |
| Skill 列表测试 | [`skills_list.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/skills_list.rs) | CWD、Scope、缓存、Plugin Skill 与变更通知合同 |
| MCP 请求处理 | [`mcp_processor.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/mcp_processor.rs) | Thread 配置上下文、精简清单、排序与分页 |
| Plugin 请求处理 | [`plugins.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/plugins.rs) | 已安装 Plugin 的 Workspace 发现、启用与可用状态 |
| MCP 工具审批 | [`mcp_tool_call.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/core/src/mcp_tool_call.rs) | 工具审批 elicitation 元数据、会话与持久授权响应 |
| MCP 状态测试 | [`mcp_server_status.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/mcp_server_status.rs) | 工具原名、项目级配置、实时元数据与精简清单合同 |
| MCP 资源测试 | [`mcp_resource.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/mcp_resource.rs) | Thread 可选上下文、文本/二进制资源读取与错误合同 |
| MCP 配置刷新测试 | [`executor_mcp.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/executor_mcp.rs) | 从磁盘重载配置并在已加载 Thread 的下一次活动 Turn 刷新 MCP |
| Plugin 列表测试 | [`plugin_list.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/plugin_list.rs) | Marketplace、已安装项、启用状态与 CWD 发现合同 |
| Catalog 请求处理 | [`catalog_processor.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/src/request_processors/catalog_processor.rs) | Permission Profile 的 CWD 配置归并、allowed 状态和分页 |
| Permission Profile 测试 | [`permission_profile_list.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/permission_profile_list.rs) | 内置、自定义、项目级 Profile 与分页合同 |
| 用户输入测试 | [`request_user_input.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/request_user_input.rs) | 问题、自动解决时限、响应与跨客户端失效合同 |
| MCP elicitation 测试 | [`mcp_server_elicitation.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/mcp_server_elicitation.rs) | 三种 elicitation 模式、能力协商与响应合同 |
| Thread 设置测试 | [`thread_settings_update.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/thread_settings_update.rs) | 模型、思考等级和服务层级通知合同 |
| Thread 分区测试 | [`thread_sections.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/thread_sections.rs)、[`thread_metadata_update.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/thread_metadata_update.rs) | 内置 Pinned 分区、移动、列表状态、迁移与分页保持合同 |
| Thread 队列与回退测试 | [`thread_queue.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/thread_queue.rs)、[`thread_revert.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/thread_revert.rs) | Queue 六请求、容量、分页、并发排序和通知，以及分页历史 Revert 的受控适配；联合 Queue/Revert 合同仍按条件测试门禁 |
| Server Diagnostics 测试 | [`server_diagnostics.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/server_diagnostics.rs) | 实验进程与运行时诊断快照；本项目未采用 |
| 上下文压缩测试 | [`compaction.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/compaction.rs) | 手动与自动压缩、`contextCompaction` Item 开始和完成通知合同 |
| Unix WebSocket 测试 | [`connection_handling_websocket_unix.rs`](https://github.com/openai/codex/blob/rust-v0.150.1/codex-rs/app-server/tests/suite/v2/connection_handling_websocket_unix.rs) | Unix Socket WebSocket 行为 |

## 当前支持矩阵

本表列出项目当前主动调用或消费的协议能力。未列出的生成类型不能直接视为已支持能力。
`codexc setup` 的脱敏总览复用既有 `config/read` 显示全局默认模型与思考等级，入口位于
[`setup-summary.mjs`](../scripts/setup-summary.mjs)，由 [`setup.test.ts`](../tests/setup.test.ts) 验证；
用户设置入口在显式确认后复用下表已有的版本化配置事务，不新增协议方法，也不修改登录状态。

| 能力 | 当前使用的官方方法或通知 | 本项目入口与验证 |
| --- | --- | --- |
| 结构化 Turn 策略错误 | `error`、`turn/completed` 中的 `TurnError.codexErrorInfo = misalignmentPolicyViolation` | Client 只识别该精确枚举并传递窄分类；Core 将错误文本与代码作为整体归约并保留 `willRetry=false` 与 `failed` 终态，三个 Surface 的完成卡片使用固定脱敏中文提示，Turn 指标保存独立分类与协议代码；[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`core.ts`](../src/conversation-core/core.ts)、[`turn-error-metrics.ts`](../src/bootstrap/turn-error-metrics.ts)、[`lifecycle-presentation.ts`](../src/surfaces/lifecycle-presentation.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`turn-error-metrics.test.ts`](../tests/turn-error-metrics.test.ts)、[`lifecycle-presentation.test.ts`](../tests/lifecycle-presentation.test.ts)、条件式真实策略错误合同 [`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP Plugin 来源 | `mcpServerStatus/list` 的 `McpServerStatus.pluginId` | Client 只保留可空、长度受限且符合固定上游 `<plugin>@<marketplace>` 字符规则的 ID；仅 `/mcp` 详情显示来源 Plugin，不用于授权、审批、命令/脚本来源推断或 OAuth 参数；[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`conversation-command-format.ts`](../src/surfaces/conversation-command-format.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`conversation-command-format.test.ts`](../tests/conversation-command-format.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Thread 原生 Queue | 实验 `thread/queue/add`、`thread/queue/list`、`thread/queue/update`、`thread/queue/delete`、`thread/queue/reorder`、`thread/queue/start`、`thread/queue/changed` | [`thread-queue-port.ts`](../src/application/thread-queue-port.ts)、[`queue-adapter.ts`](../src/codex-client/queue-adapter.ts)、[`conversation-service.ts`](../src/application/conversation-service.ts)；100 条原生容量、25 条公开分页、文本编辑和非文本安全摘要；[`thread-queue.test.ts`](../tests/thread-queue.test.ts)、[`thread-queue-service.test.ts`](../tests/thread-queue-service.test.ts)、[`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、条件式真实容量/分页/派发/重启合同 [`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Thread 分页历史与 Revert | 实验 `thread/turns/list`、`thread/revert`、`thread/reverted` | 新建 Thread 显式使用 `historyMode: "paginated"`；[`thread-history-port.ts`](../src/application/thread-history-port.ts)、[`history-adapter.ts`](../src/codex-client/history-adapter.ts)、[`conversation-service.ts`](../src/application/conversation-service.ts) 与 [`conversation-core/core.ts`](../src/conversation-core/core.ts) 提供有界列表、五分钟一次性确认、执行前并发复核、Queue 原顺序保留和派生状态失效；[`thread-history.test.ts`](../tests/thread-history.test.ts)、[`thread-revert-service.test.ts`](../tests/thread-revert-service.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、条件式真实分页/活动中断/Queue 保留与显式派发/Revert 合同 [`real-app-server.test.ts`](../tests/real-app-server.test.ts)；不接入 `thread/items/list` |
| 初始化与连接 | `initialize`、`initialized` | [`codex-client/`](../src/codex-client/README.md)、[`doctor.mjs`](../scripts/doctor.mjs)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts)；发送消息受生成的 `ClientRequest` / `ClientNotification` 约束，初始化通过 `extensions` 显式声明已实现的 `openai/form`，Doctor 只从 `initialize.userAgent` 提取运行中 App Server 的实际版本并与锁定版本比较 |
| Thread 生命周期与分区 | `thread/list.modelProviders`、`thread/read`、`thread/start`、`thread/start.threadSource`、`thread/resume`、`thread/fork`、`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/unsubscribe`、`thread/name/set`、`thread/metadata/update`、`thread/section/move`、`threadSection/list`、`threadSection/create`、`threadSection/update`、`threadSection/delete`、`thread/compact/start`、`thread/closed`、`thread/archived`、`thread/deleted` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 把官方 `section`、`modelProvider` 映射为稳定快照，并把官方 `threadSource="automation"` 来源投影为稳定 `automation`；[`conversation-service.ts`](../src/application/conversation-service.ts) 通过 `/pin`、`/unpin` 和 `/section` 编排固定、自定义分区、列表计数、完整历史搜索和 `beforeThreadId` 排序，分区视图使用官方 `section_position`。所有分区状态仍由主 App Server 的持久 Store 管理，Provider Thread 的移动由 Provider Router 路由到所属实例；Gateway 不建立第二套分区索引。自定义分区是全局状态，写操作只允许配置的全局分区管理员，内置 Pinned 不允许改名或删除，删除前必须确认且只解除归属。移动前原样回写当前 Git SHA，再由读回结果验证；固定与自定义分区按官方规则互斥。运行中 `/resume` 或 `/new` 继续把原 Thread 作为有界后台任务；StateStore 只保存最小绑定。`thread/resume` 返回 active-writer 冲突（固定或官方包装文案）时，Gateway 保留绑定、继续启动其他 Thread，并按退避只重试未恢复项；连续未知失败达到阈值也会向会话升级占用提示，官方写入方释放后恢复订阅并发送恢复提示，三渠道各收到一次占用与恢复提示。`/release` 只读定位持锁进程，`/release force` 在显式确认后向该 Codex 进程发送结束信号并立即重试恢复；不删除锁文件、不建立第二写入方；[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`gateway-startup-cleanup.test.ts`](../tests/gateway-startup-cleanup.test.ts)、[`thread-writer-lock.test.ts`](../tests/thread-writer-lock.test.ts)、[`surface-copy-contract.test.ts`](../tests/surface-copy-contract.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Thread 设置与 Provider 路由 | `thread/start.modelProvider`、`thread/fork.modelProvider`、`thread/settings/updated`、`model/list`、`config/read`、`config/batchWrite`、实验 `collaborationMode/list` | [`model-port.ts`](../src/application/model-port.ts) 与 [`collaboration-mode-port.ts`](../src/application/collaboration-mode-port.ts) 定义稳定设置边界，[`model-adapter.ts`](../src/codex-client/model-adapter.ts) 映射 App Server 目录；`codexc setup` 的 Codex 用户设置入口从同一目录选择全局模型与思考等级，并把 Fast、`sandbox_mode`、`approval_policy` 与 `sandbox_workspace_write.network_access` 收敛到带用户层修订检查的受控 `config/batchWrite` 事务；“一键配置全部”在一次确认后提交包含六个字段的同一原子事务。Fast 是 OpenAI 主配置偏好，不读取第三方模型目录；入口不修改登录凭据、第三方 Provider 配置或 Gateway Thread 默认值，用户层已有 `default_permissions` 时不混写传统 Sandbox 字段。`codexc remote` 的显式参数和 Workspace 权限继续优先，未覆盖时不再注入 Gateway 默认权限，而由 Codex 主配置及所选 Profile 自然归并。[`model-provider-catalog.ts`](../src/codex-client/model-provider-catalog.ts) 只在受管 Provider 已启用时映射 Setup 下载并审查的模型目录；自定义切换 Provider 不生成目录文件，而由 [`model-selection-service.ts`](../src/application/model-selection-service.ts) 把主 App Server 的 Codex 官方目录以精确 Provider ID 克隆为可选项。切换模式保持 OpenAI 基础配置不变，把 DeepSeek 与 OpenCode Go 的 Provider、Key、路由和价格隔离在统一 `sf-` 前缀的各自 Profile，模型目录、清单与管理标记存放在 `~/.codex-connect/providers/<id>/`；自定义第三方同样不写主配置，通过私有显式注册表和逐 Provider 的 `sf-custom-<id>` 完整 Profile 保存 Provider 块、Key、默认模型、`medium` 思考等级与服务层级。受管 Provider 模型设置按 Provider 和模型保存目录上下文、默认思考等级与自动压缩阈值；受管切换 Profile 只选择当前默认模型并镜像该模型的默认思考等级（校验必须与模型目录一致），固定模式继续通过官方 `config/batchWrite` 写入默认模型并清除会覆盖目录设置的根级思考、上下文与压缩字段。历史 Thread 仍使用自身模型。由于固定版本不允许 Profile 选择器用于 `app-server`，服务入口校验各自私有 Profile 后，通过官方 `-c` 进程覆盖和仅对子进程可见的 Key 环境变量按需启动隔离 App Server，并显式移除其他受管 Provider Key。[`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts) 按官方 `modelProvider` 路由 Thread/Turn，隔离 Server Request ID 和单 Provider 重连；第三方账户通知不进入 OpenAI 账户状态，无法关联 Thread 的 MCP 与 warning 全局通知携带 Provider 来源并只投递到对应 Provider 会话。对应 App Server 在进程启动时加载自己的模型目录，避免进程级模型元数据管理器对 Thread 级目录覆盖使用 fallback。`codexc remote` 连接主实例；切换模式的 `--profile custom-<Provider ID>`、`--profile deepseek`、`--profile opencode-go`（默认账户）与任意 `--profile opencode-go-<账户>` 是项目公开名称，内部映射到对应 `sf-*` 文件并连接对应 Provider Socket；所有已知受管内部名称以及保留的 `sf-custom-*` 名称误用于公开入口时都会明确拒绝。旧版单账户 OpenCode Go 配置在 CLI/服务启动时只补账户注册表（`providers/opencode-go/accounts.json`），Provider id 保持 `opencode-go`、Profile 与角色文件不重命名，因此旧会话与历史统计天然兼容；未受管的旧 Profile 不自动迁移。官方目录中的 Flash、Flash Vision Exp 与 Pro 均可选择，新安装默认使用 Flash Vision Exp；`codexc update` 刷新受控官方目录时保留既有选中模型和逐模型设置。模型和价格变化由人工对照官方资料更新审查基线，未知模型仍须加入编译期受控定义后才可选择。Flash Vision Exp 从目录声明读取 `text/image` 输入能力并沿用稳定的内联 `image` Turn 输入，不新增 DeepSeek API 调用层；跨 Provider 选择保留并解绑原 Thread，在下一条消息中以目标模型目录的默认思考等级创建新 Provider Thread，不继承原 Provider 设置，不 Fork 或复制 Provider 专属历史；同一 Provider 内模型选择仍作为下一 Turn 覆盖并保留兼容思考等级。Workspace、新会话和同 Provider 历史 Thread 切换会在 Conversation 内存中保留当前模型、思考等级与服务层级；自动接续只选择匹配 Provider 的候选，显式恢复不同 Provider 的历史 Thread 时尊重其原 Provider。Application 在创建或追加 Turn 前按模型目录检查图片和音频能力，避免文本模型静默接收占位输入。官方设置通知没有携带可变 Provider 时，Router 保留已确认的 Provider；[`codex-user-settings-management.test.ts`](../tests/codex-user-settings-management.test.ts)、[`codex-user-settings-setup.test.ts`](../tests/codex-user-settings-setup.test.ts)、[`codex-defaults-setup.test.ts`](../tests/codex-defaults-setup.test.ts)、[`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`model-selection-service.test.ts`](../tests/model-selection-service.test.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`deepseek-catalog.test.ts`](../tests/deepseek-catalog.test.ts)、[`deepseek-setup.test.ts`](../tests/deepseek-setup.test.ts)、[`model-provider-default-setup.test.ts`](../tests/model-provider-default-setup.test.ts)、[`model-provider-file-layout.test.ts`](../tests/model-provider-file-layout.test.ts)、[`model-provider-runtime.test.ts`](../tests/model-provider-runtime.test.ts)、[`collaboration-mode-service.test.ts`](../tests/collaboration-mode-service.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts) |
| Turn 控制 | `turn/start`、实验 `turn/start.collaborationMode`、`turn/steer`、`turn/interrupt`、`turn/started`、`error`、`turn/completed` | [`turn-port.ts`](../src/application/turn-port.ts) 定义稳定执行、结构化 Skill 输入、当前 Turn 最终回答 Schema 与 Default/Plan 覆盖端口，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 编码请求与响应；[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射生命周期通知、校验官方 `Turn.durationMs` 并统一脱敏、限长可显示的错误；显式 Skill 调用同时发送 `$<skill-name>` 文本标记和官方 `skill` 输入项，活动 Turn 不允许切换协作模式；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Item 与流式输出 | `item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/reasoning/summaryPartAdded`、`item/reasoning/textDelta` | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 分类稳定 Item 事件，[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts) 生成脱敏操作摘要，并只把官方 `imageGeneration.savedPath` 映射为生成图片产物，[`core.ts`](../src/conversation-core/core.ts) 只归约稳定输入；官方三个推理通知只作为“思考中…”状态驱动，摘要与原始思维链内容不进入渠道，连续思考每段只显示一次，每段独立计时并以最终标记结束，操作打断后再次思考会重新显示，首个回复增量、错误或完成时停止，`display.reasoning = false` 时三渠道不显示；模型代理计时不可用时，输出速度仍由 Client 在通知边界记录接收时间戳、Core 按 Thread 归约最后一次模型响应中不含推理的输出 Token 与最终回答流式时长，不消费新协议字段；[`generated-image.ts`](../src/surfaces/generated-image.ts) 对三渠道共用的生成图片本地读取执行绝对路径、无符号链接、普通文件、10 MiB 与 PNG/JPEG 签名校验；同一读取校验也用于 `codexc channel send-image` 提交的渠道 spool 图片；[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`operation-adapter.test.ts`](../tests/operation-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`lifecycle-presentation.test.ts`](../tests/lifecycle-presentation.test.ts)、[`telegram-outbox.test.ts`](../tests/telegram-outbox.test.ts)、[`feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts)、[`weixin-outbox.test.ts`](../tests/weixin-outbox.test.ts)、[`channel-image-spool.test.ts`](../tests/channel-image-spool.test.ts)、[`channel-send-image.test.ts`](../tests/channel-send-image.test.ts) |
| 子代理活动与终态 | `subAgentActivity`、子线程 `turn/started` / `turn/completed`、`item/completed` 的 `collabAgentToolCall.receiverThreadIds` 与 `agentsStates` | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 只在 Item 完成阶段把官方活动类型映射为稳定事件，避免开始与完成阶段重复登记；Core 把 `started` 显示为子代理开始、把不改变当前存活状态的 `interacted` 显示为子代理继续，`interrupted` 只参与精确终态。[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts) 把官方接收线程和状态映射为不含代理消息正文的稳定操作事件。[`subagent-completion-tracker.ts`](../src/bootstrap/subagent-completion-tracker.ts) 登记生成的子代理线程，并按子线程 `turn/started` 把每轮精确子 Turn 与父 Turn 写入指标库 Schema v11 的 `subagent_turns`；子 Turn 先于父 `interacted` 到达时会与有界待处理活动合并，上一轮仍在指标结算窗口内时分离结算，延迟终态和指标只匹配原子 Turn，避免快速继续覆盖或串入新一轮。Tracker 以 App Server 自动订阅后发送的子线程 `turn/completed`、官方中断活动及旧版工具终态结算指标；已观察到模型指标且终态后出现同一父 Turn 的官方 `wait` Item 时，再等待该子 Thread + Turn 的 Writer 当前持久化水位并立即发布，使该等待操作稳定先于完成卡片；尚无指标或终态后未出现父线程等待时保留有界收敛窗口，极快子线程先完成后登记时按 Thread + Turn 短期有界保留终态。先前父 Turn 的 `wait` 不会加速之后才终止的并行或后续子代理。指标到达和静默时间不推断终态。无指标发布零统计，读取失败显示统计不可用。三个 Surface 的紧凑操作模式共用同一策略，只保留子代理启动和失败，抑制成功的等待与交互操作；完成卡片展示模型、请求、Token、费用及全量计价均价，缓存、推理、费用分项和模型请求聚合耗时仅在调试模式展示。[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`subagent-completion-tracker.test.ts`](../tests/subagent-completion-tracker.test.ts)、[`lifecycle-presentation.test.ts`](../tests/lifecycle-presentation.test.ts)、[`request-metrics-store.test.ts`](../tests/request-metrics-store.test.ts)、[`metrics-database.test.ts`](../tests/metrics-database.test.ts)、[`telegram-outbox.test.ts`](../tests/telegram-outbox.test.ts)、[`feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts)、[`weixin-outbox.test.ts`](../tests/weixin-outbox.test.ts) |
| 上下文压缩 | `thread/compact/start`、`contextCompaction` Thread Item 与 `item/completed` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 从恢复历史提取压缩 Item ID，[`core.ts`](../src/conversation-core/core.ts) 合并实时完成 Item 并去重，[`conversation-service.ts`](../src/application/conversation-service.ts) 公开总次数；[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`telegram-format.test.ts`](../tests/telegram-format.test.ts)、[`telegram-outbox.test.ts`](../tests/telegram-outbox.test.ts)。生成类型中的 `thread/compacted` 已标记废弃，统计不依赖它；当前 Item 不提供手动/自动触发来源，因此只显示总次数 |
| 警告 | `warning`（Thread 目标或全局） | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射并统一脱敏、限长消息，[`core.ts`](../src/conversation-core/core.ts) 只负责目标路由；[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts) |
| Diff、计划产物与 Review | `turn/diff/updated`、`turn/plan/updated`、`review/start` | Review 目标与结果由 [`turn-port.ts`](../src/application/turn-port.ts) 定义，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 映射；Diff/计划产物通知经 [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 转成稳定事件后由 Core 归约。计划还通过结构化 `plan.updated` 输出，默认由三个 Surface 展示，`display.plan_updates = false` 时关闭；计划产物通知与切换官方 Plan 协作模式是两个独立边界 |
| Goal | `thread/goal/get`、`thread/goal/set`、`thread/goal/clear`、`thread/goal/updated`、`thread/goal/cleared` | [`turn-port.ts`](../src/application/turn-port.ts) 定义执行端口，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 映射请求结果，[`conversation-service.ts`](../src/application/conversation-service.ts) 在 set/clear 成功后立即同步 Core，[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 把外部变更与恢复通知转换为稳定 Core 事件；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 审批和用户输入 | 命令、文件、权限、用户输入、MCP elicitation 共 5 类审批 Server Request；MCP 工具审批按 form 的 `mcp_tool_call` 元数据区分，并只返回上游提供的 `session` / `always` 范围；`thread/start`、`thread/resume` 按 Workspace 权限传 `approvalPolicy` / `sandbox` / `permissions`（`permissions` 与 `sandbox` 互斥）；已授权用户可通过渠道 `/workspaceperm` 查看或修改当前 Workspace 权限 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts) 负责协议解码与编码，[`approval/`](../src/approval/README.md) 负责稳定授权语义，各 Surface 只实现平台交互，[`router.ts`](../src/session-routing/router.ts) 把配置权限映射为 Thread 启动参数，[`workspace-permission-writer.ts`](../src/bootstrap/workspace-permission-writer.ts) 写回配置并校验互斥；[`approval.test.ts`](../tests/approval.test.ts)、[`feishu-interactions.test.ts`](../tests/feishu-interactions.test.ts)、[`telegram-interactions.test.ts`](../tests/telegram-interactions.test.ts)、[`weixin-interactions.test.ts`](../tests/weixin-interactions.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`workspace-permission-writer.test.ts`](../tests/workspace-permission-writer.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 计划任务动态工具 | 实验 `thread/start.dynamicTools`、`item/tool/call` | Gateway 前台新 Thread 注册 `schedule_task`；Bootstrap 的 [`scheduled-task-tool-request.ts`](../src/bootstrap/scheduled-task-tool-request.ts) 将模型参数解码后交给 Application [`ScheduledTaskToolService`](../src/application/scheduled-task-tool.ts) 复用现有创建预览/列表/生命周期用例；工具不暴露 `confirm`，用户仍必须通过 `/schedule confirm` 确认创建或删除。后台计划任务 Thread 不注册工具，`createScheduledTaskServerRequestHandler` 也拒绝递归工具调用。官方只允许在 `thread/start` 注入工具，因此旧 Thread 保持当前 Provider、模型和上下文，Gateway 不为工具注入自动替换前台 Thread；旧 Thread 继续使用 `/schedule`，用户显式新建的 Thread 才注册工具；[`scheduled-task-tool.test.ts`](../tests/scheduled-task-tool.test.ts)、[`scheduled-task-server-request.test.ts`](../tests/scheduled-task-server-request.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Skill、MCP 与 Plugin | `skills/list`、`turn/start` / `turn/steer` 的 `input.skill` 和 `mention`、`mcpServerStatus/list`、`config/mcpServer/reload`、`mcpServer/oauth/login`、`mcpServer/oauthLogin/completed`、`mcpServer/resource/read`、MCP 状态通知与 Tool Item `readOnlyHint`、开发中 `plugin/installed` | Skill、MCP 与 Plugin 分别由 [`skill-port.ts`](../src/application/skill-port.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`plugin-port.ts`](../src/application/plugin-port.ts) 及对应 Client 适配器隔离。MCP 按当前 Thread 提供有界详情、健康摘要、刷新、OAuth 与只读 Resource；工具目录和实际 Tool Item 的读写提示统一归约为只读、可能写入或未知，但不替代审批或执行结果，也不暴露直接 Tool Call。Plugin 只在默认关闭、显式开启的开发中开关下列出或查看当前 Workspace 已安装项，并可在 OpenAI Thread 中发送官方 `mention`；Application 对同一次 `plugin/installed` 响应提供每页 8 项的本地分页过滤和只含需处理项的健康摘要，保留全局序号且不调用实验 `plugin/search`；详情使用响应中的版本、来源类型、安装时间、开发者、分类、能力、认证时机、不可用原因和适用套餐标识，能力与套餐各有界展示 8 项，不传播来源路径、URL、图标、截图、默认提示词或原始 Marketplace 错误。Marketplace 搜索、安装、卸载和分享仍禁止。三个 Surface 共用解析与输出；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`conversation-command-format.test.ts`](../tests/conversation-command-format.test.ts)、[`operation-adapter.test.ts`](../tests/operation-adapter.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`surface-copy-contract.test.ts`](../tests/surface-copy-contract.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP 与扩展任务通知口径 | MCP 启动状态通知、`turn/started` | MCP 首次 `starting` / `ready` 状态保持静默，[`core.ts`](../src/conversation-core/core.ts) 只投递失败、取消和异常恢复，避免与主动查询或认证结果重复。Skill、Plugin 和子代理新建 Turn 时只由共享生命周期确认，并在该事件中保留具体类型和名称；追加到活动 Turn 时保留命令确认；[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`surface-copy-contract.test.ts`](../tests/surface-copy-contract.test.ts)、[`feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts) |
| 用量、额度与权限 | OpenAI：`account/usage/read`（账户摘要与可选 `threadId` 官方估算）、`account/rateLimits/read`、账户通知；DeepSeek：`GET /user/balance`；OpenCode Go：`GET /zen/go/v1/usage`；权限：`permissionProfile/list` | [`account-port.ts`](../src/application/account-port.ts) 与 [`provider-account-service.ts`](../src/application/provider-account-service.ts) 按当前 Thread 的 `modelProvider` 返回 Token 用量、精确 Thread 官方估算、额度、第三方余额、配额窗口或明确不支持；OpenAI [`account-adapter.ts`](../src/codex-client/account-adapter.ts) 接受固定版本完整 `PlanType`，其中 `ent26` 显示为 Enterprise，并严格校验官方 Thread ID、整数单位和分组字段；`/usage` 保留账户摘要为主结果，当前 OpenAI Thread 的估算查询并行且失败隔离，不缓存、轮询或聚合子代理；`/limits` 仅在官方响应包含 10,080 分钟窗口与有效重置时间，且本机统计代理在相同重置周期观测到额度正向变化时，用 [`request-metrics-port.ts`](../src/application/request-metrics-port.ts) 按相邻快照区间估算每 1% Token 与 API 参考费用；DeepSeek [`deepseek-account-adapter.ts`](../src/bootstrap/deepseek-account-adapter.ts) 通过共享 [`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs) 从切换 Profile 或固定基础配置读取 Key、复用统一代理并裁剪官方余额；OpenCode Go [`opencode-go-account-adapter.ts`](../src/bootstrap/opencode-go-account-adapter.ts) 通过同一运行时读取凭据，把官方 `/usage` 的 5 小时/7 天/月度三个窗口归约为通用 `quota-windows` 形态（已用百分比与重置时间），命令与 WebUI 按窗口展示，并按官方价格基线从本机指标库重算模型本地用量、DeepSeek 按请求时间拆分 Off-Peak / Peak 两档；Thread Token/上下文统计保持 Provider 通用，OpenAI 周限不附加到第三方 Thread；账户通知仍由 [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射，Permission Profile 由 [`permission-port.ts`](../src/application/permission-port.ts) 与 [`permission-adapter.ts`](../src/codex-client/permission-adapter.ts) 隔离；[`provider-account-service.test.ts`](../tests/provider-account-service.test.ts)、[`deepseek-account-adapter.test.ts`](../tests/deepseek-account-adapter.test.ts)、[`opencode-go-account-adapter.test.ts`](../tests/opencode-go-account-adapter.test.ts)、[`conversation-command-format.test.ts`](../tests/conversation-command-format.test.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 全 Provider 模型代理与速度统计 | App Server 服务数据通路，不新增 RPC | [`provider-proxy/`](../src/provider-proxy/README.md) 由 App Server 服务持有，为 OpenAI 主实例、首次使用的受管 DeepSeek/OpenCode Go 实例及自定义切换实例分配独立回环代理；[`app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs) 以私有监管 Socket 独占并证明精确 Provider 拓扑，可选 Provider 的代理与隔离 App Server 按需启动，前台只复用完成真实 WebSocket 握手的受监管实例，裸 App Server、重复监管入口和重复 Gateway 均失败关闭。代理流式转发 HTTP/SSE、Responses WebSocket、HTTP `/responses/compact` 与只读 `/models`，保留上游状态与端到端 Header，并剥离本地 Turn 元数据；[`bin/codexc.mjs`](../bin/codexc.mjs) 复用统一网络代理、保留显式 `openai_base_url`，再通过 [`withOpenAiBaseUrl`](../runtime/model-provider-runtime.mjs) 或 [`withProviderBaseUrl`](../runtime/model-provider-runtime.mjs) 把对应 App Server 指向本机代理。首 Token、推理、Usage、文本与函数/自定义工具参数输出的首尾时间经 `0600` 私有 Unix Socket 投递并在响应完成事件前确认归约，[`bootstrap/app.ts`](../src/bootstrap/app.ts) 把指标同时送入有界持久化 Writer 与稳定 Core 事件；缺少 `Content-Type` 时仅按合法 `response.*` SSE 正文恢复元数据，HTTP 与 WebSocket 客户端在完成事件前断开都保留为中断失败，HTTP/SSE 已完成后的正常收尾断开不重复记为失败，上游 WebSocket 断流与 HTTP `429/5xx` 同为可重试失败并在 Turn 完成时归入自动重试，HTTP 2xx 仍未观察到可解析完成事件、模型和 Usage 时归为 `incomplete/response_not_observed`，不冒充成功请求；Codex 0.150.1 `request_kind=prewarm` 的 `generate=false` WebSocket 连接预热透明转发但不写模型请求指标；旧版 `/responses/compact` 与 Codex 0.146 默认在普通 HTTP/WebSocket `/responses` 上用私有 `request_kind=compaction` 标记的 remote compaction v2 都归为压缩请求，其 Usage、费用和额度快照仍进入会话及全局汇总、异常报告与周额度估算。Core 不读取 SQLite，按 Turn 聚合全部关联请求的次数并在存在异常尝试时拆分完成、中断、未完整观测和失败数量，同时统计累计模型耗时、缓存、不含推理的综合输出速度和总价；DeepSeek 额外在调试模式开启时展示最后请求首字延时，并始终展示整轮综合思考/生成速度，OpenAI 不以隐藏推理或摘要时间估算详细计时。Bootstrap 的 [`model-pricing-catalog.ts`](../src/bootstrap/model-pricing-catalog.ts) 启动时读取私有缓存并异步刷新 LiteLLM 价格目录，失败时回退到 Sub2API 使用的 `Wei-Shaw/model-price-repo` 镜像；每个新请求只保存发生时的 USD API 参考价格快照，历史不回算，ChatGPT 订阅请求不冒充真实账单。[`reference-cost-summary.ts`](../src/bootstrap/reference-cost-summary.ts) 在 Turn 完成时合并持久化历史和当前实时计价，避免延迟写入造成重复或遗漏。`/metrics` 经 Application [`request-metrics-port.ts`](../src/application/request-metrics-port.ts) 只读查询当前 Thread 最近 Turn 聚合和最近直接 API，并在最近运行与会话累计中对所有 Provider 按本机实际用量展示均价（每 100M Token）；`global/providers/models` 在独立指标库内统一聚合 Codex Provider 与直接 API 的自然日、周、月、最近 24 小时至 365 天或全部保留历史记录，缓存、输出速度、TTFT 平均/P50/P95 和总价都保留有效样本覆盖，总价按全局 `price_currency` 统一显示（默认人民币），先出总计、再列出输入、缓存、输出三项价格明细，不显示目录静态单价；跨价格档位聚合时明确标记多档价格，分组最多展示请求量最高的 20 项；`errors` 使用相同时间范围，以全部模型请求为失败率分母，并按提供商、模型、状态、HTTP 状态和错误类型展示异常次数与最近发生时间，未发起上游请求的 Turn 级失败（如用量上限）与 WebSocket 握手失败同样计入；请求累计输入不冒充 App Server 上下文。Observability Store 默认保留 365 天且最多 1,000,000 行，可由 `[metrics.storage]` 调整，并提供先备份、后按日期或行数清理的 `codexc metrics cleanup`；同时提供不获取写锁的只读模式和每页最多 500 条的稳定 ID 分页，`codexc metrics` 的 `report`、`export`、`run`、`turns`、`threads` 都支持 Markdown/JSON/CSV 三格式导出，`report` 与 `export` 还支持自定义本地自然日区间（默认写入 `~/.codex-connect/output/<日期>/`），`threads` 提供会话归纳总览（模型、思考等级、Token 与总价），`turns` 提供每次对话明细，MD 报表按 `price_currency` 配置换算币种并显示本地时间，JSON/CSV 保留原始币种、nanos 与 ISO 时间；[`scripts/webui-server.mjs`](../scripts/webui-server.mjs) 提供 `codexc webui` 本地 WebUI，复用同一只读查询能力并直接使用 Observability Store 的分页与错误查询，默认只监听回环地址，绑定非回环地址（`0.0.0.0`）时必须设置访问令牌（`--token` 或 `[webui] token`），前端构建产物随 npm 包发布，不直接读取业务会话库；WebUI 也可作为独立后台服务由 `codexc service start webui` 管理，不并入 `all`。Gateway 停止时实时卡片指标可丢失但模型请求不中断；[`provider-proxy.test.ts`](../tests/provider-proxy.test.ts)、[`provider-proxy-metrics.test.ts`](../tests/provider-proxy-metrics.test.ts)、[`provider-metrics-composition.test.ts`](../tests/provider-metrics-composition.test.ts)、[`model-pricing-catalog.test.ts`](../tests/model-pricing-catalog.test.ts)、[`request-metrics-store.test.ts`](../tests/request-metrics-store.test.ts)、[`metrics-database.test.ts`](../tests/metrics-database.test.ts)、[`reference-cost-summary.test.ts`](../tests/reference-cost-summary.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`conversation-command-format.test.ts`](../tests/conversation-command-format.test.ts)、[`model-provider-runtime.test.ts`](../tests/model-provider-runtime.test.ts)、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts) |
| 真实合同 | 模型、思考等级、Fast、`multi_agent_v2` 与 agents 用户设置、Skill/MCP/Plugin/Permission 稳定查询、Plugin 安全详情字段、结构化 Skill 与 Plugin mention Turn 输入、MCP 配置刷新、完整详情与工具读写属性、只读资源、OAuth PKCE 回调与完成通知、MCP 工具审批元数据与持久范围往返、Default/Plan 预设与 Plan Turn 设置通知、共享 Thread 设置通知、当前精确 Thread 官方用量估算、跨客户端 Thread 固定和自定义分区状态、分区删除解除归属、Turn 启动结果、跨客户端 Goal 请求与通知、重连后 resume Goal 恢复、双客户端连接恢复、动态工具注册与 `item/tool/call` 完整往返，以及真实 `service-app-server` 的 Provider 租约拒绝释放 | [`real-app-server.test.ts`](../tests/real-app-server.test.ts) |

自定义 Responses Provider Setup 的官方模型目录复用、手工模型 ID、固定/切换双模式、直接 API Key、
独立 Profile、候选编辑、共享 `agents.external` 的无凭据角色文件与统计代理接入，以及私有备份事务边界见
[`第三方模型 Provider 接入指南`](provider-integration-guide.md)；该本地 Setup 能力不新增 App Server RPC。

上表“全 Provider 模型代理与速度统计”还包括仅官方 OpenAI 主代理启用的 0.150.1 固定端点清单：
搜索、图片、记忆摘要与 Realtime HTTP/WS 请求透明转发且不计入 Responses 指标；DeepSeek、
OpenCode Go 和自定义第三方代理仍拒绝这些路径。真实合同使用当前锁定 App Server 验证
`POST /alpha/search` 能穿过该白名单并完成工具结果往返。

Provider 生命周期补充：私有 [`app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs) 不是
Codex App Server RPC。它负责受管实例的按需启动和主动释放；`codexc remote` 连接受管 Provider
期间通过同一私有 Socket 持有生命周期租约，Supervisor 在租约存在时拒绝释放，并在连接正常退出
或异常断开后自动撤销租约。同一 Provider 的启动、释放与租约获取串行执行，释放响应区分已释放、
租约占用与实例未运行；账户删除遇到旧版或无效监管响应时失败关闭。该边界避免 OpenCode Go 空闲
回收终止共享 Remote TUI。

模型价格实现补充：DeepSeek 不使用上述通用远程目录，[`deepseek-model-pricing.ts`](../src/bootstrap/deepseek-model-pricing.ts)
严格读取随包发布的官方人民币基线，按请求开始时的北京时间、生效计划、工作日与周末规则选择
峰谷价，再用当前 USD/CNY 汇率固化为统一 USD 快照，并把请求时段对应的 Peak/Off-Peak 档位写入
快照；汇率、精确
模型或计划缺失时不回退通用目录。模型目录与价格基线由人工对照 DeepSeek 官方文档审查更新，
运行中的 Gateway 不抓取价格 HTML。
OpenCode Go 使用独立的 [`opencode-go-model-pricing.ts`](../src/bootstrap/opencode-go-model-pricing.ts)
读取人工审查的官方美元价格基线并按请求开始时间（UTC）选择 Peak/Off-Peak 价；维护时同时核对
官方页面全部模型的价格、时段、端点和 SDK 协议，但只为编译期受控且通过 Codex 0.150.1
真实 App Server 按需启动、初始化与模型列表合同验证的模型计价和开放选择。`/usage` 与 WebUI
在官方账户窗口外，还用当前官方价格基线按请求开始时间重新计价（峰谷对齐）当前官方月度窗口
（由 `resetsAt` 倒推开始时间）内各模型已用金额；价格更新生效时间（基线 `sourceUpdatedAt`）之前
的请求使用当时保存的价格快照，之后的请求按当前基线重算；档位优先沿用请求时保存的
`pricing_bucket`，快照缺失时才按当前基线判定。对照基线中的模型包含用量（如
DeepSeek V4 Flash 每月 $30、V4 Pro 每月 $15）计算已用百分比与剩余额度。

指标库 Schema v8 为价格快照新增 `pricing_bucket` 列（`peak`/`off-peak`），Schema v9 再新增
`quota_windows` 列保存 OpenCode Go 请求发生时的官方 5 小时/7 天/月度窗口 `resetsAt` 快照，Schema v10
为 `subagent_threads` 新增可空 `parent_turn_id`，Schema v11 新增按子 Thread + Turn 记录精确父 Turn
归属的 `subagent_turns`；旧库由 `codexc metrics upgrade` 显式备份迁移，历史运行归属不按时间猜测。完成卡片与 `/metrics`
费用区对支持峰谷的 Provider 标注
单档（Peak/Off-Peak）或跨档（多档），展示层只认注入数据不识别具体 Provider。DeepSeek 官方账户
保持纯余额展示（官方无用量窗口）；OpenCode Go 的本地模型用量重算按请求记录的官方窗口快照
归属（缺失时由官方 `resetsAt` 倒推窗口）执行。

用户级 `config/read` 不携带 Workspace CWD，只读取全局用户配置；模型、思考等级、Fast、
`multi_agent_v2` 与受控共享第三方角色 `agents.external` 的普通键级写入共用一次官方
`config/batchWrite` 事务。角色只保存当前选择的 Provider 与模型；DeepSeek、OpenCode Go 的
切换和固定模式都复用同一角色机制；切换模式受管 Profile 镜像所选模型的默认思考等级，第三方
App Server 启动时读取 Profile 的该设置并显式携带，原生 `codex --profile sf-*` 与 Remote/
App Server 保持一致，避免继承全局 `config.toml` 的官方思考等级。角色模型请求还使用本地私有
`/role/external` 代理路径携带该默认思考等级进入脱敏指标；普通渠道和 Remote TUI 不走此路径。
受控角色的读改写从同一 Client 的原始用户层取得版本并传入 `expectedVersion`，版本冲突失败关闭，
不自动重试或覆盖用户并发修改。
DeepSeek 完整安装、备份恢复和 App Server 无法管理的专属文件仍由 Setup 执行私有文件级事务。

完成卡片中的“思考次数”表示本轮明确返回推理 Usage 且推理输出大于零的模型请求数；上游未返回
推理 Usage 时不猜测。用户界面的费用统一以 `**费用**：总价` 列表块显示，底层仍按当次 API 价格快照计算。

当前生成协议还包含文件系统 RPC、独立命令执行、登录、Marketplace、App、Realtime、
Remote Control、动态工具、Attestation 和实验能力等类型；它们没有因此自动成为 Gateway
公开能力。采用其中任何能力前，必须先审查对应 Server Request、Notification、安全边界和真实合同。

### 输入与语音边界

| 输入或交互 | 固定 CLI 0.150.1 | Gateway 当前状态 | 边界 |
| --- | --- | --- | --- |
| 文本 | `turn/start`、`turn/steer` 的稳定 `UserInput.text` | Telegram、飞书、微信已支持 | 由 Application 的 `TurnInput.text` 进入统一 Turn |
| 内联图片 | `turn/start`、`turn/steer` 的稳定 `UserInput.image`（`url`） | 三渠道受限 PNG/JPEG/WebP/非动画 GIF Data URL 已支持；仅当前模型声明 `image` 输入能力时可用 | Surface 完成下载、签名、格式、数量和大小校验后，共享批处理器按 [OpenAI 图片输入要求](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements)在提交边界读取为有界 Base64 Data URL；Gateway 统一限制为单张 10 MiB、每批最多四张且合计 20 MiB，这是跨渠道安全边界，不代表三平台具有相同官方上限，并低于当前已知 Provider 上限。Application 拒绝 HTTP(S)、空值和非法 Base64，Gateway 不把本地路径或 Base64 写入自身日志或独立存储，并在创建或追加 Turn 前按模型目录检查 `image` 能力；支持时提交官方 `image`，不支持时提示使用 `/model` 切换模型，不调用外部视觉 API，也不建立第二套识图会话；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`surface-input-coalescer.test.ts`](../tests/surface-input-coalescer.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts)、[`deepseek-catalog.test.ts`](../tests/deepseek-catalog.test.ts) |
| 一次性音频 | 稳定 `UserInput.audio` / `UserInput.localAudio`；模型目录用 `inputModalities` 声明实际能力；固定源码支持 WAV、MP3、M4A、WebM 与 OGG 本地音频 | 三渠道平台接收与受限转换已实现；当前可见模型均未声明 `audio`，原始音频不属于当前端到端支持 | Surface 先验证可信时长、最长 5 分钟、最大 20 MiB 与格式并写入一小时私有临时文件；Application 再按当前或下一 Turn 模型的 `inputModalities` 检查 `audio`，缺失时在 `turn/start` / `turn/steer` 前明确拒绝。微信可信转写仍作为文本提交；SILK 明确拒绝 |
| 实时语音 | 实验 `thread/realtime/start`、`appendAudio`、`appendSpeech`、`stop` 及 Realtime 通知 | 禁止接入 | 当前项目只允许 Plan 所需实验协议；不得导出、调用或消费 Realtime 业务能力 |
| ChatGPT Voice / 语音听写 | 官方桌面应用产品能力，不是当前 CLI 命令入口 | 不属于 Gateway | 不用平台模拟实现第二套 Codex 实时会话或语音输出 |

Application 的 `TurnInput` 是只含 `text`、内联 `image` 与 `localAudio` 的封闭联合；模型目录
只把 `text`、`image`、`audio` 三种官方输入能力映射为稳定类型，包含 `localAudio` 的提交必须
先通过当前模型能力检查。Codex Client 只映射这三个稳定输入变体。模块边界测试同时禁止生产 Client 调用 `thread/realtime/*`，Surface
不得把平台音频地址、密钥、实时音频或未验证的编解码数据带入 Application/Core。

## 本项目实现映射

| 要查的问题 | 本项目入口 | 验证入口 |
| --- | --- | --- |
| CLI、运行中 App Server 和生成协议是否一致 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`protocol-info.ts`](../src/codex-client/protocol-info.ts)、[`doctor.mjs`](../scripts/doctor.mjs) | `npm run protocol:check`、`codexc doctor`、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts) |
| Unix WebSocket 如何连接并对齐原生 128 MiB 消息上限 | [`codex-client/`](../src/codex-client/README.md) | [`unix-websocket-transport.test.ts`](../tests/unix-websocket-transport.test.ts) |
| JSON-RPC 如何分流和清理请求 | [`json-rpc.ts`](../src/codex-client/json-rpc.ts) | [`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Turn、Review 和 Goal 如何隔离官方协议 | [`turn-port.ts`](../src/application/turn-port.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Thread/Turn/Item 如何适配并归约 | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`input-events.ts`](../src/conversation-core/input-events.ts)、[`core.ts`](../src/conversation-core/core.ts) | [`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 多 Provider Thread 如何选择 App Server | [`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts)、[`app.ts`](../src/bootstrap/app.ts)、[`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs) | [`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`model-provider-runtime.test.ts`](../tests/model-provider-runtime.test.ts)、[`gateway-startup-cleanup.test.ts`](../tests/gateway-startup-cleanup.test.ts) |
| 官方 Thread 如何进入稳定业务边界 | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts)、[`thread-port.ts`](../src/session-routing/thread-port.ts) | [`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Thread 路由通知如何隔离 | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) | [`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Workspace、Conversation、Thread 如何绑定 | [`session-routing/`](../src/session-routing/README.md) | [`session-router.test.ts`](../tests/session-router.test.ts)、[`module-boundaries.test.ts`](../tests/module-boundaries.test.ts) |
| 模型、思考等级和 Fast 如何隔离并同步 | [`model-port.ts`](../src/application/model-port.ts)、[`model-adapter.ts`](../src/codex-client/model-adapter.ts)、[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) | [`model-selection-service.test.ts`](../tests/model-selection-service.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 原生与第三方账户指标如何隔离和扩展 | [`account-port.ts`](../src/application/account-port.ts)、[`provider-account-service.ts`](../src/application/provider-account-service.ts)、[`account-adapter.ts`](../src/codex-client/account-adapter.ts)、[`deepseek-account-adapter.ts`](../src/bootstrap/deepseek-account-adapter.ts)、[`opencode-go-account-adapter.ts`](../src/bootstrap/opencode-go-account-adapter.ts) | [`provider-account-service.test.ts`](../tests/provider-account-service.test.ts)、[`deepseek-account-adapter.test.ts`](../tests/deepseek-account-adapter.test.ts)、[`opencode-go-account-adapter.test.ts`](../tests/opencode-go-account-adapter.test.ts)、[`conversation-command-format.test.ts`](../tests/conversation-command-format.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts) |
| 直接安装 Skill 查询与显式调用如何隔离 | [`skill-port.ts`](../src/application/skill-port.ts)、[`turn-port.ts`](../src/application/turn-port.ts)、[`skill-adapter.ts`](../src/codex-client/skill-adapter.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP 状态、OAuth 与资源读取如何隔离 | [`mcp-port.ts`](../src/application/mcp-port.ts)、[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`core.ts`](../src/conversation-core/core.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 开发中 Plugin 查询与 mention 调用如何隔离 | [`plugin-port.ts`](../src/application/plugin-port.ts)、[`plugin-adapter.ts`](../src/codex-client/plugin-adapter.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Permission Profile 查询如何隔离 | [`permission-port.ts`](../src/application/permission-port.ts)、[`permission-adapter.ts`](../src/codex-client/permission-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`telegram-format.test.ts`](../tests/telegram-format.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Server Request 如何适配并协调 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`approval/`](../src/approval/README.md)、各 Surface 的 `interactions.ts` | [`approval.test.ts`](../tests/approval.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`telegram-interactions.test.ts`](../tests/telegram-interactions.test.ts)、[`feishu-interactions.test.ts`](../tests/feishu-interactions.test.ts)、[`weixin-interactions.test.ts`](../tests/weixin-interactions.test.ts) |
| 各模块如何装配和管理生命周期 | [`bootstrap/`](../src/bootstrap/README.md) | [`gateway-startup-cleanup.test.ts`](../tests/gateway-startup-cleanup.test.ts) |
| Telegram 如何适配核心事件 | [`surfaces/telegram/`](../src/surfaces/telegram/README.md) | [`tests/README.md`](../tests/README.md) |
| 新通讯渠道如何按模块接入 | [`通讯渠道 Surface 接入指南`](surface-integration-guide.md)、[`surfaces/`](../src/surfaces/README.md) | [`module-boundaries.test.ts`](../tests/module-boundaries.test.ts)、[`surface-manager.test.ts`](../tests/surface-manager.test.ts) |
| 新第三方模型 Provider 如何接入 | [`第三方模型 Provider 接入指南`](provider-integration-guide.md)、[`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs)、[`app.ts`](../src/bootstrap/app.ts) | [`model-provider-runtime.test.ts`](../tests/model-provider-runtime.test.ts)、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts)、[`model-provider-file-layout.test.ts`](../tests/model-provider-file-layout.test.ts)、[`deepseek-setup.test.ts`](../tests/deepseek-setup.test.ts)、[`opencode-go-setup.test.ts`](../tests/opencode-go-setup.test.ts) |
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
   `rust-v0.150.1` 固定版本实现和测试；本地副本缺失或基线不符时才使用上面的固定版本链接。
4. 查本项目行为时从模块 `index.ts` 和 README 进入，最后运行对应测试或真实合同测试。

协议升级从 [`Codex CLI 升级流程`](codex-cli-upgrade.md) 开始，使用
`npm run codex:upgrade -- <目标版本>` 生成差异，再由 Codex 审查适配，并同步本页的版本、数量、
固定版本源码链接和支持矩阵。`npm run docs:check` 会自动核对上表的协议和模块数字；也可用以下
命令手动复核：

正式升级提案会运行各项兼容检查，并保存逐阶段结果、日志、完整 Patch 和协议结构影响摘要。自动
提案阶段不修改本页稳定基线，因此文档索引检查明确跳过；正式 Release 发布并完成适配后必须运行
完整提交检查。Release 解析在有限网络重试后仍失败时，工作流保留 `unresolved` 失败报告，不生成
或猜测协议版本。

```bash
find src/codex-protocol/generated -type f -name '*.ts' | wc -l
rg -o '"method": "[^"]+"' src/codex-protocol/generated/ClientRequest.ts | wc -l
rg -o '"method": "[^"]+"' src/codex-protocol/generated/ServerNotification.ts | wc -l
rg -o '"method": "[^"]+"' src/codex-protocol/generated/ServerRequest.ts | wc -l
rg -c '^export type ' src/codex-protocol/index.ts
```
