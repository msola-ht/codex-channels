# Config

本目录负责把进程环境转换为经过验证的 Gateway 配置。

## 文件

- `index.ts`：使用 Zod 校验 Telegram、Codex、Workspace、Socket、数据库、代理、沙箱、超时和日志配置，并规范化路径与 URL。

外部输入只在此边界验证一次。配置错误必须抛出 `ConfigurationError` 并阻止启动，不能静默采用更宽松的权限、目录或网络默认值。
