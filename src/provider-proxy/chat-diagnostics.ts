/** Bounded, allowlisted upstream facts; never collect content, credentials or error bodies. */
import { randomUUID } from "node:crypto";

export const chatDiagnosticsHeader = "x-codexc-chat-observer";
type Fields = Record<string, string | number | boolean>;
const maximumBytes = 6_000;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identifiers = ["id", "generationId", "model", "object", "system_fingerprint", "service_tier"];
const costs = ["cost", "gatewayCost", "inferenceCost", "inputInferenceCost", "outputInferenceCost", "marketCost", "surchargeCost"];

/** Independent request metrics; excludes IDs, bodies, costs and routing history. */
export interface ModelRequestDiagnostics {
  upstreamProvider?: string | null;
  upstreamAttemptCount?: number | null;
  modelAttemptCount?: number | null;
  finishReason?: string | null;
  errorStage?: "http" | "stream" | null;
  upstreamErrorCode?: string | null;
  upstreamErrorType?: string | null;
  upstreamHttpStatus?: number | null;
}

export const modelRequestDiagnosticKeys = ["upstreamProvider", "upstreamAttemptCount", "modelAttemptCount", "finishReason", "errorStage", "upstreamErrorCode", "upstreamErrorType", "upstreamHttpStatus"] as const;

/** Shared IPC boundary validation for both owned and Relay requests. */
export function validModelRequestDiagnostics(value: Record<string, unknown>): boolean {
  return modelRequestDiagnosticKeys.every(key => {
    const field = value[key];
    if (field == null) return true;
    if (key === "errorStage") return field === "http" || field === "stream";
    if (key === "upstreamHttpStatus") return typeof field === "number" && Number.isInteger(field) && field >= 400 && field <= 599;
    if (key === "upstreamAttemptCount" || key === "modelAttemptCount") return typeof field === "number" && Number.isSafeInteger(field) && field >= 0;
    return typeof field === "string" && /^[a-zA-Z0-9_.:/-]{1,256}$/u.test(field);
  });
}

export function modelRequestDiagnostics(snapshot: ChatDiagnosticSnapshot): ModelRequestDiagnostics {
  const fields = snapshot.fields;
  const candidates = {
    upstreamProvider: fields["routing.finalProvider"],
    upstreamAttemptCount: fields["routing.totalProviderAttemptCount"],
    modelAttemptCount: fields["routing.modelAttemptCount"],
    finishReason: fields.finishReason,
    errorStage: fields["error.stage"],
    upstreamErrorCode: fields["upstreamError.cause.code"],
    upstreamErrorType: fields["upstreamError.cause.type"],
    upstreamHttpStatus: fields["upstreamError.cause.statusCode"],
  };
  return Object.fromEntries(Object.entries(candidates).filter(([key, value]) => value !== undefined && validModelRequestDiagnostics({ [key]: value })));
}

