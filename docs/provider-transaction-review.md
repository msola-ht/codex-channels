# Provider 配置与凭据事务审查

本记录覆盖 Provider 预览、确认、配置与凭据写入、权威回读、运行时消费及失败恢复。
审查基线为 `4293b567`。维护本页时按问题更新实际结果，不把源码结论或静态检查写成实机验收。

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| P01 | 切换 Profile 转固定模式前缺少本次持久恢复快照 | 已修复；隔离故障与真实 CLI 路径已观察 |
| P02 | Windows 普通环境变量凭据读取丢失大小写不敏感语义 | 已修复；分支与 Linux CLI 已观察，Windows 实机未验 |

## 后续验证清单

修复完成不等于所有故障路径均已观察。以下按项执行、记录实际输出；确认缺陷时单独修复提交，
仅补充证据时提交文档，不因缺少目标系统而把模拟分支标为实机通过。

| 编号 | 验证目标 | 状态 |
| --- | --- | --- |
| V01 | Profile 删除后、RPC 写入前强制终止任务子进程；从磁盘快照恢复，保留其他 Provider | 已观察，恢复及运行时读取成功 |
| V02 | 写入报错后的完整提交、未提交、部分提交回读；确认成功判定与恢复边界 | 待执行，生产事务接口注入故障 |
| V03 | Windows 原生环境名称、服务继承及私有文件 ACL | 待目标系统；当前仅有 Linux 分支观察 |
| V04 | 完整 Setup 交互与 macOS 服务链路 | 待对应交互环境；当前仅有共享调用链证据 |

真实断电的存储持久性不由进程终止代替证明；远程模型调用不属于本轮配置事务验证。

### V01 进程强制终止后的恢复

在 Linux 隔离 Home 中，通过生产写入器创建 `review-crash` 和 `review-other`。
仅在任务自有子进程的 Client 写入入口发送自身 `SIGKILL`，此时生产事务已经删除目标 Profile，
尚未执行 RPC 写入；父进程等待退出后直接读取磁盘快照，不依赖子进程内存或清理回调。
核对主配置原文未改变，再通过生产恢复函数恢复目标 Profile。

实际输出：`signal=SIGKILL`、`profileRemovedBeforeRestore=true`、`snapshotCount=1`、
`restoredExact=true`、`otherPreserved=true`；注册表包含两个 Provider，运行时读取返回
`runtimeProvider=review-crash`。未发现需追加修复的问题，隔离目录已清理。
这覆盖删除后、写入前的进程终止窗口，不证明 RPC 进行中、完整 CLI 崩溃或断电持久性。

## P01 转换失败时保留完整连接配置

**触发与影响。** `codexc provider switch` 经共享主配置事务先删除切换 Profile 与注册项，
再执行 App Server 配置写入。写入未提交且后续回读失败，或删除后进程退出时，旧 Profile
只留在内存；新凭据只含 Provider、Origin 和 Key，无法还原完整 URL、模型及其他设置。
共享事务见 [`primary-provider-config-transaction.mjs`](../scripts/primary-provider-config-transaction.mjs)。

**数据处理与回退方案。** 删除前保存本次原 Profile、注册表与主配置的原文快照，
并记录目标 Provider、配置修订及预期配置修改。快照使用独立随机文件名、共享私有文件保护和
原子写入，写后回读确认；失败则不删除 Profile。保留成功和失败的快照，不覆盖旧记录或自动清理。
不迁移现有配置、凭据或数据库，不自动把快照写回主配置。回退代码时保留快照与凭据版本，
按下述核对流程处理，不通过删除恢复材料绕过错误。
实际位置为 Gateway 数据目录的 `providers/profile-conversion-backups/<随机 ID>.json`。
现有 Provider 根目录与备份子目录都校验类型、所有者及平台私有权限，拒绝链接目录。
普通切换与 Setup 转固定模式经过同一事务；没有 Profile 转换时不会声称创建了快照。

**恢复约束。** 结果未知时先停止后续配置修改，重新读取主配置以判定是否已转换；
已经完整转换的状态不应恢复旧 Profile。需要回退时，先保存当前材料，逐项比较当前配置、
Profile、注册表与快照：存在后续修改或同名条目时停止，不能整份覆盖主配置或注册表。
仅在确认主配置仍为转换前状态且不引用目标固定 Provider 后，恢复目标 Profile 与对应注册项，
保留其他 Provider。主配置读取失败、部分提交或状态冲突时保留全部材料，人工核对，禁止自动重试。
快照包含凭据，不能粘贴进日志、问题报告或提交仓库。

