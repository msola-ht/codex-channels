import { afterEach, describe, expect, it, vi } from "vitest";

import { scheduleApiRefresh } from "../webui/src/lib/api-polling.js";

class Page extends EventTarget {
  visibilityState = "visible";
  change(state: string): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

afterEach(() => vi.useRealTimers());

describe("WebUI 自动刷新", () => {
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
