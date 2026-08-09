import { describe, expect, it } from "vitest";

import { parseIngestPayload } from "../cloudflare/worker/src/payload.js";

describe("Cloudflare ingest payload validation", () => {
  it("accepts a valid payload", () => {
    const parsed = parseIngestPayload({
      deviceId: "device-a",
      deviceName: "main-server",
      requestMetrics: [requestRow(1)],
      subagentThreads: [subagentRow("sub-1")],
    });

    expect(parsed.ok).toBe(true);
    expect(parsed).toMatchObject({
      deviceId: "device-a",
      deviceName: "main-server",
    });
  });

  it("accepts a missing or blank device name and rejects oversized names", () => {
    const withoutName = parseIngestPayload({
      deviceId: "device-a",
      requestMetrics: [],
      subagentThreads: [],
    });
    expect(withoutName.ok).toBe(true);

    const blank = parseIngestPayload({
      deviceId: "device-a",
      deviceName: "   ",
      requestMetrics: [],
      subagentThreads: [],
    });
    expect(blank.ok).toBe(true);
    if (!blank.ok) throw new Error("空白设备名应通过校验");
    expect(blank.deviceName).toBeUndefined();

    const oversized = parseIngestPayload({
      deviceId: "device-a",
      deviceName: "x".repeat(129),
      requestMetrics: [],
      subagentThreads: [],
    });
    expect(oversized.ok).toBe(false);
    if (oversized.ok) throw new Error("超长设备名不应通过校验");
    expect(oversized.error).toContain("deviceName");
  });

  it("rejects invalid device ids", () => {
    for (const deviceId of ["", "-bad", "UPPER", "a".repeat(65), "bad id"]) {
      const parsed = parseIngestPayload({
        deviceId,
        requestMetrics: [],
        subagentThreads: [],
      });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("无效 deviceId 不应通过校验");
      expect(parsed.error).toContain("deviceId");
    }
  });

  it("rejects non-array metric collections", () => {
    const parsed = parseIngestPayload({
      deviceId: "device-a",
      requestMetrics: {},
      subagentThreads: [],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("非数组集合不应通过校验");
    expect(parsed.error).toContain("数组");
  });

  it("rejects oversized request batches", () => {
    const parsed = parseIngestPayload({
      deviceId: "device-a",
      requestMetrics: Array.from({ length: 501 }, (_, index) => requestRow(index + 1)),
      subagentThreads: [],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("超大批次不应通过校验");
    expect(parsed.error).toContain("最多");
  });

  it("rejects malformed request rows", () => {
    const cases = [
      { ...requestRow(1), localId: 0 },
      { ...requestRow(1), provider: "" },
      { ...requestRow(1), recordedAtMs: -1 },
      { ...requestRow(1), localId: 1.5 },
      null,
    ];
    for (const row of cases) {
      const parsed = parseIngestPayload({
        deviceId: "device-a",
        requestMetrics: [row],
        subagentThreads: [],
      });
      expect(parsed.ok).toBe(false);
    }
  });

  it("rejects malformed subagent rows", () => {
    const cases = [
      { ...subagentRow("sub-1"), threadId: "" },
      { ...subagentRow("sub-1"), threadId: "x".repeat(129) },
      { ...subagentRow("sub-1"), recordedAtMs: 0 },
      { ...subagentRow("sub-1"), parentThreadId: 42 },
      null,
    ];
    for (const row of cases) {
      const parsed = parseIngestPayload({
        deviceId: "device-a",
        requestMetrics: [],
        subagentThreads: [row],
      });
      expect(parsed.ok).toBe(false);
    }
  });
});

function requestRow(localId: number) {
  return {
    localId,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    status: "completed",
    inputTokens: 1_000,
    cachedInputTokens: 900,
    outputTokens: 100,
    totalTokens: 1_100,
    recordedAtMs: 1_785_640_800_000,
    totalCostNanos: 6_000,
    pricing: { currency: "USD" },
  };
}

function subagentRow(threadId: string) {
  return {
    threadId,
    parentThreadId: "main-1",
    agentPath: "/root/ds_probe",
    recordedAtMs: 1_785_640_800_000,
  };
}
