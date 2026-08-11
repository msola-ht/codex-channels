# Policy

本目录集中处理用户和 Workspace 授权边界。

## 文件

- `index.ts`：本模块的公开导出入口。
- `conversation-actor.ts`：定义 Surface 查询和记录已授权 Conversation Actor 的窄接口。
- `surface-access.ts`：定义统一的 `target + actorId` 访问上下文和失败关闭的 Surface 授权接口。
- `feishu-access.ts`：校验飞书 Surface、App 账号和 `open_id` 精确允许名单，并支持原子替换。
- `telegram-access.ts`：实现统一授权接口，同时校验 Telegram Surface、Bot 账号和 Actor 允许名单，并支持原子替换热加载后的名单。
- `thread-section-access.ts`：按 `<surface>:<actorId>` 精确允许名单限制 App Server 全局 Thread 分区写操作；名单为空时失败关闭。
- `weixin-access.ts`：校验微信 Surface、机器人账号和微信用户 ID 精确允许名单，并支持原子替换。
- `workspace-registry.ts`：保存服务端预配置 Workspace，支持安全热加载新增项，并解析默认项和显式选择。

Surface 输入不能提交任意绝对工作目录；所有 Thread、Turn、Shell 和文件相关操作都必须使用 Registry 中已经授权的 Workspace。
具体 Surface 必须先通过自身的 `SurfaceAccessPolicy`，再记录 Actor 并调用 Application 命令或提交消息。
全局 Thread 分区写操作还必须让当前消息 Actor 通过独立的 `ThreadSectionAccessPolicy`；普通 Surface
允许名单不能隐式升级为全局目录管理员。
Registry 会复制并冻结已经通过配置边界验证的 Workspace；构造参数、列表结果或单项查询都不能
在注册后改写授权路径。热加载替换必须整体有效，失败时保留上一份 Registry。

Workspace 可携带可选的权限字段：`sandbox`、`approvalPolicy` 和 `permissions`。它们只描述该
Workspace 新建或恢复 Thread 时的 App Server 启动参数，不扩大 Registry 允许的工作目录范围；
`sandbox` 与 `permissions` 互斥由配置边界校验，Registry 只透传配置结果。
