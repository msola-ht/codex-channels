# 模块轻量化分析与审查记录

## 目标与范围

本轮工作以模块职责、依赖方向和重复实现为对象：减少重复业务分派、收敛边界校验的维护入口，
让平台模块只承担必要的平台差异。沿真实调用链确认收益后再实施，一次处理一个完整问题。

不以文件行数、拆文件数量或 CLI 启动时间作为成功标准；不为了统一形式合并不同平台状态机，
不增加只有转发作用的抽象层。没有测量证据时，不宣称性能、内存或包体积改善。
不扩大协议支持、修改授权语义或改变持久化格式。提交、推送及部署另按用户授权执行。

## 固定推进流程

1. **分析**：列出入口、调用方、数据与状态所有者、输出、失败及关闭路径，检查模块公开接口与现有测试。
2. **改前审查**：说明重复点或依赖问题、可验证收益、必须保留的差异；不成立的候选记录搁置理由。
3. **优化**：优先复用现有能力，以最小完整改动实现；不混入无关清理。
4. **改后审查与修复**：对照调用链检查行为等价、错误处理、授权、资源释放和文档；发现问题先修复再推进。
5. **验证与记录**：按风险运行相关检查，记录准确结果与缺项；不把未执行的检查记为通过。
6. **继续分析**：本项闭环后再选下一项，每次更新本文件的状态、结论和证据。

阶段状态使用：待分析、分析中、改前审查通过、优化中、待验证、已验证、审查发现回归待修复、搁置。
“已验证”指记录范围内的本地验证完成，不代表已提交、全量检查通过或真实平台验收。

## 当前工作区

分支：`refactor/lazy-cli-surface-loading`。本记录建立时 HEAD 为 `e93e0c9a`。
M01、M02、M03、M04、M06、M07 及 R01 已提交为 `2683d70a`；此前 CLI 加载调整不计入本轮模块轻量化收益。
M09、M10、M16、R02、M17 及 M08—M15 分析记录已提交为 `0b6365d1`；下文各项“未提交”描述其开发阶段，当前交付状态以本节与提交记录为准。
M19 与 M20 已提交为 `7da3fe20`；该提交正常 pre-commit 全量门禁通过，5523 项测试通过、103 项跳过，详见文末第三批提交结果。
各项原有验证记录描述开发阶段；当前提交状态与全量验证以本节和各批提交结果为准，未执行的真实平台联调、Windows 实机与远程 CI 不因本地门禁通过而视为完成。
已完成 `9372f9d0..7da3fe20` 全分支改动审查，覆盖 9 个提交、81 个文件；结论及未解决限制见文末 B01。
后续 S01、S02 已实施共享 PrivateIpcServer 修复和 Supervisor 收敛，尚未提交；R03 全改动复审确认的两项新增问题已由 R04 修复并重新验证。B01、M07、S01、S02、R03 保留为各阶段结论，当前交付判断以 R04 为准。

| 编号 | 模块与问题 | 状态 | 收益 |
| --- | --- | --- | --- |
| M01 | 飞书 Adapter 混有大量无状态命令中心展示转换 | 已验证 | 输入执行与展示维护范围分离 |
| M02 | Delivery 列表读取重复维护数据库读取生命周期 | 已验证 | 四个读取入口共用现有校验与连接关闭逻辑 |
| M03 | Telegram 重复维护普通命令结果分派 | 已验证 | 删除 20 个与共享渲染器等价的分支 |
| M04 | Provider 展示辅助函数跨渠道重复、依赖位置不合理 | 已验证 | 复用既有 Provider 展示模块，消除重复和反向展示依赖 |
| M06 | 计划任务定时／手动领取重复创建 Run | 已验证 | 统一 Run 初始记录构造，保留两类领取规则与事务 |
| M07 | Provider 指标接收端重复维护 Unix IPC 生命周期 | 已提交（保留基线限制） | 统一复用现有 PrivateIpcServer，生产代码净减少 83 行 |

## M01：飞书命令中心展示

- 链路：Surface 的 Inbox／卡片回调 → Adapter → Application 命令执行 → 展示转换 → CommandCenter 卡片与令牌。
- 改前审查：转换函数只依赖动作、类型化结果和共享格式化函数，不需要 Adapter 实例、网络或令牌存储。
- 优化：展示实现移到 `src/surfaces/feishu/command-center-presentation.ts`；Adapter 保留输入、执行及异常处理。
- 改后审查：提取时逐项比较 27 个顶层声明，实现内容一致；Adapter 类完整保留；类型引用不形成运行时反向依赖。
- 收益与限制：Adapter 从 1888 行到 1007 行，缩小职责范围；总代码量未下降，不宣称性能收益。
- 验证：飞书命令、命令中心、输入、渲染、模块边界共 96 项通过；类型检查、Lint、文档检查通过。
- 缺项：未做真实飞书联调；未运行提交全量门禁。

## M02：Delivery 只读连接生命周期

- 链路：管理查询 → Delivery 公共异步入口 → queue-reader → 私有路径和版本检查 → 同一只读事务查询 → finally 关闭连接。
- 改前审查：列表读取与既有 `withReadDatabase` 的打开、校验、事务设置和关闭代码相同；写入者仍拥有自己的连接与锁。
- 优化：`readDeliveryQueue` 复用现有 `withReadDatabase`，净减少 9 行。
- 改后审查：参数在打开连接前校验；不存在返回 missing；非法路径和版本继续抛错；列表不读密钥或正文。
  聚合与分页仍在同一事务中；成功和失败均关闭连接；不改数据库格式或恢复行为。
- 验证：构建及 Delivery 读取、WebUI 投递管理共 30 项通过；相关 Lint、Diff 检查通过。
- 缺项：未运行提交全量门禁。

## M03：Telegram 普通结果分派

- 链路：Bot 文本／回调 → Application → 类型化命令结果 → Telegram 渲染 → HTML 面板分块发送。
- 改前审查：20 个普通分支调用的格式化函数和参数与共享渲染器相同。
- 优化：普通结果使用 `renderConversationCommandResult`，专属结果继续走原分支，净减少 83 行。
- 改后审查：12 个专属分支及其辅助声明逐项比较保持一致；按钮、令牌、重置券、Diff 和通知方式保持原样。
  共享渲染器返回 null 时不发送；仍由原面板函数转义和分块。
- 验证：Telegram 渲染、交互、重置券、飞书／微信渲染及模块边界共 104 项通过；类型、相关 Lint、文档检查通过。
- 缺项：未做真实 Telegram 联调；未运行提交全量门禁。

## M04：Provider 展示职责收敛

- 链路一：飞书／Telegram 模型选择 → 按 Provider 裁剪模型显示名前缀 → 平台按钮。
- 链路二：会话列表／计划任务／命令结果 → Provider 文案 → 既有 `provider-format.ts`。
- 改前审查：两个渠道各有一份相同的前缀裁剪循环；Telegram 额外接受未限定 Provider。
  `formatDisplayedProvider` 本属 Provider 展示，却位于模型账户命令文件，导致会话和计划任务为一行文案依赖模型账户展示。
- 方案：将前缀裁剪统一放入既有 Provider 展示文件，保留未限定 Provider 时原样返回；将
  `formatDisplayedProvider` 原样移动到同一文件，更新所有调用方，不保留孤立转出口。
- 保留边界：只影响展示函数归属；不改模型 ID、Provider 解析、选择令牌、有效模型集合和命令参数。
- 优化：两个渠道调用共享 `scopedModelDisplayName`；Provider 命令文案移至既有 `provider-format.ts`，会话和计划任务不再为该文案依赖模型账户格式化文件。
- 改后审查：共享前缀循环保持原顺序和一次裁剪语义，未匹配的文本原样返回；原 `formatDisplayedProvider` 函数体保持一致。
  调用方仍独立负责模型筛选、按钮值和令牌，未增加公共模块出口或新状态。
- 审查修复：首轮 Lint 发现飞书调用处的非空断言因共享函数允许 undefined 而变得多余；已删除该断言，相关 Lint 复核通过。
- 验证：7 个测试文件共 102 项通过，包括新增的共享展示合同测试，覆盖精确前缀、原始 ID、未限定范围、不匹配以及只裁剪一次；类型和运行时依赖检查、相关 Lint 通过。
- 缺项：未做真实平台联调；未运行提交全量门禁。

## 已检查但暂不实施

- Event Bus：订阅队列、预算和关闭均有明确所有权；当前没有确认需要新增抽象的依赖问题，暂不为行数拆分。
- Model Relay／Provider Proxy：原生 Chat 与 Responses 已共用 `direct-model-http.ts`；
  流终态、观察器和错误交付仍有协议差异，暂不合并协议适配器。

## M05：后续分析——Telegram HTML 转义（搁置）

