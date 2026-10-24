# Codex 官方文档与源码索引
本页用于定位 Codex App Server 的官方说明、`0.164.0` 固定版本源码，以及本项目对应实现。
它是查询入口，不替代生成协议类型，也不声明本项目支持官方协议的全部能力。

`0.164.0` 固定源码、随仓文档和生成协议已同步；位置和固定提交见
[上游来源](upstream-sources.md)，取舍与验收限制见[升级决策](codex-cli-upgrade-decisions.md)。
生成的新类型不自动扩大下述支持范围。
本轮未替换全局 CLI 或部署运行服务；旧版人工观察保留原版本与环境限制，不作为新版实测。
Workspace 与上游 Project 的职责、共享范围及重新评估条件见
[Workspace 决策](codex-cli-upgrade-decisions.md#workspace-与上游-project-的职责)；当前不接入 Project CRUD。
## 受控协议边界
修改实验能力、动态工具、图片引用或 Plugin 接入时读取本节；以下约束不因资料移位而放宽。

- 稳定业务代码不得依赖未经批准的实验生成字段。当前锁定 `codex-cli 0.164.0` 只允许六类
  受控协议例外。官方 Plan 模式只允许使用
  `collaborationMode/list` 和 `turn/start.collaborationMode`；Luna Reserve 自动回退为原样保留当前
  Default/Plan 模式，还允许 `thread/settings/update.collaborationMode`。这些字段必须通过
  `--experimental` 生成类型并从 `codex-protocol` 受控导出。原生 Thread Queue 只允许使用
  `thread/queue/add|list|update|delete|reorder|start` 与 `thread/queue/changed`，必须通过
  `--experimental` 生成类型并从 `codex-protocol` 受控导出；列表可进行有界只读重试，写入不得盲目重试。Thread Revert 只允许使用
  `thread/turns/list`、`thread/revert` 与 `thread/reverted`，同样必须通过
  `--experimental` 生成类型并从 `codex-protocol` 受控导出；
  分页历史也用于完成卡累计当前 Thread 的官方 `Turn.durationMs`，只允许有界只读重试，Revert 写请求不得重试，且不得接入 `thread/items/list`。
  前台计划任务动态工具只允许使用 `thread/start.dynamicTools` 注册顶层 `schedule_task`，
  并处理对应 `item/tool/call`；必须通过 `--experimental` 生成类型、从 `codex-protocol`
  受控导出。调用必须关联已绑定的前台 Thread
  与唯一授权 Actor，并在首次异步检查前保留原 Request/Turn/调用身份；Turn 或对应工具终态、
  请求解决、Thread 失效、断线和关闭撤销未完成操作，写入及派发前复核，已提交操作不自动回滚。
  创建和删除仍须用户确认；后台计划任务 Thread 不注册工具并拒绝递归调用。
  不向已有 Thread 注入工具，不接入 `additionalContext`、任意动态工具或其他命名空间。
  图片引用上传只允许额外读取 `account/read.workspaceRouting`，用于核对当前 ChatGPT 账户、
  后端与路由约束；通过官方 `getAuthStatus` 获取当前可导出的令牌，不读取磁盘凭据。
  该字段必须使用受控生成类型，不得用于其他账户或路由功能。
  Auto-review 只允许额外读取实验 `configRequirements/read.allowedApprovalsReviewers`，
  结合稳定 `featureRequirements` 检查全局开关的受管限制；通过 `ConfigRequirementsReadResponse`
  受控导出。设置入口仅用于只读策略判断，不采用
  `config/read` 的合并审批字段。另允许消费 `item/autoApprovalReview/started|completed`
  的最小身份、状态及决策来源投影，用于本轮任务及当前会话递归统计 agent 来源的各结果次数和采集覆盖，
  以及按已授权 Thread 绑定向三个渠道仅展示 agent 来源的 approved、denied、timedOut、aborted 完成结果；
  完成通知额外允许投影七种官方 action 的固定类别、文件数量、网络协议白名单及合法端口，
  以及经现有凭据脱敏、控制字符清理并各按 320 字符截断的 operation、cwd、rationale，以及 durationMs；
  Client 保留这些字段中的 ASCII 标点，execve 参数先逐参数脱敏再格式化为 operation；摘要按 action 类别取 command、execve 的 program 与 argv、文件列表、network host、MCP server/tool
  或权限申请 reason，不展示 stdin 正文或完整 network target URL；不采集 riskLevel 与 userAuthorization。
  未知或畸形摘要字段在 Client 边界省略。
  子代理通知仅沿已确认的精确父子 Turn 关系路由，不从工作区、最近会话或联系消息推断归属。
  方法没有实验标记，但其 payload 在锁定版标记 UNSTABLE，两个通知类型必须受控导出。
  不传播未经处理的上游文本；摘要仅含经凭据脱敏、控制字符清理及限长的纯文本，Surface 在平台呈现边界处理 Markdown 等富文本转义，
  不展示 stdin 正文或完整 network target URL。指标与 StateStore 不增加审查正文，现有加密投递箱只暂存安全摘要，
  details 可选且不改变结构版本。
  不消费 `autoApprovalReview/strictReviewRequired`，不扩大协商。
  Plugin 仅使用稳定 `plugin/installed` 查询目标 Provider 在当前 Workspace 的已安装项（搜索仅在该目录内本地过滤），
  并通过 `turn/start` / `turn/steer` 的官方 `mention` 输入在官方或第三方 Thread 中调用；解析与最终提交的 Provider 必须一致。
  不接入市场搜索、安装、卸载或分享；这项本地支持不表示全部上游 Plugin API 已稳定，
  也不得借这些例外或 Plugin 入口接入、暴露其他实验方法、字段或通知。

  隔离只读观察中，DS 官方 Flash 经 Responses 与 Chat 均接受已安装 GitHub 插件的 `mention`；共享渠道
  命令入口经目标 DS 实例完成列表、两次解析和 `turn/start`，收到真实答复。该缓存插件在隔离环境中没有
  可用 App、MCP 或 Skill，模型明确报告不可用，不能据此声明插件连接器已可用。实际平台消息投递未观测。
  人工异常观察覆盖不存在的插件、未授权 Actor、查询期间 Provider 变化、未知 Provider 拒绝及调用准备
  期间 Provider 变化后提交数为 0；上游插件认证、套餐和可用性限制继续生效。

## 版本与数字

当前索引对应 [`src/codex-protocol/version.json`](../src/codex-protocol/version.json) 锁定的
`codex-cli 0.164.0`。生成时启用实验类型；业务采用范围及 Plugin 入口以
[受控协议边界](#受控协议边界)为准，其他生成类型不表示已支持。

| 数量 | 是什么 | 事实来源 |
| ---: | --- | --- |
| 904 | 当前 CLI 生成的 TypeScript 文件总数 | `src/codex-protocol/generated/` |
| 101 | 生成目录根层的公共、兼容和初始化类型 | `src/codex-protocol/generated/*.ts` |
| 802 | v2 请求、响应、通知和数据类型 | `src/codex-protocol/generated/v2/*.ts` |
| 1 | `serde_json` 辅助类型 | `src/codex-protocol/generated/serde_json/` |
| 178 | 客户端发给 App Server 的 Request 方法 | [`ClientRequest.ts`](../src/codex-protocol/generated/ClientRequest.ts) |
| 87 | App Server 发给客户端的 Notification 方法 | [`ServerNotification.ts`](../src/codex-protocol/generated/ServerNotification.ts) |
| 11 | App Server 发给客户端、需要回应的 Request 方法 | [`ServerRequest.ts`](../src/codex-protocol/generated/ServerRequest.ts) |
| 1 | 客户端发给 App Server 的 Notification，即 `initialized` | [`ClientNotification.ts`](../src/codex-protocol/generated/ClientNotification.ts) |
| 82 | Codex Client 适配边界使用的受控协议类型导出 | [`src/codex-protocol/index.ts`](../src/codex-protocol/index.ts) |
| 48 | 本项目直接调用的业务 Request 方法，不含连接层的 `initialize` | [`client.ts`](../src/codex-client/client.ts) |
| 5 | 本项目显式协调的 Server Request 类型 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`bootstrap/scheduled-task-tool-request.ts`](../src/bootstrap/scheduled-task-tool-request.ts) |
| 18 | 本项目 TypeScript Gateway 的一级业务模块 | [`src/README.md`](../src/README.md) |

这里的数量描述协议结构，不等于本项目已实现的功能数。只有 `codex-client` 可以使用
`src/codex-protocol/index.ts` 的受控导出；生成目录可能包含尚未采用、实验中或仅供其他客户端
使用的类型，其他业务模块不得导入。


DeepSeek 运行实例采用 `ds-<账户>` 与 `sf-ds-<账户>`，各账户拥有独立的官方 DS 目录和统计代理。
只支持显式账户 ID 的当前多账户结构，Thread 与新指标按账户归属，不提供旧单账户迁移或移除入口。
实现见 [`deepseek-account-management.mjs`](../scripts/deepseek-account-management.mjs)。

## 官方文档

当前基线为 0.164.0；跨版本取舍见[升级决策](codex-cli-upgrade-decisions.md)。相对 0.163.0
新增三个 Request：稳定 `feedback/save`、实验 `thread/sample` 与 `thread/sample/cancel`，均不接入 Gateway。
Server Request、Server Notification 和 Client Notification 的方法名称未变；公开 CLI 参数合同仅版本变化。
新增 `sci` / `sci_plus` 套餐和模型请求前后 Hook 事件已同步到现有查询、通知与展示边界；
Plugin Hook 信任沿用上游内容指纹，升级运行前的数据备份与回退边界见[升级决策](codex-cli-upgrade-decisions.md#上游数据处理与回退约束)。
图片生成继续优先消费 `savedPath`；`fileId` 仅在所属 Thread/Item 的内存事件中保留，
只有引用且已完成时展示内容不可获取状态，不下载、回传模型或持久化引用；
`toolListMeta` 只在 MCP 详情查询中以本地只读 JSON 类型内部透传，保留对应工具目录第一页的元数据及 null/空值，不展示、记录正文、持久化、注入模型或改变权限；概览不携带。
Desktop 存储要求、Responses 客户端元数据、语音会话 ID 与预测 MCP 均不消费。
官方与第三方模型的提示词查询通过 [`model-catalog-presentation.mjs`](../runtime/model-catalog-presentation.mjs)
只读展示 `model_messages.permissions.approved_prefixes`；缺省或 null 使用上游内置文本，显式空字符串表示抑制该段，不改写模型模板或授予权限。
`thread/readState/update`、`thread/items/read`、`thread/readState/changed` 与相关响应字段不接入业务；
Client 继续只投影已支持的 Thread 数据，新的已读状态通知不映射为渠道送达或已读事件。
此前采用的 `partial_answer`、Goal 用户来源及子代理启动模型快照继续保留；
预测、附件反查与 Bedrock GovCloud 能力不扩展渠道入口。
以下同时记录此前已采用并继续保留的能力。
采用稳定的 `thread/resume.collaborationMode` 恢复实际模式，并移除已停用的人格设置；
Gateway 为 OpenAI ChatGPT 图片上传原图并提交官方 fileId，历史和后续引用由 App Server 管理；
受管 DeepSeek 账户通过本地代理调用官方 Files API 并提交 `fileId`，失败不回退内联图片；
OpenAI API Key、自定义第三方、CLP 等其他 Provider 和独立自定义 OpenAI 后端保留内联图片输入。通过 `config/read`
定位运行中的模型代理并核对后端；OpenAI 路径仅在默认 ChatGPT 后端一致且策略为 `NO_CONSTRAINT` 时转换，`us`、`us_cr` 或后端不一致拒绝上传。
上传原图跳过官方本地缩放，见图片决策中的限制。
OpenAI 路径通过稳定 `getAuthStatus` 和受控 `account/read.workspaceRouting` 读取同一 App Server 的认证与路由，
不读取磁盘凭据；实现见 [`image-reference-upload.ts`](../src/codex-client/image-reference-upload.ts)。
OpenAI 字节 PUT 参照锁定版本 `codex-api/src/files.rs` 与 `files_retry_tests.rs`，共享 5 分钟预算、最多 5 次尝试及退避，完成确认最多 30 秒；创建文件及 Turn 提交不随字节重试重放。
DeepSeek 不自动重试：本地代理整次上传最多 30 秒，上游 Files POST 自身上限为 60 秒，
客户端传输阶段上限为 5 分钟，受最先到达的期限约束；客户端材料及路由准备阶段最多 60 秒，多张图片依次处理且可取消。
DeepSeek 的能力只经受保护的 Supervisor v5 IPC `imageUploadRoute`（独立 `imageUploadProtocolVersion=1`）取得，
以精确 Provider、运行实例、代理地址及代次绑定随机 Bearer；HTTP 描述和上传均校验该能力，配置修订不是授权。
磁盘材料需匹配运行实例已应用的设置快照，实例释放或重启撤销旧能力；旧服务不支持时失败关闭并提示重启 App Server 与 Gateway。
这属于本地运行时合同，不新增 App Server RPC。详细安全边界及未观察范围见 [DeepSeek 图片识别](deepseek.md#图片识别)，阶段限时与脱敏错误说明见用户指南及展示文档。
此前在线探测支持当前账户编号识图；2026-09-23 的飞书实机验收进一步确认，自动链路首次请求向
OpenAI 模型提交 `input_image.file_id` 且没有 Base64，后续纯文本请求通过 `previous_response_id`
接续且没有重复图片。该结论限定当前账户、`NO_CONSTRAINT` 路由和当次模型，其他渠道、账户、路由
与模型仍按各自验收状态记录。
原生文件引用需求及阻塞、Apps 工具上传与普通图片输入的区别见[图片决策](codex-cli-upgrade-decisions.md#图片文件引用需求阻塞与实现边界)。
`disabledPluginIds`、MCP App UI、设备验证扩展
不增加 Gateway 写入或交互入口。新增 `rollout/compress` 与删除 `thread/rollback` 均不影响当前业务调用。
既有图片接入使用一个认证响应导出和一个请求方法，审批种类没有增加；具体取舍见[升级决策记录](codex-cli-upgrade-decisions.md#图片文件引用需求阻塞与实现边界)。
本地构建或 Registry 包的 `codexc update` 由 [`source-update.mjs`](../scripts/source-update.mjs)
按已安装包的精确 CLI 基线完成临时候选公开合同校验、确认安装与服务恢复。默认 CLI 缺失也进入确认安装流程，显式 `CODEX_BINARY` 无效时拒绝。首次本地源码安装由 [`install-global-source.mjs`](../scripts/install-global-source.mjs) 在注册 Gateway 前检查 CLI，缺失或版本不匹配时按终端确认流程安装协议锁定版本，不依赖渠道初始化。

安装阶段的系统沙盒依赖由 [`sandbox-dependencies.mjs`](../scripts/sandbox-dependencies.mjs) 统一检查：macOS 固定系统入口依据 [`seatbelt.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/sandboxing/src/seatbelt.rs)，Linux 系统 `bwrap` 能力与内置回退依据 [`launcher.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/linux-sandbox/src/launcher.rs)。只处理 OS 依赖，不增加 App Server RPC 或权限配置能力。

1. [Codex App Server](https://learn.chatgpt.com/docs/app-server)：协议定位、Transport、
   JSON-RPC 消息、初始化、Thread/Turn/Item、审批、通知和 Schema 生成的主文档。
2. [Codex 开源组件](https://learn.chatgpt.com/docs/open-source)：官方开源范围和仓库入口。
3. [Codex 高级配置](https://developers.openai.com/codex/config-advanced#profiles)：独立
   `profile-name.config.toml` 的加载顺序、命名与 `--profile` 用法。
4. [OpenAI Codex 仓库](https://github.com/openai/codex)：当前官方源码；排查本项目锁定协议时，
   优先读取 [`upstream/openai-codex-0.164.0`](upstream-sources.md) 的固定本地副本；本地副本缺失时
   再打开下面固定到 `rust-v0.164.0` 的链接，不能直接以 `main` 为准。

官方文档定义产品和协议行为；本项目实际字段必须以当前锁定 CLI 生成的 TypeScript 类型为准。
如果两者看起来不一致，先检查文档是否描述了更新版本，再审查固定版本源码和生成差异。

## 固定版本官方源码

以下链接固定到 OpenAI Codex `rust-v0.164.0`：

| 查询目标 | 官方源码 | 主要内容 |
| --- | --- | --- |
| App Server 程序入口 | [`app-server/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/lib.rs) | App Server 模块、启动参数与 Transport 装配入口 |
| 原生 daemon 生命周期与包管理 | [`app-server-daemon/README.md`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-daemon/README.md)、[`src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-daemon/src/lib.rs) | 生命周期替代研究，当前暂缓接入；配置、代理、固定版本与隔离实测见[专项审查](archive/codex-daemon-review.md)，不增加 RPC 支持范围 |
| 原生 daemon 恢复合同 | [`daemon_update_recovery.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/daemon_update_recovery.rs) | 官方后台加载与中断续做合同；不能将恢复等同于历史读取，也不能代替 Gateway 归属和审批验收 |
| JSON-RPC 消息总表 | [`rpc.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/rpc.rs) | Client Request、Server Notification、Server Request |
| 协议公共类型 | [`common.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/common.rs) | 初始化、ID、通用协议结构 |
| v2 协议入口 | [`v2/mod.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/mod.rs) | v2 模块与受支持类型汇总 |
| Thread | [`thread.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) | Thread 请求、响应和生命周期 |
| Turn | [`turn.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs) | Turn 启动、追加、停止和状态 |
| 用户输入 | [`user_input.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/protocol/src/user_input.rs) | 文本、图片、一次性音频、Skill 与 Mention 输入 |
| Item | [`item.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs) | 消息、命令、文件、工具等 Item |
| 图片文件引用存储与默认装配 | [`attachment-store/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/attachment-store/src/lib.rs)、[`lib_tests.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/attachment-store/src/lib_tests.rs)、[`message_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/message_processor.rs)、[`mcp_refresh.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/mcp_refresh.rs) | 默认使用内联存储，文件编号解析返回 NotFound；已有引用仍可直传模型端，内部抽象不等于公开上传/解析 RPC |
| 普通图片准备与原生 TUI 输入 | [`image_preparation.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/image_preparation.rs)、[`image_submission.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/chatwidget/image_submission.rs) | 本地图片快照转内联输入；Core 图片处理调用注入的存储实现 |
| Apps 工具文件上传 | [`mcp_openai_file.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/mcp_openai_file.rs)、[`files.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/files.rs) | ChatGPT 认证下为工具参数上传；当前账户上传、即时下载与模型后端接受编号已探测，较大图片识图对照通过，独立按编号取回与地址刷新仍未验收 |
| 本地 Rollout 文件压缩 | [`rollout.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/rollout.rs)、[`RolloutCompressResponse.ts`](../src/codex-protocol/generated/v2/RolloutCompressResponse.ts) | 实验后台维护触发，仅适用于本地存储；不是 Thread 上下文压缩，也不返回完成状态；本项目未接入 |
| 模型访问计划与账户路由元数据 | [`model.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/model.rs)、[`account.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/account.rs)、[`workspace_routing.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs) | 目录展示与实验显式选择、账户后端路由分别审查；字段存在不授予权益；账户路由仅供图片上传核验，不开放选择器 |
| 图片生成 Item 与产物 | [`image_generation.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/ext/items/src/image_generation.rs)、[`artifact.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/ext/image-generation/src/artifact.rs) | `ImageGenerationItem.savedPath` 与生成图片落盘目录 |
| 官方模型 API 端点 | [`search.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/search.rs)、[`images.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/images.rs)、[`memories.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/memories.rs)、[`realtime_call.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/realtime_call.rs)、[`realtime_websocket/methods.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs) | OpenAI 搜索、图片、记忆摘要、Realtime HTTP 与 WebSocket 的固定请求后缀；Provider Proxy 只按该版本显式放行，不接受任意 OpenAI API 路径 |
| 权限协议 | [`permissions.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs) | 临时权限、命令网络上下文与持久规则结构 |
| MCP 协议 | [`mcp.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/mcp.rs) | MCP 状态、工具发现错误与 form、openai/form、URL、用户验证 elicitation |
| 用户验证协议 | [`user_verification.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/user_verification.rs) | 用户验证状态、登记、删除、校验 RPC 与失败类型；本项目未采用 |
| Thread 关联记录 | [`thread_attachment.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/thread_attachment.rs) | 独立持久化的类型、身份键和 JSON 内容，不等同于文件上传；本项目未采用 |
| TUI 推理摘要默认值 | [`app_server_session.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/app_server_session.rs) | 新本地 TUI 会话未配置摘要时使用 `none`，保留显式值；Setup 的未配置预选与其一致 |
| 压缩失败输入保留 | [`turn.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/session/turn.rs)、[`compact_remote.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/tests/suite/compact_remote.rs) | 开始 Turn 前压缩失败仍保留已接受输入；Gateway 不增加消息副本或自动重发 |
| Goal 空续跑阻塞 | [`thread_goal_empty_responses.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/thread_goal_empty_responses.rs) | 连续三次没有有效活动的空自动续跑进入 `blocked`，沿用现有 Goal 状态映射 |
| Plugin 协议 | [`plugin.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs) | Plugin 已安装、目录与安装类型；本项目只采用已安装响应，不据此声明其他 Plugin API 稳定或受支持 |
| 通知 | [`notification.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/notification.rs) | v2 Notification 参数 |
| Transport | [`transport.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/transport.rs) | stdio、WebSocket 和连接收发 |
| Unix Socket 受保护布局 | [`unix_socket.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-transport/src/transport/unix_socket.rs)、[`daemon_directory.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/uds/src/daemon_directory.rs) | 广告路径为确定性 SHA-256 链接，真实 Socket 位于固定的当前用户私有目录，独立于 HOME/TMPDIR |
| 远程 App Server 客户端 | [`remote.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-client/src/remote.rs) | TCP WebSocket 与 Unix Socket 连接、每连接初始化、128 MiB 消息上限和回环认证边界 |
| App Server daemon | [`app-server-daemon/README.md`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-daemon/README.md) | 实验性共享 daemon 的平台、生命周期、环境继承与状态目录；本项目不采用其生命周期 |
| Windows App Server Proxy | [`cli/src/main.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/cli/src/main.rs)、[`stdio-to-uds/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/stdio-to-uds/src/lib.rs) | `app-server proxy --sock` 的 CLI 入口与裸字节 stdio/UDS 中继；本项目 Windows Transport 在其上建立 WebSocket，macOS Desktop JSONL stdio 不直接复用该入口 |
| 初始化处理 | [`initialize_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/initialize_processor.rs) | `initialize` 握手与能力协商 |
| Server Diagnostics 处理 | [`diagnostics.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/diagnostics.rs) | 实验、无内容的进程与运行时快照；本项目未采用 |
| Thread 请求处理 | [`thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/thread_processor.rs) | Thread 请求的运行时实现 |
| Thread 协作模式恢复 | [`thread_resume.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/thread_resume.rs) | 恢复响应的实际协作模式、持久设置与旧历史冻结上下文恢复合同 |
| 人格设置停用 | [`config_toml.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/config_toml.rs) | `personality` 已弃用，CLI/WebUI 停止提供选择和写入 |
| Thread 分页历史与 Revert | [`thread_revert.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/thread_revert.rs) | `thread/turns/list`、`thread/revert`、`thread/reverted`，分页历史、活动 Turn 中断与状态恢复 |
| Thread 队列处理 | [`thread_queue_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/thread_queue_processor.rs) | 实验 `thread/queue/*` 的持久提交队列；本项目已采用六请求和 `thread/queue/changed`，通过 Client/Application 窄端口接入 |
| Thread 分区处理 | [`thread_sections.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/thread_sections.rs) | 官方内置 Pinned 分区与生命周期约束；Gateway 仅用于 `/pin`、`/unpin`，不暴露自定义分区管理 |
| Thread 订阅生命周期 | [`thread_lifecycle.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/thread_lifecycle.rs) | 订阅、空闲卸载与 `thread/closed` |
| Turn 请求处理 | [`turn_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/turn_processor.rs) | Turn 启动、追加、停止和状态 |
| 配置请求处理 | [`config_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/config_processor.rs) | `config/read`、批量写入与用户配置热加载 |
| 模型目录测试 | [`model_list.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/model_list.rs) | 可见模型、分页和远端目录合同 |
| DeepSeek Codex 接入 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/quick_start/agent_integrations/codex) | Responses Provider、配置字段、官方脚本和当前支持模型 |
| DeepSeek Responses 指南 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/guides/responses_api) | 无状态会话、流式事件、原生图片输入、工具兼容性、缓存及用量字段 |
| DeepSeek 图像理解 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/guides/vision) | 视觉模型、图片输入格式、Token 计量与限制 |
| DeepSeek Chat 接口 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/) | Relay 原生 Chat 的消息、思考控制、JSON/SSE |
| DeepSeek 创建响应接口 | [DeepSeek 官方文档](https://api-docs.deepseek.com/zh-cn/api/create-response) | `POST /responses` 请求字段、响应结构与 SSE 终止事件 |
| DeepSeek 账户余额 | [DeepSeek 官方余额接口](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/) | `GET /user/balance` 的可用状态、币种与余额字段；不提供 Codex 周限或历史 Token 汇总 |
| OpenCode Go | [OpenCode Go 官方文档](https://opencode.ai/docs/go/) | Provider 基础地址、模型端点与账户用量接口 |
| 账户请求处理 | [`account_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/account_processor.rs) | 账户 Token 用量与额度读取 |
| 账户测试 | [`account.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/account.rs) | 用量读取、认证与错误合同 |
| Thread 用量测试 | [`account_thread_usage.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/account_thread_usage.rs) | `account/usage/read.threadId` 与估算用量合同；本项目按当前精确 Thread 采用，不递归合计子代理 |
| 重置券消费合同 | [`rate_limit_resets.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/account_processor/rate_limit_resets.rs)、[`rate_limit_reset_credits.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/rate_limit_reset_credits.rs) | ChatGPT 认证、显式选券、幂等消费与四类结果 |
| 额度测试 | [`rate_limits.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/rate_limits.rs) | 单桶、多桶、消费控制与重置券合同 |
| Luna Reserve | [`luna_reserve.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/luna_reserve.rs)、[`backend_banner_fallback.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/app/backend_banner_fallback.rs)、[`luna_reserve_recovery_tests.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/app/tests/luna_reserve_recovery_tests.rs) | `supportsLunaReserve` / 轻量额度读取、隐藏 `gpt-reserve`、Thread 设置切换与同账户恢复合同 |
| Skill 列表测试 | [`skills_list.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/skills_list.rs) | CWD、Scope、缓存、Plugin Skill 与变更通知合同 |
| MCP 请求处理 | [`mcp_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/mcp_processor.rs) | Thread 配置上下文、精简清单、排序与分页 |
| Plugin 请求处理 | [`plugins.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/plugins.rs) | 已安装 Plugin 的 Workspace 发现、启用与可用状态 |
| MCP 工具审批 | [`mcp_tool_call.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/mcp_tool_call.rs) | 工具审批 elicitation 元数据、会话与持久授权响应 |
| MCP 状态测试 | [`mcp_server_status.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/mcp_server_status.rs) | 工具原名、工具发现失败、项目级配置、实时元数据、当前 Thread 连接状态、断线失败与精简清单合同 |
| MCP 资源测试 | [`mcp_resource.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/mcp_resource.rs) | Thread 可选上下文、文本/二进制资源读取与错误合同 |
| MCP 配置刷新测试 | [`executor_mcp.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/executor_mcp.rs) | 从磁盘重载配置并刷新已加载 Thread 的 MCP 运行时；请求成功不等于远端握手已经完成 |
| MCP 启动恢复 | [`mcp_refresh.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/mcp_refresh.rs)、[`connection_manager.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-mcp/src/connection_manager.rs)、[`rmcp_client.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-mcp/src/rmcp_client.rs)、[`connection_manager_tests.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/codex-mcp/src/connection_manager_tests.rs) | 普通刷新复用配置相同的健康连接、重建失败连接；`codex_apps` 工具发现可触发带退避的原生启动重连 |
| Plugin 列表测试 | [`plugin_list.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/plugin_list.rs) | Marketplace、已安装项、启用状态与 CWD 发现合同 |
| Catalog 请求处理 | [`catalog_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/catalog_processor.rs) | Permission Profile 的 CWD 配置归并、allowed 状态和分页 |
| Permission Profile 测试 | [`permission_profile_list.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/permission_profile_list.rs) | 内置、自定义、项目级 Profile 与分页合同 |
| 用户输入测试 | [`request_user_input.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/request_user_input.rs) | 问题、自动解决时限、响应与跨客户端失效合同 |
| MCP elicitation 与用户验证测试 | [`mcp_server_elicitation.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/mcp_server_elicitation.rs)、[`user_verification.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/user_verification.rs) | 常规 elicitation、用户验证能力协商、请求归属与响应合同；本项目不声明用户验证扩展并显式取消对应请求 |
| Thread 设置测试 | [`thread_settings_update.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/thread_settings_update.rs) | 模型、思考等级和服务层级通知合同 |
| Thread 分区测试 | [`thread_sections.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/thread_sections.rs)、[`thread_metadata_update.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/thread_metadata_update.rs) | 内置 Pinned 分区、移动、列表状态、迁移与分页保持合同；Gateway 只覆盖固定/取消固定路径 |
| Thread 队列与回退测试 | [`thread_queue.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/thread_queue.rs)、[`thread_revert.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/thread_revert.rs) | Queue 六请求、容量、分页、并发排序和通知，以及分页历史 Revert 的受控适配 |
| Server Diagnostics 测试 | [`server_diagnostics.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/server_diagnostics.rs) | 实验进程与运行时诊断快照；本项目未采用 |
| 上下文压缩测试 | [`compaction.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/compaction.rs) | 手动与自动压缩、`contextCompaction` Item 开始和完成通知合同 |
| Unix WebSocket 测试 | [`connection_handling_websocket_unix.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/connection_handling_websocket_unix.rs) | Unix Socket WebSocket 行为 |

## 当前支持矩阵

异步问题消费固定版 `item/completed` 的 `agentMessage.delivery = "async"` 与 `questions`，
回答复用 `turn/steer` / `turn/start`，不新增 Server Request 或实验 RPC。官方依据为固定版本
[`request_user_input_async.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/handlers/request_user_input_async.rs)、
[`spec_plan.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/spec_plan.rs) 和
[`questions.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/chatwidget/questions.rs)。
工具由 App Server 的有效模型目录决定是否开放。第三方固定、切换实例在启动时为各模型追加
固定底座 `experimental_supported_tools` 中的 `send_user_message_async` 声明，实际工具名仍为
`request_user_input_async`，覆盖 Responses 和 Chat Completions；复用上游本地工具，
不通过动态工具注入，不改源模型目录或官方 OpenAI 目录，不重放历史问题、不推断其他客户端已经回答。
运行目录由 [`third-party-model-catalog.mjs`](../runtime/third-party-model-catalog.mjs) 生成，
显式关闭用户输入工具的 Codex 配置及上游主代理限制仍然有效；开放不保证模型主动调用。
Codex 0.163.0 的隔离人工验证中，DS 官方 Flash 经 Responses 与项目 Chat 桥均实际产生异步问题、
继续执行并接收原 Thread 的回答；Responses 还观察到运行中 `turn/steer` 回答与过期追加拒绝。
其他第三方模型、实际渠道卡片交互及跨平台服务启动尚未逐项实测。
同一第三方运行目录与模板投影还从固定底座受控补齐 `clock`，供上游注册 `clock.curr_time` 与可中断的 `clock.sleep`，
保留上游 Feature 与配置条件。固定版官方依据为
[`spec_plan.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/spec_plan.rs)、
[`sleep.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/handlers/sleep.rs)。
DS Flash 的 Responses／Chat 实际返回当前 UTC 时间，2 秒等待耗时分别为 2.0011／2.0008 秒；
20 秒等待在新输入到达后分别于 1.0021／1.0030 秒结束，工具明确返回被新输入打断。
Responses 的 0 毫秒等待被明确拒绝。`sleep` Item 沿用现有过程事件映射，不新增 RPC 或调度器。
模板投影保留 DS 主提示词正文和显式空值，仅保留来源身份中性化、缺失辅助提示词补全及独立审批中文要求，
不额外追加中文时钟指导，不修改源 JSON 快照。CLP 在定义编译后补齐上述两项声明；CP v5 通过可选定义字段
`experimentalSupportedTools` 保存并编译为 `experimental_supported_tools`，旧定义未声明时维持原编译字节，工具字段仍为 `[]`，不自动迁移。
新建自定义模型及草稿从固定底座补齐两项；已有模型显式模板更新时，DS／CLP／CCG／OCG 选择“能力参数”、CP 选择“本地工具”
才合并来源的这两项声明，接口范围均为 `capabilities`，保留其他本地工具声明与 CP 手动模型能力。
仅选择提示词或运行设置不更新工具；移除旧中文时钟尾段须明确选择提示词，未选范围不改。保存仍使用版本守卫、pending／backup 与回读，
旧程序不能读取新增定义字段，回退前须先恢复更新前备份。运行副本仍补齐两项并遵守上游 Feature、配置和角色限制。
`tool_mode`、`node_repl_auto_review_required`、`web_search_tool_type` 分别涉及执行架构、Guardian 审核策略及托管搜索格式，
不作为两项本地工具的前提自动继承。详见[账户模板更新](provider-integration-guide.md#对比并更新账户模型模板)。
组合根在同一入站通知处理链路调用异步问题协调器的 `handleInput`，统一登记问题和处理失效，
不通过输出队列延迟登记；断线前连接代次的迟到通知不能重新打开问题，取消事件仍被消费。
Core 只抑制重复正文及最终答复标记。回答提交失败独立于问题取消状态报告。

Default 执行模式的等待提问只作隔离能力探测，不属于 Gateway 自动启用范围：固定版
[`request_user_input.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/handlers/request_user_input.rs)
等待用户回答，但该模式的 `isBlocking` 为 `false`；
[`features/src/lib.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/features/src/lib.rs)
将 `default_mode_request_user_input` 标记为开发中且默认关闭。
Client 验证并保留 `isBlocking`，Approval 呈现阻塞或可跳过问题；渠道有效期使用现有配置，
不再由已弃用的 `autoResolutionMs` 控制。`InteractionRouter` 从接收请求开始统一约束排队、渠道准备和答复期限，
超时沿现有交互取消路径返回安全决定。

渠道投递存量通过组合根 [`output-execution-admission.ts`](../src/bootstrap/output-execution-admission.ts)
在现有 Turn、Review、Goal 与 Queue 输入/启动端口前实施本地准入；不改变 RPC 字段或 App Server 原生 Queue 持久语义。
计划任务在调度容量检查及创建 Thread 前复核同一准入，临时超载不永久阻塞周期任务。
停止、只读查询及 Queue 删除保留可用；容量、确认及离线恢复见[投递箱](delivery.md)。
原生 TUI 的非阻塞自动跳过及输入暂停机制见
[`request_user_input/mod.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/bottom_pane/request_user_input/mod.rs)，
与渠道的差异见[等待式问题](display.md#等待式问题)。

Computer Use／浏览器过程展示复用已支持的 `item/started`、`item/completed` 和
`ThreadItem.mcpToolCall.arguments`：[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts)
只对 `cua_repl.js` / `js_reset` 标记操作类别，并提取 `js` 的 `title`；飞书
[`outbox.ts`](../src/surfaces/feishu/outbox.ts) 为同一操作创建并原地更新开始／终态卡片，不等待查询汇总。
此展示不代表操作权限或浏览器连接已可用，未接入
`item/mcpToolCall/progress`，也不解析执行代码、原始结果或截图。
飞书 MCP 工具审批复用已支持的 `mcpServer/elicitation/request`，分别映射允许一次、
会话／持久允许、拒绝与取消，不新增系统或网站权限管理接口。
共同 Client 按锁定上游 `tool_params` 与 `tool_params_display` 核对完整参数，缺失或矛盾时拒绝；
Approval 保留原名、标签、值和授权范围的 JSON 转义表示；命令预览保留上游工作目录，未提供则明确提示未知，不推定 Workspace。工具审批完整预览及命令详情分别受
3000 UTF-8 字节共同预算约束，超限不提供批准；飞书展开内容和工具审批不再截断。
实际渠道审批往返尚未观察，不将本地类型或渲染检查视为平台验收。

本表列出项目当前主动调用或消费的协议能力。未列出的生成类型不能直接视为已支持能力。
`codexc setup` 的脱敏总览复用既有 `config/read` 显示全局默认模型与思考等级，入口位于
[`setup-summary.mjs`](../scripts/setup-summary.mjs)；
用户设置入口位于 `codexc config → Codex 新会话与用户偏好`，在显式确认后复用下表已有的版本化配置事务，不修改登录状态。Auto-review 开关通过稳定只读 `configRequirements/read` 的受控实验字段 `allowedApprovalsReviewers` 和稳定 `featureRequirements` 检查受管审批人及功能限制。
网络代理菜单通过 [`codex-proxy-env.mjs`](../runtime/codex-proxy-env.mjs) 写入 Codex Home 的 `.env`，依据固定版本 [`arg0::load_dotenv`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/arg0/src/lib.rs) 的加载语义，不新增 RPC。
渠道选择 OpenAI 模型时，`model-selection-service.ts` 复用 `writeDefaultServiceTier("default")` / `config/batchWrite`
把用户级 `service_tier` 保存为 `default`，同时保留下一 Turn 的显式 Standard 覆盖；保存失败不切换会话。
第三方模型选择不修改 OpenAI 默认值。
渠道 `/fast ultrafast` 通过既有 `model/list.serviceTiers` 精确检查 `ultrafast`，使用
`turn/start.serviceTier` 传递下一 Turn 设置；主 Provider 默认值复用 `config/batchWrite` 写入
`service_tier = "ultrafast"`，独立 Provider 不改主配置。Fast、Ultrafast、Standard 分开展示；
目录未声明的档位拒绝新选择，无绑定偏好恢复时重新检查模型与思考等级，历史档位由上游过滤。验证应覆盖命令、配置写入失败、
Turn 参数、恢复及三渠道输出；不以字段为字符串推断任意档位均受支持。
渠道开启前通过 `readModelAccelerationSettings` 复用目标 Provider 与 Workspace 的 `config/read`，结合 `configRequirements/read.featureRequirements` 与 `supportsIndependentSpeedModes`，独立判断 `fast_mode` / `ultrafast_mode`；受管精确值优先于合并配置，两者未配置时采用锁定版本默认 true。关闭不受开关阻断。无 Thread 且无显式档位偏好时读取配置选择 `service_tier`，不把配置选择当作有效档位；目录 `defaultServiceTier` 不代表用户已启用加速。新显式待生效覆盖在提交前复核对应开关，失效时拒绝并提示重新选择；恢复的历史选择保留，由上游过滤，不清除保存数据。
`codexc config` 与 WebUI 共用的用户设置边界采用 `service-tier` / `serviceTier`，保留原始配置值与
模型 `serviceTiers`；独立加速设置和核心默认值事务均验证精确模型能力及对应档位的有效开关，
预览不写入，确认写入保留 `expectedVersion` 检查。未显式配置与显式 `default` 分开展示。
Thread 档位区分用户选择与实际生效：`thread/settings/updated.serviceTier` 只证明保存的选择，
不能证明 Fast 已生效；生命周期响应提供有效档位，非空值也可确认对应选择，空有效值表示 Standard，
但不足以反推用户原始选择。Client、Router、模型选择与完成展示分别保存选择是否已知及有效值是否确认，
有效值未知时不显示 Fast。普通对话可以继续；固定保存偏好或创建任务必须先有明确选择，未知时提示通过 `/fast` 选择，自动空闲释放也保留原绑定。
新任务捕获已确认的 Standard 时写入显式 `default`；既有任务中的 null 继续沿用原有配置继承语义，不改写历史数据。
已有选择由 App Server 按当前模型与 Feature 过滤，新显式待生效覆盖保留原有能力与开关复核。
OCG 账户快照明确为无有效订阅时，`gateway-component-graph.ts` 将该账户状态注入
`model-selection-service.ts`，从渠道 `/model` 的浏览和选择中排除该账户；正常额度刷新后恢复。
这是本地选择规则，不修改 `model/list` 协议、既有 Thread 或统计代理转发。Telegram 模型按钮经
`conversation-command-service.ts` 的结构化 `selectModel` 入口保留精确 Provider 与模型身份，
等待期间失去订阅时拒绝选择，不重解析到其他账户同名模型。
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

Auto-review 各入口不按 Provider 或模型白名单限制开启，包括第三方 Provider；聚合 Provider 当前关闭，
不登记实例，Desktop、Remote、渠道和旧绑定的聚合请求均明确拒绝。原代码、材料、历史与绑定保留，
旧服务需正常重启 App Server 和 Gateway 加载关闭策略。
用户与 Workspace 默认设置保留输入、配置修订及组织策略校验；当前 Thread 的切换仍须确认绑定、空闲状态、
无待处理交互及 App Server 权威响应。[`router.ts`](../src/session-routing/router.ts) 按现有权限继承规则传递审批方式，
已加载恢复保留实际审批方式、活动 Turn 和订阅；执行入口不因第三方身份自动切回 `user`。
Remote 沿用工作区或显式审批参数，恢复与继承式分叉保留历史实际模型和审批方式。
审批决定与沙箱仍由 Codex 原生机制处理，开放入口不代表全部远端模型已验证兼容。
这不增加协议能力，也不修改官方目录或持久化格式。

| 能力 | 当前使用的官方方法或通知 | 本项目入口 |
| --- | --- | --- |
| 模型请求重试状态 | 稳定 `error.willRetry`、模型输出通知与 `turn/completed` | [`notification-conversation-events.ts`](../src/codex-client/notification-conversation-events.ts) → [`core.ts`](../src/conversation-core/core.ts) → 三渠道 `turn.retry` 展示；连续重试去重、终态收尾，不重发请求或原样显示错误详情；见下方模型请求重试展示说明 |
| Codex Auto-review 用户偏好 | 稳定 `config/read`、`configRequirements/read`、`config/batchWrite`；受控实验 `configRequirements/read.allowedApprovalsReviewers` | [`codex-user-settings-management.mjs`](../scripts/codex-user-settings-management.mjs) 投影并单独写入用户层 `approvals_reviewer = "user"` 或 `"auto_review"`；[`client.ts`](../src/codex-client/client.ts) 只在该设置读取时检查受管 requirements。CLI 与 WebUI 显式确认并校验用户层修订；未知现值、受管限制和不可用的策略读取失败关闭。审查生命周期通知及统计通过下表独立的状态投影链路处理。 |
| Thread 实际审批方式展示 | `thread/start`、`thread/resume`、`thread/fork` 响应及 `thread/settings/updated.threadSettings` 的稳定 `approvalsReviewer` 字段 | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 与 [`notification-thread-state.ts`](../src/codex-client/notification-thread-state.ts) 映射实际值，经 [`router.ts`](../src/session-routing/router.ts) 与 [`core.ts`](../src/conversation-core/core.ts) 传给 [`lifecycle-presentation.ts`](../src/surfaces/lifecycle-presentation.ts) 的启动、完成卡和 [`conversation-workspace-status-command-format.ts`](../src/surfaces/conversation-workspace-status-command-format.ts) 的 `/status`；缺失或未知值显示未知，不从全局开关推断。 |
| 当前 Thread 审批方式切换 | 稳定 `thread/settings/update.approvalsReviewer` 与 `thread/settings/updated.threadSettings.approvalsReviewer`，受控 `ThreadSettingsUpdateParams` / `ThreadSettingsUpdateResponse` | [`turn-port.ts`](../src/application/turn-port.ts) 的审批设置窄端口、[`conversation-service.ts`](../src/application/conversation-service.ts) 与 [`client.ts`](../src/codex-client/client.ts) 实现 `/autoreview [on\|off]`：查询不创建 Thread，写入核对当前绑定、空闲状态与待处理交互，只有 `user` / `auto_review` 可写，其他实际值只读。相同已确认值直接返回；变更不启动 Turn、不改 Workspace 默认、不重试，先注册通知观察再请求，同时确认 RPC 成功与最新同 Thread 同目标合法通知；超时、断线、关闭及 Thread 失效清理等待，结果未确认单独回报，不乐观改缓存。Provider 路由保持对应实例隔离。上游依据为锁定源码 `request_processors/turn_processor.rs::thread_settings_update_inner`、`bespoke_event_handling.rs::ThreadSettingsApplied` 与 `tests/suite/v2/thread_settings_update.rs` / `model_auto_review.rs` |
| 恢复协作模式 | `thread/resume.collaborationMode`（稳定响应字段） | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 将实际 Default/Plan 模式交给 [`router.ts`](../src/session-routing/router.ts)，用于显式接续、自动接续与订阅恢复 |
| 异步用户问题 | `item/started`、`item/completed` 的 `agentMessage.delivery` / `questions`；回答复用 `turn/steer`、`turn/start` | [`async-question-coordinator.ts`](../src/bootstrap/async-question-coordinator.ts) 复用三个 Surface 的输入交互，独立于阻塞审批；[`conversation-service.ts`](../src/application/conversation-service.ts) 在锁内验证原 Thread 和有效期 |
| 文件审批明细关联 | `item/started.fileChange.changes` 与 `item/fileChange/requestApproval` 的 Thread、Turn、Item 身份 | [`file-change-approval-context.ts`](../src/codex-client/file-change-approval-context.ts) 在每个 Client 内有界保留路径与操作，Provider 路由核对请求来源；[`coordinator.ts`](../src/approval/coordinator.ts) 为三个渠道生成完整转义详情，明细缺失显式提示，无效或过长预览拒绝；不缓存 Diff。官方顺序见固定版本 [`turn_start.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/turn_start.rs) 的 `turn_start_file_change_approval_v2` |
| Luna Reserve 自动回退 | `error.codexErrorInfo = usageLimitExceeded`、`account/rateLimits/read` 的 `supportsLunaReserve` / `excludeResetCreditDetails` 与账户、普通用量、后端 Banner 字段，`model/list.includeHidden`、`thread/settings/update`、`thread/settings/updated` 及实验 `thread/settings/update.collaborationMode` | [`luna-reserve-port.ts`](../src/application/luna-reserve-port.ts) 与 [`luna-reserve-service.ts`](../src/application/luna-reserve-service.ts) 将最终用量错误与同一 Turn 完成配对，核验账户、受限模型和精确隐藏 `gpt-reserve`。即时与定时刷新只共享当前账户正在进行的轻量额度请求，账户失效或关闭时取消，不缓存已完成结果。最终写入前复核绑定、活动 Turn、待生效选择和完整受支持模型设置；只有 RPC 成功、最新实际设置通知匹配且共享归约完成后才确认切换，不乐观写缓存。显式清除服务层级按官方 `default` 语义确认。写入失败或未确认不由定时器重试。普通额度明确恢复、无未知 Banner 或剩余阻断且原模型可用时才切回；手工改变模型、思考等级、服务层级或模式会取消自动恢复。账户及 Thread 生命周期取消状态，已发写入不做补偿。原模型仅保存在进程内，不保存或重放失败消息，不建立第二套 Queue。协议无版本条件写入，不能保证多客户端原子修改。三个渠道复用稳定 warning；[`account-adapter.ts`](../src/codex-client/account-adapter.ts)、[`model-adapter.ts`](../src/codex-client/model-adapter.ts)、[`client.ts`](../src/codex-client/client.ts)、[`gateway-component-graph.ts`](../src/bootstrap/gateway-component-graph.ts) |
| 结构化 Turn 错误 | `error`、`turn/completed` 中的 `TurnError.codexErrorInfo` 中的 `misalignmentPolicyViolation`、`unauthorized` 与 `usageLimitExceeded` | Client 只识别这三个精确枚举并传递窄分类；Core 将错误文本与代码作为整体归约并保留 `willRetry=false` 与 `failed` 终态，三个 Surface 的完成卡片对策略错误使用固定脱敏中文提示，对登录或刷新令牌失效按 OpenAI 官方与其他 Provider 分别提示重新登录、改选第三方或更新凭据，用量上限使用明确的额度错误分类并接入上行 Reserve 合同。Turn 错误单独记录分类与协议代码诊断，不生成模型请求样本；[`notification-conversation-events.ts`](../src/codex-client/notification-conversation-events.ts)、[`core.ts`](../src/conversation-core/core.ts)、[`turn-error-diagnostics.ts`](../src/bootstrap/turn-error-diagnostics.ts)、[`lifecycle-presentation.ts`](../src/surfaces/lifecycle-presentation.ts) |
| MCP Plugin 来源 | `mcpServerStatus/list` 的 `McpServerStatus.pluginId` | Client 只保留可空、长度受限且符合固定上游 `<plugin>@<marketplace>` 字符规则的 ID；仅 `/mcp` 详情显示来源 Plugin，不用于授权、审批、命令/脚本来源推断或 OAuth 参数；[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`conversation-extension-command-format.ts`](../src/surfaces/conversation-extension-command-format.ts) |
| MCP 工具发现状态 | `mcpServerStatus/list` 的 `McpServerStatus.toolsError` | Client 只把错误是否存在映射为稳定布尔值，不向 Application、Surface 或日志传播上游错误正文；`/mcp health` 将工具发现失败列为需处理项并建议显式刷新，不把空工具集误报为“未公开能力”；[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`conversation-service.ts`](../src/application/conversation-service.ts)、[`conversation-extension-command-format.ts`](../src/surfaces/conversation-extension-command-format.ts) |
| Thread 原生 Queue | 实验 `thread/queue/add`、`thread/queue/list`、`thread/queue/update`、`thread/queue/delete`、`thread/queue/reorder`、`thread/queue/start`、`thread/queue/changed` | [`thread-queue-port.ts`](../src/application/thread-queue-port.ts)、[`queue-adapter.ts`](../src/codex-client/queue-adapter.ts)、[`conversation-service.ts`](../src/application/conversation-service.ts)；100 条原生容量、25 条公开分页、文本编辑和非文本安全摘要 |
| Thread 分页历史与 Revert | 实验 `thread/turns/list`、`thread/revert`、`thread/reverted` | 新建 Thread 显式使用 `historyMode: "paginated"`；[`thread-history-port.ts`](../src/application/thread-history-port.ts)、[`history-adapter.ts`](../src/codex-client/history-adapter.ts)、[`conversation-service.ts`](../src/application/conversation-service.ts) 与 [`conversation-core/core.ts`](../src/conversation-core/core.ts) 提供有界列表、五分钟一次性确认、执行前并发复核、Queue 原顺序保留和派生状态失效 |
| 轮次与会话执行耗时 | 既有 `turn/completed`、`thread/turns/list` 的 `Turn.durationMs` | [`turn-execution-tracker.ts`](../src/bootstrap/turn-execution-tracker.ts) 将官方整轮耗时幂等落库并有界补齐历史；重连与 Revert 后重新同步，不存消息历史或重复累计数；完成卡与 WebUI 共用指标库查询，不叠加子代理耗时 |
| 初始化与连接 | `initialize`、`initialized` | [`codex-client/`](../src/codex-client/README.md)、[`doctor.mjs`](../scripts/doctor.mjs) |
| Thread 执行上下文诊断 | 稳定 `thread/start`、`thread/resume`、`thread/fork` 响应的 `cwd/runtimeWorkspaceRoots`，`thread/settings/updated.threadSettings.cwd` | Client 校验并投影，Router 按绑定保存内存诊断，Application 经三个渠道共享 `/status` 展示最近确认 cwd 与带对应 cwd 的生命周期 roots 快照；断线、关闭、取消订阅或响应新鲜度不明时显示未知。设置事实在同步接收边界处理，旧连接设置不覆盖新状态。不改变精确目录准入、不回传 roots、不将快照当实时授权状态。macOS 隔离 App Server 新建、设置通知到共享格式器、无 Turn 持久化历史冷恢复及 Provider 设置重连已观察；空 roots、畸形响应、迟到变化、失效、换绑补偿和完整 Gateway 队列时序已人工挑战。Debian 已补验无 Turn 历史冷恢复、监管器设置重启、租约保护及恢复协调器链路，并以人工绑定提交故障观察真实恢复与退订补偿；采用手工装配的真实组件，完整 Gateway 设置入口自动编排的证据仍来自 macOS。随后已观察真实活动 Turn 的 Steer、中断、非空 Queue 六操作、观察连接恢复及 TG 正文投递；这些证据不等于执行上下文状态消息的真实平台展示、渠道输入入口或生产 Gateway 故障恢复。证据分类与仍开放的自然 closed、周期调度及各平台交互边界见[当前验收记录](thread-execution-context-acceptance.md)；早期开发见[归档记录](archive/thread-execution-context-plan.md)。 |
| 会话功能与轮次触发来源 | 稳定 `thread/start.threadSource`、`thread/fork.threadSource`、`turn/start.turnTrigger` | [`client.ts`](../src/codex-client/client.ts) 普通新建及用户显式派生发送 `threadSource=user`，普通会话用例显式传 `turnTrigger=user`，与固定版原生 CLI 一致；计划任务新建保留 `threadSource=automation`，不填 Turn 触发标记。Provider 路由保留选项，普通 HTTP/WebSocket 代理保留官方来源元数据；Steer 与 Queue 不附加各自协议未定义的字段。隔离的 0.163.0 App Server 已确认普通/后台创建、派生及恢复来源；实际请求观察确认普通 Turn 带 user、自动任务 Turn 不填触发来源，均被服务接受。恢复接口无来源覆盖字段，不迁移旧会话或回填历史统计，官方用量页面最终分类尚未观测。 |
| 指令文件来源诊断 | `thread/start`、`thread/resume`、`thread/fork` 响应的 `instructionSources` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 保留官方实际加载路径，Router 按绑定保存内存快照，Application 经三个渠道共用的 `/status` 格式器展示；未取得与空清单分别处理，释放绑定清理，不写入数据库或读取指令正文。隔离的 0.163.0 App Server 新建、派生和恢复均实际返回本项目 `AGENTS.md`，已观察 Router 至状态文案的路径输出；平台发送未执行。该清单不是全部系统/动态指令，也不保证反映后续文件修改。 |
| 原生权限配置与会话继承 | 稳定 `config/read`、`thread/start`、`thread/resume`、`thread/fork` 的权限字段及响应 | 前台不补网关权限默认值；新建由 App Server 按 cwd 加载配置，恢复/分叉保留原生权限继承。所有 Thread 响应投影实际 cwd、沙箱、审批策略和 Profile，恢复只比较显式请求约束。后台 `config/read` 按目标 Provider/cwd 预检明确受限 `sandbox_mode`，无法证明的缺省或命名 Profile 拒绝；创建仅覆盖 `approvalPolicy=never`，实际响应符合预检后才启动 Turn。Gateway 保留目录准入与审批交互，不再维护 Workspace 权限写入入口。 |
| Thread 生命周期与分区 | `thread/list.modelProviders`、`thread/list.ancestorThreadId`、`Thread.parentThreadId`、`thread/loaded/list`、`thread/read`、`thread/start`、`thread/start.threadSource`、`thread/resume`、`thread/fork`、`thread/archive`、`thread/unarchive`、`thread/delete`、`thread/unsubscribe`、`thread/name/set`、`thread/metadata/update`、`thread/section/move`、`thread/compact/start`、`thread/closed`、`thread/archived`、`thread/deleted` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 本机 [`session-cleanup.mjs`](../scripts/session-cleanup.mjs) 通过主实例枚举共享历史并跨已连接实例核对活动状态，已移除 Provider 的历史仍可维护，后代查询显式覆盖来源与归档状态，以祖先限定范围；只向父会话执行一次官方归档，随后按 Workspace 共用双状态根列表并逐组核验可查询后代，区分部分成功与未知结果，不承诺原子性。适配器把官方 `section`、`modelProvider` 映射为稳定快照，并把官方 `threadSource="automation"` 来源投影为稳定 `automation`；Desktop 启动检查用 `thread/loaded/list` 枚举持久及临时 Thread，再以 `thread/read` 读取权威活动状态。所有分区状态仍由 App Server 管理，Gateway 不建立第二套分区索引；StateStore 只保存最小绑定。运行中 `/resume` 或 `/new` 继续把原 Thread 作为有界后台任务；`/release` 只读定位持锁进程，`/release force` 在显式确认后释放占用 |
| WebUI 子代理状态与范围统计 | 稳定 `thread/read(includeTurns:false)` 的权威 Thread 状态，既有精确子 Thread/Turn 关系与官方 `durationMs` | [`gateway-thread-state.mjs`](../runtime/gateway-thread-state.mjs) 通过私有 IPC 为当前指标页读取 Gateway 已连接实例，不连接或唤醒 Provider；[`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts) 核对官方 Thread/Provider 身份。状态按刷新时刻展示，不把 idle 或 notLoaded 解释为运行完成。父 Turn 查询的用量、模型与官方耗时按精确子 Turn 收敛，缺失保持未知；[`sqlite-request-metrics-subagent-queries.ts`](../src/observability/sqlite-request-metrics-subagent-queries.ts)、[`webui-server.mjs`](../scripts/webui-server.mjs)。隔离数据查询与 WebUI 路径观察不代表真实 App Server 在线验收。 |
| Thread 设置与 Provider 路由 | `thread/start.modelProvider`、`thread/fork.modelProvider`、`thread/settings/updated`、`model/list`、`config/read`、`config/batchWrite`、实验 `collaborationMode/list` | [`model-port.ts`](../src/application/model-port.ts) 与 [`collaboration-mode-port.ts`](../src/application/collaboration-mode-port.ts) 定义稳定设置边界，[`model-adapter.ts`](../src/codex-client/model-adapter.ts) 映射 App Server 目录；模型条目中的 `multiAgentVersion`、结构化替代模型和退役时间只形成 `/model` 提示，不传播迁移 Markdown/链接，不参与可用性、路由、自动切换或审批；OpenAI 生命周期信息不复制到复用同名模型目录的第三方 Provider。`codexc config` 的 Codex 用户设置入口从同一目录选择全局模型与思考等级，并把 Fast、`sandbox_mode`、`approval_policy` 与 `sandbox_workspace_write.network_access` 收敛到带用户层修订检查的受控 `config/batchWrite` 事务；“一键配置全部”在一次确认后提交包含模型、加速、适用权限和完整五项偏好的同一原子事务。Fast 是 OpenAI 主配置偏好，不读取第三方模型目录；入口不修改登录凭据、第三方 Provider 配置或 Gateway Thread 默认值，用户层已有 `default_permissions` 时不混写传统 Sandbox 字段。`codexc remote` 不再注入 Gateway 权限参数；Codex 主配置、项目配置、所选 Profile 及原生显式参数按官方规则归并。[`model-provider-catalog.ts`](../src/codex-client/model-provider-catalog.ts) 只在受管 Provider 已启用时映射 Setup 下载并审查的模型目录；Codex 兼容自定义切换 Provider 的渠道选项不生成第三方目录文件，而由 [`model-selection-service.ts`](../src/application/model-selection-service.ts) 把主 App Server 的 Codex 官方目录以精确 Provider ID 克隆为可选项；CP 自定义切换 Provider 的渠道选项通过 `ProviderRoutingClient.listModelsForProvider` 查询各自实例的 `model/list`，不复制官方条目，总览按实例隔离故障并标记暂不可用，定向操作只查询目标 CP；读取失败不回退官方目录，不使用故障目录执行模型或能力选择。Codex 兼容后台隔离实例使用服务从本机 Codex CLI 导出的 Codex 官方目录快照（`~/.codex-connect/providers/custom/official-models.json`）作为 `model_catalog_json`，不请求第三方 `/models`。切换模式保持 OpenAI 基础配置不变，把 DeepSeek、OpenCode Go 与 CCG 的 Provider、Key 与路由隔离在统一 `sf-` 前缀的各自 Profile，模型目录与清单按提供商家族共用，管理标记按账户 ID 存放；自定义第三方同样不写主配置，通过私有显式注册表和逐 Provider 的完整 Profile（自定义目录类型为 `sf-cp-<名称>`，Codex 兼容类型为 `sf-custom-<id>`）保存 Provider 块、Key、默认模型、对应目录的思考等级与服务层级。受管 Provider 各账户独立选择默认模型；上下文、默认思考等级与模板保存在家族共用目录，只修改指定提供商的指定模型，不按模型名跨提供商广播，按该模型的 `max_context_window` 校验后写入 `context_window`；目录里其他字段保持下载原样，`auto_compact_token_limit` 仅作为上游压缩阈值，不换算为上下文窗口或随窗口调整而清空，写默认模型时保留模型目录已有窗口；受管切换 Profile 只选择当前默认模型并镜像该模型的默认思考等级（校验必须与模型目录一致），固定模式继续通过官方 `config/batchWrite` 写入默认模型并清除会覆盖目录设置的根级思考、上下文与压缩字段。历史 Thread 仍使用自身模型。由于固定版本不允许 Profile 选择器用于 `app-server`，服务入口校验各自私有 Profile 后，通过官方 `-c` 进程覆盖和仅对子进程可见的 Key 环境变量按需启动隔离 App Server，并显式移除其他受管 Provider Key。[`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts) 按官方 `modelProvider` 路由 Thread/Turn，隔离 Server Request ID 和单 Provider 重连；第三方账户通知不进入 OpenAI 账户状态，无法关联 Thread 的 MCP 与 warning 全局通知携带 Provider 来源并只投递到对应 Provider 会话。对应 App Server 在进程启动时加载自己的模型目录，避免进程级模型元数据管理器对 Thread 级目录覆盖使用 fallback。`codexc remote` 与 `codexc app` 的 `-p` / `--provider` 经 [`provider-selection.mjs`](../scripts/provider-selection.mjs) 共享完整 Provider ID 与已登记规范 `sf-*` Profile 名的精确映射，推荐完整 Provider ID，不任意剥除前缀；两个入口默认连接主实例，不根据官方登录状态自动选择第三方。Remote 的 `--profile` 保留个人 Profile 与规范受管 Profile，和 Provider 选择互斥，`--` 后原样透传；底层 Profile 文件名不变。渠道未绑定会话继续按官方登录状态选择：唯一第三方直接使用，多个候选全部属于同一家 DS、OCG、CCG 或 CLP 时采用该家注册表默认账户，其他多个候选需明确选择；使用目标 Profile 默认模型，菜单与建线程共享选择；普通消息以及 Goal 查询/设置/清除、Review、Compact、Fork 统一经 Conversation Service 的会话入口应用该选择；同 Provider 选模型不提示切换 Provider，实际跨 Provider 提示在目标 Thread 建立后消失；没有统一默认账户的多个候选要求通过 `/model` 明确选择，官方默认模型不阻断第三方入口，已有 Thread 保留 Provider。切换模式的 `--profile sf-cp-<名称>`、Codex 兼容类型的 `--profile sf-custom-<Provider ID>`、`--profile sf-ds-<账户>`、`--profile sf-ocg-<accountId>` 与 `--profile sf-ccg-<accountId>` 与磁盘文件和原生 Codex 使用同一规范名称，并连接对应 Provider Socket；旧的无 `sf-` 名称只返回明确替换提示，不作为隐式别名。受管 Provider 只接受当前账户身份、Profile 与文件布局；不支持的格式原样保留并明确拒绝，只恢复能映射到当前 Provider 的 Thread。可选模型以下载的官方目录为准，目录里有什么就开放什么（当前为 Flash 与 Pro），新安装默认使用 `deepseek-flash`；更新器不刷新 Provider 模型目录；目录配置由 Provider Setup 管理。模型目录由人工对照官方资料更新审查基线。`deepseek-flash` 从目录声明读取 `text/image` 输入能力；受管 DS 渠道图片经受保护的本地上传路由调用官方 Files API，并以稳定 `UserInput.image.fileId` 提交 App Server，安全与失败边界见 [DeepSeek 图片识别](deepseek.md#图片识别)；跨 Provider 选择保留并解绑原 Thread，向目标 App Server 的 `config/read` 读取 Profile 有效思考等级，目标模型不支持或未配置时才回落目录默认，再在下一条消息中创建新 Provider Thread；不继承原 Provider 设置，不 Fork 或复制 Provider 专属历史；同一 Provider 内模型选择仍作为下一 Turn 覆盖并保留兼容思考等级。Workspace、新会话和同 Provider 历史 Thread 切换会保留当前模型、思考等级与服务层级；未绑定期间通过 Router/StateStore 持久保存偏好，空闲释放与偏好原子落库，重启后校验精确 Provider 和目录再创建新 Thread，已有绑定仍以 App Server 为准；自动接续只选择匹配 Provider 的候选，显式恢复不同 Provider 的历史 Thread 时尊重其原 Provider。Application 在创建或追加 Turn 前按模型目录检查图片和音频能力，避免文本模型静默接收占位输入。官方设置通知没有携带可变 Provider 时，Router 保留已确认的 Provider |
| Turn 控制 | `turn/start`、实验 `turn/start.collaborationMode`、`turn/steer`、`turn/interrupt`、`turn/started`、`error`、`turn/completed` | [`turn-port.ts`](../src/application/turn-port.ts) 定义稳定执行、结构化 Skill 输入、当前 Turn 最终回答 Schema 与 Default/Plan 覆盖端口，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 编码请求与响应；[`notification-conversation-events.ts`](../src/codex-client/notification-conversation-events.ts) 映射生命周期通知、校验官方 `Turn.durationMs` 并统一脱敏、限长可显示的错误，[`lifecycle-presentation.ts`](../src/surfaces/lifecycle-presentation.ts) 在三渠道共享完成卡片中显示可用的官方 Turn 总耗时；显式 Skill 调用同时发送 `$<skill-name>` 文本标记和官方 `skill` 输入项，活动 Turn 不允许切换协作模式 |
| Item 与流式输出 | `item/started`、`item/completed`、`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/reasoning/summaryPartAdded`、`item/reasoning/textDelta` | [`notification-conversation-events.ts`](../src/codex-client/notification-conversation-events.ts) 分类稳定 Item 事件，[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts) 生成脱敏操作摘要，把来源不是用户终端命令、非空且全部为 read/listFiles/search 的 `commandExecution.commandActions` 归约为只读探索摘要、其余命令保留原始文本；该判定沿用官方 best-effort 解析，`find … -delete` 或管道里的 `tee` 等写入形态可能一并归类，且只影响渠道展示，把官方 `imageGeneration.savedPath` 映射为生成图片产物，同时原样保留 `fileId` 为所属 Thread/Item 的内存引用；飞书/Telegram 对仅有引用的已完成图片显示内容暂不可获取，持久输出剥离引用并保留该状态，不下载、不回传模型，[`core.ts`](../src/conversation-core/core.ts) 只归约稳定输入；渠道展示仅使用官方三个推理通知作为 Telegram 与飞书的“思考中…”状态驱动，默认不展示，摘要与原始思维链内容不进入渠道，连续思考每段只显示一次，每段独立计时并以最终标记结束，操作打断后再次思考会重新显示，首个回复增量、错误或完成时停止，可通过 `display.reasoning = true` 显式开启支持渠道的展示；微信为保留单次回复窗口预算，不主动发送推理、操作或 App Server 生成图片事件。[`generated-image.ts`](../src/surfaces/generated-image.ts) 对 Telegram 与飞书的生成图片本地读取执行绝对路径、无符号链接、普通文件、10 MiB 与 PNG/JPEG 签名校验；`codexc channel send-image` 对三个渠道使用各自受控读取边界提交渠道 spool 图片 |
| 第三方重复思考保护 | 已支持的 `item/reasoning/textDelta`、`item/reasoning/summaryTextDelta`、`item/started`、`item/completed`、`turn/interrupt` 与 `turn/completed` | [`notification-reasoning-guard.ts`](../src/codex-client/notification-reasoning-guard.ts) 保留原始思考／摘要增量及各自段索引，完成快照只分隔边界；[`reasoning-repeat-guard.ts`](../src/application/reasoning-repeat-guard.ts) 在有界内存中检测同段 200–4096 码点的精确三次连续重复，由组合根限定非 OpenAI 官方提供商的已绑定活动轮次（聚合入口当前关闭），原始思考与摘要独立检测，并调用原 Turn 中断。以锁定版 `app-server-protocol/src/protocol/event_mapping.rs`、`app-server/src/request_processors/turn_processor.rs`、`core/src/tasks/mod.rs` 与 `ext/queue/src/service.rs` 为合同：原始增量无序号，断线后清空；只在官方中断终态后报告停止，不递归停止子代理，不删除 Queue 或改变 Goal。真实提供商自动中断与渠道投递尚待观察。 |
| 子代理活动与终态 | `subAgentActivity`、子线程 `turn/started` / `turn/completed`、`item/completed` 的 `collabAgentToolCall.receiverThreadIds` 与 `agentsStates` | [`notification-conversation-events.ts`](../src/codex-client/notification-conversation-events.ts) 只在 Item 完成阶段把官方活动类型映射为稳定事件，避免开始与完成阶段重复登记；Core 把 `started` 显示为子代理开始、把不改变当前存活状态的 `interacted` 显示为子代理继续，`interrupted` 与 `completed` 只参与终态跟踪。[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts) 把官方接收线程和状态映射为不含代理消息正文的稳定操作事件。[`subagent-completion-tracker.ts`](../src/bootstrap/subagent-completion-tracker.ts) 登记生成的子代理线程，并按子线程 `turn/started` 把每轮精确子 Turn 与父 Turn 写入指标库的 `subagent_turns`；子 Turn 先于父 `interacted` 到达时会与有界待处理活动合并，上一轮仍在指标结算窗口内时分离结算，延迟终态和指标只匹配原子 Turn，避免快速继续覆盖或串入新一轮。成功结算只采用 App Server 发给发起父 Turn 的 `subAgentActivity.completed`，并按父 Thread、父 Turn、子 Thread 与代理路径精确匹配；子线程 `turn/completed` 与等待工具状态不再作为并行成功来源，失败和中断仍使用子线程官方终态、中断活动与工具异常状态。已观察到模型指标且终态后出现同一父 Turn 的官方 `wait` Item 时，再等待该子 Thread + Turn 的 Writer 当前持久化水位并立即发布；尚无指标或终态后未出现父线程等待时保留有界收敛窗口，登记前到达的成功活动按完整父运行归属短期有界保留。先前父 Turn 的 `wait` 不会加速之后才终止的并行或后续子代理。指标到达和静默时间不推断终态。无指标发布零统计，读取失败显示统计不可用。Telegram 与飞书的紧凑操作模式共用同一策略，只保留子代理启动和失败，抑制成功的等待与交互操作；完成卡片展示模型、请求与 Token，缓存和推理分项仅在调试模式展示。微信不主动发送子代理过程或完成事件。 |
| 上下文压缩 | `thread/compact/start`、`contextCompaction` Thread Item、`item/started` 与 `item/completed` | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 从恢复历史提取压缩 Item ID，[`core.ts`](../src/conversation-core/core.ts) 合并实时完成 Item 并去重，[`conversation-service.ts`](../src/application/conversation-service.ts) 公开总次数；共享 Surface 展示层将实时压缩开始与完成独立通知飞书、Telegram 和微信，不受普通操作隐藏设置影响 生成类型中的 `thread/compacted` 已标记废弃，统计不依赖它；当前 Item 不提供手动/自动触发来源，因此只显示总次数 |
| Hook 完成通知 | `hook/completed` | 固定版本 [`hook.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/hook.rs) 与 `bespoke_event_handling.rs`；[`notification-conversation-events.ts`](../src/codex-client/notification-conversation-events.ts) 映射运行 ID、已知事件名（包括 `preModelRequest` / `postModelRequest`）和上游终态，Core 按 Thread 路由，三渠道展示安全摘要。忽略 `hook/started`，不按执行模式额外过滤，不转发路径、状态自由文本或输出条目；验证覆盖通知适配、Thread 路由和渠道渲染，真实 hook 到客户端链路待观察 |
| Hook 列表与管理 | 稳定 `hooks/list`、`config/read`、`config/batchWrite` | 固定版本 [`hooks_rpc.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/hooks_rpc.rs) 与 [`background_requests.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/tui/src/app/background_requests.rs) 的信任与启停语义；[`hook-port.ts`](../src/application/hook-port.ts)、[`conversation-hook-service.ts`](../src/application/conversation-hook-service.ts)、[`hook-adapter.ts`](../src/codex-client/hook-adapter.ts) 通过三渠道 `/hooks` 提供列表、详情、精确版本信任、启用与停用。始终传授权 Workspace CWD，按目标 Provider 路由；五分钟确认绑定 Actor、会话、Workspace、Provider、Hook key/hash 和用户配置版本；只对 `hooks.state` 作受控 upsert，带 `expectedVersion` 与 `reloadUserConfig`，写入不重试且回读确认。各实例共用 Codex Home；[`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts) 协调已连接及正在连接的实例，以空编辑请求刷新，依据固定版 [`config_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/config_processor.rs) 与 [`config_manager_service.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/config_manager_service.rs)，不复制或重写状态；新建连接及重连强制刷新，部分失败明确展示并阻止使用旧运行配置。写入尝试使各 Provider 旧交互失效。受管项只读，信息不完整不开放渠道信任；Surface 策略复核实际详情能否无损展示，微信符号中和会改变审查字段时拒绝信任预览和确认；命令与来源脱敏，原始错误不外发。普通 Hook 的信任哈希对应配置定义，Plugin Hook 另核对内容指纹；内容变化须重新审查，指纹不保证全部外部依赖完整。0.164.0 可能在实际用户配置同级的 `.hook-trust/` 建立旧信任基线，Gateway 不自行迁移或拆解哈希。实际临时共享 Home 双实例已观察列表→预览→确认→回读、空编辑前后文件字节不变及刷新失败恢复；微信 Adapter 已观察有损信任拒绝与旧确认失效。平台投递、各 OS 和已加载 Thread 内部刷新需分别观察，保存不等于实际执行 |
| 警告 | `warning`（Thread 目标或全局） | [`notification-account-events.ts`](../src/codex-client/notification-account-events.ts) 映射并统一脱敏、限长消息，[`core.ts`](../src/conversation-core/core.ts) 只负责目标路由 |
| Diff、计划产物与 Review | `turn/diff/updated`、`turn/plan/updated`、`review/start` | Review 目标与结果由 [`turn-port.ts`](../src/application/turn-port.ts) 定义，[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 映射；Diff/计划产物通知经 [`notification-conversation-events.ts`](../src/codex-client/notification-conversation-events.ts) 转成稳定事件后由 Core 归约。计划还通过结构化 `plan.updated` 输出，Telegram 与飞书默认展示，`display.plan_updates = false` 时关闭；微信回复窗口只保留生命周期、终态与全局空闲通知，不展示计划；计划产物通知与切换官方 Plan 协作模式是两个独立边界 |
| Goal | `thread/goal/get`、`thread/goal/set`、`thread/goal/clear`、`thread/goal/updated`、`thread/goal/cleared` | [`turn-port.ts`](../src/application/turn-port.ts) 定义执行端口，[`client.ts`](../src/codex-client/client.ts) 为用户 set/clear 显式发送 `origin: "user"`，写入不重试；[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) 映射请求结果，[`conversation-service.ts`](../src/application/conversation-service.ts) 在 set/clear 成功后立即同步 Core，[`notification-conversation-events.ts`](../src/codex-client/notification-conversation-events.ts) 把外部变更与恢复通知转换为稳定 Core 事件 |
| 审批和用户输入 | 命令、文件、权限、用户输入、MCP elicitation 共 5 类审批 Server Request；命令审批接受缺省或明确的 `kind=command`；`writeStdin` 通过同一 `item/commandExecution/requestApproval` 方法解码为独立 stdin 审批，完整转义预览且仅一次批准或中止，缺失合同、过长预览与未知种类失败关闭；MCP 工具审批按 form 的 `mcp_tool_call` 元数据区分，并只返回上游提供的 `session` / `always` 范围；固定版的 `openai/userVerification` 高权限模式未声明初始化扩展、未导出五个用户验证 Client RPC，收到请求时显式取消；前台 `thread/start`、`thread/resume`、`thread/fork` 不传 Gateway 权限默认值；权限归 App Server 原生配置与 Thread 状态，后台单独约束无人值守审批和受限沙箱 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts) 负责协议解码与编码，[`approval/`](../src/approval/README.md) 负责稳定授权语义，各 Surface 只实现平台交互；[`scheduled-task-server-request.ts`](../src/bootstrap/scheduled-task-server-request.ts) 对无人值守 `writeStdin` 返回 `cancel` 中止本轮，由任务协调器持久保留审批失败归因；[`router.ts`](../src/session-routing/router.ts) 保留授权目录、身份及恢复状态校验；[`scheduled-task-executor.ts`](../src/bootstrap/scheduled-task-executor.ts) 根据目标 Provider/cwd 的原生配置预检，并核对创建响应后才提交后台 Turn |
| 计划任务动态工具 | 实验 `thread/start.dynamicTools`、`item/tool/call` | Gateway 前台新 Thread 注册 `schedule_task`；Bootstrap 的 [`scheduled-task-tool-request.ts`](../src/bootstrap/scheduled-task-tool-request.ts) 将模型参数解码后交给 Application [`ScheduledTaskToolService`](../src/application/scheduled-task-tool.ts) 复用现有创建预览/列表/生命周期用例；模型工具只接受完整 Task/Run ID，查询不读取或覆盖人工 `/schedule` 数字选择快照，人工命令继续使用各自快照。工具不暴露 `confirm`，用户仍必须通过 `/schedule confirm` 确认创建或删除。后台计划任务 Thread 不注册工具，`createScheduledTaskServerRequestHandler` 也拒绝递归工具调用。官方只允许在 `thread/start` 注入工具，因此旧 Thread 保持当前 Provider、模型和上下文，Gateway 不为工具注入自动替换前台 Thread；旧 Thread 继续使用 `/schedule`，用户显式新建的 Thread 才注册工具 |
| Skill、MCP 与 Plugin | `skills/list`、`turn/start` / `turn/steer` 的 `input.skill` 和 `mention`、`mcpServerStatus/list`、`config/mcpServer/reload`、`mcpServer/oauth/login`、`mcpServer/oauthLogin/completed`、`mcpServer/resource/read`、MCP 状态通知与 Tool Item `readOnlyHint`、`plugin/installed` | Skill、MCP 与 Plugin 分别由 [`skill-port.ts`](../src/application/skill-port.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`plugin-port.ts`](../src/application/plugin-port.ts) 及对应 Client 适配器隔离。MCP 按当前 Thread 提供有界详情、健康摘要、刷新、OAuth 与只读 Resource；工具目录和实际 Tool Item 的读写提示统一归约为只读、可能写入或未知，但不替代审批或执行结果，也不暴露直接 Tool Call。Plugin 列出或查看目标 Provider 在当前 Workspace 的已安装项，并可在官方或第三方 Thread 中发送官方 `mention`，继续校验 Actor、Workspace、启用与可用状态，解析与最终提交的 Provider 必须一致；Application 对同一次 `plugin/installed` 响应提供每页 8 项的本地分页过滤和只含需处理项的健康摘要，保留全局序号且不调用实验 `plugin/search`；详情使用响应中的版本、来源类型、安装时间、开发者、分类、能力、认证时机、不可用原因和适用套餐标识，能力与套餐各有界展示 8 项，不传播来源路径、URL、图标、截图、默认提示词或原始 Marketplace 错误。Marketplace 搜索、安装、卸载和分享仍禁止。三个 Surface 共用解析与输出 |
| MCP 与扩展任务通知口径 | MCP 启动状态通知、`turn/started` | MCP 首次 `starting` / `ready` 状态保持静默，[`core.ts`](../src/conversation-core/core.ts) 只投递失败、取消和异常恢复，避免与主动查询或认证结果重复。Skill、Plugin 和子代理新建 Turn 时只由共享生命周期确认，并在该事件中保留具体类型和名称；追加到活动 Turn 时保留命令确认 |
| OpenAI 重置券使用 | `account/rateLimits/read` 完整券明细、`account/rateLimitResetCredit/consume` | `openai-reset-credit-service.ts` 保存短期选券确认，绑定账户与券、复核状态并以同一幂等键单次消费；取消释放预览，确认即使因并发忙碌被拒绝也消耗该预览；消息渠道 `/limits reset` 通过 `conversation-reset-credit-service.ts` 绑定 Actor、Conversation |
| 用量、额度与权限 | OpenAI：`account/read`（不刷新凭据的当前认证路由）、`account/usage/read`（账户摘要与可选 `threadId` 官方估算）、`account/rateLimits/read`、账户通知；DeepSeek：`GET /user/balance`；OpenCode Go：`GET /zen/go/v1/usage`；CCG：`GET /alpha/whoami?limits=1`、`GET /alpha/billing/credits`；权限：`permissionProfile/list` | Gateway 启动时若当前 Codex Home 缺少 `auth.json` 则跳过 OpenAI 连通探测；存在鉴权文件时只把 `account/read` 的认证类型投影为 API、ChatGPT 或无需 OpenAI 认证，据此选择 [`openai-connectivity.ts`](../src/bootstrap/openai-connectivity.ts) 的官方活动线路，不读取或传播凭据；API 与自定义 Base URL 按官方 Doctor 规则检查 `/responses` 和 `/models`，ChatGPT 检查 `/backend-api/codex/responses`；`account/read` 与 HTTP 探测共同受总计 12 秒的截止时间约束且不阻断启动。系统代理在服务启动后变化时，[`network-proxy-watcher.ts`](../src/bootstrap/network-proxy-watcher.ts) 仅提示在所有客户端任务结束后按前台或后台入口重新启动 Gateway 与 App Server，不自动重启共享进程。[`account-port.ts`](../src/application/account-port.ts) 与 [`provider-account-service.ts`](../src/application/provider-account-service.ts) 按当前 Thread 的 `modelProvider` 返回 Token 用量、精确 Thread 官方估算、额度、第三方余额、配额窗口或明确不支持；OpenAI [`account-adapter.ts`](../src/codex-client/account-adapter.ts) 接受固定版本完整 `PlanType`，其中 `ent26` 显示为 Enterprise，`sci` / `sci_plus` 分别显示 SCI / SCI Plus，并严格校验官方 Thread ID、整数单位、分组字段及每张重置券的可空到期时间；`/usage` 保留账户摘要为主结果，当前 OpenAI Thread 的估算查询并行且失败隔离，不缓存、轮询或聚合子代理；`/limits` 展示官方重置券数量，按到期时间合并明细并明确标识无到期时间或服务端未返回的明细，仅在官方响应包含 10,080 分钟窗口与有效重置时间，且本机统计代理在相同重置周期观测到额度正向变化时，用 [`request-metrics-port.ts`](../src/application/request-metrics-port.ts) 按相邻快照区间估算每 1% Token；DeepSeek [`deepseek-account-adapter.ts`](../src/bootstrap/deepseek-account-adapter.ts) 通过共享 [`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs) 从切换 Profile 或固定基础配置读取 Key、复用统一代理并裁剪官方余额；OpenCode Go [`opencode-go-account-adapter.ts`](../src/bootstrap/opencode-go-account-adapter.ts) 通过同一运行时读取凭据，把官方 `/usage` 的 5 小时/7 天/月度三个窗口归约为通用 `quota-windows` 形态（已用百分比与重置时间），命令与 WebUI 按窗口展示；5 小时本地 Token 按滚动时间范围汇总，7 天/月度按请求记录的固定周期快照汇总；CCG [`ccg-account-adapter.ts`](../src/bootstrap/ccg-account-adapter.ts) 使用当前官方 CLI 的账户身份与 Credits 接口，展示月度、充值和赠送余额及 5 小时/7 天窗口；CLP [`cline-pass-account-adapter.ts`](../src/bootstrap/cline-pass-account-adapter.ts) 按独立账户 Key 查询套餐使用比例和重置时间，多账户复用 Provider 路由，Chat 转换代理与 Codex 模型目录按账户独立；WebUI 账户快照按 DS、OCG、CCG、CLP 注册表补齐多账户元数据并支持逐账户刷新；控制台首次进入、恢复可见和页头刷新只读取本地快照，成功保存后由 Gateway 独立通知；各账户手动刷新才主动查询，OpenAI 复用已有 `account/rateLimits/read`，旧快照读取失败不阻止手动查询，账户清单独立读取注册表并按来源隔离异常，单账户查询不依赖整份模型配置；OpenAI 快照时间仅随额度查询成功推进，较早额度请求的迟到结果不覆盖较新的成功观测；Thread Token/上下文统计保持 Provider 通用，OpenAI 周限不附加到第三方 Thread；账户通知仍由 [`notification-account-events.ts`](../src/codex-client/notification-account-events.ts) 映射，Permission Profile 由 [`permission-port.ts`](../src/application/permission-port.ts) 与 [`permission-adapter.ts`](../src/codex-client/permission-adapter.ts) 隔离 |

受管 Provider 设置应用也复用 [`client.ts`](../src/codex-client/client.ts) 的
`thread/loaded/list` 与 `thread/read` 检查全部已加载 Thread 的权威活动状态，包括原生客户端的持久及临时 Thread。
[`app-server-service-runtime.mjs`](../runtime/app-server-service-runtime.mjs) 在监管的 Provider 操作队列中
结合 TUI/Desktop 租约检查后重新读取启动材料并定向应用，不改变其他 Provider；本地控制端口使用
独立 `settingsProtocolVersion: 1`，不新增 App Server RPC。

手动 OpenAI `/limits` 与 WebUI 单账户刷新通过 [`client.ts`](../src/codex-client/client.ts) 直接调用
稳定 `account/rateLimits/read`，沿用取消信号；额度查询、启动探测、预热与后台轮询均不主动刷新登录凭据。
后台额度查询通过 `excludeResetCreditDetails` 省略重置券详情；凭证刷新时间仅读取账户匹配的 `auth.json.last_refresh`，不以 RPC 成功或查询时间伪造更新。
固定版本 [`account_processor.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/account_processor.rs)
及其 [`workspace_routing.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/account_processor/workspace_routing.rs)
区分额度读取与 `account/read.refreshToken` 的主动刷新语义，Gateway 额度查询不发出该刷新请求。

Codex 兼容 Provider Setup 的官方模型目录复用、手工模型 ID、固定/切换双模式、直接 API Key、
独立 Profile、候选编辑、统计代理接入，以及私有备份事务边界见
[`第三方模型 Provider 接入指南`](provider-integration-guide.md)；该本地 Setup 能力不新增 App Server RPC。
自定义提供商 使用 [`model-provider-responses-catalog.mjs`](../runtime/model-provider-responses-catalog.mjs)
生成逐 Provider 的版本化目录，通过同一 `model/list`、`config/batchWrite`、Thread/Turn 路由接入；
模板选择及平台模型 ID 映射使用官方内置目录或仓库 DS 补全模板，版本 5 导入基础模型字段、完整 `modelMessages` 并单独保留最大窗口，每个生成的模型条目声明 `multi_agent_version: v2`；显式创建或更新时补全基础提示词并固化，读取不注入新模板。旧 `followContext` 仅为历史元数据，显式保存移除，不再联动 DS 上下文；历史未完成事务仍可显式恢复，
恢复实现见 [`responses-context-sync.mjs`](../runtime/responses-context-sync.mjs)；当前布局及历史目录迁移的拒绝保护见[当前目录布局与旧版本恢复](provider-integration-guide.md#当前目录布局与旧版本恢复)。历史目录迁移须使用产生事务的对应旧版本处理，不能套用模型设置恢复命令；账户身份与凭据继续独立保存，CP 目录保持独立。
CP 的逐模型默认采样参数由 CLI 独立询问，保存在目录定义的可选 `sampling` 中，不伪装成 Codex `ModelInfo` 字段；Provider Proxy 的 HTTP/WS 与 Model Relay 按精确模型补齐出站参数，显式请求值优先，见 [`Provider 接入指南`](provider-integration-guide.md#扩展能力与高级设置)。
CLI Codex 兼容 Provider 的保存前 WS 检测见 [`responses-websocket-probe.mjs`](../scripts/responses-websocket-probe.mjs) 和 [`responses-websocket-setup.mjs`](../scripts/responses-websocket-setup.mjs)。使用锁定源码 `core/src/client.rs` 的 WS v2 Beta 头及 `codex-api/src/common.rs` 的 `ResponseCreateWsRequest`，以 `generate=false` 预热和经确认的独立文字请求分别报告兼容程度；这不是新的 App Server RPC。CP 自定义提供商的 WS 开关仅手动选择，Chat 上游强制关闭。
CP 自定义 Provider 的上游接口选择（`Responses` 直连或 `Chat Completions` 经 Chat 桥转换）保存在模型目录同目录的 `provider.json`，读写与失败关闭见 [`model-provider-upstream-metadata.mjs`](../runtime/model-provider-upstream-metadata.mjs)，Chat 上游复用 [`chat-bridge.ts`](../src/provider-proxy/chat-bridge.ts) 的 `model-api` 转换；用户可通过 [`custom-model-capability-setup.mjs`](../scripts/custom-model-capability-setup.mjs) 逐项选择能力，按需调用 [`custom-model-capability-probe.mjs`](../scripts/custom-model-capability-probe.mjs) 单独验证 apply_patch 或客户端 tool_search 的调用及模拟结果接续，其余能力手动填写。官方及第三方目录另经 [`provider-web-search-probe.mjs`](../scripts/provider-web-search-probe.mjs) 提供单账户原生网页搜索诊断：显式确认可能计费的请求，以完整流终态及结构化搜索调用判断，不修改能力声明或搜索策略，也不增加 App Server RPC。
CP 模板不导入 Codex 专用 `ultra` / `persistent` 模式；其请求转换语义已核对锁定源码 `protocol/src/openai_models/reasoning_effort.rs` 及相应测试。
CP 与 CCG 保存前通过 [`model-catalog-validation.mjs`](../scripts/model-catalog-validation.mjs) 调用本机 `debug models` 校验生成目录。目录字段与指令模板要求以锁定源码 `protocol/src/openai_models.rs` 的 `ModelInfo` / `ModelsResponse` 为准。
CP v5 目录以可选定义字段保留图片原始精度、详细程度、摘要参数、描述与等级说明，以及有效上下文、压缩阈值和截断策略；旧定义生成结果保持不变。CLI 与 WebUI 逐项声明并在预览确认后保存，Chat 上游同样允许用户声明全部能力，保留现有请求转换限制并在界面说明。字段约束与备份回退见[扩展能力与高级设置](provider-integration-guide.md#扩展能力与高级设置)。

上表“全 Provider 模型代理与请求统计”还包括仅官方 OpenAI 主代理启用的 0.164.0 固定端点清单：
搜索、图片、记忆摘要与 Realtime HTTP/WS 请求透明转发且不计入 Responses 指标；DeepSeek、
OpenCode Go 和自定义第三方代理仍拒绝这些路径。

上表“子代理活动与终态”的开始通知使用 `subAgentActivity.started` 的 `model`、`reasoningEffort` 启动快照；继续通知另复用 `thread/read` 的 `Thread.model`、`Thread.reasoningEffort`。两者均读取 `Thread.modelProvider`、`Thread.parentThreadId` 与 `Thread.sessionId` 核对 Provider 与归属：
[`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 映射官方当前配置，
[`completion-output-enricher.ts`](../src/bootstrap/completion-output-enricher.ts) 在投递前有界读取，开始通知核验直接父子身份；继续通知的目标不是发起者直接子级时，另核验双方属于同一官方会话树，失败保留未知值；
[`lifecycle-presentation.ts`](../src/surfaces/lifecycle-presentation.ts) 展示提供商、模型设置与思考强度，不宣称实际请求遥测。
启动快照缺失时保留未知，不用较晚的 Thread 设置填补。官方依据为锁定版 [`item.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs) 和 [`thread_data.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs)。

当前 v2 `subAgentActivity` 不公开上下文继承模式或任务摘要，`Thread.preview` 不作为本次子任务摘要。

子代理交互复用已有 `thread/read`、`Thread.parentThreadId` 和原审批 Server Request，不新增 RPC。
[`router.ts`](../src/session-routing/router.ts) 核验官方祖先、Workspace、Provider 和绑定有效性；
[`coordinator.ts`](../src/approval/coordinator.ts) 保留子代理原有 Thread、Turn、Item 与请求身份，
把交互送到已绑定祖先会话，归属解析与排队共用有效期，绑定变化或 `serverRequest/resolved` 会取消旧请求。
`serverRequest/resolved` 的官方 Thread 归属也用于交互结束后的后台空闲复核；子代理请求沿已核验祖先找到绑定所有者，不在渠道交互移出队列时提前释放订阅。
无人值守 `automation` Thread 及其后代仍拒绝交互审批。
官方依据为固定版 [`thread_data.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs)
及 [`bespoke_event_handling.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/bespoke_event_handling.rs)。

Provider 生命周期补充：私有 [`app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs) 不是
Codex App Server RPC。监听与端点清理复用 [`private-ipc.mjs`](../runtime/private-ipc.mjs)，
Unix 公开端点通过独占硬链接发布，绑定名保留至监听关闭，避免提前复用绑定名或关闭旧监听时误删替代路径；
它负责主实例与受管实例的按需启动和显式管理操作；`codexc remote` 连接实例
期间通过同一私有 Socket 持有生命周期租约，Supervisor 在租约存在时拒绝显式释放，并在连接正常退出
或异常断开后自动撤销租约。同一实例的启动、释放与租约获取串行执行，释放响应区分已释放、
租约占用与实例未运行；DS、OCG、CCG 通过共享 [`managed-provider-account-runtime.mjs`](../scripts/managed-provider-account-runtime.mjs)
在删除账户文件前检查并释放对应实例，遇到租约占用、释放失败或无效监管响应时保留文件；
主 App Server 与受管 Provider
实例共用同一套监管协议，`codexc remote` 连接主实例时同样持有生命周期租约。Gateway 全局空闲策略
在关闭已连接 Client 后调用 Supervisor 停止 App Server 进程（含主实例）；会话解除后等待 60 秒，
期间可恢复或创建新会话，之后每 60 秒复检一次。宽限期结束仍无任何绑定和活动时，先向所有已知授权
渠道通知，再关闭 Client，并停止监管入口中全部未被租约占用的运行实例；服务进程保持运行，后续使用
按需启动。不经 `codexc remote` 直连共享 Socket 的客户端不持有租约，空闲释放不会为其保留实例。
该通知只针对渠道会话空闲自动解除触发的全局释放轮次，其他原因导致的无绑定关闭不广播。
没有监管入口时，Gateway 仍可连接独立运行的 App Server，但不会按需启停该进程。确保与释放遇到旧版
监管协议响应时失败关闭，并提示运行 `codexc restart all`。

本项目不在本地计算或估算模型价格与费用：Gateway 不抓取价格目录、不刷新汇率，也不保存价格
快照；DeepSeek 与 OpenCode Go 的官方价格基线、`ModelPricingResolver` 与价格展示字段均已删除。
模型目录仍由人工对照官方资料审查更新。账户与额度展示保持官方来源：DeepSeek 官方账户只显示
余额（官方无用量窗口）；CCG 显示 Command Code Credits 余额与 5 小时/7 天窗口；OpenCode Go 的 5 小时本地 Token 按当前滚动时间范围归属，7 天/月度按
请求记录的固定周期快照归属（缺失时由官方 `resetsAt` 倒推窗口）执行，`/usage` 只展示官方配额
窗口与本机 Token，不展示价格或费用。

| 能力 | 当前使用的官方方法或通知 | 本项目入口 |
| --- | --- | --- |
| 本轮任务与当前会话自动审查统计及渠道完成结果 | `item/autoApprovalReview/started`、`item/autoApprovalReview/completed`（方法无实验标记，payload UNSTABLE）；受控 `ItemGuardianApprovalReviewStartedNotification` / `ItemGuardianApprovalReviewCompletedNotification` | [`notification-review.ts`](../src/codex-client/notification-review.ts) 投影身份、阶段、状态与 agent 来源的批准标志，接受 approved、denied、timedOut、aborted 四种 agent 来源终态；仅终态额外投影七种 action 固定类别、文件数量、网络协议与合法端口，以及经凭据脱敏、控制字符清理并各按 320 字符截断的 operation、cwd、rationale，并投影 durationMs。Client 保留 ASCII 标点；execve 的 program 与 argv 逐参数脱敏后再格式化，摘要按 action 类别取 command、execve program 与 argv、文件列表、network host（不含完整 target URL）、MCP server/tool 或权限申请 reason；不展示 stdin 正文，不采集风险或用户授权字段。未知或畸形摘要字段省略。 [`auto-approval-review-tracker.ts`](../src/bootstrap/auto-approval-review-tracker.ts) 继续采集开始与完成事件及全部归属 Provider 的轮次，指标库以 Thread/Turn/review ID 去重，按精确 `subagent_turns` 递归统计，完成卡在投递前读取本轮及会话快照。独立的 [`auto-approval-review-notifications.ts`](../src/bootstrap/auto-approval-review-notifications.ts) 按已授权绑定及精确父子 Turn 归属向三渠道每次仅发布一张完成结果卡，经共享关键投递路径发送；不发布或补发开始通知，无人工审批按钮，换绑、断线、未知归属不跨会话转发。Core 与投递路径保留经处理的有界纯文本，Surface 在平台呈现时负责富文本转义；指标与 StateStore 不增加审查正文，加密投递箱只暂存经处理的有界纯文本摘要，可选 details 沿用现有结构版本。断线、重启、缺少开始、未完成子轮、待完成审查与归属裁剪不能返回完整零次；迟到审查留在原 Turn。渠道实际收卡效果仍需通过真实会话确认。官方依据为锁定 [`item.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/item.rs)、[`item_builders.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/item_builders.rs)、[`common.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/common.rs) 与 [`bespoke_event_handling.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/bespoke_event_handling.rs)。缓存直接放行、用户手动批准及其他来源的终态不计入审查次数；不从缺失的历史审查重建。 |

完成卡分别查询本轮任务和当前会话累计，包含精确关联子代理；总数分为通过、拒绝、超时、中止、进行中和历史结果未知，不把未区分的旧终态当作拒绝。Provider 请求指标仅将官方 `thread_source=guardian_review` 且父 Thread/Turn 完整的审查请求归到父任务；缺少父身份时保留无会话的全局用量，不生成独立用户会话、不改变普通子代理分类。

指标只接受当前 Schema v35，首次安装直接建库，不自动迁移或重解释历史格式。字段、时间口径、
权限和只读查询合同见 [Observability](../src/observability/README.md)；安装检查见[源码安装与更新](source-install.md)。
请求用途与原始审查 Thread/Turn 作为最小身份指标独立落库；Provider 和转储读取通过
`runtime/auto-review-metadata.mjs` 共用明确来源与父归属投影。请求页筛选和转储身份展示见
[WebUI](webui.md)，不将模型请求完成状态解释为审批结果。

Provider Proxy 独立采集请求与响应模型、出站 `request_service_tier`、请求正文或 WebSocket 请求帧大小、
响应时间、生成区间、首内容和总耗时、
上游诊断及额度采集时间，经受校验 IPC 写入指标库。转储标签、实际 writer session 与 interaction
精确关联调用；CLI 与 WebUI 复用读取器，不按历史时间猜配、不推算未观测字段，也不增加 App Server RPC。
计时由 `traffic-call-timing.ts` 记录，V2 响应索引使用 `callTiming.basis: "submitted"`；
请求总耗时不作为官方 Turn 耗时。
生成区间由 `generation-timing.ts` 在原始上游事件处采集，仅作诊断；展示速度使用提交至终态的请求总耗时，不要求生成区间或首 Token 完整，避免集中到达的增量或隐藏思考 Item 放大速度。首 Token 读取已落库的首非空内容时间，不以首事件或终态补算。Chat 转换通过请求级进程内通道传递转换前时间，不依赖转储。原生 Responses 的 item 生命周期、文本/推理增量与终态用量依据锁定源 `codex-rs/codex-api/src/sse/responses.rs` 及相邻测试；不依赖可选的逐 item token 归因字段。

`response_usage_amount` 从 HTTP JSON/SSE 与 WebSocket 终态 `response.usage_metadata.amount` 提取，
保留十进制原值和零值，缺失为 NULL，不换算美元或当作最终账单。依据锁定官方
[`response_usage.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/protocol/src/response_usage.rs)
与 [WebSocket 测试](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/tests/suite/client_websockets.rs)。
完成卡片通过精确 Turn 及递归会话查询求和并报告缺失数，不使用浮点累计；
该链路由 HTTP/WS metrics、指标 IPC、Store、导出、thread summary 和 lifecycle presentation 实现。

更新器关闭原生 daemon 自动启动也复用用户层 `config/read` 与版本化 `config/batchWrite`；
入口为 `scripts/codex-user-config.mjs`，由 `source-update.mjs` 在候选切换和无需升级两条路径调用。
受管 DS、CLP、CCG、OCG 账户发布或恢复主配置由 `scripts/managed-provider-files.mjs` 复用同一用户层版本合同，
仅写入计划差异字段；私有凭据先发布，写入后回读，未知结果保留恢复材料，不自动重放或全文件回滚。
用户层会规范化路径字段；该事务在 RPC 读取两侧复核磁盘原文，使用返回版本条件写入，再以稳定回读的磁盘字段判定持久化结果，不将原始 TOML 与规范化用户层直接比较。
官方版本检查不构成主配置与私有文件的跨文件原子提交，也不承诺原生文件写入的全局串行化；恢复边界见[Provider 接入指南](provider-integration-guide.md#4-安全边界)。

CLI 用户设置使用的用户级 `config/read` 不携带 Workspace CWD，读取用户层并投影该连接的合并配置；渠道跨 Provider
切换则向目标 App Server 发送带 Workspace CWD 的只读 `config/read`，取得该 Profile 的有效思考等级。
App Server 服务在确认实例就绪前也通过带启动 Workspace CWD 的 `config/read` 核对 Provider 与统一请求策略；第三方和聚合必须保留显式注入的 300 秒完整事件空闲、15 秒 WebSocket 建连、HTTP 重试 4 次及流重试 5 次，匹配锁定 Codex 默认。受管 Provider 覆盖冲突或缺失必要响应会阻止就绪。内置 OpenAI 保留官方默认，不把原始同名 TOML 块当作已覆盖生效。所有实例的网络重连开关与 WS→HTTP 降级交由 Codex 原生配置和要求控制，不施加第三方专属覆盖。
WebUI 的 Codex 和 Provider 配置读取通过 `scripts/codex-user-config.mjs` 的共享 Client 连接已有主 App Server，关闭连接不停止服务，也不在服务不可用时启动临时进程。
Codex 设置读取沿用 `model/list` 查询已有目录；每次读取后立即断开连接，不获取 Supervisor 保活租约或唤醒已释放实例，模型相关保存仍执行原有目录校验。
WebUI 的 OpenAI 缓存卡片独立通过 `scripts/webui-official-model-catalog.mjs` 读写当前 Codex Home 的 `models_cache.json`；逐模型上下文编辑保留其他字段，刷新仅在确认后运行 `debug models` 并对比缓存实际变化，不保证远程刷新，不提供内置目录覆盖。预览确认、备份与覆盖风险见 [WebUI 指南](webui.md)，此文件视图不代表 App Server 内存中的 `model/list` 结果，不增加 RPC 能力。

Auto-review 用户层偏好只写入稳定 `approvals_reviewer` 字段，并用 `configRequirements/read`
读取受控实验 `allowedApprovalsReviewers` 及稳定 `featureRequirements` 的相关限制；`ConfigRequirementsReadResponse`
用于审批策略及 Fast/Ultrafast 的稳定功能策略判断受控导出。加速设置从合并配置与受管功能约束投影，不以用户层配置代替有效策略。依据固定版
[`config.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/protocol/v2/config.rs) 的实验字段标记及
[`export.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server-protocol/src/export.rs) 的稳定生成过滤，读取和写入合同见
[`config_manager_service.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/config_manager_service.rs)、
[`config_rpc.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/tests/suite/v2/config_rpc.rs)
和 [`config_tests.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/config/config_tests.rs)。
不扩展实验审查事件支持。
电脑、浏览器与已有 MCP 设置由 [`codex-tool-settings.mjs`](../scripts/codex-tool-settings.mjs) 受控投影，
复用上述读取和带 `expectedVersion` 的 `config/batchWrite`，不新增 RPC。字段依据固定版
[`computer_use.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/computer_use.rs)、
[`browser_use.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/browser_use.rs)、
[`mcp_types.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/mcp_types.rs) 和
[`types.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/config/src/types.rs) 的插件覆盖白名单。
用户 MCP 的添加、逐项编辑与删除由 [`mcp-setup.mjs`](../scripts/mcp-setup.mjs) 复用同一配置事务，
仅操作当前用户层 `mcp_servers`；键路径逐段引用，`null` 删除字段或条目，写入后回读确认。
插件及其他配置来源不进入编辑/删除列表，使用入口与限制见[使用指南](user-guide.md#4-workspaceprovider-与终端)。
渠道选择 OpenAI 官方模型时不继承当前 Thread 或用户配置中的 Fast，下一 Turn 显式使用标准服务层级；
Fast 只在用户之后通过 `/fast on` 明确开启时生效。
模型、思考等级、Fast、计划清单工具、
`multi_agent_v2` 的普通键级写入使用官方 `config/batchWrite` 事务。
Codex 全局设置由共享管理层保留安全写响应 `status` / `version`，在同一 Client 回读用户层并核对本次
实际编辑与返回版本；回读失败或后续修改返回保存未确认，不自动重试。`okOverridden` 只作为覆盖状态
枚举展示，不向 WebUI 传播原始覆盖来源、值或文件路径。普通偏好可按显式字段独立保存，`null` 复用
官方删除用户覆盖语义；模型目录、加速策略不可用分别降级，保留权限与普通偏好读取。工具确认额外绑定
相关合并目标的安全摘要指纹，CLI 与 WebUI 执行前重新读取核对；原生命令、凭据不进入预览。
可选子代理预设入口为 [`codex-subagents-setup.mjs`](../scripts/codex-subagents-setup.mjs)：用户显式选择并确认后，
以用户层修订保护写入 `features.multi_agent_v2.enabled` 与
`features.multi_agent_v2.default_wait_timeout_ms`。预览检测主配置用户层已有的
`agents.default_subagent_model` 与 `agents.default_subagent_reasoning_effort`，说明省略派发参数时这些键仍会生效，
并提示人工检查和处理；不写或清除这些键，不检查其他配置层或角色配置。
“仅写规则”不读配置，并提示未检查覆盖。只有有效默认及角色配置均未覆盖时，省略参数才继承当前对话设置；
全局 `AGENTS.md` 规则为独立文件写入，
不新增 RPC，不纳入安装、更新或核心默认值配置。完整协作规则由脚本托管文本及
[子代理规则与配置](user-guide.md#子代理规则与配置可选) 说明：默认 Sol/high 承担理解、审查、实现和执行，
Luna/max 处理明确、低风险且易核对的整理，Astra/high 仅按需处理复杂问题或独立审查。
主代理负责决策、整合和针对性复核，不默认重做完整调查；明确要求的完整审查和项目验证仍须执行。
使用 `fork_turns="none"` 时显式交接用户目标、纠正与授权，不假定继承父对话用户消息。
子代理不得再派发，每个代理只执行一轮，不复用或调用 `followup_task`；运行中可澄清、纠正及收缩同一任务，
交付后的工作由主代理或新代理处理。未完成异步作业须明确交接，不以返回句柄代替完成。
模型选择遵守工具契约，区分能力不支持、临时故障和授权拒绝；不因有限名单缺失断言不可用，
不将单目标失败泛化，也不盲目省略参数或自动改用 Astra。无法确认合适目标时由主代理接手并说明限制。
默认覆盖和角色覆盖顺序见固定版本
[`child_config.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/agent/child_config.rs)，
工具展示的有限可见名单见
[`multi_agents_spec.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)。
这些是行为指令而非运行时强制限制，完整操作说明见[子代理规则与配置](user-guide.md#子代理规则与配置可选)。字段依据固定版本
[`config.schema.json`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/config.schema.json)。

Codex 原生角色的 Provider、凭据、目录与权限继承父线程；本项目不提供第三方子代理配置入口。
官方行为见锁定版本的
[`role.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/agent/role.rs) 与
[`role_tests.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/agent/role_tests.rs)。
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
公开能力。采用其中任何能力前，必须先审查对应 Server Request、Notification、安全边界和上游行为。

### 输入与语音边界

| 输入或交互 | 固定 CLI 0.164.0 | Gateway 当前状态 | 边界 |
| --- | --- | --- | --- |
| 文本 | `turn/start`、`turn/steer` 的稳定 `UserInput.text` | Telegram、飞书、微信已支持 | 由 Application 的 `TurnInput.text` 进入统一 Turn |
| 视频附件引用 | 沿用稳定 `UserInput.text`，不添加原生视频类型 | 三渠道已实现下载与单文件随机引用；真实平台待验收 | 视频经私有暂存后，当前会话通过显式配置的独立 MCP 分析；MCP 以 `attachment` 读取有时限的单文件能力引用。下载期间切换工作区/Thread或撤权则拒绝提交。详见[视频分析 MCP](video-analysis-mcp.md#渠道视频附件) |
| 内联图片 | `turn/start`、`turn/steer` 的稳定 `UserInput.image`（`url`） | 三渠道受限 PNG/JPEG/WebP/非动画 GIF Data URL 已支持；仅当前模型声明 `image` 输入能力时可用 | Surface 完成下载、签名、格式、数量和大小校验后，共享批处理器按 [OpenAI 图片输入要求](https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements)在提交边界读取为有界 Base64 Data URL；Gateway 统一限制为单张 10 MiB、每批最多四张且合计 20 MiB，这是跨渠道安全边界，不代表三平台具有相同官方上限，并低于当前已知 Provider 上限。Application 拒绝 HTTP(S)、空值和非法 Base64，Gateway 不把本地路径或 Base64 写入自身日志或独立存储，并在创建或追加 Turn 前按模型目录检查 `image` 能力；支持时提交官方 `image`，不支持时提示使用 `/model` 切换模型，不调用外部视觉 API，也不建立第二套识图会话 |
| 图片自动引用 | 稳定 `turn/start`、`turn/steer` 的 `UserInput.image.fileId`；`getAuthStatus` 与受控 `account/read.workspaceRouting`；受管 DeepSeek 的本地 `/_codexc/image-upload-route` 与受限 Files API 上传入口 | OpenAI ChatGPT Thread 经当前模型代理后端核验后上传原图并提交编号；仅默认后端一致且策略为 `NO_CONSTRAINT` 时转换，自定义独立后端保留内联，`us`、`us_cr` 或后端不一致拒绝。受管 DeepSeek Thread 经同一回环代理上传官方 Files API，按 Provider 材料修订复核后提交编号；上传失败不回退 Base64。历史均由 App Server 保留。飞书实机已验证 OpenAI 首次 `file_id` 与后续 `previous_response_id` 接续不重复 Base64 | [`image-reference-upload.ts`](../src/codex-client/image-reference-upload.ts) |
| 一次性音频 | 稳定 `UserInput.audio` / `UserInput.localAudio`；模型目录用 `inputModalities` 声明实际能力；固定源码支持 WAV、MP3、M4A、WebM 与 OGG 本地音频 | 三渠道平台接收与受限转换已实现；当前可见模型均未声明 `audio`，原始音频不属于当前端到端支持 | Surface 先验证可信时长、最长 5 分钟、最大 20 MiB 与格式并写入一小时私有临时文件；Application 再按当前或下一 Turn 模型的 `inputModalities` 检查 `audio`，缺失时在 `turn/start` / `turn/steer` 前明确拒绝。微信可信转写仍作为文本提交；SILK 明确拒绝 |
| 实时语音 | 实验 `thread/realtime/start`、`appendAudio`、`appendSpeech`、`stop` 及 Realtime 通知 | 禁止接入 | Realtime 不在 Plan、Queue、Revert、前台计划任务动态工具、图片上传账户路由及 Auto-review 策略读取和审查状态投影六类受控例外中；不得导出、调用或消费 Realtime 业务能力 |
| ChatGPT Voice / 语音听写 | 官方桌面应用产品能力，不是当前 CLI 命令入口 | 不属于 Gateway | 不用平台模拟实现第二套 Codex 实时会话或语音输出 |

Application 的 `TurnInput` 是只含 `text`、内联 `image` 与 `localAudio` 的封闭联合；模型目录
只把 `text`、`image`、`audio` 三种官方输入能力映射为稳定类型，包含 `localAudio` 的提交必须
先通过当前模型能力检查。Codex Client 映射这些稳定输入，OpenAI ChatGPT 图片经账户校验和上传转换为官方 fileId，其他 Provider 保持内联路径。模块依赖静态检查同时禁止生产 Client 调用 `thread/realtime/*`，Surface
不得把平台音频地址、密钥、实时音频或未验证的编解码数据带入 Application/Core。

会话列表命令（`/resume`、`/sessions`、`/archived`）优先显示本机指标/派生缓存中的 Turn 轮数，打开列表不等待 `thread/turns/list` 历史扫描；该口径与 WebUI 一致，按本机已记录模型请求的不同 Turn 统计，缓存缺失时不猜测轮数。列表投影与缓存状态由 [`conversation-session-query-service.ts`](../src/application/conversation-session-query-service.ts) 持有，稳定通知的缓存失效、待生效设置清理及 Reserve 前后置协调由 [`conversation-event-coordinator.ts`](../src/application/conversation-event-coordinator.ts) 执行，组合根保留协议解码与生命周期接线。`thread-adapter.ts` 同时保留 `thread/list` 的 `updatedAt` / `recencyAt` 供 CLI 清理的空闲过滤，精确历史计数只在清理候选校验等显式路径使用。

历史恢复限定当前工作区，复用 `thread/list`、元数据 `thread/read` 和 `thread/resume`：
[`router.ts`](../src/session-routing/router.ts) 在恢复和重连前核对历史目录，恢复后校验实际目录、权限和活动状态；
显式恢复、重连与接管校验明确不匹配时统一移除对应绑定；Core 活动查询排除已解绑 Thread，
下一条前台消息强制新建 Thread，避免普通发送或 steer 绕过恢复校验。
共享订阅的生命周期按 Thread 串行，后台恢复在 RPC 前后复核原绑定，避免过期结果覆盖用户切换。
缺少历史与 Thread 已删除分别处理：[`client.ts`](../src/codex-client/client.ts) 只把 `thread/resume` 的精确 `-32600` 与同一请求 Thread ID 的 `no rollout found for thread id ...` 映射为 `thread.resume.history-unavailable`。
[`router.ts`](../src/session-routing/router.ts) 保留绑定，以进程内暂停状态阻止 `ensure` 和输入及 Queue 提交；成功恢复订阅或解绑后清理。
[`binding-restore-coordinator.ts`](../src/bootstrap/binding-restore-coordinator.ts) 暂停普通前台的定时重试，提示 `/new` 或历史可用后 `/resume`，档位选择未知时先显式 `/fast`；后台绑定和运行中的计划任务继续恢复重试，前台转后台时重新调度，不重跑已提交任务。
官方恢复路径先读取可恢复历史；尚未落盘的空 Thread 也可能被拒绝。这一限制已存在于 [0.163.0 的 `thread_processor.rs`](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/app-server/src/request_processors/thread_processor.rs)，当前 [0.164.0](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/app-server/src/request_processors/thread_processor.rs) 仍保留，不能归为本次升级新增回归。此处记录本地处理合同，运行观察及未覆盖边界见[升级决策](codex-cli-upgrade-decisions.md#01640-升级决策)。
后台清理在绑定已被撤权移除后仍取消当前 Client 的订阅；沿用固定版本 `thread/unsubscribe` 的 `notSubscribed`/`notLoaded` 幂等结果，不修改前台绑定。
会话切换与空闲释放通过 `ThreadLifecyclePort.hasActiveDescendants` 使用对应 Provider 的 `thread/loaded/list`
和 `thread/read` 核验父子活动，包括未持久化的已加载标准子代理 Thread；官方列表排除 `SessionSource::Internal`，不宣称枚举全部内部代理。
查询限时、限页数、节点数与祖先深度，
身份或祖先关系无法确认时失败关闭。恢复后台订阅后复用正常释放条件，不仅凭父 Thread 空闲就清理绑定。
释放与后代活动查询共用 `isThreadExecutionSettled`：接受 `idle`、`notLoaded`；对 `systemError`，必须另有 Client 在当前连续订阅中先后收到同一 Turn 的 `turn/started` 与 `turn/completed` 证据，已知活动 Turn 始终否决。锁定上游的旁路 Error 也会设置 `systemError`，因此元数据 `thread/read(includeTurns:false)` 的空 Turn ID、错误标记和按该标记归一化的历史均不作为终态证明。新活动、错误、断线及订阅变化使旧终态证据失效；未知的恢复会话和子代理继续保守保留，不扩展历史读取或持久化会话索引。对于已确认结束的失败会话，完整的活动、交互、子代理与 Queue 复核在取消订阅前完成，以取消订阅作为释放边界，之后仍检查父会话可见活动、本地活动与授权守卫、Queue 和后代；不拿已失效的终态证据推断其他客户端此后没有开始新任务。普通空闲路径仍在取消订阅后复核状态，跨渠道接管的独立条件不变。上游没有跨客户端的原子“核验空闲并取消订阅”接口。
隔离的原生 App Server 经本地 CLP 桥拒绝 cached 搜索后，已观察到失败 Turn、`systemError` 和同 Turn 终态证据，随后 `/new` 解除绑定且不保留后台；后台清理经过真实 Queue 空队列屏障也完成释放。重新订阅使证据失效后，同样的失败会话被保守保留。以上未调用外网 CLP，也未验证真实渠道投递或另一设备现场。
[`conversation-service.ts`](../src/application/conversation-service.ts) 在锁内复核选择上下文，并恢复活动 Turn。

### 模型请求重试展示

稳定 `error` 通知的 `willRetry: true` 表示 App Server 仍在重试，不是 Turn 失败。
锁定版 [`responses_retry.rs`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/core/src/responses_retry.rs) 生成重试提示，
[`bespoke_event_handling.rs`](https://github.com/openai/codex/blob/6aaac694803004a63c6f393d153c96d22521a6b9/codex-rs/app-server/src/bespoke_event_handling.rs) 将 `StreamError` 转为该通知。
Client 沿用既有 `turn.error` 输入，Core 仅对当前活动 Turn 发布不含原始错误正文的 `turn.retry` 状态；
模型文本或推理进展结束连续重试段，最终错误与官方 Turn 终态负责收尾。Gateway 不根据此通知重发请求或切换模型。
飞书、Telegram 与微信消费同一状态，渠道范围和投递限制见 [展示规则](display.md)。
此路径与 Gateway 到 App Server 的连接恢复独立；没有新增 RPC、协议字段或实验能力。
Bootstrap 按 Provider 连接代次淘汰旧连接排队的 Turn 开始、推理心跳与可重试错误，保留已接收的结果和终态；
自动恢复通过 Core 活动观察器让期间收到的实时终态优先于旧快照，防止恢复后重新显示已结束 Turn 的重试状态。
Core 在新 Turn、解绑、Thread 回退或关闭及连接中断时发布本地 `unavailable` 展示状态，不伪造官方 Turn 终态。
渠道收尾使用独立快照回执，状态编辑失败不影响持久结果；微信同 Turn 的提示预算跨断线保留。

Linux 隔离 Codex Home 中已用真实 App Server 与本机不可达模型地址观察：两次 `willRetry:true` 只产生一次重试展示，
随后 `willRetry:false` 和失败终态正确收尾；重试期间主动中断产生 `interrupted` 收尾。
将捕获的旧重试通知再次交给 Core 不产生新展示；将旧活动快照交给恢复观察器不会重新激活已中断 Turn。
复审时在真实重试通知后调用 Core 的定向断线入口，观察到 `retrying → unavailable`；再次重放捕获的通知新增展示为 0，活动 Turn 已清除，随后真实中断返回 `interrupted`。这验证本地断线处理入口，未模拟实际 Transport 断网。
观察经过真实 Client、Core 与共享渠道文案，未向外部平台发消息；平台发送/编辑、成功恢复后的实际输出与跨平台行为仍待观察。

## 本项目实现映射

CCG（CommandCode）复用已有 Responses Provider、模型设置和路由，不新增 App Server RPC；账户使用
`ccg-<accountId>` 隔离 Profile、Key、App Server、模型目录、统计代理和指标。
接口来源为 [CommandCode Provider 文档](https://commandcode.ai/docs/provider)，接入入口为
[`ccg-setup.mjs`](../scripts/ccg-setup.mjs)，模型由 [`provider-model-catalog.mjs`](../scripts/provider-model-catalog.mjs) 从 DS 完整目录生成，保留原模型并复用 Flash 内容增加 V4.1；写入前通过锁定 CLI 的 `debug models` 及其 `model_catalog_json` 解析验证完整格式；实现边界见
[`CCG`](ccg.md)。账户 Credits 使用官方 `command-code` CLI 1.62.1 当前调用的 Alpha 账户端点，公开
Provider 文档未列出该接口。

| 要查的问题 | 本项目入口 |
| --- | --- |
| CLI、运行中 App Server 和生成协议是否一致 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`protocol-info.ts`](../src/codex-client/protocol-info.ts)、[`doctor.mjs`](../scripts/doctor.mjs) |
| Unix WebSocket 如何连接并对齐原生 128 MiB 消息上限 | [`codex-client/`](../src/codex-client/README.md) |
| Windows Proxy 如何连接并在静默握手时有界清理 | [`windows-proxy-transport.ts`](../src/codex-client/windows-proxy-transport.ts)；Socket 目录由 [`app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs) 和 [`windows-private-acl.ps1`](../runtime/windows-private-acl.ps1) 对齐锁定版本 [`windows_socket_validation.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/uds/src/windows_socket_validation.rs) 的单条当前用户 OICI 完全控制 ACL；通用私有目录写入保留该更严格权限，不重新添加其他主体 |
| Desktop App 如何选择共享 App Server | [`Codex Desktop App 共享 App Server 实施方案`](codex-desktop-app-development.md)、[`desktop-app-bridge.mjs`](../runtime/desktop-app-bridge.mjs)、[`desktop-app-host.mjs`](../runtime/desktop-app-host.mjs)、[`desktop-app-command.mjs`](../scripts/desktop-app-command.mjs)、[`desktop-app-proxy.mjs`](../scripts/desktop-app-proxy.mjs)；`codexc app -p` / `--provider` 与 Remote 共用 [`provider-selection.mjs`](../scripts/provider-selection.mjs) 的完整 Provider ID / 已登记规范 `sf-*` Profile 名映射，将本次连接固定到已配置实例；省略选择连接主 OpenAI 实例。macOS 在 Pipe 附加前复用官方 `thread/loaded/list` 与 `thread/read` 检查目标实例全部已加载的持久及临时 Thread，并拒绝活动 Thread 或 Remote TUI 租约；主 OpenAI 路径已有实机验收，新增 Provider 选择在两平台均待实机验收，Windows 整体仍为预览 |
| Desktop、Remote 与渠道如何共用聚合目录 | [`aggregate-model-provider.mjs`](../runtime/aggregate-model-provider.mjs)、[`aggregate-material-guard.mjs`](../runtime/aggregate-material-guard.mjs)、[`aggregate-proxy.ts`](../src/provider-proxy/aggregate-proxy.ts)；至少两个已配置的 API Key 切换提供商派生按需 `codexc-aggregate`，包含受管与自定义成员，使用单个 App Server 与现有 Supervisor/Host；Desktop 和 Remote 使用 `-p` / `--provider` 的 `agg` 或 `sf-agg` 选择，拒绝内部 ID；任一选择值与已登记 Provider / Profile 重名时两种聚合选择均拒绝，自定义 `agg` 可明确用 `sf-custom-agg`，渠道经 `/model` 选择。精确 `<Provider ID>/<模型 slug>` 经 HTTP 路由到原 ProviderProxy/CLP 桥，每请求替换账户 Key，指标保留真实账户。只派生无密钥运行时目录，不新增 RPC；Gateway 监听源指纹，复用活动/租约门禁安全重建实例并确认目录，等待期间旧快照拒绝出站；拓扑变化仍须重启服务。锁定 0.164.0 [`step_settings.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/core/src/session/step_settings.rs) 的 `apply_update` 重读模型元数据，[`provider.rs`](https://github.com/openai/codex/blob/rust-v0.164.0/codex-rs/model-provider/src/provider.rs) 使用静态目录；此前 0.160.1 CLI 与本地可控模型服务已观察跨模型历史、工具结果和渠道绑定恢复，真实云端、外部渠道发送及 Desktop 工具仍待实机验收 |
| 聚合 Provider 配置冲突如何拒绝 | [`aggregate-model-provider.mjs`](../runtime/aggregate-model-provider.mjs) 在材料加载时拒绝主配置声明保留的 `model_providers.codexc-aggregate`，刷新重建先加载材料再释放旧实例；[`app-server-service-runtime.mjs`](../runtime/app-server-service-runtime.mjs) 在就绪前核对有效路由、隔离凭据变量和传输配置与本次启动一致，并拒绝额外查询参数、请求头、认证或模型目录 URL，避免配置冲突导致请求失败却确认就绪。主配置仍不进入材料监听或出站指纹 |
| JSON-RPC 如何分流和清理请求 | [`json-rpc.ts`](../src/codex-client/json-rpc.ts)；通知不附加本地统计计时，请求超时与诊断耗时保持独立 |
| Turn、Review 和 Goal 如何隔离官方协议 | [`turn-port.ts`](../src/application/turn-port.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) |
| Thread/Turn/Item 如何适配并归约 | [`notification-conversation-events.ts`](../src/codex-client/notification-conversation-events.ts)、[`input-events.ts`](../src/conversation-core/input-events.ts)、[`core.ts`](../src/conversation-core/core.ts) |
| 多 Provider Thread 如何选择 App Server | [`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts)、[`gateway-component-graph.ts`](../src/bootstrap/gateway-component-graph.ts)、[`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs) |
| Gateway 断线后如何恢复连接 | [`gateway-reconnect-coordinator.ts`](../src/bootstrap/gateway-reconnect-coordinator.ts)、[`binding-restore-coordinator.ts`](../src/bootstrap/binding-restore-coordinator.ts)；沿用 Client 初始化和 Router 订阅恢复，旧断线代次不能确认新一轮恢复，连接成功后的恢复失败不重复握手，正常退出与启动失败均取消恢复任务，停止后不继续恢复订阅或发布恢复结果；Provider 路由整体关闭取消在途启动与握手，拒绝晚到连接重新登记 |
| Unix Socket 布局如何验证 | [`app-server-unix-socket.mjs`](../runtime/app-server-unix-socket.mjs) 统一验证官方链接、目录和目标属主/权限；[`unix-websocket-transport.ts`](../src/codex-client/unix-websocket-transport.ts) 与 [`app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs) 只连接验证后的物理路径，残留处理只保留原链接 |
| 官方 Thread 如何进入稳定业务边界 | [`thread-adapter.ts`](../src/codex-client/thread-adapter.ts) 将官方 Thread 映射为稳定快照；会话列表中的模型和思考等级仅使用 Gateway Router 已知设置 |
| Thread 路由通知如何隔离 | [`notification-thread-state.ts`](../src/codex-client/notification-thread-state.ts)、[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) |
| Workspace、Conversation、Thread 如何绑定 | [`session-routing/`](../src/session-routing/README.md) |
| 模型、思考等级和 Fast 如何隔离并同步 | [`model-port.ts`](../src/application/model-port.ts)、[`model-adapter.ts`](../src/codex-client/model-adapter.ts)、[`thread-state-sync.ts`](../src/session-routing/thread-state-sync.ts) |
| 原生与第三方账户指标如何隔离和扩展 | [`account-port.ts`](../src/application/account-port.ts)、[`provider-account-service.ts`](../src/application/provider-account-service.ts)、[`account-adapter.ts`](../src/codex-client/account-adapter.ts)、[`deepseek-account-adapter.ts`](../src/bootstrap/deepseek-account-adapter.ts)、[`opencode-go-account-adapter.ts`](../src/bootstrap/opencode-go-account-adapter.ts) |
| 直接安装 Skill 查询与显式调用如何隔离 | [`skill-port.ts`](../src/application/skill-port.ts)、[`turn-port.ts`](../src/application/turn-port.ts)、[`skill-adapter.ts`](../src/codex-client/skill-adapter.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) |
| MCP 状态、OAuth 与资源读取如何隔离 | [`mcp-port.ts`](../src/application/mcp-port.ts)、[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`notification-account-events.ts`](../src/codex-client/notification-account-events.ts)、[`conversation-extension-query-service.ts`](../src/application/conversation-extension-query-service.ts)、[`core.ts`](../src/conversation-core/core.ts)；运行状态只读取当前 Thread 已发布连接快照，不触发探测或重连。OAuth 以当前基线 loginId、实际 Provider 与原会话关联完成，未关联通知不进入渠道；资源 URI 展示脱敏不改变读取参数 |
| Plugin 查询与 mention 调用如何隔离 | [`plugin-port.ts`](../src/application/plugin-port.ts)、[`plugin-adapter.ts`](../src/codex-client/plugin-adapter.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts) |
| Permission Profile 查询如何隔离 | [`permission-port.ts`](../src/application/permission-port.ts)、[`permission-adapter.ts`](../src/codex-client/permission-adapter.ts) |
| Server Request 如何适配并协调 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`approval/`](../src/approval/README.md)、各 Surface 的 `interactions.ts`；批量取消先撤销全部匹配请求再推进队列，准备中的交互立即释放身份和容量，取消信号贯穿 Surface 与发送队列，取消不等待平台清理，迟到决定不能恢复已取消请求 |
| 各模块如何装配和管理生命周期 | [`bootstrap/`](../src/bootstrap/README.md) |
| Telegram 如何适配核心事件 | [`surfaces/telegram/`](../src/surfaces/telegram/README.md) |
| 新通讯渠道如何按模块接入 | [`通讯渠道 Surface 接入指南`](surface-integration-guide.md)、[`surfaces/`](../src/surfaces/README.md) |
| 新第三方模型 Provider 如何接入 | [`第三方模型 Provider 接入指南`](provider-integration-guide.md)、[`model-provider-runtime.mjs`](../runtime/model-provider-runtime.mjs)、[`gateway-component-graph.ts`](../src/bootstrap/gateway-component-graph.ts) |

## 当前架构边界

当前协议隔离已经完成：`codex-protocol` 保存精确版本生成类型，`codex-client` 负责 Transport、
JSON-RPC、请求、通知和 Server Request 的协议适配；Application、Conversation Core、
Session Routing、Approval 和 Surface 只使用各自拥有的稳定类型与窄端口。生产源码只有
Client 可以导入 `codex-protocol`，模块依赖静态检查会阻止生成协议或具体 Client 再次泄漏。

内部模块继续遵守各目录 README 和根 `AGENTS.md` 的现行边界：StateStore 只保存最小绑定，
Policy 同时校验 Surface、账号、Actor 与 Workspace，Event Bus 和 Surface 输出使用有界队列，
Observability 统一脱敏，Config 严格失败关闭，Bootstrap 是唯一组合根。Gateway 停止只断开
Client 与 Surface，不终止共享 App Server。

## 查询顺序

1. 先从本页按问题找到官方概念和本项目模块。
2. 查协议字段时打开生成的 `ClientRequest.ts`、`ServerNotification.ts` 或 `ServerRequest.ts`，
   再沿具体类型文件查看参数，不能凭官方 `main` 分支或记忆手写字段。
3. 查行为语义时优先查看 `upstream/openai-codex-0.164.0` 中
   `rust-v0.164.0` 固定版本实现和测试，官方文档补充合同；本地副本缺失或基线不符时才使用上面的固定版本链接。
4. 查本项目行为时从模块 `index.ts` 和 README 进入，按改动运行静态检查并核对实际行为。

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

Config 文案说明：协议索引中的“Codex 用户设置”“一键配置全部”为历史称谓。当前入口统一使用“Codex 新会话与用户偏好”和“配置默认值与用户偏好”，后者合并模型、加速、权限与用户偏好，统一确认后批量写入；计划清单工具通过 Config 单独控制且默认关闭，TUI 空闲总结通过 Config 单独控制且默认写入关闭，Fast 仅对 OpenAI 官方主配置开放，默认值与用户偏好操作不会隐式修改联网搜索、分析、反馈或 Goals。

### CLP Chat 转换

CLP 复用现有 `thread/start.modelProvider`、`model/list` 和 Provider 路由，不增加 RPC。
CLP 共用目录由 [`cline-pass-account-management.mjs`](../scripts/cline-pass-account-management.mjs) 读取仓库 DS 模板，固定生成 Flash、Flash-1017 和 Pro 三个映射，不下载 Cline 官方模型元数据；渠道与 Relay 使用同一目录，模型窗口由所有 CLP 账户共用，不影响其他提供商。[按 ID 添加](cline-pass.md)可独立填写能力或从当前目录一次性继承完整配置及请求行为，仍向上游发送新模型 ID；请求配置通过本地目录条目的 `cline_request_profile` 明确保存，不添加 RPC 字段；可选的 `cline_provider_options` 提供模型级 `providerOptions` 覆盖，字段不设白名单，桥与 Relay 共用合并规则，同样不新增 RPC 字段。桥接受七种普通思考等级；目录声明开关时额外使用 `enabled`，基于锁定 Codex `protocol/src/openai_models.rs` 的 `ReasoningEffort::Custom` 和 `ReasoningEffortPreset`，沿用目录、模型选择及 Turn 既有字段。Flash 请求配置保留 `reasoning.effort`，未显式设置 `gateway.only` 时补 DeepSeek 默认路由；标准配置普通等级使用 `reasoning_effort`，关闭/开启使用 `reasoning.enabled=false/true`；没有显式配置时保留精确 Flash ID 的默认分支，思考选项必须属于当前启用目录。真实云端新增模型仍需分别验收。
受管 CLP 的 live `web_search` 经内部函数调用同账户 `/search/websearch`，在单一 Responses 生命周期内续答；合法混合调用先搜索，对同批尚未派发的客户端调用返回明确的内部 `not_executed` 工具结果，让模型结合来源后重新发起纯客户端调用，实际执行与审批仍由 Codex 负责。不缓存跨请求结果或增加私有 Responses 历史字段；其他未映射声明及选择仍透传。搜索历史仅保留锁定协议支持的查询，具体限制见 [CLP 网页搜索](cline-pass.md#网页搜索适配)。声明形态依据锁定源码 `tools/src/tool_spec.rs`、`tool_spec_tests.rs` 和 `core/tests/suite/web_search.rs`。
账户用量由 [`cline-pass-account-adapter.ts`](../src/bootstrap/cline-pass-account-adapter.ts) 查询 Cline 官方套餐额度接口，复用账户快照和窗口展示；
[`cline-pass-setup.mjs`](../scripts/cline-pass-setup.mjs) 按账户创建受管 Profile，注册表和默认账户复用共享校验与路由，模型目录和 Chat 代理按 Provider ID 独立；
[`model-api`](../src/model-api/README.md) 独立转换模型消息（含 `text.format` 的 `json_schema` 到 Chat `response_format` 映射），
[`chat-bridge.ts`](../src/provider-proxy/chat-bridge.ts) 提供服务拥有的本地 HTTP 适配。
依据锁定官方 `core/src/client.rs`、`protocol/src/models.rs` 与 `codex-api/src/sse/responses.rs` 的请求、条目和事件合同，
接受文本、用户内联图片、函数与自由格式工具、客户端 `tool_search`；工具结果里的内联图片不放进 Chat `tool` 消息，转成该组工具结果之后紧随的一条 `user` 消息图片段，并用相同的调用 ID 与图片序号标记关联原 `tool` 文本位置和图片；自由格式语法保留在 Chat 工具说明，CLP 模型目录声明 `apply_patch_tool_type: freeform` 与 `supports_search_tool`，检索结果按锁定 `tools/src/tool_search.rs` 的命名空间和 `defer_loading` 形态显式加载。`reasoning_content` 通过 `reasoning.content` 原文往返，Cline `reasoning` 通过摘要往返。图片沿用稳定 `UserInput.image` 与模型目录 `input_modalities`，不伪造加密推理或远程压缩语义；不完整终态保留已生成文本并拒绝执行部分工具调用。Chat 上游诊断通过请求级进程内回调写独立调用记录，不增加协议事件；HTTP 与流内错误经 [`chat-errors.ts`](../src/provider-proxy/chat-errors.ts) 映射为固定文案和白名单分类，`context_length_exceeded` 沿用锁定上游 SSE 的上下文错误语义。用户边界见 [`CLP`](cline-pass.md)。
原生 Responses 推理回传
第三方固定、切换入口的 HTTP／WS 出站保留 hosted `web_search` 与选择；受管 CLP Chat 桥对 live 搜索采用独立接口适配，通用 Chat 保持透传。聚合入口当前关闭。
内置搜索使用 Codex 的全局 `web_search` 及精确 Provider ID 的独立覆盖。CP v5 已保存的 `supportsWebSearch` 与编译快照字段 `supports_web_search` 保持可读及原样保存，仅作为历史元数据，不参与搜索门控；新模板不导入该字段。
锁定 CLI 的 `ModelInfo` 中，`web_search_tool_type` 只选形态，`supports_search_tool` 是客户端工具检索。
[`third-party-model-catalog.mjs`](../runtime/third-party-model-catalog.mjs) 仅在运行投影中关闭 Responses Lite，
启动同时关闭 standalone 搜索，确保使用模型 API 的 hosted 合同而非 OpenAI `/alpha/search`。
依据 `core/src/tools/spec_plan.rs`、`core/src/tools/hosted_spec.rs` 与 `ext/web-search/src/extension.rs`；
官方 OpenAI 和独立 Relay 不套用此策略；通用 Chat 声明不保证托管搜索的执行或回程，见 [DeepSeek](deepseek.md#网页搜索)。
DS 官方目录的无效 verbosity/摘要声明由 [`deepseek-setup.mjs`](../scripts/deepseek-setup.mjs) 调用共享纯数据层 [`model-catalog.mjs`](../runtime/model-catalog.mjs) 收紧，
已有目录经 [`deepseek-account-management.mjs`](../scripts/deepseek-account-management.mjs) 的显式配置事务更新。
客户端工具检索与跨轮推理的线上验证范围见
[DS 兼容性边界](deepseek.md#responses-兼容性边界) 与 [CLP 转换边界](cline-pass.md#chat-转换边界)。

### 渠道文本附件的工具读取

渠道文本附件使用现有 `turn/start` / `turn/steer` 文本输入提交暂存路径，不新增协议附件字段，
也不修改 Thread 的文件权限。共享存储见 `src/surfaces/text-attachment-store.ts`。自定义权限配置可能拒绝读取，应按现有审批流程处理。
