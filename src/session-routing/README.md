# Session Routing

本目录维护外部 Conversation、Workspace 与 Codex Thread 的当前绑定和订阅状态。

## 文件

- `index.ts`：本模块的公开导出入口。
- `router.ts`：选择、搜索、绑定、恢复、归档和解绑 Thread，协调持久化映射、订阅恢复、模型设置及
  `thread/unsubscribe`；切换目标恢复成功后才解除当前绑定，启动恢复只有在 Thread 明确不存在、
  已删除或已归档时才移除持久化绑定；订阅恢复时把 App Server 返回的 Thread 状态交回组合根。
- `thread-state-sync.ts`：消费 App Server 的完整 `thread/settings/updated`，同步模型、思考强度和
  服务层级；归档或删除通知会清理对应绑定，`thread/closed` 只表示无订阅者的空闲 Thread 已从
  App Server 内存卸载，保留可恢复的持久化绑定。未知或残缺通知不推断本地状态。

自动接续前必须检查来源、Workspace、活动状态和是否被其他 Conversation 占用。App Server 响应是事实来源，Router 的缓存只用于路由和界面加速。
Gateway 重连或重启后，组合根必须从 `thread/resume` 返回的 `status` 与 `turns` 恢复仍在运行的
Turn，不能只恢复绑定，否则 steer、停止和下一 Turn 队列会误判为空闲。
