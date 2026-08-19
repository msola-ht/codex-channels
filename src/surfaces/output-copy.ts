export const contentTruncatedText = "内容过长，已截断";
export const emptyCodexResponseText = "Codex 返回了空消息。";
export const interactionStoppedText = "已停止当前交互请求。";
export const cliInputTitle = "CLI 输入";
export const gatewayRequestFailedText = "Gateway 未能完成请求，请稍后重试";

export function formatCliInput(text: string): string {
  return `${cliInputTitle}\n\n${text}`;
}

export function formatCodexWarning(message: string): string {
  return `Codex 警告：${message}`;
}

export function formatConnectionLost(message: string): string {
  return `Codex 连接已中断：${message}`;
}

export function formatConnectionRestored(message: string): string {
  return `Codex 连接已恢复：${message}`;
}

export function formatThreadAvailability(
  availability: "occupied" | "available",
  threadId: string,
  background = false,
): string {
  const subject = background ? `后台会话 ${threadId.slice(0, 12)}` : "当前会话";
  return availability === "occupied"
    ? `${subject}正在被另一个 Codex 客户端使用。Gateway 已正常启动；占用解除后会自动恢复。`
    : `${subject}的占用已解除，Gateway 已自动恢复。`;
}

export function formatOperationFailure(detail: string): string {
  return `操作失败：${detail}。`;
}
