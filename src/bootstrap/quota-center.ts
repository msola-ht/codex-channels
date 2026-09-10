import type { Logger } from "pino";

import type { ProviderQuotaWindow } from "../application/index.js";
import type { GatewayConfig } from "../config/index.js";
import type { RemoteQuotaSummary } from "../conversation-core/index.js";

const quotaResetToleranceSeconds = 5 * 60;
const remoteQuotaCacheTtlMs = 30_000;
const remoteQuotaRetryDelayMs = 5_000;
const officialQuotaSnapshotMaxAgeMs = 5 * 60_000;

export interface CenterQuotaPeriod {
  provider?: string;
  windowId?: string;
  resetsAt?: number;
  deviceCount?: number;
  requestCount?: number;
  totalTokens?: number;
  latestUsedPercentMillionths?: number | null;
  estimatedTotalTokens?: number | null;
  tokensPerPercent?: number | null;
  lastObservedAtMs?: number;
}

/**
 * 补齐额度中心暂未同步的官方窗口。中心摘要仍是多设备统计的事实来源，
 * 补入的窗口只使用官方账户窗口的百分比和重置时间。
 */
export function mergeMissingRemoteQuotaWindows(
  summary: RemoteQuotaSummary,
  fallbackWindows: readonly ProviderQuotaWindow[],
  observedAtMs: number,
): RemoteQuotaSummary {
  if (summary.windows === undefined || fallbackWindows.length === 0) return summary;
  const existing = new Set(summary.windows.map((window) => window.windowId));
  const missing = fallbackWindows.flatMap((window) => {
    if (existing.has(window.windowId)) return [];
    existing.add(window.windowId);
    return [{
      provider: summary.provider,
      windowId: window.windowId,
      deviceCount: summary.deviceCount,
      requestCount: summary.requestCount,
      totalTokens: summary.totalTokens,
      latestUsedPercentMillionths: Number.isFinite(window.usedPercent)
        ? Math.round(window.usedPercent * 1_000_000)
        : null,
      resetsAt: window.resetsAt,
      estimatedTotalTokens: null,
      observedAtMs,
    } satisfies RemoteQuotaSummary];
  });
  return missing.length === 0
    ? summary
    : { ...summary, windows: [...summary.windows, ...missing] };
}

/**
 * 只允许使用近期且仍处于有效周期的官方账户窗口，避免额度中心短暂缺数时
 * 把启动时缓存的过期快照展示到完成卡片。
 */
export function selectFreshOfficialQuotaWindows(
  windows: readonly ProviderQuotaWindow[],
  observedAtMs: number | undefined,
  nowMs = Date.now(),
): readonly ProviderQuotaWindow[] {
  if (
    typeof observedAtMs !== "number"
    || !Number.isFinite(observedAtMs)
    || observedAtMs <= 0
    || observedAtMs > nowMs
    || nowMs - observedAtMs > officialQuotaSnapshotMaxAgeMs
  ) {
    return [];
  }
  return windows.filter((window) =>
    window.resetsAt === null
    || (Number.isFinite(window.resetsAt) && window.resetsAt * 1_000 > nowMs),
  );
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
        latestUsedPercentMillionths: period.latestUsedPercentMillionths ?? null,
        estimatedTotalTokens: period.estimatedTotalTokens ?? null,
        tokensPerPercent: period.tokensPerPercent ?? null,
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

interface RemoteQuotaCacheEntry {
  value: RemoteQuotaSummary | undefined;
  expiresAtMs: number;
  nextAttemptAtMs: number;
  refresh: Promise<void> | undefined;
}

/**
 * 返回一个非阻塞的额度快照读取器。首次读取和过期刷新都在后台进行，
 * 完成卡片只消费已经缓存的快照，不因额度中心网络而延迟主输出。
 */
export function createRemoteQuotaSnapshotReader(
  read: (
    provider: string,
    resetsAt: number | null | undefined,
  ) => Promise<RemoteQuotaSummary | undefined>,
  options: {
    nowMs?: () => number;
    ttlMs?: number;
    retryDelayMs?: number;
  } = {},
): (
  provider: string | undefined,
  resetsAt: number | null | undefined,
) => RemoteQuotaSummary | undefined {
  const nowMs = options.nowMs ?? Date.now;
  const ttlMs = options.ttlMs ?? remoteQuotaCacheTtlMs;
  const retryDelayMs = options.retryDelayMs ?? remoteQuotaRetryDelayMs;
  const entries = new Map<string, RemoteQuotaCacheEntry>();
  return (provider, resetsAt) => {
    if (!provider) return undefined;
    const key = `${provider}\u0000${resetsAt ?? ""}`;
    const now = nowMs();
    const entry = entries.get(key) ?? {
      value: undefined,
      expiresAtMs: 0,
      nextAttemptAtMs: 0,
      refresh: undefined,
    };
    entries.set(key, entry);
    if (entry.value !== undefined && now < entry.expiresAtMs) {
      return entry.value;
    }
    if (entry.refresh !== undefined || now < entry.nextAttemptAtMs) {
      return undefined;
    }
    entry.nextAttemptAtMs = now + retryDelayMs;
    entry.refresh = Promise.resolve()
      .then(() => read(provider, resetsAt))
      .then((value) => {
        if (value === undefined) {
          entry.value = undefined;
          entry.expiresAtMs = 0;
          return;
        }
        entry.value = value;
        entry.expiresAtMs = nowMs() + ttlMs;
        entry.nextAttemptAtMs = 0;
      })
      .catch(() => {
        entry.value = undefined;
        entry.expiresAtMs = 0;
      })
      .finally(() => {
        entry.refresh = undefined;
      });
    return undefined;
  };
}

function supportedWindowIds(provider: string): readonly string[] {
  return provider === "openai"
    ? ["codex"]
    : ["monthly", "weekly", "rolling"];
}
