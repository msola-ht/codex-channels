import { describe, expect, it } from "vitest";

import {
  createMetricsState,
  inspectResponseEvent,
  observeResponseEvent,
} from "../src/provider-proxy/response-metrics-observer.js";
import { TurnTimingAccumulator } from "../src/conversation-core/turn-timing-accumulator.js";

describe("OpenAI upstream TTFT", () => {
  it.each([0, 569, 720.25])("correlates %s ms before terminal delivery", (ttftMs) => {
    const metrics = state();
    observe(metrics, { type: "response.created", response: { id: "resp-1" } });
    observe(metrics, timing("resp-other", 999));
    observe(metrics, timing("resp-1", ttftMs));
    observe(metrics, timing("resp-other", 888));
    expect(metrics.upstreamTtftMs).toBeUndefined();
    expect(observe(metrics, { type: "response.completed", response: { id: "resp-1" } })).toBe(true);
    expect(metrics.upstreamTtftMs).toBe(ttftMs);
    expect(state().upstreamTtftMs).toBeUndefined();
  });

  it.each([
    timing("resp-other", 123), timing("resp-1", -1), timing("resp-1", "123"),
    timing("resp-1", null), timing("resp-1", 123, "engine_call"),
  ])("ignores invalid or mismatched timing: %j", (event) => {
    const metrics = state();
    observe(metrics, { type: "response.created", response: { id: "resp-1" } });
    observe(metrics, event);
    observe(metrics, { type: "response.completed", response: { id: "resp-1" } });
    expect(metrics.upstreamTtftMs).toBeUndefined();
  });

  it("does not attribute a timing to a different terminal response", () => {
    const metrics = state();
    observe(metrics, { type: "response.created", response: { id: "resp-1" } });
    observe(metrics, timing("resp-1", 123));
    observe(metrics, { type: "response.completed", response: { id: "resp-2" } });
    expect(metrics.upstreamTtftMs).toBeUndefined();
  });

  it("keeps the first valid Turn sample without summing repeats or including compaction", () => {
    const accumulator = new TurnTimingAccumulator("turn-1");
    const base = { type: "turn.modelTiming.updated", threadId: "thread-1", turnId: "turn-1" } as const;
    accumulator.recordModelTiming({ ...base, turnId: "other", upstreamTtftMs: 20 });
    accumulator.recordModelTiming({ ...base, operation: "compact", upstreamTtftMs: 30 });
    accumulator.recordModelTiming(base);
    accumulator.recordModelTiming({ ...base, upstreamTtftMs: 0 });
    accumulator.recordModelTiming({ ...base, upstreamTtftMs: 720 });
    expect(accumulator.output("turn-1")?.upstreamTtftMs).toBe(0);
    expect(accumulator.output("other")).toBeUndefined();
  });
});

function state() {
  return createMetricsState({ threadId: "thread-1", turnId: "turn-1", operation: "response" },
    0, "websocket", "response", null);
}

function timing(responseId: string, value: unknown, scope = "logical_turn") {
  return { type: "responsesapi.websocket_timing", timing_metrics: {
    response_id: responseId, timing_scope: scope, first_sampled_message_ttft_ms: value,
  } };
}

function observe(metrics: ReturnType<typeof state>, value: Record<string, unknown>) {
  const { type, event } = inspectResponseEvent(JSON.stringify(value));
  return observeResponseEvent(metrics, type, event, 100);
}
