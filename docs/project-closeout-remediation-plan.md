# 收尾问题复审与修复流程

本页是后续修复的执行流程，问题原始证据集中在[收尾审查记录](project-closeout-review.md)，全文阅读范围见[逐文件清单](project-closeout-file-inventory.csv)。本页不复制原始审查报告，也不替代现行用户与模块合同。

## 基线与授权范围

- 分支：`review/closeout-remediation-plan`。
- 审查材料提交：`c6d2688251397c1b65fccc376cedc1a5931fd5cc`，`docs: 记录逐文件收尾审查与开放问题`。
- 业务源码基线：`08c97a60d4dd5b973066e90bec8f097c42f6dade`；以上提交只包含审查 Markdown、CSV 与索引。
- 初始任务：一次本地提交、Astra 独立分批复审、关联确认及修复流程整理，已完成。随后用户授权按批实施全链路修复，每批修复后由独立 Astra 关联复审、解决发现后才本地提交；未授权推送、发布或部署。
- 复审范围：原记录 R01–R45 的证据和相关调用链，不宣称又逐行重审全部 1,146 个文件。三个 `gpt-6-astra / high` 子代理独立形成判断，主代理负责交叉依赖、证据纠正及整合；第四个新的 Astra/high 子代理完成流程整合复核。

## 复审分工与结论口径

| 批次 | 范围 | 重点 |
| --- | --- | --- |
| A1 授权与渠道 | R01、R02、R16、R21、R34、R36、R38–R42、R44、R45 | 审批完整信息、撤权、排队取消、回执、身份与正文完整性 |
| A2 运行时与配置 | R03、R04、R06、R10–R13、R17、R18、R20、R23–R26、R30、R35、R37 | 迟到响应、提交结果、目录依赖、文件/进程生命周期、网络出口 |
| A3 数据与交付 | R05、R07–R09、R14、R15、R19、R22、R27–R29、R31–R33、R43 | 敏感信息、清理边界、协议终态、探测模型、产物基线及文档 |
| A4 流程整合复核 | 45 项映射、25 个包及跨包执行合同 | 不重复全量源码审查；核对责任、依赖、恢复和验收，并针对字节语义、产物基线定向读源码 |

初始三批复审完成时：45 项均保留，3 项 P1、32 项 P2、10 项 P3；没有因反例整体撤销的问题，当时没有实施修复。以下“确认”表示源码链成立，不表示已经复现事故；“收窄”表示保留缺口并明确原影响边界；“补充”表示发现必须共同修复的遗漏路径。原编号、原始证据与原业务基线不变。

## 逐项复审与修复归属

原始文件位置、触发条件与影响见[原审查记录](project-closeout-review.md)的同编号。下面记录初始复审判定和执行时必须保留的条件；B 编号对应下一节的修复包。实施状态以后面的批次记录和原编号处理记录为准。

| 编号 | 等级 | 复审判定及关键边界 | 修复包 |
| --- | --- | --- | --- |
| R01 | P1 | 确认：飞书展开的完整命令审批仍截断；共同层完整性门禁与渠道保真一起修，不能只提高上限。 | B01 |
| R02 | P1 | 收窄确认：匿名 HTTP 缺 Host 门禁；浏览器 DNS 重绑定泄露未实测，须满足同源端口、重解析及本地网络准入条件。 | B02 |
| R03 | P2 | 确认：迟到 start/review/计划任务响应可复活 Core 活动状态；同时防止旧响应覆盖新 Turn。计划 Run 协调器可收敛，不能称永久 running。 | B10 |
| R04 | P2 | 确认：非字符串被折为空导致误清除；代理批量字段省略必须继续保留，身份编辑仍遵守成组合同。 | B06 |
| R05 | P2 | 收窄确认：普通 ProviderProxy 原生 JSON/SSE/WS 自由错误入库；独立 Relay 在组合层强制 errorMessage:null，Chat 固定错误也是反例。 | B18 |
| R06 | P2 | 确认：unknown/okOverridden 转成 none 误报未写入；同时修改结果声明和上层转交，不只是删提示。 | B06 |
| R07 | P2 | 确认：自动清理缺根/目标/manifest 身份复核；显式 cleanup 已有保护，同步维护入口未找到生产调用方。 | B05 |
| R08 | P2 | 确认：自动 manifest 比 reader 宽松；已有普通文件、NOFOLLOW 和 16 KiB 限制，不是完全无校验。严格拒绝未知字段、空身份、非有限数。 | B05 |
| R09 | P2 | 确认：两种非流式工具探测未核对实际模型；原生 Responses webSearch 已校验，Chat webSearch 不产生 supported。 | B13 |
| R10 | P2 | 确认：连接计划同值仍写入；需比较模式、真实凭据、URL 与副作用，不能用随机凭据引用判断变化。 | B07 |
| R11 | P2 | 收窄确认：独立 Provider 定向目录操作被主目录失败阻断；已绑定普通纯文本未必经过目录，官方克隆目录仍有真实依赖。 | B11 |
| R12 | P2 | 确认：同步 open 可先阻塞在 FIFO；异步私有 reader 已有 NONBLOCK。主 Codex 配置允许链接的独立合同须保留。 | B03 |
| R13 | P2 | 确认：Windows writer helper 同步阻塞且无总期限；内部 WaitForExit 不能覆盖 helper 全过程，其他 OS 不属于同一触发路径。 | B15 |
| R14 | P3 | 确认文档漂移：异常分组实际按最近发生、再按次数，最多 20 组，WebUI 取前 5；不为旧描述修改 SQL。 | B25 |
| R15 | P2 | 确认：finish 先 ended 再校验，失败漏内容完成；初审历史影响仅源码推导，B14 已补 Linux 自有官方 App Server 修前/修后分页历史读回。非法工具仍须整组拒绝。 | B14 |
| R16 | P2 | 确认：Linux 凭据既有资源缺只读安全验证；目录链接可重定向，叶链接 unlink 不删除其目标，不能混写。 | B04 |
| R17 | P2 | 确认并扩全入口：除 shared environment/Doctor，还包括 service-install-context、Desktop command/proxy；服务定义会固化误选路径。 | B16 |
| R18 | P2 | 确认：Skill 删除确认不绑定内容修订；一次检查后 rm 或简单 rename 不能证明并发内容安全，恢复语义须先明确。 | B09 |
| R19 | P2 | 确认：proposal 未核对产物 base-commit；Draft、权限隔离、后续 CI 仍有效，不是自动发布漏洞。 | B24 |
| R20 | P2 | 确认：队列锁按年龄抢活 owner、按路径释放；现有 private-file-lock 也不能直接证明回收竞争安全。 | B08 |
| R21 | P3 | 确认：微信渠道 Doctor 调 get 会 chmod；CLI 已用 inspect。只读窄端口、实现、装配同时调整，不改变运行时 get 合同。 | B04 |
| R22 | P3 | 确认：Relay 服务卡未按 errorCode 翻译；后端已有固定错误，不称内部异常泄露。 | B25 |
| R23 | P2 | 确认：多个精确名称仍 fallback 唯一 ID 前缀，resume/unarchive 可能选错授权范围内目标；保留数字序号优先。 | B10 |
| R24 | P2 | 确认：IPv6 方括号传入连接 hostname；只对连接主机去括号，Host、WS URL authority 必须保留。连接效果未实测。 | B17 |
| R25 | P2 | 确认：自动 redirect 复用首次 dispatcher；跨源敏感头已有 Undici 保护，不能称已证凭据泄露。已有 error/manual 的消费者排除。 | B17 |
| R26 | P2 | 收窄确认：OCG 先全读再按字符判上限，非 2xx 不 cancel；固定可信服务，未观察 OOM，需按接收字节有界。 | B17 |
| R27 | P2 | 确认：service-status 漏 Basic 与多 Cookie；文件/journald 均到 recentError，不能反向依赖完整 WebUI route。 | B19 |
| R28 | P3 | 确认：HTTP 发送前 413、WS 非 OPEN 仍计 submitted；部分提交后失败仍应计时，不能用 0 代替未提交。 | B18 |
| R29 | P3 | 确认文档冲突：远程 Bearer 管理已支持，须连同 Origin/监听/转储回环特例整体对齐；不删除远程功能。 | B02 |
| R30 | P3 | 确认：terminal identity 探测缺总长 64；保存 schema 已挡住，服务安装捕获记录失败继续，不称安装阻塞。 | B06 |
| R31 | P3 | 确认：失败数 0 应留空；只改 cell 显示，保留数值 accessor、排序及服务端数据。 | B25 |
| R32 | P3 | 确认：两个 Spinner 英文界面仍中文可访问名；额度按钮不能直接隐藏唯一加载状态，不必给基础组件绑语言 Context。 | B25 |
| R33 | P3 | 确认文档漂移：Relay 不存在的目录入口/Hook 和旧耗时标记需删除；不恢复旧功能，保留真实模型管理等入口。 | B25 |
| R34 | P1 | 确认并补充协议合同：共同层丢参数，飞书二次裁剪；锁定上游提供 tool_params 与 display，须证明完整表示，不能从 message 猜参数。 | B01 |
| R35 | P2 | 确认：配置已提交、解锁失败后仍删新增事件；已有 committed 错误提供明确事实，不能按普通写失败补偿。 | B08 |
| R36 | P2 | 确认：Telegram 热撤权遗漏 delta/显式图片执行时守卫；最终持久正文与 snapshot 有保护，微信/飞书不能泛化。 | B20 |
| R37 | P2 | 确认：构造期同步 --version 无总期限；三系统共享。限时 kill 请求不等于子进程及后代已退出。 | B15 |
| R38 | P2 | 确认并补充接收次序：三端外层排队先于附件 scope；Telegram 同批 stop 前后输入必须区分，Thread 仍在前序排空后捕获。 | B21 |
| R39 | P2 | 确认：限定微信普通无 receipt 通知在 close 后擦掉 signal；不能泛化到已有 receipt/checkpoint 保护的其他链。 | B22 |
| R40 | P2 | 收窄确认：audio/text 两顺序结果不对称且接受后丢 text；未证明常规客户端生产此组合，按既有合同双向拒绝，不扩附文功能。 | B23 |
| R41 | P2 | 收窄确认：macOS 损坏非空 Keychain 当 missing；无错误 Token 被使用证据。抛固定错误即可进入现有显式 revoke 分支。 | B04 |
| R42 | P2 | 确认：飞书 setup 等待期间撤权仍可写配置/发布；守卫须贯穿 configure 内每个远端写入，不仅调用前一次检查。 | B20 |
| R43 | P3 | 确认文档漂移：Relay 后台初始化期间请求继续、跳过 capture；ready 后只采集新请求，不补录。 | B05 |
| R44 | P2 | 确认并扩范围：旧模型卡及 effort/fast 卡均未绑定状态快照；守卫延续至 Application 等待后的实际写入，文本命令合同不变。 | B12 |
| R45 | P2 | 确认：完整 TXT 用展示投影，丢图片说明/URL 后仍 complete；附件须来自原始 event.text，原文 UTF-8 超限保持 uncertain。 | B22 |

## 修复包、关联路径与实施顺序

B 编号是责任边界，不强制一包一提交。每包实施时核对原编号的全部调用链，不把下表列出的主要文件当作完整文件白名单。当前执行状态见文末批次记录，前面的逐项表保留复审时判定。

推荐分批：第一批 B01/B02 处理 P1；第二批 B03–B09、B18–B22 处理私有资源、事务、泄露和撤权/取消；第三批 B10–B17、B23/B24；B25 中独立文档和 UI 小修可穿插。风险优先级不是技术依赖；已有独立实施能力时不必等待整批完成。

| 包 | 编号 / 最小完整改动 | 主要 owner 与关联消费路径 | 前置条件或协调要求 |
| --- | --- | --- | --- |
| B01 审批完整预览 | R01/R34：共同层形成完整、无歧义表示及失败关闭门禁，渠道不得二次损失。 | approval/coordinator、codex-client/server-request-adapter、稳定交互类型、飞书 approval/input cards，三端 interaction；Approval/Surface README、协议支持映射。 | 先固定 tool_params/display 原名、标签、值的完整性与预算；存在矛盾/缺失且不可证明完整时拒绝，保留上游实际批准范围。 |
| B02 HTTP 匿名边界 | R02/R29：匿名 authority 与存在的 Origin 校验集中于共同入口；同步安全文档。 | scripts/webui-server、API/management/logs/traffic/SSE 与静态入口策略；docs/webui、management-interface-security。 | 合法回环、SSH 转发不同端口与远程 Bearer 分支分别定义，不信任 Forwarded，不新增第二套登录。 |
| B03 同步私有读取 | R12：非阻塞打开、同描述符类型/身份和有界读取；保留特定主配置链接合同。 | runtime/private-file 及声明、provider-file-access、settings snapshot/Relay material worker。 | 先约定 B04/B05 所需只读校验接口；不以 lstat 或外层 Worker 超时代替描述符保护与资源回收。 |
| B04 凭据与只读诊断 | R16/R21/R41：既有目录/密钥/密文读写删校验；Doctor 用 inspect；Keychain 损坏与 missing 分开。 | secure-credential-store、微信 credential/context/cursor/doctor 窄接口、飞书 oauth-token-store/oauth、surface-composition、CLI Doctor。 | 若复用 B03 原语，待该接口落定；平台私有能力独立检查。R21/R41 可独立完成，不必等 Linux 后端。 |
| B05 自动清理与说明 | R07/R08/R43：共享严格纯 manifest 校验，删除前重核身份；对齐 Relay 初始化说明。 | traffic-dump-retention、reader、storage/Relay/App Server 启动 owner；对照显式 cleanup；user-guide 与 Provider Proxy README。 | 与 B03/B04 协调基础安全接口，不要求凭据修复先完成。同步公开入口一起处理，保留读取预算及各 owner 标签归属。 |
| B06 配置输入与结果 | R04/R06/R30：明确字段类型、保存与激活结果、可保存 identity 完整约束。 | config-management、codex-defaults-setup 及声明、settings setup/management、activation notice、terminal-identity/gateway-config；CLI/WebUI/安装读取。 | 三个逻辑补丁可分别完成；与 B08 共用 gateway-config 时串行编辑，不产生逻辑依赖。 |
| B07 连接无变化事务 | R10：共享连接 plan 计算真实 willChange，确定变化后才分配凭据引用。 | custom-primary-provider-management、CLI/WebUI、CP Profile writer、primary-provider-config-transaction 及声明。 | no-op 仍复核 revision；不写备份/Profile/凭据/metadata/主配置。保留模式转换、移除顶层 URL 等真实副作用。 |
| B08 队列互斥与提交事实 | R20/R35：分别修 owner/回收/释放和 committed 后通知保留。 | config-event-queue、workspace-config、gateway-config、CLI结果与 config-lifecycle enqueue/ack 消费。 | 先约定锁和已提交结果合同；两个补丁可独立，R35 不必被锁实现重写阻塞。共享最终路径集成观察必做。 |
| B09 Skill 删除确认 | R18：确认覆盖目标、父身份和内容修订；避免过期确认永久销毁新内容。 | skill-setup 及声明、Setup 卸载和用户指南，关联安装保留旧树语义。 | 实施前明确隔离保留/恢复/人工清理语义和授权；单次 revision 检查或 rename 后立即 rm 不能作为完整方案。 |
| B10 Core 状态与会话选择 | R03/R23：Core 内处理迟到响应与终态；精确名称歧义立即拒绝。 | Core、conversation-service、scheduled-task-executor；conversation-session-query-service → resume/unarchive。 | 两个独立逻辑补丁，无需通用状态框架。R03 所有观察器成功/失败/取消均有界释放，不建第二份历史。 |
| B11 Provider 定向目录 | R11：目标独立目录不等待无关主目录；总览隔离失败。 | model-selection-service、provider-routing-client、媒体/新会话偏好消费。 | 保留官方克隆目录真实依赖、授权错误与能力未知语义；与 B12 同文件单 writer。 |
| B12 飞书选择快照 | R44：精确 Provider/model，模型/effort/fast 三卡内存限时一次性快照，写入前复核。 | command-center presentation/pending、feishu adapter、Application selectionScope/精确选择/偏好及默认值 writer。 | B11 与本包先约定定向目录和目标身份合同，非必须先实施 B11；与 B21 的 adapter 编辑串行。 |
| B13 探测实际模型 | R09：每次成功解析前检查模型，不匹配固定 inconclusive，禁止采用。 | custom-model-capability-probe、CLI/WebUI 采用门禁、reason 翻译/字典。 | 不推断别名，不加无必要持久字段；保留已有正确 webSearch 分支。 |
| B14 Chat 流终态 | R15：完成构造校验后才提交不可逆 ended，失败仍关闭已产生内容。 | chat-to-responses、chat bridge、锁定上游 completed Item/错误消费；转换器合同。 | 与 R03 不是同一状态 owner，无硬依赖。不得派发无效工具，不改 Codex 内部历史文件。 |
| B15 自有进程生命周期 | R13/R37：异步、可取消、有总预算且确认退出的 helper/版本检查。 | gateway-component-graph、thread-writer-lock 及声明、app/config-lifecycle 和已有 owned-process 能力。 | 共用 graph 一个 writer；Windows 诊断预算与 Gateway 启动预算独立。force 异步等待后重核绑定/PID/创建时间；辅助进程清理不得停止共享 App Server，保留用户显式 force 的既有持锁目标合同。 |
| B16 有效二进制选择 | R17：所有入口复用 executable 优先级，不覆盖合法环境选择。 | runtime-environment、Doctor、service-install-context、desktop-app-command/proxy；Init、Setup、remote、维护及服务定义消费。 | 建议先于 B15 的正常启动观察，非其代码前置。明确已有定义激活方式，不自动重装/重启服务；Windows 环境名大小写单独核对。 |
| B17 网络目的地与额度正文 | R24/R25/R26：分别区分 hostname/authority、逐端点 redirect 合同、有界字节读取与 cancel。 | app-server-service-runtime、proxy/chat/request-routing、proxy-fetch、微信/AccountQuery/OCG 消费，runtime quota reader。 | 三个独立补丁；先确定哪些端点允许跳转再接 OCG，不一律造通用跳转器。与 B18 共改 proxy.ts 串行。 |
| B18 指标安全与提交计时 | R05/R28：自由错误受控投影，真实提交时才记录时间及 bytes。 | metrics observer、proxy、IPC、provider-metrics composition、SQLite writer、详情/摘要/JSON/CSV。 | 两个逻辑补丁串行整合 proxy.ts；独立 Relay null 保留。不改变 schema，部分提交仍计时。 |
| B19 服务诊断投影 | R27：共享纯日志安全投影，先脱敏再压缩/截断。 | service-status、webui-logs-route、文件/journald、recentError消费。 | 可复用 B18 的合成秘密输入清单；日志保留脱敏诊断与指标禁止任意正文是不同合同，不强行共用宽松 sanitizer。 |
| B20 撤权执行边界 | R36/R42：TG流/图片实时守卫；飞书 setup 按 Actor 取消并逐写入守卫。 | surface-composition 热加载、TG streams/outbox/API/spool、飞书 application-setup/application-api。 | 两项可分补丁，共用热加载文件单 writer；撤权仅阻止后续调用，远端已写/结果未知分别报告。spool 保留消费时解析绑定合同。 |
| B21 附件接收与 stop | R38：授权/去重/容量准入后、第一次等待前登记取消身份与预算。 | TG lifecycle/bot、WX monitor/input/adapter、FS inbox/adapter、Application attachment scope。 | 保留接收次序，目标 Thread 在前序排空后 capture；释放所有拒绝/取消资源，mayHaveSubmitted 文件不可误删。 |
| B22 微信关闭与原文投递 | R39/R45：信号贯穿实际平台调用，完整 TXT 用原文，完成回执足以证明原文送达。 | weixin/outbox、共享 delivery queue/receipt、文件客户端与 delivery 合同。 | 一个 writer，先理取消再核对完整文件链；若需排空只用有限 drainOnClose，不能擦 signal。保留 snapshot/receipt 正确分支。 |
| B23 微信输入组合 | R40：对不支持的独立 text+audio 双向拒绝。 | inbound-message-parser、input/adapter 无效消息反馈及用户说明。 | 独立小包，不将附文合并进语音转写，不修改游标格式。 |
| B24 升级产物基线 | R19：应用前校验产物基线与 checkout，缺失/畸形/漂移失败关闭。 | 升级 workflow、report/base-commit 产物、workflow README、codex-cli-upgrade。 | 优先拒绝漂移重新生成，不自动 rebase 旧补丁；保留 Draft、最小权限和门禁，不触发远程发布。 |
| B25 UI 与独立文档 | R22/R31/R32/R14/R33：调用方翻译、零值显示、可访问名；按事实修正文档。 | Relay service card、turn-table、两 Spinner 调用、翻译映射；Observability README、WebUI 专题及用户说明。 | UI 三项与纯文档两项可独立；R29 属 B02、R43 属 B05，不重复分派。保留排序、真实管理入口及当前加载状态。 |