- 链路：操作过程 → `operation-format.ts` 的文本节点转义；命令面板／Markdown → `html-format.ts` 的转义与分块。
- 分析发现：函数名称相似，但操作过程只转义 `&<>`，面板还转义双引号；HTML 分块预算按转义后的字符数计算。
- 改前审查结论：不能直接把两者当作完全等价实现替换。为几行代码增加配置参数或新层，当前收益不足。
  本项不实施，保留现有展示和分块合同；若后续出现具体转义缺陷，再按该缺陷评估统一边界。

## M06：计划任务 Run 创建收敛

- 链路：Scheduler 定时 tick／Application 手动运行 → Store 的 `claimDue`／`claimManual` → BEGIN IMMEDIATE → 资格与占用检查 → 写入 Run → COMMIT → 读取结果。
- 改前审查：两条路径的 Run INSERT 列、初始字段、错误分类和时间戳赋值完全相同；定时领取还推进下一次 occurrence，手动领取用已有最大时间计算唯一 scheduledFor，不能合并两种领取用例。
- 方案：只在原 Store 内提取私有 `insertRun`，集中初始记录写入；UUID 仍在原调用位置生成。沿用调用者已有连接与事务，不新增服务、存储格式或公共接口。
- 保留边界：BEGIN／COMMIT／ROLLBACK、资格检查、排期推进及提交后读取位置不变；不涉及 App Server 协议或执行端口行为。
- 优化：两处相同的 INSERT 由同一私有方法执行，原连接和事务所有权保持不变；生产代码净减少 7 行。
- 改后审查：将新方法在调用处展开、规范空白后，与原类成员逐项一致；UUID 生成、资格检查、手动时间计算、定时排期推进和提交后读取仍在原位置。
- 审查补强：原测试覆盖重复领取，但没有直接断言 INSERT 之后失败时的原子性；新增测试通过任务时间倒退触发后续校验失败，确认 Run 回滚、任务未变化且同一 occurrence 后续可领取。
- 验证：Store、Scheduler、Application 原有 48 项通过；新增回滚测试后 Store 20 项通过，合计覆盖 49 个不同测试；生产类型及运行时依赖检查、源码与测试 Lint、Diff 检查通过。
- 缺项：未运行提交全量门禁；没有修改执行端口或 App Server 交互，本轮未操作真实服务。

## M07：Provider 指标 IPC 接收端生命周期

- 状态：整体审查发现的 R01 已修复，提交 `2683d70a` 的全量门禁通过。
- 链路：Bootstrap `ProviderMetricsComposition` → `ProviderProxyMetricsServer` → 私有端点 → 单帧解析 → 指标入队 → 确认；关闭时先销毁已接收连接，再关闭监听和清理端点。
- 改前审查：Windows 已使用 `PrivateIpcServer`，Unix 另有一份监听、旧端点探测、chmod 和身份清理代码；共享实现已提供这些能力，无需新抽象。
- 方案：接收端统一持有一个 PrivateIpcServer；保留指标帧上限、解析、确认、连接集合与开始／停止幂等标记。发送端本轮不改。
- 差异：共享启动会创建并保护父目录；旧 Socket 必须属于当前用户且无组／其他用户权限，清理前再次检查 dev/ino。合法现有 0600 端点不变，宽权限旧端点由原先允许接管改为明确拒绝。
- 验证重点：成功收发、已占用与普通文件拒绝、宽权限旧端点拒绝、启动中途失败清理、活动连接关闭、替换路径保护；Linux 本地执行，Windows 实机不在本轮环境内。
- 优化：移除 Unix 专属 server 字段、端点身份字段及四个生命周期辅助函数，接收端统一复用 PrivateIpcServer；生产代码净减少 83 行。
- 改后审查：单帧解析、8192 字节上限、指标回调与确认、发送端实现原样保留；连接集合仍由接收器关闭，Windows 继续使用原认证实现。未新增重试或指标队列。
- 测试修复：关闭未完成上传允许连接收到 ECONNRESET，夹具改为等待 close 并校验错误码；占用夹具显式使用 0600，分别验证合法占用与宽权限拒绝。
- 验证：指标 IPC 最终 12 项通过，HTTP、WebSocket 和组合根另 32 项通过，合计 44 项；类型与运行时依赖检查、相关 Lint 通过。
- 基线问题：新审查场景发现，监听期间将 Socket 重命名并在原路径放置文件，Node/libuv 关闭监听会删除替代文件，早于应用层 dev/ino 清理检查。用 HEAD 的原始 metrics-channel 实现独立复现，`replacementSurvives: false`，确认不是本次回归。
  该场景不计为通过；最终关闭测试覆盖活动连接和重复关闭，不代表监听期间路径替换安全。共享 IPC 的全面修复需要单独审查所有宿主，未在此次去重中扩大修改。
- 缺项：未执行 Windows 实机、提交全量门禁或真实服务操作；文档中“只清理自身端点”的描述需受上述基线问题限制。

## 本批改动的整体审查与提交准备

- 范围：M01、M02、M03、M04、M06、M07 的生产代码、测试、索引及新增未跟踪文件；首轮只读审查后，经用户授权修复 R01。
- **R01 / P2 / 已修复**：`ProviderProxyMetricsServer.start()` 的 catch 新增到 Unix 路径后调用公共 `close()`，将 `stopped` 置为 true；首次因端口占用失败后，同实例可再次 start 成功，但后续 close 因 stopped 提前返回，泄漏监听与端点，可能阻止退出或后续启动。
  隔离复现为“占用端口 → start 拒绝 → 释放占用 → 同实例 start → close”。原 HEAD 的 `listeningAfterClose` 为 false，当前工作区为 true。现有启动失败清理测试没有覆盖同实例再次启动。
  修复：新增内部资源清理方法，启动失败只清理连接与底层监听、不改变终态标记；公共 close 才进入终态。明确拒绝已关闭实例再次 start，避免重新打开无法关闭的监听。
  回归验证：占用失败后释放端口并重新启动、监听已打开后注入启动失败再重新启动，两条路径均能正常关闭并移除端点；终态关闭后再 start 明确拒绝。指标 IPC 与组合根 20 项通过。
- 其余改动：复核飞书迁移的顶层声明，除已记录的 Provider 函数归属与多余非空断言移除外无意外改变；Telegram 12 个专属分支保持一致。Delivery 读事务与计划任务 INSERT 收敛未发现新增缺陷。
- M07 的监听路径被替换后遭 Node 自动删除问题仍为已复现基线缺陷，和 R01 分开记录，不算本次新增回归。
- 验证范围：本次执行 HEAD／工作区隔离对照复现、结构比对和 Diff 检查；复用此前定向测试结果，未重复全量测试，未执行 Windows 实机或提交门禁。

## 提交结果

- 提交：`2683d70a`，改动：收敛模块展示与存储职责并复用指标 IPC；未推送。
- 正常 pre-commit 门禁一次通过，使用 Node 22.13.0；全量测试 5510 通过、103 跳过，379 个测试文件通过、11 个跳过。
- 类型与版本、源码／测试 Lint、WebUI 构建与 Lint、翻译、文档、Shell 语法和 tarball 安装冒烟通过，总耗时约 2 分 46.5 秒。
- 门禁日志：`/tmp/codexc-module-lightweight-commit.log`（当前开发环境临时日志，不作为永久仓库文件）。
- Windows 实机、远程 CI 与 Unix Socket 路径替换基线问题仍未完成验证或修复。

## M08：Delivery Worker 生命周期分析（搁置）

- 链路：`PersistentSurfaceOutput` → `DeliveryJournal` 有界邮箱 → Worker 串行执行 → SQLite；故障通过注入的 onFailure 返回组合根。
- 资源所有权：Journal 持有 pending 请求、每请求截止定时器、在途正文预算和 Worker；Worker 持有数据库，正常 close 在回复后关闭消息端口。
- 改前审查：5 秒请求截止触发整体失败并释放等待者；正常关闭先发送保留容量的 close 命令；1 秒 terminate 上限处理 Worker 不退出。三者等待的对象、故障通知和清理责任不同，不能因为都有 timer／Promise.race 就合并。
- 现有证据：`persistent-output.test.ts` 覆盖不响应 Worker 的邮箱容量、超时与等待者释放，以及空闲 Worker 退出后的故障隔离；本批全量门禁包含该套件。
- 结论：没有确认能减少职责或冗余状态的最小改动，暂不增加通用超时／Worker 抽象，也不改变关闭语义。

## M09：Relay 活动租约集合（已提交：0b6365d1）

