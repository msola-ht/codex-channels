# Application

`ConversationTurnUseCases.prepareAttachmentSubmission` 在等待前序输入前登记音频或视频取消作用域；Surface 排空前序输入后调用一次 `captureTarget`，在下载前捕获当前工作区与 Thread，允许前序输入正常创建首个 Thread。下载完成后在会话锁内复核目标和调用方实时授权，并在异步会话准备之后、Turn 请求发出前再次复核已捕获的 Thread，再通过原有 Turn 提交入口发送文本视频引用或含 `localAudios` 的稳定输入。未捕获目标不得提交，取消后不得捕获；首次输入仍由既有 `ensureSession` 建立 Thread，不新增原生视频协议字段，不在 Application 下载媒体或调用视频模型。

返回的提交作用域提供取消信号、一次性 `captureTarget` 和 `submit`、`mayHaveSubmitted` 和 `dispose`。Surface 在首次等待前创建作用域并在结束时释放；`/stop` 取消当前目标的附件准备，准备总时限为 120 秒，包含等待前序输入，捕获目标不重置时限。每个目标最多 4 个待处理作用域，全局最多 1000 个目标。RPC 可能发出后即使确认失败也保留附件至过期，避免删除已经进入 Thread 的引用；不自动重试提交。

本目录实现跨模块用例，协调 Codex Client、Conversation Core、Session Router 和模型设置，不处理 Telegram SDK 或底层 Transport。

普通消息的 `submit` 接收 Surface 提供的实时授权闭包，在等待会话锁、Thread 准备及最终 Turn 写入前复核；
输入同时固定接收时的 Workspace ID 与目录，变化时拒绝。图片准备后的 start/steer 也保留最终守卫。
已经提交的请求仍按实际结果结算，不因后续撤权自动重试或丢弃响应。

模型选择和会话生命周期命令显式传递实时授权闭包：在会话锁、目录/默认配置等待和后续写入前复核，
模型选择的 Queue 检查也保留该守卫。默认速度已保存后撤权只阻止后续偏好更新，不回滚共享默认值。
模型目录、模型/effort/速度选择还固定操作开始时的 Thread；官方归档/删除导致原绑定消失时，
不得把旧模型偏好写给下一会话。跨 Provider 切换仅在自身解绑完成后接受未绑定状态。
恢复、接管、解绑和工作区切换的订阅补偿独立执行，避免撤权阻断必要清理。
当前 Thread 的自动审批设置在锁等待及最终发送前复核 Actor、Workspace、Thread、空闲状态和待处理交互；
已发设置仍等待权威确认和共享归约，撤权只阻止后续操作与结果展示，不回滚已生效设置。
Revert 的列表、预览和确认固定接收时的绑定，Thread/历史分页/Queue 读取与最终回退均传递实时授权守卫；
确认令牌的 Actor 归属不代替实时授权。已提交成功的回退仍清理选择快照，不因后续撤权重发或撤销。
`stop` 保持无锁即时取消本地准备；等待 Provider 后发送中断前复核授权和原 Thread 归属，
原 Thread 仍归属同一 Conversation 的后台状态不单独构成拒绝条件。命令结果出口复核捕获的工作区范围，
只有显式 Workspace 切换按其新范围返回，不用旧工作区守卫阻止合法切换结果。
rename、pin、compact、review 和 Goal 命令固定锁前目标，Thread 准备及最终请求前复核授权和绑定；
需要空闲的操作在最终发送前再次核对空闲。Goal 查询可能准备 Thread，也受同一守卫约束。
已经提交的 Review/Goal 结果继续归约，不能因为输出时撤权丢弃真实已发生状态。
Plan 预设/模型读取、模式保存、Queue 复核与 Turn 提交均保留实时守卫；模式保存前还核对原 Thread。
授权有效时已经保存的模式不因稍后 Turn 提交失败自动回滚，仍以待生效状态查询；成功 Turn 才消费它。
新 Turn 准备固定原绑定，创建成功后最终提交守卫改为核对新绑定，防止后续 Provider 等待把输入发到过期目标。
Skill、Plugin、Agent 命令固定锁前目标，目录解析后复核，并将守卫传到最终 start/steer；扩展列表返回前也复核。
MCP 登录与资源读取固定捕获的 Thread，目录查询后不得转向其他绑定；刷新各 Provider 的新请求分别守卫，
已经提交的 OAuth/刷新结果仍照实际结算。OAuth 完成仅匹配本 Gateway 发起的最新登录：精确核对
loginId、实际连接 Provider、Thread/server、原绑定与 Workspace 及授权；迟到、重复、转移后的结果不投递。
会话列表固定查询开始时的工作区 ID/目录，目录搜索、轮数读取和缓存写入前复核，避免旧目录结果被记到新工作区。
Permission Profile 分页与计划任务权限预检同样将实时守卫传到 Provider 等待及每次 RPC 尝试。
显式账户查询携带原用户授权，后续 HTTP/RPC 与本地估算分别复核；带守卫的第三方请求独立执行，
无守卫的后台请求仍按既有规则合并，已经提交的账户快照写入独立结算。

