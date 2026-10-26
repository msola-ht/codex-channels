# 全渠道消息显示统一计划

当前阶段：按用户授权逐批执行四渠道全链路关联审查、反例分析和修复；每批经 Astra 独立复审并处理发现后提交，再推进下一批。R1 已提交 `c549375d`，R2 已提交 `54053298`；R3 修复及独立复审完成，下一批 R4，客户端待验收。当前分支为 `fix/channel-presentation-alignment`，起始基线为 `f966f45b`。提交授权不包含部署、重启或代发验收消息。

此前 P0–P5 的方案、提交和观察证据已移至 [显示策略统一历史记录](archive/message-display-policy-unification.md)；其中的提交授权、群聊范围和阶段状态仅属于当时任务，不作为本轮的授权或完成依据。现行行为以 [消息显示](display.md) 为准。

## 四渠道呈现对齐原则

共享层决定事件含义、标题、强调意图、字段顺序、状态词、缺失值和显示档位。渠道层负责受支持的格式转换、字面值转义、分片、按钮、编辑与发送回执，不单独重写同一事件的含义或覆盖标题样式。

飞书使用卡片 Markdown；QQ 使用安全规划后的 Markdown 或完整文字备选；Telegram 在发送边界转换为支持的 HTML；微信通过文本消息接口发送，但客户端仍会解析 Markdown。不能把文本接口等同于纯文本显示，也不能用同一套转义规则替代四个平台的适配。

阶段目标是信息与层级一致，不要求按钮数量、分页大小、原地更新能力或平台样式完全相同。原授权、回复窗口、QQ 额度、显示开关、持久投递和未知结果不重试规则保持独立。不得为统一外观扩大平台能力或改变任务执行语义。

## 本轮分批计划

| 批次 | 关联审查与拟处理范围 | 当前状态 |
| --- | --- | --- |
| R1 | 开始通知从事件到共享标题/字段，再到四渠道发送；统一强调样式、微信列表换行、普通标题去句号 | 已提交 `c549375d`，Astra 独立复审完成；客户端待验收 |
| R2 | 其余生命周期：上线、完成、子代理、Hook、自动审批、思考/重试；核对各详情档位、分组、页脚与字面值转义 | 已提交 `54053298`；Astra 独立复审完成，客户端待验收 |
| R3 | 主动查询与选择面板：状态、工作区、模型、会话；共享名称/字段/当前项标记，保留各平台按钮和分页限制 | F4、字面值、选择回执和 TG 查询发送守卫已修复；Astra 独立复审完成，客户端待验收 |
| R4 | 审批与用户问题：标题、题号、选项、敏感内容提示、授权范围和处理结果；保留各渠道真实操作指引 | 已发现 F5；不能删减授权信息或复制交互状态机 |
| R5 | 模型正文与引用：Markdown/HTML 转换、本地路径、链接/图片、长消息及文件回退 | 待分析；保留权威正文与流式偏移，不用通知格式器改写任务正文 |
| R6 | 跨批收尾：四渠道相同场景对照、准入与持久路径、失败/取消/额度、文档与开放验收项 | 待前序批次完成；不以某一渠道通过推断其余渠道通过 |

每批依次执行：读取入口和共享合同 → 追踪格式/准入/发送/回退 → 列出确认问题及反例 → 最小范围修复 → 本地生产函数观察与现有静态门禁 → 主代理复核关联路径 → 记录客户端验收结果与剩余风险。共享信息只保留一个来源；不能仅消除代码差异却丢失平台必要行为。

不新增或修改测试及探针文件，不修复冻结测试。源码审查、构建检查、本地输出观察和真实平台验收分开记录。独立子代理读码结论由主代理复核后纳入记录，不能仅凭搜索匹配或代理完成声明判定覆盖。

## R1 开始通知记录

**触发与根因。** QQ 在共享结果上单独覆盖 `titleStyle`；微信开始通知调用普通文本渲染器，而上线、完成已经使用结构化 Markdown。用户截图显示微信能呈现加粗与列表，但旧开始通知的工作区和审批方式被排到同一段。早先“微信不支持 Markdown”的判断已纠正；截图证明修改前的客户端表现，不证明修改后已通过。

