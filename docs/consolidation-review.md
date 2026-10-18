# 项目重复实现与统一边界审查

本记录按问题维护当前结论、关联链路、调整边界与实施证据，不保留逐轮工作日志。修复按条目推进；未完成条目仍保留建议与限制。

审查基线：`2ac1f25b`，2026-10-18。结论来自源码与调用链检查；没有使用真实凭据、启动服务或执行外部写操作。维护性重复不等同于已发生的用户故障。

## 待处理清单

| 编号 | 建议 | 优先级 | 审查状态 |
| --- | --- | --- | --- |
| U01 | 统一自定义 Provider API Key 纯校验规则 | 中 | 已修复；隔离凭据写读与 HTTP 拒绝已观察 |
| U02 | 统一 Application 短期选择快照的容器操作 | 低 | 关联复核完成，缩小范围；未实施 |
| U03 | 收敛渠道文本附件取得明文后的公共处理 | 低 | 关联复核完成，保留窄范围；未实施 |
| U04 | 收敛 Storage 内两个同步 SQLite Store 的打开流程 | 低 | 关联复核完成，保留窄范围；未实施 |
| U05 | 统一 WebUI 写入结果未知与权威回读门禁 | 中 | 已修复；浏览器保存及 503 回读门禁已观察 |
| U06 | 统一两个模型能力检测 Hook 的请求归属与取消机制 | 中 | 已实施；调用链及构建检查完成，检测竞态未实测 |
| U07 | 统一两个 Runtime 材料 Reader 的单 Worker 所有权机制 | 中 | 已修复；Linux 真实 Worker 读取、恢复与退出已观察 |
| U08 | 统一配置管理与 CLI 总览的有效默认值投影 | 中 | 已修复；默认展示、原文写回与修订拒绝已观察 |
| U09 | 统一设置输入校验失败的领域错误适配 | 中 | 已修复；隔离 HTTP/CLI 链路已观察 |
| U10 | 移除渠道输入聚合的等价转发层 | 低 | 关联复核完成，保留局部简化；未实施 |
| U11 | 统一渠道关闭时继续清理并汇总失败的约定 | 中 | 已修复；部分构造关闭与注入失败已观察 |
| U12 | 收敛 HTTP chunk 背压写入原语 | 低 | 关联复核完成，排除终态状态机；未实施 |
| U13 | 统一审查统计与写入失败归属的运行树选择 | 中 | 已修复；隔离 SQLite 汇总与失败归属已观察 |
| U14 | 统一 Gateway 与 Codex 基础版本兼容谓词 | 中 | 已修复；门禁、更新器导出与打包清单已检查 |
| U15 | 收敛源码取得后的安装构建阶段 | 中 | 关联复核完成，排除生命周期合并；未实施 |
| U16 | 收敛一次性私有 IPC 交换的底层收尾 | 低 | 关联复核完成，降级为条件性提取；未实施 |
| U17 | 统一自有子进程退出观察的窄操作 | 低 | 关联复核完成，保留所有者决策；未实施 |
| U18 | 统一待生效选择与原生 Queue 的互斥操作 | 中 | 已实施；后查冲突清理已观察，真实跨端并发未实测 |
| U19 | 将 Queue 官方错误识别收回 Client 边界 | 中 | 已实施；分类及伪造文本拒绝已观察，真实 Queue 链路未实测 |

19 项均已完成下述关联链路的源码复核及 Astra 独立复查；实施状态逐项列明。优先级表示维护收益与风险的相对顺序，不表示已发生故障的严重程度。“复核完成”仅覆盖各项列出的调用链与合同，运行证据和未穷尽分支仍受文末限制。

## U01 自定义 Provider API Key 校验

**当前实现。** Runtime Provider 门面公开 `isValidCustomProviderApiKey` 纯格式谓词，管理保存、内部能力检测和 WebUI 检测 Schema 共用。Runtime 私有凭据读写继续通过本地错误包装校验；Relay 在已校验的读取结果上只判断凭据是否缺失。未发现原格式规则已漂移或认证故障；本项消除多处规则定义，保留各信任边界的检查。

**共享合同。** 合法 Key 必须是字符串、非全空白、length 不超过 4096 个 UTF-16 代码单元且不含 Unicode Cc 控制字符。录入替换先 trim，再校验；保留已有凭据、Runtime 读取和内部检测保留原值。不能把上限改成 UTF-8 字节数，也不能自动 trim 已有数据。

| 关联链路 | 已核对证据 | 影响与必须保留的约束 |
| --- | --- | --- |
| CLI/WebUI 录入→保存预览→确认应用 | [CLI setup](../scripts/custom-primary-provider-setup.mjs) 约 402、451 行；[WebUI 管理分发](../scripts/webui-provider-settings-management.mjs)；[管理服务](../scripts/custom-primary-provider-management.mjs) 的 buildSavePlan、prepare/preview/apply | replace 经 requiredString 裁剪；preserve 仅在同 Origin 且能取得旧 Key 时成立。apply 在管理事务内重建计划并比对预览 revision，不能复用旧校验结果绕过复核 |
| 保存计划→固定模式私有凭据→配置引用→回读确认 | [配置事务](../scripts/primary-provider-config-transaction.mjs)；[Runtime](../runtime/model-provider-custom-runtime.mjs) 的 writeCustomPrimaryProviderCredential；管理服务 confirmProviderSave | 先写新凭据版本，再写配置；结果未知或仍被引用时保留凭据。格式提取不能改变备份、回滚、旧版本保留或 save-unconfirmed 分类 |
| 保存计划→切换 Profile→回读确认 | 管理服务 applyConnectionSavePlan；Runtime writeCustomPrimaryProviderSwitchingProfile、切换 Profile 读取；confirmProviderSave | 切换写入也调用 validateCustomApiKey，回读比较实际 apiKey。固定与切换模式落盘合同不同，不合并事务 |
| 配置/环境/私有凭据→启动消费 | Runtime readCustomPrimaryProviderApiKey、readCustomPrimaryCredential、loadConfiguredCustomPrimaryCredential；[App Server 服务](../runtime/app-server-service-runtime.mjs) 约 160、690–707 行 | token 与 env_key 同时存在会拒绝；私有文件还校验格式版本、Provider 和 Origin。服务对启动捕获凭据再次比对，不能被通用 Key 校验取代 |
| 主 Provider→Relay 材料 | Runtime loadConfiguredCustomPrimaryRelayProfile；[Relay 材料](../runtime/model-provider-relay-material.mjs) 的 Profile 读取与两次 fingerprint | Key 读取已完成内容校验，Relay 再写长度/控制字符判断属于重复规则；仍须拒绝缺失 Key、OAuth/额外 Header，以及读取期间材料变化。切换 Provider 使用独立 Profile 读取链 |
| 草稿能力检测→连接 token→保存复核 | [检测路由](../scripts/webui-custom-model-probe.mjs) 的 inputSchema、routeCustomModelCapabilityProbe；[检测实现](../scripts/custom-model-capability-probe.mjs) 约 59、113 行；管理服务 customModelProbeConnection 与 probeConnections 验证 | WebUI 替换 Key 的 Schema 先 trim；检测内部再校验原值并用于 Authorization。CLI 也先 trim 新 Key。连接 token 和保存预览 HMAC 都绑定实际 Key；规范化变化须同时核对检测和保存 |

**错误与关联约束。** 管理层保留 required / invalid-api-key 字段错误，内部检测保留安全文案，WebUI 继续返回 invalid_custom_model_probe；Schema 的输入结构和录入 trim 不变。没有把 Runtime 普通异常透传到管理层。HMAC、fingerprint、Origin、不可变凭据版本、回读确认与恢复事务保持原合同；未修改持久格式。

**联动范围。** 与 U06 的检测作用域不同，本项只涉及检测输入及 token 的同值约束；不改变主动检测次数、收费副作用或回填权限。与 U07 的材料 Reader 不同，本项不改变读取新鲜度、Worker 所有权或超时。受管 Provider 的专有格式校验不纳入本项。