Fast 与 Ultrafast 按各自有效开关和模型目录选择；自动继承的禁用档位回到 Standard，保存偏好与显式待生效覆盖在提交前复核，失效时拒绝并要求用户重新选择，不清除保存数据或重解释已有 Thread 的实际设置。

## 文件

- `reasoning-repeat-guard.ts`：第三方当前已绑定轮次的重复思考保护；按推理 Item 与内容段分隔，原始思考和摘要各持有独立检测器，用有界内存比较 200–4096 个 Unicode 码点片段的连续三次重复。检测分批让出事件循环，不读历史、不保存正文；通过注入端口精确中断原 Turn，收到官方中断终态才报告已停止，失败与确认超时可见。对应连接变化、绑定失效、轮次结束及关闭清理缓冲，不自动继续或修改 Queue／Goal。

- `hook-port.ts`：定义 Hook 列表、安全审查摘要和精确版本信任/启停的窄端口；不暴露任意配置写入。
- `conversation-hook-service.ts`：锁前捕获 `/hooks` 的 Actor、Workspace/目录、Provider 和 Thread，锁内执行列表、详情、预览和一次性确认；读取与最终写入均保留实时守卫，写前复核确认期限及 Surface 无损审查能力。查询、写入和回读固定到同一 Provider，运行配置刷新由 Client 协调共享配置的实例。选择快照与确认仅在内存保留五分钟，绑定 Hook key/hash 和配置版本；已提交写入继续失效旧交互、刷新与权威回读，不因撤权中断结算；本地守卫拒绝不误报写入结果未知，不把保存成功当作实际执行成功。

- `index.ts`：本模块的公开导出入口。
- `conversation-command-service.ts`：执行平台无关的会话命令并返回结构化结果；只依赖命令实际使用的能力组合，Queue、Revert、MCP、Plugin 与计划任务分支由明确 handler 处理，不包含平台文案或消息布局。
  命令和模型/审批按钮必须传原 Actor，由组合根注入当前 Surface 账号策略；缺少授权实现失败关闭。
  Queue 命令把当前 Workspace 作用域的授权闭包传到锁、选择器和最终请求边界，拒绝后不自动撤销已提交写入。
  按钮模型选择通过 `selectModel` 接受精确 Provider 与模型身份，不重新解释为文本选择器。
  `/autoreview [on|off]` 查询或修改当前 Thread 实际审批方式；审批方式不受本地 Provider 与模型白名单限制；`selectAutoReview` 的按钮固定原 Thread ID，由会话用例在锁内复核。
  会话恢复结果携带已绑定模型，新会话与 Workspace 切换结果携带下一条消息将使用的模型和 Provider；
  存在原 Thread 时，新会话结果同时携带原 Thread ID，供三个 Surface 像自动解除占用提示一样
  展示可复制的 `恢复会话：/r <Thread ID>`。
- `conversation-command-parser.ts`：集中定义会话命令的参数语法、用法提示和查询视图；只做纯解析，不调用 Application 用例。
- `scheduled-task-command.ts`：定义计划任务命令的解析结果与创建请求类型，解析固定句式和模型标记，不依赖具体用例服务。
- `scheduled-task-service.ts`：通过异步存储端口执行计划任务用例，持有列表选择器和一次性确认状态；消费命令解析结果，并通过注入端口检查授权、取得创建上下文及触发运行。渠道命令复用 operation 守卫，数据库读取、领取与派发前复核原 Actor/工作区；创建上下文在容量等待前捕获。确认最终写入前复核有效期，失权而未展示的预览令牌取消；已提交结果继续结算。创建数量上限同时由存储原子约束。
- `scheduled-task-tool.ts`：定义前台 Agent 可见的 `schedule_task` 输入 Schema，并把模型传回的
  参数校验后映射到 `ScheduledTaskApplicationService`；将工具请求的取消和当前归属复核传到预览、写入及手动调度边界，失效请求不展示预览并撤销未交付确认令牌。创建和删除仍返回待确认预览，不直接改写 Store；已提交的写入不因取消而回滚。