**改动。** [共享开始呈现](../src/surfaces/lifecycle-presentation.ts) 设置加粗正文标题；[QQ 生命周期](../src/surfaces/qq/lifecycle.ts) 删除本地样式覆盖；[微信 Outbox](../src/surfaces/weixin/outbox.ts) 改用共享结构化 Markdown。普通标题为“已开始处理”，末尾无句号；后台与 Skill/Plugin/代理身份标题保留既有措辞。工作区、可用 Git 分支、后台 Session ID、自动审批方式仍按同一字段规则生成，无分支不新增占位。

**关联范围。** 飞书所有已准入开始回执经 `renderFeishuOutput/sendTurnMarkdown/sendMarkdown` 消费共享内容，可选原生回复，独立于 Session 状态卡；状态卡只保存本轮身份等内存元数据，不覆盖开始回执。QQ 沿 `renderQqTurnStarted` 生成 Markdown 与原文字备选，Telegram 经 `renderTelegramLifecyclePresentation` 和 `formatTelegramPanelChunks` 生成 HTML，微信经 `handleEvent` 的开始分支进入原队列和 `sendText`。共享标题在 Markdown 渲染边界转义，Telegram 不预加 Markdown 转义。事件归属、Git 查询、通知开关、平台权限、回复上下文和投递确认合同保持。

**已有观察。** 本地四渠道格式器输出均包含相同标题和字段；飞书/QQ/微信输出强调标记和逐项列表，Telegram 最终 HTML 为 `<b>已开始处理</b>` 及独立字段行。观察了无分支、手动审批、后台任务、名称中的 Markdown/HTML 特殊字符和换行；末次普通标题去句号后重新构建并读回输出。构建、相关 ESLint、文档检查、差异检查通过，不作为真实平台送达证据。

**待验收。** 用户计划自行重启，需确认运行本分支构建并在四渠道检查开始标题、字段分行、有/无分支、自动审批及常规通知关闭。目前没有修改后的明确客户端验收结果，代理未部署、重启或发送真实平台消息；本地输出和注入端口观察不等于平台验收。Astra 已完成本批独立全链路复审，修复下述两项追加发现后，未发现本批阻止交付的代码问题；主代理复核最终差异与关联文档。

**反例修复与复审。** 飞书本地生产 Outbox 配合内存消息端口观察了前后台 × 有无回复目标 × 有无状态卡八种组合、无分支/手动审批、通知关闭、撤权、明确 CardKit 拒绝后的 Post 回退及未知超时。Plugin → 普通下一轮清除旧身份，跨 Chat 不复用身份，开始正文不被后续状态更新覆盖。Astra 复审发现旧卡更新失败仍会阻断开始回执，已改为先发回执、后更新旧状态卡；追加生产 Outbox/SnapshotDelivery 观察确认：旧卡更新超时前已发送一次开始，开始本身超时不再更新卡片，发送后取消或撤权阻止卡片更新，正常顺序为开始发送后状态更新。失败继续传播，不吞未知结果或重发已确认内容。TypeScript 无输出检查、相关 ESLint 和差异检查通过；这些本地端口观察不包含真实平台传输。

R1 的 Astra 追加反例还包括 Plugin 名 `a** · b**` 被 Telegram 误判为标题与详情分隔符。已在 Telegram 生命周期适配层按 typed emphasis 映射为整行标题中间表示，最终仍是 HTML 加粗正文；实际输出为完整名称处于同一 `<b>` 中，HTML 特殊字符转义且无可见井号，普通开始和 `titleDetail` 状态/名称路径保持。未修改通用模型正文解析器。

## R2 生命周期记录

