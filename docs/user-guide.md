# Codex Connect 使用指导

本文是 Codex Connect Gateway 的完整用户指导。根目录 [README.md](../README.md) 只保留安装入口、最短配置路径和常用链接；遇到具体问题时按本文或对应专题文档继续阅读。

## 1. 工作方式

Gateway 把 Telegram、飞书和微信消息接入本机 Codex App Server。`codexc remote` 连接的是同一个 App Server，因此原生 TUI 与聊天渠道共享 Thread、Workspace、模型提供商和实时运行状态。

App Server 是 Thread、Turn、Item 和会话历史的唯一事实来源。Gateway 只保存渠道与 Workspace 的最小绑定，不复制完整会话文件或消息正文。

## 2. 安装

项目不再发布新的 npm 版本。使用 Git 源码安装器构建并注册全局 `codexc` 命令；npm 仍用于依赖安装、本地打包和配套 Codex CLI 安装。

Linux/macOS：

```bash
curl -fsSL https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.sh | sh
```

Windows PowerShell 7：

```powershell
irm https://raw.githubusercontent.com/msola-ht/codex-channels/main/install.ps1 | iex
```

源码安装会构建项目并注册全局 `codexc` 命令。目录、代理、Windows ACL、源码更新和失败恢复见[源码安装与更新](source-install.md)。

## 3. 初始化与配置

在交互终端直接运行 `codexc` 打开主菜单，可进入初始化、接入、日常设置、工作区、后台服务、指标、清理、诊断，以及“运行与连接”中的 TUI、WebUI 和前台核心服务启动入口。交互菜单要求标准输入和标准输出均连接终端；输入重定向时，`config` 仅显示路径，`timezone` 仅显示当前时区。非交互终端无参数时显示帮助，显式子命令继续供脚本调用。

`codexc service` 无参数时可选择操作和目标；核心服务 `all` 仅包含 App Server 与 Gateway，WebUI 单独选择。菜单日志显示最近 100 行，持续跟随仍使用 `codexc service logs <目标> -f`。卸载后台服务需确认。

`codexc work` 菜单区分新建工作区、注册当前目录和注册已有目录；注册前显示实际目录并确认，不创建或删除已有目录。`codexc metrics` 菜单包含会话列表导出和历史额度窗口查询，清理与重置统一使用 `codexc cleanup`。上述操作菜单完成单项后可继续选择；“运行与连接”完成后返回该子菜单，退出后返回主菜单。Setup 和 Config 单项失败会显示错误并返回各自分类菜单，不自动重试写入。

```bash
codexc init
codexc setup
codexc config
```

Gateway 配置位于：

```text
~/.codex-connect/config.toml
```

`codexc setup` 是接入向导，管理模型 Provider、渠道和项目技能；`codexc config` 是日常设置入口，统一管理 Codex 新会话与用户偏好，以及 Gateway 显示、运行参数、代理、WebUI 和本地指标存储；工作区和服务操作分别使用 `codexc work`、`codexc service`。配置示例见 [`config.example.toml`](../config.example.toml)。

`codexc config` 的“计划任务”直接选择开关；Telegram 消息格式位于“显示设置”，仅在配置 Bot 后显示。显示子项取消或选择“返回上一级”时回到显示设置；在显示设置中选择“返回”才回到 Config。日志等级统一在“高级设置 → 日志等级”选择，`debug` / `trace` 开启调试信息，`info` 恢复标准输出。

`codexc setup` 要求标准输入与提示输出均连接终端；不满足时在初始化用户目录前报错。`setup --json` 仍需交互输入及终端 stderr，stdout 输出脱敏 JSON Lines，适合将操作结果重定向到文件，不是无人值守配置接口。

`codexc timezone` 设置模型可见时区，WebUI 同步跟随；网关默认也跟随，可用 `codexc timezone --gateway` 选择系统或自定义时区，细节见[`模型可见时区`](model-timezone.md)。

Telegram、飞书和微信至少启用一个。Telegram 需要 Bot Token 和允许用户；飞书需要应用凭据和允许的 `open_id`；微信需要扫码凭据、账号和允许用户，Setup 最终确认保存时会直接启用消息接收。

### 计划相关设置

在 `codexc config → Codex 新会话与用户偏好 → 计划清单工具` 中控制上游 `update_plan` 工具，默认关闭：

```toml
[tools.update_plan]
enabled = true
```

三个设置不要混淆：

| 设置 | 作用 |
| --- | --- |
| `tools.update_plan.enabled` | 模型是否拥有创建/更新待办清单的工具，默认关闭 |
| `display.plan_updates` | Telegram 与飞书是否把 `turn/plan/updated` 通知展示到渠道，默认开启 |
| `/plan` | 是否使用官方 Plan 协作模式 |

上游计划工具关闭时不会产生普通计划清单通知；`display.plan_updates` 不能替代它。修改后由新建或重新加载的 Codex Thread 读取；当前已加载的 Thread 保持不变，无需重启服务。

### TUI 空闲总结

在 `codexc config → Codex 新会话与用户偏好 → 空闲总结` 中控制 TUI 失去焦点后的自动回顾，默认写入关闭：

```toml
[tui]
auto_recap = false
```

关闭只影响自动回顾，手动 `/recap` 仍然可用；修改后由新启动的 TUI 读取，无需重启服务。

### 推理摘要

Codex 0.156.1 已停用模型人格：CLI 与 WebUI 不再提供人格选择，保存其他偏好不会改写配置中已有的 `personality`。

在 `codexc config → Codex 新会话与用户偏好 → 其他用户偏好` 中选择推理摘要。开发基线 0.156.1
在尚未配置时预选“关闭”，与配套 CLI 的新建本地 TUI 会话默认值一致；已有的显式选择继续保留。
不支持推理摘要的第三方 Provider 可能拒绝 `auto`、`concise` 或 `detailed`，遇到此类错误时
检查对应 Codex 配置或 Profile 的 `model_reasoning_summary`，显式选择 `none`。

### 渠道会话空闲自动解除

在 `codexc config → 系统设置 → 会话空闲自动解除` 中设置渠道会话自动解除 Thread 绑定的全局
空闲阈值，默认 15 分钟：

```toml
[conversation]
idle_release_minutes = 15
```