- `conversation-account-metrics-service.ts`：组合账户、Provider 额度与本地请求指标异步查询；`ConversationService` 作为统一用例入口委托执行。`/metrics`、可见会话页的本地 Turn 计数与周额度估算等待数据库 Worker，不在调用线程执行 SQL；账户快照按 Provider 排队，执行前拒绝取消及早于已确认额度序号的结果。只有写入成功才推进序号，较新观测保存失败不阻断旧有效结果；调用方取消等待后，已派发写入仍按实际确认结果更新缓存与序号。
- `conversation-extension-query-service.ts`：组合模型目录、Skill、MCP、Plugin 与 Permission Profile 查询和选择器解析；不拥有 Turn 或 Session 生命周期。
  OAuth 关联最多保留 128 个、各十分钟；响应前每次请求暂存至多 8 条完成通知，每条错误上限 4,096 字符。
  超限且无法匹配结果时明确要求查询实际状态；失败、Thread 关闭、断线及服务关闭清理关联，不撤销已提交登录。
- `conversation-session-query-service.ts`：拥有会话列表投影、排序、分页轮数查询和展示缓存刷新/失效状态，并提供会话选择器 `resolveThread`（序号、精确 ID/名称或唯一 ID 前缀，歧义与缺失明确失败）；不修改绑定，不建立独立会话索引。派生轮数扫描每轮最多 10 秒、100 页，同 Thread 后台刷新合并，后台最多 3 个并发；关闭取消扫描和本地指标等待，拒绝迟到列表结果及缓存写入，超限时轮数保持未知。本地轮数指标读取失败降级为展示缓存或未知，不阻止权威列表返回。缓存读写、失效或删除失败后，本实例停止使用该缓存并报告固定操作分类；不返回旧缓存，不阻止权威事件归约或用户输入。失效和删除先更新代次，迟到扫描与本地指标结果既不回写也不展示。
- `conversation-event-coordinator.ts`：在稳定输入事件归约前失效选择快照与展示缓存、处理待生效偏好和 Reserve 标记；OAuth 完成先经过 Application 登录关联，再交 Core 呈现。归约后执行 Reserve 收尾；子代理跟踪和后台释放调度通过注入端口保持原顺序，不等待 RPC 或渠道输出。
- `turn-errors.ts`：把单次 Turn 失败归约为稳定的错误类型、错误码与安全文案；只读取已归约的错误对象，不执行 RPC、不生成平台输出。
- `pagination.ts`：提供 Application 层共用的分页总数、页码校验、偏移/切片与一基序号；错误类型与文案仍由各调用点提供，不持有列表状态。
- `bounded-map.ts`：只提供按插入顺序裁剪 Map 容量的内部操作；过期、键刷新、确认消费及计时器清理由服务保留。
- `conversation-service.ts`：按 Turn、Session/Workspace、Queue/Revert、扩展与账户指标五类稳定能力接口公开用例，
  新建与恢复切换将仍有活动 Turn、子代理或交互的旧会话保留在后台；释放前核验已加载后代的权威状态，
  包括冷启动后尚无本地活动记录的子代理。后台释放与恢复清理共用 Queue、交互、父子活动复核，无法确认时保留绑定。
  成功转后台后通知生命周期所有者补做空闲复核，主动切换的订阅补偿失败则交回绑定恢复，避免遗漏切换期间的终态。
  具体 `ConversationService` 负责新建、恢复、切换、归档和固定 Thread，列表查询委托给会话查询组件；提交、steer 或将纯文本
  写入 App Server Queue，公开 Conversation 状态与最近 Turn 产物；Queue 与 Revert 的稳定方法委托给各自内部用例服务，
  `submitAsyncAnswer` 在同一 Conversation 锁内、发送前校验原 Thread 绑定和问题有效性，再复用普通 start/steer 路径；
  会话列表优先读取本机指标/派生缓存中的 Turn 轮数，所有列表命令都不等待 Thread History 扫描；历史读取失败不阻塞列表且不伪造数量；
  Conversation 状态使用 Core 从 App Server 归约的当前 Goal 与上下文压缩总次数，
  普通 `status` 不执行 Git IO，展示入口 `statusForDisplay` 通过组合根注入的异步只读端口取得当前 Workspace Git 分支；完成卡仅调用 `workspaceGitBranch`，不连带查询模型与账户状态；
  `/stop` 同时取消当前目标的视频准备及当前 Thread 尚未提交的图片准备；已提交 Turn 继续使用官方中断。
  当前 Thread Auto-review 写入则在同一锁内要求已有绑定、空闲且无待处理交互，未知或 Guardian 实际值只读；已确认的相同值不写。等待 Client 的权威通知确认后再核对绑定，返回 Router 的实际值，不创建 Thread、启动 Turn 或乐观修改缓存。
  所有历史选择器限定当前工作区，选择和恢复前的上下文复核在 Conversation 锁内执行；
  通过 Core 跟踪恢复期间的 Turn 通知，在绑定成功后恢复仍有效的活动状态。
  普通新 Turn 在 `ensureSession` 等待旧绑定恢复期间同样跟踪活动通知；未加载 Thread 恢复成功后继续
  原次输入。只读快照报告活动但不含 Turn ID 时拒绝启动新 Turn，不把缺少本地活动缓存解释为空闲。
  恢复已由其他渠道绑定的空闲 Thread 时，同时锁定新旧 Conversation，确认双方无活动 Turn、
  排队消息或待处理交互后调用路由层原子转移，并向原渠道发布关键解绑通知；
  扩展与账户查询分别委托给独立组件，通过 `ConversationQueryPort` 组合窄端口，Skill、MCP 与 Permission Profile 均使用稳定结果。
  空闲释放通过 `releaseIdle` 保留扫描时的 Thread 与活动时间，在会话锁、查询和生命周期 RPC 后复核，
  同时核对活动 Turn、原生 Queue、待处理交互和待结算子代理，再取消
  App Server 订阅并解绑；释放后按主动新建同一语义恢复模型偏好、清除待生效协作模式并失效
  Revert/Queue 快照。普通输入、平台本地命令和审批交互刷新活动时间，输出事件也由组合根统一刷新。