共享生命周期直接按字段结构生成 Markdown，不再经过按行猜标题的转换；递归子字段落实字面标记及续行缩进。子代理所有详情档位使用固定状态与普通名称，模型/Provider 明确标记字面值。微信 Hook/自动审批直接消费结构化内容。Telegram 生命周期保留结构至 HTML 边界，字段换行不进入通用面板解析；上线发送、思考消息编辑和耗时页脚同步消费该结构。QQ 上线、Hook、自动审批与开始/完成一样提供独立原文字和 Markdown 候选，启动装配使用 `presentation()`，发送规划/额度不变。

本地生产入口与注入端口观察：QQ 特殊字符操作和工作区回退原文字，合法 Hook 仍用 Markdown；长合同输入分四片，超八片拒绝，首片后撤权不再发送，未知结果只发送一次。微信成功 Hook 受常规开关隐藏、失败 Hook 和拒绝审批保留，已保留审查继续原投递义务；撤权零发送、超时一次后失败。Telegram 直接 HTML 保留动态名称/模型和字面续行，长字段分片闭合标签且拼接后内容一致；思考同一消息从进行中编辑到完成，保留 2.5 秒耗时；上线仍静默，首片后撤权或未知超时不继续。以上使用生产函数及内存端口，无真实平台收件。

共享多行及深层递归输入属于渲染合同反例；当前自动审批 Client、上线字段数组中的统一映射已清除换行，不能据此声称生产可注入多行字段。QQ 长审查超出当前 Client 摘要限长，仅验证既有出站预算。Astra 已完成独立全链路复审并修复下述上线授权发现，主代理复核最终代码与文档，当前未发现本批阻止交付的问题；真实字体/列表/引用效果仍待用户重启验收。

Astra 追加关联发现：Telegram 上线发送原本直接调用 Bot API，等待状态查询或首片后撤权仍可能继续给旧目标发送，不能用 Outbox 的撤权观察替代上线链。已复用现有通知收件人授权与 API Executor，保留原授权信号到发送、逐片复核，不扩大收件范围或引入失败重试。实际生产 Surface → 启动回调 → Lifecycle → Executor 的注入端口观察：正常目标分三片（3472/3472/1169 编码码点），另一个目标正常单片；状态等待撤权、撤权后重授均停止旧目标；首片后撤权只保留首片，另一个目标继续；生命周期取消停止后续发送，未知发送异常只尝试一次且不阻断其他目标。全部保持 HTML 与静默参数，无真实网络消息。

## R3 查询与选择面板记录

共享模型状态文案统一当前/待生效模型、Provider、思考设置、速度和切换后的新会话说明；模型、提供商、思考和速度视图均消费同一来源。浏览 Provider 明示不会切换设置，Telegram 按钮反馈使用“正在浏览提供商”。QQ 会话条目使用共享思考与 Provider 名称，协作模式保留共享规划入口说明。各渠道按钮、一次性选择快照、分页和预算保持独立。

工作区、会话和模型元数据先单行化，再按渠道保护字面内容；Markdown 渠道不将动态名称解析成新标题，Telegram 直接 HTML 转义，编号列表不按名称中的冒号推测字段。飞书已转义的值不再次包进行内代码；含反引号或反斜杠的命令放弃代码装饰，避免显示转义源码。QQ 选择结果分别生成原文字及 Markdown 候选，不再从 Markdown 反推原文。

本地生产格式器与 QQ 菜单控制器注入端口观察：打开模型面板 → 浏览 Provider → 选模型 → 选思考设置，连续快照依次推进，旧菜单返回 `command.selection.expired`，执行次数为 3。QQ 9/6/3 项布局保持五行按钮，120 个长名称模型按每页 3 项输出、最大 1305 字节；待生效和切换提示保留。特殊名称中的换行、星号及方向控制字符不改变结构；Telegram 编号行中冒号和星号保持字面内容。上述不是实际平台收件。

