# CLI 入口

本目录保存 npm 包对用户暴露的 `codexc` 可执行入口。

## 文件

- `codexc.mjs`：解析顶层命令、展示帮助，并把工作转交给 `runtime/` 生命周期入口或 `scripts/` 管理
  命令；自身不持有 Gateway、App Server 或后台服务状态机。`doctor` 会执行安装、配置和服务连通性诊断。

## 命令范围

- `init`、`setup`、`config`：初始化用户目录；通过 Setup 接入 Provider、通讯渠道和项目技能；
  通过 Config 统一管理 Codex 新会话与用户偏好，以及 Gateway 的操作详情、计划更新、调试模式、
  审批超时、Sandbox、默认工作区、模型覆盖、WebUI、指标、Telegram 消息格式和配置路径。
  `setup --json` 保留交互并以 JSON Lines 输出脱敏事件；`config` 在非交互终端直接显示用户级
  `.codex-connect` 配置路径，`config --json` 只输出路径与文件存在状态，不读取或输出配置正文。
- `doctor`：诊断当前 TOML 配置、安装、Linux `bubblewrap` 沙箱前置条件、主 App Server 与已配置
  Provider App Server 的监管拓扑、实际版本和连通性；完成全部检测后按领域只展示失败、提示与处理建议，
  交互终端使用不同颜色并汇总结果；`--json` 输出全部脱敏检查、分类计数与健康状态；Linux 缺少
  `bubblewrap` 时输出安装建议，不改写配置。
- `security repair`：逐个修复 Windows Codex TOML 配置文件 ACL，不修改沙箱目录权限；Unix 平台提示无需处理。
- `start`：在前台复用内部 `service-app-server` 监管入口启动 App Server、Provider 统计代理与
  Gateway；只有监管身份、Provider 拓扑和真实 WebSocket 健康检查全部匹配的现有 App Server
  才可复用；Gateway 自身使用与 Provider 无关的配置级所有权 Socket，重复 Gateway 与未受监管
  App Server 均失败关闭；强制停止时等待本次前台启动创建的进程组退出后再结束公开命令。
- `remote`：连接共享 App Server 并启动原生 Codex TUI；切换模式可用 `--profile sf-ds-<账户>`、
  `--profile sf-ocg-<账户>`、`--profile sf-ccg-<账户>` 或 `--profile sf-custom-<Provider ID>`
  选择隔离实例；按当前目录或 `--workspace` 解析 Workspace 权限并允许显式 Codex 参数覆盖；
  在 TUI 生命周期内持有对应实例的 Supervisor 租约，直接运行的 `codex --remote` 不具备该保护；
  预期配置错误只展示一次，TUI 的终止信号原样返回调用终端。
- `desktop-app`：只读检查或在 macOS / Windows 预览中启用、禁用并启动 ChatGPT Desktop App 的
  共享 App Server 连接；完整退出检查、平台化构建兼容探测、配置事务、服务重启、Windows 回环桥
  就绪、单次子进程环境和令牌脱敏由 `scripts/desktop-app-command.mjs` 负责。macOS 通过受管 stdio
  Proxy 附加带生命周期保护的可信工具 Host，不再依赖桥端口或令牌，并由 `status` 单独报告；
  Windows 仍只承诺未实机验收的会话共享预览。
- `work`：把参数交给 `scripts/workspace-command.mjs`，列出、注册、移除 Workspace，或进入交互式权限菜单；
  `list --json` 供脚本读取稳定的 Workspace 注册摘要。
- `sessions`：无子命令时进入会话清理交互菜单；也可使用 `sessions cleanup <最大轮数>` 直接预览或确认归档旧会话。
- `cleanup`：统一交互选择会话归档、转储删除、旧指标清理、Provider 指标清理与指标库重置；复用各自执行入口与服务状态检查，完成或取消单项后返回菜单，非交互终端只显示帮助。
- `rules`：为当前 Git/Node 项目生成或检查 `.codex/rules/default.rules`，不修改 Workspace Registry；
  `check --json` 静默底层 Codex 展示并返回可解析的成功或失败结果。
- `primary-provider`：新增、列出、切换或删除自定义主 Provider；`list --json` 只输出不含凭据的稳定摘要。
- `deepseek account remove <id>`、`opencode-go account remove <id>`、`ccg account remove <id>`：确认后移除对应账户；三家均以 `legacy remove` 移除没有 ID 的旧单账户，保留备份与历史统计，之后重新添加。
- `opencode-go account`：新增、列出、删除、设置默认或停止 OpenCode Go 账户；新增账户必须输入邮箱或手机号二选一，联系方式只用于本机展示；Key 只写入
  `0600` 私有 Profile，`list --json` 不输出 Key 或 Profile 路径，`stop` 通过 App Server 监管 Socket
  释放对应隔离实例。
