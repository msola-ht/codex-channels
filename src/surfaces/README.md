# Surface Adapters

本目录保存外部交互平台适配器。Surface 负责把平台输入转换为 Application 命令，并把 Core 输出和审批交互渲染为平台消息。

`index.ts` 是所有 Surface 的公开导出入口。

当前实现：

- [`telegram/`](telegram/README.md)：Telegram Bot 输入、输出、交互、图片和生命周期。

新增 Surface 时应实现统一输入、输出和审批边界，通过 Application/Core 接入；不得直接操作底层 JSON-RPC Transport，也不得把平台类型引入 Conversation Core。