**观察与限制。** 使用任务专用目录与虚构 Key 经真实私有凭据写入→读取，观察到首尾空格保留、同 Origin 不同路径可读、跨 Origin 被拒绝。Hack 覆盖空值、全空白、Cc 字符、4096/4098 UTF-16 单元和保留空格；非法写入未产生凭据文件，内部检测在出站前拒绝。真实 WebUI HTTP 检测入口对含控制字符的 Key 返回 400 / invalid_custom_model_probe。TypeScript、模块边界与相关 ESLint 通过。未读取用户 Key，未调用外部模型、重启服务或观察完整 Provider 配置事务、失败恢复及 Relay 认证；这部分仍是源码关联证据。

## U02 Application 短期选择快照

证据入口：

- [`thread-queue-service.ts`](../src/application/thread-queue-service.ts)：`rememberSelectionSnapshot` 与数字选择器读取。
- [`thread-revert-service.ts`](../src/application/thread-revert-service.ts)：`rememberSelectionSnapshot`、`rememberConfirmation` 与页面选择校验。
- [`conversation-hook-service.ts`](../src/application/conversation-hook-service.ts)：`prune`、选择与确认上下文。
- [`scheduled-task-service.ts`](../src/application/scheduled-task-service.ts)：`rememberSnapshot`、`trimMap`、Task/Run 选择读取。

**结论：保留局部容器去重，优先级降为低，排除通用确认机制。** 四个服务都维护有界 Map，但保护的业务对象及消费顺序不同，不能将相似容器理解为同一个确认合同。未确认用户故障。

| 关联链路 | 消费前复核与失效 | 提取限制 |
| --- | --- | --- |
| Queue list→数字选择→readSnapshot→更新/删除/排序/启动 | 数字先绑定旧列表 ID，再读权威列表查 ID；完整 ID 不依赖旧页面。写入及绑定变化另行失效 | 不能缓存权威列表替代再次读取，不能把完整 ID 强制绑定快照 |
| Revert list→preview→confirm→revertThread | confirm 先消费令牌，再校验 Actor、绑定、页面、活动/最新 Turn 与 Queue 指纹；重新列举会撤销该目标确认 | 同一快照替换还涉及确认撤销，副作用留在服务内；无效调用也消费令牌的顺序不可改 |
| Hooks list→selector→preview→confirm→writeHookState→回读 | context 包含 Actor/Workspace/Provider/Thread；先核对归属再消费确认，写入尝试结束即清空所有快照和确认，因为 Provider 共用 CODEX_HOME | 不可替换成仅清当前 Conversation；与 Revert 的令牌消费顺序不同 |
| Schedule list/runs→数字选择→Store→修改；preview→confirm→创建/删除 | Task/Run 快照按 Conversation+Actor 隔离，数字解析后重新查 Store 归属；确认校验归属后消费，并有独立计时器 | 不能让普通 Map delete 跳过 confirmationTimers 清理；注入时钟和到期边界仍由服务定义 |

共同部分仅是按插入顺序有界淘汰、更新键位置及可选的过期清理。Queue/Revert 使用 Date.now，Schedule 使用注入的 now；Schedule 选择快照写入仅淘汰容量，读取才判过期，不能强行统一成一个后台 TTL 生命周期。

建议先提取 Application 内部的小型快照容器操作，复用现有 [`pagination.ts`](../src/application/pagination.ts) 的窄工具组织方式。容量和有效期仍由调用方明确给出，不增加通用缓存框架。

不能合并的业务差别：

- Queue 数字选择最终重新核对权威列表；完整 ID 不要求来自旧页面。
- Revert 的完整 ID 也必须属于最近页面，并需复核活动 Turn、最新 Turn 与 Queue 指纹。
- 计划任务按 Actor 和 Conversation 隔离，并从 Store 重新检查归属。
- Hooks 绑定 Workspace、Provider、Thread 和配置版本。

确认令牌的消费时机、失效范围和主动清理不同，不建立通用确认服务。尤其不能将 Surface 的审批交互注册表引入 Application，以免倒置依赖方向。与 U18/U19 只共享 Queue 的业务背景，不共享选择事务或错误适配。以上已核对源码，尚未观察过期、容量淘汰、重新列举、切换绑定与授权变化的运行行为。

## U03 渠道文本附件公共处理

证据入口：三个渠道的 [`Telegram file-input`](../src/surfaces/telegram/file-input.ts)、[`飞书 file-input`](../src/surfaces/feishu/file-input.ts)、[`微信 file-input`](../src/surfaces/weixin/file-input.ts)，以及共享 [`text-file-input.ts`](../src/surfaces/text-file-input.ts)、[`text-attachment-store.ts`](../src/surfaces/text-attachment-store.ts)。

三个渠道已经复用 UTF-8 校验和暂存库，但各自重复“解码明文字节、暂存、组装文件名和正文或路径及字节数”的处理。结果随后经各渠道输入适配器和 `textAttachmentBody` 提交共享输入队列。未来增加附件结果字段或修改该流程时仍需三处同步。

**关联复核结论。** 下载→明文完整性→decodeUtf8TextFile→TextAttachmentStore.prepare→textAttachmentBody→渠道输入提交的共同尾段成立，但收益仅限数行组装。Telegram/飞书先限制下载流，微信先限制密文、解密并核对明文长度/MD5；不能把所有下载前置判断移入公共尾段。decode 会移除 BOM/终端样式，返回 bytes 仍是原始明文字节数，而 32 KiB 内联阈值按清理后的文本 UTF-8 长度计算，二者含义不可合并。

暂存库已集中串行写入、50 文件容量、24 小时保留和托管路径；共享函数应接收现有 Store，不创建第二个实例或清理计时器。三渠道 catch 各自转换 TextFileValidationError 并保留 UserFacingError，提取须置于这些错误边界内。无 Store 时仍直接返回文本。U10 仅涉及后续聚合入口，U11 涉及关闭所有权，均不要求改变本文本处理规则。未观察真实下载或暂存；未发现当前三份结果已漂移。

建议只收敛取得合法明文字节后的公共尾段，优先扩展现有共享模块。平台下载、微信解密和 MD5/长度完整性校验、文件名长度单位、平台错误边界与引用消息拼装继续独立。不得改变 1,000,000 字节输入上限、清理后 32 KiB 内联阈值及暂存文件生命周期。

## U04 Storage 内同步数据库打开流程

证据入口：[`sqlite-binding-store.ts`](../src/storage/sqlite-binding-store.ts) 的构造函数和 [`sqlite-session-display-cache.ts`](../src/storage/sqlite-session-display-cache.ts) 的构造函数。二者由 [`gateway-component-graph.ts`](../src/bootstrap/gateway-component-graph.ts) 分别创建并登记关闭；展示缓存还被 [`session-cleanup.mjs`](../scripts/session-cleanup.mjs) 用于已确认归档后的缓存移除。

两者重复同一顺序：已有文件先只读校验、创建父目录、打开写连接、再次校验实际连接、保护权限、设置 `busy_timeout=0` 与 DELETE 日志模式、初始化；失败时关闭连接，同时保留初始化和清理双重异常。该顺序体现“不支持的已有库不能先被修改”的共享合同，以后调整打开或失败清理时需同步两份代码。

建议仅在 Storage 内提取窄的同步连接初始化辅助函数，让两个 Store 继续拥有各自 Schema 校验、建表、加载和错误上下文。辅助函数必须覆盖初始化回调失败时的连接清理，返回成功连接后再由各 Store 拥有生命周期。优先级低，不为两处重复建立可配置数据库框架。

Schema 版本、只读预检导出及安装预检消费保持不变。已有库只读预检与写连接复核不可合并为一次；不能把首次建库与已有库的权限处理时机改成统一前置。后续检查需覆盖 Gateway 构造失败清理、CLI 缓存清理和安装预检，且不改变磁盘合同。

