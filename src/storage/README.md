# Storage

本目录保存外部 Conversation 与 Codex Thread 的最小业务映射，不复制 Codex 会话正文或完整历史。

## 文件

- `index.ts`：本模块的公开导出入口。
- `binding-store.ts`：定义 Conversation、Workspace、Thread 和必要偏好的存储接口。
- `memory-binding-store.ts`：用于测试和临时运行的内存实现。
- `sqlite-binding-store.ts`：单机 Gateway 使用的 SQLite 实现，负责当前 Schema、Unix owner-only 权限、
  Windows 当前 SID 私有 ACL 和持久恢复。
- `sqlite-session-display-cache.ts`：独立的会话展示缓存 SQLite 实现，保存状态和最近一次权威轮数结果，
  使用独立 Schema；缓存损坏或版本不兼容时失败关闭，不修改绑定数据库。

Conversation 使用 `surface + accountId + conversationId` 作为复合身份；每个 Conversation 最多
有一个前台绑定，并可保存有界的运行中后台绑定；一个 Codex Thread 仍只能归属一个外部
Conversation。空闲 Thread 的跨渠道接管在同一个 SQLite 事务中移除原绑定、释放目标 Conversation
原绑定并写入新绑定。数据库必须使用当前 Schema v5；其他版本会失败关闭，不执行自动迁移。
标记为当前版本但缺少必需表或字段的数据库同样会失败关闭，不执行自动补表或修补。

授权操作者通过独立的 Conversation→Actor 关联保存，不从群聊或私聊的 Conversation ID
推断用户身份。无法确认操作者或已撤权的会话会解除绑定，避免恢复订阅后继续向未授权会话输出。
Actor 清理和解绑由存储实现原子完成。存储公开枚举已知 Conversation；`/new` 或跨 Provider
`/model` 暂时解除 Thread 绑定时，授权身份与 Workspace 仍可用于安全的渠道生命周期通知。

Schema v5 保留原 `conversation_bindings` 前台表，并新增
`conversation_background_bindings` 与 `conversation_idle_state`。
`conversation_idle_state` 按 `surface + accountId + conversationId` 保存最近一次可观测输入或
输出的时间，以及下一次普通消息必须新建 Thread 的持久化标记；前台绑定删除与强制新建标记在同一
事务中原子写入，常规活动以一分钟粒度写库，
强制新建标记会立即写库，确保 Gateway 重启后普通消息仍不会自动接续已释放的旧 Thread。
撤权导致所有绑定时也会原子写入强制新建标记，重新授权后的普通消息仍从新会话开始。
Schema v3 和 v4 只能在 Gateway 停止后通过 `codexc update` 统一预检、显式备份并升级；
单库排障也可使用 `codexc state upgrade`。回滚可恢复命令输出的原版本备份；升级后产生的
后台绑定与空闲活动记录不会回填到旧版本，App Server Thread 不会被删除。

存储实现必须保持可替换。新增字段应只服务于绑定恢复或必要偏好；持久化格式变化必须明确当前数据的重建或升级方式，不能静默兼容未知 Schema，也不能读取或复制 `~/.codex/sessions`。

会话展示缓存位于 Gateway 数据目录的 `session-display-cache.sqlite3`。它只缓存由 App Server
`thread/list` 和 `thread/turns/list` 产生的状态、筛选元数据及轮数，用于 `/r` 和清理预览避免重复读取
历史；轮数缓存五分钟后重新向 App Server 校验。发送新消息会立即使对应轮数失效，官方
`turn/completed` 到达后自动对该 Thread 异步回填；归档 Thread 会删除对应缓存。
