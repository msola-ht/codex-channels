import { createHash } from "node:crypto";

import type {
  QueuedSubmission,
  ThreadQueueAddResponse,
  ThreadQueueDeleteResponse,
  ThreadQueueListResponse,
  ThreadQueueStartResponse,
  ThreadQueueUpdateResponse,
  UserInput,
} from "../codex-protocol/index.js";
import type {
  ThreadQueueItem,
  ThreadQueuePage,
} from "../application/index.js";
import { toTurnStarted } from "./turn-adapter.js";
import { summarizeUserInput } from "./user-input-summary.js";

/** Convert the official Queue response to the safe Application summary. */
export function toThreadQueueItem(value: QueuedSubmission): ThreadQueueItem {
  if (!nonEmptyString(value.id) || typeof value.clientUserMessageId !== "string") {
    throw new Error("Codex Queue 响应缺少有效条目标识");
  }
  if (!Array.isArray(value.input) || value.input.length === 0) {
    throw new Error("Codex Queue 响应缺少输入条目");
  }
  const summary = summarizeUserInput(value.input);
  return {
    id: value.id,
    clientUserMessageId: value.clientUserMessageId,
    inputType: summary.inputType,
    textPreview: summary.textPreview,
    editable: summary.editable,
  };
}

export function toThreadQueuePage(value: ThreadQueueListResponse): ThreadQueuePage {
  if (!Array.isArray(value.data)) {
    throw new Error("Codex Queue 列表响应缺少 data");
  }
  if (value.nextCursor !== null && !nonEmptyString(value.nextCursor)) {
    throw new Error("Codex Queue 列表响应包含无效分页游标");
  }
  return {
    items: value.data.map(toThreadQueueItem),
    nextCursor: value.nextCursor,
    fingerprint: fingerprintQueueSubmissions(value.data),
  };
}

export function toThreadQueueAddResult(value: ThreadQueueAddResponse): ThreadQueueItem {
  return toThreadQueueItem(value.queuedSubmission);
}

export function toThreadQueueUpdateResult(value: ThreadQueueUpdateResponse): ThreadQueueItem {
  return toThreadQueueItem(value.queuedSubmission);
}

export function toThreadQueueDeleteResult(
  value: ThreadQueueDeleteResponse,
): { deleted: boolean } {
  if (typeof value.deleted !== "boolean") {
    throw new Error("Codex Queue 删除响应缺少 deleted");
  }
  return { deleted: value.deleted };
}

export function toThreadQueueStartResult(
  value: ThreadQueueStartResponse,
): { turnId: string } {
  return toTurnStarted(value);
}

export function toProtocolQueueText(text: string): UserInput[] {
  return [{ type: "text", text, text_elements: [] }];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Hash the complete ordered protocol input before it crosses the Client
 * boundary. Application only receives the digest and safe item summaries.
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
