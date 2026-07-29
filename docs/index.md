# Codex 官方文档与源码索引

本页用于定位 Codex App Server 的官方说明、`0.145.0` 固定版本源码，以及本项目对应实现。
它是查询入口，不替代生成协议类型，也不声明本项目支持官方协议的全部能力。

## 版本与数字

当前索引对应 [`src/codex-protocol/version.json`](../src/codex-protocol/version.json) 锁定的
`codex-cli 0.145.0`。生成时启用实验类型，但业务只采用固定版本官方 Plan 模式所需的
`collaborationMode/list` 与 `turn/start.collaborationMode`；其他实验类型不表示已支持。

| 数量 | 是什么 | 事实来源 |
| ---: | --- | --- |
| 697 | 当前 CLI 生成的 TypeScript 文件总数 | `src/codex-protocol/generated/` |
| 97 | 生成目录根层的公共、兼容和初始化类型 | `src/codex-protocol/generated/*.ts` |
| 599 | v2 请求、响应、通知和数据类型 | `src/codex-protocol/generated/v2/*.ts` |
| 1 | `serde_json` 辅助类型 | `src/codex-protocol/generated/serde_json/` |
| 129 | 客户端发给 App Server 的 Request 方法 | [`ClientRequest.ts`](../src/codex-protocol/generated/ClientRequest.ts) |
| 72 | App Server 发给客户端的 Notification 方法 | [`ServerNotification.ts`](../src/codex-protocol/generated/ServerNotification.ts) |
| 11 | App Server 发给客户端、需要回应的 Request 方法 | [`ServerRequest.ts`](../src/codex-protocol/generated/ServerRequest.ts) |
| 1 | 客户端发给 App Server 的 Notification，即 `initialized` | [`ClientNotification.ts`](../src/codex-protocol/generated/ClientNotification.ts) |
| 35 | Codex Client 适配边界使用的受控协议类型导出 | [`src/codex-protocol/index.ts`](../src/codex-protocol/index.ts) |
| 28 | 本项目直接调用的业务 Request 方法，不含连接层的 `initialize` | [`client.ts`](../src/codex-client/client.ts) |
| 5 | 本项目显式协调的 Server Request 类型 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts) |
| 13 | 本项目 TypeScript Gateway 的一级业务模块 | [`src/README.md`](../src/README.md) |

这里的数量描述协议结构，不等于本项目已实现的功能数。只有 `codex-client` 可以使用
`src/codex-protocol/index.ts` 的受控导出；生成目录可能包含尚未采用、实验中或仅供其他客户端
使用的类型，其他业务模块不得导入。

## 官方文档