**验证记录。** Linux Node 24.21.0、Codex CLI 0.163.0，使用临时 Codex/Gateway Home 与占位 Key：

- 经生产 Profile 写入器准备材料，向事务的既有 Client 注入写入拒绝及回读拒绝，输出
  `snapshotMatches=true`、`profileRemoved=true`；快照中的 Profile 与注册表原文均可还原，文件权限 `600`。
- 核对主配置仍与快照一致后，经生产恢复函数恢复目标，再从实际
  `bin/codexc.mjs provider switch review-blocked --yes` 执行转换，退出码 `0`，输出“已设为固定主 Provider”。
  运行时读取返回目标 Provider，`keyReadable=true`；备份数从 `1` 变为 `2`，`previousBackupPreserved=true`。
- 过期 Profile 与符号链接备份目录分别被拒绝，均为 `writes=0`、原 Profile 不变；链接目标 `targetFiles=0`。
  非转换操作的双失败输出 `incorrectSnapshotClaim=false`。
- 首次 CLI 尝试因临时 Gateway 配置尚未初始化而拒绝；补齐隔离配置后成功，没有修改现用配置。
  独立源码复核指出的目录校验和无条件快照提示已修正并复查。

未执行真实进程崩溃/断电、远程模型请求、Windows ACL、macOS 服务或完整 Setup 交互；
共享 Setup 覆盖来自调用链核对。快照供人工核对恢复，不新增自动恢复命令；不宣称原子写入已验证断电持久性。
本项提交为 `52b94f0f`（`fix(provider): 转固定模式前保留私有恢复快照`）。提交钩子的
类型/版本、模块边界、变更文件 Lint、文档索引及 Gateway 构建通过。

## P02 Windows 环境变量凭据读取

**触发与影响。** 已有 `env_key = "CUSTOM_API_KEY"` 引用 Windows 宿主的
`Custom_Api_Key`。服务入口复制 `process.env` 为普通对象后，精确属性索引误判凭据缺失。
位置为 [`readCustomPrimaryProviderApiKey`](../runtime/model-provider-custom-runtime.mjs)。

**调整边界。** 普通环境变量读取在 Windows 按名称忽略大小写匹配，Unix 仍精确匹配；
歧义环境不得任意挑选凭据。Gateway 私有版本引用保留现有 Provider、Origin 和版本检查，
不得回退到普通环境变量。没有持久化格式变化。

**实现。** 在原凭据读取函数内增加 Windows 普通变量名称匹配，不新建配置字段或公共工具。
零匹配仍表示缺失；多个已定义变体明确拒绝，即使存在精确拼写也不任意选择。值为 `undefined`
的属性不代表已设置变量。私有版本分支仍先执行原来的文件、Provider、Origin 校验。

**验证记录。** Linux Node 24.21.0，使用合成环境对象和实际导出函数；仅临时切换当前进程的
平台标识以观察纯读取分支，随后恢复，不把它作为 Windows 操作系统实测：

- 修改前 Windows 分支输出 `windowsBranchMixedCaseAvailable=false`；修改后
  `mixedCaseAvailable=true`、`missingRejected=true`、`undefinedVariantIgnored=true`。
- 两个大小写变体、控制字符 Key、空 Key 均被拒绝。Unix 输出 `mixedCaseMissing=true`、
  `exactCaseAvailable=true`，保留原有匹配语义。
- 缺少私有版本文件且存在同名环境变量时，输出 `privateReferenceFallbackRejected=true`。
- 在隔离 Codex/Gateway Home 中，通过真实 App Server 将固定 Provider 设为普通 `env_key` 引用，
  再执行实际 `bin/codexc.mjs provider switch review-blocked --yes`；退出码 `0`，
  `keyReadable=true`、`referencePreserved=true`。没有模型请求或服务重启。

Windows 完整服务启动、原生环境继承及 ACL 未实测，Linux CLI 只验证共享调用链与 Unix 语义。
本项代码和记录随 `fix(provider): 按 Windows 语义读取环境凭据` 提交；静态检查由提交钩子执行。

## 审查覆盖与限制

已检查 CLI/WebUI 的预览修订、一次性确认、共享管理锁、连接保存回读、自定义目录 pending/backup、
受管目录恢复和运行时拒绝未完成事务。除上述两项外，未确认其他缺陷。
初审为源码与合同检查，未操作用户配置、真实凭据或服务，未执行真实崩溃/断连及跨平台故障注入。
