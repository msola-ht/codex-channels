import type { MessagePhase, ThreadTokenUsage } from "../codex-protocol/index.js";

export interface ConversationTarget {
  surface: "telegram";
  conversationId: string;
}

export const gatewayUserMessageClientIdPrefix = "codex_tg_gateway:";

export type OperationStatus = "running" | "completed" | "failed" | "declined";
export type OperationKind =
  | "command"
  | "fileChange"
  | "mcpTool"
  | "dynamicTool"
  | "subagent"
  | "webSearch"
  | "imageView"
  | "imageGeneration"
  | "sleep"
  | "plan"
  | "contextCompaction"
  | "reviewMode";

export interface OperationUpdate {
  itemId: string;
  kind: OperationKind;
  action?: string;
  detail?: string;
  status: OperationStatus;
  durationMs?: number;
  exitCode?: number;
}

export type OutputEvent =
  | { type: "turn.started"; target: ConversationTarget; threadId: string; turnId: string }
  | { type: "user.message"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string }
  | { type: "text.delta"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string; phase?: MessagePhase | null }
  | { type: "text.completed"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string; phase?: MessagePhase | null }
  | { type: "operation.updated"; target: ConversationTarget; threadId: string; turnId: string; operation: OperationUpdate }
  | { type: "turn.completed"; target: ConversationTarget; threadId: string; turnId: string; status: string; error?: string; tokenUsage?: ThreadTokenUsage }
  | { type: "thread.status"; target: ConversationTarget; threadId: string; status: string }
  | { type: "connection.lost"; target: ConversationTarget; threadId: string; message: string }
  | { type: "warning"; target: ConversationTarget; threadId?: string; message: string };

export function isCriticalOutputEvent(event: OutputEvent): boolean {
  return event.type !== "text.delta" && event.type !== "turn.started" &&
    !(event.type === "operation.updated" && event.operation.status === "running");
}
