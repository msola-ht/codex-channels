/**
 * A bounded, platform-independent view of an App Server Thread Queue item.
 *
 * Queue inputs are deliberately summarized at the Client boundary.  In
 * particular, this type never carries an App Server `UserInput`, local media
 * path, skill path, or mention path across the module boundary.
 */
export type ThreadQueueInputType =
  | "text"
  | "image"
  | "audio"
  | "skill"
  | "mention"
  | "other";

export interface ThreadQueueItem {
  id: string;
  clientUserMessageId: string;
  inputType: ThreadQueueInputType;
  textPreview: string | null;
  editable: boolean;
}

export interface ThreadQueuePage {
  items: ThreadQueueItem[];
  nextCursor: string | null;
  /** Opaque digest of the complete ordered page returned by App Server. */
  fingerprint?: string;
}

export interface ThreadQueueListOptions {
  cursor?: string | null;
  limit?: number;
}

/**
 * Narrow Application-owned Queue contract.  Writes are intentionally
 * expressed as text-only operations; other clients' non-text entries remain
 * manageable through their safe summaries, but cannot be edited here.
 */
export interface ThreadQueuePort {
  addQueueItem(
    threadId: string,
    text: string,
    clientUserMessageId: string,
  ): Promise<ThreadQueueItem>;
  listQueue(
    threadId: string,
    options?: ThreadQueueListOptions,
  ): Promise<ThreadQueuePage>;
  updateQueueItem(
    threadId: string,
    queuedSubmissionId: string,
    text: string,
  ): Promise<ThreadQueueItem>;
  deleteQueueItem(threadId: string, queuedSubmissionId: string): Promise<{ deleted: boolean }>;
  reorderQueue(threadId: string, queuedSubmissionIds: string[]): Promise<void>;
  startQueueItem(threadId: string, queuedSubmissionId?: string): Promise<{ turnId: string }>;
}
