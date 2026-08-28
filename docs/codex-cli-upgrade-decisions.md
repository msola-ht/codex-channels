# Codex CLI 升级决策记录

本页记录 Codex CLI 正式版本更新对 `codex-channels` 的长期影响和项目取舍。官方更新内容以
[`openai/codex` Releases](https://github.com/openai/codex/releases) 为准；本页不复制完整更新日志，
只保存已经核实的项目决策，供后续实现、升级和回归审查使用。

## 维护规则

- 每次正式升级都新增一个版本章节，先引用对应官方 Release，再记录项目结论。
- 状态只使用：`已采用`、`待评估`、`明确不采用`、`纯上游变化`。
- 每项先用一句不依赖协议术语的说明解释“它让用户或管理员能做什么”，再记录项目收益和技术边界；
  不能只列 RPC、类型名或字段。
- `已采用` 必须指向本地入口或说明这是随锁定 App Server 自动获得的内部修复。
- `待评估` 必须写清用户价值、实施边界和重新评估条件；条件未满足时不进入实现。
- `明确不采用` 必须说明与当前架构、权限或产品范围不符的原因；后续需求改变时可以在新版本章节
  重新评估，不回写旧版本的历史结论。
- 生成协议出现类型或 RPC 不代表项目支持。公开能力仍以 [`docs/index.md`](index.md) 的支持矩阵、
  受控导出、业务入口和验证共同为准。

## 0.145.0

- 官方 Release：[`rust-v0.145.0`](https://github.com/openai/codex/releases/tag/rust-v0.145.0)
- 项目开发基线：Gateway、生成协议、真实 App Server 合同与发布包锁定 `0.145.0`
- 评估范围：稳定 Multi-Agent v2、一次性音频输入、Thread 查询、实验分页历史与搜索、Realtime、
  外部 Agent 导入、Bedrock，以及 MCP、安全与终端修复

### 已采用

| 变化 | 它是做什么的 | 项目收益与处理 | 本地入口或验证 |
| --- | --- | --- | --- |
| 0.145.0 精确协议基线 | 让 Gateway、App Server 和生成类型保持在同一正式版本 | 项目发布时锁定正式版本，不保留旧 CLI 兼容分支 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 稳定 Multi-Agent v2 | 让主 Thread 按配置启动、观察和协调不同角色的子代理 | Gateway 只消费官方子代理活动、工具状态和子 Thread 终态，不复制代理调度；三个 Surface 统一显示有界操作与完成结果 | [`operation-adapter.ts`](../src/codex-client/operation-adapter.ts)、[`subagent-completion-tracker.ts`](../src/bootstrap/subagent-completion-tracker.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts) |
| 一次性音频输入 | 把受支持的本地音频作为单次 Turn 输入提交给模型 | 三个 Surface 统一完成格式、时长、大小和私有临时文件校验；Application 在提交前继续按模型目录的 `inputModalities` 失败关闭，当前可见模型未声明 `audio` 时不会假装可用 | [`turn-port.ts`](../src/application/turn-port.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts)、[`model-selection-service.test.ts`](../tests/model-selection-service.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 会话标题搜索 | 按持久化会话名称或提取标题筛选当前 Workspace 的可恢复 Thread | `/sessions [搜索词]` 与 `/archived [搜索词]` 使用稳定 `thread/list.searchTerm`，不读取或搜索对话正文 | [`thread-port.ts`](../src/session-routing/thread-port.ts)、[`conversation-command-service.ts`](../src/application/conversation-command-service.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts) |
| Default/Plan 协作模式 | 让渠道用户在下一 Turn 使用官方 Default 或 Plan 预设 | 作为唯一允许的实验协议例外，只受控使用 `collaborationMode/list` 与 `turn/start.collaborationMode`，不借初始化协商接入其他实验能力 | [`collaboration-mode-port.ts`](../src/application/collaboration-mode-port.ts)、[`client.ts`](../src/codex-client/client.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |

### 明确不采用

| 上游能力 | 它是做什么的 | 当前不采用原因 |
| --- | --- | --- |
| 分页 Thread 历史与正文搜索 | 增量读取长会话的 Turn/Item，并搜索对话正文 | `thread/search`、`thread/searchOccurrences`、`thread/turns/list` 和 `thread/items/list` 均为实验方法；项目唯一实验例外是 Plan，Gateway 也不建立平行历史库 |
| Realtime | 持续传输实时文字或音频 | 未建立实时授权、传输、状态和三 Surface 合同，且当前业务边界明确禁止 `thread/realtime/*` |
| Cursor、Claude Code 配置与会话导入 | 把其他 Agent 的设置、历史和项目记忆迁入 Codex | App Server 是 Thread 和会话历史的唯一事实来源；Gateway 不读取、复制或迁移其他 Agent 的会话数据 |
| Amazon Bedrock | 使用 Bedrock 登录、模型和自定义传输 | 当前 Provider 范围只有 OpenAI 和显式配置的 DeepSeek；新增 Provider 必须先建立独立认证、模型目录、统计和错误边界 |
| Plugin 查询、市场与安装 | 查询、发现或安装本地及远端 Plugin | 0.145.0 评估时未采用；后续只在 0.147.0 决策中增加受开关约束的已安装列表与 mention 调试，市场、搜索和安装仍不采用 |

### 纯上游变化

- MCP 启动超时、OAuth 非阻塞发现、刷新串行化和工具目录复用随锁定 App Server 获得；Gateway
  不复制 MCP 连接池。
- TUI 长会话渲染、Windows 执行与 Sandbox、macOS Code Mode 安装、强制删除识别和审批原因保留
  不新增 Gateway 协议入口。

## 0.146.0

- 官方 Release：[`rust-v0.146.0`](https://github.com/openai/codex/releases/tag/rust-v0.146.0)
- 项目开发基线：Gateway、生成协议和 CI 锁定 `0.146.0`；README 保留 npm 当前正式版，
  发布包在 Runner 临时渲染，GitHub Release 与 npm 均成功后再自动写回 `main`
- 评估范围：CLI/TUI、App Server 协议、App Server 内部修复及其对现有 Gateway 路径的影响

### 已采用

| 变化 | 它是做什么的 | 项目收益与处理 | 本地入口或验证 |
| --- | --- | --- | --- |
| `PlanType` 新增 `ent26` | 识别一种新的企业账户套餐名称 | 企业账户的用量、额度和账户通知不再落入未知类型，三个 Surface 统一显示为 Enterprise | [`account-adapter.ts`](../src/codex-client/account-adapter.ts)、[`account-format.ts`](../src/surfaces/account-format.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`surface-copy-contract.test.ts`](../tests/surface-copy-contract.test.ts) |
| Thread 固定 | 像置顶聊天一样，把重要 Codex 会话固定在会话列表前面 | 三个 Surface 共用 `/pin`、`/unpin`；会话列表固定项优先，状态只保存在 App Server，不进入 StateStore | [`conversation-service.ts`](../src/application/conversation-service.ts)、[`client.ts`](../src/codex-client/client.ts)、[`conversation-command-service.test.ts`](../tests/conversation-command-service.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 分页 Thread 历史 Fork 修复 | 从一个很长的会话复制出新分支时，能够带上完整历史，而不是只复制当前已加载的一段 | 现有 `/fork` 继续使用稳定 `thread/fork`，长会话历史处理随锁定 App Server 获得上游修复；不新增平行 Fork 实现 | [`client.ts`](../src/codex-client/client.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts) |
| MCP 配置、认证刷新与断线重连修复 | 外部工具连接在登录或配置变化、连接断开后可以自动更新和恢复，少依赖手工重启 | `/mcp` 状态、MCP 工具和审批继续由 App Server 管理，Gateway 不复制连接池或刷新状态；升级后自动获得运行时稳定性修复 | [`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 代理、消息恢复和 App Server 序列化修复 | 让代理网络下的连接更可靠，减少中断后消息或最终结果丢失，并降低 App Server 处理消息的开销 | 现有连接、通知和恢复路径直接受益，不新增 Gateway 兼容层；仍由真实合同和渠道回归验证最终行为 | [`codex-client/`](../src/codex-client/README.md)、[`conversation-core/`](../src/conversation-core/README.md)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |

### 待评估

| 候选能力 | 它是做什么的 | 对项目可能有什么用 | 实施边界与重新评估条件 |
| --- | --- | --- | --- |
| 长会话 Fork 真实合同 | 验证从长会话复制新分支时，新分支历史完整，原会话仍可正常继续 | 避免 `/fork` 在历史很多时出现缺内容、绑错会话或订阅异常 | 只补合同和路由验证，不为了制造长历史调用模型；有可重复 Fixture 或出现实际回归时实施 |
| Plugin 命令来源展示 | 在审批或运行记录中告诉用户“这条命令由哪个 Plugin 的哪个脚本发起” | 用户更容易判断命令是否可信，审批信息也更清楚 | 只有官方取消 Plugin API 的生产禁用，并让审批请求直接携带或由真实合同证明可可靠关联可信 `pluginId`、`scriptPath` 时才重新评估；当前不通过 Item 时序推断审批来源 |

### 明确不采用

| 上游能力 | 它是做什么的 | 当前不采用原因 |
| --- | --- | --- |
| External Agent 配置和会话导入 | 把其他编程 Agent 的配置、会话和导入历史迁入 Codex | App Server 是 Thread 和历史的唯一事实来源；Gateway 不读取、迁移或维护其他 Agent 的会话副本 |
| Plugin Marketplace、分享和 Workspace 发布 | 从远端目录查找或下载 Plugin，并把本地 Plugin 分享给个人或工作区 | 固定版本 Plugin API 仍禁止生产客户端调用；下载、发布和分享还会扩大网络、供应链信任与 Workspace 权限边界 |
| Remote Code Mode Host | 让本机 App Server 把代码执行任务交给另一台机器或远程执行环境 | 当前只连接本机共享 App Server；远程执行主机需要独立认证、网络和执行信任模型 |
| 自定义 Provider 独立联网搜索 | 让声明兼容能力的第三方 Responses Provider 执行独立 `web.run` 搜索 | 上游要求 Provider 显式声明 `supports_standalone_web_search` 并实现搜索端点；当前受管第三方只透传各自 `/responses` 内建搜索，自定义 Provider Setup 也没有该能力和端点合同，因此不开放配置或路由 |
| 临时 Fork | 创建一个短期会话分支，但不把它显示在正常会话列表中 | 外部 Conversation 需要稳定、可恢复且唯一的 Thread 绑定；不进入列表的临时 Thread 不适合作为渠道会话 |
| Realtime | 持续传输实时文字或音频，形成低延迟实时会话 | 当前项目只允许 Plan 所需实验协议，未建立实时音频的授权、传输、状态和 Surface 合同 |
| 企业配置要求和配置写入 | 让企业管理员限制更新、登录 Shell、日志目录、数据目录、Browser Use 等主机行为 | 外部聊天用户不得修改 Codex 管理策略或主机级配置；这些能力不应通过聊天渠道暴露 |

### 纯上游变化

- TUI 键盘、窄屏、超链接、Mention、侧边会话和终端渲染改进由原生 `codex` 直接提供，Gateway
  不复制终端界面。
- Windows 导航、Sandbox 进程树和私有桌面相关变化不进入当前 macOS/Linux Gateway 实现。
- OpenAI 托管安装源、发布渠道元数据、macOS 辅助程序签名和公证属于 Codex CLI 分发流程，
  不改变本项目 npm 发布或服务部署边界。

## 0.146.1

- 官方 Release：[`rust-v0.146.1`](https://github.com/openai/codex/releases/tag/rust-v0.146.1)
- 项目开发基线：Gateway、生成协议、真实 App Server 合同与固定源码索引锁定 `0.146.1`；
  README 在 npm 与 GitHub Release 均成功前继续保留 `0.146.0` 为当前正式版
- 评估范围：0.146.1 的安全修复及生成协议新增的模型目录字段

### 已采用

| 变化 | 它是做什么的 | 项目收益与处理 | 本地入口或验证 |
| --- | --- | --- | --- |
| 0.146.1 精确协议基线 | 让 Gateway 始终连接和验证同一正式版本的 Codex App Server | 重新生成协议并同步 Gateway、CI、固定源码与真实合同版本；不保留 0.146.0 兼容分支 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`ci.yml`](../.github/workflows/ci.yml)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |

### 明确不采用

| 上游能力 | 它是做什么的 | 当前不采用原因 |
| --- | --- | --- |
| `Model.modelSpecialty` 业务展示 | 让客户端读取模型面向特定任务的专长标签 | 生成协议保留官方必填字段，但当前模型选择只依赖可见性、输入能力、思考等级和服务层级；没有明确的 Surface 展示或路由需求，因此不把该字段导出到 Application |

### 纯上游变化

- 网络安全能力模型的自动审核采用更安全的默认值，并在终端解释权限变化。Gateway 不启用
  `--approve-for-me`，命令、文件、网络和额外权限仍走现有显式审批，因此不新增协议入口或自动批准路径。

## 0.147.0

- 官方 Release：[`rust-v0.147.0`](https://github.com/openai/codex/releases/tag/rust-v0.147.0)
- 项目开发基线：Gateway、生成协议、真实 App Server 合同与固定源码索引锁定 `0.147.0`；
  准备正式发布时先把 README 当前正式版与安装命令同步到 `0.147.0`，通过 main CI 后再创建 Tag
- 评估范围：Thread 分区迁移、MCP 扩展与鉴权状态、Plugin 搜索和安装、审批模式、外部会话导入，
  以及安全、终端与运行时修复

### 已采用

| 变化 | 它是做什么的 | 项目收益与处理 | 本地入口或验证 |
| --- | --- | --- | --- |
| 0.147.0 精确协议基线 | 让 Gateway、App Server 和生成类型保持在同一正式版本 | 重新生成协议并同步 Gateway、CI、固定源码与真实合同版本；不保留 0.146.1 兼容分支 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`ci.yml`](../.github/workflows/ci.yml)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 内置 Pinned 分区 | 用持久分区统一承载旧版的会话置顶状态，并支持服务端排序 | `/pin`、`/unpin` 的公开行为不变；Gateway 原样回写当前 Git SHA，无损协调刚创建的加载中 Thread，再用官方固定 ID 移入或移出内置 Pinned 分区，并从 `Thread.section` 投影稳定 `isPinned`，不增加本地状态或写请求重试 | [`client.ts`](../src/codex-client/client.ts)、[`thread-adapter.ts`](../src/codex-client/thread-adapter.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 自定义 Thread 分区与会话目录筛选 | 用 App Server 全局分区整理长期会话，并按运行状态、固定、未分区、Provider、分区或关键词分页查找 | 新增共享 `/section` 和增强的 `/sessions`、`/archived`；分区 CRUD 使用稳定 `threadSection/*`，移动与 `beforeThreadId` 排序使用稳定 `thread/section/move`，分区视图按官方 `section_position` 展示，关键词查询扫描完整历史并保留完整目录选择器。全局目录写操作只允许 `thread_sections.administrators` 显式配置的 Actor，未配置时失败关闭；三渠道持续显示全局影响，内置 Pinned 不可变，删除要求二次确认且不删除 Thread；Gateway 不复制分区状态，不增加写重试 | [`client.ts`](../src/codex-client/client.ts)、[`conversation-service.ts`](../src/application/conversation-service.ts)、[`conversation-command-service.ts`](../src/application/conversation-command-service.ts)、[`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP 鉴权未知状态 | 在 App Server 尚不能确定 MCP 服务的认证方式时明确显示未知，而不是把整个响应当成错误 | `/mcp` 保留官方 `unknown` 状态并继续拒绝协议之外的值，避免一个未完成探测的服务阻断整页状态 | [`mcp-port.ts`](../src/application/mcp-port.ts)、[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| MCP 扩展协商 | 客户端在连接时明确告诉 App Server 自己能处理哪些扩展表单 | 初始化使用 `extensions["openai/form"]` 声明现有三渠道已实现的扩展表单处理，替代依赖旧式隐含或兼容协商 | [`json-rpc.ts`](../src/codex-client/json-rpc.ts)、[`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| MCP 详情、健康检查、配置刷新、OAuth 与资源读取 | 查看 Server 工具、资源和模板，只列出需要处理的状态，在不重启 App Server 的情况下重新加载配置，并启动认证或读取只读资源 | 三渠道共用 `/mcp` 子命令；工具目录和实际 Tool Item 保留 0.147.0 的 `readOnlyHint`，明确区分上游标记只读、可能写入和未知，但不据此跳过审批；`/mcp health` 基于 App Server 状态生成有界处理提示，不冒充逐个远端网络探测；`/mcp reload` 通过稳定 `config/mcpServer/reload` 刷新全部受管 Provider 实例，任一实例失败时整体报错；OAuth 不自动重试且只显示安全授权 URL，文本资源限长，二进制不外发，直接 Tool Call 仍留在 Turn 与审批边界内 | [`mcp-port.ts`](../src/application/mcp-port.ts)、[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`operation-adapter.ts`](../src/codex-client/operation-adapter.ts)、[`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts)、[`conversation-command-service.ts`](../src/application/conversation-command-service.ts)、[`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 开发中 Plugin 已安装列表、健康摘要、详情与 mention 调用 | 调试当前 Workspace 已安装 Plugin，以有界分页和本地过滤查看目录，只关注需处理状态，查看同一已安装响应中的版本、来源、安装时间、开发者、分类、能力、认证时机、可用原因和适用套餐标识，并把选中项作为官方 mention 输入交给 Turn | `[experimental].plugin_api` 默认关闭且只在显式开启时可用，Doctor 和命令输出持续标记开发中；列表每页 8 项，健康问题、能力与套餐各有界展示 8 项，本地过滤保留全局序号且不调用实验 `plugin/search`；详情不调用其他 Plugin API，不展示来源路径、远端 URL、图标、截图、默认提示词或原始 Marketplace 错误；只支持 OpenAI Thread，不接入 Marketplace 搜索、安装、卸载或分享 | [`plugin-port.ts`](../src/application/plugin-port.ts)、[`plugin-adapter.ts`](../src/codex-client/plugin-adapter.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts) |

### 待评估

| 候选能力 | 它是做什么的 | 对项目可能有什么用 | 实施边界与重新评估条件 |
| --- | --- | --- | --- |
| MCP 2026-07-28 客户端能力 | 支持分页发现、多轮请求和非阻塞服务器启动 | 大型 MCP 工具目录和启动较慢的服务可能更稳定 | 当前 Gateway 通过 App Server 查询和调用，不直接实现 MCP Client；只有生成协议新增必须协调的状态或 Server Request，或真实合同暴露差异时再扩展稳定边界 |

### 明确不采用

| 上游能力 | 它是做什么的 | 当前不采用原因 |
| --- | --- | --- |
| Agent Plugin 搜索、安装和远端目录 | 从本地、个人、Workspace 或远端目录发现并安装可移植 Plugin | 固定版本官方文档仍禁止生产客户端调用 Plugin API，且 `plugin/search` 另被标记为实验方法；搜索和安装还会扩大网络访问、供应链与 Workspace 授权边界 |
| `--approve-for-me` 自动审核 | 让另一个模型代替用户判断部分审批 | Gateway 的命令、文件、网络和权限审批必须由当前 Surface Actor 显式决定，不能把一次批准静默升级为自动授权 |
| Cursor、Claude 会话与技能导入 | 把其他客户端管理的会话或技能迁入 Codex 并持续同步 | App Server 是 Thread 和历史的唯一事实来源；Gateway 不读取、复制或同步其他客户端的会话数据 |

### 纯上游变化

- 命令与历史中的密钥、完整 Bearer Token 脱敏，项目可信目录校验、Plugin 隔离和网络策略失败关闭
  随锁定 App Server 获得；Gateway 保留自身输入授权、日志脱敏和失败关闭边界。
- 终端输入、日文、Emoji、超链接、视口和 Ghostty 修复由原生 Codex TUI 获得，Gateway 不复制
  终端渲染。
- Windows 进程与路径修复、Bedrock 缓存搜索和远端压缩、依赖升级、macOS 公证及发布归档调整
  不改变当前 Gateway 的公开接口或 npm 分发流程。

## 0.148.0

- 官方 Release：[`rust-v0.148.0`](https://github.com/openai/codex/releases/tag/rust-v0.148.0)
- 项目开发基线：Gateway、生成协议、真实 App Server 合同与固定源码索引锁定 `0.148.0`；
  README 当前正式版和安装命令在发布准备完成前继续保留 `0.147.0`
- 评估范围：持久 Thread 提交队列、Thread 历史回退、进程诊断、Thread 用量、图片生成额度失败、
  模型与自动审核元数据、MCP OAuth 与 Plugin 归属、Hook 扩展、Bedrock，以及会话恢复和安全修复

### 已采用

| 变化 | 它是做什么的 | 项目收益与处理 | 本地入口或验证 |
| --- | --- | --- | --- |
| 0.148.0 精确协议基线 | 让 Gateway、App Server 和生成类型保持在同一正式版本 | 重新生成协议并同步 Gateway、CI、固定源码与真实合同版本；不保留 0.147.0 兼容分支 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`ci.yml`](../.github/workflows/ci.yml)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 图片生成额度失败摘要 | 把 `ImageGenerationItem.failure=usageLimitExceeded` 作为结构化失败返回 | 只显示有界的“图片生成额度已用尽”，不外发上游内部限额 ID，不推断未声明的重置时间单位；成功产物仍只使用官方 `savedPath` | [`operation-adapter.ts`](../src/codex-client/operation-adapter.ts)、[`operation-adapter.test.ts`](../tests/operation-adapter.test.ts) |
| 微信运行版本标识统一 | 让微信 `base_info.bot_agent` 与实际 Gateway 包版本一致 | 生产客户端从统一 `src/version.json` 读取版本，避免后续 CLI 升级遗漏手写常量；独立合同探针继续显式锁定当前版本 | [`protocol-client.ts`](../src/surfaces/weixin/protocol-client.ts)、[`weixin-protocol-client.test.ts`](../tests/weixin-protocol-client.test.ts) |
| `account/usage/read.threadId` 与 `threadUsage` | 查询一个 OpenAI Thread 的官方估算 Credit、可选美元和用量分组 | 复用现有 `/usage`：账户摘要保持主结果，当前 OpenAI Thread 的估算并行读取且失败隔离；没有 Thread 或使用第三方 Provider 时保持原行为。官方估算不写入指标库、不与 `/metrics` 参考费用合并，也不宣称递归包含子代理 | [`Thread 官方用量开发设计`](thread-usage-development.md)、[`account-adapter.ts`](../src/codex-client/account-adapter.ts)、[`provider-account-service.test.ts`](../tests/provider-account-service.test.ts) |
| `misalignmentPolicyViolation` 结构化错误 | 用固定协议枚举表示 Turn 因安全策略不一致而终止 | Client 只识别该精确枚举并向 Core 传递窄分类；三渠道完成卡片统一显示固定、脱敏且可操作的中文提示，指标保留独立错误分类与代码，`willRetry=false` 与 `failed` 终态保持不变；其他 `CodexErrorInfo` 继续沿用现有脱敏自由文本 | [`notification-adapter.ts`](../src/codex-client/notification-adapter.ts)、[`core.ts`](../src/conversation-core/core.ts)、[`turn-error-metrics.ts`](../src/bootstrap/turn-error-metrics.ts)、[`lifecycle-presentation.ts`](../src/surfaces/lifecycle-presentation.ts)、结构化错误真实合同 [`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP Server `pluginId` 来源展示 | 标识 MCP Server 是否由某个 Plugin 提供 | Client 在协议边界校验可空、长度受限且符合固定上游 `<plugin>@<marketplace>` 字符规则的 Plugin ID；只在 `/mcp` 详情显示来源，不用于授权、审批、命令/脚本来源推断或 OAuth 参数。OAuth 仍使用自动发现 | [`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`mcp-port.ts`](../src/application/mcp-port.ts)、[`conversation-command-format.ts`](../src/surfaces/conversation-command-format.ts) |
| 模型多代理运行时与生命周期提示 | 从稳定 `model/list` 读取 `multiAgentVersion`、结构化替代模型和退役时间 | `/model` 只读显示当前 Codex 多代理运行时；带替代信息的 OpenAI 模型显示建议模型与 UTC 退役日期，不转发 Markdown/链接，不自动禁用或切换，不改变审批；第三方 Provider 不继承 OpenAI 生命周期 | [`model-adapter.ts`](../src/codex-client/model-adapter.ts)、[`model-port.ts`](../src/application/model-port.ts)、[`model-selection-service.ts`](../src/application/model-selection-service.ts)、[`conversation-command-format.ts`](../src/surfaces/conversation-command-format.ts) |
| 实验 `thread/queue/*` 与 `thread/queue/changed` | 用 App Server 持久 Queue 替换 Gateway 内存队列，对齐六个原生请求、每 Thread 100 条容量和 25/100 分页 | 不保留第二套队列；Gateway 只负责 Actor、Workspace、Conversation 归属、Provider 路由和安全展示；本地契约与条件式真实 App Server 合同见 [`Thread Queue 与 Revert 开发设计`](thread-queue-revert-development.md) | [`queue-adapter.ts`](../src/codex-client/queue-adapter.ts)、[`thread-queue-port.ts`](../src/application/thread-queue-port.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 实验 `thread/revert` 与 `thread/reverted` | 在 Queue 替换后独立采用 Thread 历史回退 | 新建 Thread 使用 `paginated` history，并通过分页 Turn 列表选择回退边界；既有 legacy Thread 不迁移；回退一次性确认、执行前复核且明确不会恢复文件，Queue 联合语义以条件式真实 App Server 合同门禁验证，详细设计见 [`Thread Queue 与 Revert 开发设计`](thread-queue-revert-development.md) | [`history-adapter.ts`](../src/codex-client/history-adapter.ts)、[`thread-history-port.ts`](../src/application/thread-history-port.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |

### 待评估

| 候选能力 | 它是做什么的 | 对项目可能有什么用 | 实施边界与重新评估条件 |
| --- | --- | --- | --- |
| 受管模型自动审核要求 | 描述企业或受管环境要求自动审核的模型范围 | 可改进受管环境提示 | 当前审批仍由 Surface Actor 显式决定；不新增 `configRequirements/read` 依赖，不让受管要求自动批准、拒绝或改变模型可选性 |
| MCP 单次 OAuth 注册策略 | 允许登录时选择自动发现、动态注册或预注册客户端 | 可为少数 OAuth 注册兼容性问题提供显式覆盖 | 当前 OAuth 自动发现路径工作正常，且没有用户选择和凭据配置边界；不扩展 OAuth 参数或凭据策略 |
| Thread 分区外观 | 为自定义 Thread 分区保存跨客户端同步的图标和颜色 | 可让渠道中的分区目录与原生客户端使用相同的视觉标识 | 当前 `/section` 只投影分区名称，创建和重命名时省略 `appearance`，因此不会覆盖其他客户端已有设置；只有三个 Surface 形成统一、安全且有明确用户需求的图标或颜色展示规则时再扩展 Application 类型与写入命令 |

### 明确不采用

| 上游能力 | 它是做什么的 | 当前不采用原因 |
| --- | --- | --- |
| 实验 `server/diagnostics` | 读取 App Server 进程、资源和活动快照 | 当前 Doctor 已有受控健康检查，新增进程诊断没有公开需求，还会扩大运维信息暴露面 |
| 异步命令与 MCP Tool Hook | 让 Hook 在后台执行命令或调用 MCP 工具 | Gateway 不提供 Hook 管理界面；命令和 MCP 调用必须保持现有 Turn、审批和 Surface Actor 归属，不建立旁路执行入口 |
| Amazon Bedrock Runtime Provider | 通过 AWS 凭据和区域使用内置 Bedrock 模型 | 当前受管 Provider 只有 OpenAI、DeepSeek 与 OpenCode Go；接入 Bedrock 需要新的凭据、模型目录、定价、服务隔离和部署边界，不属于本次协议升级 |


### 纯上游变化

- 模型切换和活动 Turn 设置保持稳定、恢复会话时还原持久 CWD 与审批策略、Provider 临时中断重连、
  MCP OAuth 重新认证恢复，均由锁定 App Server 提供；现有 Gateway 路由和审批接口无需复制实现。
- Linux 与 Windows 对拒绝或不可读路径继续失败关闭；Gateway 保留自身 Workspace 授权、Socket 权限、
  日志脱敏和显式审批边界。
- TUI Markdown 导出、`codex exec fork`、恢复选择器归档、启动时草拟提示词和 Thread 费用状态属于
  原生 Codex 客户端；Gateway 不实现第二套终端会话界面。
- Hook、Skill Creator、TUI 渲染、Windows 运行时与发布打包修复不改变 Gateway 的公开接口、
  持久化 Schema 或 npm 分发流程。

## 0.149.0

- 官方 Release：[`rust-v0.149.0`](https://github.com/openai/codex/releases/tag/rust-v0.149.0)
- 项目开发基线：本次累计升级的一部分，最终与 `0.150.1` 一起锁定
- 评估范围：队列唤醒、权限 Profile 恢复、子代理通知、TUI 任务管理、工作目录命令和诊断增强

### 已采用

| 变化 | 它是做什么的 | 项目收益与处理 | 本地入口或验证 |
| --- | --- | --- | --- |
| 队列唤醒与会话恢复修复 | 让排队消息能唤醒空闲会话，并在恢复/Fork 时保留原权限 | 现有 Thread Queue、Session 恢复和 Workspace 权限链路随 App Server 自动受益，不增加 Gateway 兼容层 | [`thread-queue-port.ts`](../src/application/thread-queue-port.ts)、[`session-routing/`](../src/session-routing/)、真实 App Server 合同 |
| 子代理通知去重与路由修复 | 避免同一子代理活动重复显示，并把通知送回正确的父会话 | 现有子代理完成通知直接受益，继续由 Core 归约，不复制调度状态 | [`subagent-completion-tracker.ts`](../src/bootstrap/subagent-completion-tracker.ts)、[`notification-adapter.test.ts`](../tests/notification-adapter.test.ts) |

### 明确不采用

| 上游能力 | 它是做什么的 | 当前不采用原因 |
| --- | --- | --- |
| `codex agents` 任务面板 | 在终端搜索、启动、重命名和停止任务 | 属于原生 TUI，不复制第二套终端界面到渠道 |
| `/cd`、`/pwd`、`/cwd` | 在终端会话中切换或查看工作目录 | Gateway 只允许预配置 Workspace，不能通过聊天输入任意目录 |
| SDK 原始配置覆盖 | 让 SDK 调用者直接传入任意 CLI 配置覆盖 | Gateway 只接受受控命令、Workspace 与配置事务，不向渠道暴露任意 `-c` 覆盖；`max`、`ultra` 或其他思考等级如果由稳定 `model/list` 对具体模型明确声明，仍会按现有模型目录自然显示和校验，不属于原始覆盖能力 |
| 第三方 Provider 官方 Turn 费用遥测 | 从兼容上游读取单个 Turn 的官方费用估算 | 该能力要求第三方上游实现对应费用端点和认证合同；当前 `/metrics` 使用 Provider Proxy 的实际 Token 与价格快照，`/usage` 也不把本机参考费用冒充上游账单，因此不接入 |

### 纯上游变化

- 原生 `codex queue` 通过同一 `thread/queue/add` 向本机或显式 Remote App Server 提交文字；Gateway
  已有 `/queue` 和 Queue 通知归约，不再复制一个 `codexc queue` 入口。
- Doctor 网络/桌面诊断、Vim、Windows Terminal 和 TUI 渲染改进由原生 CLI 提供，不改变 Gateway 公开接口。

## 0.149.1

- 官方 Release：[`rust-v0.149.1`](https://github.com/openai/codex/releases/tag/rust-v0.149.1)
- 项目开发基线：作为 `0.149.x` 补丁版本随累计协议升级进入 `0.150.1`

### 纯上游变化

- 官方 Release 未列出新的用户可见功能或本项目需要适配的业务协议；保留精确版本链路，不新增本地入口。

## 0.150.0

- 官方 Release：[`rust-v0.150.0`](https://github.com/openai/codex/releases/tag/rust-v0.150.0)
- 项目开发基线：本次累计升级的一部分，最终与 `0.150.1` 一起锁定
- 评估范围：Project、MCP 事件流、Realtime、Bedrock、Browser/Computer Use、任务引用和安全修复

### 已采用

| 变化 | 它是做什么的 | 项目收益与处理 | 本地入口或验证 |
| --- | --- | --- | --- |
| 不可信项目与凭据安全修复 | 防止不可信项目指令越权，并减少 App Server 日志中的敏感信息 | 随锁定 App Server 自动获得；Gateway 继续执行自身 Workspace 授权、日志脱敏和显式审批 | [`policy/`](../src/policy/)、[`observability/`](../src/observability/)、真实 App Server 合同 |
| MCP 启动与 Unix 关闭修复 | 让 MCP 启动更可靠，并减少关闭时被子进程拖住 | 现有 MCP 状态与服务生命周期直接受益，不建立旁路连接池 | [`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、服务生命周期测试 |
| 新账户套餐与认证枚举 | 识别 Business Premium、Enterprise Automation、Edu Plus、Edu Pro 和 AWS Access Keys 登录 | 按 0.150.1 生成类型补齐窄业务联合与显示名，避免合法账户或额度通知被当作无效响应；这只保证协议兼容，不表示项目接入 Bedrock Provider | [`account-port.ts`](../src/application/account-port.ts)、[`account-adapter.ts`](../src/codex-client/account-adapter.ts)、[`account-format.ts`](../src/surfaces/account-format.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| Skill 的 Plugin 归属 | 由 App Server 明确指出一个 Skill 是否来自 Plugin | Skill 列表改用稳定 `SkillMetadata.pluginId` 排除 Plugin Skill，不再从安装路径猜测来源；开发中 Plugin 仍通过独立入口调用 | [`skill-adapter.ts`](../src/codex-client/skill-adapter.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| 多代理新增动作与中断状态 | 识别发送消息、追加任务、中断和列表等新动作，并正确显示被中断的工具调用 | 操作适配继续保留官方动作名，Surface 提供统一中文标题；`CollabAgentToolCallStatus.interrupted` 归为失败，不再冒充成功 | [`operation-adapter.ts`](../src/codex-client/operation-adapter.ts)、[`operation-presentation.ts`](../src/surfaces/operation-presentation.ts)、[`operation-adapter.test.ts`](../tests/operation-adapter.test.ts) |
| 命令审批种类失败关闭 | 区分启动命令与向现有终端写入输入的审批 | 旧服务未发送 `kind` 时仍按命令处理；0.150.1 的 `kind=command` 正常进入现有审批，`writeStdin` 和未知值在没有独立预览与交互合同前直接拒绝 | [`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`approval.test.ts`](../tests/approval.test.ts) |

### 待评估

| 候选能力 | 它是做什么的 | 对项目可能有什么用 | 实施边界与重新评估条件 |
| --- | --- | --- | --- |
| `subAgentActivity.completed` 终态 | 把晚于父 Turn 完成的子代理成功结果重新关联到发起 Turn | 可减少 Bootstrap 仅依赖子 Thread 通知和收敛窗口的复杂度，并改善同级代理继续任务的归属 | 当前适配器有意忽略该新增枚举，仍用子 Thread 精确 Turn 终态结算；只有真实合同确认父活动、子 Turn、等待 Item 和指标写入的顺序及去重规则后，才替换现有终态来源，不并行维护两套成功判断 |
| MCP 运行时状态与资源来源 | 读取每个 MCP Server 的真实连接状态，并把 App 专属资源关联回原始 Tool Call | 可让 `/mcp health` 区分未启动、连接中、需认证、失败和禁用，也能安全处理 Hosted App 资源 | 当前资源命令只读取用户明确选择的通用 Server URI，未携带 `originCallId` 或 `connectorId`；运行时状态虽为稳定只读字段，但接入前要先定义三渠道统一状态和处理建议，并补真实失败/重连合同，不把状态字段当作主动网络探测 |

### 明确不采用

| 上游能力 | 它是做什么的 | 当前不采用原因 |
| --- | --- | --- |
| Project API 与项目事件 | 创建、移动、删除并同步 App Server 项目 | Project 是单个 App Server 内的实验 Thread 整理对象，不能替代 Workspace 的 cwd 授权、Sandbox、审批或 Permission Profile；当前也不建立跨 Provider 的第二套 Project 状态 |
| Realtime | 提供持续实时文字或音频会话 | 尚无音频输出、连接恢复、状态归约和三渠道实时传输合同 |
| Amazon Bedrock | 通过 AWS 凭据、区域和托管策略使用模型 | 当前受管 Provider 没有 Bedrock 的凭据、模型目录、计价和隔离服务边界；接受新增认证枚举不等于接入 Provider |
| Browser/Computer Use | 让模型操作浏览器或桌面，并读取企业管控要求 | 当前没有对应工具入口、屏幕与输入隐私边界、网络和持久审批合同；不读取仅为这些能力服务的配置要求 |
| TUI 任务引用与管理工具 | 用 `@` 引用其他任务，并让 TUI 动态工具管理会话 | 这是原生 TUI 在其客户端连接上注册的动态工具和 mention 编码；Gateway 不复制 TUI 工具命名空间，也不把外部 Conversation 暴露为可跨 Session 读取的任务目录 |
| Interrupt Hook 与额外 Plugin 能力 | 在 Turn 中断时执行命令或 MCP Handler | Hook 可脱离正常 Turn 工具审批路径运行；Gateway 不提供 Hook 配置或旁路执行入口 |
| MCP 事件流 | 订阅 Hosted App MCP 的持续事件 | 0.150.0 方法和通知仍为实验能力，且现有 `/mcp` 只需要状态、详情、资源与 OAuth；没有消费事件正文的业务入口，不创建订阅 |
| `writeStdin` 审批 | 审批向一个已运行终端写入输入 | 输入可能包含交互式确认或敏感内容，且现有审批卡片只展示命令；在建立独立预览、一次性请求 ID 和三渠道合同前保持失败关闭 |

### 纯上游变化

- 子代理完成活动的父 Turn 与同级代理路由修复随 App Server 获得；Gateway 当前仍以子 Thread 的
  精确 Turn 终态作为成功结算事实来源，新增 `completed` 活动按上面的待评估边界处理。
- TUI `/copy`、自动命名、快捷键、Windows Sandbox 与内部 Guardian 优化不改变 Gateway 公开接口。

## 0.150.1

- 官方 Release：[`rust-v0.150.1`](https://github.com/openai/codex/releases/tag/rust-v0.150.1)
- 项目开发基线：Gateway、生成协议、真实 App Server 合同与 CI 锁定 `0.150.1`；README 当前正式版在发布准备前保持不变
- 评估范围：远程压缩图片 Token 预算修复和精确补丁版本基线

### 已采用

| 变化 | 它是做什么的 | 项目收益与处理 | 本地入口或验证 |
| --- | --- | --- | --- |
| 0.150.1 精确协议基线 | 让 Gateway、App Server 和生成类型保持同一正式版本 | 重新生成协议并同步 Gateway、CI 和固定源码索引；不保留旧 CLI 兼容分支 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 远程压缩图片预算修复 | 长会话压缩时正确计算保留图片占用的 Token | 随锁定 App Server 自动获得，不新增 Gateway 业务逻辑或图片历史副本 | [`conversation-core/`](../src/conversation-core/README.md)、真实 App Server 合同 |

### 纯上游变化

- 本补丁没有新增 Gateway 业务协议；0.149.x–0.150.0 的取舍保留在各自章节，不在补丁章节重复记录。

## 后续使用

处理下一个正式版本时：

1. 先阅读目标版本官方 Release，只筛选与当前项目有关的变化。
2. 对照本页上一版本的 `待评估` 项，确认新版本是否补齐实施条件、废弃相关协议或改变优先级。
3. 完成协议和业务适配后新增版本章节，不静默修改旧版本结论。
4. 把本次 `已采用`、`待评估`、`明确不采用` 和 `纯上游变化` 摘要写入升级 PR。
5. 以 [`Codex CLI 升级流程`](codex-cli-upgrade.md) 完成验证、合并和发布边界检查。
