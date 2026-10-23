# Thread 执行上下文 Debian 与 macOS 验收记录

本记录维护 2026-10-22 的运行证据及开放补证项，不替代[用户指南](user-guide.md)、
[协议支持矩阵](index.md)或模块契约。早期开发与独立审查见
[历史记录](archive/thread-execution-context-plan.md)；其中的未观察结论属于当时基线，
后续补证以本文明确列出的范围为准。Debian 章节补录此前对话中的操作与输出，
不是本次重新执行的结果；macOS 章节保留 `b268b484` 已提交的证据及限制。
随后授权执行的 Debian 定向补验单列于末节，不与前次补录混为同一批运行。

## macOS 基线与环境

- 仓库：`msola-ht/codex-channels`；分支：`fix/usage-origin-instruction-diagnostics`。
- 分支审查基线：`6375533c4f48120c440e4d3675854a88f5a81cac`。
- 验收 HEAD：`8232b2ed910f9e4ca2863e0cbe4a8feaf992736e`。
  验收时重新查询远端分支，与本地一致；收尾工作树干净。
- 已包含 `3eb15937565e8dfeef53469a56eca4da963944d9`、
  `e188ced01fff7ca32a44113e883ea4d908a319c9`、
  `b802d264db679ec38c24cd5c52898521a0a61ef4`、
  `3ab3359c18743a5f04d8ec27d3b0af924dc8655c` 和上述 HEAD。
- macOS 15.8.1（24H32）、arm64；Node v24.22.1、npm 11.19.1；Codex CLI 0.163.0。
- 官方固定源码：`83086188ae0614bd882818ff1aa23f3194962012`。
- 实际 CLI 入口位于
  `/Users/heforge/.local/share/fnm/node-versions/v24.22.1/installation/lib/node_modules/` 下的
  `@hegenai/codexc/bin/codexc.mjs`、`@openai/codex/bin/codex.js`。
  已核对命令链接和安装路径；HEAD 的隔离构建与全局安装的 1295 个 JS 产物一致，
  remote 参数脚本也已核对。该对应关系仅适用于本次检查时的安装状态。

## macOS 已观察结果

“真实链路”表示使用实际 App Server 或监管器；人工注入、延迟及替代依赖单独注明。
以下观察均未提交模型 Turn，也未读取、复制或构造 Codex 内部 session 文件。

