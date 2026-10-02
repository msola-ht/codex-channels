# Delivery

本模块拥有有限磁盘投递箱。只处理不透明、版本化的结果载荷与投递状态，不持有平台 SDK、Thread 状态或授权规则；Bootstrap 注入授权复核和 Surface 投递函数。StateStore 仍只保存最小绑定。

## 文件与公开边界

- `index.ts`：公开 Journal、Coordinator、容量与状态类型。
- `types.ts`：schema、状态、容量、Worker 命令及安全错误码。
- `sqlite-journal.ts`：独立 SQLite、私有密钥、AES-256-GCM、事务额度、检查点、会话顺序与操作系统释放的单写者锁；生产环境由 Worker 独占。
- `payload-codec.ts`：写入端与只读查看端共用的 AES-256-GCM 编解码和记录身份认证数据；不持有密钥、文件、连接或恢复状态。
- `queue-reader.ts`：在线只读元数据快照，校验私有路径及当前 Schema，在同一读事务中统计并按状态/游标分页，明确 ID 与序号范围条件使用现有索引；以完整检查点与载荷 GCM 身份摘要绑定修订，不读取密钥或正文，不输出检查点细节、不执行恢复。维护写入者复用行映射，在持锁连接上重新读取所选记录。通过 `index.ts` 的异步 `readDeliveryQueue` 延迟加载 SQLite。独立 `readDeliveryPayload` 仅供显式单条内容查询，在只读事务中认证解密，不恢复状态；调用方负责裁剪可展示字段。`readDeliveryEntries` 在一次只读事务内读取最多 50 条元数据，不计算全局统计；`readDeliveryPayloads` 同事务逐条解密并经调用方投影为限定摘要，不积累原始载荷，单条不可解码返回空结果。
- `worker.ts`：串行处理存储命令，不执行平台请求或业务授权。
- `journal.ts`：主线程的有界 Worker 邮箱，预留控制槽，限制启动、请求和关闭等待；`available` 暴露 Worker 未失败且未关闭的即时状态，不代替 `ready`；`onFailure` 对非正常 Worker 故障通知组合根一次，正常关闭不触发。
- `coordinator.ts`：最多 8 个会话并行投递、每会话顺序、独立的投递顺序屏障及账号/全局高低水位执行准入、取消及未知结果隔离；不自动重发 `uncertain`。组合根可显式判定某个未知或授权失效的辅助结果仅保留核对、不阻塞后续；默认仍阻塞，存储额度不释放。

`DeliveryCoordinator.submit` 返回是否实际入箱；只有 Worker 确认本地事务提交才返回 `true`，拒收或失败返回 `false` 并报告故障，调用方可据此清理临时登记。单条处理故障通过 `fault` 的第三参数返回持久记录 ID，便于与平台日志关联，不传递正文或未知异常。平台确认必须由 `deliver` 完成后单独写回；网络请求和 SQLite 不构成原子事务。底层 `resolve` 仅供显式管理操作，不由正常调度自动调用。在线管理的批量读取和写入只使用普通邮箱容量，不占用确认与关闭的预留槽，过载返回忙碌而不停止调度。在线管理通过 `DeliveryCoordinator.resolveBatch` 暂停新调度、拒绝目标会话仍有在途投递的批次，事务核对修订并同步容量和顺序屏障；重试唤醒调度并再次验证授权，关闭等待已开始的管理操作。

数据、容量、离线核对与备份边界见 [投递箱运维](../../docs/delivery.md)。

`read` 仅向内部调度返回单条认证载荷；离线 `list` 仍不输出正文。`releaseBarrier` 仅作用于当前 Worker 中的 `uncertain` / `blocked` 记录，不修改持久状态；重启后由组合根重新判定。

Journal 的 `maintenance` 模式仅打开已有投递箱并验证载荷，不创建数据库或密钥，不执行 `sending` 恢复或清理临时图片；只允许 `queueEntry`、`queueEntries`、`resolve`、`resolveBatch`、`close`，用于 WebUI 离线维护；`resolveBatch` 最多 50 条，单事务核对全部内部修订并处理，失败整批回滚。`queueEntry` 返回与在线快照一致的脱敏字段及修订，不返回正文；`queueEntries` 在一个 Worker 命令内读取最多 50 条，保持输入顺序并用 null 表示缺失记录。默认 `runtime` 模式及现有 CLI 启动恢复行为保持不变。

`executionBlockReason(account)` / `acceptsExecution(account)` 检查初始化、Worker 可用性、关闭和账号/全局容量；单条未知结果或旧记录授权阻塞不关闭执行准入。投递及审批顺序由 `hasOutstanding(conversation)` 独立维护；存储失效时不得把空队列当作已完成投递；重启按存量恢复高低水位保护。
