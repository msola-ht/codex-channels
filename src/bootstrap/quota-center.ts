import type { Logger } from "pino";

import type { GatewayConfig } from "../config/index.js";
import type { RemoteQuotaSummary } from "../conversation-core/index.js";

const quotaResetToleranceSeconds = 5 * 60;

export interface CenterQuotaPeriod {
  provider?: string;
  windowId?: string;
  resetsAt?: number;
  deviceCount?: number;
  requestCount?: number;
  totalTokens?: number;
  totalCostNanos?: number | null;
  latestUsedPercentMillionths?: number | null;
  estimatedTotalTokens?: number | null;
  estimatedTotalCostNanos?: number | null;
  tokensPerPercent?: number | null;
  costPerPercentNanos?: number | null;
  lastObservedAtMs?: number;
}

export function selectRemoteQuotaPeriod(
  candidates: readonly CenterQuotaPeriod[],
  provider: string,
  resetsAt: number | null | undefined,
  nowMs = Date.now(),
): CenterQuotaPeriod | undefined {
  return selectRemoteQuotaPeriods(candidates, provider, resetsAt, nowMs)[0];
}

export function selectRemoteQuotaPeriods(
  candidates: readonly CenterQuotaPeriod[],
  provider: string,
  resetsAt: number | null | undefined,
  nowMs = Date.now(),
): CenterQuotaPeriod[] {
  const windowIds = supportedWindowIds(provider);
  const matching = candidates.filter((candidate) =>
    candidate.provider === provider
    && typeof candidate.windowId === "string"
    && windowIds.includes(candidate.windowId),
  );
  const nowSeconds = Math.floor(nowMs / 1_000);
  return windowIds.flatMap((windowId) => {
    const windowCandidates = matching.filter((candidate) => candidate.windowId === windowId);
    const exact = resetsAt === null || resetsAt === undefined
      ? undefined
      : windowCandidates.find((candidate) =>
          candidate.resetsAt !== undefined
          && Math.abs(candidate.resetsAt - resetsAt) <= quotaResetToleranceSeconds);
    const current = exact ?? windowCandidates
      .filter((candidate) =>
        candidate.resetsAt !== undefined
        && candidate.resetsAt >= nowSeconds
        && typeof candidate.lastObservedAtMs === "number")
      .sort((left, right) =>
        (right.lastObservedAtMs ?? 0) - (left.lastObservedAtMs ?? 0))[0];
    return current === undefined ? [] : [current];
  });
}

export async function readRemoteQuotaSummary(
  settings: GatewayConfig["metricsView"] | undefined,
  provider: string | undefined,
  resetsAt: number | null | undefined,
  logger?: Pick<Logger, "warn">,
  fetchImpl: typeof fetch = fetch,
): Promise<RemoteQuotaSummary | undefined> {
  if (!settings || !settings.enabled || !settings.endpoint || !settings.token || !provider) {
    return undefined;
  }
  const controller = new AbortController();
  // The center may aggregate a year's worth of periods from SQLite. Keep the
  // request bounded, but do not treat a normal local response (~1s) as a
  // failure and silently fall back to the single-device estimate.
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const endpoint = new URL("/api/quota?days=365", settings.endpoint);
    const response = await fetchImpl(endpoint, {
      headers: { authorization: `Bearer ${settings.token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger?.warn({ provider, resetsAt, status: response.status }, "指标中心额度查询失败");
      return undefined;
    }
    const body = await response.json() as {
      periods?: CenterQuotaPeriod[];
    };
    const candidates = body.periods ?? [];
    const periods = selectRemoteQuotaPeriods(candidates, provider, resetsAt);
    const summaries = periods.map((period) => {
      if (
        typeof period.deviceCount !== "number"
        || typeof period.requestCount !== "number"
        || typeof period.totalTokens !== "number"
        || typeof period.resetsAt !== "number"
        || typeof period.lastObservedAtMs !== "number"
      ) {
        return null;
      }
      return {
        provider,
        windowId: period.windowId ?? (provider === "openai" ? "codex" : "monthly"),
        deviceCount: period.deviceCount,
        requestCount: period.requestCount,
        totalTokens: period.totalTokens,
        totalCostNanos: typeof period.totalCostNanos === "number" ? period.totalCostNanos : null,
        latestUsedPercentMillionths: period.latestUsedPercentMillionths ?? null,
        estimatedTotalTokens: period.estimatedTotalTokens ?? null,
        estimatedTotalCostNanos: period.estimatedTotalCostNanos ?? null,
        tokensPerPercent: period.tokensPerPercent ?? null,
        costPerPercentNanos: period.costPerPercentNanos ?? null,
        resetsAt: period.resetsAt,
        observedAtMs: period.lastObservedAtMs,
      } satisfies RemoteQuotaSummary;
    });
    const valid: RemoteQuotaSummary[] = [];
    for (const summary of summaries) {
      if (summary !== null) valid.push(summary);
    }
    if (valid.length === 0) {
      logger?.warn({
        provider,
        resetsAt,
        candidateResetsAt: candidates
          .filter((candidate) => candidate.provider === provider
            && candidate.windowId !== undefined
            && supportedWindowIds(provider).includes(candidate.windowId))
          .map((candidate) => candidate.resetsAt)
          .filter((value): value is number => typeof value === "number")
          .slice(0, 8),
      }, "指标中心额度周期未命中");
      return undefined;
    }
    const primary = valid[0]!;
    return provider === "openai"
      ? primary
      : { ...primary, windows: valid };
  } catch (error) {
    logger?.warn({
      err: error,
      provider,
      resetsAt,
    }, "指标中心额度读取异常，回退本机估算");
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function supportedWindowIds(provider: string): readonly string[] {
  return provider === "openai"
    ? ["codex"]
    : ["monthly", "weekly", "rolling"];
}
