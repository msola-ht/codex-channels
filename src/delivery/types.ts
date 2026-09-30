export const deliverySchemaVersion = 1;

export interface DeliveryLimits {
  bytes: number;
  records: number;
  accountBytes: number;
  accountRecords: number;
  recordBytes: number;
}

export const defaultDeliveryLimits: Readonly<DeliveryLimits> = {
  bytes: 256 * 1024 * 1024,
  records: 20_000,
  accountBytes: 64 * 1024 * 1024,
  accountRecords: 5_000,
  recordBytes: 4 * 1024 * 1024,
};

export type DeliveryState = "pending" | "sending" | "uncertain" | "blocked";

export interface DeliverySubmission {
  id: string;
  account: string;
  conversation: string;
  /** Versioned, authenticated application payload. Never logged by the journal. */
  payload: string;
}

export interface DeliveryRecord extends DeliverySubmission {
  bytes: number;
  sequence: number;
  state: DeliveryState;
  createdAt: number;
  attempt: number;
  progress: Array<{ operation: string; state: "started" | "confirmed" | "rejected"; messageId?: string }>;
}

export interface DeliverySummary {
  records: number;
  bytes: number;
  pending: number;
  sending: number;
  uncertain: number;
  blocked: number;
}

/** Metadata only; never contains payloads, owners or platform message identifiers. */
export interface DeliveryQueueEntry {
  revision: string;
  id: string;
  sequence: number;
  account: string;
  conversation: string;
  state: DeliveryState;
  createdAt: number;
  attempt: number;
  bytes: number;
  confirmed: number;
  checkpoints: number;
}

export interface DeliveryQueueSnapshot {
  state: "available" | "missing";
  observedAt: number;
  summary: DeliverySummary | null;
  records: DeliveryQueueEntry[];
  nextCursor: number | null;
}

export type DeliveryErrorCode = "capacity" | "account-capacity" | "record-too-large" | "storage" | "closed" | "mailbox-full" | "conflict";

export class DeliveryError extends Error {
  constructor(readonly code: DeliveryErrorCode) {
    super(`可靠投递失败：${code}`);
    this.name = "DeliveryError";
  }
}

export type JournalCommand =
  | { type: "submit"; value: DeliverySubmission }
  | { type: "next"; excluded: string[]; accounts?: string[] }
  | { type: "state"; id: string; from: DeliveryState; to: DeliveryState }
  | { type: "acknowledge"; id: string }
  | { type: "read"; id: string }
  | { type: "queueEntry"; id: string }
  | { type: "queueEntries"; ids: string[] }
  | { type: "releaseBarrier"; id: string }
  | { type: "summary" }
  | { type: "checkpoint"; id: string; value: DeliveryRecord["progress"][number] }
  | { type: "list"; after: number; limit: number }
  | { type: "resolve"; id: string; action: "retry" | "confirm" }
  | { type: "resolveBatch"; entries: Array<{ id: string; revision: string }>; action: "retry" | "confirm" }
  | { type: "close" };

export type JournalResult = number | boolean | DeliveryRecord | DeliveryQueueEntry | Array<DeliveryQueueEntry | null> | DeliverySummary | Array<Omit<DeliveryRecord, "payload">> | null;

export interface WorkerRequest { id: number; command: JournalCommand }
export type WorkerReply =
  | { id: number; ok: true; result: JournalResult }
  | { id: number; ok: false; code: DeliveryErrorCode };
