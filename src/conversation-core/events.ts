export type SurfaceId = string;
export type MessagePhase = "commentary" | "final_answer";
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type TurnPlanStepStatus = "pending" | "inProgress" | "completed";
export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";
export type AuthMode =
  | "apikey"
  | "chatgpt"
  | "chatgptAuthTokens"
  | "headers"
  | "agentIdentity"
  | "personalAccessToken"
  | "bedrockApiKey";
export type PlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_usage_based"
  | "business"
  | "ent26"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "unknown";
export type RateLimitReachedType =
  | "rate_limit_reached"
  | "workspace_owner_credits_depleted"
  | "workspace_member_credits_depleted"
  | "workspace_owner_usage_limit_reached"
  | "workspace_member_usage_limit_reached";
export type McpServerStartupState = "starting" | "ready" | "failed" | "cancelled";
export type McpServerStartupFailureReason = "reauthenticationRequired";

export interface TurnPlanStep {
  step: string;
  status: TurnPlanStepStatus;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface ThreadTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export interface ThreadGoal {
  threadId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface TurnOutputTiming {
  ttftMs?: number;
  outputDurationMs?: number;
  thinkingDurationMs?: number;
  nonReasoningOutputTokens?: number;
  reasoningTokens?: number;
  outputTokensPerSecond?: number;
  thinkingTokensPerSecond?: number;
  generationTokensPerSecond?: number;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
  spendControlReached: boolean | null;
  planType: PlanType | null;
  rateLimitReachedType: RateLimitReachedType | null;
}

export interface AccountStatus {
  authMode: AuthMode | null;
  planType: PlanType | null;
}

export interface McpServerStatus {
  threadId: string | null;
  name: string;
  status: McpServerStartupState;
  error: string | null;
  failureReason: McpServerStartupFailureReason | null;
}

export interface ConversationTarget {
  surface: SurfaceId;
  accountId: string;
  conversationId: string;
}

export const gatewayUserMessageClientIdPrefix = "codex_connect_gateway:";

export function surfaceAccountKey(surface: SurfaceId, accountId: string): string {
  return JSON.stringify([surface, accountId]);
}

export function conversationTargetKey(target: ConversationTarget): string {
  return JSON.stringify([target.surface, target.accountId, target.conversationId]);
}

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
  imagePath?: string;
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
  | { type: "plan.updated"; target: ConversationTarget; threadId: string; turnId: string; explanation: string | null; steps: TurnPlanStep[] }
  | { type: "turn.completed"; target: ConversationTarget; threadId: string; turnId: string; status: TurnStatus; error?: string; durationMs?: number; timing?: TurnOutputTiming; tokenUsage?: ThreadTokenUsage; model?: string; modelProvider?: string; effort?: string | null; serviceTier?: string | null; weeklyLimit?: NonNullable<RateLimitSnapshot["secondary"]>; goal?: ThreadGoal; contextCompactionCount?: number; gitBranch?: string | undefined }
  | { type: "thread.status"; target: ConversationTarget; threadId: string; status: string }
  | { type: "connection.lost"; target: ConversationTarget; threadId: string; message: string }
  | ({ type: "account.updated"; target: ConversationTarget } & AccountStatus)
  | { type: "account.rateLimits.updated"; target: ConversationTarget; rateLimits: RateLimitSnapshot }
  | ({ type: "mcp.status.updated"; target: ConversationTarget } & McpServerStatus)
  | { type: "warning"; target: ConversationTarget; threadId?: string; message: string };

export function isCriticalOutputEvent(event: OutputEvent): boolean {
  return event.type !== "text.delta" && event.type !== "turn.started" &&
    event.type !== "plan.updated" &&
    !(event.type === "operation.updated" && event.operation.status === "running");
}

export function usesOpenAiAccount(modelProvider: string | undefined): boolean {
  return (modelProvider ?? "openai") === "openai";
}
