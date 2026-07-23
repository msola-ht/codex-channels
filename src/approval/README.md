# Approval

本目录把 App Server 发来的 Server Request 转换为平台无关的交互请求，并将用户决定映射回协议响应。

## 文件

- `index.ts`：本模块的公开导出入口。
- `types.ts`：命令、文件修改、权限、用户输入和 MCP elicitation 的可辨识联合，以及 `InteractionPort`。
- `coordinator.ts`：验证请求归属，分派交互，处理超时、拒绝、一次批准和跨客户端解决。
- `interaction-router.ts`：按 `surface + accountId` 将请求路由到对应 Surface；未注册目标默认拒绝或取消。

审批必须绑定 Thread、协议提供的 Turn 与请求标识。MCP elicitation 无法关联活动 Turn 时允许
`turnId` 为 `null`，此时 App Server 请求 ID 是该交互的协议身份。未知、缺少必需归属信息或
无法路由的高权限请求默认拒绝或取消；Surface 只实现 `InteractionPort`，不复制审批状态机。
