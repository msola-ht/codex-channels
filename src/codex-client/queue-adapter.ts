import { createHash } from "node:crypto";
import { ThreadQueueError } from "../application/index.js";
import { JsonRpcError } from "./json-rpc.js";

import type {
  QueuedSubmission,
  ThreadQueueListResponse,
} from "../codex-protocol/index.js";
import type {
  ThreadQueuePage,
} from "../application/index.js";

/** Only attach to the read-only Queue RPC rejection, before response conversion. */
export function rethrowThreadQueueError(error: unknown): never {
  if (error instanceof JsonRpcError && error.code === -32600
    && error.message === "user message queue is unavailable") {
    throw new ThreadQueueError("unavailable");
  }
  throw error;
}

export function toThreadQueuePage(value: ThreadQueueListResponse): ThreadQueuePage {
  if (!Array.isArray(value.data)) {
    throw new Error("Codex Queue 列表响应缺少 data");
  }
  if (value.nextCursor !== null && !nonEmptyString(value.nextCursor)) {
    throw new Error("Codex Queue 列表响应包含无效分页游标");
  }
  for (const submission of value.data) {
    if (!submission || !nonEmptyString(submission.id)
      || typeof submission.clientUserMessageId !== "string"
      || !Array.isArray(submission.input) || submission.input.length === 0) {
      throw new Error("Codex Queue 响应缺少有效条目");
    }
  }
  return {
    itemCount: value.data.length,
    nextCursor: value.nextCursor,
    fingerprint: fingerprintQueueSubmissions(value.data),
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Hash the complete ordered protocol input before it crosses the Client
 * boundary. Application only receives the digest and entry count.
 */
function fingerprintQueueSubmissions(value: readonly QueuedSubmission[]): string {
  return createHash("sha256")
    .update(JSON.stringify(value.map((submission) => ({
      id: submission.id,
      clientUserMessageId: submission.clientUserMessageId,
      input: submission.input,
    }))))
    .digest("hex");
}
