import type { DeliveryQueueEntry, DeliveryQueueSnapshot, DeliveryState } from "./types.js";

export type DeliveryReadCommand =
  | { type: "queue"; options: { before?: number; state?: DeliveryState; id?: string } }
  | { type: "entries"; ids: string[] }
  | { type: "payload"; ids: string[] }
  | { type: "payloads"; ids: string[] };

export interface DeliveryReadFailure {
  phase: "startup" | "request" | "worker" | "shutdown";
  reason: "timeout" | "acl" | "sqlite" | "storage" | "worker-error" | "worker-exit" | "message" | "aborted" | "overload" | "closed";
  operation: DeliveryReadCommand["type"] | "close";
}

export type DeliveryReadItem = { row: DeliveryQueueEntry; payload: string } | null;
export type DeliveryReadResult = DeliveryQueueSnapshot | Array<DeliveryQueueEntry | null> | null;
export type DeliveryReadReply =
  | { type: "ready" }
  | { type: "item"; index: number; value: DeliveryReadItem }
  | { type: "result"; value: DeliveryReadResult }
  | { type: "failure"; failure: DeliveryReadFailure };
export type DeliveryReadControl = { type: "start" } | { type: "ack"; index: number } | { type: "close" };
