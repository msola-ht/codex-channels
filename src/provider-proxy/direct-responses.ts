import type { IncomingHttpHeaders } from "node:http";
import { ModelConversionError, type DirectResponsesRequest, type DirectChatUsage } from "../model-api/index.js";
import { parseDirectModelJson, validateDirectModelResponse, withDirectModelResponse, type DirectModelTarget } from "./direct-model-http.js";
import { readChatBody, readModelFrames } from "./chat-io.js";
import { chatUpstreamError } from "./chat-errors.js";
import { createMetricsState, hasResponseOutputContent, observeJsonResponse, observeResponseEvent } from "./response-metrics-observer.js";
import type { DirectChatCapture } from "./relay-traffic-dump.js";

/** Uses the same Responses usage reducer as owned model traffic, without App Server state. */
export class DirectResponsesObserver {
  private readonly metrics = createMetricsState({ threadId: null, turnId: null, operation: "response" }, Date.now(), "http", "response", null, performance.now());
  private jsonContent = false;
  private responseId: string | undefined;
  get status(): "completed" | "failed" | "incomplete" | "unknown" { return this.metrics.status; }
  get responseModel(): string | undefined { return this.metrics.responseModel ?? undefined; }
  get hasContent(): boolean { return this.jsonContent || this.metrics.firstTokenMs !== undefined; }
  get usage(): DirectChatUsage {
    return Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]
      .flatMap(key => { const value = this.metrics[key as keyof typeof this.metrics]; return typeof value === "number" ? [[key, value]] : []; }));
  }
  observe(value: Record<string, unknown>, stream: boolean): boolean {
    const type = value.type;
    if (stream && (typeof type !== "string" || !/^[a-zA-Z0-9_.-]{1,160}$/u.test(type))) throw new ModelConversionError("Invalid Responses event type");
    if (stream && type === "error") throw chatUpstreamError(value.error ?? value);
    const terminal = stream ? ["response.completed", "response.failed", "response.incomplete"].includes(String(type)) : true;
    const response = stream ? value.response : value;
    if (terminal || stream && type === "response.created") {
      if (!record(response) || typeof response.id !== "string" || !response.id.length || response.id.length > 200
        || this.responseId !== undefined && this.responseId !== response.id) throw new ModelConversionError("Invalid Responses response identity");
      this.responseId = response.id;
      if (terminal && (!["completed", "failed", "incomplete"].includes(String(response.status))
        || stream && type !== `response.${String(response.status)}`)) throw new ModelConversionError("Invalid Responses terminal state");
      if (terminal && (response.object !== "response" || !Array.isArray(response.output))) {
        throw new ModelConversionError("Invalid Responses terminal object");
      }
    }
    if (stream) return observeResponseEvent(this.metrics, String(type), value, Date.now(), performance.now());
    const terminalObserved = observeJsonResponse(this.metrics, value, Date.now());
    this.jsonContent = terminalObserved && hasResponseOutputContent(value);
    return terminalObserved;
  }
}

interface DirectResponsesCall {
  request: DirectResponsesRequest;
  target: DirectModelTarget;
  signal: AbortSignal;
  clientHeaders?: IncomingHttpHeaders;
  capture?: DirectChatCapture;
  observer: DirectResponsesObserver;
  recheck(): void;
  submitted(userAgent: string | null): void;
  headers(status: number): void;
  content(): void;
  emit(value: Record<string, unknown>, terminal: boolean, rawFrame?: string): Promise<void>;
}

export async function sendDirectResponses(call: DirectResponsesCall): Promise<void> {
  await withDirectModelResponse({ body: call.request, path: "/responses", target: call.target, signal: call.signal,
    ...(call.clientHeaders ? { clientHeaders: call.clientHeaders } : {}), recheck: () => call.recheck(),
    transformed: operation => call.capture?.transformed?.(operation),
    submitted: (ua, headers, path) => { call.submitted(ua); call.capture?.submitted(call.request, headers, path); },
  }, async incoming => {
    call.headers(incoming.statusCode ?? 502); call.capture?.head(incoming.statusCode ?? 502, incoming.headers);
    await validateDirectModelResponse(incoming, call.request.stream, call.capture);
    if (!call.request.stream) {
      const value = parse(await readChatBody(incoming, call.signal, 8 * 1024 * 1024), call.capture);
      call.capture?.value(value, false);
      if (!call.observer.observe(value, false)) throw new ModelConversionError("Responses JSON has no terminal state");
      if (call.observer.hasContent) call.content();
      call.capture?.done(call.observer.status === "unknown" ? "incomplete" : call.observer.status); await call.emit(deliverable(value, false), true); return;
    }
    for await (const frame of readModelFrames(incoming, call.signal, { frameBytes: 1024 * 1024, bufferBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 })) {
      const value = parse(frame.data, call.capture);
      const event = frame.raw.split(/\r?\n/u).filter(line => line.startsWith("event:")).at(-1)?.slice(6).trim();
      if (event && event !== value.type) throw new ModelConversionError("Responses SSE event does not match its payload");
      call.capture?.value(value, true);
      const terminal = call.observer.observe(value, true);
      if (call.observer.hasContent) call.content();
      if (terminal) call.capture?.done(call.observer.status === "unknown" ? "incomplete" : call.observer.status);
      const output = deliverable(value, true);
      await call.emit(output, terminal, output === value ? frame.raw : undefined);
      if (terminal) return;
    }
    throw new ModelConversionError("Responses stream disconnected before a terminal event");
  });
}

/** Model output is preserved; upstream failure messages remain controlled diagnostics. */
function deliverable(value: Record<string, unknown>, stream: boolean): Record<string, unknown> {
  const response = stream ? value.response : value;
  if (!record(response) || response.error == null) return value;
  const safe = chatUpstreamError(response.error);
  const output = { ...response, error: { code: safe.code, message: safe.message } };
  return stream ? { ...value, response: output } : output;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function parse(text: string, capture?: DirectChatCapture): Record<string, unknown> {
  const value = parseDirectModelJson(text, capture);
  if (!record(value)) throw new ModelConversionError("Invalid Responses object");
  return value;
}