- `conversation-lock-coordinator.ts`：为同一 Conversation、多个 Conversation 的有序加锁；Queue、Revert
  与主会话生命周期共用同一实例。
- `thread-queue-service.ts`：维护原生 Thread Queue 的增删改查、启动、分页选择快照、错误映射和待生效设置冲突检查；
  只有列表发布更新数字选择，内部复核不重排或续期旧页；读取期间的失效不允许重新发布旧快照。
  不负责 Thread 绑定切换或后台释放。
  用户命令固定接收时的 Thread，异步读取与提交前复核 Actor、Workspace 和 Thread；写入响应仍正常结算，
  不因后续撤权重发或回滚。内部生命周期查询继续使用其所属生命周期约束。
- `thread-revert-service.ts`：维护分页历史选择快照、一次性确认令牌、Queue 指纹与执行前并发复核；
  通知失效贯穿在途列表、预览和最终提交，确认成功或失败均清理同会话其他令牌和快照。
  Revert 写请求保持单次调用且结果未知时不重试。
- `model-selection-service.ts`：查询模型、输入能力与思考等级，保存按 Conversation 生效的 Turn 覆盖设置；
  模型状态带不透明的 Conversation/Workspace/Thread/Session 页面身份；选择等待期间新 Turn 开始会取消在途选择。
  加速档位的纯目录匹配复用 `runtime/service-tier.mjs`，与 CLI/WebUI 使用相同的 Fast、Ultrafast 能力判断；回到 Standard 不受当前目录项的不可用标记阻断。
  无 Thread 且无显式档位偏好时从目标 Provider 的 Workspace 有效配置读取服务层级，保留 null，不以目录默认层级推断已启用加速；开启加速前经窄端口核对同一作用域的 `features.fast_mode`，写入前后复核订阅。
  模型目录明确不可用时，浏览保留目录的不可用原因与未知档位，不为显示档位重新连接故障实例；启用加速仍严格检查目录和有效配置。
  独立 CP 切换 Provider 经模型端口读取对应 App Server 目录，官方兼容目录与独立目录分别装配；默认选择保留精确 Provider 和平台模型 ID；总览隔离各 CP 的读取故障，定向操作只查询目标 CP，故障条目不参与能力选择。
  独立目录可从 `model/list` 的默认标记读取默认模型，聚合目录保留含多级路径的完整模型 ID；同一聚合 Provider 内模型选择仍只覆盖下一 Turn，保留当前 Thread。
  官方未登录时为未绑定会话解析唯一第三方，或组合根明确提供的同类账户默认 Provider，并使用其
  Profile 默认模型供状态、菜单与建线程复用；
  受管 Provider 设置应用后按精确 Provider 替换已确认的补充模型目录与默认标记，保留其他 Provider 的目录、已绑定模型及待生效的明确选择；
  没有明确默认 Provider 的多个可选第三方保持未选择状态，发送前要求明确选择；模型选择始终保留 Provider 身份，
  实际离开旧 Thread 的 Provider 切换提示与身份字段分开维护，目标 Thread 建立后不再提示待切换。
  模型选择入口按注入的共享账户状态过滤无有效订阅的 Provider，浏览和手动选择使用相同结果；
  结构化选择不依赖当前浏览范围，异步读取默认设置后及保存待生效选择前再次核对订阅。
  保留当前模型与完整目录用于已有会话的能力查询，不因订阅筛选自动切换或取消 Turn。
  可把主 App Server 的 Codex 官方模型目录以精确自定义 Provider ID 克隆为切换菜单项，不复制或
  持久化模型目录；模型声明的 Codex 多代理运行时作为只读能力提示保留，OpenAI 替代模型与退役时间
  不复制到第三方 Provider，且不参与模型可用性、自动切换或审批判断；
  在 Workspace、新会话或同 Provider 历史 Thread 切换前后捕获并恢复当前模型、思考等级与服务层级；切换 Workspace
  后下一条消息强制新建 Thread，不自动接续目标 Workspace 的历史 Thread，
  显式恢复不同 Provider 的历史 Thread 时则尊重该 Thread 的 Provider；未绑定期间的偏好通过 Router 持久保存，重启后按精确 Provider 与目录校验恢复；已有 Thread 的待生效覆盖仍只在内存保存；
  选择不同 Provider 时保留并解绑当前 Thread，为下一 Turn 在对应 App Server 新建带精确
  `modelProvider` 的 Thread；思考等级优先采用目标 Provider App Server 的有效配置，目标模型不支持
  或未配置时才回落其目录默认值，避免把原 Provider 的设置或专属历史发送到不兼容的 API；旧 Thread 保持可恢复；
  含内联图片或本地音频的输入在创建或追加 Turn 前必须分别通过当前模型的 `image` 或 `audio` 能力检查；
  选择 OpenAI 模型时，先通过模型窄端口保存 Standard 用户默认层级，再设置下一 Turn 的 Standard
  覆盖；保存失败不更新选择或解绑旧 Thread，App Server 重启后不再加载旧加速默认值。
  Fast 与 Ultrafast 只允许当前模型目录明确声明支持时开启，Standard 可显式退出已有加速档位；
  主 Provider 通过模型窄端口保存用户级默认层级，独立 Provider 不改写主配置。
  无绑定偏好恢复时重新检查档位；选择 OpenAI 模型统一重置 Fast/Ultrafast 为 Standard。
