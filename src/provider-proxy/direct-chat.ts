import { ChatDiagnostics, modelRequestDiagnostics, type ModelRequestDiagnostics } from "./chat-diagnostics.js";
import type { IncomingHttpHeaders } from "node:http";
import { DirectChatResponse, ModelConversionError, type DirectChatRequest } from "../model-api/index.js";
import { ChatUpstreamError, chatStreamError, chatUpstreamError } from "./chat-errors.js";
import { readChatBody, readModelFrames } from "./chat-io.js";
import { parseDirectModelJson, validateDirectModelResponse, withDirectModelResponse, type DirectModelTarget } from "./direct-model-http.js";

import type { DirectChatCapture } from "./relay-traffic-dump.js";
import { ChatGenerationTimingObserver } from "./generation-timing.js";
import type { GenerationTiming } from "../../runtime/request-timing.mjs";

export type DirectChatTarget = DirectModelTarget;
export interface DirectChatCall {
  request: DirectChatRequest;
  capture?: DirectChatCapture;
  diagnostics?(summary: ModelRequestDiagnostics): void;
  timing?(value: { responseTimeMs?: number; generationTiming?: GenerationTiming }): void;
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
  const diagnostics = new ChatDiagnostics();
  const generation = new ChatGenerationTimingObserver();
  let submittedAt: number | undefined;
  let responseTimeMs: number | undefined;
  let generationTiming: GenerationTiming | undefined;
  let errorStage: "http" | "stream" = "http";
  let delivering = false;
  const emit: typeof call.emit = async (...args) => {
    delivering = true;
    await call.emit(...args);
    delivering = false;
  };
  try {
    await withDirectModelResponse({
      body: call.request, path: "/chat/completions", target: call.target,
      ...(call.clientHeaders ? { clientHeaders: call.clientHeaders } : {}),
      signal: call.signal, recheck: () => call.recheck(),
      transformed: operation => call.capture?.transformed?.(operation),
      submitted: (userAgent, headers, path) => {
        submittedAt = performance.now();
        call.submitted(userAgent);
        call.capture?.submitted(call.request, headers, path);
      },
    }, async incoming => {
      call.headers(incoming.statusCode ?? 502);
      call.capture?.head(incoming.statusCode ?? 502, incoming.headers);
      await validateDirectModelResponse(incoming, call.request.stream, {
        value: (value, stream) => {
          if (chatStreamError(value)) responseTimeMs ??= performance.now() - submittedAt!;
          diagnostics.push(value); call.capture?.value(value, stream);
        },
        invalid: count => call.capture?.invalid(count),
      });
      if (call.request.stream) errorStage = "stream";
      if (call.request.stream) {
        for await (const { data, receivedAt: at } of readModelFrames(incoming, call.signal, {
          frameBytes: 1024 * 1024, bufferBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024,
        })) {
          if (data === "[DONE]") { call.observer.finish();
            if (call.observer.status === "completed") generationTiming = generation.finish(call.observer.usage.outputTokens, call.observer.usage.reasoningOutputTokens);
            call.capture?.done(call.observer.status === "completed" ? "completed" : "incomplete"); await emit(undefined, true); return; }
          const value: unknown = parseDirectModelJson(data, call.capture);
          diagnostics.push(value);
          call.capture?.value(value, true);
          const error = chatStreamError(value);
          if (error) { responseTimeMs ??= at - submittedAt!; throw error; }
          call.observer.push(value, true);
          responseTimeMs ??= at - submittedAt!;
          generation.push(value, at);
          if (call.observer.hasContent) call.content();
          await emit(value as Record<string, unknown>, false);
        }
        throw new ModelConversionError("Chat stream disconnected before DONE");
      }
      const body = await readChatBody(incoming, call.signal, 8 * 1024 * 1024);
      const parsed: unknown = parseDirectModelJson(body, call.capture);
      const receivedAt = performance.now();
      call.capture?.value(parsed, false);
      const envelopeError = chatStreamError(parsed);
      if (envelopeError) { responseTimeMs ??= receivedAt - submittedAt!; diagnostics.push(parsed); throw envelopeError; }
      const value = call.unwrapClpEnvelope ? directChatJsonPayload(parsed, () => { responseTimeMs ??= receivedAt - submittedAt!; }) : parsed;
      if (value !== parsed) call.capture?.transformed?.("json_unwrapped");
      diagnostics.push(value);
      const error = chatStreamError(value);
      if (error) { responseTimeMs ??= receivedAt - submittedAt!; throw error; }
      call.observer.push(value, false);
      responseTimeMs ??= receivedAt - submittedAt!;
      call.observer.finish();
      if (call.observer.hasContent) call.content();
      call.capture?.done(call.observer.status === "completed" ? "completed" : "incomplete");
      await emit(value as Record<string, unknown>, true);
    });
  } catch (error) {
    if (!delivering && !call.signal.aborted) diagnostics.error("upstream_failure", errorStage, false);
    throw error;
  } finally {
    call.diagnostics?.(modelRequestDiagnostics(diagnostics.snapshot()));
    call.timing?.({ ...(responseTimeMs === undefined ? {} : { responseTimeMs }), ...(generationTiming ? { generationTiming } : {}) });
  }
}

/** CLP's observed non-streaming envelope; unwrap once, never guess arbitrary wrappers. */
function directChatJsonPayload(value: unknown, rejected: () => void): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !Object.hasOwn(value, "success") || !Object.hasOwn(value, "data")) return value;
  const envelope = value as Record<string, unknown>;
  if (envelope.success !== true) {
    if (envelope.success === false) rejected();
    throw chatUpstreamError(undefined);
  }
  if (Object.hasOwn(envelope, "choices")) {
    throw new ChatUpstreamError("invalid_upstream_envelope", "Upstream response contains both a Chat object and a wrapped Chat object.", false);
  }
  return envelope.data;
}
