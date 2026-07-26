# Bootstrap

本目录是模块化单体的组合根，负责创建具体依赖并管理 Gateway 进程生命周期。

## 文件

- `index.ts`：向进程入口公开 `GatewayApplication`。
- `app.ts`：校验 Codex 版本，装配 Transport、Client、Core、Router 和 Storage；处理启动、重连、
  订阅恢复与关闭，并通过 Client 适配器把稳定事件分别转交 Core 与 `session-routing`、把
  Server Request 转交 Approval；未知或畸形 Notification 只记录 method 后忽略，未知或畸形
  高权限请求明确拒绝；受支持版本通过 Client 运行时信息读取，并把显示版本注入 Surface。
- `surface-plugin.ts`：定义编译期内置 Surface 插件、插件上下文和运行时模块契约，并校验插件 ID、
  实际 Surface ID 与账号实例唯一性。
- `surface-composition.ts`：显式注册 Telegram、飞书内置插件，并保留各平台访问策略、热加载钩子
  和故障上报装配。Telegram 插件始终创建一个实例；飞书插件只在严格运行配置启用时创建实例，
  并从现有授权绑定推导安全配置与启动通知会话。
- `config-lifecycle.ts`：管理配置监听、防抖重载、持久配置事件投递、信号与进程退出。
- `surface-manager.ts`：按 `surface + accountId` 向已启动 Surface 集中路由 Core 输出；按注册顺序启动
  Surface，失败时反向回滚，并隔离输出与关闭异常。

业务状态和平台逻辑应留在对应模块，只有具体实现选择、交互端口注册与生命周期协调放在这里。
新增内置 Surface 时实现一个 `BuiltInSurfacePlugin` 并加入显式注册表，不应向
`GatewayApplication` 添加平台专属字段。当前插件层只用于模块化单体内部装配，不扫描目录、
不动态导入包，也不是外部插件 API。
未启用 Surface 的持久绑定应保留但不恢复订阅。Gateway 关闭不得主动终止独立运行的 Codex App Server。
启动、停止和重连由同一生命周期协调；恢复订阅时会把 `thread/resume` 返回的活动 Turn 重新归约
到 Core。停止会中断启动中的 Codex 请求、取消并限时等待重连任务，且不会把主动关闭误判为永久
Thread 恢复失败。启动失败、启动中停止和正常停止共享同一个组件关闭任务；除中断未完成连接所需
的 Client 关闭外，Surface、事件总线、Client 收尾和存储不会被组合根重复关闭。
