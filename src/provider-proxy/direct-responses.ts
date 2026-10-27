import { ChatDiagnostics, modelRequestDiagnostics, type ModelRequestDiagnostics } from "./chat-diagnostics.js";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { ModelConversionError, prepareOllamaFreeform, type OllamaFreeformResponse, type DirectResponsesRequest, type DirectChatUsage } from "../model-api/index.js";
import { parseDirectModelJson, readDirectModelBody, validateDirectModelResponse, withDirectModelResponse, type DirectModelTarget } from "./direct-model-http.js";
import { readModelFrames } from "./chat-io.js";
import { ChatUpstreamError, chatStreamError, chatUpstreamError } from "./chat-errors.js";
import { createMetricsState, hasResponseOutputContent, invalidateGenerationTiming, observeJsonResponse, observeResponseEvent, observeRequestSubmitted, observeResponseReceived } from "./response-metrics-observer.js";
import type { GenerationTiming } from "../../runtime/request-timing.mjs";
import type { DirectChatCapture } from "./relay-traffic-dump.js";

/** Uses the same Responses usage reducer as owned model traffic, without App Server state. */
export class DirectResponsesObserver {
  private readonly metrics = createMetricsState({ threadId: null, turnId: null, operation: "response" }, Date.now(), "http", "response", null);
  submitted(at: number): void { observeRequestSubmitted(this.metrics, at); }
  receivedError(at: number): void { observeResponseReceived(this.metrics, at); }
  get firstTokenMs(): number | undefined { return this.metrics.firstTokenMs; }
  /** Internal rounds contribute receipt/content timing, never an external terminal. */
  progress(value: Record<string, unknown>, stream: boolean, at: number): void {
    invalidateGenerationTiming(this.metrics);
    if (stream) {
      if (!["response.completed", "response.failed", "response.incomplete", "error"].includes(String(value.type))) observeResponseEvent(this.metrics, String(value.type), value, Date.now(), at);
    } else {
      observeResponseReceived(this.metrics, at);
      if (hasResponseOutputContent(value)) observeResponseEvent(this.metrics, "response.output_text.delta", { type: "response.output_text.delta", delta: "content" }, Date.now(), at);
    }
  }
  aggregateUsage(value: Record<string, unknown>): void {
    const input = record(value.input_tokens_details) ? value.input_tokens_details : {};
    const output = record(value.output_tokens_details) ? value.output_tokens_details : {};
    for (const [key, count] of Object.entries({ inputTokens: value.input_tokens, outputTokens: value.output_tokens, totalTokens: value.total_tokens,
      cachedInputTokens: input.cached_tokens, reasoningOutputTokens: output.reasoning_tokens })) {
      (this.metrics as unknown as Record<string, unknown>)[key] = typeof count === "number" ? count : null;
    }
  }
  get timing(): { responseTimeMs?: number; generationTiming?: GenerationTiming } {
    return { ...(this.metrics.responseTimeMs === undefined ? {} : { responseTimeMs: this.metrics.responseTimeMs }),
      ...(this.metrics.generationTiming === undefined ? {} : { generationTiming: this.metrics.generationTiming }) };
  }
  private jsonContent = false;
  private responseId: string | undefined;
  get status(): "completed" | "failed" | "incomplete" | "unknown" { return this.metrics.status; }
  get responseModel(): string | undefined { return this.metrics.responseModel ?? undefined; }
  get hasContent(): boolean { return this.jsonContent || this.metrics.firstTokenMs !== undefined; }
  get usage(): DirectChatUsage {
    return Object.fromEntries(["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]
      .flatMap(key => { const value = this.metrics[key as keyof typeof this.metrics]; return typeof value === "number" ? [[key, value]] : []; }));
  }
  observe(value: Record<string, unknown>, stream: boolean, receivedAt = performance.now()): boolean {
    const type = value.type;
    if (stream && (typeof type !== "string" || !/^[a-zA-Z0-9_.-]{1,160}$/u.test(type))) throw new ModelConversionError("Invalid Responses event type");
    if (stream && type === "error") {
      observeResponseEvent(this.metrics, type, value, Date.now(), receivedAt);
      throw chatUpstreamError(value.error ?? value);
    }
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
    if (stream) return observeResponseEvent(this.metrics, String(type), value, Date.now(), receivedAt);
    const terminalObserved = observeJsonResponse(this.metrics, value, Date.now(), receivedAt);
    this.jsonContent = terminalObserved && hasResponseOutputContent(value);
    return terminalObserved;
  }
}

export interface DirectResponsesCall {
  adapter?: OllamaFreeformResponse;
  ollamaFreeform?: boolean;
  request: DirectResponsesRequest;
  /** Optional tighter success-body budget; error bodies remain capped at 64 KiB. */
  maximumResponseBytes?: number;
  observeChunk?: (chunk: Buffer) => void;
  observeValue?: (value: Record<string, unknown>, stream: boolean, receivedAt: number) => void;
  target: DirectModelTarget;
  signal: AbortSignal;
  clientHeaders?: IncomingHttpHeaders;
  capture?: DirectChatCapture;
  diagnostics?(summary: ModelRequestDiagnostics): void;
  observer: DirectResponsesObserver;
  recheck(): void;
  submitted(userAgent: string | null, requestBytes: number, upstreamUrl: string | null): void;
  headers(status: number): void;
  content(): void;
  emit(value: Record<string, unknown>, terminal: boolean, rawFrame?: string): Promise<void>;
}

export async function sendDirectResponses(call: DirectResponsesCall): Promise<void> {
  const { adapter: suppliedAdapter, ...wireCall } = call;
  const adapted = suppliedAdapter ? { body: call.request, adapter: suppliedAdapter }
    : call.ollamaFreeform ? prepareOllamaFreeform(call.request) : undefined;
  call = adapted ? { ...wireCall, request: adapted.body as DirectResponsesRequest } : wireCall;
  let consuming = false;
  try { await withDirectModelResponse({ body: call.request, path: "/responses", target: call.target, signal: call.signal,
    ...(call.clientHeaders ? { clientHeaders: call.clientHeaders } : {}), recheck: () => call.recheck(),
    transformed: operation => call.capture?.transformed?.(operation),
    submitted: (ua, headers, path, requestBytes, upstreamUrl) => {
      call.observer.submitted(performance.now()); call.submitted(ua, requestBytes, upstreamUrl);
      call.capture?.submitted(call.request, headers, path);
    },
  }, incoming => { consuming = true; return consumeDirectResponses(incoming, { ...call, ...(suppliedAdapter || adapted?.adapter.active ? { adapter: adapted!.adapter } : {}) }); }); }
  catch (error) {
    if (!consuming && !call.signal.aborted) {
      const diagnostics = new ChatDiagnostics();
      diagnostics.error(error instanceof ChatUpstreamError ? error.code : "upstream_failure", "http", error instanceof ChatUpstreamError && error.retryable);
      call.diagnostics?.(modelRequestDiagnostics(diagnostics.snapshot()));
    }
    throw error;
  } finally { adapted?.adapter.close(); }
}

/** Shared bounded reader; raw capture/metrics precede pure normalization and delivery. */
export async function consumeDirectResponses(incoming: IncomingMessage, call: Pick<DirectResponsesCall,
  "request" | "signal" | "maximumResponseBytes" | "capture" | "diagnostics" | "observer" | "headers" | "content" | "emit"> & {
    adapter?: OllamaFreeformResponse;
    observeChunk?: (chunk: Buffer) => void;
    observeValue?: (value: Record<string, unknown>, stream: boolean, receivedAt: number) => void;
  }): Promise<void> {
  const diagnostics = new ChatDiagnostics();
  let errorStage: "http" | "stream" = "http";
  let delivering = false;
  const emit: typeof call.emit = async (...args) => {
    delivering = true;
    await call.emit(...args);
    delivering = false;
  };
  try {
      call.headers(incoming.statusCode ?? 502); call.capture?.head(incoming.statusCode ?? 502, incoming.headers);
      await validateDirectModelResponse(incoming, call.request.stream, {
        value: (value, stream) => {
          if (chatStreamError(value)) call.observer.receivedError(performance.now());
          diagnostics.push(value); call.capture?.value(value, stream);
        },
        invalid: count => call.capture?.invalid(count),
      }, call.signal);
      if (call.request.stream) errorStage = "stream";
      if (!call.request.stream) {
        const value = parse(await readDirectModelBody(incoming, call.signal, call.maximumResponseBytes, call.observeChunk), call.capture);
        if (chatStreamError(value)) call.observer.receivedError(performance.now());
        diagnostics.push(value);
        call.capture?.value(value, false);
        call.observeValue?.(value, false, performance.now());
        if (!call.observer.observe(value, false)) throw new ModelConversionError("Responses JSON has no terminal state");
        if (call.observer.status === "failed") diagnostics.error("upstream_failure", errorStage, false);
        if (call.observer.hasContent) call.content();
        call.capture?.done(); await emit(deliverable(call.adapter ? call.adapter.json(value) : value, false), true); return;
      }
      for await (const frame of readModelFrames(incoming, call.signal, {
        ...(call.observeChunk ? { observeChunk: call.observeChunk } : {}),
        frameBytes: Math.min(call.maximumResponseBytes ?? Infinity, 1024 * 1024),
        bufferBytes: Math.min(call.maximumResponseBytes ?? Infinity, 2 * 1024 * 1024),
        totalBytes: Math.min(call.maximumResponseBytes ?? Infinity, 32 * 1024 * 1024),
      })) {
        const value = parse(frame.data, call.capture);
        const event = frame.raw.split(/\r?\n/u).filter(line => line.startsWith("event:")).at(-1)?.slice(6).trim();
        if (event && event !== value.type) throw new ModelConversionError("Responses SSE event does not match its payload");
        diagnostics.push(value.type === "error" ? value : value.response);
        call.capture?.value(value, true);
        call.observeValue?.(value, true, frame.receivedAt);
        const terminal = call.observer.observe(value, true, frame.receivedAt);
        if (call.observer.status === "failed") diagnostics.error("upstream_failure", errorStage, false);
        if (call.observer.hasContent) call.content();
        if (terminal) call.capture?.done();
        const outputs = call.adapter ? call.adapter.event(value) : [value];
        for (const converted of outputs) {
          const output = deliverable(converted, true);
          await emit(output, terminal && converted.type === value.type, output === value ? frame.raw : undefined);
        }
        if (terminal) return;
      }
      throw new ModelConversionError("Responses stream disconnected before a terminal event");
  } catch (error) {
    if (!delivering && !call.signal.aborted) diagnostics.error(error instanceof ChatUpstreamError ? error.code : "upstream_failure", errorStage, error instanceof ChatUpstreamError && error.retryable);
    throw error;
  } finally { call.adapter?.close(); call.diagnostics?.(modelRequestDiagnostics(diagnostics.snapshot())); }
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