- 链路：HTTP 请求 → reserve／wait 准入 → lease.check 出站复核 → 请求 finally 调用 release；策略变更、Provider 撤销与关闭遍历租约并 cancel。
- 改前审查：`leases` 原为 Map<RelayLease, string>，写入的身份摘要没有读取者；所有消费只使用 size、delete 和 keys。每份租约闭包中的 identity 已承担新旧权限比较。
- 方案：改为 Set<RelayLease>，使用 add 与集合遍历；不删除闭包 identity，不改变维护凭据代次和防复活记录的 identities／retiredIdentities。
- 预期收益：去掉无用途的键值关系，用成员集合直接表达在途租约；不宣称可观测的内存或性能改善。
- 保留边界：Set 与原 Map 键迭代均保留插入顺序及遍历时删除的语义；排队仍由 pending／pendingKeys 持有，容量、撤销、超时与释放流程不变。
- 优化：只修改 leases 的容器声明、登记和三处遍历；用 Set 直接维护租约成员。
- 改后审查：逐项核对 leases 的全部使用处，无摘要值读取者；闭包中的 privilege 比较、凭据历史 Map、身份轮换／防复活、并发记账和 pending 释放均保持原样。
- 验证：Relay 准入、授权和 HTTP 服务共 196 项通过，涵盖策略变更、身份撤销、等待租约取消、公平调度、容量与服务关闭；类型和运行时依赖检查、相关 Lint、Diff 检查通过。复用既有行为测试，未增加仅断言容器类型的测试。
- 限制：未测量内存或延迟，不宣称性能提升；本项未执行提交全量门禁或真实服务操作。

## M10：Event Bus 订阅对象去除闲置 Worker 引用（已提交：0b6365d1）

- 链路：subscribe 创建队列、取消控制器和消费者 Promise → publish 向活动订阅入队 → 取消订阅关闭队列并移除订阅 → close 等待独立 workers 集合。
- 改前审查：Subscription.worker 只在构造时赋值，没有读取者；真正用于关闭等待和完成清理的是 workers 集合。不能删除后者，否则已取消订阅但尚在处理的消费者不再被关闭等待覆盖。
- 方案：仅删除订阅对象的 worker 字段与赋值，共两行；不增加类型层、状态或生命周期抽象。
- 收益限制：消除无用途的持有关系，明确活动订阅与未完成消费者的不同生命周期；属于小幅清理，不宣称模块级性能收益。
- 改后审查：生产 Diff 仅删除字段声明和对象赋值，workers 集合登记、完成后移除、取消信号、预算释放与关闭等待均未改动。
- 验证：队列与输出总线预算测试共 28 项通过，包含“取消订阅后关闭仍等待消费者完成”、取消信号、排空、并发关闭和硬预算；类型与运行时依赖检查、相关 Lint、Diff 检查通过。
- 限制：仅为闲置引用清理，未运行提交全量门禁。

## M11—M15：非展示模块横向链路审查

本轮先比较五组候选，再决定是否优化。以下是源码与现有测试的静态审查结论；本轮没有新增生产代码改动，未重新执行这些行为测试。M09、M10 保持已验证、未提交状态。

| 编号 | 候选 | 审查结论 | 当前决定 |
| --- | --- | --- | --- |
| M11 | Model Relay 请求资源登记合并 | 诊断、取消、等待完成及请求头截止分别覆盖不同生命周期 | 搁置合并 |
| M12 | 指标发送与落库队列统一 | IPC 接受与 SQLite 持久化不是同一完成条件 | 搁置统一队列 |
| M13 | Binding Store 去除内存层或抽出 SQL 层 | 内存层已复用索引规则；持久化事务与回滚仍由 SQLite 层负责 | 搁置结构调整 |
| M14 | Scheduler 定时／手动执行流程统一 | 已共享 dispatch；入口排序、领取及停止条件有必要差异 | 搁置通用执行模板 |
| M15 | Traffic Dump 三类文件流统一 | 文件创建、权限、错误和关闭登记已共享；剩余差异属于格式和轮转 | 搁置动态流注册抽象 |

### M11：Model Relay 请求生命周期

- 链路：HTTP connection → 请求头截止定时器 → handle → 授权与准入 → Provider 请求 → finally 释放；stopListening／close 分别处理暂停监听和最终关闭。
- 所有权：`server.ts` 的 headerTimers 管理尚未收到完整请求头的 Socket；active 持有请求取消控制器；tasks 等待整个处理 Promise 完成；requests 只登记已授权模型调用的诊断投影。
- 改前审查：四者并非同一请求表的重复副本。连接可以尚未进入 handle，诊断集合不包含全部 HTTP 请求；取消信号发出也不代表清理已经完成。直接合并会让关闭等待或诊断范围依赖额外条件。
- 证据：`tests/model-relay-server.test.ts` 覆盖绝对请求头截止、上游超时只结算一次、客户端断开和停止监听取消。入口与清理重点为 `server.ts` 的构造监听、stopListening、close 和 handle 的 finally。
- 结论：未找到可整块删除的重复资源管理。保留现有集合，不新增统一请求上下文注册器；若后续发现取消与诊断登记遗漏，再围绕具体遗漏审查。

### M12：指标发送、写入与查询水位

- 链路：RelayMetricsSender → 私有 IPC 确认 → BufferedModelRequestMetricsWriter → Store.recordBatch → SQLite；Bootstrap 查询 Thread／Turn 指标前调用 waitForCurrentWrites。
- 所有权：发送器拥有有界发送队列和传输结果；Writer 拥有落库批次、范围水位及写入失败结果；Store 拥有事务。发送确认只表示入队，不能用它替代持久化结果。
- 改前审查：Writer 的水位只等待调用当时相关范围内已入队记录，不能改成等待全队列空闲；否则后续无关流量会拖延完成展示。发送超时也不能推导为未入队，更不能因此补发。
- 证据：`tests/buffered-model-request-metrics-writer.test.ts` 覆盖既有写入水位、Thread／Turn 失败隔离及关闭排空；`tests/model-relay-metrics-sender.test.ts` 覆盖未确认超时不重试、明确拒绝与已接收但确认丢失的区别。查询调用方位于 `gateway-component-graph.ts`。
- 结论：不统一队列和确认模型。Store 已分离 schema、查询与行映射，record 和 recordBatch 也已共享 insertSample；目前再抽写入门面只会增加转发层，没有确认模块级收益。

### M13：Binding Store 持久化与内存索引

- 链路：业务通过 BindingStore → SqliteBindingStore 写事务及内存索引更新 → MemoryBindingStore 提供查询；重启经 load 从持久化数据恢复索引。
- 改前审查：内存层保存绑定、Actor、Workspace 等最小索引，并非复制 App Server 会话历史。删除内存层意味着重写查询和绑定索引规则；另抽 SQL 门面仍不能移走事务成功／失败与内存一致性的协调责任。
- 具体审查：retainActors 在事务提交后清理内存 Actor／绑定并设置 force-new，不能简单改成提前调用 MemoryBindingStore.retainActors；时间戳和清理条件也必须对齐。其他绑定变更还需保留事务失败后的索引恢复。
- 证据：`tests/sqlite-binding-store.test.ts` 覆盖偏好持久化失败回滚、绑定事务失败恢复内存与持久化索引、跨会话转移、账号隔离及重启恢复。
- 结论：本轮不删除缓存、不更改 Schema、不按文件长度拆 SQL。该模块的后续分析价值在于逐个核对“双层更新”的业务规则是否重复或不一致；只有能消除同一规则的第二份实现且保持原子性，才进入改前审查通过状态。

### M14：计划任务调度与终态归并

- 链路：tick 收集到期任务／runTaskNow 串行手动请求 → 容量检查 → Store 领取 → 共享 dispatch → 执行结果落库 → onRunStateChanged → 重读权威 Run。
- 改前审查：定时入口需要补记错过的 occurrence、按 Conversation 保序并跨 Conversation 并发；手动入口通过 manualRunTail 排队，再等待活动 tick。共用执行端已存在，不需要再增加可配置执行模板。
- 终态边界：completed 路径先保存 running 标识并通知观察者，观察者可能归并已到达的终态；重读后才能决定是否继续完成转换。不能把几个 switch 分支统一成一次状态写入，也不能删掉通知后的重读。
- 证据：`tests/scheduled-task-scheduler.test.ts` 覆盖容量检查中停止、同会话保序／跨会话并发、终态回调竞态及停止后不启动已领取任务。
- 结论：保留领取与归并差异。tick 结果使用中间 Map 再排序存在局部简化空间，但不减少模块职责或状态所有者，本轮不把它列作模块轻量化成果。

### M15：Provider Proxy 流量转储资源管理

- 链路：Provider／Relay 转储入口 → TrafficDumpStorage 会话与待写预算 → trace／payload／interaction 文件流 → 串行写队列 → 轮转、退役与 close；Relay 两种协议共用预算和保留清理边界。
- 改前审查：三种 ensureStream 已共用 createSessionStream，私有权限、错误处理、活动流登记及 close 移除均只有一份。trace 与 payload 有不同计量和轮转条件，interaction 索引使用固定文件名。
- 关闭边界：结束写入、流 destroyed 与流真正触发 close 并不等价；轮转后仍可能存在待关闭的旧流，不能只等待当前 Session 字段指向的流。
- 证据：`tests/provider-proxy-traffic-dump.test.ts` 覆盖轮转流关闭、失败后等待 destroyed 流关闭和保留预算；`tests/model-relay-server.test.ts` 覆盖双协议共享预算、待写上限与关闭取消清理扫描。
- 结论：通用动态流字段注册只会缩短三个很薄的包装函数，不能再消除一套生命周期实现，暂不实施。保留现有共享层和独立预算边界。

