import { describe, expect, it, vi } from "vitest";

import {
  OfficialAccountSnapshotService,
  type OfficialAccountSnapshot,
  type OfficialAccountSnapshotQueryPort,
} from "../src/application/index.js";

describe("OfficialAccountSnapshotService", () => {
  it("只通过查询端口读取单个及全部最新快照", async () => {
    const snapshot: OfficialAccountSnapshot = {
      provider: "deepseek",
      accountId: null,
      observedAtMs: 1_700_000_000_000,
      available: true,
      usage: { kind: "balance", provider: "deepseek", available: true, balances: [] },
      limits: { kind: "unsupported", provider: "deepseek" },
    };
    const query: OfficialAccountSnapshotQueryPort = {
      latestOfficialAccountSnapshot: vi.fn(async () => snapshot),
      latestOfficialAccountSnapshots: vi.fn(async () => [snapshot]),
    };
    const service = new OfficialAccountSnapshotService(query);
    await expect(service.latest("deepseek")).resolves.toEqual(snapshot);
    await expect(service.latestAll()).resolves.toEqual([snapshot]);
    expect(query.latestOfficialAccountSnapshot).toHaveBeenCalledWith("deepseek", undefined);
  });
});
