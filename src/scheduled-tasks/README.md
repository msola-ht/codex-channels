# Scheduled Tasks

计划任务模块保存 Gateway 计划任务的领域合同。领域类型不依赖 Surface SDK、App Server 协议或
服务管理器；SQLite 存储实现和调度器仍只通过本目录公开的窄类型端口协作。

## 文件

- `index.ts`：公开导出入口。
- `types.ts`：封闭 Schedule 联合、Task/Run 状态及状态错误、无人值守权限和执行端口。
- `schedule.ts`：IANA 时区校验、Schedule 规范化和下一次 occurrence 计算。
- `sqlite-row-codec.ts`：数据库 Task/Run Row 的严格领域映射、持久化枚举和时间戳校验。
- `sqlite-schema.ts`：Schema v2 SQL、版本读取和运行时/只读预检共用的数据库严格结构、元数据校验。
- `sqlite-store.ts`：数据库文件与事务、原子领取、清理、崩溃收敛及当前结构检查。
- `async-sqlite-store.ts`：Gateway 独占的 SQLite Worker、初始化与请求预算、有界准入和关闭。
- `sqlite-worker.ts`、`sqlite-worker-protocol.ts`：封闭的存储命令及脱敏失败分类；同步 Store 保留给 CLI 冷路径。
- `scheduler.ts`：注入 Clock 与执行端口的有限调度循环。

交互式手动运行及显式重试可携带原请求的取消与归属复核上下文，在串行等待、容量检查、领取和派发边界再次检查；领取完成但尚未提交执行时取消，将 Run 收敛为中断；已提交的 Thread/Turn 写入按实际结果记录，不回滚。执行端口继续在异步预检后和新 Thread 返回后检查该上下文，阻止失效请求继续启动 Turn。

Schedule 目前支持 `interval`（每 N 分钟，UTC anchor 加固定分钟间隔）、`once`（绝对日期时间，或
`afterMinutes + anchorAt` 的“从现在起 N 分钟后/小时后执行一次”；触发一次后进入 `finished` 终态）、
`monthly`（每月指定日，月份无该日时跳过）、`daily`、`weekdays` 和 `weekly`。`monthly`、`daily`、`weekdays`、`weekly` 按任务时区的
`HH:mm` 计算。不存在的 DST 本地时间跳过，重复的本地时间只选择较早的 UTC occurrence。相对延时以
固定 UTC 分钟数计算，不随 DST 改变。时间计算不会读取或改变进程的 `TZ`。

SQLite 只保存任务定义和最小 Run 元数据，目录、文件与备份在 Unix 使用 owner-only 权限、在 Windows
使用当前 SID 私有 ACL；运行时从不隐式迁移 Schema，
v1 或未知版本在打开时失败关闭，不提供历史迁移；新安装直接创建当前结构。
既有文件在改动权限、日志模式或 Schema 前先只读校验；仅版本为 0 且无任何 Schema 对象的空库
可以初始化。手动和显式重试 occurrence 沿用递增毫秒时间，同时避开所有自动 occurrence 所在的
毫秒尾数及已保存的 `nextRunAt`，不推进自动计划。
调度器只通过执行端口请求运行，不建立第二套 App Server Thread/Turn 状态，也不自动重试结果未知的
写请求；`uncertain` Run 会阻塞同一任务后续 occurrence，只有显式 `resolveUncertain` 或权威恢复路径
才会解除。显式重试经同一串行调度和容量准入，用 `claimRetry` 原子解除旧未知 Run 并领取新 Run；
领取失败不消耗原未知状态，已结束的一次性任务仍可显式重试未知 Run。停止调度
时会向尚未完成的执行端口传递取消信号，并在有限等待上限后报告稳定超时。配置与 Bootstrap
App Server 执行与 Surface `/schedule` 管理命令已接入且默认关闭；Application 负责 Actor 归属、
五分钟选择快照和创建/删除确认，Surface 不直接访问 Store。
Gateway 经异步端口使用唯一计划任务 SQLite Worker，初始化、普通请求和关闭分别有独立时限；
超时写入不自动重试，也不创建替代写者。正常关闭与致命失败通过同一停止标记和协作关闭消息收敛，
阻止迟到就绪及尚未开始的 SQL；线程先关闭 SQLite，再以 1 秒预算请求 Windows ACL helper 退出。
父端保留原 2 秒关闭预算，要求关闭确认及 Worker exit；超时仍保留 owner，不强行终止线程。
helper 关闭预算失败后继续等待实际退出才关闭端口；`closeScheduledTaskStores()` 拒绝新实例并请求
全部 owner 关闭，`waitForScheduledTaskStoresExit()` 供最终退出路径等待物理结束，实例仅在 exit 后移出登记。
到期查询直接使用 SQL `LIMIT`；Scheduler 在派发后增量清理，
每批最多读取 16 个 Task 和 200 个 Run，完成一轮后等待 24 小时。清理失败经 `onError` 观察但不阻断安全调度。
领取事务按当时的 Run 状态优先判定重叠或未知阻塞，再判定容量，调度器只按事务返回的结果派发，避免异步预检期间旧 Run 完成后遗留未派发的领取。
Application 通过不阻止进程退出的短期定时器主动清理超过五分钟的待确认记录，并把 Store 状态冲突
转换为稳定的用户可见错误；
每个 Actor 在同一 Conversation 的未删除任务固定限制为 100 个。

恢复查询按 Run ID 有界读取 `running` 和 `uncertain`，让 Bootstrap 恢复已知 Thread 的无人值守
拒绝归属；缺少 Turn ID 时不能把同 Thread 的其他轮次终态当作原 Run 的结束证明。
已知 Turn 的权威终态只释放未知 Run 的运行期拒绝归属，不改写其历史未知状态。
显式重试和任务删除不证明旧 Thread 已终止；动态计划工具另行核验前台绑定与官方 Thread source，
拒绝后台或 `automation` 来源，普通审批继续由 Router 的官方来源检查安全拒绝。
