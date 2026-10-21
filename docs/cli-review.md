# CLI 逐项审查记录

## 范围与状态

本记录按“审查记录→逐批修复→子代理复查→关联修正→本地提交”的顺序推进。范围是 `codexc` 的命令结构、文案、执行逻辑、聚合与拆分、重复实现和用户流程。前两轮仅修改审查记录及索引；用户现已授权按六批实施并逐批本地提交，不包含远程推送、操作真实用户服务/配置或外部发送。历史审查结论保留原基线，当前修复进度及证据以文末执行记录为准。

基线：`ea9afe5b441d316e3390b1512764ed8e94a4f948`，2026-10-20；开始时工作区无已有改动。以下源码结论针对该基线，不代表安装中的全局命令。第一轮按四批覆盖 C01–C16 的 CLI 结构、编排及相关管理合同，并完成 Astra 独立复审和主代理证据核对。状态更正：第一轮完成不等于所有子流程已深入审完；此前“审查分析完成”的表述过宽。第二轮现已完成 D01–D05 补查、四个 Sol 分工报告整合和 Astra 对四项重点发现的独立核验，累计 25 条确认发现，均未实施修正。各批明确底层/平台及运行观察限制；完成的是所列 CLI 流程与共享合同审查，不是所有底层实现、全仓库或上游协议审计。

每项依次记录：用户意图与合同 → 入口及最终消费路径 → 正常、取消、失败与非交互流程 → 文案与反馈 → 重复/聚合/拆分判断 → 证据、影响、建议与未观察范围。问题区分为已确认不一致、设计建议、待核实风险；建议不等于实施决策。

## 审查顺序与覆盖

以下 C01–C16 状态描述第一轮覆盖。第二轮分别补查 Provider/渠道接入、Config/MCP/技能、Desktop/跨平台服务、更新卸载及数据维护、模型管理/能力探测与 OCG 最后账户恢复，由主代理汇总各批证据。报告已收齐并定向核对；具体覆盖和保留边界见 D01–D05。

| 编号 | 对象 | 本轮状态与下一步 |
| --- | --- | --- |
| C01 | 顶层分类与无参数入口 | 已查入口及主菜单分派；见下文 |
| C02 | 帮助、文案、错误与耗时 | 主审完成；共享呈现及各批领域反馈，未全面审计所有敏感信息路径 |
| C03 | 查询与清理命令收敛 | 主审完成；公开路由及 C11 维护编排 |
| C04 | `init`、`setup`、`config`、`timezone` | 第一批完成；确认快照及结构化结果问题 |
| C05 | `work` | 第一批完成；注册/默认/移除及通知队列边界 |
| C06 | `provider` 及各账户子命令 | 第二批完成；第四批排除 OCG 可疑分支 |
| C07 | `remote`、`app` | 第二批完成；选择、租约与启动结果边界 |
| C08 | `run`、服务启停/重启/重载/安装/卸载、`status`、`logs` | 第二批完成；目标、顺序、恢复和就绪合同 |
| C09 | `doctor`、`security` | 第二批完成；诊断/修复及呈现分工 |
| C10 | `metrics`、`traffic` | 第三批完成；查询、导出、跟随及文件边界 |
| C11 | `cleanup` 三类维护 | 第三批完成；确认、停服、备份及结果核验 |
| C12 | `delivery`、`channel` | 第三批完成；离线副作用、提交与发送边界 |
| C13 | `relay`、`webui` | 第三批完成；配置/进程与参数语义 |
| C14 | `reset-credit` | 第三批完成；预览、消费及未知结果 |
| C15 | `version`、`update`、程序 `uninstall` | 第四批完成；身份、预检、切换及恢复 |
| C16 | 跨入口收敛复核 | 第四批完成；共享管理层与呈现边界 |

公共命令来自 [顶层入口](../bin/codexc.mjs) 的帮助与分派；内部 `gateway`、`service-app-server`、`service-model-relay` 只作为后续生命周期调用链检查，不列为用户命令。聊天渠道斜杠命令不在本轮独立审查范围，仅在共享业务合同需要时追踪。

## C01：顶层分类与菜单流程

证据：`bin/codexc.mjs:77` 的 `helpText.main`、`:286` 的入口判断、`:307` 的 `executeCommand`；[cli-menu.mjs](../scripts/cli-menu.mjs) 的 `runCliMenu`、`runLaunchMenu`、`runToolGroup`、`runServiceMenu`；[使用入口](../README.md)。

- 顶层帮助与菜单均分为运行与连接、工作区、日常设置、接入与账户、状态与服务、数据与维护、程序维护。分类已基本收敛，不建议再增加一层覆盖全部命令的命名空间。
- stdin/stdout 同为 TTY 时，无参数打开菜单；否则显示帮助。菜单通过注入的 `runCommand` 回到同一 `executeCommand`，没有另写一套顶层执行逻辑。
- 主菜单及已读的运行、工具、服务菜单用循环保留选择；普通错误回到菜单，取消返回上层；`reportMenuError` 重新抛出转发信号和 130/143。这里是源码判断，未实际操作 TTY 或发送信号，也未覆盖所有领域菜单。
- 帮助和菜单不必逐项一一对应：菜单允许提供常用任务快捷入口，命令提供完整能力。例如重置券菜单明确只查询，服务菜单明确选择目标。不能仅因入口数量不同就判定功能缺失。

**C01-F01，已确认文案不一致，低优先级。** `README.md:52` 的示例标注“主菜单 → 后台服务”，实际菜单标签是“状态与服务”（`scripts/cli-menu.mjs:21`）。用户按文字找入口时需要自行对应。建议后续文案修正为真实标签；不需要改菜单结构。

**C01-D01，结构建议，尚未决策。** 顶层帮助分类与菜单分类各自维护。可考虑只共享稳定的分类名、短描述及规范命令路径；菜单的条件显示、确认和交互编排仍归菜单。没有证据支持把全部参数解析、平台分支和领域执行合成通用命令框架。领域审查后的取舍见 C16。

## C02：帮助、文案与职责拆分

证据：[cli-help.mjs](../scripts/cli-help.mjs) 的 `isCommandHelp`；`bin/codexc.mjs:1052` 的 `showRequestedHelp`、`:1060` 的 `showSubcommandHelp`；[cli-command-usage.mjs](../scripts/cli-command-usage.mjs)；[cli-presentation.mjs](../runtime/cli-presentation.mjs)。

- 一部分帮助已独立为纯数据，另一部分仍位于 `bin/codexc.mjs`。帮助路径有共享精确匹配器和本地一层/两层判断；它们行为范围不同，不能直接认定可互换。
- 普通操作使用 `[成功]/[失败]/[提示]/[处理]`，Doctor 项目使用 `[通过]`；这是有意区分检查结果与操作结果，不建议统一成一个标签。
- 默认失败输出 stderr，其他操作消息默认 stdout；命令总耗时在 `finally` 显式输出 stderr。该约束有助于保护机器输出，但未逐项验证 JSON/JSONL/CSV 的生产链。
- 普通子进程失败和信号已报告时，顶层避免重复打印错误；后续须继续核对具体子进程是否确实提供了足够诊断，不能仅凭顶层去重认定所有错误可理解。

**C02-D01，拆分建议，非已确认缺陷。** `bin/codexc.mjs` 同时保存大量帮助、命令分派、进程控制和指标导出文件处理。可优先评估将剩余纯帮助数据移到已有帮助模块，将指标导出编排放回指标领域，保留顶层分派及公共执行包装。理由是职责和变更归属，不是文件行数。导出文件创建/失败删除/取消、stdout 与退出码合同已在 C10 补查；后续拆分须保留这些行为，不能只搬函数。

**C02-D02，文案建议。** `metrics` 一级帮助展开多条完整参数长行，实际错误也输出整段；用户定位“命令用错了”要阅读大量筛选参数。建议一级帮助只列任务及简短用法，把完整筛选项留给各子命令帮助；错误先指出非法命令/参数，再给精确帮助路径。须保留现有选项能力，不把缩短文案误做删功能。

## C03：查询与清理的收敛

链路：`bin/codexc.mjs:514` 的 `cleanup` 按 sessions/traffic/metrics 分派；traffic 解析后调用维护脚本，metrics 经 `metricsMaintenance` 转成底层 `cleanup/reset/prune` 动作。`:544` 的 `traffic` 拒绝旧 cleanup 路径，`:830` 的 `metrics` 拒绝 reset/cleanup/prune。菜单的清理入口同样进入 `cleanup`，再复用各领域维护入口。

**C03-F01，已确认合同文档过期，中优先级。** [bin/README.md](../bin/README.md) 的 `metrics` 段称“直接维护子命令保留”，`traffic` 段仍说明 `traffic cleanup`。公开入口已经拒绝这些命令；使用旧说明会得到退出码 1，不能到达维护能力。当前有效入口是 `cleanup metrics` 与 `cleanup traffic`。

建议后续修正模块说明并核对相关引用，保留公开入口的显式拒绝；不新增兼容别名。底层脚本仍使用领域动作是内部执行合同，不等于旧公开 CLI 仍受支持，也不能为了名称统一直接删除底层分支。维护执行、停止条件及数据恢复已在 C11 补查。

实际观察（本工作树，`node bin/codexc.mjs …`，仅帮助与无效路径）：

| 输入 | 退出码 | 实际输出要点 |
| --- | --- | --- |
| `cleanup traffic --help` | 0 | `用法：codexc cleanup traffic [--dir 目录] [--confirm]`；说明默认预览及停止要求 |
| `traffic cleanup --help` | 1 | `[失败] 用法：codexc traffic …`；末尾指向 `codexc cleanup traffic -h` |
| `metrics cleanup --help` | 1 | `[失败] 用法：codexc metrics`；列出 `codexc cleanup metrics …` 维护入口 |