| 范围 | 操作与关键结果 | 证据性质 |
| --- | --- | --- |
| Remote 包装与生命周期 | 经私有 Socket 进入原生 CLI 登录界面，无提示词 Turn；退出后共享实例仍存活 | 真实连接路径；不代表已登录 TUI 的全部交互 |
| 新建与目录诊断 | App Server → Client → Router → ConversationService → 状态格式化；cwd 设置通知更新最近确认目录，roots 保留生命周期快照；空 roots 保留空列表 | 真实协议及应用链路 |
| 非法响应与展示 | 畸形 roots 被拒绝；失效显示未知；人为延迟 Git 查询期间换绑，最终状态属于新绑定，Git 仍对应登记 Workspace | 人工输入和时序挑战 |
| 持久化历史冷恢复 | 隔离 Home 中通过 `thread/start → thread/archive → thread/unarchive` 建立无 Turn 的持久化会话；停止并重启自有 App Server 后，Router resume 成功，cwd、roots、指令来源重新建立 | 真实 API 与跨进程恢复；没有对话内容 |
| 换绑失败补偿 | 人工令本地绑定提交抛错；实际顺序为恢复新会话、退订旧会话、恢复旧会话、退订新会话；最终旧绑定及诊断保留，新订阅清理 | 人工故障，真实恢复与退订 RPC |
| 普通断线恢复 | 隔离连接断开后，经实际 Transport 和恢复协调器重新连接 | 真实连接链路 |
| Provider 设置重连 | 任务自有 Provider 默认设置变更触发监管器释放及重启实例；完整 Gateway 重连并恢复持久化绑定；断线时诊断隐藏，成功后重建且恢复标记清除 | 真实监管器与应用组件图；使用无效占位凭据，不调用模型 |
| Provider 租约保护 | 持有生命周期租约时应用设置，返回 `applied:false, reason:"leased"` | 真实监管链路 |
| 旧连接 settings | 捕获两条真实设置通知并延迟消费；完成真实 Provider 设置重启及恢复后释放通知，状态归约调用数为 0，新诊断保留 | 真实通知和重连，人工队列延迟 |
| 同连接迟到 closed | 人工通知先同步失效，再分别于恢复完成后、真实恢复 RPC 已返回但 Router 尚未提交时消费；最终恢复上下文保留 | 人工通知，经完整 Gateway 接收及消费队列；后者不是“线上的响应尚未到达” |
| 解绑后的关闭清理 | 人工填充 Goal、Token、Artifacts 缓存；解绑删除诊断后消费 closed，三类缓存均清除 | 人工数据和通知，经完整 Gateway 清理链路 |
| Provider 隔离 | A 真实断线期间，延迟返回的 B 创建仍可绑定；同 Provider 人工失效后的迟到创建被拒绝，并实际退订 | 真实操作与人工响应延迟、失效组合 |
| 诊断修订窗口 | cwd-only 变化、窗口溢出与订阅失效分别挑战；不将诊断信息不足直接当作订阅失效 | 人工事件挑战 |
| 计划任务瞬时失效 | 实际执行器及后台 Thread 创建中注入失效，返回 Provider 类失败；未调用永久阻断，Turn 调用数为 0，容量恢复为 3 | 人工失效及本地授权、模型依赖；未覆盖完整周期调度 |
| 渠道最终格式 | Telegram、飞书普通消息、飞书命令中心、微信的路径标点、反斜杠、控制字符、换行、未知及空列表输出；控制字符清理、渠道转义符合观察预期 | 本地最终字符串；没有真实平台投递 |

历史冷恢复补证采用固定上游支持的 archive 持久化路径：新建会话没有 rollout 时，
archive 可先持久化已加载会话。所有历史操作均通过公开 App Server API，资源仅属于本次任务。
因此早期直接恢复无 Turn 新会话得到 `no rollout found`，不再意味着本轮无法观察成功历史恢复。

设置 RPC 的确认响应可能早于实际设置通知及状态生效。本轮在 cwd 变化未稳定时接管，
曾返回 `thread.takeover.changed`；等待通知并经权威读回确认目录后恢复成功。
这是精确目录准入保护的观察，不作为已确认缺陷，也不据此放宽子目录互通。

## macOS 结论与仍开放的边界

本轮没有新增已确认需要修复的代码缺陷；没有自动修改产品实现。
运行结果不构成所有队列排列、原生客户端并发或真实平台行为的保证。

| 开放项 | 当前限制与后续动作 |
| --- | --- |
| 带内容或运行中 Turn 的恢复 | 仅恢复无 Turn 的持久化历史。需要另行授权的隔离历史资源或模型调用，才能观察对话内容及活动 Turn 恢复；本轮不扩大授权 |
| 自然发生的 closed 竞态 | 真实 unsubscribe 后的观察窗口内未收到 closed；上述关闭竞态均人工注入。后续需在已授权资源中捕获自然通知并重放对应时序观察，不能将人工成功标成真实协议成功 |
| 完整周期调度 | 已观察执行器不永久阻断，未观察下一周期实际成功执行；后续在隔离调度环境中补证，启动模型 Turn 仍须相应授权 |
| 平台实机呈现 | 已检查最终字符串，未真实发送；需独立的平台投递授权和目标会话 |
| 进程组瞬态异常 | 一次 stdio 清理返回“自有进程组清理未确认，保留资源归属”；后续未稳定复现，最终已清理。保留未确认异常状态；复现时收集自有进程组、退出事件和清理时限证据，再判断根因，不据此修改清理逻辑 |

源码确认的合同仍是：登记 Workspace 精确 cwd 准入；roots 为生命周期快照，
不自动回传 Turn/resume/fork；Git 分支、计划任务目录和 Hooks 范围保持登记 Workspace 语义；
本地锁和修订检查不提供跨原生客户端原子保证。本次证据不扩大这些合同。

