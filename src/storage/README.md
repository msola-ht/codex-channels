# Storage

本目录保存外部 Conversation 与 Codex Thread 的最小业务映射，不复制 Codex 会话正文或完整历史。

## 文件

- `index.ts`：本模块的公开导出入口。
- `binding-store.ts`：定义 Conversation、Workspace、Thread 和必要偏好的存储接口。
- `memory-binding-store.ts`：用于测试和临时运行的内存实现。
- `sqlite-binding-store.ts`：单机 Gateway 使用的 SQLite 实现，负责当前 Schema、文件权限和持久恢复。

Conversation 使用 `surface + accountId + conversationId` 作为复合身份；一个 Codex Thread
只能绑定一个外部 Conversation。数据库必须使用当前 Schema v3；其他版本会失败关闭，不执行自动迁移。

授权操作者通过独立的 Conversation→Actor 关联保存，不从群聊或私聊的 Conversation ID
推断用户身份。无法确认操作者或已撤权的会话会解除绑定，避免恢复订阅后继续向未授权会话输出。
Actor 清理和解绑由存储实现原子完成。

存储实现必须保持可替换。新增字段应只服务于绑定恢复或必要偏好；持久化格式变化必须明确当前数据的重建或升级方式，不能静默兼容未知 Schema，也不能读取或复制 `~/.codex/sessions`。
