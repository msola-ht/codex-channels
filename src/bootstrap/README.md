# Bootstrap

实时快照先执行状态观察和取代，再按 Surface 的可选 `acceptsSnapshot` 判定是否捕获 owner 并入队。此入口只用于新快照，隐藏完成的独立收尾和已有 Journal 重放不经过它；显示隐藏不伪装成授权失败或平台确认。

持久输出将原 owner 中已校验的 Surface 来源经 `PersistentSurfaceOutput → SurfaceManager` 传入发送端，跨过反序列化与富化仍保留原任务关联；不修改 Journal/owner 格式，不凭索引建立新授权。QQ 据此从有效连接代次取原生引用索引，其他渠道仍使用原投递合同。

子代理开始通知使用 0.162.0 官方活动中的启动模型与思考等级；元数据补充只读取并核验 Provider 归属，不用稍后 Thread 设置覆盖启动快照。继续通知仍展示读取时的 Thread 设置。

本目录是模块化单体的组合根，负责创建具体依赖并管理 Gateway 进程生命周期。

`surface-composition.ts` 将固定启动配置的显示解析器注入渠道。QQ 经渠道公开的地址解码器把成员会话映射到物理群或原始单聊接收者，仅用于展示继承，业务会话、Actor、Thread、审批及来源仍使用原身份。飞书使用已校验私聊的物理 Chat ID；Telegram 仅对当前进程已确认 `chat.type=private` 的地址应用覆盖，未知旧目标保守隐藏可选实时过程并记录原因，已保留终态仍独立履行投递，不猜测 ID 或删除绑定。显示覆盖修改需重启 Gateway 激活。

成功完成通知的实时模式在 observer 准入时固定：可见模式随进程内到达序号传入可靠消费者，恢复或重试时没有该上下文则使用稳定详细呈现；不增加 Journal 字段。隐藏模式复用有界快照的独立 `turn-settlement` 用途，不写 Journal、不参与普通状态合并，按精确目标和 Turn 收尾。它等待前序持久排序屏障，或在后继持久发送前按到达顺序先入同一 critical 队列；不占队列等待自身，不阻塞后继可靠记录落盘。固定 60 秒后仅做本地清理，撤权、停止、容量不足也不发送；这不改变旧 pending/uncertain 记录或声称正文送达。微信按现有私聊目标消费完成设置；TG 类型证明缺失时成功完成可选通知同样隐藏，错误与明确缺正文仍受保护。
`gateway-component-graph.ts` 在有损展示队列之前接入第三方重复思考保护，仅为已绑定、当前活动且 Provider 已知并非 OpenAI 官方的 Thread 提供中断端口。原始思考与摘要增量由 Client 适配后交给 Application 的有界异步检测，不等待 RPC；中断任务纳入既有生命周期任务集合，对应 Provider 断线或绑定失效清空检测窗口，关闭先停检测再等待已发出的中断。提示走现有 warning 投递链，不传出思考内容。
当前页 Thread 状态由组件图以最多 4 个并发只读查询已连接 Provider；配置生命周期在应用启动成功后发布独立私有 IPC，
停止先撤销入口和查询再停止应用，不接管共享 App Server 的进程生命周期。
最终显式退出前统一关闭并等待 Delivery、Metrics、Scheduled Tasks、材料 Reader 和主线程 Windows ACL bridge 的真实退出；有界关闭失败仍保留归属并报告故障。初始配置或构造失败也清理已创建的材料 Reader／ACL 资源。
启动期间提前停止同样传播资源清理失败的非零退出状态，不能在等待资源最终退出后将曾超时的关闭改报成功。

渠道组合统一将数据库旁的 `uploads/video` 作为视频附件根传给三个 Surface，各渠道拥有独立暂存器生命周期。该目录不作为普通本地视频目录开放；MCP 通过显式 `STRATA_VIDEO_CHANNEL_ROOT` 和当前会话的随机附件引用读取单个文件，不由 Gateway 自动改写 Codex 配置。

## 文件

- `qq-network.ts`：QQ 每代次独立的代理、HTTP 池与关闭资源管理，由渠道组合注入。QQ 普通文字复用共享 Application 和持久投递；绑定和订阅沿共享恢复，审批与问答进入共享交互路由。计划任务接入共享执行器及精确 Turn 来源；当次配置通知使用受控单聊名单，不订阅持久 Workspace 配置事件。
  独立的 QQ 菜单 Setup 通过精确文件级边界许可复用此网络所有者，操作结束关闭自有资源，不启动组合根或 WebSocket。
  Markdown 图片素材的 uploadImageMaterial 复用下面的无凭据公网固定 IP 传输，与分片 PUT 分开声明 MIME/ETag 合同，不复用 QQ API 的鉴权头。
- `qq-attachment-download.ts`：QQ 附件无凭据 HTTPS 下载与富媒体预签名分片 PUT。DNS 全部结果经保守公网策略校验后固定一个 IP，直连与代理 CONNECT 均使用该地址，HTTP Host、SNI 和证书验证保留原域名；不自动重定向，代理选择仍按原 URL。私网、特殊 IPv4 和 IPv6 映射/转译范围拒绝，此安全策略不是完整可达性分类，可能保守拒绝特殊公网地址。取消覆盖 DNS 等待及实际请求，PUT 仅在有界成功响应完整结束后确认，响应结束释放专用代理资源，网络关闭汇总关闭结果。
  `surface-composition.ts` 为 QQ 上线通知注入启动允许名单、共享只读状态和运行环境；渠道在发送前复核授权，通知不恢复 Thread 或旧投递来源。完成通知复用现有精确 Turn 统计补全。

- `index.ts`：向进程入口公开 `GatewayApplication`、计划任务执行/恢复端口、进程生命周期入口和安全的 Gateway 所有权错误。
- `persistent-surface-output.ts`：在总线发布时取得原目标归属，按有界窗口异步生成快照并提交独立 Delivery；恢复时复核当前授权，通过 Surface 可等待端口记录实际平台确认；对未知或授权失效的持久结果注入仅解除顺序屏障的策略，保留记录和额度；同时拥有投递管理私有 IPC 的启动与关闭，将在线修订操作交给 Coordinator；进程内登记实时到达序号供输入镜像排序，序号不进入持久载荷，提交拒绝或开始投递时释放对应登记。
  可选 authorizeAtDispatch 接收 Coordinator 的取消信号，允许来源结算等待；通过后仍用同步 authorized 在富化、排队、started 检查点及最终发送前复核。载荷解码失败仍按存储故障处理，来源拒绝或超时不冒充存储故障。
  组件图为 QQ 捕获 owner v3（共享身份字符串与一次来源引用），非 QQ 保持 v2；任务来源核对 Thread/Turn，MCP OAuth 完成通知的显式 notification 来源核对 Thread/Server，不伪造 Turn。QQ 旧 owner、无来源、跨代次或身份不匹配均禁发，发送前同步复核精确来源。通知来源仅驻当前代次内存，不从 Journal 恢复授权。
