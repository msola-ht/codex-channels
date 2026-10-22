# 项目收尾审查

已完成清单范围内 **1,146 个文件的逐文件关联审查**，其中第五轮补齐 966 项，复用同一源码基线的 180 项完整证据；清单中没有待补全文阅读项。初始累计记录 **45 项：3 项 P1、32 项 P2、10 项 P3**，第五轮新增 R30–R45。B01–B11 实施后，24 项待修复、19 项已修复待补证、2 项文档问题已关闭，项目尚不能据此宣布验收通过。此前“全项目覆盖”仅指模块和主要链路覆盖；清单范围的全文阅读已补齐，仍不代表所有可能分支或外部平台行为均已运行验证。

建议先处理审批信息完整性、匿名 WebUI 访问、凭据及诊断秘密保护、删除边界，再处理历史完整性、目标选择、出站路由、状态一致性和资源期限。

本记录已于 `c6d26882` 提交。其后 Astra 分批复核及后续执行安排见[修复流程](project-closeout-remediation-plan.md)；下面保留原编号与源码基线，复审范围更正明确标注，不代表已经修复。

**提交后复审补充（2026-10-22）：**三个 Astra 子代理已分别完成 13、17、15 项独立关联复核，45 项及原优先级全部保留。复审判定、反例、25 个修复包及逐包关闭条件集中登记在上述流程文档。下面各轮“未提交”“尚无复核证据”等记述保留其当轮时间语义；现在已完成材料提交和源码复审，仍没有业务修复或运行复核。

**范围更正：**R05 排除明确写入 `errorMessage:null` 的独立 Relay；R02 的浏览器利用、R15 的权威历史影响仍未实测；R40 只确认解析边界反例，不推定常规客户端会产生该组合；R41 只涉及损坏/缺失诊断和撤销结果，不是错误 Token 使用或鉴权绕过。R17 的完整修复边界包含服务安装及 Desktop 两条独立环境组装。R34 须同时核对锁定上游实际参数与展示参数，完整性无法证明时拒绝；只撤销渠道截断不充分。

