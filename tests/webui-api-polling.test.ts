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
    const api = {
      ApiClientError: class extends Error {},
      fetchOfficialAccountSources: async () => ({ accounts: sources.map(provider => ({ provider, displayName: provider })), warnings: [] }),
      fetchOfficialAccountSnapshots: signal => new Promise((resolve, reject) => reads.push({ signal, resolve, reject })),
      refreshOfficialAccountSnapshot: async provider => {
        if (postResult) return postResult;
        if (provider === "openai") throw new Error("initial OpenAI failure");
        return old;
      },
    };
    const polling = { scheduleVisibleSettingsRefresh: () => () => {} };
    const state = load("webui/src/lib/account-refresh-state.ts", {});
    const useApi = load("webui/src/hooks/use-api.ts", { react, "@/lib/api": api, "../lib/api-polling": polling });
    const { useOfficialAccountSources } = load("webui/src/hooks/use-official-account-sources.ts", {
      react, "@/lib/api": api, "@/hooks/use-api": useApi,
      "@/lib/api-polling": polling, "@/lib/account-refresh-state": state,
    });
    globalThis.document = {};
    const render = () => {
      si = ri = ei = 0;
      const view = useOfficialAccountSources();
      while (effects.length) effects.shift()();
      return view;
    };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    render(); await settle();
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
  `;
  expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).not.toThrow();
});