不扩展到投递箱或计划任务库：投递箱有单写者锁、密钥与认证载荷及 maintenance 模式，计划任务库另有文件校验、内存库入口、外键和等待策略。这些实际差别不适合通过大量选项塞进同一打开函数。

**关联复核结论。** Gateway 创建 Binding Store 后立即登记构造清理，再创建展示缓存并登记；共享初始化必须连同 Binding Store 的 load 失败一起关闭连接，不能在建表成功后提前转移所有权。CLI 归档仅在 App Server 核验 archivedIds 后打开缓存并删除派生项，finally 关闭；缓存失败单独报告，不回滚已确认归档。安装预检则直接创建只读连接并调用公开 Schema 校验，绝不能为了复用构造器而打开写连接。U15 的安装构建只影响这些 dist 导出可用性，不改变只读预检合同。源码重复成立，无实测数据库故障，收益仍为低。

## U05 WebUI 写入结果未知与权威回读门禁

证据入口：[`use-versioned-settings-management.ts`](../webui/src/hooks/use-versioned-settings-management.ts) 与 [`use-management-confirmed-mutation.ts`](../webui/src/hooks/use-management-confirmed-mutation.ts)。Gateway/Codex 设置使用前者，Provider 设置和官方模型目录使用后者并显式开启 `trackReadback`。

**当前实现。** 两 Hook 共用 [use-management-readback.ts](../webui/src/hooks/use-management-readback.ts) 的未知写入谓词、写前快照与回读门禁。非 ApiClientError 异常，或除 management_audit_unavailable 外的 5xx 进入未知状态；成功写入也要求读取新快照。审计不可用例外对应后端写前拒绝合同，不是普通文案差异。预览阶段不登记写入；通用确认 Hook 仍仅在 trackReadback 为 true 时登记。

预览对象、revision 提取、确认令牌、成功返回值和 stale-revision 处理差异保持不变；下游 actionResult、writeUnconfirmed、readbackRequired 接口不变。已核对 Provider、官方目录、Gateway/Codex 设置及控件消费。新快照要求数据非空、不同对象引用、读取结束且无错误；revision 可以不变。回读只解除门禁，不证明上次写入成功，也不清除历史 writeUnconfirmed。

账户、Relay Key、任务、投递队列和重置券保持原有非 trackReadback 行为。取消不承诺回滚服务器已发生的写入，不自动重试失败操作。

**观察与限制。** Chromium 访问隔离 WebUI，经真实控件把空闲时间 15→16，预览、一次性确认、任务配置落盘与回读完成，出现保存回执且输入恢复。Hack 在浏览器拦截下一次设置写入及 GET，返回 503：页面展示未知结果和回读未完成，输入禁用；移除拦截并点击重试后，同 revision 的新快照解除门禁，未知结果提示及本地草稿仍保留。WebUI 正式构建和 oxlint 通过。隔离环境未启动 App Server，Codex 设置部分持续显示不可用；未宣称 Provider/官方目录或全部错误分类已实际操作，其共用 Hook 接入由源码核对。

## U06 模型能力检测的请求归属与取消

证据入口：[`use-custom-model-capability-probe.ts`](../webui/src/hooks/use-custom-model-capability-probe.ts) 与 [`use-provider-web-search-probe.ts`](../webui/src/hooks/use-provider-web-search-probe.ts)。前者由 Provider 编辑器的草稿和配置版本决定作用域，后者由已配置 Provider、模型和修订决定作用域。

**当前实现。** 两 Hook 共用 [use-scoped-probe-request.ts](../webui/src/hooks/use-scoped-probe-request.ts)，集中活动 AbortController、最新作用域及 enabled、重复发起限制和自身请求释放。begin 拒绝旧作用域回调，owns 同时检查控制器、取消信号和当前作用域；cancel 先撤销所有权再 abort，旧 finally 只在仍拥有控制器时释放。业务状态及结果校验留在原 Hook。

后端两个接口已共用 [`webui-custom-model-probe.mjs`](../scripts/webui-custom-model-probe.mjs) 的 `routeCustomModelCapabilityProbe`，统一并发名额、断连取消、正文限制与清理。前端 API 请求和超时也已有共享基础设施；`useApi` 的依赖驱动读取并不直接覆盖这些主动操作状态。

两个业务 Hook 保持原有调用接口，继续拥有输入、结果校验、错误映射和回填权限。

- 草稿工具检测的连接绑定 token 必须匹配，只有 `applyPatch` / `toolSearch` 的明确结论允许回填。
- 已配置网页搜索检测由后端解析凭据和协议，结果不得携带 `connectionToken`，仅供诊断展示。
- [`use-relay-reasoning-probe.ts`](../webui/src/hooks/use-relay-reasoning-probe.ts) 另有流式阶段、部分结果、历史缓存和有效期，不纳入此次提取。

已按引用核对 Provider 编辑器 resetForm、草稿变化及单模型按钮，网页搜索弹窗关闭、账号选择、目录修订失效和取消入口；两个 API 仍透传相同 signal，不改变请求、结果结构或主动检测次数，不新增自动检测。

**关联约束与限制。** 已配置检测仍拒绝任何 connectionToken 字段，草稿工具检测仍要求有效 token，webSearch 不可回填。后端共用并发名额与断连 signal，前端取消不承诺后端已释放，不自动重试 409。U01 的凭据规范化与 token 同值、U05 的持久写入回读均保持独立。WebUI 正式 TypeScript/Vite 构建与 oxlint 通过。隔离环境没有可用 Provider/模型目录，未使用真实凭据或发送可能计费的检测；关闭/取消/重新发起及迟到回调竞态只有源码控制流证据，尚无实际浏览器检测观察，不把它列为运行验证完成。

## U07 Runtime 材料 Reader 的单 Worker 所有权

证据入口：[`provider-settings-snapshot-reader.mjs`](../runtime/provider-settings-snapshot-reader.mjs) 的 `ProviderSettingsSnapshotReader`，以及 [`model-relay-material-reader.mjs`](../runtime/model-relay-material-reader.mjs) 的 `ModelRelayMaterialReader`。

**当前实现。** 二者共用 [single-worker-reader.mjs](../runtime/single-worker-reader.mjs)，集中惰性 Worker、在途读取合并、ready、初始化/读取时限、监听清理与 close。通信失败/超时/关闭取消进入终止流程；ok:false 仅拒绝本次读取，保留 Worker。关闭消息发送失败也继续持有退出 Promise；非 Windows 100 毫秒后可终止自有线程，Windows 继续等待 ACL helper 退出。2 秒关闭等待到期不释放物理所有权，重复 close 可继续等待。

调用方 [`provider-settings-watcher.ts`](../src/bootstrap/provider-settings-watcher.ts)、[`model-relay-service.mjs`](../runtime/model-relay-service.mjs)、[`model-relay-metrics-authorization.mjs`](../runtime/model-relay-metrics-authorization.mjs) 保持原接口与恢复策略。

两个公开 Reader 继续拥有 workerData、读取预算和安全错误工厂；Worker 内的配置校验、材料读取、指纹和业务结果不改，不扩大跨线程数据。

必须保留的差异：

- 设置快照只返回指纹和安全状态，并有 `readFresh`：先等待已有读取，再请求新快照；不能改成始终复用旧在途读取。
- Relay 按 Provider 材料和指标身份两种用途返回不同数据。普通预算分别为 2 秒和 750 毫秒，不能统一成宽松默认值。
- 两者初始化最多 5 秒，Windows 首次读取含 ACL 冷启动最多 7 秒；首次与后续读取不能共用同一宽预算。
- 设置读取失败带初始化、读取或校验阶段信息；Relay 保留自身安全错误，不透传任意 Worker 异常。
- 通道/超时失败与业务否定结果的处理分流必须保留；不能把配置校验失败统一改成终止并重建 Worker，否则会改变后续恢复、初始化开销和 Windows ACL helper 生命周期。
- 指标授权先等待早于样本发起的旧读取，再取得新快照；不能用通用缓存替代新鲜度要求。