- `luna-reserve-port.ts`：定义可取消的账户额度读取、隐藏 Reserve 模型解析和带最终提交守卫的 Thread 设置更新窄端口；
  Application 不接收生成协议类型。
- `luna-reserve-service.ts`：在同一 Conversation 锁内处理最终用量错误后的后端授权切换，并按 Thread
  在进程内保存原模型和已确认的 Reserve 设置；活动 Turn 完成前延后设置写入，同一账户的即时与定时刷新共用正在进行的轻量额度读取，
  失效期间的新触发会在旧操作结束后继续；账户、Thread 生命周期与关闭均有取消路径，设置写入失败不重试，
  账户失效前已被 App Server 接受的写入会提示用户确认当前模型，不执行可能覆盖后续选择的补偿写入；
  切换成功须由 RPC 与实际设置通知共同确认并完成共享归约，不乐观改写 Router；原生客户端修改受支持模型设置后放弃自动切回。
  组合根在每次设置通知归约后同步观察变更，刷新等待期间与已确认 Reserve 状态都受保护；
  手动改变后改回原值也不恢复自动写入资格。自身已提交目标的匹配通知允许继续确认。
  未确认写入不由恢复定时器重试，失败消息不在 Gateway 重放。
- `collaboration-mode-port.ts`：定义 Default/Plan 预设的稳定查询边界，不向 Application
  暴露完整实验协议。
- `collaboration-mode-service.ts`：把官方预设与当前模型设置组合为下一 Turn 的协作模式覆盖；
  取得 Turn 覆盖时合入后续明确选择的模型和思考等级，避免模式快照覆盖较新的用户选择。
  模式按 Thread 同步，只在内存保存尚未生效的选择。
- `model-port.ts`：定义项目拥有的 Provider、`text/image/audio` 输入能力、思考等级、服务层级、
  Codex 多代理运行时与可选模型替代提示，以及
  Standard/Fast/Ultrafast 默认值窄端口；CLI Setup 的全局模型默认值不进入会话 Application 边界。
  Application 和 Surface 不接收完整官方模型对象。
- `account-port.ts`：分别定义 OpenAI 账户 Token/额度、当前 Thread 官方估算、账户 ID、普通用量权限、
  Luna Reserve 后端授权摘要、第三方余额、Credits/配额窗口和未支持状态的可辨识结果，
  以及 Provider 账户适配器与查询窄端口；不同来源不得共用含义不一致的字段。
