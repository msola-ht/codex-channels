# Session Routing

本目录维护外部 Conversation、Workspace 与 Codex Thread 的前台绑定、后台绑定和订阅状态。

## 文件

- `index.ts`：本模块的公开导出入口。
- `thread-port.ts`：定义 Thread 查询与生命周期窄端口，以及只包含路由、恢复和会话列表所需字段的
  稳定快照；快照保留 App Server 返回的 `historyMode`（`legacy` 或 `paginated`），新建 Thread 使用分页
  历史，既有 legacy Thread 不宣称支持 Revert；官方分区裁剪为稳定 `id/name/builtIn`，内置 Pinned 另投影为 `isPinned`，运行中 Turn 以 `activeTurnId` 表示，恢复会话另携带
  模型 Provider、
  压缩 Item ID，不向业务层暴露完整官方 Turn。
- `router.ts`：选择、搜索、绑定、恢复、归档和解绑 Thread，把 Workspace 权限（沙箱、审批策略、
  权限 Profile）作为启动参数传给新建或恢复的 Thread，协调持久化映射、订阅恢复、Provider/模型设置、
  压缩 Item ID 及 `thread/unsubscribe`；切换目标恢复成功后才解除当前绑定，启动恢复只有在 Thread 明确不存在、
  已删除或已归档时才移除持久化绑定；订阅恢复时把稳定 Thread 快照交回组合根。跨渠道接管只允许
  当前 Thread 与目标 Conversation 原 Thread 都由 App Server 报告为空闲时执行；保留被接管
  Thread 的现有订阅，只取消目标 Conversation 被替换 Thread 的订阅。跨 Provider 模型切换通过
  `newSession` 解除当前绑定并保留原 Thread，下一 Turn 由对应 App Server 以精确 Provider 和模型新建 Thread；
  不使用 `thread/fork` 复制 Provider 专属历史。自动接续收到渠道保留的 Provider 时只恢复相同
  Provider 的候选 Thread；没有兼容候选时按该 Provider 新建，避免把模型交给错误的 App Server。

运行中的前台 Thread 在 `/resume` 或 `/new` 切换时转为后台绑定，保持 App Server 订阅与原
Conversation 归属；新输入只路由到前台 Thread。后台 Turn 完成后先与原生 Queue 的自动派发
协调；Queue 已启动下一 Turn、仍有排队条目或 Thread 仍为活动状态时保留绑定，只有权威状态确认
空闲后才取消订阅并移除后台绑定，Thread 历史仍由 App Server 保存。Gateway 恢复时同时恢复前台与后台订阅；若后台
Thread 已在离线期间结束，只提示通过 `/resume` 查看，不伪造或重放完成事件。
- `thread-state-sync.ts`：定义并消费不含协议信封的稳定 Thread 路由事件，同步模型、思考等级和
  服务层级，并在官方通知未携带不可变 Provider 时保留 Router 已确认的值；归档或删除事件会清理对应绑定，关闭事件只表示无订阅者的空闲 Thread 已从
  App Server 内存卸载，保留可恢复的持久化绑定。官方通知的校验和转换由 `codex-client` 完成。

自动接续前必须检查来源、Workspace、活动状态和是否被其他 Conversation 占用。App Server 响应是事实来源，Router 的缓存只用于路由和界面加速。
Gateway 重连或重启后，Client 必须从 `thread/resume` 返回的 `status` 与 `turns` 映射
`activeTurnId`，组合根再恢复仍在运行的 Turn，不能只恢复绑定，否则 steer、停止和下一 Turn
队列会误判为空闲。Provider 路由必须根据 Thread 的官方 `modelProvider` 选择已用对应启动配置
加载模型目录的 App Server，不能让第三方 Thread 回到 OpenAI 实例或 fallback 元数据。
恢复失败会区分永久不可用、固定版本官方 active-writer 冲突和其他暂时错误；Thread 已删除或归档、或其 Provider
已由操作员移除时，绑定属于永久不可用并安全清除；Router 只返回稳定分类，
由组合根决定重试与通知。active-writer 仍保留绑定，不在本模块删除锁、抢占写入方或复制 Thread。

本模块不得导入 `codex-client` 或 `codex-protocol`；具体 Client 由组合根作为
`ThreadLifecyclePort` 实现注入。
分区目录与排序不进入 StateStore；Application 每次从 App Server 读取权威目录，并通过 Router
把官方分区过滤与 `section_position` 排序参数交给 Client。Router 只在已有 Thread 快照中携带
当前归属，用于会话列表和 `before` 校验，不建立平行分区索引。
