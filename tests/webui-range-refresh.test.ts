import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { nextCalendarDay, rangeRefreshAt, scheduleRangeRefresh } from "../webui/src/lib/range-refresh.js";

afterEach(() => vi.useRealTimers());

it("gates reads while loading, failed or on history, and converts server deadlines to client time", () => {
  execFileSync(process.execPath, ["--input-type=module", "-e", String.raw`
    import fs from 'node:fs'; import ts from 'typescript'; import assert from 'node:assert/strict';
    let clock={nowMs:6000,receivedAtMs:1000,timeZone:'UTC'}, due, captured, calls=0;
    const code=ts.transpileModule(fs.readFileSync('webui/src/hooks/use-range-refresh.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
    const imports={react:{useContext:()=>clock,useEffect:fn=>fn()},'@/hooks/use-server-time':{},'@/lib/range-refresh':{
      rangeRefreshAt:(query,now,zone,overview)=>{captured={query,now,zone,overview};return now+300000;},
      scheduleRangeRefresh:(_refresh,value)=>{calls++;due=value;}
    }};
    globalThis.document={};globalThis.window={};Object.defineProperty(globalThis,'navigator',{value:{},configurable:true});
    const output={};new Function('require','exports',code)(id=>imports[id],output);
    const run=(time,blocked)=>output.useRangeRefresh({range:'7d'},()=>{},time,blocked,true);
    run(null,false);run(1000,true);assert.equal(calls,0);
    run(1000,false);assert.equal(calls,1);assert.equal(captured.now,6000);assert.equal(captured.overview,true);assert.equal(due,301000);
    clock=null;run(1000,false);assert.equal(calls,1);
  `], { encoding: "utf8" });
});

it("uses server calendar boundaries across spring and autumn DST changes", () => {
  expect(nextCalendarDay(Date.parse("2026-03-08T08:00:00Z"), "America/Los_Angeles")).toBe(Date.parse("2026-03-09T07:00:00Z"));
  expect(nextCalendarDay(Date.parse("2026-11-01T07:00:00Z"), "America/Los_Angeles")).toBe(Date.parse("2026-11-02T08:00:00Z"));
  const now = Date.parse("2026-10-03T15:59:00Z");
  expect(rangeRefreshAt({ range: "today" }, now, "Asia/Shanghai")).toBe(now + 60_000);
  expect(rangeRefreshAt({ range: "yesterday" }, now, "Asia/Shanghai")).toBe(now + 60_000);
  for (const range of ["24h", "7d", "30d", "90d"] as const) {
    expect(rangeRefreshAt({ range }, now, "Asia/Shanghai")).toBe(now + 300_000);
  }
  expect(rangeRefreshAt({ range: "all" }, now, "Asia/Shanghai")).toBeNull();
  expect(rangeRefreshAt({ from: "2026-01-01", to: "2026-01-02" }, now, "Asia/Shanghai")).toBeNull();
  expect(rangeRefreshAt({ range: "all" }, now, "Asia/Shanghai", true)).toBe(now + 60_000);
});

it("pauses hidden/offline deadlines, catches up once, and cancels on cleanup", () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const events = new EventTarget(), network = { onLine: true }, refresh = vi.fn();
  const stop = scheduleRangeRefresh(refresh, 2000, page, network, events);
  page.visibilityState = "hidden"; page.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(10_000); expect(refresh).not.toHaveBeenCalled();
  network.onLine = false; page.visibilityState = "visible"; page.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(10_000); expect(refresh).not.toHaveBeenCalled();
  network.onLine = true; events.dispatchEvent(new Event("online"));
  vi.advanceTimersByTime(250); expect(refresh).toHaveBeenCalledTimes(1);
  events.dispatchEvent(new Event("online")); vi.advanceTimersByTime(300_000);
  expect(refresh).toHaveBeenCalledTimes(1); stop();
  const cancel = scheduleRangeRefresh(refresh, Date.now() + 1000, page, network, events);
  cancel(); vi.advanceTimersByTime(1000); expect(refresh).toHaveBeenCalledTimes(1);
});

it("catches up after a successful request straddles midnight instead of waiting another day", () => {
  vi.useFakeTimers();
  const started = Date.parse("2026-10-03T23:59:59Z");
  const completed = Date.parse("2026-10-04T00:00:02Z");
  vi.setSystemTime(completed);
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const events = new EventTarget(), refresh = vi.fn();
  const due = rangeRefreshAt({ range: "today" }, started, "UTC")!;
  expect(due).toBeLessThan(completed);
  const cancel = scheduleRangeRefresh(refresh, due, page, { onLine: true }, events);
  vi.advanceTimersByTime(250); expect(refresh).toHaveBeenCalledTimes(1); cancel();
});