共同文件协调不等于业务依赖：`private-file`、`gateway-config`、`gateway-component-graph`、`model-selection-service`、`surface-composition`、`feishu/adapter`、`provider-proxy/proxy`、`weixin/outbox` 和用户指南分别保持单一写入者。接口变化后通知消费包定向复核；不要要求所有包等一个大重构完成。

实施中新发现的旁支另行排队，不混入原 45 项统计：

| 补充任务 | 当前证据与下一步 |
| --- | --- |
| Telegram effort 键盘目录快照 | B12 发现预存 selectEffort 返回未按 Provider filter 裁剪的目录，后续回调刷新目录可能使刚生成键盘过期；待独立复现并逐路径修复，随后独立 A 复审、单批提交。 |
| 显式相对 CLI 路径 | B16 独立 A 源码推导安装 cwd 与服务 cwd 可产生不同选择；待明确已支持的相对路径基准、复现及全入口修复，随后独立 A 复审、单批提交。当前绝对路径与环境覆盖证据不关闭此任务。 |
| 微信非成功响应正文清理 | B17 独立 A 确认 JSON/CDN 的既有非2xx分支未释放正文；redirect:error 的拒绝不经过该分支，本批未扩大缺口。待沿请求期限、错误映射和关闭链复现、修复，再独立 A 复审提交；不以正常响应或跳转观察关闭此任务。 |
| 自定义Socket目录的日志归属 | B19 独立A源码发现状态摘要固定读取dataDir/runtime，日志路由与安装器按codex.socket_path父目录选取；配置自定义Socket目录可能产生不同日志来源。待隔离复现、明确共享目录合同并修复复审，当前尚未运行观察，不在脱敏批次改变路径选择。 |

## 数据、失败恢复与回滚

| 范围 | 实施前明确的处理方案 |
| --- | --- |
| B03/B04 私有文件与凭据 | 保留格式、密钥、记录命名和支持的链接合同。异常既有资源只读拒绝且不 chmod、不重置、不重加密、不清理。用户旧权限修复或材料替换是另一个明确计划；Keychain 显式 revoke 复用现有授权删除分支。回退代码不恢复已撤销凭据。 |
| B05 自动清理 | V2 不迁移；未知/损坏对象不作为可删除项，相关校验失败不执行该删除并给固定诊断。实机启用前备份需要恢复的合法转储。已删除内容不能靠代码回退恢复；可丢弃目录验证不触碰真实转储。 |
| B07/B08 配置与通知 | 保留 immutable 凭据版本、origin、Profile/主配置快照及 uncertain-write 恢复；恢复前核当前 revision，禁止覆盖新写入。committed 后解锁失败保留配置和事件，只报告清理问题；不重复写。旧无 owner 锁保守拒绝，不自动删除队列。保持 schema v1、容量和至少一次通知语义。 |
| B09 Skill 卸载 | 方案需指定受保护隔离路径、实际旧树保留、并发写入边界、失败恢复不覆盖新目标、后续人工清理条件。此方案可能改变删除/恢复语义，不能由本次审查授权推断已批准执行；不自动清理旧安装备份。 |
| B10/B14 会话与终态 | 不迁移会话偏好，不重建平行历史。权威历史观察经隔离 App Server 的受支持接口，不读取/修补内部 session 文件。 |
| B13/B18 新采集结果 | 不自动重判已保存能力，不回填历史 metrics，不清理旧敏感文本；历史库处理需另有备份与授权。未提交计时和 bytes 保留 null，不能回写为 0。 |
| B20/B21/B22 授权、附件与投递 | 不撤销已发生的远端写，不自动反向恢复远端配置；区分已完成、未开始、结果未知。取消后仅清理确定未提交的自有附件。旧 uncertain 不擅自补发/删除，不重建已清除正文，不清空 journal。 |
| B15/B16 服务与进程 | 只回收自有资源；超时、发 kill、task-manager 状态不是退出证据。代码回退不终止共享实例、不自动重装服务；现有定义更新及激活按服务合同另执行。 |
| B24 工作流 | 回滚限于代码；不删除/重写已经创建的远程分支、Draft PR 或已发布标签。 |

其余包无计划中的存储格式迁移。没有格式变化不代表删除或恢复语义自动获得授权；实施时仍核对实际补丁是否保持以上边界。

## 后续行为观察清单

下表是修复完成后需要取得的证据，**本轮未执行**。使用现有入口和可丢弃材料，不新增测试/探针文件，不借观察权限访问用户凭据、发送渠道消息、消费额度或发布远端配置。环境不可用时记录具体未观察项，不伪造“通过”。

| 包 | Hack / 故障与竞争输入 | 至少一条真实入口与关闭所需结果 |
| --- | --- | --- |
| B01 | 超长 reason/危险命令尾部/额外权限；11+ 参数、长值尾部、控制字符、重复或冲突身份、UTF 边界、渠道二次裁剪。 | 正常命令与 MCP 审批实际可见内容和一次/session/always 响应一致；不完整时没有批准入口。无渠道授权保留未观察。 |
| B02 | 无 Token 非回环/畸形 Host、缺失/伪造 Origin，合法 IPv4/IPv6/localhost/转发端口及合法/非法 Bearer。 | 隔离浏览器正常访问可丢弃数据；DNS 重绑定另记浏览器版本、解析与网络准入，手工 HTTP 不能证明浏览器利用。 |
| B03/B04 | FIFO/特殊文件/链接、父目录与密钥替换、宽权限/异主；Keychain 不存在/坏 JSON/错身份/合法过期。 | 隔离设置读取、凭据存取及 Doctor 可用且检查不改权限；描述符/Worker 确实结束；macOS、Windows 分别观察，不以 Linux 替代。 |
| B05 | 根链接、扫描后根/目标/manifest 替换、额外字段、空身份、非有限数、活动及合法过期/超容量 session；覆盖按时间和按体积淘汰。 | App Server 启动和 Relay 自动维护分别仅删除合法候选；同步/异步入口与 CLI/WebUI reader 识别一致，未知对象保留。同步入口未找到生产调用方，不伪造真实入口观察；若无法直接观察则保留该项未补证。Relay 未 ready 跳 capture、ready 后新请求可采集；纯说明变更按内容检查。 |
| B06 | 有效 revision 下 false/数字/对象/数组拒绝且字节不变；合法清除/省略；unknown/overridden/no-op；超长 identity。 | 一入口保存另一入口读回；提示区分保存与激活；菜单预填/安装身份记录正常且不会保存非法候选。 |
| B07 | 两模式原值确认、模式变化、凭据变化、确认后竞争写、未知写结果。 | CLI/WebUI 同一资源操作：no-op 所有文件字节和凭据版本数不变，真实改变可读回，旧确认拒绝，恢复不覆盖新 revision。 |
| B08 | 活 owner 暂停超 30 秒、owner 退出、锁替换、并发 enqueue/ack；写前失败和写后解锁失败。 | 隔离 work add 到 Gateway reload 消费：配置/事件/返回事实一致，无误删锁或事件；通知发送需另有渠道授权，不许诺恰好一次。 |
| B09 | 正常/取消卸载、确认期间更新、父/目标替换、旧 descriptor 继续写。 | 可丢弃 Skill 的真实 Setup 选择到结果，新内容不被过期确认销毁，保留材料可访问且恢复不覆盖新树。 |
| B10 | completed 先于 start/review 响应、旧响应晚于新 Turn、失败/取消/解绑、计划任务；重复名与唯一前缀同时存在。 | 正常输入/stop/空闲操作状态正确；正常 resume/unarchive 成功，歧义明确拒绝；Core 和计划 Run 分别核对。 |
| B11/B12/B13 | 主目录失败、A/B 同 ID、旧模型/effort/fast 卡、点击后写前状态变化；探测实际模型 A/B/跨请求变换。 | 独立 Provider 目录/媒体/新会话仍按合同可用；旧卡不可改后来目标；CLI/WebUI 不采用错模型能力，合法采用可跨入口读回。 |
| B14 | 先正文/推理后无效 JSON/未知工具、其他失败及合法完成。 | SSE Item 成对完成，隔离 App Server 权威历史保留应保留内容，无非法工具派发；未观察历史则只登记源码与流证据。 |
| B15/B16 | 慢启动/不退出/异常输出、取消和 kill 失败；默认/显式路径/环境覆盖、PATH 缺失。 | 正常 Gateway 启动与 stop 不晚发 readiness，主循环可响应；Windows release 正常/force 保留身份复核；各 CLI/Setup/Doctor/remote/Desktop/安装入口选同一有效程序。渲染定义不等于实际安装。 |
| B17 | IPv6/域名/IPv4、port、CONNECT、WS/TLS/SNI；跨 NO_PROXY/协议跳转、循环/取消；超限 UTF-8 和非 2xx。 | Responses/Chat/WS 到正确端点且 Host 正确；需要跳转的入口逐跳正确选出口；OCG 有界降级且模型交付继续。无真实网络观察时明确保留。 |
| B18/B19 | 合成秘密 JSON/SSE/WS、Basic/Bearer/Proxy-Authorization、多 Cookie/Set-Cookie/引号；HTTP 发送前拒绝/部分提交超限，WS 非 OPEN/send 后失败。 | 隔离指标详情/摘要/导出及文件/journald 摘要无秘密，正常分类仍可用；timing/bytes/转储对齐未提交与部分提交语义。 |
| B20 | 已入队流、计时器、读图/重试等待撤权；setup 扫码/inspect/每次 patch/publish 间撤权。 | 仍授权 Actor 正常，撤权后无新特权调用，其他 Actor 不受影响；已发请求未知结果如实记录，远端写入另需授权。 |
| B21 | 三端慢前序、同批/跨批 stop 前后附件、首 Thread 未建、去重/容量拒绝、120 秒超时、取消后迟到下载。 | stop 取消已接收未提交附件，新输入仍到正确 Thread；scope/确定未提交文件释放，可能已提交文件保留。 |
| B22/B23 | 无 receipt 普通通知积压/多分片、关闭期限；长原文图片标记/CJK/代码、原文超 1 MB、文件或 checkpoint 未知；audio/text 两顺序。 | 正常微信通知及长答案可用，close 后无新调用；完整附件字节等于原始 event.text，充分回执后才清原文；不支持组合明确拒绝。 |
| B24 | 隔离产物同基线、漂移、缺失、畸形。 | 应用前 HEAD 与产物 base-commit 精确一致；应用后变更与该基线上的已验证补丁对应，不能将旧验证结论附到另一组合树。结果树不应与未应用补丁的基线树比较相等。无需触发远程发布，也不绕过 Draft/CI。 |
| B25 | 两语言服务错误与切换、0/非0及排序、两加载状态可访问名。 | UI 有效显示与读取；额度加载用隔离响应不消费真实额度。文档逐项对照当前入口、排序和索引，不为文档项运行无关服务。 |

## 已确认的跨包约束

- **审批参数表示（R01/R34）：**先固定共同层无损表示与可展示条件，再处理渠道渲染；只删除飞书裁剪或提高长度不足以覆盖 Coordinator 的参数丢失。上游同时提供参数与展示参数，明确采用的完整表示及降级条件，不从描述猜授权内容。
- **文件验证与权限设置（R07/R08/R12/R16）：**既有目录和文件的只读身份验证不同于新建资源的权限保护。Unix 的 `assertPrivateDirectoryAccess` 不提供完整类型/owner/mode 保证，`securePrivateDirectory` 会修改权限；不得把后者当作接受未知资源的验证。文件读取、自动清理和凭据后端共享基础能力但保持不同数据合同。
- **写入结果与锁（R06/R20/R35）：**已提交后的锁释放异常必须保留已保存状态和通知；事件锁解决的是互斥及所有权，不自动解决提交结果提示。其他锁工具只能借鉴，回收过程仍需核对自身竞争窗口，不能仅换函数名就宣布安全。
- **撤权与停止（R36/R38/R39/R42）：**当前授权、输入取消和服务关闭是不同作用域，分别携带到实际调用。Telegram 同批更新先处理紧急控制，修复附件代次时必须保留 stop 前后接收次序；不能整批共用一个取消代次。可靠回执的保护不证明普通通知也受保护。
- **菜单快照（R44）：**精确 Provider/模型身份与旧卡设置快照共同维护；effort/fast 同属需核对的模型设置卡。文本命令仍可按执行时当前状态解释，不能把卡片快照约束机械扩到文本命令。
- **终态与持久清除（R15/R45）：**协议流结束、内容归档、平台预览和完整内容确认是不同证据。修复不得提前宣告成功，也不得为保留内容伪造未验证工具项或擅自将未知发送改为重试。

## 每个修复包的执行步骤

1. **核对输入。**记录当前 HEAD、相关未提交变更及本包编号；源码若已变化，重新检查变更影响，不能直接套用旧行号。固定触发、业务不变量和需要保留的反例。
2. **确定完整改动边界。**沿入口、共享实现、调用者、保存和消费端逐一确认；把接口、默认值、错误、取消、配置及文档调整列在同一包内。跨包共用文件只能由一个实施者写入，先约定合同再分工。
3. **处理持久状态和恢复。**改变用户数据格式、选择、覆盖、删除或恢复语义前，明确备份、失败恢复和回滚方案；需要超出已有授权时再请求。普通代码回退不能覆盖后来用户修改、恢复已撤销权限或把未知写入重新执行。
4. **实施最小完整修复。**修根因及受影响路径，保留平台差异，不仅修改表面症状，也不夹带无关重构。写入已提交、响应未知、激活失败分别结算；取消不能等同于事务回滚。
5. **观察失败输入与真实入口。**使用已存在的生产入口和任务自有隔离数据挑战本包反例，再观察一条受影响用户路径从入口到可用结果。不得新增或维护测试、探针或 guard 脚本；不以测试/静态检查代替行为证据。渠道消息、付费请求、用户服务及用户数据操作须在其实际授权范围内进行。
6. **复核共享边界。**检查本包是否改变后续包前提，按实际数据流核对替代入口；对已有效且输入未变的证据复用，不机械重跑全仓检查。对高影响授权和数据删除修复独立核对允许、拒绝及异常分支。
7. **落证与关闭。**在原编号追加变更范围、修复提交、实际输入/输出、未观察边界及关联合同。代码已改但缺少必要观察时标“已修复待补证”；满足关闭条件再关闭。文档差异按内容、加载/消费路径及索引检查关闭，不要求无关运行操作。

提交、推送、合并和部署分别遵守实际授权。后续已获授权的本地批次提交，必须先完成实施、必要检查和独立 Astra 关联复审，并解决阻断发现；不把远程发布设为隐含步骤。

## 验证与交接

本次材料提交的正常 pre-commit 已运行类型/版本/模块边界、文档检查及 Gateway 构建，均通过。没有跳过 Hook；构建是静态交付状态，不是本轮问题修复证据。后续包选择受影响的现有检查，正常提交由 Hook 执行其范围检查。

