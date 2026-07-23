# Storage

本目录保存外部 Conversation 与 Codex Thread 的最小业务映射，不复制 Codex 会话正文或完整历史。

## 文件

- `index.ts`：本模块的公开导出入口。
- `binding-store.ts`：定义 Conversation、Workspace、Thread 和必要偏好的存储接口。
- `memory-binding-store.ts`：用于测试和临时运行的内存实现。
- `sqlite-binding-store.ts`：单机 Gateway 使用的 SQLite 实现，负责 Schema、文件权限、持久恢复和版本迁移。

Conversation 使用 `surface + accountId + conversationId` 作为复合身份；一个 Codex Thread
仍只能绑定一个外部 Conversation。Schema v3 会把 v2 Telegram 数据无损迁移到 `default` 账号。
迁移前会使用 SQLite `VACUUM INTO` 创建同目录、权限为 `0600` 的
`<数据库路径>.v2-backup`，已有备份不会覆盖且必须验证为 v2。需要回退旧版时，应先停止 Gateway，
再用该备份恢复原数据库。

授权操作者通过独立的 Conversation→Actor 关联保存，不从群聊或私聊的 Conversation ID
推断用户身份。旧 v2 私聊仅在 Conversation ID 与当前允许用户一致时补录 Actor；无法确认
操作者的旧群聊或已撤权私聊会解除绑定，避免恢复订阅后继续向未授权会话输出。Actor 清理和解绑
由存储实现原子完成。

存储实现必须保持可替换。新增字段应只服务于绑定恢复或必要偏好；持久化格式变化需要迁移和回滚方案，不能读取或复制 `~/.codex/sessions`。