- `persistent-interaction-port.ts`：审批和问题先等待同 Conversation 的前序持久结果；等待纳入原交互期限，等待前后及接受答复前复核交互归属，取消立即释放所有权并拒绝迟到结果，不保存交互正文。
- `output-execution-admission.ts`：在既有 Turn/Queue 执行端口前检查组合根的投递容量，统一覆盖普通输入、扩展调用、Review 和计划任务；保留停止、查询与 Queue 删除能力，不修改协议字段。所有端口参数包含本地提交守卫原样转发，使准入等待后仍能拒绝过期命令。
- `async-question-coordinator.ts`：在同一入站通知链路登记实时异步问题并处理生命周期取消，拒绝断线前连接代次迟到的问题通知，仍消费取消事件，避免入站或输出积压导致旧问题重新登记；等待前捕获唯一授权 Actor 与工作区 ID/目录，交互限定原用户，分批回答及最终 Turn 发送均复核原授权和 Thread。拥有有界去重、交互分批和超时，复用 Surface 输入组件，将完整回答经 Application 作为原 Thread 的普通输入提交。已进入提交的回答失败时仍提示未确认送达，不被后续取消吞掉；不处理审批响应，不保存历史。
  回答提交结束前持续保护原 Thread，整个问题流程结束后触发后台空闲复核；审批类交互则在官方 `serverRequest/resolved` 后解析绑定祖先并复核，避免只清理交互状态而遗留后台订阅。
  QQ 回答按原交互 requestId 单次领取最终回应来信的提交票据，将原问题守卫与票据守卫合并，并透传既有 SubmissionObserver；新 Turn 结果由本次参与建立来源。失败取消票据，原授权仍有效时由 QQ 窄回调提示未确认，不借无 Turn 的 warning 扩大发送范围。
- `scheduled-task-executor.ts`：在每次计划任务运行前重新校验 Actor、Conversation、Workspace、Provider、模型和无人值守权限；异步预检返回后及 Thread 创建后再次复核当前授权、取消、Workspace 与投递准入，撤权时释放新建后台绑定而不启动 Turn。临时容量拒绝及创建提交绑定前的订阅失效不撤销周期任务；强制创建 `automation` 后台 Thread 并启动单个 Turn，写请求结果未知时失败关闭。
  启动请求期间使用 Core 临时活动观察合并响应，迟到响应不覆盖期间归约的终态或更新轮次；无论 Core 当前是否仍活动，成功响应中的准确 Turn ID 都继续交给 Run 协调器关联，观察器在请求结束时释放。
  同一提交守卫穿过后台排队、投递准入和 Provider 准备到 Client 最终写入前；提交前取消或授权失效明确收敛，已发写入仍按真实响应处理，已知新 Thread 的取消保留身份并释放绑定。
  可选 Surface 提交票据在最终 Turn 请求前准备，并由同一 SubmissionObserver 确认响应的精确 Thread/Turn；QQ 缺少票据时拒绝启动。组件图贯穿任务原 Actor、Workspace 和后台绑定授权，切换前台不改投结果，重启恢复 Run 不恢复旧 QQ 结果来源。
  权限预检按实际 Provider 与授权 cwd 查询原生明确受限沙箱，未知缺省或命名 Profile 拒绝。
  创建不覆盖沙箱，仅设置无人值守 `never`；实际响应符合目录、审批策略和预检沙箱后才启动 Turn。
- `scheduled-task-run-coordinator.ts`：按持久化 Thread/Turn ID 关联 Run，接收既有 Core 输出完成事件，并在重启后读取权威分页 Turn 历史恢复或收敛运行状态；确认离线终态后通过组合层向原 Conversation 发布恢复通知，再释放后台绑定。恢复包含已知 Thread 的 `uncertain` Run，结果未知不清除无人值守拒绝归属；精确 Turn 的终态只释放该未知 Run 的运行期归属，不改写历史结果。启动响应前每 Run 只保留一个带 Turn ID 的完成候选，其他轮次不覆盖它；启动响应不匹配时在五秒和分页上限内读取权威历史的精确 Turn，缺失或读取失败保留为 `uncertain`，不能将同 Thread 的其他轮次用于结算。启动前置校验与绑定恢复均传递所属生命周期的取消信号，停止后的校验与历史读取结果不改写 Run 状态或继续翻页，保留运行记录供下次启动恢复。
  恢复终态写入后复核同一后台绑定对象；通过组合根注入 Application 的完成释放能力，保留当前 Turn、子代理与 Queue 保护，恢复本身不派发 Queue。
  QQ 自动释放后台绑定前，还会有界等待该 Conversation 已接收的持久投递结算，再复核归属和任务状态；失败记录仍保留在投递箱，等待超时保留绑定交恢复流程处理，不把顺序屏障结束称为全部送达。
- `scheduled-task-server-request.ts`：按启动恢复及实时登记的 Thread/Run 归属，在首次异步操作前记录无人值守拒绝，避免并发 Turn 完成误报成功；持久化失败保留进程内拒绝事实并记录告警。为已关联的计划任务 Thread 返回五类 Server Request 的官方安全拒绝形状；普通命令和文件审批返回 `decline`，已有终端输入 `writeStdin` 返回 `cancel` 中止本轮，其他方法明确失败；非计划任务请求交给既有审批处理器。只在 `scheduled_tasks.enabled=true` 时由组合根安装。
- `scheduled-task-tool-request.ts`：校验前台 `item/tool/call` 的 Thread 绑定、唯一授权 Actor 和
  `schedule_task` 工具名，把结果复用现有计划任务渲染格式返回给 Agent，并把确认预览交给当前
  `surface + accountId` 的原生交互入口；先拒绝后台绑定，再在 5 秒预算内查询官方 Thread 来源并复核同一前台归属，拒绝 `automation` 来源或无法确认的结果。
  请求在首次异步无人值守归属检查前登记官方 Thread、Turn、call 和请求 ID；原始通知入队前按精确身份处理动态 Item 结束、Turn 终态、请求已解决与 Thread 失效，Provider 断线和关闭也撤销未提交工作。等待后和写入、领取、派发前复核原绑定与 Actor，取消后的预览不展示并移除未交付令牌；已提交写入不回滚。
  已登记计划任务的同类工具请求在本入口先由恢复协调器记录拒绝，其余请求仍由 `scheduled-task-server-request.ts` 拒绝；工具入口的独立检查仍覆盖未知 Run、显式重试和重启后的旧 Thread。
