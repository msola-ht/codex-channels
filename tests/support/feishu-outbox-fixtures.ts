import type { ConversationTarget, OutputEvent } from "../../src/conversation-core/index.js";

export const target = { surface: "feishu", accountId: "cli_app", conversationId: "oc_chat" } as const;

export function completed(targetOverrides: Partial<ConversationTarget> = {}, text = "飞书回复", itemId = text): OutputEvent {
  return { type: "text.completed", target: { ...target, ...targetOverrides }, threadId: "thread-1", turnId: "turn-1", itemId, text };
}
export function operationUpdated(status: "running" | "completed", kind: Extract<OutputEvent, { type: "operation.updated" }>["operation"]["kind"] = "command", itemId = "command-1", detail = "git status --short"): Extract<OutputEvent, { type: "operation.updated" }> {
  return { type: "operation.updated", target, threadId: "thread-1", turnId: "turn-1", operation: { itemId, kind, detail, status, ...(status === "completed" ? { durationMs: 125, exitCode: 0 } : {}) } };
}
export function delta(text: string, itemId = "item-1"): OutputEvent { return { type: "text.delta", target, threadId: "thread-1", turnId: "turn-1", itemId, text }; }
export function threadStatus(status: string): OutputEvent { return { type: "thread.status", target, threadId: "thread-1", status }; }
export function turnCompleted(): OutputEvent { return { type: "turn.completed", target, threadId: "thread-1", sessionName: "测试会话", turnId: "turn-1", status: "completed" }; }
