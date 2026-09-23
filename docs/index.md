# Codex 官方文档与源码索引

本页用于定位 Codex App Server 的官方说明、`0.156.1` 固定版本源码，以及本项目对应实现。
它是查询入口，不替代生成协议类型，也不声明本项目支持官方协议的全部能力。

## 受控协议边界

修改实验能力、动态工具、图片引用或 Plugin 接入时读取本节；以下约束不因资料移位而放宽。

- 稳定业务代码不得依赖实验生成参数才会出现的字段。当前锁定 `codex-cli 0.156.1` 只允许五类
  受控协议例外。官方 Plan 模式只允许使用
  `collaborationMode/list` 和 `turn/start.collaborationMode`；Luna Reserve 自动回退为原样保留当前
  Default/Plan 模式，还允许 `thread/settings/update.collaborationMode`。这些字段必须通过
  `--experimental` 生成类型、从 `codex-protocol` 受控导出，并由真实 App Server
  合同测试覆盖。原生 Thread Queue 只允许使用
  `thread/queue/add|list|update|delete|reorder|start` 与 `thread/queue/changed`，必须通过
  `--experimental` 生成类型、从 `codex-protocol` 受控导出，并由真实 App Server
  合同测试覆盖；列表可进行有界只读重试，写入不得盲目重试。Thread Revert 只允许使用
  `thread/turns/list`、`thread/revert` 与 `thread/reverted`，同样必须通过
  `--experimental` 生成类型、从 `codex-protocol` 受控导出并由真实 App Server 合同测试覆盖；
  分页历史仅允许有界只读重试，Revert 写请求不得重试，且不得接入 `thread/items/list`。
  前台计划任务动态工具只允许使用 `thread/start.dynamicTools` 注册顶层 `schedule_task`，
  并处理对应 `item/tool/call`；必须通过 `--experimental` 生成类型、从 `codex-protocol`
  受控导出，并由真实 App Server 合同覆盖注册与回调。调用必须关联已绑定的前台 Thread
  与唯一授权 Actor，创建和删除仍须用户确认；后台计划任务 Thread 不注册工具并拒绝递归调用。
  不向已有 Thread 注入工具，不接入 `additionalContext`、任意动态工具或其他命名空间。
  图片引用上传只允许额外读取 `account/read.workspaceRouting`，用于核对当前 ChatGPT 账户、
  后端与路由约束；通过官方 `getAuthStatus` 获取当前可导出的令牌，不读取磁盘凭据。
  该字段必须使用受控生成类型并由真实 App Server 合同覆盖，不得用于其他账户或路由功能。
  开发中 Plugin 调试只允许在 `[experimental].plugin_api` 开启时使用稳定 `plugin/installed` 查询已安装项，
  并通过 `turn/start` / `turn/steer` 的官方 `mention` 输入调用；开关默认关闭且必须在 Doctor、
  命令输出和文档中标明开发中，只支持 OpenAI Thread。不得借这些例外或开发中入口接入、暴露其他
  实验方法、字段或通知。

## 版本与数字

当前索引对应 [`src/codex-protocol/version.json`](../src/codex-protocol/version.json) 锁定的
`codex-cli 0.156.1`。生成时启用实验类型；业务采用范围及开发中 Plugin 入口以
[受控协议边界](#受控协议边界)为准，其他生成类型不表示已支持。

| 数量 | 是什么 | 事实来源 |
| ---: | --- | --- |
| 867 | 当前 CLI 生成的 TypeScript 文件总数 | `src/codex-protocol/generated/` |
| 100 | 生成目录根层的公共、兼容和初始化类型 | `src/codex-protocol/generated/*.ts` |
| 766 | v2 请求、响应、通知和数据类型 | `src/codex-protocol/generated/v2/*.ts` |
| 1 | `serde_json` 辅助类型 | `src/codex-protocol/generated/serde_json/` |
| 167 | 客户端发给 App Server 的 Request 方法 | [`ClientRequest.ts`](../src/codex-protocol/generated/ClientRequest.ts) |
| 84 | App Server 发给客户端的 Notification 方法 | [`ServerNotification.ts`](../src/codex-protocol/generated/ServerNotification.ts) |
| 11 | App Server 发给客户端、需要回应的 Request 方法 | [`ServerRequest.ts`](../src/codex-protocol/generated/ServerRequest.ts) |
| 1 | 客户端发给 App Server 的 Notification，即 `initialized` | [`ClientNotification.ts`](../src/codex-protocol/generated/ClientNotification.ts) |
| 70 | Codex Client 适配边界使用的受控协议类型导出 | [`src/codex-protocol/index.ts`](../src/codex-protocol/index.ts) |
| 45 | 本项目直接调用的业务 Request 方法，不含连接层的 `initialize` | [`client.ts`](../src/codex-client/client.ts) |
| 5 | 本项目显式协调的 Server Request 类型 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`bootstrap/scheduled-task-tool-request.ts`](../src/bootstrap/scheduled-task-tool-request.ts) |
| 15 | 本项目 TypeScript Gateway 的一级业务模块 | [`src/README.md`](../src/README.md) |

这里的数量描述协议结构，不等于本项目已实现的功能数。只有 `codex-client` 可以使用
`src/codex-protocol/index.ts` 的受控导出；生成目录可能包含尚未采用、实验中或仅供其他客户端
使用的类型，其他业务模块不得导入。


DeepSeek 运行实例采用 `ds-<账户>` 与 `sf-ds-<账户>`，账户共享官方 DS 目录和统计代理。
旧单账户需先移除再以明确账户 ID 重新添加，旧 Thread 不做兼容；历史 `deepseek` 指标保留，新指标按账户归属。
实现见 [`deepseek-account-management.mjs`](../scripts/deepseek-account-management.mjs)，
验证见 [`deepseek-account-management.test.ts`](../tests/deepseek-account-management.test.ts)，
其中真实 App Server 合同读取两个账户的模型目录，不调用付费模型。

## 官方文档