- `app.ts`：通过异步 `GatewayApplication.create` 提供唯一构造入口，接收已加载的内置渠道插件；构造失败时逆序清理组合根登记的已取得资源，继续清理其余组件并保留原始错误及清理错误。提供启动、停止和配置重载入口，编排顶层生命周期，
  把具体组件所有权交给组件图；持有启动/停止幂等任务，内部致命故障同时通知进程生命周期退出，配置重载继承组件图实现，启动中取消、订阅移除和资源关闭由组件图统一处理。
- `gateway-component-graph.ts`：为 OpenAI 与受管 DS 主／隔离 Client 注入图片引用能力；OpenAI 上传遵循共享代理配置，本地模型路由核验直连回环地址；DS 只经受保护 Supervisor IPC 取得运行实例能力，并将私有路由读取失败映射为固定安全分类及设置应用／重启提示，不透传未知异常正文；
  为渠道 Hook 管理注入实时授权守卫及 Surface 无损审查策略，在会话锁内和写入前复核运行状态、渠道允许名单及 Actor 归属；
  Provider 断线时清理其已绑定 Thread 的 MCP 登录关联，防止跨连接迟到完成重新投递；
  普通断线与主动 Provider 设置重连均标记绑定订阅失效，隐藏旧指令来源和执行上下文；
  关闭事实同步失效已开始的 Core 恢复观察，异步归约保留事件顺序但不再次失效后来的观察；
  成功生命周期替换诊断后，旧关闭按快照身份守卫丢弃。旧连接关闭与设置通知在消费前丢弃，主动关闭也推进通知代次。
  集中装配 Transport、Client、Core、Router、Storage、Surface、指标与计划任务；Codex 版本校验在可取消的启动阶段先异步执行，成功后才继续连接及启动，不在构造中同步等待外部进程；
  构造期间即时登记数据库、指标写入方、通知端点与已创建的渠道实例；指标数据库由单 Worker 拥有，启动先等待独立初始化及订阅限制投影读取完成，再开放指标 Socket 与渠道；订阅限制只在已确认账户快照提交后更新内存投影。计划任务 Store 和插件实例创建边界也登记部分取得的资源，不依赖尚未返回的完整应用实例回滚；
  私有持有当前配置、Workspace Registry、Surface 集合与管理器，统一协调配置重载和重启通知接收方的临时切换与恢复；
  启动账户预热绑定应用关闭信号，按账户记录安全失败分类，在指标存储关闭前最多等待 5 秒；
  迟到的用量与额度结果均禁止写入。把同一 Client 的
  原生 Thread Queue 与分页历史/Revert 端口注入 Application，并把 Queue changed、Thread reverted 通知
  仅用于失效短期选择快照和校正 Core 派生状态；当前 Thread 审批设置窄端口先等待 Client 的 RPC 与合法通知确认，
  再以现有入站总线的有界排空等待共享归约完成，供 Application 复核绑定和最新实际审批方式；
  排空失败单独回报结果尚未确认，不乐观修改 Router 缓存。
  提供连接启动、订阅恢复与组件关闭原语，重连委托给 `gateway-reconnect-coordinator.ts`，
  并通过 Client 适配器把稳定事件交给 Application 的 `ConversationEventCoordinator` 按序协调 Core，Thread 状态交给 `session-routing`，把
  Server Request 转交 Approval；未知或畸形 Notification 只记录 method 后忽略，未知或畸形
  高权限请求明确拒绝；受支持版本通过 Client 运行时信息读取，并把显示版本注入 Surface；
  对当前授权 Workspace 执行有时限的只读 Git 分支查询并注入 Application 状态；按 Setup 管理
  标记装配主 Client 与可选 Provider Client，并通过 Provider 路由复用其余业务模块；
  聚合可用性由 Runtime 的共享门禁决定；当前聚合暂时关闭，不装配 `codexc-aggregate` Client、模型目录或设置监听，旧聚合绑定因 Provider 不可用而拒绝执行，保留会话与数据；
  请求指标仍只接收真实成员账户的样本，聚合不增加指标 Socket 或账户适配器。
  按已启用 Provider 装配模型指标组件，不持有模型转发数据通路；通过 `request-metrics-query-adapter.ts`
  把同一指标库的精确 Thread 查询映射为 Application `/metrics` 窄端口，并为 OpenAI `/limits`
  提供当前周窗口的精确 Provider 聚合；
  同时拥有请求指标与账户快照的独立私有通知端点，指标批次或账户快照成功保存后发送对应失效通知，关闭时先停止指标写入再释放订阅端点；通知不调用 App Server。
  计划任务的内部组件、恢复顺序和
  Store 生命周期委托给 `scheduled-task-composition.ts`。
  同一组合根还把 Luna Reserve 状态机接到最终 `usageLimitExceeded`、Thread/账户生命周期和关闭顺序；
  切换通知复用平台无关输出事件，不让 App Server Reader 等待额度 RPC 或渠道网络。
- `gateway-reconnect-coordinator.ts`：拥有断线检查去重、串行 Provider 重连、12 次有界退避和关闭取消；通过断线代次拒绝过期恢复确认，重复断线不会重置未完成恢复的重试预算。连接成功后的绑定恢复失败只重试恢复阶段，不重复握手。主动停止的 Provider 不自动重启。关闭时等待断线检查与重连任务，等待时限仍由顶层生命周期控制；绑定状态由 Binding Restore Coordinator 管理。
- `binding-restore-coordinator.ts`：单独拥有待恢复 Thread、Provider 断线绑定、恢复中集合、写锁占用通知和有界退避任务；Provider 重连与 Gateway 停止通过显式方法恢复、取消并等待，不保存第二套绑定。把 Core 临时活动观察工厂交给 Router，在每次实际恢复请求前建立窗口，合并实时 Turn 开始与完成，旧快照不重新激活已结束 Turn；观察器在成功、失败或取消后释放，不跨生命周期锁等待复用。成功恢复后通过回调触发耗时补齐，停止后的迟到恢复不触发回调。
  普通后台绑定在 Router 恢复锁释放后交给 Application 的统一释放入口，核对父 Turn、权威后代、Queue 与交互保护；仅确认释放后提示离线结束，暂时失败保留绑定并进入原恢复重试。正常后台清理的补偿失败也交回绑定恢复，避免失去订阅后依赖后续通知才能重试。恢复与清理复核原绑定、Provider 断线代次及停止状态，失效恢复不继续释放。
  `history-unavailable` 保留原 Thread 和绑定；普通前台绑定暂停定时自动重试，并提示新建会话或在历史可用后显式恢复，新建前档位选择未知时需明确选择。后台绑定与运行中的计划任务继续由既有恢复调度重试，只恢复订阅，不重跑已提交任务。暂停的前台转为后台时，组合根重新调度恢复；成功显式恢复或解绑后清理旧暂停记录，不让其继续阻挡输入。
  恢复容器及退避计数只在协调器内部创建，组合根不持有或注入其可变状态。
