import type {
  AccountStatus,
  McpServerStatus,
  MessagePhase,
  OperationUpdate,
  RateLimitSnapshot,
  ThreadGoal,
  ThreadTokenUsage,
  TurnPlanStep,
  TurnStatus,
} from "./events.js";

export type ConversationInputEvent =
  | { type: "turn.started"; threadId: string; turnId: string; receivedAtMs?: number }
  | {
      type: "thread.tokenUsage.updated";
      threadId: string;
      turnId: string;
      tokenUsage: ThreadTokenUsage;
    }
  | { type: "thread.goal.updated"; threadId: string; goal: ThreadGoal }
  | { type: "thread.goal.cleared"; threadId: string }
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
      receivedAtMs?: number;
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
      type: "turn.modelTiming.updated";
      threadId: string;
      turnId: string;
      operation?: "response" | "compact";
      model?: string;
      requestStartedAtMs: number;
      requestDurationMs: number;
      outcome?: "completed" | "interrupted" | "incomplete" | "failed";
      retryableFailure?: boolean;
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      reasoningOutputTokens?: number;
      ttftMs?: number;
      thinkingDurationMs?: number;
      outputDurationMs?: number;
      generationDurationMs?: number;
      pricingCurrency?: string;
      totalCostNanos?: number;
      uncachedInputCostNanos?: number;
      cachedInputCostNanos?: number;
      outputCostNanos?: number;
      uncachedInputPricePerMillionNanos?: number;
      cachedInputPricePerMillionNanos?: number;
      outputPricePerMillionNanos?: number;
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
      threadId: string;
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
      durationMs?: number;
    }
  | { type: "thread.status.changed"; threadId: string; status: string }
  | { type: "thread.closed"; threadId: string }
  | { type: "thread.archived"; threadId: string }
  | { type: "thread.deleted"; threadId: string }
  | ({ type: "account.updated"; modelProvider?: string } & AccountStatus)
  | {
      type: "account.rateLimits.updated";
      rateLimits: RateLimitSnapshot;
      modelProvider?: string;
    }
  | ({ type: "mcp.status.updated"; modelProvider?: string } & McpServerStatus)
  | {
      type: "warning";
      threadId: string | null;
      message: string;
      modelProvider?: string;
    };