该值对 Telegram、飞书和微信统一生效，允许 0–1440 分钟，0 表示关闭。用户消息、平台本地命令、
审批与输入交互和任何带目标会话的输出都会刷新活动时间；正在恢复的 Thread 不会被同时释放。
Provider 断线期间也会跳过扫描。
连续达到配置的空闲时间且没有任何输入和输出时，Gateway 才会在确认 Thread、原生 Queue、审批和子代理都已
空闲后取消订阅并解除前台绑定；如果此时 Gateway 已没有任何前台或后台绑定、进行中的 Provider 操作或
启动任务，还会关闭全部 Provider Client，并在每 60 秒一次的空闲复检中停止全部未被租约占用的
App Server 进程（包括主实例），后续请求会自动启动并重连；`codexc remote` 持有租约期间对应实例
不会被停止。解除后
当前渠道会收到一次“自动解除占用”提示；若 60 秒内没有新消息、`/r` 恢复或新的 Provider 操作，
Gateway 会在关闭 Client 和停止 App Server 前向所有已知授权渠道发送一次
“所有模型连接已空闲，空闲的 App Server 即将停止”的通知。
该通知只属于渠道空闲自动解除后的全局释放轮次；手动 `/new`、切换 Workspace 或 Provider、
后台任务结束等原因导致没有绑定并关闭 Client 时，不发送这条通知。
`idle_release_minutes = 0` 只关闭渠道会话自动解除；无任何绑定时的全局空闲停止仍会执行，其他
非自动解除触发的全局空闲轮次只记录日志，不发送渠道通知。共享 App Server 的原生 TUI 必须通过
`codexc remote` 启动；直接运行 `codex --remote unix://<socket>` 不持有生命周期租约，可能被停止。
空闲解除时按渠道会话保存 Provider、模型、思考等级和服务层级；Gateway 重启后直接发送消息仍沿用
这份偏好新建会话。断开后通过 `/model`、思考等级或 Fast 入口调整设置，会更新保存值。
恢复时若 Provider、模型或设置已不可用，会要求重新选择，不自动换账户或模型。
已有绑定仍以 App Server 的 Thread 设置为准；显式恢复同 Provider 历史会话继续沿用渠道偏好，
跨 Provider 恢复尊重目标 Thread，原生 Queue 存在时清除待生效覆盖。撤权、归档和跨渠道接管
等清理操作不会让旧偏好在重启后重新生效。首次采用此功能需通过
[状态数据库升级流程](source-install.md)将 v5 显式升级至 v6。
此后直接发送消息只会开启新会话，不会接续旧 Thread；需要继续旧会话时直接使用提示中的
`/r <Thread ID>` 命令显式恢复；飞书显示为 CardKit 2.0 卡片，Telegram 为 HTML 面板，微信为
结构化文本。修改后需要重启 Gateway。

### 代理与权限

共享代理统一保存在当前 Codex Home 的 `.env`，默认 `~/.codex/.env`。执行
`codexc config → 网络代理`，或在 WebUI「设置 → 网络与访问」修改；批量输入留空保持原值，取消不写入。
CLI 单项和批量代理设置均可选择 `127.0.0.1:7890`、`127.0.0.1:7897` 或自定义完整 URL；两个本地选项使用 HTTP 协议。
例如：

```dotenv
HTTP_PROXY="http://127.0.0.1:7897"
HTTPS_PROXY="http://127.0.0.1:7897"
ALL_PROXY="socks5://127.0.0.1:7897"
NO_PROXY="localhost,127.0.0.1"
```

Codex、Gateway 渠道和模型统计代理共用该文件；修改后在任务结束时执行
`codexc service restart all`，独立 Codex 进程也需重新启动。Gateway 只读取四个代理变量，
不把文件中的其他变量注入自身环境。代理值使用字面值，美元符号使用单引号包围或反斜杠转义，
不支持代理值中的变量插值。原有注释、其他设置和未修改字段会保留。
`ALL_PROXY` 可保存 SOCKS5 地址，但必须同时在此文件配置 HTTP(S) 协议的 `HTTP_PROXY`，
供 Gateway 的 HTTP(S) 客户端使用；缺少时读取或保存都会明确报错。

`.env` 字段优先于继承的标准代理环境变量；同名大小写同时存在时大写优先。已有任一代理地址时，
不补读系统代理；仅有 `NO_PROXY` 时仍允许自动发现。Windows 不读取 WinINET/WinHTTP。
不支持旧 TOML `[network]`，更新器不会迁移或修改代理配置。

Workspace 只能从已登记项目中选择，并可分别设置 Sandbox、审批策略或 Permission Profile；不会接受聊天用户提交的任意绝对路径。

## 4. Workspace、Provider 与终端

登记项目：

```bash
cd /absolute/path/to/project
codexc work add
codexc work list [--json]
```

管理模型 Provider：

```bash
codexc setup
codexc primary-provider list [--json]
codexc primary-provider switch <Provider ID> [模型] [--yes]
```

`primary-provider switch` 会把主实例切换到目标 Provider，执行前会二次确认，并提示将改写
Codex 主配置的 `model_provider` / `model`；传 `--yes` 跳过确认（适合脚本化调用），
仅命令行 switch 支持 `--yes`，交互式 Setup 菜单仍会确认。

添加账户时，Setup 与 WebUI 已有的多账户配置入口均提供 `main`（主账户）、`work`（工作账户）、`other`（其他账户）和“自定义”；已占用的预设不再显示。名称仅作账户 ID，不决定默认账户或自动切换行为。

DeepSeek、OpenCode Go、自定义 Provider 和多账户说明分别见 [`DeepSeek 使用说明`](deepseek.md)、[`OpenCode Go 使用说明`](opencode-go.md)、[`Provider 接入指南`](provider-integration-guide.md) 和 [`OpenCode Go 多账户`](opencode-go-multi-account.md)。

继续使用聊天会话：

```bash
codexc remote
codexc remote resume
codexc remote --profile sf-ds-<账户> resume
```

直接运行 `codex` 会创建独立 TUI，不共享 Gateway Thread；需要共享会话时使用 `codexc remote`。跨 Provider 切换会创建目标 Provider 的新 Thread，不复制原 Provider 历史。
直接运行 `codex --remote unix://<socket>` 不持有生命周期租约，空闲释放可能停止对应实例；
共享 App Server 的 TUI 请统一使用 `codexc remote`。

### Codex Desktop App 共享（macOS / Windows 预览）

同一台 Mac 或 Windows 电脑上的 ChatGPT Desktop App 可以连接主 OpenAI App Server。macOS 使用
受管 stdio Proxy 连接现有私有 UDS；Windows 使用受认证的本机回环桥。启用前必须完全退出
ChatGPT App，并确保主 Provider 是 OpenAI、App Server 后台服务已经安装；Windows 还需要
PowerShell 7 和当前用户安装的 `OpenAI.Codex` 包：

```bash
codexc desktop-app status
codexc desktop-app enable
codexc desktop-app open
```

以后每次都使用 `codexc desktop-app open` 启动；从 Dock 或开始菜单直接打开不会继承本次共享端点。
关闭功能前同样先完全退出 App，再执行：

```bash
codexc desktop-app disable
```

`status --json` 保持脱敏。Windows 只输出不带令牌的回环地址；macOS 的 `port`、`endpoint`、
`tokenReady` 和 `bridgeReady` 不参与连接并返回空值或 `false`，另以 `toolHostSupported` 报告当前
App Server 服务是否支持受管入口。`toolHostAttached` 只在 Desktop 已交付当前工具 Pipe 且 Host
租约仍连接时为 `true`。共享功能只支持主 OpenAI App Server，不接入
Remote Control、手机配对或第三方 Provider。Desktop 的连接环境属于未公开兼容入口，当前功能是
预览；构建不兼容时命令会拒绝启用。