这些观察仅确认公开路由和帮助，不证明清理、备份、停止或恢复成功。没有实际执行任何维护操作。

## 收敛原则与后续记录

1. 先确认业务语义相同，再合并重复；不同权限、服务生命周期、确认或恢复语义保留各自边界。
2. 聚合优先面向用户任务：查询归领域、破坏性维护集中到清理入口；共享底层能力不要求共享全部交互流程。
3. 拆分优先按职责：纯帮助、参数解析、交互编排、领域执行、呈现、进程生命周期分别确认归属，不按文件大小拆文件。
4. 每个问题需带触发、影响、源码位置和关联路径；未读到最终消费位置时显式保持“待查”，不作全链路正确性结论。

以下按批次追加；发现均未修复。

## 第一批：C04–C05，初始化、设置与工作区

### 已查链路与判断

- `bin/codexc.mjs initialize/runSetup` → [init-wizard.mjs](../scripts/init-wizard.mjs) / [setup.mjs](../scripts/setup.mjs) / [config.mjs](../scripts/config.mjs)：初始化负责目录与配置，再选择接入、偏好、可选功能、服务安装；Setup 负责接入，Config 负责日常设置。三者复用领域入口，重叠入口本身有用户价值，无需合成一个长向导。
- Setup 非交互检查在实际接入前进行；`--jsonl` 仍要求 stdin/stderr 为终端。公开 Setup/Config 使用持续菜单模式，失败不会自动重试；初始化取消明确保留已经应用的设置。初始化末尾区分核心安装与 WebUI 启动失败。
- [timezone-command.mjs](../scripts/timezone-command.mjs) → [config-management.mjs](../scripts/config-management.mjs) → [gateway-config.mjs](../runtime/gateway-config.mjs)：参数拒绝重复及互斥组合，IANA 名称检查，使用读取时 revision；共享写入器在锁内核对原文并原子写入。Config 的时区选项调用同一入口，WebUI Gateway 设置路由也调用 `updateGatewaySetting`，没有必要再造时区写入层。
- 消费端：`src/config/index.ts` 将 Gateway 的独立时区/跟随/系统三种语义分开，`scripts/webui-server.mjs applyConfiguredTimezone` 使用 `codex.timezone`；设置模块将服务时区激活标为 App Server/Gateway/WebUI 重启。不能把已保存的值描述为运行中进程已切换。
- [workspace-command.mjs](../scripts/workspace-command.mjs) → [workspace-config.mjs](../scripts/workspace-config.mjs)：注册与新建分开；移除只删除注册，固定默认项受保护，删除当前默认时回退；通知队列预读后提交配置，提交后队列清理失败明确提示“配置已保存，勿重复”。`work` 设置默认复用 Config 的 `runDefaultWorkspace`，后者使用 revision。没有发现需要为相同默认项另建业务实现的理由。

### 发现与建议

**C04-F01，已确认确认快照缺口，中优先级。** `init-wizard.mjs configureOptionalFeatures` 从传入 `document` 展示 WebUI/转储状态并等待多个确认，但写入时使用 `loadSettings(environment).revision`，不是显示状态时的 revision。若另一入口在用户等待期间修改这些配置，向导用新 revision 提交旧选择，绕开过期确认检测；反过来，旧值相等时跳过写入，也可能不满足用户刚确认的选择。底层锁只保护本次读取到写入，不能修复确认窗口。建议在展示前获取同一快照，确认后验证；批量操作须区分自己的前一步写入与外部变更，冲突后重新展示，不直接刷新 revision。涉及 WebUI enabled 和转储开关，Relay 自己的交互事务不应无条件一起改写。

**C04-F02，已确认结果信息缺失，低优先级。** `timezone-command.mjs runTimezoneCommand` 的 `--json` 写入分支只输出 timezone/configPath，并提前返回；普通文本分支才输出 `activationResult`。脚本无法从结构化结果区分无变化、已保存待重启或具体重启范围。建议 JSON 结果保留共享模块的 activation 信息与操作状态；不把 `--json` 改成隐式重启。

**C05-F01，已确认交互目标快照缺口，中优先级。** `removeWorkspaceInteractively` 先展示 ID、名称和路径，等待选择后只把 ID 传给 `removeWorkspaceFromConfig`；后者重新读取当前配置，没有核对展示时的 revision 或完整目标。另一管理进程若将相同 ID 改绑到不同目录，旧选择会移除新注册。写入锁不能识别这一确认窗口。建议携带展示快照或目标指纹，执行前复核；直接 `work remove <id>` 与交互确认的合同不同，不需强行增加同样的提示。

**C05-D01，文档职责建议。** `bin/README.md` 仍将 `work` 描述为进入“权限菜单”，实际菜单是列出/默认/注册/新建/移除；应在后续文案批次同步准确入口，不增加并不存在的权限菜单。

覆盖限制：已追踪这些管理入口、配置写入和时区消费合同；没有实际保存用户设置、创建/移除工作区或操作渠道接入。Setup 下的平台认证细节、MCP/技能安装内部算法与全部 Codex 偏好字段不作协议级审计；本任务在这些子流程覆盖入口归属、返回与反馈，具体第三方语义保持其专题合同。

## 第二批：C06–C09，Provider、连接、服务与诊断

### C06：Provider 与账户

链路：顶层 `provider` → [primary-provider-cli.mjs](../scripts/primary-provider-cli.mjs) → [primary-provider-management.mjs](../scripts/primary-provider-management.mjs) → 配置事务；受管账户分别进入 DS/OCG/CCG Setup 和所属管理模块。自定义主 Provider 的预览在执行时重建并比较；受管账户移除携带展示前的 revision。Setup 的账户/模型编辑比直接 CLI 更丰富，CLP 只经 Setup 提供接入；这种能力不对称不能仅按命令数量判为遗漏。

- `release` 对外表示释放实例，OCG 内部映射 `stop`，并说明后续可重启；不应与删除账户合并。
- 自定义 `switch` 默认确认、`--yes` 明确跳过；直接 `remove` 不确认，菜单 remove 确认。当前帮助没有承诺直接 remove 会询问，因此先记为交互一致性建议，不能称为绕过既有确认合同。建议统一说明哪些命令执行即授权、哪些必须交互；如改变合同，需同步脚本调用方。
- 自定义 Provider 切换、删除的备份/凭据清理失败被单独提示，没有把已提交配置误报为完全未写入。受管账户删最后一项可能恢复安装前配置，OCG 提示使用预览效果区分这一情况，应保留此领域差异。

**C06-R01，初查疑点，已排除。** `opencode-go-setup.mjs runOpencodeGoAccountCli` 的 add 分支无条件输出“账户已添加”，而 `addOpencodeGoAccount` 在主配置确认被拒绝时可返回 `action: cancelled`。后续追踪确认该返回在公开 add 下不可达，详见第四批复核结论；保留调查过程，不列缺陷。

### C07：TUI 与 Desktop

链路：[codex-remote-options.mjs](../scripts/codex-remote-options.mjs) → [codex-remote.mjs](../scripts/codex-remote.mjs) → Provider 解析、监管租约、原生 TUI；[desktop-app-command.mjs](../scripts/desktop-app-command.mjs) → 平台检查、配置事务、共享入口与临时租约。

- Remote 拒绝改写远端地址的参数，Workspace 与 cwd 互斥，Provider 与 Profile 选择互斥；选择后的执行阶段再次核对受管 Profile 是否存在。工作区目录选择与原生命令参数透传各有职责，不能把本机 CLI 的目录权限直接类比为外部渠道任意目录输入。
- Remote 的租约在 TUI 结束后 finally 释放，不通过关闭客户端停止共享服务；非受监管主实例分支不获取租约，应继续保留“直接 native remote 无租约保护”的使用说明，不能将所有连接描述为新启动服务。
- Desktop status 不通过桥握手启动已释放实例；open 在首次启用时确认重启影响，平台检查包含完整退出要求。macOS 启动前检查活动 Thread 和原生客户端租约，Windows 使用桥探测；这两条路径不应因相同命令而强行统一实现。
- Desktop 最终文案准确限定“已发送启动请求”，另提示不等于 App 已连接/MCP 已就绪；启用失败进入配置回滚流程，临时租约失败有独立反馈。它可作为其他异步命令成功文案的参考。

### C08：前台与后台服务

链路：`run` → [dev-all.mjs](../scripts/dev-all.mjs) → 监管入口与 Gateway；后台命令 → [service-command.mjs](../scripts/service-command.mjs) → [service-selection.mjs](../scripts/service-selection.mjs)、[service-targets.mjs](../runtime/service-targets.mjs) → 各平台控制器与就绪检测。

- 前台复用要求监管拓扑匹配及 Socket 健康；裸 App Server 或部分占用会拒绝，退出只清理自己持有的子进程集合。不能把 `run` 与 `start` 合为同一生命周期命令。
- 服务名的公开 spelling 与内部标识已有映射；`logs` 默认 gateway，其余通常 all。all 选已安装可选服务，start/restart 再按启用状态筛选；显式单目标和 all 的语义差异是有意合同。
- restart 预检后停止 WebUI/Relay/Gateway/App Server，反向启动并逐项等待就绪；失败报告已完成与未执行步骤，不自动回滚。Gateway、Relay、WebUI 分别有应用就绪检查，不能用服务管理器启动返回替代。
- stop/status/logs/reload/uninstall 使用最小控制环境，配置损坏时仍可恢复；install 复用 `service-install-management`。reload 帮助明确“已通知不代表已应用”。Unix `stop all` 尽量尝试全部目标后汇总，Windows 保持本平台失败处理，不宜为统一循环改变停止保证。

