# Application

本目录实现跨模块用例，协调 Codex Client、Conversation Core、Session Router 和模型设置，不处理 Telegram SDK 或底层 Transport。

## 文件

- `index.ts`：本模块的公开导出入口。
- `conversation-command-service.ts`：定义平台无关的会话命令名称，解析参数并返回结构化结果；不包含平台文案或消息布局。
- `conversation-service.ts`：新建、恢复、切换、归档和查询 Thread，提交、steer 或将纯文本
  排到下一 Turn，公开 Conversation 状态与最近 Turn 产物，并通过注入端口把项目规则操作限制
  到当前授权 Workspace；扩展查询通过 `ConversationQueryPort` 组合窄端口，Skill、MCP 与
  Plugin 和 Permission Profile 均使用稳定结果。
- `model-selection-service.ts`：查询模型与思考强度，保存按 Conversation 生效的 Turn 覆盖设置；
  Fast 切换同时通过模型窄端口保存用户级默认层级，与原生 CLI 的重启行为一致。
- `model-port.ts`：定义项目拥有的模型目录、思考强度、服务层级与 Fast 默认值写入窄端口；
  Application 和 Surface 不接收完整官方模型对象。
- `account-port.ts`：定义账户 Token 用量、额度窗口、Credits 与消费控制的稳定查询结果；
  多额度桶和官方重置券响应由 Client 在边界裁剪。
- `skill-port.ts`：定义已直接安装 Skill 的稳定名称与说明查询，不向 Surface 暴露路径、Scope、
  依赖或上游扫描错误。
- `mcp-port.ts`：定义 MCP Server 名称、认证状态与工具数量的稳定查询摘要，不向 Surface 暴露
  Server Info、工具 Schema、资源清单或完整官方响应。
- `plugin-port.ts`：定义已安装 Plugin 的稳定名称与启用状态查询，不向 Surface 暴露 Marketplace、
  本机路径、版本、安装策略或完整官方响应。
- `permission-port.ts`：定义 Permission Profile 的稳定 ID、说明和策略可选状态查询；只表示
  当前 Workspace 可见目录，不授予权限，也不承载审批决定。
- `turn-port.ts`：定义项目拥有的 Turn 输入、设置覆盖、Review 目标、Goal 结果与执行窄端口；
  Application 不构造官方 `UserInput`，也不接收完整官方 Turn 响应。

Surface 应通过这里的用例接口驱动会话，不应直接拼装 JSON-RPC。Thread 的权威状态仍来自 App Server，本模块只编排请求和必要的本地选择。
下一 Turn 队列按 Conversation 隔离、每个会话最多 10 条且只保存在内存中；`turn.completed`
后一次启动一条，Thread 变化或启动失败时清空，不能把消息正文写入 StateStore。
扩展查询也保持平台无关：Skill 只返回当前用户或 Workspace 直接安装且已启用的项，排除系统和插件缓存内容；MCP 只返回展示所需的稳定摘要，并按当前 Thread 读取项目级配置；Plugin 只返回已安装项的稳定摘要，不触发 `plugin/list` 市场目录查询。
成功启动 Turn 后，模型、思考强度和服务层级以 App Server 的 Thread 设置为准；Gateway 重启时通过恢复 Thread 重新取得这些设置。
Turn、steer、停止、重命名、压缩、Review 和 Goal 只依赖 `TurnExecutionPort`；当前版本官方字段由
`codex-client` 负责映射。
模型选择和 Fast 只依赖 `ModelSelectionPort`；不可见模型过滤、官方模型字段裁剪以及
`config/read` / `config/batchWrite` 的版本差异由 `codex-client` 处理。
账户用量和额度查询只依赖 `AccountQueryPort`；Application、Bootstrap 和 Surface 不解析
`account/usage/read` 或 `account/rateLimits/read` 的完整官方响应。
Skill 查询只依赖 `SkillQueryPort`；用户和项目直接安装项的筛选由 Client 适配器在协议边界完成。
MCP 查询只依赖 `McpQueryPort`；分页、Thread 配置上下文与官方清单裁剪由 Client 适配器处理。
Plugin 查询只依赖 `PluginQueryPort`；已安装过滤与 Marketplace 响应裁剪由 Client 适配器处理。
Permission Profile 查询只依赖 `PermissionQueryPort`；CWD、分页和官方响应裁剪由 Client 处理。
命令成功文案、命令菜单说明和平台交互形式由各 Surface 维护，并通过类型穷尽检查保持完整。
项目规则命令只接受 `init` 或 `check`；Application 负责选择 Workspace，具体文件与进程操作由
Bootstrap 注入的运行时实现完成。远程入口不得提供强制覆盖。
`/whoami`、交互取消、图片下载等平台能力不属于通用会话命令，继续由具体 Surface 实现。