macOS 上使用 ChatGPT `26.908.70816` 的实机验收已经确认 Desktop 与渠道可以双向发现、继续同一
Thread。新的 macOS 受管入口会把 Desktop stdio 连接代理到同一
私有 UDS，并在首次附加当前工具 Pipe 时短暂重启主 App Server 子进程，以 OpenAI 签名的 Desktop
Node 托管项目锁定的 Codex CLI；开发基线为 0.156.1，既有私有 Pipe 与签名链实机验收使用 0.154.0，
升级后仍需单独复核。Desktop 传入的内置插件启用值会受控应用到共享主实例，
Host 租约存在时空闲释放不会停止主实例。`desktop-app open` 会先通过 App Server 的官方
`thread/loaded/list` 和 `thread/read` 检查全部已加载的持久及临时 Thread；发现活动 Thread、
`codexc remote` 主实例租约，或无法完成
只读状态检查时都会拒绝启动，不会进入子进程切换。隔离实测已经确认该进程链可启动 `codex_app`，
服务重启恢复和退出重开仍需按
当前 Desktop 构建完成实机复核，因此支持级别
继续是预览。Windows 只查询当前用户的正式安装包，并直接创建带单次环境的包内 Desktop 子进程，
不写当前用户或系统级持久环境；Windows 的会话双向互通及内置工具兼容均尚未实机验收，不能据此
视为正式平台支持。

实现边界、阶段状态和验收标准见
[`Codex Desktop App 共享 App Server 实施方案`](codex-desktop-app-development.md)。

### Computer Use 与浏览器排障

配置入口：`codexc config → Codex 新会话与用户偏好 → 电脑、浏览器与 MCP`，或 WebUI
「设置 → 工作区与权限」中的 Codex 权限与工具分区。两者修改同一份 Codex 用户配置，使用版本检查；WebUI 写入前需要预览并确认。

当前支持默认应用访问、浏览器历史访问和默认站点策略，以及配置中已有的 macOS Bundle ID、Windows AUMID
和站点规则。普通 MCP 可修改启用状态、启动/调用超时、工具允许/禁用列表与审批策略；已有单工具覆盖还可修改
审批和输出 token 上限。插件 MCP 只开放这些策略覆盖，不修改插件清单里的启动命令、环境和超时。
本页不负责新增 MCP、发现插件清单里的服务器或创建应用/站点规则；未列出的条目仍在 Codex 原生配置中管理。

“用户设置”与“App Server 合并配置”分别展示，未设置时不臆测上游默认值。合并结果来自用户配置管理连接，
不包含当前渠道 Thread 的 Workspace/Profile 覆盖，也不表示组织策略、工具审批或操作系统权限已经放行。
选择“移除用户设置”仅删除该字段；工具列表的 `[]` 是显式空列表，与删除字段不同。
审批模式 `auto` 按工具属性判断，`prompt` 每次询问，`writes` 对非只读工具询问，`approve` 免除此层工具审批；
应用/站点的 `allow` 不会取消其他审批。保存后在新会话中使用；已有 MCP 连接与桌面客户端不保证即时采用新配置。

`desktop-app status` 的 `toolHostAttached` 只描述上面的 Desktop 私有工具 Host，不能据此判断
独立 Computer Use 或浏览器插件是否可用。`/mcp health` 可以检查当前 Thread 的 MCP 连接，
但工具已注册、原生应用列表可读、浏览器扩展可发现，都不代表窗口或标签页操作已经成功。

探测时应分别读取原生窗口与浏览器标签页。原生返回 `cgWindowNotFound` 时检查桌面锁屏与目标窗口；
浏览器扩展可发现但读取标签页超时，应继续检查扩展连接，不能直接判为缺少授权。系统辅助功能、
屏幕录制授权和上游应用／网站授权分别管理；Gateway 的批准按钮只回应实际收到的 App Server
请求，不代替系统授权，不解锁桌面，也不自行维护另一套网站允许名单。

飞书 MCP 工具审批区分“拒绝”和“取消”；“本会话允许”“始终允许”只在上游提供相应范围时出现，
“允许一次”不会升级为持久授权。Computer Use 操作说明与过程显示见[渠道展示](display.md)。

## 5. 后台服务与更新

安装、检查和重启：

```bash
codexc service install
codexc service status
codexc service restart all
codexc service logs -n 200
```

默认情况下 `start`、`stop`、`status` 操作全部核心服务；`restart`、`logs` 默认只操作 Gateway。App Server 与 Gateway 是独立目标，渠道内禁止停止或重启 App Server。整体重启先停止已安装的 Relay、Gateway，再停止 App Server，随后按 App Server、Gateway、已安装且启用的 Relay 顺序启动，避免正常整体重启生成断开通知；Linux 重新安装服务也使用这一停止顺序。整体重启中任一停止失败即中止，不继续停止后续依赖或启动服务。macOS 普通 `start` 不强制重启已运行的服务。单独重启 Gateway 不停止共享 App Server；单独重启 App Server 时，仍运行的 Gateway 会按真实断线处理并重连。

Linux 使用 systemd 用户服务；Windows 使用当前用户计划任务和隐藏的 PowerShell 7 进程，不需要管理员权限。Windows 私有配置 ACL 修复：

```powershell
codexc security repair
```

源码安装的日常升级统一使用：

```bash
codexc update
codexc doctor
```

本地源码通过 `npm run install:global` 安装时，缺少 Codex CLI 会自动补装项目锁定版本，无需先初始化或配置渠道；随后执行 `codexc init`、`codexc setup`、`codexc service install`。已有 CLI 不被静默替换；完成渠道配置后可运行 `codexc update` 同步已安装包要求的版本。
更新发现默认 CLI 缺失或版本不匹配时会询问是否安装，确认后先校验临时候选，再更新全局 CLI；
非交互调用会给出精确版本安装命令并退出，不静默安装。

更新先检查源码、公开合同、当前配置和数据库升级条件，通过后在一个停机窗口完成程序及配套 Codex CLI 安装、目标版本的数据库升级与服务恢复。目标版本按受支持范围执行显式数据库升级；指标 v20/v21/v22→v23 保留旧数据并生成一致性备份，运行时不隐式迁移。用户偏好与 Provider 模型目录不改写，不支持的旧配置或 Schema 明确报错。新安装由正常初始化创建当前结构。详细流程见[源码安装与更新](source-install.md)。

### 本机清理与归档

统一交互入口：

```bash
codexc cleanup
```

菜单包含以下五项，完成或取消单项后返回菜单，现有直接命令继续可用：

| 菜单项目 | 直接命令 | 执行条件与结果 |
| --- | --- | --- |
| 归档短会话及子会话 | `codexc sessions cleanup <最大轮数>` | 停止 Gateway、保留 App Server；预览并确认后归档 |
| 删除请求与响应转储 | `codexc traffic cleanup` | 先预览，确认删除需停止全部 App Server；永久删除当前配置目录下全部转储 |
| 清理旧指标 | `codexc metrics cleanup --restart-gateway` | 菜单填写保留天数、行数和是否压缩；备份清理，会停止后启动 Gateway（原先停止也会启动） |
| 核对未确认渠道结果 | `codexc delivery status` / `codexc delivery list` | 先停止 Gateway；明确重发、确认送达与停写备份见[投递箱运维](delivery.md) |
| 清理指定 Provider 的指标 | `codexc metrics prune <provider>` | 输入区分大小写的精确 ID 并确认；备份清理，Gateway 按原状态恢复 |
| 保留数据升级指标库 | `codexc metrics upgrade --from 22 --to 23` | 默认预检；先停止 Gateway 与 Relay，核对后加 `--apply` |
| 重置整个指标库 | `codexc metrics reset` | 先停止 Gateway；确认后备份并重建指标库 |