**C08-D01，收敛建议。** 重启的停止目标列表和顺序在 `runRestartCommand` 显式列举，普通启停用 `serviceDefinitions` 排序；当前顺序一致，不是已确认错误。可在需要增加服务时复用同一目标规划器，但必须保留 restart 的完整预检和失败即止、stop all 的尽量收尾差异，不能仅复用一个通用循环。

### C09：诊断与修复

[doctor.mjs](../scripts/doctor.mjs) 经生命周期执行器做配置、私有路径、版本、拓扑与连通性检查，[doctor-output.mjs](../scripts/doctor-output.mjs) 将全部结果转 JSON，文本隐藏通过项并保留领域汇总；失败使退出码非零。`security repair` 则显式进入 Windows 私有文件修复适配器，Unix 只提示无需处理。两者的“只读检查”和“修改 ACL”边界应保留。

**C09-D01，呈现建议。** Doctor 领域总结与普通命令状态已有不同职责；不要用“统一文案”删掉领域上下文或把提示项变成失败。可收敛错误提示的结构为“失败对象/已完成状态/下一步”，但原始日志与机器输出保持原格式。

覆盖限制：本批完成上述 CLI 编排、目标规划、共享管理与呈现边界的源码审查。没有真实切换/删除 Provider、连接 TUI/Desktop、操作服务或修复 ACL；未对所有平台控制器、原生 helper、模型目录转换和上游 RPC 实现作重新审计。macOS/Windows 实机启动、租约竞态和恢复效果仍未观察，不能据此声明跨平台运行验证通过。

## 第三批：C10–C14，指标、维护、投递、Relay 与重置券

### C10：查询和导出

`metrics` 经 [metrics-command-options.mjs](../scripts/metrics-command-options.mjs) 校验后，由生命周期子进程执行 [metrics-database.mjs](../scripts/metrics-database.mjs)，查询经 [metrics-database-access.mjs](../scripts/metrics-database-access.mjs) 调用 Observability 只读 Store 和查询服务；报告使用同一 readSnapshot，缺库及不兼容有明确错误。默认导出路径仅在子进程完成后报告，取消/失败移除本次文件，`--stdout` 的进度写 stderr。CLI 与 WebUI 共享底层指标能力，没必要再合并查询与维护事务。

**C10-F01，已确认文件命名解析重复且不一致，低优先级。** `bin/codexc.mjs metricsPositionalIdentifier` 只跳过 `--range/--group/--format`，但 `parseMetricsTurnsArgs` 允许筛选项在 Thread ID 前，例如 `turns --provider openai <Thread ID>`。实际查询仍使用正确 Thread ID，导出文件名却取 `openai` 为会话标识。建议复用已解析的 threadId 生成文件名，不再扫描原始 argv；影响是结果识别，不是数据库查询错范围。

**C10-F02，已确认私有输出目录边界缺失，中优先级。** `openMetricsExportFile` 对已有 `output/<日期>` 直接 recursive mkdir/chmod，再用拼接路径 open；未使用共享私有目录校验，未拒绝已有路径的符号链接/不可信祖先。若 output 或日期目录被替换为指向其他目录的链接，导出会沿链接写入并 chmod 目标目录。`wx` 只保护最终文件不覆盖，不能证明父目录归属。建议复用 `ensurePrivateDirectorySync` 等现有边界，并检查 Windows 私有 ACL，而不是仅依赖 POSIX mode。未实际构造目录替换或写出数据。

`traffic` 的列表/详情/跟随均经 [traffic-command.mjs](../scripts/traffic-command.mjs) 与 V2 reader；默认摘要，完整正文需显式展开；无目录返回非零。跟随记录已显示终态并在 session 切换后重置集合，信号让循环退出。持续模式的展示去重属于本次运行状态，不是会话权威索引。源文件正文/终端控制字符的全面净化不在本轮已验证范围。

### C11：清理、归档与恢复

[cleanup-menu.mjs](../scripts/cleanup-menu.mjs) → [maintenance-services.mjs](../scripts/maintenance-services.mjs) → 各领域执行入口。公共维护包装先读取全部服务状态，再询问临停，只恢复尝试停止的原运行服务；取消不打断恢复，失败列出恢复命令。数据确认和服务中断确认是两个不同授权范围，不应简单删去一次确认以减少步骤。

- [session-cleanup.mjs](../scripts/session-cleanup.mjs)：App Server 提供会话列表和后代，直接 `--confirm` 仍需 TTY 确认；执行前重读绑定、复核成员快照及 Gateway 已停止；取消后不发新归档，继续核验已发请求。结果区分已核验、部分、失败、未知及跳过，非全部完成返回非零。只清理已确认归档的展示缓存，不以请求成功直接宣布全部归档。
- `metrics-database.mjs` 的 reset/cleanup/prune：使用当前 Schema 和数据库锁，备份采用排他创建，reset 缺库为未变化；Provider prune 使用精确标识并恢复原 Gateway 状态。菜单服务包装和直接维护脚本各承担对应入口的停服合同，虽有类似代码，不可在未保留直接命令语义时删除一层。

**C11-F01，已确认菜单预览与执行未绑定，中优先级。** `cleanup-menu.mjs` 先调用 `runTrafficCleanup([])` 展示范围，确认后经停服包装再调用 `runTrafficCleanup(["--confirm"])`，没有传第一次预览指纹。第二次会重新扫描并立即按新范围删除。用户等待确认/停服期间新增 session 会进入删除集合，虽然第一次预览没有展示它。`traffic-cleanup.mjs` 的 identity 检查只覆盖第二次调用内部的“扫描→停服检查→重扫”，不能覆盖菜单确认窗口。建议菜单传候选指纹或停服后重新展示、重新确认；直接 `--confirm` 的全范围语义另行保留。每项删除前的身份复核和部分取消结果仍有价值，不应因修菜单而删除。

### C12：投递箱与图片提交

[delivery-command.mjs](../scripts/delivery-command.mjs) → `DeliveryJournal` → [sqlite-journal.ts](../src/delivery/sqlite-journal.ts)：独占 Writer Lock 阻止与 Gateway 同时操作，status/list 分页读取且不展示正文，retry/confirm 要求不同的显式标志。retry 是改成待重发，最终消息仍经 Gateway 授权；CLI 不直接重发。

**C12-F01，已确认帮助未充分说明查询写副作用，低优先级。** status/list 构造默认 runtime 模式 Journal；启动会将遗留 `sending` 改为 `uncertain`，并清理中断的渲染暂存。菜单 status hint 已说明会恢复 sending，命令帮助仅称显示/列出，没有同样说明，list 菜单提示也没有。建议先补全所有查询入口文案。独立复审修正：不能直接改用已有 maintenance 模式，`sqlite-journal.ts:141` 不允许该模式执行当前 CLI 所需的 summary/list/read；若以后提供真正只读的查询，应评估现有 reader 能力及恢复/状态投影合同，另做行为决定，不能作为文字修正顺手修改。

图片链路：[channel-send-image.mjs](../scripts/channel-send-image.mjs) 读取现有绑定、严格验证图片、写私有 spool 并原子发布 manifest，再由 [channel-image-spool.ts](../src/bootstrap/channel-image-spool.ts) 消费；多绑定时要求明确 Thread。成功文案是“已提交”，不等于平台已送达。它与持久投递箱的 pending/uncertain 不是同一概念，不宜只因都叫 outbox 而合并。未发送图片或访问平台账号。

### C13：Relay 和 WebUI

[model-relay-command.mjs](../scripts/model-relay-command.mjs) 严格解析命令与模型策略，管理经 [model-relay-management.mjs](../scripts/model-relay-management.mjs) 的事务/配置锁、模型校验、备份后应用。返回区分 saved_and_applied/saved_not_running/saved_unconfirmed，秘密仅在保存后返回；查询调用方只输出白名单字段。监听 Config/CLI 复用 `runRelayListenMenu`；服务进程启停仍走公共服务入口，应保留“配置启用”与“启动进程”的区分。

WebUI 前台参数 → [webui-command-options.mjs](../scripts/webui-command-options.mjs) → `webui-server.mjs resolveWebuiSettings/createWebuiServer`：CLI 只覆盖本次 host/port，不接受命令行 token；非回环要求配置 token，管理路由另做身份/Origin/修订保护。WebUI 设置和运行入口不宜合成一条隐式保存命令。

**C13-D01，一致性建议。** WebUI `--host/--port` 重复时最后值生效，metrics/traffic 同名单值参数拒绝重复。未发现文档承诺所有命令统一拒绝，所以不列为合同缺陷；建议以后统一拒绝重复，避免监听范围因多处拼参静默改变。需同步直接解析器与公开帮助。

### C14：重置券

[reset-credit-command.mjs](../scripts/reset-credit-command.mjs) → Gateway 私有请求 → [openai-reset-credit-service.ts](../src/application/openai-reset-credit-service.ts)：use 在定位用户配置和发请求前要求 TTY；查询、选择、预览、默认拒绝确认、消费依次进行。消费使用一次性 attemptId，应用层重新读取账户与券、检查有效期、串行防重复；发送后失败记为 unknown，不自动重试。额度刷新失败与已消费结果分开，finally 取消预览不声称撤销消费。该流程已有清楚的确认/结果边界，不能套用普通配置的 `--yes` 以追求统一。

覆盖限制：本批是读取源码的 CLI 合同审查；未读用户指标/投递正文、未删除文件或数据库、未归档真实会话、未签发 Relay Key、未消费券。上游归档/消费 RPC 语义沿用既有端口合同，未改变或重新验证上游协议；平台网络、数据库大数据量和信号实机行为未观察。