### 本轮排序与验证边界

- 五项均未达到“已确认模块级收益，可以直接实施”的条件；不以分析数量作为修改数量，也不把静态审查记为行为验证。
- 后续优先深入 M13 的事务与内存规则对照；其潜在收益是减少同一绑定规则的维护入口，尚未确认可行方案。M11、M12、M14、M15 的本轮合并方案不继续推进，除非出现新的具体重复证据。
- 本轮只维护分析记录，执行文档检查与 Diff 格式检查；M09、M10 沿用各自已记录的定向验证，本轮不重复运行全量门禁。

## M16：Workspace 持久化写入收敛

- 状态：已验证，未提交；承接 M13 的链路审查，不删除内存索引或改变持久化格式。
- 入口链路：Application.selectWorkspace 在会话锁内检查活动任务和排队输入 → Router.selectWorkspace 解析已配置 Workspace、解绑旧订阅并保存选择 → SqliteBindingStore.selectWorkspace → 内存索引；绑定恢复／切换走 Router → switchForeground，跨会话接管走 Router → transfer。
- 关联边界：Router 在切换或接管的存储步骤失败后负责恢复被取消的旧订阅；Store 负责 Workspace、绑定、偏好和空闲标记的事务一致性；重启 load 从数据库恢复 MemoryBindingStore。模块间仍通过既有公开接口调用。
- 改前审查：selectWorkspace、switchForeground、transfer 三处 Workspace UPSERT 的列、冲突键、赋值和 Date.now 调用相同；直接选择先检查当前绑定，另两处必须留在现有绑定事务内。绑定表的普通 INSERT 与 UPSERT 不等价，本轮不合并。
- 优化：三条路径调用同一私有 writeWorkspace，复用原数据库连接，不开启额外事务或更新内存；减少两份重复写入规则，生产代码净减少 26 行，无新文件、公共接口或依赖。不宣称性能改善。
- 改后审查：核对三处调用参数、写入顺序和异常传播；BEGIN／COMMIT／ROLLBACK、授权检查、Thread 独占条件、订阅补偿、内存提交顺序、Schema v6 与 load 均保持不变。撤权、降为后台和移除 Thread 的不同规则不混入此次收敛。
- 初次覆盖补强：原前台绑定失败测试未让 Workspace 改值，补充不同 Workspace 输入及当前／重开后的旧值断言；新增接管后段 INSERT 故障注入。后续 R02 审查确认，这些断言能检查内存与恢复结果，但不足以单独证明 Workspace 表回滚；直接持久化断言已按下节补齐。
- 验证：sqlite-binding-store 与 session-router 两个文件共 92 项通过；类型、版本与运行时边界检查、相关源码／测试 Lint、文档与 Diff 格式检查通过。
- 限制：本项只消除重复持久化规则，尚未消除 SQLite 与 Memory 两层的绑定状态协调；没有修改 App Server 交互，未操作真实服务、未执行提交全量门禁。

## R02：Workspace 回滚测试盲区修复与方向复核

- 问题：M16 两个失败测试只通过 getWorkspace 检查结果。load 先读取 Workspace 表，再加载前台绑定，后者会覆盖内存中的 Workspace。因此即使 Workspace 表残留错误值，当前实例和重开后的读取也可能通过。
- 修复：两项测试在失败后各打开独立只读 SQLite 连接，以 surface、accountId、conversationId 精确查询 conversation_workspaces；前台绑定检查原 Workspace，接管检查源／目标两侧。查询连接通过 finally 关闭，保留内存索引、绑定、空闲状态及重启断言。
- 改后审查：断言在 Store 关闭及重启加载之前执行，直接观察事务结束后的持久化值，不经过内存恢复逻辑。生产代码无新增修改，不改 Schema 或用户数据。
- 验证：存储测试 26 项通过，相关测试 Lint、文档与 Diff 检查通过。在 /tmp 隔离测试副本中，于失败操作后故意写入错误 Workspace 残留，两项测试均在新增 SQL 断言处失败；这是预期的反向验证，副本与夹具已清理。原 92 项存储／路由测试结果保留，生产源码未变化，本轮不重复路由或全量门禁。
- 方向判断：M09、M10 属于局部集合／引用清理，M16 属于三条写入链路的内部规则去重；均未扩展功能或转向 CLI，但近期实施偏重小项，不能把这些结果累计描述为显著的模块减负。M16 的收益限于减少两份 SQL 维护入口，未减少模块、资源所有者或状态协调层。
- 后续选择：优先能整块减少重复生命周期、业务分派或不必要依赖的候选；局部无用字段和薄包装去重不再单独作为下一轮模块轻量化主项。没有确认收益时继续记录分析结论，不为了维持修改数量新增抽象或合并必要边界。本轮不撤销已验证的小改动，也不扩大到无关模块。

## M17：Relay 指标与控制查询的 IPC 请求生命周期收敛

- 状态：已验证，未提交。
- 候选筛选：Provider 指标发送在 Unix 直接连接、采用空闲超时且只做尽力发送；Relay 指标有取消信号、绝对截止及明确确认分类，两者不强行合并。Queue Events 是持续订阅，也不进入单次请求实现。
- 链路一：ModelRelayServer 生成指标 → RelayMetricsSender 有界队列 → sendRelayMetrics → 私有 IPC → RelayMetricsServer → Gateway 指标入队。Sender 保留四类结果及物理发送槽，接受不等于持久化。
- 链路二：管理／WebUI 查询 → queryModelRelayControl → 私有 IPC → ModelRelayControl → v4 回应校验；apply 还需摘要匹配，queue 允许最多 128 KiB 回应，status／apply 为 8192 字节。
- 改前审查：两条链路重复持有 Socket、截止定时器、响应缓冲、单次结算标记，以及连接／数据／错误／关闭监听。它们均不重试，按换行接收单份 JSON；差异可以由现有调用方给定的截止时间、回应上限和可选取消信号表达，不需要业务回调或协议插件。
- 优化：在既有 runtime/private-ipc 中集中 requestPrivateIpcJson，并补充类型声明；指标发送和控制查询移除各自请求生命周期实现。共享层只管理连接、字节预算、JSON 解码和清理，业务版本、请求 ID、摘要、结果字段校验仍归调用方。
- 收益：两份客户端资源管理收敛为一个所有者；这是实际跨调用链复用，不是仅移动文件。三个实现文件合计净增加 8 行（另有类型声明），不以行数、性能或内存改善作为收益。未新增项目依赖、文件层级、队列、重试或用户配置。
- 改后审查：控制回应验证块规范空白后与 HEAD 完全一致；1 秒指标请求、2 秒控制请求、8192／128 KiB 回应上限与 not_running／unconfirmed 分类保持。共享连接继续使用原私有端点校验和 Windows 认证；失败只返回受控异常，不包含帧或凭据。
- 解码边界：共享层按收到的字节累计预算，再合并 Buffer 解码；保留控制查询原有 UTF-8 分片支持，Relay 指标发送不再逐块转字符串。它不验证业务确认；非法、多帧同批或缺少换行的回应仍不能作为成功确认。
- 验证：新增共享合同测试覆盖 UTF-8 分片、回应超限、非法 JSON、截断、超时、主动取消、预取消、端点缺失及成功后连接／取消监听清理。最初的 48 项结果包含旧 dist，未作为最终证据；随后通过 npm test 构建最新产物，5 个文件共 217 项通过，涵盖共享请求、指标确认、Runtime 控制、Relay 授权及 HTTP 生命周期。
- 其他检查：类型、版本、运行时依赖边界、相关源码／测试 Lint、两份 JavaScript 语法检查、文档与 Diff 检查通过。Runtime 模块说明同步更新。
- 限制：Linux 隔离 IPC／HTTP 夹具验证；没有操作真实服务或 App Server，未执行 Windows 实机、远程 CI 或提交全量门禁。共享 IPC 监听路径替换的既有问题仍单独保留，本次未修改服务端生命周期。

## 第二批审查与提交结果

- 审查范围：11 个文件，包含三组实现收敛、Event Bus 闲置引用清理、回滚与 IPC 合同测试及文档；未发现新的阻断问题。R02 的持久化断言已补齐，IPC 控制回应校验保持原样。
- 提交：`0b6365d1`，改动：收敛 Relay IPC 请求生命周期与绑定写入规则；未推送，提交后工作区干净。
- 正常 pre-commit 门禁一次通过，使用 Node 22.13.0：380 个测试文件通过、11 个跳过，5519 项测试通过、103 项跳过；类型与版本、生产／测试 Lint、WebUI 构建及 Lint、翻译、文档、Shell 语法和 tarball 安装冒烟通过，总耗时 2 分 46.6 秒。
- 门禁日志：`/tmp/codexc-module-lightweight-commit-next.log`，仅为当前环境临时日志；Windows 实机、远程 CI 及既有 Socket 路径替换问题仍不在已完成结果内。