选择回执追加生产 `QQ receive → commands → Outbox → 内存 client` 观察：`/workspace` 名称为 `*星号*&entity;` 并含换行时发送原文字，保留星号和实体原文；安全候选使用 Markdown 并转义原名。`/rename` 原文字同样保留星号，`/plan` 保留共享 `/plan <规划需求>` 说明且不显示标题源码。真实菜单令牌进入 `pick` 后分别产生 plain/Markdown。Astra 发现合法尾冒号值被通用行猜测误判标题，受影响字段改为显式列表；`/tmp/尾部：` 和模型、重命名末冒号均保留。没有可用默认 Provider 时，状态查询与模型面板统一显示待选择，不误标为 OpenAI 官方。

Telegram 关联修复：本批查询/选择结果复用既有有序队列及 API Executor，捕获原 Actor 授权信号并逐片核对 Workspace/目录/选择范围/Thread。成功切换允许采纳结构化结果对应的新作用域；撤权后重授不复活旧回复，不新增自动重试。Astra 的生产 `Bot.handleUpdate → commands → renderer → Outbox → Executor → 内存 API transport` 观察：长 `/status` 正常两片；查询等待撤权、撤权重授均零片，首片撤权只一片，首片切 Thread 不发送第二正文并保留安全失败提示；`/workspace`、`/resume` 成功变更后各一条正确回执。未知超时只尝试一次原正文，失败提示另计。主代理发现入口 scope 读取可能阻断失效工作区恢复，已先检查目录存在再读取状态；实际 removed → `/workspace` 列表 → 选择有效工作区及按钮入口均成功。可选 Actor Registry 未注入时只复用已鉴权私聊身份，仍执行访问检查。

飞书和微信沿原 Outbox 授权发送，未实证它们查询期间精确选择范围变化的全部竞态；没有据此新增状态机或声称四端竞态全覆盖。真实平台渲染与 SDK 网络取消效果均待用户环境验收。

Astra 已完成本批独立全链路复审并复核选择回执最终差异，主代理核对修复边界及恢复入口。追加观察 `/new`、Workspace/Provider 浏览按钮、旧模型快照、发送后停止和生命周期负责的 Plugin 回执，均保留对应语义；四渠道同一待生效结果均有下一轮生效、新 Session 及继续选择提示。类型检查、相关 ESLint 和差异检查通过；未确认本批剩余阻断问题。

## 后续批次预审补充

- R2：除 F3，确认子代理详细档标题未遵循“状态强调、名称普通”，动态模型字段缺少字面标记；QQ 上线、Hook、自动审批的文字回退复用了 Markdown 源。多行字段另属共享 renderer 合同反例，当前自动审批 Client 已清除换行、Hook 名为枚举，不能称为这些来源的可达换行攻击。
- R3：F4 同时涉及飞书模型卡和 Telegram 提供商根页，必须共享待生效状态、切换后果及连续选择提示；保留 QQ 分页和字节预算。合法工作区名称可有内部换行，动态元数据的单行化和渠道字面处理须随格式器一起核对。
- R4：普通题干的 Markdown 语义在飞书/微信与异步路径不一致；QQ 问题元数据、微信异步选项未字面保护。超过三题的异步分批出现全局/局部双重题号，显示标签需共享但操作索引保持。飞书 MCP form 省略来源标题；持久审批结果在响应发送前声称“已保存”，需改为准确的选择结果。保留授权全文、敏感能力差异和原问题 ID/令牌映射。
- R5：预审调用现有生产纯函数，确认微信误删反斜杠转义的图片/强调内容，微信与 Telegram 多反引号行内代码失真，Telegram 链接标签含代码时泄漏内部占位符，HTML 降级文字丢失链接目标。后续修复需保留链接补回后的分片上限；字数测量与实际文字回退不混用。未发现要统一 QQ/飞书预算、重写流式偏移或新增图片传输的依据。

## 本轮渠道代码读取与最终复核

R6 持久链预审已由独立 Sol 完成，覆盖 `SurfaceManager → PersistentSurfaceOutput → Coordinator/Journal → 四渠道 deliver/snapshot → 原 owner 授权`，未确认 R1/R2 新阻断性缺陷。新记录准入和既有记录重放分离，`off` 完成采用独立资源收尾，不伪造 ACK；`uncertain/blocked` 保留载荷、检查点与容量，不自动重发。原目标、Actor、Workspace 目录及 QQ 来源代次继续控制发送，完成统计不替代正文确认。主代理已读完整报告并核对其范围；R4/R5 完成后仍须针对最终改动复核。