## 第四批：C15–C16，程序维护与整体收敛

### C15：版本、更新与卸载

`version` 只读当前包元数据；更新/卸载经 [cli-lifecycle-command.mjs](../scripts/cli-lifecycle-command.mjs) 的父子 IPC 传递取消，父进程等待子进程收尾，不用直接杀子进程代替事务取消。

[source-update.mjs](../scripts/source-update.mjs) 的受管更新先核对来源、干净工作树、npm prefix 与服务路径，再解析候选提交；构建及配置/数据库/CLI 合同预检完成后才停服。切换源码前有备份，失败区分切换前/已切换/全局命令未刷新及服务恢复状态；源码已切换但安装未完成时保留服务停止，给出手工恢复步骤。原运行服务集合按配置恢复；npm/本地包路径只同步配套 CLI，不假称更新 Gateway 源码。没有执行更新、下载或包安装。

[source-uninstall.mjs](../scripts/source-uninstall.mjs) 先确认安装身份和精确删除范围，再卸载服务、包和受管源码；删除前再次检查目录/包身份，保留普通工作树和用户数据。菜单会询问是否继续，直接命令代表显式执行，帮助需要准确说明该区别。卸载程序和 `uninstall --services` 共享服务卸载能力但删除范围不同，应保留两个明确入口。

**C15-D01，流程建议。** 主菜单对 update/security/uninstall 的通用“继续？”仅覆盖启动此操作；真正的目标、阶段及恢复信息由领域模块提供。若优化确认，优先将精确卸载范围在最终执行前展示清楚，不要再叠加没有新信息的“确定吗”。更新候选的配套 CLI 安装确认则涉及新增副作用，不能与菜单确认混为一谈。

### C16：跨入口与重复的最终判断

检查了 Gateway Config/时区/默认工作区管理、Provider 默认模型及主 Provider 管理、Relay 监听和服务控制的共享调用链：

| 主题 | 已有公共能力 | 应保留的入口差异 |
| --- | --- | --- |
| Gateway 设置 | `config-management` 校验、revision、写入与 activation | CLI 提示；WebUI 身份、Origin、确认令牌与审计 |
| 默认工作区 | `runDefaultWorkspace` + `updateGatewaySetting` | work 管理注册，Config 管理默认值；不是重复业务 |
| 服务/网关时区 | `runTimezoneCommand` 被 Config 和 init 复用 | WebUI Gateway 写入白名单不开放时区；不能从共享写入器推断网页也可编辑 |
| 受管模型默认值 | `model-provider-default-management` 的 preview/apply | 账户默认模型与同族共享模型思考等级的不同作用域，需在两端明确展示 |
| 主 Provider | `primary-provider-management` 的 preview/apply | CLI 直接执行/TTY 确认与 WebUI 预览令牌 |
| Relay | `model-relay-management`、`runRelayListenMenu` | 监听配置和服务进程生命周期；签发 Key 的一次性秘密展示 |
| 服务 | `service-targets`/`service-selection`/安装管理 | restart 失败即止、stop 的收尾策略、维护按原状态恢复 |

[model-provider-default-setup.mjs](../scripts/model-provider-default-setup.mjs) 已明确展示账户默认模型、共享思考等级及受影响 Profile 范围，确认后传 preview 给管理层；[webui-provider-settings-management.mjs](../scripts/webui-provider-settings-management.mjs) 复用同一管理能力。没有因“同族共享目录”而建议将单账户默认值同步给全部账户。

`config-activation-result` 与 `config-activation-notice` 已区分无变化、下次读取、新会话/TUI、热加载、各服务重启及重装。后续文案应消费这些结果，不在 init 或单命令里重新推导生效方式。菜单返回值虽有 back/cancel/cancelled/undefined 等多种形态，但在已查调用链各有适配；没有证据支持一次性统一全部返回类型。适合按具体错误收敛，避免大面积等价改写。

**C06-R01 复核结论：排除为可达缺陷。** `opencode-go-account-provisioning.mjs buildPlan` 在 add 下拒绝既有账户，公开 add 固定 switching，`writesMainConfig` 仅来自 exclusive 或 previousMode exclusive；该取消分支在当前公开 add 不可达。不保留为缺陷，也不据此增加改动。未来若开放 mode/reconfigure，调用方须处理 cancelled，再输出成功。

### 建议实施次序（仅建议，未实施）

1. 先处理确认快照、文件边界和已提交结果：C04-F01、C05-F01、C10-F02、C11-F01、C11-F02，以及关闭记录的生效误导 C04-F03，保留各自事务及资源归属。
2. 再处理其他结果准确性和帮助合同：C03-F01、C04-F02、C10-F01、C10-F03、C12-F01、C01-F01、C07-F01，以及 work/直接清理确认的过期描述。
3. 最后评估纯结构收敛：帮助数据移出顶层、指标导出回归领域模块、共享稳定菜单元数据；不建万能命令框架，不顺手重写 Provider/服务/存储架构。

覆盖限制：本轮审查完成的对象是公开 CLI、菜单与相关管理能力的职责和数据流；具体平台原生控制、全部配置子项、上游平台认证和网络协议没有做逐行全量审计。未做任何写操作的运行验收。独立复审已补充下列发现；以上结构建议仍没有授权为实现。

## 独立复审

状态：已完成。复审代理 `/root/cli_independent_review` 使用 `gpt-6-astra`、high 推理，一次只读任务；未修改文件，未启动遗留异步任务或进程。主代理已完整读取报告，并针对新增发现和修正核对当前源码；生产基线未变。

复审独立查看完整顶层公开分派和主菜单，向下追踪 init/config/timezone/work、metrics 查询与维护、traffic 清理、delivery、维护取消/服务恢复、Provider 帮助及 OCG 疑点，不只是核验主审列出的发现。它确认原有 9 条发现，补充 4 条问题及 1 条文档澄清，修正 C12 的潜在建议，继续排除 C06-R01。

复审未再次逐行覆盖全部 Provider 登录、MCP/技能安装、Desktop 原生 helper、各系统控制器、重置券上游处理及更新/卸载全部事务；这些保留主审覆盖与已声明限制，不声称经过第二次全量检查。复审未发现阻止结束本轮 CLI 结构、文案、流程和相关管理合同审查的范围缺口。

### 已收到并由主代理核对的补充

**C07-F01，已确认帮助自相矛盾，低优先级。** `bin/codexc.mjs:163` 的 Remote 追加帮助仍推荐配置两个 API Key Provider 后使用 `-p agg/-p sf-agg`，但同一帮助引用的 `CODEX_REMOTE_USAGE` 明确“聚合模式暂时关闭”；`provider-selection.mjs:21` 根据 `aggregateProviderEnabled=false` 拒绝这两个值。用户按帮助操作必然失败。复审代理实际运行 `node bin/codexc.mjs remote -h`，退出码 0，观察到两段矛盾文案，主代理已核对帮助源和拒绝分支。建议删除过期启用指引，收敛到同一规范帮助来源；不要为匹配旧帮助重新开放聚合能力。最终按文案错误定为低优先级。

**C11-F02，已确认提交后的维护结果丢失，中优先级。** `metrics-database.mjs cleanupCompatibleMetricsDatabase` 在 `COMMIT` 后仍执行可失败的 VACUUM/COUNT；失败落入同一 catch，尝试 ROLLBACK 后只抛原错误。`deleteProviderRows` 在 COMMIT 后 VACUUM 也有同样结果丢失。直接 `pruneProviderMetrics` 与 `cleanupMetricsDatabaseWithGatewayRestart` 若数据处理完成、服务恢复失败，同样抛错而丢弃 result；CLI 只在函数返回后打印删除数量和备份路径，因此用户会只见失败，不知道数据已经改变及备份在哪里。菜单外层恢复发生在子命令输出之后，这条恢复失败路径不能与直接入口混为一谈；VACUUM/COUNT 的提交后失败则两者都受影响。建议保留 committed、已删除数量、备份路径和后处理/恢复状态，失败仍非零，但必须报告“数据已提交，后续失败”，不要隐式回滚或重做清理。未制造数据库或服务故障。

**C10-F03，已确认输出选项改变无关环境依赖，低优先级。** `bin/codexc.mjs:920` 的 `--stdout` 查询先调用 `configuredEnvironment`，读取并校验 Codex `.env` 代理；默认导出分支直接使用 process.env，底层只读数据库查询不依赖网络代理。无效或不可读的 `.env` 会使同一查询仅因选择 stdout 而提前失败。主代理指出路径差异，复审独立检查了 `.env` 的显式报错分支。建议为本地查询使用相同最小环境，保留需要网络或服务控制的维护入口自己的环境校验；本次未读取或修改用户 `.env`。

**C04-F03，已确认关闭转储的生效文案误导，中优先级。** `init-wizard.mjs:187–195` 丢弃 `applySetting` 结果，开启时提示重启 App Server 后生效，关闭时仅说“调用详情记录已关闭”。用户对已有运行环境执行 init、关闭记录后跳过安装时，已有 Codex 代理仍按启动快照采集；`config-management.mjs:323–326` 返回 restart-app-server，`app-server-service-runtime.mjs:311` 在创建代理时决定 trafficDump。建议 init 复用共享 activation 呈现，明确“关闭配置已保存，App Server 重启后生效”。Config 中同一设置已输出 activation 提示，须保持一致。Relay 则在配置刷新后对新请求使用新状态（`model-relay-service.mjs:80–90`），不能将 Codex 和 Relay 都说成立即关闭或都要求重启。未实际关闭用户转储或观察运行中记录。

