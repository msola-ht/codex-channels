# 原生 Codex daemon 接入审查

## 决策与范围

基于官方 `codex-cli 0.160.0`，固定源码提交
`a956835d020762cb2b570053af06f643a11c0ecc`，本轮完成源码、项目调用链和 Linux 隔离实测审查。
本地参考仓库为 `upstream/openai-codex-0.160.0`；没有以官方 main 代替锁定版本。

**当前决定：暂不实施官方 daemon 接管，继续使用项目现有服务管理。**
原生恢复与包管理有实际收益，不能继续仅以“又一套后台管理”概括。与此同时，直接替换
`spawn` 会破坏现有 Provider 配置、代理所有权和恢复边界；完整迁移必须满足下文条件。
本次改动仅在既有 `codexc update` 中关闭用户层 `features.daemon_auto_start`，防止原生终端自动启动另一套后台；不执行 daemon 接管，不改变存储布局，不停止已有官方后台。

`daemon_auto_start` 在 0.160.0 默认开启；关闭自动启动与关闭 daemon 自动更新是不同操作。
更新器复用 `config/read` 与带 `expectedVersion` 的 `config/batchWrite`，不增加 RPC；
缺失或显式 `true` 均设为 `false`，已有 `false` 不重复写，冲突直接报错。

升级总体采用范围见[升级决策](codex-cli-upgrade-decisions.md)，版本升级仍遵守
[升级流程](codex-cli-upgrade.md)。以下区分源码结论、隔离实测与尚未验收的迁移合同。

## 原生能力的收益与边界

| 能力 | 已确认的收益 | 对本项目的边界 |
| --- | --- | --- |
| 每个 Codex Home 的后台管理 | 官方负责安装目录、确定性 Socket、生命周期锁、后台 PID、启动探测及有界停止/重启 | 可替换部分进程管理；不能替代 Provider 拓扑、授权、代理和指标协调 |
| 多客户端共享 | 现有项目 Transport 无需放宽安全检查即可连接，同一实例的两个客户端读取同一 Thread | 不需要复制会话历史，也不需要另建终端会话接口；真实 TUI 仍需验收 |
| 重启恢复 | 官方恢复已加载的持久 Thread，并可在客户端连接前续做被中断工作 | 是会发起新模型请求的行为变化，不能只当成历史重新加载 |
| 独立后台包 | 后台包不依赖正在被替换的全局 CLI 文件，支持从当前 CLI 安装精确版本 | 调用 CLI、已选后台包、正在运行的 App Server 三个版本均需核对 |
| 原生源码维护 | 后续恢复和生命周期修复由上游维护，项目可以减少重复实现 | 生命周期合同仍标为实验性；每次升级要重新验证，不代表可以删掉整个 Supervisor |

官方依据：[daemon 生命周期说明](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-daemon/README.md)、
[生命周期实现](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-daemon/src/lib.rs)、
[后台启动实现](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-daemon/src/backend/pid_start.rs)。

## 完整调用链中的迁移条件

### 1. Provider 配置与 Codex Home 不能直接互换

当前 [App Server Runtime](../runtime/app-server-service-runtime.mjs) 为主实例和 Provider 实例
启动独立子进程；[模型启动参数](../runtime/model-provider-startup-runtime.mjs) 通过 `-c` 注入
模型、Provider、目录、代理地址、重试与搜索设置，并通过子进程环境仅传入所选凭据。
当前隔离主要依赖不同实例与 Socket，不是为每个 Provider 建立独立 Codex Home。

daemon 则以 Codex Home 为管理单元。隔离实测中，在启动命令加 `-c model=...` 后，
`config/read` 仍返回 Home 配置中的模型；这些根 CLI 覆盖没有进入后台启动参数。
其 [PID 后端](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-daemon/src/backend/pid.rs)
与 [CLI 分发](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/cli/src/main.rs)
支持这一结果。不能把现有参数数组直接加在 daemon 命令上就宣称等价。

迁移前须明确受控配置如何进入后台，以及 Provider 切换时配置和进程如何一起更新。
改为多个 Codex Home 还会影响账户、历史、配置、Skills 等资源解析；双 Home 探测只证明
实例独立，不证明符合当前 Provider 的数据语义。不得复制内部会话库或通过随意符号链接
拼接 Home。若最终方案需要改变用户持久化布局，必须另行给出备份、失败恢复与回退方案。

### 2. 代理与后台必须有协调一致的生命周期