export class ChatDiagnostics {
  private readonly fields: Fields = {};
  private truncated = false;
  private put(key: string, value: unknown, numeric = false): void {
    if (value == null) return;
    const valid = typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value) && value >= 0)
      || (typeof value === "string" && value.length <= 256 && (numeric ? /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu : /^[a-zA-Z0-9_.:/-]+$/u).test(value));
    if (!valid) { this.truncated = true; return; }
    const next = { ...this.fields, [key]: value };
    if (Object.keys(next).length > 256 || Buffer.byteLength(JSON.stringify(next)) > maximumBytes) { this.truncated = true; return; }
    this.fields[key] = value;
  }
  header(requestId: unknown): void { this.put("requestId", requestId); }
  push(value: unknown): void {
    const chunk = record(value);
    const failure: unknown = (Array.isArray(chunk.choices) ? chunk.choices : []).find(choice => record(choice).error != null || record(choice).finish_reason === "error");
    this.upstreamError(chunk.error ?? record(failure).error);
    for (const key of identifiers) this.put(key, chunk[key]);
    this.put("created", chunk.created, true);
    const usage = record(chunk.usage);
    for (const key of ["prompt_tokens", "completion_tokens", "total_tokens", "cache_creation_input_tokens", "cost", "gateway_cost", "market_cost", "is_byok"]) this.put(`usage.${key}`, usage[key], true);
    for (const group of ["prompt_tokens_details", "completion_tokens_details"]) {
      const details = record(usage[group]);
      for (const key of ["cached_tokens", "reasoning_tokens", "audio_tokens", "video_tokens", "image_tokens"]) this.put(`usage.${group}.${key}`, details[key], true);
    }
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices.slice(0, 1) : []) {
      this.put("finishReason", record(choice).finish_reason);
      // JSON completions use message; streaming chunks use delta.
      const entry = record(choice);
      const metadata = record(record(entry.delta ?? entry.message).provider_metadata);
      const gateway = record(metadata.gateway);
      for (const key of costs) this.put(`gateway.${key}`, gateway[key], true);
      this.put("gateway.generationId", gateway.generationId);
      const routing = record(gateway.routing);
      for (const key of ["canonicalSlug", "originalModelId", "resolvedProvider", "finalProvider", "modelAttemptCount", "totalProviderAttemptCount"]) this.put(`routing.${key}`, routing[key]);
      const fallbacks = routing.fallbacksAvailable;
      if (Array.isArray(fallbacks)) {
        if (fallbacks.length > 16) this.truncated = true;
        fallbacks.slice(0, 16).forEach((value, index) => this.put(`routing.fallbacks.${index}`, value));
      }
      const attempts = Array.isArray(routing.modelAttempts) ? routing.modelAttempts : [];
      if (attempts.length > 8) this.truncated = true;
      attempts.slice(0, 8).forEach((attempt, modelIndex) => {
        const providers = record(attempt).providerAttempts;
        if (!Array.isArray(providers)) return;
        if (providers.length > 8) this.truncated = true;
        providers.slice(0, 8).forEach((provider, index) => {
          const values = record(provider);
          for (const key of ["provider", "providerRequestId", "providerResponseId", "statusCode", "success", "startTime", "endTime"]) this.put(`routing.attempts.${modelIndex}.${index}.${key}`, values[key]);
        });
      });
      const deepseek = record(metadata.deepseek);
      for (const key of ["promptCacheHitTokens", "promptCacheMissTokens", "systemFingerprint"]) this.put(`deepseek.${key}`, deepseek[key]);
    }
  }
  private upstreamError(value: unknown): void {
    const error = record(value);
    for (const key of ["code", "type", "request_id"]) this.put(`upstreamError.${key}`, error[key]);
    // Observed Cline stream-initialization envelope. This is diagnostic evidence only:
    // never classify, retry, or forward arbitrary message text based on this embedded JSON.
    if (error.code !== "stream_initialization_failed" || typeof error.message !== "string") return;
    if (Buffer.byteLength(error.message) > 64 * 1024) { this.truncated = true; return; }
    if (!error.message.startsWith("Failed to create stream:")) return;
    const start = error.message.indexOf("{");
    if (start < 0) return;
    let embedded: Record<string, unknown>;
    try { embedded = record(record(JSON.parse(error.message.slice(start))).error); }
    catch { return; }
    for (const key of ["code", "type"]) this.put(`upstreamError.cause.${key}`, embedded[key]);
    const param = record(embedded.param);
    const status = param.statusCode;
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
      this.put("upstreamError.cause.statusCode", status);
    }
    this.put("upstreamError.cause.param.type", param.type);
  }
  error(code: string, stage: "http" | "stream", retryable: boolean): void {
    this.put("error.code", code); this.put("error.stage", stage); this.put("error.retryable", retryable);
  }
  responseStatus(status: number | undefined): void { this.put("httpStatus", status); }
  snapshot(): ChatDiagnosticSnapshot { return { fields: { ...this.fields }, truncated: this.truncated }; }
}

export interface ChatDiagnosticSnapshot { fields: Fields; truncated: boolean }

/** Request-scoped in-process delivery; HTTP carries only an unguessable correlation ID. */
export class ChatDiagnosticsChannel {
  private readonly listeners = new Map<string, (snapshot: ChatDiagnosticSnapshot) => void>();
  subscribe(listener: (snapshot: ChatDiagnosticSnapshot) => void): { id: string; close: () => void } {
    const id = randomUUID();
    this.listeners.set(id, listener);
    return { id, close: () => { this.listeners.delete(id); } };
  }
  publish(id: unknown, snapshot: ChatDiagnosticSnapshot): void {
    if (typeof id === "string") this.listeners.get(id)?.(snapshot);
  }
  clear(): void { this.listeners.clear(); }
}
