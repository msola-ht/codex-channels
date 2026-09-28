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

  constructor(code: FeishuMessageErrorCode, message: string) {
    super(message);
    this.name = "FeishuMessageError";
    this.code = code;
  }
}