该预审实际观察了飞书/TG/微信生产 Outbox：常规通知关闭和完成 `off` 拒绝新开始/隐藏新成功完成，但已保留开始与完成各产生一个 `confirmed` 检查点，撤权零发送。QQ 生产生命周期 → Outbox → 额度端口的开始/完成各发送一次并确认；撤权为 `SurfaceDeliveryNotSentError` 且零发送，同轮状态已预留两片后再申请一片被 `budget` 拒绝。所有接收器均为内存端口；没有真实窗口耗尽、磁盘满/ACK 故障或服务重启观察，不把源码恢复路径当作运行证据。

三个 Sol 子代理分别完成飞书与 Telegram、QQ、微信的只读源码梳理；主代理已阅读完整报告，并针对开始旁路、动态标题约束、命令状态差异、交互题干、微信出站与回退边界复核代码。证据适用于 `f966f45b` 加本分支当前改动。子任务没有改文件、运行历史测试或发送平台消息，均无遗留作业。

| 渠道 | 已读取的入口、共享内容及最终消费 | 渠道适配与覆盖边界 |
| --- | --- | --- |
| 飞书 | [Outbox](../src/surfaces/feishu/outbox.ts) 的 `handleEvent/sendTurnMarkdown/sendMarkdown` → [renderer](../src/surfaces/feishu/renderer.ts) → 共享生命周期；主动命令读取 [命令中心](../src/surfaces/feishu/command-center-presentation.ts)；交互读取 [审批卡](../src/surfaces/feishu/approval-card.ts)、[问题卡](../src/surfaces/feishu/input-card.ts)、[交互处理](../src/surfaces/feishu/interactions.ts)；正文读取 [流式](../src/surfaces/feishu/text-streams.ts)、[分片](../src/surfaces/feishu/outbox-content.ts)、[长答案文件](../src/surfaces/feishu/outbox-answer-file.ts) 到 [Client](../src/surfaces/feishu/client.ts) | CardKit Markdown/表单、原地状态卡、回复目标、完整审批详情预算、正文 Post 或文件回退属于平台边界；共享开始旁路见 F1。命令读到代表性结果与卡片入口，未穷尽所有按钮组合 |
| Telegram | [Outbox](../src/surfaces/telegram/outbox.ts) 的 `handleEvent/sendPanel` → [生命周期格式](../src/surfaces/telegram/format.ts) → [Panel HTML](../src/surfaces/telegram/html-format.ts) → HTML 发送；上线读取 [lifecycle](../src/surfaces/telegram/lifecycle.ts)，命令读取 [command-renderer](../src/surfaces/telegram/command-renderer.ts)，交互读取 [interactions](../src/surfaces/telegram/interactions.ts)，正文读取 [Markdown 转换](../src/surfaces/telegram/markdown-format.ts)、[流式](../src/surfaces/telegram/text-streams.ts)、[长答案](../src/surfaces/telegram/long-message-format.ts) | HTML 转义、inline keyboard/ForceReply、可展开引用、typing、静默提醒和分片末按钮保留；不能先把共享字面字段全部做 Markdown 转义再传给 HTML。未重审全部 SDK 或网络错误码 |
| QQ | [Surface](../src/surfaces/qq/surface.ts) → [Messages](../src/surfaces/qq/messages.ts) 的 `deliver` → [生命周期](../src/surfaces/qq/lifecycle.ts)/[任务过程](../src/surfaces/qq/task-progress.ts) → [Outbox](../src/surfaces/qq/outbox.ts) → [协议发送](../src/surfaces/qq/protocol.ts)；命令读取 [菜单控制器](../src/surfaces/qq/command-menu-controller.ts)、[扩展](../src/surfaces/qq/extension-commands.ts)、[计划任务](../src/surfaces/qq/schedule-menu.ts)、[高影响管理](../src/surfaces/qq/privileged-management-menu.ts)；交互读取 [interactions](../src/surfaces/qq/interactions.ts)，正文读取 [Markdown 规划](../src/surfaces/qq/message-markdown.ts)、[安全前缀](../src/surfaces/qq/body-markdown.ts)、[流式](../src/surfaces/qq/streaming.ts) 和 [额度](../src/surfaces/qq/send-budget.ts) | 原生 Markdown/文字候选必须发送前选定，未知发送不换格式重发；正文、菜单、普通文字的字节/码点上限不同。第一批没有第二条开始标题覆盖。未重审全部 Application 命令执行或 App Server 协议 |
| 微信 | [Outbox](../src/surfaces/weixin/outbox.ts) 的 `handleEvent/enqueueText/send` → [credential-client](../src/surfaces/weixin/credential-client.ts) → [protocol-client](../src/surfaces/weixin/protocol-client.ts) 的 `sendText`/`text_item.text`；上线读取 [Surface](../src/surfaces/weixin/surface.ts)，命令读取 [command-renderer](../src/surfaces/weixin/command-renderer.ts)/[conversation-adapter](../src/surfaces/weixin/conversation-adapter.ts)，交互读取 [interactions](../src/surfaces/weixin/interactions.ts)/[Markdown 中性化](../src/surfaces/weixin/markdown-sanitize.ts)，正文读取 [final-text-format](../src/surfaces/weixin/final-text-format.ts) 与 Outbox 文件回退 | 新开始内容不经正文兼容转换或全角中性化，Markdown 到文本消息正文保持；回复上下文、逐片/HTTP 前授权、4000 UTF-16 码元分片和五片/文件回退仍独立。Hook/自动审批旧路径见 F3；没有修改后的客户端观测 |

