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

// 只放行各 Surface 错误类声明的稳定小写 kebab 错误码；新增错误码时必须同步本白名单，
// 否则该码会被当作不可信字符串从日志元数据中剥离（失败安全）。
const knownLowerKebabErrorCodes = new Set([
  // FeishuMessageErrorCode（client.ts）与 FeishuApplicationSetupErrorCode /
  // FeishuConnectionErrorCode（application-api.ts / event-connection.ts）。
  "card-create-failed",
  "client-create-failed",
  "invalid-credentials",
  "invalid-response",
  "download-failed",
  "download-timeout",
  "read-failed",
  "read-timeout",
  "rate-limited",
  "send-failed",
  "send-timeout",
  "authorization-invalid",
  "configuration-conflict",
  "configuration-failed",
  "inspect-failed",
  "start-failed",
  "start-timeout",
  "stopped",
  "invalid-menu-event",
  "invalid-message-event",
  "invalid-card-action",
  // WeixinOutboxErrorCode / WeixinProtocolErrorCode / WeixinFileInputErrorCode /
  // WeixinInputFatalCode / WeixinRequestAbortReason（outbox.ts / protocol-client.ts /
  // file-input.ts / input-adapter.ts / request-abort.ts）。
  "image-sender-unavailable",
  "missing-reply-context",
  "unauthorized-recipient",
  "aborted",
  "api-error",
  "http-error",
  "invalid-input",
  "network-error",
  "timeout",
  "integrity",
  "message-processing",
  "receiver-failed",
  "network-abort",
  // TelegramTextFileInputErrorCode / TelegramFileLocationError
  // （file-input.ts / file-download.ts）与共享 GeneratedImageErrorCode（generated-image.ts）。
  "too-large",
  "unsupported",
  "lookup-failed",
  "invalid-path",
  "invalid-file",
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
