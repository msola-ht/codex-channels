# Scheduled Tasks

计划任务模块保存 Gateway 计划任务的领域合同。领域类型不依赖 Surface SDK、App Server 协议或
服务管理器；SQLite 存储实现和调度器仍只通过本目录公开的窄类型端口协作。

## 文件

- `index.ts`：公开导出入口。
- `types.ts`：封闭 Schedule 联合、Task/Run 状态、无人值守权限和执行端口。
- `schedule.ts`：IANA 时区校验、Schedule 规范化和下一次 occurrence 计算。
- `sqlite-row-codec.ts`：数据库 Task/Run Row 的严格领域映射、持久化枚举和时间戳校验。
- `sqlite-schema.ts`：Schema v2 SQL、版本读取和数据库严格结构校验。
- `sqlite-store.ts`：数据库文件与事务、原子领取、清理、崩溃收敛和显式 v1→v2 升级入口。
- `scheduler.ts`：注入 Clock 与执行端口的有限调度循环。

Schedule 目前支持 `interval`（每 N 分钟，UTC anchor 加固定分钟间隔）、`once`（绝对日期时间，或
`afterMinutes + anchorAt` 的“从现在起 N 分钟后/小时后执行一次”；触发一次后进入 `finished` 终态）、
`monthly`（每月指定日，月份无该日时跳过）、`daily`、`weekdays` 和 `weekly`。后五者按任务时区的
`HH:mm` 计算。不存在的 DST 本地时间跳过，重复的本地时间只选择较早的 UTC occurrence。相对延时以
固定 UTC 分钟数计算，不随 DST 改变。时间计算不会读取或改变进程的 `TZ`。

SQLite 只保存任务定义和最小 Run 元数据，目录、文件与备份在 Unix 使用 owner-only 权限、在 Windows
使用当前 SID 私有 ACL；运行时从不隐式迁移 Schema，
v1 或未知版本在打开时失败关闭。`codexc update` 与 `codexc state upgrade` 在 Gateway 停止后预检、
备份并显式执行唯一的 v1→v2 迁移（`hourly`→`interval`），迁移在同一事务中保留 `runs` 外键。
调度器只通过执行端口请求运行，不建立第二套 App Server Thread/Turn 状态，也不自动重试结果未知的
写请求；`uncertain` Run 会阻塞同一任务后续 occurrence，只有显式 `resolveUncertain` 或权威恢复路径
才会解除。停止调度
时会向尚未完成的执行端口传递取消信号，并在有限等待上限后报告稳定超时。配置与 Bootstrap
App Server 执行与 Surface `/schedule` 管理命令已接入且默认关闭；Application 负责 Actor 归属、
五分钟选择快照和创建/删除确认，Surface 不直接访问 Store。Scheduler 在首次 tick 和之后每 24 小时最多调用一次
Run 清理；清理失败经 `onError` 观察但不阻断本次安全调度。
Application 通过不阻止进程退出的短期定时器主动清理超过五分钟的待确认记录，并把 Store 状态冲突
转换为稳定的用户可见错误；
每个 Actor 在同一 Conversation 的未删除任务固定限制为 100 个。