A4 已完成流程整合复核：确认 45 项归属完整唯一，25 包无需要重划的责任冲突或错误硬依赖；提出的两处验收修订已纳入上表——B05 补齐时间/体积、同步/异步与 CLI/WebUI 识别矩阵，B24 区分应用前基线和应用后结果树。四个子代理均只读，未创建文件或遗留后台作业。主代理定向核对关键补充，并核对分支、提交范围、文档内容与索引。

流程整理阶段的文档检查实际通过：`npm run docs:check` 覆盖 84 个 Markdown 文件，索引与本地链接一致；45 个 R 编号无缺漏/重复，25 个 B 编号无重复且归属均可定位。当时业务源码和逐文件 CSV 未改变，流程文档、原报告复审补充和索引作为提交后的工作区交付保留。后续实施状态以下方批次记录为准。

跨平台私有文件、Windows helper、macOS Keychain、真实渠道、浏览器、App Server 及故障竞态的未观察边界继续保留，不以其他平台成功替代。最终交接应能从每个 R 编号定位到复审判定、负责修复包、依赖、调整路径及验收条件。

## 实施批次记录

### 第一批：B01 / B02（已提交 `1f5472d4`）

- 范围：R01/R34 审批完整性、R02 匿名 HTTP 边界、R29 当前安全文档。业务修复从 `c6d26882` 开始，先前流程与复审补充一并纳入本批交接。
- B01 实施：Client 以原始参数对象逐名逐值核对展示数组；共同层完整转义命令、权限、规则与 MCP 参数原名/标签/值，不截取前若干项。命令详情与 MCP 完整预览超 3000 UTF-8 字节安全拒绝；飞书完整内容改为无损展示，并在端口和渲染前防御性拒绝超限。
- 独立 A 的关联补充：普通命令原先未保留官方 cwd，相同相对路径命令不能核对执行目录；此遗漏与本包完整预览直接相关，已纳入 R01 修复。Client 按官方可选字符串合同解码并拒绝畸形值，稳定请求携带 cwd，共同层完整转义显示并计入预算；缺失明确提示未知，不猜 Workspace，不修改执行目录或协议响应。
- B01 本地观察：通过构建后的实际 Client 解码入口输入合成 RPC，漏尾部参数与值不一致均返回 `ok:false`、`action:cancel`，完整两项保留原名、标签和值；实际飞书渲染入口保留 1106 字符详情及末尾“末尾必须保留”，3100 字符工具详情和 12100 字符命令详情分别抛固定安全错误，未生成可批准卡片。未写测试或探针文件。
- B02 实施与实际入口：`scripts/webui-server.mjs` 路由分派前统一校验匿名真实回环、唯一合法 Host 和存在的同源 HTTP Origin；Token 分支保持原有 Bearer 及管理 Origin 合同。隔离生产服务实际返回静态 HTML（Codex WebUI）、favicon、time、health 均 200；合法 metrics SSE 为 200 后发 `unavailable`，隔离环境没有 Gateway IPC，不宣称实时指标已验收。
- B02 Hack：恶意 Host 在普通 API、management、logs、traffic、三类 SSE 和静态入口共 8 路均为 403 `host_invalid`；缺失/畸形 Host、IP 别名、尾点及伪造转发头均拒绝。跨主机/端口或 null/HTTPS 匿名 Origin 为 403 `origin_invalid`；匿名管理 POST 缺 Origin 为 403 `management.origin-invalid`。合法 localhost 大小写、不同于服务端口的同源 Host/Origin、默认端口 80/00080 和 IPv6 authority 均通过；未知管理路径返回 404，证明到达分派而非执行管理写入。
- B02 已认证反例：隔离 `0.0.0.0` 实例使用任务专用 Bearer，从非真实回环来源请求合法域名/HTTPS Origin，time 为 200、未知 management GET/POST 为 404；错 Origin 为 403、错/缺 Bearer 为 401、traffic 仍为 503 `traffic_unavailable`。没有真实配置或远端操作。任务服务已退出，端口连接拒绝且临时目录已删除。
- B02 限制：公共 `codexc webui` 在无配置隔离目录实际因 config.toml 不存在返回 ENOENT，随后用其生产服务脚本观察；未以此声称公共 CLI 完整启动已验证。IPv6 socket 实际 EADDRNOTAVAIL，只有 IPv6 authority 通过 IPv4 socket 的观察；真实 SSH 隧道、重复 Host（curl 合并，只有源码依据）及浏览器/DNS 重绑定未观察，playwright-cli 不可用且未安装。
- 独立复审：新的 Astra/high 读取本批完整实现 diff 和关联链，复核上述 cwd 修订后确认无剩余提交阻断。覆盖官方参数生产、Client、共同层、三渠道及决定回传，以及 HTTP 各分支和两份安全合同；没有把主代理观察冒充代理重复运行。
- 静态状态：`npm run check`（类型、版本、模块边界）、目标 ESLint、文档检查及最终 `npm run build` 均通过。一次直接 tsc 增量发射因已有 dist 声明被读作输入报 TS5055，已改回标准 build 成功，不修改门禁或业务代码来掩盖该调用方式问题。
- cwd 本地解码观察：字符串目录按原值保留，数字目录返回 `decline`，缺失目录保留 `null`。最终完整用户路径观察限制不因此解除。
- 未观察：真实渠道发卡/点击、App Server 完整审批往返、浏览器 DNS 重绑定；没有为本地观察发送渠道消息、访问用户凭据或产生模型费用。本地解码/渲染观察不能替代完整用户路径，相关行为保持待补证。
- 本地提交：`1f5472d45a0298f601cd3c2600956b09c28bc299`，正常 Hook 的类型/版本/边界、变更 Lint、文档与构建全部通过，总计 13.2 秒；提交后工作区 clean。没有推送。

### 第二批子批次：B03 / B04 / B05（已提交 `3b8e8b8e`）

原第二批按共享资源责任拆成可独立审查提交的子批次，本次只处理私有读取、凭据与诊断、自动转储维护，配置事务及渠道撤权等仍待后续子批次。输入为第一批提交 `1f5472d4`。

- B03：新增只读目录身份 inspect（旧 assert 语义不变），同步 reader 改 NONBLOCK、同 FD 有界读取、前后元数据和路径身份复核；主 Codex 配置保持已有 realpath 链接与共享读取 mode 合同，Provider wrapper 共用实现。settings snapshot 的预算前 marker 和 Relay materials 共用此边界，不改 Worker 生命周期。
- B03 实际 Linux 观察：FIFO 约 0.05 ms 拒绝，严格链接 ELOOP、特殊文件/无效预算/超限拒绝；0644 主配置链接和 0755 父目录可读且权限不变。目录 inspect 对宽权限、链接、文件和 FIFO 拒绝，预取消为 AbortError。40 次拒绝前后 FD 为 19→19；16 MiB 原子替换竞争被拒绝，替换 Worker exit=0，稳定后可读。
- B03 真实生产 Reader：正常 Provider settings 返回可见 ds-manual 与指纹，正常 Relay materials 返回禁用配置快照；FIFO marker 返回 snapshot-invalid（约 118 ms）、FIFO Gateway config 返回 materials invalid（约 101 ms），均等待 close/waitForExit 完成。最初 node --input-type 被 Worker 继承造成初始化失败，已确认退出并改正常 node -e 动态 import 后取得上述结果，不作为产品失败。异主样本 chown 被容器以 EINVAL 拒绝；Windows/macOS 未观察。
- B04：Linux 凭据通过新目录 inspect 和持有的目录 FD 进行操作，拒绝祖先/叶链接、异主/宽权限/多硬链接，不 chmod 既有材料；二进制读取同 FD 非阻塞有界。既有记录缺 key 不生成替代 key；删除只需路径/身份安全，不依赖解密。微信 Doctor 的窄接口和装配改为 inspect；macOS 非空损坏 Token 抛固定错误，沿现有显式 revoke 清理分支。
- B04 数据处理：保留既有 AES-GCM 格式、master.key、记录命名及系统 Keychain/DPAPI 分工，不迁移或重加密。只新建资源设置 0700/0600；损坏/未知材料保持原样，旧权限或密钥恢复不自动执行。Linux procfs 不可用则失败关闭。代码回退不能恢复显式撤销的凭据，不自动用旧备份覆盖新写入。
- B04 实际 Linux 观察：生产记录 Store 对任务自有材料 missing→null、set/get→disposable-one、update/get→disposable-two；0644 记录拒绝且仍为 644；目录链接拒绝 remove、链接目标文件仍在；有记录但缺 key 拒绝 set，key 未重建，显式 remove 后 get→null。生产 cursor Store 正常 inspect 读回游标，目录 0755 时拒绝并保持 755。临时材料已清理；真实渠道 Doctor/授权和 macOS Keychain 未观察。
- B05：共享 Runtime 纯 manifest 校验，reader、自动 sync/async retention 与经 reader 的显式 cleanup 保持严格识别；私有根/目标/manifest 在扫描、计数及删除前复核。未知版本或无 manifest 跳过，已识别位置的坏 manifest 中止维护并走既有固定故障/采集降级，不修改未知材料；R43 指南对齐后台初始化、未 ready 跳 capture、ready 后只采新请求。
- 本次新增 runtime manifest 两个源/声明文件属于本批关联审查范围；原 1,146 项 CSV 仍对应初始业务基线，不把旧清单冒充新文件的逐行证据。
- B05 隔离观察：同步/异步按时间和容量淘汰四条路径均保留 new、返回 1363 字节；活动 registry 在容量为零时保留活动 session、删除非活动 session，释放保护后返回 0。根链接、0755 根、扫描后根/session/manifest 替换均拒绝且保留材料；权限保持 755。额外字段、空身份、非有限时间在维护及共同 reader 均拒绝；V3 合法结构、无 manifest 未知目录跳过保留。维护的 16 KiB 与 reader 原有 1 MiB 预算分别保留；17 KiB 合法 manifest 维护拒绝、reader 接受。预取消入口为 AbortError。
- B05 生产消费观察：隔离 Relay owner 的 prepare 实际删除合法过期 session；begin 初始化期间返回 undefined 并记录 skipped，ready 后公开采集流程保存一条完整调用，实际 traffic CLI 显示 manual-model→manual-model、结果“完成”。显式 cleanup 实际预览一个 V2 session、1.4 KiB，未删除；损坏 manifest 令真实 Relay owner 报固定 capture failed、状态 failed、材料保留。三个 owner 均 closed，REPL exit=0，临时目录和独立 tsbuildinfo 已清理。
- B05 限制：未启动真实 App Server 或 WebUI HTTP，仅分别核对其启动调用链和共同 reader；同步公开入口无生产 caller，只观察函数本身；Windows/macOS ACL 未观察。路径式 rm 仍存在身份复核到执行间的竞争窗口，不能宣称跨进程原子条件删除。
- 第二批首次独立 Astra/high 复审：B03/B05 全链未发现其他确定阻断；B04 有两项必须修正。其一，读取 master.key 后至记录 rename 和最终返回没有延续密钥修订核对，读取记录与密钥也需最终快照复核；其二，/proc/self/fd 能力不可用时 ENOENT 可能被误作记录不存在，删除假成功。两项来自源码独立判断，未执行注入；本批保留未提交，修订后另开独立 A 定向复核，不能把首次审查描述为通过。
- B04 复审修订：文件读取返回内容及同 FD 修订；get 最终核对记录与密钥，set 在 rename 前及最终成功确认时核对密钥。目录能力先确认 proc 路径可达且对应持有目录；叶 ENOENT 必须复核目录能力，持有后配置路径消失转固定目录变化错误。初始尚未创建目录仍保持 missing 语义。
- B04 修订观察：用生产 TypeScript 微信凭据入口和任务自有材料完成保存→读取→删除→null，权限 0700/0600、密文不含输入明文。FS 调用边界注入读取 key 后删除/替换/chmod 均拒绝，旧记录字节保留且临时记录为零；rename 后 chmod 也在最终返回失败，不恢复覆盖并发材料。get 期间替换记录或放宽 key 权限均拒绝；proc 初始/叶访问期间失效、proc 指向其他目录，以及操作期间移动配置目录均固定失败、顶层无 ENOENT code；原材料保留。真正初始缺失仍返回 null。没有卸载系统 procfs；这些是调用边界模拟，不是宿主故障实测。自有目录、句柄均已清理。
- 修订后的完整 `npm run build` 与 `npm run check` 均 exit=0，包含 B05 最后补充的统计后身份复核；类型、版本和模块依赖检查通过。目标 ESLint、差异空白检查与 84 个 Markdown 的文档检查通过。以上为静态状态，真实渠道、macOS/Windows 观察限制仍保留。
- 第二个独立 Astra/high 定向复核发现上层补偿会绕过底层并发拒绝：飞书授权在 set 失败后无条件恢复旧 Token，微信 Setup 在 set 前标记 attempted 后同样补偿。已删除飞书失败后的恢复，并把失败提示改成授权未确认；微信仅在 set 确认成功后置位，存储拒绝不进入后续配置失败补偿。保留材料、不自动恢复或删除是本次失败恢复方案；无需迁移或备份重放。已成功写入后的停止／配置失败沿用既有补偿合同，仍不构成跨进程 CAS。
- 上层实际隔离观察：飞书控制器用模拟平台/存储端口推进到授权后 set 拒绝，原记录为空和非空两种输入均只 set 一次、remove 零次，提示授权未确认。首次合成授权链接不符合官方域名门禁而提前拒绝（set 零次），改为受支持域名后取得上述完整分支结果，未发网络或平台消息。微信生产 Setup 会话推进到 ready 后注入 set 拒绝，两种原记录情况均 set 一次、remove 零次、配置写入零次、文件字节不变、状态 failed；另观察 set 成功但配置提交前失败时仍 remove 一次，保留既有补偿。会话及自有临时目录已清理。
- 最终独立复核：第二个 Astra 已读取底层修订、飞书授权与刷新、微信 Setup/Bot/回复上下文、Doctor 关联链，确认本次修订无剩余提交阻断。它是第一次 B03/B05 全链审查之后的定向补充，不重复宣称全量复审。主代理核对全部报告和最终差异；R07/R08/R12/R16/R21/R41 标为已修复待补证，R43 文档已关闭，其他包继续开放。
- 本地提交：`3b8e8b8e30d1634e60618d9615a9fde90358550e`。正常 Hook 对最终包含上层补偿修订的源码重新执行类型/版本/模块边界、变更 Lint、文档与构建，全部通过，总计 14.2 秒；提交后工作区 clean，没有推送。

### 第三批子批次：B06（已提交 `d74d7663`）

- 输入为 `3b8e8b8e`，仅处理 R04 配置非法类型、R06 默认模型保存结果呈现和 R30 终端标识总长；不与 B07 连接事务或 B08 事件锁混写。
- 关联边界：共享管理 writer 同时供 CLI 和 WebUI 预览/执行使用；身份仍是成组替换，代理批量省略字段保持原值，默认模型的 value 必须显式提供。默认模型向导的实际入口是 Config/Init，WebUI 已保留 unknown/overridden，不改变其 API。终端可保存候选与用于 UA 的上游探测值保持区分。
- 数据处理：不改变配置格式、凭据或备份恢复。非法输入在写入前拒绝；显式清除和合法省略保持当前合同。未知保存结果仅修正提示，不重试、不回滚；超长终端候选不写入，不截断成另一个身份。
- R04 实际 HTTP 观察：隔离 `createWebuiServer` 的 `/api/v1/management/settings` GET 为 200；preview 中模型 false/17/对象/数组均 400 invalid-input，缺 value 为 400 required，clientIdentity=false、title=[]、代理字段=false 分别为 400 对应字段错误；直接 PATCH 非法模型也为 400。配置字节不变，独立 Codex Home 仍空、未生成备份。共同 CLI writer 保存合法身份后，HTTP GET 读回标题和 Manual/1；旧 revision 的 PATCH 为 409 stale-revision。服务已 close 并等待后台资源退出，临时材料删除。
- 观察命令纠正：首次人工请求误用 `/api/management`，得到 404/405，且身份未放入 value 对象而得到 invalid-boolean；这些是命令未遵循现有接口，不能算修复证据或产品缺陷。按源码确认路径和请求形状后取得上条输出，没有修改业务代码来迎合错误调用。
- 主代理审查提出的末尾换行正则疑问已由实际输入排除：当前 Node v24.22.1、无 m 标记的正则拒绝 64 个 a 加 LF、短值加 LF/CRLF。保留最小总长 lookahead 修复，不将未复现假设登记为缺陷或添加无必要规则。
- R04 共享入口补充：四种非法 JSON 类型在默认模型、代理、身份子字段和终端身份均拒绝且 TOML/.env 字节不变；身份顶层空对象仍合法成组清空，false/数字/数组/遗漏拒绝。null、空白清除，批量省略保留，no-op activation:none，旧 revision 拒绝均已观察。通过 createClient 注入目录模型保存后读回 available-model，连接/关闭各一次；不代表连接真实上游。
- R06 真实向导及管理层观察：`runCodexUserSettingsSetup → defaults → load/update` 仅在既有 createClient 边界注入。unknown 返回 updated/unknown/revision:null/ok/activationResult:null，overridden 返回 updated/confirmed/okOverridden/null，均无“未写入”提示；真正 no-op 零写且保留 none，正常保存 next-thread，取消零写，所有连接关闭。这是生产向导的结果呈现与管理层路径观察，真实 App Server 的异常返回尚未观测。
- R30 实际入口：13/64 字符候选通过，65 字符为 null、UA 原值保留；安装所用 apply 函数长候选不写、短候选保存 ShortTerm/1.2、已有身份跳过且字节不变。CLI 身份菜单长候选预填空、短候选正确，取消不写。首次隔离配置遗漏必需 codex 表而失败，补齐输入后完成，不作为产品缺陷。未安装或激活真实服务。
- 独立 Astra/high 已完成本批源码及关联消费审查，无剩余提交阻断；覆盖 CLI/Config/Init、WebUI、共享 writer/声明、结果转交、终端安装记录与 App Server 环境消费。主代理已核对完整报告及实际差异。类型/版本/模块边界、局部 ESLint、84 个 Markdown 文档和差异空白检查均通过；本地提交继续执行正常 Hook。R04/R06/R30 保留已修复待补证，未把隔离 HTTP 或注入端口等同于真实 TTY/浏览器、上游异常或各 OS 服务安装。
- 本地提交：`d74d7663320ea12606b762d13a157985376415d4`。正常 Hook 的类型/版本/模块边界、变更 Lint、文档及构建全部通过，总计 9.87 秒；提交后工作区 clean，没有推送。

