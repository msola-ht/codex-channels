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
      const render = () => {
        si = ri = 0;
        const result = hook(loader, [], retainDataOnError ? undefined : { retainDataOnError });
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
