# CLI 入口

本目录保存 npm 包对用户暴露的 `codexc` 可执行入口。

## 文件

- `codexc.mjs`：解析顶层命令，并把工作转交给 Gateway 入口或 `scripts/` 中的管理脚本；`doctor`
  会执行安装、配置和服务连通性诊断。

## 命令范围

- `init`、`setup`、`config`：初始化、从统一菜单选择配置模块，或显示用户级
  `.codex-connect` 配置。
- `doctor`：诊断当前 TOML 配置、安装与连通性，不改写配置。
- `start`：在前台启动已构建的 App Server 与 Gateway。
- `remote`：连接共享 App Server 并启动原生 Codex TUI。
- `ws`：列出或注册 Workspace。
- `rules`：为当前 Git/Node 项目生成或检查 `.codex/rules/default.rules`，不修改 Workspace Registry。
- `service`：完整校验配置后安装整套后台服务；启停、重启、状态和日志命令使用
  `gateway`、`app-server` 或 `all` 明确目标，日常 `restart` 默认只操作 Gateway。

所有公开命令和子命令都支持 `-h` / `--help`；`gateway` 与 `service-app-server` 仅作为服务模板的
内部进程入口，不出现在公开命令列表。CLI 只负责参数校验、环境装配和进程分发，不保存
Conversation、Thread 或审批状态。新增用户命令时应复用现有应用能力或脚本，并同步更新根目录
README 和 CLI 测试。
