# Delivery

本模块拥有有限磁盘投递箱。只处理不透明、版本化的结果载荷与投递状态，不持有平台 SDK、Thread 状态或授权规则；Bootstrap 注入授权复核和 Surface 投递函数。StateStore 仍只保存最小绑定。

## 文件与公开边界

- `index.ts`：公开 Journal、Coordinator、容量与状态类型。
- `types.ts`：schema、状态、容量、Worker 命令及安全错误码。
- `sqlite-journal.ts`：独立 SQLite、私有密钥、AES-256-GCM、事务额度、检查点、会话顺序与操作系统释放的单写者锁；生产环境由 Worker 独占。
- `worker.ts`：串行处理存储命令，不执行平台请求或业务授权。
- `journal.ts`：主线程的有界 Worker 邮箱，预留控制槽，限制启动、请求和关闭等待。
- `coordinator.ts`：最多 8 个会话并行投递、每会话顺序、独立的投递顺序屏障及账号/全局高低水位执行准入、取消及未知结果隔离；不自动重发 `uncertain`。组合根可显式判定某个未知或授权失效的辅助结果仅保留核对、不阻塞后续；默认仍阻塞，存储额度不释放。

`DeliveryCoordinator.submit` 返回是否实际入箱；只有 Worker 确认本地事务提交才返回 `true`，拒收或失败返回 `false` 并报告故障，调用方可据此清理临时登记。单条处理故障通过 `fault` 的第三参数返回持久记录 ID，便于与平台日志关联，不传递正文或未知异常。平台确认必须由 `deliver` 完成后单独写回；网络请求和 SQLite 不构成原子事务。`resolve` 仅供离线维护入口明确重发或确认送达，正常调度不得调用。

数据、容量、离线核对与备份边界见 [投递箱运维](../../docs/delivery.md)。

`read` 仅向内部调度返回单条认证载荷；离线 `list` 仍不输出正文。`releaseBarrier` 仅作用于当前 Worker 中的 `uncertain` / `blocked` 记录，不修改持久状态；重启后由组合根重新判定。

`executionBlockReason(account)` / `acceptsExecution(account)` 只检查初始化、关闭和账号/全局容量；单条未知结果或旧记录授权阻塞不关闭执行准入。投递及审批顺序由 `hasOutstanding(conversation)` 独立维护；重启按存量恢复高低水位保护。