`codexc cleanup -h` / `--help` 显示说明，非交互终端不会执行清理。菜单不会统一停掉所有服务，各项沿用原有条件；执行失败会报告错误并返回清理菜单。

会话归档示例：先停止 Gateway，保留 App Server，预览“主会话不超过 3 轮、整组可查询成员至少空闲 7 天”的候选：

```bash
codexc service stop gateway
codexc sessions cleanup 3 --idle-days 7
```

核对后在交互终端执行，命令会重新扫描并再次询问确认：

```bash
codexc sessions cleanup 3 --idle-days 7 --confirm
codexc service start gateway
```

交互归档统一从 `codexc cleanup → 归档短会话及子会话` 进入；`codexc sessions` 无参数只显示帮助。不指定 `--idle-days` 就没有会话年龄限制。
轮数阈值只计算主会话，子孙轮数不累加；派生子孙随官方归档，Fork 独立筛选。
活动、固定、渠道绑定或状态无法确认的成员会使整组跳过。归档保留历史，不是永久删除；
官方操作可能部分成功，执行期间不要在其他客户端操作候选会话。完整筛选及核验口径见[展示说明](display.md)。

### 卸载

卸载但保留用户数据：

```bash
codexc uninstall
```

源码卸载不要求配置文件有效；仍会检查受管安装身份并保留用户配置和数据。

npm 安装版也可以使用 `codexc service uninstall` 后执行 `npm uninstall -g @hegenai/codexc`。

## 6. 渠道命令

在聊天中发送 `/help` 查看当前渠道完整命令。常用命令包括：

- 会话：`/new`、`/resume`、`/sessions`、`/archived`、`/rename`、`/archive`、`/unarchive`、`/pin`、`/unpin`
- Workspace：`/workspace`、`/workspaceperm`
- 运行：`/status`、`/stop`、`/queue`、`/revert`、`/compact`、`/fork`、`/review`、`/release`
- 模型：`/model`、`/effort`、`/fast`、`/plan`
- 状态：`/diff`、`/usage`、`/metrics`、`/limits`、`/permissions`、`/goal`
- 扩展：`/agents`、`/skill`、`/plugin`、`/mcp`
- 帮助：`/help`、`/whoami`

`/stop` 会优先中断当前活动 Turn；`/resume` 和 `/new` 切换时，旧任务仍可在后台运行，结果与审批继续返回原聊天。Queue 由 App Server 持久保存，不由 Gateway 建立第二套消息正文队列。
存在原 Thread 时，`/new` 的结果会显示 `恢复会话：/r <Thread ID>`，可直接复制该命令恢复旧会话。

`/r` 的完整 ID、短 ID、名称和序号都只在当前工作区查找。恢复其他工作区的历史前，
请先使用 `/work` 切换到会话所属工作区；恢复不会自动切换工作区或改写历史会话的目录。
恢复时如果历史目录或实际权限与工作区不一致，会解除该绑定；下一条普通消息在当前工作区新建会话。
`/model` 选择 OpenAI 模型会关闭下一轮的 Fast，并同步保存为 Codex 用户默认值，避免 `all` 重启后
重新开启；需要时可用 `/fast on` 再打开。选择第三方模型不修改 OpenAI 的 Fast 默认值。
`/resume`（及 `/r`）、`/sessions` 和 `/archived` 的当前页会话会优先显示本机指标/缓存中的 Turn 轮数；打开列表不等待历史扫描。该轮数与 WebUI 相同，按本机已记录模型请求的不同 Turn 统计；本地没有记录时不会猜测数量。需要完整官方历史计数时，`codexc sessions cleanup` 仍会按候选读取。

计划任务是 Gateway 自有功能，不是 App Server 原生计划 RPC。启用方式和确认语法见 [`计划任务开发设计`](scheduled-tasks-development.md)。

## 7. 指标、WebUI 与图片

```bash
codexc metrics status
codexc metrics threads
codexc metrics report --range 30d --group models
codexc metrics export --range 30d --format json
codexc webui
codexc traffic
```

WebUI 默认展示本机脱敏指标；回环监听未配置令牌时可直接使用设置页，显式配置令牌后所有 API 都会验证，非回环监听必须配置令牌。详情见 [`WebUI`](webui.md)。

### 正常发图与图片引用

照常在渠道发送图片即可，不需要额外命令。使用 OpenAI ChatGPT 登录时，Gateway 上传已校验的
原图并以官方 `fileId` 提交；App Server 保存引用，后续历史继续使用引用。自动引用目前要求
实际模型代理与账户均使用默认 ChatGPT 后端，且账户路由策略为 `NO_CONSTRAINT`；
`us`、`us_cr` 或后端不一致时会在上传前报错。
API Key、第三方 Provider 和独立自定义 OpenAI 后端保持内联图片输入。Actor、Workspace、模型能力和媒体大小限制继续适用。