已核对设置观察器停止、Relay 整体清理和指标授权 close 的所有权及异常消费。两个 Worker 仍先关闭 ACL helper，预算失败后等待真实退出再关闭 parentPort；宿主不以 Promise 超时替代物理退出。

不将数据库写者、投递只读 Worker 或进程监管器一起迁入该能力。它们的已发送写入、队列容量、确认与终止语义不同，U07 只针对上述两个单读取宿主的已确认重复。

**关联约束。** watcher 读取失败保留原配置并报告阶段，Relay 走 unavailable，指标授权返回 invalid_sample。指标样本到达后先等待旧 reading，再取得新 reading 的因果约束不变；U16/U17 的 Socket/子进程机制不混入此宿主。

**观察与限制。** Linux 使用真实设置 Worker：并发 read 返回同一 Promise，readFresh 返回不同快照对象，async_hooks 观察仅创建一个 Worker；关闭后读取拒绝。真实 Relay Worker 对无渠道配置返回 invalid，修正隔离配置后读取成功，Worker 创建数不增加，证明业务否定未重建；metrics 用途返回安全空身份快照。初始化期间 close 导致 pending 以 initialization/worker-unavailable 拒绝，重复关闭完成；全部关闭后观察 WORKER 资源数为 0。TypeScript、模块边界及相关 ESLint 通过。未人为制造 Windows ACL 卡住或 2 秒关闭超时，Windows/macOS、超时后二次等待仍为源码关联证据；未启动实际 Relay Listener 或共享 App Server。

## U08 配置管理与 CLI 总览的有效默认值投影

证据入口：[`gateway-config.mjs`](../runtime/gateway-config.mjs) 的共享 Schema 与 `validateGatewayConfigStructureDocument`；[`config-management.mjs`](../scripts/config-management.mjs) 的 `readConfigSnapshot`、`loadGatewaySettings`；[`config-metrics-management.mjs`](../scripts/config-metrics-management.mjs)、[`config-webui-management.mjs`](../scripts/config-webui-management.mjs) 的投影函数，以及 [`config-summary.mjs`](../scripts/config-summary.mjs) 的 `gatewayConfigSummary`。

**当前实现。** 配置快照保留原始 document 和 Schema 返回的 effective 视图。管理查询与 CLI 总览的审批、空闲释放、显示、日志、计划任务和指标从有效视图读取；可选 debug/webui 表缺失时使用各自已有 Schema 解析入口取得默认值。指标投影只消费已默认化或完整校验后的设置，不再重写范围与默认值。运行配置仍消费原 Schema，默认值本身不变。

**关联约束。** 原文与代理配置原文仍共同形成 revision；写操作只修改原始 document，保留 sourceByDocument、注释与未配置字段。CLI 总览的 WebUI“使用命令行默认值”、服务 enabled: undefined、tokenConfigured 及渠道存在性仍按原始配置判断。管理结构校验仍不要求启用渠道；非法值不通过展示默认分支掩盖。U09 的候选错误适配独立保留。

**观察与限制。** 在无渠道、无可选设置表的隔离配置上，真实 loadGatewaySettings 与 CLI 总览分别得到 900 秒、15 分钟、365 天/1000000 行及 WebUI 127.0.0.1:8787；enabled 仍为 undefined，总览显示“使用命令行默认值”。重复读取未改原文字节或 revision。通过 updateGatewaySetting 修改日志等级并回读得到 warn，文件保留原注释，未补写 approval/display/metrics/webui 等缺省表；旧 revision 再写返回 stale-revision。显式 WebUI false 展示关闭；非法 metrics retention_days:0 被拒绝。相关 ESLint、TypeScript 和模块边界检查通过。未重新执行浏览器 UI 或真实服务重载，HTTP 管理仍复用同一投影入口。

## U09 设置输入校验失败的领域错误适配

**已修复。** 基线中合法长度但格式非法的 terminalIdentity 经 Schema 抛普通 Error，进入 WebUI 500；长度错误却返回 400。现在 [`gateway-config.mjs`](../runtime/gateway-config.mjs) 的 Codex/Gateway 局部 Schema 通过 GatewayConfigValidationError 暴露不含输入值的路径与错误码，[`config-management.mjs`](../scripts/config-management.mjs) 仅将本次操作拥有的候选字段失败转换为 ConfigManagementError。身份联动与 App Server 时区格式遵循共享 Schema，删除管理层重复规则；网关时区同一调用边界一并适配。

**关联链路。** WebUI 预览、确认重演、最终应用及 CLI 共用 updateGatewaySetting。旧配置读取校验和 revision 比对仍在候选适配之外；未知字段路径、IO 和写入错误不映射为输入错误。WebUI 错误出口继续返回 400/409 与安全字段消息；[`translate.ts`](../webui/src/lib/i18n/translate.ts) 为 invalid-value 增加受控映射，并为身份提供中英文格式提示，不透传内部异常。时区仅走 CLI，未扩展 WebUI 白名单。U05 的未知写入门禁保持不变。

**实际观察。** 在任务独占临时目录、独立 CODEX_HOME 和回环 WebUI 实例中，真实 HTTP 预览 bad terminal、数值 42、跟随 CLI 却指定 custom 名称，均返回 400 invalid-value 与对应字段；合法 terminal/1.0 预览 200、确认 PATCH 200 且 consistency=confirmed，随后 GET 回读同值并取得新 revision；复用旧 revision 返回 409 stale-revision。缺少必需 codex 表的隔离配置仍返回 500 internal_error，未被误归为输入错误。网关时区不在 WebUI 白名单，HTTP 返回 setting_not_allowed；同一管理入口拒绝 MadeUp/Zone 为 ConfigManagementError，实际 CLI 保存 Asia/Shanghai 后回读一致。隔离服务已关闭，未接触真实用户配置或重启服务。

**检查与限制。** Gateway check、相关 ESLint、WebUI 自身 TypeScript/Vite 构建、i18n 键与占位符检查通过。曾用根目录 TypeScript 5.9 检查 WebUI 产生无关类型错误，改用该子项目声明的 TypeScript 6.0 正式构建后通过；未修改依赖或绕过检查。未执行浏览器交互，未模拟磁盘 IO 失败或所有字段组合，未以静态检查代替上述 HTTP/CLI 观察。

## U10 渠道输入聚合的等价转发层

[`surface-input-coalescer.ts`](../src/surfaces/surface-input-coalescer.ts) 只创建 [`SurfaceInputBatcher`](../src/surfaces/surface-input-batcher.ts)，将 `enqueue`、`flushPending`、`close` 原样转发，并为选项和结果类型增加别名。真正的 Actor 隔离、图片容量、聚合键、提交顺序与关闭规则均在 Batcher 内。

Telegram Bot、飞书 Adapter 和微信 Conversation Adapter 都通过 Coalescer 调用；Surface 根入口又导出它。当前包装层没有独立调度或错误语义，容易让后续维护者误以为存在两种聚合算法。

建议保留一个明确命名的实现和公开入口，同时调整三个渠道的类型与导入，不保留新的兼容包装层。Batcher 当前还暴露图片容量只读属性，统一入口时应明确是否仍属公开能力，避免无意扩大接口。这是低收益收尾项，不应借机改聚合时机、取消或普通消息提交行为。

