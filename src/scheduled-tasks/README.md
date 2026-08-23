# Scheduled Tasks

计划任务模块保存 Gateway 计划任务的领域合同。领域类型不依赖 Surface SDK、App Server 协议或
服务管理器；SQLite 存储实现和调度器仍只通过本目录公开的窄类型端口协作。

## 文件

- `index.ts`：公开导出入口。
- `types.ts`：封闭 Schedule 联合、Task/Run 状态、无人值守权限和执行端口。
- `schedule.ts`：IANA 时区校验、Schedule 规范化和下一次 occurrence 计算。
- `sqlite-store.ts`：独立 Schema v1、任务/运行记录、原子领取、清理和崩溃收敛。
- `scheduler.ts`：注入 Clock 与执行端口的有限调度循环。

Schedule 目前只支持 `hourly`、`daily`、`weekdays` 和 `weekly`。Hourly 使用 UTC anchor 加固定小时
间隔；其他类型按任务时区的 `HH:mm` 计算。不存在的 DST 本地时间跳过，重复的本地时间只选择较早的
UTC occurrence。时间计算不会读取或改变进程的 `TZ`。

SQLite 只保存任务定义和最小 Run 元数据，目录和文件使用私有权限；运行时不隐式迁移未知 Schema。
调度器只通过执行端口请求运行，不建立第二套 App Server Thread/Turn 状态，也不自动重试结果未知的
写请求；`uncertain` Run 会阻塞同一任务后续 occurrence，只有显式 `resolveUncertain` 或权威恢复路径
才会解除。停止调度
时会向尚未完成的执行端口传递取消信号，并在有限等待上限后报告稳定超时。配置与 Bootstrap
App Server 执行已接入且默认关闭；Surface 命令属于后续阶段。Scheduler 在首次 tick 和之后每 24 小时最多调用一次
Run 清理；清理失败经 `onError` 观察但不阻断本次安全调度。