- `scheduled-task-composition.ts`：在功能启用时集中创建计划任务 Store、Executor、Run Coordinator、Scheduler、
  Application Service 与动态工具 Handler，并拥有恢复、启动、停止和关闭顺序；Gateway 组合根只保留
  Surface 创建上下文、无人值守权限边界和 App Server 请求接线。Store Worker 就绪后才恢复与启动调度；
  审批查询、拒绝标记和完成持久化经异步端口执行，同步输出观察仅登记内存终态。
- `git-workspace-status.ts`：通过异步子进程读取当前授权 Workspace 的 Git 分支，限制执行时间与输出大小，接收调用方取消；状态命令、上线通知与完成卡共用该读取器，不阻塞 Gateway 事件循环。
- `request-metrics-query-adapter.ts`：通过 Observability Worker 的异步窄端口读取相同范围和聚合语义，把查询结果和 Provider
  显示名映射为 Application 的 `/metrics` 窄端口，保留错误组的来源和错误码；不让 Application 依赖 SQLite 实现。
- `managed-provider-capabilities.ts`：按 `runtime/model-provider-definitions.mjs` 的编译期能力元数据
  有界装配 DeepSeek、OpenCode Go、CCG、CLP 的账户适配器；适配器以精确 Provider ID 登记，`none` 明确不提供
  账户能力；未知能力或适配器冲突启动时失败关闭，不回退到 OpenAI 账户查询。
- `provider-metrics-composition.ts`：组合 Provider 私有指标 Socket、Observability 独立存储和 Core
  模型请求入口；IPC 只投影约定字段，Provider 归属由组合层确定，不接受入站扩展字段覆盖。
  模型请求统计端口。合法脱敏样本尝试入队；生图请求只保存请求指标，不回填文本模型思考等级，
  不更新 Core 的模型重试或完成卡实时请求状态。具备 Thread 与 Turn 关联的非审查文本样本按 Turn 聚合
  到完成卡片。持久化通过 Observability 有界 Writer 延迟分片执行，入队失败明确拒绝 IPC 确认，
  但仍保留普通请求的 Core 实时统计；已受理不等于落库成功，延迟写入失败独立上报。
  优先使用代理指标携带的 HTTP/WS 请求中明确提供的 `reasoning.effort`，
  普通 Thread 仅在缺失时
  由可选 `resolveModelSettings` 按 Thread 关联回填路由层维护的思考等级；该组合层、Core 和数据库
  View 不解析请求正文、设置文件或价格目录。
- `account-query.ts`：四类第三方账户查询共用总预算、受控 HTTP/网络/解析失败分类和安全诊断；显式渠道查询在凭据读取、每次 HTTP 及后续本地查询前复核实时授权，守卫拒绝保留原异常。调用方取消保持取消语义，业务响应解析仍归各适配器；预热和手动刷新复用同一安全诊断投影。
- `bounded-fetch-body.ts`：统一组合根远端适配器的 Content-Length 校验、流式累计、超限取消与
  Reader 清理；调用方注入领域错误，并决定是否允许缺少正文，不向 Surface 暴露该基础设施。
- `completion-account-status.ts`：将本次具体 Provider 的官方余额、Credits 与配额窗口投影为完成卡摘要，不携带凭据或完整账户响应。
- `completion-timing.ts`：在 Turn 完成时用同一指标库快照重建本轮请求数、含正数推理输出的请求数、Token、用量缺失计数、压缩统计与 OpenAI 单次响应用量汇总；同时传递精确本轮普通请求的出站档位及缺失、混合计数，不用当前 Thread 选择或响应档位替换本轮请求观测；推理用量全部缺失时删除旧实时计数，明确观测为零时保留零，避免迟到指标与实时计数混用；
  上游轮次首 Token 使用当前 Turn 首个有效 OpenAI 上游样本，覆盖重启后仅观测到后续请求的实时值；
  若当前 Turn 已部分延迟写入，按持久化汇总校正请求状态与
  可选用量字段。
- `auto-approval-review-tracker.ts`：在有界展示队列之前采集所有已归属 Provider 的官方审查与轮次通知，包括未绑定渠道的后代；Reader 只提交有界异步写入，不执行 SQL。断线使观测覆盖失效，写入失败或队列超限会合并一次独立的持久覆盖降级，无法落库则停止 Gateway；关闭限时等待已接收操作。完成卡通过异步窄端口获取当前轮递归任务快照和当前会话累计快照。
- `auto-approval-review-notifications.ts`：独立于指标写入，每次仅发布审查完成结果，不补发开始通知；仅 `turn.started` 可记录直接会话归属，审查开始、子代理活动与继续操作不能捕获当前绑定。按已记录的授权归属及既有精确父子 Turn 关系路由，完成时复核原会话与 Provider，保留来源身份、Client 校验的固定动作类别、文件数量、网络协议与端口，以及经凭据脱敏、控制字符清理并各按最多 320 字符截断的 operation、cwd、rationale，并投影 durationMs。Client 保留 ASCII 标点；execve program 与 argv 逐参数脱敏后再格式化。operation 摘要按 action 类别取 command、execve program 与 argv、文件列表、network host（不含完整 target URL）、MCP server/tool 或权限申请 reason；不展示 stdin 正文，不采集风险与用户授权字段。保持有界等待和去重，断线只清理对应 Provider 的归属及等待。无归属、淘汰与输出失败可观测；Core 与投递摘要保持有界纯文本，经现有加密投递箱暂存，平台富文本转义由 Surface 负责。指标采集仍消费开始和完成事件；StateStore 与指标库不增加审查正文、schema 或指标字段，持久投递沿用当前结构版本，历史事件可缺省 details。
- `turn-execution-tracker.ts`：将官方轮次耗时幂等写入指标库；单队列、有界分页补齐历史，
  绑定恢复与 Revert 后重新同步，丢弃与实时事件冲突的快照；实时观察在单 Worker 内按序完成，历史读取有取消及分页预算，只重试权威读取、不重试结果未知的写入。完整性以指标库为准，写入或排队失败会持久降级所有历史完整标记，无法落库则停止 Gateway；内存只记录当前连接的有界观测集合。
  清理后再次完成与写入失败触发补齐；同一五秒预算内最多三次尝试，失效与成功均通知读取方刷新。全局故障按代次确认完整性失效落库后恢复读取可信度，之后各 Thread 以自己的持久完整性为准；旧历史读取不能跨故障重新认证快照，Provider 断线重置后的旧任务也不能因故障恢复重新入队。
  停止时取消读取与重试并等待任务退出，禁止迟到写入，不阻塞 App Server Reader。