共同读取了共享生命周期、命令格式器、`delivery-policy` 的常规通知/完成准入以及涉及的持久输出入口。以上是源码路径覆盖，不是所有命令回调、审批安全、平台 SDK 或持久恢复的完整重新审计；所有渠道均未做本轮真实收件、重启恢复、额度耗尽或客户端视觉验收。后续每批仍须围绕实际改动扩展必要的调用链与反例。

### 已核对的开放项

| 编号与批次 | 触发条件与影响 | 代码依据与下一步 |
| --- | --- | --- |
| F1 · R1 | 原无回复目标开始路径用 Session 状态卡替代或后台省略，已有卡更新会覆盖共享字段 | 已修复：已准入开始回执统一经 `sendMarkdown`，独立状态卡仅保存原内存元数据；本轮身份在普通下一轮清空，不跨会话复用。前后台、有无回复/状态卡及失败路径已做本地端口观察，客户端待验收 |
| F2 · R1/R2 | 合法 Plugin 名中的 Markdown 字符进入标题，可能改变标题格式 | 已修复：共享结构化 renderer 在 Markdown 边界转义标题；Telegram 原值经 HTML 转义，QQ 保留独立原文字备选。观察含 `a**b`、下划线、链接形状及 HTML 特殊字符的四渠道格式器输出，名称保持字面内容。子代理其他字段问题另列 R2 |
| F3 · R2 | 微信 Hook/自动审批先渲染 plain 再猜字段，丢失 literal；子代理详细档标题/动态模型字段及 QQ 部分通知原文字回退也有差异 | 已修复并经独立复审，见 R2 记录。多行字面值按共享渲染合同保护，不将其称为当前自动审批/Hook 来源的可达换行攻击 |
| F4 · R3 | QQ 模型面板自行组装当前状态，未显示共享格式器中的提供商切换说明、思考设置下一轮生效标记及连续选择提示；协作模式另有简短回执，缺少共享规划入口说明；会话列表直接显示原始思考等级和 Provider，未使用共享显示名称 | [QQ 模型/会话面板](../src/surfaces/qq/command-menu-controller.ts)、[QQ 命令回执](../src/surfaces/qq/messages.ts)、[共享模型文案](../src/surfaces/conversation-model-account-command-format.ts)、[共享会话文案](../src/surfaces/conversation-session-command-format.ts)、[共享协作模式](../src/surfaces/conversation-workspace-status-command-format.ts)。提取共享状态语义，保留 QQ 按钮和分页；Goal 的平台能力限制不能机械抹平 |
| F5 · R4 | 飞书普通阻塞问题把整个题干转义，异步问题保留 Markdown；TG 普通与异步题干均按 Markdown 渲染。同题干中的代码或链接可能显示不同 | [飞书问题卡](../src/surfaces/feishu/input-card.ts)、[TG 问题格式](../src/surfaces/telegram/interactions.ts)。统一题干内容语义，标题/选项等元数据仍字面化，保留原表单、题目映射和取消路线 |