### 第四批子批次：B07（已本地提交）

- 提交 `84758a595a6259a1c6f1bc019d8fb0307dd55378`；正常提交 Hook 通过类型、版本、模块边界、局部 ESLint、84 份 Markdown 检查及构建，耗时 9.81 秒。未推送。

- 输入为 `d74d7663`，仅处理 R10 自定义 Provider 连接原值保存。连接计划在完成模型默认值保护后计算真实变化，固定凭据版本仅为真实修改分配；CLI 与 WebUI 复用判断，并在管理锁内重新读取和核对预览 revision 后才返回 unchanged。
- 必须保留的真实副作用：模式转换、备份候选消费、顶层 URL 移除、认证表示规范化、Origin 或 URL 变化、协议 metadata 删除均参与变化判断。显式 replace 若旧凭据不可读取仍可修复；不能为了证明同值而强制读取旧凭据。连接保存不重写模型、独立思考默认值或搜索设置。
- 数据处理与验收：无变化不重写主配置/Profile/注册表/目录/metadata，不创建凭据版本或覆盖恢复快照；保留管理锁和 WebUI 审计，零写入只指这些业务材料，不绕过互斥或审计。真实写入沿用既有不可变凭据、备份及未知结果保留语义，不新增迁移或自动恢复。
- 实际 HTTP 观察：任务自有 switching/exclusive 两套目录分别通过生产 WebUI GET 读取、POST preview 和带确认令牌的 POST apply，均为 200；预览 willChange:false/activation:none，结果 unchanged/none/auditStatus:recorded。排除正常审计/锁后的业务文件摘要集一致，RPC 写入次数为零。使用实际共享连接管理、资源读取、确认、锁及审计，只在既有工厂边界提供隔离配置 Client，没有连接真实 App Server 或模型上游。两个 HTTP 服务均关闭，并等待通知/后台资源退出。
- 独立 Astra/high 已核对连接 final plan、固定最终 edits、切换 writer 字段、协议 metadata、三类副作用、延后凭据分配、锁内 revision 复核、原完整/modelOnly 分支、CLI 外层及 WebUI 消费，无剩余源码提交阻断。该代理未运行保存或静态检查，行为证据由实施者和主代理取得，仍需收齐本批全部结果后提交。
- 两模式隔离保存：preserve 与同 Key replace 均 willChange:false→unchanged/none，业务摘要集不变，凭据版本分别 0→0 / 1→1，RPC 写入零次。完整 CLI 向导原值确认返回 none，无“将写入／配置已写入／写入并启用”文案。名称真实修改后 runtime 读回 B07 changed，所选 active-model、独立 effort high、搜索 cached 和目录字节保留；旧预览均 stale-preview。
- Hack：名称、URL 路径、WS、实际 Key 和跨 Origin replace 均判真实变化；跨 Origin preserve 拒绝 api-key-replacement-required，夹带模型字段拒绝 invalid-operation。Chat metadata 只改 JSON 排版仍 unchanged 且原字节保留；Responses 已有 metadata 判真实变化并删除。固定模式认证、重试、目录路径、明文 Key、env_key 规范化及顶层 URL 移除均判变化。损坏旧凭据 preserve 拒绝，显式 replace 实际保存并由 runtime 读回对应 Key。
- 未知结果观察：注入写后响应丢失、随后回读可确认时返回 updated；写后全部回读失败时返回 save-unconfirmed，实际新配置、恢复备份与 5 个凭据版本均保留，没有重放写入。均为隔离配置 Client 的故障边界，不宣称真实上游故障已观测。
- 跨入口与转换：两模式实际 CLI 向导保存 CLI saved B07 后，生产 WebUI snapshot 读取同名与 active-model；CLI 提示 restart-all，switching 写 Profile（RPC 零次）、exclusive RPC 一次。取消后选择返回，业务摘要不变且写零次。switching→exclusive 实际 updated，主 Provider 为 cp-b07、切换列表清空；备份候选→switching 实际 updated，候选被消费、切换列表含 cp-b07。连接关闭 9/9。
- 观察输入纠正：首轮隔离模型不支持所设 high 被既有 loader 拒绝，修正材料后重做；一次取消提示注入始终重新选择 connection 导致正常菜单循环，已 Ctrl-C 结束该自有命令，再按 cancel→back 完成无写入观察。不作为产品故障，未修改产品以适配错误观察输入。全部任务临时目录（含 HTTP 审计）、连接与作业已清理。
- 主代理已收齐并核对实现及独立审查完整报告。现有类型/版本/模块边界、局部 ESLint、文档与差异空白检查通过。真实 App Server RPC、TTY/浏览器和三系统私有适配尚未实机观察，恢复入口对后来 revision 的保护未另行执行；R10 保留已修复待补证，不把接口注入或静态状态当作这些边界的验收。

### 第五批：B08（已本地提交）

- 提交 `a4e0c01d2f453a2e6d712022d70b4f78d2511d99`；正常 Hook 类型/版本/边界、局部 Lint、84 份文档、WebUI 构建/Lint、2,135 个双语键及占位符、Gateway 构建全部通过，总耗时 21.4 秒。未推送。

- 输入 `84758a59`，范围 R20/R35：Workspace 添加/移除 → 配置原子保存 → 持久事件 → reload 投递 → 精确 ID 确认。保持队列 schema v1、容量限制及至少一次通知语义。
- 数据处理方案：不改队列 JSON，不迁移或删除用户材料。锁改为私有目录和唯一 owner 标记；仅明确死亡的 owner 才允许按宽限规则回收，活进程不按年龄抢锁。旧空文件锁、无 owner、未知格式和无法确认身份的锁保留并拒绝操作。人工恢复前须确认没有队列使用者，备份队列与锁材料后检查；不得自动清除未知锁。回滚源码前同样须停止队列使用者并检查锁格式，不能让旧实现自动接管新锁。
- 结果合同：配置已提交后的解锁故障保留新事件；队列操作成功但解锁失败携带完成结果，由调用方分别报告配置锁、队列锁及实际事件清理失败，不重放已完成操作。真实渠道通知和 Windows/macOS 锁行为尚待观察，本批不授权发送消息或启停用户服务。
- Linux 实际 CLI 入口：对任务自有配置执行 `runWorkspaceCommand` 的 add/list/remove，在配置原子写入后的精确 lock unlink 注入 EACCES。add 仍报告已添加和锁清理告警，list 读回新增项目，持久事件保留 1 条；remove 仍报告注册已删除，队列 0 条，项目磁盘目录保留。写前 rename 故障则抛失败，配置原字节不变，只清除本次未生效事件，先前有效事件仍在。
- 队列完成结果观察：仅对任务队列 marker unlink 注入失败，入队完成后配置仍保存（2 个工作区、1 条事件），CLI 单独报告队列锁。实际 matching 对当前配置匹配 1 条，改名后 0 条；精确 ID ack 后解锁故障携带 void 完成结果，实际事件 0 条。移除注册时 discard 已完成但解锁失败，CLI 不误报旧事件清理未完成，实际剩 1 个默认工作区、0 条事件。
- 上述观察均为真实生产管理/队列函数与隔离数据，仅文件系统故障点注入；没有启动真实 Gateway 或发渠道消息。首次观察材料遗漏必需 codex 表被现有校验拒绝，补全隔离材料后重做，不修改产品适配错误材料。任务目录 `codexc-b08-cli-*` 与 `codexc-b08-queue-result-*` 均由各命令 finally 精确清理，无遗留进程。
- 独立 A 的关联发现已纳入：prune 后复用同一 Workspace ID，或 remove 与重新 add 竞争时，按 Workspace ID 清队列可能误删新通知。add 全操作改为同一配置锁事务，prune/remove 先取得旧事件 ID 快照，提交后只确认这些 ID；删除孤立的 discard 接口。上面的 discard 故障观察属于该调整前的中间版本，最终包装链需重新观察。
- 同步私有 writer 在 Windows rename 已完成但 staging rmdir 失败的分类一并修正为 `PrivateFileWriteCommittedError`，Gateway 保留已提交事实，Workspace、三渠道 Setup、WebUI 双语告警按保存后清理失败解释。Linux 中通过平台/ACL 边界替身执行实际同步 writer：rename 后清理失败得到 committed=true、目标内容为 after、临时目录保留；rename 前失败 committed=false、目标仍为 after。此为故障路径注入，不代表 Windows ACL 或 Windows 文件系统实机验证。自有 `codexc-b08-staging-h5Sn6k` 已清理。
- A 还确认共享配置旧文件锁存在双回收按路径误删继任锁的时序风险；本批将队列锁算法提取为窄公共同步目录锁，由两类 owner 保持自己的业务错误与重入语义。恢复/回滚方案同时涵盖 `config.toml.lock` 和事件队列锁：不兼容的旧 PID 文件锁不自动转换或删除；切换版本前须停止全部相关使用者、备份配置/队列/锁材料并核对，禁止新旧锁实现混跑。未知锁与崩溃留下的 ownerless/临时 owner 文件不自动扫除。
- 锁算法实际观察：子进程真实持锁暂停 35,007 ms，对手在 31,270 ms 时尝试操作，等待 2,005 ms 后拒绝抢锁，owner 恢复后事件落盘且锁清理。32 enqueue 与 1 ack 进程最终 36 条唯一事件，精确保留 seed-4..7 和全部 32 新事件，全部 ack 后为空。两回收者被强制读取同一旧 snapshot，第二者旧 marker unlink 得到 ENOENT 后没有 rmdir 继任空目录，两者最终退出且两事件保留。EPERM/EIO 不能证明死亡，均不回收；超过 256 KiB 拒绝且释放锁。
- 锁替换 Hack 曾复现 Linux 在外部删除空锁后立即复用 inode，已通过 Unix 删除期间持目录 FD 修正，同一注入重做后继任空目录保留。enqueue/read/ack 完成后换 owner 均保留继任 marker，并以完成错误保留 event/数组/void；操作失败仍优先抛原始错误。这些保证针对合作进程协议，不声明 Node 路径检查与 rmdir 能原子隔离任意同用户恶意文件系统替换。Windows/macOS 实机未观察。
- 抽取后主代理重新观察完整 CLI：add/list/remove 在配置 marker 释放失败时保存事实与事件分别为 2/1、1/0；写前 rename 失败保留配置字节和原有效事件。prune 复用 project ID 后旧事件被精确删除，新 cwd 的新事件保留；展示快照后改名使旧移除确认被拒绝。remove 精确 ack 完成后释放失败仍为 1 个默认 Workspace、0 事件，CLI 只报告队列锁收尾。自有 `codexc-b08-final-cli-BFbzdB` 已清理。
- 抽取后 Windows 分支注入链：在平台标识及 ACL 适配边界提供替身，实际同步 writer → Gateway writer → Workspace 管理 add 返回 cleanup=true、配置 2 项/事件 1 条；写前 rename 失败不改配置并保留有效事件；remove 返回 cleanup=true、配置 1 项/事件 0 条且目录保留。自有 `codexc-b08-staging-chain-LcGRrS` 已清理。这不替代 Windows 文件系统/ACL 实机证据。
- WebUI 实际翻译入口按 `gateway_config_saved_cleanup_failed` 分别返回中英文“已保存、后续清理失败、核对锁和临时目录、勿重复保存”提示，键结构不变。最新类型、版本、运行时边界、局部 ESLint、WebUI TypeScript 和 84 份文档检查通过；WebUI 类型命令登录 shell 输出 fnm multishell 只读路径告警，但编译本身退出 0，未更改系统配置。
- 公共锁最终接入观察：16 个配置事务进程把 900 累加为 916；32 个队列进程入队齐全，确认一半后保留 16。旧文档 CAS 被拒且当前值 1000 保留，重入返回 27。两包装对老化活 PID 均约 2,005 ms 拒绝，对明确 ESRCH 的过期 owner 回收成功；旧文件锁原样保留，配置父目录 755 不被收紧。释放 EACCES 时两业务错误保留完成结果，配置 writer 已提交分类正确；原操作错误优先，外层/重入/共享层 Promise 都拒绝且无未处理拒绝。所有自有进程与目录已收齐清理。
- 公共配置锁附带调用链已核对：Codex `.env`、自定义 Provider 注册表、Relay 管理、init 与 Desktop 都使用同步回调，保留各自 CAS、管理事务及业务结果；不把共享锁升级推断为这些入口全部重新实机验收。旧锁恢复/回滚约束也适用于这些资源的 `.lock`，须同时停止相关 CLI/WebUI writer 后再核对，不能只停 Workspace 操作。
- 独立 Astra/high 已完成最终全链路源码复核，原问题及同 ID 清理、Windows staging、共享配置锁三项关联补充均无剩余 P1/P2 提交阻断。主代理已核对两实施代理与独立 A 完整报告、最终差异和上述观察。真实 Gateway→渠道通知、Windows/macOS 实机及全部管理入口的运行行为仍未观察；R20/R35 保留已修复待补证。

### 第六批：B09（已提交 `c810b6a8`）

- 输入 `a4e0c01d`。用户后续已授权逐批修复；本批只修改 Skill 管理实现和文档，观察仅使用任务自有材料，不执行真实用户技能卸载。
- 本地提交 `c810b6a81f88d56a9812f86dc75cdaadc5e17f03`；正常 Hook 的类型、版本、模块边界、局部 lint、84 份 Markdown 与 Gateway 构建检查通过，耗时 9.84 秒。提交后工作区干净，未推送。
- 数据处理方案：卸载确认绑定绝对目标、父目录身份和完整树修订；执行前复核，过期确认拒绝。卸载从安装位置移走实际原树并保留在私有隔离目录，不递归永久删除；原 descriptor 后续写入仍留在该树。已按下述上游发现合同选择 skills 根目录之外的父目录作为保留位置。
- 失败恢复与回滚：移走后发现变化时保留实际树并输出位置，不覆盖任何后来出现的新目标；人工恢复须先停用相关写入者、核对安装目标不存在，再恢复保留材料，冲突时另选位置保留。无自动恢复覆盖、无自动扫除隔离目录或旧安装备份。后续永久清理仅在用户核对内容且无进程持有旧树后手工进行；取消卸载不产生写入。
- 已核对锁定上游 HEAD `83086188ae0614bd882818ff1aa23f3194962012`：`codex-rs/ext/skills/src/loader/host.rs` 对隐藏目录使用 Skip，但 `loader/environment.rs` 使用 Include，`loader/discovery.rs` 按该策略遍历。因此新卸载保留目录放在 skills 根目录之外的同盘父目录下，不依赖名称隐藏阻止加载。原安装旧树保留不在本批迁移/清理范围；不修改上游或运行其测试。
- 主代理完整 Setup 生产入口观察：仅将提示选择与 TTY 边界注入，并把技能根指向自有目录，`runSetup → 项目技能 → 卸载 → 返回 → 完成` 正常返回 completed。拒绝确认时目录条目/正文不变、sample 仍在已安装列表；确认卸载后列表为空、原目标不存在，完整原文仍在根目录外 `.codexc-skill-uninstall-sample-*/previous`，隔离权限 700，成功输出包含完整恢复路径。未连接真实终端或读取用户技能，`codexc-b09-setup-YMx5b1` 已精确清理。
- 实施者观察：确认期间更新内容、替换目标或父目录均拒绝且不移走新树；准备隔离目录后再更新内容/父目录同样拒绝，空隔离材料保留。rename 后旧 FD 写入使结果未确认，原文与 late write 都留在 previous；正常返回后旧 FD 写入也仍可从 previous 读回。rename 后新目标出现时原树和新目标都保留，没有恢复覆盖。EXDEV 注入不执行 copy/delete；根符号链接按 canonical root 选择保留父位置；目标不存在不创建目录。相邻安装正常发布新内容并保留旧 backup。所有任务材料/FD 已清理，无异步作业。
- 长恢复路径关联观察：实际 `runSetup(stayOnMenu)` 中注入 rename 后新目标，target 长 489、保留路径长 522；外层错误摘要会截断，但受控卸载错误在摘要前完整输出两路径，旧/新内容都保留，随后可正常退出。
- 独立 A 实测发现 230 字节技能名可安装、却因保留目录前缀拼接完整名称而 ENAMETOOLONG；主代理改用固定 `.codexc-skill-uninstall-` 前缀（替代前述中间版本的带名称前缀），重做生产 install/uninstall 后 installed=true、removed=true、列表空、原文保留。rename 实际完成后注入 EIO 的完整 Setup 观察显示“移动结果未确认”，完整路径可见、target 空、previous 原文存在，无“原目标未移走”错误声明、不重试移动。`codexc-b09-final-piQXcj` 已清理。
- 独立 Astra/high 最终检查确认、父/树修订、保留路径、后置失败、旧 descriptor、普通/JSONL 输出、列表及安装消费者和上游发现合同，无剩余 P1/P2 提交阻断。主代理已收齐实施与复审完整报告并核对最终差异；类型、版本、模块边界、局部 ESLint 与差异检查通过。真实终端、App Server 缓存加载和 Windows/macOS 文件系统/ACL 未观察；不声明能原子隔离任意同 UID 写者改名保留目录或祖先，记录路径仍须人工核对。R18 保留已修复待补证。

### 第七批：B10（已提交 `0b9d5ff1`）

