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
| Plugin 命令来源展示 | 在审批或运行记录中告诉用户“这条命令由哪个 Plugin 的哪个脚本发起” | 用户更容易判断命令是否可信，审批信息也更清楚 | 固定协议必须能把可信 `pluginId`、`scriptPath` 与当前请求安全关联；项目准备展示 Plugin 审批且真实合同证明关联可靠时再实施 |

### 明确不采用

| 上游能力 | 它是做什么的 | 当前不采用原因 |
| --- | --- | --- |
| External Agent 配置和会话导入 | 把其他编程 Agent 的配置、会话和导入历史迁入 Codex | App Server 是 Thread 和历史的唯一事实来源；Gateway 不读取、迁移或维护其他 Agent 的会话副本 |
| Plugin Marketplace、分享和 Workspace 发布 | 从远端目录查找或下载 Plugin，并把本地 Plugin 分享给个人或工作区 | 当前只查询 `plugin/installed`；下载、发布和分享会扩大网络、供应链信任与 Workspace 权限边界 |
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

## 后续使用

处理下一个正式版本时：

1. 先阅读目标版本官方 Release，只筛选与当前项目有关的变化。
2. 对照本页上一版本的 `待评估` 项，确认新版本是否补齐实施条件、废弃相关协议或改变优先级。
3. 完成协议和业务适配后新增版本章节，不静默修改旧版本结论。
4. 把本次 `已采用`、`待评估`、`明确不采用` 和 `纯上游变化` 摘要写入升级 PR。
5. 以 [`Codex CLI 升级流程`](codex-cli-upgrade.md) 完成验证、合并和发布边界检查。
