# 全项目链路验证与修复清单

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

状态：进行中。L03-F1/F2 已在 `6032c7a1` 提交；L03-F3 的命令身份与 Queue 子链已在 `ee685e50` 提交，模型和会话生命周期子链已修复，
其他命令链尚待修复与验收，不能视为整项通过。
基线 `15e3322b`。主代理检查 Registry、Router、Application、Client 与热加载分类；
Sol 子代理只读检查三个 Surface 到 Application 的输入授权，并负责限定四个 Surface 文件的授权传递修复。

| 发现 | 触发与影响 | 修复或剩余工作 |
| --- | --- | --- |
| L03-F1 失效工作区静默回退 | 保存的 Workspace ID 已移除，`Router.workspace` 自动改选默认目录，后续请求改变执行范围 | 改为 `workspace.missing` 且不改原选择；列表只读显示保存的 ID，显式选择有效项后恢复 |
| L03-F2 普通输入授权丢失 | 聚合回调丢弃 Actor；下载、锁等待或 Provider/图片准备期间撤权，旧请求仍可提交 | 批次保留 Actor，三个渠道五处普通提交传实时授权；Application 固定 Workspace 并在锁内复核，Thread 新建/恢复及 Turn start/steer 保留最终守卫；迟到新订阅清理，不写回失效绑定 |
| L03-F3 命令授权未贯穿 | 部分 Telegram 按钮未传 Actor，通用命令即使传 Actor 也未统一约束后续等待、RPC 和本地偏好写入 | 入口与按钮强制传 Actor，组合根注入实时策略；Queue、模型选择、恢复/接管及生命周期贯穿后续提交守卫；其他命令与异步交互仍待处理 |

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
命令入口和结果出口的检查不等于其他命令内部已安全；下一步仍在 L03 处理其他写命令与只读结果的
等待边界，再核对异步交互输入，完成后才进入 L02。

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

当前子链没有真实 Provider、平台账号或跨操作系统执行；其他 Turn/Goal/扩展命令与异步交互
仍属 L03 待验收内容。不能据此宣称整项授权已通过。

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

**剩余命令清单。** 独立 Sol 只读追踪后确认以下仍需修复与观察，不能由已完成子链推定通过：

- Hooks/Schedule/重置券和异步交互的独立授权合同，以及普通只读查询内部的分页/Provider 等待。

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

**已核对和未观察。** 三渠道 Policy 复核 Surface 与账号；飞书错误 App ID、微信错误接收账号有拒绝入口。
Workspace 删除/改目录及 Telegram/微信名单缩减要求重启，不能声称它们可任意热替换；飞书名单支持热撤权。
当前记录没有真实平台撤权或 Windows/macOS 观察。L03-F3、输入关联异步交互及最终整项验收未完成，
后续仍留在 L03，不跳到 L02。