- 输入 `c810b6a8`，范围 R03/R23。R03 的活动缓存只用于路由与展示，成功启动响应仍按提交事实结算，不推断续体执行时 Turn 仍运行；R23 保留现有列表排序、有效数字序号优先与后续权限检查，只修复精确匹配歧义被前缀绕过。
- 本地提交 `0b9d5ff1105a6c18af5a02ebb2d030d1c1cf427f`；正常 Hook 的类型、版本、模块边界、局部 lint、84 份 Markdown 与 Gateway 构建检查通过，耗时 14.1 秒。提交后工作区干净，未推送。
- 已核对锁定上游 `83086188ae0614bd882818ff1aa23f3194962012`：`turn_processor.rs` 662–734 在提交后继续等待并构造固定 inProgress 响应，Review 1451–1472 也先提交再响应；`thread_lifecycle.rs` 323–389 通知有序但与响应独立，不能假设响应先于完成。
- Core 复用请求作用域 `trackThreadActivity`，以 untouched/active/terminal/invalidated/stopped 有限状态替代完成 ID 集合。普通 start、inline Review、Scheduled 请求前登记、finally 释放；恢复、解绑补偿继续同一接口。完成 A 不清除活动 B，启动身份只附相同响应 Turn，合并前核对当前归属；断线、Thread 关闭/归档/删除永久使旧窗口失效。仅官方终态删除同 Turn 活动，单独 error 与 revert 不推断终态。未绑定时仍记录通知以支持后续合法绑定。
- 关联路径已核对：ensure、resume、新会话切换、原绑定补偿、空闲释放、后台释放与重连恢复；两个 Queue start 路径没有乐观 mark，保持原职责。Scheduled 的准确 `onTurnStarted` 回调与 Run 协调器提前终态、精确历史读取保持独立，普通成功提交仍消费模型/模式选择。无协议、持久格式、用户材料或权限变更。
- 主代理实际执行生产 `ConversationService.submit/review → Core → status` 及 `ConversationCommandService.execute(status)`，仅 Router/Turn/模型端口使用自有内存输入：completed 先于响应时 status 无活动 Turn；连续两条输入均新建、steer 调用 0、markApplied 为 2；Review 也不复活。第三次提交返回旧 turn-3 时状态保留 newer-turn；新轮次完成后命令 status 与 `hasActiveTurns=false` 一致，started 输出仅各真实注入启动一次。
- Core 受控事件顺序观察：断线/恢复后的旧窗口不激活；未绑定 started 后建立绑定可恢复 before-binding，未附旧身份；完成 A 保留 B，inProgress 不删除 B；无 owner 时 closed 清理活动且旧窗口不恢复；重复 stop、stop 后 restore、归属转移后的 restore 均无效，最终 observer 数量 0。第一次内联调用漏提供 `contextCompactionItemIdsForThread` 导致注入端口 TypeError，补齐后完整重做成功，未据此修改产品代码。
- Scheduled 生产 Executor/Core 注入观察：完成先于响应时 Executor 仍返回 running/准确 Thread 与 Turn，Core active=null，`onTurnStarted` 精确关联 run-task，observer=0；未知 transport 异常返回 uncertain，不新增 Run 关联，observer=0。该 running 是提交结果，不是宣称持久 Run 仍运行；本次未运行 Run Store 结算。
- R23 实际选择器观察：重复名称 abcd 与唯一 abcd-third ID 前缀同时存在时返回 `session.selector.ambiguous`；唯一名称、唯一前缀、有效序号和越界数字的精确名称仍成功；普通前缀歧义、ID/名称交叉精确冲突、缺失及空参数返回各自结构化错误。生产 Command → Service 的 resume/unarchive 歧义入口均 writeCount=0、binding=null；正常 unarchive unique 返回 thread.unarchived/abcd-third 并准确调用该目标端口。
- 首版实施者完整类型、版本、模块边界和三个实现文件局部 ESLint 通过；主代理已核对差异。上述内联观察不创建测试或 probe 文件，不连接真实 App Server、平台账号或用户 Thread；真实渠道消息、官方 RPC 竞态、计划 Run 持久结算及 Windows/macOS 运行仍未观察，保留验收限制。后续补偿修复和独立 A 最终结论见下述记录。
- 独立 A 新发现 P2：既有 releaseIdle/newSession/background release 与 resume 原绑定补偿，在 unsubscribe 前建立的窗口可能收到 `thread.closed` 后永久失效，吞掉随后新补偿 resume 返回的活动 B。锁定上游 `thread_lifecycle.rs` 575–617 支持最后订阅解除后卸载并广播 closed；其他客户端在重订阅前启动 B 时，恢复快照可能是唯一当前证据。修复方向是为每次新的权威恢复请求在请求前建立独立窗口、请求结束释放，保持旧窗口失效；同时核对 ensure 等待生命周期队列后的恢复。此前已通过的启动竞态观察仍有效，但不能据此宣称补偿链已完成验证。
- 主代理已复现该回归：生产 `ConversationService.newSession → SessionRouter → MemoryBindingStore/WorkspaceRegistry/Core`，仅 ThreadLifecyclePort 注入 unsubscribe 时 closed、随后权威 active B 而没有 started；补偿 resume 返回 B。修复前实际输出 `thread.takeover.changed`、原 binding=t 保留、Core active=null、权威 active=B、observer=0，确认是活动恢复缺失而非绑定丢失；同一调用链的修后观察如下。
- 恢复窗口修正后的主代理观察：同一生产链分别执行 newSession、releaseIdle、background release；unsubscribe/closed 后补偿 resume active B，三者均保留 binding=t、Core active=B=权威 B、observer=0，结果分别为 `thread.takeover.changed`、busy、false。再次用实际 Router/MemoryBindingStore 运行普通输入两次、命令 Review 和 status：requests=2、steer=0、markApplied=2，Review 完成不复活；旧响应晚于 B 时保留 B，最终完成无活动且 observer=0。此前仅 Router 端口注入的入口记录由这一更完整生产链补充，不等同真实 RPC 验收。
- 同合同扩展检查发现 transferBinding/fork 失败恢复与 unarchive 的原有活动快照交回缺口，一并接入新观察工厂，未改变成功绑定或权限合同；这三条不是本次引入的回归。主代理用生产 Command → Service → Router → MemoryBindingStore/Core 重做 resume/unarchive：重复名均拒绝且写入调用为空、无绑定；唯一名均精准选 abcd-third，resume 或 unarchive→resume 返回活动 B 后，绑定与 Core 活动均准确，observer=0。
- 最后补证：ensure 读取 notLoaded 期间注入 closed，后续新 resume 返回 active B，普通 submit 返回 `conversation.busy`、startTurn 调用 0、binding=t、Core=B、observer=0。fork 入口注入绑定提交失败，实际顺序 unsubscribe t/closed → resume t(active B) → cleanup unsubscribe forked；原错误返回，原 binding=t、Core=B、observer=0。未将这些受控边界观察描述为真实平台或官方 RPC 竞态。
- 独立 Astra/high 最终覆盖全部启动、恢复/补偿、解绑、断线、归属、输出与 Run 下游、Queue 和两个会话选择入口，确认原补偿窗口 P2 关闭，无剩余 P1/P2 提交阻断。主代理已读完整报告和最终 Router/Application/Bootstrap 差异；关键 blob 与复审一致：Router `0ba65ca4`、Service `de29d3b5`。补偿版完整类型、版本、模块边界与四文件局部 ESLint 通过；选择器局部 ESLint、84 份 Markdown 索引/链接与差异检查通过。接管失败、ensure 生命周期锁等待和批量重连的事件竞态完成源码关联复审，未单独运行；真实平台与跨 OS 限制仍保留。R03/R23 标记已修复待补证，未扩大为整体验收通过。

### 第八批：B11（已提交 `3d87ed66`）

- 输入 `0b9d5ff1`，范围 R11。独立 CP 的定向目录不应依赖无关主实例；官方兼容 CP 的克隆目录仍真实依赖主实例，不制造能力。总览隔离来源失败，不把故障当成未登录或自动切换 Provider；当前选择身份与本次查询覆盖范围分开，保留精确 Provider/model、已有 Thread 与 pending 权威设置。
- 只读关联分析覆盖目录装配、模型/effort/fast、图片/音频能力、未绑定偏好校验和新 Thread 提交，以及 CollaborationMode/Luna Reserve 的共享状态消费。确认不能仅跳过主查询：主默认模型缺失判断与 `models[0]` 回退会继续阻断浏览或误把浏览目标当作当前 Provider，影响目标默认设置读取及跨 Provider 新会话语义。目录失败的空能力列表也不能展示为“不支持加速”或继承 none 作为真实思考等级。
- 主代理修前实际观察：生产 ModelSelectionService + SessionRouter/MemoryBindingStore/WorkspaceRegistry，主目录端口注入失败、cp-task 目录准备健康结果；browseProvider(cp-task) 返回主故障，calls=[primary]，目标目录未调用，当前身份仍 main-model/openai。仅内存和受控端口，没有真实模型请求或用户数据写入。
- 实施计划同时保留等待后的授权守卫、收齐同批在途目录及最终缓存发布守卫；整体 Client 关闭须阻止后续查询与结果，单 Provider 关闭可显示目录不可用，不解析英文错误识别取消。无协议或持久格式变更；B12 飞书卡片快照另批处理。
- 已实施私有 ModelCatalog/confirmedProviders，只有成功目录证明模型缺失；未查询与失败来源保留当前身份，移除目标首项回退。独立目录最多四个并发，allSettled 收齐后复核粘性守卫，全部读取完成后才更新默认缓存。生产固定与切换模式都注入 ProviderRoutingClient，其同步本地生命周期守卫进入模型选择、能力与偏好校验链；整体关闭不降级为成功状态，单 Provider 故障只标记该来源不可用。失败占位的空能力和 none 不作为真实能力或默认 effort。
- 主代理生产 Command → ConversationService → ModelSelectionService → SessionRouter/MemoryBindingStore/WorkspaceRegistry 的受控观察：主目录失败，总览 openai 与官方克隆 cp-clone 均 available=false/支持情况未知，独立 cp-task 健康；浏览 cp-task 仍保留当前 main-model/openai。精确选择 cp-task/same 只读取目标目录和目标默认 effort/tier，保存 medium/default 并设置 forceNew；effort high、fast on/off、image/audio 能力查询均只到目标。随后 submit 经保存偏好校验，startThread 与 startTurn 均收到准确 cp-task/same，返回 new-cp/task-turn，绑定正确。仅外部模型和 Thread/Turn 端口注入自有数据，没有真实请求或平台发送。
- 文字 `/model cp-task` 的实际调用仍为 primary、cp-task、cp-task：共享命令先总览解析，再定向浏览；本批修复主目录失败后可以继续，不宣称文字命令端到端不等待主目录。直接 browseProvider 和结构化精确选择跳过无关主目录；保留既有数字选择和命令分类语义，当前用户指南及模块合同已区分。
- 最终版失败观察：首次授权异常即使随后恢复也原样拒绝，calls=[cp0]、active=0、默认缓存为空、偏好为空；整体停止发生在并发读取中时，已启动 cp0..cp3 全部收齐、active=0，不启动 cp4、不更新缓存；选择等待默认 effort 时停止，返回同一关闭错误且偏好为空。官方未登录、唯一 CP 动态默认未知且目录失败时，状态保留 cp/请选择模型/effort=null/available=false；threadStartOptions 拒绝 default-missing，目录成功但无默认标记后状态也明确拒绝 default-missing。
- 生产 ProviderRoutingClient 的活动准入等待观察分别覆盖主目录与独立 cp：等待期间撤权，释放准入后均返回原授权错误，只有 waiting 记录，没有 ensureProvider 或 model RPC 调用；自有 Routing 对象已关闭。没有新增测试、probe 文件或后台进程。上述观察不替代真实 RPC、平台和 Windows/macOS 验收；单 Provider 关闭、CollaborationMode/LunaReserve 的实际服务交互仍仅源码关联检查。
- 实施者最终完整类型、版本、模块边界与四文件 ESLint、差异检查通过。独立 Astra 正在复审，暂未提交；最终结论和提交状态在收齐后追加。
- 独立 A 找到失败占位的两处关联泄漏，均已修正：未配置主默认时，不可用占位的 Provider ID 不能回退为当前模型；共享文本、飞书与 Telegram 当前模型呈现也不能从失败占位读取显示名或 defaultReasoningEffort=none。主代理过滤这些已确认目录的消费点，保留列表不可用原因，不涉及 B12 交互快照。实际观察无配置主失败的 state/status/browse 均为 默认模型/openai/effort=null；明确配置失败均保留 configured-main；健康主目录仍显示 actual-main/medium。实际生产共享 effort 文本、飞书 Provider 卡与 Telegram 渲染入口均显示 configured-main/模型默认，不再显示错误的 Provider 名称或“关闭思考”；Telegram reply 只记录到自有内存，未发送平台消息。
- 独立 Astra/high 最终覆盖命令、Service、目录路由、固定/切换装配、同名精确身份、默认值、偏好存储与 Thread/Turn 消费、CollaborationMode/LunaReserve、关闭/授权和三端呈现，确认两项占位问题已关闭，无剩余 P1/P2 提交阻断。主代理已读完整报告并核对七源码 blob：Service `37965517`、Routing `d928b60f`、共享格式 `34aba1ed`、飞书 `57c44693`、Telegram `0769d1c5`；最终类型/版本/边界与变更呈现局部 ESLint 通过。用户指南进一步明确渠道按钮仍可能前置页面刷新；模式预设读取、首次自动接续历史查询等既有主依赖不属于本次解耦范围，不承诺主实例完全故障时所有操作可用。R11 标记已修复待补证，真实平台与跨 OS 限制保留。
- 本地提交 `3d87ed66209c3044377dadf2c472a0c3fea7a5e1`；正常 Hook 类型/版本/模块边界、局部 lint、84 份 Markdown 与 Gateway 构建全部通过，耗时 13.7 秒。提交后工作区干净，未推送。

### 第九批：B12（已提交 `322fc7ab`）