## macOS 静态检查与清理

该验收提交已有类型、版本、模块边界、限定范围 Lint、文档索引和构建检查通过记录。
文档检查在无 Git 元数据的临时源码副本中曾失败，随后在实际仓库通过（当时 85 个 Markdown）。
相同输入的通过结果被复用；没有运行历史测试，也没有新增测试、探针或守卫脚本。
静态状态与上述运行证据分别成立，不能互相替代。

所有隔离 App Server、Gateway、监管器和交互会话均已停止；最终跟踪的子进程已退出，
两个 Socket 入口及其对应短路径 Socket 均不存在；任务临时目录已删除。
原有共享服务在最终检查时仍运行，未被停止或重启。
未覆盖安装、部署、发送渠道消息或提交模型 Turn；未操作用户现有历史会话。

## Debian 验收与修复补录

### 基线、环境与证据范围

- 初始验收 HEAD：`3ab3359c18743a5f04d8ec27d3b0af924dc8655c`；
  修复交付：`8232b2ed910f9e4ca2863e0cbe4a8feaf992736e`。
  分支审查基线与固定上游同上；原四个待验收提交均已确认存在。
- Debian 13.7、x86_64；Node v24.22.1、npm 11.19.1；Codex CLI 0.163.0。
- 初始验收核对了 PATH 中全局安装副本与相关构建产物；修复期间运行仓库构建，
  没有将修复覆盖安装到全局入口，不能把最终源码提交等同于用户现有服务版本。
- 下表记录修复过程中取得、对最终实现仍适用的观察。注入响应、人工事件和局部组件
  不算完整 Gateway 或真实历史恢复；没有保留原始逐条终端日志文件，证据来自本次会话记录。

### 实际观察与限制

| 范围 | 操作与关键结果 | 证据性质与适用范围 |
| --- | --- | --- |
| 创建与状态 | 隔离 App Server 经 Client → Router → ConversationService → 格式器创建 Thread；显示 cwd、roots 快照及临时 AGENTS.md 指令来源 | 真实协议与应用链；最终 Router 构建也观察了正常创建与展示 |
| 断线与重连 | 终止任务连接后，执行上下文与指令来源均为未知；实际 Client 重连成功 | 真实 Transport 连接；不等于完整监管器及绑定恢复成功 |
| 无 Turn 恢复 | 直接恢复临时会话返回 `no rollout found`，原绑定保留 | 真实失败响应；Debian 当时未使用 archive/unarchive 补建持久化历史 |
| 恢复成功状态 | 注入合法 resume 结果后，待恢复标记清除，执行上下文与指令来源重建；成功恢复后旧 closed 的身份守卫失效 | 人工响应，验证 Router 状态合并；不算真实历史恢复 |
| 迟到创建清理 | 真实 start RPC 完成后、结果交给 Router 前注入同 Thread 订阅失效，后台创建返回 `conversation.busy`，reason 为 `subscription-restoring`；没有新增后台绑定，并收到真实 unsubscribe 成功确认 | 真实创建与退订 RPC，人工失效；一次紧接着的 loaded/list 仍包含该 Thread，不宣称立即卸载 |
| Provider 范围与修订窗口 | 用不匹配的 Provider 失效谓词挑战在途创建；另在响应前产生 257 次其他 Thread 的 cwd 变化。均可绑定，订阅不待恢复；执行上下文保守未知，指令来源保留 | Router 人工范围与事件挑战，不是双 Provider 真实断线 |
| Core 关闭顺序 | 旧关闭同步观察后建立新恢复窗口，异步消费旧关闭再合并响应，活动状态保留；恢复窗口建立后才收到关闭，合并响应后活动状态为 undefined | Core 人工事件，无模型 Turn；不算完整 Gateway 队列复现 |
| 关闭身份守卫 | 原诊断对象返回 true，新生命周期对象返回 false，删除诊断后返回 true | 最终提交构建上的人工对象操作；缓存完整清理另见 macOS 证据 |
| 渠道格式 | Telegram、飞书普通消息、飞书命令中心、微信最终字符串覆盖 Markdown 标点、反斜杠、控制字符及指令路径；控制字符转为空格，保留渠道转义 | 本地格式输出，无平台投递 |

