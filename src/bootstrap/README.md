# Bootstrap

本目录是模块化单体的组合根，负责创建具体依赖并管理 Gateway 进程生命周期。

## 文件

- `index.ts`：向进程入口公开 `GatewayApplication`。
- `app.ts`：校验 Codex 版本，装配 Transport、Client、Core、Router、Storage、Policy 和 Telegram Surface；处理启动、配置热加载、重连、订阅恢复与关闭。

业务状态和平台逻辑应留在对应模块，只有具体实现选择与生命周期协调放在这里。Gateway 关闭不得主动终止独立运行的 Codex App Server。
