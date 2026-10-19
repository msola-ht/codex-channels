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
  /** Cancels local waiting; never sent as an App Server protocol field. */
  signal?: AbortSignal;
  /** Rechecks local authorization immediately before each RPC attempt. */
  beforeSubmit?: () => void;
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

/**
 * Narrow application boundary for paginated history and destructive revert.
 * Local guards run before each RPC attempt and never become protocol fields;
 * an already-sent revert still settles using its actual response.
 */
export interface ThreadHistoryPort {
  listThreadTurns(
    threadId: string,
    options?: ThreadTurnsListOptions,
  ): Promise<ThreadTurnsPage>;
  revertThread(
    threadId: string,
    beforeTurnId: string,
    beforeSubmit?: () => void,
  ): Promise<ThreadRevertResult>;
}