- `subagent-completion-tracker.ts`：登记 Core 发布的子代理线程，以 App Server 发给发起父 Turn 的
  `subAgentActivity.completed` 作为成功终态，并以父 Thread、父 Turn、子 Thread 和代理路径精确
  匹配；子线程 `turn/completed` 不再重复宣布成功，失败/中断仍接受子线程终态、官方中断活动与
  `collabAgentToolCall.agentsStates` 异常状态。极快子线程在登记前完成时只在有界短期缓存中保留
  带父运行归属的完成活动。Tracker 在 App Server 输入阶段同步记录未结算父运行，避免异步 Surface
  输出尚未登记时提前释放后台父 Thread；最后一个子代理终态后由组合根重试挂起的订阅清理。
  `interacted` 到达时若该子线程仍有活动轮次则不重复登记；上一轮已经终止时开启新一轮完成跟踪，
  上一轮仍在指标结算窗口内则分离结算；子线程 `turn/started` 会把本轮精确 Turn 与父 Turn 记入
  Observability，官方成功活动按同一子 Turn 读取本轮统计，避免通知乱序或快速继续时覆盖终态，
  也不会把多轮 Thread 累计误报为单轮用量。
  统计归属同样采集未绑定渠道的后代，兼容明确开始活动与子 Turn 通知的两种到达顺序；
  继续任务必须具备同一 `followup_task` 操作的开始和完成边界，并关联其后观察到的子 Turn 开始。
  普通 interacted/contacted 消息不建立统计父轮关系；缺失边界、归属缓存到期或淘汰使审查覆盖降级。
  输出活动同步登记，不等待指标库；父轮真实终态发布前按父 Thread/Turn 结算已确认结束但未发布的活动（含分离旧轮次），先将子代理终态交给持久投递，再接收父轮完成卡。此时尚未取得的统计明确不可用；旧计时器和异步结果失效，避免迟到重复。仍运行的任务不结算，父卡显示当前观测到的后台任务数量。
  已观察到模型指标且终态后出现父线程官方 `wait` Item 时，立即等待 Observability Writer 当前
  水位落库并发布，保持该等待操作先于完成卡片；终态到达时尚无指标或之后未出现父线程等待时
  保留有界收敛窗口，后续新指标使旧结算失效；指标到达或静默本身不推断子代理结束。无指标
  发布零统计终态，指标写入或读取失败发布“统计不可用”终态；完成事件复用汇总中的最后一次
  思考等级、请求结果和 Token，不在 Tracker 内重复计算。关闭时组合根先排空入站及输出登记队列，
  再调用 `drain`，以共享 5 秒期限结算已确认终态（含分离的旧轮次），指标超时按不可用输出；
  该期限同时取消汇总前的指标水位等待；排空结束后组合根取消被新结算替代的旧等待，不终止底层指标写入。迟到结算不重复发布，不为仍运行的子代理伪造终态，持久接收入口在结算后才关闭。
- `surface-plugin.ts`：定义编译期内置 Surface 插件、窄会话能力与共享命令执行器上下文及运行时模块契约，并校验插件 ID、
  实际 Surface ID 与账号实例唯一性。
- `surface-composition.ts`：在组件图构造前按已验证配置异步加载 Telegram、飞书和微信内置插件，再同步创建渠道；创建渠道前初始化共享 `uploads` 根并收紧私有权限，拒绝符号链接或非当前用户所有的根，无渠道插件时不创建目录。把组合根创建的共享命令执行器注入各端，并保留各平台访问策略、
  热加载钩子、故障上报装配和全局生命周期通知的安全收件人。三个插件都只在严格运行配置启用时创建实例；Telegram 由非空 Token
  决定是否启用，飞书和微信使用显式开关；飞书和微信启动通知从仍有授权 Actor 的已知 Conversation
  解析收件人，不要求当时已有 Thread 绑定。三个渠道按目标复用共享代理选择；微信协议 Client 在首次调用时从独立安全存储
  读取凭据，不把 Token 放入运行配置。
  QQ 在创建渠道、恢复订阅前按当前 App 的精确单聊及群/成员策略复核已知 Actor；撤权或无法确认 Actor 的
  Conversation 复用共享 `retainActors` 原子解除前台/后台绑定，保留 Workspace 选择及 App Server Thread。
  已授权单聊与群成员、其他 App 和其他渠道的绑定不受影响；重新授权后普通输入按既有强制新建标记处理。
  QQ 群配对服务使用配置目录与 App 隔离的私有 IPC，经窄端口注入 Surface；Surface 持有启停，Runtime 仅接收已解析的群身份与配对指令，不操作 Application 或保存配置。Setup 完整确认后复用原子配置写入，配对本身不授予任务权限。
  组合根同时向 Surface 上下文提供官方主路由的鉴权文件可用性，非官方主路由返回未知；该值只用于
  上线通知和失效降级提示，不替代 App Server 的认证判断，也不改变 Thread 的 Provider 绑定。
- `proxy-fetch.ts`：向 Bootstrap 组合代码转发 Runtime 共享的代理 Fetch 接口；代理选择与
  Dispatcher 复用由 `runtime/proxy-fetch.mjs` 实现。
