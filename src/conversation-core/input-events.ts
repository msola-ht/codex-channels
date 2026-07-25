import type {
  AccountStatus,
  McpServerStatus,
  MessagePhase,
  OperationUpdate,
  RateLimitSnapshot,
  ThreadTokenUsage,
  TurnPlanStep,
  TurnStatus,
} from "./events.js";

export type ConversationInputEvent =
  | { type: "turn.started"; threadId: string; turnId: string }
  | {
      type: "thread.tokenUsage.updated";
      threadId: string;
      turnId: string;
      tokenUsage: ThreadTokenUsage;
    }
  | { type: "turn.diff.updated"; threadId: string; turnId: string; diff: string }
  | {
      type: "turn.plan.updated";
      threadId: string;
      turnId: string;
      explanation: string | null;
      plan: TurnPlanStep[];
    }
  | {
      type: "item.agentMessage.started";
      threadId: string;
      turnId: string;
      itemId: string;
      phase: MessagePhase | null;
    }
  | {
      type: "item.agentMessage.delta";
      threadId: string;
      turnId: string;
      itemId: string;
      text: string;
    }
  | {
      type: "item.agentMessage.completed";
      threadId: string;
      turnId: string;
      itemId: string;
      text: string;
      phase: MessagePhase | null;
    }
  | {
      type: "item.userMessage";
      threadId: string;
      turnId: string;
      itemId: string;
      clientId: string | null;
      text: string;
    }
  | {
      type: "item.operation.updated";
      threadId: string;
      turnId: string;
      operation: OperationUpdate;
    }
  | {
      type: "turn.error";
      turnId: string;
      message: string;
      willRetry: boolean;
    }
  | {
      type: "turn.completed";
      threadId: string;
      turnId: string;
      status: TurnStatus;
      error: string | null;
    }
  | { type: "thread.status.changed"; threadId: string; status: string }
  | { type: "thread.closed"; threadId: string }
  | { type: "thread.archived"; threadId: string }
  | { type: "thread.deleted"; threadId: string }
  | ({ type: "account.updated" } & AccountStatus)
  | { type: "account.rateLimits.updated"; rateLimits: RateLimitSnapshot }
  | ({ type: "mcp.status.updated" } & McpServerStatus)
  | { type: "warning"; threadId: string | null; message: string };
