import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      postMessage = vi.fn();
      unref = vi.fn();
      terminate = vi.fn(async () => { this.emit("exit", 1); return 1; });
    },
  };
});
import { CompletionMetricsReader } from "../src/observability/completion-metrics-reader.js";

afterEach(() => vi.useRealTimers());

describe("completion metrics deadlines", () => {
  it("cancels all pending reads at the deadline and permits a fresh worker only after cooldown", async () => {
    vi.useFakeTimers();
    const reader = new CompletionMetricsReader("unused");
    try {
      const pending = Promise.allSettled([
        reader.query("threadSummary", "first"),
        reader.query("threadSummary", "second"),
      ]);
      await vi.advanceTimersByTimeAsync(4_000);
      expect((await pending).every(result => result.status === "rejected")).toBe(true);
      await expect(reader.query("threadSummary", "cooldown")).rejects.toThrow("暂不可用");
      await vi.advanceTimersByTimeAsync(30_000);
      const retry = Promise.allSettled([reader.query("threadSummary", "retry")]);
      await reader.close();
      expect((await retry)[0]?.status).toBe("rejected");
    } finally { await reader.close(); }
  });
});
