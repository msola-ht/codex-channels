# Surface Adapters

`completion-notice-delay.ts` 提供四渠道共用的 2 秒完成通知显示缓冲。各渠道在本会话正文/流式收尾之后、可见完成通知的实际发送之前调用；等待可取消，之后仍执行原授权、回复窗口及配额检查。隐藏完成通知不等待，正文、工具和独立失败提示不增加这项延迟。不增加持久状态或配置，也不将等待视作客户端渲染完成回执。

`SurfaceOutputPort.acceptsSnapshot` 是可选的实时快照显示准入；Bootstrap 在状态观察和旧快照取代之后、捕获 owner 和排队之前调用，缺省保留既有行为。它不替代来源授权，不用于持久记录重放，也不门控隐藏完成的独立收尾。QQ 复用现有显示判定，避免已隐藏的新状态因未捕获来源而误报归属变化；真实来源缺失仍由投递守卫处理。

正文流式显示由目标 `streamingEnabled` 控制，缺省开启；关闭只停止新 `text.delta` 预览，完整 `text.completed`、附件和可靠投递保持独立。它不改变模型传输、思考状态或其他原地更新。Telegram、飞书与 QQ 单聊消费该设置；微信及 QQ 群不开放无效覆盖。已有流的完整终结仍走原收尾逻辑，存量完成正文不按新设置隐藏。

过程说明由目标 `commentaryEnabled` 控制，缺省开启，Telegram、飞书、QQ 单聊支持，微信不开放。共享 `delivery-policy.ts` 仅依据显式 phase 分类；关闭后未知阶段增量在各渠道既有有界流中缓冲，明确 final_answer 才放行完整前缀。未知完整 Item 始终保留，已准入正文流继续原收尾，旧持久记录独立于当前开关。Telegram、飞书在 Turn 结束或关闭时丢弃尚未准入且没有完整 Item 终态所有者的缓冲，不能以收尾代替 phase 准入。观察阶段先清理明确隐藏的未显示缓冲，再决定新事件准入；不建立第二份正文历史。

Telegram 既有空白 commentary 的明确省略特例保持不变；该设置不把旧增量替换为空白完成 Item 的权威正文，也不为它新增成功确认。

常规通知由目标 `routineNotificationsEnabled` 控制，四渠道均支持，缺省开启。`delivery-policy.ts` 按结构化事件区分普通成功提示与需要关注的结果；状态观察、授权和原持久义务独立。Gateway 上线摘要、App Server 连接恢复、会话空闲释放和全局空闲释放不受常规通知开关控制；微信恢复提示沿原回复上下文和配额发送；配置只有 live 普通提示可隐藏，持久工作区回执仍需原交付确认。失败、重试、账户/额度、OAuth、审批及主动命令不由该开关屏蔽。

[QQ](qq/README.md) 已接入文字任务、命令菜单、共享持久投递及审批/问题回应；图片、文本/普通文件、原生引用、音视频输入、原生 Queue、计划任务和当次配置通知已随 `9c0d3488` 部署，具体客户端证据与待验收范围见模块文档。部署就绪不代表所有分支验收完成，旧来源仍不恢复。

本目录保存外部交互平台适配器。Surface 负责把平台输入转换为 Application 命令，并把 Core 输出和审批交互渲染为平台消息。

`SurfaceMessageDisplaySettings` 是组合根注入的窄展示解析回调，以原始 `ConversationTarget` 选择工具、计划、思考、完成通知及呈现详情；Telegram、飞书 Outbox 和 QQ 消息准入、任务进度及异步渲染使用同一目标设置。微信消费完成通知和呈现详情，继续不开放这些过程输出。`presentationDetail` 只选择上线会话和完成、子代理的关键明细，不决定消息准入或投递确认，也不读取日志等级；`basic` 使用紧凑摘要，`detailed` 增加本轮统计总计，不展开统计子项；`full` 展开现有环境、统计分项和审批详情，仍不复制正文或会话累计。独立装配未注入回调时保留各渠道原来的过程选项默认值，完成通知默认 `detailed`，呈现详情默认 `basic`。新实时事件按有效设置准入，已保留的终态只选择版式，不重新以 `hidden`/`compact` 过滤。

完成通知 `brief` 呈现实际执行状态、上下文占用、后台身份和必要异常，不因呈现详情 `detailed` 展开统计；它不确认正文送达。`off` 只省略成功且无错误、错误码及权威缺正文标记的新完成通知。`liveCompletionDisplay` 在实时准入时固定模式；`shouldSettleLiveCompletion`、`settleLiveCompletion` 与 `discardLiveCompletion` 分离新事件的隐藏收尾、受原授权的瞬态操作和精确 Turn 的无发送清理。收尾复用原 Conversation 队列及瞬态回执，等待嵌套操作结算，不生成 Journal 记录或持久确认，也不受普通状态快照替换。持久 `deliver` 的可选完成上下文只由本次实时准入传递；恢复或未提供上下文时完成通知固定使用 `detailed`，统计明细按当前目标的呈现详情选择，不查询当前完成偏好而空确认，也不增加持久字段。流式正文失败的独立提示仍复核原授权。

`index.ts` 是 Gateway 装配各 Surface 的主公开入口；通过显式异步加载函数提供飞书、微信、Telegram 和 QQ 四个消息渠道，
纯共享能力与凭据检查不静态加载飞书或 Telegram SDK。
该入口也向本机图片提交命令公开 `readGeneratedImage` 与 `GeneratedImageError`，复用普通文件、符号链接、大小与格式校验；读取后的字节才允许进入渠道待发送目录。

`sendChannelImage` 的可选 `format: "markdown"` 当前仅 QQ 支持，由 SurfaceManager 拒绝其他渠道使用；缺省继续普通图片。QQ 使用相同队列、原绑定守卫和收据，素材上传不单独认定图片送达。

显式文件发送现覆盖 QQ/飞书/TG/微信，CLI、spool 和路由通过 `channelFilePolicy` 共享渠道准入与预算，Adapter 负责平台协议。MP4 和 Ogg/Opus 的受控文件头检查共用；微信原生 voice 不开放。TG/微信显式图片和文件现消费原 Thread 守卫及领取器取消信号，不因后台 Thread 解绑而改投前台；微信固定入队时回复上下文。新增支持不改变文件 version 1 manifest，不迁移用户数据，未部署或实机验收。

