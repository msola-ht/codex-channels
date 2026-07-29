export const contentTruncatedText = "内容过长，已截断";
export const emptyCodexResponseText = "Codex 返回了空消息。";
export const interactionStoppedText = "已停止当前交互请求。";

export function formatCodexWarning(message: string): string {
  return `Codex 警告：${message}`;
}

export function formatConnectionLost(message: string): string {
  return `Codex 连接已中断：${message}`;
}

export function formatOperationFailure(detail: string): string {
  return `操作失败：${detail}。`;
}