当前 Runtime 同时拥有动态本地端口上的 ProviderProxy、Chat Completions Bridge、凭据环境、
指标 IPC 和 App Server 子进程。App Server 配置指向这些代理；Runtime 退出时一并回收。
改为 detached daemon 后，Runtime 退出可能留下仍在运行、但代理已经消失的 App Server；
新 Runtime 获取不同端口后，旧后台仍可能使用原地址。

因此原生化之前必须解决代理重建、地址变更、配置生效、后台就绪和失败恢复的顺序。
不能仅把 `spawn` 换成 `daemon start`，也不能把两套生命周期所有者同时用于同一实例。
继续保留 [Supervisor](../runtime/app-server-supervisor.mjs) 中的 Provider 租约、拓扑与
Desktop 协调责任；只有职责实际移交后，才删除对应进程管理代码。

### 3. 原生恢复会自动开始新 Turn

管理模式下，App Server 可在没有外部客户端时恢复持久 Thread，并为符合条件的中断工作
开始一次续做。恢复过程检查中断状态、执行环境和权限等条件，插入重启恢复上下文，要求
模型先检查状态再重复操作；这不是“工具恰好执行一次”的保证。

本地模拟后端实测：原先的活动 Turn 在重启后被标为 `interrupted`，随后出现完成的续做 Turn；
新模型请求早于测试客户端重连。显式 `stop` 后再 `start` 则没有自动加载该 Thread。
后者不意味着删除历史；只表示本次没有进行重启恢复。

Gateway 当前续做规则还涉及来源、Workspace、运行状态和已有外部绑定。原生后台没有
Gateway 的全部业务归属信息，因此迁移必须决定后台离线续做的授权边界，并验证重连后的
输出路由、状态收敛、审批与动态工具归属。不能同时让 Gateway 再提交一份续做输入。
清理、升级、故障恢复也必须区分 `restart` 与 `stop`/`start`，避免把有意停止误当成恢复。

官方依据：[恢复快照](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/request_processors/daemon_snapshot.rs)、
[续做实现](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/src/request_processors/daemon_continuation.rs)、
[恢复合同测试](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/daemon_update_recovery.rs)。
本轮阅读了这些上游测试，没有运行整套上游 Rust 测试。

### 4. 精确版本可以维持，但需接入现有更新事务

官方支持 `codex app-server daemon update --from-cli --yes`：从调用 CLI 安装后台包并固定版本。
显式固定的版本不参与 latest 渠道自动更新。因此“独立后台必然造成无法控制的版本漂移”
不成立。该路径本轮通过帮助和[安装源码](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server-daemon/src/prepare_install.rs)
核实，未进行跨版本升级或回退实测。

但已有后台包不会因全局 CLI 更新而自动同步；普通 `daemon update` 会选择最新稳定版本，
不能直接替代项目精确版本更新器。候选安装、合同检查、停止/恢复顺序、运行版本确认和失败回退
仍须由项目更新链路协调；同版本包替换也不能只核对安装文件而忽略仍在运行的进程。

### 5. 操作系统、桌面桥与状态探测仍需保留边界

原生 PID 后台启动后脱离调用进程，不等同于本项目 systemd 的 `Restart=always`、开机启动和
Runtime 依赖恢复。当前 [服务模板](../systemd/codex-connect-app-server.service.template)
是前台长期运行入口；不能直接改成执行后退出的 daemon 启动命令，而不重新设计监管关系。
自动更新器也不等于进程崩溃守护或开机服务。

macOS Desktop 的宿主启动、签名环境和桥接管道需单独验收；官方 remote control 不是
本项目 Desktop 桥的等价替代。原生 TUI 仍必须连接对应 Provider 的权威实例。
Gateway 停止不得主动终止共享 App Server；Relay、WebUI 不在 daemon 替换范围。

实测停止后执行 `daemon version` 会因 Socket 不存在返回非零，不能假定总能得到
`status: stopped` JSON。管理层需区分正常停止、版本不符和实际探测失败，不能把所有异常
都当成“未运行”，也不能只看 PID 就宣布就绪。

## 隔离实测记录

使用真实 `0.160.0` 二进制、私有临时 Codex Home 和本地 HTTP 模拟模型后端；关闭自动更新
及 remote control，不使用真实账户、不修改用户服务。实验进程均已停止。

