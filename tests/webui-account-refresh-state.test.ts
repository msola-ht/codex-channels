import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginAccountRefreshAttempt, clearRecoveredAccountFailures, type AccountRefreshAttempts,
  openAiCreditsFromSnapshot,
  openAiWeeklyQuotaFromSnapshot,
  accountRefreshErrors,
  accountSnapshotIsStale,
  scheduleAccountSnapshotExpiry,
  accountSnapshotsWithMissingProviders,
  accountSnapshotsAfterRefresh,
  mergeAccountSnapshotLists,
  accountSnapshotsWithoutRemoved,
  ccgAccountFromSnapshot,
  deepseekAccountFromSnapshot,
  refreshableAccounts,
  refreshAccountSnapshots,
  remainingRemovedAccountProviders,
  quotaAccountFromSnapshot,
} from "../webui/src/lib/account-refresh-state.js";
import { estimateServerTime } from "../webui/src/lib/server-time.js";
import type { OfficialAccountSourcesResponse, OfficialAccountSnapshotsResponse } from "../scripts/webui-api.js";

describe("WebUI per-account refresh state", () => {
  it("clears only failures superseded by strictly newer observations", () => {
    const attempts: AccountRefreshAttempts = new Map();
    beginAccountRefreshAttempt(attempts, "clp-main", 500);
    attempts.get("clp-main")!.error = { kind: "refresh-failed", message: "failed" };
    const snapshot = (observedAtMs: number): OfficialAccountSnapshotsResponse => ({ observedAtMs, warnings: [], snapshots: [{
      provider: "clp-main", accountId: "main", displayName: "CLP", default: true, observedAtMs,
      available: true, usage: null, limits: null,
    }] });
    for (const time of [0, 499, 500]) expect(clearRecoveredAccountFailures(attempts, snapshot(time))).toEqual([]);
    expect(clearRecoveredAccountFailures(attempts, snapshot(501))).toEqual(["clp-main"]);
    expect(attempts.size).toBe(0);
    beginAccountRefreshAttempt(attempts, "clp-main");
    attempts.get("clp-main")!.error = { kind: "refresh-failed", message: "unknown baseline" };
    expect(clearRecoveredAccountFailures(attempts, snapshot(501))).toEqual([]);
  });

  it("bounds manual refresh failure metadata across navigation", () => {
    const attempts: AccountRefreshAttempts = new Map();
    beginAccountRefreshAttempt(attempts, "clp-main", 100);
    for (let i = 0; i < 300; i++) beginAccountRefreshAttempt(attempts, String(i), 100);
    expect(attempts.size).toBe(256);
    expect(attempts.has("clp-main")).toBe(false);
  });

  it("maps the isolated account source list without model configuration", () => {
    const accounts = ["openai", "clp-main", "ds-main"].map(provider => ({ provider, accountId: null, displayName: provider, default: false }));
    expect(refreshableAccounts({ accounts, warnings: [] })).toEqual(accounts.map(account => ({ id: account.provider, displayName: account.displayName })));
  });

  it("accepts a first single-account response and merges later accounts without replacing the list", () => {
    const response = (provider: string): OfficialAccountSnapshotsResponse => ({ observedAtMs: 100, warnings: [], snapshots: [{
      provider, accountId: "main", displayName: provider, default: false, observedAtMs: 100, available: true, usage: null, limits: null,
    }] });
    const first = accountSnapshotsAfterRefresh(null, ["clp-main"], [{ status: "fulfilled", value: response("clp-main") }]);
    const next = accountSnapshotsAfterRefresh(first, ["ds-main"], [{ status: "fulfilled", value: response("ds-main") }]);
    expect(next?.snapshots.map(snapshot => snapshot.provider)).toEqual(["clp-main", "ds-main"]);
    expect(accountSnapshotsAfterRefresh(next, ["clp-main"], [{ status: "rejected", reason: new Error("failed") }])).toEqual(next);
    expect(mergeAccountSnapshotLists(next, response("ds-main")).snapshots.map(snapshot => snapshot.provider)).toEqual(["ds-main"]);
  });

  it("keeps newer quota observations across late single-account and whole-list responses", () => {
    const snapshot = { provider: "openai", accountId: null, displayName: "OpenAI", default: false,
      observedAtMs: 2000, available: true, usage: null, limits: { usedPercent: 0 } };
    const current = { observedAtMs: 2000, snapshots: [snapshot], warnings: [] };
    const older = { ...current, observedAtMs: 1000, snapshots: [{ ...snapshot, observedAtMs: 1000, limits: { usedPercent: 80 } }] };
    expect(accountSnapshotsAfterRefresh(current, ["openai"], [{ status: "fulfilled", value: older }])).toEqual(current);
    expect(mergeAccountSnapshotLists(current, older)).toEqual(current);
    expect(mergeAccountSnapshotLists(current, { ...older, snapshots: [] }).snapshots).toEqual([]);
  });

  it("publishes completed accounts before slower queries and preserves individual failures", async () => {
    const response = { snapshots: [], warnings: [], observedAtMs: 0 };
    let finish!: (value: typeof response) => void;
    const slow = new Promise<typeof response>(resolve => { finish = resolve; });
    const receive = vi.fn();
    const refresh = refreshAccountSnapshots(["clp-slow", "ds-fast", "ccg-failed"], async provider => {
      if (provider === "clp-slow") return slow;
      if (provider === "ccg-failed") throw new Error("unavailable");
      return response;
    }, receive, new AbortController().signal);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    expect(receive).toHaveBeenCalledWith("ds-fast", { status: "fulfilled", value: response });
    expect(receive).toHaveBeenCalledWith("ccg-failed", { status: "rejected", reason: expect.any(Error) });
    finish(response);
    await refresh;
    expect(receive).toHaveBeenLastCalledWith("clp-slow", { status: "fulfilled", value: response });
  });

  it("bounds outgoing queries and drops late results and queued work after cancellation", async () => {
    const controller = new AbortController();
    const response = { snapshots: [], warnings: [], observedAtMs: 0 };
    let finish!: (value: typeof response) => void;
    const pending = new Promise<typeof response>(resolve => { finish = resolve; });
    const query = vi.fn(async () => pending);
    const receive = vi.fn();
    const refresh = refreshAccountSnapshots(Array.from({ length: 10 }, (_, i) => `clp-${i}`), query, receive, controller.signal);
    expect(query).toHaveBeenCalledTimes(4);
    controller.abort();
    finish(response);
    await refresh;
    expect(query).toHaveBeenCalledTimes(4);
    expect(receive).not.toHaveBeenCalled();
  });
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
    expect(quotaAccountFromSnapshot(refreshed.snapshots[0]!).subscriptionRequired).toBe(true);
    const failed = accountSnapshotsAfterRefresh(refreshed, ["ocg-old"], [{ status: "rejected", reason: new Error("timeout") }]);
    expect(failed.snapshots).toEqual([missing]);
    const recovered = accountSnapshotsAfterRefresh(failed, ["ocg-old"], [{ status: "fulfilled", value: { ...response, observedAtMs: 3, snapshots: [{ ...old, observedAtMs: 3 }] } }]);
    expect(quotaAccountFromSnapshot(recovered.snapshots[0]!).subscriptionRequired).toBe(false);
  });

  it("does not resurrect a confirmed deletion from old snapshots or missing-provider placeholders", () => {
    const response = { observedAtMs: 0, warnings: [], snapshots: [] };
    const stale = accountSnapshotsWithMissingProviders(response, [{ id: "ocg-old", displayName: "Old" }, { id: "deepseek", displayName: "DS" }]);
    expect(accountSnapshotsWithoutRemoved(stale, ["ocg-old"]).snapshots.map((item) => item.provider)).toEqual(["deepseek"]);
    expect(accountSnapshotsWithoutRemoved({ ...stale, snapshots: stale.snapshots.map((item) => ({ ...item, accountId: item.provider === "ocg-old" ? "old" : null })) }, ["ocg-old"]).snapshots.map((item) => item.provider)).toEqual(["deepseek"]);
  });
  it("removes only the exact provider when DS, OCG and CCG share an account id", () => {
    const response = { observedAtMs: 1, warnings: [], snapshots: ["ds-main", "ocg-main", "ccg-main"].map((provider) => ({
      provider, accountId: "main", displayName: provider, default: true,
      observedAtMs: 1, available: true, usage: null, limits: null,
    })) };
    expect(accountSnapshotsWithoutRemoved(response, ["ocg-main"]).snapshots.map((item) => item.provider))
      .toEqual(["ds-main", "ccg-main"]);
    const placeholders = accountSnapshotsWithMissingProviders({ ...response, snapshots: [] },
      response.snapshots.map((snapshot) => ({ id: snapshot.provider, displayName: snapshot.displayName })));
    expect(accountSnapshotsWithoutRemoved(placeholders, ["ocg-main"]).snapshots.map((item) => item.provider))
      .toEqual(["ds-main", "ccg-main"]);
    const confirmed = accountSnapshotsWithoutRemoved(response, ["ocg-main"]);
    const providers = confirmed.snapshots.map((snapshot) => ({ id: snapshot.provider, displayName: snapshot.displayName }));
    expect(remainingRemovedAccountProviders(confirmed, providers, ["ocg-main"])).toEqual([]);
    expect(remainingRemovedAccountProviders(response, providers, ["ocg-main"])).toEqual(["ocg-main"]);
    expect(remainingRemovedAccountProviders(confirmed, [...providers, { id: "ocg-main", displayName: "OCG" }], ["ocg-main"]))
      .toEqual(["ocg-main"]);
  });
  it("keeps missing account identity null instead of turning a provider label into a deletion target", () => {
    const snapshot = {
      provider: "ocg-main", accountId: null, displayName: "OCG", default: false,
      observedAtMs: 1, available: true, usage: { windows: [{ resetsAt: 123 }] }, limits: null,
    };
    expect(quotaAccountFromSnapshot(snapshot)).toMatchObject({ account: null, windows: [{ resetsAt: 123000 }] });
    expect(quotaAccountFromSnapshot({ ...snapshot, accountId: "main" }).account).toBe("main");
  });
  it("preserves an unknown Cline reset time without converting it to epoch zero", () => {
    const snapshot = { provider: "clp-main", accountId: "main", displayName: "Cline Pass main", default: true,
      observedAtMs: 123, available: true, usage: { windows: [{ windowId: "five-hour", usedPercent: 0, resetsAt: null }] }, limits: null };
    expect(quotaAccountFromSnapshot(snapshot)).toMatchObject({ windows: [{ usedPercent: 0, resetsAt: null }] });
  });
  it("keeps subscription facts in snapshots independently of refresh failures", () => {
    const snapshot = {
      provider: "ocg-old", accountId: "old", displayName: "OCG", default: false,
      observedAtMs: 123, available: false, usage: { kind: "subscription-required" }, limits: null,
    };
    expect(quotaAccountFromSnapshot(snapshot)).toMatchObject({ subscriptionRequired: true, windows: [] });
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
    expect(quotaAccountFromSnapshot(snapshot).subscriptionRequired).toBe(true);
    expect(quotaAccountFromSnapshot({ ...snapshot, available: true, usage: { kind: "quota-windows", windows: [] } }).subscriptionRequired).toBe(false);
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

it("includes CLP in refresh and maps official quota reset seconds to milliseconds", () => {
  const sources: OfficialAccountSourcesResponse = { accounts: [{ provider: "clp-test", accountId: "test", default: true, displayName: "CLP" }], warnings: [] };
  expect(refreshableAccounts(sources)).toEqual([{ id: "clp-test", displayName: "CLP" }]);
  const account = quotaAccountFromSnapshot({ provider: "clp-test", accountId: null, displayName: "CLP", default: false,
    observedAtMs: 1234, available: true, limits: null, usage: { kind: "quota-windows", windows: [
      { windowId: "five-hour", label: "5小时", usedPercent: 12.5, resetsAt: 1800000000, status: null },
    ] } });
  expect(account).toMatchObject({ available: true, subscriptionRequired: false, windows: [{ usedPercent: 12.5, resetsAt: 1800000000000 }] });
});


describe("WebUI account snapshot expiry scheduling", () => {
  afterEach(() => vi.useRealTimers());
  class Page extends EventTarget {
    visibilityState: DocumentVisibilityState = "visible";
    change(state: DocumentVisibilityState) {
      this.visibilityState = state;
      this.dispatchEvent(new Event("visibilitychange"));
    }
  }
  it("updates at expiry and cancels the timer and listener on cleanup", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const observedAtMs = Date.now();
    const page = new Page();
    const changes: boolean[] = [];
    const stop = scheduleAccountSnapshotExpiry(observedAtMs, () => changes.push(accountSnapshotIsStale(observedAtMs, Date.now())), page, Date.now);
    expect(changes).toEqual([false]);
    vi.advanceTimersByTime(15 * 60_000);
    expect(changes).toEqual([false]);
    vi.advanceTimersByTime(1);
    expect(changes).toEqual([false, true]);
    stop();
    page.change("visible");
    expect(changes).toEqual([false, true]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("checks immediately on becoming visible and replaces the old snapshot timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const page = new Page();
    const update = vi.fn();
    const old = Date.now();
    const stop = scheduleAccountSnapshotExpiry(old, update, page, Date.now);
    page.change("hidden");
    vi.advanceTimersByTime(16 * 60_000);
    expect(update).toHaveBeenCalledTimes(1);
    page.change("visible");
    expect(update).toHaveBeenCalledTimes(2);
    expect(accountSnapshotIsStale(old, Date.now())).toBe(true);
    stop();
    const stopNew = scheduleAccountSnapshotExpiry(Date.now(), update, page, Date.now);
    expect(vi.getTimerCount()).toBe(1);
    stopNew();
    vi.advanceTimersByTime(16 * 60_000);
    expect(update).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([20 * 60_000, -30 * 86_400_000])("expires on server time despite client clock skew of %i ms", (skew) => {
    vi.useFakeTimers();
    const serverNow = 1_800_000_000_000;
    vi.setSystemTime(serverNow + skew);
    const clock = { nowMs: serverNow, receivedAtMs: Date.now(), timeZone: "UTC" };
    const changes: boolean[] = [];
    const stop = scheduleAccountSnapshotExpiry(serverNow, (now) => changes.push(accountSnapshotIsStale(serverNow, now)), new Page(), () => estimateServerTime(clock));
    expect(changes).toEqual([false]);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    expect(changes).toEqual([false, true]);
    stop();
  });

  it("caps a future timestamp delay and does not spin when it exceeds the timer limit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const schedule = vi.spyOn(globalThis, "setTimeout");
    const update = vi.fn();
    const stop = scheduleAccountSnapshotExpiry(Date.now() + 30 * 86_400_000, update, new Page(), Date.now);
    expect(schedule).toHaveBeenLastCalledWith(expect.any(Function), 2_147_483_647);
    vi.advanceTimersByTime(60_000);
    expect(update).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    schedule.mockRestore();
  });

  it("does not schedule expiration for missing snapshots", () => {
    vi.useFakeTimers();
    const stop = scheduleAccountSnapshotExpiry(0, vi.fn(), new Page(), Date.now);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
});


describe("OpenAI credit snapshot presentation", () => {
  const snapshot = { provider: "openai", accountId: null, displayName: "OpenAI", default: true,
    observedAtMs: 1000, available: true, usage: null, limits: { kind: "rate-limits", provider: "openai", limits: {
      ordinaryUsageLimit: { credits: { balance: "0", unlimited: false } },
      resetCreditsAvailable: 5, resetCreditExpiresAt: [2000, null, 1000, 1000],
    } } };
  it("preserves zero, groups exact expiry dates, and counts undisclosed vouchers", () => {
    expect(openAiCreditsFromSnapshot(snapshot)).toEqual({ observedAtMs: 1000, remaining: "0", unlimited: false, subscription: null,
      resetCreditsAvailable: "5", expirations: [{ expiresAt: 1000, count: 2 }, { expiresAt: 2000, count: 1 }, { expiresAt: null, count: 1 }], undisclosedCount: "1" });
  });
  it("passes through subscription dates separately from quota observation time", () => {
    const subscription = { activeUntil: 2000, lastChecked: 500 };
    expect(openAiCreditsFromSnapshot({ ...snapshot, subscription })).toMatchObject({ observedAtMs: 1000, subscription });
  });
  it("distinguishes missing details from no expiry and preserves large serialized counts", () => {
    const limits = { ...snapshot.limits.limits, resetCreditsAvailable: "9007199254740993", resetCreditExpiresAt: null };
    expect(openAiCreditsFromSnapshot({ ...snapshot, limits: { ...snapshot.limits, limits } })).toMatchObject({
      resetCreditsAvailable: "9007199254740993", expirations: null, undisclosedCount: "9007199254740993",
    });
    expect(openAiCreditsFromSnapshot({ ...snapshot, limits: { kind: "rate-limits", provider: "openai", limits: {} } })).toMatchObject({
      remaining: null, resetCreditsAvailable: null, expirations: null,
    });
    expect(openAiCreditsFromSnapshot(undefined)).toBeNull();
    expect(openAiCreditsFromSnapshot({ ...snapshot, provider: "deepseek" })).toBeNull();
    expect(openAiCreditsFromSnapshot({ ...snapshot, limits: null })).toBeNull();
  });
});

describe("OpenAI current weekly quota snapshot", () => {
  const snapshot = (ordinaryUsageLimit: unknown) => ({ provider: "openai", accountId: null, displayName: "OpenAI", default: true,
    observedAtMs: 2000, available: true, usage: null, limits: { kind: "rate-limits", provider: "openai", limits: { ordinaryUsageLimit } } });
  it.each(["primary", "secondary"])("reads the explicit weekly %s window including zero", slot => {
    expect(openAiWeeklyQuotaFromSnapshot(snapshot({ planType: "pro", [slot]: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 4000 } })))
      .toEqual({ usedPercent: 0, resetsAt: 4_000_000, planType: "pro" });
  });
  it("does not treat other or absent windows as a weekly quota", () => {
    expect(openAiWeeklyQuotaFromSnapshot(snapshot({ planType: "pro", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 2000 } })))
      .toEqual({ usedPercent: null, resetsAt: null, planType: "pro" });
    expect(openAiWeeklyQuotaFromSnapshot(undefined)).toBeNull();
    expect(openAiWeeklyQuotaFromSnapshot({ ...snapshot(null), provider: "deepseek" })).toBeNull();
    expect(openAiWeeklyQuotaFromSnapshot(snapshot(null))).toBeNull();
  });
  it("does not render invalid percent or timestamps", () => {
    expect(openAiWeeklyQuotaFromSnapshot(snapshot({ secondary: { usedPercent: NaN, windowDurationMins: 10080, resetsAt: 9e15 } })))
      .toEqual({ usedPercent: null, resetsAt: null, planType: null });
  });
});
