import type { AutoApprovalReviewDetails } from "../conversation-core/index.js";
import type {
  ItemGuardianApprovalReviewStartedNotification,
  ItemGuardianApprovalReviewCompletedNotification,
} from "../codex-protocol/index.js";
import type { RpcNotification } from "./json-rpc.js";
import {
  redactCommandArguments,
  sanitizeOperationText,
} from "./operation-adapter.js";
import { asRecord, nonEmptyString } from "./notification-parse-helpers.js";

/** Safe status, metrics and completed-detail projection of the controlled, unstable review payload. */
export interface AutoApprovalReviewEvent {
  threadId: string;
  turnId: string;
  reviewId: string;
  phase: "started" | "completed";
  status: "inProgress" | "approved" | "denied" | "timedOut" | "aborted";
  approved: boolean;
  details?: AutoApprovalReviewDetails;
}

export function toAutoApprovalReviewEvent(notification: RpcNotification): AutoApprovalReviewEvent | undefined {
  if (notification.method !== "item/autoApprovalReview/started"
    && notification.method !== "item/autoApprovalReview/completed") return undefined;
  const params = asRecord(notification.params) as Partial<ItemGuardianApprovalReviewStartedNotification
    & ItemGuardianApprovalReviewCompletedNotification> | undefined;
  const threadId = nonEmptyString(params?.threadId);
  const turnId = nonEmptyString(params?.turnId);
  const reviewId = nonEmptyString(params?.reviewId);
  const review = asRecord(params?.review);
  const completed = notification.method === "item/autoApprovalReview/completed";
  const status = review?.status;
  if (status !== "inProgress" && status !== "approved" && status !== "denied"
    && status !== "timedOut" && status !== "aborted") return undefined;
  if (!threadId || !turnId || !reviewId || (!completed && status !== "inProgress")
    || (completed && (params?.decisionSource !== "agent"
      || (status !== "approved" && status !== "denied" && status !== "timedOut" && status !== "aborted")))) return undefined;
  const details = completed ? toAutoApprovalReviewDetails(params?.action, review, params?.startedAtMs, params?.completedAtMs) : undefined;
  return { threadId, turnId, reviewId, phase: completed ? "completed" : "started", status,
    approved: completed && params?.decisionSource === "agent" && status === "approved",
    ...(details ? { details } : {}) };
}

function toAutoApprovalReviewDetails(
  actionValue: unknown,
  review: Record<string, unknown> | undefined,
  startedAtMs: unknown,
  completedAtMs: unknown,
): AutoApprovalReviewDetails | undefined {
  const details: AutoApprovalReviewDetails = {};
  const action = toAutoApprovalReviewAction(actionValue);
  if (action) details.action = action;
  const raw = asRecord(actionValue);
  if (action && raw) {
    let operation: unknown;
    switch (action.kind) {
      case "command": operation = raw.command; break;
      case "execve":
        if (typeof raw.program === "string" && Array.isArray(raw.argv) && raw.argv.length <= 1_024
          && raw.argv.every((arg: unknown) => typeof arg === "string")) {
          operation = redactCommandArguments([raw.program, ...raw.argv])
            .map((arg: string) => /\s|["'\\]/u.test(arg) ? JSON.stringify(arg) : arg).join(" ");
        }
        break;
      case "applyPatch":
        if (action.fileCount !== undefined) operation = (raw.files as string[]).join(" · ");
        break;
      case "networkAccess": operation = raw.host; break;
      case "mcpToolCall":
        if (typeof raw.server === "string" && typeof raw.toolName === "string") {
          operation = `${raw.server} / ${raw.toolName}`;
        }
        break;
      case "requestPermissions": operation = raw.reason; break;
      case "writeStdin": break;
    }
    const summary = reviewText(operation);
    const cwd = reviewText(raw.cwd);
    if (summary) details.operation = summary;
    if (cwd) details.cwd = cwd;
  }
  const rationale = reviewText(review?.rationale);
  if (rationale) details.rationale = rationale;
  if (typeof startedAtMs === "number" && Number.isSafeInteger(startedAtMs) && startedAtMs >= 0
    && typeof completedAtMs === "number" && Number.isSafeInteger(completedAtMs) && completedAtMs >= startedAtMs) {
    details.durationMs = completedAtMs - startedAtMs;
  }
  return Object.keys(details).length ? details : undefined;
}

/** Bound and redact selected text before it enters channel output or durable delivery. */
function reviewText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return sanitizeOperationText(value)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .trim() || undefined;
}

/** Construct only allowlisted action fields. */
function toAutoApprovalReviewAction(value: unknown): AutoApprovalReviewDetails["action"] {
  const action = asRecord(value);
  const kind = action?.type;
  switch (kind) {
    case "command":
    case "execve":
    case "writeStdin":
    case "mcpToolCall":
    case "requestPermissions":
      return { kind: kind satisfies ItemGuardianApprovalReviewCompletedNotification["action"]["type"] };
    case "applyPatch": {
      const files = action?.files;
      // Bound element inspection; oversized or malformed lists retain only the action category.
      const fileCount = Array.isArray(files) && files.length <= 1_024
        && files.every((file: unknown) => typeof file === "string") ? files.length : undefined;
      return { kind, ...(fileCount !== undefined ? { fileCount } : {}) };
    }
    case "networkAccess": {
      const protocol = action?.protocol;
      const port = action?.port;
      return {
        kind,
        ...(protocol === "http" || protocol === "https" || protocol === "socks5Tcp" || protocol === "socks5Udp"
          ? { protocol: protocol satisfies Extract<ItemGuardianApprovalReviewCompletedNotification["action"], { type: "networkAccess" }>["protocol"] } : {}),
        ...(typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65_535 ? { port } : {}),
      };
    }
    default:
      return undefined;
  }
}
