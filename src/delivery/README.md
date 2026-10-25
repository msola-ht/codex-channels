# Delivery

本模块拥有有限磁盘投递箱。只处理不透明、版本化的结果载荷与投递状态，不持有平台 SDK、Thread 状态或授权规则；Bootstrap 注入授权复核和 Surface 投递函数。StateStore 仍只保存最小绑定。

## 文件与公开边界

- `index.ts`：公开 Journal、Coordinator、异步只读查询、读取与写入者关闭/退出确认，以及容量、状态与安全故障类型。
- `types.ts`：schema、状态、容量、Worker 命令及安全错误码。
  `DeliveryNotSentError` 是组合边界提供的明确未发送证据，Coordinator 保留为 `blocked` 并报告 `delivery-not-sent`；普通异常仍为 `uncertain`。两类均不自动重试或确认送达，不新增持久状态或修改 Schema。
- `sqlite-journal.ts`：独立 SQLite、私有密钥、AES-256-GCM、事务额度、检查点、会话顺序与操作系统释放的单写者锁；生产环境由 Worker 独占。
  已有库先只读校验版本、必需结构与完整性，通过后才调整目录权限、取得写入锁或改变日志模式；不兼容库不初始化或修补。
- `payload-codec.ts`：写入端与只读查看端共用的 AES-256-GCM 编解码和记录身份认证数据；不持有密钥、文件、连接或恢复状态。
- `queue-reader.ts`：Worker 内的只读连接、短事务快照与维护写入者复用的行映射。校验 Unix 所有者/权限、Windows 私有 ACL 与当前 Schema；同一读事务统计和分页，以完整检查点与载荷 GCM 身份摘要绑定修订。元数据不读取密钥或正文、不输出检查点细节、不执行恢复；载荷查询在 SQLite 内拒绝超过 4 MiB 的正文，再于事务外认证解密，单条不可解码返回空结果。
- `reader-protocol.ts`：只读 Worker 的有限命令、逐条载荷/ACK 协议和固定故障分类，不跨线程传递函数或原始异常。
- `reader-worker.ts`：独占一个只读 SQLite 连接。批量正文先用短事务捕获所有目标的修订基线；每条用独立短事务读取同快照的修订与正文，基线变化则该项返回空结果。密钥读取、解密、主线程投影与逐条 ACK 均不持有 SQLite 事务，避免阻塞 DELETE 模式的唯一写入者。每条等待主线程投影完成并 ACK 后才读取下一条，不积累 50 条原始正文；不获取写入者锁、不创建目录或恢复数据。
- `reader.ts`：公开异步 `readDeliveryQueue`、`readDeliveryEntries`、`readDeliveryPayload`、`readDeliveryPayloads`，全进程最多 2 个尚未确认退出的只读 Worker，过载显式拒绝。批量最多 50 个不同 ID，投影结果累计最多 4 MiB；调用方负责同步裁剪可展示字段。支持请求 `AbortSignal`；初始化预算 Windows 30 秒、其他平台 5 秒，普通请求（包含全部逐条投影）总预算 5 秒，关闭等待最多 2 秒，退出未确认保留资源归属和容量。`DeliveryReadError.failure` 仅含阶段、原因和操作。WebUI 断开只取消本请求的读取，不改变已经开始的投递处理语义。
  `closeDeliveryReaders()` 永久停止新读取准入、取消所有在途只读操作并在 2 秒内等待；超时仍保留归属，`waitForDeliveryReadersExit()` 提供真实退出的等待句柄。Windows 关闭先等待 ACL helper 的子进程与线程真实退出；超过关闭预算时读取调用报告未确认，外层 Worker 保持引用及容量归属，等待 helper 的真实退出后再关闭，不强制终止或允许进程自然退出后遗忘 helper。其他平台可终止自身只读 Worker，仍在实际 `exit` 后释放容量。
- `worker.ts`：串行处理存储命令，不执行平台请求或业务授权。
  构造 Journal 前先复核共享取消标记，已取消时不创建存储或执行恢复；构造后再次复核，初始化中到达的取消走原有关闭路径。
  正常关闭和初始化失败均关闭 SQLite 与嵌套 Windows ACL helper；关闭响应在资源清理后发送。故障取消标记阻止尚未开始的邮箱写入，已开始的事务仍按未知结果处理。
