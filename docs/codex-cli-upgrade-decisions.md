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
  README 在 npm 与 GitHub Release 均成功前继续保留 `0.146.1` 为当前正式版
- 评估范围：Thread 分区迁移、MCP 扩展与鉴权状态、Plugin 搜索和安装、审批模式、外部会话导入，
  以及安全、终端与运行时修复

### 已采用

| 变化 | 它是做什么的 | 项目收益与处理 | 本地入口或验证 |
| --- | --- | --- | --- |
| 0.147.0 精确协议基线 | 让 Gateway、App Server 和生成类型保持在同一正式版本 | 重新生成协议并同步 Gateway、CI、固定源码与真实合同版本；不保留 0.146.1 兼容分支 | [`codex-protocol/`](../src/codex-protocol/README.md)、[`ci.yml`](../.github/workflows/ci.yml)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 内置 Pinned 分区 | 用持久分区统一承载旧版的会话置顶状态，并支持服务端排序 | `/pin`、`/unpin` 的公开行为不变；Gateway 原样回写当前 Git SHA，无损协调刚创建的加载中 Thread，再用官方固定 ID 移入或移出内置 Pinned 分区，并从 `Thread.section` 投影稳定 `isPinned`，不增加本地状态或写请求重试 | [`client.ts`](../src/codex-client/client.ts)、[`thread-adapter.ts`](../src/codex-client/thread-adapter.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| MCP 鉴权未知状态 | 在 App Server 尚不能确定 MCP 服务的认证方式时明确显示未知，而不是把整个响应当成错误 | `/mcp` 保留官方 `unknown` 状态并继续拒绝协议之外的值，避免一个未完成探测的服务阻断整页状态 | [`mcp-port.ts`](../src/application/mcp-port.ts)、[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| MCP 扩展协商 | 客户端在连接时明确告诉 App Server 自己能处理哪些扩展表单 | 初始化使用 `extensions["openai/form"]` 声明现有三渠道已实现的扩展表单处理，替代依赖旧式隐含或兼容协商 | [`json-rpc.ts`](../src/codex-client/json-rpc.ts)、[`server-request-adapter.ts`](../src/codex-client/server-request-adapter.ts)、[`json-rpc.test.ts`](../tests/json-rpc.test.ts) |
| MCP 详情、健康检查、配置刷新、OAuth 与资源读取 | 查看 Server 工具、资源和模板，只列出需要处理的状态，在不重启 App Server 的情况下重新加载配置，并启动认证或读取只读资源 | 三渠道共用 `/mcp` 子命令；`/mcp health` 基于 App Server 状态生成有界处理提示，不冒充逐个远端网络探测；`/mcp reload` 通过稳定 `config/mcpServer/reload` 刷新全部受管 Provider 实例，任一实例失败时整体报错；OAuth 不自动重试且只显示安全授权 URL，文本资源限长，二进制不外发，直接 Tool Call 仍留在 Turn 与审批边界内 | [`mcp-port.ts`](../src/application/mcp-port.ts)、[`mcp-adapter.ts`](../src/codex-client/mcp-adapter.ts)、[`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts)、[`conversation-command-service.ts`](../src/application/conversation-command-service.ts)、[`provider-routing-client.test.ts`](../tests/provider-routing-client.test.ts)、[`real-app-server.test.ts`](../tests/real-app-server.test.ts) |
| 开发中 Plugin 已安装列表与 mention 调用 | 调试当前 Workspace 已安装 Plugin，并把选中项作为官方 mention 输入交给 Turn | `[experimental].plugin_api` 默认开启且可显式关闭，Doctor 和命令输出持续标记开发中；只支持 OpenAI Thread，不接入搜索、安装、卸载或分享 | [`plugin-port.ts`](../src/application/plugin-port.ts)、[`plugin-adapter.ts`](../src/codex-client/plugin-adapter.ts)、[`turn-adapter.ts`](../src/codex-client/turn-adapter.ts)、[`conversation-service.test.ts`](../tests/conversation-service.test.ts) |

### 待评估

| 候选能力 | 它是做什么的 | 对项目可能有什么用 | 实施边界与重新评估条件 |
| --- | --- | --- | --- |
| 自定义 Thread 分区 | 把会话按工作、个人或其他名称分组，并手工排序 | 长期会话较多时比单一置顶列表更容易整理 | 分区属于整个 App Server 的全局状态，当前无法按 Workspace 或 Surface Actor 证明查看、改名和删除权限；只有建立不泄露其他 Workspace 名称且不维护第二事实来源的授权模型后才重新评估，现阶段只采用内置 Pinned 分区 |
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

## 后续使用

处理下一个正式版本时：

1. 先阅读目标版本官方 Release，只筛选与当前项目有关的变化。
2. 对照本页上一版本的 `待评估` 项，确认新版本是否补齐实施条件、废弃相关协议或改变优先级。
3. 完成协议和业务适配后新增版本章节，不静默修改旧版本结论。
4. 把本次 `已采用`、`待评估`、`明确不采用` 和 `纯上游变化` 摘要写入升级 PR。
5. 以 [`Codex CLI 升级流程`](codex-cli-upgrade.md) 完成验证、合并和发布边界检查。