- `openai-connectivity.ts`：在 OpenAI Provider 启动时复用同一代理做有界、无凭据的 HTTP
  连通探测；缺少当前 Codex Home 的 `auth.json` 时跳过。存在鉴权文件时，组合根先通过稳定 `account/read` 判断当前使用 API Key 还是 ChatGPT 路由，再按官方
  Doctor 的端点规则只探测活动线路。API 与自定义 `openai_base_url` 使用 `/responses` 传输探测和
  `/models` 路径校验，ChatGPT 使用 `/backend-api/codex/responses`；`account/read` 与 HTTP 探测共同受
  总计 12 秒的启动窗口约束，传输失败在剩余时间内有限退避重试，以覆盖已解析代理地址的监听稍晚于
  App Server/Gateway 就绪的情况。推理端点 HEAD 返回 5xx 时报告线路异常，不被 `/models` 成功掩盖。
  失败和路径异常形成脱敏状态
  供渠道上线通知使用，但不阻断 Gateway；停止过程会取消仍在进行的探测。
- `startup-network-recovery.ts`：拥有启动后的有限网络复检、额度重读和主 OpenAI 实例的单次 MCP 刷新；
  接续会话后有界补读 MCP 快照，并保留读取期间更新的实时状态；429/5xx 继续有限复检。
  首次快照失败在网络可达后仅补读一次，实时通知或关闭会取消待补读项，失败不等于健康。
  只跟踪启动窗口内非授权类 `codex_apps` 失败，以真实状态通知确认恢复，停止时取消并有界等待。
  与首次探测共用根目录 `startup-network-policy.json` 的截止时间和退避参数。
- `deepseek-account-adapter.ts`：通过共享 Provider 运行时按请求读取切换 Profile 或固定基础配置中的
  DeepSeek Key，
  通过共享代理调用官方余额接口，并在共享有界响应读取和严格 Schema 校验后只返回稳定余额；Key、响应正文
  和解析异常不进入日志或业务事件；失败返回稳定文案并保留底层原因。官方账户只有余额接口，没有用量窗口，不展示本地用量估算。
- `opencode-go-account-adapter.ts`：通过同一共享 Provider 运行时按请求读取 OpenCode Go Key，调用官方
  `/zen/go/v1/usage` 接口，把 5 小时/7 天/月度三个窗口归约为通用 `quota-windows` 形态（已用百分比与
  重置时间）；参数化工厂按 `modelProvider` 区分 `ocg-<账户>`，指标库按账户过滤，并汇总本机
  指标库的模型本地 Token 用量；三个额度窗口共用一次精确 Provider 流式读取，不执行通用文本筛选、
  重复计数或偏移分页；Key、响应正文
  和解析异常同样不进入日志或业务事件；仅将官方明确的缺少订阅权益响应转换为可持久化的无有效订阅结果，
  不把普通鉴权或网络失败解释为订阅到期；失败返回稳定文案并保留底层原因。
- `cline-pass-account-adapter.ts`：按独立账户 Provider 读取固定或切换配置中的私有 Key，查询官方套餐额度接口，归约 5 小时、7 天和月度的已用比例及重置时间；未返回的重置时间归约为未知，已提供的时间仍严格校验。三个已知窗口必须齐全且唯一，上游新增的其它窗口类型不进入展示口径。响应有界读取、严格校验，失败返回稳定脱敏文案并保留底层原因。
- `ccg-account-adapter.ts`：按精确 `ccg-<账户>` 读取私有 Key，调用 Command Code 官方 CLI 当前使用的
  账户身份与 Credits 接口，归约月度、充值、赠送余额及 5 小时/7 天窗口；响应按统一字节上限和稳定
  Schema 校验；身份与 Credits 两次串行请求共用同一个总预算，失败不传播上游正文，并保留底层原因。
- `provider-idle-releaser.ts`：统一跟踪所有 Provider Client 的活动操作；当 Gateway 没有前台或后台
  Conversation 绑定、没有正在进行的 Provider 操作或启动任务时，先等待 60 秒宽限期；宽限期内
  新绑定、新操作或启动任务会取消本轮释放。宽限期结束仍空闲时，只有渠道会话空闲自动解除触发的
  全局释放轮次会先通过注入回调通知所有已知授权渠道，再关闭全部已连接 Client；其他原因导致的
  无绑定关闭不发送该通知。该组件在关闭 Client 后通过监管入口停止对应 App Server 进程（含主实例），
  不按 Provider 类型区分；每 60 秒复检一次，并停止监管入口中全部未被租约占用的运行实例，因此也
  覆盖仅由 `codexc remote` 启动、Gateway 从未连接的实例。租约占用或未运行的实例保持现状，后续
  请求通过 Provider 路由按需启动并重连。Client 关闭和启动期间使用有界并发保护，关闭失败只记录
  日志并在后续全局空闲检查重试；启动完成、会话解绑、后台任务终态和 Provider 操作结束都会触发
  检查；Gateway 关闭时停止新的检查，并在有界时间内等待已开始的关闭完成。
- `conversation-idle-releaser.ts`：按 `conversation.idle_release_minutes` 定期扫描前台 Thread
  绑定；输入或输出刷新最近活动时间，超过阈值且 App Server 确认为空闲后由
  `ConversationService.releaseIdle` 取得会话锁，持续复核扫描时的 Thread、活动时间与取消代次，取消订阅后
  只释放同一有效绑定；新活动使扫描失效时恢复原订阅，失败交给既有绑定恢复任务。
  成功后通过共享结构化事件只通知一次
  “自动解除占用”，并携带当前 Thread ID 供 `/r` 直接恢复。
  正在恢复或 Provider 断线的绑定会跳过本轮；断线只取消对应 Provider 的候选，其余候选仍可完成扫描和订阅补偿。
  补偿恢复暂时失败后继续使用既有恢复协调器的退避调度。强制新建标记也会跳过扫描；关闭时停止定时器并限时等待已经在途的
  扫描退出，避免释放 RPC 卡住 Gateway 关闭。
- `turn-error-diagnostics.ts`：把同步 RPC 与异步 `turn.error` 通知的 Turn 级失败转换为结构化诊断字段，
  由组合层记录 `turn.failed` 日志；不生成模型请求样本，不记录异常正文。保留阶段、归属、错误分类与受限代码，
  用户错误反馈仍走原有 RPC/完成事件路径。历史已写入的失败样本不猜测分类、不回填或删除。
