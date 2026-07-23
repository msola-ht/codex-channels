# Policy

本目录集中处理用户和 Workspace 授权边界。

## 文件

- `index.ts`：本模块的公开导出入口。
- `conversation-actor.ts`：定义 Surface 记录已授权 Conversation Actor 的窄接口。
- `surface-access.ts`：定义统一的 `target + actorId` 访问上下文和失败关闭的 Surface 授权接口。
- `telegram-access.ts`：实现统一授权接口，校验 Telegram Actor 是否在允许列表中，并支持原子替换热加载后的名单。
- `workspace-registry.ts`：保存服务端预配置 Workspace，支持安全热加载新增项，并解析默认项和显式选择。

Telegram 输入不能提交任意绝对工作目录；所有 Thread、Turn、Shell 和文件相关操作都必须使用 Registry 中已经授权的 Workspace。
具体 Surface 必须先通过自身的 `SurfaceAccessPolicy`，再记录 Actor 并调用 Application 命令或提交消息。
