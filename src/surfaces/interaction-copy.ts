export const interactionProcessedTitle = "Codex 交互已处理";
export const interactionCancelledTitle = "Codex 交互已取消";

export const interactionOutcome = {
  answered: "已提交回答",
  cancelled: "已取消",
  completed: "已确认完成",
  formSubmitted: "已提交表单",
  mcpAllowedAlways: "已始终允许",
  mcpAllowedOnce: "已允许一次",
  mcpAllowedSession: "已在本会话允许",
  resolvedElsewhere: "已在其他客户端处理",
  timedOut: "请求已超时",
  userInputFailed: "输入请求无法继续，已安全取消",
} as const;

export function formatProcessedInteractionOutcome(outcome: string): string {
  return `${interactionProcessedTitle}：${outcome}。`;
}

export function formatCancelledInteraction(reason?: string): string {
  return reason
    ? `${interactionCancelledTitle}：${reason}。`
    : `${interactionCancelledTitle}。`;
}