1. [Codex App Server](https://learn.chatgpt.com/docs/app-server)：协议定位、Transport、
   JSON-RPC 消息、初始化、Thread/Turn/Item、审批、通知和 Schema 生成的主文档。
2. [Codex 开源组件](https://learn.chatgpt.com/docs/open-source)：官方开源范围和仓库入口。
3. [OpenAI Codex 仓库](https://github.com/openai/codex)：当前官方源码；排查本项目锁定协议时，
   应优先打开下面固定到 `rust-v0.145.0` 的链接，而不是直接以 `main` 为准。

官方文档定义产品和协议行为；本项目实际字段必须以当前锁定 CLI 生成的 TypeScript 类型为准。
如果两者看起来不一致，先检查文档是否描述了更新版本，再审查固定版本源码和生成差异。

## 固定版本官方源码

以下链接固定到 OpenAI Codex `rust-v0.145.0`：

| 查询目标 | 官方源码 | 主要内容 |
| --- | --- | --- |
| App Server 总览 | [`app-server/README.md`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/README.md) | 启动方式、协议和开发入口 |
| JSON-RPC 消息总表 | [`rpc.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/rpc.rs) | Client Request、Server Notification、Server Request |
| 协议公共类型 | [`common.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/common.rs) | 初始化、ID、通用协议结构 |
| v2 协议入口 | [`v2/mod.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/mod.rs) | v2 模块与受支持类型汇总 |
| Thread | [`thread.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) | Thread 请求、响应和生命周期 |
| Turn | [`turn.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs) | Turn 启动、追加、停止和状态 |
| Item | [`item.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs) | 消息、命令、文件、工具等 Item |
| 图片生成 Item 与产物 | [`image_generation.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/ext/items/src/image_generation.rs)、[`artifact.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/ext/image-generation/src/artifact.rs) | `ImageGenerationItem.savedPath` 与生成图片落盘目录 |
| 权限协议 | [`permissions.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs) | 临时权限、命令网络上下文与持久规则结构 |
| MCP 协议 | [`mcp.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs) | MCP 状态与 form、openai/form、URL elicitation |
| 通知 | [`notification.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/notification.rs) | v2 Notification 参数 |
| Transport | [`transport.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/transport.rs) | stdio、WebSocket 和连接收发 |
| 初始化处理 | [`initialize_processor.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/initialize_processor.rs) | `initialize` 握手与能力协商 |
| Thread 请求处理 | [`thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/thread_processor.rs) | Thread 请求的运行时实现 |
| Thread 订阅生命周期 | [`thread_lifecycle.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs) | 订阅、空闲卸载与 `thread/closed` |
| Turn 请求处理 | [`turn_processor.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/turn_processor.rs) | Turn 请求的运行时实现 |
| 配置请求处理 | [`config_processor.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/config_processor.rs) | `config/read`、批量写入与用户配置热加载 |
| 模型目录测试 | [`model_list.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/model_list.rs) | 可见模型、分页和远端目录合同 |
| 账户请求处理 | [`account_processor.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/account_processor.rs) | 账户 Token 用量与额度读取 |
| 账户测试 | [`account.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/account.rs) | 用量读取、认证与错误合同 |
| 额度测试 | [`rate_limits.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/rate_limits.rs) | 单桶、多桶、消费控制与重置券合同 |
| Skill 列表测试 | [`skills_list.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/skills_list.rs) | CWD、Scope、缓存、Plugin Skill 与变更通知合同 |
| MCP 请求处理 | [`mcp_processor.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/mcp_processor.rs) | Thread 配置上下文、精简清单、排序与分页 |
| MCP 状态测试 | [`mcp_server_status.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/mcp_server_status.rs) | 工具原名、项目级配置、实时元数据与精简清单合同 |
| Plugin 请求处理 | [`plugins.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/plugins.rs) | 已安装查询、本地与远端来源、CWD 和安装建议 |
| Plugin 列表测试 | [`plugin_list.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/plugin_list.rs) | 已安装过滤、安装建议、Marketplace 与功能开关合同 |
| Catalog 请求处理 | [`catalog_processor.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/catalog_processor.rs) | Permission Profile 的 CWD 配置归并、allowed 状态和分页 |
| Permission Profile 测试 | [`permission_profile_list.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/permission_profile_list.rs) | 内置、自定义、项目级 Profile 与分页合同 |
| 用户输入测试 | [`request_user_input.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/request_user_input.rs) | 问题、自动解决时限、响应与跨客户端失效合同 |
| MCP elicitation 测试 | [`mcp_server_elicitation.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/mcp_server_elicitation.rs) | 三种 elicitation 模式、能力协商与响应合同 |
| Thread 设置测试 | [`thread_settings_update.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/thread_settings_update.rs) | 模型、思考强度和服务层级通知合同 |
| 上下文压缩测试 | [`compaction.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/compaction.rs) | 手动与自动压缩、`contextCompaction` Item 开始和完成通知合同 |
| Unix WebSocket 测试 | [`connection_handling_websocket_unix.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/connection_handling_websocket_unix.rs) | Unix Socket WebSocket 行为 |

## 当前支持矩阵

本表列出项目当前主动调用或消费的协议能力。未列出的生成类型不能直接视为已支持能力。

| 能力 | 当前使用的官方方法或通知 | 本项目入口与验证 |
| --- | --- | --- |
| 初始化与连接 | `initialize`、`initialized` | [`codex-client/`](../src/codex-client/README.md)、[`doctor.mjs`](../scripts/doctor.mjs)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts)；发送消息受生成的 `ClientRequest` / `ClientNotification` 约束，Doctor 只从 `initialize.userAgent` 提取运行中 App Server 的实际版本并与锁定版本比较 |
| Thread 生命周期 | `thread/list`、`thread/read`、`thread/start`、`thread/resume`、`thread/fork`、`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/unsubscribe`、`thread/name/set`、`thread/compact/start`、`thread/closed`、`thread/archived`、`thread/deleted` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 把官方响应映射为稳定快照，[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 把生命周期通知映射为 [`session-routing/`](../src/session-routing/README.md) 的稳定事件；[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts) |
| Thread 设置 | `thread/settings/updated`、`model/list`、`config/read`、`config/batchWrite`、实验 `collaborationMode/list` | [`model-port.ts`](../src/application/model-port.ts) 与 [`collaboration-mode-port.ts`](../src/application/collaboration-mode-port.ts) 定义稳定设置边界，[`model-adapter.ts`](../src/codex-client/model-adapter.ts) 映射官方目录，[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 隔离模型、Fast 与 Default/Plan 设置通知；[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts)、[`model-selection-service.test.ts`](../tests/model-selection-service.test.ts)、[`collaboration-mode-service.test.ts`](../tests/collaboration-mode-service.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts) |
| Turn 控制 | `turn/start`、实验 `turn/start.collaborationMode`、`turn/steer`、`turn/interrupt`、`turn/started`、`error`、`turn/completed` | [`turn-port.ts`](../src/application/turn-port.ts) 定义稳定执行与 Default/Plan 覆盖端口，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 编码请求与响应，[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射生命周期通知、校验官方 `Turn.durationMs` 并统一脱敏、限长可显示的错误；活动 Turn 不允许切换协作模式；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Item 与流式输出 | `item/started`、`item/completed`、`item/agentMessage/delta` | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 分类稳定 Item 事件，[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts) 生成脱敏操作摘要，并只把官方 `imageGeneration.savedPath` 映射为生成图片产物，[`core.ts`](../src/conversation-core/core.ts) 只归约稳定输入；[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`operation-adapter.test.ts`](../tests/operation-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`weixin-outbox.test.ts`](../tests/weixin-outbox.test.ts) |
| 上下文压缩 | `thread/compact/start`、`contextCompaction` Thread Item 与 `item/completed` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 从恢复历史提取压缩 Item ID，[`core.ts`](../src/conversation-core/core.ts) 合并实时完成 Item 并去重，[`conversation-service.ts`](../src/application/conversation-service.ts) 公开总次数；[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`telegram-format.test.ts`](../tests/telegram-format.test.ts)、[`telegram-outbox.test.ts`](../tests/telegram-outbox.test.ts)。生成类型中的 `thread/compacted` 已标记废弃，统计不依赖它；当前 Item 不提供手动/自动触发来源，因此只显示总次数 |
| 警告 | `warning`（Thread 目标或全局） | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射并统一脱敏、限长消息，[`core.ts`](../src/conversation-core/core.ts) 只负责目标路由；[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts) |
| Diff、计划产物与 Review | `turn/diff/updated`、`turn/plan/updated`、`review/start` | Review 目标与结果由 [`turn-port.ts`](../src/application/turn-port.ts) 定义，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 映射；Diff/计划产物通知经 [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 转成稳定事件后由 Core 归约。计划产物通知与切换官方 Plan 协作模式是两个独立边界 |
| Goal | `thread/goal/get`、`thread/goal/set`、`thread/goal/clear`、`thread/goal/updated`、`thread/goal/cleared` | [`turn-port.ts`](../src/application/turn-port.ts) 定义执行端口，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 映射请求结果，[`conversation-service.ts`](../src/application/conversation-service.ts) 在 set/clear 成功后立即同步 Core，[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 把外部变更与恢复通知转换为稳定 Core 事件；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 审批和用户输入 | 命令、文件、权限、用户输入、MCP elicitation 共 5 类 Server Request | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts) 负责协议解码与编码，[`approval/`](../src/approval/README.md) 负责稳定授权语义，各 Surface 只实现平台交互；[`approval.test.ts`](../tests/approval.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`weixin-interactions.test.ts`](../tests/weixin-interactions.test.ts) |
| Skill、MCP 与 Plugin | `skills/list`、`mcpServerStatus/list`、`plugin/installed`、MCP 状态通知 | Skill、MCP 和 Plugin 查询分别由 [`skill-port.ts`](../src/application/skill-port.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`plugin-port.ts`](../src/application/plugin-port.ts) 及对应 Client 适配器隔离；MCP 通知由 [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射并脱敏，再由 [`runtime-status-format.ts`](../src/surfaces/runtime-status-format.ts) 为 Telegram、飞书和微信生成共享稳定语义；[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`surface-copy-contract.test.ts`](../tests/surface-copy-contract.test.ts)、[`weixin-outbox.test.ts`](../tests/weixin-outbox.test.ts) |
| 用量、额度与权限 | `account/usage/read`、`account/rateLimits/read`、账户通知、`permissionProfile/list` | 账户查询由 [`account-port.ts`](../src/application/account-port.ts) 与 [`account-adapter.ts`](../src/codex-client/account-adapter.ts) 隔离，账户通知由 [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射为稳定 Core 事件，并通过 [`runtime-status-format.ts`](../src/surfaces/runtime-status-format.ts) 进入三个 Surface；Permission Profile 目录由 [`permission-port.ts`](../src/application/permission-port.ts) 与 [`permission-adapter.ts`](../src/codex-client/permission-adapter.ts) 隔离；[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`surface-copy-contract.test.ts`](../tests/surface-copy-contract.test.ts)、[`weixin-outbox.test.ts`](../tests/weixin-outbox.test.ts) |
| 真实合同 | Fast 默认值、Skill/MCP/Plugin/Permission 稳定查询、Default/Plan 预设与 Plan Turn 设置通知、共享 Thread 设置通知、Turn 启动结果、跨客户端 Goal 请求与通知、重连后 resume Goal 恢复、双客户端连接恢复 | [`real-app-server.test.ts`](../tests/real-app-server.test.ts) |

当前生成协议还包含文件系统 RPC、独立命令执行、登录、Marketplace、App、Realtime、
Remote Control、动态工具、Attestation 和实验能力等类型；它们没有因此自动成为 Gateway
公开能力。采用其中任何能力前，必须先审查对应 Server Request、Notification、安全边界和真实合同。

## 本项目实现映射

| 要查的问题 | 本项目入口 | 验证入口 |
| --- | --- | --- |
| CLI、运行中 App Server 和生成协议是否一致 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`protocol-info.ts`](../src/codex-client/protocol-info.ts)、[`doctor.mjs`](../scripts/doctor.mjs) | `npm run protocol:check`、`codexc doctor`、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts) |
| Unix WebSocket 如何连接 | [`codex-client/`](../src/codex-client/README.md) | [`unix-websocket-transport.test.ts`](../tests/unix-websocket-transport.test.ts) |
| JSON-RPC 如何分流和清理请求 | [`json-rpc.ts`](../src/codex-client/json-rpc.ts) | [`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Turn、Review 和 Goal 如何隔离官方协议 | [`turn-port.ts`](../src/application/turn-port.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Thread/Turn/Item 如何适配并归约 | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`input-events.ts`](../src/conversation-core/input-events.ts)、[`core.ts`](../src/conversation-core/core.ts) | [`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 官方 Thread 如何进入稳定业务边界 | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts)、[`thread-port.ts`](../src/session-routing/thread-port.ts) | [`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Thread 路由通知如何隔离 | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) | [`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Workspace、Conversation、Thread 如何绑定 | [`session-routing/`](../src/session-routing/README.md) | [`session-router.test.ts`](../tests/session-router.test.ts)、[`module-boundaries.test.ts`](../tests/module-boundaries.test.ts) |
| 模型、思考强度和 Fast 如何隔离并同步 | [`model-port.ts`](../src/application/model-port.ts)、[`model-adapter.ts`](../src/codex-client/model-adapter.ts)、[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) | [`model-selection-service.test.ts`](../tests/model-selection-service.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 账户用量与额度查询如何隔离 | [`account-port.ts`](../src/application/account-port.ts)、[`account-adapter.ts`](../src/codex-client/account-adapter.ts) | [`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`telegram-format.test.ts`](../tests/telegram-format.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 直接安装 Skill 查询如何隔离 | [`skill-port.ts`](../src/application/skill-port.ts)、[`skill-adapter.ts`](../src/codex-client/skill-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
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
3. 查行为语义时阅读官方 App Server 文档，再查看 `rust-v0.145.0` 固定版本实现和测试。
4. 查本项目行为时从模块 `index.ts` 和 README 进入，最后运行对应测试或真实合同测试。

协议升级从 [`Codex CLI 升级流程`](codex-cli-upgrade.md) 开始，使用
`npm run codex:upgrade -- <目标版本>` 生成差异，再由 Codex 审查适配，并同步本页的版本、数量、
固定版本源码链接和支持矩阵。`npm run docs:check` 会自动核对上表的协议和模块数字；也可用以下
命令手动复核：

每日 Alpha Canary 只对官方 Pre-release 做隔离前向兼容测试，不改变本页记录的稳定版本、数量、
固定版本链接或支持矩阵；它和正式升级预览会独立运行各项兼容检查，并保存逐阶段结果、日志、
完整 Patch 和协议结构影响摘要。预览阶段不修改本页稳定基线，因此文档索引检查明确跳过；正式
Release 发布并完成适配后必须重新运行正式升级流程和完整提交检查。Release 解析在有限网络
重试后仍失败时，工作流保留 `unresolved` 失败报告，不生成或猜测协议版本。

```bash
find src/codex-protocol/generated -type f -name '*.ts' | wc -l
rg -o '"method": "[^"]+"' src/codex-protocol/generated/ClientRequest.ts | wc -l
rg -o '"method": "[^"]+"' src/codex-protocol/generated/ServerNotification.ts | wc -l
rg -o '"method": "[^"]+"' src/codex-protocol/generated/ServerRequest.ts | wc -l
rg -c '^export type ' src/codex-protocol/index.ts
```