图片引用会跳过 App Server 的本地缩放，不能视为与普通原生 TUI 的图片预处理完全相同。
上传最多等待 60 秒，可通过 `/stop` 取消；账户或路由变化、上传和引用失败都会明确报错，
不自动重新上传或回退 Base64。远端图片没有自动删除入口，保留时间和跨重启可用性不作保证；
此功能不提供文件管理、按编号下载或用户手动编号输入。
实现、验证范围与限制见[图片引用决策](codex-cli-upgrade-decisions.md#图片文件引用需求阻塞与实现边界)。

部署后需要确认自动引用时，先按[模型请求转储](#模型请求转储)开启调用详情记录。为避免历史条目或
长字段被裁剪，可临时把 `model_traffic_input_items` 和 `model_traffic_item_max_bytes` 都设为 `0`，
重启 App Server 后在新会话中发送一张图片，再发送一条只引用前图的纯文本追问。用下面的命令分别
展开首次发图和后续追问对应的模型调用：

```bash
codexc traffic
codexc traffic --exchange <首次发图编号>
codexc traffic --exchange <后续追问编号>
```

首次请求应包含 `input_image.file_id`，且不包含该图片的 `data:image/...;base64`。后续请求可能在
完整历史中继续携带同一 `file_id`，也可能通过 `previous_response_id` 增量接续而完全不再携带图片；
两者都属于官方历史复用。后续请求重新出现该图片的 Base64 才表示自动引用未生效。模型能够回答
后续追问只能证明上下文可用，不能单独证明首次请求已经使用 `fileId`。转储包含未脱敏的会话正文、
工具输出和代码，验证后恢复原来的裁剪配置并关闭转储，不要分享原始文件。

从本机向绑定渠道发送图片：

```bash
codexc channel send-image /tmp/screenshot.png
codexc channel send-image /tmp/screenshot.png --thread <Thread ID>
```

只接受经过安全校验的 PNG/JPEG，具体限制见 [`渠道图片`](channel-image.md)。

## 8. 排障

```bash
codexc doctor
codexc doctor --json
codexc service status
codexc service logs -n 100
```

常见处理：

- 配置修改未生效：`codexc service reload`。
- 只重启 Gateway：`codexc service restart`；共享 App Server 与活动 Thread 会保留。
- Codex CLI 版本不一致：按 `codexc update` 或错误提示安装精确版本后重试。
- 飞书无消息：先运行 `codexc doctor`，再检查应用权限、消息事件发布和允许用户。
- Windows ACL 失败：运行 `codexc security repair`，再运行 `codexc doctor`。
- 日志需要脱敏后再分享；不要分享 Token、Cookie、Authorization Header 或完整命令工作内容。

错误码见 [`错误字典`](errors.md)，渠道展示口径见 [`展示说明`](display.md)，协议与支持矩阵见 [`官方文档与源码索引`](index.md)。

### 模型请求转储

需要查看模型请求和响应的完整字段时，运行 `codexc config`，选择“系统设置 → 调用详情记录 → 开启”，
再按提示重启 App Server。也可以手工设置：

```toml
[debug]
model_traffic_dump = true
model_traffic_retention_days = 30
```

```bash
codexc service restart app-server
```

App Server 发给统计代理的模型调用会写入 `~/.codex-connect/traffic/` 下的 V2 私有 session 目录；
HTTP 的一次请求对应一条逻辑调用，同一 WebSocket 连接中的每个 `response.create` 也分别对应一条。
每条逻辑调用只保存一条请求索引和一个完成、失败或不完整终态响应，原始 HTTP/SSE 块、WebSocket
握手和双向帧另存为默认不展示的 trace。HTTP 请求头
`x-codex-turn-metadata`、WebSocket 首帧 `client_metadata` 里的 `thread_id` 与 `turn_id`
可以对齐到具体会话和轮次。转储是统计代理的旁路复制，不改变转发路径、指标采集和流式背压，
也不是抓包代理。Authorization、Cookie 等凭据字段只保留认证方案，替换为 `<redacted>`。

每个 session 的 `manifest.json` 声明精确版本，`interactions.jsonl` 保存小型索引，正文通过
offset/bytes 引用轮转的 `payload-*.bin`，原始传输轨迹位于 `trace-*.jsonl`。正文和 trace 文件达到
64 MiB 后轮转；长驻进程约每 24 小时让新逻辑调用进入新的 writer session，已在执行的并发调用继续
写入原 session，因此请求与响应不会被拆分。
同一 Provider 的历史完整 session 约保留 320 MiB，当前写入 session 不在中途删除。
转储写入失败时只停止转储并在日志中报错，模型请求继续正常转发。转储包含 prompt、工具输出和代码，
排查完成后关闭开关并删除 session，不要分享原始转储。

`model_traffic_retention_days` 默认 `30`。App Server 服务每次启动，以及开启转储后建立新 writer
session 时，都会按 session 最后活动时间删除超过该天数的可识别 V2 历史批次；启动清理即使当前已
关闭转储也会执行。清理以完整 session 为单位，含保留期内记录的批次会整体保留；设为 `0` 可关闭按
时间自动清理。旧版逐帧 JSONL、未知文件和未知目录不会自动删除。升级后首次启动会按同一规则处理
已有 V2 历史批次；需要回滚到不识别该键的旧版时，先从 `[debug]` 删除
`model_traffic_retention_days`。

转储默认按下一节的体积控制规则裁剪，不会把每次请求重发的完整会话历史原样落盘。流被提前终止时，
该逻辑调用会得到 `failed` 或 `incomplete` 终态及明确的 `errorScope`；已收到的传输块仍在 trace 中。

正文与索引分开存储，直接读不方便；用 `codexc traffic` 渲染成人可读文本：

```bash
codexc traffic                                 # 列出最新 session 中的逻辑模型调用
codexc traffic --exchange 12                   # 展开某次调用的一条请求和一个终态响应
codexc traffic --all --grep deepseek-flash     # 只显示匹配关键字的逻辑调用并展开正文
codexc traffic --exchange 12 --max-bytes 2000  # 限制每段正文的显示长度
codexc traffic --follow                        # 从现有文件末尾开始持续输出新写入的记录，按 Ctrl-C 停止
codexc traffic cleanup                         # 预览全部可清理转储，不删除
codexc traffic cleanup --confirm               # 停止全部 App Server 与 Relay 后永久删除预览范围
```

摘要行包含调用编号、时间、请求路径或 WebSocket URL、线程、轮次、模型和终态；详情固定分为“请求”
与“响应”，并补充参数、Token 用量和已完成输出条目。列表区分模型列表查询、连接预热与模型请求。
不传路径时读取 `traffic/` 中最新标签的最新 writer session；也可以用 `--dir` 指定根
目录，或传入一个 V2 session 目录。旧版逐帧 JSONL 原样保留但不自动迁移或混读，重启 App Server
后会生成 V2 session；回滚旧版本时旧文件仍可继续使用。`codexc traffic -h` 列出全部选项。
`cleanup` 会预览默认 `traffic/` 或 `--dir` 指定目录中可识别的全部 V2 session 和旧版逐帧 JSONL，
未知文件与目录不处理。实际删除只允许当前配置的数据目录下的 `traffic/`；先运行
`codexc service stop app-server`，再加 `--confirm`。删除不可恢复，完成后可按需运行
`codexc service start app-server`。

同一份转储也能在 `codexc webui` 的「转储」页查看：摘要列表与 `codexc traffic` 使用同一套解析，
点开某条即进入该条的请求参数、实际输出与用量摘要。终态未携带输出时，从已存 trace 的完成条目
提取；原始正文、诊断信息与传输 trace 默认收起，数据不会回写。页面地址保留标签、writer session、调用编号与分页位置，
返回列表回到原处；App Server 重启后也不会把旧列表中的编号解析成新 session 的同号调用。
该页只接受本机回环访问，展示内容同样是未脱敏原文（转储裁剪过的条目会显示对应的截断标记）。页面
同时显示自动保留天数，并提供“清空转储”的预览确认入口；实际删除前必须先停止全部 App Server。

### 转储体积控制

首个请求或未采用增量接续的请求可能携带完整会话历史，长会话一轮就有几 MB；使用 WebSocket
`previous_response_id` 接续时，后续请求也可能只携带本轮增量。转储对实际出现的 `input` 按下面的
规则裁剪后落盘，不需要额外配置：

```toml
[debug]
model_traffic_dump = true
model_traffic_input_items = 3
model_traffic_item_max_bytes = 65536
model_traffic_retention_days = 30
```

- `model_traffic_input_items`（默认 `3`）：只保留请求 `input` 数组末尾这么多条完整条目，更早的
  条目合并成一条 `{"type": "omitted", "omitted_items": …, "omitted_bytes": …}` 摘要；
  `0` 表示按原样保留整个 `input`；
- `model_traffic_item_max_bytes`（默认 `65536`，即 64 KiB）：单个数组条目（请求 `input` 条目、
  响应 `output` 条目、其中嵌套的数组元素）和超长字符串字段超过该字节数时只保留头尾各一半，替换为
  `{"type": "truncated", "bytes": …, "head": …, "tail": …}` 标记；`0` 表示不限制。它独立于
  `model_traffic_input_items` 生效，只设上限不会折叠 `input`。
- `model_traffic_retention_days`（默认 `30`）：App Server 启动及新 writer session 建立时，按最后活动
  时间清理超过天数的完整 V2 历史批次；`0` 关闭按时间清理。按 Provider 约 320 MiB 的体积上限继续生效。

精简开启时还会折叠响应里重复回显的 `response.instructions` 与 `response.tools`
（`<omitted N 字节>` 占位），并丢弃逐条流式增量事件
（`response.output_text.delta`、`response.reasoning_text.delta`、
`response.function_call_arguments.delta` 等以 `.delta` 结尾的事件）不再写入转储，它们的完整文本
由同一条目的 `*.done` 事件和 `response.completed.response.output` 承载。请求头、请求体其它字段、
`model`、保留的响应事件和事件顺序保持完整。需要逐个字段核对原文时，把两项参数都设为 `0` 按原样
转储。这些参数都在 App Server 启动时读取，改完需要重启服务；使用 `codexc traffic` 查看时不需要
额外参数，折叠、截断与丢弃结果会直接显示在对应位置。

开启精简时正文先整段缓冲再折叠，然后按 1 MiB 分片写入；单个正文超过 32 MiB 时退化为按原样分片，
避免为超大正文占用过多内存。

WebSocket 提供方（OpenAI 官方）同样生效：客户端 `response.create` 帧的 `input` 按同样规则保留
末尾条目，上游 `response.created`、`response.in_progress`、`response.completed` 里重复的工具与
指令回显按同样规则折叠，`.delta` 帧直接跳过。

## 9. 开发与验证

```bash
git clone https://github.com/msola-ht/codex-channels.git
cd codex-channels
npm ci
npm run check
npm run lint
npm run docs:check
npm test
```

协议升级必须先查阅 [`docs/index.md`](index.md)、官方固定 Tag 和 [`上游源码维护规则`](upstream-sources.md)，不得把生成类型存在误认为 Gateway 已支持。完整项目文档索引见 [`index.md`](../index.md)。

项目命令规则预授权只读 Git 状态、差异、日志、声明的验证入口和绑定渠道图片发送；`git branch`、`git remote` 不整体预授权，按当前执行权限处理。

## 可选模型 API 转发

`codexc relay` 管理独立 Relay 的调用方和访问密钥；`status`、`callers` 只读，
`issue` 签发、`rotate` 轮换、`disable --caller ID` 撤销。新秘密只在保存后显示一次。
`enable`/`disable` 保存服务开关并确认当前进程生效；进程未运行时明确显示仅保存，
通过 `codexc service start relay` 启动；停止、重启、状态和日志也使用 `relay` 目标，日常命令统一使用新名称；仅保留 `codexc service start model-relay` 作为旧更新器的显式升级启动入口，执行时输出迁移提示，其他操作拒绝旧名称。内部系统服务名称保持不变，无需为名称变更重新安装服务。首次启用前先完成指标库显式升级。

Relay 默认禁用、回环监听；可显式使用 IPv4 局域网监听，跨不可信网络使用自己管理的加密隧道。提供原生 Chat Completions 与 Responses JSON/SSE 和
受限模型列表，不提供 App Server 的 Agent、Thread、Turn、工具执行或文件访问。
客户端使用 `/v1/chat/completions` 或 `/v1/responses` 选择原生协议；不会互转或自动重试另一协议。
`codexc relay providers` 和管理页展示账户的实际协议能力：CLP 为 Chat，DS 为 Chat/Responses，其他已接入的 Responses 提供商为 Responses。
自定义主/切换 Provider 必须有可独立读取的 API Key 和有效模型目录；不借用 Codex OAuth 登录态。
Responses 只提供同步无状态创建；不提供 `store=true`、`background=true`、服务端会话引用或响应管理端点。
普通参数、工具声明和远程图片交由上游处理；Chat 保留原始响应字段与工具增量，客户端须等待有效终态后才执行工具。
回退仅支持 CLP 的旧程序前，停止 Gateway、Relay 和 WebUI，使用 `codexc relay rollback-providers --provider ID`（可重复）明确列出所有非 CLP Relay 账户；
命令备份后移除这些引用及其 Key，保持提供商自身配置和剩余凭据。重新接入须重新签发，不恢复备份中的旧秘密。
完整双协议、提供商接入与升级回滚合同见[实施方案](provider-api-relay-development.md#1514-原生双协议与提供商公共接入)。
局域网交互设置：运行 `codexc relay listen`，或进入 `codexc config` → 模型转发监听，选择关闭、仅本机、局域网（0.0.0.0）或指定内网 IP。确认后自动备份、原子保存并向运行中的 Relay 确认生效，保留 Key 和现有端口。若服务未运行，会提示启动命令，不自动安装或启动。配置被其他操作修改时拒绝覆盖，请重新进入菜单。

手动设置：先备份当前实际使用的配置文件并校验备份，再在已有 `[model_relay]` 段设置 `host = "192.168.1.10"`（替换为服务器的内网地址），或 `host = "0.0.0.0"`。不要重复创建同名 TOML 段。保留现有 Key、并发及其他字段；默认端口为 4119。支持 10/8、172.16/12、192.168/16 的规范 IPv4 地址，IPv6 当前仅支持回环 `::1`。不接受域名、URL 或公网 IP 字面量。

运行中的 Relay 会刷新监听配置；配置无效或绑定失败时停止接收请求，不自动换地址。初次启用使用 `codexc relay enable`，已安装的服务使用 `codexc service start relay`，通过 `codexc relay status` 确认 `configurationValid`、`enabled`、`listening` 均为 true。改变监听地址会取消旧请求，应在空闲时操作。客户端 Base URL 填 `http://192.168.1.10:4119/v1`，API Key 使用已签发的 Relay Key，模型选择该 Key 允许的 ID。

`0.0.0.0` 监听所有 IPv4 网卡，不是客户端地址，也不保证仅内网可达；自行限制防火墙来源，不做公网端口映射。HTTP 中 Key 和正文未加密，跨不可信网络使用加密隧道。此设置不开放 App Server、控制 IPC 或指标 IPC，不改变 WebUI 的监听与管理授权。回退旧版本前停止 Relay，将 host 改回 `127.0.0.1` 或 `::1`，保留当前凭据，勿恢复整份旧配置。

客户端可携带当前 Key 调用 `GET /v1/models` 查看获准且仍在提供商目录中的模型。WebUI 请求页面来源显示“Codex / 转发”，可按来源与真实调用方筛选；接收确认不代表指标已落盘，交付完成不证明客户端已收到。
请求列表优先显示 Key 的当前中文用途名称，长名称省略显示，悬停或聚焦可查看完整名称与调用方 ID；未命名或已移除的调用方仍显示原 ID。名称仅用于展示，筛选和历史指标继续使用稳定 ID，不回写历史记录。

WebUI 侧栏「模型转发」提供独立 Key 管理页。每个用途对应一把 Key，名称支持中文，内部调用方 ID 在新建时自动生成并保持不变。先选择已配置的提供商
账户和允许模型，再选择「跟随客户端」或「强制关闭」。多把 Key 可以使用同一账户，策略互不影响。
Key 列表显示原生 Chat/Responses 协议；双协议账户同时显示两者。模型选择中的文本、图片、音频标签来自现有目录，未声明时不推断能力；标签不改变上游参数处理。
账户凭据在 WebUI「模型管理 → 账户与凭据」维护，自定义提供商的地址与凭据在「模型管理 → 提供商」编辑；Relay 页不复制上游秘密。新建、编辑、轮换、停用和删除使用居中弹窗，先预览再确认，
完整新 Key 只显示一次，关闭后无法再次查看；响应丢失时先刷新确认记录，不能自动重复签发。
若返回 `cleanupStatus: "failed"` 或页面提示管理锁清理失败，修改已经保存；先保存新 Key，再检查数据目录权限和磁盘，不要重复签发。读取失败可直接刷新；编辑时错误及刷新入口显示在弹窗内。刷新保留草稿，但检测到版本变化会禁止保存，须明确选择“重新加载并丢弃草稿”再编辑、预览，避免覆盖其他端修改。上游能力暂不可读取时保留现有策略，可仅改名或切换到可用提供商；不会把未知状态当作模型不支持。
「查看调用」进入现有请求列表并精确筛选用途。停用后重新使用须轮换生成新秘密。

CLI 使用同一管理逻辑，例如：

```bash
codexc relay providers
codexc relay issue --caller translation --key translation-key --provider clp-main --model cline-pass/deepseek-v4.1-flash --reasoning off --name "沉浸式翻译"
codexc relay edit --caller translation --reasoning passthrough
```

`issue` / `edit` 可通过 `--name "中文名称"` 设置 1–64 字符的用途名称，不含控制字符或首尾空白。名称可重复、可修改，身份仍以 caller_id 区分；改名不会取消请求或更改历史指标。旧记录未设名称时显示调用方 ID。

`edit --model ID`（可重复）替换允许模型列表；不换提供商时省略则保持原列表。`edit --provider ID --model ID ...` 更换提供商，必须显式重选模型；API Key、调用方 ID 和凭据代次不变，客户端的模型名与协议路径需匹配新提供商。页面切换提供商时清空模型并将思考策略重置为跟随客户端；CLI 未指定 `--reasoning` 则保留原策略，不兼容时明确拒绝。缺省思考策略为透传。

`codexc relay delete --caller ID` 删除调用方并撤销 Key，取消其旧请求；历史指标和转储不删除。WebUI 的“删除”先预览再确认。改绑或删除会保留仅用于旧调用指标结算的历史身份摘要，不含秘密，不能用于请求鉴权；删除后新建必须使用新的 callerId 和 keyId。新建、编辑和删除会清理无人引用的 Relay 账户项，保留其他 Key 共用的引用，不删除上游账户或凭据。摘要最多 4096 条，同时受配置文件 1 MiB 限制；达到上限时拒绝整次操作，不静默清除历史摘要。

新增可选 `model_relay.retired_callers` 不要求迁移现有配置。首次改绑或删除前，应更新并重启 Gateway、Relay 和 WebUI，避免旧进程不识别新字段。回退旧程序前先等待指标收敛并停止上述进程，使用新版本执行 `codexc relay rollback-retired`；该命令备份后只移除历史摘要，保留当前凭据、提供商绑定和删除结果，之后不能保证补收旧调用指标。不要恢复整份历史配置以复活旧密钥。
强制关闭支持 CLP 的精确模型 `cline-pass/deepseek-v4.1-flash`，以及 DS 的 `deepseek-flash` / `deepseek-v4-pro`，同一 Key 的全部允许模型必须支持。
关闭策略覆盖顶层思考控制参数，CLP Chat 和 DS Responses 实际出站为 `reasoning.effort=none`，DS Chat 使用 `reasoning_effort=none`；不改历史消息或隐藏上游思考响应。
嵌套 `extra_body` / `extraBody` 的思考控制字段与关闭策略冲突时明确拒绝；跟随客户端不增加此限制。
更换提供商、修改模型或策略会取消该 Key 的旧请求。配置保存与运行态应用分开报告，不会自动启动服务。

新增可选字段 `model_relay.callers[].reasoning` 和 `display_name` 不要求旧配置升级；首次使用前应先停止旧 Gateway、
Relay、WebUI（包括前台实例），更新全部程序后再启动，避免旧程序读取新字段失败。
回退旧程序前停止这些进程，用新版本执行 `codexc relay rollback-reasoning`，备份后仅移除策略字段，
保留当前身份、哈希、代次和停用状态；此操作会使强制关闭失效。命令检查 Gateway 所有权和 Relay 控制端点，
回退到不支持中文名称的版本前，用新版本执行 `codexc relay rollback-names`，仅移除 `display_name` 并保留当前凭据；若目标版本也不支持思考策略，再执行 `rollback-reasoning`。
WebUI 及其他手工写入者须自行保持停止。失败保留原配置，不应恢复整份历史配置以免复活旧凭据。


Relay 的 Chat 请求保留模型参数、消息内容和扩展字段，由 CLP 判断是否支持；远程图片 URL
也由上游处理，Relay 不主动抓取。仅本地模型授权、JSON 对象/消息数量、stream 布尔、单选择
n=1 和请求大小等边界由 Relay 校验；省略 stream 时默认 JSON。请求参数不能改变本机账户、
凭据或上游地址。参数透传不代表当前模型支持所有能力，响应仍遵循已记录的单选择 JSON/SSE 合同。

Relay 保留普通应用请求头（例如 User-Agent、HTTP-Referer、X-Title），入口密钥不会转发给 CLP。
上游 Authorization 和传输头由 Relay 控制；Cookie、代理凭据、转发来源与内部身份头剔除。

在 WebUI“请求明细”点击唯一的“查看调用详情”：已采集报文直接打开现有转储视图；未关联时仅显示“未关联”，不提供详情链接。Relay 没有 Codex 会话或轮次，HTTP 200 不等于客户端交付成功。出站 User-Agent 只记录新调用实际发送的值，缺失时不推断客户端类型。

Codex 和 Relay 共用 `[debug].model_traffic_dump`，默认关闭。在 WebUI 的 Gateway 系统设置或 `codexc config` 系统设置中，用“记录调用详情”控制采集，用“调用记录模式”选择生产或调试；不再单独按 Key 开启。只记录启用后实际出站的调用，不补录历史。

如果配置仍含旧 `model_relay.traffic_dump`、`traffic_dump_mode` 或 `traffic_dump_debug`，运行时会明确拒绝。安装新版本后、运行 `codexc update` 或启动服务前，先停止旧 Gateway（包括前台进程），再显式选择统一后的状态。旧进程会按旧 Schema 自动补齐刚移除的字段；安装新文件不会替换其内存中的代码。例如保留关闭并采用生产模式：

```bash
codexc service stop gateway
codexc traffic upgrade --enabled false --mode production
codexc update
```

要统一开启调试，可明确选择 `--enabled true --mode debug`。升级命令锁定配置、校验旧字段、保存并校验私有备份后原子替换；不修改身份、凭据、数据库或已有转储，不自动重启服务。不能用旧开关的逻辑“或”自动扩大采集范围。

模式复用已有裁剪参数：生产预设为 `model_traffic_input_items = 3`、`model_traffic_item_max_bytes = 65536`，调试预设为 `0/0`；仅两项都为 0 时视为调试。自定义非零裁剪值仍受支持，切换模式才会写入预设值。Codex 沿用现有精简/完整转储，Relay 生产记录出站请求与上游响应，调试为所有调用方增加入站、交付及实际处理记录。调试没有 Key 限定或自动到期；排查完可手动恢复生产或关闭采集。Codex 更改在重启 App Server 后生效，运行中的 Relay 在配置刷新后用于新请求；已开始采集的请求按开始时的模式完成。

Codex/Relay 在生产和调试模式均保留普通请求/响应头及关联 ID，不按未知字段或诊断格式隐藏。仅遮蔽凭据类头、明显的 Bearer/Basic/Digest 值、URL 用户信息与敏感查询参数/片段、CSP nonce；未知业务头原样记录，可能包含用户业务信息，转储仅用于本机排查。模式仅影响正文裁剪及采集阶段，不决定普通头可见性。新规则只影响后续采集，旧记录无法还原已遮蔽值。Relay 每个头值最多 1 KiB，全部头最多 16 KiB；Codex 保持既有头容量；超限与正文截断明确标记。Relay 调试模式每侧请求最多 512 KiB、每侧响应最多 4 MiB，合计仍为 1 MiB/8 MiB；不是网络抓包。交付完成表示本地 HTTP 写入完成，不等于客户端已处理。鉴权/准入失败且未实际出站的请求不新增调用转储或指标。

Relay 生产记录脱敏后的出站 Chat/Responses 参数、输入和上游 JSON/SSE；请求与响应头遵循上述必要脱敏规则。翻译原文、回答及自由文本内的秘密仍会保存。请求正文最多 1 MiB、响应 8 MiB；Relay 共用 512 MiB 磁盘和 16 MiB 待写预算。保留天数统一使用 `[debug].model_traffic_retention_days`，默认 30 天，0 关闭按时间清理但保留 Relay 容量上限。首次启用在取消/超时边界内等待异步容量初始化，随后按实际已写及待写字节记账，并为在途调用预留空间。后台清理保护活动批次及扫描期间新建批次，整理期间继续采集；容量不足、写入故障或超限会留下日志或截断标记。写入故障会停止本进程后续采集，排除故障并重启 Relay 后恢复，模型转发继续。

停止采集不删除已有文件。回退程序前停止相关写入服务并归档调试批次；统一后的全局字段已被旧程序支持，旧 Relay 因独立字段缺失默认不采集。不要恢复整份旧配置覆盖当前凭据。如需回退指标库，按升级输出的备份路径及 SHA-256 执行 `codexc metrics rollback --from 23 --to 22 --backup PATH --sha256 HASH --apply`，先归档新库再恢复；从 v20 升级的备份使用 `--to 20`。

模型转发管理页显示配置并发上限及运行状态，点击“刷新”更新处理中、等待执行和接收请求数量。配置上限不代表运行进程已应用；服务停止或状态无法确认时，不显示虚假的零队列。

Relay 支持 JSON 非流式调用，不要求客户端启用流式。失败响应提供 `code`、`phase`、
`request_id` 和已知的 `upstream_status`；除带安全 `param` 的入口字段错误外，`message` 也包含这些定位信息。
`X-Relay-Request-Id` 可与指标记录关联。`invalid_upstream_*` 表示上游响应类型或字段校验失败；
例如上游 HTTP 200 配合 `invalid_upstream_tools` 表示工具响应字段校验未通过，并非上游返回了 502。
WebUI 请求列表的失败状态提示可查看错误码；诊断不包含请求内容、密钥或上游错误原文。
上游 429/503 提供的 `Retry-After` 在为受限整数秒或规范 HTTP 日期时会保留，客户端可据此退避；Relay 不自动重试。
Chat 的长度限制、内容过滤、`insufficient_system_resource` 和 `aborted` 终态原样交付，指标与新转储记为未完整完成。
工具参数字符串原样保留，客户端须在执行工具前验证 JSON 与参数含义；Relay 不执行工具或补齐参数。
Chat 与 Responses 的非流式首内容耗时在整包解析校验后观测，不是上游实际生成首 Token 的时间；空内容不填此值。

Relay 返回 403 `model_not_allowed` 时，请使用当前 Key 的 `GET /v1/models` 返回的精确模型 ID，
包括模型前缀。模型必须同时位于 Key 授权列表和 Provider 模型目录中；此类拒绝发生在出站前，
不会新增上游调用指标，也不表示 CLP 返回了 403。

Relay 的 JSON 非流式响应同时接受标准 Chat 对象和 CLP 的 `{success:true,data:...}` 包装；
客户端收到的仍是标准 Chat 响应。包装失败或内部响应不合法时返回明确错误，不当作成功生成。

Relay 只执行全局限流，不与本机 App Server 的代理共用计数。`[model_relay]` 的
`max_concurrency` 可设为 1–32，默认 10；`requests_per_minute` 可设为 0–600，默认 0
（关闭分钟与突发限制）；`burst` 为 1–32，默认 10，仅在分钟速率为正数时生效。
账户和 Key 只管理身份与模型授权，不再设置执行限额。鉴权失败保护始终保留。

Chat 请求在全局并发或令牌不足时排队：上传和等待合计最多 32 个，正文预算合计 16 MiB。
上传前每个请求先预留 1 MiB，正文验证后按重新序列化的实际字节释放多余预算；单请求原始正文
及重新序列化正文均不超过 1 MiB。计数和字节预算任一达到上限都会拒绝，所以不能保证同时接受
32 个大请求。上传限时 15 秒，正文验证后的等待最长 30 秒，均计入请求总期限 300 秒。
同一 Key 先入先出，不同 Key 轮转；没有每 Key 数量上限。`GET /v1/models` 不排队，仍受全局限额。

队列满返回 HTTP 429 `relay_queue_full`，等待超时返回 HTTP 429 `relay_queue_timeout`，
并带 `upstream_attempted:false`；未出站的拒绝、超时和撤销不会进入模型调用指标。
客户端断开、Key 撤销或 Relay 关闭时取消等待，不自动重试；队列仅在内存中，重启不恢复。
`codexc relay status` 返回执行数 `active` 及 `queue.pending`（上传与等待）、`queue.waiting`
（已验证正文的等待）、`queue.bytes`（正文预留预算），不包含请求正文。WebUI 队列展示尚未实现。

旧配置中账户或 Key 的 `max_concurrency`、`requests_per_minute`、`burst` 不再受支持，
新程序明确拒绝，不会静默忽略。切换新版本前使用新版本入口执行 `codexc relay upgrade-limits`
（未安装时可在已构建的新源码目录执行 `node bin/codexc.mjs relay upgrade-limits`）。
该命令校验配置、创建并核验私有备份，再原子移除上述字段；保留全局值、所有身份及凭据代次，
不修改数据库、不重启服务。重复执行不写文件。之后按正常流程更新并重启 Relay。
旧进程与新控制 IPC 不兼容，升级期间的状态可能显示 `unconfirmed`，不能据此认定撤销已生效。
回滚旧程序可让其使用缺省的账户/Key 限额；需要恢复原限额时只从备份核对这三个数值字段，
不要覆盖当前凭据或禁用记录。实际数据升级操作需由使用者明确执行。
