const duration = value => typeof value === "number" && Number.isFinite(value) && value >= 0;

export function validGenerationTiming(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = ["reasoningMs", "textMs", "toolMs", "totalMs"];
  return Object.keys(value).length === keys.length && keys.every(key => duration(value[key]))
    && value.totalMs >= Math.max(value.reasoningMs, value.textMs, value.toolMs)
    && value.totalMs <= value.reasoningMs + value.textMs + value.toolMs + 0.001;
}

export function validRequestTiming(value) {
  return (value.responseTimeMs == null || duration(value.responseTimeMs))
    && (value.generationTiming == null || validGenerationTiming(value.generationTiming))
    && (value.totalDurationMs == null || (
      (value.responseTimeMs == null || value.responseTimeMs <= value.totalDurationMs)
      && (value.generationTiming == null || value.generationTiming.totalMs <= value.totalDurationMs)));
}

/** A missing interval is never replaced with total request time. */
export function generationSpeed(value) {
  const timing = value?.generationTiming;
  if (!validGenerationTiming(timing) || timing.totalMs <= 0
    || !Number.isSafeInteger(value.outputTokens) || value.outputTokens <= 0) return null;
  const speed = value.outputTokens / (timing.totalMs / 1000);
  return Number.isFinite(speed) ? speed : null;
}

export function formatGenerationSpeed(value) {
  const speed = generationSpeed(value);
  return speed === null ? "—" : `${speed.toFixed(1)} /s`;
}