F1–F4 已修复并经对应批次独立复审；F5 留待 R4。最终视觉影响仍需对应平台观察。后续新增发现按各批记录管理，不把源码修复视为客户端验收。

### 后续反例与本次最终复核

- R1/R2：分别核对有/无回复目标、已有状态卡、后台开始、合法带 Markdown 符号的 Plugin 名、无 Git 分支、手动/自动审批。普通短字段输出不能证明动态标题及旁路也正确。
- R2/R3：多行字面值如 `第一行\n标题：\n*内容*` 不能在渠道二次识别时变成新标题；R2 已修复微信生命周期丢失字面标记及共享叶字段续行缩进。R3 继续核对命令动态名称/路径，不能因共用 formatter 就视为全部转义完备。
- R4：相同题干的代码、链接、选项、敏感输入、等待式/异步问题分别比较；审批全文核对、令牌有效性和支持范围独立验收，不能为外观一致删除授权范围或提示。
- R5：长字段/围栏/链接/粗体在分片处的闭合、未知结果禁止重发、文件失败及完整正文确认分别核查。微信现有分片处理围栏与代理对，不保证任意粗体/链接/转义边界都能保持；QQ 不同消息上限和飞书/TG 各自回退条件不可合并成一个通用上限。

前序主代理读码汇总复核已完成：核对四份渠道覆盖行与三份完整子代理报告，回读 F1–F5 的触发代码及关键消费者。该阶段只形成计划；后续实施进度以批次记录为准，文档索引和 [现行展示说明](display.md) 链接到本计划。

## 历史验收边界

P0–P5 已交付源码的历史记录仍有未直接观察的场景，归档不将其关闭。它们与本轮 F1–F5 的确认差异分别管理：

| 未观察范围 | 状态与下一步 |
| --- | --- |
| 四渠道真实收件、字体/列表/折叠、通知声音和引用效果 | 未完成全组合验收；R1–R5 逐批记录用户截图、目标设置和运行版本，不以单渠道观察覆盖其他渠道 |
| 服务重启、持久 Journal 恢复、配置实际激活、窗口及额度异常 | 保留历史限制；R6 针对受改动影响的路径选择授权环境补证，不能通过重放未知结果强行验证 |
| CLI 真正 TTY、WebUI 浏览器交互、macOS/Windows 现场行为 | 历史本地函数/HTTP 观察不覆盖这些边界；若后续涉及管理入口或平台分支，再补对应现场证据，未涉及部分继续登记为未观察 |

上述记录不是新增功能承诺，也不扩大平台发送、服务操作或配置修改授权。

## 文档清理记录

本轮将 P0–P5 原记录分离归档，保留提交、历史观察和未验收边界；当前文档只维护 R1–R6、四渠道读码与 F1–F5。关联说明修正漏列 QQ 的共享能力和图片入口，以及微信文本传输与 Markdown 解析的混淆；部署/验收记录按代码批次区分，未知的运行状态保持未知。

此前 Astra 已完成独立文档复审，核对历史正文保留、提交身份、开放项、索引链接及关联源码，指出模块 README 对飞书开始通知覆盖范围描述过宽；当时已收窄并登记 F1。此后 R1 实施修复并同步更新现行说明。文档复审不替代各批代码复审或平台功能验收。
