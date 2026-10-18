# codexc app 跨平台验收与交接

更新日期：2026-10-18。

操作者已明确确认：**当前 `codexc app` 可以使用，只是尚未记录验收过程**。本轮任务是补齐
macOS 和 Windows 的实际版本、操作结果及恢复记录，不把“缺少记录”解释为“不能使用”。
验收开始时的可用反馈尚未细分平台、Provider 和内置工具范围；本页后续记录已补齐 macOS
主实例的实际结果，Windows 和其他未执行项由操作者具备对应条件后填写。

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

上述 Linux 阶段尚未观察：Windows CIM/PowerShell 实际分支、Windows Proxy 无法终止后的清理
重试、异步工厂与关闭的竞态、macOS 签名 Host 与 Desktop UI。不得把正常断连结果写成
这些故障分支已实测。当时的 Linux 环境没有 `pwsh` 或 macOS Desktop；后续 macOS 观察见下方记录。

## 开始前记录

macOS、Windows 分别填写一份，主实例与隔离/聚合实例分别标结果。操作使用专门的验收
Workspace 和无敏感内容的 Thread；所有重启、禁用步骤先完成或停止已有任务。

| 项目 | macOS | Windows |
| --- | --- | --- |
| 日期与操作者 | 2026-10-18，Codex 代理无人值守；约 05:00–05:06 PDT | 待填 |
| 系统版本与架构 | macOS 15.8.1，24H32，arm64 | 待填 |
| Desktop 完整版本/构建号 | ChatGPT 26.1013.40934 / 20770；读取 `/Applications/ChatGPT.app/Contents/Info.plist`，未打开“关于”页 | 待填 |
| `codex --version` | `codex-cli 0.163.0` | 待填 |
| `node --version` | `v24.19.0` | 待填 |
| PowerShell 版本 | 不适用 | 待填，要求 7 |
| 源码提交、是否包含上述修复 | `fix/codexc-app-acceptance`，`23f9907578213e75ee302498b341031bc38c359e`；包含修复，开始时工作区干净 | 待填 |
| 实际 `codexc` 安装位置 | `~/.local/share/fnm/node-versions/v24.19.0/installation/lib/node_modules/@hegenai/codexc/bin/codexc.mjs`；本地工作树构建的 npm 全局包，非工作树链接 | 待填 |
| 主 Provider、选定 Provider | 主实例 `openai`；监管登记 `ds-main`、`clp-main`、`codexc-aggregate`，未启动验收它们 | 待填 |
| 初始共享开关、各服务状态 | 共享已启用；App Server running PID 66366，Gateway running PID 66381，WebUI running PID 66409，Relay missing；Desktop 未运行、无 Host 租约 | 待填 |
| 本次使用的渠道与验收 Workspace 别名 | 未使用渠道、未创建验收 Thread；只读核查本机及主实例 | 待填 |

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

### 2026-10-18 macOS 无人值守核查

本次补齐环境、安装来源与安全前置条件；**未完成当前版本 Desktop 的功能验收，也未确认新的
Desktop 功能故障**。用户关于当前可用的反馈保持有效，不能把下面的未执行项解释为不可用。
本次原始输出保留在会话工具记录中；没有另存含配置或会话内容的日志。

安装核对结果：

- `command -v codexc` 指向 fnm multishell 的命令入口，解析符号链接后为上表 npm 全局包。
  安装包版本是 `0.163.0`，`codexc-source-install.json` 记录来源为当前仓库、`managed: false`。
  版本号和来源路径都不能证明已经安装当前 HEAD。
- 对 `bin/`、`runtime/`、`scripts/` 中 Git 跟踪且安装包内存在的 467 个文件逐字节比较，只有
  `runtime/desktop-app-bridge.mjs` 和 `scripts/windows-desktop-app-inspect.ps1` 不同。
  源码两文件哈希与本页交接表一致；已安装文件 SHA-256 分别为
  `c465e47a12f4616c0356f4078d6c3a2eb8b539efbb0baf021ddd5c42ebeb91cb`、
  `87bf3fb7cf814bc0e9314ccee9464b243963ed969dd86a3c9b2302e2e3ae202c`。
  差异正是交接修复，说明全局包尚未包含它们；此比较不覆盖 `dist/` 或 WebUI 构建产物。