- 输入 `3d87ed66`，范围 R44。飞书 Provider 导航、模型、effort 与 fast 卡片必须保持生成时的目标和设置身份；旧卡及点击后目录/默认读取等待中的状态变化不得把选择应用到后来目标。普通文字命令保留按执行时状态解释，不扩展为外部配置事务或跨入口 revision 改造。
- 只读分析已沿 presentation → CommandCenter pending/Actor/Chat/message/TTL → adapter → CommandService → ConversationService 锁/Queue → ModelSelectionService → 默认配置 RPC beforeSubmit、Router/内存或 SQLite 偏好 → 新 Thread/下一 Turn 核对。现有卡片模型只保存 model.id、三种设置均通过字符串 execute，Provider 导航也依赖执行时 providerFilter；selectionScope 只有会话与工作区身份，不含当前/待生效设置或浏览范围。仅扩大 hash 不够，状态生成期间须固定原 scope 并在目录/默认等待后复核，避免旧值与新 scope 混合。
- 主代理修前实际复现：生产飞书 CommandCenter.openResponse 生成 cp-a/same 模型卡；随后浏览 cp-b，再向 handleCardAction 注入原卡按钮。经真实 Adapter → Command → Service → Models → Router/MemoryBindingStore，返回 accepted，偏好实际保存 cp-b/same/medium/null，cards=2、warnings=[]，确认旧 A 卡选择被重解释到 B。只注入自有模型端口、内存卡片收发与 Actor 许可，未调用平台、用户服务或真实配置 writer；所有自有对象已关闭，无脚本文件或后台任务。
- 实施采用平台无关结构化选择入口及本地快照，飞书 pending 保存准确选项，不把快照放进回调载荷；保留既有有界限时一次性 token。消费后捕获 TTL/关闭/授权守卫继续约束写入；合法自有解绑/偏好/浏览变更按提交阶段推进，不能把自己刚写成的状态误判过期，已提交默认值也不得伪称未保存或自动回滚。成功后生成新快照的后续卡片。下一步收齐实现、受控完整入口与失效观察，再开启新的独立 Astra 复审。
- 关联实施补充：Router.newSession 未绑定路径先写偏好、await 返回后仍复核守卫，若仅扩大 scope 会把自身提交误判过期。新增窄同步 onCommitted 回调，在绑定/偏好提交后、通知或 await 返回前推进本操作预期；外部等待变化不能在 await 后一并吸收。effort/fast 返回状态统一携带实际浏览范围，避免成功后新卡与当前 scope 不一致；共享返回值保留 providerFilter，Telegram 既有目录裁剪差异另记，不宣称其完整 token 合同已通过运行验收。
- 首轮修后完整飞书链观察：旧 A 卡在浏览 B 后回调返回 accepted（仅代表接收），内部返回 model.selection.expired，偏好为空，重放 invalid；新 A 卡准确保存 cp-a/same/medium/default，自动生成后续 effort 卡，连续选择 high、medium 都成功并产生新卡。随后 submit 创建 task-thread，Thread 参数精确 cp-a/same 且绑定一致。首次 Turn 日志误从第三参数读取 overrides，缺失字段仅为观察注入采集错误，未据此修改产品代码；准确第五参数补采另记。
- 失败观察使用同一 CardCenter → Adapter → Command → Service → Models → Router/MemoryStore：旧 effort/fast 卡在 cp-a→cp-b 后拒绝；目录等待期间修改 tier、切 Workspace、TTL 100→101、撤权、关闭均拒绝后续写入，保留竞争后偏好、默认写入数组为空、cards=1，所有重放 invalid。TTL/撤权/关闭 texts=[]，无后续提示；其它过期返回结构化安全提示。自有卡片只进入内存，未发送平台消息。
- 生产 Command 结构化 fast-off 到默认 writer 的受控边界观察：提交前撤权返回 command.authorization-changed、writes=[]、原 fast 偏好保留；已记录 default 提交后撤权返回相同授权错误、writes=[default]、后续偏好仍 fast，没有回滚或重试；正常 fast-off 返回 models/default、writes=[default]、偏好准确变为 default。writer 使用自有注入端口，未修改用户配置或执行真实 RPC。
- 最终准确参数补采：生产 Command.selectModelSetting 依次精确选 cp-a/same、effort=high、fast on→off，再 Service.submit；输出 fastOn=fast、fastOff=default、task-thread/task-turn，Thread 参数准确 cp-a/same，Turn 第五参数准确 cp-a/same/high/default，input=[text]，绑定正确。修正前述日志采集位置，不是产品修复。
- 已绑定路径补充观察：同 Thread 下当前 effort 改变或 Session ID 改变，旧卡入口立即 model.selection.expired，unsubscribe 调用为空、绑定保留、pending 为空；正常从 cp-a 切 cp-b 时 unsubscribe old-thread 一次、解除前台绑定、保存 cp-b/same/medium/null。自有解绑通知中注入竞争偏好 cp-a/competitor/high 后，原选择返回 model.selection.expired，保留竞争值，不用 await 后的快照推进吞掉它。未操作真实 Thread 或用户持久化。
- 实施者最终完整类型/版本/模块边界、9 个源码局部 ESLint 与差异检查通过并已交权；主代理读完实现报告和差异，新的独立 Astra 正在沿完整选择、快照、写入及消费链复审。真实飞书、App Server RPC、SQLite 落盘与 Windows/macOS 运行尚未观察，已有静态与内存边界证据不替代这些验收。
- 页面生成阶段额外观察：分别让生产 Models.state 等待目录、默认 tier 读取时写入 different/openai/high/default 偏好；两个入口都返回 model.selection.expired，保留新偏好，没有输出旧值搭配新 scope 的混合卡片。最后源码输入为 Models `0521d1c6`、Router `f010037d`、CommandCenter `61e5a291`，无新增脚本文件。
- 独立 A 新发现必须修复的有效默认边界：selectSetting 首次完整快照核对后，effort/fast 再次读取目录；raw scope 未含动态目录默认，可能把原 A 卡应用给 B。主代理实测官方未登录、唯一独立 CP 无静态默认：卡片读取 a，第 2 次校验仍 a，第 3 次目录为 b，实际返回 b/high、pending={effort:high}，threadStartOptions=b/cp。生产受管目录的 refreshProviderModels → updateSupplementaryModels 更新 isDefault 也可改变默认选择，属于本包原卡身份合同，不是外部配置 revision 扩展。已启动补修，不能据前述 raw 状态观察宣布本批通过。
- 独立 A 的有界元数据建议已采纳：CommandCenter 的本地模型元数据只保存与实际展示一致的前 18 项。实际构造 25 项卡片后 stored=18、allowed=18，伪造第 19 项 invalid，第 18 项准确执行 model-17，重放 invalid；未发平台消息。
- 旁支发现（不计入原基线 45 项）：A 核对 Telegram 时发现原有 effort 返回路径使用未按 providerFilter 裁剪的 catalog.models，而下一次 me 回调的 modelState 会裁剪；多 Provider 目录可能让新键盘 token 立即失效。原 HEAD 已有同类不一致，本包没有引入，尚无真实 Telegram 观察。本批记录为待单独复现、核对 Telegram 菜单合同后处理，不混入飞书三卡快照修复，也不据此更改原清单的覆盖或关闭数。
- 有效默认补修完成：结构化操作保存首次核对后的有效快照、实际查询目录来源与相关默认来源；后续解析比较有效状态，提交前复用已确认目录，只有继承档位需要重新读取。自有同步提交只推进本操作已写值；用户默认写入成功不代表 Workspace 覆盖已改变，不在该写入与明确偏好提交之间重新猜测继承值。修后独立目录默认 a→b、受管目录 isDefault a→b、继承 tier null→fast 三种等待期变化均返回 expired，pending={}、偏好为空。
- 独立 A 又发现补修中的跨 Provider 导航新卡不自洽：操作内保留的旧来源能力与下一页定向刷新不同。已将提交前旧快照核对与提交后新页目录覆盖分开。修后新 cp-b 卡保留 m1、effort/tier=null，随后精确选择 cp-b/m2 成功，偏好准确为 cp-b/m2/medium/null。官方 fast on/off、Workspace 始终覆盖为 fast 时显式 off 和显式模型选择均成功；定向 CP 选择只查询 cp/cp/tiercp，没有主目录请求。
- 最终完整飞书受控用户链：Command model 总览→CommandCenter 点击 cp-a 导航→模型序号 1→新 effort 卡 high→fast on→新卡 off→Service.submit，cards=7、warnings=[]、texts=[]、每张已消费卡重放均 invalid。Thread 参数准确 cp-a/same，Turn 第五参数准确 cp-a/same/high/default，返回 task-thread/task-turn。仅平台收发和模型/Thread/Turn 外部端口为自有内存输入，未发送真实消息或写用户配置；对象均已关闭。
- 独立 Astra/high 最终全链复审与两轮修订复核无剩余阻断。主代理已读完整报告并核对最终 Models blob `d5f901f1eb50da5aba3638422b4456458b133f42`、CommandCenter `9ab87c0a01a8082ab7e2335297f29561abd3b3de`；其余七源码保持复审输入。类型、版本和模块边界检查通过。R44 标记已修复待补证；真实飞书/App Server RPC、SQLite 落盘和 Windows/macOS 未观察，独立 CLI/WebUI 配置写者与最后读取至写入间不具备跨进程原子 revision 保证，不以本批快照守卫宣称解决该外部事务问题。
- 本地提交 `322fc7ab759356a5b3a85011d3b55434237f86b5`；正常 Hook 类型/版本/边界、局部 lint、84 份 Markdown 和 Gateway 构建通过，耗时 14.6 秒。提交后工作区干净，未推送。

### 第十批：B13（已提交 `186be82e`）

- 输入 `322fc7ab`，范围 R09。CLI/WebUI 共用的非流式 apply_patch/tool_search 探测只检查响应 model 字段形状，未确认与请求模型精确相等；外层 result.model 是请求身份，不能替代每次响应归属证据。两步补丁和三步工具搜索任一步错模型都必须为无法确认，不得采用到目标模型。
- 关联路径已核对：共享 request/parser → CLI 逐项显式采用与 WebUI canApply/draftKey → 连接关联标识/预览 revision → Provider 模型目录事务 → runtime 编译 apply_patch_tool_type/supports_search_tool。非 200 明确工具拒绝分类保留；原生 Responses webSearch 已有完成响应模型核对，Chat webSearch 不产生支持证据。独立 responses-tool-search-probe 只做单请求诊断、无上述保存调用方，不扩为本批工具能力自动采用路径。
- 修复边界只增加每次非流式成功响应的精确模型归属校验和中英文安全提示，不修改模型别名、历史声明、关联标识、目录 schema 或其他能力。缺失/无效模型仍不可验证，大小写、首尾空格和版本后缀不隐式等同。响应自报模型相同也不能证明供应商实际使用的底层模型身份。
- 实施者生产 probe 入口的 46 组 loopback 观察：两协议×两能力全 A 的 4 组分别在 2/3 请求后 supported；逐步返回 B 的 10 组均在该步停止并返回固定归属原因/HTTP 200；缺失、null、数字、空串、空白、控制字符及超长字段 14 组不可验证；大小写、尾空格、后缀不同 6 组拒绝；错误工具/marker 8 组不可验证；HTTP 400 明确工具拒绝且正文含其他模型的 4 组仍 unsupported。自有服务器和 dispatcher 已关闭，无文件或后台任务。
- 主代理完整 CLI 生产提示入口观察：错模型一次请求后没有 apply 选项、没有关联标识；继续选择未知只保留手动草稿。全 A 两请求后出现 apply，明确采用，再经 prepare/applyCustomPrimaryProviderSave 把任务自有 cp-owned 切换 Provider 保存为 created/restart-all；没有执行重启。WebUI 使用的生产 loadProviderModelCatalogPresentations 读回 model-A/other-model；编译目录中 A 为 freeform、图片支持、search=false，另一模型仍 patch=null、文本、search=true，未跨模型或覆盖另一能力。目录验证实际执行隔离 Codex debug models；配置 Client 为自有只读端口，没有真实 App Server RPC。
- 保存竞争观察：模型预览后另一操作更新 other-model 图片能力，旧预览执行返回 stale-preview，保留竞争后的 otherImages=true 与 A 的 search=false。自有目录 `/tmp/codexc-b13-entry-DPQJkk` 和 loopback 服务器均已清理。
- 主代理 WebUI 生产 HTTP 子路由观察：向任务自有 routeCustomModelCapabilityProbe 提交 A，合成上游返回 B；HTTP 200、一次请求、result.model=A、check=inconclusive、固定原因、httpStatus=200，保留既有 connectionToken 合同但 canApply=false，响应不含 B 的实际名称。此观察不含管理认证外壳或浏览器，未连接真实 WebUI；自有 `/tmp/codexc-b13-web-route-QpyC6l` 与两个服务器已清理。
- 真实翻译函数中英文新原因及未知文本安全回退通过；局部 ESLint、node --check、Oxlint、WebUI 自身 TypeScript 6.0.3 和 i18n:check 通过（2136 源键、键及占位符一致）。第一次误用根 TypeScript 5.9.3 检查 WebUI 报范围外泛型/DOM iterable 错，核对实际构建入口后使用 WebUI 编译器通过，未修改范围外代码。所有行为观察均为合成响应，真实供应商、浏览器点击和跨 OS 尚未观察；独立 A 复审结论待追加。
- 独立 Astra/high 完整核对双协议每步模型归属、失败/取消/预算、CLI/WebUI 采用、管理鉴权/Origin、token/预览/目录事务及 runtime 逐模型消费，无剩余阻断。主代理已读完整报告并核对三源码 blob：probe `44df6489`、reason 映射 `6a01dfc8`、中英消息 `d55c336a`。token 仍是连接归属证明，不宣称服务端能力证明；手动声明合同保持。R09 标记已修复待补证，以上真实环境限制保留。
- 本地提交 `186be82e96b5faf950b2ac6186b0fdec46e89c97`；正常 Hook 类型/版本/边界、局部 lint、84 份 Markdown、WebUI 构建/Lint/翻译和 Gateway 构建通过，耗时 18.2 秒。提交后工作区干净，未推送。

### 第十一批：B14（已提交 `f47cee98`）

- 输入 `186be82e`，范围 R15。Chat 终态必须在全部可失败的构造检查成功后提交；错误路径应收尾此前已交付的文本/推理 Item，非法客户端工具始终整组拒绝。仅将 ended 后移不足以覆盖用量构造失败或 push 同帧切换内容后抛错导致已生成事件未返回。
- 主代理修前生产 ChatToResponses 观察：content/reasoning/reasoning_content 三种先输出 already-visible，再积累非法 JSON 工具并 finish，均抛 Invalid Chat tool arguments；随后 fail 只有 response.failed、output_item.done=0，终态对应 content/summary 为空。另在先输出 reasoning 后，同一帧 content+非法工具 index=128 触发 push 错误，fail 只输出 message 的 done，之前 reasoning 的 done 已丢失。以上均为内联纯转换输入，无测试或 probe 文件。
- 用量关联反例实测：单轮 prompt_tokens=MAX_SAFE_INTEGER、completion_tokens=1，各字段单独通过原计数检查，但 finish 与随后 fail 都抛 Invalid accumulated Chat usage，不能生成终态。分析同时核对 hosted 多轮累加及失败路径的未知用量语义，不将本批扩大为一般指标重构；尚未宣称修复或上游历史落盘通过。
- 主代理修前生产 HTTP 桥接观察：ChatCompletionsBridge `/responses` → 自有 Chat SSE 上游，正文 visible-before-error 后非法 JSON 的 known 工具以 tool_calls/[DONE] 结束。HTTP 200 仅有 created/item.added/part.added/text.delta/failed，done=0，failed.output 中正文仍 in_progress/content=[]。首次误用 `/v1/responses` 得到 404，核对私有桥合同后改用 `/responses` 得到上述结果，未据此改变产品路由。两个自有服务器和桥均已关闭；未连接 App Server 或读取用户历史。
- 完整补修集中在一个转换器：push 先预解析整帧，最多复制 128 个工具状态引用并仅克隆改动项，不复制正文历史；finish 先构造全部合法工具、检查空答复与累计用量，再提交 ended/内容收尾/工具生命周期；fail 在用量聚合已知不可表示时省略 usage，仍生成内容 done 和 failed。合法 usage 独立保留，最新非法 usage 清除旧本轮快照；单轮 total 也检查安全整数。不修改桥终态控制器、直接 Chat Relay、公开协议或历史存储格式。
- 实施者内存生产入口观察：三种内容×坏 JSON/未知/混合工具 9 项均保留 already-visible 的 text/part/item.done→failed，客户端工具零发布；切内容帧的 index/type/id/function/finish/content/reasoning/后续工具错误不提交新内容，旧 Item 正常收尾；工具增量坏帧不污染原参数。单轮溢出、负数、cache 越界、坏 usage 清旧值，fail 不再二次抛错；合法 usage 与坏工具同帧仍保留 8/3/11、cache2/reason1。
- 托管搜索关联观察：两轮累计溢出在 tool_calls/length/filter 终态前全部拒绝、无客户端调用、usage 未知；缺首轮/末轮计数保持未知；搜索已完成但下一轮未提交时失败保留 2/1/3，beginModelRound 后未收到新计数则未知；两轮正常累计为 5/3/8、cache2/reason2。混合搜索与坏客户端工具在执行前整组拒绝；合法混合仅内部 not_executed 续传，后续客户端调用获得响应范围 ID。已开始搜索后失败不伪造 search completed。正常文本和 function/custom/tool_search、合法 usage 尾帧、length/filter、无 finish、空响应、16 MiB、上游错误、签名推理与工具 ID 冲突均按相应成功/失败合同观察。
- 主代理修后实际 HTTP 桥共 11 条：正常文本和合法工具 completed；混合坏工具、未知工具、切 kind 坏帧、非法 usage、无 finish、无 DONE、流内错误都先交付原可见内容 done 再 failed，客户端工具事件为零；length/filter 为 incomplete 且无部分调用。合法工具具有 added/done 配对。桥与上游均在 finally 关闭，无新增观察文件。
- 已补到 Linux 官方 App Server 权威历史路径：任务自有隔离 Codex Home、工作区、模型目录和 loopback 上游，生产 StdioTransport/JsonRpcClient 与 Runtime owned-process 端口启动并回收自有 App Server，正式 initialize→thread/start(paginated)→turn/start→官方通知→thread/read(metadata)→thread/items/list。修前构建产物为 `186be82e`，一次请求后 Turn failed，agent delta 存在，item/completed 仅 userMessage，分页历史也只有 userMessage、nextCursor=null；修后源码一次请求，Turn 仍 failed，完成通知和分页历史均新增 agentMessage，正文准确为 OWNED_VISIBLE_BEFORE_ERROR。未发出合法工具，未读取内部 session 文件，未连接用户服务/真实供应商。
- 上述历史首轮日志误从分页 entry 顶层提取 type 得到空对象，核对生成类型 ThreadItemEntry.item 后重新完整运行修前链取得准确历史；这属于观察采集更正，不是协议修复。自有目录 `codexc-b14-history-before-eIxo5M`、`codexc-b14-history-YMKaV9`、`codexc-b14-history-vhiswY` 已在自有进程关闭后精确清理。当前证据覆盖已加载 Thread 的正式权威分页读回；进程重启后的磁盘重载、真实供应商、跨 OS 与客户端断线后的送达结果仍未观察。
- 最终类型/版本/边界、局部 ESLint 与差异检查通过，实施者已交权，主代理核对最终源码 blob `fafc3ab0ff8c31a3894d33866611e4c7a1f88fa7` 并读完整报告；独立 A 全链复审中，尚未提交。
- 独立 Astra/high 最终覆盖 HTTP/转换/hosted 续轮/失败交付/锁定官方完成 Item 与历史读取链，确认无剩余源码阻断，最终 blob 与上述一致。主代理已读完整报告；Message incomplete 和无 status 的 Reasoning 完整内容 done 均符合官方类型，未完成搜索不伪造完成，断连不承诺送达。R15 标记已修复待补证：Linux 自有官方 App Server 权威分页历史已实际观察，剩余限制是磁盘重载、其他 OS、真实供应商与不可达客户端的最终交付，不再把该已观察历史路径标为未实测。
- 本地提交 `f47cee981f0b849b7b90abdd77daf9a390342b31`；正常 Hook 类型/版本/边界、局部 lint、84 份 Markdown 和 Gateway 构建通过，耗时 12.9 秒。提交后工作区干净，未推送。另实际核对当前 CLI 为 0.163.0；普通环境版本查询提示无法创建 PATH aliases（只读文件系统）但退出成功，此提示不影响此前隔离正式 RPC 观察，也没有修改环境或安装程序。

### 第十二批：B16（已提交 `b5f974a0`，先于 B15）

