import { describe, expect, it, vi } from "vitest";

import {
  createMetricsState,
  inspectResponseEvent,
  observeResponseEvent,
  HttpResponseMetricsObserver,
} from "../src/provider-proxy/response-metrics-observer.js";
import { TurnTimingAccumulator } from "../src/conversation-core/turn-timing-accumulator.js";

describe("OpenAI upstream TTFT", () => {
  it("uses captured request and receive times even when parsing runs later", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(900);
    try {
      const metadata = { threadId: null, turnId: null, operation: "response" as const };
      const http = createMetricsState(metadata, 1000, "http", "response", null, 100);
      http.responseFormat = "sse";
      new HttpResponseMetricsObserver(http).observeChunk(
        Buffer.from('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'), 1200, 350,
      );
      const ws = createMetricsState(metadata, 1000, "websocket", "response", null, 100);
      observeResponseEvent(ws, "response.reasoning_text.delta", { delta: "thinking" }, 1200, 350);
      expect(http.firstContentMs).toBe(250);
      expect(ws.firstContentMs).toBe(250);
      expect(clock).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it("measures independent request clocks and ignores lifecycle or empty deltas", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    try {
      const first = state();
      const push = (metrics: ReturnType<typeof state>, type: string, delta?: string) => {
        const parsed = inspectResponseEvent(JSON.stringify({ type, delta }), "", metrics.firstContentMs === undefined);
        observeResponseEvent(metrics, parsed.type, parsed.event, -999, performance.now());
      };
      clock.mockReturnValue(120);
      push(first, "response.created");
      push(first, "response.output_text.delta", "");
      expect(first.firstContentMs).toBeUndefined();
      clock.mockReturnValue(145);
      push(first, "response.function_call_arguments.delta", "{");
      expect(first.firstContentMs).toBe(45);
      clock.mockReturnValue(200);
      push(first, "response.output_text.delta", "later");
      expect(first.firstContentMs).toBe(45);
      const second = state();
      clock.mockReturnValue(209);
      push(second, "response.reasoning_summary_text.delta", "thinking");
      expect(second.firstContentMs).toBe(9);
      expect(inspectResponseEvent('{"type":"response.output_text.delta","delta":"later"}').event).toBeUndefined();
    } finally { clock.mockRestore(); }
  });

  it("observes split SSE content and keeps request and echo models distinct", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10);
    try {
      const metrics = createMetricsState({ threadId: null, turnId: null, operation: "response" }, 1000, "http", "response", null, performance.now());
      metrics.responseFormat = "sse";
      metrics.requestModel = "requested";
      const observer = new HttpResponseMetricsObserver(metrics);
      observer.observeChunk(Buffer.from('data: {"type":"response.output_text.delta","delta":"'), 1010, performance.now());
      expect(metrics.firstContentMs).toBeUndefined();
      clock.mockReturnValue(35);
      observer.observeChunk(Buffer.from('hi"}\n\n'), 500, performance.now());
      expect(metrics.firstContentMs).toBe(25);
      observer.observeChunk(Buffer.from('data: {"type":"response.completed","response":{"model":"echoed"}}\n\n'), 1200, performance.now());
      expect(metrics).toMatchObject({ firstContentMs: 25, requestModel: "requested", responseModel: "echoed" });
      const missing = state();
      observeResponseEvent(missing, "response.completed", { response: {} }, 1, performance.now());
      expect(missing.responseModel).toBeNull();
      expect(missing.firstContentMs).toBeUndefined();
    } finally { clock.mockRestore(); }
  });
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
    0, "websocket", "response", null, performance.now());
}

function timing(responseId: string, value: unknown, scope = "logical_turn") {
  return { type: "responsesapi.websocket_timing", timing_metrics: {
    response_id: responseId, timing_scope: scope, first_sampled_message_ttft_ms: value,
  } };
}

function observe(metrics: ReturnType<typeof state>, value: Record<string, unknown>) {
  const { type, event } = inspectResponseEvent(JSON.stringify(value));
  return observeResponseEvent(metrics, type, event, 100, performance.now());
}
