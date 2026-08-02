# Approval

本目录协调平台无关的审批请求、授权语义和用户决定；App Server Server Request 的解码与响应
编码由 `codex-client` 负责。

## 文件

- `index.ts`：本模块的公开导出入口。
- `requests.ts`：定义命令、文件、临时权限、用户输入与 MCP elicitation 的稳定请求、响应和规则类型。
- `types.ts`：命令、文件修改、权限、用户输入和 MCP elicitation 的可辨识联合，以及 `InteractionPort`。
- `interaction-decision.ts`：把 Surface 已验证的审批选择统一映射为一次、会话、命令规则、网络规则
  或拒绝决定，并再次校验当前请求确实提供对应能力。
- `coordinator.ts`：验证请求归属，分派交互，处理拒绝、一次/会话批准、命令前缀规则和跨客户端解决。
- `interaction-router.ts`：按 `surface + accountId` 将请求路由到对应 Surface，并按完整 Conversation
  有界串行审批、用户输入和 MCP 交互；不同 Conversation 可并行。重复请求、容量溢出、未注册、
  渠道不可用、超时、关闭或不支持的交互默认拒绝或取消；渠道故障时只清理对应账号的活动与排队
  交互，恢复前的新请求立即失败关闭，不影响其他渠道账号。同时提供按 Thread 查询待处理交互的只读保护，
  供空闲会话跨渠道接管在转移绑定前失败关闭，不迁移审批、输入或 MCP 交互。

审批必须绑定 Thread、协议提供的 Turn 与请求标识。MCP elicitation 无法关联活动 Turn 时允许
`turnId` 为 `null`，此时 App Server 请求 ID 是该交互的协议身份。未知、缺少必需归属信息或
无法路由的高权限请求默认拒绝或取消；Surface 只实现 `InteractionPort`，不复制审批状态机。
协调器只记录请求 ID、类型、Thread、Turn 和路由结果等脱敏身份字段；没有 Thread 绑定或没有
对应 Surface 端口时必须记录明确的安全拒绝原因，不得记录命令、审批理由、表单内容或 MCP
输入正文。Surface 在平台创建交互消息后记录送达结果，便于区分上游未请求、路由失败和平台
发送失败。
固定版本 MCP 工具审批通过 form elicitation 的
`_meta.codex_approval_kind = "mcp_tool_call"` 识别；协调器只把上游明确提供的
`session` / `always` 持久范围交给 Surface，并在用户选择后原样返回 `_meta.persist`。
普通 MCP form 仍按 JSON 输入处理，工具审批不得降级为要求用户手写 JSON。
本模块不导入 `codex-client` 或 `codex-protocol`，也不接收原始 RPC method/params；畸形与未知
Server Request 在 Client 适配边界安全拒绝，原始 params 不进入业务模块或错误消息。
命令审批携带实验性的额外网络或文件系统权限时，Client 适配器必须先按当前协议基线验证，
`coordinator.ts` 再将权限明细加入审批内容；实验决策清单未提供一次批准时必须拒绝，未知或畸形
权限形状不得弹出可批准的降级审批。会话批准只在协议提供 `acceptForSession` 时显示并按原值返回；文件审批按
当前协议支持同一选项。命令前缀持久批准只在 `proposedExecpolicyAmendment` 与协议提供的
`acceptWithExecpolicyAmendment` 完全一致时显示，用户显式选择后原样返回提议，由 App Server
负责更新内存和磁盘规则。网络持久批准同样只接受
`proposedNetworkPolicyAmendments` 与 `applyNetworkPolicyAmendment` 中完全一致的主机和动作，
且每条规则必须与 `networkApprovalContext.host` 一致；网络专用请求可以不含命令，但必须显示
目标主机和协议。畸形或不一致的网络上下文、提议和决策必须在进入 Surface 前失败关闭。网络会话
批准只作用于该上下文主机，持久批准只返回用户明确选择的单条规则；两类持久规则都与
`acceptForSession` 独立。临时权限始终保持 Turn 作用域。
