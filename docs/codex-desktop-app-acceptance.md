# codexc app 跨平台验收与交接

更新日期：2026-10-18。

操作者已明确确认：**当前 `codexc app` 可以使用，只是尚未记录验收过程**。本轮任务是补齐
macOS 和 Windows 的实际版本、操作结果及恢复记录，不把“缺少记录”解释为“不能使用”。
当前可用反馈尚未细分平台、Provider 和内置工具范围，以下空项由操作者切换系统后填写。

实现说明见 [Desktop 共享架构](codex-desktop-app-development.md)，公开命令与服务操作见
[用户指南](user-guide.md#codex-desktop-app-共享macos--windows-预览)。

## 当前代码与实现边界

- 主体仍是独立受监管的 App Server。Desktop、渠道、原生 TUI 连接同一目标实例；
  Gateway 不复制会话历史，退出 Desktop 不主动终止共享实例。
- macOS：通过单次启动环境选择受管 CLI Proxy，转换 JSONL stdio 与 UDS WebSocket；
  工具 Host 接收 Desktop 提供的 Pipe，附加时可能短暂重启目标实例。
- Windows：单次子进程环境传入带令牌的回环 WebSocket 地址；桥通过目标 Provider 租约和
  Windows Proxy Transport 接入私有 Socket。
- `compatible` 仅表示入口探测通过；`toolHostAttached` 仅表示 Host 租约附加。
  二者均不代替内置工具调用结果。Windows `bridgeReady: null` 是只读查询未握手，不是故障。
- 上游 0.163.0 将 UDS 客户端识别为 WebSocket；转换后不等价于原生本地 stdio。
  原生用户验证等仅限本地连接的能力不包含在基础会话共享通过结论中。

本轮关联修复与验收文档位于分支 `fix/codexc-app-acceptance`，基于提交
`065aab7dd4304a1a93564cdcaecb78d20d0af6bb`：

| 文件 | 本轮修复 | SHA-256 |
| --- | --- | --- |
| `runtime/desktop-app-bridge.mjs` | 清理失败保留资源及租约；关闭可重试；异步创建期间关闭不再启动迟到的 Transport | `b982515281f587355122cce60b90610c96722cb9f6dce320acafe8b3da1f005c` |
| `scripts/windows-desktop-app-inspect.ps1` | 进程路径不可判定或已安装但找不到可执行文件时保持 unknown | `6f175ee842c202895472ab5b6e2224d841f73610026334bedf7d8559e8ac1c95` |

切换机器时获取并切换到 `fix/codexc-app-acceptance`，记录 `git rev-parse HEAD`，
确认包含这两项修复。仅获取上述基线提交不包含修复。
后续代码变化须更新记录中的提交和工作区状态，不沿用旧哈希声称已验收。
本轮未改变服务模板；已有安装在程序更新到位后重启 App Server 加载桥代码，不因这两项
修复要求重装服务。服务定义或安装路径另有变化时遵循用户指南。

## 已有证据

以下 Linux 运行结果产生于本轮同一会话、上述两文件内容下；未运行模型请求、未连接用户
现有服务或会话。桥使用真实 CLI 0.163.0、隔离 Codex Home、任务专用 Supervisor 与 Unix
Transport，客户端是交互式 WebSocket 客户端，不是 Windows Desktop 或 Windows Proxy。
原始输出保留在本轮会话工具记录，下面摘录结果；没有另存独立原始日志文件。

| 观察 | 实际输出或结果 | 范围 |
| --- | --- | --- |
| 桥到真实 App Server | `initialize` 返回 `codex_cli_rs/0.163.0`；`config/read` 返回隔离配置 | 基础 RPC 转发 |
| 连接持租约 | `leases [ 'openai' ]` | 目标实例租约 |
| 错误令牌 | `invalid token HTTP 401` | 认证拒绝 |
| 未知 Provider | `unknown provider HTTP 400` | 目标选择拒绝 |
| 二进制帧 | `desktop close code 1003`，随后租约 `[]` | 非法帧拒绝与断开清理 |
| 带连接并发及重复关闭桥 | 连接以 `1012` 关闭；`stopped`；租约 `[]` | 正常停止的幂等性 |
| 桥停止后的共享进程 | `owned server still running true` | 桥不终止 App Server |
| 隔离资源收尾 | 自有 App Server 退出码 `0`；Socket 不再可用；临时目录已删除 | 无遗留任务资源 |
| 静态检查 | `npm run check`、`npm run lint`、`node --check runtime/desktop-app-bridge.mjs`、`git diff --check` 通过 | 工作流结果，不替代功能验收 |

首次沙箱内启动被 Codex 固定 UDS 目录校验拒绝；随后经受支持的权限提升完成上述隔离观察。
没有修改固定目录权限或访问其中的用户服务。

2026-10-18 补充执行公开 CLI 路径：`app --help`、`app status --help`、
`app enable --help`、`app disable --help` 及对应的 `-h` 均正常显示帮助；Linux 上 `app` 明确报告
“Codex Desktop App 共享当前只支持 macOS 与 Windows”；端口 `0` 和重复 `--provider`
参数返回用法错误。这些拒绝发生在配置读取及服务操作之前。
文档完成后，`npm run docs:check` 与 `git diff --check` 通过；修复文件哈希与上表一致。

尚未在当前环境观察：Windows CIM/PowerShell 实际分支、Windows Proxy 无法终止后的清理
重试、异步工厂与关闭的竞态、macOS 签名 Host 与 Desktop UI。不得把正常断连结果写成
这些故障分支已实测。当前 Linux 没有 `pwsh` 或 macOS Desktop。

## 开始前记录

macOS、Windows 分别填写一份，主实例与隔离/聚合实例分别标结果。操作使用专门的验收
Workspace 和无敏感内容的 Thread；所有重启、禁用步骤先完成或停止已有任务。

| 项目 | macOS | Windows |
| --- | --- | --- |
| 日期与操作者 | 待填 | 待填 |
| 系统版本与架构 | 待填 | 待填 |
| Desktop 完整版本/构建号 | 待填 | 待填 |
| `codex --version` | 待填 | 待填 |
| `node --version` | 待填 | 待填 |
| PowerShell 版本 | 不适用 | 待填，要求 7 |
| 源码提交、是否包含上述修复 | 待填 | 待填 |
| 实际 `codexc` 安装位置 | 待填 | 待填 |
| 主 Provider、选定 Provider | 待填 | 待填 |
| 初始共享开关、各服务状态 | 待填 | 待填 |
| 本次使用的渠道与验收 Workspace 别名 | 待填 | 待填 |

两平台都先执行：

```text
codex --version
node --version
codexc app status --json
codexc status appserver
codexc status gateway
```

macOS 用 `sw_vers`、`uname -m`、`command -v codexc` 补充环境信息；Desktop 构建号从
“关于”页面记录。Windows 在 PowerShell 7 中用以下只读命令补充：

```powershell
$PSVersionTable.PSVersion
Get-Command codexc | Select-Object Source
Get-AppxPackage -Name OpenAI.Codex | Select-Object Name, Version, Architecture
```

不要把完整配置、凭据、带令牌 URL 或启动环境贴进记录。状态 JSON 中的个人路径也应脱敏。

## 两平台共同验收顺序

每项填写“通过 / 失败 / 未执行 / 不适用”，并注明实际行为；依赖条件不满足时停止该分支，
不反复重启碰运气。先完成主 OpenAI，再对已配置的单个 Provider 和 `agg` 重复相关步骤。

| 编号 | 操作 | 通过依据 |
| --- | --- | --- |
| C1 | 完全退出 Desktop，执行 `codexc app` | 已启用时直接启动；首次启用时出现确认且默认拒绝。App 内能实际使用，不能只记命令成功 |
| C2 | Desktop 仍运行时再次执行 `codexc app` | 明确要求退出，不强制结束进程或重启服务 |
| C3 | Desktop 新建验收 Thread，发送一个唯一的无敏感标记；在同 Provider 的渠道中选中该 Thread，发送第二个标记 | 两端对应同一 Thread ID，能看到并继续同一段上下文；记录双向显示情况 |
| C4 | 渠道另建验收 Thread，完成一轮后从 Desktop 打开并续接 | 反向发现与续接成立，记录结果是否自动出现、是否需要手动打开或刷新 |
| C5 | 在验收 Thread 发起短任务，观察另一端；再通过支持取消的入口停止 | 事件、最终状态和取消结果一致，没有重复启动同一轮 |
| C6 | 在会触发审批的既有权限设置下请求验收 Workspace 内的无害操作，选择拒绝；有需要再单独确认允许路径 | 发起端出现实际审批、拒绝不执行、允许结果可见。没有触发审批则记未覆盖，不改全局策略凑结果 |
| C7 | 查看 App 内 MCP 状态，并在专用验收任务中明确调用一个 `codex_app` 只读工具 | 记录准确工具名、成功结果和时间；普通 shell 工具成功不算内置工具通过 |
| C8 | 完全退出 Desktop，再执行 `codexc app`，打开已有验收 Thread 续接；重复两次 | 能重新连接且保留历史，旧 Host 租约不持续阻塞。实例可按空闲策略释放，不要求一直运行 |
| C9 | 无活动任务时保持 Desktop 打开，执行 `codexc restart gateway` | Desktop 当前共享连接和后续会话不因 Gateway 重启丢失 |
| C10 | 无活动任务时执行 `codexc restart appserver` | 分别记录自动恢复情况；若必须退出后重新 `codexc app`，记为人工恢复，不能记自动恢复通过 |
| C11 | 退出 Desktop，执行 `codexc app --provider <已配置ID>`；之后退出并用无参数 `codexc app` | 所选实例实际可用；无参数回到主实例，不沿用上次选择。不要在跨 Provider 旧 Thread 上证明转换成功 |
| C12 | 满足聚合前提时退出 Desktop，执行 `codexc app --provider agg`，新建验收 Thread，依次使用两个成员模型 | 目录显示预期成员、模型选择和回复成立；另记内置工具结果。只有一个成员则不适用 |
| C13 | 记录初始设置后，在停机窗口退出 Desktop，执行 `codexc app disable`，检查状态，再按原设置启用 | 禁用/恢复有明确结果；Thread 历史仍在。Windows 曾使用自定义端口时恢复原端口 |

`C3/C4` 使用渠道现有的 Thread 选择/续接功能，不直接编辑绑定或会话文件。
`C5/C6` 可能调用模型；由操作者在本机明确执行。本轮 Linux 观察没有覆盖模型响应和外部消息。
`C13` 是可选维护阶段，不能为补记录打断正在使用的服务。已启用环境无须为了 C1 强制恢复首次状态。

## macOS 专项

- 启动前、打开后、退出后分别记录 `codexc app status --json`。选定实例对应的
  `desktopAppProvider` 和 `toolHostAttached` 用于判断租约，工具结果仍以 C7 为准。
- 无活动任务时，用 `codexc remote` 连接目标实例并保持打开，在另一终端运行 `codexc app`：
  应因原生客户端租约拒绝。退出 Remote 后重新启动应能继续；不要强杀客户端。
- 可在专用任务实际运行期间尝试启动，确认活动 Thread 会阻止会重启目标实例的 Host 附加。
  如果任务已结束，记录为未覆盖，不把启动成功判错。
- 如工具失败，记录错误类别与版本组合，例如 `untrusted-process-ancestry`、
  `missing-code-signing-identity` 或 Pipe closed。保留本机日志，公开记录不包含 Pipe 完整路径。
- `codexc app enable --port 47821` 应拒绝端口参数，且不进行启用/服务重启。

2026-10-08 的工具失败是特定历史组合的记录，不推断当前组合仍失败；本次成功记录补齐后，
按实际版本新增结论，保留历史事实。

## Windows 专项

- 确认使用当前用户安装的 `OpenAI.Codex` 包以及 PowerShell 7。包版本、CLI 版本分别记录。
- 启动前、打开后、退出后记录状态。`running` 为 `null` 时必须先解决探测问题，不能将其
  当成已退出；不通过结束未知进程来绕过门禁。
- 正常启动后确认 C3/C4，而不是以桌面窗口出现或桥端口可连接作为成功依据。
- 重复 C8，检查没有持续增长的本次 Desktop Proxy 残留。用任务管理器核对进程路径和父进程，
  不按通用进程名批量结束 Node/Codex。
- 若自然发生包内可执行文件缺失、CIM 路径不可读或 Proxy 清理失败，保留脱敏结果并停止该分支。
  不修改真实安装包、进程权限或安全软件来制造故障；未遇到则注明仅代码审查覆盖。
- 睡眠/唤醒、Windows 重启、Desktop 更新属于后续恢复验收，分别记录，不用一次冷启动代替。

## 记录与故障交接

每个 Provider 复制一张表，并在表前填写 Provider ID。没有执行的项保持未执行，不留空白
或只写“全部正常”。证据栏注明平台、实际行为和是否需要人工恢复。记录保留在本页，
较大的截图/日志仅保存脱敏摘录或受控本机位置。

本表 Provider：待填。

| 编号 | 内容 | macOS | Windows | 实际行为与脱敏证据 |
| --- | --- | --- | --- | --- |
| C1 | 启动并实际使用 | 未执行 | 未执行 | 待填 |
| C2 | 拒绝重复启动 | 未执行 | 未执行 | 待填 |
| C3 | Desktop → 渠道续接 | 未执行 | 未执行 | 待填 |
| C4 | 渠道 → Desktop 续接 | 未执行 | 未执行 | 待填 |
| C5 | 事件与取消 | 未执行 | 未执行 | 待填 |
| C6 | 审批拒绝/允许 | 未执行 | 未执行 | 待填 |
| C7 | codex_app 实际调用 | 未执行 | 未执行 | 待填 |
| C8 | 两次退出重开 | 未执行 | 未执行 | 待填 |
| C9 | Gateway 重启 | 未执行 | 未执行 | 待填 |
| C10 | App Server 重启恢复 | 未执行 | 未执行 | 待填 |
| C11 | Provider 选择不持久化 | 未执行 | 未执行 | 待填 |
| C12 | 聚合成员切换 | 未执行 | 未执行 | 待填 |
| C13 | 禁用并恢复原设置 | 未执行 | 未执行 | 待填 |
| 专项 | 分别展开平台专项 | 未执行 | 未执行 | 待填 |

故障时先记录发生时间、操作、预期与实际结果，再收集：

```text
codexc app status --json
codexc status appserver
codexc logs appserver -n 100
```

不要反复 enable、重装或清空配置/会话文件。连接失败和内置工具失败分别报告；需要恢复时
先结束活动任务、完全退出 Desktop，再按已确认配置执行 `codexc app`。服务确实需要重启时
显式使用 `codexc restart appserver`；保留重启前证据。

验收完成后，结论至少写明：平台、Desktop/CLI 版本、Provider、基础共享是否通过、工具是否
通过、恢复是否自动、剩余未执行项。将对应摘要同步到
[实现与验收状态](codex-desktop-app-development.md#实现与验收状态)，不要把一个平台的通过推广到另一个。