### 关联修复与独立审查

验收发现显式恢复未清待恢复标记、旧连接关闭在过滤前产生副作用，以及断线仍暴露旧指令来源。
全链路审查随后覆盖迟到生命周期的绑定提交与补偿、Provider 范围、订阅与 cwd 修订分离、
计划任务瞬时失败分类、指令路径转义及 Core 关闭观察顺序，修复均交付于 `8232b2ed`。
对应契约已同步到 `bootstrap`、`conversation-core`、`session-routing`、`surfaces` 的 README。

Astra 对 `6375533c..3ab3359c` 与当时修复工作树完成独立全链路审查；
最终关闭时序修订另经针对性复核，发现并修正了诊断删除时误丢关闭清理的问题。
最后复核没有未解决的新增确定问题。独立审查为源码与调用链判断，不是审查代理亲自运行的证据。
Provider 设置主动重连、完整恢复失败补偿、计划任务失败分类和完整 Gateway 排队通知，
在 Debian 当时仍主要依赖源码审查及局部人工挑战；不能借用后续 macOS 运行结果声称 Debian 已实测。

`8232b2ed` 的提交 Hook 已通过类型与版本、模块边界、变更文件 Lint、文档索引和构建。
推送后远端 SHA 与本地一致，工作树干净；未新增或修改测试、探针、守卫脚本，也未运行历史测试。
任务 App Server 正常退出（code 0），随后确认任务进程与 Socket 不存在，临时目录及 REPL 已清理。
没有读取内部 session 文件、提交模型 Turn、投递平台消息、部署或重启用户现有服务。

## Debian 补验范围评估（执行前）

`8232b2ed` 之后的 `b268b484` 仅补充 macOS 文档，本次也仅补录文档，未改变产品实现。
已有 Debian 运行及静态证据无需因文档更新而全部重跑；这不等于 Debian 的未观察项已经关闭。

若要将验收结论提升为 Debian 上的真实历史恢复与监管器恢复链路也已观察，仍需在授权的隔离环境补充：

1. 使用 App Server 的 start/archive/unarchive 建立无 Turn 持久化历史，停止并重启自有实例后冷恢复，
   核对绑定、cwd、roots 与指令来源；不操作内部 session 文件。
2. 经 Debian 的任务自有监管器观察 Provider 设置重连、租约保护及绑定恢复，检查 Unix Socket 权限、
   进程退出和资源归属；同时挑战绑定提交失败后的旧订阅补偿与新订阅清理。

这些是剩余的 Linux 运行证据，不是已确认缺陷或重复全量验收的理由。自然 closed、带内容或活动 Turn
恢复、完整周期调度和真实平台投递仍按上述开放边界处理；macOS 人工队列结果不能关闭自然通知缺口。
`ef5a2d7b` 文档补录本身没有启动补验；用户随后授权执行，结果见下一节。
本记录不包含 systemd 安装、服务激活或部署验收。

## Debian 定向补验结果

### 执行基线与隔离方式

执行 HEAD 为 `ef5a2d7b8ad344eacd9edc9aea0e861a6fa0f071`，与 `8232b2ed` 之间仅有文档变化，
产品实现及此前构建不变。环境仍为 Debian 13.7 x86_64、Node v24.22.1、npm 11.19.1、
Codex CLI 0.163.0，固定上游 HEAD 已重新核对。
使用仓库 `dist/` 与 `runtime/`，原生 CLI 来自
`/root/.local/share/fnm/node-versions/v24.22.1/installation/lib/node_modules/@openai/codex/bin/codex.js`。
没有安装覆盖全局 Gateway，也没有激活现有服务。

任务目录为 `/tmp/codexc-debian-igR6rZ`，包含独立 Home、Workspace、Provider 配置、数据目录和私有 Socket。
仅复制仓库模型目录，受管 DS 账户使用无效占位凭据；无模型 Turn、真实渠道发送或内部 session 文件读取。
操作在交互式 Node 环境完成，没有新增测试、探针或守卫脚本。