**C11-D02，已确认文档口径不准确，低优先级。** `docs/user-guide.md:704–705` 的“直接命令”表称 prune 输入 ID 并确认、reset 确认后备份；直接命令经 `metricsMaintenance` → 数据库脚本不会再次询问，确认存在于交互菜单。建议区分“交互菜单会确认”和“直接命令即显式执行”，同时限定后文“非交互不会执行清理”为无参数菜单入口；不要把增加所有直接命令的二次确认当成文案修正。

## 第一轮问题清单与证据边界

共 13 条编号发现，另有结构建议及 work/直接清理的文档澄清；全部尚未修复。优先级表示建议处理顺序，不表示发生过用户数据损坏。

| 编号 | 优先级 | 结论 | 主要定位 |
| --- | --- | --- | --- |
| C01-F01 | 低 | README 菜单名过期 | `README.md:52` |
| C03-F01 | 中 | 模块说明仍支持已拒绝的清理路径 | `bin/README.md:54,58` |
| C04-F01 | 中 | init 确认未绑定展示时配置快照 | `scripts/init-wizard.mjs:153,180,190` |
| C04-F02 | 低 | 时区 JSON 写入结果遗漏生效状态 | `scripts/timezone-command.mjs:199` |
| C04-F03 | 中 | init 将关闭配置误报为已停止采集 | `scripts/init-wizard.mjs:187` |
| C05-F01 | 中 | 工作区移除未绑定展示时目标 | `scripts/workspace-command.mjs:294` |
| C07-F01 | 低 | Remote 帮助仍推荐禁用的聚合入口 | `bin/codexc.mjs:163` |
| C10-F01 | 低 | 导出文件名与查询 Thread 解析不一致 | `bin/codexc.mjs:980` |
| C10-F02 | 中 | 导出父目录缺少链接/私有访问校验 | `bin/codexc.mjs:947` |
| C10-F03 | 低 | stdout 查询引入无关代理配置依赖 | `bin/codexc.mjs:920` |
| C11-F01 | 中 | 转储菜单确认与最终候选范围脱节 | `scripts/cleanup-menu.mjs:55,61` |
| C11-F02 | 中 | 已提交指标清理结果在后续失败时丢失 | `scripts/metrics-database.mjs:270,413,198,311` |
| C12-F01 | 低 | 投递查询帮助遗漏启动恢复的写副作用 | `scripts/delivery-command.mjs:33` |

第一轮证据是源码与 4 次真实帮助/拒绝路径观察（初轮 3 次，复审 1 次）；没有实施故障注入、业务写入或平台验收。文档的索引与本地链接由现有 `docs:check` 检查；静态结果不用于证明业务可用。交付只有本记录和 `index.md` 索引，未修改实现、提交 Git、操作服务或写入用户配置。第一轮 C06 疑点已排除、独立复审已完成；第二轮覆盖和新增结论见下文。

## 第二轮：深层子流程补查

### 批次 D01：源码更新、卸载与维护取消

已补读 `source-update.mjs` 的预检、候选构建、源码切换、服务恢复、子进程取消和顶层锁；`source-uninstall.mjs` 的包身份、删除顺序和取消边界；`cli-lifecycle-command.mjs` 的 IPC 取消传递。更新取消进入切换阶段后继续收尾；卸载在当前破坏性操作结束后停止后续步骤。子进程 launcher 等待 close，不能因收到取消就把尚未完成的操作描述为已回滚。卸载在每个 npm 包删除前复核目录身份/来源，删除源码前复核 dev/ino，且 npm 包仍存在时保留源码；这些检查与更新所需的工作树内容保护不是同一合同。

**D01-F01，已确认源码更新保护缺口，高优先级。** `scripts/source-update.mjs:87,620` 只在初始计划检查旧 checkout 的未提交改动和 origin，并在 `:96` 记录 HEAD。之后克隆、构建、合同检查及 CLI 安装存在较长等待；`:292` 附近的再次检查仅核对 npm prefix/服务路径（`inspectSourceInstallation`，`:1115`），没有重查旧工作树内容或 HEAD。`:319` 直接把当时的旧目录移成 backup，成功后 `:355` 递归删除 backup。触发条件是预检通过后、切换前另一个编辑器或 Git 操作修改旧 checkout；更新仍可成功并删除这些后来的修改。顶层 `.source-update` 锁只串行同入口更新，不约束编辑器/Git 写入，不能排除此路径。这里只证明源码可达的丢失路径，没有执行真实更新或制造数据丢失。

建议把旧 checkout 的身份、HEAD、origin 和工作树状态纳入切换前复核，变化则中止；在 backup 清理前再次检查实际备份并保留意外变化，避免把一次预检当作跨构建等待的永久授权。必须同时处理持有旧目录句柄的并发写入和失败恢复说明，不能声称仅增加一次 `git status` 就提供原子保护。对应用户合同是 `docs/source-install.md:121` 的无本地修改前提及备份/恢复语义；保持“不自动覆盖较新状态”的边界。

维护链补查：`traffic-cleanup.mjs` 删除前逐项复核根目录和目标身份，取消报告已删除数量；它仍不能补救 C11-F01 的菜单确认快照遗漏。`session-cleanup.mjs` 已追到跨 Provider 读取、后代枚举、绑定保护、逐组再次检查、归档后权威列表核验和只清理已证实归档的展示缓存；取消会停止后续提交并继续核验已提交请求。未重新执行上游归档或跨平台服务操作；App Server 的实际锁/归档原子性仍限于第一轮注明的源码合同，不作运行验证结论。

额外补查 `codex-remote-options.mjs` → `codex-remote.mjs` → `app-server-supervisor.mjs`：Provider/Profile 与工作目录互斥、规范名称、原生 `--` 字面参数、受管连接覆盖拒绝、执行时选择重查及租约释放均已阅读。租约成功后服务端关闭握手超时，按连接存在维护租约，不依赖 JS 心跳；因此不能仅凭 TUI 使用 `spawnSync` 就判定租约会超时。原生权限参数继续由 Codex 处理，没有发现需要 Gateway 再包一套权限语义的证据。

`traffic-dump-reader.mjs` 补查了 V2 manifest、索引分页、正文分片引用及文件打开：manifest 限 1 MiB，索引单行限 16 MiB，正文文件名/offset/bytes 校验、普通文件和打开前后身份检查均存在；末尾未完成 JSON 可跳过，其他不支持索引版本拒绝。保留文件边界检查，不建议为与 metrics 共用读取器而抹平 SQLite 与追加日志的不同合同。本项为源码审查，没有读取用户实际转储。

### 批次 D02：Config、MCP 与技能

Sol 子代理完成独立分工阅读，主代理定向核对共享设置计算、MCP 校验、技能覆盖和 Codex RPC 写入边界。覆盖 Config 主分类、Codex 偏好/权限/工具策略、MCP 新增编辑删除、子代理规则管理、技能安装卸载、网络代理、显示与系统设置、WebUI 对应管理路由。已追到版本化配置写入、Gateway 字段解析和重载分类、上游 MCP 超时消费；未运行配置写入、MCP 分析或技能安装。

**D02-F01，中：通用工具设置绕过 Strata MCP 超时合同。** `scripts/mcp-setup.mjs:170–187` 要求 Strata 调用超时显式大于分析总时限，拒绝移除或过短值；`scripts/codex-tool-settings.mjs:35–36,54–73` 却把同一字段投影为普通正数或 null。Config 的两处工具设置入口及 WebUI `tool-access` 均通过后者写入，可把预设 960 秒改成 1 秒或移除。锁定 Codex 上游 `connection_manager.rs:378–381,1037–1050` 消费该值；移除用户覆盖且无其他配置层提供更长值时，回落到 `rmcp_client.rs:105` 的 300 秒；项目视频分析预算为 900 秒。因此允许保存的配置可使长分析在自身预算结束前被 MCP 客户端取消，不代表所有视频调用必然失败。建议在共享管理边界复用 Strata 不变量校验，预览和执行都核对实际目标及继承配置；不能只隐藏菜单字段，也不能将普通 MCP 一律限制成 Strata 规则。未实际发起分析。

**D02-F02，中：技能覆盖更新失败时丢失旧版。** `scripts/skill-setup.mjs:56–77` 在确认覆盖后先 `rmSync(target)`，再 `cpSync(source,target)`；只预查源 `SKILL.md` 存在。后续源子文件读取或磁盘写入失败时，原可用技能已删除，新版可能不完整，且无备份/恢复结果。建议同父目录先准备完整候选，再核对确认时的目标并替换；失败保留旧版，部分成功需报告恢复位置。卸载属于明确删除合同，不应混入更新事务。没有执行故障注入或读技能正文。

**D02-F03，低：Codex 等值设置仍写入并报告需生效。** `scripts/codex-user-settings-management.mjs:63–91` 对同值 edits 仍提交 `config/batchWrite`，返回固定的 `next-thread` 等 activation。`src/codex-client/client.ts:1086–1103` 没有消除这些 edits；锁定上游配置管理器对非空 edits 走持久化。与 Gateway 设置已有的 no-op 结果及项目合同不一致。建议共享计算按用户层原值判定无变化，并区分“未配置”与“显式设置默认值”；无变化不写且返回 `none`，同步 CLI/WebUI 预览和反馈。没有观察真实文件改写或通知。

