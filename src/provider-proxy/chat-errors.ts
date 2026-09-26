/** Cline's documented OpenAI-compatible errors; never expose upstream free text. */
import type { IncomingMessage } from "node:http";

export class ChatUpstreamError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
    this.name = "ChatUpstreamError";
  }
}
const descriptions: Record<string, readonly [string, boolean]> = {
  context_length_exceeded: ["输入超过模型上下文窗口，请缩短输入或压缩上下文。", false],
  content_filter: ["上游内容过滤阻止了本次生成。", false],
  rate_limit: ["上游限流，请稍后重试或降低并发。", true],
  server_error: ["上游服务暂时异常，请稍后重试。", true],
};
const httpErrors: Record<number, readonly [string, string, boolean]> = {
  400: ["invalid_request_error", "上游拒绝请求，请检查模型参数与输入格式。", false],
  401: ["authentication_error", "上游认证失败，请检查 API Key。", false],
  402: ["payment_required", "上游额度不足，请检查账户余额或套餐状态。", false],
  403: ["permission_denied", "API Key 无权访问此资源，请检查权限。", false],
  404: ["not_found", "上游端点或模型不存在，请检查模型 ID 与地址。", false],
  429: ["rate_limit", "上游限流，请稍后重试或降低并发。", true],
  500: ["server_error", "上游服务暂时异常，请稍后重试。", true],
  502: ["server_error", "上游模型提供商异常，请稍后重试。", true],
  503: ["server_error", "上游服务暂不可用，请稍后重试。", true],
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function chatUpstreamError(value: unknown, status?: number): ChatUpstreamError {
  const code = object(value).code;
  if (typeof code === "string" && Object.hasOwn(descriptions, code)) {
    const [message, retryable] = descriptions[code]!;
    return new ChatUpstreamError(code, message, retryable);
  }
  // HTTP status is authoritative; numeric stream codes follow the documented error format.
  const numeric = status ?? (typeof code === "number" ? code : typeof code === "string" && /^\d{3}$/u.test(code) ? Number(code) : undefined);
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
export async function readChatHttpError(incoming: IncomingMessage): Promise<ChatUpstreamError> {
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const value of incoming) {
      const part = Buffer.isBuffer(value) ? value : Buffer.from(value as string);
      size += part.length;
      if (size > 64 * 1024) { incoming.destroy(); break; }
      parts.push(part);
    }
    if (size <= 64 * 1024) return chatUpstreamError(object(JSON.parse(Buffer.concat(parts).toString("utf8"))).error, incoming.statusCode);
  } catch { /* Non-JSON or interrupted bodies retain the HTTP classification. */ }
  return chatUpstreamError(undefined, incoming.statusCode);
}