`delivery-diagnostics/index.ts` 是离线投递诊断的窄公开入口，仅复用载荷解码和屏障分类，不加载平台 SDK 或数据库实现。
`SurfaceOutputPort.deliver` 的可选来源参数由持久 owner 解析后传入，富化不重选来源；QQ 用它校验并取得原生引用索引。来源本身不授予发送权限，各渠道继续执行原授权守卫，不消费该参数的渠道保持原行为。
`persistent-output.ts` 分类可恢复的终态输出与独立生命周期通知，持久结果发送未知或授权失效后解除顺序屏障并保留记录、检查点与容量计费，并将必要图片纳入同一有界快照；
载荷 v1 支持分类独立于当前显示偏好和渠道实时准入。`retains` 只决定新事件是否入箱；已入箱操作即使后来改为 `hidden`，或在 `compact` 下属于省略的 sleep/子代理操作，也保留可见的完整或精简终态表示。恢复不保证与原来版式相同，不新增持久字段。发送仍复核原授权、来源、回复窗口和渠道支持；微信不因此开放普通操作或子代理输出。
生成图片的上游 `fileId` 只在实时事件中传递，写入快照前一律剥离；只有引用、没有 `savedPath` 的完成结果仅保留内容不可获取标记，恢复后沿用相同提示，不把引用写入投递 Journal。
`SurfaceOutputPort.deliver` 的原归属授权回调由飞书、Telegram、微信显式保存为回执的同步 `beforeSend` 守卫，缺失回调时拒绝实际发送；既有无消息展示特例不伪造送达确认。守卫随队列及子回执保留，在检查点写入前后、SDK 的后续请求或重试前重新核对；状态快照同样携带自己的授权守卫。QQ 继续使用原有来源守卫，不因共享回执扩展而增加发送权限。

`delivery-receipt.ts` 关联一次可靠投递生成的排队操作和平台检查点。`SurfaceOutputPort.deliver`
等待实际操作结算，Bootstrap 才能确认持久记录；TG/飞书/微信可靠输出要求存在平台成功检查点，排队终态持有正文引用，独立于断线清理的临时流缓存；正文截断会要求完整原文附件的确认，缺少完整性依据则拒绝确认。既有空白 commentary 和隐藏自动审批展示特例保持原有明确结算规则，不据此推导其他空发送成功。`snapshot-delivery.ts` 将状态展示的失效信号与排队操作关联；`SurfaceOutputPort.deliverSnapshot`
允许按展示规则不产生消息，等待实际状态操作结束，并在平台调用前复核归属。普通 `handle` 继续用于中间输出。

Surface 只运输和呈现项目已经接入的 Codex CLI/App Server 能力。当前能力范围以
[`docs/index.md`](../../docs/index.md) 的支持矩阵为准；平台 SDK 提供某项能力或生成协议中出现
某个类型，不代表 Surface 可以自行建立新的 Thread、Turn、历史、工具或审批语义。Setup、
Doctor、菜单、输入状态、连接健康和平台媒体传输属于渠道运维或呈现能力，不能伪装成 Codex
原生功能。

当前实现：

工作区只选择登记目录；`/status` 和生命周期卡片的权限相关状态取 App Server 实际值。
`/status` 经共享格式化入口显示精简的当前会话、执行设置、有效消息模式、上下文及累计 Token；四渠道不再提供详情视图。
仅在目录未确认或与工作区不同时追加说明；目标只显示状态并指向 `/goal`，额度显示已取得的账户余额、额度窗口或周限摘要，查询失败时提示通过 `/usage` 或 `/limits` 重查。
动态字段统一清理控制字符，飞书与微信使用字面值转义，Telegram 使用已有 HTML 字段值转义；底层执行目录、指令来源和加载快照不因精简展示而删除。
`/autoreview [on|off]` 查询或切换当前已绑定 Thread，统一结果由共享格式化器呈现；飞书命令中心与
Telegram 按钮绑定原 Thread、Actor、Conversation 和限时一次性令牌。
平台只提交结构化选择，Application 在锁内复核 Thread 与空闲状态，确认权威设置后才返回更新成功。
四渠道共用 `lifecycle-presentation.ts` 仅在自动审批完成后呈现结果与结构化内容摘要；Client 提供经脱敏和限长的文本。飞书、QQ、微信在共享 Markdown 呈现边界处理字面字段；Telegram 保留结构直到 HTML 转义，不把字段续行再次解析成标题。QQ 上线、Hook 与自动审批保留独立原文字备选，Markdown 不适用时不展示转义源码。通知经共享关键投递路径发送，不生成审批交互。
普通生命周期卡只在 Thread 权威设置启用自动审批时显示审批方式，完成卡的自动审批统计也受此条件约束；主动 `/status`、专用查询与设置入口保留完整审批状态和操作回执。

- [`telegram/`](telegram/README.md)：Telegram Bot 输入、输出、交互、图片、一次性音频、UTF-8 文本文件和生命周期。
- [`feishu/`](feishu/README.md)：飞书官方 SDK 长连接、私聊文本、PNG/JPEG/WebP/非动画 GIF、一次性音频与 UTF-8 文本文件到
  Application 的窄 Adapter、富文本最终回复、纯文本安全提示、有界输出队列、私聊交互卡片、平台权限中心、
  用户 OAuth Device Flow 和单账号生命周期组合；有效配置启用时由 Bootstrap 显式注册。真实平台
  状态见 [`通讯渠道验收矩阵`](../../docs/channel-acceptance-matrix.md)。
- [`weixin/`](weixin/README.md)：微信 Setup 的严格独立凭据边界、固定版窄协议 Client、
  私有原子游标检查点、可取消接收监控器、授权后提交 Application 的私聊文本、图片、一次性
  音频与 UTF-8 文本文件输入 Adapter，
  以及复用统一会话命令服务的完整命令目录、加密回复上下文、重启上线通知、受限配置通知和
  Turn 完成统计；
  文本与生成图片有界 Outbox、带随机一次性 ID 的精确文本审批、用户输入与 MCP 交互端口，以及
  目录内部完整 `SurfaceAdapter` 已实现；严格运行配置显式启用时由 Bootstrap 注册单账号私聊
  Surface。

`secure-credential-store.ts` 提供 Surface 内部复用的 macOS Keychain、Linux AES-256-GCM 和 Windows
DPAPI 主密钥 + AES-256-GCM 字符串记录机制；平台模块仍各自拥有 Service、目录、记录键、载荷校验
和错误语义。macOS Keychain 命令失败在记录存储边界转换为安全错误，不传播含凭据参数的原始命令、标准输出或标准错误；读取和删除的记录不存在语义保持不变。
Linux 后端只读验证既有目录、主密钥和密文的类型、归属与私有权限，不用 chmod 修复后放行；
拒绝目录祖先链接、叶链接和多硬链接文件。每次操作持有目录描述符，通过 Linux procfs 的该描述符路径
读写删除，目录替换时不会转向新位置；前后仍复核配置路径身份。文件同描述符非阻塞有界读取，
单记录最多 1 MiB（含加密开销），正常三类凭据载荷均在预算内。已有材料缺失主密钥时拒绝创建替代密钥，
不迁移、重加密或清理未知材料；新目录和文件才由创建时的 0700/0600 保护。读取结果保留记录和密钥修订，
返回前再次核对；保存时在记录替换前后核对密钥修订，变化时明确失败，不自动恢复覆盖并发材料。
procfs 描述符访问路径先核对可达性及身份，叶文件不存在也需复核目录能力；基础设施不可用时失败关闭。
Windows 持续流量路径使用异步 DPAPI、ACL 与记录读写；每目录串行、总容量 16 项和 15 秒取消预算，物理操作结算前保留槽位。凭据格式、作用域与 OAuth 关闭时的在途回滚归属不变。

