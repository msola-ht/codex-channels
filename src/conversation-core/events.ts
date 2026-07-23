import type {
  AccountUpdatedNotification,
  McpServerStatusUpdatedNotification,
  MessagePhase,
  RateLimitSnapshot,
  ThreadTokenUsage,
  TurnPlanStep,
} from "../codex-protocol/index.js";

export interface ConversationTarget {
  surface: "telegram";
  conversationId: string;
}

export const gatewayUserMessageClientIdPrefix = "codex_connect_gateway:";

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

export interface TurnArtifacts {
  threadId: string;
  turnId: string;
  diff?: string;
  plan?: {
    explanation: string | null;
    steps: TurnPlanStep[];
  };
}

export type OutputEvent =
  | { type: "turn.started"; target: ConversationTarget; threadId: string; turnId: string }
  | { type: "user.message"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string }
  | { type: "text.delta"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string; phase?: MessagePhase | null }
  | { type: "text.completed"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string; phase?: MessagePhase | null }
  | { type: "operation.updated"; target: ConversationTarget; threadId: string; turnId: string; operation: OperationUpdate }
  | { type: "turn.completed"; target: ConversationTarget; threadId: string; turnId: string; status: string; error?: string; tokenUsage?: ThreadTokenUsage; model?: string; effort?: string | null }
  | { type: "thread.status"; target: ConversationTarget; threadId: string; status: string }
  | { type: "connection.lost"; target: ConversationTarget; threadId: string; message: string }
  | ({ type: "account.updated"; target: ConversationTarget } & AccountUpdatedNotification)
  | { type: "account.rateLimits.updated"; target: ConversationTarget; rateLimits: RateLimitSnapshot }
  | ({ type: "mcp.status.updated"; target: ConversationTarget } & McpServerStatusUpdatedNotification)
  | { type: "warning"; target: ConversationTarget; threadId?: string; message: string };

export function isCriticalOutputEvent(event: OutputEvent): boolean {
  return event.type !== "text.delta" && event.type !== "turn.started" &&
    !(event.type === "operation.updated" && event.operation.status === "running");
}