- `account-snapshot.ts`：校验并生成跨展示端复用的官方账户快照读模型，不携带凭据或原始响应。
- `conversation-reset-credit-service.ts`：`/limits reset` 的分页查询、预览和确认归属，绑定 Actor、Conversation、Workspace 与当前 Thread；查询、预览和消费的实时授权贯穿 Provider 等待及最终 RPC，已发送消费按真实结果结算。
- `openai-reset-credit-service.ts`：OpenAI 重置券查询、短期选券确认与单次消费；复核账户/券修订、过期及并发，预览与券期限贯穿最终消费提交守卫；本地明确拒绝保留 stale/授权分类，消费结果与额度刷新分离，不保存凭据或自动重试写操作。
- `provider-account-service.ts`：维护编译期显式 Provider 账户适配器注册表；OpenAI 适配器复用
  App Server 账户查询，未注册的聚合或自定义 Provider 返回不支持，不创建占位账户快照，不回退到 OpenAI。
  OpenAI 额度可在快照保存后附加由组合根提供的凭证刷新时间，仅供展示，不写入官方账户快照。
  手动额度查询与启动预热直接读取官方额度，不主动刷新登录凭据；凭证刷新时间只读取已有值，不由查询时间生成。
  账户用量、额度、单账户刷新和启动预热可携带取消信号，取消后的结果不写入快照。启动预热按
  Provider 与查询类型回报失败，主动取消不回报为查询失败。第三方同账户查询共享正在进行的
  上游请求，等待方独立取消，最后一个等待方取消才中止上游；失效请求不能清理替代请求。
  快照写入成功后才更新已发布的额度缓存；OpenAI 冷启动仅取得用量时暂存用量供后续额度查询合并，不覆盖已有持久快照。
  OpenAI 普通用量查询沿用额度观测时间，只有额度成功查询才推进时间；较早额度请求的迟到结果不覆盖较新的成功观测。
  查询结果可通过快照写入端口落入统一读模型；按需刷新只接受已注册 Provider，查询失败保留最后
  一次确认快照，不以 `unsupported` 覆盖有效余额或额度。官方明确的无有效订阅是结构化查询结果，
  同样写入快照；普通查询失败不覆盖该状态，后续成功获取额度才恢复正常额度展示。
- `request-metrics-port.ts`：定义 `/metrics` 使用的当前 Thread 最近 Turn 运行聚合、整个 Thread
  指标累计，以及自然日/周/月、24 小时至 365 天滚动窗口或全部保留历史的全局/提供商/模型聚合和异常请求
  只读摘要；错误组保留来源、HTTP 状态、错误类型与错误码；聚合中的上下文压缩摘要单列实际请求模型、请求数与 Token；
  历史无 Turn 指标只参与通用明细和时间范围聚合；不向 Application 暴露 SQLite 或请求正文。
- `skill-port.ts`：定义已直接安装 Skill 的稳定名称与说明查询，以及只供 Application 启动
  Turn 使用的精确 Skill 路径解析；路径不向 Surface 暴露，也不传播 Scope、依赖或上游扫描错误。
- `mcp-port.ts`：定义 MCP Server 概览、当前 Thread 的未启动/连接中/已连接/需认证/失败/取消/禁用或未知运行状态、可空 Plugin 来源、只表示工具发现是否失败的布尔状态、带只读/可能写入/未知属性的工具摘要、资源/模板详情、共享 OAuth
  能力判断、登录结果和有界只读资源内容；Plugin 来源只供 `/mcp` 详情展示，不用于授权或 OAuth；不向 Surface 暴露工具 Schema、二进制正文或完整官方响应。
- `plugin-port.ts`：定义 Plugin 的已安装摘要、版本、来源、安装时间、开发者、分类、能力、
  认证时机、可用原因、适用套餐标识、Marketplace 加载失败计数与只供 Turn 调用的官方 mention 引用；
  查询显式携带目标 Provider，不提供市场搜索、安装、卸载或分享能力；已安装目录的本地搜索由命令层处理。
- `permission-port.ts`：定义 Permission Profile 的稳定 ID、说明和策略可选状态查询；只表示
  当前 Workspace 可见目录，不授予权限，也不承载审批决定。
- `thread-occupancy-port.ts`：定义渠道 `/release` 使用的 Thread 占用查询与释放窄端口；只返回
  稳定占用状态、持锁进程摘要和释放结果，不暴露进程级实现。
- `thread-queue-port.ts`：定义原生 Thread Queue 的六个稳定用例及已知拒绝分类；Application 按分类映射反馈与释放策略，不识别官方英文异常。Application 只接收纯文本写入，
  通过 Client 返回条目种类、可编辑标记和有界安全预览，不传播官方 `UserInput` 或本地路径。
  切换到已有 Queue 的 Thread 时沿用该 Thread 自身设置并清除当前会话待生效偏好；后台完成释放前
  重新查询 Queue、按 Thread 活动 Turn 和待结算子代理运行，避免自动派发或子代理仍在运行时解除绑定。
- `thread-history-port.ts`：定义分页 Turn 摘要、历史模式和 Revert 的稳定端口；只为当前会话提供
  有界列表、预览和一次性确认结果，不保存完整历史或工作区文件状态。
