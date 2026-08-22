import type {
  ThreadRevertResponse,
  ThreadTurnsListResponse,
  Turn,
} from "../codex-protocol/index.js";
import type {
  ThreadRevertResult,
  ThreadTurnSummary,
  ThreadTurnsPage,
} from "../application/index.js";
import { toThreadSnapshot } from "./thread-adapter.js";
import { summarizeUserInput } from "./user-input-summary.js";

export function toThreadTurnSummary(turn: Turn): ThreadTurnSummary {
  requireString(turn.id, "turn id");
  if (!isTurnStatus(turn.status)) throw new Error("Codex Turn 响应包含未知 status");
  requireNullableNumber(turn.startedAt, "turn startedAt");
  requireNullableNumber(turn.completedAt, "turn completedAt");
  requireNullableNumber(turn.durationMs, "turn durationMs");
  if (!Array.isArray(turn.items)) throw new Error("Codex Turn 响应缺少 items");
  if (turn.itemsView !== "summary") {
    throw new Error("Codex Turn 列表响应未使用 summary 视图");
  }
  const userMessage = turn.items.find((item) => item.type === "userMessage");
  if (!userMessage || userMessage.type !== "userMessage") {
    return {
      id: turn.id,
      status: turn.status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      durationMs: turn.durationMs,
      inputType: null,
      textPreview: null,
    };
  }
  if (!Array.isArray(userMessage.content) || userMessage.content.length === 0) {
    throw new Error("Codex Turn userMessage 缺少 content");
  }
  requireNullableString(userMessage.clientId, "userMessage clientId");
  const summary = summarizeUserInput(userMessage.content);
  return {
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    inputType: summary.inputType,
    textPreview: summary.textPreview,
  };
}

export function toThreadTurnsPage(response: ThreadTurnsListResponse): ThreadTurnsPage {
  if (!Array.isArray(response.data)) throw new Error("Codex Turn 列表响应缺少 data");
  requireNullableString(response.nextCursor, "nextCursor");
  requireNullableString(response.backwardsCursor, "backwardsCursor");
  const turns = response.data.map(toThreadTurnSummary);
  if (new Set(turns.map((turn) => turn.id)).size !== turns.length) {
    throw new Error("Codex Turn 列表响应包含重复 Turn ID");
  }
  if (turns.length === 0 && response.nextCursor !== null) {
    throw new Error("Codex Turn 空页面不应携带下一页游标");
  }
  return {
    turns,
    nextCursor: response.nextCursor,
  };
}

export function toThreadRevertResult(response: ThreadRevertResponse): ThreadRevertResult {
  if (!response.thread || !Array.isArray(response.thread.turns)) {
    throw new Error("Codex Revert 响应缺少有效 Thread");
  }
  if (response.thread.turns.length !== 0) {
    throw new Error("Codex Revert 响应不应携带 turns");
  }
  requireNullableString(response.turnsBackwardsCursor, "turnsBackwardsCursor");
  requireNullableString(response.itemsBackwardsCursor, "itemsBackwardsCursor");
  return {
    thread: toThreadSnapshot(response.thread),
  };
}

function isTurnStatus(value: unknown): value is ThreadTurnSummary["status"] {
  return value === "completed"
    || value === "interrupted"
    || value === "failed"
    || value === "inProgress";
}

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Codex Turn 响应缺少有效 ${field}`);
  }
}

function requireNullableString(value: unknown, field: string): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || value.trim() === "")) {
    throw new Error(`Codex 响应包含无效 ${field}`);
  }
}

function requireNullableNumber(value: unknown, field: string): asserts value is number | null {
  if (
    value !== null
    && (!Number.isSafeInteger(value) || (value as number) < 0)
  ) {
    throw new Error(`Codex Turn 响应包含无效 ${field}`);
  }
}