- `update`：Git 源码安装先在临时仓库构建并预检官方 `main` 最新提交，切换后再统一审查并更新用户
  配置、状态数据库和指标数据库，然后恢复核心服务；npm 安装不修改程序包。
- `uninstall`：只卸载当前受管 Git 源码安装；先卸载后台服务，再删除源码仓库、对应 npm 全局命令
  和旧 Shell PATH 配置，保留用户配置、数据库、凭据、日志和输出。Registry 安装交给 npm 卸载。
- `state`：在 Gateway 停止后显式备份并升级业务状态数据库。
- `metrics`：查询、导出、清理或显式维护独立模型指标库；`status --json` 返回稳定的路径、Schema
  兼容性与记录数，日常兼容升级使用 `update`。
- `traffic`：把 `[debug].model_traffic_dump` 生成的 JSON Lines 转储渲染成人可读文本，支持列出
  exchange 摘要、展开指定 exchange 的完整请求与响应、关键字与长度过滤，以及持续跟随新写入的
  记录；参数在读取用户配置前完成校验，命令只读转储目录，不访问网络或凭据。
- `channel send-image`：把本地 PNG/JPEG 图片交给 Gateway，由 Thread 绑定渠道的机器人凭据
  发送回对应会话；见 `docs/channel-image.md`。
- `webui`：启动本机只读指标与设置界面；监听参数在读取用户配置前完成校验。
- `service`：安装动作复用结构化服务安装任务，完整校验配置后生成全部后台服务定义，并启动 App Server
  与 Gateway；启停、重启、状态和日志命令使用
  `gateway`、`app-server`、`webui` 或 `all` 明确目标，日常 `restart` 默认只操作 Gateway；
  `all` 只包含 App Server 与 Gateway 两项核心服务；核心服务安装、启动或重启后按目标等待监管拓扑、
  WebSocket 与 Gateway 应用就绪状态稳定，再输出最终成功状态。状态、日志、停止、配置重载和卸载等
  诊断恢复操作不依赖配置文件可读，因此配置缺失或损坏时仍可管理已有后台服务；`status --json`
  把 macOS launchd、Linux systemd 与 Windows 用户级计划任务归一为同一状态结构，服务异常时仍输出
  可解析 JSON 并返回非零状态。Windows 由隐藏的 PowerShell 7 启动器和当前 SID 私有 IPC 管理，无需
  管理员权限，登录当前用户后启动。

内部 `service-app-server` 入口同时监管主 App Server、可选 Provider App Server，以及每个已启用
Provider 的独立回环统计代理（DS、OpenCode Go 与 CCG 各自的全部账户共享一个）；任一非主动释放的受监管组件异常
退出都会共同重建。主 App Server 与 Provider App Server 都支持按需启动和释放；Gateway 全局空闲
释放会停止未被租约占用的实例。监管入口记录运行、主动释放与租约状态，防止 Gateway 立即把实例重新拉起，并按实例串行
处理启动、释放和租约获取；释放结果区分已释放、租约占用与实例未运行，防止并发租约误停 Remote TUI。
再次使用自动启动。代理指标通过私有 Unix Socket
发送给 Gateway，Gateway 生命周期不再控制模型数据通路。入口持有独立 `0600` 监管 Socket，
用于跨进程互斥和向前台启动器证明精确 Provider 拓扑；它同时集中拒绝已被裸进程占用的 App
Server Socket。启动主 App Server 与 Provider App Server 前，入口把 `[codex].terminal_identity`
写入子进程的 `TERM_PROGRAM` / `TERM_PROGRAM_VERSION`，供 Codex 在模型上游 `User-Agent` 中上报
终端标识；未配置时保持环境原样，由 Codex 自行探测。`codexc service install` 在生成服务定义
前、本地更新真正重启核心服务前，若该值未配置且运行命令的终端可探测，则按该终端补入配置并
提示一次；已配置或探测不到终端时保持配置不变；补入失败只提示原因并继续当前命令。`start`、
`restart`、`reload`、`stop`、`status`、`logs` 与 `uninstall` 不改写该配置。

所有公开命令和子命令都支持 `-h` / `--help`；`gateway` 与 `service-app-server` 仅作为服务模板的
内部进程入口，不出现在公开命令列表。CLI 只负责参数校验、环境装配和进程分发，不保存
Conversation、Thread 或审批状态。新增用户命令时应复用现有应用能力或脚本，并同步更新根目录
README 和 CLI 测试。

公开命令的操作状态统一使用 `[成功]`、`[失败]`、`[提示]` 和 `[处理]`，Doctor 检查项另用
`[通过]`；着色只作用于这些状态标签。路径、标识符、结构化输出、列表和日志保持原始格式，避免
呈现层破坏脚本解析。