`surface-shutdown.ts` 收集各渠道关闭步骤的同步和异步失败；渠道仍决定启动与等待各步骤的顺序，
保留各资源原有预算，全部清理尝试完成后统一抛出失败。停止结果由实例缓存，失败不伪装为成功，也不隐式重新启动资源。

`types.ts` 定义最小 `SurfaceAdapter` 契约。可选 `output.deliverySource` 提供来源引用的捕获、可取消等待和同步复核；引用不能单独授予发送资格。持久 `deliver` 的第四参数可接收共享同步授权守卫，用于最终网络发送前复核。
普通输出 `handle` 的可选第三参数传递共享会话队列取消信号；QQ 正文流在该队列内等待单帧完成，并将取消传递到来源等待、节流及 HTTP。
可选 capabilities 分别约束自动绑定恢复、交互、计划任务及持久配置事件订阅；QQ 启用绑定恢复、交互和计划任务，`configurationNotifications: false` 排除持久 Workspace 配置事件重放，当次 `configurationChanged` 仍发送受控通知。QQ 交互仍经过 `PersistentInteractionPort` 的前序持久投递屏障，按原用户、工作区和当前请求归属授权，不恢复旧来源或令牌。
可选 `output.observeUserMessageIdentity` 接收当前已握手连接投影的官方用户消息四项身份，QQ 结合 Queue 提交响应关联精确 Turn；`output.observeQueueChanged` 只清理未用选择。可选 `prepareScheduledTaskSubmission` 为 Executor 提供独立提交观察票据；QQ 将计划运行固定于原任务 Workspace 和后台绑定，经权威响应确认 Turn，前台切换不改变该归属。
可选 `takeAsyncAnswerSubmission(target, requestId)` 按原目标与请求单次领取异步回答的 `observer/isCurrent/cancel` 及可选 `failed` 通知端口；Bootstrap 将其接入 `ConversationService.submitAsyncAnswer`，提交前及等待后复核，失败取消来源并尝试受控提示。QQ 必须取得该次回答来信的新来源才可提交；确认后保留来源至正常释放，不恢复旧来源，其他渠道未实现此可选端口时沿用原路径。
每个实例使用
`surface + accountId` 标识，分别提供启停、输出、可选配置变更通知、计划任务确认呈现与 `InteractionPort`；Bootstrap
只通过编译期内置插件注册表显式注册。
Bootstrap 的内置插件注册表负责把一个渠道插件展开为零到多个账号实例并验证身份唯一性；
Telegram、飞书目录仍只实现平台 Adapter，不导入插件宿主或组合根类型。
`SurfaceOutputPort` 接收平台无关的 `OutputEvent`。Reader 只同步调用 `admitLive` 与 `observe`；`deliver` 和
`deliverSnapshot` 的等待发生在后台 Conversation 队列，不阻塞 Reader。
`partial_answer` 按稳定正文投递，包括微信回复窗口和长正文处理，但不代表整轮完成；飞书完成统计独立发送，不追加到正文或部分回答卡上。
可选 `admitLive` 在普通与持久模式发布时只固定可丢弃的实时输出身份，不变更展示生命周期。可选 `observe` 保留持久模式发布时的本地生命周期处理；普通模式仍由 `handle` 按消费顺序处理，持久重放不调用两者。
组合根按事件对象弱引用去重；仅向成功调用准入端口的 `handle` 传递 `liveAdmitted: true`，包括富化生成的副本，只跳过重复准入，仍执行普通展示生命周期。准入或观察抛错时不准入路由；未装配准入端口时不传该标记。Telegram 直接 `observe` 仍先固定实时身份，直接 `handle` 仍补全准入和本地展示状态。
`delivery-policy.ts` 定义最新展示快照的键及终态淘汰关系；Bootstrap 持有有界临时快照，平台不维护第二套投递恢复队列。状态进入渠道队列后仍属于该快照的预算；断线、终态与新轮次
会取消对应旧状态的未发送操作。状态发送失败或结果未知会向调用方报告，不自动重试整个状态。
Bootstrap 按 `surface + accountId` 精确选择一个输出端口，Surface 不再各自订阅全局事件总线。
平台投递只交给成功启动且仍处于运行状态的 Surface；本地生命周期观察不依赖渠道就绪。单个输出端口拒绝事件不得中断后续路由。
`connectionOnly: true` 明确标记仅连接的 Adapter：不参与旧绑定恢复、消息准入、持久投递账号选择或审批可用性，
没有配置通知订阅对象，其连接故障也不阻塞其他渠道配置事件确认。未声明时保持完整消息渠道的现有行为。
运行连接失败后，同一 Adapter 的 `start()` 必须能重新建立输入连接；Bootstrap 对每个账号实例
独立退避，不通过重启 Gateway 恢复单个渠道。`stop()` 用于 Gateway 关闭或账号永久隔离，必须可在部分启动后
安全调用并保持幂等。生产装配中的关键终态由 Bootstrap 提交独立持久投递箱，不写入 StateStore；
渠道恢复后按 Conversation 顺序交给 `deliver`，实际发送确认成功后才清除记录。渠道离线或存在前序
持久结果时，展示状态按键保留最新快照，正文增量依赖完整 Item，不另建流式恢复队列。未装配持久投递的独立使用路径仍采用内存恢复缓冲，按
`isSheddableBacklogEvent` 合并或削减中间输出。容量与恢复合同见[关键结果投递](../../docs/delivery.md)。
临时连接故障只能取消当前交互，不能把可恢复端口永久关闭。
配置变更通知使用结构化动作区分热加载、自动重启、需要重装、加载失败，以及第三方模型设置的
等待重启、重启中、已生效和失败；Surface 只渲染结果，不得接收原始配置值或异常详情。普通
生命周期通知可通过可选的 `configurationChanged` 异步入队；`deliverConfigurationChange` 必须等待
所有目标的平台 API 实际发送成功，失败时抛出错误，以便 Bootstrap 保留尚未确认的持久化配置事件。
没有配置通知订阅对象时按空集合完成。QQ 不订阅持久事件，但当次通知使用显式单聊允许名单，热加载更新名单，重启前同应用只取新旧交集，换应用或禁用时不发送；逐人完整回执、六十秒期限与共享主动预算由 QQ Adapter 负责，未知不自动重试。
全局变更投递给所有 Surface；平台作用域变更只投递给匹配 Surface。进程重启和重装会影响所有
Surface，因此未匹配到具体变更的 Surface 仍会收到不包含平台私有原因的生命周期通知。

