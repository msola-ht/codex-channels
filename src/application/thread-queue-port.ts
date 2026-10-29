/** Read-only App Server queue state used for binding and Revert safety. */

export type ThreadQueueFailure = "unavailable";

/** A known rejection from the Queue authority, never a transport failure. */
export class ThreadQueueError extends Error {
  constructor(readonly failure: ThreadQueueFailure) {
    super(`Thread Queue: ${failure}`);
    this.name = "ThreadQueueError";
  }
}

export interface ThreadQueuePage {
  itemCount: number;
  nextCursor: string | null;
  /** Opaque digest of the complete ordered page returned by App Server. */
  fingerprint?: string;
}

export interface ThreadQueueListOptions {
  cursor?: string | null;
  limit?: number;
  beforeSubmit?: () => void;
}

/**
 * Read-only native Queue contract for binding safety and Revert concurrency.
 * Local beforeSubmit guards run after asynchronous preparation and before
 * each RPC attempt; they never become protocol fields or cancel sent writes.
 */
export interface ThreadQueuePort {
  listQueue(
    threadId: string,
    options?: ThreadQueueListOptions,
  ): Promise<ThreadQueuePage>;
}
