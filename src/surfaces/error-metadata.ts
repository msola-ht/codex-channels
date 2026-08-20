import { UserFacingError } from "../conversation-core/index.js";

export interface SurfaceErrorMetadata extends Record<string, unknown> {
  errorType: string;
  errorCode?: string | number;
  errorReason?: SurfaceErrorReason;
  errorMessage?: string;
}

export type SurfaceErrorReason =
  | "no-active-turn"
  | "expected-turn-mismatch"
  | "non-steerable-review"
  | "non-steerable-compact"
  | "empty-input";

const knownLowerKebabErrorCodes = new Set([
  "aborted",
  "api-error",
  "authorization-invalid",
  "card-create-failed",
  "client-create-failed",
  "configuration-conflict",
  "configuration-failed",
  "download-failed",
  "download-timeout",
  "http-error",
  "image-sender-unavailable",
  "inspect-failed",
  "integrity",
  "invalid-card-action",
  "invalid-credentials",
  "invalid-file",
  "invalid-input",
  "invalid-menu-event",
  "invalid-path",
  "invalid-response",
  "lookup-failed",
  "message-processing",
  "missing-reply-context",
  "network-abort",
  "network-error",
  "rate-limited",
  "read-failed",
  "read-timeout",
  "receiver-failed",
  "send-failed",
  "send-timeout",
  "start-failed",
  "start-timeout",
  "stopped",
  "timeout",
  "too-large",
  "unauthorized-recipient",
  "unsupported",
  "unsupported-image",
]);

export function surfaceErrorMetadata(error: unknown): SurfaceErrorMetadata {
  if (error instanceof UserFacingError) {
    return {
      errorType: "UserFacingError",
      errorCode: error.code,
      errorMessage: error.message,
    };
  }
  const constructorName = error instanceof Error
    ? error.constructor.name
    : undefined;
  const errorType = typeof constructorName === "string"
    && /^[A-Za-z][A-Za-z0-9]{0,40}$/u.test(constructorName)
    ? constructorName
    : error instanceof Error
      ? "Error"
      : error === null
        ? "null"
        : typeof error;
  if (typeof error !== "object" || error === null) {
    return { errorType };
  }
  const record = error as Record<string, unknown>;
  if (
    typeof record.error_code === "number"
    && Number.isSafeInteger(record.error_code)
  ) {
    return { errorType, errorCode: record.error_code };
  }
  if (
    typeof record.code === "number"
    && Number.isSafeInteger(record.code)
  ) {
    return {
      errorType,
      errorCode: record.code,
      ...rpcErrorReason(errorType, record.message),
    };
  }
  if (
    typeof record.code === "string"
    && (
      /^[A-Z][A-Z0-9_]{1,40}$/u.test(record.code)
      || knownLowerKebabErrorCodes.has(record.code)
    )
  ) {
    return { errorType, errorCode: record.code };
  }
  return { errorType };
}

function rpcErrorReason(
  errorType: string,
  message: unknown,
): Pick<SurfaceErrorMetadata, "errorReason"> {
  if (errorType !== "JsonRpcError" || typeof message !== "string") {
    return {};
  }
  if (message === "no active turn to steer") {
    return { errorReason: "no-active-turn" };
  }
  if (/^expected active turn id `?[^`]+`? but found `?[^`]+`?$/u.test(message)) {
    return { errorReason: "expected-turn-mismatch" };
  }
  if (message === "cannot steer a review turn") {
    return { errorReason: "non-steerable-review" };
  }
  if (message === "cannot steer a compact turn") {
    return { errorReason: "non-steerable-compact" };
  }
  if (message === "input must not be empty") {
    return { errorReason: "empty-input" };
  }
  return {};
}