`ConversationDeliveryQueue` 提供可复用的每 Conversation 有界顺序队列：同一 Conversation 串行，
不同 Conversation 可并行；关键输出可以替换仍在等待的非关键输出。入队时可携带合并键，仍在等待
执行的同键条目会就地替换为最新载荷并保持顺序与容量计数，达到硬预算时仍允许等量替换。
取消会移除未执行操作并释放预算；不带回执的普通任务显式清除上个任务的异步回执上下文。新增 Surface
时应实现统一输入、输出和审批边界，通过 Application/Core 接入，并把平台发送操作放入该队列或
提供等价约束。`waitForIdle()` 在暂停新入队后限时等待当前任务结束，保留队列供恢复后继续使用。
Bootstrap 复用该队列隔离每个会话的完成统计准备，并关闭逐 Token 的普通阶段
调试记录；终态统计准备与慢队列警告仍保留。
`delivery-policy.ts` 是渠道投递策略的唯一判定点：`resolveSurfaceDelivery` 决定事件是投递、按合并键
合并还是忽略，并给出是否关键；渠道差异只保留微信回复窗口白名单和思考状态的合并键两张表，
Surface 不再各自维护允许列表或在 `handle` 内散落关键性字面量。Telegram 与飞书对同一 Turn 的
思考状态按分段合并，仅合并尚未执行的中间快照，创建首条状态和终态始终执行。
`SurfaceOutputCoalescer` 供出站总线与运行中路由复用：首条快照不合并，后续同段快照可被终态替换，
终态或同 Conversation 的其他事件结束当前合并段；不同渠道、账号、Conversation、Thread 和 Turn 不串段。
分段元数据最多保留 1,000 个 Conversation，淘汰只减少合并机会，不复用旧键；故障恢复缓冲仍采用最新状态策略。
Hook 完成通知按 Thread 与 Hook 运行 ID 使用已有有界内存快照投递，三端发送前重新检查归属，避免持久输出等待期间跳过提示；不落盘。
`turn-retry-presentation.ts` 统一模型请求自动重试、收到后续输出、终态及失效文案，按完整目标、Thread 与 Turn 隔离有界临时消息句柄；Telegram/飞书复用同条状态，微信每轮最多一次重试与一次后续输出提示，断线保留同轮提示预算。状态及收尾均经过独立回执的有界快照投递，不附带在持久结果回执上，也不写入可靠结果日志。观察器只变更内存状态，最新快照所有者负责取消过期操作，避免用旧创建事件取消已排队的终态更新。仅保存消息句柄和去重状态，不推断上游重试次数或持久化对话状态。
`delivery-retry.ts` 为缺少其他恢复路径的渠道提供有界重试：只重试能证明请求未被平台接受的失败
（显式拒绝、限流、服务端错误），超时与网络中断一律不重试，避免重复气泡；等待有上限，且重试
保持在单次平台调用粒度，不在分段发送的上层重跑整段逻辑。
投递关键性有三个层次，不能互相替代：Core 的 `isCriticalOutputEvent` 区分完整输出与可丢弃的
增量或过程事件；`SurfaceDeliveryDecision.critical` 表示该事件在本渠道不得静默丢失，微信白名单
事件恒为真，其他渠道沿用 Core 判定；`ConversationDeliveryQueue` 的排队关键性决定队列满时该平台
发送能否被丢弃，由渠道按用户可见结果选择。收紧或合并任意两层前，必须先确认对应渠道的用户可见
结果。
Thread Queue 属于 App Server，由 Application 负责授权、25 条分页和五分钟数字选择快照；Surface
只渲染共享的 `/queue add|list|update|delete|reorder|start` 结果，不保存 Queue 镜像或消息正文。
分页历史 Revert 同样由 Application 统一编排；三个 Surface 只渲染 `/revert list`、预览和一次性确认结果，
统一提示仅支持新建分页历史 Thread、执行前会复核并且不会恢复工作区文件。Surface 不保存 Turn 历史、
确认令牌或 Queue/历史快照；按钮和菜单只能提交当前绑定 Actor 的规范选择器。
Gateway 计划任务同样由 Application 统一编排；四个 Surface 只渲染 `/schedule` 的类型化列表、Run、
预览与操作结果。飞书管理按钮携带完整任务或 Run ID 并继续走共享命令；显式命令和 `schedule_task`
工具预览都按精确 Surface 复用同一呈现入口，飞书与 Telegram 的创建/删除确认按钮提交同一五分钟令牌，
飞书按钮被接受后会把原卡片更新为无按钮终态，微信保留同一文本语法；
QQ 完整字面预览全部取得平台确认后才开放确认按钮与文字 confirm，停止、切换、取消和过期撤销尚未执行的确认；临时呈现身份不作为共享确认权威。Surface 不保存任务定义、Prompt 或共享选择快照，任务与确认状态由 Application 持有。
审批卡片和其他需要等待结果的 `runOrdered` 操作排在所有既有关键消息之后，但会越过尚未执行的
非关键过程输出；关键消息与非关键消息各自保持原顺序。交互取消会移除尚未执行的发送，
并向在途平台请求传递取消信号；在有界清理窗口内取得已验证的迟到消息 ID 时，尝试清理交互入口。
平台已接受但未返回 ID 的写入仍属于结果未知，不自动重发；清理失败不恢复已失效令牌，关闭窗口结束后不再发起清理请求。
生产交互由 Approval Router 统一约束从排队到答复的总期限；发送准备不会延长有效期，
超时复用上述取消路径。Surface 自身的答复计时不能替代 Router 的全链路期限。
Telegram 和飞书在交互消息创建成功或失败时
只记录脱敏身份与平台错误分类，不记录审批正文。
完整接入顺序、组合工厂、身份、配置、存储和验证要求见
[`通讯渠道 Surface 接入指南`](../../docs/surface-integration-guide.md)。
关闭队列时拒绝新输出，立即结束 `runOrdered` 等待者并限时等待在途发送；超时记录告警，
清除余下积压且不再执行发送回调。飞书普通输出选择在期限内排空，期限结束再取消；
有序交互在所有模式下立即取消，其取消信号与普通输出相互独立。并发关闭调用等待同一个关闭结果，不能提前报告完成。
实现位于 `conversation-delivery-queue.ts`，并通过本目录 `index.ts` 公开。`enqueue` 可关联取消信号；已接受任务通过 `settled` 在移出队列或实际执行结束时结算一次，调用方据此释放上游载荷预算。取消在途任务不会提前结算。已取消的入队请求或被取消后移除的等待操作必须将关联可靠回执标记失败，不能将释放载荷预算当作平台送达确认。
`diagnostics.ts` 提供 Surface 内部共用的脱敏阶段计时与异步关联上下文，只携带账号、会话、
Thread/Turn/Item、事件类型及输入/投递标识；输出队列、输入处理和平台调用复用该上下文，
不保留事件正文。公开的 `withPersistentDeliveryDiagnostics` 供组合根注入持久记录 ID，各层通过 `persistentDeliveryId` 关联同一记录，单次操作的 `deliveryId` 独立保留。终态相关任务在 `info` 留痕，任务成功与正文投递成功分别记录，慢操作与失败在 `warn` 留痕；阶段明细、合并与取消
使用 `debug`。诊断不修改平台调用、重试或排队顺序，日志口径与排障步骤见
[`消息详情与日志等级`](../../docs/display.md#消息详情与日志等级)。
`attachment-input-lifecycle.ts` 只管理当前已接收、尚未完成的音视频取消身份，不保存正文或建立提交队列。
三渠道在第一次队列等待前登记，每个Surface实例最多1000个活跃目标、每目标4项，120秒预算包含接收后的等待。
授权停止命令同步取消此前任务；后续附件等待该目标此前全部停止处理结束后，才建立Application提交范围，
Thread仍在前序输入排空后捕获。失败、取消和关闭释放接收范围，已经可能提交的文件沿原保留规则处理。

`surface-input-batcher.ts` 是已授权 Surface 输入的唯一聚合实现，三个渠道直接调用；只合并同一 Surface
会话与 Actor 的输入，提交回调保留 Actor 身份；各渠道把停止状态与实时允许名单的守卫传至 Application，
等待聚合、下载、会话锁或图片准备后仍需复核，缺失授权接口失败关闭。批次仍只合并 Surface
明确标识的图片批次，普通文字、单图和无批次标识的消息立即提交。图片落盘后仍由渠道管理，批次
flush 时由该共享边界一次读取并复核可信 MIME、PNG/JPEG/WebP/非动画 GIF 签名、单张 10 MiB 与整批 20 MiB，转换为
有界 Base64 Data URL 再交给 Application；Gateway 只在本次 Turn 内存中持有 Base64，
不写入自身日志或独立存储，也不向 App Server 发送本地路径，不在 Surface 维护另一套识图会话或重试队列。

`video-attachment-store.ts` 为四渠道提供独立视频附件暂存与单文件随机引用：复用私有媒体存储，按渠道分目录，最多保留八个文件并允许一个串行去重候选，每个文件最大 64 MiB、24 小时过期；只初步验证 MP4/WebM 容器签名，实际可解码性由 Strata 判断。流保存及哈希含排队最多 60 秒、最多四条在途流，关闭销毁流并等待收尾。`store` 接受已授权的 ConversationTarget 与 Actor，按作用域和 SHA-256 去重；Adapter 在提交成功或结果不确定时 `retain`，确定未提交时 `discard`，复用旧附件不会被失败清理删除。去重仅保留有界内存元数据，不续期，不跨会话或重启恢复映射。共享附件提示指导原引用追问及有界 context 传递。引用是持有者凭据，仅提交给完成授权的当前 Conversation；MCP 不提供列举入口，不依赖可伪造的 Actor 参数鉴权。引用不代表跨会话身份认证，泄露后可在有效期内转授读取权。暂存内容不写 StateStore；使用方式与部署边界见[视频分析 MCP](../../docs/video-analysis-mcp.md)。
四渠道共享的 `/metrics` 分开展示当前 Thread 最近有请求记录 Turn 的运行聚合、指标库保留范围内的会话累计，
`global/providers/models` 支持自然日/周/月、24 小时至 365 天滚动窗口和全部保留历史，
按同一请求口径聚合指标库记录，模型维度最多展示请求量最高的 20 组并说明截断，提供商完整返回；`errors` 用同一
范围展示异常率及按提供商、模型、状态、HTTP 状态和错误类型形成的前 20 组异常，附带最近发生时间。
不把请求累计输入误写成上下文占用。当前会话显示完整 ID、已有官方执行耗时及普通请求平均首 Token、加权输出速度；主 Thread 耗时与递归请求性能的范围分别保留，缺失不推算，历史耗时不完整明确标记。压缩摘要只列请求数、Token 和模型/异常，不展开性能、本地价格或费用；完成卡只显示官方整轮耗时，标为“本轮耗时”。
信息类聊天指令（`/status`、`/usage`、
`/limits`、`/models`、`/sessions`、`/skills`、`/mcp`、`/plugin`、`/permissions`、`/goal`、
`/metrics` 等）输出统一为 Markdown 列表：首行为 `##` 标题、小节为 `###`
标题、字段为 `-` 列表项、明细缩进嵌套；`/diff` 与操作结果保持原文。四渠道分别用飞书卡片
Markdown、Telegram HTML、微信结构化字段及 QQ 安全 Markdown/完整字面回退渲染列表。
`/sessions` 和 `/archived` 在飞书、Telegram、微信和 QQ 统一每页十条，由 Application 完成分页；Surface 直接呈现当前页，不二次切片。共用可复制的分页/筛选命令，仅支持运行状态、固定状态、Provider 和关键词。
自定义会话分区入口及其管理员权限已移除。内置 Pinned 在三渠道统一复用 `/pin` 与 `/unpin`，
渠道只提交选择，不保存分区状态。
`turn-reply-targets.ts` 只在 Surface 内存中把待提交输入的精确平台消息 ID 绑定到实际
Thread 与 Turn，允许 `turn.started` 早于提交响应时仍原生回复正确输入；读取、登记与删除均核对
Conversation，旧会话完成不能删除新会话已登记的回复目标。不保存消息正文，Turn、Thread 或 Surface 关闭时清理。
`quoted-input.ts` 把各平台已验证的回复/引用正文转换为有界、明确标记且与当前消息分离的上下文；
引用获取仍由各 Surface 负责，不能读取 Gateway 私有历史或让引用内容参与命令解析。
`plan-presentation.ts` 统一完整计划与新增完成步骤的有界展示、状态符号和去重指纹；Telegram 复用
同一个按完整 Conversation 与 Turn 隔离并在完成时释放的进度状态，飞书保留原地更新卡片所需的平台消息状态并核对接收会话；微信不展示
结构化计划，其回复窗口只保留生命周期、终态与全局空闲通知。各渠道只决定完整计划是原地更新还是
追加紧凑进度。
`lifecycle-presentation.ts` 向 Telegram、飞书、微信和 QQ 提供 Gateway 上线、Turn 开始确认、子代理
开始/继续/完成通知、Hook 完成提示和 Turn 结束汇报的共享结构；具体事件仍按渠道能力准入，微信不开放子代理过程通知。Hook 按上游完成通知展示安全状态摘要，经四渠道内存投递，微信将其纳入回复窗口预算，不写入持久输出日志。OpenAI 启动传输探测全部失败时，上线通知增加代理检查提醒，
官方主路由缺少鉴权时增加未登录提示和 `codex login` 或 `/model` 的操作建议，不显示目标地址或
底层错误；飞书和微信仍只通知已有安全会话。完成卡片对 `unauthorized` 按 OpenAI 官方与其他
Provider 分别生成固定凭据提示，不展示上游原文。完成通知在 `basic` 下保留状态、上下文、可用耗时及必要异常；`brief` 不增加耗时。
`detailed` 另显示模型设置、本轮请求结果、已观测 Token 总计、缓存命中率及已取得的当前账户额度，不展开环境、Token/性能分项或会话累计。
缺失本轮输入/输出时不以零或最近请求补齐；上下文仍取最近权威上下文用量。父 Turn 存在明确子代理合计时另展示任务合计，
不混入父 Turn 自身统计；失败后成功的可恢复请求保留“自动重试、最终成功”语义，错误、后台身份、Goal 及仍运行子代理保留。
基础子代理完成仅名称和状态，详细子代理保留模型设置、请求数、Token 总计和缓存命中率，不展开 Token 分项。
四渠道上线和完成通知在所有呈现档位（含 `brief`）保留工作区与已取得的 Git 分支；缺少分支隐藏整行，完成工作区优先名称、其次 ID，均缺失时显示“未知”。详细上线保留会话摘要及工作目录、Session ID、协作模式，不再自动展开系统/UA等环境字段。未绑定或尚未恢复时不展示默认模型冒充当前设置。
“已开始处理”和后台继续处理的共享内容从 `turn.started` 接收任务工作区与 Git 分支；缺少工作区采用相同占位，缺少分支隐藏整行，原常规通知准入保持独立。飞书已准入的开始回执统一经 Markdown 发送路径处理可选回复目标，独立于可变 Session 状态卡，后续状态更新不覆盖开始字段。
开始通知的 `titleStyle` 由共享层设置为加粗正文；飞书、QQ、微信消费共享结构化 Markdown，Telegram 在发送时转为 HTML。动态标题在 Markdown 边界转义，Telegram 保留原字面值后做 HTML 转义。QQ 不另设标题样式，微信不再把开始字段拼成仅靠软换行分隔的普通段落。
自动审批通过的详细呈现保留来源、动作、操作和理由摘要；失败及人工审批必要详情不裁剪。正文、指标采集与主动状态/指标查询不变。
原生 OpenAI 鉴权的 Codex Provider 统一显示为“OpenAI 官方”，且只在该类 Thread 显示
OpenAI 周限；速度区分用户选择与生命周期确认的有效设置，设置通知只显示“已选”并将有效档位标为未知，
未知选择不会被标为 Standard；下一 Turn 的选择标为待提交，不承诺生效。完成输出格式化本轮普通请求的出站档位观测：
完整一致时直接显示档位，响应返回值不参与该选择；混合与缺失分别显示，不借用其他轮次或当前选择。
没有请求观测汇总或请求完全未观测时，沿用完成事件既有有效快照并标注“设置快照”，缺省仍未知；部分或混合观测不以快照填补。不根据 Provider 或模型目录猜测功能开关；自定义目录 Provider 使用 `CP <名称>`，其余 Codex 兼容类型保留原 ID，不追加“自定义”后缀。
历史无 Turn 指标只在通用明细和时间范围聚合中按稳定 Provider ID 展示；各 Surface 只保留 HTML、
CardKit Markdown 或微信文本布局以及各自的发送策略。后台 Thread 的文本、审批和完成汇报均标注
短 Thread ID，并继续进入原 Conversation 的有界顺序队列。
`elapsed-duration.ts` 把已确认的 Turn、操作、推理状态和请求耗时格式化为自适应 `ms` / `s` / `min` / `h`，
三个 Surface、CLI 与 WebUI 共用该纯函数；账户用量秒数仍使用独立的中文周期格式。不负责计时、状态或持久化。
`account-format.ts` 统一套餐名称、额度状态、百分比、周期与重置时间格式，供命令结果、运行时通知
和生命周期汇报复用；`accountQuotaFields` 统一状态查询与详细／完整完成卡的提供商归属、余额、周限及重置时间，不发起查询。
`conversation-model-account-command-format.ts` 为三个渠道渲染 `/limits reset` 选券预览、确认命令和消费结果，并在 OpenAI `/limits` 中展示重置券可用数量，并按相同
到期时间合并服务端返回的明细；`null` 到期时间明确显示为“无到期时间”，明细少于可用数量时标出
未返回明细的剩余张数。
`provider-format.ts` 统一已知 Provider 显示名（DS、CLP、CCG、OCG、CP 短标签及 AGG；OpenAI 保留原规则）、命令中的 Provider 文案，并把渠道模型项归一为“提供商 · 原目录模型名”，对后续 Provider 标识做有界展示。`modelListEntry` 返回列表文案与模型名，供列表与“当前模型”行共用；`formatDisplayedProvider` 在会话、模型行和定时任务中复用同一套短标签，官方标识保留原规则。受管账户目录自带的前缀按渠道标签归一；聚合模型按模型 ID 拆出成员 Provider，显示成员标签与原模型名；自定义目录已有的限定前缀与官方主 Provider 的展示名保持原样。统计分组不进入 Surface，模型列表、按钮、状态、会话、计划任务及请求统计明细均保留原模型身份，选择编号、Application 模型目录、文本选择输入、按钮载荷或出站 ID 不变。提供商摘要统一统计可用与暂不可用模型，不改变目录排序或选择编号。同时按实际服务档位格式化速度，并依据当前模型目录展示 Fast、Ultrafast 支持情况，供模型、状态与生命周期展示共用。
`markdown-fence.ts` 只识别反引号或波浪号围栏、合法开头与匹配结束并推进纯状态；共享列表、渠道命令、问题预览及最终正文复用它，字符预算、分片、截断和转义仍由各渠道负责。
`markdown-inline-code.ts` 识别完整等长反引号串包裹的行内代码，供微信正文、Telegram HTML 转换及反斜杠解码复用；未闭合标记保留字面内容，平台转义和分片预算仍由调用方负责。
`reasoning-effort-format.ts` 统一模型菜单、状态与运行结果的思考设置文案；目录声明 `enabled` 时使用思考模式选择，`enabled` / `none` 分别显示开启/关闭思考，其余等级原样显示，提交给 Application 的控制值保持不变。
`slash-command.ts` 统一飞书与微信的严格斜杠命令解析，并规范化三个渠道共同公开的
`/h`、`/work`、`/r` 快捷命令；Telegram 在 Bot 注册边界接入同一组显式映射。
纯格式化实现分别位于
`conversation-command-help.ts`、`conversation-session-command-format.ts`、
`conversation-scheduled-task-command-format.ts`、`conversation-extension-command-format.ts`、
`conversation-hook-command-format.ts`、
`conversation-model-account-command-format.ts`、`conversation-workspace-status-command-format.ts` 和
`conversation-command-outcome-format.ts`，按帮助、会话、计划任务、Skill/MCP/Plugin、模型账户、
Workspace/状态与操作结果分派隔离。它们统一四渠道已支持入口的平台无关命令文案，不导入平台 SDK，
也不写入 Application 状态；OpenAI `/usage` 以账户摘要为主，在当前 Thread 有效时追加有界的官方 Credits、可选美元、
字段完整时的 Token 汇总和最多 8 个明细组，官方估算不可用或查询失败时只追加稳定提示；DeepSeek `/usage` 显示余额，
未支持的 Provider 明确说明能力缺失。计划任务确认、列表、运行记录和命令结果格式也通过本目录
`index.ts` 供 Bootstrap 动态工具回调复用。
`conversation-command-renderer.ts` 把完整 `ConversationCommandResult` 穷尽映射为共享命令文案；模型面板通过
`formatConversationModelState` 共享当前/待生效字段、切换后果及下一步提示，渠道自行处理按钮与分页。
工作区、会话和模型元数据单行化后，由渠道传入的字面格式回调处理；Telegram 保留原值到 HTML 边界。
`conversation-hook-command-format.ts` 只接收 Application 的 Hook 展示快照，集中生成纯文本列表、详情、
持久配置确认文案和合法操作选项；原样使用 Application 选择标识与确认令牌，不展示内部 Key 或哈希。
向组合根公开共享文案的保真检查并接收窄文字保真能力；组合根显式组合飞书、Telegram 与微信策略，未知渠道拒绝审查。Application 在列表、预览与确认时复核；微信格式中和会改变审查字段时拒绝信任。结果区分共享配置保存和实例刷新未确认。
飞书和 Telegram 接入既有鉴权动作路径，微信按相同命令提供文本入口。
四渠道在已支持命令范围内复用共享映射和字段文案，Telegram、QQ 与飞书在各自交互式渲染器中处理按钮、键盘及专属展示。
`/skill` 返回带序号的已启用项，`/skill <名称或序号> <任务>` 通过 Application
提交官方结构化 Skill 输入；Surface 不接收或拼装本机 Skill 路径。
`/mcp`、`/mcp health`、`/mcp reload`、`/mcp <名称或序号>`、工具/资源/模板分页搜索、`/mcp login ...` 与
`/mcp resource ...` 共用详情、OAuth 能力判断和只读资源格式；OAuth 完成结果由三个渠道共用格式，
成功静默发送、失败按错误通知发送；健康检查只展示需处理项与提示，刷新明确说明在 Thread 下一次
活动 Turn 生效；健康处理命令使用当前列表数字序号，最多展示 8 项并明确省略数量；资源正文明确标为
外部不可信内容。详情及分页中的后续命令沿用 Application 返回的原始选择器，Surface 不使用 Server
名称重新构造命令。
`/plugin` 无参数显示已安装项第一页，`/plugin list [页码] [search <关键词>]` 使用全局数字选择器
进行每页 8 项的本地分页过滤，`/plugin health` 只展示未启用、不可用和 Marketplace 加载失败等状态，
问题最多展示 8 项；只带选择器时查看开发者、分类、能力、认证时机及套餐等安全详情，能力与套餐
列表最多展示 8 项；`health` / `list` 同名 Plugin 带任务时仍可直接调用，详情使用完整 ID 或序号；
带选择器和任务时调用 Plugin；飞书按相同分页生成一次性任务表单，
Telegram 使用当前页按钮和绑定 Actor 的十分钟一次性 ForceReply，微信提供可复制的编号任务命令；
各 Surface 都不拼装 Plugin mention 路径。
`user-facing-error-format.ts` 统一三个渠道的结构化用户错误文案，只保留渠道名称差异；
`error-metadata.ts` 统一渠道日志中的受约束异常类型、机器错误码和锁定 App Server
白名单拒绝分类，拒绝异常正文、堆栈、请求标识及上游自定义名称进入日志；Bootstrap
继续通过注入的 Pino `err` 序列化器处理组合根异常。
`input-copy.ts` 统一补充文字、文件、图片与音频追加到当前 Turn 的确认文案；
`output-copy.ts` 统一 CLI 输入镜像、断线、警告、操作失败、停止交互、空回复与内容截断等输出
语义，以及 Thread 被其他 Codex 客户端占用与自动恢复的提示；各渠道继续自行决定 HTML、CardKit
Markdown、纯文本布局和发送方式。
`interaction-copy.ts` 统一审批、用户输入和 MCP 交互的处理、取消、超时、跨客户端解决及提交结果
语义，以及普通问题局部题号和异步问题已有全局题号的显示；不改变问题 ID 或回答索引。平台仍各自使用按钮、卡片或可复制命令完成交互。
`pending-interaction-registry.ts` 统一四个渠道待处理交互的请求 ID 与一次性令牌索引、容量限制、
请求级取消信号、准备期失效与立即释放身份及容量、完成清理和超时计时器释放；
旧请求的迟到清理不能释放同 ID 新请求的占用。平台仍各自负责授权复核、消息准备、输入解析、
决定映射和结果更新。
`text-file-copy.ts` 统一三个渠道文本文件下载失败、1,000,000 字节上限以及编码、空内容、文件名和控制字符拒绝文案，
同时保留渠道名称以便定位来源。`text-file-input.ts` 统一文件名安全校验、UTF-8 严格解码、
BOM 与常见终端转义序列清理、残留控制字符拒绝和有界流读取（流读取总时限 30 秒，不因持续到达数据而延长）；平台下载与错误类型仍留在各自 Surface。
`text-attachment-store.ts` 的 `prepareTextFile` 统一三渠道下载及完整性检查之后的解码、暂存与结果组装，复用各渠道原有 Store；返回 bytes 保留原始明文字节数。清理后不超过 32 KiB 的文本内联提交，更大文本保存为随机命名的私有文件并提交路径与到期时间。每个渠道暂存目录最多 50 个文件、50,000,000 字节，保留 24 小时，每分钟及启动时清理过期文件；关闭停止清理计时器但保留尚未到期文件。文件内容不写入 StateStore，工具读取仍受当前 App Server 权限约束。
`runtime-status-format.ts` 统一账户、额度与 MCP Server 运行状态的稳定中文语义和脱敏；
Core 只把 MCP 启动失败、取消及异常恢复投递给 Surface，首次启动中和正常就绪保持静默；
Telegram、飞书与微信分别通过 HTML 面板、CardKit Markdown 或按会话排序的纯文本气泡发送。
`configuration-change-format.ts` 统一 Telegram、飞书与微信已有的配置热加载、重启、重装和失败通知；
Workspace 操作提示只在 Telegram 实际提供切换按钮时声明可点击。
新增 Workspace 的数字切换命令使用 Bootstrap 从当前完整注册列表附带的序号，不按新增子集重新编号。
`operation-presentation.ts` 统一操作标题、状态、耗时与退出码元数据、上游敏感占位符和单行摘要；共享准入在所有工具档位隐藏子代理 `wait` 的正常过程，失败和拒绝沿用有效设置，独立生命周期通知与既有可靠投递义务不变。
该模块也为三个渠道提供有界的压缩通知去重与文案；
Telegram HTML、飞书 CardKit Markdown 与微信安全文本的转义、布局、分组和发送仍由各自
Adapter 负责。
`operation-update-buffer.ts` 在 Surface 边界按完整 Conversation 与 Turn 有界暂存成功的查询操作，并统一在非 Commentary
最终文本或 Turn 完成前 Flush；最终回复前单项
保持原详情，多项生成一次分类计数汇总，并展示最多 8 个去重后的详情及各自次数；
超出时明确省略数量。可靠投递入口在每个终态操作后显式排空所属 Turn 的缓冲，避免仅凭内存聚合就确认持久记录。飞书网页搜索完成后直接发送，不进入该缓冲；失败、拒绝和其他操作同样
不进入缓冲。
Computer Use 的 MCP 操作也不进入查询缓冲；飞书在同一卡片展示调用开始和终态，复用已有去重、
顺序队列及 `hidden` 模式。具体操作说明已在 Client 边界提取并清洗，过程展示不使用 MCP 读写声明标签。
`bounded-local-file.ts` 为图片和显式文件提供有界普通文件读取，拒绝链接、身份/长度或修改时间变化；channelFilePolicy 统一声明四渠道文件准入与预算，保留各渠道内容合同，共享 MP4/Ogg-Opus 文件头校验。文件名拒绝控制字符和路径分隔符；具体限制见 `docs/channel-file.md`。`SurfaceAdapter.sendChannelFile` 由四渠道实现，携带原 Thread 实时守卫、媒体类型和取消信号；显式图片同样在排队、读取和请求边界消费这些信息，不因后台解绑改投前台。未修改普通生成图与原长正文文件的内容预算。

`generated-image.ts` 对 App Server `imageGeneration.savedPath` 指向的生成图片和
`codexc channel send-image` 提交的渠道 spool 图片执行同一读取校验：绝对路径、拒绝符号链接、
空文件、超过 10 MiB 的内容和非 PNG/JPEG 签名；Telegram、飞书、微信与 QQ 分别负责平台上传和发送，QQ 使用更小的 5,000,000 字节上限，
不读取 `imageView` 或用户上传图片路径。
Telegram、飞书和 QQ 收到仅含 `fileId`、没有 `savedPath` 的原生图片生成完成结果时，
独立提示“图片已生成，但当前无法获取图片内容”，不受操作过程显示档位影响；不展示引用、
不尝试下载或声称图片已发送。若同时有路径则沿用原有安全读取与平台发送链路。
微信仍按回复窗口策略忽略这类操作事件，不新增引用结果通知。
`SurfaceAdapter.sendChannelImage` 是可选的渠道图片发送入口，由 Gateway 的
`channel-image-spool` 驱动，复用 `generated-image.ts` 的读取校验和各自平台上传发送；
四个 Surface 都实现该入口，微信按目标 Conversation 复用其回复上下文与授权检查。
Surface 不得直接操作底层 JSON-RPC Transport，也不得把平台 SDK 类型引入 Conversation Core。

会话命令统一映射到 Bootstrap 注入的 Application `ConversationCommandExecutor`；Surface 只保留普通输入、状态或菜单实际需要的能力切片，并负责提取命令名、参数和渲染类型化结果。
Skill、Plugin 与子代理新建 Turn 时由统一 `turn.started` 生命周期确认，命令结果
不重复发送启动提示；该事件保留具体扩展类型和名称，追加到活动 Turn 时仍渲染明确确认。普通文本、图片下载、平台帮助、身份查询和
交互取消保留在平台边界。PNG/JPEG/WebP/非动画 GIF
的大小限制与内容签名校验由 `managed-image-store.ts` 在 Surface 内复用；
一次性音频的 20 MiB、WAV/MP3/M4A/WebM/OGG 内容签名、Unix `0700/0600` 或 Windows 当前 SID
ACL 私有暂存和一小时清理由
`managed-audio-store.ts` 复用。两者通过内部 `managed-media-store.ts` 统一私有目录生命周期、
有界流落盘、临时文件清理和过期清理；图片与音频从取得下载地址到完整流落盘共用 30 秒总预算，关闭会取消在途下载和 `pipeline`，关闭后的新操作与迟到结果均拒绝。视频的落盘沿用 60 秒预算并接入相同关闭信号；各自的格式白名单、限制和保留时间保持独立。
三渠道音频在接收后、首次排队等待前登记 Surface 附件取消范围；等待此前停止命令结束后建立 Application 提交作用域。`/stop` 取消旧准备，下载前捕获工作区与 Thread，提交前复核原目标和实时授权，避免下载完成后意外启动新 Turn。
组合根在创建渠道前收紧共享 `uploads` 根目录；媒体暂存器启动时拒绝符号链接、非目录和非当前用户所有的目录，
再收紧渠道目录权限，Windows 继续由共享 ACL 辅助函数验证当前 SID 所有权并关闭权限继承。
媒体下载中的目录和文件权限操作异步执行，并共享下载取消信号。
Application 只接收绝对本地路径；
平台仍各自负责取得受信下载流。所有输入在调用 Application 前必须构造
`SurfaceAccessContext` 并通过对应访问策略。

Surface 只能渲染明确标记的结构化用户错误，不能直接复用其内部回退文案；App Server 的 Turn、
warning 和 MCP 错误只使用 Client 边界已经统一脱敏并限长的稳定字段。未知异常、凭据和未经约束
的响应正文不得带入聊天消息或日志。

Bootstrap 把共享的 `display.operation_updates` 五档模式显式注入各 Surface Outbox。`full`
显示完整操作，`detailed` 与其准入相同，正常详情脱敏后单行最多600字符并标记省略，失败/拒绝保留完整脱敏详情；`compact` 显示单行摘要，其中子代理只保留启动和失败、抑制成功的等待与交互操作，
`failures` 只显示失败或拒绝的操作，`hidden` 忽略新到达的普通 `operation.updated`；已入箱终态保留上述可见表示与送达义务。Core 始终正常归约操作，审批与其他关键输出不受影响。
可选 `display.subagents` 缺省开启，关闭时统一隐藏新的子代理启动、联系、结束通知及子代理工具操作；其既有可靠结果仍发送，其他工具不受该开关影响。正文、生成图片和父轮完成/异常保持独立。三个支持过程展示的渠道复用同一子代理类别判定，微信不扩展过程能力。
上下文压缩开始和完成由共享展示状态去重，三个渠道均独立、有序发送，不受操作显示设置影响。
完整工具档逐项发送现有操作详情；其余工具档下，Telegram 把同一 Turn 的成功查询类操作延迟聚合；
飞书只聚合 MCP 与动态工具，网页搜索完成后立即发送。MCP 目录与实际工具调用统一显示 App Server
提供的只读、可能写入或未知提示，该提示不替代审批或执行结果。微信
除上下文压缩生命周期外，不主动发送操作事件；Surface 只实现平台格式，不各自定义
第二套显示配置。

Bootstrap 还把默认开启的 `display.plan_updates` 注入 Telegram 与飞书 Outbox。开启后，Telegram 与飞书消费
Core 发布的结构化 `plan.updated`：首次发送完整计划；飞书后续只原地更新这一张卡，
Telegram 则在步骤首次完成时发送紧凑进度并保留首次快照；微信不展示计划。不解析或拆分模型
正文，也不根据操作事件推断步骤完成时间；多个步骤若在同一官方通知中完成，只能按该通知的实际
到达时间展示。关闭时不产生任何计划渠道消息，Core 的计划归约保持不变。

Telegram 与飞书在 `display.reasoning` 开启时消费 Core 发布的 `turn.reasoning`，按顺序展示“思考中…”状态，连续思考每段只
显示一次，每段独立计时并流式原地更新耗时；微信不展示思考状态，摘要与原始思维链内容不进入渠道。
