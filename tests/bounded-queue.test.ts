import { describe, expect, it } from "vitest";

import { BoundedAsyncQueue } from "../src/event-bus/bounded-queue.js";

describe("BoundedAsyncQueue", () => {
  it("drops a non-critical event when full", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    expect(queue.push(1)).toBe(true);
    expect(queue.push(2)).toBe(false);
    expect(await queue.shift()).toBe(1);
  });

  it("replaces a queued non-critical event with a critical event", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    queue.push(1, false);
    expect(queue.push(2, true)).toBe(true);
    expect(await queue.shift()).toBe(2);
  });
});