- `turn-port.ts`：定义项目拥有的 Turn 输入、设置覆盖、Review 目标与执行窄端口，并复用 Core
  统一的 Goal 稳定状态类型；
  Turn 启动可携带仅限本地的 `beforeSubmit` 守卫，由 Client 在异步准备之后、RPC 写入之前调用，不改变官方参数或已提交写入的响应等待；
  `ThreadApprovalsReviewerPort` 单独定义已加载 Thread 审批方式更新，只有 `user` / `auto_review` 可写；组合根注入的端口在官方确认与共享入站归约完成后返回，Application 再复核绑定与最新实际值。
  输入只允许文本、PNG/JPEG/WebP/非动画 GIF Base64 Data URL 图片、绝对本地音频路径、已由 Client 从当前 Workspace
  `skills/list` 解析的 Skill 引用，以及经当前 Workspace 解析的 Plugin mention；Data URL 仅允许内联
  受支持的 `data:image/*;base64,...`，音频路径不代表当前模型可用，必须先通过模型目录能力检查。
  显式 Skill 调用同时发送 `$<skill-name>` 文本标记和内部 Skill 引用。Application 不构造官方 `UserInput`，
  也不接收完整官方 Turn 响应。

Surface 只依赖直接输入、状态或菜单所需的能力切片，并使用 Bootstrap 注入的
`ConversationCommandExecutor` 执行共享命令；不依赖完整 `ConversationUseCases`、具体服务类或底层 JSON-RPC。
Thread 的权威状态仍来自 App Server，本模块只编排请求和必要的本地选择。
Queue 由 App Server 持久化并按 Thread 限制为 100 条；Application 默认以 25 条一页维护五分钟、
不含正文的 Conversation 选择快照，数字选择器只使用该快照，完整 ID 则重新复核权威列表。
`thread/queue/changed` 只使快照失效，不触发网络读取；Queue 非空时转移、接管或转后台失败关闭。
新建 Thread 使用分页历史模式；`/revert list`、预览和确认只使用最近一次有效页面快照，执行前重新读取
历史、活动 Turn 和完整 Queue，并在并发变化时失败关闭；Queue 按锁定版本的真实合同保留原顺序且不会因 Revert 自动启动。成功的
`thread.reverted` 会清除 Core 的产物、计划、目标、上下文压缩、用量与计时等派生展示缓存；不持久化
Turn/Item 历史，也不承诺恢复工作区文件。
后台 Thread 正常或失败完成释放前通过一次原生 `thread/queue/start` 协调自动派发竞态，再读取权威状态；中断完成只查询并保留 Queue，延后释放的重试继续沿用该限制；Gateway 不保存或重放下一 Turn 正文；仍有待结算子代理时保留订阅，
最后一个子代理终态完成后重试此前挂起的释放。
Gateway 计划任务通过 `ScheduledTaskApplicationService` 暴露创建预览、一次性确认、列表、运行记录、
重命名、暂停、恢复、立即运行、uncertain 重试和删除预览；每次操作精确绑定 Surface Actor 与
Conversation，数字选择器只使用最近五分钟的内存快照，完整 ID 仍重新复核 Store 归属。
`ScheduledTaskToolService` 把前台 Agent 的 `schedule_task` 参数解码为上述同一批用例，并返回稳定的
确认、列表或生命周期结果；模型不接触 Store 和权限选择，创建和删除仍必须由用户确认一次性令牌。
固定句式仍由 `parseNaturalScheduledTaskDraft` 直接解析，不再创建后台临时 Thread。
重命名、暂停和恢复不会改变列表序号，成功后保留当前快照供连续管理；创建和删除会使快照失效。
每个 Surface Actor 在同一 Conversation 最多保留 100 个未删除任务；创建预览和确认都会复核该固定上限。
扩展查询也保持平台无关：Skill 只向 Surface 返回当前用户或 Workspace 直接安装且已启用项的
名称与说明；显式调用时由 Client 再按精确名称解析绝对路径，排除系统和插件缓存内容。MCP 按当前
Thread 返回稳定概览与详情；命令结果携带工具、资源或模板的有界分页搜索视图，OAuth 登录不自动
重试、要求当前会话已经绑定 Thread，且只对共享能力判断允许的认证状态开放；详情结果保留用户本次使用的原始选择器，供 Surface
生成可继续执行的登录、浏览和资源读取命令；Bearer Token 返回结构化认证结果并明确提示无需 OAuth，
资源读取只展示已经隐藏常见凭据的有界文本或二进制元数据；请求/内容/目录/模板 URI 也在 Client 输出投影脱敏，
实际读取仍使用用户提交的原 URI，展示值不能用作新的读取身份。
Plugin 列表与详情只查询当前 Provider 实例在当前 Workspace 的已安装项，
会话尚未解析出 Provider 时要求先通过 `/model` 选择，不回退到官方实例；
详情只使用同一次 `plugin/installed` 返回的安全摘要，能力与适用套餐有界展示，不读取本机路径或远端 URL；
Application 对同一已安装目录提供每页 8 项的本地分页过滤和只含需处理项的健康归约，保留原目录全局
数字选择器，不调用 `plugin/search`；同时保留 Marketplace 加载失败计数，在互斥区内解析并发送官方 mention，
支持官方与第三方；自动恢复确定实际 Thread 后与最终 start/steer 提交前再次复核 Provider 与解析时一致，
变化时拒绝并要求重发，不借用主实例的账户可用状态放行其他 Provider；
三个 Surface 共用同一 Application 边界。
成功启动 Turn 后，模型、思考等级、服务层级和协作模式以 App Server 的 Thread 设置为准；
Gateway 重启时通过恢复 Thread 和设置通知重新取得这些设置。`/plan` 无参数切换
Default/Plan，带参数时在空闲边界内直接启动 Plan Turn；活动 Turn 不允许中途切换。
Turn、steer、停止、重命名、固定、压缩、Review 和 Goal 只依赖 `TurnExecutionPort`；当前版本官方字段由
`codex-client` 负责映射。停止直接读取 Core 中精确的活动 Thread/Turn 并发送中断，不进入同一
Conversation 的普通操作互斥区，因此不会被尚未返回的 steer 阻塞。Goal set/clear 请求成功后，Application 使用已确认结果立即更新 Core；
App Server 通知继续处理其他客户端修改与恢复后的状态校正。
自定义 Thread 分区的 Application 命令和管理员权限已移除。内置 Pinned 仍由 `/pin` 与 `/unpin`
提供会话级快捷入口。
模型选择和 Fast 只依赖 `ModelSelectionPort`；不可见模型过滤、官方模型字段裁剪，以及目标
Provider App Server 的有效思考等级与服务层级读取均由 `codex-client` 统一处理。CLI Setup 直接依赖
具体 Client 的全局默认值读写，不扩大 Surface 可用的会话端口。
OpenAI 原生账户查询只依赖 `AccountQueryPort`；当前 Thread 的 `/usage` 与 `/limits` 通过
`ProviderAccountQueryPort` 按 `modelProvider` 选择显式注册的适配器。OpenAI `/usage` 在有当前绑定
Thread 时并行读取账户摘要和精确 Thread 官方估算，估算失败隔离为可辨识状态；待生效 Provider
选择仍决定账户来源，只有账户选择和实际绑定都属于 OpenAI 时才附加 Thread 估算；无 Thread 只读取摘要。
新增第三方时实现 `ProviderAccountAdapter` 并在 Bootstrap 登记，不能伪造 OpenAI Thread 估算；未提供的账户能力保持不支持。
Application 和 Surface 不解析 `account/usage/read`、`account/rateLimits/read` 或第三方完整响应。
`/metrics` 只依赖 `RequestMetricsQueryPort`；无参数或 `session` 查询当前 Thread，`global`、
`providers`、`models` 和 `errors` 统一使用 `24h`、`7d`、`30d`、`90d` 或全部保留历史；`errors` 只展示
脱敏后的状态、HTTP 状态、错误类型、次数和最近发生时间。Bootstrap 把独立指标库映射为稳定摘要，
Application 不读取数据库。OpenAI `/limits` 还通过该端口按周窗口查询统计代理已经按相邻额度
快照归约的增量样本，估算每 1% 的 Token；没有完整周窗口、有效重置时间或正向
额度变化区间时不产生估算。该请求流水
不能替代 App Server 提供的 Thread 上下文、账户额度或累计 Token 状态。
Skill 查询与显式调用只依赖 `SkillQueryPort`；用户和项目直接安装项的筛选、调用名称与绝对路径
校验由 Client 适配器在协议边界完成。
MCP 查询与配置刷新只依赖 `McpQueryPort`；Application 从官方详情归约只含需处理项与提示的健康
摘要，连接失败、取消或工具发现失败只建议显式刷新，并把刷新交给 Client，不把运行状态读取冒充远端网络探测，也不接收工具发现错误正文。官方状态分页、Thread 配置上下文、OAuth
URL 校验、资源限长与响应裁剪由 Client 适配器处理，渠道查询分页与搜索由共享命令结果表达。Plugin 查询与调用只依赖
`PluginQueryPort`，Workspace、可用性与调用时的 Provider 一致性由 Application 执行。
Permission Profile 查询只依赖 `PermissionQueryPort`；CWD、分页和官方响应裁剪由 Client 处理。
命令成功文案、命令菜单说明和平台交互形式由各 Surface 维护，并通过类型穷尽检查保持完整。
`/whoami`、交互取消、图片下载等平台能力不属于通用会话命令，继续由具体 Surface 实现。
