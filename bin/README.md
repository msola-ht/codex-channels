# CLI 入口

本目录保存 npm 包对用户暴露的 `codexc` 可执行入口。

## 文件

- `codexc.mjs`：解析顶层命令，并把工作转交给 Gateway 入口或 `scripts/` 中的管理脚本；`doctor`
  会执行安装、配置和服务连通性诊断。

## 命令范围

- `init`、`setup`、`config`：初始化、从统一菜单选择配置模块，或打开交互式配置与设置菜单
  （操作详情、计划更新、按提供商的价格显示方式、调试模式、审批超时、Sandbox、默认工作区与
  模型、Telegram 消息格式等配置文件参数，以及配置路径）；`config` 在非交互终端仍直接显示
  用户级 `.codex-connect` 配置路径。
- `doctor`：诊断当前 TOML 配置、安装、主 App Server 与已配置 Provider App Server 的实际版本和连通性，不改写配置。
- `start`：在前台启动已构建的 Provider 隔离 App Server 与 Gateway。
- `remote`：连接共享 App Server 并启动原生 Codex TUI；切换模式可用 `--profile deepseek` 选择隔离实例。
- `ws`：列出或注册 Workspace。
- `rules`：为当前 Git/Node 项目生成或检查 `.codex/rules/default.rules`，不修改 Workspace Registry。
- `state`：在 Gateway 停止后显式备份并升级业务状态数据库。
- `metrics`：只读检查独立模型指标库，或在 Gateway 停止后备份并重建不兼容的指标库。
- `service`：完整校验配置后安装整套后台服务；启停、重启、状态和日志命令使用
  `gateway`、`app-server` 或 `all` 明确目标，日常 `restart` 默认只操作 Gateway。

内部 `service-app-server` 入口同时监管主 App Server、可选 Provider App Server，以及每个已启用
Provider 的独立回环统计代理；任一受监管组件退出都会共同重建。代理指标通过私有 Unix Socket
发送给 Gateway，Gateway 生命周期不再控制模型数据通路。

所有公开命令和子命令都支持 `-h` / `--help`；`gateway` 与 `service-app-server` 仅作为服务模板的
内部进程入口，不出现在公开命令列表。CLI 只负责参数校验、环境装配和进程分发，不保存
Conversation、Thread 或审批状态。新增用户命令时应复用现有应用能力或脚本，并同步更新根目录
README 和 CLI 测试。
