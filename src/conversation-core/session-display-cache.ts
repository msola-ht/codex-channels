export type SessionDisplayStatusType =
  | "notLoaded"
  | "idle"
  | "systemError"
  | "active";

export interface SessionDisplayCacheEntry {
  threadId: string;
  workspaceId: string;
  archived: boolean;
  preview: string;
  name: string | null;
  modelProvider: string;
  status: { type: SessionDisplayStatusType };
  activeTurnId: string | null;
  isPinned: boolean;
  turnCount: number | null;
  measuredAt: number | null;
}

/** Persistent derived data used to render and filter session lists quickly. */
export interface SessionDisplayCachePort {
  get(threadId: string): SessionDisplayCacheEntry | undefined;
  put(entry: SessionDisplayCacheEntry): void;
  invalidateTurnCount(threadId: string): void;
  remove(threadId: string): void;
  close?(): void;
}
