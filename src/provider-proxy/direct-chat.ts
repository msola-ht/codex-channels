import type { IncomingHttpHeaders } from "node:http";
import { DirectChatResponse, ModelConversionError, type DirectChatRequest } from "../model-api/index.js";
import { ChatUpstreamError, chatStreamError, chatUpstreamError, readChatHttpError } from "./chat-errors.js";
import { readChatBody, readChatFrames } from "./chat-io.js";
import { withDirectModelResponse, type DirectModelTarget } from "./direct-model-http.js";

import type { DirectChatCapture } from "./relay-traffic-dump.js";

export type DirectChatTarget = DirectModelTarget;
export interface DirectChatCall {
  request: DirectChatRequest;
  capture?: DirectChatCapture;
  clientHeaders?: IncomingHttpHeaders;
  target: DirectChatTarget;
  signal: AbortSignal;
  observer: DirectChatResponse;
  unwrapClpEnvelope: boolean;
  recheck(): void;
  submitted(userAgent: string | null): void;
  headers(status: number): void;
  content(): void;
  emit(value: Record<string, unknown> | undefined, terminal: boolean): Promise<void>;
}

/** One direct Chat exchange. No retries, redirects, caller identity or metric submission. */
export async function sendDirectChat(call: DirectChatCall): Promise<void> {
  await withDirectModelResponse({
    body: call.request, path: "/chat/completions", target: call.target,
    ...(call.clientHeaders ? { clientHeaders: call.clientHeaders } : {}),
    signal: call.signal, recheck: () => call.recheck(),
    transformed: operation => call.capture?.transformed?.(operation),
    submitted: (userAgent, headers, path) => {
      call.submitted(userAgent);
      call.capture?.submitted(call.request, headers, path);
    },
  }, async incoming => {
    call.headers(incoming.statusCode ?? 502);
    call.capture?.head(incoming.statusCode ?? 502, incoming.headers);
    if (incoming.statusCode !== 200) throw await readChatHttpError(incoming, call.capture);
    const contentType = incoming.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (call.request.stream) {
      if (contentType !== "text/event-stream") throw new ChatUpstreamError("invalid_upstream_content_type", "Upstream response Content-Type does not match the requested JSON/SSE format.", false);
      for await (const data of readChatFrames(incoming, call.signal, {
        frameBytes: 1024 * 1024, bufferBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024,
      })) {
        if (data === "[DONE]") { call.observer.finish(); call.capture?.done(call.observer.status === "completed" ? "completed" : "incomplete"); await call.emit(undefined, true); return; }
        const value: unknown = parseChatJson(data, call.capture);
        call.capture?.value(value, true);
        const error = chatStreamError(value);
        if (error) throw error;
        call.observer.push(value, true);
        if (call.observer.hasContent) call.content();
        await call.emit(value as Record<string, unknown>, false);
      }
      throw new ModelConversionError("Chat stream disconnected before DONE");
    }
    if (contentType !== "application/json") throw new ChatUpstreamError("invalid_upstream_content_type", "Upstream response Content-Type does not match the requested JSON/SSE format.", false);
    const body = await readChatBody(incoming, call.signal, 8 * 1024 * 1024);
    const parsed: unknown = parseChatJson(body, call.capture);
    call.capture?.value(parsed, false);
    const envelopeError = chatStreamError(parsed);
    if (envelopeError) throw envelopeError;
    const value = call.unwrapClpEnvelope ? directChatJsonPayload(parsed) : parsed;
    if (value !== parsed) call.capture?.transformed?.("json_unwrapped");
    const error = chatStreamError(value);
    if (error) throw error;
    call.observer.push(value, false);
    call.observer.finish();
    if (call.observer.hasContent) call.content();
    call.capture?.done(call.observer.status === "completed" ? "completed" : "incomplete");
    await call.emit(value as Record<string, unknown>, true);
  });
}

function parseChatJson(text: string, capture?: DirectChatCapture): unknown {
  try { return JSON.parse(text) as unknown; }
  catch { capture?.invalid(Buffer.byteLength(text)); throw new ChatUpstreamError("invalid_upstream_json", "Upstream response contains invalid JSON.", false); }
}

/** CLP's observed non-streaming envelope; unwrap once, never guess arbitrary wrappers. */
function directChatJsonPayload(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !Object.hasOwn(value, "success") || !Object.hasOwn(value, "data")) return value;
  const envelope = value as Record<string, unknown>;
  if (envelope.success !== true) throw chatUpstreamError(undefined);
  if (Object.hasOwn(envelope, "choices")) {
    throw new ChatUpstreamError("invalid_upstream_envelope", "Upstream response contains both a Chat object and a wrapped Chat object.", false);
  }
  return envelope.data;
}