**关联复核结论。** Telegram Bot、飞书 Adapter、微信 Conversation Adapter 的 enqueue 和 flushPending 均经过此包装，命令前 flush 按 target+actor 而非整个 Conversation 刷新。Batcher.close 会停止接收、刷新 pending 并等待在途集合；包装 close 只 await 同一行为。去掉包装不能顺带把 close 改成丢弃 pending 或改写错误汇总。U03 的附件处理只是上游输入来源，U11 的 Surface 关闭只是生命周期调用方，二者不要求合并到 Batcher。调整清单包括 Surface index 的类型导出、三渠道字段类型/构造和模块文件索引；不需新增聚合算法。未观察实际消息聚合。

## U11 渠道关闭时继续清理与失败汇总

证据入口：[`telegram/bot.ts`](../src/surfaces/telegram/bot.ts) 的 `stop`、[`feishu/surface.ts`](../src/surfaces/feishu/surface.ts) 的 `stopOnce`、[`weixin/surface.ts`](../src/surfaces/weixin/surface.ts) 的 `stopOnce`，以及 [`surface-manager.ts`](../src/bootstrap/surface-manager.ts) 的 `stop` / `stopSurface`。

**当前合同。** 三个渠道通过 [surface-shutdown.ts](../src/surfaces/surface-shutdown.ts) 收集同步抛错与异步拒绝，按各自依赖顺序尝试后续清理，结束后以 AggregateError 报告所有失败。原先任一前项失败会跳过后项；Telegram 的 finally 只保证代理销毁，微信的 finally 内也会短路。

**关联链路。** SurfaceManager.stop→Surface.stop→输入、媒体、交互、输出 close。飞书仍先关闭连接再等待启动通知、Inbox 和 Adapter；视频提前取消并在原位置等待，OAuth/命令中心先于输出关闭。Telegram 仍提前停止轮询，排空输入和输出后等待生命周期结算，最后销毁代理。微信仍先停输入、进行生命周期通知，再关闭媒体、交互和输出。提前启动的视频和轮询关闭立即安装失败处理，避免等待其他步骤期间出现未观察拒绝。

**所有权与失败。** 三个 Surface 均缓存停止结果；Telegram 补齐单次关闭归属。失败仍向外抛出，SurfaceManager 保留失败实例的 attempted 状态，不发布停止成功；重复 stop 返回原结果，不重启资源或承诺自动恢复。资源各自既有等待预算与共享 App Server 的非所有权不变。未把关闭全部并行化，也未修改 SDK 调用或微信生命周期通知本身的降级语义。

**观察与限制。** Linux 上使用编译后的真实 WeixinSurface 构造及 stop 入口，未 start、无平台网络调用：正常部分构造实例连续停止均完成。Hack 经可注入的媒体端口同时触发视频异步拒绝、文件同步抛错，观察到 AggregateError 含两项，后续 images/audios 均执行，真实 Outbox.closed 为 true，重复 stop 返回同一 Promise，未观察拒绝数为 0。此证据只覆盖本地关闭控制流；没有真实 SDK 关闭故障、在途平台请求、macOS/Windows 服务停机或泄漏观察。TypeScript、模块依赖检查和构建通过；ESLint 指出的冗余 unknown 联合类型已修正。

## U12 HTTP chunk 背压写入

证据入口：[`chat-io.ts`](../src/provider-proxy/chat-io.ts) 的 `writeChatData`（约 50 行），以及 [`proxy-delivery.ts`](../src/provider-proxy/proxy-delivery.ts) 的 `writeResponseChunk` / `waitForDelivery`（约 21、33 行）。消费者分别是 Chat Bridge、原生 Proxy 和 Model Relay Server。

两处重复检查响应和取消状态、注册 drain/close/error/abort、调用 response.write、等待背压解除，并清理监听和超时。以后修正同步 write 异常或关闭竞争，需要维护两份机制。目前未确认实际交付故障。

建议仅复用支持 string 与 Buffer 的 HTTP chunk 写入原语，保留调用入口及默认预算。Chat 实现在确认背压后启动 timer，另一实现在调用写入前启动并于同步成功后清除；提取前明确实际交付等待的预算合同，保留调用方使生成计时失效的回调。

不得合并普通交付与终态预算、协议收尾、指标与转储状态、WebSocket send 回调或 pipeline。Relay 带正文的 endResponse 和错误响应独立 signal 也不纳入本项。实施后需沿三个消费者核对取消、同步失败、背压、关闭与终态交付，不能只检查共享函数。

**关联复核结论。** 原生 Proxy 在 chunk 到达时暂停上游，串行 forwarding 中交付成功才 resume；Chat Bridge 按转换事件逐条 await；Relay 又有终态专用 controller/timer。因此原语只能承诺本次 write 的接受/背压等待，不能承诺整次响应结束或上游取消。原生 Proxy 还在原语外用 waitForProxyOperation 限制等待，不能因“重复超时”删掉外层预算：它也覆盖忽略取消的在途操作。两个实现错误文案和 settled 防重不同，提取时保留受控阶段类型及防重收尾，不统一整条指标状态机。未观察实际断连或背压。

## U13 审查运行树的选择规则

证据入口：[`sqlite-request-metrics-store.ts`](../src/observability/sqlite-request-metrics-store.ts) 的 `metricsWriteScopes`（约 233 行），以及 [`sqlite-auto-approval-review-metrics.ts`](../src/observability/sqlite-auto-approval-review-metrics.ts) 的 task/session summary 与私有 `summary`（约 59–82 行）。[`request-metrics-writer.ts`](../src/observability/request-metrics-writer.ts) 的 `waitForCurrentWritesInScope` 消费前者；Bootstrap 完成卡先等待该写入范围，再读取后者的审查统计。

**当前实现。** 两处共用 [sqlite-review-run-scope.ts](../src/observability/sqlite-review-run-scope.ts)：任务以精确 Thread/Turn 为根；会话保留审查轮次、官方执行轮次、有 Turn 的模型请求、子代理父轮次四来源，再按 parent_thread_id + parent_turn_id 递归。SQL 片段及参数顺序统一，仍使用 UNION 去重，不持有连接或物化运行树。

**关联合同。** Writer 捕获初始 enqueuedCount→等待写入→数据库解析范围→检查该水位内失败；Bootstrap 只在 persisted 为 false 时降级 usage.coverage。sessionReview 写入失败匹配仍保留根 Thread 通配，以覆盖没有数据库记录的失败；普通 session 线程树不改。摘要的 pendingParentTurns、历史完整性、事件覆盖率与 Token 缺失判定仍独立；普通请求仍排除审查用途，取消等待不取消实际写入。没有改变表、索引或持久格式。

**观察与限制。** 隔离 SQLite 通过真实 Store 写入根轮次、子轮次关系及一项 approved 审查；task 范围返回两轮，task/session 总数均为 1，无关父 Turn 总数为 0，session 写入范围保留根 Thread 通配。Hack 加入根↔子循环后仍返回两轮且只统计一次。真实 BufferedModelRequestMetricsWriter 将缺字段样本交给 Store 拒绝，尚无记录的 empty 根会话范围返回 persisted=false，无关范围返回 true。连接经 Writer 正常关闭。TypeScript、模块边界、相关 ESLint 和 Gateway 构建通过。未生成真实平台完成卡，IPC 及平台渲染未实测，跨边界降级路径为源码核对。

## U14 Gateway 与 Codex 版本兼容谓词

**当前实现。** [gateway-version-policy.mjs](../scripts/gateway-version-policy.mjs) 无 I/O 地定义唯一 `isGatewayVersionCompatible`：基础版本相等，或追加受控的 -fixN / -rc.N 后缀。[check-gateway-version.mjs](../scripts/check-gateway-version.mjs) 与 [source-update.mjs](../scripts/source-update.mjs) 共用；更新器保留原公开导出，新模块加入 npm files 与脚本索引。

**关联约束。** 门禁仍核对 package.json 与 src/version.json 一致；更新器仍独立执行候选提交、防降级和官方稳定版限制。不把这些规则并入兼容谓词，不引入宽松 SemVer。更新器导入纯模块，不执行当前源码树的 check 脚本。U15 构建阶段独立。