### 操作与关键输出

| 范围 | 操作与结果 | 证据性质 |
| --- | --- | --- |
| 无 Turn 持久化 | 实际 start/archive/unarchive 成功；固定上游 `thread_processor.rs` 的 archive 路径明确先持久化已加载的非 ephemeral Thread | 真实 App Server API；无对话内容 |
| 跨进程冷恢复 | 首个自有 App Server PID 2752805 退出 code 0，另启 PID 2753260；恢复前诊断为 undefined，Router resume 后同一 Thread `01a16712-a18c-72d3-aa8f-cf9d54dcd45a` 的 cwd、roots、AGENTS.md 来源重建，权威 read 返回 idle、activeTurnId 为 null | 真实新进程、Client 和 Router；恢复前失效标记由交互环境显式调用 |
| 换绑失败补偿 | 第二个无 Turn 持久化 Thread 恢复时，人为令 `switchForeground` 抛错；记录实际 RPC 顺序为 resume 新 → unsubscribe 旧 → resume 旧 → unsubscribe 新；原绑定与执行上下文、指令来源保留 | 人工本地提交故障，真实恢复及退订；恢复原方法后继续运行 |
| 监管器及 Provider | 运行实际 `runAppServerService`，Supervisor PID 2753988；主实例 openai 与受管 ds-isolated 均由任务监管器持有 | 真实服务 Runtime 与私有监管 IPC；不是 systemd 安装服务 |
| 租约保护 | 获取 ds-isolated 租约，通过既有设置 writer 将默认思考等级 high 改为 low；设置应用返回 `applied:false, reason:"leased"` | 真实租约、隔离配置写入及监管响应 |
| 设置应用重启 | 释放租约后再次应用，返回 `applied:true, changed:true`；服务日志记录 ds-isolated 释放及重新启动，官方 config/read 确认实例默认等级 low | 真实目标实例生命周期；不据默认值推断已恢复 Thread 的等级 |
| 断线与绑定恢复 | 收到 ds-isolated 真实断线时隐藏诊断；调用实际 `GatewayReconnectCoordinator.recoverAppliedSettings`，经 ProviderRoutingClient、BindingRestoreCoordinator、Router 恢复同一持久化绑定，cwd、roots、来源重建，`isRestoring` 为 false | 手工装配真实组件；输出、交互取消及非目标回调使用本地空实现，未运行完整 Gateway 设置入口 |
| 最终状态消费 | 使用真实 ModelSelectionService、ConversationService 和共享格式器，输出恢复后的最近确认目录、roots 快照及 AGENTS.md 文件路径 | 本地最终文案，无平台发送；不以先前临时模型状态替代值作为最终证据 |
| Unix 路径与权限 | 两个 App Server 入口为官方 rendezvous 符号链接，指向 `/tmp/codex-daemon-0/` 下各自哈希 Socket；实际 Socket 均为当前 UID 0、0600，任务目录、入口父目录和短路径父目录均为 0700 | 实际文件类型、realpath、所有者与 mode；符号链接自身 0777 不作为 Socket 权限 |

### 结论、检查与清理

本轮没有新增确定的产品缺陷。Debian 的无 Turn 历史冷恢复、换绑失败补偿、监管器设置重启、
租约保护及实际恢复协调器链路已补得运行证据，不再保留为完全未观察。
完整 Gateway 设置入口的自动编排本次未重跑，其完整组件图证据仍来自 macOS；
自然 closed、带内容或活动 Turn 恢复、完整周期调度、真实平台投递仍未因此关闭。
没有代码变化，因此复用 `8232b2ed` 的静态与构建结果；本次仅对新增文档执行提交门禁。

直接启动的两个 App Server 均正常退出；恢复协调器停止、连接关闭后向任务监管器发送 SIGTERM，
其退出结果为 signal SIGTERM。随后实际进程检查未找到任务监管器或已记录子进程；
两个入口、两个实际短路径 Socket 及 Supervisor Socket 均不存在。
确认后删除任务目录并退出 REPL。没有以单独的退出信号代替清理确认，也没有停止或重启用户现有服务。
