import { loadOpencodeGoAccountCredential } from "./model-provider-runtime.mjs";

const usageUrl = "https://opencode.ai/zen/go/v1/usage";
const maximumResponseBytes = 65_536;
const requestTimeoutMs = 10_000;
const windowIds = Object.freeze(["rolling", "weekly", "monthly"]);
const fallbackCacheMs = 60_000;

export function createOpencodeGoQuotaWindowsProvider(options = {}) {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  let cached = null;
  let inflight = null;
  return async () => {
    const nowMs = options.nowMs?.() ?? Date.now();
    if (cached !== null && nowMs < cached.expiresAtMs) {
      return cached.windows;
    }
    if (inflight === null) {
      inflight = (async () => {
        try {
          const windows = await fetchQuotaWindows(environment, fetchImpl);
          if (windows === null) {
            cached = { windows: null, expiresAtMs: nowMs + fallbackCacheMs };
            return null;
          }
          const nextResetMs = Math.min(...windows.map((window) =>
            window.resetsAt === null ? Number.POSITIVE_INFINITY : window.resetsAt * 1_000));
          cached = {
            windows,
            expiresAtMs: Number.isFinite(nextResetMs)
              ? nextResetMs
              : nowMs + fallbackCacheMs,
          };
          return windows;
        } catch {
          cached = { windows: null, expiresAtMs: nowMs + fallbackCacheMs };
          return null;
        } finally {
          inflight = null;
        }
      })();
    }
    return inflight;
  };
}

async function fetchQuotaWindows(environment, fetchImpl) {
  let apiKey;
  try {
    apiKey = loadOpencodeGoAccountCredential(environment);
  } catch {
    return null;
  }
  let response;
  try {
    response = await fetchImpl(usageUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      signal: globalThis.AbortSignal.timeout(requestTimeoutMs),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body;
  try {
    body = await response.text();
  } catch {
    return null;
  }
  if (body.length > maximumResponseBytes) return null;
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
    });
  }
  return windows.length === 0 ? null : windows;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
