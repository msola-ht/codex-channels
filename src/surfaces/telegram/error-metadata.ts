import { GrammyError, HttpError } from "grammy";
import {
  surfaceErrorMetadata,
  type SurfaceErrorMetadata,
} from "../error-metadata.js";

export interface TelegramErrorMetadata extends SurfaceErrorMetadata {
  networkCode?: string;
  networkErrorType?: string;
  telegramErrorKind?: "message_not_modified" | "message_not_found" | "message_not_editable" | "invalid_entities" | "message_too_long" | "bad_request";
}

const networkCodes = new Set([
  "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EPIPE", "ENOTFOUND",
  "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET",
]);
const networkTypes = new Set(["Error", "TypeError", "FetchError", "AbortError", "TimeoutError", "AggregateError"]);

export function telegramErrorMetadata(error: unknown): TelegramErrorMetadata {
  const result: TelegramErrorMetadata = surfaceErrorMetadata(error);
  if (error instanceof GrammyError && error.error_code === 400) {
    const description = error.description.toLowerCase();
    result.telegramErrorKind = description.includes("message is not modified") ? "message_not_modified"
      : description.includes("message to edit not found") ? "message_not_found"
      : description.includes("message can't be edited") ? "message_not_editable"
      : description.includes("can't parse entities") ? "invalid_entities"
      : description.includes("message is too long") ? "message_too_long"
      : "bad_request";
  }
  // grammY wraps fetch failures in HttpError.error. Inspect bounded causes only;
  // never include URLs, descriptions, headers, messages or arbitrary nested fields.
  let cause: unknown = error instanceof HttpError ? error.error : undefined;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 4 && cause && typeof cause === "object" && !visited.has(cause); depth += 1) {
    visited.add(cause);
    const record = cause as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof record.code === "string" && networkCodes.has(record.code)) result.networkCode ??= record.code;
    if (typeof record.name === "string" && networkTypes.has(record.name)) result.networkErrorType ??= record.name;
    cause = record.cause;
  }
  return result;
}