**D02-F04，中：MCP 菜单吞掉临时客户端清理失败且没有可重试的归属记录。** 子代理最初将其列为待核风险，主代理随后补查 `scripts/mcp-setup.mjs:412` → `codex-user-config.mjs:138–166` → `src/codex-client/stdio-transport.ts:88–108` → `runtime/process-lifecycle.mjs:211`。临时客户端直接创建自有 stdio App Server；终止函数在组长/进程组未退出时可抛错，Transport 保留子进程供重试，但 MCP 菜单的 finally 无条件吞错并丢弃本次客户端入口。进程登记是 WeakMap，不是全局重试队列；同菜单下次操作可再创建客户端，用户也没有收到清理未确认提示。对照共享 `withCodexUserConfigClient` 已有 `unclosedReadClients`、后续入场清理及保留已写结果的 warning 机制。建议复用该资源所有权边界，保持已提交 MCP 写入结果、告知清理失败并在重新进入前收尾；不能用清理错误诱导重复写入。确认的是异常被吞和重试归属缺失，没有实测孤儿进程或挂起。

排除与限制：普通 Codex 设置不额外回读不单独报缺陷，官方写 RPC 成功已有持久化证据；MCP 回读另承担认证组合核验。官方技能发现/缓存失效及 WebUI React 草稿流程不计为本轮已深审；已覆盖其 CLI 管理与共享服务端合同。

### 批次 D03：Provider 与渠道接入

Sol 子代理覆盖官方登录/恢复、自定义 Provider 官方目录与 CP 表单、主 Provider 切换恢复删除、DS/CCG/OCG/CLP 账户生命周期、三个渠道 Setup 状态机，以及配置解析→重载分类→Surface 组合消费。主代理定向核对切换计划、删除后处理、Gateway 写锁和三渠道结果分支。模型管理细节及 OCG 最后账户文件恢复另开补查，不借账户覆盖声称全部算法已审。

**D03-F01，中：跨模型目录切换继承不属于目标目录的模型。** `scripts/primary-provider-management.mjs:326–338,449,466–472` 只在显式传模型时读/校验官方目录。从固定 CP（自定义目录）切换至已配置或备份中的官方目录 Provider、省略模型时，仅清理自定义目录和思考等级，保留原 `config.model`。这可以保存 CP 专属 ID；`runtime/app-server-service-runtime.mjs:166,1146` 随后注入官方目录却不修正模型，违反 `docs/provider-integration-guide.md:413–424` 的目标目录合同。建议先计算最终模型再按目标目录校验，必要时要求明确选择或展示已定义的清除默认值行为，不能随意取目录第一项。Setup/直接命令共用计划，已有 switching Profile 自带模型的路径保持其语义。不声称真实上游必然出现某个错误。

**D03-F02，中：CP 已删除结果被目录/元数据清理失败覆盖，部分残留无法重试清理。** `scripts/primary-provider-management.mjs:149–207` 先完成配置/Profile 删除，再直接删除 catalog 与 `provider.json`。两者清理异常发生在返回 `removed` 结果之前，导致 CLI/Setup 只显示失败，丢失已经删除、是否恢复官方及生效范围。仅剩 `provider.json` 时，`:567–579` 的 orphan 检测又不包含它，同命令重试得到 provider-not-found。底层 `model-provider-responses-catalog.mjs:122`、`model-provider-upstream-metadata.mjs:54` 均允许非 ENOENT 错误上抛。建议分别报告配置提交和材料清理状态，将精确归属的元数据残留纳入恢复计划；不自动回滚已提交删除。未实际删除账户或注入文件故障。

**D03-F03，中：Telegram/飞书把写入后的锁释放失败误报成普通保存失败。** `runtime/gateway-config.mjs:424–429,463–479` 先原子写入，再释放锁；释放错误仍会抛出。`telegram-setup-session.mjs:199–203` 和 `feishu-setup-session.mjs:204–218` 将所有异常归为 save-failed，不能表达已保存或结果待确认；飞书扫码还因此跳过后续应用配置/发布而不返回对应降级状态。建议写入器明确提交阶段，session 保留已保存状态和生效范围，飞书说明应用配置是否执行；未知结果不自动重写。微信已有异常后 inode/目标配置确认与凭据保留分支，不列入同一问题。没有真实扫码、平台发布或锁故障观察。

保持排除 C06-R01；switching 转固定后改用全局搜索值是已写明的合同，不算字段误丢。平台 API 官方语义、凭据后端各 OS 实现和真实自动重启未在本批实机观察。

### 批次 D04：Desktop 与各平台服务控制

Sol 子代理覆盖 Desktop 参数、首次启用、open/disable/status、配置回滚，macOS bundle/Host/租约/私有 Pipe 链，Windows Appx/bridge/启动取消链；服务覆盖目标选择、定义渲染、安装激活恢复、systemd/launchd/Windows Task 控制、状态、日志和就绪。主代理核对 Codex Home 传递、模板转义及下列重点位置。未启停服务或运行真实 Desktop，也未把源码阅读当作各 OS 验收。

**D04-F01，中：Unix 服务定义遗漏显式 Codex Home。** `scripts/service-install-context.mjs:40–46,57` 已规范化显式 `CODEX_HOME`，`service-install-management.mjs:480` 仅 Windows 定义写入它；`:549–589` 和八份 Unix 模板均不传。若用户终端使用非默认 Home、服务管理器没有该变量，安装预检与后台进程将读取不同的代理、Provider、Profile 和认证作用域，或导致就绪失败。消费者为 `runtime-environment`→`codex-proxy-env`/`codexHomePath` 及 `app-server-runtime` 的 Provider 读取。建议 Unix 同样保存显式 Home，未指定保留默认语义；既有安装需重新 install 生成/加载定义，restart 本身不修正。未读取或切换真实 Home。

**D04-F02，中：systemd ExecStart 路径遗漏美元符号转义。** `scripts/service-install-management.mjs:549–570,600–607` 的转义保留 `$`；若 CLI 路径包含字面 `${USER}` 目录，四份 unit 的 ExecStart 双引号仍不能阻止 systemd 展开，Node 将得到别的路径。依据 [systemd 官方 Command Lines](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Command%20Lines)，字面美元需 `$$` 或受支持的禁用展开机制。建议只在 ExecStart 参数边界处理，不把它误用到 Environment、WorkingDirectory 或 launchd XML；已有 unit 需重新生成加载。未安装实验 unit。

**D04-F03，中：Desktop 首次启用确认未绑定此前配置。** `scripts/desktop-app-command.mjs:81–94,159–162,191–197,772–785` 在终端 A 读取未启用状态/旧端口后等待确认（实际提示告知启用和重启，并不展示端口）；若终端 B 已 enable 新端口，A 确认仍将旧端口或 47821 传入启用流程。写函数重新读取最新文档后以旧投影替换 desktop_app，底层原文比较只保护这次新读到写之间，无法保护确认前快照。Provider/Socket 目标也在交互前解析。建议保留预览 revision 和目标，在创建令牌、写配置和重启前复核；变化则拒绝旧确认。现有回滚已核对 applied 与当前配置，不应误报为任意覆盖，也不应删除这项保护。未实际制造并发启用。

**D04-F04，低：Windows 日志行数只约束输出，不约束整文件读取。** `scripts/windows-service-control.mjs:507–521` 对累计日志先 readFileSync，再 split/slice；`windows-service-host` 持续 append。因此 `logs -n 100` 仍随整个文件增长占内存，可能在最需要诊断长期服务时失败。Unix tail/journalctl 无此全量读路径。建议有界读取尾部并保留请求行数和末行语义，不能直接拿固定 16 KiB 错误摘要替代。未生成大日志或观察 OOM。

排除：Desktop status 不唤醒释放实例；租约获取后再次检查取消，不支持“取消后必然迟到启动”的指控。服务 install 未承诺按旧状态逐项回放，不能把恢复定义的局限直接报成违约。macOS 已运行 WebUI 独立激活要求已有文档。Windows 原生 C#/Job/ACL、私有 IPC 底层和全部通用进程管理实现不是本轮完整审计对象。

### 批次 D05：模型管理、能力探测与最后账户恢复

另一个 Sol 子代理补齐 D03 明确未深入的模型子流程，主代理核对 OCG 实际恢复字段、事务守卫、模型选择令牌及工具能力保存的默认值保留。未新增确认的实现缺陷。

- 模型增删改与模板：菜单追到 `provider-model-additions` 的有期限 sourceToken、完整字段与同族账户预览、执行重建计划；CLP 本地编辑保留原 ID/路由/未选元数据；模板按 prompts/settings/capabilities 分开，保留窗口与思考默认，不兼容则拒绝。移除保护同族账户默认、目录默认、最后模型及 Gateway 显式默认，删除对应模板关联但保留历史引用。
- 共享持久化：目录/manifest 和受影响 Profile 的思考镜像复用 `model-provider-managed-runtime` 事务，pending/备份、回读与失败守卫拒绝覆盖后续修改。CLP Relay 独立目录合同保留，不能为了聚合界面把不同消费范围合并。
- 能力探测：`custom-model-capability-setup/probe` 只在明确选择后请求，apply_patch 最多两次、tool_search 最多三次，单项 45 秒；验证模拟工具往返，不执行模型请求的真实工具；无法确认不自动采用，保存绑定账户连接/凭据/模型等快照。网页搜索诊断另有单次请求及费用确认，不自动回填能力或改搜索策略。
- OCG 最后账户：`opencode-go-account-management.mjs:466` 起逐步核对文件快照；固定模式先要求可读恢复基线，恢复受管字段后删注册表/Profile/marker，保留共享目录，异常按快照回滚，外部后续变更阻止覆盖。没有据此声称实机异常恢复已验证。