- `config-lifecycle.ts`：在创建应用组件前应用网关进程时区，并在任何 Surface 或指标组件启动前
  获取配置级 Gateway 所有权；管理配置监听、防抖重载、持久配置事件投递、信号、所有权释放与
  进程退出；配置重载同时检查已启用微信的安全凭据变化，重新扫码替换同账号凭据也触发连接重建。
  读取或校验配置失败保留当前运行配置；已进入组件应用阶段后失败则走故障关闭链，避免允许名单、
  Workspace 或绑定已部分更新而仍按旧配置快照继续服务。该失败不确认配置事件，不终止共享 App Server。
  持久配置事件只在投递成功后按精确 ID 确认；队列操作已完成但解锁失败时保留完成结果并单独告警，不把已确认事件报告为保留待重试。
  只有应用启动完成后才把所有权
  协议标记为就绪，供服务管理入口区分进程占位和可用 Gateway；账户刷新私有 IPC 与应用一同启停。
  内部致命停止请求进入同一进程关闭链，立即取消设置与代理监听、撤销就绪并关闭账户 IPC；整体关闭预算为 30 秒，超时标记故障。正常及超时后的显式进程退出均先关闭投递、指标与计划任务存储，阻止新数据库 Worker 创建，并确认其 Worker 与嵌套 helper 已实际退出，不把超时视为资源回收成功，不终止共享 App Server。
  该 IPC 根据受控账户查询原因生成固定文案，不透传内部异常 message；按 Provider 记录阶段、分类、
  耗时和受控状态码，主动取消不记录为上游失败；快照等未知本地异常按内部故障处理。
- `provider-settings-watcher.ts`：监听当前 Gateway 已启用的受管 Provider 模型目录、Profile 与管理标记；
  构造与轮询不在 Gateway 主线程读文件；单个有界 Runtime Worker 安全读取、散列并完整校验稳定快照，
  同时最多一项读取，应用与模型刷新后的确认使用新读取。Worker 初始化、普通读取与停止分别有独立时限，
  限制单文件、文件数与整批字节预算，私有访问校验保持当前平台语义，跨线程仅返回指纹和安全失败阶段。
  保留的聚合实现使用 Runtime 提供的第三方成员材料指纹捕获成员配置、目录及源路径变化，复用同一待应用流程；当前关闭状态不注册聚合监听。
  主 Codex 配置不参与聚合变化监听，必要的主配置校验留在材料加载与实例启动／应用边界。
  校验后逐 Provider 调用监管设置应用端口，原生 TUI/Desktop 租约或权威活动 Thread 保留待应用状态。
  组合根在同一 Provider RPC 准入入口排空请求并阻止新请求；监管重新派生启动材料并只更新目标实例，
  连接与绑定恢复复用既有协调器；设置恢复期间再次意外断线必须重新握手，主动释放或关闭会取消设置等待者。
  模型目录只刷新成功的 Provider：启动前先核对宿主已应用的指纹与默认设置，运行实例读取权威目录，
  未运行实例仅使用匹配该指纹的已捕获目录；不会为目录读取唤醒实例或提前发布其他 Provider 的待应用设置。
  已配置但尚未确认目录的受管与聚合 Provider 保留不可用身份占位，不发布未经确认的模型能力；确认成功后按 Provider 整体替换占位。
  模型目录刷新成功且文件代次仍匹配后才确认生效，连续变化及失败
  保留待应用项并按冷却时间重试；每 Provider 每文件代次最多失败 12 次，新的文件变化或 Gateway
  重建重置预算。启动静默核对宿主的已应用指纹，相同指纹不重启实例，避免重建丢失待生效变化。
  聚合成员变化经快照读取识别，或任一提供商设置应用被宿主拓扑守卫拒绝后，只提示一次需重启 App Server 和 Gateway，并保留待应用项；本次 Gateway 生命周期不再重试该实例。其他提供商继续检查，其设置变更若触及宿主拓扑保护也转入需重启状态。
  停止时取消应用、最多等待五秒，迟到结果不刷新模型或发状态通知；重复启动不增加定时器，停止后不能重新启动。
- `network-proxy-watcher.ts`：按字段保留 Codex `.env` 与标准环境代理优先级；已有任一代理地址时跳过系统查询，
  否则监听系统发现参与解析后的有效代理变化；单独配置 `NO_PROXY` 不禁用观察。仅记录需手动刷新 Gateway 和 App Server 的提示，区分
  后台服务与前台入口，不自动重启共享进程。系统查询异步执行且不重叠，失败保留上次结果并告警；
  停止 Gateway 时取消后续检查及在途查询，并等待查询结束。
- `completion-output-enricher.ts`：在实际投递前为 `turn.completed` 补全当前授权 Workspace 的 Git 分支、
  本轮统计、显式父 Turn 任务合计与递归包含子代理后代的 Session 累计统计；通过注入端口等待指标写入水位。
  Git 异步读取与统计补全并行，共享 250 ms 展示预算；优先启动执行耗时查询，其余独立查询并行准备，各自仍等待所需指标水位，耗尽后不启动后续查询，已启动查询的迟到失败仍被捕获；失败时保留 Core
  本轮统计并省略不可靠的累计值。第三方账户额度并行读取、独立上限 2 秒，失败或超时省略，不回退到其他账户或缓存。
  本轮与会话耗时只读指标库，不在投递路径扫描官方历史；原完成事件的官方本轮耗时优先。查询超时、失败与暂未就绪由投递时生成的状态明确展示，不与官方缺失耗时混同，也不写入持久投递记录。
  自动审查总数、各结果分类、覆盖与已记录审查 Token 也通过指标库窄端口分别读取本轮任务与当前会话累计；读取前等待调用时全部已入队指标的有限水位，以覆盖子代理，仅对应运行范围内的审查写入失败保守标记用量 partial，不降级独立的审批事件覆盖。普通任务与会话统计同样只受其范围内非审查写入失败影响。水位支持预算信号取消，不等待后续流量、不证明 IPC 无遗漏或历史无裁剪，仍受共享 250 ms 预算约束。查询失败显式返回未知，不把缺失观测当完整零次。Git 分支查询失败仅省略分支，不丢弃已经取得的审查统计。
  子代理开始和继续通知通过注入的只读 Thread 端口，在共享的 2 秒预算内获取提供商并核验归属；开始通知保留官方活动中的启动模型与思考等级，继续通知获取读取时设置。开始通知核验直接父子身份，继续通知目标非直接子级时补读发起 Thread 并核验同一官方 session tree。失败、超时或关闭时查询字段保留未知，不覆盖已收到的启动快照，不读取任务正文或推测上下文继承。
  `beginShutdown` 禁止新账户与子代理配置查询，`stop` 取消在途查询；超时同样取消出站查询。
