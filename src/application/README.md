# Application

本目录实现跨模块用例，协调 Codex Client、Conversation Core、Session Router 和模型设置，不处理 Telegram SDK 或底层 Transport。

## 文件

- `index.ts`：本模块的公开导出入口。
- `conversation-command-service.ts`：定义平台无关的会话命令名称，解析参数并返回结构化结果；不包含平台文案或消息布局。
- `conversation-service.ts`：新建、恢复、切换、归档和查询 Thread，提交、steer 或将纯文本
  排到下一 Turn，并公开 Conversation 状态与最近 Turn 产物。
- `model-selection-service.ts`：查询模型与思考强度，保存按 Conversation 生效的 Turn 覆盖设置；
  Fast 切换同时通过 Codex Client 保存用户级默认层级，与原生 CLI 的重启行为一致。

Surface 应通过这里的用例接口驱动会话，不应直接拼装 JSON-RPC。Thread 的权威状态仍来自 App Server，本模块只编排请求和必要的本地选择。
下一 Turn 队列按 Conversation 隔离、每个会话最多 10 条且只保存在内存中；`turn.completed`
后一次启动一条，Thread 变化或启动失败时清空，不能把消息正文写入 StateStore。
扩展查询也保持平台无关：Skill 只返回当前用户或 Workspace 直接安装且已启用的项，排除系统和插件缓存内容；Plugin 只读取已安装项，不触发远端市场目录刷新。
成功启动 Turn 后，模型、思考强度和服务层级以 App Server 的 Thread 设置为准；Gateway 重启时通过恢复 Thread 重新取得这些设置。
命令成功文案、命令菜单说明和平台交互形式由各 Surface 维护，并通过类型穷尽检查保持完整。
`/whoami`、交互取消、图片下载等平台能力不属于通用会话命令，继续由具体 Surface 实现。
