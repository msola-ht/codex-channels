import pino from "pino";
import { expect, it, vi } from "vitest";
import { EventBus } from "../src/event-bus/index.js";

it("shares the hard budget across slow subscribers, retains admission and stops critical overflow", async () => {
  const overflow = vi.fn();
  const accepted: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((resolve) => { release = resolve; });
  const bus = new EventBus<string>(pino({ level: "silent" }), 10, undefined,
    { entries: 4, bytes: 8, size: (value) => value.length, overflow });
  bus.observe((value) => { accepted.push(value); });
  const delivered: string[] = [];
  bus.subscribe("a", async (value) => { delivered.push(value); await slow; });
  bus.subscribe("b", async () => { await slow; });
  bus.publish("aa", true);
  bus.publish("bb", true);
  bus.publish("cc", true);
  bus.publish("dd", true);
  expect(overflow).toHaveBeenCalledOnce();
  expect(accepted).toEqual(["aa", "bb", "cc"]);
  release();
  await bus.close();
  expect(delivered).toEqual(["aa", "bb"]);
});

it("reclaims budget after failed handlers and skips replaceable excess without stopping", async () => {
  const overflow = vi.fn();
  const calls: string[] = [];
  const bus = new EventBus<string>(pino({ level: "silent" }), 2, undefined,
    { entries: 1, bytes: 2, size: (value) => value.length, overflow });
  bus.subscribe("fixture", (value) => { calls.push(value); throw new Error("consumer failure"); });
  bus.publish("aa", false);
  bus.publish("bb", false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  bus.publish("cc", true);
  await bus.close();
  expect(overflow).not.toHaveBeenCalled();
  expect(calls).toEqual(["aa", "cc"]);
});