**D05-D01，低优先级文案建议。** `scripts/opencode-go-setup.mjs:261,277` 说“恢复安装前 Codex 主配置/主配置已恢复为安装前状态”，实际 `managed-model-provider-setup.mjs:191` 只恢复 `managedRootKeys` 及该 Provider 的 model_providers/profiles 条目，保留其他设置。现行 OCG 专题文档已正确限定。建议提示改为“恢复该账户接管的 Codex 主配置字段，保留其他设置”；未发现整份配置被回退，不按数据丢失缺陷计数。

模型探测没有联网或计费，未运行真实账户删除、磁盘故障或 OS 权限恢复。上游完整协议解析器、原生技能缓存和 C#/ACL 等底层属于明确的审计边界，不以调用方阅读代替全实现审计。

### 第二轮独立核验与交付状态

Astra 已独立核验 D01-F01、D02-F01、D04-F01、D04-F03，四项均成立；主代理已纳入其措辞纠正及条件限制。此次是重点发现核验，不是全 CLI 第二次独立审计。Unix Home 缺口不影响已经显式传递的 Gateway 自身 CODEX_CONNECT_HOME/config.toml；源码更新的一次重查不能消除外部写入竞态；Desktop 回滚仍有比较保护；Strata 清除覆盖的有效值取决于其余配置层。

第二轮新增 12 条确认发现，连同第一轮 13 条共 25 条；建议项单列，不混入缺陷数量：

| 编号 | 优先级 | 结论 |
| --- | --- | --- |
| D01-F01 | 高 | 更新成功清理可能删除预检后的源码修改 |
| D02-F01 | 中 | 通用工具设置绕过 Strata 超时不变量 |
| D02-F02 | 中 | 技能覆盖先删除旧版，复制失败无恢复 |
| D02-F03 | 低 | Codex 等值设置仍写入并报告生效要求 |
| D02-F04 | 中 | MCP 清理异常被吞，缺少重试归属和提醒 |
| D03-F01 | 中 | 跨目录 Provider 切换继承无效默认模型 |
| D03-F02 | 中 | CP 删除后清理错误丢提交结果，孤立元数据不能重试 |
| D03-F03 | 中 | 渠道配置提交后释放锁错误误报普通保存失败 |
| D04-F01 | 中 | Unix 服务遗漏显式 Codex Home |
| D04-F02 | 中 | systemd ExecStart 路径美元符号被展开 |
| D04-F03 | 中 | Desktop 首次确认未绑定配置和目标快照 |
| D04-F04 | 低 | Windows 日志按行查询仍全量读取文件 |

收敛结论：优先共享真正相同的配置变更计算、确认快照、提交/后处理结果与资源清理归属；保留不同目录、账户作用域、平台控制和日志/SQLite 的消费合同。无需新增统一万能命令框架，也不应把所有菜单强行加一层确认。推荐先处理 D01-F01，再处理跨入口不变量、目录作用域与确认竞态，最后处理结果文案和纯职责拆分；这是修正建议，尚未实施。

本轮已完成所列公开 CLI 及补查子流程的团队源码审查，没有遗留代理或异步作业。明确未作全审的底层范围包括官方技能发现/缓存、WebUI 全部 React 交互、Windows 原生 C#/ACL 与通用进程/私有 IPC 的完整实现、上游全协议解析；它们不能凭调用方覆盖推断正确。真实配置写入、服务安装启停、Desktop、平台账户、计费探测和破坏性维护未运行，本轮没有新增业务运行观察。后续动作是按发现确定修正范围；记录和索引为本任务唯一文件改动。

## 修复优先级与执行顺序

本节覆盖全部 25 条确认发现，每项只归属一个批次；下面是执行顺序，保留各发现原有严重度，不把批次顺序等同于事故严重度。编排已完成；批次实施状态见执行记录。

| 顺序 | 执行优先级 | 修复目标及范围 | 对应发现 | 数量 |
| --- | --- | --- | --- | --- |
| R1 | 最先：数据与文件保护 | 更新保留旧树、技能候选替换、转储清理确认范围、工作区移除目标快照、指标导出目录保护 | D01-F01、D02-F02、C11-F01、C05-F01、C10-F02 | 5 |
| R2 | 高：配置提交与确认一致性 | 先明确 Gateway 写入提交/释放结果，再处理 init 和 Desktop 的确认快照及过期目标 | D03-F03、C04-F01、D04-F03 | 3 |
| R3 | 高：运行作用域与配置不变量 | Unix 显式 Codex Home、systemd 参数转义、Provider 跨目录最终模型校验、Strata 共享超时校验 | D04-F01、D04-F02、D03-F01、D02-F01 | 4 |
| R4 | 中：部分成功与资源收尾 | 指标清理保留提交/备份结果、CP 删除区分清理结果及可恢复残留、MCP 临时客户端清理归属 | C11-F02、D03-F02、D02-F04 | 3 |
| R5 | 中低：结果准确性与读取边界 | Codex 等值保存、时区 JSON 生效信息、init 采集关闭反馈、导出名称解析、stdout 查询代理依赖、Windows 日志有界读取 | D02-F03、C04-F02、C04-F03、C10-F01、C10-F03、D04-F04 | 6 |
| R6 | 收尾：帮助与文档一致性 | 菜单名、清理入口、Remote 聚合说明、投递查询副作用 | C01-F01、C03-F01、C07-F01、C12-F01 | 4 |

R1 内先做源码更新，再做技能替换和删除范围，最后做导出目录；前两项先落实备份保留、失败恢复及回退方案，不能通过自动清理旧副本掩盖不确定状态。更新需处理预检后的外部修改和切换后旧句柄写入；技能需先准备候选、保护原目录，失败时准确报告可恢复状态。工作区与转储分别沿用各自目标身份和确认合同，不合成通用删除框架。

R2 先修共享写入结果边界，核对所有调用方如何处理“已提交但后处理失败”，随后在 init/Desktop 绑定确认时的修订和资源目标，避免在旧错误语义上继续增加调用方特判。R1 的确认范围修复可以复用现有快照能力，不依赖新增万能事务层。

R3 中同一服务渲染器的两项一起处理，但 ExecStart 参数转义与环境变量转义分开。Provider 模型与 Strata 超时分别下沉到其真实共享管理边界，CLI/Setup/WebUI 同合同入口同步调整；不新增原本没有的配置入口。服务修复同时写明既有定义需重新 install/加载，实际部署不在本次代码修复授权内。

R4 复用 R2 确立的提交/后处理区分原则，但 SQLite 提交、Provider 多文件清理、进程资源归属仍保留各自状态。CP 残留仅处理精确归属材料，不扩大到历史目录扫描或数据迁移。R5 的 no-op 比较必须区分缺省与显式默认值；JSON、退出码、输出文件名和实际查询保持同一结果语义。

相关合同文档随每批实现同步修正，R6 负责剩余帮助及总核对，不把必要文档更新拖到最后。顺带纳入已有明确文字澄清 C05-D01、C11-D02、D05-D01。C01-D01/C02-D01/C02-D02/C08-D01/C13-D01 等分类共享、帮助拆分、文案精简、顺序去重和重复参数统一仍是设计建议，暂不作为本次缺陷修复必做项；只有修复本身确有需要时作最小调整。

每批完成条件：追踪受影响入口、共享管理层、持久化/消费和其他同合同调用方；完成代码与对应契约更新；使用隔离的任务数据观察真实入口结果和相关失败/取消/并发边界，记录实际输出；执行适用的现有静态检查。遵守不新增或维护测试/探针脚本的规则，不把静态结果当成功能证据。涉及真实服务、外部账号、费用或无法提供的平台时，完成可授权工作并明确未观测边界，不冒称验证通过。

每批将问题状态更新为待实施、实施中、已修复且有证据，或已实现但某边界未观测；保留原审查基线，记录修复后的实际文件和证据。共享文件串行修改，独立模块才考虑分工。最终核对 25 项归属、未解决问题与剩余风险，不以条数归零替代行为核验。

## 修复执行记录

### R1：数据与文件保护（已提交 `348d59d7`）

实现范围：源码更新在停服前、切换前复核原目录身份/HEAD/origin/工作树，成功后也保留旧树并返回 backupPath；技能同父目录准备完整候选、绑定确认快照，保留旧树及失败恢复材料；转储菜单携带首次预览指纹到最终执行，工作区交互移除在锁内核对展示文档；导出逐级使用 Runtime 私有目录保护能力。修复前先确定恢复方案：不迁移格式，不自动删除旧源码/旧技能副本，不覆盖并发写入的新目标，精确输出恢复位置，清理由用户确认不再使用后手动进行。

已观察证据：

- 隔离 `init` 创建任务配置后，由正常指标 Store 创建空库；真实 `codexc metrics report --format json` 在 Node 24.21.0 与 CI 固定 Node 22.22.0 均成功导出可解析 JSON，文件权限 600。输出目录替换成符号链接后，真实入口退出 1、提示私有目录类型或所有者无效，重定向目录为空。空库创建前的导出明确报数据库不存在，没有把失败当成功。
- 真实 PTY `work` 展示目标期间，另一管理调用将同 ID 改绑。确认时拒绝旧快照，独立 list 仍保留新目标；重新选择后成功移除注册，两个磁盘目录均保留。
- 转储菜单首次预览 1 项后新增第 2 项，确认明确拒绝且独立 CLI 预览仍为 2 项；选择 No 后保持 2 项；重新预览确认后删除 2 项、独立预览为 0。服务状态适配使用隔离注入，没有启停实际服务。
- 技能：真实 Setup→项目技能→覆盖→返回→完成成功退出，候选内容正确且 previous 保留旧内容，隐藏副本不进入技能列表；确认提示期间编辑目标后，旧确认被拒绝且编辑保留。Node 22 新装及读取列表成功；源包含 FIFO 时在准备阶段明确拒绝，旧目标未被移走。实际观察发现 Node 24 的原生复制对特殊文件/极长链接存在跳过或原生异常风险，已在复制前后源快照中拒绝不支持类型和无法解析的链接。发布失败后自动恢复、Windows/macOS 未实测；Node rename 不提供跨平台 NOREPLACE，最后一次检查到系统调用仍有外部创建空目录的竞态，不能承诺完整事务隔离，但旧树始终保留且不递归删除目标/备份。
- 初始化隔离数据的首次调用漏覆盖继承的 CONFIG_FILE，权限收紧尝试被 EROFS 拒绝，未改写真实配置；后续同时显式隔离 HOME/CONFIG_FILE。源码更新计划调用被现有“不能在运行中的 Codex 服务内执行更新”约束拒绝，没有绕过此约束或执行真实更新，切换/恢复成功链目前只有源码证据。

