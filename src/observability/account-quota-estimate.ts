import type { AccountQuotaWindowEstimate, ModelRequestMetricSample } from "./request-metrics.js";

interface Snapshot {
  observedAtMs: number;
  available: boolean;
  usage: unknown;
}
interface Window { windowId: string; resetsAt: number; usedPercent: number }
interface Sample { tokens: number; requests: number; incomplete: boolean }

/** Reduces persisted account observations; unfinished intervals never enter the ratio. */
export function createAccountQuotaEstimator(snapshots: readonly Snapshot[], nowMs: number) {
  const intervals: Sample[] = snapshots.map(() => ({ tokens: 0, requests: 0, incomplete: false }));
  return {
    observe(this: void, metric: Pick<ModelRequestMetricSample,
      "requestStartedAtMs" | "responseCompletedAtMs" | "inputTokens" | "outputTokens">): void {
      if (snapshots.length < 2 || metric.responseCompletedAtMs <= snapshots[0]!.observedAtMs) return;
      let low = 1;
      let high = snapshots.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (snapshots[middle]!.observedAtMs <= metric.requestStartedAtMs) low = middle + 1;
        else high = middle;
      }
      // We cannot split one request's usage across account observations. Invalidate
      // every interval it touches, including requests already running at the baseline.
      for (let index = low; index < snapshots.length; index += 1) {
        const interval = intervals[index]!;
        const left = snapshots[index - 1]!.observedAtMs;
        const right = snapshots[index]!.observedAtMs;
        if (index > low && metric.responseCompletedAtMs <= left) break;
        if (metric.requestStartedAtMs < left || metric.responseCompletedAtMs > right
          || metric.responseCompletedAtMs < metric.requestStartedAtMs) {
          interval.incomplete = true;
          continue;
        }
        interval.requests += 1;
        const tokens = metric.inputTokens === null || metric.outputTokens === null
          ? null : metric.inputTokens + metric.outputTokens;
        if (tokens === null || !Number.isSafeInteger(tokens) || tokens < 0) interval.incomplete = true;
        else interval.tokens += tokens;
        break;
      }
    },
    result(): AccountQuotaWindowEstimate[] {
      const states = new Map<string, {
        window: Window; pending: Sample; total: Sample; delta: number; count: number;
      }>();
      for (const [index, snapshot] of snapshots.entries()) {
        const windows = readWindows(snapshot);
        const present = new Set(windows.map(window => window.windowId));
        for (const id of states.keys()) if (!present.has(id)) states.delete(id);
        for (const window of windows) {
          let state = states.get(window.windowId);
          // A reset, backwards percentage, or missing observation starts a new baseline.
          if (!state || state.window.resetsAt !== window.resetsAt || window.usedPercent < state.window.usedPercent) {
            state = { window, pending: empty(), total: empty(), delta: 0, count: 0 };
            states.set(window.windowId, state);
            continue;
          }
          merge(state.pending, intervals[index]!);
          const delta = window.usedPercent - state.window.usedPercent;
          if (delta <= 0) continue;
          if (!state.pending.incomplete && state.pending.requests > 0 && state.pending.tokens > 0) {
            merge(state.total, state.pending);
            state.delta += delta;
            state.count += 1;
          }
          state.window = window;
          state.pending = empty();
        }
      }
      return [...states.values()].map(state => ({
        windowId: state.window.windowId,
        resetsAt: state.window.resetsAt,
        tokenEstimate: state.delta > 0 && state.window.resetsAt * 1_000 > nowMs
          ? { status: "ready", tokensPerPercent: state.total.tokens / state.delta,
              observedDeltaPercent: state.delta, intervalCount: state.count, requestCount: state.total.requests }
          : { status: "sampling" },
      }));
    },
  };
}

function empty(): Sample { return { tokens: 0, requests: 0, incomplete: false }; }
function merge(target: Sample, source: Sample): void {
  target.tokens += source.tokens;
  target.requests += source.requests;
  target.incomplete ||= source.incomplete;
}
function readWindows(snapshot: Snapshot): Window[] {
  if (!snapshot.available || !isRecord(snapshot.usage) || snapshot.usage.kind !== "quota-windows"
    || snapshot.usage.available !== true || !Array.isArray(snapshot.usage.windows)) return [];
  const windows = new Map<string, Window>();
  const ids = new Set<string>();
  for (const value of snapshot.usage.windows) {
    if (!isRecord(value) || typeof value.windowId !== "string" || !value.windowId) continue;
    if (ids.has(value.windowId)) {
      windows.delete(value.windowId);
      continue;
    }
    ids.add(value.windowId);
    if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent) || value.usedPercent < 0
      || typeof value.resetsAt !== "number" || !Number.isSafeInteger(value.resetsAt) || value.resetsAt <= 0) continue;
    windows.set(value.windowId, { windowId: value.windowId, usedPercent: value.usedPercent, resetsAt: value.resetsAt });
  }
  return [...windows.values()];
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