- 读取 App Server 和 Gateway 的 launchd `ProgramArguments`，均引用上述全局包及 fnm
  `v24.19.0` Node，未引用源码入口。没有执行安装或重启，不能声称运行服务已加载交接代码。
- 根据[本地工作树安装与部署](source-install.md#本地工作树安装与部署)，更新需要先记录服务状态、
  停止 WebUI 和核心服务，再运行 `npm run install:global`，随后按原状态恢复。
  本次主实例有活动 Thread，未进入这一停机窗口；没有使用 `codexc update` 拉取其他分支。

实际观察与边界：

| 项目 | 结果 | 实际输出与解释 |
| --- | --- | --- |
| 交接分支及提交 | 通过 | HEAD 等于交接提交，祖先检查退出码 0；无需 fetch 或切换 |
| 已安装 CLI 与源码 CLI 的只读 Desktop 状态 | 通过 | 两者均为 `configured: true`、`running: false`、`primaryProvider: openai`、`primaryInstanceState: running`、`toolHostAttached: false`、`desktopAppProvider: null` |
| 兼容入口与 Host 能力 | 仅状态观察 | `compatible: true`、`toolHostSupported: true`、`providerSelectionSupported: true`；不代表 UI 或工具通过；macOS 的 `bridgeReady: false` 不用作故障判断 |
| 监管状态只读查询 | 通过 | `status: ready`，`runningProviders: [openai]`，`leasedProviders: []`，`desktopAppAttached: false`；没有获取或释放业务租约 |
| 活动任务安全检查 | 通过，发现活动任务 | 通过现有 `CodexAppServerClient.countActiveLoadedThreads()` 查询真实主实例，输出 `{"provider":"openai","activeLoadedThreads":1}`；未输出 Thread 内容或 ID；随后关闭本次查询连接 |
| macOS 端口参数拒绝 | 通过 | 全局 `codexc app enable --port 47821` 和源码 `node bin/codexc.mjs app enable --port 47821` 均退出 1，提示 `--port 仅用于 Windows Desktop 共享桥；macOS 使用受管 stdio，无需设置端口`；未执行启用或重启 |
| 服务保留 | 通过，仅状态观察 | 查询结束后 App Server、Gateway、WebUI 仍为相同 PID，Relay missing；没有将该结果记为服务重启或 Desktop 退出后的独立性验收 |

活动查询首次受沙箱限制，`lstat /private/tmp/codex-daemon-501` 返回 EPERM；经支持的权限提升
执行相同只读查询后成功。`codexc work list` 在配置权限维护的 `chmod` 处返回 EPERM，没有重试或
修改配置；这不是 Workspace 或 Desktop 功能故障证据。`codex --version` 也伴有无法创建 PATH
别名的沙箱警告，但成功返回版本。

在活动数尚未确认前，源码 Desktop 启动命令被自动审批审查拒绝，命令未执行；理由是启动可能
短暂重启共享 App Server，尚无空闲证据。后续只读查询确认 1 个活动 Thread，因此未重新尝试
启动，也未停止、取消或中断该任务。未实际触发启动命令的活动 Thread 拒绝路径，不能把安全
检查结果写成该门禁已实测。

桌面自动化 `cua.getState()` 两次均在初始化阶段失败；第二次诊断为
`node_repl kernel exited unexpectedly`，stderr 为 `Codex Desktop App 受管入口只接受 macOS App Server 连接`。
本次没有可用 UI 观察，没有启动额外桥接、修改工具环境或改变签名链。该结果只说明本会话的
自动化入口不可用，未确定根因，不归类为当前 Desktop 共享或 `codex_app` 调用故障。

本轮 Provider：`openai`。Windows 全部未执行，当前没有 Windows 实机环境。

| 编号 | macOS 结果 | 未观察内容与原因 |
| --- | --- | --- |
| C1 | 未执行 | 启动被自动审批拒绝，后续确认活动 Thread；安装更新也需要停机窗口，未打开 Desktop |
| C2 | 未执行 | Desktop 当前未运行，未制造重复启动条件 |
| C3 | 未执行 | 未确认真实渠道消息目标，未新建验收 Thread 或发送消息；主实例启动前置未完成 |
| C4 | 未执行 | 同 C3，没有渠道到 Desktop 的实际续接观察 |
| C5 | 未执行 | 未启动专用短任务或取消现有任务；无事件与取消 UI 观察 |
| C6 | 未执行 | 未触发实际审批，未改变审批策略或替用户作允许决定 |
| C7 | 未执行 | 无 Desktop UI/MCP 状态观察，无明确命名的 `codex_app` 工具调用；shell 和状态查询不替代此项 |
| C8 | 未执行 | 未打开或退出 Desktop；初始无 Host 租约不能证明退出清理或两次重开通过 |
| C9 | 未执行 | 有活动任务，未重启 Gateway；不能据服务 running 推断独立性验收通过 |
| C10 | 未执行 | 有活动任务，未重启 App Server；自动恢复与手动重开均未观察 |
| C11 | 未执行 | 已登记 `ds-main`、`clp-main`，但主实例验收前置未完成，未切换 Provider |
| C12 | 未执行 | 已登记聚合实例，未启动、未调用成员模型或内置工具，不记为不适用或通过 |
| C13 | 未执行 | 可选停机维护；保留原共享开关与服务，不禁用或重新启用 |
| macOS 专项 | 部分完成 | 状态和端口拒绝已观察；Remote 租约拒绝、活动 Thread 启动门禁、签名 Host 实际附加、退出清理均未执行 |

后续先确认所有活动任务结束并具备可操作的 Desktop UI，按文档安装交接包、复核两文件哈希和
服务加载状态，再从主 OpenAI 的 C1 开始。C3/C4 还需明确允许发送测试消息的本人渠道与验收
Workspace。Windows 仍需独立记录系统、Desktop 包与 PowerShell 7 版本，完成 C1–C13、
进程 unknown 识别、Proxy 清理及恢复专项；Linux 与本次 macOS 只读结果不能代替这些观察。

### 2026-10-18 macOS 更新后续验收

用户随后确认已停止全部服务并完成更新。本节时间采用北京时间（UTC+8），与上节 PDT
相差 15 小时；平台、Desktop `26.1013.40934 / 20770`、CLI `0.163.0`、Node `v24.19.0`
及源码 HEAD 未变。保留上节作为更新前事实，本节覆盖安装和可执行项目的最新结论。

#### 安装、启动与真实会话

- 重新解析全局 `codexc`，仍为同一 fnm npm 全局包。两项交接修复的 SHA-256 均与源码一致；
  对共同存在的 467 个 `bin/`、`runtime/`、`scripts/` 跟踪文件逐字节比较，差异为 `[]`。
  更新由用户完成，本轮代理未重复安装。两份上轮文档修改保留，未提交。
- 初始 `codexc status all` 显示服务 `missing`，三个 launchd plist 文件实际仍存在；
  不将此状态解释为配置文件被删除。`codexc start appserver` 成功并确认就绪（1.04 秒），
  主实例只读活动 Thread 数为 0，随后执行 `codexc app`。
- 20:23 左右打开 Desktop，真实进程 PID 69537；有权限的 `app status --json` 返回
  `running: true`、`desktopAppProvider: openai`、`toolHostAttached: true`。
  再次 `codexc app` 明确拒绝：`请先完全退出 ChatGPT Desktop App 后再继续`。
- 沙箱内状态曾返回 `running: false`，同一运行状态经权限提升查询和真实进程核对为 `true`；
  本节进程结论使用有权限的结果。沙箱内重复启动命令在 `chmod` 处被 EPERM 拒绝，不作为
  C2 证据；提升后的重复启动拒绝才是本轮 C2 观察。
- `cua.getState()` 仍初始化失败。改用系统辅助功能操作本轮 Desktop 窗口后完成实际 UI 路径，
  没有创建新桥或改动系统隐私权限。截取窗口时系统弹出 Ghostty 屏幕录制权限提示，未代用户
  允许；后续依赖辅助功能读取。打开项目选择器实际显示“创建项目”，已取消，未创建项目配置。
- 20:27，在 Desktop 新建“返回验收标记”会话，请求不读写文件、不调用工具、不发送外部消息，
  只回复 `CODEXC-MAC-20261018-2033-A`。UI 实际显示完全相同的回复。
  只读查询共享主实例的已加载 Thread 元数据，匹配到
  `01a14efa-ded4-7852-96a8-9c101abbe783`，状态 `idle`；Desktop 自动选择的工作目录为
  `~/Documents/Codex/2026-10-18/openai-desktop-codexc-mac-20261018-2033`。
  没有配置渠道 Workspace、复制历史或读取内部 session 文件。

#### 当前内置工具故障

本次首次确认**当前版本、主 OpenAI 的基础会话可用，但 `codex_app` 启动失败**，并非套用历史失败。
20:28 的 UI 回复表示无法确认可用的 `codex_app` 只读工具，单独这条模型回复不作为根因证据。
随后针对上述精确 Thread 查询官方 `mcpServerStatus/list`，实际得到：

```text
name: codex_app
runtimeStatus: failed
tools: []
toolsError: MCP startup failed: Mcp error: -32603: Codex app tools pipe closed
```

本轮 PID 69537 的 Desktop 日志
`~/Library/Logs/com.openai.codex/2026/10/18/codex-desktop-3a3fa5ff-825c-4b3b-b9ed-ed7205e52de4-69537-t0-i1-122340-0.log`
在 `2026-10-18T12:23:47.646Z` 记录
`dynamic_app_tools_peer_rejected reason=untrusted-process-ancestry`，
`12:23:48.121Z` 随后记录 `Codex app tools pipe closed`；验收 Thread 启动时也出现同类拒绝。
仅提取本次进程日志的时间和错误类别，没有记录 Pipe 完整路径、环境或工具消息。

核查入口和资源归属：`desktop-app-proxy.mjs` 接收 Desktop 的工具开关与 Pipe，取得 Supervisor
Host 租约；`desktop-app-host.mjs` 验证私有 Socket、签名 Node 和锁定 CLI，签名 Node 托管
共享 CLI。实际进程树为 Supervisor 69439 → Desktop 签名 Node 69592 → Codex 69594。
Host 附加成功，失败发生在 Desktop 的工具对端信任链校验，继而 MCP 无工具可调用。
日志未确定具体哪个祖先进程或哪条私有规则被拒绝，因此不能提出已经证实有效的最小代码修复。
按开发文档停止条件，不修改应用包、签名、Pipe 转发、CLI 基线或审批策略，也不重复启用试错。
本轮没有完成任何明确命名的 `codex_app` 实际调用，C7 失败于调用前的 MCP 启动阶段。

#### 服务独立性与恢复

- `codexc start gateway` 成功（3.40 秒）。在只读确认活动 Thread 为 0 后执行
  `codexc restart gateway`，总耗时 3.68 秒；App Server 监管 PID 69439 与签名 Host PID
  69592 均未变，Desktop 仍运行、Host 仍附加；随后前述真实标记回复成功。
- 再次确认活动 Thread 为 0 后执行 `codexc restart appserver`，总耗时 1.49 秒，新监管 PID
  71401。Desktop 保持运行，状态先后两次显示 `toolHostAttached: false`、
  `desktopAppProvider: null`。通过 UI 尝试发送 `AUTO-RECOVER` 请求，重开前没有观察到对应
  回复，后续辅助功能枚举也未找到输入框；不能仅凭点击成功声称请求已提交或自动恢复成功。
- 正常退出 Desktop 后，确认 `running: false`、Host 未附加、共享 App Server PID 71401
  仍运行；重新执行 `codexc app`，Host 恢复附加，打开原“返回验收标记”会话。
  重开后才观察到 `CODEXC-MAC-20261018-2033-A AUTO-RECOVER`；另发人工恢复请求后，
  实际回复 `CODEXC-MAC-20261018-2033-A MANUAL-RECOVER-1`，只读确认原 Thread ID 不变、
  活动数为 0。因此本轮确认人工重开恢复，未证明自动恢复；没有重放协议请求或迁移历史。
- 第二次正常退出后，明确观察 `running: false`、`toolHostAttached: false`、
  `desktopAppProvider: null`，App Server PID 71401 仍运行。再次 `codexc app` 并打开同一
  验收会话，实际回复 `CODEXC-MAC-20261018-2033-A MANUAL-RECOVER-2`。
  两次重开后均保留上下文并能继续，正常 Host 清理未持续阻塞启动；这不覆盖清理失败重试分支。
- 取消专项在同一 Thread 发起仅输出 `CANCEL-CHECK` 数字行的任务。动态内容生成期间，
  系统辅助功能的“停止”按钮枚举长时间未完成，未获得实际点击结果；终止本任务所属的
  osascript 枚举进程（退出 143），避免迟到点击，不结束 Desktop 或共享服务。
  官方 `thread/turns/list` 的最新摘要确认 Turn
  `01a14f04-893d-7863-a6a3-d12d9e9b062b` 正是该请求且 `inProgress`，随后通过现有 Client
  的 `turn/interrupt` 仅取消此轮。读回同一 Turn 为 `interrupted`，主实例活动 Thread 数为 0。
  这是后端取消证据，不是 Desktop 停止按钮成功，也未观察另一渠道展示；不把自动化枚举迟滞
  直接归因于 Desktop 产品故障。

#### 本轮范围与剩余条件

| 编号 | 主 OpenAI 最新结果 | 范围与限制 |
| --- | --- | --- |
| C1 | 通过 | 更新后真实 Desktop 回复唯一标记，共享主实例可读到同一验收 Thread |
| C2 | 通过 | 真实进程运行期间明确拒绝重复启动 |
| C3/C4 | 用户确认通过（此前实测） | 用户确认飞书交互此前测试无问题并同意验收通过；本轮未重新取得双向同 Thread ID、标记及显示行为证据，详见用户交互补录 |
| C5 | 部分完成 | 后续用户实际点击 Desktop 停止按钮，UI-CANCEL 对应 Turn 读回 interrupted、Thread idle；本机取消通过，渠道事件一致性仍未覆盖，见用户交互补录 |
| C6 | 未执行 | 未触发实际审批，不修改全局策略制造弹窗；审批拒绝/允许均未覆盖 |
| C7 | 失败 | 当前 Thread 的 MCP 启动失败、工具为空；Desktop 日志确认祖先链拒绝，未发生具名工具调用 |
| C8 | 通过 | 两次正常退出重开并继续原 Thread，标记与历史保留 |
| C9 | 通过，限本机基础会话 | Gateway 重启未替换共享监管及签名 Host；随后 Desktop 实际回复成功；不覆盖渠道另一端显示 |
| C10 | 人工恢复通过；自动恢复未通过验收 | 服务就绪后未观察自动恢复回复；退出重开后回复并能继续；自动恢复请求的实际接收时间未确认 |
| C11/C12 | 未执行 | 已配置单 Provider 与聚合，但主实例工具路径触发信任链停止条件，未扩大到其他实例启动和模型请求；不将主实例结果推广到它们 |
| C13 | 未执行 | 可选停机维护未做，保持共享配置，不为补记录反复 enable/disable |
| macOS 专项 | 部分通过 | Host 附加、重复启动拒绝、正常退出租约清理及 Remote 租约拒绝与释放后重开均已观察；活动 Thread 启动拒绝、清理失败分支未制造或执行 |

Windows 实机仍未执行。当前确认的内置工具故障需要明确的上游可接受启动合同及私有校验原因，
不能用正常会话回复、签名验证通过或 Host 租约附加掩盖。未做代码修复，保留当前基础会话能力。

20:41 收尾状态：App Server running PID 71401、Gateway running PID 70335，Desktop
running、OpenAI Host 已附加；WebUI 和 Relay 的状态为 missing，本轮未启动它们。
最后一次权威活动查询为 0，验收 Thread 和结果保留。临时窗口截图已删除；没有提交、推送、
修改测试、系统隐私权限或账号配置。文档检查及 `git diff --check` 通过，仅表示文档工作流状态。

### 2026-10-18 20:55 继续核查与 Remote 租约专项

版本、源码与安装状态沿用前节，三个文档的已有修改保留。本轮没有再次调用模型或修改实现。

#### Remote 租约拒绝通过

1. 官方 Client 只读查询主实例活动 Thread 数为 0，正常退出本轮 Desktop；有权限的状态查询
   确认 `running: false`、`toolHostAttached: false`。
2. 通过真实 PTY 执行 `codexc remote -C <仓库目录>`，出现官方 Codex `v0.163.0` TUI。
   未输入模型任务；此客户端产生的 Thread 为 `01a14f14-736c-7370-b3e0-a0ef56c23400`，未删除。
3. Remote 保持连接时执行 `codexc app`，实际拒绝：
   `Provider openai 的 App Server 正由原生客户端租约保护；请退出相关客户端后重试`。
   App Server 监管 PID 仍为 71401；没有进入 Desktop Host 附加阶段。
4. 发送 Ctrl-D 正常退出本任务 Remote，退出码 0，未强杀。再次执行 `codexc app`，
   启动预检确认无活动 Turn，启动请求成功；随后状态为 Desktop running、OpenAI Host 已附加。
   因此 Remote 租约存在时拒绝、退出后释放并允许 Desktop 重新打开均已实测。

本项已同步至前节最新结果表；更新前的未执行记录保留，活动 Thread 启动拒绝仍未执行。
20:55 收尾仍为 App Server PID 71401、Gateway PID 70335、Desktop 运行，WebUI/Relay missing。

#### 工具失败进一步定位及修复边界

- 当前机器不存在 `upstream/openai-codex-0.163.0`，因此只读访问官方固定提交的文件树及相关
  Issue，没有下载、切换或更新上游。固定树的目标文件名检索未定位到私有 peer-authorizer
  实现；这不是对整份源码内容的完整审查。
- 对安装包使用只读字符串提取，确认当前 `app.asar` 的动态工具 Pipe 调用共享 Socket
  authorizer，macOS packaged 路径加载 `native/browser-use-peer-authorization.node` 并调用
  `authorizeSocketPeer`。原生模块包含祖先链及签名错误类别、peer/parent/grandparent 标识，
  但字符串本身不证明精确允许规则。本轮没有加载调用该私有模块、伪造 peer 或改变校验设置。
- `codesign -dv --verbose=4` 确认随包 Node 为 `Identifier=node`，项目锁定原生 CLI 为
  `Identifier=codex`，两者 `TeamIdentifier=2DC432GLL2`。随包 `codex-app-tools` 启动脚本优先
  `exec CODEX_MCP_NODE_PATH`；本项目 Host 设置该路径为随包签名 Node，并将 `CODEX_CLI_PATH`
  设为锁定原生 CLI。已有证据支持“Host 附加成功后，工具对端因祖先链拒绝”，不能将签名匹配
  误写成整个进程链已获信任；仍不知道具体哪个节点或哪条私有规则不满足。
- 发现独立的 Node REPL 入口冲突线索：当前 `app.asar` 运行时解析读取启动环境中的
  `CODEX_CLI_PATH`，Node REPL 配置构造器再将它传入运行时；项目 Desktop 启动把该变量设为
  `desktop-app-proxy.mjs`，而 Proxy 只接受含 `app-server` 的调用。此前 CUA 初始化的真实
  stderr 正是 Proxy 的入口拒绝。这条数据流与错误吻合，但未捕获失败子进程的完整参数，
  也没有验证独立修复；不能据此声称解决了 `codex_app` 的原生祖先链拒绝。
- 不能简单把 Desktop 的 `CODEX_CLI_PATH` 改成原生 CLI：它同时是共享 App Server 的启动
  选择入口，修改会改变既定连接行为。也没有把 Proxy 放宽为任意命令转发来掩盖缺少的入口
  合同。若继续实现，须分别明确 App Server 入口、Node REPL 入口与工具 peer-authorizer 的
  受支持合同，并保持独立共享实例及当前审批边界。

2026-10-18 只读复核上游：[#47425](https://github.com/openai/codex/issues/47425) 与
[#48786](https://github.com/openai/codex/issues/48786) 仍开放、无评论；新的共享服务器浏览器
报告 [#54720](https://github.com/openai/codex/issues/54720) 也开放，两个评论分别为重复项提示
机器人和报告者的补充，没有维护者确认的修复合同。该报告使用 Desktop `26.1013.31256`，
不是本次构建，只作相关拓扑旁证。按精确 `untrusted-process-ancestry` 搜索公开 PR 返回 0；
这不证明其他措辞的 PR 或上游私有实现不存在修复。未写 Issue、评论或 PR。

### 2026-10-18 用户交互补录

用户提供 Desktop MCP 列表截图，`codex_app` 显示“已启用 / 不支持身份验证”。该列表不表示
运行时工具就绪，“不支持身份验证”也不等于认证失败或需要用户授权。随后用户转述模型查询
`ALL_TOOLS` 中 `mcp__codex_app__` 前缀匹配为 `[]`；本次没有发生实际工具调用，不新增调用
错误，也不单凭名称前缀匹配重新判断根因。此前精确 Thread 的 MCP failed 与 Pipe 拒绝证据保留。

用户在原“返回验收标记”Thread 发起 `UI-CANCEL` 纯文本生成任务，并亲自点击停止，反馈
“停止了”。代理仅通过官方 Client 读取最新轮次摘要及 Thread 状态，没有替用户再次取消：

| 项目 | 权威查询结果 |
| --- | --- |
| Thread | `01a14efa-ded4-7852-96a8-9c101abbe783` |
| Turn | `01a14f19-3892-7030-ac67-877d25054238` |
| 请求摘要 | 从 1 到 1000 逐行输出 UI-CANCEL，不调用工具，由用户点击停止 |
| Turn 状态 | `interrupted` |
| 开始 / 完成时间（Unix 秒） | `1792328415` / `1792328420` |
| Thread 状态 | `idle` |

因此 Desktop 本机停止按钮路径已通过用户操作及服务端状态双重确认，更新此前自动化未完成的
观察；C5 的另一渠道事件和最终状态一致性仍未执行，不将本项写成全部跨端取消验收通过。

用户随后明确：“这个可以验收通过，交互是没问题的，我之前测试过”。按当时飞书与 Desktop
交互验收语境，将 C3/C4 记为用户确认通过，证据来源是用户此前实测反馈，并非本轮代理重新
观察到双向续接；此前测试的具体版本、Thread ID 和时间未补充。不将此确认扩大到审批拒绝/
允许、跨端取消一致性、内置工具、其他 Provider 或 Windows。

保留本轮异常：21:01 用户截图显示发送 `/thread` 后收到“Gateway 未能完成请求”。此前代理
给错了命令；项目支持 `/sessions`、`/resume`，没有 `/thread` 会话选择命令。对应 Gateway
日志记录普通消息启动 Turn 失败，错误码 `rpc:-32600`；旧绑定 Thread 可读取但状态为
`notLoaded`。该 RPC 错误的根因尚未确认，不能仅以错误命令解释全部原因，也不能据此否定
用户此前交互通过。原 Desktop 标记 Thread 的自动创建目录不属于当前登记的 Workspace，
本轮未强行续接、修改绑定或添加配置。按用户确认停止重复交互验收，异常保留为未解决观察。

#### 21:05 搜索能力反馈

用户补充另一条交互记录：要求检查 MCP 搜索能力，界面显示工具 `Web run`，模型随后报告已用
`MCP Model Context Protocol official` 搜索并返回 MCP 官方博客等页面。将此记为搜索能力
可用的用户反馈；本轮代理未重复搜索，也未独立核对该次调用的原始返回、完整工具标识或所属
MCP Server，不能仅凭模型称其为“MCP 搜索工具”确定工具归属。

这条反馈没有展示明确命名的 `mcp__codex_app__…` 工具调用，不改变 C7 的结果。此前确认的
故障限定为验收 Thread 的 `codex_app` 启动失败，不能扩大为所有 MCP 或搜索工具不可用；
`Web run` 搜索成功与该内置工具启动失败可以同时成立。

### 2026-10-18 Linux 关联审查（暂停平台验收）

本轮沿用已提交的 macOS 结果，不重复 Desktop 验收。对启动入口的代码复核确认：
`scripts/desktop-app-command.mjs` 将 Desktop 的 `CODEX_CLI_PATH` 设置为
`scripts/desktop-app-proxy.mjs`；Proxy 只接受 macOS App Server 调用。Supervisor 的 Host
路径另将其子进程环境中的该变量设置为锁定的原生 CLI，不能据此推断 Desktop 自身的 Node REPL
环境也已修正。结合前述 macOS 安装包观察，这是入口复用冲突线索；本机没有该 Desktop 包和
失败子进程的完整调用参数，锁定 CLI 源码也没有这条私有 Node REPL 启动合同。
因此本轮未把 Proxy 放宽为任意 CLI 转发，未改变 Host 签名、工具 Pipe 或共享实例的归属；
Node REPL 初始化和 `codex_app` 祖先链拒绝仍分别作为未解决问题，不记为已修复。

渠道恢复链发现并修复独立缺口：`SessionRouter.ensure` 原先直接复用已有绑定，
`thread.closed` 不登记恢复；Thread 从 App Server 内存卸载后，绑定仍在，下一次 `turn/start`
会访问未加载 Thread。现先读取不含历史的权威快照并核对 Workspace 与允许来源，遇到
`notLoaded` 复用既有串行订阅恢复；Application 同步合并恢复期间的活动通知，成功后继续
同一次输入。要求空闲的操作遇到权威活动状态时拒绝执行，不在 Turn 请求失败后重发。
这修复了可复现的 `-32600` 原因之一，不能据此断定此前 macOS 飞书记录中的错误必定同源。

隔离真实 CLI `0.163.0` 的观察：卸载后的 Thread 直接 `turn/start` 返回
`-32600: thread not found`，没有执行模型请求。全新且从未材料化的空 Thread 恢复也被上游拒绝，
未将此误写成恢复成功。随后通过官方 `thread/name/set` 命名另一条任务自有 Thread，再卸载，
权威状态为 `notLoaded`；修复后的 `router.ensure` 返回相同 Thread ID、恢复回调为 `idle`，
回读也为 `idle`。进一步经 Application 的只读 `getGoal` 路径，同次调用从 `notLoaded`
恢复后返回 `null`（没有 Goal），回读为 `idle` 且绑定未变。没有模型请求、内部 Session 文件
读写或真实渠道消息；任务自有进程和临时目录已清理。新 Turn 的实际模型执行、macOS 飞书现场
故障是否同源以及 Windows 行为仍未观察。

提交前关联复核补齐失配清理的串行边界：工作区或来源不匹配时，先取得 Thread 生命周期锁，
再复核绑定与权威快照，之后才解除绑定和取消订阅，避免与其他本地恢复路径交错。
隔离真实 App Server 上将任务自有 Thread 绑定到另一任务工作区，`router.ensure` 实际返回
`thread.takeover.changed`，原绑定已移除，查询活动 Thread 数为 0；自有客户端与临时目录已清理。
此观察覆盖失配拒绝路径，不代表已运行并发交错场景；此前成功恢复路径的实现未变。

用户补充 macOS 飞书“释放占用”返回平台不支持。关联追踪确认该按钮执行只读 `/release`，
Runtime 只实现 Linux 与 Windows 进程诊断；macOS 在锁文件存在时返回未知，不曾识别到真实
持锁进程，`/release force` 也不会在未知状态结束进程。本轮区分“平台不支持”和“诊断不可用”
的返回原因，修正三个渠道共用提示，不再将锁文件存在表述成已确认占用或直接建议重启服务。
未新增 macOS 强制释放能力，未结束用户进程，也未操作用户提供的 Session。

Linux 手动调用当前 Runtime，使用任务专用临时 Codex Home，实际观察：没有锁文件返回
`held: false`；创建无人打开的空锁文件后仍返回 `held: false`；将进程表入口指向不存在的目录
返回 `held: true, holder: null, reason: inspection-unavailable`，该内部保守值对外展示为未知。
临时目录随后删除。分别调用三个渠道共用的格式化入口，已观察两种原因生成不同提示，均说明
未执行释放且占用尚未确认；这不是飞书消息发送或 macOS 进程诊断实测。

### 后续验收记录模板

以下为空白模板，不代表上方已记录项目的最新结果。每个 Provider 复制一张表，并在表前填写
Provider ID。没有执行的项保持未执行，不留空白
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