**观察与限制。** 实际版本门禁通过；更新器旧导出与新模块为同一函数，手动调用观察正式版、fix1、rc.1 被接受，fix0、rc.0、基础版本不同、正则元字符替代版本点均拒绝。相关 ESLint 通过；npm pack --dry-run --ignore-scripts 清单包含新模块及更新器。当前可用 Node 为 24.21.0，此清单检查未替代 CI 锁定 Node 22.13.0 的安装验证；未运行真实源码更新或服务启停。

## U15 源码取得后的安装构建阶段

证据入口：[`install.sh`](../install.sh) 约 158 行、[`install.ps1`](../install.ps1) 约 132 行，以及 [`source-update.mjs`](../scripts/source-update.mjs) 的 `buildCheckout`（约 853 行）。三处维护相同顺序：确认 npm ignore-scripts、安装根依赖、按设置安装 Hook、Gateway build/check、WebUI 安装/build、检查两个产物入口。

这使必要构建步骤及脚本禁用政策需要跨 Shell、PowerShell、JavaScript 同步。建议仅收敛仓库取得后的阶段定义和执行入口；入口必须能在依赖未安装时加载，不能依赖 dist 或尚未安装的包。

安装器继续拥有工具检查、克隆、平台操作与本次 checkout 的失败清理；更新器继续拥有候选身份、取消、备份、切换和恢复。构建执行须保留更新取消信号、既有进度/错误反馈和命令运行方式。`install:global --prepared` 只消费已有产物，不得借去重重新安装或构建。显式 CODEX_BINARY 处理也不应被改写。

后续实施需联动首装、更新、install-global-source、prepare-package 与 npm 生命周期，并按 CI 固定 Node/npm 观察实际路径。没有运行安装或确认构建产物。

**关联复核结论。** 更新链先验证候选版本/提交/快进关系，再 buildCheckout，再 inspectStagedInstallation；提取构建不能把安装预检提前到 dist 尚未生成时，也不能把运行入口改成加载未安装依赖。首装与更新的三份阶段序列确实一致，但 prepare-package 先检查已有依赖、仅在必要时安装，且显式 ignore-scripts 时不构建；它不是第四份等价的全量构建流程。install-global-source 的 prepared 分支只校验并消费产物，还拥有 Codex 与原生产物检查。建议仅共享三份相同阶段，保留这些相邻入口的不同合同。与 U14 关联的是候选构建中的 check，不是版本与安装事务应整体合并；源码读取可确认依赖顺序，尚未观察任一平台安装恢复。

## U16 一次性私有 IPC 交换的底层收尾

