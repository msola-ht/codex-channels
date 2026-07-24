# Approval

本目录把 App Server 发来的 Server Request 转换为平台无关的交互请求，并将用户决定映射回协议响应。

## 文件

- `index.ts`：本模块的公开导出入口。
- `types.ts`：命令、文件修改、权限、用户输入和 MCP elicitation 的可辨识联合，以及 `InteractionPort`。
- `coordinator.ts`：验证请求归属，分派交互，处理超时、拒绝、一次/会话批准、命令前缀规则和跨客户端解决。
- `interaction-router.ts`：按 `surface + accountId` 将请求路由到对应 Surface；未注册目标默认拒绝或取消。

审批必须绑定 Thread、协议提供的 Turn 与请求标识。MCP elicitation 无法关联活动 Turn 时允许
`turnId` 为 `null`，此时 App Server 请求 ID 是该交互的协议身份。未知、缺少必需归属信息或
无法路由的高权限请求默认拒绝或取消；Surface 只实现 `InteractionPort`，不复制审批状态机。
命令审批携带实验性的额外网络或文件系统权限时，`coordinator.ts` 必须先按当前协议基线验证并
将权限明细加入审批内容；实验决策清单未提供一次批准时必须拒绝，未知或畸形权限形状不得弹出
可批准的降级审批。会话批准只在协议提供 `acceptForSession` 时显示并按原值返回；文件审批按
当前协议支持同一选项。命令前缀持久批准只在 `proposedExecpolicyAmendment` 与协议提供的
`acceptWithExecpolicyAmendment` 完全一致时显示，用户显式选择后原样返回提议，由 App Server
负责更新内存和磁盘规则。网络持久批准同样只接受
`proposedNetworkPolicyAmendments` 与 `applyNetworkPolicyAmendment` 中完全一致的主机和动作，
且每条规则必须与 `networkApprovalContext.host` 一致；网络专用请求可以不含命令，但必须显示
目标主机和协议。畸形或不一致的网络上下文、提议和决策必须在进入 Surface 前失败关闭。网络会话
批准只作用于该上下文主机，持久批准只返回用户明确选择的单条规则；两类持久规则都与
`acceptForSession` 独立。临时权限始终保持 Turn 作用域。