| 探测 | 结果 | 不能推导出的结论 |
| --- | --- | --- |
| 两个 Home 分别 bootstrap/start | 分别安装后台包并返回 0.160.0 | 不代表现有 Provider 可直接迁移 Home |
| 项目 Client/Unix WebSocket Transport 建立三个连接 | 初始化成功，同一实例两个客户端可读同一 Thread | 未完整运行真实 TUI 或渠道审批 |
| B 读取 A 的临时 Thread | 被拒绝，返回未加载 | 不是跨账户安全边界的完整验收 |
| 重复启动 A | 返回 `alreadyRunning` | 未覆盖并发启动竞态全集 |
| 重启、停止 A，同时查询 B | B 继续响应 | 不证明共享代理崩溃时可恢复 |
| 启动命令附加模型 `-c` 覆盖 | 后台仍使用 Home 中的模型 | 不能搬用当前逐实例参数注入方式 |
| 持久 Thread 一轮完成、下一轮保持活动后重启 | 客户端重连前产生恢复模型请求；历史依次为完成、中断、续做完成 | 不保证实际工具不重复执行，也未覆盖全部审批/Queue/Goal |
| 显式停止再启动 | 原 Thread 不在已加载列表 | 历史并未因此被证明删除 |
| 停止后的版本探测 | 非零退出，Socket 不存在 | 初轮脚本把此记为清理错误；后续检查确认进程与 Socket 均已退出 |

复现步骤：先为 A/B 各建权限受限的临时 Home，固定 CLI 并关闭两项后台开关；bootstrap 后
用项目 Client 完成初始化、共享读取、交叉读取和独立启停。恢复探测另配置本地模拟 Responses
服务，完成第一轮、保持第二轮请求未完成，执行 daemon restart，并在重新连接 Client 前
观察模型请求；最后读取已加载列表与 Turn 状态，再对比显式 stop/start。结束时停止两个实例
并检查无遗留进程。不要把该步骤直接用于用户正在工作的 Home。

本次临时诊断脚本为 `/tmp/codexc-daemon-probe.mjs`、`/tmp/codexc-daemon-phase2.mjs`，报告为
对应的 `-report.json` 文件；它们不是仓库测试或长期交付依赖。上表保存可持续复核的结果，
正式接入时须把必要断言纳入仓库真实 App Server 合同，不能以临时报告代替回归测试。

## 接入验收与后续决策

本轮分析已完成，接入实施暂缓。以下条件仅供未来重新决定接入时复核，不是当前待办，也不表示已经通过：

1. 明确单一进程所有者，以及主实例、Provider 实例与 Codex Home 的映射；配置、认证、历史和
   Skills 语义保持一致，所需数据变更有获准的备份与回退方案。
2. 验证代理退出/重建、端口变化、凭据切换、Provider 租约回收及系统开机/崩溃恢复，确保不会
   留下使用失效代理的 daemon。停止 Gateway 仍保持共享 App Server。
3. 真实 App Server 合同覆盖中断续做、显式停止、绑定/Workspace 变化、Queue、待决审批、
   动态工具与 Goal；验证 Gateway 离线时的处理及重连后状态与输出归属，无重复续做提交。
4. 将 `--from-cli` 精确安装纳入升级事务，验证调用、安装和运行三个版本；覆盖旧后台仍运行、
   候选失败、同版本替换、停止状态、跨版本更新与回退，保持官方自动更新关闭。
5. 验证原生 TUI 的 Provider 目标、Socket 安全及 macOS Desktop 桥；对实际支持的平台完成
   服务管理验收。Linux 隔离结果不能代替 macOS/Windows 证据。

当前不继续做 daemon 设计或实现。未来若重新决定接入，应先形成 Provider 配置/数据归属与代理生命周期的最小接入设计，再决定是否实施替换。
可以先用隔离的单实例证明该设计，但不能以只支持默认实例的结果宣布全项目迁移完成。
验收通过后再移交进程职责、删除重复管理代码；不增加长期双后端兼容层，不扩展渠道主机管理权限。

## 本次关闭自动启动的验证

更新器回归覆盖版本无需更新、候选切换、配置冲突和失败后的服务恢复。真实 0.160.0 App Server
在隔离 Codex Home 中验证了单键关闭、其他配置保持不变，以及重复执行不改变配置版本。
类型、相关 Lint 与文档索引检查通过；提交时由正常 pre-commit 执行完整门禁。
这些证据只验证关闭自动启动，不表示原生 daemon 接管已经实现或验收。