本次基线从 0.155.1 升至 0.156.1，包含 0.156.0 与 0.156.1 两次正式发布。
采用稳定的 `thread/resume.collaborationMode` 恢复实际模式，并移除已停用的人格设置；
Gateway 为 OpenAI ChatGPT 图片上传原图并提交官方 fileId，历史和后续引用由 App Server 管理；
API Key、第三方 Provider 和独立自定义 OpenAI 后端保留内联图片输入。通过 `config/read`
定位运行中的模型代理并核对后端；仅默认 ChatGPT 后端一致且策略为 `NO_CONSTRAINT` 时转换，`us`、`us_cr` 或后端不一致拒绝上传。
上传原图跳过官方本地缩放，见图片决策中的限制。
通过稳定 `getAuthStatus` 和受控 `account/read.workspaceRouting` 读取同一 App Server 的认证与路由，
不读取磁盘凭据；实现见 [`image-reference-upload.ts`](../src/codex-client/image-reference-upload.ts)。
账户路由、令牌读取、编号转发、分页历史保留与后端拒绝由
[`real-app-server-supervised-tools.test.ts`](../tests/real-app-server-supervised-tools.test.ts) 覆盖；
上传和取消见 [`image-reference-upload.test.ts`](../tests/image-reference-upload.test.ts)。
此前在线探测支持当前账户编号识图；2026-09-23 的飞书实机验收进一步确认，自动链路首次请求向
OpenAI 模型提交 `input_image.file_id` 且没有 Base64，后续纯文本请求通过 `previous_response_id`
接续且没有重复图片。该结论限定当前账户、`NO_CONSTRAINT` 路由和当次模型，其他渠道、账户、路由
与模型仍按各自验收状态记录。
原生文件引用需求及阻塞、Apps 工具上传与普通图片输入的区别见[图片决策](codex-cli-upgrade-decisions.md#图片文件引用需求阻塞与实现边界)。
`disabledPluginIds`、MCP App UI、设备验证扩展
不增加 Gateway 写入或交互入口。新增 `rollout/compress` 与删除 `thread/rollback` 均不影响当前业务调用。
本次图片接入增加一个认证响应导出和一个请求方法，审批种类没有增加；具体取舍见[升级决策记录](codex-cli-upgrade-decisions.md#01561)。
本地构建或 Registry 包的 `codexc update` 由 [`source-update.mjs`](../scripts/source-update.mjs)
按已安装包的精确 CLI 基线完成临时候选公开合同校验、确认安装与服务恢复，验证见
[`source-update.test.ts`](../tests/source-update.test.ts)。

1. [Codex App Server](https://learn.chatgpt.com/docs/app-server)：协议定位、Transport、
   JSON-RPC 消息、初始化、Thread/Turn/Item、审批、通知和 Schema 生成的主文档。
2. [Codex 开源组件](https://learn.chatgpt.com/docs/open-source)：官方开源范围和仓库入口。
3. [Codex 高级配置](https://developers.openai.com/codex/config-advanced#profiles)：独立
   `profile-name.config.toml` 的加载顺序、命名与 `--profile` 用法。
4. [OpenAI Codex 仓库](https://github.com/openai/codex)：当前官方源码；排查本项目锁定协议时，
   优先读取 [`upstream/openai-codex`](upstream-sources.md) 的固定本地副本；本地副本缺失时
   再打开下面固定到 `rust-v0.156.1` 的链接，不能直接以 `main` 为准。

官方文档定义产品和协议行为；本项目实际字段必须以当前锁定 CLI 生成的 TypeScript 类型为准。
如果两者看起来不一致，先检查文档是否描述了更新版本，再审查固定版本源码和生成差异。

## 固定版本官方源码

以下链接固定到 OpenAI Codex `rust-v0.156.1`：

| 查询目标 | 官方源码 | 主要内容 |
| --- | --- | --- |
| App Server 程序入口 | [`app-server/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/lib.rs) | App Server 模块、启动参数与 Transport 装配入口 |
| JSON-RPC 消息总表 | [`rpc.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/rpc.rs) | Client Request、Server Notification、Server Request |
| 协议公共类型 | [`common.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/common.rs) | 初始化、ID、通用协议结构 |
| v2 协议入口 | [`v2/mod.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/mod.rs) | v2 模块与受支持类型汇总 |
| Thread | [`thread.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) | Thread 请求、响应和生命周期 |
| Turn | [`turn.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/turn.rs) | Turn 启动、追加、停止和状态 |
| 用户输入 | [`user_input.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/protocol/src/user_input.rs) | 文本、图片、一次性音频、Skill 与 Mention 输入 |
| Item | [`item.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/item.rs) | 消息、命令、文件、工具等 Item |
| 图片文件引用存储与默认装配 | [`attachment-store/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/attachment-store/src/lib.rs)、[`lib_tests.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/attachment-store/src/lib_tests.rs)、[`message_processor.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/message_processor.rs)、[`mcp_refresh.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/mcp_refresh.rs) | 默认使用内联存储，文件编号解析返回 NotFound；已有引用仍可直传模型端，内部抽象不等于公开上传/解析 RPC |
| 普通图片准备与原生 TUI 输入 | [`image_preparation.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/image_preparation.rs)、[`image_submission.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/tui/src/chatwidget/image_submission.rs) | 本地图片快照转内联输入；Core 图片处理调用注入的存储实现 |
| Apps 工具文件上传 | [`mcp_openai_file.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/mcp_openai_file.rs)、[`files.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-api/src/files.rs) | ChatGPT 认证下为工具参数上传；当前账户上传、即时下载与模型后端接受编号已探测，较大图片识图对照通过，独立按编号取回与地址刷新仍未验收 |
| 本地 Rollout 文件压缩 | [`rollout.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/rollout.rs)、[`RolloutCompressResponse.ts`](../src/codex-protocol/generated/v2/RolloutCompressResponse.ts) | 实验后台维护触发，仅适用于本地存储；不是 Thread 上下文压缩，也不返回完成状态；本项目未接入 |
| 模型访问计划与账户路由元数据 | [`model.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/model.rs)、[`account.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/account.rs)、[`workspace_routing.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs) | 目录展示与实验显式选择、账户后端路由分别审查；字段存在不授予权益；账户路由仅供图片上传核验，不开放选择器 |
| 图片生成 Item 与产物 | [`image_generation.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/ext/items/src/image_generation.rs)、[`artifact.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/ext/image-generation/src/artifact.rs) | `ImageGenerationItem.savedPath` 与生成图片落盘目录 |
| 官方模型 API 端点 | [`search.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-api/src/endpoint/search.rs)、[`images.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-api/src/endpoint/images.rs)、[`memories.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-api/src/endpoint/memories.rs)、[`realtime_call.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-api/src/endpoint/realtime_call.rs)、[`realtime_websocket/methods.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs) | OpenAI 搜索、图片、记忆摘要、Realtime HTTP 与 WebSocket 的固定请求后缀；Provider Proxy 只按该版本显式放行，不接受任意 OpenAI API 路径 |
| 权限协议 | [`permissions.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs) | 临时权限、命令网络上下文与持久规则结构 |
| MCP 协议 | [`mcp.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs) | MCP 状态、工具发现错误与 form、openai/form、URL、用户验证 elicitation |
| 用户验证协议 | [`user_verification.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/user_verification.rs) | 用户验证状态、登记、删除、校验 RPC 与失败类型；本项目未采用 |
| Thread 关联记录 | [`thread_attachment.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/thread_attachment.rs) | 独立持久化的类型、身份键和 JSON 内容，不等同于文件上传；本项目未采用 |
| TUI 推理摘要默认值 | [`app_server_session.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/tui/src/app_server_session.rs) | 新本地 TUI 会话未配置摘要时使用 `none`，保留显式值；Setup 的未配置预选与其一致 |
| 压缩失败输入保留 | [`turn.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/session/turn.rs)、[`compact_remote.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/tests/suite/compact_remote.rs) | 开始 Turn 前压缩失败仍保留已接受输入；Gateway 不增加消息副本或自动重发 |
| Goal 空续跑阻塞 | [`thread_goal_empty_responses.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/thread_goal_empty_responses.rs) | 连续三次没有有效活动的空自动续跑进入 `blocked`，沿用现有 Goal 状态映射 |
| Plugin 协议 | [`plugin.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs) | 开发中 Plugin 已安装、目录与安装类型；本项目只采用已安装响应 |
| 通知 | [`notification.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-protocol/src/protocol/v2/notification.rs) | v2 Notification 参数 |
| Transport | [`transport.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/transport.rs) | stdio、WebSocket 和连接收发 |
| Unix Socket 受保护布局 | [`unix_socket.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-transport/src/transport/unix_socket.rs)、[`daemon_directory.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/uds/src/daemon_directory.rs) | 广告路径为确定性 SHA-256 链接，真实 Socket 位于固定的当前用户私有目录，独立于 HOME/TMPDIR |
| 远程 App Server 客户端 | [`remote.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-client/src/remote.rs) | TCP WebSocket 与 Unix Socket 连接、每连接初始化、128 MiB 消息上限和回环认证边界 |
| App Server daemon | [`app-server-daemon/README.md`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server-daemon/README.md) | 实验性共享 daemon 的平台、生命周期、环境继承与状态目录；本项目不采用其生命周期 |
| Windows App Server Proxy | [`cli/src/main.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/cli/src/main.rs)、[`stdio-to-uds/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/stdio-to-uds/src/lib.rs) | `app-server proxy --sock` 的 CLI 入口与裸字节 stdio/UDS 中继；本项目 Windows Transport 在其上建立 WebSocket，macOS Desktop JSONL stdio 不直接复用该入口 |
| 初始化处理 | [`initialize_processor.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/initialize_processor.rs) | `initialize` 握手与能力协商 |
| Server Diagnostics 处理 | [`diagnostics.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/diagnostics.rs) | 实验、无内容的进程与运行时快照；本项目未采用 |
| Thread 请求处理 | [`thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/thread_processor.rs) | Thread 请求的运行时实现 |
| Thread 协作模式恢复 | [`thread_resume.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/thread_resume.rs) | 恢复响应的实际协作模式、持久设置与旧历史冻结上下文恢复合同 |
| 人格设置停用 | [`config_toml.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/config_toml.rs) | `personality` 已弃用，CLI/WebUI 停止提供选择和写入 |
| Thread 分页历史与 Revert | [`thread_revert.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/thread_revert.rs) | `thread/turns/list`、`thread/revert`、`thread/reverted`，分页历史、活动 Turn 中断与状态恢复 |
| Thread 队列处理 | [`thread_queue_processor.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/thread_queue_processor.rs) | 实验 `thread/queue/*` 的持久提交队列；本项目已采用六请求和 `thread/queue/changed`，通过 Client/Application 窄端口接入 |
| Thread 分区处理 | [`thread_sections.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/thread_sections.rs) | 官方内置 Pinned 分区与生命周期约束；Gateway 仅用于 `/pin`、`/unpin`，不暴露自定义分区管理 |
| Thread 订阅生命周期 | [`thread_lifecycle.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/thread_lifecycle.rs) | 订阅、空闲卸载与 `thread/closed` |
| Turn 请求处理 | [`turn_processor.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/turn_processor.rs) | Turn 启动、追加、停止和状态 |
| 配置请求处理 | [`config_processor.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/config_processor.rs) | `config/read`、批量写入与用户配置热加载 |
| 模型目录测试 | [`model_list.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/model_list.rs) | 可见模型、分页和远端目录合同 |
| DeepSeek Codex 接入 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex) | Responses Provider、配置字段、官方脚本和当前支持模型 |
| DeepSeek Responses 指南 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/guides/responses_api) | 无状态会话、流式事件、原生图片输入、工具兼容性、缓存及用量字段 |
| DeepSeek 图像理解 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/guides/vision) | 视觉模型、图片输入格式、Token 计量与限制 |
| DeepSeek 创建响应接口 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/api/create-response) | `POST /responses` 请求字段、响应结构与 SSE 终止事件 |
| DeepSeek 账户余额 | [DeepSeek 官方余额接口](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/) | `GET /user/balance` 的可用状态、币种与余额字段；不提供 Codex 周限或历史 Token 汇总 |
| OpenCode Go | [OpenCode Go 官方文档](https://opencode.ai/docs/go/) | Provider 基础地址、模型端点与账户用量接口 |
| 账户请求处理 | [`account_processor.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/account_processor.rs) | 账户 Token 用量与额度读取 |
| 账户测试 | [`account.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/account.rs) | 用量读取、认证与错误合同 |
| Thread 用量测试 | [`account_thread_usage.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/account_thread_usage.rs) | `account/usage/read.threadId` 与估算用量合同；本项目按当前精确 Thread 采用，不递归合计子代理 |
| 额度测试 | [`rate_limits.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/rate_limits.rs) | 单桶、多桶、消费控制与重置券合同 |
| Luna Reserve | [`luna_reserve.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/luna_reserve.rs)、[`backend_banner_fallback.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/tui/src/app/backend_banner_fallback.rs)、[`luna_reserve_recovery_tests.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/tui/src/app/tests/luna_reserve_recovery_tests.rs) | `supportsLunaReserve` / 轻量额度读取、隐藏 `gpt-reserve`、Thread 设置切换与同账户恢复合同 |
| Skill 列表测试 | [`skills_list.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/skills_list.rs) | CWD、Scope、缓存、Plugin Skill 与变更通知合同 |
| MCP 请求处理 | [`mcp_processor.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/mcp_processor.rs) | Thread 配置上下文、精简清单、排序与分页 |
| Plugin 请求处理 | [`plugins.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/plugins.rs) | 已安装 Plugin 的 Workspace 发现、启用与可用状态 |
| MCP 工具审批 | [`mcp_tool_call.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/mcp_tool_call.rs) | 工具审批 elicitation 元数据、会话与持久授权响应 |
| MCP 状态测试 | [`mcp_server_status.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/mcp_server_status.rs) | 工具原名、工具发现失败、项目级配置、实时元数据、当前 Thread 连接状态、断线失败与精简清单合同 |
| MCP 资源测试 | [`mcp_resource.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/mcp_resource.rs) | Thread 可选上下文、文本/二进制资源读取与错误合同 |
| MCP 配置刷新测试 | [`executor_mcp.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/executor_mcp.rs) | 从磁盘重载配置并刷新已加载 Thread 的 MCP 运行时；请求成功不等于远端握手已经完成 |
| MCP 启动恢复 | [`mcp_refresh.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/mcp_refresh.rs)、[`connection_manager.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-mcp/src/connection_manager.rs)、[`rmcp_client.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-mcp/src/rmcp_client.rs)、[`connection_manager_tests.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/codex-mcp/src/connection_manager_tests.rs) | 普通刷新复用配置相同的健康连接、重建失败连接；`codex_apps` 工具发现可触发带退避的原生启动重连 |
| Plugin 列表测试 | [`plugin_list.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/plugin_list.rs) | Marketplace、已安装项、启用状态与 CWD 发现合同 |
| Catalog 请求处理 | [`catalog_processor.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/src/request_processors/catalog_processor.rs) | Permission Profile 的 CWD 配置归并、allowed 状态和分页 |
| Permission Profile 测试 | [`permission_profile_list.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/permission_profile_list.rs) | 内置、自定义、项目级 Profile 与分页合同 |
| 用户输入测试 | [`request_user_input.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/request_user_input.rs) | 问题、自动解决时限、响应与跨客户端失效合同 |
| MCP elicitation 与用户验证测试 | [`mcp_server_elicitation.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/mcp_server_elicitation.rs)、[`user_verification.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/user_verification.rs) | 常规 elicitation、用户验证能力协商、请求归属与响应合同；本项目不声明用户验证扩展并显式取消对应请求 |
| Thread 设置测试 | [`thread_settings_update.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/thread_settings_update.rs) | 模型、思考等级和服务层级通知合同 |
| Thread 分区测试 | [`thread_sections.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/thread_sections.rs)、[`thread_metadata_update.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/thread_metadata_update.rs) | 内置 Pinned 分区、移动、列表状态、迁移与分页保持合同；Gateway 只覆盖固定/取消固定路径 |
| Thread 队列与回退测试 | [`thread_queue.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/thread_queue.rs)、[`thread_revert.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/thread_revert.rs) | Queue 六请求、容量、分页、并发排序和通知，以及分页历史 Revert 的受控适配；联合 Queue/Revert 合同仍按条件测试门禁 |
| Server Diagnostics 测试 | [`server_diagnostics.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/server_diagnostics.rs) | 实验进程与运行时诊断快照；本项目未采用 |
| 上下文压缩测试 | [`compaction.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/compaction.rs) | 手动与自动压缩、`contextCompaction` Item 开始和完成通知合同 |
| Unix WebSocket 测试 | [`connection_handling_websocket_unix.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/connection_handling_websocket_unix.rs) | Unix Socket WebSocket 行为 |

## 当前支持矩阵

异步问题消费固定版 `item/completed` 的 `agentMessage.delivery = "async"` 与 `questions`，
回答复用 `turn/steer` / `turn/start`，不新增 Server Request 或实验 RPC。官方依据为固定版本
[`request_user_input_async.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/tools/handlers/request_user_input_async.rs)、
[`spec_plan.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/tools/spec_plan.rs) 和
[`questions.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/tui/src/chatwidget/questions.rs)。
工具由模型目录决定是否开放，Gateway 不注入工具、不重放历史问题、不推断其他客户端已经回答。
组合根在同一入站通知处理链路调用异步问题协调器的 `handleInput`，统一登记问题和处理失效，
不通过输出队列延迟登记；Core 只抑制重复正文及最终答复标记。回答提交失败独立于问题取消状态报告，
由协调器测试覆盖输出积压、生命周期失效和提交期间断线的组合场景。

Computer Use／浏览器过程展示复用已支持的 `item/started`、`item/completed` 和
`ThreadItem.mcpToolCall.arguments`：[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts)
只对 `cua_repl.js` / `js_reset` 标记操作类别，并提取 `js` 的 `title`；飞书
[`outbox.ts`](../src/surfaces/feishu/outbox.ts) 为同一操作创建并原地更新开始／终态卡片，不等待查询汇总。
由 [`operation-adapter.test.ts`](../tests/operation-adapter.test.ts)、
[`feishu-outbox-operations.test.ts`](../tests/feishu-outbox-operations.test.ts) 和
[`real-app-server-supervised-tools.test.ts`](../tests/real-app-server-supervised-tools.test.ts)
中的真实 MCP Item 合同验证。此展示不代表操作权限或浏览器连接已可用，未接入
`item/mcpToolCall/progress`，也不解析执行代码、原始结果或截图。
飞书 MCP 工具审批复用已支持的 `mcpServer/elicitation/request`，分别映射允许一次、
会话／持久允许、拒绝与取消；[`feishu-interactions.test.ts`](../tests/feishu-interactions.test.ts)、
[`approval-coordinator.test.ts`](../tests/approval-coordinator.test.ts) 及
[`real-app-server-isolated-state.test.ts`](../tests/real-app-server-isolated-state.test.ts)
覆盖按钮、稳定决定和真实协议往返，不新增系统或网站权限管理接口。

本表列出项目当前主动调用或消费的协议能力。未列出的生成类型不能直接视为已支持能力。
`codexc setup` 的脱敏总览复用既有 `config/read` 显示全局默认模型与思考等级，入口位于
[`setup-summary.mjs`](../scripts/setup-summary.mjs)，由 [`setup.test.ts`](../tests/setup.test.ts) 验证；
用户设置入口位于 `codexc config → Codex 新会话与用户偏好`，在显式确认后复用下表已有的版本化配置事务，不新增协议方法，也不修改登录状态。
网络代理菜单通过 [`codex-proxy-env.mjs`](../runtime/codex-proxy-env.mjs) 写入 Codex Home 的 `.env`，依据固定版本 [`arg0::load_dotenv`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/arg0/src/lib.rs) 的加载语义，由 [`config-menu.test.ts`](../tests/config-menu.test.ts) 验证，不新增 RPC。
渠道选择 OpenAI 模型时，`model-selection-service.ts` 复用 `writeDefaultFastMode(false)` / `config/batchWrite`
把用户级 `service_tier` 保存为 `default`，同时保留下一 Turn 的显式 Standard 覆盖；保存失败不切换会话。
第三方模型选择不修改 OpenAI 默认值；`model-selection-service.test.ts` 和
`real-app-server-isolated-state.test.ts` 的模型切换与真实 App Server 重启合同覆盖该行为。
OCG 账户快照明确为无有效订阅时，`gateway-component-graph.ts` 将该账户状态注入
`model-selection-service.ts`，从渠道 `/model` 的浏览和选择中排除该账户；正常额度刷新后恢复。
这是本地选择规则，不修改 `model/list` 协议、既有 Thread 或统计代理转发，验证见
`model-selection-service.test.ts` 与 `provider-account-service.test.ts`。Telegram 模型按钮经
`conversation-command-service.ts` 的结构化 `selectModel` 入口保留精确 Provider 与模型身份，
等待期间失去订阅时拒绝选择，不重解析到其他账户同名模型；回调竞态由
`telegram-command-interactions.test.ts` 覆盖。
固定版的公开用户配置只接受 `approval_policy = "on-request" | "never"`；协议内部的 `untrusted`
仍可作为 Workspace Thread 设置传给 App Server，但 `codexc remote` 不把它转换为固定版已退役的
CLI 参数，未显式覆盖时失败关闭。
[`public-cli-contract.json`](../src/codex-protocol/public-cli-contract.json) 固定记录 Remote 实际转发
的 `--remote`、`--profile`、`--config`、`--sandbox`、`--cd` 和 `--ask-for-approval` 的存在性、
别名、参数形状和枚举值；正式 CLI 升级会从目标版公开帮助刷新快照，并在
`public-cli-impact.md` 中把新增、删除、签名变化和枚举变化与 App Server 协议影响分开报告。
`codexc update` 在每次版本检查及候选源码切换前，用实际 CLI 校验同一快照、本地审批允许值和
实际 `CODEX_HOME/config.toml` 的根级和所有 Profile 审批设置；目标版本不同时使用临时候选 CLI
先完成真实校验，通过后才修改全局安装。不兼容设置只给出精确修复提示，不静默迁移审批语义。

启动恢复由 [`startup-network-recovery.ts`](../src/bootstrap/startup-network-recovery.ts) 协调：首次网络检查
结束后，在 [`startup-network-policy.json`](../startup-network-policy.json) 定义的五分钟窗口内有限复检，
HTTP 429/5xx 与传输失败继续使用剩余预算，路径与其他响应错误不重试。接续后的 OpenAI 绑定会话在后台
通过稳定 `mcpServerStatus/list` 补读一次当前快照，单次与整体都有截止时间，读取期间的实时通知与关闭事件优先；
首次快照失败时，在网络确认可达后仅对尚无更新通知的会话再补读一次，仍失败则明确提示状态未确认。
网络恢复后重新读取 `account/rateLimits/read`；仅观察到非重新授权类 `codex_apps` 失败才对主 OpenAI
实例调用一次稳定 `config/mcpServer/reload`，该方法影响此实例的所有已加载 Thread，不支持指定 Server。
健康连接由官方实现复用，恢复仍以 `mcpServer/startupStatus/updated` 为准，不重启共享进程或重放 Turn。
正常网络启动只观察窗口内迟到的失败通知；Gateway 停止会取消探测、额度读取与刷新请求的等待。
验证见 [`startup-network-recovery.test.ts`](../tests/startup-network-recovery.test.ts)、
[`json-rpc-account.test.ts`](../tests/json-rpc-account.test.ts)、[`json-rpc-mcp.test.ts`](../tests/json-rpc-mcp.test.ts)
和包含失败连接重建、健康连接复用的真实合同 [`real-app-server-isolated-state.test.ts`](../tests/real-app-server-isolated-state.test.ts)。

| 能力 | 当前使用的官方方法或通知 | 本项目入口与验证 |
| --- | --- | --- |
| 恢复协作模式 | `thread/resume.collaborationMode`（稳定响应字段） | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 将实际 Default/Plan 模式交给 [`router.ts`](../src/session-routing/router.ts)，用于显式接续、自动接续与订阅恢复；[`json-rpc-threads.test.ts`](../tests/json-rpc-threads.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`real-app-server-isolated-state.test.ts`](../tests/real-app-server-isolated-state.test.ts) |
| 异步用户问题 | `item/started`、`item/completed` 的 `agentMessage.delivery` / `questions`；回答复用 `turn/steer`、`turn/start` | [`async-question-coordinator.ts`](../src/bootstrap/async-question-coordinator.ts) 复用三个 Surface 的输入交互，独立于阻塞审批；[`conversation-service.ts`](../src/application/conversation-service.ts) 在锁内验证原 Thread 和有效期；[`async-question-coordinator.test.ts`](../tests/async-question-coordinator.test.ts)、[`conversation-service-input-control.test.ts`](../tests/conversation-service-input-control.test.ts)、[`real-app-server-supervised-tools.test.ts`](../tests/real-app-server-supervised-tools.test.ts) |
| Luna Reserve 自动回退 | `error.codexErrorInfo = usageLimitExceeded`、`account/rateLimits/read` 的 `supportsLunaReserve` / `excludeResetCreditDetails` 与账户、普通用量、后端 Banner 字段，`model/list.includeHidden`、`thread/settings/update` 及实验 `thread/settings/update.collaborationMode` | [`luna-reserve-port.ts`](../src/application/luna-reserve-port.ts) 与 [`luna-reserve-service.ts`](../src/application/luna-reserve-service.ts) 只把最终用量错误与同一 Turn 的完成事件配对，再验证同一 OpenAI 账户、受限模型和精确隐藏 `gpt-reserve`，以不重试的写请求切换当前 Thread；观察到活动 Turn 时延后写入，同一账户的 Reserve Thread 每轮共享一次轻量额度读取，失效期间的新触发在旧操作结束后续跑。只有权威普通额度明确恢复且无未知 Banner、消费控制或限额阻断时切回仍可用的原模型。待生效设置、手工改模、账户切换、Thread 关闭、归档、删除或 Gateway 关闭会取消状态；不可取消的设置写入若在账户失效后完成，只发出确认当前模型的告警，不执行可能覆盖后续选择的补偿写入。原模型仅保存在进程内，Gateway 不保存或重放失败消息，也不建立第二套 Queue；回退完成前由 App Server 自动开始的 Queue 消息仍可能失败并需重发。三个渠道复用稳定 warning 通知，并区分普通用量与 Reserve 自身用量耗尽；[`account-adapter.ts`](../src/codex-client/account-adapter.ts)、[`model-adapter.ts`](../src/codex-client/model-adapter.ts)、[`client.ts`](../src/codex-client/client.ts)、[`gateway-component-graph.ts`](../src/bootstrap/gateway-component-graph.ts)、[`luna-reserve-service.test.ts`](../tests/luna-reserve-service.test.ts)、[`json-rpc-account.test.ts`](../tests/json-rpc-account.test.ts)、[`json-rpc-models.test.ts`](../tests/json-rpc-models.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、真实 Thread 设置合同 [`real-app-server-isolated-state.test.ts`](../tests/real-app-server-isolated-state.test.ts) 与条件式真实账户/模型合同 [`real-app-server-websocket.test.ts`](../tests/real-app-server-websocket.test.ts) |
| 结构化 Turn 错误 | `error`、`turn/completed` 中的 `TurnError.codexErrorInfo = misalignmentPolicyViolation` 与 `unauthorized` | Client 只识别这两个精确枚举并传递窄分类；Core 将错误文本与代码作为整体归约并保留 `willRetry=false` 与 `failed` 终态，三个 Surface 的完成卡片对策略错误使用固定脱敏中文提示，对登录或刷新令牌失效按 OpenAI 官方与其他 Provider 分别提示重新登录、改选第三方或更新凭据，Turn 指标保存独立分类与协议代码；[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`core.ts`](../src/conversation-core/core.ts)、[`turn-error-metrics.ts`](../src/bootstrap/turn-error-metrics.ts)、[`lifecycle-presentation.ts`](../src/surfaces/lifecycle-presentation.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core-lifecycle.test.ts`](../tests/conversation-core-lifecycle.test.ts)、[`turn-error-metrics.test.ts`](../tests/turn-error-metrics.test.ts)、[`lifecycle-presentation.test.ts`](../tests/lifecycle-presentation.test.ts)、条件式真实策略错误合同 [`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP Plugin 来源 | `mcpServerStatus/list` 的 `McpServerStatus.pluginId` | Client 只保留可空、长度受限且符合固定上游 `<plugin>@<marketplace>` 字符规则的 ID；仅 `/mcp` 详情显示来源 Plugin，不用于授权、审批、命令/脚本来源推断或 OAuth 参数；[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`conversation-extension-command-format.ts`](../src/surfaces/conversation-extension-command-format.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`conversation-extension-command-format.test.ts`](../tests/conversation-extension-command-format.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP 工具发现状态 | `mcpServerStatus/list` 的 `McpServerStatus.toolsError` | Client 只把错误是否存在映射为稳定布尔值，不向 Application、Surface 或日志传播上游错误正文；`/mcp health` 将工具发现失败列为需处理项并建议显式刷新，不把空工具集误报为“未公开能力”；[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`conversation-service.ts`](../src/application/conversation-service.ts)、[`conversation-extension-command-format.ts`](../src/surfaces/conversation-extension-command-format.ts)、[`json-rpc-mcp.test.ts`](../tests/json-rpc-mcp.test.ts)、[`conversation-service-mcp.test.ts`](../tests/conversation-service-mcp.test.ts) |
| Thread 原生 Queue | 实验 `thread/queue/add`、`thread/queue/list`、`thread/queue/update`、`thread/queue/delete`、`thread/queue/reorder`、`thread/queue/start`、`thread/queue/changed` | [`thread-queue-port.ts`](../src/application/thread-queue-port.ts)、[`queue-adapter.ts`](../src/codex-client/queue-adapter.ts)、[`conversation-service.ts`](../src/application/conversation-service.ts)；100 条原生容量、25 条公开分页、文本编辑和非文本安全摘要；[`thread-queue.test.ts`](../tests/thread-queue.test.ts)、[`thread-queue-service.test.ts`](../tests/thread-queue-service.test.ts)、[`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、条件式真实容量/分页/派发/重启合同 [`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Thread 分页历史与 Revert | 实验 `thread/turns/list`、`thread/revert`、`thread/reverted` | 新建 Thread 显式使用 `historyMode: "paginated"`；[`thread-history-port.ts`](../src/application/thread-history-port.ts)、[`history-adapter.ts`](../src/codex-client/history-adapter.ts)、[`conversation-service.ts`](../src/application/conversation-service.ts) 与 [`conversation-core/core.ts`](../src/conversation-core/core.ts) 提供有界列表、五分钟一次性确认、执行前并发复核、Queue 原顺序保留和派生状态失效；[`thread-history.test.ts`](../tests/thread-history.test.ts)、[`thread-revert-service.test.ts`](../tests/thread-revert-service.test.ts)、[`conversation-core-lifecycle.test.ts`](../tests/conversation-core-lifecycle.test.ts)、条件式真实分页/活动中断/Queue 保留与显式派发/Revert 合同 [`real-app-server.test.ts`](../tests/real-app-server.test.ts)；不接入 `thread/items/list` |
| 初始化与连接 | `initialize`、`initialized` | [`codex-client/`](../src/codex-client/README.md)、[`doctor.mjs`](../scripts/doctor.mjs)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts)；发送消息受生成的 `ClientRequest` / `ClientNotification` 约束，初始化通过 `extensions` 显式声明已实现的 `openai/form`，Doctor 只从 `initialize.userAgent` 提取运行中 App Server 的实际版本并与锁定版本比较 |
| Thread 生命周期与分区 | `thread/list.modelProviders`、`thread/list.ancestorThreadId`、`Thread.parentThreadId`、`thread/loaded/list`、`thread/read`、`thread/start`、`thread/start.threadSource`、`thread/resume`、`thread/fork`、`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/unsubscribe`、`thread/name/set`、`thread/metadata/update`、`thread/section/move`、`thread/compact/start`、`thread/closed`、`thread/archived`、`thread/deleted` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 本机 [`session-cleanup.mjs`](../scripts/session-cleanup.mjs) 按所属 Provider 预览会话组，后代查询显式覆盖来源与归档状态，以祖先限定范围；只向父会话执行一次官方归档，随后核验可查询成员，区分部分成功与未知结果，不承诺原子性。验证见 [`session-cleanup.test.ts`](../tests/session-cleanup.test.ts)、[`real-app-server-supervised-tools.test.ts`](../tests/real-app-server-supervised-tools.test.ts)；官方依据为 [`thread_archive.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/app-server/tests/suite/v2/thread_archive.rs)。适配器把官方 `section`、`modelProvider` 映射为稳定快照，并把官方 `threadSource="automation"` 来源投影为稳定 `automation`；Desktop 启动检查用 `thread/loaded/list` 枚举持久及临时 Thread，再以 `thread/read` 读取权威活动状态。所有分区状态仍由 App Server 管理，Gateway 不建立第二套分区索引；StateStore 只保存最小绑定。运行中 `/resume` 或 `/new` 继续把原 Thread 作为有界后台任务；`/release` 只读定位持锁进程，`/release force` 在显式确认后释放占用；[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`json-rpc-threads.test.ts`](../tests/json-rpc-threads.test.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`gateway-startup-cleanup.test.ts`](../tests/gateway-startup-cleanup.test.ts)、[`thread-writer-lock.test.ts`](../tests/thread-writer-lock.test.ts)、[`surface-copy-contract.test.ts`](../tests/surface-copy-contract.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts)、[`real-app-server-desktop-bridge.test.ts`](../tests/real-app-server-desktop-bridge.test.ts) |
| Thread 设置与 Provider 路由 | `thread/start.modelProvider`、`thread/fork.modelProvider`、`thread/settings/updated`、`model/list`、`config/read`、`config/batchWrite`、实验 `collaborationMode/list` | [`model-port.ts`](../src/application/model-port.ts) 与 [`collaboration-mode-port.ts`](../src/application/collaboration-mode-port.ts) 定义稳定设置边界，[`model-adapter.ts`](../src/codex-client/model-adapter.ts) 映射 App Server 目录；模型条目中的 `multiAgentVersion`、结构化替代模型和退役时间只形成 `/model` 提示，不传播迁移 Markdown/链接，不参与可用性、路由、自动切换或审批；OpenAI 生命周期信息不复制到复用同名模型目录的第三方 Provider。`codexc config` 的 Codex 用户设置入口从同一目录选择全局模型与思考等级，并把 Fast、`sandbox_mode`、`approval_policy` 与 `sandbox_workspace_write.network_access` 收敛到带用户层修订检查的受控 `config/batchWrite` 事务；“一键配置全部”在一次确认后提交包含六个字段的同一原子事务。Fast 是 OpenAI 主配置偏好，不读取第三方模型目录；入口不修改登录凭据、第三方 Provider 配置或 Gateway Thread 默认值，用户层已有 `default_permissions` 时不混写传统 Sandbox 字段。`codexc remote` 的显式参数和 Workspace 权限继续优先，未覆盖时不再注入 Gateway 默认权限，而由 Codex 主配置及所选 Profile 自然归并。[`model-provider-catalog.ts`](../src/codex-client/model-provider-catalog.ts) 只在受管 Provider 已启用时映射 Setup 下载并审查的模型目录；自定义切换 Provider 的渠道选项不生成第三方目录文件，而由 [`model-selection-service.ts`](../src/application/model-selection-service.ts) 把主 App Server 的 Codex 官方目录以精确 Provider ID 克隆为可选项；后台隔离实例使用服务从本机 Codex CLI 导出的 Codex 官方目录快照（`~/.codex-connect/providers/custom/official-models.json`）作为 `model_catalog_json`，不请求第三方 `/models`。切换模式保持 OpenAI 基础配置不变，把 DeepSeek、OpenCode Go 与 CCG 的 Provider、Key 与路由隔离在统一 `sf-` 前缀的各自 Profile，模型目录、清单与管理标记存放在 `~/.codex-connect/providers/<id>/`；自定义第三方同样不写主配置，通过私有显式注册表和逐 Provider 的 `sf-custom-<id>` 完整 Profile 保存 Provider 块、Key、默认模型、`medium` 思考等级与服务层级。受管 Provider 模型设置按 Provider 保存默认模型、目录上下文与默认思考等级；上下文窗口由独立的“模型上下文窗口”按模型名聚合与广播，同名模型跨 Provider 共用同一窗口占比，并在各 Provider 的 `max_context_window` 一致时换算写入 `context_window`，最大窗口不一致时失败关闭；目录里其他字段保持下载原样，`auto_compact_token_limit` 仅作为上游压缩阈值，不换算为上下文窗口或随窗口调整而清空，写默认模型时保留模型目录已有窗口；受管切换 Profile 只选择当前默认模型并镜像该模型的默认思考等级（校验必须与模型目录一致），固定模式继续通过官方 `config/batchWrite` 写入默认模型并清除会覆盖目录设置的根级思考、上下文与压缩字段。历史 Thread 仍使用自身模型。由于固定版本不允许 Profile 选择器用于 `app-server`，服务入口校验各自私有 Profile 后，通过官方 `-c` 进程覆盖和仅对子进程可见的 Key 环境变量按需启动隔离 App Server，并显式移除其他受管 Provider Key。[`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts) 按官方 `modelProvider` 路由 Thread/Turn，隔离 Server Request ID 和单 Provider 重连；第三方账户通知不进入 OpenAI 账户状态，无法关联 Thread 的 MCP 与 warning 全局通知携带 Provider 来源并只投递到对应 Provider 会话。对应 App Server 在进程启动时加载自己的模型目录，避免进程级模型元数据管理器对 Thread 级目录覆盖使用 fallback。`codexc remote` 默认连接主实例；官方未登录且没有显式 Profile 时连接唯一第三方；多个候选全部属于同一家 DS、OCG 或 CCG 时连接该家注册表默认账户，其他多个候选要求明确指定 Profile。渠道未绑定会话采用相同规则，使用目标 Profile 默认模型，菜单与建线程共享选择；普通消息以及 Goal 查询/设置/清除、Review、Compact、Fork 统一经 Conversation Service 的会话入口应用该选择；同 Provider 选模型不提示切换 Provider，实际跨 Provider 提示在目标 Thread 建立后消失；没有统一默认账户的多个候选要求通过 `/model` 明确选择，官方默认模型不阻断第三方入口，已有 Thread 保留 Provider。该默认建线程与请求链路由无登录凭据的 [`real-app-server.test.ts`](../tests/real-app-server.test.ts) 验证；切换模式的 `--profile sf-custom-<Provider ID>`、`--profile sf-ds-<账户>`、`--profile sf-ocg-<accountId>` 与 `--profile sf-ccg-<accountId>` 与磁盘文件和原生 Codex 使用同一规范名称，并连接对应 Provider Socket；旧的无 `sf-` 名称只返回明确替换提示，不作为隐式别名。DS、OCG、CCG 均不迁移旧账户身份、Profile 或文件布局；旧配置需先移除再重新添加，旧 Provider 的历史 Thread 不保证恢复。可选模型以下载的官方目录为准，目录里有什么就开放什么（当前为 Flash 与 Pro），新安装默认使用 `deepseek-flash`；更新器不刷新 Provider 模型目录；目录配置由 Provider Setup 管理。模型目录由人工对照官方资料更新审查基线。`deepseek-flash` 从目录声明读取 `text/image` 输入能力并沿用稳定的内联 `image` Turn 输入，不新增 DeepSeek API 调用层；跨 Provider 选择保留并解绑原 Thread，向目标 App Server 的 `config/read` 读取 Profile 有效思考等级，目标模型不支持或未配置时才回落目录默认，再在下一条消息中创建新 Provider Thread；不继承原 Provider 设置，不 Fork 或复制 Provider 专属历史；同一 Provider 内模型选择仍作为下一 Turn 覆盖并保留兼容思考等级。Workspace、新会话和同 Provider 历史 Thread 切换会在 Conversation 内存中保留当前模型、思考等级与服务层级；自动接续只选择匹配 Provider 的候选，显式恢复不同 Provider 的历史 Thread 时尊重其原 Provider。Application 在创建或追加 Turn 前按模型目录检查图片和音频能力，避免文本模型静默接收占位输入。官方设置通知没有携带可变 Provider 时，Router 保留已确认的 Provider；[`codex-user-settings-management.test.ts`](../tests/codex-user-settings-management.test.ts)、[`codex-user-settings-setup.test.ts`](../tests/codex-user-settings-setup.test.ts)、[`codex-defaults-setup.test.ts`](../tests/codex-defaults-setup.test.ts)、[`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`model-selection-service.test.ts`](../tests/model-selection-service.test.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`deepseek-catalog.test.ts`](../tests/deepseek-catalog.test.ts)、[`deepseek-setup.test.ts`](../tests/deepseek-setup.test.ts)、[`model-provider-default-setup.test.ts`](../tests/model-provider-default-setup.test.ts)、[`model-provider-custom-runtime.test.ts`](../tests/model-provider-custom-runtime.test.ts)、[`model-provider-managed-runtime.test.ts`](../tests/model-provider-managed-runtime.test.ts)、[`model-provider-runtime-rollback.test.ts`](../tests/model-provider-runtime-rollback.test.ts)、[`model-provider-runtime-topology.test.ts`](../tests/model-provider-runtime-topology.test.ts)、[`collaboration-mode-service.test.ts`](../tests/collaboration-mode-service.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts) |
| Turn 控制 | `turn/start`、实验 `turn/start.collaborationMode`、`turn/steer`、`turn/interrupt`、`turn/started`、`error`、`turn/completed` | [`turn-port.ts`](../src/application/turn-port.ts) 定义稳定执行、结构化 Skill 输入、当前 Turn 最终回答 Schema 与 Default/Plan 覆盖端口，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 编码请求与响应；[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射生命周期通知、校验官方 `Turn.durationMs` 并统一脱敏、限长可显示的错误，[`lifecycle-presentation.ts`](../src/surfaces/lifecycle-presentation.ts) 在三渠道共享完成卡片中显示可用的官方 Turn 总耗时；显式 Skill 调用同时发送 `$<skill-name>` 文本标记和官方 `skill` 输入项，活动 Turn 不允许切换协作模式；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core-lifecycle.test.ts`](../tests/conversation-core-lifecycle.test.ts)、[`lifecycle-presentation.test.ts`](../tests/lifecycle-presentation.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Item 与流式输出 | `item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/reasoning/summaryPartAdded`、`item/reasoning/textDelta` | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 分类稳定 Item 事件，[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts) 生成脱敏操作摘要，并只把官方 `imageGeneration.savedPath` 映射为生成图片产物，[`core.ts`](../src/conversation-core/core.ts) 只归约稳定输入；官方三个推理通知只作为 Telegram 与飞书的“思考中…”状态驱动，默认不展示，摘要与原始思维链内容不进入渠道，连续思考每段只显示一次，每段独立计时并以最终标记结束，操作打断后再次思考会重新显示，首个回复增量、错误或完成时停止，可通过 `display.reasoning = true` 显式开启支持渠道的展示；微信为保留单次回复窗口预算，不主动发送推理、操作或 App Server 生成图片事件。[`generated-image.ts`](../src/surfaces/generated-image.ts) 对 Telegram 与飞书的生成图片本地读取执行绝对路径、无符号链接、普通文件、10 MiB 与 PNG/JPEG 签名校验；`codexc channel send-image` 对三个渠道使用各自受控读取边界提交渠道 spool 图片；[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`operation-adapter.test.ts`](../tests/operation-adapter.test.ts)、[`conversation-core-lifecycle.test.ts`](../tests/conversation-core-lifecycle.test.ts)、[`lifecycle-presentation.test.ts`](../tests/lifecycle-presentation.test.ts)、[`telegram-outbox.test.ts`](../tests/telegram-outbox.test.ts)、[`feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts)、[`weixin-outbox.test.ts`](../tests/weixin-outbox.test.ts)、[`channel-image-spool.test.ts`](../tests/channel-image-spool.test.ts)、[`channel-send-image.test.ts`](../tests/channel-send-image.test.ts) |
| 子代理活动与终态 | `subAgentActivity`、子线程 `turn/started` / `turn/completed`、`item/completed` 的 `collabAgentToolCall.receiverThreadIds` 与 `agentsStates` | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 只在 Item 完成阶段把官方活动类型映射为稳定事件，避免开始与完成阶段重复登记；Core 把 `started` 显示为子代理开始、把不改变当前存活状态的 `interacted` 显示为子代理继续，`interrupted` 与 `completed` 只参与终态跟踪。[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts) 把官方接收线程和状态映射为不含代理消息正文的稳定操作事件。[`subagent-completion-tracker.ts`](../src/bootstrap/subagent-completion-tracker.ts) 登记生成的子代理线程，并按子线程 `turn/started` 把每轮精确子 Turn 与父 Turn 写入指标库 Schema v11 的 `subagent_turns`；子 Turn 先于父 `interacted` 到达时会与有界待处理活动合并，上一轮仍在指标结算窗口内时分离结算，延迟终态和指标只匹配原子 Turn，避免快速继续覆盖或串入新一轮。成功结算只采用 App Server 发给发起父 Turn 的 `subAgentActivity.completed`，并按父 Thread、父 Turn、子 Thread 与代理路径精确匹配；子线程 `turn/completed` 与等待工具状态不再作为并行成功来源，失败和中断仍使用子线程官方终态、中断活动与工具异常状态。已观察到模型指标且终态后出现同一父 Turn 的官方 `wait` Item 时，再等待该子 Thread + Turn 的 Writer 当前持久化水位并立即发布；尚无指标或终态后未出现父线程等待时保留有界收敛窗口，登记前到达的成功活动按完整父运行归属短期有界保留。先前父 Turn 的 `wait` 不会加速之后才终止的并行或后续子代理。指标到达和静默时间不推断终态。无指标发布零统计，读取失败显示统计不可用。Telegram 与飞书的紧凑操作模式共用同一策略，只保留子代理启动和失败，抑制成功的等待与交互操作；完成卡片展示模型、请求与 Token，缓存和推理分项仅在调试模式展示。微信不主动发送子代理过程或完成事件。锁定 0.156.1 的真实 App Server 合同覆盖父 Turn 归属与活动顺序。[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`subagent-completion-tracker.test.ts`](../tests/subagent-completion-tracker.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts)、[`lifecycle-presentation.test.ts`](../tests/lifecycle-presentation.test.ts)、[`request-metrics-store.test.ts`](../tests/request-metrics-store.test.ts)、[`telegram-outbox.test.ts`](../tests/telegram-outbox.test.ts)、[`feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts)、[`weixin-outbox.test.ts`](../tests/weixin-outbox.test.ts) |
| 上下文压缩 | `thread/compact/start`、`contextCompaction` Thread Item 与 `item/completed` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 从恢复历史提取压缩 Item ID，[`core.ts`](../src/conversation-core/core.ts) 合并实时完成 Item 并去重，[`conversation-service.ts`](../src/application/conversation-service.ts) 公开总次数；[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`conversation-core-lifecycle.test.ts`](../tests/conversation-core-lifecycle.test.ts)、[`telegram-format.test.ts`](../tests/telegram-format.test.ts)、[`telegram-outbox.test.ts`](../tests/telegram-outbox.test.ts)。生成类型中的 `thread/compacted` 已标记废弃，统计不依赖它；当前 Item 不提供手动/自动触发来源，因此只显示总次数 |
| 警告 | `warning`（Thread 目标或全局） | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射并统一脱敏、限长消息，[`core.ts`](../src/conversation-core/core.ts) 只负责目标路由；[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core-global-events.test.ts`](../tests/conversation-core-global-events.test.ts) |
| Diff、计划产物与 Review | `turn/diff/updated`、`turn/plan/updated`、`review/start` | Review 目标与结果由 [`turn-port.ts`](../src/application/turn-port.ts) 定义，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 映射；Diff/计划产物通知经 [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 转成稳定事件后由 Core 归约。计划还通过结构化 `plan.updated` 输出，默认由三个 Surface 展示，`display.plan_updates = false` 时关闭；计划产物通知与切换官方 Plan 协作模式是两个独立边界 |
| Goal | `thread/goal/get`、`thread/goal/set`、`thread/goal/clear`、`thread/goal/updated`、`thread/goal/cleared` | [`turn-port.ts`](../src/application/turn-port.ts) 定义执行端口，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 映射请求结果，[`conversation-service.ts`](../src/application/conversation-service.ts) 在 set/clear 成功后立即同步 Core，[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 把外部变更与恢复通知转换为稳定 Core 事件；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core-lifecycle.test.ts`](../tests/conversation-core-lifecycle.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 审批和用户输入 | 命令、文件、权限、用户输入、MCP elicitation 共 5 类审批 Server Request；命令审批只接受缺省或明确的 `kind=command`，0.152.0 新增的 `writeStdin` 与未知种类在没有独立预览合同前失败关闭；MCP 工具审批按 form 的 `mcp_tool_call` 元数据区分，并只返回上游提供的 `session` / `always` 范围；0.156.1 的 `openai/userVerification` 高权限模式未声明初始化扩展、未导出五个用户验证 Client RPC，收到请求时显式取消；`thread/start`、`thread/resume` 按 Workspace 权限传 `approvalPolicy` / `sandbox` / `permissions`（`permissions` 与 `sandbox` 互斥）；已授权用户可通过渠道 `/workspaceperm` 查看或修改当前 Workspace 权限 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts) 负责协议解码与编码，[`approval/`](../src/approval/README.md) 负责稳定授权语义，各 Surface 只实现平台交互，[`router.ts`](../src/session-routing/router.ts) 把配置权限映射为 Thread 启动参数，[`workspace-permission-writer.ts`](../src/bootstrap/workspace-permission-writer.ts) 写回配置并校验互斥；[`approval-coordinator.test.ts`](../tests/approval-coordinator.test.ts)、[`interaction-router.test.ts`](../tests/interaction-router.test.ts)、[`feishu-interactions.test.ts`](../tests/feishu-interactions.test.ts)、[`telegram-interactions.test.ts`](../tests/telegram-interactions.test.ts)、[`weixin-interactions.test.ts`](../tests/weixin-interactions.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`workspace-permission-writer.test.ts`](../tests/workspace-permission-writer.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 计划任务动态工具 | 实验 `thread/start.dynamicTools`、`item/tool/call` | Gateway 前台新 Thread 注册 `schedule_task`；Bootstrap 的 [`scheduled-task-tool-request.ts`](../src/bootstrap/scheduled-task-tool-request.ts) 将模型参数解码后交给 Application [`ScheduledTaskToolService`](../src/application/scheduled-task-tool.ts) 复用现有创建预览/列表/生命周期用例；工具不暴露 `confirm`，用户仍必须通过 `/schedule confirm` 确认创建或删除。后台计划任务 Thread 不注册工具，`createScheduledTaskServerRequestHandler` 也拒绝递归工具调用。官方只允许在 `thread/start` 注入工具，因此旧 Thread 保持当前 Provider、模型和上下文，Gateway 不为工具注入自动替换前台 Thread；旧 Thread 继续使用 `/schedule`，用户显式新建的 Thread 才注册工具；[`scheduled-task-tool.test.ts`](../tests/scheduled-task-tool.test.ts)、[`scheduled-task-server-request.test.ts`](../tests/scheduled-task-server-request.test.ts)、[`session-router.test.ts`](../tests/session-router.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Skill、MCP 与 Plugin | `skills/list`、`turn/start` / `turn/steer` 的 `input.skill` 和 `mention`、`mcpServerStatus/list`、`config/mcpServer/reload`、`mcpServer/oauth/login`、`mcpServer/oauthLogin/completed`、`mcpServer/resource/read`、MCP 状态通知与 Tool Item `readOnlyHint`、开发中 `plugin/installed` | Skill、MCP 与 Plugin 分别由 [`skill-port.ts`](../src/application/skill-port.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`plugin-port.ts`](../src/application/plugin-port.ts) 及对应 Client 适配器隔离。MCP 按当前 Thread 提供有界详情、健康摘要、刷新、OAuth 与只读 Resource；工具目录和实际 Tool Item 的读写提示统一归约为只读、可能写入或未知，但不替代审批或执行结果，也不暴露直接 Tool Call。Plugin 只在默认关闭、显式开启的开发中开关下列出或查看当前 Workspace 已安装项，并可在 OpenAI Thread 中发送官方 `mention`；Application 对同一次 `plugin/installed` 响应提供每页 8 项的本地分页过滤和只含需处理项的健康摘要，保留全局序号且不调用实验 `plugin/search`；详情使用响应中的版本、来源类型、安装时间、开发者、分类、能力、认证时机、不可用原因和适用套餐标识，能力与套餐各有界展示 8 项，不传播来源路径、URL、图标、截图、默认提示词或原始 Marketplace 错误。Marketplace 搜索、安装、卸载和分享仍禁止。三个 Surface 共用解析与输出；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`conversation-extension-command-format.test.ts`](../tests/conversation-extension-command-format.test.ts)、[`operation-adapter.test.ts`](../tests/operation-adapter.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`surface-copy-contract.test.ts`](../tests/surface-copy-contract.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP 与扩展任务通知口径 | MCP 启动状态通知、`turn/started` | MCP 首次 `starting` / `ready` 状态保持静默，[`core.ts`](../src/conversation-core/core.ts) 只投递失败、取消和异常恢复，避免与主动查询或认证结果重复。Skill、Plugin 和子代理新建 Turn 时只由共享生命周期确认，并在该事件中保留具体类型和名称；追加到活动 Turn 时保留命令确认；[`conversation-core-global-events.test.ts`](../tests/conversation-core-global-events.test.ts)、[`surface-copy-contract.test.ts`](../tests/surface-copy-contract.test.ts)、[`feishu-outbox.test.ts`](../tests/feishu-outbox.test.ts) |
| 用量、额度与权限 | OpenAI：`account/read`（不刷新凭据的当前认证路由）、`account/usage/read`（账户摘要与可选 `threadId` 官方估算）、`account/rateLimits/read`、账户通知；DeepSeek：`GET /user/balance`；OpenCode Go：`GET /zen/go/v1/usage`；CCG：`GET /alpha/whoami?limits=1`、`GET /alpha/billing/credits`；权限：`permissionProfile/list` | Gateway 启动时若当前 Codex Home 缺少 `auth.json` 则跳过 OpenAI 连通探测；存在鉴权文件时只把 `account/read` 的认证类型投影为 API、ChatGPT 或无需 OpenAI 认证，据此选择 [`openai-connectivity.ts`](../src/bootstrap/openai-connectivity.ts) 的官方活动线路，不读取或传播凭据；API 与自定义 Base URL 按官方 Doctor 规则检查 `/responses` 和 `/models`，ChatGPT 检查 `/backend-api/codex/responses`；`account/read` 与 HTTP 探测共同受总计 12 秒的截止时间约束且不阻断启动。系统代理在服务启动后变化时，[`network-proxy-watcher.ts`](../src/bootstrap/network-proxy-watcher.ts) 仅提示在所有客户端任务结束后按前台或后台入口重新启动 Gateway 与 App Server，不自动重启共享进程。[`account-port.ts`](../src/application/account-port.ts) 与 [`provider-account-service.ts`](../src/application/provider-account-service.ts) 按当前 Thread 的 `modelProvider` 返回 Token 用量、精确 Thread 官方估算、额度、第三方余额、配额窗口或明确不支持；OpenAI [`account-adapter.ts`](../src/codex-client/account-adapter.ts) 接受固定版本完整 `PlanType`，其中 `ent26` 显示为 Enterprise，并严格校验官方 Thread ID、整数单位、分组字段及每张重置券的可空到期时间；`/usage` 保留账户摘要为主结果，当前 OpenAI Thread 的估算查询并行且失败隔离，不缓存、轮询或聚合子代理；`/limits` 展示官方重置券数量，按到期时间合并明细并明确标识无到期时间或服务端未返回的明细，仅在官方响应包含 10,080 分钟窗口与有效重置时间，且本机统计代理在相同重置周期观测到额度正向变化时，用 [`request-metrics-port.ts`](../src/application/request-metrics-port.ts) 按相邻快照区间估算每 1% Token；DeepSeek [`deepseek-account-adapter.ts`](../src/bootstrap/deepseek-account-adapter.ts) 通过共享 [`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs) 从切换 Profile 或固定基础配置读取 Key、复用统一代理并裁剪官方余额；OpenCode Go [`opencode-go-account-adapter.ts`](../src/bootstrap/opencode-go-account-adapter.ts) 通过同一运行时读取凭据，把官方 `/usage` 的 5 小时/7 天/月度三个窗口归约为通用 `quota-windows` 形态（已用百分比与重置时间），命令与 WebUI 按窗口展示；5 小时本地 Token 按滚动时间范围汇总，7 天/月度按请求记录的固定周期快照汇总；CCG [`ccg-account-adapter.ts`](../src/bootstrap/ccg-account-adapter.ts) 使用当前官方 CLI 的账户身份与 Credits 接口，展示月度、充值和赠送余额及 5 小时/7 天窗口；WebUI 账户快照按 DS、OCG、CCG 注册表补齐多账户元数据并支持逐账户刷新；Thread Token/上下文统计保持 Provider 通用，OpenAI 周限不附加到第三方 Thread；账户通知仍由 [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts) 映射，Permission Profile 由 [`permission-port.ts`](../src/application/permission-port.ts) 与 [`permission-adapter.ts`](../src/codex-client/permission-adapter.ts) 隔离；[`json-rpc-account.test.ts`](../tests/json-rpc-account.test.ts)、[`openai-connectivity.test.ts`](../tests/openai-connectivity.test.ts)、[`provider-account-service.test.ts`](../tests/provider-account-service.test.ts)、[`deepseek-account-adapter.test.ts`](../tests/deepseek-account-adapter.test.ts)、[`opencode-go-account-adapter.test.ts`](../tests/opencode-go-account-adapter.test.ts)、[`ccg-account-adapter.test.ts`](../tests/ccg-account-adapter.test.ts)、[`webui-account-refresh-state.test.ts`](../tests/webui-account-refresh-state.test.ts)、[`webui-server-provider-management.test.ts`](../tests/webui-server-provider-management.test.ts)、[`conversation-metrics-format.test.ts`](../tests/conversation-metrics-format.test.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-core-global-events.test.ts`](../tests/conversation-core-global-events.test.ts)、[`conversation-core-usage.test.ts`](../tests/conversation-core-usage.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) 与无需登录的真实账户线路合同 [`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 真实合同 | 当前 OpenAI 认证路由、模型、思考等级、Fast、`multi_agent_v2` 与 agents 用户设置、Skill/MCP/Plugin/Permission 稳定查询、Plugin 安全详情字段、结构化 Skill 与 Plugin mention Turn 输入、MCP 配置刷新、完整详情与工具读写属性、只读资源、OAuth PKCE 回调与完成通知、MCP 工具审批元数据与持久范围往返、Default/Plan 预设与 Plan Turn 设置通知、共享 Thread 设置通知、当前精确 Thread 官方用量估算、跨客户端 Thread 固定状态、Turn 启动结果、跨客户端 Goal 请求与通知、重连后 resume Goal 恢复、双客户端连接恢复、动态工具注册与 `item/tool/call` 完整往返，以及真实 `service-app-server` 的主实例启动、Provider 按需启动/释放与租约拒绝释放 | [`real-app-server.test.ts`](../tests/real-app-server.test.ts)、[`real-app-server-websocket.test.ts`](../tests/real-app-server-websocket.test.ts)、[`real-app-server-supervised-provider.test.ts`](../tests/real-app-server-supervised-provider.test.ts) |

自定义 Responses Provider Setup 的官方模型目录复用、手工模型 ID、固定/切换双模式、直接 API Key、
独立 Profile、候选编辑、统计代理接入，以及私有备份事务边界见
[`第三方模型 Provider 接入指南`](provider-integration-guide.md)；该本地 Setup 能力不新增 App Server RPC。

上表“全 Provider 模型代理与请求统计”还包括仅官方 OpenAI 主代理启用的 0.156.1 固定端点清单：
搜索、图片、记忆摘要与 Realtime HTTP/WS 请求透明转发且不计入 Responses 指标；DeepSeek、
OpenCode Go 和自定义第三方代理仍拒绝这些路径。真实合同使用当前锁定 App Server 验证
`POST /alpha/search` 能穿过该白名单并完成工具结果往返。

Provider 生命周期补充：私有 [`app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs) 不是
Codex App Server RPC。它负责主实例与受管实例的按需启动和显式管理操作；`codexc remote` 连接实例
期间通过同一私有 Socket 持有生命周期租约，Supervisor 在租约存在时拒绝显式释放，并在连接正常退出
或异常断开后自动撤销租约。同一实例的启动、释放与租约获取串行执行，释放响应区分已释放、
租约占用与实例未运行；DS、OCG、CCG 通过共享 [`managed-provider-account-runtime.mjs`](../scripts/managed-provider-account-runtime.mjs)
在删除账户文件前检查并释放对应实例，遇到租约占用、释放失败或无效监管响应时保留文件；
跨提供商回归见 [`managed-provider-account-lifecycle.test.ts`](../tests/managed-provider-account-lifecycle.test.ts)。主 App Server 与受管 Provider
实例共用同一套监管协议，`codexc remote` 连接主实例时同样持有生命周期租约。Gateway 全局空闲策略
在关闭已连接 Client 后调用 Supervisor 停止 App Server 进程（含主实例）；会话解除后等待 60 秒，
期间可恢复或创建新会话，之后每 60 秒复检一次。宽限期结束仍无任何绑定和活动时，先向所有已知授权
渠道通知，再关闭 Client，并停止监管入口中全部未被租约占用的运行实例；服务进程保持运行，后续使用
按需启动。不经 `codexc remote` 直连共享 Socket 的客户端不持有租约，空闲释放不会为其保留实例。
该通知只针对渠道会话空闲自动解除触发的全局释放轮次，其他原因导致的无绑定关闭不广播。
没有监管入口时，Gateway 仍可连接独立运行的 App Server，但不会按需启停该进程。确保与释放遇到旧版
监管协议响应时失败关闭，并提示运行 `codexc service restart all`。

本项目不在本地计算或估算模型价格与费用：Gateway 不抓取价格目录、不刷新汇率，也不保存价格
快照；DeepSeek 与 OpenCode Go 的官方价格基线、`ModelPricingResolver` 与价格展示字段均已删除。
模型目录仍由人工对照官方资料审查更新。账户与额度展示保持官方来源：DeepSeek 官方账户只显示
余额（官方无用量窗口）；CCG 显示 Command Code Credits 余额与 5 小时/7 天窗口；OpenCode Go 的 5 小时本地 Token 按当前滚动时间范围归属，7 天/月度按
请求记录的固定周期快照归属（缺失时由官方 `resetsAt` 倒推窗口）执行，`/usage` 只展示官方配额
窗口与本机 Token，不展示价格或费用。
按需启动、初始化与模型列表流程由 Codex 0.156.1 真实 App Server 合同测试覆盖。

指标库 Schema v8 曾为价格快照新增 `pricing_bucket`，Schema v9 为官方额度窗口快照新增
`quota_windows` 列，Schema v10
为 `subagent_threads` 新增可空 `parent_turn_id`，Schema v11 新增按子 Thread + Turn 记录精确父 Turn
归属的 `subagent_turns`，Schema v12 新增官方账户快照表，Schema v13 为每个请求新增记录实际发往
模型上游 `User-Agent` 的 `user_agent` 列；Schema v14 删除价格、成本、旧计时列与派生 View，只保留
当前采集和展示合同；Schema v15 新增可空 `upstream_ttft_ms`，保留 OpenAI 上游首 Token 统计，
完成卡片取当前 Turn 首个有效样本，不由 App Server 通知或本地时间估算。Schema v16 新增可空
`first_content_ms`、`request_model`、`response_model`，由 Provider Proxy 独立观测单请求首内容和请求/响应模型名称，
贯通指标 IPC、明细、导出及转储，不新增 App Server RPC。单请求首字耗时参考 sub2api：HTTP/SSE 使用 semantic、
WebSocket 使用 token-event 判定，具体口径及差异见[WebUI 请求明细](webui.md)；不替代上游轮次 TTFT。
Schema v17 保存可空转储标签、实际 writer session 与 interaction，由 Provider Proxy 绑定并经 IPC、指标库、导出和 WebUI 精确定位调用；不根据历史时间猜配，也不新增 App Server RPC。
转储读取器通过 `traffic-dump-presentation.mjs` 分开投影当前调用的服务端模型声明与安全缓冲候选；CLI 与 WebUI 复用 `runtime/model-name-comparison.mjs` 比较请求和响应名称，候选不作为实际换模证据，不改变转发或存储协议。
单次调用阶段由 `src/provider-proxy/traffic-call-timing.ts` 记录单调时钟节点，`traffic-dump.ts` 写入 V2 响应索引的可选 `callTiming`；共享读取器向 CLI 与 WebUI 投影阶段，与上游 logical-turn 统计分组。Schema v18 新增可空 `total_duration_ms`，总耗时由 `response-metrics-observer.ts` 从请求入口到首次终态或结束/失败观测，经指标 IPC、Store、请求明细和导出贯通；不依赖调用记录开关，旧记录为 NULL，不新增 App Server RPC。
Schema v19 的 `request_service_tier` 由 `provider-proxy/proxy.ts` 从 HTTP/WS 出站请求独立采集，经指标 IPC、Store 与 JSON/CSV 导出传递；WebUI 请求和错误明细按请求层级显示 FAST，不被响应 `default` 覆盖。请求层级缺失时为 NULL；由 `provider-proxy-http-metrics.test.ts`、`provider-proxy-websocket-metrics.test.ts`、`provider-proxy-metrics.test.ts` 和 `webui-tables.test.ts` 验证，不新增 App Server RPC。
指标库只接受当前 Schema，不提供历史升级；新安装直接建库。

CLI 用户设置使用的用户级 `config/read` 不携带 Workspace CWD，读取用户层并投影该连接的合并配置；渠道跨 Provider
切换则向目标 App Server 发送带 Workspace CWD 的只读 `config/read`，取得该 Profile 的有效思考等级。
电脑、浏览器与已有 MCP 设置由 [`codex-tool-settings.mjs`](../scripts/codex-tool-settings.mjs) 受控投影，
复用上述读取和带 `expectedVersion` 的 `config/batchWrite`，不新增 RPC。字段依据固定版
[`computer_use.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/computer_use.rs)、
[`browser_use.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/browser_use.rs)、
[`mcp_types.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/mcp_types.rs) 和
[`types.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/config/src/types.rs) 的插件覆盖白名单；
由 [`codex-user-settings-management.test.ts`](../tests/codex-user-settings-management.test.ts) 与
[`real-app-server-isolated-state.test.ts`](../tests/real-app-server-isolated-state.test.ts) 验证字段隔离、带点键与精确删除。
渠道选择 OpenAI 官方模型时不继承当前 Thread 或用户配置中的 Fast，下一 Turn 显式使用标准服务层级；
Fast 只在用户之后通过 `/fast on` 明确开启时生效。
模型、思考等级、Fast、计划清单工具、
`multi_agent_v2` 的普通键级写入使用官方 `config/batchWrite` 事务。
Codex 原生角色的 Provider、凭据、目录与权限继承父线程；本项目不提供第三方子代理配置入口。
官方行为见锁定版本的
[`role.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/agent/role.rs) 与
[`role_tests.rs`](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/agent/role_tests.rs)。
真实合同 [`real-app-server-supervised-tools.test.ts`](../tests/real-app-server-supervised-tools.test.ts)
验证原生角色的 Provider 继承、模型/思考覆盖及父子完成归属。
切换模式受管 Profile 镜像所选模型的默认思考等级，第三方
App Server 启动时读取 Profile 的该设置并显式携带，原生 `codex --profile sf-*` 与 Remote/
App Server 保持一致，避免继承全局 `config.toml` 的官方思考等级。子代理复用父线程统计代理，不设角色专用路由，不从角色配置推测请求的思考等级。
用户设置的读改写从同一 Client 的原始用户层取得版本并传入 `expectedVersion`，版本冲突失败关闭，
不自动重试或覆盖用户并发修改。
DeepSeek 完整安装、备份恢复和 App Server 无法管理的专属文件仍由 Setup 执行私有文件级事务。

完成卡片中的“思考次数”表示本轮明确返回推理 Usage 且推理输出大于零的模型请求数；上游未返回
推理 Usage 时不猜测。

当前生成协议还包含 Project、文件系统 RPC、独立命令执行、登录、Marketplace、App、Realtime、
Remote Control、动态工具、Attestation 和实验能力等类型；它们没有因此自动成为 Gateway
公开能力。采用其中任何能力前，必须先审查对应 Server Request、Notification、安全边界和真实合同。

### 输入与语音边界

| 输入或交互 | 固定 CLI 0.156.1 | Gateway 当前状态 | 边界 |
| --- | --- | --- | --- |
| 文本 | `turn/start`、`turn/steer` 的稳定 `UserInput.text` | Telegram、飞书、微信已支持 | 由 Application 的 `TurnInput.text` 进入统一 Turn |
| 内联图片 | `turn/start`、`turn/steer` 的稳定 `UserInput.image`（`url`） | 三渠道受限 PNG/JPEG/WebP/非动画 GIF Data URL 已支持；仅当前模型声明 `image` 输入能力时可用 | Surface 完成下载、签名、格式、数量和大小校验后，共享批处理器按 [OpenAI 图片输入要求](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements)在提交边界读取为有界 Base64 Data URL；Gateway 统一限制为单张 10 MiB、每批最多四张且合计 20 MiB，这是跨渠道安全边界，不代表三平台具有相同官方上限，并低于当前已知 Provider 上限。Application 拒绝 HTTP(S)、空值和非法 Base64，Gateway 不把本地路径或 Base64 写入自身日志或独立存储，并在创建或追加 Turn 前按模型目录检查 `image` 能力；支持时提交官方 `image`，不支持时提示使用 `/model` 切换模型，不调用外部视觉 API，也不建立第二套识图会话；[`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`surface-input-coalescer.test.ts`](../tests/surface-input-coalescer.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts)、[`deepseek-catalog.test.ts`](../tests/deepseek-catalog.test.ts) |
| 图片自动引用 | 稳定 `turn/start`、`turn/steer` 的 `UserInput.image.fileId`；`getAuthStatus` 与受控 `account/read.workspaceRouting` | OpenAI ChatGPT Thread 经当前模型代理后端核验后上传原图并提交编号；仅默认后端一致且策略为 `NO_CONSTRAINT` 时转换，自定义独立后端保留内联，`us`、`us_cr` 或后端不一致拒绝；历史由官方保留。飞书实机已验证首次 `file_id` 与后续 `previous_response_id` 接续不重复 Base64 | [`image-reference-upload.ts`](../src/codex-client/image-reference-upload.ts)、[`image-reference-upload.test.ts`](../tests/image-reference-upload.test.ts)、[`real-app-server-supervised-tools.test.ts`](../tests/real-app-server-supervised-tools.test.ts)；[决策与限制](codex-cli-upgrade-decisions.md#图片文件引用需求阻塞与实现边界)、[脱敏实测记录](codex-image-fileid-probe.md#gateway-生产链路验收) |
| 一次性音频 | 稳定 `UserInput.audio` / `UserInput.localAudio`；模型目录用 `inputModalities` 声明实际能力；固定源码支持 WAV、MP3、M4A、WebM 与 OGG 本地音频 | 三渠道平台接收与受限转换已实现；当前可见模型均未声明 `audio`，原始音频不属于当前端到端支持 | Surface 先验证可信时长、最长 5 分钟、最大 20 MiB 与格式并写入一小时私有临时文件；Application 再按当前或下一 Turn 模型的 `inputModalities` 检查 `audio`，缺失时在 `turn/start` / `turn/steer` 前明确拒绝。微信可信转写仍作为文本提交；SILK 明确拒绝 |
| 实时语音 | 实验 `thread/realtime/start`、`appendAudio`、`appendSpeech`、`stop` 及 Realtime 通知 | 禁止接入 | Realtime 不在 Plan、Queue、Revert、前台计划任务动态工具及图片上传账户路由五类受控例外中；不得导出、调用或消费 Realtime 业务能力 |
| ChatGPT Voice / 语音听写 | 官方桌面应用产品能力，不是当前 CLI 命令入口 | 不属于 Gateway | 不用平台模拟实现第二套 Codex 实时会话或语音输出 |

Application 的 `TurnInput` 是只含 `text`、内联 `image` 与 `localAudio` 的封闭联合；模型目录
只把 `text`、`image`、`audio` 三种官方输入能力映射为稳定类型，包含 `localAudio` 的提交必须
先通过当前模型能力检查。Codex Client 映射这些稳定输入，OpenAI ChatGPT 图片经账户校验和上传转换为官方 fileId，其他 Provider 保持内联路径。模块边界测试同时禁止生产 Client 调用 `thread/realtime/*`，Surface
不得把平台音频地址、密钥、实时音频或未验证的编解码数据带入 Application/Core。

会话列表命令（`/resume`、`/sessions`、`/archived`）优先显示本机指标/派生缓存中的 Turn 轮数，打开列表不等待 `thread/turns/list` 历史扫描；该口径与 WebUI 一致，按本机已记录模型请求的不同 Turn 统计，缓存缺失时不猜测轮数。`thread-adapter.ts` 同时保留 `thread/list` 的 `updatedAt` / `recencyAt` 供 CLI 清理的空闲过滤，精确历史计数只在清理候选校验等显式路径使用。

历史恢复限定当前工作区，复用 `thread/list`、元数据 `thread/read` 和 `thread/resume`：
[`router.ts`](../src/session-routing/router.ts) 在恢复和重连前核对历史目录，恢复后校验实际目录、权限和活动状态；
显式恢复、重连与接管校验明确不匹配时统一移除对应绑定；Core 活动查询排除已解绑 Thread，
下一条前台消息强制新建 Thread，避免普通发送或 steer 绕过恢复校验。
共享订阅的生命周期按 Thread 串行，后台恢复在 RPC 前后复核原绑定，避免过期结果覆盖用户切换。
[`conversation-service.ts`](../src/application/conversation-service.ts) 在锁内复核选择上下文，并恢复活动 Turn。
跨工作区拒绝与显式切换后的目录归属由 [`real-app-server-isolated-state.test.ts`](../tests/real-app-server-isolated-state.test.ts)
的 `rejects cross-workspace history` 合同验证；失败清理与并发选择由
[`session-router.test.ts`](../tests/session-router.test.ts) 和 [`conversation-service-session.test.ts`](../tests/conversation-service-session.test.ts) 验证。

## 本项目实现映射

CCG（CommandCode）复用已有 Responses Provider、模型设置和路由，不新增 App Server RPC；账户使用
`ccg-<accountId>` 隔离 Profile、Key、App Server 和指标，并共享一份 CCG 模型目录与统计代理。
接口来源为 [CommandCode Provider 文档](https://commandcode.ai/docs/provider)，接入入口为
[`ccg-setup.mjs`](../scripts/ccg-setup.mjs)，模型由 [`provider-model-catalog.mjs`](../scripts/provider-model-catalog.mjs) 从 DS 完整目录生成，保留原模型并复用 Flash 内容增加 V4.1；写入前通过锁定 CLI 的 `debug models` 及其 `model_catalog_json` 解析验证完整格式；实现边界见
[`CCG`](ccg.md)。账户 Credits 使用官方 `command-code` CLI 1.62.1 当前调用的 Alpha 账户端点，公开
Provider 文档未列出该接口；配置与失败回滚验证见 [`ccg-setup.test.ts`](../tests/ccg-setup.test.ts)，
账户响应归约见 [`ccg-account-adapter.test.ts`](../tests/ccg-account-adapter.test.ts)。

| 要查的问题 | 本项目入口 | 验证入口 |
| --- | --- | --- |
| CLI、运行中 App Server 和生成协议是否一致 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`protocol-info.ts`](../src/codex-client/protocol-info.ts)、[`doctor.mjs`](../scripts/doctor.mjs) | `npm run protocol:check`、`codexc doctor`、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts) |
| Unix WebSocket 如何连接并对齐原生 128 MiB 消息上限 | [`codex-client/`](../src/codex-client/README.md) | [`unix-websocket-transport.test.ts`](../tests/unix-websocket-transport.test.ts) |
| Windows Proxy 如何连接并在静默握手时有界清理 | [`windows-proxy-transport.ts`](../src/codex-client/windows-proxy-transport.ts) | [`windows-proxy-transport.test.ts`](../tests/windows-proxy-transport.test.ts)；该回归合同只在 Windows 执行 |
| 开发中的 Desktop App 如何共享主 OpenAI App Server | [`Codex Desktop App 共享 App Server 实施方案`](codex-desktop-app-development.md)、[`desktop-app-bridge.mjs`](../runtime/desktop-app-bridge.mjs)、[`desktop-app-host.mjs`](../runtime/desktop-app-host.mjs)、[`desktop-app-command.mjs`](../scripts/desktop-app-command.mjs)、[`desktop-app-proxy.mjs`](../scripts/desktop-app-proxy.mjs)；macOS `open` 在 Pipe 附加前复用官方 `thread/loaded/list` 与 `thread/read` 检查全部已加载的持久及临时 Thread，并拒绝活动 Thread 或 Remote TUI 租约；受管入口的 Thread 双向共享、App Server 重启恢复与内置 `codex_app` 启动已通过实机测试，JSONL stdio/Unix WebSocket 转换另由真实 0.156.1 `initialize` 合同覆盖；Windows 尚未实机验收 | [`app-server-service-runtime.test.ts`](../tests/app-server-service-runtime.test.ts)、[`desktop-app-bridge.test.ts`](../tests/desktop-app-bridge.test.ts)、[`desktop-app-bridge-token.test.ts`](../tests/desktop-app-bridge-token.test.ts)、[`desktop-app-command.test.ts`](../tests/desktop-app-command.test.ts)、[`json-rpc-threads.test.ts`](../tests/json-rpc-threads.test.ts)、[`windows-desktop-app-command.test.ts`](../tests/windows-desktop-app-command.test.ts)、[`real-app-server-desktop-bridge.test.ts`](../tests/real-app-server-desktop-bridge.test.ts)；自动化合同不覆盖打包 Desktop 的私有工具 Pipe 与签名校验 |
| JSON-RPC 如何分流和清理请求 | [`json-rpc.ts`](../src/codex-client/json-rpc.ts)；通知不附加本地统计计时，请求超时与诊断耗时保持独立 | [`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`json-rpc-timing.test.ts`](../tests/json-rpc-timing.test.ts) |
| Turn、Review 和 Goal 如何隔离官方协议 | [`turn-port.ts`](../src/application/turn-port.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Thread/Turn/Item 如何适配并归约 | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`input-events.ts`](../src/conversation-core/input-events.ts)、[`core.ts`](../src/conversation-core/core.ts) | [`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core-lifecycle.test.ts`](../tests/conversation-core-lifecycle.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 多 Provider Thread 如何选择 App Server | [`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts)、[`gateway-component-graph.ts`](../src/bootstrap/gateway-component-graph.ts)、[`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs) | [`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`model-provider-runtime-topology.test.ts`](../tests/model-provider-runtime-topology.test.ts)、[`gateway-startup-cleanup.test.ts`](../tests/gateway-startup-cleanup.test.ts) |
| Unix Socket 布局如何验证 | [`app-server-unix-socket.mjs`](../runtime/app-server-unix-socket.mjs) 统一验证官方链接、目录和目标属主/权限；[`unix-websocket-transport.ts`](../src/codex-client/unix-websocket-transport.ts) 与 [`app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs) 只连接验证后的物理路径，残留处理只保留原链接 | [`app-server-unix-socket.test.ts`](../tests/app-server-unix-socket.test.ts)、[`unix-websocket-transport.test.ts`](../tests/unix-websocket-transport.test.ts)、[`real-app-server-queue.test.ts`](../tests/real-app-server-queue.test.ts)、[`real-app-server-supervised-provider.test.ts`](../tests/real-app-server-supervised-provider.test.ts) |
| 官方 Thread 如何进入稳定业务边界 | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 将官方 Thread 映射为稳定快照；会话列表中的模型和思考等级仅使用 Gateway Router 已知设置 | [`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`conversation-service-session.test.ts`](../tests/conversation-service-session.test.ts) |
| Thread 路由通知如何隔离 | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) | [`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Workspace、Conversation、Thread 如何绑定 | [`session-routing/`](../src/session-routing/README.md) | [`session-router.test.ts`](../tests/session-router.test.ts)、[`module-boundaries.test.ts`](../tests/module-boundaries.test.ts) |
| 模型、思考等级和 Fast 如何隔离并同步 | [`model-port.ts`](../src/application/model-port.ts)、[`model-adapter.ts`](../src/codex-client/model-adapter.ts)、[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) | [`model-selection-service.test.ts`](../tests/model-selection-service.test.ts)、[`thread-state-sync.test.ts`](../tests/thread-state-sync.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 原生与第三方账户指标如何隔离和扩展 | [`account-port.ts`](../src/application/account-port.ts)、[`provider-account-service.ts`](../src/application/provider-account-service.ts)、[`account-adapter.ts`](../src/codex-client/account-adapter.ts)、[`deepseek-account-adapter.ts`](../src/bootstrap/deepseek-account-adapter.ts)、[`opencode-go-account-adapter.ts`](../src/bootstrap/opencode-go-account-adapter.ts) | [`provider-account-service.test.ts`](../tests/provider-account-service.test.ts)、[`deepseek-account-adapter.test.ts`](../tests/deepseek-account-adapter.test.ts)、[`opencode-go-account-adapter.test.ts`](../tests/opencode-go-account-adapter.test.ts)、[`conversation-metrics-format.test.ts`](../tests/conversation-metrics-format.test.ts)、[`conversation-core-usage.test.ts`](../tests/conversation-core-usage.test.ts) |
| 直接安装 Skill 查询与显式调用如何隔离 | [`skill-port.ts`](../src/application/skill-port.ts)、[`turn-port.ts`](../src/application/turn-port.ts)、[`skill-adapter.ts`](../src/codex-client/skill-adapter.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP 状态、OAuth 与资源读取如何隔离 | [`mcp-port.ts`](../src/application/mcp-port.ts)、[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`core.ts`](../src/conversation-core/core.ts)；运行状态只读取当前 Thread 已发布连接快照，不触发探测或重连 | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts)、[`conversation-core-global-events.test.ts`](../tests/conversation-core-global-events.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) 的失败与刷新重连合同 |
| 开发中 Plugin 查询与 mention 调用如何隔离 | [`plugin-port.ts`](../src/application/plugin-port.ts)、[`plugin-adapter.ts`](../src/codex-client/plugin-adapter.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Permission Profile 查询如何隔离 | [`permission-port.ts`](../src/application/permission-port.ts)、[`permission-adapter.ts`](../src/codex-client/permission-adapter.ts) | [`conversation-service.test.ts`](../tests/conversation-service.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`telegram-format.test.ts`](../tests/telegram-format.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| Server Request 如何适配并协调 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`approval/`](../src/approval/README.md)、各 Surface 的 `interactions.ts` | [`approval-coordinator.test.ts`](../tests/approval-coordinator.test.ts)、[`interaction-router.test.ts`](../tests/interaction-router.test.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`telegram-interactions.test.ts`](../tests/telegram-interactions.test.ts)、[`feishu-interactions.test.ts`](../tests/feishu-interactions.test.ts)、[`weixin-interactions.test.ts`](../tests/weixin-interactions.test.ts) |
| 各模块如何装配和管理生命周期 | [`bootstrap/`](../src/bootstrap/README.md) | [`gateway-startup-cleanup.test.ts`](../tests/gateway-startup-cleanup.test.ts) |
| Telegram 如何适配核心事件 | [`surfaces/telegram/`](../src/surfaces/telegram/README.md) | [`tests/README.md`](../tests/README.md) |
| 新通讯渠道如何按模块接入 | [`通讯渠道 Surface 接入指南`](surface-integration-guide.md)、[`surfaces/`](../src/surfaces/README.md) | [`module-boundaries.test.ts`](../tests/module-boundaries.test.ts)、[`surface-manager.test.ts`](../tests/surface-manager.test.ts) |
| 新第三方模型 Provider 如何接入 | [`第三方模型 Provider 接入指南`](provider-integration-guide.md)、[`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs)、[`gateway-component-graph.ts`](../src/bootstrap/gateway-component-graph.ts) | [`model-provider-custom-runtime.test.ts`](../tests/model-provider-custom-runtime.test.ts)、[`codexc-cli.test.ts`](../tests/codexc-cli.test.ts)、[`deepseek-setup.test.ts`](../tests/deepseek-setup.test.ts)、[`opencode-go-setup.test.ts`](../tests/opencode-go-setup.test.ts) |
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
   `rust-v0.156.1` 固定版本实现和测试；本地副本缺失或基线不符时才使用上面的固定版本链接。
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

Config 文案说明：协议索引中的“Codex 用户设置”“一键配置全部”为历史称谓。当前入口统一使用“Codex 新会话与用户偏好”和“配置核心默认值”；计划清单工具通过 Config 单独控制且默认关闭，TUI 空闲总结通过 Config 单独控制且默认写入关闭，Fast 仅对 OpenAI 官方主配置开放，核心默认值操作不会隐式修改联网搜索、分析、反馈或 Goals。
