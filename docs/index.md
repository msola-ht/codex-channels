# Codex 官方文档与源码索引

本页用于定位 Codex App Server 的官方说明、`0.145.0` 固定版本源码，以及本项目对应实现。
它是查询入口，不替代生成协议类型，也不声明本项目支持官方协议的全部能力。

## 版本与数字

当前索引对应 [`src/codex-protocol/version.json`](../src/codex-protocol/version.json) 锁定的
`codex-cli 0.145.0`，生成时未启用实验协议。

| 数量 | 是什么 | 事实来源 |
| ---: | --- | --- |
| 617 | 当前 CLI 生成的 TypeScript 文件总数 | `src/codex-protocol/generated/` |
| 90 | 生成目录根层的公共、兼容和初始化类型 | `src/codex-protocol/generated/*.ts` |
| 526 | v2 请求、响应、通知和数据类型 | `src/codex-protocol/generated/v2/*.ts` |
| 1 | `serde_json` 辅助类型 | `src/codex-protocol/generated/serde_json/` |
| 92 | 客户端发给 App Server 的 Request 方法 | [`ClientRequest.ts`](../src/codex-protocol/generated/ClientRequest.ts) |
| 72 | App Server 发给客户端的 Notification 方法 | [`ServerNotification.ts`](../src/codex-protocol/generated/ServerNotification.ts) |
| 10 | App Server 发给客户端、需要回应的 Request 方法 | [`ServerRequest.ts`](../src/codex-protocol/generated/ServerRequest.ts) |
| 1 | 客户端发给 App Server 的 Notification，即 `initialized` | [`ClientNotification.ts`](../src/codex-protocol/generated/ClientNotification.ts) |
| 53 | 本项目允许业务模块使用的协议类型导出 | [`src/codex-protocol/index.ts`](../src/codex-protocol/index.ts) |
| 27 | 本项目直接调用的业务 Request 方法，不含连接层的 `initialize` | [`client.ts`](../src/codex-client/client.ts) |
| 5 | 本项目显式协调的 Server Request 类型 | [`coordinator.ts`](../src/approval/coordinator.ts) |
| 13 | 本项目 TypeScript Gateway 的一级业务模块 | [`src/README.md`](../src/README.md) |

这里的数量描述协议结构，不等于本项目已实现的功能数。业务代码只能使用
`src/codex-protocol/index.ts` 的受控导出；生成目录可能包含尚未采用、实验中或仅供其他客户端
使用的类型。

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
| 通知 | [`notification.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server-protocol/src/protocol/v2/notification.rs) | v2 Notification 参数 |
| Transport | [`transport.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/transport.rs) | stdio、WebSocket 和连接收发 |
| 初始化处理 | [`initialize_processor.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/initialize_processor.rs) | `initialize` 握手与能力协商 |
| Thread 请求处理 | [`thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/thread_processor.rs) | Thread 请求的运行时实现 |
| Thread 订阅生命周期 | [`thread_lifecycle.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs) | 订阅、空闲卸载与 `thread/closed` |
| Turn 请求处理 | [`turn_processor.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/src/request_processors/turn_processor.rs) | Turn 请求的运行时实现 |
| Thread 设置测试 | [`thread_settings_update.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/thread_settings_update.rs) | 模型、思考强度和服务层级通知合同 |
| Unix WebSocket 测试 | [`connection_handling_websocket_unix.rs`](https://github.com/openai/codex/blob/rust-v0.145.0/codex-rs/app-server/tests/suite/v2/connection_handling_websocket_unix.rs) | Unix Socket WebSocket 行为 |

## 当前支持矩阵

本表列出项目当前主动调用或消费的协议能力。未列出的生成类型不能直接视为已支持能力。

| 能力 | 当前使用的官方方法或通知 | 本项目入口与验证 |
| --- | --- | --- |
| 初始化与连接 | `initialize`、`initialized` | [`codex-client/`](../src/codex-client/README.md)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)；发送消息受生成的 `ClientRequest` / `ClientNotification` 约束 |
| Thread 生命周期 | `thread/list`、`thread/read`、`thread/start`、`thread/resume`、`thread/fork`、`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/unsubscribe`、`thread/name/set`、`thread/compact/start`、`thread/closed`、`thread/archived`、`thread/deleted` | [`session-routing/`](../src/session-routing/README.md)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts) |
| Thread 设置 | `thread/settings/updated`、`model/list`、`config/read`、`config/batchWrite` | [`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts)、[`model-selection-service.test.ts`](../tests/model-selection-service.test.ts) |
| Turn 控制 | `turn/start`、`turn/steer`、`turn/interrupt`、`turn/started`、`error`、`turn/completed` | [`conversation-core/`](../src/conversation-core/README.md)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts) |
| Item 与流式输出 | `item/started`、`item/completed`、`item/agentMessage/delta` | [`core.ts`](../src/conversation-core/core.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts) |
| 警告 | `warning`（Thread 目标或全局） | [`core.ts`](../src/conversation-core/core.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts) |
| Diff、Plan 与 Review | `turn/diff/updated`、`turn/plan/updated`、`review/start` | [`conversation-command-service.ts`](../src/application/conversation-command-service.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts) |
| Goal | `thread/goal/get`、`thread/goal/set`、`thread/goal/clear` | [`client.ts`](../src/codex-client/client.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts) |
| 审批和用户输入 | 命令、文件、权限、用户输入、MCP elicitation 共 5 类 Server Request | [`approval/`](../src/approval/README.md)、[`approval.test.ts`](../tests/approval.test.ts) |
| Skill、MCP 与 Plugin | `skills/list`、`mcpServerStatus/list`、`plugin/installed`、MCP 状态通知 | [`client.ts`](../src/codex-client/client.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts) |
| 用量、额度与权限 | `account/usage/read`、`account/rateLimits/read`、账户通知、`permissionProfile/list` | [`core.ts`](../src/conversation-core/core.ts)、[`conversation-core.test.ts`](../tests/conversation-core.test.ts) |
| 真实合同 | Fast 默认值、共享 Thread 设置通知、双客户端连接恢复 | [`real-app-server.test.ts`](../tests/real-app-server.test.ts) |