## M18：提交后继续审查其他 IPC 宿主（搁置扩展）

目标是核对 M17 能否继续减少独立生命周期实现，不以 Socket、timer 或 JSON 等相似代码形态作为合并依据。

| 链路 | 关联业务边界 | 结论 |
| --- | --- | --- |
| WebUI 投递管理 → requestDeliveryResolution → Gateway 在线处置；仅未发送时进入 DeliveryJournal maintenance | null 明确表示未发出命令，允许尝试离线维护；发送后断开必须是 unconfirmed，禁止再次处置 | 不直接改用只返回通用失败的请求函数 |
| WebUI／重置券入口 → requestGatewayAccountOperation → GatewayAccountRefreshServer → 刷新或重置券执行 | 20 秒截止、512 KiB 回应、EOF 完成边界、AbortSignal 原因，以及 invalid_response／gateway_unavailable／受控业务错误分类 | 不通过增加一批模式开关扩大共享请求接口 |
| 服务状态／安装健康确认 → gatewayOwnerIsReady → readGatewayOwnerStatus → GatewayOwner | 服务端连接后主动发送状态，客户端不发业务请求；ready 与持有进程互斥锁是不同状态 | 不把被动状态探测改成请求／响应模型 |

- Delivery 证据：`scripts/webui-management-delivery-route.mjs` 的 resolveDelivery 仅在 result 为 null 时创建 maintenance Journal；`tests/delivery-control.test.ts` 覆盖端点缺失与写入后丢失回应的区别，并确认只执行一次。共享函数若抹掉“是否发送”的证据，将影响实际维护路径，不能为去重放宽。
- 账户刷新证据：`runtime/gateway-account-refresh.mjs` 同时承载刷新与四类重置券操作，客户端按 end 解码响应，服务端绑定断连取消；`tests/gateway-account-refresh.test.ts` 覆盖受控公开错误、调用方取消及关闭取消。只看指标发送的外观会漏掉失败分类与操作取消责任。
- 就绪探测证据：GatewayOwner 在接入时直接 socket.end 状态；`tests/gateway-owner.test.ts` 区分 owner 已活动与 markReady 后就绪，并验证开始关闭后不能重新宣称就绪。
- 改前审查结论：三个候选尚不能在保留当前合同的同时直接复用 M17；本轮保留现状，不添加通用 IPC 框架。后续轻量化转向其他明确重复职责，不继续横向套用请求封装。
- 本轮仅新增分析记录，执行文档与 Diff 检查；上述既有测试已包含在 `0b6365d1` 提交门禁中，不重复执行或将此分析算作新增功能验证。

## M19：Delivery 写入与只读查看共用载荷编解码

- 状态：已提交为 `7da3fe20`，提交全量门禁通过。
- 前置筛选：复核 Coordinator → PersistentSurfaceOutput → 各 Surface deliver → DeliveryReceipt → 检查点写回。现有 Receipt 已共用操作确认，飞书完整内容补发、Telegram 空正文与微信回复窗口仍有必要差异；不新增通用 Outbox，也不合并授权复核、平台确认和本地 acknowledge 的失败域。
- 写入链路：PersistentSurfaceOutput 快照 → DeliveryJournal Worker → SqliteDeliveryJournal.submit → 身份认证数据、AES-GCM 编码 → SQLite；重启验证 metadata proof 并逐条认证读取。
- 查看链路：投递管理 → Delivery 公共只读入口 → queue-reader 私有路径、Schema 与行类型检查 → 读取密钥 → 单条解密或逐条投影。只读查看不启动恢复、不持有写锁，不改变投递状态。
- 改前审查：两侧分别维护相同的 GCM 解密和 `[schemaVersion, id, account, conversation]` 认证数据构造。该格式只有一份持久化合同，可以集中实现；两侧不同的密钥生命周期、行校验、事务和失败策略不能一并移走。
- 优化：增加模块内部 payload-codec，集中既有加密、解密和认证数据构造；写入／恢复和只读查看共用，未通过 index.ts 增加公共出口。Codec 不持有密钥或资源，不新增可选算法、配置或扩展机制。更新 Delivery 文件索引。
- 改后审查：AES-256-GCM、12 字节随机 nonce、UTF-8、认证字段顺序、Schema v1、metadata 的 `delivery-v1`／`metadata` 字符串和 SQL 列全部不变；没有格式升级、数据迁移或用户数据操作。Writer 的 close 清零密钥仍在原处；只读路径继续检查载荷上限与字节类型。单条读取认证失败抛错，批量投影单条失败返回 null，Writer 恢复失败关闭。
- 测试补强：使用 Node 原生加密与写死的 v1 认证数据构造独立夹具，不通过新 Codec 生成，验证写入端恢复与只读端均可读取既有格式；分别篡改 id、account、conversation，验证单条读取拒绝、批量投影为空、Writer 重开失败。
- 验证：npm test 构建最新产物后，delivery-queue-reader、persistent-output、persistent-output-ownership、webui-delivery-management、module-boundaries 共 5 个文件、116 项通过；类型、版本、运行时依赖边界、相关 Lint、文档和 Diff 检查通过。
- 收益与限制：认证格式和解密规则由两份维护入口收敛为一份，Writer 不再内嵌编解码方法；实现总代码净增加 3 行，不宣称体积或性能改善。不改 Coordinator 或平台确认行为，未运行提交全量门禁或操作真实服务。

## M20：剩余模块候选审查与本轮收尾

按 src/README.md 的 18 个一级模块补齐职责与候选链路盘点。以下“保留”表示检查过所列候选后没有确认值得实施的收敛方案，不表示逐行证明整个模块不存在任何缺陷或未来优化。

| 模块 | 本轮核对的链路／责任 | 结论与证据 |
| --- | --- | --- |
| application | ConversationService、Queue、Revert 的会话锁；列表缓存刷新与代次失效 | 三者已经注入同一 ConversationLockCoordinator。查询缓存的 refresh promise、代次与 rerun 分别处理并发、迟到结果及后续刷新，不合并成第二份会话状态；保留现有边界 |
| approval | Coordinator 的请求归属／决定映射 → InteractionRouter 排队、失效及 Surface 清理 | cancelMatching 已统一批量取消且先撤销整批再推进队列；safeDecline 与 safeInteractionDecision 返回不同层的类型，不能因都表示拒绝而合并；保留 |
| bootstrap | 组合根接线、Provider 重连、绑定恢复与持久输出装配 | 重连处理连接代次与有限重试，绑定恢复处理 Thread 待恢复集合；恢复失败不能重新做已成功握手。M17、M19 已收敛实际重复实现，组合根仍负责具体装配 |
| codex-client | BaseTransport → JsonRpcClient 初始化、pending 请求、Server Request 与通知分流 | Transport 事件分发已共用；pending 响应与反向 Server Request 生命周期不同；不将连接代次、业务缓存合成通用注册器，不改协议或平台 Transport |
| codex-protocol | 锁定版本、受控 index 导出与 generated 类型 | 属于生成合同，排除手工删减／去重；没有新增协议依赖或能力 |
| config | TOML 结构验证 → 运行语义／路径与权限校验 → 安全默认值补齐 | 结构与动态资源校验边界不同，校验成功后才写默认值；Registry 原子替换也需独立保护其输入。不删除安全校验或新增隐式默认回退 |
| conversation-core | Client 稳定事件 → Core 活动状态归约 → TimingAccumulator → 输出总线 | 已将请求统计归约交给专属累加器；恢复观察者用于处理绑定期间开始／结束竞态，不替代长期活动状态；不合并状态寿命不同的集合 |
| delivery | Worker、Coordinator、确认、只读查看和载荷编解码 | M02、M19 完成共享读取生命周期及编解码收敛；M08 保留 Worker 不同超时责任 |
| event-bus | 活动订阅、独立消费者、预算与关闭等待 | M10 去除闲置引用；取消订阅后仍可能有在途消费者，保留 workers 关闭集合 |
| model-api | 原生 Chat／Responses 请求与转换流状态 | 两个原生入口已共用 direct-request 的模型、stream 和思考冲突检查；协议保留与协议转换合同不同，不能将原生未知字段透传改成转换路径的严格拒绝 |
| model-relay | 准入、取消、诊断、指标发送及停止 | M09、M17 完成；M11、M12 保留不同生命周期与确认语义 |
| observability | 指标队列水位 → 批量事务 → 查询与行映射 | M12：落库、IPC 接受与查询水位不能互换；Store 已拆分 schema、查询和行映射，不再增设转发门面 |
| policy | Surface + Account + Actor 授权 → 已配置 Workspace Registry | Telegram 要验证整数 Actor 的规范字符串，飞书／微信是精确字符串；为两份短字符串类新增通用授权基类收益不足。Registry 冻结快照及整体替换保护保留 |
| provider-proxy | 原生转发、指标 IPC、转储流与保留预算 | M07、M17 完成 IPC 职责收敛；M15 保留已有共享流创建层与协议专属轮转／预算 |
| scheduled-tasks | 定时／手动领取 → Store → dispatch → 终态通知归并 | M06 完成共同 INSERT；M14 保留领取和终态竞态差异 |
| session-routing | Workspace 选择、Thread 绑定切换／接管、订阅补偿与存储 | M13、M16 核对完整链路；保留存储失败后的旧订阅恢复以及生命周期并发复核 |
| storage | 最小绑定写入、内存索引与重启恢复 | M16、R02 完成写入收敛和直接持久化回滚断言；不删除内存索引、不改变 Schema |
| surfaces | 平台输入／输出、共享展示、Receipt 与持久确认 | M01、M03、M04 完成；M05 与 M19 前置分析保留转义预算、完整内容确认、空正文及回复窗口差异，不新增通用 Outbox |

