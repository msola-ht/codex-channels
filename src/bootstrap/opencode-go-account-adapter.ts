import {
  loadOpencodeGoAccountCredentialFor,
} from "../../runtime/model-provider-runtime.mjs";
import {
  loadOpencodeGoDefaultAccount,
  opencodeGoProviderId,
} from "../../runtime/opencode-go-accounts.mjs";
import {
  SqliteModelRequestMetricsStore,
  sumProviderQuotaTokens,
  type AsyncGatewayMetricsStore,
} from "../observability/index.js";
import { AccountQuery } from "./account-query.js";

import type {
  ProviderAccountAdapter,
  ProviderAccountUsage,
  ProviderQuotaWindow,
} from "../application/index.js";

const opencodeGoUsageUrl = "https://opencode.ai/zen/go/v1/usage";
const fiveHourMs = 5 * 60 * 60 * 1_000;
const sevenDayMs = 7 * 24 * 60 * 60 * 1_000;

const windowLabels: Readonly<Record<string, string>> = Object.freeze({
  rolling: "5小时",
  weekly: "7天",
  monthly: "月度",
});

export function createOpencodeGoAccountAdapter(
  options: OpencodeGoAccountAdapterOptions = {},
): ProviderAccountAdapter {
  const environment = options.environment ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const provider = options.provider ?? defaultOpencodeGoProvider(environment);
  return {
    provider,
    async accountUsage(signal) {
      const query = new AccountQuery("OpenCode Go", signal);
      return query.run(async () => {
        const apiKey = loadOpencodeGoAccountCredentialFor(provider, environment);
        const { body: parsed, status } = await query.json(fetchImpl, opencodeGoUsageUrl, apiKey, "usage", { allowForbidden: true });
        if (status === 403) {
          const error = record(record(parsed).error);
          if (record(parsed).type === "error" && error.type === "EntitlementError"
            && error.message === "OpenCode Go subscription required.") {
            return { kind: "subscription-required", provider };
          }
          query.rejectHttp(403);
        }
        const usage = parseUsageResponse(
          parsed,
          provider,
        );
        if (usage.kind !== "quota-windows") {
          throw new Error("OpenCode Go usage response schema is invalid");
        }
        const nowMs = options.nowMs?.() ?? Date.now();
        const monthlyWindow = usage.windows.find(
          (window) => window.windowId === "monthly",
        );
        let windowEndAtMs: number | null = monthlyWindow?.resetsAt === null
          || monthlyWindow?.resetsAt === undefined
          ? null
          : monthlyWindow.resetsAt * 1_000;
        let windowStartAtMs: number;
        try {
          windowStartAtMs = windowEndAtMs === null
            ? calendarMonthStart(nowMs)
            : opencodeGoMonthlyWindowStartMs(windowEndAtMs / 1_000);
        } catch {
          windowStartAtMs = calendarMonthStart(nowMs);
          windowEndAtMs = null;
        }
        query.stage = "local";
        query.operation = "local-tokens";
        const localTokens = options.metricsDatabasePath === undefined && options.metricsQuery === undefined
          ? null
          : await readWindowLocalTokens(
              options.metricsDatabasePath,
              nowMs,
              usage.windows,
              windowStartAtMs,
              windowEndAtMs,
              provider,
              options.metricsQuery, query.signal,
            );
        const windows = localTokens === null
          ? usage.windows
          : usage.windows.map((window) => ({
              ...window,
              localTokens: localTokens.get(window.windowId) ?? null,
            }));
        return { ...usage, windows, provider };
      });
    },
  };
}

export interface OpencodeGoAccountAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  metricsDatabasePath?: string;
  metricsQuery?: (signal?: AbortSignal) => Pick<AsyncGatewayMetricsStore, "providerQuotaTokens">;
  nowMs?: () => number;
  provider?: string;
}

function defaultOpencodeGoProvider(environment: NodeJS.ProcessEnv): string {
  const account = loadOpencodeGoDefaultAccount(environment);
  if (account === undefined) throw new Error("尚未配置 OpenCode Go 账户");
  return opencodeGoProviderId(account.id);
}

