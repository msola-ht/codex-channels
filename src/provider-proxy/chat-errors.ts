/** Cline's documented OpenAI-compatible errors; never expose upstream free text. */
import type { IncomingMessage } from "node:http";
import { modelRequestPolicy } from "../../runtime/model-request-policy.mjs";

export class ChatUpstreamError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean, readonly retryAfter?: string, readonly upstreamStatus?: number) {
    super(message);
    this.name = "ChatUpstreamError";
  }
}

export type ModelRequestStage = "upload" | "prepare" | "headers" | "body" | "stream" | "delivery" | "terminal";
const timeoutMessages: Record<ModelRequestStage, string> = {
  upload: "模型请求正文上传超时。",
  prepare: "模型请求准备超时。",
  headers: "模型上游首响应头等待超时。",
  body: "模型上游正文读取超时。",
  stream: "模型上游完整事件等待超时。",
  delivery: "模型响应下游交付超时。",
  terminal: "模型响应终态收尾超时。",
};

/** Local deadlines only; a received upstream HTTP error keeps its own classification. */
export class ModelRequestTimeoutError extends ChatUpstreamError {
  readonly status: number;
  constructor(readonly stage: ModelRequestStage) {
    super(stage === "upload" ? "upload_timeout" : stage === "prepare" ? "preparation_timeout"
      : stage === "delivery" || stage === "terminal" ? "delivery_timeout" : "upstream_timeout",
    timeoutMessages[stage], stage !== "delivery" && stage !== "terminal");
    this.name = "ModelRequestTimeoutError";
    this.status = stage === "upload" ? 408 : 504;
  }
}
const descriptions: Record<string, readonly [string, boolean]> = {
  context_length_exceeded: ["输入超过模型上下文窗口，请缩短输入或压缩上下文。", false],
  content_filter: ["上游内容过滤阻止了本次生成。", false],
  rate_limit: ["上游限流，请稍后重试或降低并发。", true],
  server_error: ["上游服务暂时异常，请稍后重试。", true],
  upstream_timeout: ["上游响应超时，请稍后重试。", true],
};
const httpErrors: Record<number, readonly [string, string, boolean]> = {
  400: ["invalid_request_error", "上游拒绝请求，请检查模型参数与输入格式。", false],
  401: ["authentication_error", "上游认证失败，请检查 API Key。", false],
  402: ["payment_required", "上游额度不足，请检查账户余额或套餐状态。", false],
  403: ["permission_denied", "API Key 无权访问此资源，请检查权限。", false],
  404: ["not_found", "上游端点或模型不存在，请检查模型 ID 与地址。", false],
  408: ["upstream_timeout", "上游接收请求超时，请稍后重试。", true],
  429: ["rate_limit", "上游限流，请稍后重试或降低并发。", true],
  500: ["server_error", "上游服务暂时异常，请稍后重试。", true],
  502: ["server_error", "上游模型提供商异常，请稍后重试。", true],
  503: ["server_error", "上游服务暂不可用，请稍后重试。", true],
  504: ["upstream_timeout", "上游响应超时，请稍后重试。", true],
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function chatUpstreamError(value: unknown, status?: number): ChatUpstreamError {
  const code = object(value).code;
  if (status !== undefined) {
    // HTTP determines authentication, availability and retryability. Only refine
    // 400 with compatible, non-retryable input errors from the bounded body.
    if (status === 400 && (code === "context_length_exceeded" || code === "content_filter")) {
      const [message, retryable] = descriptions[code]!;
      return new ChatUpstreamError(code, message, retryable, undefined, status);
    }
    const info = httpErrors[status];
    return info ? new ChatUpstreamError(...info, undefined, status)
      : new ChatUpstreamError("chat_upstream_error", "模型上游请求失败。", false, undefined, status);
  }
  if (typeof code === "string" && Object.hasOwn(descriptions, code)) {
    const [message, retryable] = descriptions[code]!;
    return new ChatUpstreamError(code, message, retryable);
  }
  // HTTP status is authoritative; numeric stream codes follow the documented error format.
  const numeric = typeof code === "number" ? code : typeof code === "string" && /^\d{3}$/u.test(code) ? Number(code) : undefined;
  const info = numeric === undefined ? undefined : httpErrors[numeric];
  return info ? new ChatUpstreamError(...info) : new ChatUpstreamError("chat_upstream_error", "Chat 上游请求失败。", false);
}
export function chatStreamError(value: unknown): ChatUpstreamError | undefined {
  const chunk = object(value);
  if (chunk.error != null) return chatUpstreamError(chunk.error);
  for (const entry of Array.isArray(chunk.choices) ? chunk.choices : []) {
    const choice = object(entry);
    if (choice.error != null || choice.finish_reason === "error") return chatUpstreamError(choice.error);
  }
  return undefined;
}
export async function readChatHttpError(incoming: IncomingMessage, capture?: { value(value: unknown, stream: boolean): void; invalid(bytes: number): void }, signal?: AbortSignal): Promise<ChatUpstreamError> {
  const retryAfter = incoming.statusCode === 429 || incoming.statusCode === 503 ? safeRetryAfter(incoming.headers["retry-after"]) : undefined;
  const classify = (value: unknown): ChatUpstreamError => {
    const error = chatUpstreamError(value, incoming.statusCode);
    return new ChatUpstreamError(error.code, error.message, error.retryable, retryAfter, error.upstreamStatus);
  };
  signal?.throwIfAborted();
  const encoding = incoming.headers["content-encoding"];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") {
    incoming.destroy();
    capture?.invalid(0);
    return classify(undefined);
  }
  const parts: Buffer[] = [];
  let size = 0;
  let timedOut = false;
  const abort = (): void => { incoming.destroy(); };
  signal?.throwIfAborted();
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; incoming.destroy(); }, modelRequestPolicy.errorBodyTimeoutMs);
  try {
    for await (const value of incoming) {
      const part = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
      size += part.length;
      if (size > 64 * 1024) { incoming.destroy(); break; }
      parts.push(part);
    }
    signal?.throwIfAborted();
    if (timedOut) { capture?.invalid(size); return classify(undefined); }
    if (size <= 64 * 1024) {
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts)));
      capture?.value(value, false);
      return classify(object(value).error);
    }
  } catch {
    if (signal?.aborted) throw signal.reason;
    // The HTTP error is already authoritative. A stalled diagnostic body must
    // not replace 401/429/503 with 504 or discard a validated Retry-After.
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  capture?.invalid(size);
  return classify(undefined);
}

/** Only standard delay-seconds or canonical HTTP-date; never forward arbitrary header text. */
function safeRetryAfter(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  if (/^\d+$/u.test(value) && Number.isSafeInteger(Number(value))) return value;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toUTCString() === value ? value : undefined;
}