- `surface-manager.ts`：按 `surface + accountId` 向已启动 Surface 集中路由 Core 输出，投递前委托
  `completion-output-enricher.ts` 补全完成事件与子代理开始、继续设置；持久与非持久投递共用补全异常降级，保留原始事件继续投递。取消、授权复核、平台发送和持久确认仍各自处理失败。并行完成各 Surface 的首次启动，
  单个渠道启动或运行失败时只取消该渠道交互并独立退避恢复，不停止 Gateway 或其他渠道。
  Telegram 通过可选 `admitLive` 在普通与持久模式发布时固定正文预览的授权活动身份，按原事件弱引用去重；富化后的 `handle` 继承 `liveAdmitted` 上下文，只跳过重复准入。展示生命周期仍按普通模式的消费顺序、持久模式的发布顺序观察；未提供准入端口的渠道不接收新增上下文。
  生产装配将终态与独立生命周期通知写入投递箱，实时调用 Surface 的本地生命周期观察端口；最新展示状态在 512 项/8 MiB 内存预算内按键合并，前序持久结果排空后复核归属再展示，直到渠道实际结算才释放预算，同键在途状态和最新替换值共同计费。
  实时状态与持久结果共用 Conversation 调度，CLI 输入镜像按到达序号排在前序通知之后、后续结果之前；完成或断线将失效传播到渠道队列。永久隔离账号时移除其临时快照，排队任务取消后释放预算，在途任务等实际结算，持久记录不删除。未装配持久投递的独立路径保留原有内存恢复队列；补投与实时输出共用每 Conversation 的有界顺序队列；
  完成统计与额度查询只等待本会话，不阻塞其他会话或渠道。恢复前限时排空旧队列，
  故障期间的输出与在途返回事件按原始到达序号归并，旧快照不覆盖新快照；关闭后不再启动恢复。
  不可用期间不积压流式增量。渠道失效与启动失败日志附带受控的
  `errorChain`（每层只有类型与白名单错误码，不含错误正文），便于定位底层失败原因。
  渠道未就绪时对应账号的新审批、用户输入与 MCP 交互立即失败关闭。
  关闭时通过 `beginShutdown` 先拒绝新执行和交互，保留持久接收入口供组合根排空入站通知，随后 `stop` 等待入箱并关闭渠道。
- `channel-file-spool.ts`：文件独立 manifest 和 `channel-file-outbox` 根目录，沿 Thread 绑定调用活动 QQ/飞书/TG/微信的 `sendChannelFile`，通过共享 channelFilePolicy 复核类型及预算，透传显式 file/video/voice 与停止信号（微信拒绝 voice）；不改变图片数据格式，未知发送不重试。
- `channel-media-spool.ts`：图片和文件共用的私有领取、发送及归档处理，按明确 kind 读取各自 manifest，文件只允许同编号 `.bin` 副本；文件 version 1 可选 mediaType，缺省 file，原记录不改写，图片拒绝该字段。普通图片 version 1；QQ 显式 Markdown 图片 version 2 且 format=markdown，向 Surface 透传格式，不迁移旧记录。两个公开包装器各自持有生命周期和根目录，停止信号传到支持取消的渠道上传边界；文件在固定原目标后按渠道复核类型与预算。
- `channel-image-spool.ts`：图片 manifest 包装器，复用共享处理器扫描 `data/channel-outbox/pending/` 的图片发送请求，按
  Thread 绑定解析目标会话，调用 `SurfaceManager.sendChannelImage` 由各渠道机器人凭据
  发送，成功归档到 `done/`、失败归档到 `failed/` 并保留原因；Unix 使用 `0700/0600`，Windows
  使用当前 SID 私有 ACL；创建或使用目录时检查类型、链接与所有者，启动时先拒绝既有文件链接或异主文件，再收紧权限；只接受
  pending 目录内与 manifest 同编号的绝对图片路径。发送只交给已经成功启动的活动 Surface。
  每次轮询只处理一批快照，发送前将 manifest 原子改名为 `.sending`；失败归档未完成或重启
  遗留领取记录时仅重试归档，不再次发送图片，停止时不继续处理下一条。

业务状态和平台逻辑应留在对应模块，只有具体实现选择、交互端口注册与生命周期协调放在这里。
Provider 账户能力同样通过编译期显式注册：OpenAI 复用 Codex Client，第三方实现 Application
拥有的窄适配器；新增 Provider 不得动态加载，也不得把未知 Provider 回退到 OpenAI 账户查询。
新增内置 Surface 时实现一个 `BuiltInSurfacePlugin` 并加入显式注册表，不应向
`GatewayApplication` 添加平台专属字段。当前插件层只用于模块化单体内部装配，不扫描目录、
不动态导入包，也不是外部插件 API。
未启用 Surface 的持久绑定应保留但不恢复订阅。Gateway 关闭不得主动终止独立运行的 Codex App Server。
启动、停止和 App Server 重连由同一生命周期协调；单 Provider 断线只重连并恢复该侧订阅，
只取消该侧 Thread 的待处理交互，`thread/resume` 返回的活动 Turn 会重新归约到 Core。停止会中断启动中的 Codex 请求、取消并限时等待重连任务，且不会把主动关闭误判为永久
Thread 恢复失败。单个 Thread 被另一个 Codex 进程持有写锁时，组合根保留绑定并让 Gateway 与
其他 Thread 正常启动，按有界退避间隔只重试未恢复 Thread；占用与解除各投递一次结构化渠道通知。
重试只保留仍匹配原 Conversation、Workspace 与 Session 的绑定；绑定被删除或切换后移除旧恢复任务。
停止会取消等待计时器并限时等待在途恢复，不删除官方写锁或绕过 App Server 单写约束。
启动失败、启动中停止和正常停止共享同一个组件关闭任务；关闭入口取消绑定恢复计时器，Client 关闭后、存储关闭前限时等待在途恢复；停止后的恢复结果不再触发业务通知或计划任务恢复。异步启动阶段返回后检查停止状态，避免继续启动后续组件。除中断未完成连接所需
的 Client 关闭外，Surface、事件总线、Client 收尾和存储不会被组合根重复关闭。组合根有界持有
已接收的 Queue 完成释放任务，停止时拒绝新任务并先限时等待，避免 Surface 或 Client 关闭后继续派发。

- `relay-metrics-composition.ts`：Relay IPC 与已有 Gateway 指标 Writer 的组合；接收端随 Writer 存活，先等待授权材料准备再发布监听；准备期间关闭会取消 Reader，监听启动返回后再次核对关闭与最新启用状态。结算通过隔离 Worker 按当前私有原子配置异步核对调用方、账户和代次，入队前复核取消与关闭状态，不依赖延迟热加载或入口启用状态；停用身份仍可结算历史调用。不创建第二个数据库写入者或 Core 事件。
