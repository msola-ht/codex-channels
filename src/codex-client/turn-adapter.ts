import type {
  ReviewStartResponse,
  ReviewTarget as ProtocolReviewTarget,
  ThreadGoal as ProtocolThreadGoal,
  TurnStartResponse,
  TurnSteerResponse,
  UserInput,
} from "../codex-protocol/index.js";
import type {
  GoalStatus,
  ReviewStarted,
  ReviewTarget,
  ThreadGoal,
  TurnInput,
  TurnStarted,
} from "../application/index.js";

export function toProtocolTurnInput(input: TurnInput[]): UserInput[] {
  return input.map((item) => {
    switch (item.type) {
      case "text":
        return { type: "text", text: item.text, text_elements: [] };
      case "localImage":
        return { type: "localImage", path: item.path };
      case "localAudio":
        return { type: "localAudio", path: item.path };
    }
  });
}

export function toProtocolReviewTarget(target: ReviewTarget): ProtocolReviewTarget {
  switch (target.type) {
    case "uncommittedChanges":
      return { type: "uncommittedChanges" };
    case "baseBranch":
      return { type: "baseBranch", branch: target.branch };
    case "commit":
      return { type: "commit", sha: target.sha, title: target.title };
    case "custom":
      return { type: "custom", instructions: target.instructions };
  }
}

export function toTurnStarted(response: TurnStartResponse | TurnSteerResponse): TurnStarted {
  const turnId = "turn" in response ? response.turn.id : response.turnId;
  requireString(turnId, "turn id");
  return { turnId };
}

export function toReviewStarted(response: ReviewStartResponse): ReviewStarted {
  requireString(response.reviewThreadId, "review thread id");
  requireString(response.turn.id, "review turn id");
  return {
    threadId: response.reviewThreadId,
    turnId: response.turn.id,
  };
}

export function toThreadGoal(goal: ProtocolThreadGoal): ThreadGoal {
  requireString(goal.threadId, "goal thread id");
  requireString(goal.objective, "goal objective");
  requireNumber(goal.tokensUsed, "goal tokens used");
  requireNumber(goal.timeUsedSeconds, "goal time used");
  requireNumber(goal.createdAt, "goal created at");
  requireNumber(goal.updatedAt, "goal updated at");
  if (goal.tokenBudget !== null) {
    requireNumber(goal.tokenBudget, "goal token budget");
  }
  return {
    threadId: goal.threadId,
    objective: goal.objective,
    status: toGoalStatus(goal.status),
    tokenBudget: goal.tokenBudget,
    tokensUsed: goal.tokensUsed,
    timeUsedSeconds: goal.timeUsedSeconds,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function toGoalStatus(status: ProtocolThreadGoal["status"]): GoalStatus {
  switch (status) {
    case "active":
    case "paused":
    case "blocked":
    case "usageLimited":
    case "budgetLimited":
    case "complete":
      return status;
    default:
      throw new Error("Codex Goal 响应包含未知 status");
  }
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
}

function requireNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
}
