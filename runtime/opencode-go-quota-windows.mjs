import {
  loadOpencodeGoAccountCredential,
  loadOpencodeGoAccountCredentialFor,
} from "./model-provider-runtime.mjs";

const usageUrl = "https://opencode.ai/zen/go/v1/usage";
const maximumResponseBytes = 65_536;
const requestTimeoutMs = 10_000;
const windowIds = Object.freeze(["rolling", "weekly", "monthly"]);
const fallbackCacheMs = 60_000;

export function createOpencodeGoQuotaWindowsProvider(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const provider = options.provider;
  let cached = null;
  let inflight = null;
  return async (signal) => {
    if (signal?.aborted) return null;
    const nowMs = options.nowMs?.() ?? Date.now();
    if (cached !== null && nowMs < cached.expiresAtMs) {
      return cached.snapshot;
    }
    if (inflight === null) {
      inflight = (async () => {
        try {
          const windows = await fetchQuotaWindows(
            environment,
            fetchImpl,
            provider,
            signal,
          );
          if (signal?.aborted) return null;
          if (windows === null) {
            cached = { snapshot: null, expiresAtMs: nowMs + fallbackCacheMs };
            return null;
          }
          const observedAtMs = options.nowMs?.() ?? Date.now();
          const snapshot = { windows, observedAtMs };
          const nextResetMs = Math.min(...windows.map((window) =>
            window.resetsAt === null ? Number.POSITIVE_INFINITY : window.resetsAt * 1_000));
          cached = {
            snapshot,
            expiresAtMs: Number.isFinite(nextResetMs) && nextResetMs > observedAtMs
              ? nextResetMs
              : observedAtMs + fallbackCacheMs,
          };
          return snapshot;
        } catch {
          if (signal?.aborted) return null;
          cached = { snapshot: null, expiresAtMs: nowMs + fallbackCacheMs };
          return null;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  };
}

async function fetchQuotaWindows(environment, fetchImpl, provider, signal) {
  let apiKey;
  try {
    apiKey = provider === undefined
      ? loadOpencodeGoAccountCredential(environment)
      : loadOpencodeGoAccountCredentialFor(provider, environment);
  } catch {
    return null;
  }
  const requestSignal = signal === undefined
    ? globalThis.AbortSignal.timeout(requestTimeoutMs)
    : globalThis.AbortSignal.any([
        signal,
        globalThis.AbortSignal.timeout(requestTimeoutMs),
      ]);
  let response;
  try {
    response = await fetchImpl(usageUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      redirect: "error",
      signal: requestSignal,
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  let body;
  try {
    body = await readQuotaResponseBody(response, requestSignal);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const usage = record(parsed).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const windows = [];
  for (const windowId of windowIds) {
    const window = record(usage)[windowId];
    if (!window || typeof window !== "object" || Array.isArray(window)) continue;
    const resetsAt = typeof window.resetsAt === "string"
      ? Date.parse(window.resetsAt)
      : Number.NaN;
    windows.push({
      windowId,
      resetsAt: Number.isFinite(resetsAt) ? Math.floor(resetsAt / 1_000) : null,
      usedPercentMillionths: typeof window.percent === "number"
        && Number.isFinite(window.percent)
        && window.percent >= 0
        && window.percent <= 100
        ? Math.round(window.percent * 1_000_000)
        : null,
      status: typeof window.status === "string" && window.status.length > 0
        ? window.status
        : null,
    });
  }
  return windows.length === 0 ? null : windows;
}

async function readQuotaResponseBody(response, signal) {
  if (!response.body) throw new Error("Missing quota response body");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let complete = false;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) {
        complete = true;
        return Buffer.concat(chunks, bytes).toString("utf8");
      }
      bytes += chunk.value.byteLength;
      if (bytes > maximumResponseBytes) throw new Error("Quota response too large");
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
