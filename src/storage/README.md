# Storage

本目录保存 Telegram Conversation 与 Codex Thread 的最小业务映射，不复制 Codex 会话正文或完整历史。

## 文件

- `index.ts`：本模块的公开导出入口。
- `binding-store.ts`：定义 Conversation、Workspace、Thread 和必要偏好的存储接口。
- `memory-binding-store.ts`：用于测试和临时运行的内存实现。
- `sqlite-binding-store.ts`：单机 Gateway 使用的 SQLite 实现，负责 Schema、文件权限和持久恢复。

存储实现必须保持可替换。新增字段应只服务于绑定恢复或必要偏好；持久化格式变化需要迁移和回滚方案，不能读取或复制 `~/.codex/sessions`。
