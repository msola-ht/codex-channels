import type {
  ReviewStartResponse,
  ReviewTarget as ProtocolReviewTarget,
  TurnStartResponse,
  TurnSteerResponse,
  UserInput,
} from "../codex-protocol/index.js";
import type {
  ReviewStarted,
  ReviewTarget,
  TurnInput,
  TurnStarted,
} from "../application/index.js";

export function toProtocolTurnInput(input: TurnInput[]): UserInput[] {
  return input.map((item) => {
    switch (item.type) {
      case "text":
        return { type: "text", text: item.text, text_elements: [] };
      case "image":
        return { type: "image", url: item.url };
      case "localAudio":
        return { type: "localAudio", path: item.path };
      case "skill":
        return { type: "skill", name: item.name, path: item.path };
      case "plugin":
        return { type: "mention", name: item.name, path: item.path };
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
  if (!turnId.trim()) throw new Error("Codex 响应缺少有效 turn id");
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

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`Codex 响应缺少有效 ${field}`);
  }
}
