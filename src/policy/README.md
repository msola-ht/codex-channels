# Policy

本目录集中处理用户和 Workspace 授权边界。

## 文件

- `index.ts`：本模块的公开导出入口。
- `telegram-access.ts`：校验 Telegram 用户是否在允许列表中，并支持原子替换热加载后的名单。
- `workspace-registry.ts`：保存服务端预配置 Workspace，支持安全热加载新增项，并解析默认项和显式选择。

Telegram 输入不能提交任意绝对工作目录；所有 Thread、Turn、Shell 和文件相关操作都必须使用 Registry 中已经授权的 Workspace。
