# 计划任务开发设计

本文定义在 Codex Connect Gateway 中实现计划任务的边界与分阶段方案。设计基于
`codex-cli 0.148.0` 固定协议，以及 2026-08-22 可见的 OpenAI Scheduled 文档；本文是实施前合同，
不表示当前 Gateway 已经支持计划任务。

首期功能必须对外称为“Gateway 计划任务（由 App Server 执行）”，不得称为“App Server 原生计划
任务”。App Server 负责 Thread、Turn、工具和运行状态，Gateway 负责调度、任务定义与投递；两者的
事实来源不能混淆。

## 结论

Codex App 的 Scheduled 是宿主产品能力，不是 App Server 中的一组计划任务 RPC。官方当前说明要求
从 ChatGPT Web 或桌面 App 创建和管理 Scheduled；CLI 与 IDE 扩展不提供管理界面。本地项目任务由
桌面 App 在项目目录或隔离 Worktree 中运行，机器和 App 必须保持运行。

固定版 App Server 没有 `automation/create|list|update|delete|run` 等请求，也不保存用户计划任务的
启停状态、下次运行时间、RRULE 或运行目录。`0.148.0` 只提供以下相关能力：

- `thread/start.threadSource` 可以把执行 Thread 标记为字符串 `automation`。
- 实验 `thread/start.dynamicTools` 与 `item/tool/call` 可以让宿主提供计划任务管理工具，但工具调用
  最终仍由宿主执行。
- 实验 `turn/start.additionalContext` 可以注入 `automation_info` 等应用上下文。
- `plugin/read.scheduledTasks` 只返回插件目录中的任务模板摘要，不是用户任务列表或运行状态 API。

因此，Gateway 若要在 Telegram、飞书和微信中提供计划任务，必须拥有一套明确的宿主调度器。首期
只复用稳定的 Thread/Turn 能力和 `threadSource`，不接入实验动态工具或额外上下文。

## 目标与非目标

### 首期目标

1. 允许已授权用户为当前 Conversation 和 Workspace 创建、查看、暂停、恢复、删除并手动运行任务。
2. 每次到期运行强制创建新的后台 Codex Thread，不替换或追加当前前台 Thread。
3. 复用现有 Provider、模型、思考等级、Workspace 权限、后台绑定、Surface 输出和指标链路。
4. Gateway 或 App Server 重启后能够恢复调度，不重复执行结果未知的任务。
5. 只持久化任务定义与最小运行元数据，不复制 App Server Thread 历史或模型输出正文。

### 首期非目标

- 不兼容或导入 ChatGPT/Codex App 已创建的 Scheduled；官方没有公开同步 API。
- 不在同一 Thread 上按计划继续上下文；这需要与活动 Turn、原生 Queue 和会话设置单独设计。
- 不让模型通过自然语言直接创建或修改任务。
- 不接入实验 `dynamicTools`、`item/tool/call` 或 `additionalContext`。
- 不读取 `plugin/read.scheduledTasks` 并自动安装插件任务模板。
- 不实现任意 RFC 5545 RRULE、一次性提醒、日历例外、节假日或分布式多机调度。
- 不把系统 `cron`、systemd timer 或外部 CI 伪装为 Gateway 任务。

## 固定事实来源