Node 22.22.0 从官方固定版本下载到任务目录并通过官方 SHA-256 清单校验，未改项目依赖。现有类型/运行边界检查在 Node 24 与 Node 22 通过；文档检查通过。未新增或修改测试脚本。Windows/macOS 权限、实际服务停启、更新切换和取消过程未实机观察；不得将隔离菜单观察描述为平台验收。

独立 Sol 复查覆盖上述五条关联链路、声明和文档，未发现新增生产代码阻断；指出索引状态过期和技能恢复保证文案过宽，已同步索引并将保证限定为失败恢复不覆盖已存在目标。复查为只读源码审查，没有重复执行主代理和实施代理的观察。

### R2：配置提交与确认一致性（已提交 `8f1e8454`）

init 可选项先捕获共享设置修订和展示值，全部确认后在 Gateway 配置锁内核对修订并保存；过期确认即使选择未变化也拒绝，取消保留零写入。真实隔离 PTY 展示 WebUI 未设置后，另一共享管理入口保存 false；原向导选择 Yes 后退出 1，提示确认失效，独立读取仍为 webui=false、traffic=false。

重新运行真实 init 后选择启用 WebUI、保持转储关闭，正常完成并明确跳过未配置渠道的服务安装；独立共享管理读取为 webui=true、traffic=false。再次运行，选择关闭 WebUI 后在下一项 Ctrl+C，向导取消，独立读取仍为 true/false，未提前保存。没有运行实际服务安装。

Desktop 保留初始原文/CAS 文档与 Provider 运行目标快照，在锁内先复核再创建 token/保存，异步激活与回滚再次复核。现有注入端口下，确认中竞争写端口 48999、改主 Provider 上游均在 token/重启前拒绝；取消不写入；Windows/macOS 正常启用和 disable 编排完成；重启失败恢复原状态，重启中竞争写 48998 则拒绝恢复并保留新值；锁释放失败保留已存配置、不继续重启。真实 Linux `app status --json` 输出 supported=false、configured=true，不能当作 Desktop 实机验收。异步重启和 Provider 文件不共用 Gateway 锁，复核后外部写入最后窗口仍存在；合法确认后 token 已创建但保存失败的遗留行为未改变。

共享锁区分同步操作完成与 Gateway 原子写入已确认；只有后者返回已保存异常。三渠道会话/CLI/JSONL 保留已保存和锁释放告警，飞书独立保留后续应用配置结果，微信保留已提交的新凭据；未知异常仍按原合同确认或失败。配置管理保留有效备份，WebUI 普通设置用独立安全错误码和双语文案提示已保存，刷新后再编辑。其它共享调用者（初始化/默认值、Workspace、备份、Relay、Codex .env、Provider 注册）经源码核对，不把通用锁完成当 Gateway 已保存；未逐一故障运行。

隔离现有产品入口及平台替身观察：注入锁 unlink EACCES 后，Telegram 保存名单 [123] 并返回告警；飞书仍尝试一次应用配置，故意使其失败时同时返回应用配置降级，配置保存且其它渠道字段保留；微信保留新凭据和正确名单。回环 WebUI HTTP PATCH 返回 500/gateway_config_saved_cleanup_failed，随后 GET 200 读到新日志等级。旧 revision/CAS 拒绝并保留竞争更新；未知 writer 错误仍 failed/save-failed，取消和非法输入未写入；等值设置 activation=none、inode 不变；需要备份的已提交异常保留内容等于原文的备份。无写入的锁操作故障只返回通用完成错误，未被误判为写入。任务服务、REPL 和目录已收尾。

现有定向后端 ESLint、前端 oxlint、i18n（2020 个键）、文档及 Node 22 类型/边界检查通过；最终提交钩子覆盖集成后的输入。未观察浏览器 React 告警/刷新交互、真实平台授权发布/凭据后端和三平台实际服务激活；不能将平台替身或 HTTP 观察扩写成实机验收。未新增或维护测试。

独立 Sol 复查覆盖共享锁/原子提交到配置管理、三渠道 CLI/JSONL、WebUI API/前端消费、init 与 Desktop 确认和恢复，未发现新增生产代码阻断；复查指出的残留“实施中”记录已修正。该复查为源码判断，未重复实施观察或静态检查。

### R3：运行作用域与配置不变量（已实施并完成独立复查，提交收尾）

Unix 四类服务定义写入显式规范化 Codex Home；未设置则不生成环境项，Windows 原行为保留。systemd 采用官方 [Command Lines](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Command%20Lines) 的 `:` 前缀关闭 ExecStart 变量展开，保持路径字面值，不改变 Environment/WorkingDirectory 或 launchd 的转义规则。已有定义需重新 install，普通 restart 不刷新模板，文档同步说明激活和恢复边界。
源码更新安装归属校验同样按新 ExecStart 格式精确匹配，旧格式需要按文档重装程序/服务定义；不添加另一套宽松路径解析。

隔离定义生成与安装管理入口观察：含字面 `${USER}`、空格与 `&` 的源码/Home 路径在四份 unit 和四份 plist 中保持其含义；systemd-analyze verify 返回 0，plist 标准解析读回精确路径。未指定 Home 的 unit 没有该变量或残留占位符。Node 24 初次、CI Node 22 替换已有定义的完整安装管理编排均返回 installed/五阶段；平台预检、激活和就绪使用替身，未操作真实服务。确认后更换为另一已存在 Home，执行前拒绝 stale-plan；无效 Home 明确 ENOENT。首次 macOS 定义观察未隔离 HOME 时尝试创建缺失 LaunchAgents 失败，未写入；随后改用隔离的安装环境对象。真实 systemd/launchd 服务启动和 Windows 实机未观察。

Provider 在共享切换计划计算最终模型后核对目标官方目录，合法继承保留、非法继承要求显式选择，不任取第一项；CP 模型目录与回切 OpenAI 的既有清空合同保留。配置 RPC/非 CP 模型列表使用现有注入替身，落盘事务真实执行，CP 来源使用真实 `codex debug models --bundled`。已观察配置/备份候选的 cp-only-model 均拒绝且零写；gpt-6.1-sol 经 CLI/Setup 成功继承、清除 CP 目录及思考覆盖，运行时读到目标；显式恢复消费正确备份；合法 switching Profile 转固定保留自身模型和私有凭据，非法模型保留 Profile 且不创建转换备份；旧预览/取消/目录导出失败均未写；完全缺省不请求目录。未进行真实上游推理或服务重启。

Strata 共享校验位于现有工具设置模块，预览/执行 await；MCP 编辑确认后再读用户修订和选中目标合并状态。实际合并目标、预算或清除后的继承不可知时明确拒绝，普通 MCP 仅在目标可确定时不受视频预算限制。已损坏合并时限需原生修复，不能凭拟写值假定高层覆盖消失。锁定上游 HEAD 83086188ae0614bd882818ff1aa23f3194962012 只读核对超时消费和环境覆盖，未升级协议。

隔离真实 Codex 配置 RPC 观察（提示输入替身）：通用工具入口保存 1000、MCP 编辑保存 1100，另一管理入口回读用户/合并值相同；1/900/null 预览拒绝，执行1也拒绝；普通MCP保存1和null均成功；取消修订不变。确认期间独立RPC把分析预算900改1800，旧确认拒绝、超时仍1100；新预算下1200拒绝，恢复预算900后1200成功。替换快照边界观察覆盖无覆盖null、未知宿主、缺失合并、名称与实际启动不一致和已有不安全时限。未启动视频MCP或发起模型/视频请求，没有真实TTY/WebUI浏览器观察；用户层revision不覆盖独立配置层，读后到写入仍有外部竞态。任务客户端、作业和目录已收尾。

Node 22 类型/运行边界、定向 ESLint、文档及 diff 检查通过。源更新完整执行仍受当前服务内约束未观察，归属匹配仅源码核对；真实三平台服务/Provider对话和跨配置层原子性不声称已验证。

独立 Sol 全链路复查发现并定向核对两项修正：模板字符串 replacement 会解释合法路径中的美元序列，已改 callback；官方目录导出没有沿用 RPC 的显式 Codex binary，已共用解析器。随后主代理把模板替换收敛为单轮 callback，防止路径内字面占位符被下一轮再次解释，并自行核对这项收敛。Node22 重生成八定义，包含 $$、$&、美元反引号/单引号及字面 __CONFIG_DIR__/__CODEX_HOME_ENVIRONMENT__ 的路径在 plist 解析和 unit 文本中精确保留，systemd-analyze verify 0。PATH 不含 codex、Gateway 指向真实 native Codex 绝对路径时，CP来源的官方模型预览成功；首次使用依赖node的JS包装器但PATH无node时目录导出失败，未误报成功。复查无剩余阻断，限制保持如上。