证据入口：[`app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs) 的 `readSupervisorResponse`（约 917 行），以及 [`private-ipc.mjs`](../runtime/private-ipc.mjs) 的 `requestPrivateIpcJson`（约 233 行）；Model Relay 控制已使用后者。

Supervisor 的 inspect/ensure/release/apply 一次请求另行维护连接、写入、字节上限、超时、取消与 socket 销毁。现有差异不能直接抹平：Supervisor 在创建连接后计时，等 EOF 返回原文；共享 helper 将异步端点校验纳入预算，以换行完成 JSON 交换，失败拒绝为未确认。协议不兼容与传输结果未知也不是同一种错误。

建议先在现有 private-ipc 边界收敛有界连接、收帧和取消收尾，明确帧边界、无效 JSON、端点验证预算后再复用。Supervisor 继续负责版本、Provider 身份、拓扑和领域分类。本项是条件性重构建议，尚无运行故障证据。

租约必须保持活连接，Gateway 状态由服务端主动推送，Delivery 必须区分确定未发送与发送后结果未知；这些不能套入完成即销毁或统一返回 undefined 的机制。实施需核对 Windows 描述符/ACL 路径及调用方失败分支，而不能仅替换 helper 名称。

**关联复核结论：降为低优先级，暂不直接替换 helper。** Supervisor 服务端返回换行 JSON 并结束连接，但 inspect 消费端还区分无响应（允许就绪所有者按原预算重试）与有内容但拓扑无效（incompatible）；ensure/release 校验 Provider，apply 校验设置协议及拓扑变更。Relay 控制则另绑定 requestId、digest、动作与字段白名单。公共 JSON helper 当前把解析失败和传输未确认合为拒绝，直接替换会抹掉 Supervisor 的就绪决策。只有先证明可保留这类分类且不增加宽泛选项，才值得提取底层收尾；不要求为去重先建传输框架。Windows 端点验证预算差异仍未实机观察，U07 的 Worker 关闭及 U17 的进程退出不纳入此 IPC 合同。

## U17 自有子进程退出观察

[`process-lifecycle.mjs`](../runtime/process-lifecycle.mjs) 约 262 行、[`windows-service-host.mjs`](../scripts/windows-service-host.mjs) 约 203 行的 `childExitedWithin`，以及 [`app-server-supervisor.mjs`](../runtime/app-server-supervisor.mjs) 约 1119 行的 `waitForChildExit`，重复退出状态检查、exit 监听、超时和监听清理。消费者分别是终止升级、Windows 服务停止和 Proxy 收尾。

建议在 process-lifecycle 公开窄的退出观察能力；各所有者决定预算、timer 是否维持事件循环和失败后的资源处理。现有实现对于 signalCode、注册后复查、超时后二次检查与 unref 有差别，统一前必须逐项明确，不能当作完全等价直接替换。

该项优先级低。IPC 优雅停止、stdin EOF、TERM/KILL 升级、Unix 进程组消失、输出管道 close 与更新/卸载安全边界均不等价，继续由原所有者处理。没有观察跨平台进程停止故障。

**关联复核结论。** Windows host 的 control.send 成功只是停止请求已交付，随后仍等待子进程退出，失败才调用 terminateChildProcess；Supervisor 的 Proxy 先关闭 stdin，等待 1 秒后升级终止；process-lifecycle 在 TERM 和 KILL 后分别观察。故统一操作只能返回是否观察到 child 退出，不应自己发信号或清除进程树所有权。Supervisor 外层 stopProxyChild 已检查 exitCode 与 signalCode，其内层 helper 只检查 exitCode，不能据此单独宣称信号退出一定导致错误升级；需要结合调用间竞态观察。timer.unref 差异影响宿主是否继续存活，保留为所有者决定。无需把输出管道 close 当成 exit，同样不能因 exit 成功就证明整棵进程树消失。

## U18 待生效选择与原生 Queue 的互斥操作

**实施与证据。** 四入口已共用 ConversationService 私有 `withGuardedSelection`，保留锁内空闲检查、前后 Queue 读取，仅受控冲突清理本地待生效选择。Fast status 仍走锁外只读分支，Fast 默认设置写入、startPlan 与最终 Turn 的 Provider/活动状态守卫均未改变。手工调用编译产物并注入选择期间 Queue 冲突，观察顺序为 lock→idle→queue→selected→queue→clear，返回 queue.pending-overrides；目录普通失败仅执行 lock→idle→queue，原错返回且未清理。类型及构建通过。该观察仅覆盖局部保护，未使用真实模型目录、创建 Turn 或运行原生客户端并发，不能证明跨端原子性。

证据入口：[`conversation-service.ts`](../src/application/conversation-service.ts) 的 `togglePlanMode`、`selectModel`、`selectEffort`、`selectFastMode`（约 1362、1433、1450、1467 行），以及 [`thread-queue-service.ts`](../src/application/thread-queue-service.ts) 的 `rejectPendingOverrideChange`。

四处重复取得 Conversation 锁、要求空闲、选择前读取 Queue、执行异步选择、选择后再次读取 Queue，并在受控 queue.pending-overrides 冲突时清除待生效选择。后查必须保留：读取模型目录或预设期间，原生客户端可以改变 Queue，本地锁无法阻止。待生效选择最终经 startNewTurn/turnOverrides 传给 Client，维护的是同一“原生 Queue 与渠道待生效覆盖互斥”不变量。

建议只在 ConversationService 内提取私有受保护选择操作，让四入口提供具体选择动作，不新增跨模块事务框架或 Gateway Queue 副本。当前未确认冲突行为失效。

保留 fast status 的锁外只读分支；startPlan 还会启动 Turn，不能机械套入只返回状态的函数。Provider 切换和用户默认 Fast 设置仍由具体选择实现负责，冲突不能反向补偿已写入默认设置，也不能把任意异常当作需要撤销选择。实施需核对四个入口和最终 Turn 覆盖消费。

**关联复核结论。** 四入口确实重复相同局部保护，但不是跨 App Server 的原子事务：两次 Queue 读取之间及之后仍允许原生客户端活动。selectFastMode 在设置 pending 前可能已写入官方默认速度；冲突后 clearPendingSelections 只清本地模型与协作模式选择，不能声称回滚整个选择操作。最终 startNewTurn 在 ensureSession 后复核活动状态和 Provider 一致性，调用 startTurn 成功后才 markApplied，这些下游守卫必须保留。建议把提取命名为“受保护的选择操作”，不包装成保证跨端原子性的事务。U02 的页面快照不参与此保护，U19 的 unavailable 分类会影响 hasItems 的结果，实施顺序宜先稳定错误分类再提取四入口。未运行原生客户端并发场景。

## U19 Queue 官方错误识别边界

**实施与证据。** Application 端口已定义 `ThreadQueueError`，六个 Client Queue RPC 只在请求拒绝处适配 `JsonRpcError(-32600)` 与锁定版本的精确文字（条目不存在保留官方动态 ID 后缀），响应转换及 Provider 路由失败不进入分类。命令、Revert、hasItems 与后台释放消费同一分类；后台 empty/unavailable 之后的活动与路由空闲复核保留。手工操作编译产物观察到官方 empty → queue.empty；同文普通 Error、错误码 -32603、附加未知后缀均原样传播并映射 queue.failed。类型、边界检查及构建通过。未连接用户 App Server、创建真实 Queue 或触发后台释放，真实 RPC 至渠道反馈尚未观察。

证据入口：[`thread-queue-service.ts`](../src/application/thread-queue-service.ts) 的 `queueUserFacingError`（约 349 行）和 `hasItems`；[`conversation-service.ts`](../src/application/conversation-service.ts) 的 `dispatchNativeQueueBeforeRelease`（约 1861 行）；[`client.ts`](../src/codex-client/client.ts) 的 Queue 请求和 [`provider-routing-client.ts`](../src/codex-client/provider-routing-client.ts) 的转发。

Application 通过官方英文异常正文识别 unavailable、empty、full、busy、not-found 与 reorder-conflict；后台释放又单独匹配 queue is empty。普通命令、释放和 Revert Queue 读取因此依赖协议文字。官方证据来自锁定源码 83086188ae0614bd882818ff1aa23f3194962012，路径相对于其 codex-rs 目录：

- app-server/src/request_processors/thread_queue_processor.rs 的活动 Turn、Queue 不可用分支，以及 ext/queue/src/service.rs 的空队列、条目不存在分支。
- thread-store/src/queue_store.rs 的 LocalQueueStore.enqueue（约 103 行）将存储 RowNotFound 转为 InvalidRequest，生成队列容量超限文字。
- state/src/runtime/queued_items.rs 的 reorder（约 181 行）在条目集合不匹配时生成 InvalidInput；thread-store/src/queue_store.rs 的 reorder（约 141 行）将其转换为 ThreadStoreError::InvalidRequest。
- thread_queue_processor.rs 的 queue_error（约 325 行）将上述存储 InvalidRequest 转为 RPC invalid request，使 full/reorder-conflict 的文字到达 Client。

以上已核对本地锁定源码；未获取其他版本或运行上游测试。分类实现需要同时考虑错误结构和文字，不能仅凭任意异常包含同一英文片段就认定来源。

建议由 Application 的窄 Queue 端口定义稳定失败分类，Client 在 RPC 适配处按锁定错误结构与文字转换，Provider Routing 原样传播。Application 保留分类到用户文案、后台释放行为的映射，不再识别官方英文。不要扩成所有 RPC 的通用错误框架。

用户 queue start 遇 empty 应反馈，后台释放遇 empty 继续协调；hasItems 对 unavailable 的既有策略不能扩展到未知错误。读取的有界重试与写操作不重试保持不变，写结果未知及本地响应裁剪失败不能伪装成确定未写入。Revert 和 Routing 其他英文分类属于不同业务，不纳入 Queue 提取。实施需核对命令、释放、回退与 Provider 转发四条消费路径。

**关联复核结论。** 六个 Client 请求中 list 允许 overload 重试，其余写操作关闭；RPC 返回后还有 toThreadQueue* 裁剪/验证，list 另有页数限制。稳定错误适配应限定在能证明来自 Queue RPC 的错误边界，不能把响应转换失败、Provider 路由失败或任意 Error 文本都分类成官方 empty/unavailable。Provider Routing 按 Thread 转发，Application 的 Queue、Revert 读取共用映射；后台释放另将 item-not-found 视为 busy，只有 empty/unavailable 才进入后续本地活动与路由空闲复核，不能把分类成功理解为可以直接释放。关联 U18 时须保留 unavailable 的现有政策，不扩大为所有连接失败均视空。锁定官方错误来源沿用同一基线的已读证据，未新增协议支持或观察真实 RPC 失败。

## 已检查且不建议合并的部分

- 渠道命令名称与说明已有 Application 命令目录和 Surface 共享帮助入口；不能仅为减少菜单文件而将平台交互形式合并。
- 投递策略已有共享判定入口；平台 Outbox 的正文流状态机有不同语义，保留独立实现。
- 受管 Provider Key 校验已复用 [`model-provider-definitions.mjs`](../runtime/model-provider-definitions.mjs) 的 `isManagedProviderApiKeyValid`。DS/OCG 与 CCG/CLP 的格式规则不同，自定义 Provider 又有不同支持范围。
- 绑定库、展示缓存、指标库、计划任务库与投递箱拥有不同数据、事务和恢复合同；文件同为 SQLite 不构成合并存储的理由。
- 不将有界 Worker 或异步 Hook 的相似结构作为统一生命周期框架的充分理由。写者、只读 Worker、流式检测和普通读取的取消、未知结果及实际退出要求不同。
- Core 的断线、Revert、解绑/归档清理集合不同，不能机械合并。生产重连路径传 affectedThreadIds；断线保留 phase/消息去重可能服务于重放，Revert 明确保留活动 Turn 等待官方完成。目前不足以判定清理遗漏，未列为已确认缺陷。
- Approval 的原始 RPC 拒绝、业务归属拒绝、平台交互安全默认值位于不同信任边界；不因 switch 相似合并。Event Bus 容量队列也不能代替审批期限与取消协调。
- 服务选择和顺序已有共享定义；all 在安装、启动、停止、状态查询中的含义不同。Unix 模板、Windows Job/IPC、launchd 与 systemd 的外观相似不能抹平进程所有权。
- [`logger.ts`](../src/observability/logger.ts) 的 `safeErrorMetadata` 与 [`surfaces/error-metadata.ts`](../src/surfaces/error-metadata.ts) 有相似异常类型裁剪，但允许输出的字段不同：前者不保留 message，后者可呈现明确的 `UserFacingError` 和白名单业务分类。Telegram 还基于 SDK 错误追加安全分类。当前不建议用同一个宽松序列化器替换，以免扩大日志或外部错误的暴露范围。

## 集中处理建议

优先处理 U09 的输入错误出口分叉和 U11 的关闭失败短路。随后按边界分别处理 U01/U08/U14 的共享规则、U05/U06 的前端状态、U13 的统计范围。Queue 先稳定 U19 的错误分类，再处理 U18 的局部选择保护。U07 涉及资源所有权，应独立评审；U15 涉及安装事务，单独安排真实安装/更新观察。U02/U03/U04/U10/U12/U17 为低优先级局部去重；U16 仅在保留错误分类且不增加宽泛传输框架的前提下考虑，不作为必须实施项。

修复以逐项状态为准。凭据规范化、存储格式、审批策略和检测副作用仍须遵守每项已明确的边界，不随去重扩张。

| 关联项 | 共同边界 | 实施时必须联动的部分 |
| --- | --- | --- |
| U01、U06、U09 | 凭据输入、检测与错误适配 | Key 规范化、连接 token、保存预览 HMAC 保持同值；共享校验不能泄漏普通内部异常 |
| U05、U08、U09 | 设置读取→预览→写入→回读 | 原始配置与有效默认值分开；revision 不变不等于回读失败；确定未写入与结果未知分开 |
| U03、U10、U11 | 附件→输入聚合→渠道关闭 | 原始明文字节数与清理后大小分开；关闭仍刷新已接收输入并处理自有资源 |
| U07、U11、U16、U17 | 取消与资源释放 | 共享的是明确相同的窄操作，Worker、Surface、Socket、子进程的所有权及成功证据不统一 |
| U02、U18、U19 | Queue 选择、互斥与失败分类 | 页面快照不替代权威列表；分类不改变释放决策；本地锁不承诺跨端原子性 |
| U04、U14、U15 | 安装/更新与运行前检查 | 无依赖入口、npm 文件清单、候选构建和只读数据库预检顺序保持完整 |
| U12、U13 | 交付状态与指标完整性 | 背压等待、生成完成、写入水位和统计 coverage 各自承担不同证据，不能互相替代 |

## 审查覆盖与证据限制

初审覆盖全部 18 个 src 一级模块与主要工程入口。会话链、数据链、平台工具链由只读协作审查完成，主代理审查 Bootstrap、Config、Surfaces、WebUI 与管理后端并核对关键发现。下表说明模块职责、公开接口及主要链路的覆盖，逐项关联复核状态以问题清单为准；两者均不代表所有文件和所有分支逐行审计。

Astra 独立复查覆盖 U01–U19 的重复实现、关键调用方、下游消费与建议边界，主代理核对其指出的修正并合入对应条目。该独立复查未重新执行全仓初审或静态检查，不为下表全部模块覆盖提供第二份独立证明。

| 范围 | 已检查的主要链路 | 结论与剩余限制 |
| --- | --- | --- |
| application | 命令/输入→Conversation→选择与 Turn；Queue/Revert/Hook/任务用例、后台释放 | U02/U18/U19；未穷举模型目录、Reserve 全状态和全部命令反馈 |
| conversation-core | 通知归约、恢复、文本与终态、计时、断线/回退/Thread 生命周期 | 归约已有集中边界；清理差异见上，未完整审计长期缓存上界 |
| session-routing | ensure/resume、新建、前后台容量、转移、解绑/归档、订阅恢复、派生缓存 | 生命周期锁和 Workspace 校验已有共享；未穷举接管失败与存储异常组合 |
| approval | 请求登记→祖先归属→交互排队→决定；超时、取消、迟到决定 | 状态机已有共享；未观察真实平台送达和取消 |
| policy | Actor/允许名单校验、Workspace 整体替换与冻结、选择器 | 现有小型策略保持独立，无新增项 |
| codex-client | Transport/RPC、Provider 路由、Thread/Turn/Queue/History、通知、审批适配 | U19；未逐分支审计全部 Plugin/MCP/Hook 字段、图片上传和 Windows Duplex |
| codex-protocol | 受控导出、版本、公开 CLI 合同、Queue 锁定错误来源 | 未重新生成或逐个比较生成文件，不把类型存在视作支持证明 |
| event-bus | 有界队列→独立消费者→预算释放→drain/close | 容器与跨订阅预算分工明确；未观察拥塞场景 |
| model-api | 原生 Chat/Responses 校验、思考策略、双向转换、私有项与用量尾帧 | 已有共享规则；未穷举所有图片/工具组合 |
| provider-proxy | HTTP/WS 出站→响应观察→背压→终态指标；Chat Bridge 与转储接口 | U12；协议收尾保留独立，未逐项审计全部 Header/正文捕获 |
| model-relay | 鉴权/预留→模型解析→公平等待→材料复核→出站→生成与交付收尾 | 租约、执行许可、指标槽不同；未观察撤销、计费和网络交付 |
| observability | 指标 Writer/Worker/SQLite→范围查询→审查摘要；额度与用量汇总 | U13；未穷举 Schema、保留裁剪、排序和额度估算数学 |
| delivery | 接受→Journal/Worker→授权派发→ACK/未知结果；维护与只读查看 | 编解码与读取已有共享；未逐条审计 SQL 状态转换或实际重启恢复 |
| scheduled-tasks | 规范化/时间计算→自动/手动领取事务→派发→结果/恢复→清理 | 业务领取入口已复用；未运行 DST/崩溃或穷举更新 SQL |
| storage | Memory/SQLite binding、提交后内存更新、启动加载、展示缓存 | U04；未观察损坏、并发写入和跨平台权限 |
| bootstrap | 组件装配、Surface 注册/停止、重连/恢复、账户查询、持久交互、完成卡 | U11/U13 消费已核对；装配所有权不宜变成通用基类 |
| config | Schema→运行投影、管理投影/CLI 总览、热加载分类 | U08/U09；未逐个字段审计完整配置与所有向导 |
| surfaces | 三渠道输入/附件/聚合、命令、审批身份复核、投递策略、停止链 | U03/U10/U11；平台下载、加密、卡片、reply window 保持独立 |
| WebUI 前端 | 路由/导航/页面主要请求链、API/AuthGate、管理与检测 Hook、Queue/流量读取、组件复用边界 | U05/U06；未逐行审查所有视觉组件、全部文案及无障碍，也未运行浏览器 |
| WebUI 后端 | 服务入口→来源/Token/限流→管理确认→设置/Provider 路由→审计与异常出口 | 已核对 U05/U09 的错误合同；未穷举每个管理动作和字段 |
| Runtime | App Server/Gateway 所有权、停止预算、私有 IPC/路径、Supervisor、Provider 材料/凭据入口 | U01/U07/U16/U17；未完整展开 Provider 启停、账户事务、ACL/TOCTOU 和原生宿主 |
| CLI/bin/服务模板 | 命令分发→服务选择→平台控制；Unix 八份模板与 Windows host | 服务顺序已集中；未逐一审计非服务子命令、全部 Doctor 项或运行服务管理器 |
| 安装/更新/卸载/npm | 两安装器、源码候选/构建/切换入口、prepared 生命周期、卸载身份与取消 | U14/U15；未运行安装/删除，未穷举所有恢复分支 |
| 生成/静态检查/Hook/CI | 协议生成与比较共享引擎、边界检查、verify 计划、Hook、三个工作流和升级验证入口 | 未完整审计检查器解析与 PR 生成算法，未验证远端保护或运行 CI |
| 文档与独立筹备目录 | 根索引、模块职责与主题文档；im 的独立筹备定位 | im 尚无当前 Gateway 实现可合并；未扩展审查旧快照、备份、依赖目录或技能目录 |

审查基线上的模块与运行时边界静态检查通过，其允许表、公开入口、无循环、Surface 隔离和目录依赖检查没有报错；这不是功能或安全通过的证据。后续修复的静态检查、实际链路观察与未验证范围分别记在对应条目；未读取真实配置/凭据，未执行功能测试或三平台关闭场景。

至此全部一级模块与主要工程入口均有上述覆盖记录；仍未穷尽的分支已在表中标明。本记录是用于集中治理重复规则的架构审查，不是全仓安全审计或逐行缺陷清单。后续新增建议仍需给出实际调用方、共享合同、下游影响和应保留的差异。
