# 全项目链路验证与修复清单

**文档状态：已完成阶段的历史审查与证据记录。** L01–L19 的审查及确认问题修复已随 `ee39c1f7`
交付，并通过 PR #268 合入 `main`（`8d6dc9d5`）。下文保留当时的计划、执行顺序、阶段状态和观察；
Astra 前置审查、逐项单独提交及“可开启／下一项”等表述仅说明当时安排，不是后续任务的执行要求。
当前开发与交付遵循[开发规则](development-rules.md#development-workflow)，现行功能合同见各条目引用的专题与模块文档。
未观察事项仍保留在各条目的限制中；后续补证在具备对应环境和授权后按具体边界开展，引用本页证据，
不重新启动整份清单，也不因本页转为历史记录而视为已验收。

本轮从重复实现治理转向授权、状态一致性、失败恢复与资源所有权。清单基线为
`1b1981057bdd3fc96ef38fb8b1c29fa3a3994b15`，覆盖当前 Gateway、Runtime、CLI、WebUI
及交付工程入口；它是待审查范围，不是缺陷清单或全项目已经通过的声明。

沿用 [U01–U19](consolidation-review.md) 的逐项记录方式，不重复提取已完成的共享实现。
[Provider 事务记录](provider-transaction-review.md) 保留 P01/P02 与 V01/V02 的原始证据，
本页只引用尚未覆盖的边界。既有证据须核对代码和输入是否仍适用，不能由局部成功推断全路径成功。

## 执行与完成标准

先由 Astra 独立审查本清单的范围、事实依据、遗漏、依赖和可执行性；主代理核对并修订，
解决文档阻断项后才开始以下链路关联审查。文档审查不替代实现审查，也不预先批准具体改法。

每项按入口、授权/前置条件、共享接口、实现、权威回读或持久化、最终消费、取消与清理追踪。
先建立业务不变量，再记录缺陷的触发、根因、下游影响和关联调整；无缺陷也记录已查边界。
修复仅限确认问题，不预设重构。实现变化要有针对失败/对抗输入的实际观察及可用的用户路径；
不新增或维护测试、探针脚本、夹具套件。直接使用生产入口与临时隔离材料观察，不修改真实用户数据。

状态分为：待审查、审查中、待修复、已修复待观察、已审查（附证据限制）、待环境。
源码结论、隔离运行、真实服务/平台观察和静态检查分别记载；缺少环境只阻塞对应观察，
不阻塞该项源码关联审查及已授权修复。一次完成一个条目的审查、必要修复和记录，再单独提交。
若发现跨项共享缺陷，明确主修复条目和受影响条目，先协调接口再推进，不重复修复。
后续改动若改变已完成条目的输入、接口或不变量，回开受影响的具体边界并记录重核结果，
未变化的证据继续复用，不等到推送前才处理证据失效。

服务部署、真实渠道消息、外部模型收费请求、用户 Thread/账户、安装替换及破坏性维护不因清单而获得授权。
优先隔离 Home、临时数据库、本机连接和自有子进程；目标 OS 或必要权限不可得时记录准确限制。
本阶段提交不自动合并、发布或部署；推送前按仓库规则另做完整分支关联复核。

## 条目与顺序

优先级表示失败后影响和补证价值，不表示已确认漏洞。编号稳定，不要求按编号执行。
执行顺序为 L01→L03→L02→L15→L04→L05→L18→L06→L16→L17→L07→L08→L09→L10→L11→L12→L13→L19→L14；
箭头表示推进顺序而非接口依赖。每项开始先核对关联项，尚未审查的依赖不得冒充通过；
若实际缺陷要求调整先后，在本页记录原因。
除下方逐项结果另有记录外，各项状态均为待审查，不能将计划或旧证据视作本轮通过结论。

| 编号 | 优先级 | 链路与关键不变量 | 待验证失败场景与成功证据 | 源码/合同入口及关联项 |
| --- | --- | --- | --- | --- |
| L01 | 高 | WebUI 请求→回环/Token/Origin→预览确认→管理服务→审计/响应；确认绑定主体、输入和修订，写前只消费一次 | 错误主体、输入替换、过期、并发重复、审计失败不能执行写入；合法隔离管理请求可完成并权威回读 | [管理接口安全](management-interface-security.md)、`scripts/webui-server.mjs`、`scripts/management-access.mjs`、`scripts/management-confirmations.mjs`、`scripts/webui-provider-settings-management.mjs`；L02/L03/L11 消费此边界 |
| L02 | 高 | CLI Setup/WebUI Provider 预览→检测归属→确认→事务→启动材料；凭据身份与 Origin 不漂移，旧预览不能写新资源 | 取消、重复确认、预览后修改、迟到检测回填、目录 pending/backup 恢复；隔离完整 Setup 保存后运行时可读；Windows 名称与 ACL 待原生系统 | [Provider 事务记录](provider-transaction-review.md)、[Provider 接入](provider-integration-guide.md)、`scripts/custom-primary-provider-setup.mjs`、`scripts/custom-primary-provider-management.mjs`、`runtime/model-provider-custom-runtime.mjs`；复用 P01/P02/V01/V02，关联 U06/U07 |
| L03 | 高 | Surface Actor→Workspace→命令/异步等待→最终能力调用；撤权后无新写入，未知 Workspace 不回退 | 账号错配、撤权/Workspace 替换发生于异步等待中、路径伪造；受授权的隔离入口可到达预期能力，无关会话不受影响 | [Policy](../src/policy/README.md)、[Surface](../src/surfaces/README.md)、`src/application/`、`src/bootstrap/config-lifecycle.ts`；L04–L08 共用授权链 |
| L04 | 高 | Server Request→归属/祖先查询→交互排队→用户决定→Client 响应；一次批准不升级，迟到决定失效 | 查询中解绑、同值重绑、排队到期、批量取消、平台发送迟到、跨端已解决；本地生产协调器/路由可准确派发并安全拒绝；真实渠道送达另记 | [Approval](../src/approval/README.md)、`src/approval/coordinator.ts`、`src/approval/interaction-router.ts`、[协议矩阵](index.md)；L03/L05/L07 |
| L05 | 高 | Thread ensure/resume/接管→绑定存储→订阅/活动状态→Turn；一 Thread 单归属，App Server 是权威状态 | 订阅成功但存储失败、断线重连、活动变化、后台容量并发预留、Provider 错路由；隔离新建/恢复后实际输入落到正确绑定 | [Routing](../src/session-routing/README.md)、[Storage](../src/storage/README.md)、`src/bootstrap/`、[协议矩阵](index.md)；L03/L04/L06 |
| L06 | 高 | Queue/Revert/模型选择→页面快照→权威列表/历史→确认写入→通知失效；无平行队列，不承诺跨端原子性 | 过期页、循环游标、原生端更改、冲突排序、部分失败、通知与确认竞态；隔离 App Server Queue 链路及只对任务自有 Thread 的回退 | [Queue/Revert](thread-queue-revert-development.md)、`src/application/thread-queue-service.ts`、`src/application/thread-revert-service.ts`；复用 U02/U18/U19，关联 L05 |
| L07 | 高 | 输出事件→投递箱提交→授权复核→平台 ACK→持久结果→重启恢复；生成完成不等于已送达，未知结果不盲目重发 | ACK 丢失、提交失败、sending 恢复、撤权、会话顺序、管理批量修订冲突；临时 Journal 重开与生产 Coordinator 到本机投递端的可用路径 | [Delivery](../src/delivery/README.md)、[投递运维](delivery.md)、`src/bootstrap/persistent-interaction-port.ts`；L03/L04/L10 |
| L08 | 高 | Schedule→领取事务→执行端口→Thread/Turn→结果恢复；同 occurrence 不重复，未知结果阻止后续自动执行 | DST/月份缺日、手动与自动竞争、取消落在领取/派发之间、Run 缺 Turn ID、崩溃后重领；隔离 Store/Scheduler 可完成一次任务，外部平台输出不强求 | [计划任务](scheduled-tasks-development.md)、[模块合同](../src/scheduled-tasks/README.md)、`src/application/scheduled-task-service.ts`；L03/L05/L07 |
| L09 | 高 | Relay 鉴权/队列→材料复核→模型出站→流解析→交付→指标；撤销后不新出站，生成与交付状态分离 | 等待撤销、迟到材料、客户端断开、背压、缺终态、畸形流、工具/图片转换；本机 HTTP/流式请求可完成并释放许可，不调用收费模型 | [Relay](../src/model-relay/README.md)、[模型 API](../src/model-api/README.md)、[Proxy](../src/provider-proxy/README.md)、[Relay 合同](provider-api-relay-development.md)；L02/L10/L12 |
| L10 | 中 | 请求/审查指标→IPC→有界 Writer→SQLite→查询/完成卡；写入范围与统计范围一致，缺失不冒充完整 | Worker 失败、缓冲溢出、父子 Turn 混淆、取消等待、单条写失败、重连重复；隔离真实写入和查询正确降级，卡片平台送达另记 | [Observability](../src/observability/README.md)、`src/observability/request-metrics-writer.ts`、`src/bootstrap/`；复用 U13，关联 L07/L09 |
| L11 | 中 | Gateway 配置读取→默认投影→预览修订→保存→热加载→各消费者；原文与有效默认值不混淆，失败不扩大授权 | 缺字段/未知字段、部分初始化、热加载失败、并行保存、浏览器过期响应；隔离 CLI/HTTP 保存及消费者读取，Doctor 保持只读 | [Config](../src/config/README.md)、`scripts/webui-management-settings.mjs`、`webui/src/hooks/use-versioned-settings-management.ts`、`src/bootstrap/config-lifecycle.ts`；复用 U05/U08/U09，关联 L01/L03 |
| L12 | 高 | 服务/Worker/Socket 启动→就绪→取消/故障→嵌套清理→真实退出；共享 App Server 不被 Gateway 清理 | 初始化中停止、清理一项失败、退出超时、假就绪、私有路径链接/替换；任务自有进程观察，Windows helper/Job 与 macOS/Linux 服务实机分开 | [Runtime](../runtime/README.md)、`runtime/app-server-supervisor.mjs`、`runtime/process-lifecycle.mjs`、`runtime/private-file.mjs`、[Windows](windows-support-development.md)；复用 U07/U11/U16/U17，IPC 两实现保留职责差异 |
| L13 | 中 | 三渠道事件/附件→Actor→解密/大小限制→聚合→Turn→文本/卡片投递；身份和字节语义不丢失，Reader 不等平台网络 | 超限/坏编码/解密失败、聚合中撤权、关闭排空、平台限流、慢消费者/事件总线容量；生产适配器隔离入口到消费端；真实平台单独列缺口 | [渠道矩阵](channel-acceptance-matrix.md)、[Surface](../src/surfaces/README.md)、[Event Bus](../src/event-bus/README.md)、[显示合同](display.md)；复用 U03/U10/U11/U12，关联 L03/L07 |
| L14 | 中 | 安装/更新候选→构建/版本门禁→只读数据预检→切换→激活/回退；代码替换不等于服务已激活 | 不兼容库、构建失败、取消、替换失败、ignore-scripts、打包遗漏；优先隔离候选与产物核对，不执行用户全局安装/卸载 | [源码安装](source-install.md)、`scripts/source-update.mjs`、`scripts/source-build.mjs`、[CI](../.github/workflows/README.md)；复用 U14/U15/Node 最低版本观察，关联 L12 |
| L15 | 高 | 受管账户预览→租约/停止→注册表/文件事务→固定基线恢复；聚合成员→目录/材料快照→刷新→逐次出站复核→成员指标 | 默认账户删除、租约占用、停止未知、部分删除/恢复冲突；材料变化、pending、迟到 Worker、模型移除；隔离账户写读不破坏其他账户/共享目录，聚合请求落到精确成员 | [多账户合同](opencode-go-multi-account.md)、[Provider 接入](provider-integration-guide.md)、`scripts/opencode-go-account-management.mjs`、`scripts/deepseek-account-management.mjs`、`scripts/cline-pass-account-management.mjs`、`runtime/aggregate-model-provider.mjs`、`runtime/aggregate-material-guard.mjs`；L01/L02/L05/L09/L10/L12 |
| L16 | 高 | Skill/Plugin 实时解析→绑定/Provider→Turn；MCP 状态/资源/OAuth/刷新；Hook 精确 hash/version 审查→确认→写入→跨实例刷新/回读 | 路径/Provider 错配、同名内容替换、旧确认、资源超限、OAuth 迟到、部分刷新失败；隔离生产入口取得受限结果并拒绝错配，不把保存当执行成功 | [协议矩阵](index.md)、[Application](../src/application/README.md)、`src/application/conversation-extension-query-service.ts`、`src/application/conversation-hook-service.ts`、`scripts/mcp-setup.mjs`；L01/L03/L04/L05；不执行真实 OAuth 或 Hook，不开放市场安装/任意 MCP Tool Call |
| L17 | 高 | CLI/WebUI/渠道重置券预览→私有账户 IPC→账户/券复核→单次消费→额度刷新；资产不重复消费，未知结果不重试 | 账户切换、并发忙碌、重复确认、取消、响应丢失及消费后刷新失败；隔离端口观察单次调用与明确未知/刷新失败分类，不使用真实重置券 | [用户指南](user-guide.md#openai-重置券-cli)、`src/application/openai-reset-credit-service.ts`、`src/application/conversation-reset-credit-service.ts`、`scripts/reset-credit-command.mjs`、`scripts/webui-reset-credit-route.mjs`；L01/L03/L10/L12 |
| L18 | 高 | Turn/Item/Goal→Client 投影→Core 归约→生命周期/呈现；Reserve 错误→账户→设置→权威确认/恢复；重复思考→精确中断→终态→清理 | 旧轮次迟到、断线恢复、partial answer、Revert 清理、手动设置抢占、写出但缺确认、错误轮次中断、长期缓存上限；生产归约器/用例输出与官方状态一致，不伪造停止或自动重发 | [Core](../src/conversation-core/README.md)、[Application](../src/application/README.md)、`src/application/luna-reserve-service.ts`、`src/application/reasoning-repeat-guard.ts`；L04/L05/L06/L10/L13 |
| L19 | 高 | cleanup sessions/metrics/traffic→各自预览/前置检查→确认→按各自合同修改→逐项核验；诊断读取/导出有界且不越权 | 状态未知、活动后代、Schema 不兼容、备份失败、锁竞争、部分归档、未知转储格式、payload 路径逃逸、导出取消/背压；仅临时库/文件及任务自有 Thread 验证，拒绝时原数据不变 | [用户指南](user-guide.md#本机清理与归档)、[Scripts](../scripts/README.md)、`scripts/session-cleanup.mjs`、`scripts/metrics-database.mjs`、`scripts/traffic-cleanup.mjs`、`scripts/traffic-dump-reader.mjs`；L01/L05/L10/L12/L14；真实用户维护不获授权 |

以下子范围是对应条目的完成条件，不能仅通过通用链路检查代替：

- L08：前台 `item/tool/call → schedule_task → 用户确认 → 创建/删除`，保持原 Request/Turn/call
  身份；覆盖终态/断线撤销、后台递归拒绝及尚未提交与已提交写入的取消差别。
- L13：分别核对图片上传的账户/后端/路由，音视频准备时的目标捕获、取消和 `mayHaveSubmitted`
  资源保留，以及 `channel send-image` 本地文件→私有 spool/manifest→绑定复核→投递/归档。
  只观察本地替代端或接口不表示平台传输成功，不发送真实渠道消息。
- L14：工程门禁子范围包括 `scripts/verify-commit.mjs`、`scripts/verification-scope.mjs`、协议/边界
  检查器及 Hook/CI 调用关系，核对范围选择、必要检查触发及失败传播；执行检查通过不等于检查器已审计。
- L15：分别登记 DS/OCG/CCG/CLP 的实际入口及其专有差异，共享实现的证据只复用到相同合同；
  账户事务与聚合材料是两个必查子链，不能由自定义 Provider 修复代替。
- L16：Skill/Plugin、MCP、Hook 三个子链分别登记结果；尤其 MCP 配置保存、OAuth 结果路由、
  资源读取和运行刷新不互相替代成功证据。
- L18：普通执行/归约、Reserve、重复思考保护三个子链分别登记；Goal 写入确认及取消不得被 Turn
  终态检查替代。长期缓存限制按实际保留状态核查，不强求运行到所有容量极限。
- L19：会话归档、指标维护、转储清理与诊断读取分别登记，导出关联 L10 的查询一致性；
  会话通过 App Server 官方归档与权威回读，不创建本地会话备份；指标维护按其具体操作核对
  停止状态、私有备份和 Writer 锁，所需备份必须在修改前成功且不得覆盖既有材料；转储清理
  核对相关实例停止并只删除已识别的精确文件范围，不套用指标备份事务。未知 Schema 不隐式迁移。

## 覆盖映射与边界

18 个一级模块均有负责条目：application L03/L06/L08/L16/L17/L18，approval L04，bootstrap L05/L10/L12，
codex-client/codex-protocol L04–L06/L16/L18，config L11，conversation-core L18，delivery L07，
event-bus L13，model-api/model-relay/provider-proxy L09，observability L10，policy L03，
scheduled-tasks L08，session-routing/storage L05，surfaces L13。CLI/WebUI L01/L02/L11/L17/L19，Runtime 与安装工程 L12/L14/L15。
映射只分配后续责任，不是逐文件/逐 RPC 覆盖。扩展、账户与聚合、自动干预和维护现分别由
L15–L19 负责，不再只作模块兜底；仍须按实际入口列出检查结果或剩余限制。
不扩展到未实施设计、旧快照、备份、技能目录或外部插件；本轮不升级锁定协议、不重做重复代码治理。

## 文档独立审查

Astra 已对基线 `1b198105` 上的初稿完成只读文档审查，确认四类清单阻断：账户与聚合事务、
扩展与账户消费、Core 归约与自动动作、数据维护与诊断读取缺少明确完成条件。
主代理核对所引模块合同与公开入口，已新增 L15–L19，并补齐 L08/L13/L14 子范围和跨项证据失效规则。
本结论不是代码缺陷发现。第二轮 Astra 定点复核确认四类范围缺口已解决，并指出 L19 不应
把指标的备份/Writer 锁套用到会话归档和转储删除。主代理已按其源码依据修正当前稿的两处
表述；该局部修订由主代理核对，不声称已获第三轮独立复审。文档阻断已处理，可开启 L01。
根索引位置已获认可；两轮均未执行全项目代码审计或运行验证。

## 逐项结果

### L01 管理请求、确认与审计

状态：已修复并完成下述隔离 HTTP、Runner 与浏览器观察；真实服务任务尚未观察。源码基线 `1fc5950a`，修复提交 `cf3cbe97`。
主代理检查 HTTP 回环/Origin/Token、正文限额、限速、一次性确认、Provider/账户路由、
审计 Writer 与错误出口；Sol 子代理只读检查 Codex/Gateway/Relay/Delivery/Task/官方模型/
重置券七类路由到执行端口及任务结果消费。主代理核对其发现与最终改动；不代表重复全量独立代码审查。

| 发现 | 触发与影响 | 修复及关联消费 |
| --- | --- | --- |
| L01-F1 高风险确认遗漏 | `kind: all` 的生产设置逻辑包含 sandbox、审批策略、网络权限写入，HTTP 未要求令牌 | 将 all 纳入预览签发与执行消费共用集合；前端通用设置 Hook 已传回令牌，无需新确认机制；CLI 显式向导不受影响 |
| L01-F2 内部错误外泄 | 任务审计/启动异常原 message 被当作公共 400；异步启动异常也仅做文本清洗 | 审计前置统一返回 `management_audit_unavailable`；仅显式任务输入/占用错误允许公开文案，未知错误走固定结果未确认文案；异步启动错误固定提示 |
| L01-F3 审计降级丢失 | 启动降级只在 202，终态失败只进日志；任务回读及 UI 看不到 | Runner 统一记录启动/终态，任务保留降级后再通知；公开类型、回读和任务 Hook 中英文反馈同步，不覆盖执行结果或自动重跑 |
| L01-F4 未知字段静默丢弃 | 账户操作及 Provider switch/remove 投影掉未知字段后仍签发确认；任务写入先投影也可隐藏未知字段 | 对相关输入明确拒绝；任务先校验原正文，安装任务拒绝无合同的 target；现有前端规范输入保持适用 |

**实际观察。** Linux，所有材料在任务临时 Home，不使用真实账户/服务：

- 修复前实际 `createWebuiServer` HTTP 的账户请求带未知字段：预览/执行均 `200`，注入写入端口
  调用一次；修复后账户及 Provider 未知字段均 `400`，账户写入次数 `0`。错误 Bearer 为 `401`，
  非回环 Origin 为 `403`。外网 socket 拒绝为源码证据，没有创建公网访问。
- 修复前真实 HTTP 调用生产 `updateCodexUserSetting`（配置 Client 用隔离端口）不带令牌的 all
  返回 `200`，端口收到三项权限写入；修复后无令牌 `409`、预览 `confirmationRequired=true`、
  确认 `200`、重放 `409`，写入次数合计 `1`。这不表示真实 App Server 已写权限。
- 经生产 `initializeUserData` 创建隔离配置后，HTTP 修改 `display.plan-updates`：`200`、
  `consistency=confirmed`、重新 GET 值匹配、`auditStatus=recorded`。把临时审计文件替换为目录，
  后续写入返回 `500/management_audit_unavailable`，配置原文不变。
- 生产确认 Store 的到期边界、错误主体及错误主体尝试后的再次消费均拒绝。
- 生产 Task 路由注入审计失败：`starts=0`、`500/management_audit_unavailable`；未知启动异常：
  `500/task_start_failed`；两者公共 message 均不含注入的内部标记。
- 生产 Runner 排队后立即取消，未启动子进程：分别令 started/cancelled 审计回调失败，
  最终均 `state=cancelled`、`auditStatus=degraded`，详情与最后变化通知一致；启动审计失败后
  终态审计成功也不消除降级。临时材料与监听端口均已清理。

- Chromium 实际打开隔离 WebUI 的 `/#/settings`，将计划任务从关闭改为启用，经确认弹窗提交后，
  页面显示已启用及保存成功、生效方式提示，临时 `config.toml` 的 `scheduled_tasks.enabled=true`。
  隔离环境未运行 Gateway，未启动计划任务；App Server/指标依赖不可用不作为这些能力验收成功。
- 浏览器仅拦截任务列表响应，提供 `state=cancelled/auditStatus=degraded` 的受控条目；
  服务页面实际显示审计记录不完整、结果不变、不要重复执行的提示，切换英文后同义提示可见。
  此项证据仅覆盖响应到界面消费，与上面的生产 Runner 观察分开，不代表真实服务审计故障已复现。

**边界。** Relay/Delivery/官方模型/重置券的业务内部、服务执行与跨平台退出留给对应条目；
本项仅核对其管理接入。浏览器补验未发现新增问题；
不把取消排队任务等同服务执行成功。修改不涉及持久 Schema 或用户数据迁移。
本项提交主题为 `fix(webui): 补齐管理确认与任务审计边界`，静态检查由提交钩子执行。
下一项按顺序为 L03；其余 L02–L19 尚未在本轮完成。

### L03 Actor、Workspace 与异步授权

状态：已审查（附下述证据限制），确认问题已修复并完成隔离生产路径观察；真实平台与跨操作系统观察缺口保留。
起始基线 `15e3322b`。主代理检查 Registry、Router、Application、Client 与热加载分类；
Sol 子代理只读检查三个 Surface 到 Application 的输入授权，并负责限定四个 Surface 文件的授权传递修复。

| 发现 | 触发与影响 | 修复或剩余工作 |
| --- | --- | --- |
| L03-F1 失效工作区静默回退 | 保存的 Workspace ID 已移除，普通解析及订阅恢复清理会自动改选默认目录，后续请求改变执行范围 | 改为 `workspace.missing` 且不改原选择；恢复清理也保留选择；列表只读显示保存的 ID，显式选择有效项后恢复 |
| L03-F2 普通输入授权丢失 | 聚合回调丢弃 Actor；下载、锁等待或 Provider/图片准备期间撤权，旧请求仍可提交 | 批次保留 Actor，三个渠道五处普通提交传实时授权；Application 固定 Workspace 并在锁内复核，Thread 新建/恢复及 Turn start/steer 保留最终守卫；迟到新订阅清理，不写回失效绑定 |
| L03-F3 命令授权未贯穿 | 部分 Telegram 按钮未传 Actor，通用命令即使传 Actor 也未统一约束后续等待、RPC 和本地偏好写入 | 入口与按钮强制传 Actor，组合根注入实时策略；下述全部命令子链贯穿后续提交守卫，已提交结果独立结算 |
| L03-F4 异步回答丢失授权上下文 | 问题保留 Thread/取消状态，等待后失去原 Actor/Workspace 约束 | 提问前捕获原用户与工作区，三渠道限定回答者，交互与最终 Turn 共享守卫 |
| L03-F5 查询结果错误归属 | 会话目录返回后改读当前工作区，可能把 A 目录 Thread 缓存为 B 工作区 | 固定初始工作区，后续查询与缓存写前复核；已合法提交的缓存不回滚 |
| L03-F6 原模型目标消失后写偏好 | 官方归档/删除在模型配置等待期间解除绑定，旧模型 Fast 选择可流入下一默认模型 | 模型服务固定原 Thread，唯有自身跨 Provider 解绑成功才更新预期目标 |

**已观察的隔离路径。** 使用生产 Router、内存 BindingStore、Application 和指定注入端口，无真实用户数据：

- 修复前保存 `removed`，调用 `workspace` 得到默认 `safe`，保存值也变为 `safe`。
  修复后返回 `workspace.missing`，保存值仍为 `removed`；生产命令 `/workspace` 返回有效列表及
  原选择 ID，生产 `selectWorkspace('safe')` 成功；任意绝对目录选择被 `workspace.selector.not-found` 拒绝，原选择不变。
- 生产 ConversationService 使用受控 Turn 端口，在一个请求进入提交等待、另一个请求排队后撤权：
  两者均以 `input.authorization-changed` 拒绝，写入次数 `0`；重新授权的同一入口取得 `threadId=t/turnId=turn/steered=true`，写入一次。
  这是 Application 等待边界观察，不代表真实上游网络已验收。
- 生产微信 Adapter→ConversationService→Codex Client→隔离 RPC 端口：合法文字产生一次 `turn/steer`，
  撤权后的文字不增加 RPC；Client 的 start/steer/resume 最终守卫拒绝时均不调用 RPC。
  撤权提示实际为“输入授权或工作区已变化，本次输入未继续提交”，不再误报没有会话。
  不发送平台消息、不调用真实模型。
- 生产 Router 的新建请求已发出后才撤权：受控响应返回时执行一次新订阅取消，返回撤权错误，
  BindingStore 无新绑定。没有重发创建或删除官方 Thread。

**命令身份与 Queue 子链。** Astra 对代表性 Queue、模型选择和恢复/接管给出只读设计评估；
确认应显式传递授权闭包，并把后续新副作用与已提交结果结算、生命周期补偿分开。
Sol 实现 Queue Service/Port/Client/RPC 四文件，主代理实现命令入口、组合根和 Surface Actor 传递，
核对合并 diff 并运行统一类型/边界检查及构建，均通过。

- 主代理经生产 CommandService→ConversationService→QueueService，使用隔离 Queue 端口执行
  `queue add` 再 `queue list`，结果含同一 `q1`、正文和数字选择器；撤权后 add 被拒绝，条目数仍为 `1`，
  空 Actor 同样被 `command.authorization-changed` 拒绝。
- Sol 直接运行当前源码 Service→Client→JSON-RPC，使用内存 Transport：列表响应期间撤权或切换 Thread，
  分别阻止 update/delete 的后续 RPC；首次列表收到 `-32001` 后撤权，没有第二次发送。
- 六种 Queue 请求在会话锁等待期间切换 Thread，全部拒绝，端口调用数 `0`。
- 更新 RPC 已发送后撤权，生产 Queue Service 仍返回实际更新条目，保留快照失效处理，不重发或回滚；
  命令结果出口会再次检查 Actor，拒绝展示时明确提示已提交操作不会自动撤销，应重新查询。

以上是隔离生产入口观察，没有真实平台投递、真实 Provider 启动或 App Server Queue 服务的观察。
命令入口和结果出口的检查不代表其他命令内部安全；其他写命令、只读结果与异步交互的补充证据见后文。

**模型与会话生命周期子链（基线 `ee685e50`）。** 两个 Sol 分别实现模型窄端口/选择服务和 Router/Thread
窄端口；主代理整合 CommandService、ConversationService、Provider Client 与 Telegram 模型按钮预查询。
模型目录、配置读取和写入守卫透传至每次 RPC 尝试；生命周期固定原绑定和工作区，失效后阻止新副作用，
已有操作结算和恢复订阅补偿独立于用户授权。

- 主代理运行生产 CommandService→ConversationService→ModelSelectionService，使用隔离模型端口：
  选择 `openai/second` 返回可显示的模型结果和待生效 Standard，默认写入为 `[default]`；
  下一次目录读取期间撤权，返回 `command.authorization-changed`，写入仍为 `[default]`，选择保持 `second`。
- Sol 运行生产模型服务，分别在目录、默认速度、加速配置、独立 Provider 目录和目标 Provider 思考读取期间撤权，
  后续写入/解绑为 `0`。默认速度写入完成后撤权，保留一次 `default`，不解绑、不更新覆盖，也不自动回滚。
  合法模型→思考→速度操作返回对应设置；未绑定偏好保存和生命周期偏好恢复仍可完成。
- Sol 运行生产 Router 与内存 BindingStore/Registry：合法恢复依次读取新 Thread、订阅新 Thread、取消旧订阅并绑定新 Thread。
  恢复、接管、派生或条件解绑在取消旧订阅后撤权，保留旧绑定、恢复旧订阅，并按需取消新订阅。
  锁等待中原绑定消失或无绑定等待中出现新绑定时拒绝，保留新状态；失效旧 Workspace 仍允许显式选择有效项。
- 主代理运行生产 Client 与隔离 RPC 端口：模型和 Thread 分页的首个响应撤权后各只发一次请求；
  加速配置读取后撤权不发后续 requirements 请求；默认配置已提交后撤权仍正常结算。
  这些观察核对 Client 的守卫传递，不代表真实 App Server 或平台网络观察。

当前子链没有真实 Provider、平台账号或跨操作系统执行；其他 Turn/Goal/扩展命令与异步交互的证据独立记录如下。

**自动审批设置子链（基线 `f0480a25`）。** 命令与按钮传入同一 Workspace/Actor 守卫，Application
固定锁前 Thread，并将空闲、交互与 Thread 身份检查经 Bootstrap/Provider 路由传至 Client 最终发送前。
提交前失败保留结构化原因，已发设置仍执行原有权威确认，不回滚或重试。
主代理运行生产 CommandService→ConversationService→Client，Provider 等待和 RPC/通知采用隔离端口：
合法选择返回 `reviewer=auto_review/updated=true`、一次 `thread/settings/update`；等待期间撤权返回
`command.authorization-changed`，切换 Thread 返回 `autoreview.stale-selection`，两者 RPC 均为 `0`、原设置为 `user`。
发送后撤权时，实际设置保留 `auto_review`、RPC 仅一次，命令出口拒绝展示；每轮结束后临时设置监听均移除，
仅保留 Client 原有监听。没有真实平台交互、Provider 启动或上游审批行为观察。

**Revert 授权子链（基线 `e9a02b7b`）。** Sol 实现 Revert Service/History Port，主代理核对其 diff 并贯穿
命令、Application、Router、Provider Client 和 RPC。确认令牌原先只核对 Actor 身份，历史/Queue 读取期间
撤权仍可提交回退；现固定锁前绑定，每次读取、分页及最终写入前复核实时授权。明确授权错误不再误报结果未知。
主代理经生产 CommandService→ConversationService→RevertService 使用隔离历史/Queue 端口，完整执行
`list → 1 → confirm` 返回 `thread.reverted/t/turn`，回退一次；下一次确认的历史读取后撤权返回
`command.authorization-changed`，总回退次数保持 `1`。生产 Client 的 read/turns-list/revert 守卫拒绝时，
隔离 RPC 端口记录均为零次发送。
Sol 的补充生产入口观察覆盖锁等待期间切换 Thread、第一页返回撤权、Queue 返回撤权和最终端口准备后撤权，
均未发回退；已发送后撤权仍返回实际结果，并使旧选择快照失效。没有真实用户历史回退或真实上游网络观察。

**补充命令范围。** 独立 Sol 只读追踪后补入 Hooks/Schedule/重置券、异步交互的独立授权合同和
普通只读查询内部分页/Provider 等待；各自修复与观察记录如下，没有由前述子链推定通过。

**停止与结果范围子链（基线 `4dbeba79`）。** `/stop` 不进入会话锁，仍立即取消本地附件/输入准备；
原 Thread 的中断通过 Provider 准备前后守卫，只有实时授权有效且原 Thread 仍归属同一 Conversation 才发送。
所有命令结果重新核对原 Workspace ID/cwd，显式 Workspace 切换除外；模型和审批按钮使用相同出口守卫。
主代理运行生产 CommandService→ConversationService→Client、隔离 Provider 等待与 RPC：合法停止返回
`turn.stop-requested/stopped=true`，本地取消和 RPC 各一次；等待时撤权或改变原 Thread 归属，返回
`command.authorization-changed`，本地取消仍一次、RPC 为零。同一归属仍允许发送；后台状态不额外限制是代码合同，
本次未驱动真实前台转后台生命周期。另经命令 sessions 入口在列表读取时更改工作区目录，结果出口明确拒绝。
本次没有真实平台停止、上游 Turn 终态或操作系统差异观察。

**普通 Thread/Goal 命令子链（基线 `2ef96283`）。** 主代理贯穿命令与 Application 守卫，固定锁前 Thread，
Thread 准备和最终请求前复核；Sol 负责 Turn Port、Client、Provider 与输出准入的透传。
原本 `getGoal` 等看似查询的入口也可能创建 Thread，因此 Thread 准备同样受守卫约束。
主代理运行生产 CommandService→ConversationService、隔离 Thread 准备与 Turn 端口：rename、pin、compact、
review、Goal set/get/clear 均返回对应命令结果，各调用一次；Review 和 Goal 的已知结果进入 Core 归约。
Thread 准备期间撤权时不建立隔离绑定；最终发送等待期间撤权或换成其他 Thread 时，新业务调用均为零。
Sol 内联运行生产输出准入→ProviderRoutingClient→Client→JSON-RPC，使用内存 Transport：正常七方法返回
对应结果，调用前撤权时七项 RPC 均为零。pin 初始读取后撤权只读取一次；metadata/update 后撤权保留已写
元数据、不发送 move；move 后撤权继续唯一权威读回并返回固定成功；move 返回上游错误时也不自动回滚元数据。
pin/Goal 读取的首个过载响应后撤权均阻止重试；输出准入等待撤权不发送 compact，Provider 准备等待撤权不发送 rename。
已提交 rename 正常结算；三个原固定参数包装均保留最终守卫。捕获请求中没有本地 `beforeSubmit` 协议字段。
这些证据来自隔离生产调用链，未连接真实 App Server、平台账号或执行跨操作系统路径。

**Plan 子链（基线 `b95deca9`）。** 模式预设查询、模型读取和本地偏好保存贯穿守卫，并固定模式选择时的 Thread；
带参数 Plan 的 Queue 复核和 Turn 发送继续传递守卫。共享新 Turn 入口固定准备前绑定，成功准备后核对实际新绑定。
主代理运行生产 CommandService→ConversationService→CollaborationModeSelectionService、隔离模型/预设和 Turn 端口：
正常切换返回 `mode=plan/pending=true`，无 Turn；正常带参数调用返回 `plan.started/plan-turn`、发送一次、待生效状态清空。
模型读取期间撤权返回 `command.authorization-changed`，无偏好、无 Turn；发送等待期间撤权或 Thread 被替换，
同样拒绝且发送为零，但此前授权有效时已保存的模式仍为待生效，不声称回滚。没有真实模型调用或平台交互观察。

**扩展命令子链（基线 `4ea0b796`）。** 主代理贯穿 Command/Application 的 Skill、Plugin、Agent 与 MCP 守卫，
固定扩展调用的锁前目标；Sol 负责扩展查询服务、窄端口、Client 与 Provider 路由。Telegram 直接模型/Plugin
按钮预查询另捕获实时 Actor 与工作区 ID/cwd，返回前复核，不依赖仅在命令出口才执行的校验。
主代理经生产 CommandService→ConversationService→ExtensionQueryService、隔离目录与 Turn 端口观察：
Skill、Plugin、Agent 正常各追加一次 Turn，并返回对应名称及 `steered=true`；Skill/Plugin 的目录解析期间撤权，
三类命令的提交等待期间撤权或换 Thread，均返回 `command.authorization-changed`，未发 Turn。
MCP 登录和资源读取正常各调用一次下游端口；目录响应期间撤权或换 Thread，均在 OAuth/资源调用前拒绝，后续调用为零。
没有访问真实插件目录、OAuth 账号或 MCP 资源，也没有发送真实平台消息。
Sol 运行生产 Extension→Provider→Client→JSON-RPC、内存 Transport：合法列表/解析、MCP 详情、OAuth 与资源读取
返回可用结果；Plugin 列表返回前撤权被拒绝，已提交 OAuth 仍结算。Skill/Plugin/MCP 概览/资源读取首个过载
响应后撤权，各只发送一次；MCP 概览和详情分页撤权后不取下一页。Provider 准备期间撤权时未发 skills/list，
但已有内部 initialize/config 写入，不能声称整个生命周期零调用。双 Provider 正常刷新计数 `[1,1]`；
下一轮首分支提交后撤权，累计 `[2,1]`，首分支正常结算、后分支拒绝，未回滚或重发。
主代理直接运行 Telegram 按钮查询守卫：原目录接受，同 ID 目录替换或 Actor 撤权均拒绝；这不是实际平台按钮交互观察。

**重置券授权子链（基线 `8962788f`）。** 渠道预览原有 Actor/Conversation/Workspace/Thread 绑定继续复用，
实时上下文复核贯穿共用服务、Provider 准备、账户路由和券明细读取，到消费最终发送前。
本地守卫明确拒绝时保留原失败分类；请求已发送后的未知结果仍为 `reset_unknown`，不自动重试。
主代理内联运行生产 ConversationResetCreditService→共用服务→ProviderRoutingClient→Client，隔离 RPC 端口：
正常列表、预览、确认返回 `consumed/reset/refreshed=true`，消费一次、刷新一次；账户响应期间撤权仅发账户读取，
不继续读券。最终消费等待期间撤权或换 Thread 时消费为零，后者返回 `reset_stale`；已发送消费后撤权仍返回
实际成功并刷新一次。模拟消费响应丢失只发送一次、返回 `reset_unknown`、未刷新。
这些观察未连接真实 App Server 或消费真实资产，RPC 发送等待由隔离端口模拟；CLI/WebUI 的账户 IPC
继续省略渠道守卫，取消信号和已有管理授权合同保持不变，其完整业务验收留给 L17。

**计划任务授权子链（基线 `8f3070dc`）。** Sol 将渠道命令的 Actor/Workspace 守卫接入既有 operation，
贯穿任务/Run 读取、创建和删除确认、Scheduler 领取与派发；创建上下文提前到容量等待前捕获，删除确认在
异步读取后再次核对有效期。主代理核对命令、Service 与 Scheduler 的现有领取/收敛合同；未把任务管理
错误限制到当前前台 Thread，也未修改已经提交的写入结算。
Sol 使用生产 Command→Service→Scheduler 和内存 SQLite，隔离权限/执行端口：创建确认、list、rename、
pause/resume、run/runs、删除确认均返回对应结果，名称回读 `usable-name`，Run 回读 `completed`，删除后可见任务为零。
容量等待改变模型，返回 `scheduled-task.state.invalid`、新增权限读取为零；Task 读取撤权后 rename 写入及
runs 查询均为零。创建确认权限读取撤权未创建任务；运行容量等待撤权未创建 Run；重试期间改变 cwd 未创建 Run、
原 `uncertain` 保留。已领取后撤权回读 `interrupted`、执行端口调用为零；执行端口返回完成后撤权虽不展示命令
结果，数据库仍结算 `completed`。删除确认等待期间改变 cwd 或超时 300001ms 均不删除；末端失权未展示的预览
已取消，重复确认返回 `scheduled-task.confirmation.invalid`。自然语言创建返回预览后已取消隔离令牌。
没有实际 App Server Thread/Turn 或平台消息观察，执行完成来自隔离端口；真实 Executor 后续提交仅作源码
关联检查。权限读取内部的 Provider/RPC 等待继续随共用只读查询边界审查，完整调度业务仍归 L08。

**Hooks 授权子链（基线 `89bec395`）。** Sol 修复锁后才捕获上下文的问题，锁前固定 Actor、Workspace/目录、
Provider 与 Thread；列表、版本读取、定义复核、最终写入贯穿实时守卫，写前重查确认期限与无损审查能力。
主代理核对全部差异、窄端口、共享配置读取和 Provider 修订失效；本地拒绝保留授权分类，已提交写入的
跨 Provider 刷新和权威回读独立结算，最终结果展示仍检查授权。
Sol 内联运行生产 HookService→ProviderRouting→Client→JsonRpc、隔离内存 Transport：列表/详情/预览/确认
返回 `listCount=1/updated=trust/trustStatus=trusted`，双 Provider 刷新与回读完成。锁等待换 Thread 零 RPC；
列表过载后撤权只发一次读取；配置版本响应后撤权不再读取 Hook 或写入。最终 Provider 等待撤权与失去
Surface 审查能力分别返回 `hooks.forbidden` 和 `hooks.local-review-required`，均无写、`revision=0`。
输入编码时撤权也被最后 RPC 守卫拒绝，无 RPC、`revision=0`。写入发出后撤权，权威状态仍变为 trusted、
`revision=1`，双 Provider 刷新和回读完成，结果出口返回 forbidden。没有真实用户配置、Hook 执行或平台消息观察；
Hook hash/version 与实际执行的完整业务验收留给 L16。

**异步回答授权子链（基线 `06eec831`）。** 问题在首次等待前捕获唯一授权 Actor、Workspace ID/目录；
每批交互携带本地 `expectedActorId` 和组合 `isCurrent`，经 InteractionRouter/PersistentInteractionPort 及
Application 锁内、最终 start/steer 复核。飞书/微信仅允许原用户接收该交互，Telegram 文字和按钮回答核对
原用户；字段不进 App Server 协议或持久化。具体授权闭包在组合根绑定当前名单、Actor Registry、工作区与停止状态。
主代理运行生产 AsyncQuestionCoordinator→InteractionRouter→ConversationService，隔离交互与 Turn 端口：
正常回答原用户 `actor-original` 的问题追加一次；交互答复时撤权、锁等待撤权、最终提交等待撤权或换 Thread
均未发 Turn，锁后拒绝保留一次未确认提示。已发送后撤权仍完成一次发送、不新增警告；六场景 pending 均清空。
飞书/微信生产端口接收与原用户不符的 Registry 时返回空决定、无投递；Telegram 隔离 pending 的文字/按钮
错用户答复未解决问题，按钮返回“该请求已失效”，关闭返回空决定。首次手工观察的清理端口错误地把关闭的空决定
当作接受而抛错，修正隔离端口后关闭完成；不是产品失败。未观察真实平台交互、完整 Gateway 启动或真实 App Server。

**纯查询授权子链（基线 `eade4374`）。** Sol 独立只读审查确认会话列表在等待后重新读取当前工作区，
可能把 A 目录 Thread 写成 B 工作区的展示缓存；权限分页和账户后续 HTTP/RPC 也缺少实时守卫。
主代理固定列表查询初始工作区，贯穿目录、搜索、轮数查询及缓存写入，并接通命令/权限与计划任务权限读取上游。
主代理经生产 Command→SessionQuery、隔离 Router/指标/缓存观察：正常返回两条会话，缓存工作区均为 A；
首轮列表返回时改工作区或撤权，只查询一次、无后续查询/缓存写入。首个轮数指标返回时撤权只读取一个指标；
显式历史扫描首个分页后撤权只发一页。后两场景保留撤权前合法写入的 A 工作区缓存，不声称自动回滚。
生产 Command→Extension→Provider→Client 的隔离 RPC 端口观察：权限列表正常两页返回两个 Profile；
第一页后撤权只发一页。生产计划任务 Service→Provider→Client：正常预览读取一次配置；最终请求前撤权或
改目录均无配置 RPC，分别返回 `command.authorization-changed` 和 `scheduled-task.state.invalid`。
另一 Sol 负责账户服务/适配器及 Client/Provider 守卫，主代理核对全部差异和上游接线。带守卫的第三方查询
不与后台共享请求；后台仍用既有生命周期，已派发快照独立结算。Provider 列表部分故障继续降级，但首次授权
拒绝锁存并原样抛出，不能被 allSettled 或 Thread 用量失败降级吞掉。
Sol 运行 metrics→ProviderAccountService→OpenAI adapter→Client→JsonRpc、内存 Transport，正常得到
`token-usage/123 tokens/thread unavailable`，两个 usage RPC。usage/Thread usage/limits/权限列表/无人值守
预检在过载后撤权均只发一次业务 RPC；权限正常两页，分页撤权只发一页。三类查询在 Provider 活动排队时
撤权均 `ensures=0`；账户额度返回后撤权未查周估算，换 Thread 返回 `command.authorization-changed`。
生产 AccountQuery 模拟 CCG whoami→credits，首个响应后撤权只发一次 HTTP；显式与后台并发独立两调用，
前者拒绝、后者完成。快照写入已派发后撤权仍写一次并结算；瞬时 Thread usage/Thread 列表守卫拒绝均保留原异常。
真正 Provider 列表一成功一失败仍返回成功部分。正常 Client 额度和无人值守权限分别得到 codex 和 workspace-write。
这部分没有真实 App Server、账户或数据库文件观察；CCG 使用生产 AccountQuery，未加载真实适配器凭据；
OpenCode Go 后续本地 Token 分支仅核查源码接线。`/metrics` 单次固定范围数据库查询、`/status` 单次固定目录
git 查询，以及 `/diff`、审批/工作区本地投影复用已有入口/出口守卫，没有证据需要把 Actor 注入数据库层。

**恢复分支的工作区补充（基线 `88470dc3`）。** 主代理复查 L03-F1 时发现订阅恢复清理不可用绑定后仍会
把缺失工作区替换成默认目录，且后台绑定失败可能覆盖会话已选工作区。移除该重选分支，复用 BindingStore
删除 Thread 时保留工作区的既有合同；不改变绑定清理或持久格式。
主代理运行生产 SessionRouter→MemoryBindingStore/WorkspaceRegistry、隔离生命周期端口：缺失工作区恢复
返回 `workspace.missing/bindingRemoved=true`、零 RPC，保存的选择仍为 missing，后续 workspace 查询继续拒绝；
显式选择 A 后恢复到 `/A`。有效 A 目录的 Thread 不存在和其他目录后台 Thread 不存在，均读取一次后清理绑定，
会话选择仍为 A。SQLite 同一删除接口保留选择经源码核对，本次没有实际持久数据库重开或真实重连观察。

**模型原目标补充（基线 `04ed5150`）。** 独立 Sol 只读核实 Conversation 锁不能阻止官方通知直接解除绑定，
给出 `/fast` 从支持 Fast 的旧模型流入不支持 Fast 的默认模型的完整因果链；没有证据表明锁内能插入另一已绑定
前台，也没有把 `/resume` 两阶段锁本身认定为错误目标。后者始终固定显式选择 ID，第二阶段复核当前绑定/归属。
另一 Sol 在模型服务组合原 Thread 与授权守卫；主代理核对 state/browse、模型/effort/速度及 Router 自身解绑
合同。跨 Provider 仅在自身 newSession 成功后接受未绑定，已发送默认配置保存不回滚。
Sol 运行生产 ModelSelectionService→SessionRouter→MemoryBindingStore/WorkspaceRegistry、隔离模型端口：
正常 Fast 返回 fast、一次默认保存；effort 返回 high；同 Provider 模型选择和跨 Provider 切换均返回可用状态，
后者解绑后保存 third/vendor/medium/fast，`providerPending=true`。目录、加速配置、默认 effort/tier、解绑等待中
调用实际 Router.forgetThread，均 `command.authorization-changed`、无新偏好。默认保存前失目标零写入，
已保存后失目标保留一次 fast/default 写入、无后续偏好。共 17 个隔离场景；最末核对原 Fast 模型消失后，
下一默认 plain 模型 `serviceTiers=[]/serviceTier=null/pending=false`，Turn overrides 和 Thread options 均为空。
没有真实平台或 App Server 模型执行观察，结论限于生产模型选择/路由和隔离能力端口。

**已核对和未观察。** 三渠道 Policy 复核 Surface 与账号；飞书错误 App ID、微信错误接收账号有拒绝入口。
Workspace 删除/改目录及 Telegram/微信名单缩减要求重启，不能声称它们可任意热替换；飞书名单支持热撤权。
当前记录没有真实平台撤权或 Windows/macOS 观察，也没有替代 L04–L08、L16–L18 的独立业务验收。
L03 已识别的输入、命令、查询、异步回答及恢复分支均有上文源码关联、修复与对应隔离证据；
已提交子链正常门禁通过，未运行或新增测试。保留真实服务观察限制，下一项按顺序进入 L02。

### L02 Provider Setup、预览与启动材料

**审查基线：`aa4bb8e7`；状态：已审查（附证据限制）。** CLI Setup→共享保存计划→事务锁→配置/Profile/目录写入→
回读→运行时消费已补充隔离观察；Sol 子代理完成 WebUI 检测归属与确认链独立只读审查，主代理复核关键消费点。
未确认新的代码缺陷，本项提交补充证据。受管账户租约、删除及聚合另由 L15 覆盖。

**复用证据。** 比较 `ceb54a22` 至本基线，Setup、共享自定义 Provider 管理、主配置转换事务、
自定义运行时、模型目录和凭据文档模块没有差异，沿用 [Provider 事务记录](provider-transaction-review.md)
P01/P02/V01/V02 的适用结论和限制，不重复宣称完成真实断电、Windows ACL 或 macOS 服务观察。

**Setup 完整保存。** Linux 临时私有 Home 中调用生产 `runCustomPrimaryProviderSetup`，注入提示答案与
只读配置 Client；保存和运行时读取使用实际生产实现。Codex 兼容类型新增切换 Provider 后，读取返回
`review-provider/review-model/https://example.invalid/v1`，凭据匹配，Profile 为 `0600`，主配置原文未变，
Client `connect=4/close=4`，输出不含 Key。自定义类型从生产模板选择、模型声明、最终确认走到目录保存，
当前已安装 CLI 实际执行隔离 `debug models` 校验；运行时读回 `cp-review/review-model`，目录包含该模型，
`pending=false/backup=false/close=4`，输出不含 Key。没有发送远程模型请求或启动服务，临时目录均已清理。

**Hack 与取消。** 最终取消后 `profiles=0/connect=1/close=1`，主配置未变；最终确认时将 Client 修订从
v1 改为 v2，返回 `stale-preview/profiles=0/connect=2/close=2`。同 Origin 改 URL 路径并留空 Key 可保存且
保留原 Key；更换 Origin 留空返回 `API Key 不能为空`，原 URL/Key 不变；更换 Origin 显式输入新 Key 后
运行时读取新 URL/Key。输入期间通过生产文件写入器修改主配置，Setup 拒绝文件快照变化，保留外部修改和
原 Profile。这些都是隔离输入/Client 下的生产交互函数观察，未验证真实 TTY 的按键、信号或真实 App Server RPC。

**检测归属。** 生产 CLI 能力交互在检测结果匹配模型/协议/思考等级/能力后，用户选择采用才生成连接证明；
隔离匹配结果得到 `applyPatch=freeform/receipts=1`，错模型结果在首次检测后拒绝，未进入采用提示。
生产 WS 交互收到取消结果时返回空结果，`calls=1/questions=1`，没有进入后续采用步骤。
此处检测响应由隔离端口提供，不代表第三方实际上支持对应能力。

**WebUI 关联审查。** `use-scoped-probe-request.ts` 以草稿标识、enabled、活动 Controller 和取消信号
约束结果回填，取消先清除所有权，旧请求 finally 不会清理新请求。Provider 编辑器将配置版本、连接、Key、
模型定义等纳入草稿标识；能力采用检查模型行和结果身份。后端连接 HMAC 在保存时重新计算，子代理内联调用
生产函数观察到 URL 路径、Origin、Key、模型、思考等级、能力或协议任何一项变化均改变证明。
Provider 路由预览前后检查资源修订，确认绑定主体/输入/修订/预览；整段确认路由持有共享管理锁，
底层保存仍重建计划。生产确认 Store 的首次消费成功，重复消费、修改输入、错误输入消费后重试均为
`management.confirmation-invalid`。固定凭据读取及启动材料再次核对 Provider、Origin 和版本引用；
未知保存结果进入回读门禁，不能把下一次读取成功改写为上次保存成功。

**限制与下一项。** 未观察真实浏览器的迟到响应、取消后立即重发、跨标签修改及 WebUI 完整保存；
相关前端结论来自源码链路，不是浏览器实测。真实 TTY、App Server RPC、付费模型探测、网络断连、
Windows 原生环境/ACL 与 macOS 服务均保留未验证状态；P01/V01 的进程终止证据不证明断电持久性。
没有运行或新增测试。记录已随 `bae02ab6` 提交，正常文档与索引门禁通过；按顺序进入 L15。

### L15 受管账户与聚合材料

**审查基线：`bae02ab6`；状态：已审查（附证据限制）。** 主代理核对账户管理/删除，Sol 子代理独立审查聚合材料与实际出站；
另一 Sol 完成 OpenCode Go 配置新增/重配的同因修复及观察，主代理复核并补齐基线写前检查。

**L15-F1 删除快照晚于计划。** OpenCode Go 从原注册表生成剩余账户，再等待监管器；原实现直到等待后才
捕获快照，因而把外部变更当成本次基线，却仍写入旧计划。隔离生产删除入口中，在首次监管器检查时通过
生产注册表写入器新增 c，删除 b 返回 `removed`，最终仅剩 a，c 被覆盖。该场景是共享管理锁之外的文件修改；
不能据此声称两个遵守管理锁的 CLI 会并发覆盖。

修复将注册表/Profile/标记快照固定在首次等待前，固定模式同时捕获主配置和恢复基线；停止前、停止后及
后续写入复用同一快照，最后一个账户也不重新拍摄晚快照。未改变数据格式、持久备份布局或回滚策略。
关联检查 DS、CLP 删除路径在首次异步等待前已有快照，无需对应修改；CCG 虽在停止前拍摄快照，
仍晚于恢复基线读取的异步等待，已将其快照前移到该读取前，避免相同的旧注册表计划覆盖。

**删除隔离观察。** 修复后，首次等待或停止等待期间新增 c 都拒绝，分别 `inspections=1/2`，保留 a/b/c
和原 Profile；最后一个账户等待期间新增 c 也拒绝，保留 b/c。Profile 外部替换、固定恢复基线替换均拒绝，
保留替换内容。Remote 租约返回 `account-runtime-in-use/releases=1`，不兼容监管器返回
`supervisor-incompatible/releases=0`；删除默认账户返回 `default-account-conflict/inspections=0`。
正常删除 b 返回 `removed`、剩 a、目标 Profile 移除、共用目录保留。固定账户删除恢复 openai/original-model，
保留后来添加的 user_note；最后一个固定账户正常删除返回空注册表、保留共用目录，恢复 baseline 模型和
user_note。最后账户的注册表移除端口抛错时，原主配置逐字恢复，账户 b、Profile 和共用目录保留。
这些观察使用生产管理/文件/注册表实现、临时 Home 和隔离监管器端口；无真实服务停止、租约进程或原生 OS 观察。
CCG 使用生产 Profile/标记生成器和本地目录准备隔离账户；正常删除返回 `removed/registry=[a]/profile=false`，
恢复基线读取等待中以微任务写入新增 c，修复后拒绝并保留 `registry=[a,b,c]/profile=true`。
现有共享回滚器对外部冲突返回“配置失败且回滚未完成”，不会覆盖外部注册表；本项没有改变该错误分类。

**L15-F2 新增/重配快照晚于下载。** OCG 的 nextAccounts 和目录来源先于 Profile 归属检查、目录下载、CLI
校验确定，原快照直到这些等待之后才捕获。同样会丢弃外部更新：子代理在原实现下载回调新增默认账户 c，
添加 b 返回 `configured/accounts=[b]/externalBytesPreserved=false`。修复在执行计划首次等待前固定 config、
Profile、标记、目录、manifest、固定基线及注册表；只为新分配的随机归档文件补快照。等待后首次复核位于
回滚区域外，尚未写入时的冲突不误报回滚失败；主代理补齐归档和固定基线写入前的复核。DS、CLP、CCG
配置路径已有等待前快照，按各自合同保留。

子代理观察到修复后同场景 `operation-failed/accounts=[c]/externalBytesPreserved=true`，b 的 Profile/标记/目录
未创建；下载期间分别替换目录、manifest、主配置、Profile、标记、固定基线的六个场景均保留外部字节。
已有目录时首次等待新增 c，也保留原 a-b/c 和目录，未创建目标 d。凭据变量名冲突 a-b/a_b 使最终注册表
写入失败时，原账户与目录保留，新主配置/标记/基线不存在、新凭据数为 0。
正常切换→固定→切换均可经生产 reader 读取，主配置没有明文 Key。主代理补齐写前检查后，再从生产 CLI
业务入口 `addOpencodeGoAccount` 执行切换新增→固定→切换→再次固定，四次 `configured`，运行时均读回
`ocg-review/deepseek-flash` 及对应模式；本地目录源读取一次，归档基线数为 1，输出不含 Key。
上述目录由本地仓库数据供给，实际调用已安装 Codex CLI 做隔离目录校验，无网络下载或付费调用。

**聚合独立审查。** Sol 核对成员快照→宿主刷新→模型列表→每次出站→成员指标，主代理复核材料守卫、
最终 HTTP 提交及指标分派点。注册表、Profile、目录、未完成事务标记和 CP 协议元数据均纳入指纹；
路由按精确 provider/model 保存成员 Key，共用目录不合并账户路由。实例刷新前后复核材料及生成目录字节，
成员变化不会自动混入旧实例。守卫仅接受当前 Worker 和请求序号的结果，取消或退休不释放尚存活 Worker 的
资源所有权；代理复核成功并检查取消后才出站，材料变化返回 `409 aggregate_snapshot_changed`。
指标按实际成员账户分派到对应 Provider Socket，聚合外层不重复采集。

子代理实际运行生产 `AggregateMaterialGuard`，未变材料 `accepted`，变更材料拒绝，预先取消返回
`isolated cancellation`，关闭后返回“聚合材料复核不可用”；Worker 关闭且临时目录清理。
未观察真实成员请求到指标数据库落地、活动租约下完整重建、运行中 Worker 超时/迟到及 Windows ACL 子进程退出；
这些结论限于源码关联与上述守卫观察。材料复核和网络发送之间不具备跨进程原子性，保持模块已声明的限制。

**完成边界。** CLI 与 WebUI 均复用上述账户管理接口；正常配置及删除、外部变更拒绝、固定恢复和回滚已有
隔离生产路径证据。未重复执行 DS/CLP 全套账户配置，相关路径以源码核对为依据。快照检查和文件原子替换
不等于跨进程多文件原子事务，本轮修复已确认的等待后重新认可旧计划基线问题。没有新增或运行测试。
本项记录与修复提交后，下一项为 L04 审批归属、交互排队及迟到决定。

### L04 审批归属、交互队列与迟到决定

**审查基线：`9158af12`；状态：已审查（附证据限制）。** L15 已提交，正常类型、边界、Lint、文档和构建门禁通过。
本项按 Server Request→Client 解码→祖先/绑定归属→交互排队→用户决定→原请求响应追踪，
复用 L03 授权边界；子代理独立核对 Router 排队/批量取消和 Surface 清理消费。

**L04-F1 权限原因遮蔽实际范围。** 临时权限审批原来使用 `reason ?? JSON.stringify(permissions)`，
有原因就不展示权限。生产协调器隔离观察显示 detail 仅为“读取报告”，批准后却返回 network.enabled=true、
`/sensitive` 写权限及 root 写规则。三渠道消费同一 detail，没有其他权限明细来源。
修复始终组合转义原因与完整权限 JSON，保持 Turn 范围；超过共同的 3000 UTF-8 字节上限时安全拒绝，
不让渠道截断后保留批准按钮。官方固定源码 HEAD 已核对为 `83086188ae0614bd882818ff1aa23f3194962012`，
权限 Params 的 reason 与 permissions 独立，项目仅批准 Turn 范围；没有新增协议字段或授权方式。

**权限与归属观察。** 以内联调用实际 Client 适配器→ApprovalCoordinator→SessionRouter/MemoryBindingStore/
WorkspaceRegistry→InteractionRouter→隔离 Surface。有/无原因均显示完整网络、root 和带换行路径的 JSON
转义表示，`allowSession=false`，一次批准返回完整权限及 `scope=turn`。超长清单 `Surface calls=0`、返回
空权限。同值解绑/重绑、Workspace 目录变化后，迟到批准均为空权限；已解决通知在 Thread 读取中到达时，
不调用 Surface。合法子代理沿两次 Thread 读取投递父绑定且保留原请求身份，不同 cwd 的祖先链拒绝。
这些观察使用隔离 Thread/Surface 端口，没有真实 App Server 或渠道平台权限授予。
补充含下划线、方括号、星号、双引号、换行与双向控制字符的路径：JSON 字符串值先经过现有审批转义，
解析回原权限 `roundTrip=true`，微信 Markdown 清理后仍保留路径转义，批准返回的权限对象不变。
生产 Client/协调器/共享按钮映射的命令观察：一次选择仅返回 accept，显式会话选择才返回 acceptForSession，
未提供会话选项时拒绝；命令前缀提议与允许决定精确匹配时原样返回 git/status，不匹配时拒绝。

**队列独立审查。** Sol 内联运行生产 Router，排队请求 25 ms 到期不调用 Surface；阻塞事件循环后在超时
回调前返回批准，仍由消费时截止复核拒绝。同一会话 a/b 同属 Thread t、c 属于另一个 Thread，批量取消 t
后仅派发 a/c，不派发 b，c 仍可批准一次。注销取消活动和排队请求，新请求也拒绝；跨端 resolved 后迟到
批准失效。不同会话与异步问题队列独立。PersistentInteractionPort 前序等待超时后，不调用底层 request。
飞书准备阶段超时先撤销令牌，清理窗口内迟到取得消息 ID 后进行一次终态更新，不重新批准。

**L04-F2 Telegram 交互端口关闭边界。** 原端口只等待准备与状态更新，没有自有清理截止栅栏。
子代理运行生产端口和隔离 deferred API，close 约 5004 ms 返回后才给出消息 ID，仍记录
`edit.afterCloseReturned=true`，决定保持拒绝。完整 Gateway 在随后关闭的 Outbox 中另有拒绝栅栏，
所以此证据仅证明端口自身合同缺口，不能声称整机关闭后仍出网。
修复缓存关闭 Promise，在准备窗口结束后禁止新状态清理，状态排空后中止自有取消信号；清理排队与 SDK
调用继承该信号，等待也能从不响应取消的端口返回。原请求的失效决定保持不变，不重发未知发送。
完整服务关闭顺序仍归 L12，本项只修复交互端口的迟到准备与清理所有权。

主代理修复后运行生产 TelegramInteractionPort 与隔离 API：close 约 5007 ms 返回后迟到消息 ID
`edits=0/lateEdit=false`；窗口内 25 ms 返回消息 ID 时 `edits=1` 并完成清理；状态编辑一直不返回时，
close 约 5001 ms 返回，SDK 信号已中止，交互决定也返回拒绝。三项重复 close 均复用同一 Promise。
隔离 API 的等待均已释放，无遗留异步任务；不代表真实 Telegram 已接受的消息一定被撤回。

**完成边界。** 已核对请求归属、单次/持久范围映射、队列有效期、批量取消、跨端解决、祖先路由和
三渠道清理消费，修复权限预览与 Telegram 端口关闭缺口。真实渠道送达/撤回、实际 App Server
审批执行及 Windows/macOS 行为未观察；相关平台结论限于源码和隔离端口。没有新增或运行测试。
本项修复和记录提交后，按顺序进入 L05 Thread 绑定、订阅与恢复。

### L05 Thread 绑定、订阅与恢复

**状态：已审查（附证据限制），修复订阅补偿、后台恢复和事务错误覆盖。**
本项按 ensure/resume/接管→唯一归属→持久化→订阅与活动恢复→输入消费追踪。
主代理负责 Router 与消费链；Sol 独立只读审查 Memory/SQLite Store 事务和重开，不触及真实数据库。
不变量是一个 Thread 只有一个 Conversation 归属，后台历史目录不覆盖用户工作区选择，
失败写入不发布成功，App Server 权威活动必须先恢复再决定是否提交新 Turn。

**L05-F1 绑定失败后的订阅补偿。** 原 ensure 新建和自动恢复在绑定写入抛错后没有取消新订阅；
后台创建虽取消，却吞掉取消失败。主代理内联调用生产 Router，隔离生命周期端口返回合法会话，
Store 写入故意失败：修复前两条前台路径 `unsub=0`；后台清理失败只返回原存储错误。
修复复用已有 cleanupFailedResume，绑定成功后才写新建/自动恢复缓存；保留已有合法归属的订阅。
修复后新建、自动恢复、后台三条路径各观察清理成功/失败：均 `unsub=1/binding=null`，
清理成功保留原始存储错误，清理失败 AggregateError 同时包含存储和清理错误。未调用真实 App Server。

**L05-F2 后台绑定加载改变选择与活动。** 原 SQLite load 用前台 bind/demote 还原后台，
仅有后台时覆盖先加载的工作区，并把重开时刻当作活动。Sol 在任务自有数据库复现：选择
workspace-new，重开变成后台 workspace-a，活动时间也变大。下游 ensure 消费该选择，可能在旧目录新建。
修复直接使用既有 memory.bindBackground；不改 Schema、不迁移或写入用户数据。
主代理用生产 SQLite Store 重开临时库，后台仍归 old，已选工作区保持 selected；活动时间读取
数据库原值，不再合成重开活动。demote 的内存与落盘时刻存在毫秒差，未将内存值当作持久化原值。

**L05-F3 事务开始失败掩盖原因。** switchForeground 在 BEGIN IMMEDIATE 失败后仍 ROLLBACK，
Sol 持有另一个写事务时观察到 cannot rollback，原始锁争用被覆盖。改为事务开始成功后才进入回滚区。
主代理持有临时库写锁后实际 bind 返回 `database is locked`，新绑定不存在；释放锁后同一 Store
成功绑定 fresh 到 selected。其他事务的 BEGIN 已在 try 前，未扩大修改。

**存储独立审查证据。** 跨 Conversation 后台绑定拒绝且原归属不变；后台变化不改前台偏好和
force-new；转移后旧主 forceNew=true、新主=false，双方偏好清空，重开一致。事务中途 sessionId
违反 NOT NULL，Workspace、偏好、前后台写入完整回滚，内存未提前改变。解绑、撤权与 force-new
重开一致。v5、非空未知 v0、缺表 v6 均拒绝且主库哈希未变，空 v0 正常初始化 v6。
这些证据来自生产 Store 与临时数据库；临时材料已清理，没有新增或维护测试。

**输入消费与恢复。** 主代理运行生产 ConversationService.submit→SessionRouter→SQLite→
ConversationCore，生命周期/Turn 和模型设置使用隔离窄端口。先保留 old 后台、选择 selected 并重开库，
再提交文本：实际 startThread 的 cwd=/selected，startTurn 收到 fresh 与同目录和原文，返回
threadId=fresh/turnId=turn-fresh；前台归 selected，后台仍归 old。此为生产用例到可控执行端的观察，
不表示真实渠道或 App Server 已执行 Turn。随后模拟同一 Thread 卸载，恢复返回 native-active：
Core 恢复活动 Turn，submit 返回 conversation.busy，startTurn 总调用数仍为 1，没有重复启动。

4 个并发后台创建只调用 startThread 三次，第四个 conversation.background-limit，剩余容量 0。
绑定已提交但随后清除 force-new 写入失败时，本次明确报错，原绑定保留；重试 ensure 消费原绑定，
startThread 总调用数仍为 1。持久标记属于后续无绑定时的保守选择，不把单独清标记失败当作绑定回滚。

源码已关联 resume/fork 的旧订阅恢复与新订阅清理、接管的双 Thread 锁与空闲复核、共享后台容量、
restoreSubscriptions 的暂时失败保留和永久不可用清除，以及 BindingRestoreCoordinator 的 Provider
断线代数、活动跟踪和后台释放。Provider 选择复用 L03 的精确 Provider/模型边界：自动候选必须匹配
显式 Provider 且仍可配置，最终 Turn 另行拒绝覆盖到不同 Provider。L03 已记录的撤权、目录替换与
生命周期守卫输入未改变；L04 的审批归属读取继续消费同一绑定接口，本项没有改变其接口或有效期。

**完成边界。** 临时 SQLite 重开、失败补偿、容量并发和生产输入用例已观察；真实 App Server
断线重连、真实 Provider 实例路由、渠道发送及 Windows/macOS 未观察，不能把隔离端口结果视为这些
环境通过。没有新增或运行测试。提交本项后按顺序进入 L18，普通归约、Reserve、重复思考三个子链分别记录。

### L18 会话归约、Reserve 与重复思考保护

**状态：已审查（附证据限制），修复归约清理、Goal 身份与 Reserve 手动抢占。** L05 已提交
`3d21ba43`，本项按既定顺序推进。
主代理追踪 Client 投影→Core Turn/Item/Goal 归约→状态与呈现消费，含旧轮次迟到、partial answer、
Revert 清理、Goal 写入确认与取消、长期缓存边界。两个 Sol 子代理分别独立只读审查 Reserve
账户授权→设置写入与双确认→恢复，以及重复思考检测→精确中断→官方终态→清理。
三条子链各自记录实际证据和环境限制；不把 Turn 完成当作 Goal 或自动干预成功，不自动重放输入。

**L18-F1 旧轮次完成清除新统计。** Core 原先在任意 turn.completed 后删除按 Thread 保存的
统计累加器，虽 output 已按 Turn 拒绝错配，清理仍没有核对 Turn。内联先开始 new 并记一条模型请求，
再完成 old/new，修复前 newTiming=null。现在只删除身份匹配的累加器，未绑定完成也清理该轮次错误。
修复后生产通知投影→Core→输出得到 new 的 modelRequestCount=1、input=10、output=3、reasoning=1，
旧完成仍保持自己的 Turn 身份。此观察是对抗乱序输入，不声称已在真实上游观察到同一乱序。

**L18-F2 生命周期缓存释放。** 全连接断开原先保留 artifacts，直接调用后仍可读取 isolated-diff；
按 Provider 的定向断开则未清理 errorsByTurn 与 phaseByItem，观察各残留 1。现在全断开清空产物，
错误采用 Thread/Turn 复合键，既有 clearTurnResponseState 同步清理错误、消息去重与阶段缓存。
修复后 artifacts=null；同时存在 a/b 两个 Thread 时只断开 a，保留的键恰为 b:failed 与 b:failed:i。
定向断开是现有 Gateway 重连路径；全断开补齐 Core 公开合同，不把该支路描述为当前重连接线。
读取端已追到 ConversationService.artifacts 与 diff 命令，清理后不返回失效产物。

**L18-F3 Goal 响应身份。** 通知已有内外 Thread ID 一致性校验，但 get/set 响应只校验字段格式。
主代理运行生产 Client，给 selected 请求返回 other Goal，修复前 get/set 都接受。现在响应转换核对
请求 Thread，错配明确报错，不能按请求 Thread 写入别的 Goal。锁定官方源码 HEAD 为
83086188ae0614bd882818ff1aa23f3194962012；get/set 按请求 Thread 返回 Goal，set/clear 保留
origin=user，写入无重试，未增加协议能力。

生产 ConversationService→Router→Client→隔离 RPC 的正常路径观察：set 修剪目标文本后返回并同步 Core，
get 取得相同目标，clear 后缓存为空；错配 get/set 均拒绝，缓存保持空。已提交响应期间撤权仍归约真实
已发生结果；撤权后再 clear 的 additionalCalls=0。只读 get 的 overload 重试允许，set/clear 均 false。
没有创建真实 Goal 或执行外部 Thread。通知投影→Core 的 partial_answer 保持可展示，但成功终态仍标记
missingFinalResponse=true；final_answer 不标记。早先一轮手工输入缺少 clientId 被正确拒绝，补齐 null 后
才观察用户消息对应判定；未将畸形输入当作正常链路通过。

**L18-F4 Reserve 手动往返抢占。** Sol 复现进入 Reserve high 后手动 low→high，下一次轮询仍写
ordinary，覆盖用户选择。原实现只比较最终快照，丢失等待/轮询间变更。现组合根在 ThreadStateSynchronizer
同步归约后调用 Application 观察器；Reserve 记录刷新起始设置和最终提交时的目标，自己的匹配通知推进
确认，其他偏离立即清除返回状态并使刷新代次失效，改回原值不复活操作。观察器不等待 RPC、不取得会话锁。
本次未改 Client 的共享双确认实现，不影响 L04 审批方式确认。

主代理修复后运行生产 Reserve、通知投影、ThreadStateSynchronizer、Router 与内存 Store：正常流程写
[gpt-reserve, ordinary] 并分别提示；手动往返只写 [gpt-reserve]，returnState=false，不提示切回；
进入时查询模型期间手动往返 writes=[]；恢复时查询期间往返只保留第一次 gpt-reserve 写入。
端口按真正提交前守卫→设置通知→返回顺序驱动，关闭后所有定时器和操作收尾。
协议没有版本条件或写入关联号，仍不能识别完全同值的其他客户端写入或保证跨客户端原子性。

Reserve 独立审查还覆盖账户/受限模型/精确隐藏模型、相同 Turn 错误配对、活动延后、pending 选择、
最终 RPC 守卫、无未知 Banner/剩余阻断的恢复条件及关闭。修复前未变的 Client 双确认观察可复用：
仅 RPC ACK 或不匹配通知保持 pending，最新匹配通知后 confirmed，临时监听数 0；断线前确认失败并清理。
账户清理中止额度读取，writes=0；未确认写入只尝试一次、returnStates=0、timer=false，后续轮询不重试。
这些结果是独立生产模块与隔离端口证据，60 秒定时器自然轮询未观察，恢复调用由隔离运行主动触发。

**重复思考独立审查。** Sol 未确认缺陷；主代理复核精确提交守卫、终态处理及组合根路由结论。
锁定原始/摘要段索引映射，完成快照只分隔边界；固定第三方与聚合进入保护，官方 OpenAI 排除。
200 个 Unicode 码点同段重复三次只对捕获的 Thread/Turn 中断一次，RPC 成功不提示停止，只有官方
interrupted 才提示。原始两次加摘要一次、跨 Item 两次加一次及旧 Turn 增量不触发；触发后解绑使迟到
守卫明确拒绝。10 万字符增量显示缓冲降级，只检测有界尾段；第 33 个并发窗口显示降级。
拒绝、实际等待超过 10 秒无确认、普通 completed/failed 均不伪称已停止。缓存边界为 32768 UTF-16
单元、200–4096 码点周期、32 Run、128 排队块/边界及 128 终结标记，关闭释放自有状态。
不递归中断子代理，不删除 Queue、不改 Goal、不自动继续；所有隔离作业已结束。

**覆盖与限制。** 普通归约/Goal、Reserve、重复思考分别完成源码追踪与上述观察，Revert 仍只清派生
展示、保留活动到官方终态；绑定恢复复用 L05 活动跟踪证据。修复后的局部缓存释放不代表所有长期运行
内存峰值都已实测；模型请求统计后续仍由 L10 审查。真实 App Server、Reserve 账户授权与模型可用性、
原生客户端人工操作及三渠道投递未观察。没有新增、维护或运行测试。提交后按顺序进入 L06。

### L06 Queue、Revert 与模型选择快照

**状态：已审查（附证据限制）。** 审查基线为 L18 提交 `1ecf4f67`。
本项从页面选择与 Actor/Workspace/Thread 身份追到权威 Queue/历史、确认写入及通知失效；
主代理审查 Queue，Sol 分别只读审查 Revert 和模型/模式选择快照。App Server 持有唯一 Queue 与
历史，不建立平行队列、不将多步本地复核宣称为跨客户端原子性。复用 L03/L05/L18 未变化证据。

**发现与修复**

- **L06-F1，Queue 内部读取覆盖用户序号。** `readSnapshot` 原来同时保存数字选择快照，
  未向用户展示的写前读取也会重排旧页。实际复现：列表显示 `[a,b]`，权威顺序变为 `[b,a]`，
  对不可编辑 a 的更新失败后，删除 `1` 错删 b。现在只有列表成功返回才建立数字映射；
  修复后同一操作删除 a。列表等待期间失效不再重新发布快照，数字操作等待期间检查原快照身份及期限。
- **L06-F2，Revert 在途引用绕过通知失效。** 原来通知只删除 Map，确认仍持有局部历史与令牌引用；
  最后一次 Queue/提交等待期间原生 Turn 开始，旧确认仍可回退未经预览的新 Turn。
  列表和预览等待也可能重新发布已失效页面。现为整个操作登记失效标记，贯穿最终提交守卫；
  已写出请求按真实响应结算。确认成功或失败都清除同会话其他令牌和页面，防止结果未知后使用兄弟令牌重试。
- **L06-F3，Plan 快照压过后续模型选择。** Plan 缓存 a/medium 后选择 b/high，原 Turn 同时携带
  顶层 b/high 和模式 a/medium；锁定官方 `step_settings.rs` 优先应用模式字段，导致旧值生效。
  `turnOverride` 现在合入较新的显式模型和思考等级，保留模式其他设置。
- **L06-F4，原生 Turn 开始后在途模型选择复活。** 目录等待之前的空闲检查不足；通知清空待选值后，
  旧选择仍可能保存。现把通知失效标记传入选择及 Queue 复核的守卫，永久取消这一在途操作，
  即使原生 Turn 随后完成也不能复活。跨 Provider 选择自身执行的解绑仍由模型服务更新预期 Thread，
  外层守卫不将这个合法转换误判为外部改绑；此边界按调用源码复核，未单独做修复后运行观察。
- **L06-F5，Telegram 旧模型页作用到新 Session。** 原令牌未绑定目标与 Actor，平台应答/清按钮等待后
  重新调用命令会捕获新绑定。实际以官方归档/删除对应的 `forgetThread` 解绑模拟等待期变化，
  原路径仍保存新模型。现模型状态携带不透明的 Conversation/Workspace/cwd/Thread/Session 身份，
  按钮令牌再绑定 Actor；模型、Provider、思考回调在平台等待后复核授权和原身份。
  普通 Telegram 命令已有 Conversation 串行化，此发现不声称并行 `/new` 可插入同一处理队列。

**关联范围与实际观察**

- Queue 生产 Service→Client→隔离 RPC 依次添加 first/second，列出 q1/q2，更新 q1 为 updated、
  q2 排首、再列出 q2/second 与 q1/updated、删除 q1、启动返回 turn-q2，最终列表为空。
  请求 Thread 均为目标 thread；列表允许 overload 重试，所有写操作禁止重试。
  在列表等待注入失效返回 `queue.snapshot.required`，待处理标记与快照均归零；数字删除等待注入失效也拒绝，
  删除记录未增加。隔离 RPC 使用内存实现，不能证明真实 App Server 持久化或自动派发。
- Revert 生产 Service 配合隔离端口，正常 list→preview→confirm 写入 1 次并返回成功；
  列表、预览、确认 Queue 读取和最终提交守卫处注入失效均返回 `revert.concurrent`、写入 0 次，
  标记、快照、令牌归零。写出后才失效仍结算成功，写入 1 次。
  两份预览中第一份写出后断连返回 `revert.result-unknown`，第二份返回 `revert.confirmation-invalid`，总写入保持 1 次。
- Revert 只读独立审查另观察 Actor 错配、Queue 指纹变化、等待期撤权/改绑拒绝写入；
  legacy Thread、循环游标、第 21 页分别拒绝为 legacy-thread/unavailable/usage。
  Queue 输入仅在第 160 字符之后变化仍产生不同完整指纹；历史 Skill 输入只投影类型，预览不泄露路径。
  Provider 包装与 Client 保留最终守卫，Revert 不启用自动重试。
- 生产 ConversationService→模型/模式服务→Router/Core→隔离 Turn 端口执行 Plan、选择 b、选择 high、提交输入：
  最终顶层与 collaborationMode 都为 b/high，模式为 plan，原输入到达 Turn 并返回结果。
  目录等待期间由生产协调器注入原生 Turn 开始，及开始后完成两种情况，均返回
  `command.authorization-changed`，pending 为 false，在途标记归零。
- Telegram 生产回调→真实命令/会话/模型服务→Router/Core/内存存储配合本地 SDK 端口：
  正常模型按钮写入 1 次、回复 1 次并得到待选 b；应答等待期间解绑、同 Thread 更换 Session、
  使用旧 Session 页面、其他 Actor 使用按钮，均返回 `model.selection.expired`，模型写入与回复均为 0。
  未连接 Telegram 网络或发送外部消息。
- 对照锁定官方 `83086188ae0614bd882818ff1aa23f3194962012` 的 Queue 处理、模式优先级及 Revert 设置恢复，
  修正文档原有超出实现的表述：当前只在预览/写前复核 Queue，未做写后回读；
  Client 虽投影 Revert 返回的 Thread，Application 不据此更新 Router 或额外读取。
  官方内部恢复设置并保留 Thread ID/订阅，后续依靠通知与既有读取收敛；没有据此声称观察到设置恢复故障。

**证据限制与交接**

以上运行观察均使用生产模块与隔离端口；没有操作真实用户 Thread、调用模型或连接平台服务。
真实 App Server 的 Queue 持久化/自动派发、真实回退与通知时序、Telegram 平台交互仍未观察；
最终本地守卫之后的跨客户端变化不具有原子保证。未新增、维护或运行测试。
提交门禁结果单独报告，不代替上述行为证据；本项提交后按清单进入 L16。

### L16 Skill/Plugin、MCP 与 Hook

**状态：已审查（附证据限制）。** 审查基线为 L06 提交 `111857e6`。
本项分别验收 Skill/Plugin 实时解析与 Turn 引用、MCP 配置/资源/OAuth/刷新、Hook 精确内容与版本确认；
主代理负责 Skill/Plugin，Sol 分别只读审查 MCP 和 Hook，复用 L03 未变化的授权证据。
不运行真实 OAuth 或 Hook，不操作用户配置，不开放市场安装或任意 MCP Tool Call。

**Skill/Plugin 子链。** 主代理已追踪命令解析→Workspace 目录→精确解析→自动恢复/绑定→Turn 编码与最终守卫。
发现 **L16-F1**：未绑定时 `models.status` 默认 OpenAI，Plugin 初查放行后 `ensure` 可能自动恢复到其他
Provider 的历史 Thread，原路径仍发送 mention。生产 ConversationService→真实 Router/模型服务、隔离
目录与执行端口复现：入口 Provider 为 openai，最终提交记录为 other，返回了成功提交结果。
现同时按实际 Thread 设置判断，并在自动恢复后的消费点和最终 start/steer 守卫复核，不修改通用恢复策略。
修复后生产 CommandService→ConversationService→Client/适配器、隔离 RPC/Thread 端口观察：

- OpenAI 正常返回 plugin.started，原任务文本与 `plugin://demo@local` mention 到达 history Thread，写入一次；
  自动恢复 other、最终提交守卫前 Provider 变为 other 均返回 `plugin.provider.unsupported`，Turn 写入为零。
- 两次 Plugin 目录读取之间停用插件，返回 `plugin.unavailable`，不发 Turn；两次查询均限定 `/isolated`。
  Skill 正常返回 skill.started，实际协议输入为 `$demo hello` 文本和解析得到的绝对 SKILL.md 路径；
  同名两个启用 Skill 明确拒绝，错误 cwd 返回 `skill.not-found`，均不发 Turn。
- 生产适配器观察：系统 Skill、插件 Skill、禁用 Skill 不进入直接安装列表；相对路径和非 SKILL.md 拒绝调用。
  Plugin 受管禁用不产生 invocable，ID 与 name/marketplace 不一致拒绝；摘要只保留来源类型和加载错误计数，
  未传播来源路径或原始诊断。未改变目录数字选择器按本次权威目录解析的既有合同。
- 锁定源码 `request_processors/catalog_processor.rs` 与 `plugins.rs` 确认 cwd 查询、Skill 官方缓存及
  Plugin 已安装目录语义；本地每次调用重新查询不等于强制磁盘重扫，Skill 当前仍传 `forceReload: false`。
  引用也不是文件内容哈希承诺；未观察真实目录文件替换与模型实际执行。

**Hook 子链。** Sol 在源码定位阶段因模型容量中断，未交付完整结果；以下由主代理接手，不能计作独立审查通过。
复用 L03 Actor/Workspace/Provider 等待守卫证据，补查适配器→Service 精确 key/hash/version→Client 单次
batchWrite→Provider 修订与刷新→权威回读→共享格式器/渠道无损策略，未发现新增需修复问题。
主代理内联生产 HookService→ProviderRouting→Client→隔离 RPC 实际观察：

- 正常列表、信任预览与确认返回 trusted，写入 1 次，openai/second 各刷新一次；令牌重放返回
  `hooks.review-expired`，写入保持 1 次。同 key 改 command/hash 或改变用户配置版本后确认均拒绝，写入 0 次。
- second 刷新失败仍回读 trusted，结果明确携带 `refreshFailedProviders=[second]`；共享呈现包含“刷新未确认”，
  不把其他实例运行状态当成成功。回读失败返回 `hooks.readback-failed`，写入仍为 1；
  写出后响应丢失返回 `hooks.write-unconfirmed`，不重试且旧令牌失效。
- 501 字符 command 无法无损展示，预览返回 `hooks.local-review-required`、写入 0 次。
  适配器对 prompt/agent/MCP 缺完整内容不提供信任能力；实际投影 prompt 为 reviewable=false，
  凭据脱敏或换行清理改变 command 也为 false。微信含下划线文本经生产无损策略拒绝，普通 command 可审查。
- 官方 `hooks/src/engine/discovery.rs` 的哈希覆盖规范化事件、matcher/group 与处理器配置，
  `trusted_hash == current_hash` 才是 trusted，不覆盖脚本文件内容。现有呈现已说明这个限制及信任不等于执行成功。
  用户配置版本用于冲突保护，项目 Hook 在最终检查后仍可被外部改动；保存旧 hash 不会把新 hash 自动信任。
  Provider 刷新失败保留落后修订，后续操作需成功刷新才能获准；此后续补刷路径按源码复核，未额外运行。

**MCP 子链。** Sol 完成配置保存、OAuth 结果路由、资源读取与运行刷新四项只读审查；
主代理核对报告对应源码，并修复确认问题、观察改动后的关联入口。

- **L16-F2，OAuth 结果未关联登录尝试。** 原响应与通知都丢弃 loginId，Core 只按当前 Thread 绑定投递。
  Sol 通过生产适配器/Core/格式器观察新登录成功后旧登录失败仍输出 `[true,false]`，旧结果投给转移后的
  new-owner，第三方 Provider 的同 Thread 通知也投给 OpenAI 会话。固定官方响应/通知携带相同 loginId；
  完成任务可在响应前运行，默认 OAuth 超时 300 秒，不能只在响应返回后登记。
  现 Client 必须取得有效 loginId，ProviderRouting 返回实际连接路由键；Application 发起前登记有界关联，
  响应前暂存、响应后精确匹配 Provider/Thread/server/loginId，并复核原绑定、Session、Workspace 与授权。
  同会话同 server 的新尝试替换旧代次，成功/失败完成只消费一次；命令响应未知不自动重试。
  事件协调器先关联后归约；无本 Gateway 登录、过期、转移、关闭或断线后的结果不直接按新绑定投递。
  关联上限 128 个、期限十分钟，覆盖官方五分钟及调度余量；响应前上限 8 条，每条错误最多 4,096 字符，
  超限且无法匹配时明确要求查询实际认证状态，关闭清空。不把关联取消解释为撤销服务端登录。
- 主代理修复后生产 Command→Conversation/Extension→ProviderRouting→Client 与通知适配器→事件协调器→Core，
  配合隔离 RPC、真实 Router/内存绑定观察：正常与通知早于响应均只投递 1 次；重复完成不重发；
  旧失败与错 Provider 通知均不覆盖匹配的新成功。转移归属、同 Thread 更换 Session、撤权、Thread 关闭
  都为完成输出 0、pending 0；缺 loginId 响应和 RPC 失败同样清理为 0。
  两个重叠请求中旧响应或旧失败都不删除新占位，最终只投递 new；响应前九条不匹配通知返回
  `mcp.oauth.unavailable` 并清空。推进关联期限、调用断线清理、服务关闭后完成均不投递且 pending 0。
  断线实际 Socket 与十分钟墙钟等待未运行；观察通过设置该次关联期限和调用生产清理入口完成。
- **L16-F3，资源 URI 绕过正文脱敏。** Sol 输入内容 URI 的 `api_key=placeholder-resource-key`，
  正文同类字段已隐藏，生产格式器仍原样显示 URI。主代理将请求/内容/资源目录/模板 URI 的输出投影
  统一使用现有凭据脱敏，RPC 输入保持原始含义。修复后生产 Client→适配器→格式器观察文本和二进制
  内容、请求 URI、完整详情及 resources/templates 分页均不含占位凭据，显示 `[REDACTED]`；
  捕获的实际 RPC URI 与原输入完全相同。没有把展示字符串用于自动重读，也没有新增通用元数据清洗。
- **配置保存独立证据（Sol）。** `runMcpSetup`→真实 Client→隔离 RPC 新增成功 reads=2/writes=1，
  expectedVersion=v1、replace、reloadUserConfig=true，关闭一次；取消 writes=0，版本冲突写一次且不重试。
  回读不一致与合并认证冲突在 saved=true 后返回明确未确认，没有误报连接成功。编辑/删除共享保存函数
  已按源码追踪，实际入口仅观察新增；未写真实用户文件。
- **资源读取独立证据（Sol）。** 生产 Extension→ProviderRouting→Client→隔离 RPC，目录和资源请求均落在
  third/thread-cp，格式器取得 usable resource text；目录响应期间换 Thread 后不读资源，坏 URI/撤权调用数为零。
  10 项响应保留 7 项，文本合计 8,000 字符、首项 truncated=true、omitted=3，不含 Base64 正文；
  1,000,001 字符文本及非法 Base64 拒绝。主代理 URI 修复未改变上述限额/调用守卫，复用对应证据。
- **运行刷新独立证据（Sol）。** openai 慢成功、third 快失败，慢分支释放前整体仍未结束；
  实际顺序为 openai-start→third-failed→openai-done→returned-error，等待已启动分支后传播失败。
  未把配置保存、OAuth 完成、资源可读或刷新响应互相替代为就绪证据。

**限制与交接。** 本项没有执行真实 OAuth、Hook、模型、App Server 或平台消息，未修改真实用户配置；
真实认证结果、远端资源、刷新后 health 与平台呈现仍未观察。未新增、维护或运行测试；未新增文档。
OAuth 关联与清理是各 OS 共用的进程内合同，未修改 Transport、服务模板或进程所有权；Windows/macOS 未运行观察。
类型与边界检查先发现新增错误码尚未登记，补齐稳定错误码和呈现后已通过；提交门禁状态另行报告。
提交后按既定顺序进入 L17，不据此宣布全项目验收完成。

### L17 重置券预览、消费与刷新

**状态：已审查（附证据限制）。** L16 已提交 `f3c61af6`，类型、边界、Lint、文档索引与构建门禁通过。
主代理审查共用重置券服务、渠道包装与 Client 消费；Sol 只读审查 CLI/WebUI→私有账户 IPC→最终呈现。
复用 L01/L03 未变化的授权与传输证据；单独核对账户变化、忙碌、重复确认、取消、未知结果与刷新失败，
不使用真实重置券，不修改真实账户状态。

**共用消费与渠道子链。** 主代理发现 **L17-F1**：预览/券期限只在读取后检查，Provider 等待后最终
`beforeSubmit` 仅复核授权，可能消费已经过期的确认。内联生产共用服务、隔离消费端口推进时钟，
分别在最终提交前超过预览五分钟及券到期时间，原实现两种情况均 writes=1 并返回 reset/refreshed=true。
现最终守卫同时复核两种期限，本地明确拒绝保留 `reset_stale`，不误分类为已经发出但结果未知。

修复后生产渠道包装→共用服务、隔离账户/消费/刷新端口观察：

- 正常预览→确认返回 consumed/reset/refreshed=true，写 1 次、刷新 1 次；再次确认 stale。
  预览或券在最终等待期间过期、账户变更、券说明修订均 stale，写入/刷新为 0。
- 消费响应丢失返回 reset_unknown，写入 1、刷新 0，不重试；消费成功但刷新失败返回
  consumed/reset/refreshed=false，写入/刷新各 1，不将刷新失败改成消费失败。
- 取消后确认 stale、写入 0；上述场景结束时 busy=false，共用 attempts 与渠道 pending 均为 0。
  两份预览并发确认，第二份返回 reset_busy 且已消费令牌，第一份结束后第二份重试 stale，总消费仍为 1。
- 另经生产共用服务→ProviderRouting→Client→隔离 RPC，reset/nothingToReset/noCredit/alreadyRedeemed
  四种官方结果均原样结算并单独刷新；消费携带精确 coupon ID 和该预览 UUID、retryOverload=false。
  明细读取明确 `excludeResetCreditDetails=false`；最终 RPC 前推进到预览期限外，消费请求记录为空、返回 stale。
  时限观察使用内联可控时钟，不宣称实际等待五分钟。

已核对锁定官方 `rate_limit_resets.rs` 与生成 Consume 参数：后端在处理消费时获取认证，只有 creditId 和
idempotencyKey，没有预期 accountId 的条件写入字段。Gateway 读取后复核账户/券身份并单次提交，
不能保证最后复核之后原生客户端切换账户的跨端原子性；不添加未支持的协议字段或自动重试。
L03 已观察的渠道身份、目录/Thread、最终授权守卫继续适用。

**CLI/WebUI 独立审查。** Sol 只读追踪 CLI 命令和 WebUI 管理路由，经私有账户 IPC、组合根调度
至共用服务，以及 WebUI API、确认状态与结果文案；该范围未发现新增必修问题。主代理核对路由的
一次性确认、成功后审计降级、独立取消清理和 CLI 单次消费/刷新提示，与共用服务修复一致。
沿用生产入口、临时私有 Socket 和隔离业务端口实际观察：

- CLI 取消仅 preview/cancel，提示未消费；正常确认只 consume 一次并显示用量已重置。
  刷新失败保留操作已确认及稍后查询提示；nothingToReset 使用无窗口可重置文案。
  响应未知仅消费一次后取消清理，明确要求用 list 核对、不直接重复消费；stale/busy 不追加消费。
  非交互消费在 IPC 前拒绝；券名称 ANSI 被清除、描述换行归一，JSON 保留转义原文。
- 生产 WebUI Server 的 HTTP→私有 IPC：预览和正常消费 200，reset/refreshed=true/auditRecorded=true；
  刷新失败仍 200、refreshed=false；未知消费 503/reset_unknown，随后仅 cancel 清理；取消 200 且未消费。
  上述四类重复管理确认令牌均 409/management.confirmation-invalid，无额外消费。
- 首次 CLI 隔离环境缺配置报 ENOENT 且无 IPC 调用，使用生产初始化入口准备临时配置后完成观察；
  这是环境准备修正，不列为产品缺陷。临时 HTTP/Socket 已关闭、临时目录已清理。

**证据限制与交付。** 未使用真实券、真实上游账户或外部渠道；CLI 提示/输入为注入端口，未观察真实
终端 SIGINT。WebUI 浏览器未启动，最终对话框、审计降级和取消清理失败仅核对源码；Windows/macOS
IPC 未运行。以上隔离观察不等同于真实资产消费验收。本项修复同步用户指南与 Application 职责说明，
不新增文档；正常提交执行既有静态门禁，提交后按既定顺序进入 L07。

### L07 持久投递、确认与恢复

**状态：已审查（附证据限制）。** L17 已提交 `2b587798`，类型、边界、Lint、文档索引及构建门禁通过（11.4 秒）。
本项按清单追踪输出事件→投递箱事务→实时授权→平台确认→本地确认→重启恢复，另核对批量管理
修订冲突与审批顺序屏障。复用 L03/L04 已有身份及审批证据；生产 Journal 使用隔离临时数据，
不读取或修改用户投递箱，不发送真实平台消息。未完成的检查不计为已验收。

**主代理链路核对与观察。** 已追踪 SurfaceManager 输出观察器→PersistentSurfaceOutput 快照及
会话尾链→Coordinator→Journal，并检查平台调用前及 started 检查点后的授权复核。
组合根 owner v2 同时绑定 Actor、所选/绑定 Workspace 目录和 Provider；正常释放 Thread 的有限例外
不允许跨目标重绑。PersistentInteractionPort 等待前序投递占用原期限；L04 未变化的超时/失效证据继续适用。

- 生产 PersistentSurfaceOutput、真实临时 Worker/SQLite 和本机 HTTP 接收端：正常正文收到 1 次并完成
  confirmed 检查点及本地删除。HTTP 已收到但消费端报告响应丢失时，记录保留 uncertain；在 started
  检查点前撤权时 HTTP 收到次数不增加，记录也保留 uncertain。重开实际数据库留下两条 uncertain、
  attempt=1、只有 started 检查点，成功记录已移除。该观察使用隔离授权回调，不代表真实渠道送达。
- 生产 Coordinator/Journal，单独将本地 acknowledge 结果设为 false：发送端调用 1 次，故障分类 storage，
  执行准入 unavailable，记录仍 sending；重开转 uncertain，未再次调用发送端。显式允许保留记录释放
  屏障后，后续同会话结果正常送达，旧记录仍计费保留。
- 暂挂同会话第一条投递时，调用顺序为 first、其他会话 parallel，第二条尚未派发且屏障为 true；
  释放后才调用 second。派发前撤权返回 blocked、authorization-changed，不调用发送端。
  管理 ignore 用旧修订返回 false 且记录存在，用当前修订返回 true 后记录数/字节数均为 0。
- 首次内联运行携带 `--input-type=module` 时 Worker 启动失败；改为 Node 原生 stdin 模块识别后运行成功。
  没有据此改产品代码。各轮均关闭 Coordinator/Worker/HTTP 并删除本轮临时数据，未写验证脚本或测试。

**存储独立审查。** Sol 只读覆盖 SQLite submit/ACK/recovery/resolveBatch、共用修订及密文认证、
Journal 邮箱与 Worker 串行写入；主代理复核事务及状态转换关键位置。当前范围未发现新增必修问题。
生产存储和真实 Worker 的隔离观察：

- 账号、单条、全局容量分别拒绝 account-capacity、record-too-large、capacity，原 2 条/131082 bytes 不变。
  pending ACK=false，sending ACK=true 后降为 1 条/65541 bytes；maintenance 保留 sending，runtime 重开
  为 uncertain、attempt=1、started 检查点保留且 next=null。
- reader/writer 修订一致；第二条修订改变后，整批 confirm=false，第一条仍存在且检查点不变；
  重复 ID 批次 conflict。当前修订 retry=true，两条 pending、attempt 保留、检查点清空；旧修订再次失败，
  旧修订读取正文返回 null。GCM AAD 绑定 schema/ID/账号/会话；隔离篡改账号后正文读取 null、writer 启动
  storage，sending 不被恢复改写。
- 公共 Journal→真实 Worker：第二写者启动 conflict；128 次提交成功，第 129 次 mailbox-full，
  预留控制槽 summary 仍读到 128 条，available=true、故障回调 0；ACK 后剩 127 条，关闭后 available=false。
  未知 schema 99 启动 storage，主库 SHA-256 和预设目录权限 750 不变。
- 相关六个 dist 模块与当前 TypeScript 即时编译内容一致；观察用临时数据，所有读写连接、Worker
  和临时目录均已关闭清理，未修改生产存储代码、未运行历史测试。

**限制与交付。** 真实平台、断电/磁盘满、Worker 硬终止、Windows ACL 尚未实际观察；事务提交异常
与部分取消边界仅据源码判断。平台 ACK 与本地事务没有跨系统原子性，不承诺恰好一次。记录既有链路
证据并提交本项文档，不为没有确认缺陷的实现添加改动；随后进入 L08。

### L08 计划任务领取、派发与恢复

**状态：已审查（附证据限制）。** L07 已提交 `181f8914`，文档与索引门禁通过。本项沿 Schedule→领取事务→
执行端口→Thread/Turn→恢复状态核对，不扩展到新调度能力。复用 L03 已有管理授权证据；独立核对
DST/月份缺日、手动/自动竞争、领取后取消、缺失 Turn ID 和重开恢复，不调用真实 App Server 或外部渠道。

**L08-F1，已修复。** 恢复协调器在写入 Run 终态前计算 stillOwned，等待 Store 后沿用它通知和直接释放
后台 Thread。生产协调器隔离 Store/Router/历史端口观察：markCompleted 等待期间目标由 original 改为
new-owner，结果 state=completed、通知 original、释放 new-owner。现持久化结束后复核原后台绑定对象，
并由组合根注入 Application 的后台完成释放检查，保留新 Turn、Queue 或子代理活动的保护；
恢复本身不派发 Queue。修复后转移目标、复用同一 target 对象但更换绑定，均保留已确认 Run 终态，
通知/释放为 0；正常路径通知/释放各 1。清理等待期间再换绑定，传入守卫拒绝释放。
缺 Turn ID 时保持 uncertain、拒绝归属仍登记，不用其他轮次结算；已有 uncertain 的精确终态只释放
运行期归属，不改历史状态、不发成功通知。以上是生产协调器与隔离 Store/Router/历史/清理端口观察，
实际 Application 完成释放的当前 Turn/Queue/子代理检查复用既有实现和源码证据。

**L08-F2，已修复。** Sol 独立发现共享时区校验把 Intl 可解析值全部当作 IANA。生产命令解析→
Application previewCreate→confirm→内存 SQLite 实际保存 `+01:00`，得到 created 和次日 09:00Z，
违背文档只支持 IANA 的合同。现共享 validator 拒绝正负号偏移，命令、自然语言、动态工具和 Store
读取/写入共同生效，不迁移历史数据。修复后 `+01:00`、`-05:00` 及前后空格变体均返回
scheduled-task.schedule.invalid；America/New_York、UTC、Etc/GMT+8 仍可持久化。

**调度及执行链实际观察。** 主代理直接运行生产 Scheduler→Executor→真实内存 SQLite，隔离
Thread/Turn/权限端口：正常只创建 Thread/Turn 各 1 次并保存 running 及两个 ID；领取后取消为
interrupted、写入 0；创建 Thread 后取消和最终 Turn 前撤权均 interrupted、仅 Thread 写入 1 次、
清理 1 次；Turn 响应丢失为 uncertain，保留 Thread、Turn ID 为 null，不重试、不伪造已取消。
此前 L03 的选择、管理授权及原请求取消守卫保持不变。

**Schedule/Store 独立观察。** Sol 直接调用当前源码，主代理核对报告和共用校验调用链：

- NY 春季 02:30 跳到 2026-03-09T06:30Z；秋季 01:30 取 2026-11-01T05:30Z，两个重复时刻之间
  计算则跳次日。Lord Howe 半小时缺口跳过当日；monthly 31 跳过四月、monthly 29 跳过非闰年二月。
  once 落入 DST 缺口明确失败，相对 120 分钟跨 DST 仍增加固定 UTC 120 分钟。
- manual 与 automatic 同毫秒申请被分为相邻 occurrence，手动不推进自动计划；dispatching 时自动
  skipped_overlap，重复自动领取被拒绝，完成后下一次正常领取。uncertain 同时阻止手动与自动；
  retry 容量不足保留旧 uncertain，成功才原子改旧 Run 为 failed 并领取新 Run；finished once 仅允许显式 retry。
- 领取插入后故意触发时间戳倒退，事务回滚、Run 数 0、nextRunAt 不变；retry 无法分配可表示时间戳
  时旧 uncertain 与记录数保持不变。私有文件库重开后 dispatching→uncertain/gateway_crash，
  已知 Thread 缺 Turn 的 running 保持待恢复；第二次 crash recovery 返回空。超过 90 天清理仍保留
  uncertain/running。独立报告未发现其他 Store/Schedule 必修问题。

**限制。** 无真实 App Server、平台通知、断电或多进程持锁竞争；文件重开覆盖已提交状态恢复。
新清理组合路径的真实上游空闲查询未运行，不将隔离端口称为真实 Thread 验收。临时连接/目录均已清理，
无新测试、脚本或文档，相关模块说明和计划任务专题已同步；静态检查结果单列为交付门禁。
首次提交门禁在新增回调的 unbound-method Lint 失败；将接口方法签名改为无接收者的函数属性，
保持回调调用行为不变后重新提交，不绕过门禁。

### L09 Relay 准入、出站、流与交付

**状态：已审查（附证据限制）。** L08 已提交 `81b5194e`，重新提交的类型、边界、Lint、文档及构建门禁通过
（13.0 秒）。本项沿鉴权/排队→材料复核→模型出站→流解析→客户端交付→指标追踪；使用本机 HTTP
与合成模型结果，不调用收费模型。复用 L15 未变化的聚合材料快照证据，未知流终态不得视为生成成功。

**主入口实际观察。** 主代理核对 Server→Admission→材料/采集器准备→Direct Model HTTP 最终
recheck→指标收尾的调用链；真实本机 Relay HTTP 与本机合成上游观察：

- JSON 和 SSE 各返回 200/hello，上游各收到一次，指标分别 completed/finished；材料复核失败返回
  503/upstream_error，Key 在准备期间撤销返回 503/request_revoked，二者均无新增上游调用或指标。
- 一条 SSE 已出站、第二条排队时撤销 Key：第一条已发 200 的流结束为错误结果，第二条 503，
  上游总共只有第一条调用，单条指标 failed/failed；不能从已发送的 HTTP 200 推断模型成功。
- 准备期间撤销后迟到的材料返回，503、出站 0、指标 0；迟到采集器返回亦不出站，finish 仅调用一次，
  参数 failed/failed/preparation_cancelled。每轮 active、pending、waiting、bytes 均为 0，metricFailures=0。
- 全部请求使用合成 Key 与本机上游，未读取用户凭据；Relay 和 HTTP 上游已关闭，无遗留监听或文件。

**出站与流独立审查。** Sol 核对 Direct Chat/Responses、共享 HTTP/SSE、协议观察和工具/图片
转换，未确认新增必修缺陷；主代理复核发送前守卫、终态与交付顺序等关键位置。实际观察：

- Chat 缺 DONE、缺 finish、畸形 JSON、结束后追加正文及非法 UTF-8 均明确失败，不发布追加或非法
  帧；合法相同 finish 的空 assistant usage 尾帧完成且 outputTokens=2。Responses 缺终态、event/type
  不同、terminal output=null 均拒绝；failed 合成秘密正文被替换为受控错误，observer=failed。
- 两协议有效终态后 emit 抛错，交付异常独立传播，observer 仍 completed；中途取消 observer=unknown。
  CLP 支持的 JSON 包装得到 json-ok/completed，Responses JSON 长度截断保持 incomplete。
- 生产 sendDirectChat 的首次 emit 挂起 25ms 时 delivered=1/status=unknown；释放后才到
  delivered=3/status=completed，后续终态没有越过交付等待。U12 的 16MiB 真实 HTTP 背压超时和监听
  清理证据复用：相关生产文件仍为 e035adeb 对应内容，未重复运行。
- 原生 Chat 畸形工具参数按其原样转发合同保留；Chat→Responses 转换在 finish 校验失败，不发布工具。
  同样参数遇到 length 只发布 incomplete、terminalOutput=[]。并行工具 b/a 图片按结果顺序保留归属，
  两条 tool 后只补一条 user 图片消息；缺结果、不匹配结果、远程 URL 和 file_id 明确拒绝。

**限制与交付。** 不穷举所有 custom/namespace/tool_search/reasoning/图片组合；合成图片仅验证
转换形状，不验证解码或模型理解；未等待生产 300 秒空闲期限，未调用真实模型。两个独立观察 HTTP
服务已关闭，无待收集作业。本项只提交既有文档证据，后续按顺序进入 L10。

### L10 指标接收、写入与范围消费

**状态：已审查（附证据限制）。** L09 已提交 `bdec8d48`，文档与索引门禁通过。本项沿指标 IPC→有界 Writer→
SQLite→范围查询/完成卡核对，复用 U13 未变化的运行树选择与 L09 单次出站指标证据。隔离数据观察
不得操作真实指标库，接收确认不得写成持久化成功。

**L10-F1，已修复。** Writer 将入队拒绝统一记为 sequence=0；统计固定初始水位后、等待数据库
范围解析期间的新拒绝，也会被视为水位内失败。生产 Writer 隔离存储观察：初始无写入的范围查询
等待期间，同范围超预算样本被拒绝，原查询和后续查询均 false；原查询应不受后来输入影响。
现分别记录接收序号和拒绝观察序号，等待起点捕获二者；同范围失败仍按最早证据合并，
容量溢出的保守失败也按两类水位归属。没有改持久格式、IPC 或范围查询合同。

修复后生产 Writer 隔离 Store 实际输出：late-rejection 的 initial=true/later=false；初始已接收
批次写入失败 initial/later 均 false；无关 Thread 和审查用途失败不污染普通范围（均 true）。
取消等待返回 cancelled，实际写入仍完成、后续水位 true。10001 个不同失败范围超过容量后，
更早已固定水位仍 true，之后的查询保守 false；未扩大内存上限。
已核对 Bootstrap 完成卡消费者：审查用途未持久化降级 usage.coverage，普通 task/session 未持久化
不返回伪完整汇总；U13 的父子 Turn 范围/循环去重证据继续适用，相关查询实现没有变化。

私有 IPC→Writer→SQLite 的独立报告已收集并与当前改动核对；未观察真实平台完成卡或用户指标库。

**L10-F2，已修复。** Relay 指标 IPC 将 responseFormat/status/deliveryStatus/traffic.label
用 String 强转检查枚举，却保留原值入队。Sol 用真实私有 IPC 同时发 status=["completed"] 的畸形
Relay、正常 Relay、正常 Provider，得到 accepted/accepted/ok；同一批三条 SQLite 全回滚、rows=0，
正常 Provider 轮次水位 false，报参数 10 无法绑定。现四字段均先要求 string，再检查枚举，
在跨进程输入边界拒绝畸形值，不通过弱化 SQLite 或拆分重试掩盖坏批次。

修复后 Sol 分别经生产 RelayMetricsServer 和 RelayMetricsComposition 发送四种数组，全部
rejected/invalid_sample，receiveCount=0、authorizationCount=0；正常及重复 UUID 均 accepted，
真实 SQLite 仅 1 行、outputTokens=1、后台错误为空。主代理核对了四处差异、组合根投影与
Owned/shared diagnostics 同类校验，后者本已严格检查类型，不传播无必要改动。

**其他独立实际证据。** 使用当前 Writer、真实私有 IPC/SQLite 和固定材料快照执行生产鉴权：

- 暂缓 SQLite 提交时，全部接收确认已返回但库仍 0 行；放行后为 3 行。accepted/ok 只证明入队。
- Provider 帧伪造 provider/source/callerId/relayRequestId/recordedAtMs，落库仍为组合根 provider p、
  source=owned、Relay 身份列为空和实际记录时间。Relay envelope/sample Provider 不一致拒绝；
  当前上限 3 的未来代次 4 拒绝，当前旧代次 2 和 retired 旧代次 1 按已签发历史结算合同受理，
  未注册 Provider 返回 unknown_provider。
- 多个独立连接重复同 UUID，后发样本把输出 Token 7 改为 999，提交前后重复均受理但最终仍只有
  首条 outputTokens=7，不覆盖或重复计数。唯一索引及 ON CONFLICT DO NOTHING 语义未变。

**限制与交付。** 材料 Reader 用进程内固定快照，未读取用户配置；未实机观察 Windows ACL、
材料 Worker 读取或真实平台完成卡。Worker 致命故障/退出归属续由 L12 核对，不以当前隔离 Store
失败观察代替真实 Worker 故障。自有接收器、Writer、SQLite 和临时目录均已关闭清理。本项同步
两模块说明，仅提交两处修复及证据；下一项 L11。

### L11 配置投影、保存与热加载

**状态：已审查（附证据限制）。** L10 已提交 `d819adc1`，类型、边界、Lint、文档和构建门禁通过（12.2 秒）。
本项复用 U05/U08/U09 未变化的默认投影、管理错误和浏览器回读证据，补配置运行消费、修订竞争、
无效/部分配置与重载失败边界；只操作任务临时配置，不启停真实 Gateway。

**L11-F1 配置应用失败后继续使用不一致授权。** 生产组件图按顺序更新 Workspace、渠道允许名单及
飞书绑定，最后才替换配置快照；飞书 `retainActors` 的 SQLite 事务可能失败。隔离生产组件图、渠道
模块与 AccessPolicy，在 Telegram 允许用户由 `[1]` 增至 `[1,2]`、飞书名单变化且绑定写入抛错时，
实际得到 `afterFailureAllowed2=true/snapshotStillOld=true`；随后恢复旧配置，分类器返回
`changes=[]`，用户 2 仍被允许。外层原来将所有错误视为读取失败并继续服务，导致恢复原文也无法撤销残留授权。
修复在唯一配置应用调用点区分读取/校验与组件应用失败：前者继续保留旧配置，后者以故障状态进入
既有 Gateway 关闭链，不确认配置事件、不重试应用，也不主动停止共享 App Server。

主代理直接加载修复后的生产生命周期入口，配置读取/应用和监听端口隔离，Gateway 所有权及账户/Thread
私有 IPC 使用任务临时目录。注入应用失败后实际退出码为 1，顺序为 `apply-failed→not-ready→
provider-stop→network-stop→application-stop`；未调用保留旧配置的失败通知。日志仅暴露 Error 类型，
没有注入异常正文。真实 App Server 与平台未启动，退出时临时目录已清理；这证明该入口的故障分流与
关闭调用，不代表实际渠道停机、跨 OS 服务管理器重启或磁盘故障已观察。

**消费者与分类。** 正常隔离生产组件图取得新 Workspace `two`，Telegram 用户 2 可访问，飞书旧 Actor
被拒绝、新 Actor 可访问，绑定清理一次、配置快照已替换、通知为 `reloaded`。删除 Workspace、收窄
Telegram 名单及变更时区均分类为 `restart`；二进制路径及代理变化为 `reinstall`。沿唯一调用点核对
重载串行化、停止后不应用、配置事件投递后才确认；事件投递失败保留待办，不视为配置回滚。

**保存与回读。** Sol 独立审查读取→默认投影→预览→修订保存→回读及 Doctor，主代理复核锁内原文
比较与前端门禁。相对 `2af6a83e`，U05/U08/U09 相关生产输入未变化，保留原浏览器证据及其限制。
本轮新增隔离观察：

- 最小无渠道 TOML 两次读取均得到 900 秒、15 分钟、365 天/1000000 行和 WebUI `127.0.0.1:8787`，
  字节及 revision 不变。真实本机 HTTP 预览 idle=16 返回 200 且不落盘；同修订并发保存 idle=16 与
  logging=warn 返回 200 confirmed/409 stale-revision，回读为 16/info，保留注释且不补可选表。
- 两个独立进程同修订保存 idle=23/logging=warn，一方成功，另一方 stale-revision，最终 15/warn。
  预检查后插入竞争编辑，底层锁内原文比较拒绝覆盖；Codex `.env` 旧快照写入也拒绝并保留竞争值。
- 未知表、version=2、缺 codex 表分别返回 500 internal_error，原文不变且响应不包含敏感哨兵。
  Doctor 隔离配置故意缺渠道及可执行程序，exit=1，8 成功/4 失败/19 提示；仍检查默认 Workspace，
  配置及 `.env` 的字节、mode、mtime 不变。该退出码不是验收失败，也不表示真实环境健康。
- useApi 在 refetch/卸载取消旧请求，已取消结果不覆盖；管理读回要求新快照对象、读取结束且无错，
  revision 相同也可解除门禁。此次过期响应结论来自源码，浏览器保存与 503 后回读复用 U05。

**限制与交付。** 未重跑浏览器竞态、全部设置组合及交互菜单，没有实际用户配置重载、平台连接或
Windows/macOS 运行观察。全部任务子进程和 HTTP/IPC 已结束，临时材料已清理；没有新增测试、脚本或
文档。仅修复生命周期失败分流，同步 Bootstrap 职责与用户排障说明；提交门禁另行记录，下一项 L12。

### L12 服务、Worker、Socket 与嵌套退出

**状态：已审查（附证据限制）。** L11 已提交 `d80b9a29`，类型、边界、Lint、文档及构建门禁通过（11.7 秒）。
本项按启动→就绪→取消/故障→嵌套清理→退出核对资源所有权，复用 U07/U11/U16/U17 未变化证据；
重点补初始化中停止、清理失败、超时与私有路径替换，不启动用户服务、不终止共享 App Server。

**已确认问题与修复。**

- L12-F1：GatewayOwner 的 `runtime` 为链接时仍可发布就绪并 chmod 目标；共享 PrivateIpcServer
  改用既有 `ensurePrivateDirectorySync`，校验最终目录类型/属主后收紧。安装入口同类用法留到 L14
  沿其实际合同复核。正常目录可继续创建，Delivery 自有更严格预检保留。
- L12-F2：Windows 独占创建描述文件后，写入/ACL 失败发生在登记身份之前，清理会遗漏本次文件。
  现从已打开描述符登记身份，区分未发布清理和已发布的 token/身份保护；Windows 实机观察尚缺。
- L12-F3：Supervisor 端点清理异常跳过在途操作等待，且永久缓存失败关闭结果。已改为 finally 排空，
  失败后允许重试清理但仍拒绝重新启动。真实私有 IPC 发起阻塞 ensure，将任务目录暂替普通文件：
  关闭仍等待工作，解除后返回 ENOTDIR；恢复目录后取得新的关闭 Promise 并成功删除端点，start 仍拒绝。
- L12-F4：Unix WebSocket 健康检查成功即返回，仅发 close，慢对端留下默认约 30 秒握手。已改为
  terminate 并等待 close；本机私有 UDS 的不响应关闭对端，修复后 `healthy=true` 且连接数为 0。
- L12-F5：生产 Desktop Host 的自有 Unix 组中，组长收到 TERM 退出后，忽略 TERM 的后代仍存活，
  `terminateChildProcess` 却返回成功。Sol 复现后由 Astra 独立评估组长寿命、PGID 重用及僵尸语义，
  主代理采用仍存活的 Host 在原生退出时强杀自身组的方案；原生状态先记日志，Host 可见状态改为 SIGKILL。
  终止器只对存活组长发信号，随后有界只读确认组消失；组长已退出不向旧 PGID 发信号，成功缓存，
  未确认保留实例及其 Proxy 归属。普通非组子进程行为不改。此方案不终止主动脱离专属组的进程。
- L12-F6：Windows 健康探测 Proxy 关闭失败后原来只 unref，没有同进程重试归属。现保留失败对象，
  下次探测先等待清理，失败不再新建，exit 才解除登记；短命 CLI 的最终退出仍依赖既有原生 Job。
  此边界为源码确认，尚无 Windows helper 关闭失败的实机观察。

**已有补充观察。** Gateway 生产 start/stop 配合隔离组件，在初始化等待时停止，start 拒绝“正在停止”，
后续 prepareStore 没有执行；重复 stop 返回同一 Promise。Surface 关闭注入异常后仍执行指标、输出、
Client、Binding 与计划存储清理，最终报告资源未完全关闭；正常场景关闭成功。此处是生产生命周期
与隔离端口控制流观察，不是实际 SDK/服务停机。U07 单读取 Worker 实现自 `8b5d8414` 未变，复用其
真实 Worker 初始化取消、重复 close、资源归零证据，Windows 嵌套 ACL 退出仍只具源码证据。

**路径与进程实测。** 主代理对修复后的 GatewayOwner 观察链接父目录被拒绝，链接目标保持 0755、
没有新文件；正常 Owner 可就绪且关闭无残留。Sol 的私有 JSON 交换得到 usable，Socket 为 0600；
公开端点被替换为普通文件后关闭保留 replacement，启动中立即关闭拒绝启动且没有残留，陈旧 Socket
可以恢复，普通文件与任意 rendezvous 目标被拒绝。无响应请求返回 unconfirmed，预取消连接返回
AbortError；这些未变化路径的证据保留，不推断真实平台成功。

主代理直接调用修复后的生产 Desktop Host 入口，以自有 Node 代替原生 Codex，在 Linux 上观察：
普通停止、忽略 TERM 的后代、原生进程自然 exit=0，均得到组清理 confirmed，相关 `/proc` 进程消失；
Host 为 SIGKILL，日志保留原生 SIGTERM 或 exit=0，重复终止完成。另先外部强杀任务 Host、保留原生
子进程，终止器明确返回“进程组清理未确认”，没有追杀旧 PGID，原生子进程仍在；随后任务按已捕获
PID 和启动身份清理，确认进程消失。该观察覆盖 Unix 算法，不等于 macOS 签名 Host 实机验收。

**所有权关联覆盖。** Sol 分别审查私有路径/IPC 和监管/进程退出，主代理整合后核对最终实现。
Supervisor 正常停止等待在途 ensure、拒绝第二项排队工作、关闭后拒绝 start；服务失败清理以终止
确认结果保留 children/Provider/Proxy，不能只看组长 exit。Gateway 只关闭 Client 连接，Windows
临时 Transport 只拥有自己的 proxy；共享 App Server 的进程归独立服务所有。Windows 服务 Host
发送停止后仍观察 exit，原生 helper 通过父进程句柄、创建时间和 Job 保有最终回收职责；这些属于
源码覆盖，没有运行 Windows 服务。两类 IPC 的 EOF/换行、预算和错误分类差异继续保留。

**限制与交付。** Windows 描述文件写入/ACL 失败清理和健康 Proxy 失败后重试均未实机观察；
Windows helper/Job、macOS 签名 Host、三平台正式服务管理器停机均未运行。组存在性观察遇到僵尸或
组号复用会保守报未确认，不将其当作可以追杀的证据。所有任务自有进程、HTTP/UDS 与临时目录已清理；
没有测试、探针脚本、新依赖或真实用户资源操作。修复及证据同步 Runtime 职责文档，下一项 L13。

### L13 渠道输入、附件、聚合与输出

**状态：已审查（附证据限制），下述三处问题已修复。** 源码基线为 L12 提交 `f1d83559`；
其类型、边界、Lint、文档及构建门禁通过（8.96 秒），本项门禁随独立提交执行。
按本页必查子范围分别核对图片账户/后端/路由、音视频目标/取消/提交未知、send-image spool/绑定/
投递，以及三渠道输入聚合与有界输出；复用 U03/U10/U11/U12 及 L03/L07 未变化证据。只运行隔离
生产入口与本机替代端，不发送真实渠道消息，不将旧平台矩阵升级为本轮实机通过。

已确认并修复图片引用准备遗漏提交守卫：原 `startTurn/steerTurn` 仅在最终 Turn 前复核，
读取 Thread 后撤权仍会完成创建、PUT 与上传确认。现有本地守卫贯穿这三个出站步骤及每次
PUT/确认重试，守卫异常保留原对象和分类，不进入上传重试。主代理核对 Application 普通输入、
Provider 转发及最终 Turn 守卫；未改变 RPC 字段、图片聚合或音视频的提交未知资源合同。
直接调用生产 Client 与图片上传器、隔离 RPC/HTTP 端口：正常 start/steer 各为三次上传请求和
一次携带 `file_A` 的 Turn；创建前撤权为零写入，创建后/PUT 后撤权分别只留一/两次既有写入，
PUT 503 或确认 retry 后撤权均无下一次请求、无 Turn，原 `authorization.changed` 错误对象保留。

另确认 `SurfaceManager.sendChannelImage` 绕过活动实例集合：隔离 Surface 启动失败后仍调用
发送端口一次。补齐运行状态检查后相同入口为零调用并明确报尚未就绪；正常启动仍调用一次。
该入口继续使用原有 Outbox 顺序和关闭机制，不将入队当成平台送达。

**send-image 恢复修复。** Sol 实际复现发送成功后同时阻塞 done/failed 归档，旧实现重启后
发送次数从 1 增至 2：防重发状态只保留在内存。现在发送前同目录原子领取 `.json → .sending`，
遗留领取记录仅归档失败，不再次发送；领取失败为零发送。manifest 字段仍为 version 1，图片仍
放在 pending，不修改 StateStore。主代理核对 CLI 发布顺序、Thread 绑定解析、三个 Surface
Outbox、私有文件工具与最终差异；同时限制同编号 png/jpg，避免归档处理错拿领取记录或其他请求。
恢复计划在修改前明确：停 Gateway 后备份整个 spool 并保留权限；无法归档时保留文件和领取状态，
修复文件系统后只重试归档。回退旧版前隔离 `.sending` 及同编号图片，人工核对，不能改回 json
自动重发；详细步骤已更新 [渠道图片发送](channel-image.md#恢复与回退)，本轮没有操作真实 spool。

隔离真实 `initializeUserData → SqliteBindingStore → submitChannelImage → ChannelImageSpool`
到本机接收端：68 字节 PNG 原样到达一次，pending 清空、done 两文件、version 1 和 0600 保持。
相同归档阻塞下修复后重启仍只有一次发送，遗留 `.sending` 转 failed 并标记结果未知；同进程
解除归档阻塞后也只重试归档。未绑定、跨编号引用均零发送，其他请求图片保留原位；发送失败和
ACK 丢失各调用一次，重启不再调用。领取目标被目录占用时零发送且原请求保留，运行中新增图片
符号链接被拒，外部文件不变。异主文件实测受容器 chown EINVAL 阻断，仅完成 UID 检查源码覆盖。
本机制不承诺断电磁盘持久性或平台恰好一次；领取后发送前退出也保守按未知处理，不能谎称送达。

**音视频已查边界。** Sol 从三渠道 Adapter、共享媒体存储、Application 捕获目标和模型能力
检查追至 Turn 提交与视频 MCP 消费；主代理核对 `prepareAttachmentSubmission`、一次性提交、
目标复核与 `mayHaveSubmitted` 的相关调用，没有确认新缺陷。隔离微信生产 Adapter → AES 解密
→ VideoStore → Application → 本机视频 Client：一次 Turn、一个保留文件，上传端收到 24 字节，
分析请求收到 2654 字节并返回占位分析；撤权、Workspace 改变、stop 均零 Turn/零保留文件，
ACK 丢失则单次调用并保留文件。三渠道音频入口均得到 44 字节 WAV；真实模型选择服务的隔离
目录无 audio 能力时返回 `model.input.audio.unsupported` 且未提交，目录加入能力后单次 localAudio
提交。坏签名、声明超限、坏 AES key 分别受控拒绝；飞书视频去重后 discard 副本仍留原文件，
关闭后迟到流被销毁。24 字节视频和 44 字节音频仅为容器头材料，不证明解码或模型推理。

**有界事件观察。** 生产 EventBus 的一个消费者阻塞时，另一消费者仍收到 1/2/3；慢消费者的
同键等待快照 2 被 3 替换。共享四条硬预算耗尽后仅触发一次 overflow，释放阻塞后慢端为
1/3/4、快端为 1/2/3/4，drain 与 requireDrained close 完成；没有将拒收的关键事件描述为已送达。
U03 文本附件尾段、U11 共享关闭和微信 Surface、U12 背压实现相对 `42718512` 无改动，复用原观察；
U10 聚合器仅增加 L03 的 Actor 透传，当前入口再次观察同批次不同 Actor 分离、序号 2/1 输入按
1/2 合并、flush a 只提交 a、close 排空 b、关闭后输入明确拒绝。图片子链隔离观察还覆盖非图片
与声明超限均无暂存残留、图片和说明单次聚合、下载期间撤权后零 Turn；账户变化或取消发生于
PUT 后均无确认/Turn，后端 Origin 错配零上传，第三方 Provider 保留内联输入且不调用官方上传。

**范围限制。** `/stop` 当前取消已登记的音视频准备和 Client 图片准备；不将尚未开始处理的
全部平台事件或 Surface 图片下载扩大为新的取消合同。真实三平台收发、真实 App Server 图片/
音频请求、视频解码推理、平台限流及长期自然过期未观察，原渠道矩阵的缺口继续保留。
Windows ACL、macOS 原生文件系统本项未运行。所有任务自有本机端口和临时材料已清理；没有新增
测试、脚本、文档或依赖。下一项按原顺序为 L19。

### L19 会话归档、指标维护、转储与诊断

**状态：已审查（附证据限制），下述确认问题已修复。** L13 已提交 `22faa5fa`，类型、版本、边界、Lint、文档及构建门禁通过
（13.0 秒）。本项分别追踪会话官方归档与回读、指标维护的停止/备份/锁、转储精确删除范围和
诊断导出边界；复用 L01/L05/L10/L12 未变化证据，只使用临时库、文件和替代服务端口。

**转储已确认问题与修复。** manifest 的未知 `path` 字段原可覆盖扫描目录，生产 cleanup 在隔离
材料上实际删掉了 traffic 外的任务自有目录、反而留下原 session。现严格读取四个既有字段，
拒绝未知字段，目录归属只由扫描路径决定；不迁移、改写或删除被拒材料。另实际观察 payload
符号链接泄出目录外占位正文，现 manifest、索引、trace 与 payload 共用普通文件打开/身份复核，
拒绝链接、非普通文件及替换；manifest 上限 1 MiB，JSONL 单行上限 16 MiB，避免畸形行无限积累。
没有改变 V2 写入格式或正文展示语义。

停止检查等待期间新增 session，旧实现会把未预览对象一起删除；现复核原预览范围及目录/manifest
身份，变化则整次拒绝，逐项删除前再复核，取消/变化时保留尚未处理对象。此处不引入指标备份事务，
仍按官方文档的显式永久删除合同操作。隔离生产入口观察：路径覆盖拒绝且原 session 保留；
payload 链接拒绝且外部文件不变；16 MiB＋1 无换行 trace 明确报读取上限；新增批次时两目录都
保留。正常 describe/summarize 返回原正文和 total=1；重新预览后清理两批次成功，外部文件仍在。
再经真实 `TrafficDumpStorage` 写出 V2：生产 CLI `traffic --exchange 1` exit=0，显示 hello 与
完成状态、stderr 为空；本机 HTTP 生产路由列表/详情均 200，详情正文与写入一致，错误 session
返回 404 `traffic_session_not_found`，没有回退其他批次。此处 HTTP 复用真实路由，管理鉴权仍复用
L01 未变化证据；没有启动用户 WebUI 或调用真实模型。任务 Writer/HTTP/CLI 和临时材料均已清理。

还确认转储停止预检只读 Relay 服务状态，App Server 仅凭监管/Socket 缺失判定停止，可能放过
服务启动尚未发布端点的阶段。现同时要求两类受管服务处于明确停止状态，并保留原 IPC/Socket
检查。生产停止检查函数配合隔离状态端口：App Server activating、端点缺失时，修复前 accepted，
修复后明确拒绝；两类服务均 inactive 且端点缺失时通过。未实际启停任何用户服务。

**会话归档。** Sol 核对 CLI/菜单 → 预览 → 全组保护 → 确认复核 → archive → 权威双状态回读
与缓存清理，主代理定点复核执行和核验段，没有确认新缺陷。锁定 Codex `83086188` 的父归档可
部分完成派生后代，本地 confirmed/partial/unconfirmed 与非零退出一致；后代查询不按父 cwd
截断，跨实例已加载状态分别检查。真实 Client/JSON-RPC/SQLite 配合隔离 Transport 观察：正常及
已移除 Provider 历史均只发一次父归档、确认父子并清除对应缓存；活动、未知、固定、跨 Workspace、
后台绑定、多实例分散加载、循环 Turn 游标均零归档；确认后变更或 Gateway 启动均拒绝。
部分归档只清父缓存，回读失败保留全部缓存；请求报错但权威回读已归档按回读结算、不重试；发出后
取消仍完成核验再返回取消。Schema 99 绑定库在零连接时拒绝且 SHA-256 不变。隔离真实顶层 CLI
非交互 `cleanup sessions 3 --confirm` exit=1 并要求交互确认。首次 CLI 观察遗漏隔离配置，启动器
尝试收紧默认配置权限被沙箱 EROFS 拒绝，未改文件或连接 Thread；随后已以隔离材料完成观察。

**指标维护修复。** Sol 完成维护/导出及 HTTP 消费链，主代理核对最终差异与共享校验/服务适配器。
原 reset 对 Schema 999 实际返回 changed 并移走库；现锁前/锁内均完整校验，未知版本与当前
Schema 31 缺表均拒绝，SHA-256 不变且无锁/备份副产物。原 prune 将空服务状态当停止，reset/
cleanup 则有 Windows 恒 false、macOS 任意查询失败当停止的分叉；现三操作复用跨平台适配器及
明确停止状态白名单，隔离未知状态时全部拒绝且库不变，不兼容状态的 CLI 处理建议同步修正。

reset 原先 rename 后才保护备份权限，隔离权限端口失败时实际导致当前库路径消失。修改前明确
数据计划：保持 Schema、备份命名和 Writer 锁，独占复制 → 私有保护 → 删除当前库；复制或保护
失败保留原库，已生成备份保留供检查且重试不覆盖，删除失败保留两份，不自动恢复或启动 Writer。
回退仍在停写后人工从原格式备份恢复，没有迁移。修复后相同权限失败保留原库且哈希不变；正常
reset 备份哈希相同/0600，后续生产 Writer 重建 Schema 31/0 行，既有同名备份与原库不被覆盖。
三操作 Writer 锁竞争均 `METRICS_DATABASE_LOCKED` 且原库不变；prune 精确删除 retired 两行、
保留 RETIRED，cleanup 删除过期一行、剩两行并 VACUUM，备份均 0600。HTTP reset 预览后新增
记录再确认得到 409 `management.confirmation-invalid`；新预览进入 202 Runner/真实 CLI 后因
未知服务状态失败，auditStatus=recorded、库不变。

**导出观察。** 只读快照/Worker/输出实现未改：首 64 KiB 回调暂停 40ms 期间仅一次写入；期间
新增第 201 行，当前导出记录/聚合仍为 200，后续 CLI 为 201。阻塞输出取消约 2ms 返回
`metrics_export_cancelled`；两任务占用时第三返回 busy，取消后释放。真实 CLI JSON/CSV/Markdown
均得到 0600 文件，进度仅 stderr；不兼容库退出 1、stdout 空、失败输出文件清除。HTTP 无 Bearer
为 401，普通/版本帧 JSON 均 200、记录/聚合均为 3，帧类型 1/2，非法 range 为 400。转储版本
99 被拒且原字节不变，`../` payload 引用拒绝，删除前取消保留原 session。

**限制与交付。** 本项不操作真实用户库、Thread、平台或服务。会话归档使用隔离 RPC，不代表真实
官方服务归档；Windows/macOS 服务、ACL/文件系统、真实浏览器下载，以及导出 64 MiB/120 秒
极限未运行，后两项完成源码预算核对。未将静态门禁当作功能证据。所有自有 Worker、子进程、
监听、SQLite 与临时材料已收尾，没有新测试/脚本/文档/依赖；本项独立提交后继续 L14。

### L14 安装更新、激活回退与工程门禁

**状态：已审查（附证据限制）。** L19 已提交 `aec1adee`，类型、版本、边界、Lint、文档及构建门禁通过
（8.74 秒）。本项沿候选/构建/预检/替换/激活恢复及检查器/Hook/CI 两条链完成审查。两个 Sol
分别负责更新事务与工程门禁，主代理核对最终差异、共享接口，并完成打包和服务安装边界观察。
复用 U14/U15 及 L12 未变化证据；以下修复重新核对其受影响边界，不操作用户全局安装或正式服务。

**首装与更新事务。** 原首装 finally 无条件删除失败时的正式 checkout：隔离真实 Shell 入口在全局
替换已发生、来源记录失败时 exit=1 且源码消失；克隆失败时也会删除期间出现的其他目录。现只清理
自有 staging，源码移入正式目录后保留并提示在该目录重试 `npm run install:global`。移动前以
lstat 拒绝已有目标，再 rename，避免 mv/Move-Item 把源码嵌套进竞争目录。修复后对应失败保留
源码或 other-owner，正常隔离流程 exit=0。此恢复调整不迁移用户数据：失败保留来源供修复，
不自动回滚已替换的全局包；需要回退时从保留的所选源码重新安装并核对版本，之后才恢复服务。
同用户在检查与 rename 之间的极窄竞争窗口未宣称为跨进程原子独占保证。

Shell 安装根目录原先直接 chmod，现先校验真实目录及属主，链接目标 0755 在拒绝后保持原状。
Windows 对应复用共享私有目录保护；源码发现全新克隆未生成 DLL 就调用 ACL helper，首装会卡在
保护阶段。现明确要求有效 ignore-scripts=false，先调用既有无依赖原生生成器，再保护目录和完整
构建；true/未知设置提前拒绝。双安装器同步 Codex CLI 时显式 include=optional，与本地安装及
更新合同一致；Windows 修复仅完成源码核对，没有原生执行证据。

生产更新器在临时 Git 材料与现有注入端口下：构建/数据库预检失败均零停服且原源码不变；第二次
rename 失败恢复原路径并进入服务恢复；双 rename 失败保留 pre-update 并报告 restore-failed；
全局刷新失败保留备份且不启动服务；激活失败保留备份并报告 services failed；同版本新 commit
正常更新 changed=true 且清理备份。源码来源实际写读 managed/prefix 一致，污染 GIT_DIR 不会
重定向仓库操作，版本 2 或链接来源拒绝。以上没有执行真实全局替换或服务控制。

**只读预检与产物。** 原 requireUserConfig 在校验前修改权限：临时 version=999 配置拒绝后从
0644 变成 0600。现显式只读选项复用类型/属主/平台权限校验，不执行 chmod/ACL 修复；安装预检、
状态库检查、缓存定位及就绪查询均改用该模式，启动/写入默认行为保留。有效临时配置完成配置及
数据库预检且未生成数据库；版本 999、权限 0644 分别拒绝，内容哈希和权限不变；Schema 999
状态库拒绝且库哈希、0640 权限、配置及旁文件状态不变。首次隔离观察遗漏已有配置环境变量，
对默认配置的 chmod 被沙箱 EROFS 拒绝、未修改内容；随后显式覆盖配置路径完成全部观察。

源码构建与 --prepared 原先接受符号链接产物；两者现要求入口为实际普通文件。主代理隔离调用
真实 install-global-source 入口，仅替换外部安装端口：旧链接入口实际到达 pack/install，修复后
exit=1、外部调用为 0；正常普通文件 exit=0，只执行系统依赖检查、pack 与全局安装端口，不重新
构建或安装源码依赖。source-build 的 ignore=true/false 分别为 5/6 阶段，只有 false 安装 Hook；
未知设置零阶段拒绝，预先取消保留原取消错误。没有安装依赖或新增脚本。

**服务定义与打包。** 补齐 L12 延后边界：service-install-context 原 mkdir+secure 会跟随已存在
运行目录链接并把目标 0755 改为 0700；现复用 ensurePrivateDirectorySync，拒绝时目标仍 0755。
真实 writeServiceDefinitions 在隔离配置/XDG 目录写出四个 systemd 文件，均 0600，无未替换
占位符，runtime 为 0700；这仅是定义落盘，不是服务启动证据。prepare-package 在显式禁用脚本时
实际 exit=0、无输出；npm pack --dry-run --ignore-scripts 成功列出 4436 个文件，包含 CLI、
Gateway/WebUI 产物、Runtime 与服务模板，没有 upstream、Git 或 node_modules；.codex 仅包含
package.json 明确分发的 channel-image 技能两文件。未生成全局安装、修改 Hook 或调用服务管理器。

**工程门禁修复与观察。** Windows CI 原同一步 PowerShell 的 build 失败可被后续 check 成功掩盖，
现完整类型/边界检查与构建分为独立步骤。局部门禁原只识别两个 WebUI 共享来源，现按 TypeScript
配置与 AST 追踪共享声明、实际加载的 .mjs 及传递导入，纯类型导入区别处理；依赖无法确定时拒绝。
生产计划对 model-catalog、model-template-prompts、request-timing 声明、elapsed-duration、
config-activation-result 和 provider-model-additions 声明均选择 WebUI；纯类型对应 .mjs 和
无关 check-docs 不额外选择，Markdown 只选文档。字典检查器自身变更也会执行字典检查。

边界检查原正则漏掉合法的带注释/模板字面值动态导入，改用现有 TypeScript AST；文档检查改用
git ls-files -z，防中文/换行路径被引用后漏查。对真实入口作内存端口注入，越界导入实际 exit=1，
中文路径断链实际 exit=1；类型检查返回 37 时 verify 也返回 37，未进入 noCheck 构建。源码核对
真实索引 NUL 快照、Hook 失败传播、协议精确版本与生成树比较/失败清理、版本门禁及 CI 触发。
未改变既有依赖允许表；AST 不推导非字面值动态导入，仍须代码审查。定向 Lint、边界、77 个文档
检查及 diff 格式检查通过；完整提交门禁由本项提交 Hook 执行，结果与行为证据分开报告。

**限制与收尾。** 实际环境 Node 24.21.0 / npm 11.19.0，没有 CI 锁定 Node 22.22.0，未下载或
冒充该版本验证。Windows/macOS 原生安装、ACL、服务管理器、正式远端 CI 与真实全局替换均未运行；
这些观察仍待对应环境，不能由 Linux 隔离路径或模板落盘代替。自有进程、连接、临时 Git/数据材料
均收尾；没有新增测试、文档、脚本或依赖。L12 私有目录安装端、L19 共用状态库只读定位因本项变更
重新核对，其他已记录输入未变的证据继续复用。

## 本轮验收结论

L01–L19 已按既定顺序完成源码关联审查、确认问题修复及逐项证据记录；状态均为已审查（附证据
限制），不代表所有真实平台或操作系统均已验收通过。各项未观察边界保留在原条目，后续补证按
对应边界开展，不重建清单或重复审查未变化实现。逐项提交不等于推送前完整分支复核；本轮记录
不宣称远端 PR、CI、合并或部署已完成。