- [OpenAI Scheduled 文档](https://learn.chatgpt.com/docs/automations?surface=app)：宿主管理、独立任务与
  Chat 内任务、Worktree、模型、权限和 RRULE 的当前产品行为。
- [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)：App Server 定位、JSON-RPC、
  Thread/Turn 与实验动态工具；官方建议自动化作业或 CI 使用 Codex SDK。
- [`thread.rs`](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server-protocol/src/protocol/v2/thread.rs)：
  `threadSource` 与实验 `dynamicTools`。
- [`turn.rs`](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server-protocol/src/protocol/v2/turn.rs)：
  实验 `additionalContext`。
- [`plugin.rs`](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs)：
  `ScheduledTaskSummary` 及其有限 Schedule 类型。
- [`app-server/README.md`](https://github.com/openai/codex/blob/rust-v0.148.0/codex-rs/app-server/README.md)：
  `dynamicTools` 与 `item/tool/call` 的宿主回调合同。

项目内 `upstream/openai-codex` 必须保持在 `rust-v0.148.0` 的提交
`3ba0f711642a888aec92a611a3f3b2211157ff89`。当前网页文档描述的新产品能力不能反向当作固定版
协议字段。

## 采用方案

### 运行链路

```text
Surface 命令/按钮
    -> Application 授权与任务用例
    -> Scheduled Task Store 保存任务定义
    -> Scheduler 计算 nextRunAt 并领取到期运行
    -> Scheduled Run Executor 强制新建后台 Thread
    -> App Server 执行 Turn
    -> 既有 Core / Surface / Metrics 链路处理过程与完成事件
    -> Store 只保存运行状态、Thread/Turn ID 与脱敏错误
```

Scheduler 是另一种入站适配器，权限不得高于 Surface 用户。它不能直接操作底层 Transport，也不能
绕过 Application、Policy、Session Routing 或 Provider Routing。

### 每次运行都新建 Thread

首期使用独立运行语义：一个计划任务的每次触发都强制 `thread/start`，随后启动一个 Turn。

- 不调用 `SessionRouter.ensure`，避免恢复任意空闲历史 Thread。
- `thread/start` 继续使用 `historyMode: "paginated"`。
- 显式发送 `threadSource: "automation"`，并由 Client 稳定映射该来源。
- 使用任务创建时冻结的 `modelProvider`、模型、思考等级和服务层级；运行前重新校验模型仍可见且
  Provider 可用，不能静默换模型。
- Workspace 权限使用运行时重新读取的当前配置，不复制创建时的旧权限快照。
- 新 Thread 作为当前 Conversation 的后台绑定；不替换前台绑定。完成后沿用现有后台释放逻辑，
  Thread 历史仍由 App Server 保存，用户可显式 `/resume`。

后台绑定仍受每个 Conversation 最多三个的既有上限约束。没有空位时不抢占前台或其他后台任务，
本次运行记为 `skipped_capacity`，并显示在运行记录中。

### 调度范围

首期以固定版插件任务摘要中的四种 Schedule 为能力边界，并补充宿主调度必需的
`anchorAt`：

| 类型 | 必需字段 | 语义 |
| --- | --- | --- |
| `hourly` | `intervalHours`、`anchorAt` | 从确认创建时间开始每 N 小时一次，N 为正整数 |
| `daily` | `time` | 指定时区每天执行 |
| `weekdays` | `time` | 指定时区周一至周五执行 |
| `weekly` | `days`、`time` | 指定时区每周所选日期执行 |

每个任务必须保存有效 IANA 时区，例如 `Asia/Shanghai`。不得静默采用 Gateway 主机时区；创建命令
没有提供时区时必须要求补充。`time` 固定为 `HH:mm`，工作日使用 `MO` 至 `SU`。

`hourly.anchorAt` 是确认创建成功的 UTC 时间，后续 occurrence 始终由上一计划时间增加固定小时数，
不因 DST 改变间隔；固定版插件摘要允许 Hourly 附带可选工作日，但首期明确拒绝该组合。Daily、
Weekdays 和 Weekly 按任务时区计算：不存在的本地时间跳过该次；重复的本地时间只执行第一次。每次
成功计算后持久化 UTC `nextRunAt`，启动恢复时重新校验，不通过字符串比较判断到期。

首期不解析任意 RRULE。若以后对齐 App 的高级 Schedule，应采用经过审查的 RFC 5545 实现，并先
说明新增依赖、迁移与回滚；不能手写一个看似兼容但语义不完整的解析器。

### 到期、停机与重叠

- 同一任务最多一个活动 Run；上一次仍在执行时，新的 occurrence 记为 `skipped_overlap`。
- Gateway 启动时只补跑最近五分钟内最多一个错过的 occurrence；更早的记为 `missed`，不集中补跑。
- 手动 `/schedule run` 产生独立 occurrence，但仍遵守单任务不重叠和后台容量限制。
- 到期顺序按 `scheduledFor`、任务 ID 稳定排序；不同 Conversation 可以并行，同一 Conversation 的
 派发顺序必须稳定。
- Scheduler 停止接收新领取后，等待已进入 `dispatching` 的短临界区完成；已经进入 App Server 的
  Turn 不因 Gateway 关闭而主动停止。

### 不确定写入与重复执行

`thread/start` 和 `turn/start` 都是写请求，超时、断线或进程崩溃后不能盲目重试。任务运行采用以下
持久状态机：

```text
dispatching -> running -> completed | failed | interrupted
      \-> uncertain (blocks later occurrences until an explicit recovery action)
occurrence claim -> missed | skipped_overlap | skipped_capacity | blocked | dispatching
```

领取 occurrence 时先在本地事务中写入唯一 `runId` 和 `dispatching`，再调用 App Server。只有收到
明确响应后才写入 Thread/Turn ID 并进入 `running`。Gateway 在写请求结果未知时把 Run 标记为
`uncertain`，重启后不得自动重试；只有显式解除（`resolveUncertain`）后，未来的 `/schedule retry <runId>`
才能创建新 Run，解除本身不会自动重试。

这种设计选择“结果未知时可能漏跑”而不是“自动重试造成重复命令或外部副作用”。App Server 当前
没有可让 Thread 创建与 Gateway Run 原子提交的幂等键，因此不能宣称 exactly-once。

重启恢复时，`dispatching` 一律收敛为 `uncertain`。已经保存 Thread/Turn ID 的 `running` Run 先按
Provider 恢复后台绑定和订阅，再读取权威 Thread 与分页 Turn 状态：活动 Turn 继续等待；终态 Turn
按官方状态完成 Run；Thread、Turn 或 Provider 无法定位时进入 `uncertain`。不得只凭 Thread 当前
空闲推断 Run 已成功，也不得为补齐完成通知重新启动 Turn。

## 持久化设计

计划任务不能写入现有 StateStore。StateStore 继续只保存 Conversation、Workspace、Thread 和授权
绑定；计划定义使用独立的私有 `scheduled-tasks.sqlite3`，具有独立 Schema 和生命周期。

### Task 最小字段

- `task_id`、`name`、`status`、`created_at`、`updated_at`
- `surface`、`account_id`、`conversation_id`、`actor_id`
- `workspace_id`
- `prompt`
- `schedule_type`、规范化 Schedule 字段、`timezone`、可空 `anchor_at`、`next_run_at`
- `model_provider`、`model`、`reasoning_effort`、`service_tier`

### Run 最小字段

- `run_id`、`task_id`、`scheduled_for`、`state`
- 可空 `thread_id`、`turn_id`
- `dispatch_started_at`、`started_at`、`completed_at`
- 可空的稳定错误分类和有界脱敏错误说明

不得保存模型回答、完整 Item、Diff、Plan、命令参数、审批内容或外部工具结果。`prompt` 是任务定义
不可避免的正文，应在产品文案中明确会持久化；数据库目录权限固定 `0700`、文件固定 `0600`，日志、
错误和指标不得包含 Prompt。实施前必须取得用户对这一新持久化格式的确认。

Schema 首版为 v1，只接受当前版本。后续升级必须由 `codexc update` 在 Gateway 停止后预检、备份并
显式迁移；运行时不隐式补表。删除任务写入不可运行的墓碑并立即清空 Prompt、Schedule 与用户派生
名称，只保留任务 ID、固定删除标记和既有 Run 关联；不删除 App Server Thread。Run 元数据沿用指标库的保留思路，默认最多
保留 90 天和每任务 200 条；`dispatching`、`running` 和 `uncertain` Run 不因清理上限或保留期删除，清理不影响 Thread 历史。
Scheduler 在首次 tick 和之后每 24 小时最多执行一次清理；清理失败通知 `onError`，但不阻塞本次安全调度。

## 授权与无人值守安全

计划任务会在用户不在线时运行，权限边界必须比普通交互更严格：

1. 创建和每次运行都校验 Surface Actor 仍被授权、Conversation 仍存在、Workspace 仍已注册。
2. Actor 撤权、Workspace 删除、Surface 停用或 Provider 删除时自动把任务置为 `blocked`，不改投其他
   Actor、Workspace 或 Provider。
3. 首期只允许 `read-only` 或 `workspace-write`；拒绝 `danger-full-access`。
4. 使用 Workspace 当前权限配置，但 Approval Policy 固定为 `never`；若组织要求或 Permission
   Profile 不能形成无需人工批准的运行环境，则创建或运行失败关闭。
5. 运行中仍出现命令、文件、额外权限、用户输入或 MCP elicitation Server Request 时自动拒绝或
   取消，并把 Run 标记为需要处理；不得等待一个无人值守的渠道交互令牌。
6. 禁止任务执行服务安装、服务停止、App Server 重启、凭据设置和其他现有渠道禁止操作。
7. 任务只能使用创建时当前 Conversation 已选择的 Workspace，不能接受任意绝对路径。

任务创建预览必须显示 Workspace、Provider、模型、思考等级、时区、下一次运行时间、Sandbox、
是否允许网络，以及“任务会在无人值守时执行”。创建和删除使用一次性确认令牌；暂停、恢复和手动
运行仍需最新任务列表快照或完整 ID。

## 公开命令与渠道交互

首期采用确定性命令，不让模型解释日期或自然语言后直接创建任务：

```text
/schedule add hourly <N> <时区> <文本>
/schedule add daily <HH:mm> <时区> <文本>
/schedule add weekdays <HH:mm> <时区> <文本>
/schedule add weekly <MO,TU,...> <HH:mm> <时区> <文本>
/schedule list [页码]
/schedule runs <任务 ID 或列表序号> [页码]
/schedule rename <任务 ID 或列表序号> <名称>
/schedule pause <任务 ID 或列表序号>
/schedule resume <任务 ID 或列表序号>
/schedule run <任务 ID 或列表序号>
/schedule retry <Run ID>
/schedule delete <任务 ID 或列表序号>
/schedule confirm <一次性令牌>
```

`add` 和 `delete` 先返回预览，再由 `confirm` 执行。序号只在当前 Conversation 最近五分钟的列表
快照内有效；任务列表与 Run 列表分别维护快照。Surface 只渲染结构化结果，飞书可以增加对应按钮，
但按钮与文本命令调用同一 Application 用例，不能复制调度逻辑。

新任务名称默认取 Prompt 第一行归一化后的前 40 个字符，用户可用 `rename` 修改；名称不调用模型
生成。`add` 的待确认 Prompt 只存在于五分钟有效的 Application 内存注册表，确认成功后才写入私有
数据库，Gateway 重启后未确认预览自然失效。

完成卡片沿用普通后台 Thread 的模型、Token、费用、耗时和操作统计，并增加任务名、Run ID 与计划
时间。计划任务数据库不重复保存这些指标；WebUI 根据 Run 的 Thread ID 关联现有指标查询。关联失败
只显示“指标不可用”，不回算或复制模型请求。

## 模块落点

### 新增模块

- `src/scheduled-tasks/`：封闭的 Schedule 类型、下次运行计算、SQLite Store、到期领取、状态机和
  生命周期；通过窄端口请求执行，不导入 Surface SDK 或 App Server 协议。
- `src/application/scheduled-task-port.ts`：拥有平台无关的创建预览、确认、列表、启停、手动运行、
  Run 查询和执行结果类型。

新增一级模块前必须同步 `src/README.md` 与 `tests/module-boundaries.test.ts`。依赖方向固定为：

```text
Surface -> Application <- Scheduled Tasks
                         |
                         v
                   Execution Port
                         |
                 Bootstrap / Routing
```

### 现有模块修改

- `codex-client`：只给稳定 `ThreadStartOptions` 增加封闭的 `threadSource: "automation"`，并在
  `thread/start` 原样编码；不导出动态工具或额外上下文类型。
- `session-routing`：增加“强制新建后台 Thread”的窄用例，禁止复用 `ensure` 的空闲 Thread 选择；
  继续执行 Thread 独占和每 Conversation 三后台任务限制。
- `application`：执行 Actor、Workspace、Provider、模型和确认令牌校验；不直接读取 SQLite。
- `bootstrap`：装配 Store、Scheduler 与 Scheduled Run Executor，并按 Thread ID 把完成事件关联回
  Run；创建 Store 位于配置/数据库校验之后，真正启动到期领取必须等 App Server Client、绑定恢复与
  Surface 就绪之后。关闭时先停止领取，再等待派发临界区。
- `conversation-core`：保持不变；计划 Run 不建立第二套 Turn 状态。
- `surfaces`：共享解析、格式化与按钮；不各自实现时区、确认或 Schedule 计算。
- `observability`：不改变请求指标 Schema；只按 Thread ID 复用现有查询。

现有 `storage` 模块不承担计划任务定义，避免把消息正文带入绑定数据库。

## 配置与部署

功能默认关闭，实施时增加严格配置：

```toml
[scheduled_tasks]
enabled = false
```

首期不增加默认时区、默认权限或并发数量配置；任务时区显式保存，安全边界与并发上限固定在实现
合同中。开启后 Scheduler 随 Gateway 运行，Linux systemd linger 可让用户未登录时继续运行；Gateway
未运行期间不会准时触发，只按前述五分钟窗口有限补跑。

关闭功能只停止新领取，不删除数据库、不停止已经进入 App Server 的 Turn。回滚到不认识该配置的
旧版本前，必须先移除 `[scheduled_tasks]` 配置段；私有数据库可以保留并由新版本重新使用。

## 分阶段实施

### PR 1：存储与纯调度域

1. 新模块、Schedule 封闭联合、IANA 时区与 DST 测试。
2. 独立 SQLite Schema v1、权限、严格版本、备份/升级接口。
3. Task/Run 状态机、到期领取、五分钟有限补跑、重叠与容量结果。
4. 只使用假执行端口的时钟和崩溃恢复测试，不连接 App Server 或 Surface。

### PR 2：App Server 执行与路由

1. `threadSource: "automation"` 受控编码和稳定来源映射。
2. 强制新建后台 Thread，不改变前台绑定，不自动重试写请求。
3. Provider/模型/Workspace 当前状态复核，无人值守 Server Request 默认拒绝。
4. Bootstrap 完成 Run 与 Thread 的关联；完成卡片、后台释放和指标继续按 Thread ID 复用现有链路。
5. 真实 App Server 合同覆盖创建、Turn 完成、Gateway 重启恢复、App Server 断线和不确定派发。

### PR 3：命令与三 Surface

1. `/schedule` 规范命令、列表快照、创建/删除确认和 Run 查询。
2. Telegram、飞书、微信统一文案与飞书按钮。
3. `/help`、菜单、根 README、`docs/display.md`、错误字典与渠道验收矩阵同步。
4. 授权撤销、Workspace 删除、Provider 删除和 Surface 停用测试。

### 后续候选，不与首期合并

- 同一聊天上下文计划任务：单独审查 App Server Queue 顺序、活动 Turn、模型设置和停止条件。
- 自然语言管理：只有完成 `dynamicTools`、`item/tool/call` 的完整实验协议与安全审查后，才允许注册
  `codex_app.automation_update`；该工具只是调用 Application 用例，不获得额外权限。
- 插件任务模板：等待 `plugin/read` 被项目正式采用，再把模板作为创建预览输入；不得自动启用。
- RFC 5545 RRULE、一次性任务、多个 Workspace 和隔离 Worktree：分别设计和验收。
- Codex SDK 执行器：只有需要脱离共享 App Server 或运行 CI/云任务时再评估，不能同时保留两套默认
  执行引擎。

## 验证链路

实施至少覆盖：

- Schedule 解析、非法日期/时区、DST 缺失和重复时间、稳定 nextRunAt。
- SQLite 当前 Schema、文件权限、事务领取、保留清理和升级备份。
- 同任务不重叠、Conversation 后台容量、停机补跑和稳定排序。
- `dispatching` 崩溃恢复为 `uncertain`，所有 App Server 写请求不自动重试。
- Actor/Workspace/Provider/模型重新授权与撤权后的失败关闭。
- 无人值守审批、用户输入、额外权限与 MCP elicitation 全部安全拒绝。
- 前台 Thread 不变、计划 Thread 独占、后台完成释放、重启订阅恢复和多 Provider 路由。
- 三 Surface 命令、确认、按钮令牌、输出顺序、超时隔离和敏感信息清洗。
- 真实锁定版 App Server 合同使用临时 `CODEX_HOME` 和 Mock Responses，不调用真实账户或模型。

每个 PR 先运行改动直接相关的定向测试、`npm run check`、`npm run lint` 和 `npm run docs:check`；提交
门禁由 pre-commit 统一运行 `npm run verify:commit`。协议或真实 App Server 行为变化必须保留条件式
真实合同，未设置合同环境而跳过时不能报告为通过。

## 完成标准与停止条件

只有同时满足以下条件才能宣布计划任务可用：

- Gateway 重启不会丢任务，也不会自动重试结果未知的 App Server 写请求。
- 前台 Conversation 不被计划任务抢占，Thread 仍保持唯一外部 Conversation 归属。
- 无人值守运行无法扩大 Sandbox、Workspace、Actor、Provider 或工具权限。
- Task Store 不保存模型输出或 App Server 历史，Prompt 不进入日志、错误或指标。
- 三 Surface、WebUI 关联、CLI Doctor、升级、备份和卸载说明一致。
- 条件式真实 App Server 合同及部署验收实际通过。

遇到以下任一情况必须停止实施并重新审查：

- 为保证调度需要读取或修改 Codex 内部会话文件。
- 需要让 Scheduler 直接操作 Transport、Surface SDK 或 Provider 私有进程。
- 无法让结果未知的派发进入 `uncertain`，只能依靠自动重试规避。
- 必须持久化模型回答、审批正文、工具输出或完整 Thread 历史才能恢复。
- 固定版 App Server 不接受 `threadSource: "automation"`，或后台 Thread 与 Remote TUI 共享出现冲突。
- 首期必须依赖实验 `dynamicTools`、`additionalContext` 或 `item/tool/call` 才能工作。
- 第三方 Provider 的 Thread/Turn 合同与 OpenAI 主实例不一致且无法失败关闭。
