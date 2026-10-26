import { toStructuredMarkdownList } from "./markdown-list.js";
import type { InteractionRequest } from "../approval/index.js";

export function formatInteractionQuestionHeading(
  request: Extract<InteractionRequest, { type: "user-input" }>,
  questionIndex: number,
): string {
  const header = request.questions[questionIndex]!.header
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();
  const number = `问题 ${questionIndex + 1}/${request.questions.length}`;
  if (request.asynchronous && header) return header;
  return header && header !== number ? `${number} · ${header}` : number;
}

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
  mcpDeclined: "已拒绝",
  resolvedElsewhere: "已在其他客户端处理",
  timedOut: "请求已超时",
  userInputFailed: "输入请求无法继续，已安全取消",
} as const;

export function formatProcessedInteractionOutcome(outcome: string): string {
  return toStructuredMarkdownList([
    interactionProcessedTitle,
    `结果：${outcome}。`,
  ].join("\n"));
}

export function formatCancelledInteraction(reason?: string): string {
  return toStructuredMarkdownList([
    interactionCancelledTitle,
    ...(reason ? [`原因：${reason}。`] : []),
  ].join("\n"));
}
