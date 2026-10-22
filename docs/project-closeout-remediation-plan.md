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
| R15 | P2 | 确认：finish 先 ended 再校验，失败漏内容完成；锁定上游支持历史影响推导，但权威历史丢失未实测。非法工具仍须整组拒绝。 | B14 |
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
| B15 自有进程生命周期 | R13/R37：异步、可取消、有总预算且确认退出的 helper/版本检查。 | gateway-component-graph、thread-writer-lock 及声明、app/config-lifecycle 和已有 owned-process 能力。 | 共用 graph 一个 writer；Windows 诊断预算与 Gateway 启动预算独立。force 异步等待后重核绑定/PID/创建时间；不得停止共享 App Server。 |
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

### 第一批：B01 / B02（实施与独立复审完成，待本地提交）

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