**第一批实施更新（2026-10-22）：**R01/R02/R34 已实施并经新的独立 Astra 关联复审，无剩余提交阻断，状态为“已修复待补证”；R29 当前安全文档已对齐并完成内容/实现映射复核。R01 还补齐上游工作目录的解码、传递、完整展示与未知提示。实际本地解码/渲染和隔离 HTTP 输出、平台未观察项见[流程批次记录](project-closeout-remediation-plan.md#实施批次记录)。下面原轮次证据保留原基线，不能将其当作修复后现状；未实施的 41 项继续开放。

## 基线与状态

**第二批实施更新（2026-10-22）：**B03/B04/B05 已完成，第一次独立 A 全链审查的两项凭据阻断及第二次 A 发现的上层失败补偿问题均已修正，最终定向复核无剩余提交阻断。R07/R08/R12/R16/R21/R41 已修复待补证，R43 文档关闭；隔离 Linux 文件、生产 Reader、Relay owner/CLI、凭据及授权失败分支的实际输出和未观察边界集中在[流程批次记录](project-closeout-remediation-plan.md#实施批次记录)。本次新增文件不纳入原基线 CSV 的覆盖声明。

- 审查日期：2026-10-22。
- 源码基线：`08c97a60d4dd5b973066e90bec8f097c42f6dade`。首轮审查开始及代码检查结束时工作树均为 clean；后续补审期间源码未变，工作树仅有本记录、根索引及第四轮新增的逐文件清单改动。
- Gateway 与 Codex CLI 基线：`0.163.0`。
- 工作范围：首轮源码只读审查、静态检查和构建；第二轮补审长正文与媒体、扩展用例、复杂 Provider 事务、指标聚合、转储、Worker 和跨平台 Runtime；第三轮按模块与公开入口对账；第四轮完整补读普通 Proxy、网络环境链、HTTP 管理公共层、事件总线、授权、绑定存储等，并建立逐文件证据清单。按用户要求持续完善本记录及索引。未修复业务代码，未提交或推送。
- 证据口径：下列问题依据源码调用链确认；没有进行真实渠道发送、用户配置写入、用户服务启停或故障注入。浏览器利用和运行竞态的实机观察分别保留为待补证。
- 优先级：P1 为收尾前优先处理的安全边界问题；P2 为功能一致性、数据保护或资源期限问题；P3 为低风险诊断、呈现或合同表述差异。

源码位置的行号均对应上述基线。后续修改时保留编号，更新状态、修复版本、实际观察和复核结果，不用静态检查通过替代问题关闭证据。现行行为合同仍由对应专题文档及模块 README 维护。

## 问题总表

**第三批实施更新（2026-10-22）：**B06 的 R04/R06/R30 已完成输入类型、保存结果呈现和终端候选总长修复，并通过独立 Astra 关联复审。隔离 HTTP、共享 writer、真实向导调用链的注入返回、CLI 预填及安装记录函数已观察；真实浏览器/TTY、上游异常及各平台服务安装仍未观察，状态保留已修复待补证。详见流程批次记录。

| 编号 | 优先级 | 问题 | 当前状态 | 下一步 |
| --- | --- | --- | --- | --- |
| R01 | P1 | 飞书截断命令审批内容后仍允许批准 | 已修复待补证 | 补真实渠道审批往返观察 |
| R02 | P1 | 匿名回环 WebUI 未校验请求 Host | 已修复待补证 | 补浏览器、SSH 与 IPv6 连接观察 |
| R03 | P2 | 迟到启动响应重新激活已完成 Turn | 已修复待补证 | 启动及补偿链受控观察通过；补真实 RPC/渠道竞态与 Run 持久结算 |
| R04 | P2 | 非法 JSON 类型被解释为清除配置 | 已修复待补证 | 补真实浏览器与 TTY 配置操作观察 |
| R05 | P2 | 上游自由错误文本未经脱敏进入普通指标 | 待修复 | 在采集边界投影安全诊断 |
| R06 | P2 | 默认模型保存结果未知或被覆盖时误报未写入 | 已修复待补证 | 补真实 App Server 未确认或覆盖返回观察 |
| R07 | P2 | 自动转储清理跟随未经验证的根目录链接 | 已修复待补证 | 补真实 App Server 启动及跨平台观察 |
| R08 | P2 | 自动清理接受读取合同拒绝的 manifest | 已修复待补证 | 补真实 WebUI HTTP 与跨平台观察 |
| R09 | P2 | 工具能力探测未核对实际响应模型 | 待修复 | 按请求模型及完整探测链核对结果归属 |
| R10 | P2 | 自定义 Provider 连接原值保存仍写入并提示重启 | 已修复待补证 | 补真实 App Server、TTY/浏览器及跨平台观察 |
| R11 | P2 | 主实例目录失败阻断健康独立 Provider 操作 | 已修复待补证 | 受控完整提交链、关闭/撤权及呈现已观察；补真实 RPC/渠道与跨 OS |
| R12 | P2 | Unix 同步私有文件读取在类型校验前可能阻塞 | 已修复待补证 | 补异主及 macOS/Windows 私有访问观察 |
| R13 | P2 | Windows 占用诊断在 Gateway 主线程无期限等待 | 待修复，Windows 行为未实测 | 异步执行并覆盖整个 helper 生命周期 |
| R14 | P3 | 异常分组文档的频次排序与 SQL 不一致 | 待对齐 | 明确按最近发生还是频次展示 |
| R15 | P2 | Chat 工具终态校验失败遗漏已展示内容的收尾 | 待修复，权威历史行为未实测 | 校验成功后提交终态，失败仍完成内容归档 |
| R16 | P2 | Linux 渠道凭据复用未经验证的既有私有资源 | 已修复待补证 | 补跨用户及真实渠道链路；保留非原子竞争限制 |
| R17 | P2 | Setup 子进程和 Doctor 忽略显式 CLI 环境覆盖 | 待修复 | 统一所有入口的二进制选择 |
| R18 | P2 | Skill 卸载确认未绑定待删除目标修订 | 已修复待补证 | Linux 竞争、保留及完整 Setup 已观察；补跨平台与实际缓存加载 |
| R19 | P2 | 升级提案可把已验证补丁应用到另一基线 | 待修复，工作流竞态未实测 | 核对产物基线或固定验证提交 |
| R20 | P2 | 配置事件队列按锁龄抢占仍存活的持有者 | 已修复待补证 | Linux 持锁暂停、并发及双回收已观察；补 Windows/macOS 实机 |
| R21 | P3 | 微信只读 Doctor 会修改消息游标权限 | 已修复待补证 | 补真实渠道 Doctor 调用观察 |
| R22 | P3 | Relay 服务卡读取错误绕过当前语言翻译 | 待修复 | 按结构化错误码在渲染时翻译 |
| R23 | P2 | 会话名称歧义被唯一 ID 前缀匹配掩盖 | 已修复待补证 | 两命令生产调用链已观察拒绝与准确选取；补真实渠道往返 |
| R24 | P2 | IPv6 上游 URL 方括号误传 HTTP 连接主机 | 待修复，IPv6 请求未实测 | 分离连接主机与 URL/Host authority |
| R25 | P2 | Fetch 自动重定向沿用初始代理出口 | 待修复，重定向未实测 | 拒绝不支持的跳转或逐跳重选代理 |
| R26 | P2 | OCG 额度正文上限在完整分配后才检查 | 待修复，大响应未实测 | 接收时限制字节并取消未使用正文 |
| R27 | P2 | 服务状态错误摘要遗漏认证头和多值 Cookie 脱敏 | 待修复，实际泄露未观察 | 共用日志安全投影并在截断前脱敏 |
| R28 | P3 | 本地拒绝的未提交请求仍生成 submitted 耗时 | 待修复 | 在真实提交点记录计时 |
| R29 | P3 | 管理安全专题与远程 Bearer 管理合同冲突 | 已关闭，文档已对齐并复审 | 与 B02 后续行为观察保持一致 |
| R30 | P3 | 自动终端标识通过探测却超出配置总长限制 | 已修复待补证 | 补各 OS 服务安装控制链观察 |
| R31 | P3 | 轮次失败列仍显示合同要求省略的零值 | 待修复 | 调整显示投影并保留排序数据 |
| R32 | P3 | 两处英文加载状态仍使用中文辅助名称 | 待修复 | 调用方传本地化标签或隐藏装饰图标 |
| R33 | P3 | WebUI 文档残留不存在的目录入口和旧耗时展示 | 待对齐 | 按当前入口与显示规则统一文档 |
| R34 | P1 | MCP 工具参数截断后仍允许批准完整操作 | 已修复待补证 | 补真实 MCP 审批往返观察 |
| R35 | P2 | Workspace 写入已提交后撤销新增通知事件 | 已修复待补证 | CLI 故障注入、同 ID 清理已观察；补真实 Gateway 渠道通知 |
| R36 | P2 | Telegram 撤权未覆盖实时正文与显式图片输出 | 待修复，撤权发送未实测 | 输出执行前统一复核当前授权 |
| R37 | P2 | Gateway 同步版本校验没有等待期限 | 待修复，进程挂起未实测 | 异步校验并纳入启动取消及清理预算 |
| R38 | P2 | 三渠道排队音视频晚于 stop 登记取消范围 | 待修复，竞态未实测 | 在接收入队前登记或捕获取消代次 |
| R39 | P2 | 微信普通通知在关闭时丢失取消信号 | 待修复，关闭发送未实测 | 将同一取消范围贯穿实际平台调用 |
| R40 | P2 | 微信音频后附文本被静默丢弃 | 待修复，平台组合未观察 | 对不支持的组合双向拒绝或完整传递 |
| R41 | P2 | macOS 飞书损坏凭据被当作未授权 | 已修复待补证 | 补 macOS Keychain 异常及显式撤销观察 |
| R42 | P2 | 飞书应用配置任务在撤权后继续特权写入 | 待修复，外部写入未实测 | 每阶段复核 Actor 并取消撤权任务 |
| R43 | P3 | Relay 指南称等待转储初始化但实际跳过采集 | 已关闭，文档与实际入口已对齐 | 保持后台初始化与新请求采集合同 |
| R44 | P2 | 飞书旧模型卡按新的 Provider 筛选解释选择 | 待修复，旧卡点击未实测 | 绑定精确模型身份和选择快照 |
| R45 | P2 | 微信完整答案附件保存的是有损展示文本 | 待修复，实际文件未发送 | 完整附件使用原始正文并绑定确认 |

## R01 飞书截断命令审批内容后仍允许批准

**优先级与状态：P1，待修复。**

触发条件是命令审批的完整 detail 超过 12,000 UTF-8 字节。较长的 reason、命令前置内容或参数可把命令末尾、额外权限和持久规则挤到不可见部分。

证据链：

1. [server-request-adapter.ts](../src/codex-client/server-request-adapter.ts) 第 116–154 行接受命令与原因字符串，没有相应长度限制。
2. [coordinator.ts](../src/approval/coordinator.ts) 第 155–191 行拼接原因、命令、额外权限及持久规则，直接建立可批准交互；没有其他高权限分支使用的完整预览上限。
3. [approval-card.ts](../src/surfaces/feishu/approval-card.ts) 第 42 行起生成批准按钮，第 157–159 行却对“完整审批内容”调用 `truncateUtf8(detail, maximumDetailBytes)`。
4. [interactions.ts](../src/surfaces/feishu/interactions.ts) 第 665 行起将按钮决定映射回原请求；批准范围仍是完整请求，没有缩减为可见部分。

**影响：**用户展开面板后仍无法核对被截去的内容，却可批准一次、会话授权或所提供的持久规则。可见审批内容与实际授权内容不一致。

**建议调整：**在 Coordinator 中先形成无损完整预览，超出共同展示能力时安全拒绝；可参考现有 stdin、文件和临时权限审批的 3,000 字节限制。飞书 Surface 还应防御性地禁止对不完整预览生成批准按钮。同步核对审批展示合同及飞书模块文档，不能只提高截断长度。Telegram 采用分块完整展示，微信对超长交互取消，应分别保留它们的合同。

**关闭条件：**对超长原因、长命令后缀及末尾额外权限进行隔离观察，确认不会出现“只展示前段却批准完整请求”；再观察一条正常长度的真实飞书审批路径，确认显示与实际返回决定一致。当前没有发送真实审批。

**处理记录：**尚无修复、修复版本或复核证据。

## R02 匿名回环 WebUI 未校验请求 Host

**优先级与状态：P1，待修复；浏览器 DNS 重绑定利用待补证。**

触发条件是 WebUI 使用默认回环监听且未配置访问令牌，请求携带非回环域名的 Host。

证据链：

1. [webui-server.mjs](../scripts/webui-server.mjs) 第 255–276 行在 `token === null` 时允许普通 API GET 继续处理，没有 Host 或 Origin 校验。
2. 同文件第 387–418 行的管理 GET 把缺失的 Origin 替换为可信 `state.origin`，匿名分支同样不校验 Host。
3. [webui-traffic-route.mjs](../scripts/webui-traffic-route.mjs) 第 70–74 行仅额外验证 socket 为回环连接，然后进入调用记录读取；这些记录可包含 prompt、代码和工具输出。日志、指标及管理查询也经过上述公共入口。

**影响：**代码没有把匿名请求的 HTTP 主机约束到受支持的回环主机。在允许相应访问的浏览器环境中，攻击域名解析切换到回环地址后，同源 GET 可不带 Origin，形成 DNS 重绑定读取本机数据的风险。服务器端缺少检查是源码事实；浏览器利用能否成功取决于浏览器及网络策略，本轮没有实机复现，不能声称已读取任何用户数据。

**建议调整：**在匿名模式的公共 HTTP 入口统一校验请求 authority，限制为受支持的回环主机，并校验存在的 Origin。保留合法 SSH 本机转发使用不同端口的能力；远程 Bearer 模式继续遵循其独立合同。覆盖普通 API、管理 GET、日志、调用详情及事件流，不能仅修补管理写接口。对应更新 [管理接口安全合同](management-interface-security.md) 和 [WebUI 文档](webui.md)。

**关闭条件：**在无用户数据的隔离实例中观察非回环 Host、缺失 Origin、伪造 Origin 的拒绝结果，以及合法 localhost、IPv4/IPv6 回环和 SSH 转发入口；单独记录浏览器 DNS 重绑定场景能否触发及阻断位置。当前没有启动 WebUI 或执行浏览器利用。

**处理记录：**尚无修复、修复版本或复核证据。

## R03 迟到启动响应重新激活已完成 Turn

**优先级与状态：P2，待修复；实际触发频率未观察。**

触发顺序为：`turn/completed` 已经归约，随后对应 `startTurn` 的 Promise 恢复执行。

证据链：

1. [core.ts](../src/conversation-core/core.ts) 第 461–483 行在完成通知中删除相同 Turn 的活动状态。
2. [conversation-service.ts](../src/application/conversation-service.ts) 第 1786–1790 行在启动请求返回后无条件调用 `markTurnStarted`；Review 第 1490 行具有相同模式。
3. Core 第 99–114 行仅判断当前是否已经标记为同一活动 Turn，没有防止已观察终态被迟到响应倒退，因此重新插入活动状态并发布开始事件。
4. 普通输入入口第 928–940 行依据该缓存调用 `turn/steer`，失败后记录错误并抛出，没有在此路径自动改为新轮次。
5. 第五轮补充：[scheduled-task-executor.ts](../src/bootstrap/scheduled-task-executor.ts) 第 259–281 行同样在 `startTurn` 返回后直接调用 `markTurnStarted`，没有合并等待期间已观察的终态。计划任务的 Run 数据库由 [scheduled-task-run-coordinator.ts](../src/bootstrap/scheduled-task-run-coordinator.ts) 独立协调提前终态和精确 Turn 历史，可以正确收敛；这里的缺口是 Core 活动状态，不能据此推断 Run 必然一直 running。后台绑定释放后 Core 的无绑定清理也可能纠正状态。

本地锁定上游 `rust-v0.163.0` 的 HEAD 为 `83086188ae0614bd882818ff1aa23f3194962012`。其中 `codex-rs/app-server/src/request_processors/turn_processor.rs` 第 662–734 行先调用 `start_or_steer_turn`，之后仍等待配置快照和请求 Turn 记录；`bespoke_event_handling.rs` 第 155、1351 行分别独立发送开始、完成通知。不能假定启动响应必定先于完成通知被消费。上游位置与基线见 [协议索引](index.md) 和 [上游来源](upstream-sources.md)。

**影响：**已完成 Turn 可再次显示为活动，下一次输入可能误走 steer 并被上游以 `NoActiveTurn` 拒绝；停止和要求空闲的操作也可能读到错误状态。后续权威事件或恢复过程可能纠正状态，本轮没有证据将其描述为永久卡死。

**建议调整：**统一结算启动响应与请求期间已经观察到的事件，保证终态不倒退，也不能让旧响应覆盖较新的 Turn。参考已有 `trackThreadActivity` 的恢复协调职责，同时处理普通提交和 Review；只判断当前 active 是否存在不足以解决。核对 Core、Application 和 Client 事件消费之间的合同。

**关闭条件：**隔离观察“完成通知先于响应续体”“旧响应晚于新 Turn”及 Review 对应顺序；确认下一条正常输入可创建或正确补充当前轮次，停止和空闲判断保持一致。当前只有源码及锁定上游证据，没有运行竞态复现。

**处理记录：**尚无修复、修复版本或复核证据。

## R04 非法 JSON 类型被解释为清除配置

**优先级与状态：P2，待修复。**

触发条件是已获授权的管理请求携带有效 revision，但字符串字段传入 `false`、数字、对象或数组。

证据链：

1. [config-management.mjs](../scripts/config-management.mjs) 第 652–676 行的 `optionalString` 用 `stringValue(value) === ""` 判断清除，而 `stringValue` 对任何非字符串均返回空字符串。
2. 默认模型管理入口第 132–136 行因此把 `false` 等归一为 `null`，进入无需模型目录查询的清除分支；第 362–365 行删除已有 `codex.default_model`。
3. [webui-management-operations.mjs](../scripts/webui-management-operations.mjs) 第 99 行的 `assertManagedSetting` 仅检查对象和 kind。[webui-management-gateway-route.mjs](../scripts/webui-management-gateway-route.mjs) 的预览和 PATCH 均进入上述转换，PATCH 第 103–106 行通过共享 writer 保存。
4. 批量代理还有独立的同类分支：`config-management.mjs` 第 552 行把 `https_proxy: false` 当成删除。该操作虽要求一次性确认，预览与执行却使用相同错误转换，指纹匹配不能纠正语义。
5. [共享声明](../scripts/config-management.d.mts) 第 90、118 行规定相关值为 `string | null`，上述输入不属于支持的合同。

示例仅说明请求形状，不代表本轮实际发送：

```json
{"setting":{"kind":"system.default-model","value":false}}
```

```json
{"setting":{"kind":"network.proxy-batch","values":{"https_proxy":false}}}
```

**影响：**无效输入没有被拒绝，反而删除用户已有覆盖。代理覆盖被删除后，运行时可能转而采用环境变量或系统发现，改变实际连接来源。这不是绕过鉴权或确认令牌的问题，而是通过授权入口执行了错误的配置语义。

**建议调整：**在共享管理边界明确验证类型，仅对合同支持的 null 或空字符串执行清除；其他类型返回结构化错误。检查 `optionalString` 的身份标题等其他调用，保留部分编辑中未提供字段不变的语义。预览、CLI 与 WebUI 必须共享同一校验。

**关闭条件：**使用可丢弃配置观察上述非法输入的拒绝结果及文件内容不变；对合法字符串、显式清除、字段省略分别观察预览到保存的结果。批量代理需覆盖有效确认令牌下的非法值。当前未修改用户配置。

**处理记录：**尚无修复、修复版本或复核证据。

## R05 上游自由错误文本未经脱敏进入普通指标

**优先级与状态：P2，待修复。**

触发条件是原生 Provider 上游在错误消息或受识别的 WebSocket 关闭原因中回显凭据、敏感 URL 或提示正文。本轮没有观察到真实上游泄露真实秘密。

证据链：

1. [response-metrics-observer.ts](../src/provider-proxy/response-metrics-observer.ts) 第 322、370 行把 `error.message` 交给 `boundedMessage`；第 566–573 行只删除控制字符、压缩空白并截断，没有脱敏或固定错误投影。
2. [proxy.ts](../src/provider-proxy/proxy.ts) 第 1434 行也把被识别为 usage/rate limit 的 WebSocket 关闭原因整体写入 `errorMessage`。
3. [metrics-channel.ts](../src/provider-proxy/metrics-channel.ts) 第 276–278 行原样接受字符串，经 [provider-metrics-composition.ts](../src/bootstrap/provider-metrics-composition.ts) 的 `handle` 传给 Writer。
4. [sqlite-request-metrics-store.ts](../src/observability/sqlite-request-metrics-store.ts) 第 401 行持久化；[request-detail.tsx](../webui/src/components/requests/request-detail.tsx) 第 75 行展示，[format.ts](../webui/src/lib/format.ts) 第 196–203 行只翻译少量已知文案，其他文本原样返回；[metrics-output-renderer.mjs](../scripts/metrics-output-renderer.mjs) 第 738 行也直接导出。

**影响：**上游自由文本进入无需开启调用详情转储的普通指标库和后续展示、导出路径。若文本含秘密，该秘密会随指标保留；若含提示正文，则突破普通指标的最小诊断信息边界。这与 [Provider Proxy 模块合同](../src/provider-proxy/README.md) 中“不保留错误正文”的要求不一致。日志字段脱敏和转储头部脱敏没有覆盖这条数据流。

**建议调整：**在采集边界保留固定分类和受限代码；确需说明文本时，应建立明确白名单并在截断前脱敏，覆盖两处错误事件和 WebSocket 关闭原因，同时检查 IPC 新信任边界。可参考同模块 [chat-errors.ts](../src/provider-proxy/chat-errors.ts) 根据代码和 HTTP 状态生成固定文案的原则，但不能直接套用 Chat 专有协议分类。

**关闭条件：**使用合成秘密观察 JSON、SSE、WebSocket 三条路径到指标写入、读取、展示和导出，确认不会保留秘密或任意正文，且仍保留可操作的错误分类。当前没有发送真实模型请求或读取用户指标库。

**处理记录：**尚无修复、修复版本或复核证据。

## R06 默认模型保存结果未知或被覆盖时误报未写入

**优先级与状态：P2，待修复。**

触发条件是 CLI 默认模型保存返回 `consistency === "unknown"` 或 `writeStatus === "okOverridden"`。

证据链：

1. [codex-defaults-setup.mjs](../scripts/codex-defaults-setup.mjs) 第 112–114 行把上述情况的 activation 转为 `none`，仍调用配置生效提示。
2. [config-activation-notice.mjs](../scripts/config-activation-notice.mjs) 第 61–62 行对 `none` 输出“当前值未变化，配置文件未写入，无需重启服务”。
3. 前一段输出却已经表示保存结果未知或用户配置已保存但受到更高优先级覆盖，形成矛盾；返回的 `activationResult` 也混淆了保存状态与生效状态。
4. [codex-user-settings-setup.mjs](../scripts/codex-user-settings-setup.mjs) 第 711–714 行已有正确的门控：未知或被覆盖时跳过该生效提示。

**影响：**用户可能依据最后的“未写入”误判操作结果并重复提交，或误以为已保存的配置没有变化。这里不代表底层配置事务本身失败。

**建议调整：**默认模型入口采用与通用设置入口相同的结果门控，保留“保存未知”和“已保存但被覆盖”的真实状态；不提供生效提示不能等价为无写入。同步核对返回对象的消费者。

**关闭条件：**分别观察正常保存、无变化、回读失败和 `okOverridden` 的完整 CLI 输出及返回结果，确认没有互相矛盾的写入结论。当前没有执行真实默认模型写入。

**处理记录：**尚无修复、修复版本或复核证据。

## R07 自动转储清理跟随未经验证的根目录链接

**优先级与状态：P2，待修复；未执行删除观察。**

触发条件是 `<dataDir>/traffic` 为指向其他目录的符号链接，目标内存在满足标签及过期或体积淘汰条件的 V2 session。

证据链：

1. [traffic-dump-retention.ts](../src/provider-proxy/traffic-dump-retention.ts) 第 75 行直接 `opendir(options.directory)`，没有先验证根目录类型、链接、owner 或私有访问；第 86、106 行通过同一路径拼接并递归删除 session。同步入口第 48、66 行具有相同问题。
2. [app-server-service-runtime.mjs](../runtime/app-server-service-runtime.mjs) 第 135 行构造 `traffic` 路径，第 1342–1345 行在启动时调用自动清理，第 1357 行才启动主实例。清理不受当前转储开关控制。
3. [traffic-dump-storage.ts](../src/provider-proxy/traffic-dump-storage.ts) 第 240–243 行的私有目录保护发生在写入准备阶段，不能保护此前的启动清理；[relay-traffic-dump.ts](../src/provider-proxy/relay-traffic-dump.ts) 的 `maintain` 也进入同一维护实现。
4. [traffic-dump-reader.mjs](../scripts/traffic-dump-reader.mjs) 第 61–68、666–668 行的 WebUI/CLI 读取却会拒绝根目录链接。

**影响：**读取入口拒绝的位置，自动维护仍可能进入并删除其子 session，扩大自动删除的实际目录范围。这里没有证明跨用户攻击，也没有观察到任何用户数据被删除；问题是自动维护缺少与读取、写入一致的路径边界。

**建议调整：**在同步及异步维护入口检查既有根目录的真实类型、链接、owner 和平台私有访问，并在扫描与删除之间复核根及目标 session 的身份。复用 Runtime 安全能力，不能只保护 writer 新建目录。保留未知位置不处理的合同及固定诊断。

**关闭条件：**在可丢弃目录中观察链接根、扫描后替换根/目标、合法私有目录和活动 session；确认范围外材料不删除、合法过期材料可清理。分别核对 App Server 启动及 Relay 维护。当前未运行清理或用户服务。

**处理记录：**第二轮新增；尚无修复、修复版本或复核证据。

## R08 自动清理接受读取合同拒绝的 manifest

**优先级与状态：P2，待修复；未执行删除观察。**

触发条件是 manifest 含 `version: 2` 和四个类型正确的字段，但额外包含未知字段，或 `label/session` 为空，所在目录又满足淘汰条件。启动清理没有指定 label，因此空标签也可能被纳入。

证据链：

1. [traffic-dump-retention.ts](../src/provider-proxy/traffic-dump-retention.ts) 第 144–157 行仅检查四个字段的类型，不拒绝额外字段、空身份或非有限数值；第 87–98 行将结果纳入计划，第 106 行递归删除。同步清理共享该解析器。
2. [traffic-dump-reader.mjs](../scripts/traffic-dump-reader.mjs) 第 375–385 行明确拒绝这些输入；[用户指南](user-guide.md) 的转储合同规定未知文件和目录不自动删除，manifest 只接受当前四个字段。

**影响：**当前读取合同视为未知或损坏的材料，自动维护却认定为自有 V2 session 并可能删除。它与 R07 的根目录边界不同：即使根目录合法，这个识别差异仍存在。

**建议调整：**读取、显式清理和自动维护共享严格且无副作用的 manifest 校验；仅删除完整满足当前合同的 session。未知、扩展或损坏材料保留并报告固定诊断，不能通过放宽读取合同消除差异。

**关闭条件：**对额外字段、空身份、数值异常及合法 manifest 分别观察识别与保留结果，覆盖按时间和按体积清理、同步与异步入口，并检查 CLI/WebUI 读取一致性。当前未创建删除样本或执行清理。

**处理记录：**第二轮新增；尚无修复、修复版本或复核证据。

## R09 工具能力探测未核对实际响应模型

**优先级与状态：P2，待修复。**

触发条件是请求模型 A 的 `apply_patch` 或 `tool_search` 探测，上游非流式 JSON 实际声明模型 B，但工具调用及模拟标记符合短任务要求。

证据链：

1. [custom-model-capability-probe.mjs](../scripts/custom-model-capability-probe.mjs) 第 126 行调用 Responses/Chat 解析器时没有传入请求模型；第 363、398 行仅检查响应 model 的字符串形状。
2. 第 158–203 行根据工具与模拟回程判定 `supported`，多次请求间也没有核对响应模型一致性；第 220 行返回结果时重新填入输入 model，丢失实际响应模型。
3. [custom-model-capability-setup.mjs](../scripts/custom-model-capability-setup.mjs) 第 66–80 行及 [use-custom-model-capability-probe.ts](../webui/src/hooks/use-custom-model-capability-probe.ts) 第 29 行的结果绑定检查因此只能看到 A。WebUI 的 [provider-settings-management.tsx](../webui/src/components/settings/provider-settings-management.tsx) 第 501–506 行可采用该结果。
4. [custom-primary-provider-management.mjs](../scripts/custom-primary-provider-management.mjs) 第 729–733 行检查的是 A 的连接令牌，无法补证响应归属；最终 [model-catalog.mjs](../runtime/model-catalog.mjs) 第 167–168 行将能力编译为 A 的工具声明供 App Server 使用。

**影响：**错误路由或上游 fallback 的能力证据可被保存到所选模型。当前没有证据证明真实上游发生过此情况，也不表示用户无法手动配置能力；缺陷在于探测结论缺少模型归属证据。

**建议调整：**在共享请求/解析边界核对实际响应模型及整组请求的身份一致性；不匹配返回固定 `inconclusive`，不提供可采用结论。已有原生网页搜索 Responses 完成分支检查请求模型，可对齐其原则。若支持别名，须有明确映射合同，不能接受任意不同字符串。同步核对 CLI、WebUI、连接令牌和保存语义。

**关闭条件：**隔离上游分别返回错误模型、请求间变化及正确模型，观察两端结果采用和最终目录归属。当前未发起任何模型探测或付费请求。

**处理记录：**第二轮新增；尚无修复、修复版本或复核证据。

## R10 自定义 Provider 连接原值保存仍写入并提示重启

**优先级与状态：P2，待修复。**

触发条件是从 CLI 或 WebUI 编辑已有自定义 Provider 的连接、凭据与运行模式，保持原值并确认保存。

证据链：

1. [custom-primary-provider-management.mjs](../scripts/custom-primary-provider-management.mjs) 第 125–155 行的连接计划未计算 `willChange`，底层 `buildSavePlan` 返回值也不设置该字段。模型专用计划第 245 行则明确计算变化。
2. 第 264–265 行默认 `willChange: true` 并提示 `restart-all`；第 304–313 行仅在值明确为 false 时跳过保存，否则连接路径先写恢复备份再保存。
3. 切换模式进入 [model-provider-custom-runtime.mjs](../runtime/model-provider-custom-runtime.mjs) 第 695–708 行，即使字段相同也重新序列化并写 Profile。
4. 固定模式每次计划在 `custom-primary-provider-management.mjs` 第 740 行分配新凭据引用；其 Runtime 工厂第 35 行默认使用随机版本。[primary-provider-config-transaction.mjs](../scripts/primary-provider-config-transaction.mjs) 第 37、51 行分别写新凭据版本和主配置引用。

**影响：**原值保存成为实际写入，覆盖恢复材料、重写 Profile，或产生额外私有凭据版本并改变主配置引用，随后要求重启。这里没有声称凭据内容改变或事务失败；它也不同于 R06 的保存结果文案错误。

**建议调整：**连接计划比较有效字段、模式、副作用和实际凭据，计算真实变化。无变化仍核对修订，但不写恢复材料、Profile、元数据、凭据或主配置，返回 `unchanged/none`；确认存在变化后再创建凭据版本。CLI 与 WebUI 共用同一预览和执行判定。

**关闭条件：**用可丢弃配置观察两种模式的原值保存，对比所有材料字节、凭据版本数和返回结果；另观察真实字段变更及过期确认拒绝。当前未执行保存。

**处理记录：**第二轮新增；尚无修复、修复版本或复核证据。

## R11 主实例目录失败阻断健康独立 Provider 操作

**优先级与状态：P2，待修复。**

触发条件是健康独立 Provider 已配置或已有绑定，但主实例连接、鉴权或 Provider 策略检查失败。

证据链：

1. [model-selection-service.ts](../src/application/model-selection-service.ts) 第 755–761 行无论 `targetProvider` 是谁，均先等待主目录；[provider-routing-client.ts](../src/codex-client/provider-routing-client.ts) 第 759–762 行明确将它路由到主实例。
2. 只有主查询成功后，第 784–792 行才筛选并读取目标独立目录；第 803 行的故障隔离不覆盖前面的主查询。这与 [Application 模块合同](../src/application/README.md) 中定向操作只查询目标 CP 的要求不一致。
3. 锁定 Codex 上游 `model_catalog.rs` 第 32–40 行在缓存读取前检查当前 Provider 要求；`request_processors/catalog_processor.rs` 第 280–293 行会将失败传播为 `model/list` RPC 错误，因此不需要畸形协议输入就可能触发。
4. 该目录函数供模型浏览/选择、思考强度、速度档位、`requireInputModality` 和 `validateUnboundPreference` 使用。后两者分别被 [conversation-service.ts](../src/application/conversation-service.ts) 第 922–926、1713 行在提交前调用。

**影响：**健康独立 Provider 的定向菜单、图片/音频能力检查及无绑定偏好下的新会话提交会被无关主实例故障阻断。已绑定独立 Thread 的普通纯文本输入不必经过该检查，不能扩大为所有第三方会话均不可用。

**建议调整：**依据目标及目录来源决定查询依赖。定向独立目录只查询自身；总览隔离主目录失败并保留健康独立目录。依赖主目录克隆能力的官方兼容 Provider 仍须保留其真实依赖，不能制造占位能力。同步核对默认选择、偏好恢复、输入能力和菜单消费。

**关闭条件：**隔离环境令主实例 `model/list` 拒绝，观察健康独立 Provider 的浏览、模型/思考/速度、媒体能力及无绑定偏好提交；确认依赖主目录的 Provider 仍按合同拒绝。当前没有启动实例或模拟上游失败。

**处理记录：**第二轮新增；尚无修复、修复版本或复核证据。

## R12 Unix 同步私有文件读取在类型校验前可能阻塞

**优先级与状态：P2，待修复；异常文件行为未实测。**

触发条件是待读取的配置或受管标记被错误替换成没有写入端的 FIFO。这里讨论本地异常材料，不推定远程用户可以创建该文件。

证据链：

1. [private-file.mjs](../runtime/private-file.mjs) 第 118–141 行用 `O_RDONLY | O_NOFOLLOW` 同步打开，打开返回后才通过 `fstatSync().isFile()` 拒绝非普通文件。没有 `O_NONBLOCK`；同模块异步私有配置读取第 80 行则包含该标志。
2. [provider-file-access.mjs](../runtime/provider-file-access.mjs) 第 11–21 行的 Unix 主配置读取同样先同步打开再查类型，`realpathSync` 不会把 FIFO 变成普通文件。
3. [model-provider-managed-runtime.mjs](../runtime/model-provider-managed-runtime.mjs) 的 `readManagedMarker` 直接进入共享同步读取；[provider-settings-snapshot-worker.mjs](../runtime/provider-settings-snapshot-worker.mjs) 在文件预算扫描之前读取该标记。[model-relay-material-worker.mjs](../runtime/model-relay-material-worker.mjs) 第 37 行也直接读取配置。
4. Linux 接口文档说明，FIFO 的普通打开会等待另一端，而非阻塞只读打开可立即返回，见 [Linux man-pages：fifo(7)](https://man7.org/linux/man-pages/man7/fifo.7.html)。这解释了为何后置类型校验不能覆盖打开阶段。

**影响：**同步调用者可能停在打开阶段，无法及时报告类型错误；Worker 内的同步读取也不能靠 JavaScript 定时器或取消检查中断该系统调用。外层可报告超时，不等于内部读取已经退出。当前没有实测 Worker 强制退出的系统行为，不将其描述为不可回收。

**建议调整：**同步读取采用非阻塞打开后，在同一描述符上验证普通文件、owner 和权限；保持 Codex 主配置与严格私有文件各自的链接合同。同步核对文件读取大小边界及 Worker 关闭归属，不能仅在调用前增加一次易过时的路径检查。

**关闭条件：**在可丢弃目录观察 FIFO、设备/链接、正常配置和读取期间替换，确认快速拒绝且读取/Worker 生命周期有明确结果。当前未创建异常文件或执行注入。

**处理记录：**第二轮新增；尚无修复、修复版本或复核证据。

## R13 Windows 占用诊断在 Gateway 主线程无期限等待

**优先级与状态：P2，待修复；Windows 实际延迟及挂起行为未观察。**

触发条件是 Windows 上执行 `/release` 或 `/release force`，对应锁路径存在，PowerShell 启动、动态编译或锁持有者查询缓慢或不返回。

证据链：

1. [conversation-command-service.ts](../src/application/conversation-command-service.ts) 的 release 分支经 ConversationService 的窄端口进入 [gateway-component-graph.ts](../src/bootstrap/gateway-component-graph.ts) 第 2266 行，直接调用同步 `inspectThreadWriterLock`，没有 Worker 隔离。
2. [thread-writer-lock.mjs](../runtime/thread-writer-lock.mjs) 第 186–192 行使用 `spawnSync` 运行 Windows helper，未设置 timeout、取消或 helper 总期限；检查和强制释放均共用该入口。
3. [windows-thread-writer-lock.ps1](../runtime/windows-thread-writer-lock.ps1) 第 40 行起动态编译 Restart Manager 调用并查询持有者。强制释放的 `timeoutMs` 仅用于第 25 行的 `WaitForExit`，不覆盖前面的启动、查询或编译。

**影响：**只读占用查询也会同步阻塞 Gateway 事件循环；helper 等待期间其他渠道事件、审批计时和停止回调不能正常推进，最坏等待没有代码规定的总上限。Windows 仍是开发预览，但该实现缺口不能由其他 ACL Worker 已有期限覆盖。

**建议调整：**将 helper 执行移到异步、有界的进程或既有 Runtime Worker 能力，覆盖初始化、查询、取消与真实退出，并保留 PID/创建时间复核和明确的无法诊断结果。调整窄端口调用及关闭归属，不能仅为同步调用增加很长 timeout 后宣称主线程不受影响。

**关闭条件：**在 Windows 隔离环境观察缓慢启动/查询、取消、正常查询及释放；确认其他会话仍可响应，期限结束后 helper 退出得到确认，失败不误报锁已释放。当前没有 Windows 执行环境观察。

**处理记录：**第二轮新增；尚无修复、修复版本或复核证据。

## R14 异常分组文档的频次排序与 SQL 不一致

**优先级与状态：P3，待对齐。**

[Observability 模块 README](../src/observability/README.md) 第 142 行称展示出现次数最高的 20 组；[sqlite-request-metrics-queries.ts](../src/observability/sqlite-request-metrics-queries.ts) 第 422–425 行却先按最近发生时间倒序、再按次数排序后截取。CLI 消费这些分组，WebUI 概览再取前五组。

**影响：**超过上限时，最近发生的低频异常可排在较早的高频异常之前。当前界面没有把结果宣称为频次榜，因此先记录为文档合同差异，不推定聚合计数错误。

**建议调整：**确认现行产品意图；若保留源码行为，将模块文档对齐为最近发生的异常组；若要求频次榜，再共同调整 SQL、CLI/WebUI 消费及合同。

**关闭条件：**文档排序描述与实际查询优先级、截取数量和消费者一致。当前仅记录，未修改业务合同或查询。

**处理记录：**第二轮新增；尚无对齐修改或复核证据。

## R15 Chat 工具终态校验失败遗漏已展示内容的收尾

**优先级与状态：P2，待修复；权威历史行为未实测。**

触发条件是 Chat 上游已流式输出正文或推理，随后以 `tool_calls` 结束，但完整工具组包含无效 JSON 参数或未知工具名，且错误落到 `finish()` 而非更早的预校验。

证据链：

1. [chat-to-responses.ts](../src/model-api/chat-to-responses.ts) 第 173–180 行在 `validateCalls()` 前设置 `ended=true`。校验抛错时，活动内容仍未调用 `closeContent()`。
2. [chat-bridge.ts](../src/provider-proxy/chat-bridge.ts) 第 332–380 行捕获终态构造异常，调用 `converter.fail()`；转换器第 35–38 行因为 `ended` 已为 true，直接生成 `response.failed`，跳过内容收尾。
3. 活动正文仅在 `activeContent.text` 中；未收尾 Item 的 `content`/`summary` 仍为空，缺少对应 `output_item.done`。
4. 本地锁定 Codex 源码 `codex-rs/codex-api/src/sse/responses.rs` 第 354 行及 `codex-rs/core/src/stream_events_utils.rs` 第 315 行经完成 Item 路径记录消息；`codex-rs/core/src/session/turn.rs` 第 2776 行在流错误处分支退出。最后一段已展示内容因而缺少进入权威历史的完成事件。上游基线见本记录的官方参照说明。

**影响：**失败前已显示的最后一段正文或推理无法通过正常完成路径归档，失败响应自身也没有保留该段完整内容。合法完成及 `push()` 阶段失败不受此特定顺序影响；hosted-search 预校验通常会更早拒绝无效工具，因此不能扩大为所有 Chat 失败。

**建议调整：**必要校验成功后才提交不可逆终态；终态构造失败仍允许 `fail()` 完整关闭活动内容。继续坚持整组工具校验成功后才发布调用，不能为补齐 Item 事件而释放非法工具。同步核对桥接错误交付和上游历史消费。

**关闭条件：**隔离观察“先正文/推理、后无效工具组”的 SSE 与权威历史，确认保留已交付内容、拒绝无效调用；正常完成和更早失败路径继续保持配对。当前未执行故障注入或调用模型。

**处理记录：**第三轮新增；尚无修复、修复版本或复核证据。

## R16 Linux 渠道凭据复用未经验证的既有私有资源

**优先级与状态：P2，待修复；跨用户读取或链接写入未实测。**

触发条件是既有凭据子目录、密文或 `master.key` 为链接、其他属主或不安全权限。默认新建时的私有权限不足以证明这些既有资源安全。

证据链：

1. [secure-credential-store.ts](../src/surfaces/secure-credential-store.ts) 第 156、207 行直接读取密文和主密钥，仅检查密钥长度；第 202 行递归 `mkdir` 加 `chmod` 跟随既有目录链接；第 215 行优先复用未检查的旧主密钥。`remove()` 也直接使用拼接路径。
2. Linux 微信 [credential-store.ts](../src/surfaces/weixin/credential-store.ts) 第 56 行、[reply-context-persistence.ts](../src/surfaces/weixin/reply-context-persistence.ts) 第 117 行及飞书 [oauth-token-store.ts](../src/surfaces/feishu/oauth-token-store.ts) 第 34 行共用该后端。
3. [surface-composition.ts](../src/bootstrap/surface-composition.ts) 第 145、245 行注入凭据目录，没有对应的子目录私有资源守卫；上传目录的保护不能覆盖凭据。
4. [doctor.mjs](../scripts/doctor.mjs) 第 153 行仅检查配置目录下的 `credentials` 顶层，第 270 行通过后端读取微信材料，没有检查实际子目录、密文和密钥；飞书路径还可能位于另一状态数据库父目录。

**影响：**运行时和 Setup 接受不符合私有存储合同的现有材料，目录链接还可能把写入或删除导向其他位置。如果密钥和密文均位于其他用户可遍历、可读取的位置，加密本身不能保护机密性。这不是默认安装必然泄露，也没有观察到任何真实凭据泄露。

**建议调整：**在共享 Linux 后端校验实际目录和文件的类型、链接、属主及私有访问；读取、复用密钥、保存和删除都保持同一边界，复用已有私有文件能力并避免检查与使用分离。Doctor 复用只读检查并覆盖实际微信、回复上下文及飞书路径，不能静默修权限后报告原状态安全。

**关闭条件：**用隔离材料观察既有链接、不安全权限、错误属主、主密钥替换及正常存取；确认不读取、不改写、不删除越界材料，并正确报告原因。当前没有读取用户凭据或执行这些场景。

**处理记录：**第三轮新增；尚无修复、修复版本或复核证据。

## R17 Setup 子进程和 Doctor 忽略显式 CLI 环境覆盖

**优先级与状态：P2，待修复。**

触发条件是 `[codex].binary` 为默认 `codex`，通过 `CODEX_BINARY` 指定另一安装，而 PATH 中的程序缺失或不同。

证据链：

1. [runtime-environment.mjs](../scripts/runtime-environment.mjs) 第 19–22 行无条件将子脚本的 `CODEX_BINARY` 改成配置值或 `codex`，丢失继承的显式覆盖。
2. [codexc.mjs](../bin/codexc.mjs) 第 655–669 行的 Setup/`runScript` 使用该环境；Config 同样走子脚本。官方登录、Codex 设置及 MCP 的共享选择函数收到的已经是改写后的环境。
3. [init-wizard.mjs](../scripts/init-wizard.mjs) 第 248 行在主进程使用 `effectiveCodexBinary`，保留覆盖；[doctor.mjs](../scripts/doctor.mjs) 第 384–387 行则直接解析配置值，独立遗漏覆盖。
4. [executable.mjs](../runtime/executable.mjs) 第 4–12 行与[用户指南](user-guide.md) 第 102 行已经定义统一优先级：非默认显式配置优先，默认 `codex` 允许环境覆盖。

**影响：**同一配置下 Init 可识别正确安装，后续 Setup/Config 却可能调用另一版本或失败；Doctor 可能检查另一程序并给出不适用的版本诊断。当前确认的是选择链差异，未实际启动错误程序。

**建议调整：**环境组装前使用共享选择逻辑计算有效二进制，Doctor 也复用该逻辑；核对所有 `configuredEnvironment` 消费者，不能只修官方登录末端。保留非默认显式配置优先的合同。

**关闭条件：**隔离观察默认配置加环境覆盖、非默认配置、PATH 缺失及不同版本，确认 Init/Setup/Config/MCP/登录/Doctor 一致选择预期目标。

**处理记录：**第三轮新增；尚无修复、修复版本或复核证据。

## R18 Skill 卸载确认未绑定待删除目标修订

**优先级与状态：P2，待修复；删除竞争未实测。**

[skill-setup.mjs](../scripts/skill-setup.mjs) 第 289–308 行列出名称、选择目标并异步等待确认，但只向 `uninstallSkill` 传递名称。第 208–215 行重新拼接当前路径后直接递归删除，不核对确认时的目标身份或内容。相对地，同文件安装流程第 79–80 行已有目标修订校验，并在发布前复核和保留旧目录。

**触发与影响：**停留在卸载确认期间，另一安装器、Setup 或编辑器替换/更新了该技能。确认旧提示后实际删除的是新树，且没有恢复材料；影响下次会话读取的用户技能目录，而非项目内的安装标记。

**建议调整：**将目标路径、父目录身份和目标树修订绑定到确认，执行时重新核对；变化时拒绝旧确认。通过独占隔离或保留旧目录处理实际删除与并发更新的边界，不能用一次 `existsSync` 代替修订保护。同步检查安装与卸载对恢复材料的说明。

**关闭条件：**隔离观察确认期间更新、目标/父目录替换、取消及正常卸载，确认新内容不会被旧确认删除。当前未读取真实用户技能内容，也未执行删除。

**处理记录：**第三轮新增；尚无修复、修复版本或复核证据。

## R19 升级提案可把已验证补丁应用到另一基线

**优先级与状态：P2，待修复；远程工作流竞态未实测。**

证据链：

1. [write-upgrade-report.mjs](../scripts/write-upgrade-report.mjs) 第 182 行保存 `base-commit.txt`，验证结果与该提交生成的补丁对应。
2. [codex-upgrade-preview.yml](../.github/workflows/codex-upgrade-preview.yml) 第 160–164 行的独立 propose Job 重新检出默认分支，而非固定产物基线。
3. 第 191–197 行只执行 `git apply --check` 和 `git apply`，不读取或比较 `base-commit.txt`，也不重新验证应用后的树，随后提交 Draft 分支。
4. [升级指南](codex-cli-upgrade.md) 第 78 行要求应用产物前核对基线一致；分支前进时应重新生成。

**触发与影响：**preview 完成到 propose 检出之间默认分支前进，或手动 preview 使用不同分支；只要补丁仍能无冲突应用，Draft 中的代码树就可能不等于已验证代码树，验证报告失去对应关系。`git apply --check` 仅证明可应用；本问题不表示工作流会自动合并或发布，Draft 限制仍存在。

**建议调整：**固定到产物记录的基线，或在应用前比较当前 HEAD 与 `base-commit.txt`，漂移时拒绝并重新生成。报告同时标识生成基线和提案最终树；继续保持只读验证 Job 与 Draft 写入 Job 的权限隔离。

**关闭条件：**在隔离分支/产物上观察相同基线和基线前进两条路径，保证不会将旧验证结果标为新组合树的结果。当前未触发工作流、创建分支或写入远程。

**处理记录：**第三轮新增；尚无修复、修复版本或复核证据。

## R20 配置事件队列按锁龄抢占仍存活的持有者

**优先级与状态：P2，待修复；运行竞态未实测。**

[config-event-queue.mjs](../runtime/config-event-queue.mjs) 的 `withQueueLock()` 使用空的独占锁文件；`isStaleLock()` 仅按 mtime 超过 30 秒判定失效，不核对持有进程。抢占和释放均直接按路径 unlink，不核对 inode 或持有令牌。入队、确认和丢弃都是锁内读取、修改、覆盖写入。

**触发与影响：**进程 A 取得锁并读出旧队列后暂停超过 30 秒；B 抢占并加入或确认事件；A 恢复后用旧快照覆盖，可能丢失新通知或复活已确认通知。若 A 释放时 B 仍持有替换后的锁，还会删除 B 的锁文件。该问题不要求一次正常磁盘操作本身持续 30 秒，进程暂停即可满足顺序。

跨边界调用是 [workspace-config.mjs](../scripts/workspace-config.mjs) 第 125–135 行的新增/保存失败清理，以及 [config-lifecycle.ts](../src/bootstrap/config-lifecycle.ts) 第 292–343 行的 Gateway 读取、发送与确认。后者没有共享 CLI 配置写锁，因此配置文件的修订保护不能替代队列锁。影响限 Workspace 新增通知的可靠性；没有证据表明该队列竞争会直接覆盖权威 Workspace 配置。

**建议调整：**复用 [private-file-lock.mjs](../runtime/private-file-lock.mjs) 的活跃持有者及身份保护思路，按进程存活与锁身份判断回收，释放时只删除自己持有的文件。保持队列容量、配置保存失败清理和通知确认的现有语义。

**关闭条件：**隔离观察暂停超过阈值的活进程、已退出持有者、锁被替换及并发入队/确认，确认不丢事件、不复活已确认事件、不释放他人锁。当前未暂停用户进程或执行竞争场景。

**处理记录：**第三轮新增；尚无修复、修复版本或复核证据。

## R21 微信只读 Doctor 会修改消息游标权限

**优先级与状态：P3，待修复。**

[微信 doctor.ts](../src/surfaces/weixin/doctor.ts) 第 51–53 行调用 `cursorStore.get()`；[updates-cursor-store.ts](../src/surfaces/weixin/updates-cursor-store.ts) 第 34 行将修权限参数设为 true，第 65、139 行分别执行文件 `chmod(0600)` 和目录 `chmod(0700)`。同实现第 38 行已有只读 `inspect()`，CLI Doctor 第 291 行使用这一入口，但渠道 Doctor 未使用。

**影响：**与微信模块文档的只读诊断约定不符，会改变受查游标的权限并可能掩盖原有异常。此项与 R16 的凭据资源保护不同，不合并为凭据泄露问题。

**建议调整与关闭条件：**渠道 Doctor 端口使用已有只读 inspect 能力，保留运行时 get 的合同；隔离观察检查前后权限不变、安全及异常权限分别正确报告。当前没有执行 chmod 或发送渠道诊断命令。

**处理记录：**第三轮新增；尚无修复、修复版本或复核证据。

## R22 Relay 服务卡读取错误绕过当前语言翻译

**优先级与状态：P3，待修复。**

[relay-service-management.tsx](../webui/src/components/settings/relay-service-management.tsx) 第 32 行直接显示 `services.error`；[use-api.ts](../webui/src/hooks/use-api.ts) 第 53–56 行同时保留了结构化 `errorCode`。同一接口在 [settings-page.tsx](../webui/src/pages/settings-page.tsx) 第 100 行已使用 `translateApiErrorCode`。现有翻译支持管理限速、网络失败、超时及未知错误。

**触发与影响：**英文界面读取 Relay 服务状态失败时，显示服务端中文或浏览器原始错误，切换语言也不更新该段。同接口在两个页面表达不一致；未知服务端异常仍由后端固定消息遮蔽，不能将本项夸大为内部异常泄露。账户来源告警和单账户刷新提示按文档有意保留原文，不属于本项。

**建议调整与关闭条件：**在 Relay 服务卡渲染时按错误码翻译，保留重试和加载状态；隔离观察已知错误、网络失败、未知代码及中英文切换，重试后恢复正常。当前未启动浏览器观察失败界面。

**处理记录：**第三轮新增；尚无修复、修复版本或复核证据。

## R23 会话名称歧义被唯一 ID 前缀匹配掩盖

**优先级与状态：P2，待修复。**

[conversation-session-query-service.ts](../src/application/conversation-session-query-service.ts) 第 458–467 行先收集精确 ID/名称匹配，但只处理数量为 1 的情况；数量大于 1 时仍继续匹配 ID 前缀，并在前缀唯一时直接返回。模块合同要求歧义明确失败。

**触发：**列表中两条会话同名为 `abcd`，第三条会话 ID 以 `abcd` 开头且是唯一该前缀，用户输入名称 `abcd`。这是源码推导示例，没有实际创建会话。命名入口只检查非空和 64 字符上限，不限制名称与 ID 前缀重合。

**跨边界影响：**[conversation-service.ts](../src/application/conversation-service.ts) 第 1046 行的 resume、第 1273 行的 unarchive 共用选择器，随后将返回的 ID 交给 Router；[router.ts](../src/session-routing/router.ts) 第 632、1183 行继续执行接续/解除归档和绑定。用户本应收到名称歧义提示，却可能操作第三条会话。后续 Workspace、归属和活动状态检查仍存在，因此不将本项描述为越权访问；问题是授权范围内选错目标。

**建议调整：**按既定优先级先决算精确匹配：唯一则返回，多个则拒绝，仅零匹配时进入前缀匹配。核对 resume 与 unarchive 两个入口，保留序号语义。

**关闭条件：**隔离观察重复名称加唯一 ID 前缀、唯一精确名称、唯一前缀及普通歧义，确认不会恢复或解除归档错误会话。当前未调用 App Server。

**处理记录：**第四轮新增；尚无修复、修复版本或复核证据。

## R24 IPv6 上游 URL 方括号误传 HTTP 连接主机

**优先级与状态：P2，待修复；实际 IPv6 请求未观察。**

[model-provider-custom-runtime.mjs](../runtime/model-provider-custom-runtime.mjs) 第 879 行起的 HTTP(S) URL 校验允许 `http://[::1]:8080/v1`。但 [app-server-service-runtime.mjs](../runtime/app-server-service-runtime.mjs) 第 534–550 行将 `URL.hostname` 原样作为上游连接 host；IPv6 的该属性含方括号。[proxy.ts](../src/provider-proxy/proxy.ts) 第 640–647 行和 [chat-bridge.ts](../src/provider-proxy/chat-bridge.ts) 第 239–243 行直接传给 Node HTTP(S) 的 `hostname`，需要裸 IPv6 地址的连接层因而收到带括号名称。

**影响范围：**固定/切换自定义 Provider、顶层 `openai_base_url` 的原生 Responses HTTP 及 Chat 桥接。受管内置域名不触发；[model-relay-service.mjs](../runtime/model-relay-service.mjs) 第 107–108 行及同一 App Server Runtime 第 304 行的图片上传已正确去括号。已安装 `ws/lib/websocket.js` 第 756–758 行也在连接前剥去方括号，佐证 URL authority 与连接 host 的不同要求。未观察具体 DNS 错误码。

**建议调整：**区分连接主机与 URL/Host authority。不能在共享 host 上简单全局去括号，因为 Proxy 第 1048 行还拼接 WS URL，[request-routing.ts](../src/provider-proxy/request-routing.ts) 也构造 Host 头；应分别保持合法格式并核对代理 CONNECT、HTTPS 和 SNI。

**关闭条件：**隔离观察 IPv4、域名、裸 IPv6 连接目标，覆盖原生 HTTP、Chat、WS 和代理路径，确认连接地址及 Host/URL 均正确。当前未连接任何上游。

**处理记录：**第四轮新增；尚无修复、修复版本或复核证据。

## R25 Fetch 自动重定向沿用初始代理出口

**优先级与状态：P2，待修复；实际重定向未观察。**

[proxy-fetch.mjs](../runtime/proxy-fetch.mjs) 第 12–22 行只根据初始 URL 选择直连或代理 Dispatcher，随后交给 Fetch 自动跟随跳转。已安装 Undici `7.29.0` 的 `lib/web/fetch/index.js` 第 1346–1354、2146–2154 行递归更新目标但复用原 `controller.dispatcher`，不再次执行项目的代理选择。

**触发与影响：**重定向跨越 `NO_PROXY` 或 HTTP/HTTPS 分别配置的代理边界。原目标需要代理而新目标应直连时仍经原代理；反向跳转仍直连，可能违反预期出口或导致连接失败。[微信 protocol-client.ts](../src/surfaces/weixin/protocol-client.ts) 第 743–757 行、[account-query.ts](../src/bootstrap/account-query.ts) 第 73–79 行和 OCG 额度请求均采用默认 follow，存在实际消费者。图片上传、微信 CDN 已显式拒绝跳转，连通性检查使用 manual，不受此问题影响。

跨源敏感头处理不能与出口选择混为一谈：已检查的 Undici 跳转实现会删除跨源 Authorization、Proxy-Authorization、Cookie 和 Host，因此没有将本项报告为跨源凭据泄露。

**建议调整：**端点不支持跳转则显式拒绝；确需跳转时使用有次数和总取消预算的流程，逐跳重新选择代理，同时保留方法、正文及敏感头的正确转换。Runtime、Gateway Fetch 包装与实际消费者应共同对齐，不能只修改初始选择器。

**关闭条件：**隔离观察代理→NO_PROXY、NO_PROXY→代理、HTTP→HTTPS 及循环跳转，核对实际出口和取消；当前没有执行网络请求。

**处理记录：**第四轮新增；尚无修复、修复版本或复核证据。

## R26 OCG 额度正文上限在完整分配后才检查

**优先级与状态：P2，待修复；大响应及内存故障未实测。**

[opencode-go-quota-windows.mjs](../runtime/opencode-go-quota-windows.mjs) 第 7 行声明 65,536 字节上限，第 90 行却先 `response.text()` 完整分配正文，再于第 94 行检查 JavaScript 字符长度；第 87 行对非 2xx 响应直接返回，也不消费或取消正文。

**跨边界影响：**App Server Runtime 将该能力注入 Proxy 启动及后台刷新，[proxy.ts](../src/provider-proxy/proxy.ts) 第 1511–1527 行只提供单账户在途去重及生命周期取消，外层没有字节上限。10 秒期限不能限制期间接收的数据总量。异常大成功响应会先占用内存再降级为空额度，非成功正文的收尾也不完整。

地址固定为受信的 `https://opencode.ai/zen/go/v1/usage`，需要该服务或响应链异常才触发，不能描述为普通聊天用户可以直接构造攻击，也没有观察 OOM 或连接池耗尽。

**建议调整：**在接收阶段按字节累计，超限立即取消，非 2xx 同样释放正文。可参考 Gateway [bounded-fetch-body.ts](../src/bootstrap/bounded-fetch-body.ts) 的处理合同，但 Runtime 不应反向依赖 Bootstrap；保留原失败退避和观测时间语义。

**关闭条件：**隔离观察超限、多字节、非 2xx、取消和正常小正文，确认接收内存有界且额度降级不影响模型交付。

**处理记录：**第四轮新增；尚无修复、修复版本或复核证据。

## R27 服务状态错误摘要遗漏认证头和多值 Cookie 脱敏

**优先级与状态：P2，待修复；未观察真实秘密或实际泄露。**

[service-status.mjs](../scripts/service-status.mjs) 第 233–261 行将 Pino 错误 msg、非工具 tracing 错误及普通 `Error:` 行送入 `sanitizeServiceError`。第 266–275 行只处理 Bearer Authorization，未覆盖 Basic；Cookie 的键值替换遇到分号即停止，后续 Cookie 值仍可能保留。

**触发示例：**`Error: Authorization: Basic <合成值>`，或 `Error: Cookie: first=a; sid=second`。这些只是源码推导输入，未实际执行或读取用户日志。

**跨边界影响：**Linux journald 和文件日志共用该摘要处理；[webui-management-status-route.mjs](../scripts/webui-management-status-route.mjs) 第 68–82 行直接将结果放入 `entries[].recentError`，没有再次脱敏。同源日志页 [webui-logs-route.mjs](../scripts/webui-logs-route.mjs) 第 37–42 行已经隐藏完整认证头/Cookie，因此同一段日志从服务状态摘要读取时反而可能暴露。管理鉴权仍存在，但不满足诊断投影不返回已有秘密的合同。本项与 R05 的模型错误入指标库是不同入口和出口。

**建议调整：**在合适共享边界复用日志安全投影，保留状态摘要的错误筛选和长度限制；先脱敏再截断，涵盖 Basic、Proxy-Authorization、Cookie/Set-Cookie、多值及带引号内容。

**关闭条件：**用隔离日志材料观察 journald/文件到服务状态与日志接口的响应，确认两种投影均无秘密残留，正常诊断仍可用。

**处理记录：**第四轮新增；尚无修复、修复版本或复核证据。

## R28 本地拒绝的未提交请求仍生成 submitted 耗时

**优先级与状态：P3，待修复。**

[proxy.ts](../src/provider-proxy/proxy.ts) 第 803–805 行先标记指标和转储的 submitted 起点，随后第 815–834 行才在未缓冲路径检查声明的 Content-Length。超过 48 MiB 时本地 drain 后返回 413，不会走到 `flushHeaders` 或正文发送，却已经计算 submitted 总耗时，可能包含最多接近 5 秒的本地拒收等待。

[response-metrics-observer.ts](../src/provider-proxy/response-metrics-observer.ts) 第 171 行明确要求实际提交才记录；失败结算后该值经 IPC、Composition 进入指标库，再到详情及导出，转储也可能产生同基准计时。WS 第 1116–1122 行同样在辅助函数检查 OPEN 和发送前标记，相关失败分支应一起调整。

**建议调整：**已知大小超限的 HTTP 请求在提交计时前拒绝；WS 使用已有实际 submitted 回调，与请求字节计数保持一致。部分正文已经发送后才超限属于真实提交，应保留计时；缓冲路径的发送前拒绝不是这一 HTTP 缺陷。

**关闭条件：**隔离观察发送前拒绝、发送后超限、正常 HTTP、WS 关闭与正常提交，核对指标及转储起点。当前仅为源码证据；没有成功率、用量或费用错误的证据。

**处理记录：**第四轮新增；尚无修复、修复版本或复核证据。

## R29 管理安全专题与远程 Bearer 管理合同冲突

**优先级与状态：P3，待对齐。**

[管理接口安全专题](management-interface-security.md) 第 18–20 行禁止非回环管理写入，第 30–32 行仅允许回环 Origin；但 [WebUI 文档](webui.md) 第 143–148 行明确支持绑定 `0.0.0.0` 后凭 Bearer 进行远程/域名反代管理，Origin 与 Host 精确匹配。[webui-server.mjs](../scripts/webui-server.mjs) 第 387–418 行与后者一致，先验证令牌，再在远程模式下推导同站点 Origin，不信任转发头。

**影响与建议：**两个现行专题对同一已支持能力声明相反的安全边界，会误导部署和后续审查。对齐安全专题的监听/认证与 Origin 两节，分别说明匿名回环和已认证远程模式。此项不要求新增远程权限，也不是源码绕过鉴权或 R02 匿名 Host 问题的重复记录。

**关闭条件：**两份文档与实际分支的适用条件一致，仍明确原始转储仅限真实回环、高风险写入需要确认。当前仅记录差异，未改安全合同或运行远程管理。

**处理记录：**第四轮新增；尚无对齐修改或复核证据。

## 已完成检查

以下检查均在上述源码基线、Linux、Node.js `v24.22.1`、npm `11.19.1` 下完成，退出码为 0。它们反映静态及构建状态，不证明实际用户路径可用。

| 检查 | 观察结果 |
| --- | --- |
| `npm run check` | 类型、Gateway/CLI 版本兼容与模块依赖边界检查通过 |
| `npm run lint` | Gateway、CLI、Runtime、Scripts Lint 通过 |
| `npm run docs:check` | 审查基线的 82 个 Markdown 文件索引与本地链接检查通过 |
| `npm run lint --prefix webui` | WebUI Lint 通过 |
| `npm run i18n:check` | 2,135 个中文源键，中英文键及占位符一致 |
| `npm run protocol:check` | CLI `0.163.0` 与生成类型一致，公开 CLI 合同检查通过 |
| `npm run build --prefix webui` | WebUI TypeScript 与 Vite 构建通过 |
| `npm run build` | Gateway TypeScript 构建通过；Linux 不构成 Windows 原生产物验证 |

本机 Node/npm 与 CI 固定的 Node `22.23.4` 不同，没有据此宣称 CI 或安装路径已通过。没有编写、修改或运行行为测试，也没有读取远程 CI 状态。首轮加入本记录后，文档检查覆盖 83 个 Markdown 文件并通过。第二轮源码基线不变，复用以上静态及构建结果；补审记录及索引更新后的 `npm run docs:check` 同样通过，覆盖 83 个 Markdown 文件，索引与本地链接一致。

第三轮同样保持源码不变，复用既有静态及构建结果；更新后的文档检查通过，仍覆盖 83 个 Markdown 文件。`git diff --check` 未报告空白错误，未跟踪的本记录另以 `git diff --no-index --check /dev/null docs/project-closeout-review.md` 检查，未报告空白错误；后者的退出码 1 表示与空文件存在差异。未执行远程 CI、测试或运行故障注入。

第四轮更新问题、覆盖说明、根索引并新增 CSV 支持清单后，`npm run docs:check` 通过，仍覆盖 83 个 Markdown 文件；跟踪差异和两份未跟踪审查材料的空白检查均无报告。CSV 文件数量和状态统计由本轮精确阅读清单汇总，清单生成不构成代码验证。源码保持不变，未重复执行既有类型/构建检查，未运行测试或实际故障场景。

第五轮完成后，文档检查通过（83 个 Markdown 文件）；跟踪差异及两份未跟踪材料的空白检查均无报告，no-index 的退出码 1 仅表示与空文件不同。最终对账确认 CSV 共有 1,146 个唯一且均为 Git 跟踪的路径，全部为完整阅读；轮次分布为第五轮 966、第四轮 110、第三轮 70。问题总表与正文 45 个编号一一对应且顺序一致，优先级合计为 P1 3、P2 32、P3 10。所有分工报告已收齐，无任务进程或异步句柄遗留；工作树仅审查主文档、CSV 与根索引变化。以上属于材料一致性证据，不是业务运行验证。

## 审查覆盖与验证边界

前四轮由主代理与分工子代理审查模块及主要链路，第四轮开始保守记录精确文件阅读状态。第五轮由主代理继续应用、Core、审批、投递、Relay、路由和配套合同，分工审查 Runtime、WebUI、管理脚本、Bootstrap/Client、指标、Proxy 辅助及渠道；主代理复核报告并定向核对发现及跨模块消费。团队的完整阅读证据覆盖当前清单全部文件，不表示主代理独自重复全文阅读所有代理文件，也不表示外部平台或实际并发行为已经验收。

### 逐文件清单与最终统计

[逐文件阅读清单](project-closeout-file-inventory.csv) 是本记录的支持材料，不是另一份结论报告。基于同一源码提交，枚举跟踪的 `src`（排除协议生成目录）、`runtime`、`scripts`、`bin`、`webui/src`、根安装脚本、受支持的 `metrics-to-v32` 入口、CI/Hook、systemd/launchd 模板，再纳入根与 WebUI 的配置/构建入口。类型声明也逐文件计入；Markdown 合同继续由本记录引用，不计入此实现清单。依赖锁文件属于生成依赖清单，不按手写实现计入；第三方、历史工具、技能和二进制资产的排除仍按下文说明。

最终清单为 **1,146 个互不重复的跟踪文件**（初次所选目录为 1,126 个，加入 20 个根/WebUI 配套入口后更新）：

| 状态 | 数量 | 含义与下一步 |
| --- | --- | --- |
| 完整阅读 | 1,146 | 第五轮补齐 966；复用第四轮 110、第三轮 70。均有全文阅读及关联核对证据，不表示无缺陷或完成运行验收 |
| 定向阅读 | 0 | 第四轮的 27 项已补齐全文证据 |
| 待核对全读证据 | 0 | 第四轮的 939 项已逐批补齐 |

第四轮历史统计为完整 180、定向 27、待核对 939；以上是第五轮完成后的当前统计。清单只凭实际全文阅读及关联报告提升状态，不根据搜索命中、目录数或静态检查判定完成。源码变化后应重新核对受影响证据；剩余工作是开放问题修复与注明的运行补证，而非清单内未读文件。

### 第四轮完整补读与关联核对

- **普通 Proxy：**完整阅读 `proxy.ts` 全文，补齐 HTTP/WS 的路由、准入、正文处理、发送前拒绝、背压、排队、终态、取消与关闭；完整补读图片上传、运行时登记和计时/诊断辅助文件，新增 R28。`start/close` 并发疑点受生产 Runtime 等待 `instanceLaunches` 约束，未形成可达缺陷；未重复登记 R05、R07/R08、R15。
- **网络与环境：**完整阅读代理选择/发现、Codex `.env`、Fetch 包装、凭据环境隔离、App Server 基础运行时、Relay 服务、额度采集及 Gateway Fetch/网络观察/账户读取，补到相关声明文件。跨路径确认 URL authority 与连接 host 不同、重定向复用 Dispatcher 和额度正文限流缺口，新增 R24–R26。共享 Fetch 的 Dispatcher 未暴露 close 接口这一事实不足以单独证明持续资源泄漏，未新增该项。
- **WebUI 后端公共层：**完整阅读 HTTP 服务、认证/Origin、元数据/正文限制、确认、审计、管理公共分派与路由、服务状态/任务、指标导出、日志/转储/通知，以及维护命令 Worker 包装。完整阅读路由不等于重新全审其底层 Provider/模型事务；相关文件在 CSV 中分别记录。新增 R27、R29。
- **授权、队列与存储：**主代理完整阅读 `policy` 7 个、`event-bus` 3 个、`storage` 6 个文件，核对精确 Actor/账号、Workspace 冻结、关键事件及硬预算、合并/释放计数、关闭、SQL 提交后更新内存、前后台绑定转换/接管/撤权、重开恢复和会话展示缓存。对总线组合根观察者、缓存生产者/消费者定向追踪，没有仅凭文件阅读宣称运行正确。
- **应用辅助与计划任务：**完整阅读会话查询/缓存/选择器、分页与有界 Map、Turn 错误投影、会话缓存/错误类型、Thread 端口及状态同步；沿 resume/unarchive 追到绑定，新增 R23。补读 Schedule 日期/DST 算法、计划任务异步 SQLite Store/Worker/协议和 Row Codec；任务 SQL 与调度器本轮仍复用前轮路径证据，未提升为逐文件完整状态。Turn 原始错误投影仍属于 R05，未重报。
- **配套加载入口：**完整阅读主题前置脚本/HTML、Vite 代理与 TypeScript 配置、根 TS/ESLint/忽略规则，核对实际入口和构建消费；没有启动浏览器或将这些静态读取称为界面验收。

本轮三份子审查报告均已结束，未遗留任务进程或异步句柄。除新问题外，“未发现新增”仅表示当前源码证据不足以再登记缺陷，不能替代剩余文件补审。

| 边界 | 两轮已检查的关键路径 | 尚未观察或不在完整覆盖内的部分 |
| --- | --- | --- |
| 渠道与会话 | 三渠道授权、Workspace、绑定/接续/恢复/订阅；Turn 提交/归约；Outbox 长正文、媒体、完整附件及回执；模型、Hook、Skill/Plugin、MCP 与账户扩展 | 真实平台发送、格式拒绝/限流、MCP OAuth/资源、账户/券/Reserve 云端操作及迟到事件顺序 |
| 审批与任务 | 审批归属、令牌、期限/取消；投递额度及 uncertain 恢复；任务创建/确认/领取/重叠限制与 Schedule；Delivery 只读 Worker、取消和实际退出归属 | 真实审批、投递、调度、并发故障及各平台 Worker/helper 实际退出 |
| 管理与配置 | HTTP 安全与审计；Gateway/Codex 写入及未知结果；自定义 Provider 连接/模型事务及恢复；受管模型编辑/模板/新增；OCG provisioning；工具/搜索/WS/Relay 思考探测及前端采用 | 真实配置写入、跨进程竞争、故障恢复、付费探测与真实 TTY；WebUI 全部视觉、可访问性及每个呈现组件 |
| Relay 与 Proxy | 身份、授权、准入/队列、出站复核、Chat/Responses 转换、HTTP/WS 取消/背压、图片身份与指标；普通/Relay 转储写入、轮转、保留、读取和显式清理 | 真实上游调用、所有协议输入组合、并发读写、实际清理删除及存储故障 |
| 存储与组合 | 绑定库 v6、指标库 v32 单写者；SQL 聚合/递归范围/额度/十进制汇总；执行耗时及自动审查/子代理 trackers；EventBus、构造/关闭顺序及空闲屏障 | 真实用户数据库、超大数据性能、服务故障恢复及实际事件重入 |
| 安装与运行时 | CLI、更新/卸载、服务与 Supervisor；Windows Job/ACL/DPAPI/计划任务；Unix 私有文件、进程归属、launchd；Desktop 启用/回滚、桥、stdio Proxy、Host；Windows 安装与原生产物构建/加载 | 三平台实际安装、服务启停、进程回收和升级恢复；Windows ACL/DPAPI/原生 DLL、macOS 签名/Host；Desktop 双向接续及 CI 固定 Node 环境 |

### 模块与关键路径覆盖总账

按 [源码模块索引](../src/README.md)、[CLI 入口索引](../bin/README.md)、根包脚本和文件清单对账。以下覆盖当前产品模块和开发交付边界；“已审”仅指源码审查，问题仍按 R 编号开放。源码未变的前两轮证据继续有效，没有把本轮定向复核描述为重新逐行全审。

| 模块或交付边界 | 三轮累计已审的职责与链路 | 结论及主要未观察边界 |
| --- | --- | --- |
| `application` | 会话/扩展命令、模型选择、Queue 增删改序/启动、Revert 分页预览/确认、确认令牌及并发锁 | R03、R06、R11；实际上游提交及竞争未观察 |
| `approval` | 归属、完整预览、决定映射、超时、取消及外部已解决交互失效 | R01；真实批准未观察 |
| `bootstrap` | 组件装配、启动/停止/重载、tracker、异步提问、网络恢复、通知事件队列 | R20，R16 的目录注入；服务启动及重入未观察 |
| `codex-client` | JSON-RPC 关联/过载/期限、各 Transport、Turn/Queue/History、媒体上传及账户/扩展适配 | R03 相关权威状态链；各平台断线和真实 RPC 未观察 |
| `codex-protocol` | 受控导出、版本、生成器/一致性检查、所用字段及锁定上游消费 | 未发现新增项；生成目录按生成合同审查，不逐文件人工重审 |
| `config` | 严格配置、默认值、Workspace、代理、权限及 reload 分类 | R04、R17 相关共享入口；真实配置写入未观察 |
| `conversation-core` | Turn/Item 归约、终态、订阅、重复推理保护及应用消费 | R03；迟到事件次序未观察 |
| `event-bus` | 事件分发、订阅归属、错误传播与组合生命周期 | 未发现新增项；真实事件重入未观察 |
| `delivery` | 单写者、密文投递、额度、修订、重试/uncertain、只读 Worker 及退出 | 未发现新增项；真实投递与存储故障未观察 |
| `model-api` | 全部非生成转换实现；工具组/身份、私有项、图片归属、思考、用量及终态 | R15；外部协议输入组合及权威历史未观察 |
| `model-relay` | 独立身份、Key、模型授权、准入/排队、指标 IPC、生命周期 | Astra 复审更正：独立 Relay 入库明确清空 errorMessage，不属于 R05 的同类泄露路径；真实 Relay 请求未观察 |
| `provider-proxy` | 普通/聚合路由、HTTP/WS、Chat/Responses、搜索续轮、取消/背压、转储保留 | R05、R07、R08、R15；真实上游、慢交付、删除未观察 |
| `observability` | 安全日志、指标写入/查询、SQL 范围、耗时、十进制累计、导出及展示消费 | R05、R14；用户库、超大规模与性能未观察 |
| `policy` | Actor/Workspace 授权及外部输入能力边界 | 未发现新增项；真实平台身份和撤权未观察 |
| `scheduled-tasks` | 创建/确认、计划、领取、额度、重叠及结果生命周期 | 未发现新增项；实际调度及并发未观察 |
| `session-routing` | 绑定唯一性、接续/恢复、后台保留及释放 | 未发现新增项；多客户端真实接续未观察 |
| `storage` | 当前绑定 schema、读写合同、恢复状态及单写者 | 未发现新增项；用户数据、磁盘故障未观察 |
| `surfaces` | 三渠道接入、授权、审批、Outbox/媒体、OAuth/凭据、微信诊断 | R01、R16、R21；平台登录、发送、限流和跨用户访问未观察 |
| `webui` | 全部 15 个 pages 模块及路由、认证、API/SSE、缓存、草稿、确认、指标/导出、投递、Relay、日志/转储、语言 | R22；R02、R04、R05 等后端问题保持开放；浏览器布局、焦点、辅助技术、下载未观察 |
| `bin` 与管理 `scripts` | 所有公开命令分派；Init/Setup/三渠道登录、Workspace、Skill/MCP、视频 MCP、Provider/模型、备份、时区、Doctor、维护 | R04、R06、R09、R10、R17、R18；TTY、配置写入、外部调用未观察 |
| `runtime` | 私有文件/锁、配置/凭据、Supervisor/IPC、进程及服务所有权、模型目录、Desktop、Windows native helper | R12、R13、R20；三平台真实 helper 与进程回收未观察 |
| 安装、升级与服务模板 | 源码/prepared 安装、npm 生命周期、清理构建目录、systemd/launchd/Windows、更新/回滚/卸载、受支持指标 v31→v32 | 源码链已审；实际安装、备份恢复、权限和服务激活未观察 |
| CI、Hook 与生成/维护脚本 | CI/升级 Draft、提交范围选择、模块边界/文档/版本检查、协议生成/比较、升级报告与模型模板生成 | R19；远程 workflow、CI 固定 Node 和跨平台构建未在本轮执行 |
| 文档、schema、配置及目录快照 | 用户入口、模块职责、专题合同、现行数据库 schema、协议及模板来源/消费者 | R14 等差异逐项记录；索引/链接静态检查不等于全部文字语义正确 |

没有把第三方依赖、`upstream/` 整仓、生成代码逐行审计、历史快照、旧版数据库升级工具、`.codex/skills`/`.agents/skills` 和未跟踪独立项目算入当前产品覆盖。上游只读取与合同有关的锁定源码；历史 v31 schema 因受支持的 v32 升级消费而纳入相关链路，其余历史材料未扩展审查。静态图片资产未做二进制安全审计。表中的平台/外部行为限制明确保留，不以模块已读替代运行验收。

### 第三轮补审的具体边界

- **完整前端：**核对全部页面路由和错误恢复；令牌提取/存储、鉴权、请求取消与迟到结果；SSE 断线/重连和快照 revision；服务器时间/DST/范围刷新；账户并发合并、指标范围/分页/排序与二进制导出；设置草稿、导航阻挡、未知写入回读；任务 ID 取消及终态刷新；投递 `id + revision` 确认；Relay Key 的一次性秘密；日志目标隔离和转储 `label/session/id` 锚定。共享组件按调用消费核对，未声称对每个 shadcn 包装文件逐行审计。新增 R22。
- **初始化与独立工具：**Init 的默认目录和取消、Setup 路由与 JSONL 分流；Telegram 配对、飞书注册 Worker、微信二维码/凭据事务及三渠道最终配置写入；Workspace 注册/默认/移除和事件消费；Skill 安装/卸载；MCP 四类增改删和 Strata 路径；视频 MCP 从 JSONL 准入、取消到文件身份、上传映射、Responses 终态；备份、时区和诊断。新增 R16–R18、R21。配置 writer 的源修订检查有效，未把异步读取间隙误报为渠道配置丢更新。
- **协议转换与 Client：**完整阅读 model-api 非生成实现、Chat bridge/IO/direct transports、hosted-search 和 aggregate proxy；核对工具组全量校验、名称映射、自由格式、图片/私有项、续轮 ID、用量与终态。Client 补齐 JSON-RPC、所有 Transport 及 Turn/Queue/History 适配，核对超时、断线、请求代次、写请求不重试及上游消费。新增 R15；普通 Proxy 本轮按协议/终态定向复核，其余路径复用前轮证据。
- **开发交付：**读取 CI、升级预览/提案与 PR 描述检查、Hook、范围选择、编译产物准备/清理、发布解析/阶段验证/报告、协议生成与公开 CLI 合同、模块边界和文档检查、模型模板更新；补读受支持指标升级入口与私有备份、事务/回滚、逐表保持和高水位检查。发现 R19。另记录现有 Windows CI 的 PowerShell 语法解析仅枚举 `install.ps1` 和 `scripts/*.ps1`，未包含 `runtime/*.ps1`；本轮未发现这些 helper 的具体语法错误，不将静态门禁范围缺口当作已发生的运行故障。
- **组合与辅助路径：**补读 Revert 与 Queue 的完整确认/分页链、排序多锁、重复推理保护、异步提问期限/关闭、网络恢复、Git Workspace 状态期限、配置 reload、配置/指标/队列事件 IPC、模型模板绑定、Responses 上下文同步及 agent roles。新增 R20，其余未形成确证新增项。

### 第二轮补审的具体边界

- **渠道与扩展：**Telegram Outbox 到 text streams、HTML/纯文本分片及 API executor；飞书到正文卡片、完整答案文件、message port 和 SDK 取消上下文；微信到回复窗口、AES/CDN 上传和最终消息。核对“预览成功”与“完整附件成功”、创建结果未知后停止重发、关闭及检查点归属。模型目录路由发现 R11；Hook 核对完整预览、一次性确认、版本/哈希及多实例刷新；Skill/Plugin 核对提交前重新解析；MCP 核对 OAuth 关联、资源投影及断线清理；账户扩展核对快照、重置券单次消费及 Luna Reserve 结算。
- **Provider 事务：**自定义连接、模型、保留默认的单项能力保存全部计划分支；固定/切换模式、凭据版本、目录 journal、未知结果及条件恢复。受管模型编辑保留 ID/路由，模板更新核对来源、字段范围和候选期限，新增核对继承/手填及仅追加。OCG provisioning 补齐新增、重配、共享目录、两种模式转换、联系字段、无变化、恢复与账户移除的关联。新增 R09、R10；没有关闭既有事务实机补证事项。
- **主动探测：**工具探测两种协议及模拟回程，原生搜索的精确账户/模型材料，WS prewarm/generate，Relay 九种思考方式的顺序预算、取消及 NDJSON 背压。追到 CLI/前端身份、迟到结果、采用草稿、连接令牌与保存；未执行任何实际出站探测。
- **指标与组合：**请求/模型/异常/时间桶、Thread 树、精确父 Turn、子代理和审查范围 SQL，核对 `UNION` 去重及 `threadId + turnId` 关联；检查额度窗口、采集顺序和十进制累加；追到 CLI、WebUI 关键摘要及完成统计。补读 `TurnExecutionTracker`、`AutoApprovalReviewTracker`、`AutoApprovalReviewNotifications`、`SubagentCompletionTracker` 及组件图接线；未发现新的范围串用，另记 R14 的排序表述差异。
- **转储与 Worker：**普通/Relay storage 到保留策略、App Server 启动清理、CLI/WebUI reader 及显式 cleanup，新增 R07、R08。Delivery reader/queue reader 补齐批量修订、解密投影、容量、取消、关闭及未退出 Worker 保留所有权。Provider snapshot 与 Relay material Worker 补齐私有读取和 ACL 关闭链；Unix 同步读取另记 R12。
- **平台与 Desktop：**读取 Windows native C# 的目录句柄/reparse 防护、父进程身份、原子 Job 绑定及回收，ACL bridge/helper 的期限和句柄退出，DPAPI/secure record、服务 host/control/launcher/计划任务；检查 native 构建 manifest/hash 加载、`install.ps1` 和 prepared 安装消费。macOS 补读 launchd 控制、Desktop 签名 Host、stdio Proxy、桥接队列和关闭，Desktop 命令的配置锁、回读、条件回滚及只读 status。Thread Writer Lock 诊断及调用方发现 R13；无平台实机结论。

本地官方参照仍为锁定版本：Codex HEAD `83086188ae0614bd882818ff1aa23f3194962012`，微信 HEAD `43675b66551d12d6853155a7869a50fb12a18a1e`，飞书 SDK HEAD `e34a66f0d20935ee77f94909d16d93292d58b6c7`。补审核对了受影响的模型目录、Hook/Skill/Plugin、MCP、账户及媒体接口；公开 SDK 源码的提交身份不等同于 npm 发布包身份。未更新、拉取或修改上游参照。

已有持续验收入口仍然有效：[渠道验收](channel-acceptance-matrix.md)、[Desktop 验收](codex-desktop-app-acceptance.md)、[Provider 事务补证](provider-transaction-review.md)、[Windows 开发边界](windows-support-development.md)。本轮审查不关闭这些文档中的开放事项。

## R30 自动终端标识通过探测却超出配置总长限制

**优先级与状态：P3，待修复；长环境值仅作源码推导。**

触发条件是终端名与版本分别符合字符规则，但组合后的总长度超过 64。例如各为 32 个 ASCII 字符时，加上 `/` 得到 65 字符。

**证据链与影响：**[terminal-identity.mjs](../runtime/terminal-identity.mjs) 第 57–60 行的 `detectTerminalIdentity` 只检查正则；[gateway-config.mjs](../runtime/gateway-config.mjs) 第 145–154 行的正则允许名称与版本各 64 字符，但 Schema 另限总长 64。[config-management.mjs](../scripts/config-management.mjs) 第 266–278 行把非空探测值交给共享设置 writer，因总长校验被拒绝；[service-command.mjs](../scripts/service-command.mjs) 第 103–116 行明确捕获该失败并继续服务操作，因此不属于安装阻塞或非法值落盘。[config-system-menu.mjs](../scripts/config-system-menu.mjs) 第 383 行也会预填该无效值，用户需要缩短。

**建议调整：**可落盘标识探测复用完整配置约束，包含总长；保留 User-Agent token 探测的独立上游语义。已有配置会跳过自动记录，短标识不触发，不需要改动用户数据格式。

**关闭条件：**核对长标识不再成为可保存候选，短标识与已有配置路径保持正确；后续实现时隔离观察安装记录和配置预填路径。当前未设置模拟环境执行，也未写入用户配置。

**处理记录：**尚无修复、修复版本或运行复核证据。

## R31 轮次失败列仍显示合同要求省略的零值

**优先级与状态：P3，待修复。**

**触发与证据：**[turn-table.tsx](../webui/src/components/threads/turn-table.tsx) 第 118–126 行直接渲染 `requestOutcomes.failed`，值为零且列可见时仍产生 `0`。[WebUI README](../webui/README.md) 第 153、155 行明确要求统计零值留空，并省略失败数为零的失败项；相邻中断、未完整列已使用空值投影。

**影响与建议：**会话详情的轮次显示与共同呈现合同不一致，服务端数据不受影响。仅调整零值单元格显示，保留排序 accessor、非零失败数及原始指标。

**关闭条件与处理记录：**尚未修复；实现时观察零值与非零值的可见列显示及排序。当前为源码证据，未观察浏览器。

## R32 两处英文加载状态仍使用中文辅助名称

**优先级与状态：P3，待修复。**

**触发与证据：**[spinner.tsx](../webui/src/components/ui/spinner.tsx) 第 7 行默认 `role="status" aria-label="加载中"`。[provider-model-addition-dialog.tsx](../webui/src/components/settings/provider-model-addition-dialog.tsx) 第 101 行读取候选期间，以及 [reset-credit-action.tsx](../webui/src/components/overview/reset-credit-action.tsx) 第 58 行确认消费期间，均未覆盖标签或设置 `aria-hidden`。英文界面也会继承中文辅助名称，旁边按钮文字已有翻译。

**影响与建议：**这两个入口的辅助技术文案与当前语言不一致。业务调用方传入 `t("common.loading")`，或在图标仅装饰、相邻文本已说明状态时隐藏图标；不要求基础组件依赖语言上下文。多数其他调用已经覆盖标签，不能泛化为全部加载状态遗漏；也不同于 R22 的服务读取错误。

**关闭条件与处理记录：**尚未修复；实现时检查中英文状态的可访问名称及读屏消费。当前未运行浏览器或读屏。

## R33 WebUI 文档残留不存在的目录入口和旧耗时展示

**优先级与状态：P3，待对齐。**

**证据链：**[WebUI README](../webui/README.md) 第 345、351 行声称 Relay 有目录更新入口并引用不存在的 `hooks/use-relay-catalog.ts`；[WebUI 专题](webui.md) 第 229、233、716 行仍描述目录下载入口、高风险额度和更新通知。实际 [relay-provider-models.tsx](../webui/src/components/settings/relay-provider-models.tsx) 仅提供只读模型表及读取失败后的刷新，没有该下载操作。专题第 7 行另承诺总耗时缺失时 `*` 和缺失轮数、全未知 `—`；实际 [thread-table.tsx](../webui/src/components/threads/thread-table.tsx) 第 202–208 行只显示非零已知耗时，README 第 153 行也已规定统计零值或缺失留空。

**影响与建议：**用户和维护者会寻找当前不存在的入口、Hook 或展示标记。按当前源码和已确立的共同显示规则统一模块与用户文档，不为满足残留说明恢复已移除入口。模型目录展示、OpenAI 目录刷新和普通数据刷新仍存在，不能描述为全部目录能力缺失；没有证据认定功能回归。

**关闭条件与处理记录：**尚未调整现行文档；后续对齐用户入口、模块文件索引、实际组件及调用方，并通过文档检查。当前已核对源码和引用，没有执行目录下载。

## R34 MCP 工具参数截断后仍允许批准完整操作

**优先级与状态：P1，待修复；未发送实际审批。**

**触发与证据链：**[server-request-adapter.ts](../src/codex-client/server-request-adapter.ts) 第 328–413 行接受完整 `tool_params_display`；[coordinator.ts](../src/approval/coordinator.ts) 第 627 行起仅展示前 10 项、每项名称前 100 字符和值前 300 字符，其余只提示数量。第 289–350 行仍允许一次及上游提供的 session/always 批准，响应针对完整调用。锁定 Codex 源码 `codex-rs/core/src/mcp_tool_call.rs` 第 1897–1980 行确认默认 message 只是服务器/工具的批准问题，不包含参数；参数独立放在 meta，不能靠 message 恢复被截内容。

**跨渠道影响：**飞书 [input-card.ts](../src/surfaces/feishu/input-card.ts) 第 212–263 行还对 message/detail 各截为 1000 字符，仍生成批准按钮；Telegram 虽分块、微信虽拒绝超过整条上限的提示，两者收到的参数已经在 Coordinator 丢失。参数超过 10 项或危险目标位于长字符串尾部时，用户无法核对完整操作。此根因属于共用 MCP 参数投影，与 R01 的飞书命令面板截断分别处理。

**建议与关闭条件：**在共同层建立完整且无歧义的参数预览，超出可完整显示范围时拒绝或引导原生客户端核对；各 Surface 不得再截断可批准信息。保持上游允许的持久范围及响应语义，核对多参数、长值、格式控制字符与三渠道交付。当前仅有源码及锁定上游证据，尚无修复或运行复核。

## R35 Workspace 写入已提交后撤销新增通知事件

**优先级与状态：P2，待修复；异常锁释放未实测。**

**触发与证据链：**[workspace-config.mjs](../scripts/workspace-config.mjs) 第 126–138 行先入队新增 Workspace 事件，任何配置写入异常均调用 `acknowledgeConfigEvents` 删除它。[gateway-config.mjs](../runtime/gateway-config.mjs) 第 418–453 行却明确定义了文件原子写入已成功、随后锁释放失败的 `GatewayConfigWriteCommittedError`。此时新 Workspace 已生效，但调用方误当未写入而撤掉事件并抛错。[config-lifecycle.ts](../src/bootstrap/config-lifecycle.ts) 第 291–347 行的通知依赖保留事件匹配当前配置，再交给 SurfaceManager；事件被撤后，后续 reload/restart 不能恢复该通知。

**影响与建议：**新增/创建 Workspace 可能同时出现“配置已保存、CLI 报失败、渠道无新增通知”。区分未提交失败与已提交清理警告：前者撤事件，后者保留并反馈保存状态；核对 CLI/Setup 的共享调用结果。删除 Workspace 的外层释放错误可能误报保存结果，但没有相同新增事件撤销分支，不泛化此缺陷。

**关闭条件与处理记录：**隔离观察写前失败和写后锁释放失败，确认事件和落盘状态一致、通知仍可消费且不重复。尚未修复，未改用户配置或注入文件系统故障。

## R36 Telegram 撤权未覆盖实时正文与显式图片输出

**优先级与状态：P2，待修复；没有进行真实撤权或发送。**

**触发与证据链：**已绑定 Telegram 会话仍在产生回答时热移除该用户。[surface-composition.ts](../src/bootstrap/surface-composition.ts) 第 408–413 行只替换访问策略和通知接收人，保留绑定与文本流。持久最终正文有授权守卫，但 [persistent-output.ts](../src/surfaces/persistent-output.ts) 第 23 行将 `text.delta` 排除；[surface-manager.ts](../src/bootstrap/surface-manager.ts) 第 207–240、878–907 行的实时路径直接交给 Surface。[text-streams.ts](../src/surfaces/telegram/text-streams.ts) 第 236–304 行继续 send/edit，没有访问策略复核，最终正文拒绝不能收回此前已输出的增量。

**另一路径：**[channel-image-spool.ts](../src/bootstrap/channel-image-spool.ts) 第 185–190 行按 Thread 取当前绑定后调用发送；Telegram [outbox.ts](../src/surfaces/telegram/outbox.ts) 第 672–703 行读图并排队 `sendPhoto`，同样不检查已撤销的允许名单。当前文档明确规定 spool 消费时解析目标，因此绑定转移后选新目标本身不单列缺陷；修复时须明确队列等待后的归属与授权。

**反例与建议：**微信实际 `sendImage` 在读图前后均检查 access，不能因共有入口无检查就推断全部渠道受影响。飞书撤权会清理绑定，保护范围也不同。统一覆盖 Telegram 实时输出及显式图片的执行时授权，取消被撤权流并核对等待期间变更；保留其他会话输出。关闭条件是隔离观察撤权前后增量、排队图片与正常允许用户路径。尚无修复或运行证据。

## R37 Gateway 同步版本校验没有等待期限

**优先级与状态：P2，待修复；异常 CLI 挂起未实测。**

**证据与影响：**[gateway-component-graph.ts](../src/bootstrap/gateway-component-graph.ts) 第 251 行在组件构造中调用版本检查，第 2397–2406 行 `spawnSync(... --version)` 没有 timeout。受支持的显式 CLI 路径若挂起，Gateway 主线程一直被阻塞；[config-lifecycle.ts](../src/bootstrap/config-lifecycle.ts) 虽在构造前安装信号与停止处理，但 JavaScript 信号回调及关闭定时器均不能在此同步等待中执行。这覆盖三个系统，区别于 R13 的 Windows 占用诊断 helper。

**建议与关闭条件：**把版本校验纳入可取消、有限预算且保留子进程归属的启动阶段，停止后不再发布就绪；核对正常版本、不匹配、执行失败及不退出子进程。超时不等于清理成功，仍需确认所启动进程实际结束。当前只核对源码链，未启动挂起进程，尚无修复。

## R38 三渠道排队音视频晚于 stop 登记取消范围

**优先级与状态：P2，待修复；排队竞态未实测。**

**合同与触发：**用户指南规定 `/stop` 取消当前目标尚未提交的音视频准备，Application 要求在等待前序输入前登记取消范围。若音视频已经被渠道接收、仍在前序输入后排队，紧急 `/stop` 却先执行，取消集合中尚无该输入；队列随后执行时才新建范围并可继续提交。

**关联证据：**Telegram [lifecycle.ts](../src/surfaces/telegram/lifecycle.ts) 第 260–279 行同一批次先执行紧急控制，之后普通输入入队；[bot.ts](../src/surfaces/telegram/bot.ts) 第 1121、1360 行在音视频 handler 执行后才调用 `prepareAttachmentSubmission`。微信 [updates-monitor.ts](../src/surfaces/weixin/updates-monitor.ts) 第 99–109 行等待前一消息，[conversation-adapter.ts](../src/surfaces/weixin/conversation-adapter.ts) 第 145–149、459 行再次串行，直到第 165、204 行才登记。飞书 [inbox.ts](../src/surfaces/feishu/inbox.ts) 第 219–240 行把 stop 独立执行、普通消息入队，第 337–342 行顺序调 handler；[adapter.ts](../src/surfaces/feishu/adapter.ts) 第 792、843 行才创建范围。[conversation-service.ts](../src/application/conversation-service.ts) 第 1382–1388 行只能取消当时已登记的控制器，无法覆盖未来创建的范围。

**建议与反例：**取消身份应在接收并确认目标后、进入任何等待队列前捕获；通过入队范围或取消代次让已接收旧输入不能在 stop 后复活。仅移动到 Adapter 内 `flushPending` 前无效，当前已经这样做；stop 后新收到的独立输入应仍可正常提交。后续核对三端同批和跨批、慢前序输入、尚未绑定目标及正常取消。尚未修复或进行平台观察。

## R39 微信普通通知在关闭时丢失取消信号

**优先级与状态：P2，待修复；未观察真实关闭后的发送。**

**微信证据：**[outbox.ts](../src/surfaces/weixin/outbox.ts) 第 274 行先设置 closed，再关闭队列；第 356、373、450、495 行却在 closed 后把传入 signal 改为 undefined。`conversation-adapter.ts` 的普通命令/失败通知及 `surface.ts` 的通知通过 `notifyText → enqueueText → send` 进入无 receipt 队列。共享 [conversation-delivery-queue.ts](../src/surfaces/conversation-delivery-queue.ts) 第 303–307 行中止 worker，但第 372–374 行对没有 receipt/requestSignal 的普通操作仍调用 `run`；此类已排队通知取得被中止的 worker signal 后，被 Outbox 擦掉取消，分片可继续发起请求。等待关闭的有限预算到期不保证这些实际调用结束。

**关联反例与范围更正：**Telegram 部分事件回调也未传入 worker signal，但对应生产事件经持久输出或 SnapshotDelivery，receipt/checkpoint 另行约束实际发送。只看局部回调不足以证明生产可绕过关闭，故不将其列为同样已确认的受影响路径。微信可靠 receipt 路径也有额外保护，本项限定可到达的普通通知链。飞书消息窄端口另绑定关闭信号，未发现相同链路。

**建议与关闭条件：**保留并贯穿 worker、单请求和关闭信号，每次新平台调用前核对；若选择排空，使用队列统一的 drainOnClose 预算，而不是擦除取消。核对排队普通消息、多分片、文件回退、读图等待及关闭到期后无新调用。尚未修复，未发送平台消息。

## R40 微信音频后附文本被静默丢弃

**优先级与状态：P2，待修复；未确认平台是否实际生成该组合。**

**源码反例：**[inbound-message-parser.ts](../src/surfaces/weixin/inbound-message-parser.ts) 第 171–195 行的文本分支只拒绝重复文本，不拒绝先前音频；第 199–216 行的音频分支却拒绝已存在文本。因此同一组条目按“文本→音频”排列被拒绝，按“音频→文本”排列则解析成功，最终第 240 行起返回 audio 时没有带 text。[conversation-adapter.ts](../src/surfaces/weixin/conversation-adapter.ts) 只消费音频引用和 voice_item 转写，无法恢复被丢的独立文本。

**影响与建议：**遇到该输入形状会静默丢失用户文字，排列顺序改变接受语义。当前没有混合音频与文本的完整支持合同，优先在解析边界双向拒绝；如果确需支持，则先明确组合语义并完整传递，不把 voice_item 的转写当作独立用户说明。该项是输入边界反例，不声称常规微信客户端已经发生丢字。尚未修复；关闭需核对两种顺序、独立音频、带转写音频和独立文本。

## R41 macOS 飞书损坏凭据被当作未授权

**优先级与状态：P2，待修复；未访问用户 Keychain。**

**证据与影响：**[oauth-token-store.ts](../src/surfaces/feishu/oauth-token-store.ts) 第 65–74 行的 macOS get 对已找到记录直接返回 `parseStoredToken`；第 145–200 行遇坏 JSON、身份不符、空 Token 或非法期限会返回 null。相同文件第 101–108 行的加密文件实现则区分“记录缺失”和“载荷无效”，后者抛错。[oauth.ts](../src/surfaces/feishu/oauth.ts) 的状态读取、授权准备及撤销消费 null：坏记录会显示 missing，继续新授权可覆盖它，撤销删除后却返回原来没有凭据。不会使用错误身份 Token，但损坏信息被静默抹成缺失。

**建议与关闭条件：**让 Keychain 已找到但无效的载荷抛出脱敏的明确错误，保留未找到的 null 语义；与加密文件后端统一状态及恢复处理。核对缺失、坏 JSON、身份错配、合法过期和正常凭据；撤销仍可按显式请求清理损坏记录并报告真实结果。尚未修复或运行异常凭据场景。

## R42 飞书应用配置任务在撤权后继续特权写入

**优先级与状态：P2，待修复；未进行飞书应用写入。**

**触发与证据：**用户点击 `/fs doctor` 的自动配置按钮时仍获授权，但在卡片更新、官方扫码或检查等待期间被移出允许名单。[application-setup.ts](../src/surfaces/feishu/application-setup.ts) 第 130–157 行仅在点击时检查 access；第 188–283 行后续等待后直接调用 `configureApplication`，没有再次验证 pending Actor。[surface-composition.ts](../src/bootstrap/surface-composition.ts) 第 446–454 行热撤权更新策略和绑定，却不取消此 Setup 任务。[application-api.ts](../src/surfaces/feishu/application-api.ts) 第 319–395 行检查后依次 patchAbility、patchConfig、publish，其 signal 只关联 controller 关闭，没有 Actor 撤权守卫。

**影响与建议：**撤权生效后仍可能修改并发布应用菜单、事件与回调，属于先前有效动作跨异步等待后的权限缺口。控制器每次进入后续特权阶段应核对当前 Actor，并在撤权时取消相关任务；多阶段 API 写入也需接收守卫或取消范围，不能只在整个 configureApplication 之前检查一次。已完成的远端写入不能伪称撤销，应保留明确阶段与结果。

**关闭条件与处理记录：**隔离核对初次卡片等待、扫码完成、检查返回及各写入阶段间撤权；保留仍授权 Actor 正常配置和全局关闭。尚未修复；本项只依据本地授权/调用链，不推断飞书平台已发生异常。

## R43 Relay 指南称等待转储初始化但实际跳过采集

**优先级与状态：P3，待对齐。**

**证据链：**[用户指南](user-guide.md) 第 1209 行声称首次启用会等待异步容量初始化；[model-relay-service.mjs](../runtime/model-relay-service.mjs) 第 75–85 行却在后台 `void dump.prepare()`，模型请求直接调用 `dump.begin`。[relay-traffic-dump.ts](../src/provider-proxy/relay-traffic-dump.ts) 第 101–112 行对未 ready 的调用返回 undefined 并记录 initializing/capture skipped。模块 README 也明确模型请求不等待磁盘。

**影响与建议：**用户开启后立即发起请求，模型可正常完成但没有转储，指南却暗示会等待并采集。按实现统一用户说明：初始化期间跳过、ready 后仅采集新调用，现有预算和故障日志保留；不为满足旧说明让模型请求等待磁盘。尚未改动现行指南；未请求真实 Relay 或模拟慢磁盘。关闭时对齐指南、模块合同与组合入口。

## R44 飞书旧模型卡按新的 Provider 筛选解释选择

**优先级与状态：P2，待修复；未点击实际飞书卡片。**

**触发与证据：**打开 Provider A 的模型卡，再通过另一命令或卡片浏览 Provider B，随后点击尚未失效的 A 卡模型；当 A/B 存在相同模型 ID 时可能选择 B 的模型。[command-center-presentation.ts](../src/surfaces/feishu/command-center-presentation.ts) 第 696–707 行按钮仅保存 `model.id`。[command-center.ts](../src/surfaces/feishu/command-center.ts) 第 116–126、326–395 行校验目标、Actor、消息、按钮及期限，没有保存 Provider/selectionScope；`acceptedStates` 只是呈现内容。[adapter.ts](../src/surfaces/feishu/adapter.ts) 第 467–470 行把字符串交给命令执行。[model-selection-service.ts](../src/application/model-selection-service.ts) 第 181–193 行按当前 providerFilter 解析字符串，第 764–780 行又明确允许官方目录映射到不同 Provider 时保留原 ID。

**影响与建议：**旧卡显示的提供商与实际选择不一致，可能切到另一账户/服务。飞书模型动作应传精确 provider/model 并绑定选择时的 Workspace/Thread/Session 和设置快照，变更后拒绝过期选择；关联核对旧 effort/fast 卡，不凭相似形式直接宣称同样故障。Telegram 已使用完整 state/selectionScope 与精确身份，是不同合同的反例。尚未修复；关闭需核对同 ID 跨 Provider、旧卡、设置变化和正常选择。

**Astra 复审补充：**已进一步沿 `command-center` 的 pending/字符串选择及 `model-selection-service.ts` 的 `selectEffort`、`selectFastMode` 核对，旧 effort/fast 卡也会按后来当前模型/会话执行合法选项。因此 R44 修复包同时覆盖三类卡，快照守卫必须延续到 Application 异步等待后的实际偏好或默认值写入前；普通文本命令仍按当前状态解释。此补充取代上段尚待关联核对的状态，不代表已经点击平台卡片或修复代码。

## R45 微信完整答案附件保存的是有损展示文本

**优先级与状态：P2，待修复；未发送平台文件。**

**证据链：**[outbox.ts](../src/surfaces/weixin/outbox.ts) 第 326 行先对 text.completed 使用 `formatWeixinFinalText`，后续长文路径第 380 行直接 `Buffer.from(text)`，第 418 行确认完整内容。[final-text-format.ts](../src/surfaces/weixin/final-text-format.ts) 第 60–64 行会彻底移除 Markdown 图片，包括说明和 URL。因此一段仍超过气泡容量、文件大小在上限内的长正文含 `![图的说明](https://example.test/report.png)` 时，完整附件已缺少这些原文，却可确认成功并清除 Journal 原文。[投递合同](delivery.md) 第 46 行要求完整附件及检查点确认后才清除原文，微信 README 未提供有损附件的例外。

**建议与范围：**保持原 `event.text` 作为完整附件字节来源，兼容格式转换只用于气泡/预览；确认完整性的对象须与持久原文一致。短正文如何呈现 Markdown 由展示合同决定，本项不要求气泡逐字显示格式符号；只针对承担全文保留责任的附件。尚未修复，关闭需核对长正文中的图片标记、代码/强调格式、UTF-8 大小上限和完整附件确认后的清理。

## 第五轮逐文件关联审查汇总

本轮按逐文件清单补齐 966 项完整阅读证据，已有完整证据仅在关联不明时定向复核。业务源码保持只读，逐批报告与发现核对后登记。下列为本轮最终关联汇总；与前四轮证据合并覆盖全部清单。

- **计划任务定义到执行结果：**完整补读 `scheduled-tasks` 的类型、导出、Scheduler、schema、SQLite Store，以及 Bootstrap 的五个计划任务文件、Application 的命令解析/用例/动态工具。核对命令与模型工具到一次性确认、Actor/Conversation/Workspace/模型/权限复核，再到 SQL 容量和领取事务、同会话串行派发、独立 Thread 提交、无人值守审批拒绝、提前终态、恢复和保留清理。工具创建/删除仅生成预览，未交付确认在取消后撤销；写入已提交后仍结算结果。计划任务启动响应的 Core 状态问题并入 R03，不重复编号。
- **反例核对：**容量与重叠约束在 SQL 事务中再次检查；手动重试仅在替代 Run 成功领取的同一事务中解除旧 uncertain；运行恢复按精确 Turn 历史收敛，不因 Thread 空闲推断成功。以上不列为缺陷。未知写入、跨平台文件系统与真实服务行为仍未运行观察。
- **Application 与 Core：**补齐应用命令、服务、接口及 Core 事件/归约/计时的逐文件阅读。关联渠道授权守卫、等待锁后的原 Thread 核对、附件捕获和停止、普通提交/steer、跨渠道接管双锁、后台订阅释放、原生 Queue 屏障、模型/Plan 待生效选择、Hook 配置版本与完整审查门禁、MCP 提前 OAuth 完成、重置券一次性消费与 Luna Reserve 代次失效。既有 R03、R11、R23 保留；未将所有后台释放或设置提交都归成同一竞态。账户通知只由 Routing Client 放行 OpenAI 来源，因此 Core 的单账户缓存不能仅凭未按 Provider 分桶就判定串账户。计时以 Turn ID 匹配，缺失用量不直接当作零覆盖。
- **Runtime 全部清单项：**收齐并核对本轮 161 项完整阅读报告，均已登记 CSV。关联私有文件/Windows ACL 与凭据消费、IPC 帧与所有权、Supervisor 每 Provider 队列与租约、目录及凭据事务到启动/Proxy/Relay、Worker 取消后物理退出、Desktop 启动收尾、四份模型 JSON 到创建和运行副本。新增 R30；保留 R12/R13/R20 等既有问题。Windows/macOS/Linux 服务及异常资源行为仍未实测。
- **WebUI 全部清单项：**收齐本轮 210 项精确完整阅读报告并定向核对发现，均已登记 CSV，包括全部页面、44 个 hooks、基础 UI 和 3771 行中英字典。关联令牌加载、API/SSE/导出、查询范围和 revision、草稿/确认/未知写入回读、账户并发、探测采用、投递批量修订、调用详情锚定、日志、焦点与字典加载。新增 R31–R33；R22 保留。阅读覆盖不等于浏览器布局、焦点、辅助技术或真实账户功能验证。
- **安装与管理入口：**收齐 271 项逐文件报告，涵盖 scripts 259、bin 2、根安装器 2、systemd/launchd 模板各 4；补齐配置、账户、模型目录、服务、Desktop、主动探测、维护与 API 类型的调用消费。新增 R35，R17 同根覆盖还涉及服务安装和 Desktop 二进制选择。`metrics-command-options.d.mts` 残留 upgrade/rollback 类型键、`setup-summary.d.mts` 声明运行值不存在的 agent 字段，当前未发现消费者取值，作为低影响声明漂移附注而非新增业务故障。真实 TTY、服务激活与付费诊断未观察。
- **Bootstrap 与 Client：**收齐 57 项逐文件报告（32 Bootstrap、24 Client、main），补齐组合、Provider 生命周期、Thread/Turn/Queue/Review/Goal、通知投影、图片上传及扩展能力的授权和关闭链。新增 R36/R37；主代理另补完 Server Request adapter 和全部 Approval 文件，沿三渠道与锁定上游确认 R34。未运行真实 App Server 或渠道任务。
- **Delivery、Relay 与路由：**主代理完整补读 Delivery 11 文件，核对加密身份绑定、单写者、容量预留、pending/sending/uncertain、修订批处理、逐条 ACK 读取和取消后资源归属；完整补读 Relay 4 文件的鉴权、撤销代次、公平准入、出站前材料核对、交付终态及指标单次结算。Router 全文关联 Application/Client/BindingStore，核对固定身份的生命周期锁、前后台容量、恢复失败补偿、归档已提交后结算和空闲释放。未发现这些补读范围的新确证问题；文件系统故障、实际网络交付与竞态未观察。
- **配套配置：**完整补读 Config 导出/转换、协议受控导出与版本/CLI 合同、根 package、配置示例、Provider 映射及启动网络策略，关联既有 writer、安装/生成器与运行消费者。源码未变，未重新执行不受文档变更影响的构建。
- **指标与 Proxy 辅助：**收齐 Observability 22 项和 Proxy 辅助 11 项报告并登记，分别全文 6,065 和 2,829 行。指标沿 IPC 归属、有限 writer 水位、单 Worker/SQLite、审查排除、精确父 Turn 递归、null/覆盖率、额度和 CLI/WebUI 快照消费核对；未新增业务问题。Proxy 沿生成计时、HTTP/WS/Relay 终态、转储裁剪/trace、容量与 reader 消费核对，保留 R05/R07/R08/R28，新增文档差异 R43。真实磁盘/网络/并发行为未观察。
- **渠道 Surface：**补齐 151 项完整阅读，与主代理已读的计划任务格式器合计 152 项：共享 54、飞书 40、Telegram 26、微信 32。追接收入队、Actor 授权、媒体准备、审批展示与回传、旧卡选择、OAuth、持久/快照/普通输出和实际 API 调用。新增 R38–R42、R44/R45，MCP 与热撤权分别关联 R34/R36；R39 最终收窄到微信可达的普通通知链。无真实渠道消息、文件或应用配置写入。

**汇总结论：**本轮审查清单已完成，45 项仍开放。优先处理 R01/R02/R34 三项 P1，再按授权撤销、数据/凭据保护、完整交付、目标与状态一致性、资源期限处理 P2，最后对齐 P3 文档与呈现。每项均记录触发、证据、影响、关联调整和关闭条件；本轮没有实施修复，不把“读完”“未新增”或静态通过当作缺陷关闭。所有平台实机、故障/竞态、真实账户及浏览器观察限制继续保留在对应条目和持续验收文档。

## 已排除的疑点

空闲释放请求超时后可能晚到的疑点，未列为缺陷。Gateway 成功关闭 Provider Client 后会清除连接标记；下一次请求通过 `ensureClient` 再次执行 `ensureProvider`，Supervisor 的同一 Provider 队列将其排在旧 release 之后。已检查路径没有找到足以证明旧 release 终止新 Gateway 活动的绕过方式。

计划任务的异步预检也不能单独证明存在超额或重叠竞争：SQL 插入再次约束每 Actor/Conversation 的任务数，领取事务再次判断阻塞 Run。没有把这两项早期疑点算入问题总表。

第三轮还排除了以下疑点：图片引用上传自身注册断线取消，不因 Client 构造器未重复调用而构成泄漏；HTTP `response.incomplete` 后内存归约变化不足以证明指标被覆盖，终态前已复制并单次提交快照；WebUI 转储摘要复用明确排除可接续的 `websocket_client_closed`；Thread 总 Token 的服务端排序使用树聚合，前端 accessor 不改变 SQL；账户来源告警和单账户刷新提示按 WebUI 文档有意保持服务端原文，不属于遗漏本地化。

## 后续处理方式

逐项修复时，在对应编号下追加实际修改范围、关联合同调整、修复版本、失败或对抗输入观察、真实用户路径及复核结果；观察不到的行为保留原因和剩余风险。文档记录不额外授权业务修复、用户数据变更、提交、部署或外部消息。

已修复但缺少必要运行证据的条目标记为“已修复待补证”；达到对应关闭条件后再标记“已关闭”。所有仍开放的问题保留在本记录中，不通过归档消除待办。完成后按项目文档生命周期规则处理历史记录。
