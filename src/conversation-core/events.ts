export type SurfaceId = string;
export type MessagePhase = "commentary" | "final_answer";
export type TurnStatus = "completed" | "interrupted" | "failed" | "inProgress";
export type TurnErrorCode = "misalignmentPolicyViolation";
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
  | "bedrockApiKey"
  | "bedrockAccessKeys";
export type PlanType =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "prolite"
  | "team"
  | "self_serve_business_prolite"
  | "self_serve_business_usage_based"
  | "business"
  | "ent26"
  | "enterprise_cbp_automation"
  | "enterprise_cbp_usage_based"
  | "enterprise"
  | "edu"
  | "edu_plus"
  | "edu_pro"
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

export interface CompactRequestMetricsSummary {
  model: string | null;
  hasMixedModels: boolean;
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
}

export interface TurnOutputTiming {
  modelRequestCount?: number;
  completedModelRequestCount?: number;
  interruptedModelRequestCount?: number;
  incompleteModelRequestCount?: number;
  failedModelRequestCount?: number;
  retryableFailureModelRequestCount?: number;
  reasoningRequestCount?: number;
  modelRequestDurationMs?: number;
  requestInputTokens?: number;
  requestCachedInputTokens?: number;
  requestOutputTokens?: number;
  ttftMs?: number;
  firstResponseLatencyMs?: number;
  outputDurationMs?: number;
  thinkingDurationMs?: number;
  nonReasoningOutputTokens?: number;
  reasoningTokens?: number;
  outputTokensPerSecond?: number;
  outputSpeedSampleCount?: number;
  outputSpeedTimedCount?: number;
  thinkingTokensPerSecond?: number;
  thinkingSpeedSampleCount?: number;
  thinkingSpeedTimedCount?: number;
  generationTokensPerSecond?: number;
  generationSpeedSampleCount?: number;
  generationSpeedTimedCount?: number;
  /** Turn 内最后一次模型请求的开始时间（毫秒），用于按请求时段选择峰谷档位 */
  modelRequestStartedAtMs?: number;
  referenceCost?: ReferenceCostSummary;
  compact?: CompactRequestMetricsSummary;
}

export interface ReferenceCostSummary {
  currency: string | null;
  totalCostNanos: number | null;
  inputTokens?: number;
  outputTokens?: number;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  pricedRequestCount: number;
  requestCount: number;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  /** 本 Turn 已计价请求出现过的峰谷档位（去重、稳定排序） */
  pricingBuckets?: Array<"peak" | "off-peak">;
}