- 输入 `f47cee98`，范围 R17。按原包依赖建议，先统一二进制选择再观察 B15 的启动/退出预算，避免用错程序影响生命周期结论。合同沿用现有 effectiveCodexBinary：显式非默认配置优先，配置为 codex 时采用有效 CODEX_BINARY，否则使用 PATH 默认命令；不添加命令字符串解析或别名。
- 只读初步确认 runtime-environment、Doctor、service-install-context、Desktop command/proxy 和 remote 有遗漏；Unix App Server systemd/launchd 模板也未固化所选 CODEX_BINARY，而 Gateway 与 Windows 服务已有相应字段。仅把自定义目录加入 PATH 不能支持文件名不是 codex 的合法路径。完整调用/渲染/激活边界仍在核对，暂不修改服务或用户定义。
- 实施统一共享环境、Doctor、Remote（含聚合辅助 Client）、Desktop 两入口、服务安装及四处健康检查的有效程序选择；官方模型候选和业务模型目录校验读取用户配置选择。schema 与共享选择器拒绝空白配置，非空值保原义，不做命令拆分或无效路径回退。Unix 健康检查仅连接 UDS，Windows 才实际启动 Proxy，不以 Linux 观察代替 Windows 进程证据。
- 独立 Astra/high 发现并补修：Init 摘要原先 trim 后再选择；模板维护工具需要独立候选 CLI 合同，新增校验函数可选明确 binary 参数并让导出、版本和校验共享一次选择；WebUI UA 读取应使用已验证且补齐默认值的配置计算有效 binary 并纳入缓存键；Unix WebUI 模板与 App Server 模板同样需要固化 binary。Relay 不调用 Codex，未机械增加其 Unix 字段。上述均仍待最终复审结论，不把首次实施者自审当独立验收。
- Linux Node 22.23.4（CI 锁定版）真实 `bin/codexc.mjs remote --version`：PATH 仅 Node 与系统目录、无 codex，默认配置加环境覆盖及显式绝对路径均输出 codex-cli 0.163.0、exit 0；显式缺失路径 exit 1 且没有回退到有效环境程序。Doctor JSON 的 Codex CLI 项 success/0.163.0；整体 exit 1 来自隔离配置无渠道、无监管和 Socket，不称整体健康。临时 Home 下官方 CLI 的 PATH alias 警告不改变版本退出结果。
- 将已安装官方原生程序复制到任务自有 `Codex custom & cli` 路径：环境覆盖和显式配置两种 Remote 调用均 exit 0；给路径添加文字引号或参数则明确找不到程序、exit 1，无 shell 拆分。三平台 writeServiceDefinitions 在隔离目录首次与覆盖生成后，App Server/Gateway/WebUI 均保存选中路径；launchd 中 & 正确编码为 &amp;，systemd 引号与 Windows JSON 保留完整路径。仅生成定义，不安装/激活，不宣称 Windows ACL、Proxy 或 macOS/Linux 服务运行验证。
- 业务模型目录观察：显式真实 CLI 配合无效环境覆盖仍导出 11 个官方模型、8 个可选模型，完整目录加载校验成功；空 models 被官方 CLI 拒绝（首轮使用空目录失败，换完整目录确认原因），显式缺失路径不回退。维护入口 `update-model-templates.mjs --update-base` 配合无效用户 binary 和有效候选覆盖 exit 0，三份目录通过当前 Codex 加载，仅显示差异、不写仓库；报告底座模型差异属候选目录事实，未采用变更。
- 纯函数 Hack 拒绝空串、空白、数字、null/undefined；空白环境覆盖视未设置，非空环境 trim，显式非默认保原值。实施者 Node 22 check/14 mjs lint 通过；A 补修后的检查另记。所有隔离 CLI/配置/生成定义目录已清理；Node 工具与原生副本暂保留在任务自有 `/var/tmp/codexc-b16-node.SgNTmC`，供后续生命周期批次复用，由主代理负责最终清理。
- 原 R17 证据更正：当前 bin 的 config 直接使用 process.env，并非经 runScript；Setup 的父环境污染成立。原45项之外另记预存边界：显式相对 config.binary 按安装 cwd 解析，但服务启动可被配置原相对值覆盖并按服务 cwd 再解析，跨 cwd 一致性尚未修复，须另批明确相对路径基准和观察；本批不声称该路径已一致。另有此前 Telegram effort 键盘旁支仍待独立处理。
- WebUI 生产状态子路由在自有 HTTP 服务中使用合法省略 binary 的配置：无 App Server 时两次均 HTTP 200/source=unavailable，不因缺省值抛错；改变环境 binary 后 cache key 同步变化。此观察仅覆盖默认值和缓存归属、降级合同，不含真实 WebUI 鉴权外壳或 Windows Proxy 成功路径；自有 HTTP 与目录已关闭清理。
- 独立 Astra/high 完整复审已完成，4 项关联发现补修后无剩余本批阻断，主代理已读完整报告；审查源码差异 SHA-256 为 `86fd36ca595271e4e54b7bfb5bfe2a3868527a56218be475325787cec14ab234`。补修后 Node 22.23.4 类型/版本/边界检查与4个改动模块局部 ESLint 均 exit 0。R17 标记已修复待补证，保留上述跨 OS、服务和相对路径限制；尚未提交。
- 本地提交 `b5f974a07a5b3b9448948c90fe53df2418b8f92d`，正常 Hook 使用 Node 22.23.4，类型/版本/边界、局部 lint、84 份 Markdown、安装和控制脚本语法、Gateway 构建全部通过，耗时 11.8 秒。提交后工作区干净，未推送。

### 第十三批：B15（已提交）

- 输入 `b5f974a0`，范围 R13/R37。版本检查仍在 Graph 同步构造内 spawnSync；Windows writer helper 的启动/编译/查询未纳入总预算，/release 直接等待会阻塞事件循环。下一步沿 Gateway create/start/stop 与 release 授权、绑定、PID/创建时间复核梳理异步边界，复用已有自有进程终止能力，不终止共享 App Server。
- 关联分析确定：版本读取移到 startInternal 建立取消信号后的首个异步步骤、先于 IPC/连接；helper 与版本进程复用小型 Runtime owner，分清操作期限和清理期限，未确认退出保留归属并接入最终关闭。release 贯通已有 Actor 授权闭包，异步等待后复核原绑定/Workspace 和 PID/创建时间。这里“不终止共享 App Server”限定本任务运行观察及辅助进程清理；保留用户指南现有显式 `/release force` 可结束持锁进程的合同，不擅自撤销该功能，也不对用户进程执行它。
- 新增 owned-command-runner 及声明，Unix worker 从 scripts 移入 Runtime，原脚本转发同一实现；无 Runtime→scripts 依赖。版本操作 5 秒/合计输出 4096B，Windows writer helper 8 秒/1MiB；另有清理 500ms grace+1000ms 确认，Windows 最多加两次各 2 秒 taskkill。操作超时不等于总清理成功：未确认 child/进程组保留 owner，最终进程退出路径仍等待物理退出。构造、启动失败、停止均覆盖关闭，不改变服务模板和共享关闭预算。
- release 命令将既有授权闭包经 Application 窄端口传至 Graph；捕获稳定绑定对象与冻结 Workspace 快照，两次诊断后、终止前后复核。Windows 继续使用同一目标进程对象复核 startedAt，目标等待只使用剩余期限；辅助 runner 不接管被终止的持锁 PID。已发出 force 的未知结果不伪装成回滚，不对替换绑定执行恢复。
- 实施者内联 Node 22 生产 runner Hack：正常 stdout/stderr status0（74ms），非零 status7（61ms），挂起 timeout（262ms），cancelled（276ms），output-limit（100ms），父先退出/后代继承管道最终 descendant-done（473ms），树取消（336ms），重复 close 及关闭后新调用拒绝。20ms 心跳持续增长。无管道后代存活 2 秒时，run 在1068ms/close在1069ms明确 cleanup-unconfirmed，waitForExit 在2173ms确认整组退出，最终 close 成功；未遗失归属或发送信号到用户目标。
- 主代理 Linux 正式构建入口观察：隔离 Home/工作区/数据/唯一 Unix Socket，自有官方 0.163.0 App Server，GatewayApplication.create→start→stop 均 fulfilled，5ms 心跳推进21/23次；stop 后 App Server仍运行且通过生产 readAppServerUserAgent 再次握手。随后按自有进程归属终止官方 Server，exit0，六类 resource owners close/wait 全部完成，全部任务目录/Socket清理。无认证、无 Surface 插件、无模型请求，因此这不是带渠道的完整 CLI 服务就绪或真实平台投递验收；无认证周限查询降级日志符合隔离条件。
- 另三个隔离生产启动场景：真实 Node 作为 CLI 返回固定版本不支持，启动前 stop 返回 Gateway正在停止，启动中5ms stop 返回 cancelled；三者 start 均 rejected/stop fulfilled，心跳继续且六类资源关闭均成功。Linux 生产 writer inspection 对自有打开锁文件识别 Node PID；关闭描述符后 held=false，不存在文件也为 false；不可读 procRoot 与已取消输入均 inspection-unavailable。没有真实 force 成功断言。
- 观察故障记录：沙箱中官方固定 `/tmp/codex-daemon-0` 显示 mode0，批准只读核对实际700后使用授权升级在唯一自有 Socket 观察，未 chmod 用户目录。最初源码 tsx 观察因 MetricsWorker 固定 .js 路径不可用失败；曾误判为继承 input-type并重试，核源码后正式构建解决。随后内联 --input-type 仍导致 Delivery Worker 初始化关闭，改用Node22原生 stdin模块识别、execArgv=[]后正常启动。以上是观察入口修正，没有为此修改产品 Worker，也没有把失败轮记为成功。
- 独立 Astra/high 完整覆盖 create/start/stop/最终退出、runner及Windows Job源码、release授权/绑定/身份/恢复、七个脚本worker消费者及打包包含，无剩余本批阻断；主代理已读完整报告。完整类型、局部 ESLint、Runtime边界、正式构建与diff格式通过。Windows helper/Restart Manager/Job/taskkill、macOS运行及真实force尚未观察；Linux既有PID复用窗口不因此关闭。R13/R37标记已修复待补证。
- 本地提交 `fc940b9f4616607399920396b63be2239063a9aa`，正常 Node 22 Hook 的类型/版本/边界、局部 lint、84 份 Markdown、脚本语法和 Gateway 构建全部通过，耗时19.5秒；提交后工作区干净，未推送。

### 第十四批：B17（已提交）

- 输入 `fc940b9f`，范围 R24/R25/R26。连接 hostname 去除 IPv6 外围方括号，HTTP Host 与 WebSocket URL authority 保留；共享 Fetch 固定 API 默认拒绝跳转、保留 manual，显式 follow 在出站前拒绝。微信 JSON API、AccountQuery 和 Runtime OCG 显式 error，不引入逐跳通用代理。锁定微信源默认 follow 不是本项目必须支持跳转的证据；本批采用本项目固定端点失败关闭合同，未声称供应商永不跳转。
- OCG 正文按实际接收字节累计到64KiB，超限停止读取，非2xx及异常释放正文；取消不写失败缓存，成功后才产生 observedAtMs，模型终态仍只读已有快照、不等待额度网络。
- 主代理 Node 22.23.4 内联调用生产 ProviderProxy/ChatCompletionsBridge：IPv4与localhost的 HTTP Responses、Chat→Responses、WebSocket均成功；HTTP均200，Chat可见 OWNED_NETWORK_OK及completed，WS收到completed。自有 CONNECT代理收到三次精确 `[::1]:38381`，转接自有IPv4上游后上述三链成功，Host保留方括号，路径分别为 `/v1/responses` 与 `/v1/chat/completions`。全部监听、连接及代理已关闭。
- IPv6直接监听在沙箱及受支持升级后均返回 EADDRNOTAVAIL；上述CONNECT观察只证明authority、连接参数与转发合同，不证明真实IPv6 socket、TLS/SNI或外部供应商可用。未调用真实模型、账户或平台。
- 实施者另发现 Node 内置 Request 与安装的 Undici Fetch 品牌不兼容：代理路径的 error/manual Request 在发网前失败。已统一默认直连与代理使用全局 Fetch，代理仍使用安装的 ProxyAgent Dispatcher；Node22.23.4（内置Undici6.29.1）和Node24.22.1（内置Undici7.30.1）真实CONNECT均观察native Request manual返回307、不访问终点，POST返回200且方法/头/正文保留。error及init覆盖error在首跳拒绝，effective follow在出站前拒绝。尚未完成独立复审或提交。
- 实施者生产OCG Provider配合隔离私有凭据和自有HTTP：65536字节成功；约66KiB多字节、持续流超限、503、断流、坏JSON及307均null并进入普通失败退避；取消后立即下一请求成功，缓存命中保留observedAt。生产AccountQuery普通JSON成功、allowForbidden的403仍解析、307归network/request且未访问跳转终点；微信Client经既有fetchImpl端口映射自有loopback，上线成功，307归稳定network-error，传入redirect均error。首轮微信因无效accountId被invalid-input拒绝，改用合规自有身份后完成；没有真实微信请求。实施者确认自有监听、计时器和隔离目录已清理。
- 主代理另用生产 ProviderProxy 和自有 HTTP 上游、故意等待取消的额度回调观察：模型在31ms内返回200/completed，指标为completed且quotaWindows/quotaObservedAtMs均null；刷新仅启动一次且交付时尚未完成。关闭代理后该刷新收到一次取消并结算，全部自有连接关闭。这证明后台额度等待不阻本地模型交付及关闭归属，不是外部额度服务运行验收。
- 实施者最终全量类型、六个实现文件ESLint、Runtime边界及diff格式均通过；声明文件由类型检查覆盖，首次ESLint对.d.mts仅报告无匹配配置的ignored警告，不作为声明检查成功。未运行或新增测试。运行观察没有覆盖Windows/macOS网络、TLS/SNI或真实供应商。
- 新独立 Astra/high 全链复审完成，无剩余本批阻断；主代理已读完整报告并核对七个最终源码blob一致。审查差异SHA-256为 `5f9136db4c12f0bfecae3aa32d5e5f37e4515320d5fee5d2b14eaef85c1d70e4`。覆盖静态/动态上游、Responses/Chat/WS、全部共享Fetch消费者、Request与代理合同、额度账户归属/退避/取消/时间戳、后台关闭以及IPC/Writer/SQLite消费。R24/R25/R26标记已修复待补证；微信非2xx既有清理缺口已单列后续任务。
- 本地提交 `a4e29016f75731eee3f305a2f5b79ae9072a742d`，正常Node22 Hook类型/版本/边界、局部Lint、84份Markdown和Gateway构建全部通过，15.4秒；提交后工作区干净，未推送。

### 第十五批：B18（已提交）

- 输入 `a4e29016`，R05/R28。追踪普通Proxy的JSON/SSE/WS自由错误到IPC、Composition、BufferedWriter、SQLite、明细和导出；独立Relay已有errorMessage:null合同排除。拟在采集与IPC边界统一普通指标errorMessage:null，保留受限type/code/HTTP状态，Chat客户端固定错误不变；不改Schema、不重写或清理历史数据。HTTP/WS提交时点与实际发送对齐，未提交保持null，部分提交失败仍计时；Chat外层须沿真实上游诊断时钟关联转储。
- 主代理改前在Node22生产链复现：自有HTTP/WS上游→ProviderProxy→真实私有指标Socket→ProviderMetricsComposition→BufferedWriter→SQLite；关闭后只读重开，四条JSON错误、SSE失败、WS错误、WS限额关闭记录均保存合成标记 `SYNTHETIC_B18_PRIVATE_BODY`，生产JSON和CSV导出均包含它。无写入错误；自有监听、Socket、数据库目录均清理。未访问真实模型、指标库或用户数据；该观察不包含MetricsWorker线程及真实WebUI浏览器。
- 主代理修后复用同一生产持久/只读重开/导出链，四条errorMessage均null，原type/code与正常请求字节、耗时保留，JSON/CSV不再含合成标记；另故意经真实IPC发送带有界非null错误正文的旧格式帧，受理后持久null、两种导出不含标记。全程errors为空，全部自有资源已清理；没有修改历史库。
- 实施者补齐Chat关联：真实桥的beginModelRound及end同步抛错前不建立timing；end接受后才保留首轮submittedAt，多轮已提交时钟不清空。外层普通Proxy和转储由同一真实诊断起点更新。尚在运行观察和独立A复审，未提交。
- 实施者Node22生产路径观察：声明48MiB+1的HTTP请求返回413，上游请求0（TCP连接1不算提交），metrics无bytes/totalDuration，转储无callTiming；chunked 49MiB发送后超限返回413，上游请求1，已提交50331648字节、总耗时1033.913475ms，转储同值。正常JSON200/completed、bytes29、总耗时11.767383ms，转储同值。WS helper非OPEN和同步throw不标提交；send接受后异步callback失败仍保bytes1与耗时。真实WS Proxy交付completed、bytes54与上游一致，总耗时/转储0.677743ms。
- Chat早期非法JSON返回400，上游0、bytes/totalDuration空、转储无时钟；正常stream:true/store:false请求返回200、正文hello及completed，上游1、bytes114、总耗时5.939304ms，多次诊断起点保持221.429976，转储同总耗时。首次输入遗漏stream被合同拒绝400，更正后才成功。独立IPC Hack有界旧帧接收后正文null且429/type/code保留，501字符帧拒绝；全部自有资源清理。A与实施者同时发现Chat同步end抛错可跳过等待ready并因取消形成未处理拒绝，正在补旁挂拒绝处理并观察。
- 上述同步异常已补修：创建ready后立即旁挂catch，原await仍传播正常错误。A以Node事件循环观察确认旧机制产生AbortError/ABORT_ERR未处理拒绝；实施者对生产Chat的ClientRequest.end定向注入同步throw一次，返回502固定chat_upstream_error、上游请求0、bytes/totalDuration及转储callTiming空，unhandledRejection为空。补修后全量tsc、4个源码ESLint、Runtime边界及diff格式通过；全部自有资源与作业收齐。
- 独立A完成全链审查，无剩余本批阻断；主代理已读实施者和A完整报告，核对四个最终源码blob一致。A发现的ready拒绝及README错误文本旧合同均已补修。R05/R28标记已修复待补证；MetricsWorker线程、浏览器、真实模型/平台和跨OS未运行，Chat多轮搜索续答起点仅源码核对，不冒称实测。历史错误文本仍可能被原有读出/导出消费，本批未清理或重写。
- 本地提交 `690935ff539685e413437b0e00f6b9c3f677cfbb`，正常Node22 Hook类型/版本/边界、局部Lint、84份Markdown和Gateway构建全部通过，15.6秒；提交后工作区干净，未推送。

### 第十六批：B19（已提交）

