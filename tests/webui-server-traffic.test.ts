import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { routeTrafficApi } from "../scripts/webui-traffic-route.mjs";
// @ts-expect-error JavaScript reader intentionally has no declaration file.
import { describeDumpExchange } from "../scripts/traffic-dump-reader.mjs";
import {
  cleanupWebuiTestFixtures,
  startWebuiTestServer,
  type WebuiTestServer,
} from "./webui-server-test-fixture.js";

const temporaryDirectories: string[] = [];
const servers: WebuiTestServer[] = [];

afterEach(async () => {
  await cleanupWebuiTestFixtures(servers, temporaryDirectories);
});

describe("webui traffic V2 API", () => {
  it("does not infer new stages from legacy wall-clock records or invalid offsets", async () => {
    const fixture = createFixture();
    const legacy = httpInteraction(1);
    const invalid = httpInteraction(2);
    Object.assign(invalid.response, { callTiming: {
      clock: "monotonic", endMs: 100, forwardingMs: 10, firstEventMs: 120,
      requestBodyEndMs: 80, responseHeadMs: 20,
    } });
    writeSession(fixture.trafficDir, "openai", "clock-stages", [legacy, invalid]);
    const paths = [join(fixture.trafficDir, "openai-clock-stages")];
    expect((await describeDumpExchange(paths, 1)).response.callTiming).toBeNull();
    const timing = (await describeDumpExchange(paths, 2)).response.callTiming;
    expect(timing).toMatchObject({ totalMs: 100, preForwardMs: 10, receiveResponseMs: 80 });
    expect(timing.firstEventWaitMs).toBeUndefined();
    expect(timing.afterFirstEventMs).toBeUndefined();
    expect(timing.waitResponseHeadMs).toBeUndefined();
  });
  it.each(["http", "websocket"])("separates %s model declarations across trace pages without changing terminal models", async (transport) => {
    const fixture = createFixture();
    const call = transport === "http" ? httpInteraction(1) : websocketInteraction(1);
    call.response.headers = { "X-OpenAI-Model": "header-model" };
    const value = JSON.stringify({ type: "codex.response.metadata", headers: {
      "openai-model": "declared-model", "x-codex-safety-buffering-faster-model": "candidate-model",
      "x-codex-turn-state": "must-not-project", "x-models-etag": "catalog-only",
    } });
    call.responseBody = JSON.stringify({ type: "response.completed", response: {
      model: "terminal-model", output: [{ type: "message", content: [{ type: "output_text", text: "answer" }] }],
    } });
    call.response.responseModels = ["terminal-model"];
    call.trace = Array.from({ length: 3 }, () => ({ interaction: 1, kind: "other" }));
    if (transport === "websocket") {
      call.trace.push(...[value.slice(0, 40), value.slice(40)].map((text, index) => ({
        interaction: 1, kind: "websocket_frame", direction: "upstream", text, part: index + 1, parts: 2,
      })));
      call.trace.push({ interaction: 2, kind: "websocket_frame", direction: "upstream", text: value.replace("candidate-model", "other-call") });
    } else {
      const sse = `data: ${value}\n\n`;
      call.trace.push(...[sse.slice(0, 30), sse.slice(30)].map((text) => ({ interaction: 1, kind: "response_body", encoding: "utf8", text })));
    }
    writeSession(fixture.trafficDir, "openai", "models", [call]);
    const detail = await describeDumpExchange([join(fixture.trafficDir, "openai-models")], 1, { maxTracePageSize: 1 });
    expect(detail.trace).toHaveLength(1);
    expect(detail.responseModels).toEqual(["terminal-model"]);
    expect(detail.modelEvidence).toEqual({
      serverModels: [{ source: "http.headers.x-openai-model", model: "header-model" }, { source: "codex.response.metadata.headers.openai-model", model: "declared-model" }],
      safetyModels: [{ source: "codex.response.metadata.headers.x-codex-safety-buffering-faster-model", model: "candidate-model" }],
      truncated: false,
    });
    expect(detail.response.outputTruncated).toBe(false);
    expect(JSON.stringify(detail.modelEvidence)).not.toMatch(/must-not-project|catalog-only|other-call/u);
  });

  it("bounds declarations and preserves explicit safety metadata sources", async () => {
    const fixture = createFixture();
    const call = websocketInteraction(1);
    call.trace = [
      { type: "response.metadata", metadata: { type: "safety_buffering", retry_model: "retry-model" } },
      { type: "response.metadata", safety_buffering: null, metadata: { type: "safety_buffering", retry_model: "ignored" } },
      { type: "response.metadata", headers: { "openai-model": "x".repeat(257) } },
      { type: "response.completed", response: { headers: { "X-OpenAI-Model": "nested-model" } }, safety_buffering: { retry_model: "explicit-retry" } },
      ...Array.from({ length: 40 }, (_, index) => ({ type: "codex.response.metadata", headers: { "openai-model": `model-${index}` } })),
    ].map((event) => ({ interaction: 1, kind: "websocket_frame", direction: "upstream", text: JSON.stringify(event) }));
    writeSession(fixture.trafficDir, "openai", "bounded-models", [call]);
    const detail = await describeDumpExchange([join(fixture.trafficDir, "openai-bounded-models")], 1);
    expect(detail.modelEvidence.safetyModels).toEqual([
      { source: "response.metadata.metadata.retry_model", model: "retry-model" },
      { source: "response.completed.safety_buffering.retry_model", model: "explicit-retry" },
    ]);
    expect(detail.modelEvidence.serverModels[0]).toEqual({ source: "response.completed.response.headers.x-openai-model", model: "nested-model" });
    expect(detail.modelEvidence.serverModels).toHaveLength(30);
    expect(detail.modelEvidence.truncated).toBe(true);
  });

  it("identifies WebSocket failure terminals without an HTTP eventType index", async () => {
    const fixture = createFixture();
    const call = websocketInteraction(1);
    call.response.state = "failed";
    call.responseBody = JSON.stringify({ type: "response.failed", response: { error: { code: "upstream_error" } } });
    writeSession(fixture.trafficDir, "openai", "ws-failed", [call]);
    const detail = await describeDumpExchange([join(fixture.trafficDir, "openai-ws-failed")], 1);
    expect(detail.response.failureStage).toBe("上游返回失败或不完整终态");
  });

  it.each([
    [{ state: "failed", errorScope: "upstream_route" }, "上游路由解析"],
    [{ state: "failed", errorScope: "upstream_response" }, "上游响应接收"],
    [{ state: "incomplete", eventType: "response.incomplete" }, "上游返回失败或不完整终态"],
    [{ state: "failed", status: 429 }, "上游 HTTP 响应"],
    [{ state: "incomplete" }, "未提供失败阶段"],
    [{ state: "completed" }, undefined],
  ])("projects only recorded failure stages: %j", async (response, expected) => {
    const fixture = createFixture();
    const call = httpInteraction(1);
    Object.assign(call.response, response);
    const session = "2026-09-17T00-00-00-000Z";
    writeSession(fixture.trafficDir, "openai", session, [call]);
    const detail = await describeDumpExchange([join(fixture.trafficDir, `openai-${session}`)], 1);
    expect(detail.response.failureStage).toBe(expected);
  });

  it("reports unavailable exact references without selecting another call", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.environment);
    const detailUrl = `${server.origin}/api/v1/traffic/exchange?label=openai&session=missing&id=1`;
    const empty = await getJson<TrafficErrorBody>(detailUrl);
    expect(empty.status).toBe(404);
    expect(empty.body.error.code).toBe("traffic_session_not_found");
    writeSession(fixture.trafficDir, "openai", "retained", [httpInteraction(1)]);
    const missingSession = await getJson<TrafficErrorBody>(detailUrl);
    expect(missingSession.status).toBe(404);
    expect(missingSession.body.error.code).toBe("traffic_session_not_found");
    const missingCall = await getJson<TrafficErrorBody>(detailUrl.replace("session=missing&id=1", "session=retained&id=2"));
    expect(missingCall.status).toBe(404);
    expect(missingCall.body.error.code).toBe("traffic_exchange_not_found");
  });

  it("projects retained inputs, declared tools and reported parameters without inventing missing content", async () => {
    const fixture = createFixture();
    const call = httpInteraction(1, JSON.stringify({
      instructions: "top-level instructions", input: [
        { type: "omitted", omitted_items: 2, omitted_bytes: 123 },
        { role: "developer", content: "developer message" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "question" }, { type: "input_image", image_url: "local-image" }] },
        { type: "function_call_output", call_id: "call-1", output: "tool result" },
        { type: "truncated", head: "prefix", tail: "suffix", bytes: 100 },
      ],
      tools: [{ type: "function", name: "test_tool", parameters: { type: "object" } }],
      reasoning: { effort: "high" }, parallel_tool_calls: false, temperature: 0,
    }), JSON.stringify({ response: { reasoning: { effort: "low" }, temperature: 1, top_p: null, output: [] } }));
    const session = "2026-09-17T00-00-00-000Z";
    writeSession(fixture.trafficDir, "ocg", session, [call]);
    const detail = await describeDumpExchange([join(fixture.trafficDir, `ocg-${session}`)], 1);
    expect(detail.request.content).toMatchObject({ instructions: "top-level instructions", input: [
      { type: "omitted", omittedItems: 2 },
      { type: "message", role: "developer", text: "developer message" },
      { type: "message", role: "user", text: expect.stringContaining("input_image") },
      { type: "function_call_output", callId: "call-1", text: "tool result" },
      { type: "truncated", text: expect.stringContaining("prefix") },
    ], tools: [{ name: "test_tool", type: "function", definition: expect.stringContaining("parameters") }] });
    expect(detail.parameterComparison).toEqual([
      { field: "reasoning.effort", request: "high", response: "low" },
      { field: "parallel_tool_calls", request: "false", response: null },
      { field: "temperature", request: "0", response: "1" },
    ]);
    expect(detail.response.output).toEqual([]);
  });

  it("derives local HTTP stages across trace pages and does not reuse them for WebSocket", async () => {
    const fixture = createFixture();
    const call = httpInteraction(1);
    call.request.startedAtMs = 100;
    call.trace = [
      { kind: "request_end", ts: 110 }, { kind: "response_head", ts: 150 }, { kind: "response_end", ts: 150 },
    ].map((record) => ({ ...record, interaction: 1 }));
    const session = "2026-09-17T00-00-00-000Z";
    writeSession(fixture.trafficDir, "deepseek", session, [call, websocketInteraction(2)]);
    const paths = [join(fixture.trafficDir, `deepseek-${session}`)];
    const detail = await describeDumpExchange(paths, 1, { maxTracePageSize: 1 });
    expect(detail.response.httpTiming).toEqual({ receiveRequestMs: 10, waitResponseHeadMs: 40, receiveResponseMs: 0 });
    expect(detail.trace).toHaveLength(1);
    expect((await describeDumpExchange(paths, 2)).response.httpTiming).toBeNull();
  });

  it("does not replace unavailable request content or invalid stage timestamps with defaults", async () => {
    const fixture = createFixture();
    const call = httpInteraction(1, "{incomplete");
    call.trace = [
      { interaction: 1, kind: "response_head", ts: 50 },
      { interaction: 1, kind: "response_end", ts: 40 },
    ];
    const session = "2026-09-17T00-00-00-000Z";
    writeSession(fixture.trafficDir, "ocg", session, [call]);
    const detail = await describeDumpExchange([join(fixture.trafficDir, `ocg-${session}`)], 1);
    expect(detail.request.content).toEqual({ instructions: null, input: null, tools: null });
    expect(detail.response.httpTiming).toEqual({ receiveRequestMs: undefined, waitResponseHeadMs: undefined, receiveResponseMs: undefined });
  });

  it("lists logical calls without payloads and returns one request with one response", async () => {
    const fixture = createFixture();
    writeSession(fixture.trafficDir, "ocg", "2026-09-17T00-00-00-000Z", [
      httpInteraction(1),
      websocketInteraction(2),
    ]);
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic?limit=1`);
    expect(list.status).toBe(200);
    expect(list.body.retentionDays).toBe(30);
    expect(list.body).toMatchObject({
      enabled: true,
      label: "ocg",
      maximumOffset: 50_000,
      total: 2,
      nextOffset: 1,
    });
    expect(list.body.exchanges[0]).toMatchObject({
      id: 2,
      requestModel: "gpt-6-astra",
      responseModels: ["gpt-6-astra"],
      state: "completed",
      transport: "websocket",
    });
    expect(JSON.stringify(list.body)).not.toContain("hello");

    const detail = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=1&session=${list.body.exchanges[0]?.session}`,
    );
    expect(detail.status).toBe(200);
    expect(JSON.parse(detail.body.exchange.request.body)).toEqual({
      input: ["hello"], model: "deepseek-flash",
    });
    expect(JSON.parse(detail.body.exchange.response?.body ?? "null")).toMatchObject({
      type: "response.completed",
    });
    expect(detail.body.exchange.tracePage.total).toBe(2);
  });

  it("projects stored per-call metadata, usage and completed output beyond the trace page", async () => {
    const fixture = createFixture();
    const call = websocketInteraction(1, Array.from({ length: 101 }, () => ({
      interaction: 1, kind: "websocket_frame", direction: "upstream", text: "{}",
    })));
    call.request.requestKind = "prewarm";
    call.requestBody = JSON.stringify({
      model: "model-test", reasoning: { effort: "high" }, service_tier: "priority",
      previous_response_id: "resp-before",
      client_metadata: { thread_id: "thread-current", turn_id: "turn-current",
        "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn", turn_id: "turn-current" }) },
    });
    const event = JSON.stringify({ type: "response.output_item.done", output_index: 0,
      item: { id: "msg-result", type: "message", content: [{ type: "output_text", text: "actual answer" }] } });
    call.trace.push(...[event.slice(0, 40), event.slice(40)].map((text, index) => ({
      interaction: 1, kind: "websocket_frame", direction: "upstream", text, part: index + 1, parts: 2,
    })));
    call.responseBody = JSON.stringify({ type: "response.completed", response: {
      id: "resp-current", output: [], service_tier: "default",
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 },
        output_tokens: 10, output_tokens_details: { reasoning_tokens: 2 } },
    } });
    writeSession(fixture.trafficDir, "openai", "2026-09-17T00-00-00-000Z", [call]);
    const server = await startServer(fixture.environment);
    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic`);
    expect(list.body.exchanges[0]).toMatchObject({ requestKind: "turn", turnId: "turn-current" });
    const detail = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?id=1`);
    expect(detail.body.exchange).toMatchObject({
      request: { parameters: { reasoningEffort: "high", serviceTier: "priority", previousResponseId: "resp-before" } },
      response: { responseId: "resp-current", serviceTier: "default",
        usage: { inputTokens: 100, cachedTokens: 80, outputTokens: 10, reasoningTokens: 2 },
        output: [{ type: "message", text: "actual answer" }], outputTruncated: false },
    });
    expect(detail.body.exchange.trace).toHaveLength(100);
  });

  it("assembles SSE completed items across chunks and bounds their combined output", async () => {
    const fixture = createFixture();
    const call = httpInteraction(1);
    const events = [0, 1].map((index) => `data: ${JSON.stringify({
      type: "response.output_item.done", output_index: index,
      item: { type: "message", content: [{ type: "output_text", text: "a".repeat(150) }] },
    })}\n\n`).join("");
    call.trace = [events.slice(0, 30), events.slice(30)].map((text) => ({
      interaction: 1, kind: "response_body", encoding: "utf8", text,
    }));
    const session = "2026-09-17T00-00-00-000Z";
    writeSession(fixture.trafficDir, "openai", session, [call]);
    const detail = await describeDumpExchange([join(fixture.trafficDir, `openai-${session}`)], 1, { maxSectionBytes: 350 });
    expect(detail.response.output).toHaveLength(1);
    expect(detail.response.output[0].text).toBe("a".repeat(150));
    expect(detail.response.outputTruncated).toBe(true);
  });

  it.each([
    ['data: {"type":"response.output_item.done","item":', true],
    ['data: {"type":"response.completed"}', false],
    ['data: [DONE]\n', false],
    [': keepalive\n', false],
  ])("reports incomplete SSE tail %s", async (tail, truncated) => {
    const fixture = createFixture();
    const call = httpInteraction(1);
    call.trace = [{ interaction: 1, kind: "response_body", encoding: "utf8", text: tail }];
    const session = "2026-09-17T00-00-00-000Z";
    writeSession(fixture.trafficDir, "openai", session, [call]);
    const detail = await describeDumpExchange([join(fixture.trafficDir, `openai-${session}`)], 1);
    expect(detail.response.outputTruncated).toBe(truncated);
  });

  it("extracts scoped timing beyond the trace page even when terminal output exists", async () => {
    const fixture = createFixture();
    const call = websocketInteraction(1, Array.from({ length: 101 }, () => ({
      interaction: 1, kind: "websocket_frame", direction: "upstream", text: "{}",
    })));
    call.responseBody = JSON.stringify({ response: { id: "resp-current",
      output: [{ type: "message", content: "answer" }] } });
    const timing = JSON.stringify({ type: "responsesapi.websocket_timing", timing_metrics: {
      timing_scope: "logical_turn", response_id: "resp-current", total_turn_time_s: 5.421,
      first_sampled_message_ttft_ms: 2843, engine_queue_max_ms: 1738,
      engine_service_sampling_total_ms: 2327.393, client_tool_pause_total_ms: 0,
    } });
    call.trace.push(...[timing.slice(0, 30), timing.slice(30)].map((text, index) => ({
      interaction: 1, kind: "websocket_frame", direction: "upstream", text, part: index + 1, parts: 2,
    })));
    call.trace.push({ interaction: 1, kind: "websocket_frame", direction: "upstream",
      text: timing.replace("resp-current", "resp-other") });
    const session = "2026-09-17T00-00-00-000Z";
    writeSession(fixture.trafficDir, "openai", session, [call]);
    const detail = await describeDumpExchange([join(fixture.trafficDir, `openai-${session}`)], 1);
    expect(detail.response.timing).toEqual({ scope: "logical_turn", responseId: "resp-current",
      totalMs: 5421, firstTokenMs: 2843, queueMaxMs: 1738, samplingMs: 2327.393, toolPauseMs: 0 });
    expect(detail.response.output).toMatchObject([{ text: "answer" }]);
    expect(detail.response.outputTruncated).toBe(false);
    expect(detail.trace).toHaveLength(100);
  });

  it.each([
    ["logical_turn", "resp-current", "resp-current", true],
    ["engine_call", "resp-current", "resp-current", false],
    ["logical_turn", "resp-other", "resp-current", false],
    ["logical_turn", undefined, undefined, false],
  ])("keeps missing timing explicit and rejects unmatched scope or response: %s %s %s", async (scope, id, terminalId, matched) => {
    const fixture = createFixture();
    const call = websocketInteraction(1, [{ interaction: 1, kind: "websocket_frame", direction: "upstream",
      text: JSON.stringify({ type: "responsesapi.websocket_timing", timing_metrics: {
        timing_scope: scope, response_id: id, total_turn_time_s: null,
        first_sampled_message_ttft_ms: "123", engine_queue_max_ms: -1, client_tool_pause_total_ms: 0,
      } }),
    }]);
    call.responseBody = JSON.stringify({ response: { id: terminalId, output: [] } });
    const session = "2026-09-17T00-00-00-000Z";
    writeSession(fixture.trafficDir, "openai", session, [call]);
    const detail = await describeDumpExchange([join(fixture.trafficDir, `openai-${session}`)], 1);
    if (matched) {
      expect(detail.response.timing).toEqual({ scope, responseId: id, toolPauseMs: 0,
        totalMs: undefined, firstTokenMs: undefined, queueMaxMs: undefined, samplingMs: undefined });
    } else expect(detail.response.timing).toBeNull();
  });

  it("prefers terminal output without duplicating its trace items and distinguishes model discovery", async () => {
    const fixture = createFixture();
    const call = httpInteraction(1, "{}", JSON.stringify({ output: [{ type: "message", content: "terminal answer" }] }));
    call.trace.push({ interaction: 1, kind: "websocket_frame", direction: "upstream",
      text: JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", content: "trace answer" } }) });
    const models = httpInteraction(2);
    Object.assign(models.request, { method: "GET", path: "/models?client_version=1" });
    writeSession(fixture.trafficDir, "openai", "2026-09-17T00-00-00-000Z", [call, models]);
    const server = await startServer(fixture.environment);
    const detail = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?id=1`);
    expect(detail.body.exchange.response).toMatchObject({
      output: [{ text: "terminal answer" }], outputSource: "terminal", outputTruncated: false,
    });
    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic`);
    expect(list.body.exchanges.find((entry) => entry.id === 2)).toMatchObject({ category: "models" });
  });

  it("paginates raw trace independently from the logical response", async () => {
    const fixture = createFixture();
    const traces = Array.from({ length: 120 }, (_value, index) => ({
      interaction: 1,
      kind: "websocket_frame",
      sequence: index,
      ts: 1_700_000_000_000 + index,
    }));
    writeSession(fixture.trafficDir, "openai", "2026-09-17T00-00-00-000Z", [
      websocketInteraction(1, traces),
    ]);
    const server = await startServer(fixture.environment);

    const first = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?id=1`);
    expect(first.body.exchange.trace).toHaveLength(100);
    expect(first.body.exchange.tracePage).toEqual({
      nextOffset: 100,
      offset: 0,
      previousOffset: null,
      total: 120,
    });
    const second = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=1&traceOffset=100`,
    );
    expect(second.body.exchange.trace).toHaveLength(20);
    expect(second.body.exchange.tracePage.previousOffset).toBe(0);
  });

  it("does not skip trace records after the byte limit truncates a page", async () => {
    const fixture = createFixture();
    writeSession(fixture.trafficDir, "openai", "2026-09-17T00-00-00-000Z", [
      websocketInteraction(1, [
        { interaction: 1, kind: "large", text: "x".repeat(4 * 1_048_576), ts: 1 },
        { interaction: 1, kind: "after-limit", text: "visible-next-page", ts: 2 },
      ]),
    ]);
    const server = await startServer(fixture.environment);

    const first = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?id=1`);
    expect(first.body.exchange.trace).toHaveLength(1);
    expect(first.body.exchange.tracePage.nextOffset).toBe(1);
    const second = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=1&traceOffset=1`,
    );
    expect(second.body.exchange.trace).toMatchObject([
      { kind: "after-limit", text: expect.stringContaining("visible-next-page") },
    ]);
  });

  it("bounds request and response payload reads to four MiB", async () => {
    const fixture = createFixture();
    const oversized = "x".repeat(4 * 1_048_576 + 1024);
    writeSession(fixture.trafficDir, "openai", "2026-09-17T00-00-00-000Z", [
      httpInteraction(1, oversized, oversized),
    ]);
    const server = await startServer(fixture.environment);

    const detail = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?id=1`);
    expect(detail.body.exchange.request.bodyTruncated).toBe(true);
    expect(detail.body.exchange.response?.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(detail.body.exchange.request.body)).toBe(4 * 1_048_576);
  });

  it("keeps labels and writer sessions explicit across restarts", async () => {
    const fixture = createFixture();
    writeSession(fixture.trafficDir, "openai", "2026-09-17T00-00-00-000Z", [
      httpInteraction(1, "older"),
    ], 100);
    writeSession(fixture.trafficDir, "openai", "2026-09-18T00-00-00-000Z", [
      httpInteraction(1, "newer"),
    ], 200);
    writeSession(fixture.trafficDir, "deepseek", "2026-09-18T01-00-00-000Z", [
      httpInteraction(1, "other"),
    ], 300);
    const server = await startServer(fixture.environment);

    const latest = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic`);
    expect(latest.body.label).toBe("deepseek");
    expect(latest.body.labels.map((entry) => entry.label)).toEqual(["deepseek", "openai"]);
    const older = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=1&label=openai&session=2026-09-17T00-00-00-000Z`,
    );
    expect(older.body.exchange.request.body).toBe("older");
  });

  it("paginates all retained sessions by request time without merging repeated ids", async () => {
    const fixture = createFixture();
    const oldSession = "2026-09-17T00-00-00-000Z";
    const newSession = "2026-09-18T00-00-00-000Z";
    const older = httpInteraction(1, "older request", "older response");
    const newer = httpInteraction(1, "newer request", "newer response");
    older.request.startedAtMs = 100;
    newer.request.startedAtMs = 300;
    const overlapping = httpInteraction(2);
    overlapping.request.startedAtMs = 400;
    writeSession(fixture.trafficDir, "openai", oldSession, [older, overlapping], 100);
    writeSession(fixture.trafficDir, "openai", newSession, [newer], 200);
    writeSession(fixture.trafficDir, "deepseek", "other", [httpInteraction(1)], 300);
    const server = await startServer(fixture.environment);
    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic?label=openai&limit=2`);
    expect(list.body).toMatchObject({ total: 3, session: null, nextOffset: 2,
      sessions: [{ session: newSession }, { session: oldSession }],
      exchanges: [{ id: 2, session: oldSession }, { id: 1, session: newSession }],
    });
    const next = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic?label=openai&limit=2&offset=2`);
    expect(next.body).toMatchObject({ total: 3, nextOffset: null, exchanges: [{ id: 1, session: oldSession }] });
    for (const [session, body] of [[oldSession, "older"], [newSession, "newer"]]) {
      const detail = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?label=openai&session=${session}&id=1`);
      expect(detail.body.exchange.request.body).toBe(`${body} request`);
      expect(detail.body.exchange.response?.body).toBe(`${body} response`);
    }
    const filtered = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic?label=openai&session=${oldSession}`);
    expect(filtered.body).toMatchObject({ total: 2, session: oldSession });
    const ambiguous = await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic/exchange?label=openai&id=1`);
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.code).toBe("missing_parameter");
    writeSession(fixture.trafficDir, "openai", "2026-09-19T00-00-00-000Z", [httpInteraction(1)], 500);
    const refreshed = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic?label=openai`);
    expect(refreshed.body).toMatchObject({ total: 4, session: null });
    const unknown = await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic?label=openai&session=other`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("traffic_session_not_found");
  });

  it("reports legacy JSONL explicitly and rejects unsupported parameters", async () => {
    const legacy = createFixture();
    writeFileSync(join(legacy.trafficDir, "openai-2026-09-17T00-00-00-000Z-1.jsonl"), "{}\n");
    const legacyServer = await startServer(legacy.environment);
    const unavailable = await getJson<TrafficErrorBody>(`${legacyServer.origin}/api/v1/traffic`);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe("traffic_legacy_format");

    const fixture = createFixture();
    writeSession(fixture.trafficDir, "openai", "2026-09-17T00-00-00-000Z", [httpInteraction(1)]);
    const server = await startServer(fixture.environment);
    const invalid = await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic?bogus=1`);
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("unsupported_parameter");
    const excessiveOffset = await getJson<TrafficErrorBody>(
      `${server.origin}/api/v1/traffic?offset=50001`,
    );
    expect(excessiveOffset.status).toBe(400);
    expect(excessiveOffset.body.error.code).toBe("invalid_parameter");
  });

  it("fails closed when a V2 session manifest is malformed", async () => {
    const fixture = createFixture();
    const session = join(fixture.trafficDir, "openai-broken");
    mkdirSync(session);
    writeFileSync(join(session, "manifest.json"), "{broken");
    const server = await startServer(fixture.environment);

    const result = await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic`);
    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("traffic_unsupported_version");
  });

  it("rejects non-loopback callers before reading traffic", async () => {
    const fixture = createFixture();
    await expect(routeTrafficApi({
      apiPath: "/traffic",
      environment: fixture.environment,
      request: { socket: { remoteAddress: "192.0.2.1" } },
      response: {},
      url: new URL("http://127.0.0.1/api/v1/traffic"),
    })).rejects.toMatchObject({ message: "调用记录查看只允许回环访问", status: 503 });
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-webui-traffic-v2-"));
  temporaryDirectories.push(root);
  const configPath = join(root, "config.toml");
  const environment = {
    ...process.env,
    CODEX_CONNECT_CONFIG_FILE: configPath,
    CODEX_CONNECT_HOME: root,
    CODEX_HOME: join(root, "codex"),
  };
  writeGatewayConfig(configPath, {
    codex: { binary: "codex", socket_path: "runtime/app-server.sock" },
    debug: { model_traffic_dump: true, model_traffic_input_items: 3 },
    default_workspace: "main",
    network: {},
    telegram: { allowed_user_ids: [1], bot_token: "token", message_format: "html" },
    version: 1,
    workspaces: [{ cwd: join(root, "workspace"), id: "main", name: "Main" }],
  });
  const trafficDir = join(root, "traffic");
  mkdirSync(trafficDir, { recursive: true });
  return { environment, trafficDir };
}

function startServer(environment: NodeJS.ProcessEnv) {
  return startWebuiTestServer(servers, environment, join(process.cwd(), "webui", "dist"));
}

async function getJson<T>(url: string): Promise<{ body: T; status: number }> {
  const response = await fetch(url);
  return { body: await response.json() as T, status: response.status };
}

interface LogicalInteraction {
  request: Record<string, unknown>;
  requestBody: string;
  response: Record<string, unknown>;
  responseBody: string;
  trace: Array<Record<string, unknown>>;
}

function httpInteraction(id: number, requestBody?: string, responseBody?: string): LogicalInteraction {
  const request = requestBody ?? JSON.stringify({ input: ["hello"], model: "deepseek-flash" });
  const response = responseBody ?? JSON.stringify({
    response: { model: "deepseek-flash", output: [] }, type: "response.completed",
  });
  return {
    requestBody: request,
    responseBody: response,
    request: {
      account: "heforges", headers: { authorization: "Bearer <redacted>" }, id,
      kind: "request", method: "POST", path: "/responses", requestKind: "turn",
      requestModel: "deepseek-flash", startedAtMs: 1_700_000_000_000 + id,
      threadId: `thread-http-${id}`, transport: "http", turnId: `turn-http-${id}`,
    },
    response: {
      durationMs: 12, headers: { "content-type": "text/event-stream" }, id,
      kind: "response", responseModels: ["deepseek-flash"], state: "completed", status: 200,
    },
    trace: [
      { interaction: id, kind: "request_head", ts: 1_700_000_000_000 },
      { interaction: id, kind: "response_end", ts: 1_700_000_000_012 },
    ],
  };
}

function websocketInteraction(
  id: number,
  trace?: Array<Record<string, unknown>>,
): LogicalInteraction {
  return {
    requestBody: JSON.stringify({ model: "gpt-6-astra", type: "response.create" }),
    responseBody: JSON.stringify({ response: { model: "gpt-6-astra" }, type: "response.completed" }),
    request: {
      headers: { "user-agent": "codex-cli" }, id, kind: "request", requestModel: "gpt-6-astra",
      startedAtMs: 1_700_000_000_000 + id, transport: "websocket", url: "wss://example.test/responses",
    },
    response: {
      durationMs: 8, id, kind: "response", responseModels: ["gpt-6-astra"], state: "completed",
    },
    trace: trace ?? [],
  };
}

function writeSession(
  directory: string,
  label: string,
  session: string,
  interactions: LogicalInteraction[],
  createdAtMs = 1_700_000_000_000,
) {
  const path = join(directory, `${label}-${session}`);
  mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(path, "manifest.json"), JSON.stringify({ createdAtMs, label, session, version: 2 }));
  const payloads: Buffer[] = [];
  let offset = 0;
  const records = interactions.flatMap((interaction) => {
    const request = Buffer.from(interaction.requestBody);
    const requestPayload = { bytes: request.length, parts: [{ bytes: request.length, encoding: "utf8", file: "payload-1.bin", offset }] };
    payloads.push(request);
    offset += request.length;
    const response = Buffer.from(interaction.responseBody);
    const responsePayload = { bytes: response.length, parts: [{ bytes: response.length, encoding: "utf8", file: "payload-1.bin", offset }] };
    payloads.push(response);
    offset += response.length;
    return [
      { version: 2, ts: createdAtMs, ...interaction.request, payload: requestPayload },
      { version: 2, ts: createdAtMs + 1, ...interaction.response, payload: responsePayload },
    ];
  });
  writeFileSync(join(path, "payload-1.bin"), Buffer.concat(payloads), { mode: 0o600 });
  writeFileSync(join(path, "interactions.jsonl"), records.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
  const trace = interactions.flatMap((interaction) => interaction.trace);
  writeFileSync(join(path, "trace-1.jsonl"), trace.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
}

interface TrafficListBody {
  enabled: boolean;
  retentionDays: number;
  exchanges: Array<Record<string, unknown>>;
  label: string;
  labels: Array<{ label: string; sessions: number }>;
  maximumOffset: number;
  nextOffset: number | null;
  session: string | null;
  total: number;
}

interface TrafficDetailBody {
  exchange: {
    request: { body: string; bodyTruncated: boolean };
    response: { body: string; bodyTruncated: boolean } | null;
    trace: Array<Record<string, unknown>>;
    tracePage: { nextOffset: number | null; offset: number; previousOffset: number | null; total: number };
  };
}

interface TrafficErrorBody {
  error: { code: string; message: string };
}
