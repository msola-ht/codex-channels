export type FeishuMessageErrorCode =
  | "card-create-failed"
  | "client-create-failed"
  | "invalid-credentials"
  | "invalid-response"
  | "download-failed"
  | "download-timeout"
  | "read-failed"
  | "read-timeout"
  | "rate-limited"
  | "send-failed"
  | "send-timeout";

export class FeishuMessageError extends Error {
  readonly code: FeishuMessageErrorCode;

  readonly diagnostics: FeishuApiDiagnostics;

  constructor(code: FeishuMessageErrorCode, message: string, diagnostics: FeishuApiDiagnostics = {}) {
    super(message);
    this.name = "FeishuMessageError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export interface FeishuApiDiagnostics {
  httpStatus?: number;
  platformCode?: number;
  platformRequestId?: string;
}

/** Only machine-readable diagnostics: never retain the SDK error, request, body or headers. */
export function feishuApiDiagnostics(error: unknown): FeishuApiDiagnostics {
  if (error instanceof FeishuMessageError) return error.diagnostics;
  const object = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const root = object(error);
  const response = object(root.response);
  const body = object(response.data);
  const httpStatus = response.status;
  const platformCode = body.code;
  const requestId = object(body.error).log_id ?? object(response.headers)["x-tt-logid"];
  return {
    ...(typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(typeof platformCode === "number" && Number.isSafeInteger(platformCode) && platformCode > 0 ? { platformCode } : {}),
    ...(typeof requestId === "string" && /^[a-fA-F0-9]{16,64}$/u.test(requestId) ? { platformRequestId: requestId } : {}),
  };
}