async function readWindowLocalTokens(
  metricsDatabasePath: string | undefined,
  nowMs: number,
  quotaWindows: readonly ProviderQuotaWindow[],
  monthlyWindowStartAtMs: number,
  monthlyWindowEndAtMs: number | null,
  provider: string,
  metricsQuery?: (signal?: AbortSignal) => Pick<AsyncGatewayMetricsStore, "providerQuotaTokens">,
  signal?: AbortSignal,
): Promise<Map<string, number>> {
  const tokens = new Map<string, number>();
  try {
      const ranges: ReadonlyArray<readonly [string, number | null, number, number]> = [
        [
          "rolling",
          windowResetsAt(quotaWindows, "rolling"),
          ...quotaWindowRange(
            quotaWindows.find((window) => window.windowId === "rolling"),
            nowMs,
            fiveHourMs,
          ),
        ],
        [
          "weekly",
          windowResetsAt(quotaWindows, "weekly"),
          ...quotaWindowRange(
            quotaWindows.find((window) => window.windowId === "weekly"),
            nowMs,
            sevenDayMs,
          ),
        ],
        [
          "monthly",
          monthlyWindowEndAtMs === null ? null : Math.floor(monthlyWindowEndAtMs / 1_000),
          monthlyWindowStartAtMs,
          monthlyWindowEndAtMs ?? nowMs,
        ],
      ];
      const validRanges = ranges.filter(([, , startAtMs, endAtMs]) =>
        Number.isFinite(startAtMs)
        && Number.isFinite(endAtMs)
        && endAtMs > startAtMs);
      let refreshed: Map<string, number>;
      if (metricsQuery) refreshed = await metricsQuery(signal).providerQuotaTokens(validRanges, provider);
      else {
        if (metricsDatabasePath === undefined) return tokens;
        const store = new SqliteModelRequestMetricsStore(metricsDatabasePath, nowMs, { readOnly: true });
        try { refreshed = sumProviderQuotaTokens(store, validRanges, provider); }
        finally { store.close(); }
      }
      for (const [windowId, total] of refreshed) tokens.set(windowId, total);
  } catch {
    // 指标库不可用时窗口本地 Token 保持不可用
  }
  return tokens;
}

function quotaWindowRange(
  window: ProviderQuotaWindow | undefined,
  nowMs: number,
  durationMs: number,
): [number, number] {
  if (window?.resetsAt === null || window?.resetsAt === undefined) {
    return [nowMs - durationMs, nowMs];
  }
  const resetsAtMs = window.resetsAt * 1_000;
  const startAtMs = resetsAtMs - durationMs;
  const endAtMs = Math.min(nowMs, resetsAtMs);
  if (
    Number.isFinite(startAtMs)
    && Number.isFinite(endAtMs)
    && endAtMs > startAtMs
  ) {
    return [startAtMs, endAtMs];
  }
  return [nowMs - durationMs, nowMs];
}

function windowResetsAt(
  windows: readonly ProviderQuotaWindow[],
  windowId: string,
): number | null {
  return windows.find((window) => window.windowId === windowId)?.resetsAt ?? null;
}

export function opencodeGoMonthlyWindowStartMs(resetsAtSeconds: number): number {
  if (!Number.isFinite(resetsAtSeconds) || resetsAtSeconds <= 0) {
    throw new Error("OpenCode Go 月度窗口重置时间无效");
  }
  const date = new Date(resetsAtSeconds * 1_000);
  const targetMonth = date.getUTCMonth() - 1;
  const targetYear = date.getUTCFullYear();
  const lastDayOfTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  return Date.UTC(
    targetYear,
    targetMonth,
    Math.min(date.getUTCDate(), lastDayOfTargetMonth),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  );
}

function calendarMonthStart(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function parseUsageResponse(value: unknown, provider: string): ProviderAccountUsage {
  const response = record(value);
  if (
    response.usage === null
    || typeof response.usage !== "object"
    || Array.isArray(response.usage)
  ) {
    throw new Error("OpenCode Go usage response schema is invalid");
  }
  const usage = record(response.usage);
  const windows = Object.entries(usage).flatMap(([windowId, raw]) => {
    const window = record(raw);
    if (
      typeof window.percent !== "number"
      || !Number.isFinite(window.percent)
      || window.percent < 0
      || window.percent > 100
    ) {
      return [];
    }
    const windowResult: ProviderQuotaWindow = {
      windowId,
      label: windowLabels[windowId] ?? windowId,
      usedPercent: window.percent,
      resetsAt: null,
      status: typeof window.status === "string" ? window.status : null,
    };
    if (typeof window.resetsAt === "string") {
      const resetsAt = Date.parse(window.resetsAt);
      if (Number.isFinite(resetsAt)) {
        windowResult.resetsAt = Math.floor(resetsAt / 1_000);
      }
    }
    return [windowResult];
  });
  if (windows.length === 0) {
    throw new Error("OpenCode Go usage response has no valid windows");
  }
  return {
    kind: "quota-windows",
    provider,
    available: true,
    windows,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