补充证据与审查：

- Application：ConversationService 只创建一个 locks 实例并注入 Queue／Revert；forConversations 去重后排序加锁。会话展示缓存用代次拒绝在新 Turn 开始前发出的旧查询结果，pending Promise 不能替代代次。
- Approval：interaction-router 测试覆盖整批取消后才推进、迟到同 ID 回答不污染替代请求、异步问题不阻塞审批和账号隔离；本次仅核对现有行为，不改变审批决定或上游字段。
- Policy／Config：policy 测试覆盖冻结快照、热替换失败保留旧 Registry、Surface／账号精确匹配与规范 Actor；Config 先完成 runtime 语义检查才调用 materializeGatewayConfigDefaults。二者独立入口承担不同业务不变量。
- Bootstrap／Client：gateway-reconnect-coordinator 测试覆盖恢复失败不重复握手、重复断线不重置预算；json-rpc-connection-errors 覆盖旧 Transport 清理期间失效与并发关闭。各状态集合有明确所有者，本轮未发现可移除的完整重复状态层。
- Model API：chat-request 与 responses-request 都实际调用 validateDirectModel、validateDirectStream、assertNoNestedReasoningControls；不为已有共享能力再建统一协议解释器。
- Delivery 改后复审：与 HEAD 的私有 aad／encrypt／decrypt 函数体规范空白并把 this.key 对应为参数 key 后，三个实现体一致；随机 nonce、metadata proof 和密钥清零位置未改变。沿用 M19 的 116 项检查结果，不因只读审查重复执行。
- 非生成源码的连续重复片段扫描仅用于发现候选；命中 Surface handle 中的相似片段后，结合完整 deliver 链路确认既有 Receipt 与平台差异。扫描未命中不作为“无重复实现”的证明。

本轮完成状态：

- 18 个一级模块均有上述候选审查结论；已确认有收益的 M01—M19 实施项均已完成开发、改后审查及记录范围内的验证，没有保留“确认应做但尚未实现”的轻量化项。
- M19 及后续分析记录已提交为 `7da3fe20`；其余本批实现见 `2683d70a`、`0b6365d1`。最新生产代码已通过 `7da3fe20` 的正常提交全量门禁，包含 M19 的新增覆盖。
- 本轮没有变更 RPC、授权语义、持久化格式、平台交互或服务状态；不开展协议升级、部署与发布。不把“所有候选已有处理结论”扩张为“项目不存在其他优化或缺陷”。
- M07 的 Unix Socket 路径替换是已复现的独立基线缺陷，仍未修复，不列为轻量化完成成果；Windows 实机和远程 CI 未执行。
- 最终文档与索引、Diff 格式检查通过；后续有新证据时另开候选，继续沿用分析、改前审查、优化、改后审查修复、验证的流程，不把本次盘点作为批量改动未分析实现的授权。

## 第三批审查与提交结果

- 提交：`7da3fe20`，改动：统一 Delivery 载荷编解码并补齐模块审查记录；6 个文件，新增 148 行、删除 31 行。提交后工作区干净，未推送。
- 正常 pre-commit 全量门禁一次通过，使用 Node 22.13.0：380 个测试文件通过、11 个跳过，5523 项测试通过、103 项跳过；类型与版本、生产／测试 Lint、WebUI 构建及 Lint、翻译、文档、Shell 语法和 tarball 安装冒烟通过，总耗时 2 分 45.7 秒。
- 门禁日志：`/tmp/codexc-delivery-codec-commit.log`，仅为当前环境临时日志。此处记录已完成的门禁，取代 M19 开发时点“未运行提交全量门禁”的状态。

## B01：全分支改动审查

### 基线与范围

- 分支：`refactor/lazy-cli-surface-loading`；审查 HEAD 为 `7da3fe20`。
- 比较基线：本地 `main`、`origin/main` 和 merge-base 均为 `9372f9d0a04d247224015a2d381ebd5da1a67f3d`；未联网刷新远端引用。
- 范围：9 个提交，81 个文件，新增 3142 行、删除 2114 行；逐组核对完整差异、调用方、失败／关闭路径、测试与索引。包含此前 CLI 调整，不仅是最新 Delivery 提交，也不同于 M20 的模块候选盘点。
- 本轮只维护审查记录，不修改业务代码、不提交或推送。

### 按链路核对结果

| 提交／模块 | 关联链路与审查重点 | 结论 |
| --- | --- | --- |
| `8fc10aa7`：CLI 与渠道装配 | bin 参数／帮助 → 命令实现；严格运行配置 → owner → 内置插件加载 → 组件图 → Surface；加载失败释放 owner，渠道开关变化仍走既有重启分类 | 仅加载已选命令或已启用渠道；显式注册与插件身份检查保留，不引入动态插件发现。新进程加载隔离测试及安装冒烟覆盖执行入口 |
| `4b327607`：OCG 检测与清理 | provisioning／Setup → 只读旧配置检测；明确旧账户移除 → 清理预览 → 确认、运行占用保护与文件事务 | 逐函数比较确认检测／移除函数体在读取函数更名后保持一致；没有隐式迁移、扩大删除范围或跳过确认 |
| `f0581b73`：完成事件补全 | 持久投递／内存输出 → CompletionOutputEnricher → 统计端口及账户查询 → 投递前授权复核 | 250 ms 共享统计预算、独立 2 秒账户截止与迟到失败处理保留；beginShutdown 禁止新账户查询，stop 取消在途查询；所有投递入口均改为调用新所有者 |
| `862169e5`、`428768e9`：Setup／Config | 菜单选择 → 延迟导入 → 现有处理器；注入回调、返回菜单、配置重读、取消、加载失败与子进程信号 | 默认处理器仍被等待，注入优先；路径／帮助查询无额外配置读取。新测试覆盖选中路径、错误恢复及不应加载的依赖 |
| `e93e0c9a`：CLP 管理 | CLI 菜单与 WebUI → 同一账户管理模块 → 私有配置事务 | 原 12 个顶层函数在拆分后实现一致；导入与声明同步迁移，WebUI 不再依赖 CLP 终端菜单；新模块列入包清单和 tarball 冒烟 |
| `2683d70a`：Surface 展示 | 飞书 Adapter → 命令中心展示；Telegram 普通结果 → 共享分派 → 原 HTML 分块发送；Provider 文案辅助函数 | 飞书 Adapter 类保持一致，展示提取不移动命令执行或令牌所有权；Telegram 移除的 20 个分支与共享格式化调用一致，专属按钮等分支保留。Provider 前缀裁剪保留渠道有效输入行为 |
| `2683d70a`、`0b6365d1`：存储与事件 | Delivery 列表 → 只读连接；定时／手动领取 → Run INSERT；选择／切换／接管 → Workspace UPSERT；订阅取消 → workers 关闭等待；Relay lease → 取消／释放 | 共用实现留在原事务内，数据库写入后再更新内存；直接 SQL 回滚断言避免恢复逻辑掩盖损坏。仅去除未读取的引用和值，关闭集合及身份校验仍保留 |
| `2683d70a`、`0b6365d1`：指标与控制 IPC | Provider 指标监听 → PrivateIpcServer；Relay 指标／控制 → 单次 JSON 请求 → 各调用方校验确认 | 私有权限保护收紧；启动失败可清理后重试，显式关闭为终态。请求有字节上限、截止、取消与统一清理，不重试；控制版本、请求 ID、digest 与状态字段校验仍在调用方。保留 M07 基线缺陷 |
| `7da3fe20`：Delivery 编解码 | Writer 写入／恢复与只读单条／批量查询 → 共用 Codec | 算法、nonce 长度、AAD 顺序、metadata proof、Schema 与密钥清理不变；v1 独立夹具及三类身份篡改覆盖两侧读取，未引入存储升级 |
| 全分支配套文件 | 模块出口与声明 → 调用方与测试；package files → 安装产物；目录 README → 文档索引 | 新文件有所属索引，旧导入已调整，没有发现此次移动造成的孤立入口；根 README 的用户命令与安装入口无需因内部拆分扩写 |

