# Session Routing

本目录维护外部 Conversation、Workspace 与 Codex Thread 的当前绑定和订阅状态。

## 文件

- `index.ts`：本模块的公开导出入口。
- `router.ts`：选择、搜索、绑定、恢复、归档和解绑 Thread，协调持久化映射、订阅恢复、模型设置及 `thread/unsubscribe`；订阅恢复时把 App Server 返回的 Thread 状态交回组合根。

自动接续前必须检查来源、Workspace、活动状态和是否被其他 Conversation 占用。App Server 响应是事实来源，Router 的缓存只用于路由和界面加速。
Gateway 重连或重启后，组合根必须从 `thread/resume` 返回的 `status` 与 `turns` 恢复仍在运行的
Turn，不能只恢复绑定，否则 steer、停止和下一 Turn 队列会误判为空闲。