当前生成协议还包含文件系统 RPC、独立命令执行、登录、Marketplace、App、Realtime、
Remote Control、动态工具、Attestation 和实验能力等类型；它们没有因此自动成为 Gateway
公开能力。采用其中任何能力前，必须先审查对应 Server Request、Notification、安全边界和真实合同。

## 本项目实现映射

| 要查的问题 | 本项目入口 | 验证入口 |
| --- | --- | --- |
| CLI 版本和生成协议是否一致 | [`codex-protocol/`](../src/codex-protocol/README.md) | `npm run protocol:check` |
| Unix WebSocket 如何连接 | [`codex-client/`](../src/codex-client/README.md) | [`unix-websocket-transport.test.ts`](../tests/unix-websocket-transport.test.ts) |
| JSON-RPC 如何分流和清理请求 | [`json-rpc.ts`](../src/codex-client/json-rpc.ts) | [`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Thread/Turn/Item 如何归约 | [`conversation-core/`](../src/conversation-core/README.md) | [`conversation-core.test.ts`](../tests/conversation-core.test.ts) |
| Workspace、Conversation、Thread 如何绑定 | [`session-routing/`](../src/session-routing/README.md) | [`session-router.test.ts`](../tests/session-router.test.ts) |
| 模型、思考强度和 Fast 如何同步 | [`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) | [`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts) |
| 审批和用户输入如何协调 | [`approval/`](../src/approval/README.md) | [`approval.test.ts`](../tests/approval.test.ts) |
| 各模块如何装配和管理生命周期 | [`bootstrap/`](../src/bootstrap/README.md) | [`gateway-startup-cleanup.test.ts`](../tests/gateway-startup-cleanup.test.ts) |
| Telegram 如何适配核心事件 | [`surfaces/telegram/`](../src/surfaces/telegram/README.md) | [`tests/README.md`](../tests/README.md) |
| 与真实 App Server 的合同是否一致 | [`real-app-server.test.ts`](../tests/real-app-server.test.ts) | `RUN_CODEX_CONTRACT=1 npm test -- --run tests/real-app-server.test.ts` |

## 模块复核进度

本清单记录逐模块对照当前规则、生成协议和 `rust-v0.145.0` 官方实现的专项复核进度，不代表未列为
完成的模块缺少常规测试。

已完成：

- `codex-protocol`：协议生成、版本基线与受控导出，提交 `7be8e48`。
- `codex-client`：Transport、JSON-RPC 与类型化 App Server API，提交 `27cd545`。
- `conversation-core`：Turn、Item、错误与警告通知归约，提交 `994a3c7`。
- `session-routing`：Thread 绑定、恢复、订阅和关闭语义，提交 `5410f40`。

后续按以下顺序继续，每个模块单独审查、修改、验证和提交：

1. `application`：先处理 `conversation-service.ts` 的 Turn、队列与 Thread 切换，再检查命令服务。
2. `approval`：Server Request 归属、一次/会话批准、持久规则与失效处理。
3. `storage`：最小绑定 Schema、内存/SQLite 一致性和失败回滚。
4. `policy`：Surface Actor、账号与 Workspace 授权边界。
5. `event-bus`：有界队列、关键事件保护和消费者隔离。
6. `observability`：结构化日志、错误上下文与敏感字段脱敏。
7. `config`：TOML 边界验证、热加载分类和代理优先级。
8. `surfaces`：通用 Surface 接口及 Telegram 输入、输出和交互适配。
9. `bootstrap`：最后复核组合根、连接恢复、后台任务和关闭顺序。

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
