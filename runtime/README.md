# 共享运行时基础设施

本目录保存 npm CLI 与已编译 Gateway 必须直接共享的稳定 JavaScript 模块，不承载会话业务。

- `config-event-queue.mjs`：以有界、版本化、原子更新的队列保存待投递配置事件。

这里的模块同时被 `bin/`、`scripts/` 和 `src/bootstrap` 使用，必须保持无平台 SDK 依赖，并随 npm 包发布。
