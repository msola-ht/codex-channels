/** Bounded, allowlisted upstream facts; never collect content, credentials or error bodies. */
import { randomUUID } from "node:crypto";

export const chatDiagnosticsHeader = "x-codexc-chat-observer";
type Fields = Record<string, string | number | boolean>;
const maximumBytes = 6_000;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const identifiers = ["id", "generationId", "model", "object", "system_fingerprint", "service_tier"];
const costs = ["cost", "gatewayCost", "inferenceCost", "inputInferenceCost", "outputInferenceCost", "marketCost", "surchargeCost"];

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
      const metadata = record(record(record(choice).delta).provider_metadata);
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
