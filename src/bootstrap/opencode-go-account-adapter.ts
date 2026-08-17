import { loadOpencodeGoAccountCredential } from "../../runtime/model-provider-runtime.mjs";
import {
  calculateModelRequestCostComponents,
  SqliteModelRequestMetricsStore,
} from "../observability/index.js";
import { readBoundedFetchBody } from "./bounded-fetch-body.js";
import {
  loadOpenCodeGoPricingBaseline,
  OpenCodeGoModelPricingResolver,
  isOpenCodeGoPeakMinute,
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
        const modelUsage = options.metricsDatabasePath === undefined
          ? undefined
          : readModelUsageEstimates(
              options.metricsDatabasePath,
              nowMs,
              windowStartAtMs,
              windowEndAtMs,
            );
        const localTokens = options.metricsDatabasePath === undefined
          ? null
          : readWindowLocalTokens(
              options.metricsDatabasePath,
              nowMs,
              windowStartAtMs,
              windowEndAtMs,
            );
        const windows = localTokens === null
          ? usage.windows
          : usage.windows.map((window) => ({
              ...window,
              localTokens: localTokens.get(window.windowId) ?? null,
            }));
        return modelUsage === undefined
          ? { ...usage, windows }
          : { ...usage, windows, modelUsage };
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

export function createOpencodeGoRemainingUsageReader(
  options: OpencodeGoAccountAdapterOptions = {},
): (
  model: string,
  requestStartedAtMs?: number,
) => Promise<ProviderModelUsageEstimate | null> {
  const adapter = createOpencodeGoAccountAdapter(options);
  return async (model, requestStartedAtMs) => {
    try {
      const usage = await adapter.accountUsage();
      if (usage.kind !== "quota-windows") return null;
      const baseline = loadOpenCodeGoPricingBaseline();
      const bucket = baseline.models.get(model)?.peakOffPeak === undefined
        ? undefined
        : isOpenCodeGoPeakMinute(
            new Date(requestStartedAtMs ?? options.nowMs?.() ?? Date.now()),
            baseline,
          )
          ? "peak"
          : "off-peak";
      return usage.modelUsage?.find((estimate) =>
        estimate.model === model && estimate.bucket === bucket) ?? null;
    } catch {
      return null;
    }
  };
}

function readWindowLocalTokens(
  metricsDatabasePath: string,
  nowMs: number,
  monthlyWindowStartAtMs: number,
  monthlyWindowEndAtMs: number | null,
): Map<string, number> {
  const tokens = new Map<string, number>();
  try {
    const store = new SqliteModelRequestMetricsStore(
      metricsDatabasePath,
      nowMs,
      { readOnly: true },
    );
    try {
      const windows: ReadonlyArray<readonly [string, number, number]> = [
        ["rolling", nowMs - 5 * 60 * 60 * 1_000, nowMs],
        ["weekly", nowMs - 7 * 24 * 60 * 60 * 1_000, nowMs],
        ["monthly", monthlyWindowStartAtMs, monthlyWindowEndAtMs ?? nowMs],
      ];
      for (const [windowId, startAtMs, endAtMs] of windows) {
        if (
          Number.isFinite(startAtMs)
          && Number.isFinite(endAtMs)
          && endAtMs > startAtMs
        ) {
          tokens.set(windowId, readOpencodeGoTokens(store, startAtMs, endAtMs));
        }
      }
    } finally {
      store.close();
    }
  } catch {
    // 指标库不可用时窗口本地 Token 保持不可用
  }
  return tokens;
}

function readOpencodeGoTokens(
  store: SqliteModelRequestMetricsStore,
  startAtMs: number,
  endAtMs: number,
): number {
  let total = 0;
  let offset = 0;
  do {
    const page = store.page({
      startAtMs,
      endAtMs,
      offset,
      limit: 500,
      sortKey: "recordedAtMs",
      sortDirection: "asc",
      filter: "opencode-go",
    });
    for (const record of page.records) {
      if (record.provider !== "opencode-go") continue;
      const requestAtMs = record.requestStartedAtMs ?? record.recordedAtMs;
      if (requestAtMs < startAtMs || requestAtMs >= endAtMs) continue;
      const totalTokens = record.totalTokens;
      if (
        totalTokens !== null
        && Number.isSafeInteger(totalTokens)
        && totalTokens >= 0
      ) {
        total += totalTokens;
        continue;
      }
      if (record.inputTokens !== null && record.outputTokens !== null) {
        total += record.inputTokens + record.outputTokens;
      }
    }
    offset = page.nextOffset ?? -1;
  } while (offset >= 0);
  return total;
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
      const priceEffectiveAtMs = baseline.sourceUpdatedAtMs;
      type ModelBucket = "off-peak" | "peak";
      const totals = new Map<string, {
        model: string;
        bucket: ModelBucket | null;
        usedUsdNanos: number;
      }>();
      const totalKey = (model: string, bucket: ModelBucket | null) =>
        bucket === null ? model : `${model}:${bucket}`;
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
          const usage = {
            inputTokens: record.inputTokens,
            cachedInputTokens: record.cachedInputTokens,
            outputTokens: record.outputTokens,
          };
          const cost = atMs >= priceEffectiveAtMs
            ? (() => {
                const pricing = resolver.resolve({
                  provider: "opencode-go",
                  model: record.model,
                  serviceTier: record.serviceTier,
                  inputTokens: record.inputTokens,
                  atMs,
                });
                return pricing === null
                  ? null
                  : calculateModelRequestCostComponents(usage, pricing);
              })()
            : record.pricing === null
              ? null
              : calculateModelRequestCostComponents(usage, record.pricing);
          if (cost === null) continue;
          const bucket = baseline.models.get(record.model)?.peakOffPeak === undefined
            ? null
            : isOpenCodeGoPeakMinute(new Date(atMs), baseline)
              ? "peak"
              : "off-peak";
          const key = totalKey(record.model, bucket);
          const existing = totals.get(key);
          totals.set(key, {
            model: record.model,
            bucket,
            usedUsdNanos: (existing?.usedUsdNanos ?? 0) + cost.totalCostNanos,
          });
        }
        offset = page.nextOffset ?? -1;
      } while (offset >= 0);
      const estimates: ProviderModelUsageEstimate[] = [];
      const pushEstimate = (
        model: string,
        bucket: ModelBucket | null,
        usedUsdNanos: number,
      ): void => {
        const includedUsageUsd = baseline.models.get(model)?.includedUsageUsd;
        if (includedUsageUsd === undefined) return;
        const includedUsdNanos = Math.round(includedUsageUsd * 1_000_000_000);
        const common = {
          model,
          ...(bucket === null ? {} : { bucket }),
          includedUsageUsd,
          windowStartAtMs,
          windowEndAtMs,
        };
        if (includedUsdNanos <= 0) {
          estimates.push({
            ...common,
            usedUsdNanos,
            usedPercent: null,
            remainingUsdNanos: null,
          });
          return;
        }
        estimates.push({
          ...common,
          usedUsdNanos,
          usedPercent: usedUsdNanos / includedUsdNanos * 100,
          remainingUsdNanos: includedUsdNanos - usedUsdNanos,
        });
      };
      const emitted = new Set<string>();
      const modelsWithTotals = new Set<string>();
      for (const { model, bucket, usedUsdNanos } of totals.values()) {
        modelsWithTotals.add(model);
        emitted.add(totalKey(model, bucket));
        if (bucket !== null) {
          pushEstimate(model, bucket, usedUsdNanos);
          continue;
        }
        pushEstimate(model, null, usedUsdNanos);
      }
      // 有本地请求的 DeepSeek 模型按官方表格展示 Off-Peak / Peak 两档，未使用的一档计 0。
      for (const model of modelsWithTotals) {
        const price = baseline.models.get(model);
        if (price?.peakOffPeak === undefined) continue;
        for (const bucket of ["off-peak", "peak"] as const) {
          if (!emitted.has(totalKey(model, bucket))) {
            pushEstimate(model, bucket, 0);
          }
        }
      }
      return estimates.sort((left, right) =>
        right.usedUsdNanos! - left.usedUsdNanos!
        || left.model.localeCompare(right.model)
        || (left.bucket ?? "").localeCompare(right.bucket ?? ""));
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