- `journal.ts`：主线程的有界 Worker 邮箱，预留控制槽，限制启动、请求和关闭等待；`available` 暴露 Worker 未失败且未关闭的即时状态，不代替 `ready`；`onFailure` 对非正常 Worker 故障通知组合根一次，正常关闭不触发。
  Windows Worker 初始化单独允许 30 秒以覆盖多次私有 ACL 操作，其余平台初始化与普通请求仍为 5 秒；故障提供固定枚举的阶段、原因与操作，不传递原始异常、路径或正文。
  关闭请求后另在两秒内等待实际 Worker 退出；Windows 不强制终止或取消引用外层 Worker，超时保留嵌套 helper 的资源归属，直到真实退出。其他平台可终止自身 Worker，超时不表示清理成功。
  `closeDeliveryJournals()` 停止新建写入者并关闭全部存量，`waitForDeliveryJournalsExit()` 等待真实退出；Gateway 与 WebUI 在显式退出前消费此句柄。致命存储故障关闭写入者，容量与冲突拒绝保持可用；启动中关闭拒绝 readiness，取消排队操作不能返回成功。
- `coordinator.ts`：最多 8 个会话并行投递、每会话顺序、独立的投递顺序屏障及账号/全局高低水位执行准入、取消及未知结果隔离；不自动重发 `uncertain`。组合根可显式判定某个未知或授权失效的结果仅保留核对、不阻塞后续；默认仍阻塞，存储额度不释放。
  授权回调接收本次投递的 AbortSignal，等待包含在总期限内；拒绝、异常或授权超时保留为 blocked，不视为存储故障。关闭取消等待，未开始发送的记录保持 pending；状态写入失败仍停止调度。
  可选 `acknowledged` 回调仅在平台发送及 Journal ACK 均成功后触发，用于释放进程内投递来源；发送未知或 ACK 失败不触发。清理回调失败单独报告，不把已成功 ACK 的记录误报为存储失败。

`DeliveryCoordinator.submit` 返回是否实际入箱；只有 Worker 确认本地事务提交才返回 `true`，拒收或失败返回 `false` 并报告故障，调用方可据此清理临时登记。单条处理故障通过 `fault` 的第三参数返回持久记录 ID，便于与平台日志关联，不传递正文或未知异常。平台确认必须由 `deliver` 完成后单独写回；网络请求和 SQLite 不构成原子事务。底层 `resolve` 仅供显式管理操作，不由正常调度自动调用。在线管理的批量读取和写入只使用普通邮箱容量，不占用确认与关闭的预留槽，过载返回忙碌而不停止调度。在线管理通过 `DeliveryCoordinator.resolveBatch` 暂停新调度、拒绝目标会话仍有在途投递的批次，事务核对修订并同步容量和顺序屏障；重试唤醒调度并再次验证授权，关闭等待已开始的管理操作。

数据、容量、离线核对与备份边界见 [投递箱运维](../../docs/delivery.md)。

`read` 仅向内部调度返回单条认证载荷；离线 `list` 仍不输出正文。`releaseBarrier` 仅作用于当前 Worker 中的 `uncertain` / `blocked` 记录，不修改持久状态；重启后由组合根重新判定。

Journal 的 `maintenance` 模式仅打开已有投递箱并验证载荷，不创建数据库或密钥，不执行 `sending` 恢复或清理临时图片；只允许 `queueEntry`、`queueEntries`、`resolve`、`resolveBatch`、`close`，用于 WebUI 离线维护；`resolveBatch` 最多 50 条，单事务核对全部内部修订并处理，失败整批回滚。`queueEntry` 返回与在线快照一致的脱敏字段及修订，不返回正文；`queueEntries` 在一个 Worker 命令内读取最多 50 条，保持输入顺序并用 null 表示缺失记录。默认 `runtime` 模式及现有 CLI 启动恢复行为保持不变。

`executionBlockReason(account)` / `acceptsExecution(account)` 检查初始化、Worker 可用性、关闭和账号/全局容量；单条未知结果或旧记录授权阻塞不关闭执行准入。投递及审批顺序由 `hasOutstanding(conversation)` 独立维护；存储失效时不得把空队列当作已完成投递；重启按存量恢复高低水位保护。
