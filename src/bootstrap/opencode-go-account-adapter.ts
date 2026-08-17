import { loadOpencodeGoAccountCredential } from "../../runtime/model-provider-runtime.mjs";
import {
  calculateModelRequestCostComponents,
  SqliteModelRequestMetricsStore,
} from "../observability/index.js";
import { readBoundedFetchBody } from "./bounded-fetch-body.js";
import {
  loadOpenCodeGoPricingBaseline,
  OpenCodeGoModelPricingResolver,
} from "./opencode-go-model-pricing.js";

import type {
  ProviderAccountAdapter,
  ProviderModelUsageEstimate,
  ProviderAccountUsage,
  ProviderQuotaWindow,
} from "../application/index.js";
import { UserFacingError } from "../conversation-core/index.js";

const opencodeGoUsageUrl = "https://opencode.ai/zen/go/v1/usage";
const maximumResponseBytes = 65_536;
const requestTimeoutMs = 10_000;

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
  return {
    provider: "opencode-go",
    async accountUsage() {
      try {
        const apiKey = loadOpencodeGoAccountCredential(environment);
        const response = await fetchImpl(opencodeGoUsageUrl, {
          method: "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          signal: AbortSignal.timeout(requestTimeoutMs),
        });
        if (!response.ok) {
          throw new Error(`OpenCode Go usage request failed with status ${response.status}`);
        }
        const body = await readBoundedFetchBody(response, maximumResponseBytes, {
          invalidContentLength: () => new Error("OpenCode Go usage response length is invalid"),
          tooLarge: () => new Error("OpenCode Go usage response is too large"),
          missingBody: () => new Error("OpenCode Go usage response is empty"),
        });
        const usage = parseUsageResponse(JSON.parse(body.toString("utf8")) as unknown);
        const nowMs = options.nowMs?.() ?? Date.now();
        const monthlyWindow = usage.kind === "quota-windows"
          ? usage.windows.find((window) => window.windowId === "monthly")
          : undefined;
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
        const modelUsage = options.metricsDatabasePath === undefined
          ? undefined
          : readModelUsageEstimates(
              options.metricsDatabasePath,
              nowMs,
              windowStartAtMs,
              windowEndAtMs,
            );
        return modelUsage === undefined
          ? usage
          : { ...usage, modelUsage };
      } catch {
        throw new UserFacingError(
          "provider.account.unavailable",
          "OpenCode Go 账户查询失败",
          { provider: "OpenCode Go" },
        );
      }
    },
  };
}

export interface OpencodeGoAccountAdapterOptions {
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  metricsDatabasePath?: string;
  nowMs?: () => number;
}

function readModelUsageEstimates(
  metricsDatabasePath: string,
  endAtMs: number,
  windowStartAtMs: number,
  windowEndAtMs: number | null,
): ProviderModelUsageEstimate[] {
  try {
    const store = new SqliteModelRequestMetricsStore(
      metricsDatabasePath,
      endAtMs,
      { readOnly: true },
    );
    try {
      const resolver = new OpenCodeGoModelPricingResolver();
      const baseline = loadOpenCodeGoPricingBaseline();
      const totals = new Map<string, number>();
      let offset = 0;
      do {
        const page = store.page({
          startAtMs: windowStartAtMs,
          endAtMs,
          offset,
          limit: 500,
          sortKey: "recordedAtMs",
          sortDirection: "asc",
          filter: "opencode-go",
        });
        for (const record of page.records) {
          if (record.provider !== "opencode-go" || record.model === null) {
            continue;
          }
          const atMs = record.requestStartedAtMs ?? record.recordedAtMs;
          const pricing = resolver.resolve({
            provider: "opencode-go",
            model: record.model,
            serviceTier: record.serviceTier,
            inputTokens: record.inputTokens,
            atMs,
          });
          if (pricing === null) continue;
          const cost = calculateModelRequestCostComponents(
            {
              inputTokens: record.inputTokens,
              cachedInputTokens: record.cachedInputTokens,
              outputTokens: record.outputTokens,
            },
            pricing,
          );
          if (cost === null) continue;
          totals.set(
            record.model,
            (totals.get(record.model) ?? 0) + cost.totalCostNanos,
          );
        }
        offset = page.nextOffset ?? -1;
      } while (offset >= 0);
      const estimates: ProviderModelUsageEstimate[] = [];
      for (const [model, usedUsdNanos] of totals) {
        const includedUsageUsd = baseline.models.get(model)?.includedUsageUsd;
        if (includedUsageUsd === undefined) continue;
        const includedUsdNanos = Math.round(includedUsageUsd * 1_000_000_000);
        estimates.push({
          model,
          includedUsageUsd,
          usedUsdNanos,
          usedPercent: usedUsdNanos / includedUsdNanos * 100,
          remainingUsdNanos: includedUsdNanos - usedUsdNanos,
          windowStartAtMs,
          windowEndAtMs,
        });
      }
      return estimates.sort((left, right) =>
        right.usedUsdNanos! - left.usedUsdNanos!);
    } finally {
      store.close();
    }
  } catch {
    return [];
  }
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

function parseUsageResponse(value: unknown): ProviderAccountUsage {
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
    provider: "opencode-go",
    available: true,
    windows,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