### 审查结论与未解决项

- 未发现本分支新增、需要阻断交付的代码问题。R01 的启动失败清理回归及 R02 的持久化断言盲区已在此前提交修复，本次复核保持有效。
- 发现记录状态滞后：M19／M20 仍写“尚未提交”和全量门禁未执行。本轮已补录 `7da3fe20` 与准确门禁结果，更新当前状态；各条开发阶段定向验证保留为历史证据。
- 方向核对：此前 CLI 按需加载与后续模块职责收敛分别记录。后续改动确实覆盖 Bootstrap、Surfaces、Delivery、Storage、Scheduled Tasks、Provider Proxy、Relay 和 Event Bus；收益是减少重复维护和不必要依赖。总代码净增加不能表述为包体积缩小，也没有新的性能测量结论。
- **仍未解决：M07 Unix Socket 路径替换缺陷。** 监听期间重命名原 Socket、在原路径创建替代文件后，Node/libuv 关闭监听可能先删除替代路径，应用层 inode 检查不能阻止它；原实现已复现同样结果。模块 README 中“只清理自己创建的端点”不能作为该竞争场景的保证。后续需要单独分析共享 IPC 全部宿主及关闭合同，不能在本次记录维护中声称已修复。
- 本地验证证据绑定 `7da3fe20`：沿用其已经通过的完整提交门禁；本轮未改业务代码，因此不重复全套测试。本轮 `npm run docs:check` 通过（75 个 Markdown 文件，索引与本地链接一致），`git diff --check` 通过。
- 验证边界：跳过的 103 项测试不算通过；本轮未做真实飞书／Telegram／微信联调、Windows 实机验收或远程 CI。结论是上述分支差异审查完成，不是整个项目无缺陷或所有平台已验收。

## S01：共享 IPC 公开端点关闭保护

### 链路分析与改前审查

