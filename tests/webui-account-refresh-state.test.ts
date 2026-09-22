import { describe, expect, it } from "vitest";
import {
  accountRefreshErrors,
  accountSnapshotIsStale,
  accountSnapshotsWithMissingProviders,
  accountSnapshotsAfterRefresh,
  accountSnapshotsWithoutRemoved,
  ccgAccountFromSnapshot,
  deepseekAccountFromSnapshot,
  refreshableAccounts,
  opencodeAccountFromSnapshot,
} from "../webui/src/lib/account-refresh-state.js";
import type { ManagementProvidersResponse, OfficialAccountSnapshotsResponse } from "../scripts/webui-api.js";

describe("WebUI per-account refresh state", () => {
  it("establishes the first snapshot from a successful refresh even when list reads fail", () => {
    const response = { observedAtMs: 123, warnings: [], snapshots: [{
      provider: "ocg-main", accountId: "main", displayName: "OCG", default: true,
      observedAtMs: 123, available: false, usage: { kind: "subscription-required" }, limits: null,
    }] };
    expect(accountSnapshotsAfterRefresh(null, ["ocg-main"], [{ status: "fulfilled", value: response }]))
      .toEqual(response);
    expect(accountSnapshotsAfterRefresh(null, ["ocg-main"], [{ status: "rejected", reason: new Error("offline") }]))
      .toBeNull();
  });
  it("accepts confirmed refresh payloads even when the following list read fails", () => {
    const old = { provider: "ocg-old", accountId: "old", displayName: "OCG", default: false,
      observedAtMs: 1, available: true, usage: { kind: "quota-windows", windows: [] }, limits: null };
    const response = { observedAtMs: 1, warnings: [], snapshots: [old] };
    const missing = { ...old, observedAtMs: 2, available: false, usage: { kind: "subscription-required" } };
    const refreshed = accountSnapshotsAfterRefresh(response, ["ocg-old"], [{ status: "fulfilled", value: { ...response, snapshots: [missing] } }]);
    expect(opencodeAccountFromSnapshot(refreshed.snapshots[0]!).subscriptionRequired).toBe(true);
    const failed = accountSnapshotsAfterRefresh(refreshed, ["ocg-old"], [{ status: "rejected", reason: new Error("timeout") }]);
    expect(failed.snapshots).toEqual([missing]);
    const recovered = accountSnapshotsAfterRefresh(failed, ["ocg-old"], [{ status: "fulfilled", value: response }]);
    expect(opencodeAccountFromSnapshot(recovered.snapshots[0]!).subscriptionRequired).toBe(false);
  });

  it("does not resurrect a confirmed deletion from old snapshots or missing-provider placeholders", () => {
    const response = { observedAtMs: 0, warnings: [], snapshots: [] };
    const stale = accountSnapshotsWithMissingProviders(response, [{ id: "ocg-old", displayName: "Old" }, { id: "deepseek", displayName: "DS" }]);
    expect(accountSnapshotsWithoutRemoved(stale, ["old"]).snapshots.map((item) => item.provider)).toEqual(["deepseek"]);
    expect(accountSnapshotsWithoutRemoved({ ...stale, snapshots: stale.snapshots.map((item) => ({ ...item, accountId: item.provider === "ocg-old" ? "old" : null })) }, ["old"]).snapshots.map((item) => item.provider)).toEqual(["deepseek"]);
  });
  it("keeps missing account identity null instead of turning a provider label into a deletion target", () => {
    const snapshot = {
      provider: "ocg-main", accountId: null, displayName: "OCG", default: false,
      observedAtMs: 1, available: true, usage: { windows: [{ resetsAt: 123 }] }, limits: null,
    };
    expect(opencodeAccountFromSnapshot(snapshot)).toMatchObject({ account: null, windows: [{ resetsAt: 123000 }] });
    expect(opencodeAccountFromSnapshot({ ...snapshot, accountId: "main" }).account).toBe("main");
  });
  it("keeps subscription facts in snapshots independently of refresh failures", () => {
    const snapshot = {
      provider: "ocg-old", accountId: "old", displayName: "OCG", default: false,
      observedAtMs: 123, available: false, usage: { kind: "subscription-required" }, limits: null,
    };
    expect(opencodeAccountFromSnapshot(snapshot)).toMatchObject({ subscriptionRequired: true, windows: [] });
    expect(accountRefreshErrors(["deepseek", "ocg-old", "ocg-other"], [
      { status: "fulfilled", value: {} },
      { status: "rejected", reason: new Error("网络超时") },
      { status: "rejected", reason: new Error("账户刷新失败") },
    ])).toEqual({
      deepseek: null,
      "ocg-old": { kind: "refresh-failed", message: "网络超时" },
      "ocg-other": { kind: "refresh-failed", message: "账户刷新失败" },
    });
    expect(accountRefreshErrors(["ocg-old"], [{ status: "fulfilled", value: {} }])).toEqual({ "ocg-old": null });
    expect(opencodeAccountFromSnapshot(snapshot).subscriptionRequired).toBe(true);
    expect(opencodeAccountFromSnapshot({ ...snapshot, available: true, usage: { kind: "quota-windows", windows: [] } }).subscriptionRequired).toBe(false);
  });

  it("keeps snapshots and adds missing configured accounts without fabricating usage", () => {
    const response: OfficialAccountSnapshotsResponse = { observedAtMs: 1, warnings: [], snapshots: [{
      provider: "deepseek", accountId: null, displayName: "DeepSeek", default: false,
      observedAtMs: 1, available: true, usage: { balances: [] }, limits: null,
    }] };
    const result = accountSnapshotsWithMissingProviders(response, [
      { id: "deepseek", displayName: "DeepSeek" }, { id: "ocg-new", displayName: "New" },
    ]);
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots[0]).toBe(response.snapshots[0]);
    expect(result.snapshots[1]).toMatchObject({ provider: "ocg-new", observedAtMs: 0, available: false, usage: null });
    expect(response.snapshots).toHaveLength(1);
  });

  it("distinguishes missing snapshots from stale snapshots", () => {
    expect(accountSnapshotIsStale(0, 1_000_000)).toBe(false);
    expect(accountSnapshotIsStale(100_000, 1_000_000)).toBe(false);
    expect(accountSnapshotIsStale(99_999, 1_000_000)).toBe(true);
  });

  it("refreshes all managed DS, OCG, and CCG accounts", () => {
    const providers = [
      { id: "openai", kind: "managed" }, { id: "deepseek", kind: "managed" },
      { id: "ds-work", kind: "managed" },
      { id: "ocg-one", kind: "managed" }, { id: "ocg-custom", kind: "custom" },
      { id: "ccg-main", kind: "managed" }, { id: "ccg-custom", kind: "custom" },
    ].map((provider) => ({ ...provider, displayName: provider.id }));
    expect(refreshableAccounts({ providers } as ManagementProvidersResponse).map((provider) => provider.id))
      .toEqual(["deepseek", "ds-work", "ocg-one", "ccg-main"]);
  });

  it("projects DS balances and CCG credits from account snapshots", () => {
    const base = {
      accountId: "main", displayName: "Account", default: true,
      observedAtMs: 123, available: true, limits: null,
    };
    expect(deepseekAccountFromSnapshot({
      ...base, provider: "ds-main",
      usage: { kind: "balance", balances: [{ currency: "USD", totalBalance: "2", grantedBalance: "1", toppedUpBalance: "1" }] },
    })).toMatchObject({ provider: "ds-main", account: "main", default: true, balances: [{ totalBalance: "2" }] });
    expect(ccgAccountFromSnapshot({
      ...base, provider: "ccg-main",
      usage: {
        kind: "credit-usage", planId: "individual-pro", monthlyRemaining: "4.00",
        purchasedRemaining: "2.00", freeRemaining: "1.00", totalRemaining: "7.00",
        windows: [{ windowId: "weekly", label: "7天", usedPercent: 25, resetsAt: 456, status: null }],
      },
    })).toMatchObject({
      provider: "ccg-main", totalRemaining: "7.00",
      windows: [{ windowId: "weekly", resetsAt: 456000 }],
    });
  });
});