- 输入 `690935ff`，R27。沿文件/journald错误分类到management `/services` recentError，以及日志安全文本到日志API梳理；拟抽现有日志投影为纯共享脚本，保日志入口公开导出、状态错误筛选/工具错误排除，先脱敏后压缩与截断。保留普通诊断可读性，与B18指标正文恒null不是同一合同。
- 主代理改前用自有gateway.error.log三条Basic/Proxy-Authorization/双Cookie材料，经生产routeStatusManagement的 `/services` 子路由和自有HTTP返回200；recentError仍含三个合成值，日志sanitizeLogText对同材料均REDACTED。使用自有服务状态缓存、platform=null避免查询真实服务，未读用户日志/journald；该观察不包含外层管理鉴权。所有任务目录和HTTP已清理。
- 抽取初版后，主代理实观发现带引号首Cookie只隐藏首项，sid仍残留；Set-Cookie同样成立。已补普通/不完整头隐藏到行尾，结构化JSON按字段处理；另将URL query与头匹配分开，敏感键解码后投影，正常status参数保留。主代理复跑生产/services子路由（含quoted首Cookie）返回200，摘要和日志均REDACTED、无合成值残留；结构化控制字符分隔的authorization键值也被隐藏。所有自有资源清理，独立A审查中。
- 独立A发现另一同批解析绕过，主代理已实际确认：`Error: Cookie: sid={"opaque":"SYNTH_COOKIE"}` 和api_key的JSON尾部被当成独立结构化记录，在已脱敏前缀后重新拼回非敏感键的原值；普通journal前缀完整JSON记录本身仍正确保留诊断并隐藏cookie。已交实施者补解析边界，修复复核前不提交。
- A另发现原摘要支持的 `api key` 空格拼写在迁移后漏匹配；主代理实际确认普通与带引号两例泄出，要求恢复。首轮JSON值范围补丁仅覆盖header/field，A继续指出敏感URL query的同根JSON尾部仍可拼回（含authorization/编码键）；已纳同批补修，未把局部修正当作整体完成。
- 继续复审的中间补丁发现非敏感JSON query值吞后续敏感参数，以及新增无限反斜杠匹配/允许问号的query键导致潜在二次回溯；后两项为源码复杂度推断，未对旧补丁运行大输入。要求按参数key先判敏感再决定值范围、避免非敏感值遮蔽后续参数，并消除新增无界回溯。最终补丁需补最大允许输入规模观察，不能以中间局部结果关闭本批。
- 实施者改为仅扫描?/&key=、key排除?、敏感key才扩展值范围，quote前仅有限反斜杠；4/16/64/256KiB反斜杠观察约0.13/0.47/1.84/7.44ms，问号约0.10/0.35/1.32/5.14ms，256KiB定时器延迟7.53/5.22ms。主代理最后定向发现未闭合单/双引号query值仍落空匹配后泄出；A指出先替sk令牌会制造数组形占位符并误吞安全status。均要求补齐后再定最终输入，未提前提交。
- 最终sanitizer blob `45a86e6ccae2b53650bd1a605b2bc288fe3189b3` 已将敏感query未闭合引号保守消费到行尾，query投影前置于sk/sess等通用替换；主代理五组定向输入全无合成值且status保留，再经production `/services` HTTP子路由观察JSON Cookie/未闭合query/空格api key均返回200及REDACTED，资源全部清理。独立A读取四个最终blob并给无剩余本批阻断结论；主代理已读实施者与A完整报告。
- 实施者14组及补修后的6组自有文件/注入journal/readServiceLogs观察无合成秘密残留，正常Pino/tracing诊断、工具/warn排除、depth32、失败503及600字边界保持；Node22类型/版本/Runtime边界、局部ESLint和diff检查通过。A报告引用的是较早打包清单；补充最终45a86版本的Node22 npm pack --dry-run --ignore-scripts --offline已完成，sanitizer4399B、status22337B、logs6711B全部收录，自有缓存清理，无安装或发布。
- R27标记已修复待补证。外层鉴权、真实journald、浏览器与Windows/macOS服务未实机运行；只保证已识别凭据形式的安全投影，不声称可识别任意未知正文中的秘密。自定义Socket目录日志归属差异已另记待复现任务。
- 本地提交 `3348a4745786cc59548fcc40dd36ce0c75c3446e`，正常Node22 Hook完整类型/版本/边界、Lint、84份Markdown、WebUI构建/Lint/2136字典键以及Gateway构建全部通过，44.2秒；提交后工作区干净，未推送。

### 第十七批：B20（已提交）

- 输入 `3348a474`，R36/R42。Telegram热撤权目前只替换访问策略/通知目标，现有正文流和显式图片需沿队列、重试与实际API边界复核；飞书应用配置需沿卡片等待、扫码、检查及patchAbility/patchConfig/publish各阶段复核并取消失效任务。仍授权目标保持正常，重授权不能复活旧操作；已远端提交结果不宣称可回滚。
- 本批不发送真实渠道消息，不修改真实飞书应用，不读用户账户或内部会话。先确定现有授权/取消端口及最小关联修复，隔离观察阶段间撤权和正常路径；未观察的外部平台边界保留。
- 最小方案已确定：TG由实际登记Actor复核目标权限，不能将群chatId当Actor；共享API执行器每次尝试复核，队列及流捕获可取消授权范围，撤权取消旧范围，重授权不能复活旧操作。仍有授权Actor的共享会话和仍授权的后台Thread不能机械取消。spool保持消费时解析并固定目标的合同，等待期间不改投新绑定；本批不扩共享发图接口，也不宣称持续复核Thread绑定快照。startup直发与命令context.reply并非本次正文/显式图片缺陷，须分别核对现有合同而不冒称被统一执行器覆盖。
- FS控制器须拥有Doctor与授权任务，热撤权沿Surface取消对应Actor任务；卡片投递贯穿取消信号，迟到扫码回调不得重新发卡。configure内部检查及每次patch/publish前后复核，保留已完成与未确认的远端操作阶段，撤权后不继续发送结果卡，也不宣称已回滚。实现与独立复审尚未完成。
- 主代理Node22初版集成观察：生产createTelegramSurface→Grammy本地API transformer→createTelegramRuntimeModule热reload，正常已登记Actor图片送至本地终端；名单内但未登记Actor的chat拒绝且未调用API；群会话登记两Actor，撤一人后另一人仍授权时可发。阻塞已进入sendPhoto的请求再排一张，撤权后立即重授权：已有请求确认返回，排队旧请求取消且无API，新提交正常。总sendPhoto目标为 `[11,-100,11,11]`；这区分已提交请求和未执行队列，不把本地取消当作撤回。未启动polling或连接真实平台，任务PNG及Surface资源已清理；后续补修仍须核对证据适用性。
- 独立A发现共享ConversationDeliveryQueue的取消分支只移除/release，未标记可靠回执失败；生产queue+captureDelivery内联输出 `status:resolved,calls:0,checkpoints:[]`。新TG signal接入激活此路径，可导致持久非正文结果没有平台调用却被ack。已扩本批至该共享队列，取消未执行项及已取消入队均需明确fail，补修和关联复审中。
- 重授权边界精确限定为已经进入TG平台队列/计时器并捕获授权范围的旧操作；尚在前级持久队列、未开始Surface执行的结果，首次投递继续按原owner及当前授权规则。没有引入整Turn永久封禁或journal授权代次，不改blocked/uncertain的人工处理合同；不得将此实现描述为永久禁止该Turn后续所有输出。
- A继续发现多段输出丢失队列信号：部分Outbox事件的enqueue回调不向send/sendPanel传signal，首段API迟到确认后可在重授权范围下发后续段。生产Outbox内联以12000字符user.message、首段挂起→撤权→重授权→释放，观察 `status:resolved,calls:4`。已要求贯穿所有同类回调与多段发送链，不能仅补图片或首段；隔离API故意忽略abort模拟已提交请求迟到确认，没有真实平台发送。
- 上述两项已补：共享队列取消先fail可靠回执，再释放；TG所有相关回调贯穿原signal，reasoning首次发送后也检查取消，防迟到二次入队。A复用原输入独立实观变为queue `rejected,calls:0,checkpoints:[]`、多段输出 `rejected,calls:1`。实施者另观同回执已有一项confirmed、另一等待项取消时仍rejected，入队前已取消也rejected；正常12000字仍为4段。真实进入429退避500ms后撤权再加，调用次数保持1并返回取消。
- 主代理指出FS扫码卡失败时共用abort会阻止原Doctor错误提示，已分离官方轮询取消与Actor任务范围：投递失败仅终止轮询，仍授权可更新原卡；撤权/关闭取消整个范围。finally取消并收齐已发起卡片投递，避免移除任务owner后仍有迟到卡。实施者已观察失败提示“飞书配置未完成”，完整报告及A最终结论待收齐。
- 实施者最终报告：Node22生产openDoctor→提取真实Doctor按钮→handleCardAction→HttpApi依赖端口，16个撤权再授权窗口覆盖Doctor读取/卡片、扫码回调/卡片、授权后检查、配置检查、三次写入及配置后检查；撤权后未进入下一次写入，迟到Doctor按钮无效。已发成功分别记录完成到patchAbility/patchConfig/publish；patchConfig未知记录completed=[patchAbility]及unconfirmed=patchConfig，明确403记录rejected=patchConfig。close阻止后续publish；正常扫码完成三写及结果卡；撤A不影响B原有按钮正常配置。未连接真实HTTP/扫码租户。
- TG正常delta一次send及一次edit；旧计时器和同Item迟到delta在撤再加后不再调用API，其他授权用户与新Turn正常。9源码tsc、局部ESLint、Runtime边界与diff检查均退出0，所有异步作业收齐、任务资源清理。共享队列的飞书/微信调用方也经独立A源码核对，正常顺序合同保持，但没有重复三渠道真实平台运行。
- 主代理已读实施者及独立A完整报告，并核9个最终源码blob与复审输入一致；A全链结论无剩余本批阻断。R36/R42标已修复待补证：本地生产类、热reload及SDK注入端口观察不等于真实Telegram送达、飞书扫码/远端配置或跨OS验收；startup/context.reply未扩，已发未知结果不自动重发/回滚。将通过正常Hook本地提交，未授权远端推送。
- 本地提交 `1e92e45201e30f738857282aea0e38fb71cef504`，正常Node22 Hook类型/版本/边界、局部Lint、84份Markdown及Gateway构建均通过，16.2秒；提交后工作区干净，未推送。

### 第十八批：B21（已提交）

- 输入 `1e92e452`，R38。三渠道音视频在前级输入队列等待时尚未登记Application取消范围，紧急stop可能先执行；须从真实接收入口、Actor/目标鉴权到全部等待队列、下载和锁内提交关联修复。TG同批紧急优先、微信monitor与adapter双层队列、飞书Inbox顺序处理分别核对，不能仅前移到现有flushPending之前。
- 保留先前输入创建首个Thread后再捕获附件目标的合同；已接收旧附件取消，stop后新收到独立附件仍可提交，其他目标和未授权stop不受影响。已可能提交的引用不得因取消误删，重复、过载和关闭需释放任务范围。不连接真实渠道或共享AppServer，实施后再开新的独立A复审。
- 方案确定为Surface内部共享有界附件接收范围，不新增Application端口：三端在授权、去重与容量准入后、第一次等待前登记音视频任务，120秒预算从接收起。授权stop在接收时取消此前任务，并让后续新附件等待该stop的处理结束，再创建现有Application提交范围，防迟执行stop误杀新输入。TG按update顺序登记，再保留紧急优先调度；微信还覆盖persistReplyContext前的等待。多次stop、处理失败及关闭必须释放等待，取消不能提前删除可能已提交的文件；实现和观察仍在进行。
- 主代理指出并经独立A确认：TG/WX到达时未授权直接返回无receipt，后续队列等待期间重新授权可走handler的缺receipt回退，夹在其中的stop无法取消旧附件。要求接收拒绝附件留下不占配额的永久拒绝身份或直接忽略，不允许后续当前授权重新接纳；飞书Inbox本身先拒未授权，无此入口路径。
- 主代理与A核Telegram接收stop识别，A用已安装生产grammY确认：前导空白且实体offset=1、以及无bot_command实体的 `/stop` 均会被新增文字识别误当stop，但SDK按普通文本处理；反之机器人MyBot的 `/stop@mybot` 是SDK有效命令，原接收识别却未匹配。已要求接收取消与紧急调度复用真实命令实体/用户名合同并拒有参数形式，不能用更宽文字识别触发取消。补修及独立复核中。
- 两项补修已由A独立实观复核：拒绝receipt重授权后仍audio.unavailable、create0/pending0；TG直接复用SDK命令匹配，前导空白/无实体false、大小写用户名和原名true、带参数false。接收未授权stop也限定冻结拒绝以保持准入一致；A未找到此stop分支的可重复生产竞态，不另列已复现缺陷。多stop改用尚未完成任务集合，避免不断链接历史Promise；逆序完成时先结束stop2不创建提交scope，stop1也结束后才create1，取消/close移除waiter。
- 实施者Node22生产接收链观察：TG lifecycle.pollUpdates→Bot→audio handler覆盖跨批慢前序、同批old/stop/new、其他chat和未授权stop，old无scope/download，new及other提交localAudio、stop后普通文字正常；WX InputAdapter.start→monitor→双层队列覆盖重复old、stop/new、file new.mp4及其他Actor，旧语音一次取消提示、新转写及视频按序提交并retain，游标1/2/3提交；FS Inbox.receive→adapter覆盖stop2先完成时new无下载、stop1完成后新语音提交、其他Chat正常、未授权stop ignored。三端结束pending/stops均0。下载与最终Turn消费口使用隔离注入，没有真实平台或用户AppServer。
- 真实120秒观察完成：elapsedMs=120151，audio.unavailable、pending0、dispose1；mayHaveSubmitted=true未因dispose清零。FS实际file视频入口迟到下载在stop后discard并拒绝，mayHaveSubmitted=false；已到RPC提交口但确认丢失时retain且mayHaveSubmitted=true。关闭等待中的附件不下载，最终pending/stops0；同目标第5项/第1001个活跃目标拒绝且不建Application scope，释放后0；飞书duplicate/overload不重复登记接收范围。额度是每Surface实例1000目标/每目标4项，Application另保留原全局预算。
- 独立A已完成三端接收、队列、下载、Application锁内守卫与文件归属的全链复审，无剩余本批阻断；主代理核9个最终源码blob与A报告一致。Application源码未改，相关README已纠正为接收范围与提交作用域分层，新增共享文件已入Surface索引。R38标已修复待补证；真实渠道、共享AppServer、模型执行和macOS/Windows未观察。准备正常Hook本地提交，不推送。
- 主代理已读实施者最终完整报告，所有异步作业和自有资源已收齐。观察中Application准备/取消调用生产方法，但会话锁及最终Turn消费由隔离端口执行，不能称完整AppServer提交验收；锁内真实守卫的适用性由独立A源码追踪补充。最新tsc、9源码局部ESLint、Runtime边界及diff检查均通过。
- 本地提交 `32763098cff7ad352f1105d5486ad34194179046`；正常Node22 Hook类型/版本/边界、局部Lint、84份Markdown及Gateway构建均通过，16.3秒；提交后工作区干净，未推送。

### 第十九批：B22（修复及独立复审完成，待提交）

- 输入 `32763098`，R39/R45。关联微信普通通知及可靠最终正文的Surface入口、共享队列、Outbox、平台客户端、完整内容receipt与Journal确认边界。
- R39保留关闭/worker/单请求取消，核对排队通知、多分片、文件回退及等待后的新调用；不以擦除signal实现排空，也不泛化改变其他渠道的关闭合同。
- R45完整TXT以原始最终正文生成，UTF-8文件大小也按原文计算；微信兼容格式只用于气泡与预览。完整文件及检查点未确认时不得错误清除持久原文。实施后安排新的独立A关联复审，再提交。
- 源码改动限定微信Outbox，不改共享队列与其他渠道排空策略。保留输入取消信号，并在每次真实API调用前检查关闭与取消；完整TXT字节独立取自event.text，后台任务前缀仅在预览显示。新的独立A正在核对入口、队列、重试、实际客户端及完整内容确认链。
- 实施者首轮隔离观察：普通多分片首请求忽略取消并跨15ms关闭预算，关闭返回及迟到首请求结束后API调用均仅1次，排队通知未发送；读图跨关闭后image=0，文件失败跨关闭后无新增回退，started检查点等待跨关闭后API=0。在途已发请求返回成功仍保存真实started/confirmed，不伪称撤回。生产/help入口至窄发送端口返回帮助。完整TXT等于原字节；原文1,000,000字节可发文件，1,000,001字节及原文1,088,114/展示88,044字节均不发文件、限5气泡且拒绝完整确认。缺文件端口、文件未知及confirmed检查点失败均拒绝确认；隔离Journal全链和独立A结论仍待收齐。
- 独立A已完成源码全链审查，无本批阻断；覆盖普通及可靠入口、队列关闭/超时、重试、协议多阶段上传、原文快照及receipt→Coordinator→Journal删除。取消边界明确为Outbox.close开始，Surface.stop仍先执行其既有输入与生命周期关闭步骤；已发未知请求不能撤回。文件触发条件仍是展示正文超过五气泡，短气泡继续兼容展示，不扩大为所有Markdown逐字附件投递。最终运行报告待收齐后再提交。
- 实施者最终报告已收齐：生产/help→ConversationAdapter→Outbox→ProtocolClient使用内存Fetch替身，正常链依次sendmessage、sendmessage、getuploadurl、upload、sendmessage；真实媒体加密后解密CDN载荷等于原文60,083字节，覆盖图片标记、CRLF、代码、中文强调和代理对。getuploadurl或upload阻塞跨关闭期限后没有后续平台调用。
- 源码DeliveryJournal Worker与Coordinator使用独立临时SQLite：正常完整文件ACK=1、records=0；文件未知、confirmed检查点失败及原文超限均ACK=0、records=1、uncertain且原文完全保留；明确文件拒绝按既有合同重试3次后回退，文本合计5条，仍ACK=0。检查点失败未误写文件confirmed。此证据不是实平台送达验收。
- 主代理已读完整实施报告并核最终源码blob `fd848421312efd6f21e6622b045f0781f729307a` 与独立A输入一致；源码仅outbox.ts，模块README及投递合同同步。类型、局部Lint、Runtime边界及diff检查通过，全部异步任务收齐、临时Worker和目录已清理。R39/R45标已修复待补证，真实微信客户端呈现与外部网络未观察。
- 独立A最终报告已收齐，复审覆盖Core原文、SurfaceManager快照/重放至SQLite确认删除及所有受影响发送入口，无剩余阻断；A复用实施者有效运行证据并独立形成源码判断，未宣称重复实机观察。上述阶段性“待收齐”现已完成，准备正常Hook提交。
