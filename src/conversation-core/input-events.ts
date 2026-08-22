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
  | { type: "thread.reverted"; threadId: string }
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
      type: "item.reasoning.delta";
      threadId: string;
      turnId: string;
      itemId: string;
    }
  | {
      type: "item.subagentActivity";
      threadId: string;
      turnId: string;
      itemId: string;
      agentThreadId: string;
      agentPath: string;
      kind: "started" | "interacted" | "interrupted";
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
      /** 请求开始时段对应的峰谷档位（仅支持峰谷定价的 Provider 提供） */
      pricingBucket?: "peak" | "off-peak";
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
      type: "mcp.oauth.completed";
      threadId: string | null;
      name: string;
      success: boolean;
      error: string | null;
      modelProvider?: string;
    }
  | {
      type: "warning";
      threadId: string | null;
      message: string;
      modelProvider?: string;
    };
