import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scheduleApiRefresh, scheduleVisibleSettingsRefresh, settledTaskIds } from "../webui/src/lib/api-polling.js";

class Page extends EventTarget {
  visibilityState = "visible";
  change(state: string): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

afterEach(() => vi.useRealTimers());

describe("WebUI 自动刷新", () => {
  it("supports a slower queue interval without changing the default interval", () => {
    vi.useFakeTimers();
    const page = new Page();
    const refresh = vi.fn();
    const stop = scheduleApiRefresh(refresh, false, true, page, 10_000);
    vi.advanceTimersByTime(9_999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });
  it("waits for a slow request to finish before scheduling the next refresh", () => {
    vi.useFakeTimers();
    const page = new Page();
    const refresh = vi.fn();
    const stopLoading = scheduleApiRefresh(refresh, true, true, page);
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();
    stopLoading();
    const stop = scheduleApiRefresh(refresh, false, true, page);
    vi.advanceTimersByTime(1_999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("pauses while hidden and removes timers and visibility listeners on cleanup", () => {
    vi.useFakeTimers();
    const page = new Page();
    const refresh = vi.fn();
    const stop = scheduleApiRefresh(refresh, false, true, page);
    vi.advanceTimersByTime(1_000);
    page.change("hidden");
    vi.advanceTimersByTime(5_000);
    expect(refresh).not.toHaveBeenCalled();
    page.change("visible");
    vi.advanceTimersByTime(2_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
    page.change("visible");
    vi.advanceTimersByTime(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh once the management task is no longer active", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const page = new Page();
    const stop = scheduleApiRefresh(refresh, false, false, page);
    page.change("visible");
    vi.advanceTimersByTime(10_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });
});

describe("WebUI 管理任务终态关联刷新", () => {
  it("ignores historical terminal tasks on first load", () => {
    expect(settledTaskIds(null, [{ id: "history", state: "completed" }])).toEqual([]);
  });
  it("refreshes even when a task completes before the first post-submit poll", () => {
    expect(settledTaskIds(new Map(), [{ id: "quick", state: "completed" }])).toEqual(["quick"]);
  });
  it.each(["completed", "failed", "cancelled"])("refreshes affected resources after %s exactly once", (state) => {
    expect(settledTaskIds(new Map([["task", "running"]]), [{ id: "task", state }])).toEqual(["task"]);
    expect(settledTaskIds(new Map([["task", state]]), [{ id: "task", state }])).toEqual([]);
  });
  it("does not refresh for queued or running tasks", () => {
    expect(settledTaskIds(new Map(), [{ id: "task", state: "running" }])).toEqual([]);
  });
});

it("invalidates failed live snapshots through retries while preserving the default cache policy", () => {
  const script = String.raw`
    import fs from "node:fs";
    import ts from "typescript";
    import assert from "node:assert/strict";
    const source = fs.readFileSync("webui/src/hooks/use-api.ts", "utf8")
      .replace(/^import .*$/gm, "").replace(/export (function|interface)/g, "$1");
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
    for (const retainDataOnError of [false, true]) {
      const slots = [], refs = [];
      let si = 0, ri = 0, previousDeps, effect, cleanup;
      const useState = initial => {
        const index = si++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
      };
      const useRef = initial => refs[ri++] ?? (refs[ri - 1] = { current: initial });
      const useEffect = (run, deps) => {
        if (!previousDeps || deps.some((value, index) => value !== previousDeps[index])) effect = run;
        previousDeps = deps;
      };
      const hook = new Function("useState", "useRef", "useEffect", "useCallback", "ApiClientError", code + ";return useApi;")(
        useState, useRef, useEffect, fn => fn, class extends Error {});
      const pending = [];
      const loader = signal => new Promise((resolve, reject) => pending.push({ signal, resolve, reject }));
      let mergeData;
      const render = () => {
        si = ri = 0;
        const result = hook(loader, [], { retainDataOnError, mergeData });
        if (effect) { cleanup?.(); cleanup = effect(); effect = undefined; }
        return result;
      };
      const settle = () => new Promise(resolve => setImmediate(resolve));
      render(); pending[0].resolve({ requests: ["old"] }); await settle();
      let view = render(); assert.deepEqual(view.data, { requests: ["old"] });
      view.refetch(); render(); pending[1].reject(new Error("unavailable")); await settle();
      view = render(); assert.ok(view.error);
      const expected = retainDataOnError ? { requests: ["old"] } : null;
      assert.deepEqual(view.data, expected);
      view.refetch(); view = render();
      assert.equal(view.loading, true); assert.equal(view.error, null); assert.deepEqual(view.data, expected);
      pending[2].resolve({ requests: ["new"] }); await settle();
      view = render(); assert.deepEqual(view.data, { requests: ["new"] });
      view.refetch(); render(); cleanup();
      assert.equal(pending[3].signal.aborted, true);
      pending[3].resolve({ requests: ["late"] }); await settle();
      assert.deepEqual(render().data, { requests: ["new"] });
      mergeData = (previous, next) => previous?.revision > next.revision ? previous : next;
      render(); pending.at(-1).resolve({ revision: 2, requests: ["fresh"] }); await settle();
      view = render(); view.refetch(); render();
      pending.at(-1).resolve({ revision: 1, requests: ["stale read"] }); await settle();
      view = render(); assert.deepEqual(view.data, { revision: 2, requests: ["fresh"] });
      view.replaceData({ revision: 0, requests: ["stale replacement"] });
      view = render(); assert.deepEqual(view.data, { revision: 2, requests: ["fresh"] });
      view.replaceData(previous => ({ ...previous, requests: [...previous.requests, "functional update"] }));
      assert.deepEqual(render().data, { revision: 2, requests: ["fresh", "functional update"] });
      cleanup();
    }
  `;
  expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).not.toThrow();
});


describe("设置页面恢复补查", () => {
  it("retains busy events through the throttle and coalesces them into one refresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const page = new Page();
    const refresh = vi.fn();
    const state = { pending: false, lastRefresh: 0 };
    let stop = scheduleVisibleSettingsRefresh(refresh, false, page, state);
    page.change("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
    stop = scheduleVisibleSettingsRefresh(refresh, true, page, state);
    vi.advanceTimersByTime(1_000);
    page.change("hidden");
    page.change("visible");
    expect(state.pending).toBe(true);
    stop();
    stop = scheduleVisibleSettingsRefresh(refresh, false, page, state);
    page.change("visible");
    vi.advanceTimersByTime(3_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(state.pending).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it("cancels delayed work while hidden or unmounted and resumes only when visible", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const page = new Page();
    const refresh = vi.fn();
    const state = { pending: true, lastRefresh: 10_000 };
    const stop = scheduleVisibleSettingsRefresh(refresh, false, page, state);
    page.change("hidden");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(6_000);
    expect(refresh).not.toHaveBeenCalled();
    page.change("visible");
    expect(refresh).toHaveBeenCalledTimes(1);
    page.change("visible");
    expect(vi.getTimerCount()).toBe(1);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    page.change("visible");
    vi.advanceTimersByTime(6_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not repeat pending work already satisfied by a manual refresh", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const page = new Page();
    const refresh = vi.fn();
    const state = { pending: true, lastRefresh: 10_000 };
    const stop = scheduleVisibleSettingsRefresh(refresh, false, page, state);
    state.pending = false;
    state.lastRefresh = Date.now();
    vi.advanceTimersByTime(6_000);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });
});

it("cancels superseded batch snapshot reads without losing new accounts or retaining deleted accounts", () => {
  const script = String.raw`
    import fs from "node:fs";
    import ts from "typescript";
    import assert from "node:assert/strict";
    const slots = [], refs = [], dependencies = [], cleanups = [];
    let si = 0, ri = 0, ei = 0;
    const effects = [];
    const react = {
      useState(initial) {
        const index = si++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
      },
      useRef(initial) { return refs[ri++] ?? (refs[ri - 1] = { current: initial }); },
      useCallback(fn) { return fn; },
      useEffect(run, deps) {
        const index = ei++;
        if (!dependencies[index] || deps.some((value, i) => value !== dependencies[index][i])) {
          effects.push(() => { cleanups[index]?.(); cleanups[index] = run(); });
        }
        dependencies[index] = deps;
      },
    };
    const load = (path, imports) => {
      const code = ts.transpileModule(fs.readFileSync(path, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      }).outputText;
      const exports = {};
      new Function("exports", "require", code)(exports, name => {
        assert.ok(name in imports, name);
        return imports[name];
      });
      return exports;
    };
    const reads = [];
    const cline = { provider: "clp-test", accountId: "test", displayName: "CLP", default: false,
      observedAtMs: 1000, available: true, usage: null, limits: null };
    const old = { observedAtMs: 1000, snapshots: [cline], warnings: [] };
    const openai = { ...cline, provider: "openai", accountId: null, observedAtMs: 2000,
      limits: { kind: "rate-limits", provider: "openai", limits: {
        ordinaryUsageLimit: { secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: null } },
      } } };
    const fresh = { ...old, observedAtMs: 2000, snapshots: [cline, openai] };
    let sources = ["clp-test", "openai"], postResult = null;
    const posts = [];
    let sourceFailure = false, sourcePending = null, postPending = null;
    const api = {
      ApiClientError: class extends Error {},
      fetchOfficialAccountSources: async signal => { if (sourcePending) { sourcePending.signal = signal; return sourcePending.promise; } if (sourceFailure) throw new Error("sources unavailable"); return { accounts: sources.map(provider => ({ provider, displayName: provider })), warnings: [] }; },
      fetchOfficialAccountSnapshots: signal => new Promise((resolve, reject) => reads.push({ signal, resolve, reject })),
      refreshOfficialAccountSnapshot: async (provider, signal) => {
        posts.push(provider);
        if (postPending) { postPending.calls.push({ provider, signal }); return postPending.promise; }
        if (postResult) return postResult;
        if (provider === "openai") throw new Error("initial OpenAI failure");
        return old;
      },
    };
    let visibleRefresh;
    const polling = { scheduleVisibleSettingsRefresh: callback => { visibleRefresh = callback; return () => {}; } };
    const state = load("webui/src/lib/account-refresh-state.ts", {});
    const useApi = load("webui/src/hooks/use-api.ts", { react, "@/lib/api": api, "../lib/api-polling": polling });
    const { useOfficialAccountSources } = load("webui/src/hooks/use-official-account-sources.ts", {
      react, "@/lib/api": api, "@/hooks/use-api": useApi,
      "@/lib/api-polling": polling, "@/lib/account-refresh-state": state,
      "@/hooks/use-server-time": { useServerTimeSnapshot: () => ({ nowMs: 10_000_000, receivedAtMs: Date.now() }) },
      "@/lib/server-time": { estimateServerTime: snapshot => snapshot.nowMs },
    });
    globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
    const attempts = new Map();
    const render = () => {
      si = ri = ei = 0;
      const view = useOfficialAccountSources(attempts);
      while (effects.length) effects.shift()();
      return view;
    };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    render(); await settle();
    assert.equal(reads.length, 1);
    reads[0].resolve(old); await settle(); render(); await settle();
    assert.equal(reads.length, 2);
    let view = render();
    view.refetchSnapshots(); render();
    assert.equal(reads[1].signal.aborted, true);
    reads[2].resolve(fresh); await settle();
    assert.equal(render().data.openaiWeeklyQuota.usedPercent, 12);
    // 模拟不配合取消的迟到响应，仍不能清除独立读取新增的账户。
    reads[1].resolve(old); await settle();
    view = render();
    assert.equal(view.data.openaiWeeklyQuota.usedPercent, 12);
    assert.equal(view.refreshError, null);
    assert.equal(view.refreshing, false);
    // 新的权威整表仍能删除账户，不能把旧账户永久并入列表。
    sources = ["openai"];
    postResult = { ...fresh, snapshots: [openai] };
    const removal = view.refresh(); await settle();
    reads.at(-1).resolve(postResult); await removal;
    view = render();
    assert.deepEqual(view.data.clinePass, []);
    assert.equal(view.data.openaiWeeklyQuota.usedPercent, 12);
    // 被替代的读取不报错；新的独立读取失败仍应显示错误并保留额度。
    const retry = view.refresh(); await settle();
    const superseded = reads.at(-1);
    render().refetchSnapshots(); render();
    assert.equal(superseded.signal.aborted, true);
    reads.at(-1).reject(new Error("independent sync failed"));
    superseded.reject(new Error("cancelled old sync"));
    await retry; await settle();
    view = render();
    assert.equal(view.error, "independent sync failed");
    assert.equal(view.refreshError, null);
    assert.equal(view.data.openaiWeeklyQuota.usedPercent, 12);
    const unmount = view.refresh(); await settle();
    const pendingSync = reads.at(-1);
    for (const cleanup of cleanups) cleanup?.();
    assert.equal(pendingSync.signal.aborted, true);
    pendingSync.resolve(old); await unmount;
    const remount = async baseline => {
      for (const cleanup of cleanups) cleanup?.();
      slots.length = refs.length = dependencies.length = cleanups.length = reads.length = posts.length = 0;
      render(); await settle();
      if (baseline instanceof Error) reads[0].reject(baseline); else reads[0].resolve(baseline);
      await settle(); render(); await settle();
      return render();
    };
    // Fresh snapshots skip all POSTs and the redundant trailing GET.
    sources = ["clp-test"];
    attempts.clear();
    const recent = { ...old, snapshots: [{ ...cline, observedAtMs: 10_000_000 }] };
    view = await remount(recent);
    assert.deepEqual(posts, []);
    assert.equal(reads.length, 1);
    // Manual single-account refresh bypasses freshness and a failing source list.
    sourceFailure = true;
    postResult = recent;
    const manual = view.refresh("clp-test"); await settle();
    assert.deepEqual(posts, ["clp-test"]);
    reads.at(-1).resolve(recent); await manual;
    sourceFailure = false;
    // Missing/stale OpenAI fails; remount retains the cooldown and error.
    sources = ["openai"];
    postResult = null;
    view = await remount(old);
    assert.deepEqual(posts, ["openai"]);
    reads.at(-1).resolve(old); await settle(); render();
    view = await remount(old);
    assert.deepEqual(posts, []);
    assert.ok(view.refreshControls.openai.error);
    // Explicit retry bypasses that cooldown without needing sources.
    const retryAccount = view.refresh("openai"); await settle();
    assert.deepEqual(posts, ["openai"]);
    reads.at(-1).resolve(old); await retryAccount;
    // Restoring visibility reads a baseline; hiding cancels it before any POST.
    attempts.clear(); render();
    visibleRefresh(); await settle();
    const hiddenRead = reads.at(-1);
    document.visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(hiddenRead.signal.aborted, true);
    const count = posts.length;
    hiddenRead.resolve(old); await settle();
    assert.equal(posts.length, count);
    document.visibilityState = "visible";
    attempts.clear();
    view = await remount(new Error("snapshot database unavailable"));
    assert.deepEqual(posts, ["openai"]);
    reads.at(-1).resolve(old); await settle(); render();

    // A new independent sync owns reads and cancels automatic preflight too.
    sources = ["clp-test", "openai"];
    attempts.clear();
    const allRecent = { ...recent, snapshots: [...recent.snapshots, { ...openai, observedAtMs: 10_000_000 }] };
    view = await remount(allRecent);
    visibleRefresh(); await settle();
    const preflight = reads.at(-1);
    render().refetchSnapshots(); render();
    const independent = reads.at(-1);
    assert.equal(preflight.signal.aborted, true);
    independent.resolve(allRecent); await settle();
    preflight.resolve(recent); await settle();
    assert.equal(independent.signal.aborted, false);
    assert.equal(render().data.openaiWeeklyQuota.usedPercent, 12);
    assert.deepEqual(posts, []);
    // The superseded preflight may resolve or reject before the new read finishes.
    for (const rejectOld of [false, true]) {
      render(); visibleRefresh(); await settle();
      const oldRead = reads.at(-1);
      render().refetchSnapshots(); render();
      const latestRead = reads.at(-1);
      if (rejectOld) oldRead.reject(new Error("old preflight cancelled")); else oldRead.resolve(recent);
      await settle(); render();
      assert.equal(latestRead.signal.aborted, false);
      assert.equal(render().refreshError, null);
      assert.equal(render().loading, true);
      latestRead.resolve(allRecent); await settle(); render();
      assert.equal(render().data.openaiWeeklyQuota.usedPercent, 12);
      assert.deepEqual(posts, []);
    }
    // A stale failed account later gets a newer successful observation elsewhere.
    attempts.clear(); sources = ["openai"]; postResult = null;
    view = await remount(old);
    reads.at(-1).resolve(old); await settle(); render();
    assert.deepEqual(posts, ["openai"]);
    view = await remount(allRecent);
    assert.equal(view.refreshControls.openai.error, null);
    assert.deepEqual(posts, []);
    // A failure against this same fresh snapshot must remain visible.
    const sameSnapshotFailure = view.refresh("openai"); await settle();
    reads.at(-1).resolve(allRecent); await sameSnapshotFailure; render();
    view = await remount(allRecent);
    assert.ok(view.refreshControls.openai.error);
    assert.deepEqual(posts, []);
    // Independent synchronization can also clear that error without navigation.
    view.refetchSnapshots(); render();
    reads.at(-1).resolve({ ...allRecent, snapshots: allRecent.snapshots.map(item => ({ ...item, observedAtMs: 10_000_001 })) });
    await settle(); render(); view = render();
    assert.equal(view.refreshControls.openai.error, null);

    // Cancel even before preflight starts; a delayed source response cannot start reads.
    let finishSources;
    sourcePending = { promise: new Promise(resolve => { finishSources = resolve; }) };
    render(); visibleRefresh(); await settle();
    render().refetchSnapshots(); render();
    const sourceRead = reads.at(-1), readCount = reads.length;
    assert.equal(sourcePending.signal.aborted, true);
    sourceRead.resolve(allRecent); await settle();
    finishSources({ accounts: [{ provider: "clp-test", displayName: "CLP" }], warnings: [] });
    await settle(); render();
    assert.equal(reads.length, readCount);
    sourcePending = null;
    // Cancel in-flight queries and never start the fifth queued account.
    let finishPosts;
    postPending = { calls: [], promise: new Promise(resolve => { finishPosts = resolve; }) };
    sources = ["clp-one", "clp-two", "clp-three", "clp-four", "clp-five"];
    posts.length = 0;
    const batch = render().refresh(); await settle();
    assert.equal(posts.length, 4);
    render().refetchSnapshots(); render();
    const newRead = reads.at(-1);
    assert.ok(postPending.calls.every(call => call.signal.aborted));
    newRead.resolve(allRecent); await settle();
    finishPosts(old); await batch; render();
    assert.equal(posts.length, 4);
    assert.equal(newRead.signal.aborted, false);
    assert.equal(render().data.openaiWeeklyQuota.usedPercent, 12);
    assert.equal(render().refreshError, null);
    postPending = null;
    for (const cleanup of cleanups) cleanup?.();

  `;
  expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).not.toThrow();
});
