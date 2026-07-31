# Session Routing

本目录维护外部 Conversation、Workspace 与 Codex Thread 的当前绑定和订阅状态。

## 文件

- `index.ts`：本模块的公开导出入口。
- `thread-port.ts`：定义 Thread 查询与生命周期窄端口，以及只包含路由、恢复和会话列表所需字段的
  稳定快照；固定状态以 `isPinned` 表示，运行中 Turn 以 `activeTurnId` 表示，恢复会话另携带
  模型 Provider、
  压缩 Item ID，不向业务层暴露完整官方 Turn。
- `router.ts`：选择、搜索、绑定、恢复、归档和解绑 Thread，协调持久化映射、订阅恢复、Provider/模型设置、
  压缩 Item ID 及 `thread/unsubscribe`；切换目标恢复成功后才解除当前绑定，启动恢复只有在 Thread 明确不存在、
  已删除或已归档时才移除持久化绑定；订阅恢复时把稳定 Thread 快照交回组合根。跨渠道接管只允许
  当前 Thread 与目标 Conversation 原 Thread 都由 App Server 报告为空闲时执行；保留被接管
  Thread 的现有订阅，只取消目标 Conversation 被替换 Thread 的订阅。跨 Provider 模型切换通过
  `newSession` 解除当前绑定并保留原 Thread，下一 Turn 以精确 Provider、模型和目录新建 Thread；
  不使用 `thread/fork` 复制 Provider 专属历史。
- `thread-state-sync.ts`：定义并消费不含协议信封的稳定 Thread 路由事件，同步模型、思考强度和
  服务层级，并在官方通知未携带不可变 Provider 时保留 Router 已确认的值；归档或删除事件会清理对应绑定，关闭事件只表示无订阅者的空闲 Thread 已从
  App Server 内存卸载，保留可恢复的持久化绑定。官方通知的校验和转换由 `codex-client` 完成。

自动接续前必须检查来源、Workspace、活动状态和是否被其他 Conversation 占用。App Server 响应是事实来源，Router 的缓存只用于路由和界面加速。
Gateway 重连或重启后，Client 必须从 `thread/resume` 返回的 `status` 与 `turns` 映射
`activeTurnId`，组合根再恢复仍在运行的 Turn，不能只恢复绑定，否则 steer、停止和下一 Turn
队列会误判为空闲。

本模块不得导入 `codex-client` 或 `codex-protocol`；具体 Client 由组合根作为
`ThreadLifecyclePort` 实现注入。
