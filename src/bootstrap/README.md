# Bootstrap

本目录是模块化单体的组合根，负责创建具体依赖并管理 Gateway 进程生命周期。

## 文件

- `index.ts`：向进程入口公开 `GatewayApplication`。
- `app.ts`：校验 Codex 版本，装配 Transport、Client、Core、Router、Storage、Policy 和显式注册的 Surface 集合；处理启动、配置热加载、重连、订阅恢复与关闭。
- `surface-manager.ts`：按注册顺序启动 Surface，失败时反向回滚，并在关闭时隔离各 Surface 的异常。

业务状态和平台逻辑应留在对应模块，只有具体实现选择、交互端口注册与生命周期协调放在这里。
未启用 Surface 的持久绑定应保留但不恢复订阅。Gateway 关闭不得主动终止独立运行的 Codex App Server。
启动、停止和重连由同一生命周期协调；停止会中断启动中的 Codex 请求、取消并限时等待重连任务，
且不会把主动关闭误判为永久 Thread 恢复失败。
