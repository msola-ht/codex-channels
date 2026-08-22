import type { ThreadSnapshot } from "../session-routing/index.js";
import type { ThreadQueueInputType } from "./thread-queue-port.js";

export type ThreadHistorySortDirection = "asc" | "desc";

export interface ThreadTurnSummary {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  inputType: ThreadQueueInputType | null;
  textPreview: string | null;
}

export interface ThreadTurnsListOptions {
  cursor?: string | null;
  limit?: number;
  sortDirection?: ThreadHistorySortDirection;
}

export interface ThreadTurnsPage {
  turns: ThreadTurnSummary[];
  nextCursor: string | null;
}

export interface ThreadRevertResult {
  thread: ThreadSnapshot;
}

export interface ThreadRevertListResult {
  threadId: string;
  turns: ThreadTurnSummary[];
  selectors: string[];
  page: number;
  hasNextPage: boolean;
}

export interface ThreadRevertPreview {
  threadId: string;
  beforeTurnId: string;
  turn: ThreadTurnSummary;
  affectedTurnCount: number;
  activeTurnId: string | null;
  queueItemCount: number;
  token: string;
}

/** Narrow application boundary for paginated history and destructive revert. */
export interface ThreadHistoryPort {
  listThreadTurns(
    threadId: string,
    options?: ThreadTurnsListOptions,
  ): Promise<ThreadTurnsPage>;
  revertThread(threadId: string, beforeTurnId: string): Promise<ThreadRevertResult>;
}