export interface TurnTaskMetricsSummary {
  requestCount: number;
  unsuccessfulRequestCount: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  pricedRequestCount: number;
  pricedInputTokens: number;
  pricedOutputTokens: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  pricingCurrency: string | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  pricingBuckets?: Array<"peak" | "off-peak">;
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

export const gatewayUserMessageClientIdPrefix = "codex_connect:";

export function surfaceAccountKey(surface: SurfaceId, accountId: string): string {
  return JSON.stringify([surface, accountId]);
}

export function conversationTargetKey(target: ConversationTarget): string {
  return JSON.stringify([target.surface, target.accountId, target.conversationId]);
}

export type OperationStatus = "running" | "completed" | "failed" | "declined";
export type SubagentStatus =
  | "pendingInit"
  | "running"
  | "interrupted"
  | "completed"
  | "errored"
  | "shutdown"
  | "notFound";
export type SubagentTerminalStatus = Exclude<
  SubagentStatus,
  "pendingInit" | "running"
>;

export interface SubagentState {
  threadId: string;
  status: SubagentStatus;
}

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
  receiverThreadIds?: string[];
  subagentStates?: SubagentState[];
  status: OperationStatus;
  durationMs?: number;
  exitCode?: number;
  readOnlyHint?: boolean | null;
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

export interface TurnStartIdentity {
  kind: "skill" | "plugin" | "agent";
  name: string;
}

export interface RemoteQuotaSummary {
  provider: string;
  windowId: string;
  deviceCount: number;
  requestCount: number;
  totalTokens: number;
  totalCostNanos: number | null;
  latestUsedPercentMillionths: number | null;
  estimatedTotalTokens: number | null;
  estimatedTotalCostNanos: number | null;
  tokensPerPercent?: number | null;
  costPerPercentNanos?: number | null;
  observedAtMs: number;
}

export type OutputEvent =
  | { type: "turn.started"; target: ConversationTarget; threadId: string; turnId: string; identity?: TurnStartIdentity; background?: boolean }
  | { type: "user.message"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string; background?: boolean }
  | { type: "text.delta"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string; phase?: MessagePhase | null; background?: boolean }
  | { type: "text.completed"; target: ConversationTarget; threadId: string; turnId: string; itemId: string; text: string; phase?: MessagePhase | null; background?: boolean }
  | { type: "operation.updated"; target: ConversationTarget; threadId: string; turnId: string; operation: OperationUpdate; background?: boolean }
  | { type: "plan.updated"; target: ConversationTarget; threadId: string; turnId: string; explanation: string | null; steps: TurnPlanStep[]; background?: boolean }
  | { type: "subagent.spawned"; target: ConversationTarget; threadId: string; turnId: string; agentThreadId: string; agentPath: string; background?: boolean }
  | { type: "subagent.contacted"; target: ConversationTarget; threadId: string; turnId: string; agentThreadId: string; agentPath: string; background?: boolean }
  | { type: "subagent.completed"; target: ConversationTarget; parentThreadId: string; agentThreadId: string; agentPath: string; status: SubagentTerminalStatus; metricsStatus: "available" | "empty" | "unavailable"; model: string | null; modelProvider: string | null; reasoningEffort: string | null; requestCount: number; unsuccessfulRequestCount: number; pricedRequestCount: number; inputTokens: number; pricedInputTokens: number; cachedInputTokens: number | null; outputTokens: number; pricedOutputTokens: number; reasoningOutputTokens: number; outputTokensPerSecond: number | null; outputSpeedSampleCount: number; outputSpeedTimedCount: number; totalCostNanos: number | null; inputCostNanos: number | null; cachedInputCostNanos: number | null; outputCostNanos: number | null; pricingCurrency: string | null; elapsedMs: number; durationMs: number }
  | { type: "turn.completed"; target: ConversationTarget; threadId: string; sessionName?: string | null; turnId: string; status: TurnStatus; error?: string; errorCode?: TurnErrorCode; durationMs?: number; timing?: TurnOutputTiming; tokenUsage?: ThreadTokenUsage; model?: string; modelProvider?: string; effort?: string | null; serviceTier?: string | null; weeklyLimit?: NonNullable<RateLimitSnapshot["secondary"]>; remoteQuota?: RemoteQuotaSummary; goal?: ThreadGoal; contextCompactionCount?: number; sessionReferenceCost?: ReferenceCostSummary; taskAggregate?: TurnTaskMetricsSummary; workspaceId?: string; workspaceName?: string; gitBranch?: string | undefined; background?: boolean }
  | { type: "thread.status"; target: ConversationTarget; threadId: string; status: string; background?: boolean }
  | { type: "thread.name"; target: ConversationTarget; threadId: string; name: string | null; background?: boolean }
  | { type: "thread.availability"; target: ConversationTarget; threadId: string; availability: "occupied" | "available"; background?: boolean }
  | { type: "turn.reasoning"; target: ConversationTarget; threadId: string; turnId: string; summary: string; elapsedMs: number; final?: boolean; background?: boolean }
  | { type: "connection.lost"; target: ConversationTarget; threadId: string; message: string; background?: boolean }
  | { type: "connection.restored"; target: ConversationTarget; threadId: string; message: string; background?: boolean }
  | ({ type: "account.updated"; target: ConversationTarget } & AccountStatus)
  | { type: "account.rateLimits.updated"; target: ConversationTarget; rateLimits: RateLimitSnapshot }
  | ({ type: "mcp.status.updated"; target: ConversationTarget } & McpServerStatus)
  | {
      type: "mcp.oauth.completed";
      target: ConversationTarget;
      threadId: string | null;
      name: string;
      success: boolean;
      error: string | null;
    }
  | { type: "warning"; target: ConversationTarget; threadId?: string; message: string; background?: boolean };

export function isCriticalOutputEvent(event: OutputEvent): boolean {
  return event.type !== "text.delta" && event.type !== "turn.started" &&
    event.type !== "plan.updated" &&
    event.type !== "subagent.spawned" &&
    event.type !== "subagent.contacted" &&
    !(event.type === "operation.updated" && event.operation.status === "running");
}

export function usesOpenAiAccount(modelProvider: string | undefined): boolean {
  return (modelProvider ?? "openai") === "openai";
}
