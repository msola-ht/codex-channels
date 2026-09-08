import { describe, expect, it, vi } from "vitest";

import {
  createRemoteQuotaSnapshotReader,
  readRemoteQuotaSummary,
  selectRemoteQuotaPeriod,
  selectRemoteQuotaPeriods,
  type CenterQuotaPeriod,
} from "../src/bootstrap/quota-center.js";

describe("quota center remote quota", () => {
  const nowMs = 1_900_000_000_000;
  const monthly: CenterQuotaPeriod = {
    provider: "ocg-lunare",
    windowId: "monthly",
    resetsAt: 1_950_000_000,
    deviceCount: 3,
    requestCount: 12,
    totalTokens: 1_200_000,
    totalCostNanos: 500_000_000,
    latestUsedPercentMillionths: null,
    estimatedTotalTokens: null,
    estimatedTotalCostNanos: null,
    lastObservedAtMs: nowMs - 60_000,
  };
  const weekly: CenterQuotaPeriod = {
    provider: "ocg-lunare",
    windowId: "weekly",
    resetsAt: 1_930_000_000,
    deviceCount: 2,
    requestCount: 7,
    totalTokens: 700_000,
    lastObservedAtMs: nowMs - 120_000,
  };
  const rolling: CenterQuotaPeriod = {
    provider: "ocg-lunare",
    windowId: "rolling",
    resetsAt: 1_920_000_000,
    deviceCount: 1,
    requestCount: 1,
    totalTokens: 11_000,
    lastObservedAtMs: nowMs - 180_000,
  };

  it("prefers the current OpenCode Go monthly period over shorter windows", () => {
    expect(selectRemoteQuotaPeriod(
      [rolling, weekly, monthly],
      "ocg-lunare",
      undefined,
      nowMs,
    )).toMatchObject({
      windowId: "monthly",
      deviceCount: 3,
      requestCount: 12,
      totalTokens: 1_200_000,
    });
  });

  it("keeps exact OpenAI codex window matching", () => {
    const codex: CenterQuotaPeriod = {
      provider: "openai",
      windowId: "codex",
      resetsAt: 1_930_000_000,
      deviceCount: 2,
      requestCount: 20,
      totalTokens: 900_000,
      lastObservedAtMs: nowMs - 60_000,
    };
    expect(selectRemoteQuotaPeriod([codex], "openai", codex.resetsAt, nowMs))
      .toMatchObject({ windowId: "codex", deviceCount: 2 });
  });

  it("does not select expired or unsupported center windows", () => {
    expect(selectRemoteQuotaPeriod([
      { ...monthly, resetsAt: 1_899_000_000 },
      { ...monthly, windowId: "unknown" },
    ], "ocg-lunare", undefined, nowMs)).toBeUndefined();
  });

  it("reads a multi-device OpenCode Go summary from the center", async () => {
    const response = {
      ok: true,
      json: async () => ({ periods: [weekly, monthly] }),
    } as unknown as Response;
    const fetchImpl = vi.fn(async () => response) as unknown as typeof fetch;
    const result = await readRemoteQuotaSummary({
      enabled: true,
      endpoint: "http://127.0.0.1:8790",
      token: "view-token",
    }, "ocg-lunare", undefined, undefined, fetchImpl);
    expect(result).toMatchObject({
      provider: "ocg-lunare",
      windowId: "monthly",
      deviceCount: 3,
      requestCount: 12,
      totalTokens: 1_200_000,
    });
    expect(result?.windows?.map((window) => window.windowId))
      .toEqual(["monthly", "weekly"]);
  });

  it("selects one current period for every OpenCode Go center window", () => {
    expect(selectRemoteQuotaPeriods(
      [rolling, weekly, monthly],
      "ocg-lunare",
      undefined,
      nowMs,
    ).map((period) => period.windowId)).toEqual(["monthly", "weekly", "rolling"]);
  });

  it("returns cached snapshots without waiting for a slow refresh", async () => {
    let resolveRead!: (value: ReturnType<typeof makeQuotaSummary>) => void;
    const read = vi.fn(() => new Promise<ReturnType<typeof makeQuotaSummary>>((resolve) => {
      resolveRead = resolve;
    }));
    const reader = createRemoteQuotaSnapshotReader(read, {
      ttlMs: 1_000,
      retryDelayMs: 10,
    });

    expect(reader("ocg-lunare", undefined)).toBeUndefined();
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(reader("ocg-lunare", undefined)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);

    const summary = makeQuotaSummary();
    resolveRead(summary);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reader("ocg-lunare", undefined)).toEqual(summary);
  });
});

function makeQuotaSummary() {
  return {
    provider: "ocg-lunare",
    windowId: "monthly",
    deviceCount: 1,
    requestCount: 2,
    totalTokens: 300,
    totalCostNanos: null,
    latestUsedPercentMillionths: null,
    estimatedTotalTokens: null,
    estimatedTotalCostNanos: null,
    tokensPerPercent: null,
    costPerPercentNanos: null,
    resetsAt: 1_950_000_000,
    observedAtMs: 1_900_000_000_000,
  } as const;
}
