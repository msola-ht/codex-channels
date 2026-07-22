# CLI 入口

本目录保存 npm 包对用户暴露的可执行入口。`package.json` 中的 `codexc` 与 `codex-connect` 都指向同一个入口文件。

## 文件

- `codexc.mjs`：解析顶层命令，并把工作转交给 Gateway 入口或 `scripts/` 中的管理脚本；`doctor` 会执行安装、配置和服务连通性诊断。

## 命令范围

- `init`、`config`：初始化或显示用户级 `.codex-connect` 配置。
- `start`：启动已构建的 Gateway。
- `remote`：连接共享 App Server 并启动原生 Codex TUI。
- `ws`：列出或注册 Workspace。
- `service`：安装、启停、重启、查看或卸载 macOS 服务。

CLI 只负责参数校验、环境装配和进程分发，不保存 Conversation、Thread 或审批状态。新增用户命令时应复用现有应用能力或脚本，并同步更新根目录 README 和 CLI 测试。
