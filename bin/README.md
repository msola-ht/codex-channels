# CLI 入口

本目录保存 npm 包对用户暴露的 `codexc` 可执行入口。

## 文件

- `codexc.mjs`：解析顶层命令，并把工作转交给 Gateway 入口或 `scripts/` 中的管理脚本；`doctor`
  会执行安装、配置和服务连通性诊断。

## 命令范围

- `init`、`setup`、`config`：初始化、从统一菜单选择配置模块，或打开交互式配置与设置菜单
  （操作详情、计划更新、按提供商的价格显示方式、调试模式、审批超时、Sandbox、默认工作区与
  模型、WebUI、指标、Telegram 消息格式等配置文件参数，以及配置路径）；`config` 在非交互终端仍直接显示
  用户级 `.codex-connect` 配置路径。
- `doctor`：诊断当前 TOML 配置、安装、Linux `bubblewrap` 沙箱前置条件、主 App Server 与已配置
  Provider App Server 的监管拓扑、实际版本和连通性；完成全部检测后按领域只展示失败、提示与处理建议，
  交互终端使用不同颜色并汇总结果；Linux 缺少 `bubblewrap` 时输出 `[处理]` 安装建议，不改写配置。
- `start`：在前台复用内部 `service-app-server` 监管入口启动 App Server、Provider 统计代理与
  Gateway；只有监管身份、Provider 拓扑和真实 WebSocket 健康检查全部匹配的现有 App Server
  才可复用；Gateway 自身使用与 Provider 无关的配置级所有权 Socket，重复 Gateway 与未受监管
  App Server 均失败关闭；强制停止时等待本次前台启动创建的进程组退出后再结束公开命令。
- `remote`：连接共享 App Server 并启动原生 Codex TUI；切换模式可用 `--profile deepseek` 或
  `--profile opencode-go-<账户>` 选择隔离实例；
  预期配置错误只展示一次，TUI 的终止信号原样返回调用终端。
- `work`：把参数交给 `scripts/workspace-command.mjs`，列出、注册、移除 Workspace，或进入交互式权限菜单。
- `rules`：为当前 Git/Node 项目生成或检查 `.codex/rules/default.rules`，不修改 Workspace Registry。
- `agents`：选择、查看或停用 Codex multi_agent_v2 的共享第三方子代理（`agents.external`）；
  `agents status` 只读取 Codex 用户配置，不要求 Gateway 已初始化。
- `opencode-go account`：新增、列出、删除、设置默认或停止 OpenCode Go 账户；Key 只写入
  `0600` 私有 Profile，`stop` 通过 App Server 监管 Socket 释放对应隔离实例。
- `update`：Git 源码安装先在临时仓库构建并预检官方 `main` 最新提交，切换后再统一审查并更新用户
  配置、状态数据库和指标数据库，然后恢复核心服务；npm 安装不修改程序包。
- `uninstall`：只卸载当前受管 Git 源码安装；先卸载后台服务，再删除源码仓库、对应 npm 全局命令
  和旧 Shell PATH 配置，保留用户配置、数据库、凭据、日志和输出。Registry 安装交给 npm 卸载。
- `state`：在 Gateway 停止后显式备份并升级业务状态数据库。
- `metrics`：查询、导出、清理或显式维护独立模型指标库；日常兼容升级使用 `update`。
- `channel send-image`：把本地 PNG/JPEG 图片交给 Gateway，由当前飞书/微信/Telegram
  会话的机器人凭据发送回绑定会话；见 `docs/channel-image.md`。
- `webui`、`center`：分别启动本机只读指标界面和多设备指标中心；监听参数在读取用户配置前完成校验。
- `service`：完整校验配置后安装整套后台服务；启停、重启、状态和日志命令使用
  `gateway`、`app-server`、`webui`、`center` 或 `all` 明确目标，日常 `restart` 默认只操作 Gateway；
  `all` 只包含 App Server 与 Gateway 两项核心服务；核心服务安装、启动或重启后按目标等待监管拓扑、
  WebSocket 与 Gateway 应用就绪状态稳定，再输出最终成功状态。状态、日志、停止、配置重载和卸载等
  诊断恢复操作不依赖配置文件可读，因此配置缺失或损坏时仍可管理已有后台服务。

内部 `service-app-server` 入口同时监管主 App Server、可选 Provider App Server，以及每个已启用
Provider 的独立回环统计代理（全部 OpenCode Go 账户共享一个）；任一受监管组件退出都会共同重建。
账户隔离实例空闲超过 5 分钟（无活动 Turn、无绑定、非 `agents.external` 默认账户）由
`releaseProvider` 释放，再次使用自动拉起。代理指标通过私有 Unix Socket
发送给 Gateway，Gateway 生命周期不再控制模型数据通路。入口持有独立 `0600` 监管 Socket，
用于跨进程互斥和向前台启动器证明精确 Provider 拓扑；它同时集中拒绝已被裸进程占用的 App
Server Socket。

所有公开命令和子命令都支持 `-h` / `--help`；`gateway` 与 `service-app-server` 仅作为服务模板的
内部进程入口，不出现在公开命令列表。CLI 只负责参数校验、环境装配和进程分发，不保存
Conversation、Thread 或审批状态。新增用户命令时应复用现有应用能力或脚本，并同步更新根目录
README 和 CLI 测试。

公开命令的操作状态统一使用 `[成功]`、`[失败]`、`[提示]` 和 `[处理]`，Doctor 检查项另用
`[通过]`；着色只作用于这些状态标签。路径、标识符、结构化输出、列表和日志保持原始格式，避免
呈现层破坏脚本解析。