- 目标：修复 M07 已复现的公开路径替换后误删问题，以资源所有权和可验证可靠性为收益，不计为减行或性能优化。
- 根因：项目验证使用的 Node 22.13.0 所带 [libuv `uv__pipe_close`](https://github.com/nodejs/node/blob/v22.13.0/deps/uv/src/unix/pipe.c#L165-L179) 在关闭时直接 unlink 绑定路径，不做 inode 比较；共享层等 close 完成后才检查 inode，已无法阻止该删除。Node 的[IPC 文档](https://nodejs.org/download/release/v22.13.0/docs/api/net.html#ipc-support)也说明自行创建的 Unix Socket 由关闭逻辑移除。
- 复核实验：从 `7da3fe20` 导出原 PrivateIpcServer 到隔离目录，与工作区修复版执行相同的“启动 → 重命名 Socket → 原路径写入普通文件 → close”。原版 `replacementSurvives: false`，修复版为 `true`；没有操作用户真实服务。

| 宿主 | 入口、状态及失败／关闭责任 | 本次影响 |
| --- | --- | --- |
| GatewayOwner | 启动互斥 → ready 状态 → 状态查询；关闭时销毁已接入连接并等待服务端 | 共享 Unix 端点发布与清理受修复，ready 和互斥协议不变 |
| GatewayAccountRefreshServer | 帧解析 → 刷新／重置券处理 → 回应；关闭取消 controller、销毁连接并等待操作 | 只修底层监听端点，业务取消和确认语义不变 |
| DeliveryControlServer | 主控制入口 → 在线处置 → QueueEventsServer；事件入口失败时关闭已启动控制入口 | 主／事件端点均复用共享层，null 与 unconfirmed 的离线切换边界不变 |
| ModelRelayControl | 主控制入口 → apply／status／queue；事件入口启动失败回收主监听 | 两类监听均覆盖，digest、请求 ID 与回应校验不变 |
| QueueEventsServer | 订阅握手 → changed／heartbeat → 有界连接回收 | 共享层关闭，握手计时器与订阅状态仍由原宿主负责 |
| ProviderProxyMetricsServer | 指标归约 → 确认；启动失败清理可重试，显式关闭后拒绝启动 | 直接覆盖原 M07 复现场景，保留 R01 修复 |
| RelayMetricsServer | 有界指标接入 → receive → accepted／rejected；断开取消在途写入等待 | 只修监听端点，容量与确认状态不变 |
| AppServerSupervisorOwner | Windows 使用共享 IPC；Unix 自行 createServer、监听、记录 inode 和关闭 | Windows 行为保留；Unix 独立实现不受本修复覆盖，列为下一项独立分析，不宣称全项目同类问题均已消除 |

- 方案取舍：在共享层增加关闭后的检查不能修复根因；不依赖 Node 私有 handle，不增加原生依赖，不改为 Linux 专属 abstract Socket，也不改变客户端端点格式。
- 实施方案：同目录随机临时名字监听 → chmod 0600 → link 独占发布既有公开路径 → 移除临时名字。libuv 只保存临时绑定名，公开路径交给现有 inode 清理；link 的 EEXIST 作为占用失败，不覆盖竞争者。临时名长度不超过原 basename，碰撞有界重试，实际绑定失败不会触碰竞争端点。

### 改后审查、验证及边界

- 公开路径、Socket 类型、属主／权限校验、客户端连接方式和 JSON 合同不变；没有配置、数据库格式或 RPC 变更。Windows 描述文件与认证流程不变。
- 发布失败关闭临时监听；成功发布只留下公开 Socket。已替换的公开普通文件与新监听均在关闭旧实例后保留；同时发布仅一方成功，失败方清理不删除胜者；残留的公开 Socket 仍走原占用探测和恢复路径。
- 新增 `private-ipc-lifecycle.test.ts` 的 8 项回归：正常发布／清理、替代文件、替代监听、竞争发布、发布失败后重试、硬链接不支持、残留恢复、103 字节且短 basename 的端点。测试直接经过共享层和真实本地 Socket；故障注入仅用于文件发布失败路径。
- Node 22.13.0 下首批 4 文件 31 项通过；后续构建最新产物后 5 文件 60 项通过。两批合计 8 个不同文件、84 个不同用例，覆盖生命周期、请求、Gateway Owner、Provider 指标、账户操作、Delivery 控制、Relay 指标发送与控制／订阅。类型、版本、运行时依赖、改动文件 Lint、文档（75 个 Markdown 文件）与 Diff 格式检查通过。
- 未执行 macOS／Windows 实机及远程 CI，不能将 Linux 成功视为 macOS Socket 硬链接验收；不支持该发布方式的文件系统失败关闭，不回退到已知误删路径。可在 macOS 运行 `npm test -- tests/private-ipc-lifecycle.test.ts tests/gateway-owner.test.ts tests/provider-proxy-metrics.test.ts` 验证。
- 限制：进程若在临时绑定与发布清理之间被强制杀死，可能留下随机名字的残留 Socket；不扫描或删除无法证明归属的文件。私有父目录仍是安全前提；本次不声称抵抗同 UID 对任意内部临时名字及 inode 检查窗口的恶意并发替换。
- 下一项：单独审查 Supervisor Unix 所有权实现、Provider 租约及关闭等待，判断是否能复用共享层。涉及共享 App Server 行为的改动需按项目规则追加真实 App Server 合同；本轮未改该实现、Transport、Provider 子进程或服务状态。
- 状态：已实施并完成上述验证，未提交、未推送；记录中旧提交的全量门禁不能作为本轮新增修复的全量验证。

## S02：Supervisor 链路收敛与 IPC 修复收尾

### 链路关联与方案复审

- 范围限定为上述 8 类私有 IPC 宿主的公开端点所有权；检查 `runtime/` 的监听入口后，Supervisor 是剩余自行创建 Unix 监管监听的宿主。Desktop Bridge 使用回环 HTTP，官方 App Server 的 Unix WebSocket 由 Codex 创建，不是这套私有 IPC 协议，均不替换。
- 已核对 `docs/index.md` 的 Provider 生命周期说明、Supervisor 公共声明、Client 入口、生成初始化类型与既有真实合同。本地官方源 HEAD 为锁定的 `b412ff32c417f855c2b2d1581b77058eed87c84b`；本次不改变 Codex RPC、rendezvous 规则或 Transport。
- Supervisor 链路：服务 Runtime 准备端点目录 → Owner 启动 → 私有 inspect／ensure／release／lease → 每 Provider 串行操作 → close 标记关闭、销毁连接、等待在途操作。连接关闭撤销租约，租约存在时拒绝释放；这些业务状态仍归 Supervisor 所有。
- 改前结论：Unix 的监听、探测和清理与共享层承担同一职责，可完整删除重复实现；独立 Unix 分支的底层 close 同样会绕过后置 inode 检查。共享层已具备安全发布、失败清理及有界探测，不再增加另一层封装。
- 复审发现并修复：硬链接可创建超过 Socket 地址长度上限的公开文件，即使临时监听名较短，客户端仍无法连接。因此共享层在监听前拒绝包含 NUL 或达到 104 字节的公开路径，新增 104 字节拒绝测试；103 字节边界仍通过。Supervisor 保留明确的路径长度诊断。

### 实施与改后审查

- Supervisor 全平台使用 PrivateIpcServer，删除独立 Unix listener、stale probe 和 unlink 实现；公开声明及私有协议版本保持不变。启动失败后仍可在同一实例重试，显式关闭后拒绝重新启动该 Owner。
- 原有 `#handleRequest`、Provider 串行队列、租约集合、release 二次复核与在途操作等待保持原样；父目录与旧端点权限统一执行共享层严格校验，未放宽权限。公开端点不变，无配置或数据迁移。
- 新增 Supervisor 回归覆盖：旧路径被替换后关闭不误删、另一 Owner 占用失败后重试、关闭等待在途 Provider 操作。共享层新增过长公开名拒绝覆盖。
- 更新 Runtime 职责说明和 `docs/index.md` 的实现／验证映射。没有修改真实用户服务、账户或会话；不提交、不推送。

### 验证与剩余边界

- Node 22.13.0 定向检查：Supervisor 与共享生命周期共 25 项通过、1 项 macOS 专属用例跳过；随后构建最新产物并检查 12 个相关测试文件，11 个文件、121 项通过、1 项跳过。
- 同批真实 App Server 合同的 5 项在沙盒中全部因官方受保护目录的 `0700` 校验失败而未进入业务验证。锁定源码 `uds/src/daemon_directory.rs` 明确要求 `/tmp/codex-daemon-<uid>` 且该目录由沙盒隐藏，不能通过改变 HOME／TMPDIR 绕开。按环境权限流程在沙盒外运行相同隔离夹具后，5 项全部通过（5.06 秒）；没有修改权限检查或操作现有服务。
- 最终相关验证合计 12 个不同文件、126 项通过、1 项 macOS 专属用例跳过。包含真实主实例与按需 Provider 启动、初始化、通知、租约及释放保护；类型、版本、运行时依赖和改动文件 Lint 通过。路径上限规则只在共享层维护，Supervisor 将明确错误码转换为原有监管路径诊断。
- 文档索引与本地链接检查（75 个 Markdown 文件）和 Diff 格式检查通过。macOS／Windows 实机、远程 CI 和提交全量门禁未执行；S01 的硬链接支持与强制终止残留限制继续适用。
- 本轮完成：8 类私有 IPC 宿主已全部接入修复后的共享监听层，确认的端点误删问题及本次复审发现的长路径问题均已处理。没有遗留待实现的独立 Supervisor 修复项；macOS Socket 硬链接与专属 Desktop 租约需在对应平台验收，不把本地验证扩张为所有平台已验收。未提交、未推送，不继续扩大到无关模块。

## R03：全部未提交改动复审（发现回归，已在 R04 修复）

- 范围：当前 8 个未提交文件，包含新建的共享生命周期测试；对照 `7da3fe20`，核对生产实现、调用链、测试和文档。此前 9 个分支提交的审查沿用 B01，本次重点审查其后的全部工作区差异。
- **P2：提前释放临时绑定名，旧监听仍可能删除后续实例的端点。** `PrivateIpcServer.start` 发布公开硬链接后立即 unlink 临时绑定名，但 libuv 保留该名字直到 close。隔离实验只记录实际绑定名：启动实例 A，使用 A 已释放的临时名作为实例 B 的公开路径，B 正常收发后关闭 A，得到 `secondListening: true`、`secondEndpointSurvives: false`。两个实例均通过正常公共接口启动，没有手工替换内部文件。短 basename 会把随机名字空间缩到一个字符，使同目录复用更易出现；当前测试仅检查原公开路径被替换，没有覆盖已释放绑定名再分配。应保证绑定名在监听存活期间不被重新分配，并补多实例关闭回归；不能把此场景归为同 UID 恶意改写。
- **P2：统一拒绝 104 字节路径导致 Linux 兼容性回归。** 共享层将所有 Unix 平台都限制为至多 103 字节；在 Node 22.13.0/Linux 上，同一 104 字节私有 Socket 路径使用 HEAD 原实现可启动并返回 `{ok:true}`，工作区实现则报长度限制。此限制同样影响原本可用的 Gateway、指标和 Supervisor 端点。应按实际支持的平台地址上限验证，同时防止硬链接绕过内核绑定校验；保留 macOS 的严格夹具边界不能替代 Linux 的兼容性要求。
- 实验在 `/tmp` 私有隔离目录中执行，结束后清理；未改业务代码、未操作真实服务、未提交或推送。本轮只更新本记录及当前状态。
- 既有 126 项通过是其覆盖范围内的有效证据，但未覆盖以上两种场景，不能据此维持 S02 的“本轮完成”交付结论。建议修复后重做对应定向验证；macOS 硬链接与 Windows 实机、远程 CI 的缺项仍保留，不将缺项推断为已确认的平台故障。

## R04：R03 两项回归的链路关联修复

- 改前核对：8 类宿主都通过共享层创建监听，未扫描目录发现端点；各自的操作、租约、确认与取消责任保持在宿主。修复限定在共同的名字生命周期及平台长度校验，不让各宿主另加绕行逻辑。
- 绑定名修复：删除发布成功后立即 unlink 绑定名的步骤，保留同一 Socket 的两个名字直到关闭。第二实例若把该绑定名用作公开端点，会由现有活动探测明确拒绝；原监听关闭后才允许复用，重复关闭旧实例不影响新实例。正常关闭、发布失败和失败后重试均清理对应资源，不新增资源管理器或配置项。
- 路径修复：按 [Node 22.13.0 IPC 合同](https://nodejs.org/download/release/v22.13.0/docs/api/net.html#identifying-paths-for-ipc-connections) 恢复 Linux 的 107 字节边界，macOS 保留 103 字节边界；仍按 UTF-8 字节长度检查并拒绝 NUL。Supervisor 继续复用共享错误码转换诊断，不重复维护上限。
- 回归证据：新增绑定名保留／关闭后复用用例，以及 Linux 104、105、106、107 字节连通用例；修改生产代码前 5 项全部按预期失败。修复后全部通过，另验证平台上限之外的路径拒绝、103 字节短 basename、原公开路径替换、并发发布与失败清理。正常启动测试更新为两个名字、两个硬链接，关闭后目录为空。
- 验证：Node 22.13.0 下共享生命周期／请求、Supervisor、Gateway Owner、Provider 指标共 5 文件 54 项通过、1 项 macOS 专属跳过；服务 Runtime、账户管理生命周期、账户操作、Delivery 控制、Relay 指标及控制共 6 文件 72 项通过；沙盒外隔离的真实 App Server 合同 1 文件 5 项通过。总计 12 个不同文件、131 项通过、1 项跳过；类型、版本、运行时依赖与改动文件 Lint 通过。
- 改后复审：修复同时覆盖正式公开端点和另一个正常实例复用绑定名的场景，不再将后者归入恶意内部修改。没有更改 RPC、私有 IPC 帧、客户端路径、权限规则、Provider 租约、数据库或用户配置；文档当前说明已同步，前述阶段中的“立即移除临时名字／统一 103 字节”不再是当前实现。
- 资源取舍：每个活动 Unix 监听保留两个私有 Socket 名字，正常退出全部清理；强制终止可能留下两个名字，公开端点按原 stale 探测恢复，随机绑定名不凭外观扫描删除。此限制适用于整个监听存活期间，取代 S01 只描述启动短窗口的残留边界；不宣称不存在任何同 UID 恶意目录替换竞争。
- 状态：R03 两项问题已修复并完成上述关联验证，未提交、未推送。macOS 硬链接与专属租约、Windows 实机、远程 CI 和提交全量门禁未执行，不扩大本地验证结论。

## R05：提交前复审

- 复审当前 8 个文件的最终差异，核对共享监听的发布、失败清理、关闭和重试路径，以及 Supervisor 租约和在途操作等待；未发现新的阻断问题。R03 两项回归均有针对性覆盖，既有 131 项关联验证结果继续适用。
- 提交范围仅含 S01／S02／R04 的运行时修复、回归测试及关联文档；无新增依赖、协议字段、配置或存储变更。公开命令未改变，根 README 无需调整。
- 按用户要求进入正常提交，由 pre-commit 执行全量门禁；本节记录提交前审查，不预先声明门禁通过。实际提交及门禁结果以 Git 记录和本次交付为准；不推送。前述 macOS／Windows 实机与远程 CI 缺项继续保留。
