import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { initializeUserData } from "../scripts/runtime-config.mjs";
import { BufferedModelRequestMetricsWriter, SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { QueueEventsServer } from "../runtime/queue-events.mjs";
import { metricsEventsPath } from "../runtime/metrics-events.mjs";
import { metricsLink, metricsQueryParams } from "../webui/src/lib/metrics-query.js";
import {
  cleanupWebuiTestFixtures,
  createWebuiTestFixture,
  metricSample,
  recordSample,
  startWebuiTestServer,
  type WebuiTestServer,
  type WebuiTestServerOptions,
} from "./webui-server-test-fixture.js";

const temporaryDirectories: string[] = [];
const servers: WebuiTestServer[] = [];

afterEach(async () => {
  await cleanupWebuiTestFixtures(servers, temporaryDirectories);
});

function createFixture() {
  return createWebuiTestFixture(temporaryDirectories);
}

function startServer(
  environment: NodeJS.ProcessEnv,
  staticDir?: string,
  options: WebuiTestServerOptions = {},
) {
  return startWebuiTestServer(servers, environment, staticDir, options);
}

/** 写入只含索引的最小 V2 批次，用于校验请求明细列表按调用记录关联上游提供商。 */
function writeCallIndex(
  fixture: ReturnType<typeof createFixture>,
  session: string,
  id: number,
  upstreamProvider: string,
) {
  const directory = join(fixture.home, "traffic", `openai-${session}`);
  mkdirSync(directory, { mode: 0o700, recursive: true });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ createdAtMs: 1, label: "openai", session, version: 2 }));
  const request = Buffer.from(JSON.stringify({ model: "deepseek-flash" }));
  const response = Buffer.from(JSON.stringify({ type: "response.completed" }));
  writeFileSync(join(directory, "payload-1.bin"), Buffer.concat([request, response]), { mode: 0o600 });
  const payload = (bytes: number, offset: number) => ({ bytes, parts: [{ bytes, encoding: "utf8", file: "payload-1.bin", offset }] });
  writeFileSync(join(directory, "interactions.jsonl"), [
    { version: 2, ts: 1, id, kind: "request", method: "POST", path: "/responses", transport: "http",
      startedAtMs: 1, requestModel: "requested", payload: payload(request.length, 0) },
    { version: 2, ts: 2, id, kind: "response", state: "completed", status: 200, upstreamProvider,
      responseModels: ["requested"], payload: payload(response.length, request.length) },
  ].map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
}

describe("webui server data API", () => {
  it("filters and exports persisted review facts without classifying unknown requests as ordinary", async () => {
    const fixture = createFixture();
    const identities = { requestPurpose: "autoApprovalReview" as const,
      reviewerThreadId: "reviewer", reviewerTurnId: "review-turn" };
    recordSample(fixture.databasePath, { ...metricSample(), ...identities });
    recordSample(fixture.databasePath, metricSample());
    const { origin } = await startServer(fixture.environment);
    for (const path of ["requests", "requests/export"]) {
      const response = await fetch(`${origin}/api/v1/${path}?range=all&requestPurpose=autoApprovalReview`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ total: 1, records: [{ ...identities, traffic: null }] });
    }
    const all = await fetch(`${origin}/api/v1/requests?range=all`);
    expect(await all.json()).toMatchObject({ total: 2, records: expect.arrayContaining([
      expect.objectContaining({ requestPurpose: null, reviewerThreadId: null, reviewerTurnId: null }),
    ]) });
    for (const purpose of ["ordinary", "guardian", "null", ""]) {
      const response = await fetch(`${origin}/api/v1/requests?range=all&requestPurpose=${purpose}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_filter" } });
    }
  });
  it("returns paired cache coverage without inventing a complete rate for complementary missing fields", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const request = metricSample();
    store.recordBatch([
      { ...request, inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 },
      { ...request, inputTokens: 200, cachedInputTokens: null, outputTokens: 20 },
      { ...request, inputTokens: null, cachedInputTokens: 10, outputTokens: null,
        status: "failed", errorType: "client_disconnected" },
    ]);
    store.close();
    const { origin } = await startServer(fixture.environment);
    const response = await fetch(`${origin}/api/v1/threads/thread-1/turns?range=all`);
    expect(response.status).toBe(200);
    const aggregate = { requestCount: 3, inputTokens: 300, cachedInputTokens: null, outputTokens: 30,
      cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: 2 } };
    expect(await response.json()).toMatchObject({
      turns: [{ turnId: "turn-1", inputTokens: 300, cachedInputTokens: null,
        interruptionSummary: { usageUnobserved: 1 } }], aggregate, treeAggregate: aggregate,
    });
  });

  it("returns an empty global subagent page when no relationships are registered", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    store.close();
    const { origin } = await startServer(fixture.environment);
    const response = await fetch(`${origin}/api/v1/subagents`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generatedAt: expect.any(String), subagents: [], modelUsage: [], total: 0, offset: 0, limit: 20, nextOffset: null,
    });
  });

  it("returns complete model usage across subagent pages and exact parent Turn scopes", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    store.recordBatch([
      { ...metricSample(), threadId: "child-a", model: "alpha", inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 },
      { ...metricSample(), threadId: "child-a", model: "beta", inputTokens: 200, cachedInputTokens: null, outputTokens: 20 },
      { ...metricSample(), threadId: "child-b", provider: "other", model: "alpha", inputTokens: 900, cachedInputTokens: 0, outputTokens: 90 },
      { ...metricSample(), threadId: "nested", model: "alpha", inputTokens: 1000, cachedInputTokens: 500, outputTokens: 100 },
    ]);
    for (const [agentThreadId, parentThreadId, parentTurnId] of [
      ["child-a", "root", "first"], ["child-b", "root", "second"], ["nested", "child-a", "first"],
    ] as const) {
      store.recordSubagentThread({ agentThreadId, parentThreadId, parentTurnId, agentPath: `/root/${agentThreadId}` });
      store.recordSubagentTurn({ agentThreadId, agentTurnId: "agent-turn", parentThreadId, parentTurnId, agentPath: `/root/${agentThreadId}` });
    }
    store.close();
    const { origin } = await startServer(fixture.environment);
    const read = async (path: string) => {
      const response = await fetch(`${origin}/api/v1/${path}`);
      expect(response.status).toBe(200);
      return response.json();
    };
    const modelUsage = [
      { model: "alpha", inputTokens: 1000, outputTokens: 100,
        cacheUsage: { inputTokens: 1000, cachedInputTokens: 50, missingRequestCount: 0 } },
      { model: "beta", inputTokens: 200, outputTokens: 20,
        cacheUsage: { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 1 } },
    ];
    for (const offset of [0, 1, 9]) {
      expect(await read(`threads/root/subagents?limit=1&offset=${offset}`)).toMatchObject({ total: 2, modelUsage });
    }
    expect(await read("threads/root/subagents?parentTurnId=first&offset=9")).toMatchObject({
      total: 1, subagents: [], modelUsage: [
        { ...modelUsage[0], inputTokens: 100, outputTokens: 10,
          cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: 0 } },
        modelUsage[1],
      ],
    });
    expect(await read("subagents?limit=1&offset=1")).toMatchObject({ total: 3, modelUsage: [
      { model: "alpha", inputTokens: 2000, outputTokens: 200,
        cacheUsage: { inputTokens: 2000, cachedInputTokens: 550, missingRequestCount: 0 } },
      modelUsage[1],
    ] });
    expect(await read("threads/root/subagents?parentTurnId=missing")).toMatchObject({ total: 0, modelUsage: [] });
  });

  it("lists main Threads with separate own and filtered descendant usage while preserving child detail access", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const recordedAtMs = Date.now() - 10_000;
    const current = { ...metricSample(), recordedAtMs, model: "matching" };
    store.recordBatch([
      { ...current, threadId: "root-a" },
      { ...current, threadId: "root-a", turnId: "second", recordedAtMs: recordedAtMs + 100 },
      { ...current, threadId: "root-b", recordedAtMs: recordedAtMs + 200 },
      { ...current, threadId: "root-c", model: "excluded", recordedAtMs: recordedAtMs + 300 },
      { ...current, threadId: "child-a", recordedAtMs: recordedAtMs + 400 },
      { ...current, threadId: "child-b", recordedAtMs: recordedAtMs + 500 },
      { ...current, threadId: "nested", model: "child-only", recordedAtMs: recordedAtMs + 600 },
    ]);
    for (const [agentThreadId, parentThreadId] of [["child-a", "root-a"], ["child-b", "root-a"], ["no-requests", "root-a"], ["nested", "child-a"]] as const) {
      store.recordSubagentThread({ agentThreadId, parentThreadId, parentTurnId: "turn-1", agentPath: `/root/${agentThreadId}` });
    }
    store.close();
    const { origin } = await startServer(fixture.environment);
    const read = async (path: string) => {
      const response = await fetch(`${origin}/api/v1/${path}`);
      expect(response.status).toBe(200);
      return response.json();
    };
    const scope = "range=all&provider=deepseek&model=matching&limit=1";
    const first = await read(`threads?${scope}`);
    expect(first).toMatchObject({ total: 2, turnCount: 3, nextOffset: 1, aggregate: { requestCount: 3, inputTokens: 3000, outputTokens: 300 }, treeAggregate: { requestCount: 5, inputTokens: 5000, outputTokens: 500 }, threads: [{ threadId: "root-b", directSubagentCount: 0, totalTokens: 1100, subagentUsage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 } }] });
    const second = await read(`threads?${scope}&offset=1`);
    expect(second).toMatchObject({ total: 2, turnCount: 3, nextOffset: null, aggregate: first.aggregate, treeAggregate: first.treeAggregate, threads: [{ threadId: "root-a", directSubagentCount: 3, requestCount: 2, inputTokens: 2000, totalTokens: 4400, subagentUsage: { inputTokens: 2000, outputTokens: 200 } }] });
    expect(await read(`threads?${scope}&offset=2`)).toMatchObject({ threads: [], total: 2, aggregate: first.aggregate, treeAggregate: first.treeAggregate });
    expect(await read(`threads?${scope}&sort=totalTokens&direction=desc`)).toMatchObject({ threads: [{ threadId: "root-a", totalTokens: 4400 }] });
    expect(await read(`threads?${scope}&sort=totalTokens&direction=asc`)).toMatchObject({ threads: [{ threadId: "root-b", totalTokens: 1100 }] });
    expect(await read("threads?range=all")).toMatchObject({ total: 3, turnCount: 4, aggregate: { requestCount: 4 }, treeAggregate: { requestCount: 7, inputTokens: 7000 } });
    expect(await read("threads?range=all&model=child-only")).toMatchObject({ threads: [{ threadId: "root-a", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, provider: null, model: null, totalTokens: 1100, subagentUsage: { inputTokens: 1000, outputTokens: 100 } }], total: 1, turnCount: 0, aggregate: null, treeAggregate: { requestCount: 1 } });
    expect(await read("threads?range=all&threadId=root-a&model=child-only")).toMatchObject({ total: 1, treeAggregate: { requestCount: 1, inputTokens: 1000 } });
    expect(await read("threads?range=all&threadId=child-a")).toMatchObject({ threads: [], total: 0 });
    expect(await read("threads/child-a/run")).toMatchObject({ threadId: "child-a", parentThreadId: "root-a", agentPath: "/root/child-a" });
    expect(await read("threads/child-a/turns?range=all")).toMatchObject({
      total: 1, subagentTurnCount: 1, turns: [{ turnId: "turn-1" }], aggregate: { requestCount: 1 },
      subagentAggregate: { requestCount: 1, inputTokens: 1000 },
      treeAggregate: { requestCount: 2, inputTokens: 2000 },
    });
    const detail = await read(`threads/root-a/turns?${scope}`);
    expect(detail).toMatchObject({
      total: 2, turnCount: 2, subagentTurnCount: 2, nextOffset: 1,
      aggregate: { requestCount: 2, inputTokens: 2000 },
      subagentAggregate: { requestCount: 2, inputTokens: 2000 },
      treeAggregate: { requestCount: 4, inputTokens: 4000 },
    });
    expect(await read(`threads/root-a/turns?${scope}&offset=20`)).toMatchObject({
      turns: [], total: 2, subagentTurnCount: 2, aggregate: detail.aggregate,
      subagentAggregate: detail.subagentAggregate, treeAggregate: detail.treeAggregate,
    });
    expect(await read("threads/root-a/turns?range=all&model=child-only")).toMatchObject({
      turns: [], total: 0, turnCount: 0, subagentTurnCount: 1, aggregate: null,
      subagentAggregate: { requestCount: 1, inputTokens: 1000 }, treeAggregate: { requestCount: 1, inputTokens: 1000 },
    });
    expect(await read("threads/root-a/turns?range=all&turnId=turn-1")).toMatchObject({
      turns: [{ turnId: "turn-1" }], total: 1, aggregate: { requestCount: 1 },
      subagentTurnCount: null, subagentAggregate: null, treeAggregate: null,
    });
    expect(await read("threads/root-a/turns?range=all&model=missing")).toMatchObject({
      turns: [], total: 0, subagentTurnCount: 0, aggregate: null, subagentAggregate: null, treeAggregate: null,
    });
    expect(await read("threads/root-a/subagents")).toMatchObject({ total: 3 });
    expect(await read("overview?range=all")).toMatchObject({ threadCount: 6, turnCount: 7, global: { requestCount: 7 } });
    expect((await fetch(`${origin}/api/v1/threads?mainThreadsOnly=false`)).status).toBe(400);
  });

  it("authenticates and pages registered subagents without requiring metric requests", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    store.close();
    const raw = new DatabaseSync(fixture.databasePath);
    const insert = raw.prepare("INSERT INTO subagent_threads (thread_id, parent_thread_id, parent_turn_id, agent_path, recorded_at_ms) VALUES (?, ?, ?, ?, ?)");
    for (const [id, parent, time] of [
      ["child-b", "root", 200], ["child-a", "root", 200], ["older", "root", 100],
      ["nested", "child-a", 300], ["deeper", "nested", 400], ["unrelated", "other", 500],
    ] as const) insert.run(id, parent, id === "child-a" ? null : "parent-turn", `/root/${id}`, time);
    raw.close();
    const { origin } = await startServer(fixture.environment, undefined, { token: "subagent-token" });
    const url = `${origin}/api/v1/threads/root/subagents`;
    const globalUrl = `${origin}/api/v1/subagents`;
    const headers = { authorization: "Bearer subagent-token" };
    expect((await fetch(url)).status).toBe(401);
    expect((await fetch(url, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(url, { headers, method: "POST" })).status).toBe(405);
    expect((await fetch(globalUrl)).status).toBe(401);
    expect((await fetch(globalUrl, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await fetch(globalUrl, { headers, method: "POST" })).status).toBe(405);
    const defaults = await fetch(url, { headers });
    expect(defaults.status).toBe(200);
    expect(await defaults.json()).toMatchObject({
      generatedAt: expect.any(String), threadId: "root", total: 3, offset: 0, limit: 20, nextOffset: null,
      subagents: [
        { threadId: "child-a", parentThreadId: "root", parentTurnId: null, agentPath: "/root/child-a", recordedAtMs: 200, directSubagentCount: 1,
          provider: null, model: null, turnCount: 0, requestCount: 0, inputTokens: 0, outputTokens: 0,
          firstRequestStartedAtMs: null, lastRecordedAtMs: null,
          cacheUsage: { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 0 } },
        { threadId: "child-b", directSubagentCount: 0 }, { threadId: "older", directSubagentCount: 0 },
      ],
    });
    expect(await (await fetch(`${url}?limit=1`, { headers })).json()).toMatchObject({
      total: 3, offset: 0, limit: 1, nextOffset: 1, subagents: [{ threadId: "child-a" }],
    });
    expect(await (await fetch(`${url}?offset=1&limit=2`, { headers })).json()).toMatchObject({
      total: 3, offset: 1, limit: 2, nextOffset: null, subagents: [{ threadId: "child-b" }, { threadId: "older" }],
    });
    expect(await (await fetch(`${url}?offset=10`, { headers })).json()).toMatchObject({ total: 3, subagents: [], nextOffset: null });
    expect(await (await fetch(`${origin}/api/v1/threads/missing/subagents`, { headers })).json()).toMatchObject({ total: 0, subagents: [] });
    const global = await (await fetch(globalUrl, { headers })).json();
    expect(global).toMatchObject({ generatedAt: expect.any(String), total: 6, offset: 0, limit: 20, nextOffset: null });
    expect(global).not.toHaveProperty("threadId");
    expect(global.subagents).toMatchObject([
      { threadId: "child-a", parentThreadId: "root", requestCount: 0 },
      { threadId: "child-b", parentThreadId: "root", requestCount: 0 },
      { threadId: "deeper", parentThreadId: "nested", requestCount: 0 },
      { threadId: "nested", parentThreadId: "child-a", requestCount: 0 },
      { threadId: "older", parentThreadId: "root", requestCount: 0 },
      { threadId: "unrelated", parentThreadId: "other", requestCount: 0 },
    ]);
    expect(await (await fetch(`${globalUrl}?offset=2&limit=2`, { headers })).json()).toMatchObject({
      total: 6, offset: 2, limit: 2, nextOffset: 4, subagents: [{ threadId: "deeper" }, { threadId: "nested" }],
    });
    expect(await (await fetch(`${globalUrl}?offset=10`, { headers })).json()).toMatchObject({ total: 6, subagents: [], nextOffset: null });
    recordSample(fixture.databasePath, { ...metricSample(), threadId: "root", provider: "matching", recordedAtMs: Date.now() - 1000 });
    expect(await (await fetch(`${origin}/api/v1/threads?range=all&provider=matching`, { headers })).json()).toMatchObject({
      total: 1, threads: [{ threadId: "root", directSubagentCount: 3 }],
    });
    for (const query of ["range=all", "provider=matching", "sort=time", "threadId=root", "offset=0&offset=1", "limit=1&limit=2", "sortKey=time&sortKey=last", "sortDirection=asc&sortDirection=desc", "sortKey=requests", "sortDirection=invalid", "sortKey=", "sortDirection=", "offset=-1", "offset=1.5", "offset=9007199254740992", "limit=0", "limit=101", "limit=", "limit=no"]) {
      expect((await fetch(`${url}?${query}`, { headers })).status, query).toBe(400);
      expect((await fetch(`${globalUrl}?${query}`, { headers })).status, query).toBe(400);
    }
    expect((await fetch(`${origin}/api/v1/threads/${"x".repeat(129)}/subagents`, { headers })).status).toBe(400);
  });

  it("filters direct subagents by exact parent Turn associations and validates the scoped query", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    for (const [agentThreadId, parentThreadId, parentTurnId] of [
      ["child-a", "root", "spawn"], ["child-b", "root", "first"], ["child-c", "root", "second"],
      ["spawn-only", "root", "first"], ["nested", "child-a", "first"], ["unrelated", "other", "first"],
    ] as const) {
      store.recordSubagentThread({ agentThreadId, parentThreadId, parentTurnId, agentPath: `/root/${agentThreadId}` });
    }
    for (const [agentThreadId, agentTurnId, parentThreadId, parentTurnId] of [
      ["child-a", "agent-first", "root", "first"], ["child-a", "agent-first-again", "root", "first"],
      ["child-a", "agent-second", "root", "second"], ["child-b", "agent-first", "root", "first"],
      ["child-c", "agent-second", "root", "second"], ["nested", "agent-first", "child-a", "first"],
      ["unrelated", "agent-first", "other", "first"],
    ] as const) {
      store.recordSubagentTurn({ agentThreadId, agentTurnId, parentThreadId, parentTurnId, agentPath: `/root/${agentThreadId}` });
    }
    store.close();
    const { origin } = await startServer(fixture.environment);
    const url = `${origin}/api/v1/threads/root/subagents`;
    const read = async (query: string) => {
      const response = await fetch(`${url}?${query}`);
      expect(response.status).toBe(200);
      return response.json();
    };
    expect(await read("parentTurnId=first")).toMatchObject({
      threadId: "root", total: 2, offset: 0, limit: 20, nextOffset: null,
      subagents: [{ threadId: "child-a", requestCount: 0 }, { threadId: "child-b", requestCount: 0 }],
    });
    expect(await read("parentTurnId=second")).toMatchObject({
      total: 2, subagents: [{ threadId: "child-a" }, { threadId: "child-c" }],
    });
    expect(await read("parentTurnId=first&limit=1")).toMatchObject({
      total: 2, offset: 0, limit: 1, nextOffset: 1, subagents: [{ threadId: "child-a" }],
    });
    expect(await read("parentTurnId=first&offset=1&limit=1&sortKey=time&sortDirection=asc")).toMatchObject({
      total: 2, offset: 1, limit: 1, nextOffset: null, subagents: [{ threadId: "child-b" }],
    });
    expect(await read("parentTurnId=missing")).toMatchObject({ total: 0, subagents: [], nextOffset: null });
    expect(await read("parentTurnId=FIRST")).toMatchObject({ total: 0, subagents: [] });
    expect(await read("parentTurnId=first&offset=10")).toMatchObject({ total: 2, subagents: [], nextOffset: null });
    expect(await (await fetch(`${origin}/api/v1/threads/other/subagents?parentTurnId=first`)).json()).toMatchObject({
      total: 1, subagents: [{ threadId: "unrelated" }],
    });
    expect(await (await fetch(url)).json()).toMatchObject({ total: 4 });
    for (const query of ["parentTurnId=", "parentTurnId=%20", `parentTurnId=${"x".repeat(129)}`]) {
      const response = await fetch(`${url}?${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "invalid_parent_turn_id" } });
    }
    const duplicate = await fetch(`${url}?parentTurnId=first&parentTurnId=second`);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toMatchObject({ error: { code: "invalid_parameter" } });
    for (const query of ["turnId=first", "parentThreadId=root", "parentTurnId=first&provider=matching"]) {
      const response = await fetch(`${url}?${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "unsupported_parameter" } });
    }
    const global = await fetch(`${origin}/api/v1/subagents?parentTurnId=first`);
    expect(global.status).toBe(400);
    expect(await global.json()).toMatchObject({ error: { code: "unsupported_parameter" } });
  });

  it("keeps observed own and descendant cache usage after requests without usage fail", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const current = { ...metricSample(), recordedAtMs: Date.now() - 1000 };
    store.recordBatch([
      { ...current, threadId: "root", inputTokens: 100, cachedInputTokens: 80, outputTokens: 10 },
      { ...current, threadId: "child", inputTokens: 200, cachedInputTokens: 150, outputTokens: 20 },
      { ...current, threadId: "nested", inputTokens: 300, cachedInputTokens: 0, outputTokens: 30 },
      ...["root", "child"].map((threadId) => ({
        ...current, threadId, status: "failed" as const, errorType: "client_disconnected",
        inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null,
      })),
      { ...current, threadId: "nested", inputTokens: null, cachedInputTokens: 50, outputTokens: null },
    ]);
    for (const [agentThreadId, parentThreadId] of [["child", "root"], ["nested", "child"]] as const) {
      store.recordSubagentThread({ agentThreadId, parentThreadId, parentTurnId: "turn-1", agentPath: `/root/${agentThreadId}` });
    }
    store.close();
    const { origin } = await startServer(fixture.environment);
    const response = await fetch(`${origin}/api/v1/threads?range=all`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      total: 1,
      threads: [{
        threadId: "root", inputTokens: 100, cachedInputTokens: null, outputTokens: 10, totalTokens: 660,
        cacheUsage: { inputTokens: 100, cachedInputTokens: 80, missingRequestCount: 1 },
        subagentUsage: { inputTokens: 500, cachedInputTokens: null, outputTokens: 50,
          cacheUsage: { inputTokens: 500, cachedInputTokens: 150, missingRequestCount: 2 } },
      }],
    });
  });

  it("returns child metrics and pages by request times without including descendant requests", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const now = Date.now();
    store.recordBatch([
      { ...metricSample(), threadId: "child-a", provider: "old", model: "old", requestStartedAtMs: now - 3000, recordedAtMs: now - 2000, inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 },
      { ...metricSample(), threadId: "child-a", turnId: "second", provider: "latest", model: "latest", requestStartedAtMs: now - 2000, recordedAtMs: now - 1000, inputTokens: 200, cachedInputTokens: null, outputTokens: 20 },
      { ...metricSample(), threadId: "child-b", requestStartedAtMs: now - 4000, recordedAtMs: now - 3000 },
      { ...metricSample(), threadId: "nested", provider: "nested", model: "nested", requestStartedAtMs: now - 5000, recordedAtMs: now, inputTokens: 9000, outputTokens: 900 },
    ]);
    for (const [agentThreadId, parentThreadId] of [["child-a", "root"], ["child-b", "root"], ["no-requests", "root"], ["nested", "child-a"]] as const) {
      store.recordSubagentThread({ agentThreadId, parentThreadId, parentTurnId: "parent", agentPath: `/root/${agentThreadId}` });
    }
    store.close();
    const { origin } = await startServer(fixture.environment);
    const url = `${origin}/api/v1/threads/root/subagents`;
    expect(await (await fetch(`${url}?limit=1`)).json()).toMatchObject({
      total: 3, nextOffset: 1, subagents: [{ threadId: "child-a", provider: "latest", model: "latest",
        turnCount: 2, requestCount: 2, inputTokens: 300, outputTokens: 30,
        firstRequestStartedAtMs: now - 3000, lastRecordedAtMs: now - 1000,
        cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: 1 } }],
    });
    expect(await (await fetch(`${url}?sortKey=time&sortDirection=asc&limit=1`)).json()).toMatchObject({
      total: 3, nextOffset: 1, subagents: [{ threadId: "child-b" }],
    });
    expect(await (await fetch(`${url}?sortKey=last&sortDirection=asc&offset=1&limit=1`)).json()).toMatchObject({
      total: 3, nextOffset: 2, subagents: [{ threadId: "child-a" }],
    });
    expect(await (await fetch(`${url}?sortKey=time&sortDirection=desc&offset=2`)).json()).toMatchObject({
      total: 3, nextOffset: null, subagents: [{ threadId: "no-requests", firstRequestStartedAtMs: null, lastRecordedAtMs: null }],
    });
    const globalUrl = `${origin}/api/v1/subagents`;
    expect(await (await fetch(`${globalUrl}?limit=1`)).json()).toMatchObject({
      total: 4, nextOffset: 1, subagents: [{ threadId: "nested", parentThreadId: "child-a", requestCount: 1, inputTokens: 9000 }],
    });
    expect(await (await fetch(`${globalUrl}?offset=1&limit=1`)).json()).toMatchObject({
      total: 4, nextOffset: 2, subagents: [{ threadId: "child-a", requestCount: 2, inputTokens: 300, outputTokens: 30 }],
    });
    expect(await (await fetch(`${globalUrl}?sortKey=time&sortDirection=asc&limit=1`)).json()).toMatchObject({
      total: 4, nextOffset: 1, subagents: [{ threadId: "nested" }],
    });
    expect(await (await fetch(`${globalUrl}?sortKey=last&sortDirection=asc&limit=1`)).json()).toMatchObject({
      total: 4, nextOffset: 1, subagents: [{ threadId: "child-b" }],
    });
    expect(await (await fetch(`${globalUrl}?sortKey=time&sortDirection=desc&offset=3`)).json()).toMatchObject({
      total: 4, nextOffset: null, subagents: [{ threadId: "no-requests", firstRequestStartedAtMs: null, lastRecordedAtMs: null }],
    });
  });

  it("exposes own session timing on main Threads independently of the request range and model", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const now = Date.now();
    for (const threadId of ["complete", "partial", "missing"]) {
      store.record({ ...metricSample(), threadId, model: "matching", recordedAtMs: now - 1000 });
    }
    store.replaceThreadExecutions("complete", "deepseek", [
      { turnId: "turn-1", durationMs: 100, recordedAtMs: now - 1000 },
      { turnId: "older", durationMs: 200, recordedAtMs: now - 100_000 },
    ]);
    store.replaceThreadExecutions("partial", "deepseek", [
      { turnId: "turn-1", durationMs: 400, recordedAtMs: now - 1000 },
      { turnId: "missing-turn", durationMs: null, recordedAtMs: now - 1000 },
    ]);
    store.recordSubagentThread({ agentThreadId: "child", parentThreadId: "complete", parentTurnId: "older", agentPath: "/root/child" });
    store.replaceThreadExecutions("child", "deepseek", [{ turnId: "child-turn", durationMs: 9000, recordedAtMs: now - 1000 }]);
    store.close();
    const { origin } = await startServer(fixture.environment);
    const response = await fetch(`${origin}/api/v1/threads?range=24h&model=matching`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ total: 3, threads: expect.arrayContaining([
      { threadId: "complete", sessionTiming: { knownDurationMs: 300, missingTurnCount: 0, historyComplete: true } },
      { threadId: "partial", sessionTiming: { knownDurationMs: 400, missingTurnCount: 1, historyComplete: true } },
      { threadId: "missing", sessionTiming: { knownDurationMs: null, missingTurnCount: 0, historyComplete: false } },
    ].map((thread) => expect.objectContaining(thread))) });
  });

  it("notifies authenticated readers only after metrics commit and closes on writer shutdown", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const events = new QueueEventsServer(metricsEventsPath(configPath));
    const writer = new BufferedModelRequestMetricsWriter(new SqliteModelRequestMetricsStore(fixture.databasePath), undefined, () => events.changed());
    const controller = new AbortController();
    let receiving: Promise<void> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await events.start();
      const { origin } = await startServer(fixture.environment, undefined, { token: "webui-token" });
      const url = `${origin}/api/v1/metrics/events`, headers = { authorization: "Bearer webui-token" };
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(`${url}?token=webui-token`, { headers })).status).toBe(400);
      const response = await fetch(url, { headers, signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      reader = response.body!.getReader();
      let received = "";
      const decoder = new TextDecoder();
      receiving = (async () => {
        try { while (true) {
          const chunk = await reader!.read();
          if (chunk.done) return;
          received += decoder.decode(chunk.value, { stream: true });
        } } catch (error) { if (!controller.signal.aborted) throw error; }
      })();
      await expect.poll(() => (received.match(/"changed"/gu) ?? []).length).toBe(1);
      writer.enqueue(metricSample());
      expect(await writer.waitForCurrentWrites()).toBe(true);
      await expect.poll(() => (received.match(/"changed"/gu) ?? []).length).toBe(2);
      const snapshot = await fetch(`${origin}/api/v1/requests?range=all`, { headers });
      expect(await snapshot.json()).toMatchObject({ total: 1 });
      expect(received).not.toContain("webui-token");
      expect(received).not.toContain(metricSample().provider);
      await events.close();
      await receiving;
      expect(received).toContain('"unavailable"');
    } finally {
      controller.abort(); await receiving; reader?.releaseLock();
      await writer.close(); await events.close();
    }
  });

  it("does not expose a separate metrics-only detail endpoint", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);
    expect((await fetch(`${origin}/api/v1/requests/1`)).status).toBe(404);
  });

  it("filters relay requests by real caller with null Thread/Turn and separate delivery", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, { ...metricSample(), source: "relay", callerId: "client", keyId: "key",
      credentialGeneration: 2, relayRequestId: "8a13f205-1387-48a9-8cec-efce153a8210", deliveryStatus: "disconnected",
      provider: "clp-test", transport: "http", operation: "response", threadId: null, turnId: null, traffic: null });
    const { origin } = await startServer(fixture.environment);
    const response = await fetch(`${origin}/api/v1/requests?range=all&source=relay&callerId=client`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ records: [{ source: "relay", callerId: "client", threadId: null, turnId: null, deliveryStatus: "disconnected" }] });
    const owned = await fetch(`${origin}/api/v1/requests?range=all&source=owned`);
    expect(await owned.json()).toMatchObject({ records: [] });
    expect((await fetch(`${origin}/api/v1/requests?source=other`)).status).toBe(400);
    appendFileSync(join(fixture.home, "config.toml"), `\n[[model_relay.callers]]\ncaller_id = "client"\nkey_id = "key"\nmodels = ["clp-test/fixture"]\ncredential_generation = 2\nsecret_sha256 = "${"a".repeat(64)}"\nenabled = false\ndisplay_name = "沉浸式翻译"\n`);
    const named = await fetch(`${origin}/api/v1/requests?range=all&source=relay&callerId=client`);
    expect(named.status).toBe(200);
    expect(await named.json()).toMatchObject({ records: [{ callerId: "client", callerDisplayName: "沉浸式翻译" }] });
    const configPath = join(fixture.home, "config.toml");
    const configuration = readFileSync(configPath, "utf8");
    writeFileSync(configPath, configuration.replace('display_name = "沉浸式翻译"', 'display_name = "网页翻译"'));
    const renamed = await fetch(`${origin}/api/v1/requests?range=all&source=relay`);
    expect(await renamed.json()).toMatchObject({ records: [{ callerId: "client", callerDisplayName: "网页翻译" }] });
    writeFileSync(configPath, configuration.replace('models = ["clp-test/fixture"]', 'models = ["clp-other/fixture"]'));
    const rebound = await fetch(`${origin}/api/v1/requests?range=all&source=relay`);
    expect(await rebound.json()).toMatchObject({ records: [{ callerId: "client", callerDisplayName: "沉浸式翻译" }] });
    for (const changed of [configuration.replace('key_id = "key"', 'key_id = "other-key"'), configuration.replace('caller_id = "client"', 'caller_id = "other-client"')]) {
      writeFileSync(configPath, changed);
      const mismatched = await fetch(`${origin}/api/v1/requests?range=all&source=relay`);
      expect(mismatched.status).toBe(200);
      const result = await mismatched.json() as { records: Array<{ callerId: string; callerDisplayName?: string }> };
      expect(result.records[0]?.callerId).toBe("client");
      expect(result.records[0]).not.toHaveProperty("callerDisplayName");
    }
  });
  it("returns the server time zone before a metrics database exists", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);
    const before = Date.now();
    const response = await fetch(`${origin}/api/v1/time`);
    expect(response.status).toBe(200);
    const result = await response.json() as { timeZone: string; nowMs: number };
    expect(result.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(result.nowMs).toBeGreaterThanOrEqual(before);
    expect(result.nowMs).toBeLessThanOrEqual(Date.now());
    expect((await fetch(`${origin}/api/v1/time?timeZone=UTC`)).status).toBe(400);
  });
  it("returns persisted TTFT in request details and export with missing values left null", async () => {
    const fixture = createFixture();
    const generationTiming = { reasoningMs: 100, textMs: 200, toolMs: 300, totalMs: 600 };
    const traffic = { label: "openai", session: "2026-09-19T00-00-00-000Z-2", interaction: 4 };
    recordSample(fixture.databasePath, {
      ...metricSample(), provider: "openai", upstreamTtftMs: 569.25,
      responseTimeMs: 10, generationTiming,
      requestServiceTier: "priority", serviceTier: "default",
      upstreamProvider: "deepseek", upstreamAttemptCount: 3, modelAttemptCount: 2, finishReason: "stop", errorStage: "stream", upstreamErrorCode: "rate_limit_exceeded", upstreamErrorType: "rate_limit_error", upstreamHttpStatus: 429, responseUsageAmount: "0.12345678901234567890", firstTokenMs: 12.5, totalDurationMs: 1234.5, outputTokens: 1_000, requestModel: "requested", responseModel: "echoed", traffic,
    });
    recordSample(fixture.databasePath, metricSample());
    const { origin } = await startServer(fixture.environment);
    for (const path of ["requests", "requests/export"]) {
      const response = await fetch(`${origin}/api/v1/${path}?range=all`);
      expect(response.status).toBe(200);
      const body = await response.json() as { records: Array<{ provider: string; upstreamTtftMs: number | null }> };
      expect(body.records.find((row) => row.provider === "openai")?.upstreamTtftMs).toBe(569.25);
      expect(body.records.find((row) => row.provider === "openai")).toMatchObject({
        responseTimeMs: 10, generationTiming,
        upstreamProvider: "deepseek", upstreamAttemptCount: 3, modelAttemptCount: 2, finishReason: "stop", errorStage: "stream", upstreamErrorCode: "rate_limit_exceeded", upstreamErrorType: "rate_limit_error", upstreamHttpStatus: 429, responseUsageAmount: "0.12345678901234567890", firstTokenMs: 12.5, totalDurationMs: 1234.5, requestModel: "requested", responseModel: "echoed", traffic,
        requestServiceTier: "priority", serviceTier: "default",
      });
      expect(body.records.find((row) => row.provider === "deepseek")).toMatchObject({
        responseTimeMs: null, generationTiming: null,
        responseUsageAmount: null, firstTokenMs: null, totalDurationMs: null, requestModel: null, responseModel: null, traffic: null,
        requestServiceTier: null,
      });
      expect(body.records.find((row) => row.provider === "deepseek")?.upstreamTtftMs).toBeNull();
    }
    const sorted = await fetch(`${origin}/api/v1/requests?range=all&sort=totalDuration&direction=desc`);
    expect(sorted.status).toBe(200);
    expect(((await sorted.json()) as { records: Array<{ totalDurationMs: number | null }> }).records[0]?.totalDurationMs).toBe(1234.5);
    for (const path of ["requests", "threads", "threads/thread-1/turns"]) {
      for (const sort of ["tokensPerSecond", "generationTokensPerSecond"]) {
        const response = await fetch(`${origin}/api/v1/${path}?range=all&sort=${sort}&direction=desc`);
        expect(response.status).toBe(400);
      }
    }
  });
  it("serves metrics without joining optional traffic indexes", async () => {
    const fixture = createFixture();
    const session = "2026-09-19T00-00-00-000Z-2";
    recordSample(fixture.databasePath, { ...metricSample(), provider: "clp", traffic: { label: "openai", session, interaction: 4 } });
    writeCallIndex(fixture, session, 4, "deepseek");
    const { origin } = await startServer(fixture.environment);
    const list = await fetch(`${origin}/api/v1/requests?range=all`);
    expect(list.status).toBe(200);
    const record = ((await list.json()) as { records: Array<{ upstreamProvider?: string }> }).records[0];
    expect(record).toHaveProperty("upstreamProvider", null);
    const exported = await fetch(`${origin}/api/v1/requests/export?range=all`);
    expect(exported.status).toBe(200);
    const exportedRecord = ((await exported.json()) as { records: Array<{ upstreamProvider?: string }> }).records[0];
    expect(exportedRecord).toHaveProperty("upstreamProvider", null);
  });
  it.each(["missing", "not-directory", "invalid-index"])("keeps requests, errors and export usable with unavailable capture: %s", async state => {
    const fixture = createFixture();
    const session = "broken-capture";
    recordSample(fixture.databasePath, { ...metricSample(), status: "failed", httpStatus: 502, upstreamProvider: "deepseek", upstreamAttemptCount: 2,
      traffic: { label: "openai", session, interaction: 1 } });
    if (state === "not-directory") writeFileSync(join(fixture.home, "traffic"), "not a dump directory");
    if (state === "invalid-index") {
      writeCallIndex(fixture, session, 1, "must-not-read");
      writeFileSync(join(fixture.home, "traffic", `openai-${session}`, "interactions.jsonl"), "invalid JSON");
    }
    const { origin } = await startServer(fixture.environment);
    for (const path of ["requests", "errors", "requests/export"]) {
      const response = await fetch(`${origin}/api/v1/${path}?range=all`);
      expect(response.status).toBe(200);
      const body = await response.json() as { records: Array<{ status: string; traffic: unknown; upstreamProvider?: string }> };
      expect(body.records).toHaveLength(1);
      expect(body.records[0]).toMatchObject({ status: "failed", traffic: { label: "openai", session, interaction: 1 } });
      expect(body.records[0]).toMatchObject({ upstreamProvider: "deepseek", upstreamAttemptCount: 2 });
    }
  });
  it("keeps serving the request list when the referenced call record is missing", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, {
      ...metricSample(),
      traffic: { label: "openai", session: "2026-09-19T00-00-00-000Z-3", interaction: 9 },
    });
    const { origin } = await startServer(fixture.environment);
    const list = await fetch(`${origin}/api/v1/requests?range=all`);
    expect(list.status).toBe(200);
    const record = ((await list.json()) as { records: Array<{ upstreamProvider?: string }> }).records[0];
    expect(record).toHaveProperty("upstreamProvider", null);
  });
  it("serves errors independently of optional traffic indexes", async () => {
    const fixture = createFixture();
    const session = "2026-09-19T00-00-00-000Z-5";
    recordSample(fixture.databasePath, {
      ...metricSample(),
      status: "failed",
      httpStatus: 502,
      errorType: "http_error",
      traffic: { label: "openai", session, interaction: 7 },
    });
    writeCallIndex(fixture, session, 7, "deepseek");
    const { origin } = await startServer(fixture.environment);
    const errors = await fetch(`${origin}/api/v1/errors?range=all`);
    expect(errors.status).toBe(200);
    const record = ((await errors.json()) as { records: Array<{ upstreamProvider?: string }> }).records[0];
    expect(record).toHaveProperty("upstreamProvider", null);
  });
  it("preserves every Provider in API parameters and scoped navigation links", () => {
    const query = { range: "30d" as const, provider: ["openai", "custom,provider"], offset: 50, limit: 50, sort: "input" };
    expect(new URLSearchParams(metricsQueryParams(query)).getAll("provider")).toEqual(query.provider);
    const link = metricsLink("/requests", query, { threadId: "thread-1", turnId: "turn-2" });
    const params = new URLSearchParams(link.split("?")[1]);
    expect(params.getAll("provider")).toEqual(query.provider);
    expect(params.get("threadId")).toBe("thread-1");
    expect(params.get("turnId")).toBe("turn-2");
    for (const key of ["offset", "limit", "sort"]) expect(params.has(key)).toBe(false);
    expect(metricsQueryParams({ provider: [] })).toBe("");
    expect(metricsLink("/requests", query, { provider: [] })).not.toContain("provider=");
  });

  it("lists every recorded Provider without the overview group limit", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const providers = Array.from({ length: 25 }, (_, index) => `provider-${String(index).padStart(2, "0")}`);
    store.recordBatch(providers.map((provider) => ({ ...metricSample(), provider })));
    store.record(metricSample());
    store.record(metricSample());
    store.close();
    const { origin } = await startServer(fixture.environment);
    const response = await fetch(`${origin}/api/v1/providers`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: ["deepseek", ...providers] });
    expect((await fetch(`${origin}/api/v1/providers?range=30d`)).status).toBe(400);
  });

  it("combines multiple Providers before filtering, pagination, aggregation and export", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const current = { ...metricSample(), recordedAtMs: Date.now() - 1_000, model: "matching" };
    store.recordBatch([
      { ...current, provider: "deepseek" },
      { ...current, provider: "openai", turnId: "turn-2", status: "failed" },
      { ...current, provider: "other" },
      { ...current, provider: "openai", model: "excluded" },
    ]);
    store.close();
    const { origin } = await startServer(fixture.environment);
    const scope = "range=all&provider=deepseek&provider=openai&provider=deepseek&model=matching";
    const read = async (path: string) => {
      const response = await fetch(`${origin}/api/v1/${path}`);
      expect(response.status).toBe(200);
      return response.json();
    };
    const first = await read(`requests?${scope}&limit=1`);
    const second = await read(`requests?${scope}&limit=1&offset=1`);
    expect(first).toMatchObject({ total: 2, nextOffset: 1, aggregate: { requestCount: 2, unsuccessfulRequestCount: 1 } });
    expect(second).toMatchObject({ total: 2, nextOffset: null, aggregate: first.aggregate });
    expect([first.records[0].provider, second.records[0].provider].sort()).toEqual(["deepseek", "openai"]);
    const exported = await read(`requests/export?${scope}`);
    expect(exported.filters.provider).toEqual(["deepseek", "openai"]);
    expect(exported.records).toEqual([...first.records, ...second.records]);
    expect(exported.aggregate).toEqual(first.aggregate);
    expect(await read(`threads?${scope}`)).toMatchObject({ total: 1, turnCount: 2, aggregate: first.aggregate });
    expect(await read(`threads/thread-1/turns?${scope}`)).toMatchObject({ total: 2, aggregate: first.aggregate });
    expect(await read(`errors?${scope}`)).toMatchObject({ total: 1, errors: { requestCount: 2, unsuccessfulRequestCount: 1 } });
    expect(await read(`requests?range=all`)).toMatchObject({ total: 4 });
    for (const invalid of ["provider=", "provider=openai&provider=%20", `provider=${"x".repeat(129)}`]) {
      expect((await fetch(`${origin}/api/v1/requests?${invalid}`)).status).toBe(400);
    }
  });

  it("counts Provider Threads and Turns independently within the selected range", async () => {
    const fixture = createFixture();
    const nowMs = Date.now();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const current = { ...metricSample(), recordedAtMs: nowMs - 1_000 };
    store.recordBatch([
      current,
      current,
      { ...current, turnId: "turn-2" },
      { ...current, threadId: "subagent-1" },
      { ...current, threadId: "no-turn", turnId: null },
      { ...current, provider: "openai" },
      { ...current, provider: "unbound", threadId: null, turnId: null },
      { ...current, threadId: "older-thread", recordedAtMs: nowMs - 2 * 86_400_000 },
    ]);
    store.recordSubagentThread({ agentThreadId: "subagent-1", parentThreadId: "thread-1", parentTurnId: "turn-1", agentPath: "/root/child" });
    store.close();
    const { origin } = await startServer(fixture.environment);
    for (const [range, threadCount, turnCount] of [["24h", 2, 3], ["7d", 3, 4]] as const) {
      const response = await fetch(`${origin}/api/v1/overview?range=${range}`);
      expect(response.status).toBe(200);
      const overview = await response.json();
      expect(overview).toMatchObject({ threadCount, turnCount });
      expect(overview.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider: "deepseek", threadCount, turnCount }),
        expect.objectContaining({ provider: "openai", threadCount: 1, turnCount: 1 }),
        expect.objectContaining({ provider: "unbound", threadCount: 0, turnCount: 0, aggregate: expect.objectContaining({ requestCount: 1 }) }),
      ]));
      for (const group of overview.providers) {
        const threads = await (await fetch(`${origin}/api/v1/threads?range=${range}&provider=${group.provider}&limit=1`)).json();
        const childCount = group.provider === "deepseek" ? 1 : 0;
        expect(threads.total).toBe(group.threadCount - childCount);
        expect(threads.turnCount).toBe(group.turnCount - childCount);
        expect(threads.threads.every((thread: { parentThreadId: string | null }) => thread.parentThreadId === null)).toBe(true);
      }
    }
  });

  it("keeps calendar-day and custom-date totals aligned across dashboard and detail queries", async () => {
    const fixture = createFixture();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const date = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    store.recordBatch([
      { ...metricSample(), recordedAtMs: yesterday.getTime() - 1 },
      { ...metricSample(), recordedAtMs: yesterday.getTime(), status: "failed" },
      { ...metricSample(), recordedAtMs: today.getTime() - 1, turnId: "turn-2" },
      { ...metricSample(), recordedAtMs: today.getTime(), threadId: "today-thread" },
    ]);
    store.close();
    const { origin } = await startServer(fixture.environment);
    for (const scope of ["range=yesterday", `from=${date}&to=${date}`]) {
      const read = async (path: string) => {
        const response = await fetch(`${origin}/api/v1/${path}?${scope}`);
        expect(response.status).toBe(200);
        return response.json();
      };
      const overview = await read("overview");
      expect(overview).toMatchObject({ threadCount: 1, turnCount: 2, global: { requestCount: 2 } });
      expect(overview.range).toMatchObject({ startAtMs: yesterday.getTime(), endAtMs: today.getTime() });
      const daily = await read("daily");
      expect(daily.daily.reduce((sum: number, row: { requestCount: number }) => sum + row.requestCount, 0)).toBe(2);
      expect(daily.daily).toHaveLength(1);
      expect(daily.daily[0]).toMatchObject({ day: date, requestCount: 2 });
      expect(daily.range).toEqual(overview.range);
      expect(overview.trend).toMatchObject({ range: overview.range, generatedAt: overview.generatedAt, granularity: "hour" });
      expect(overview.trend.hourly).toHaveLength(24);
      expect(overview.trend.hourly[0]).toMatchObject({ hour: `${date} 00:00`, requestCount: 1 });
      expect(overview.trend.hourly[23]).toMatchObject({ hour: `${date} 23:00`, requestCount: 1 });
      expect(overview.trend.hourly[12]).toMatchObject({ requestCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
      for (const key of ["requestCount", "inputTokens", "outputTokens"]) {
        expect(overview.trend.hourly.reduce((sum: number, row: Record<string, number>) => sum + row[key]!, 0)).toBe(overview.global[key]);
      }
      expect(overview.heatmap.generatedAt).toBe(overview.generatedAt);
      expect(await read("threads")).toMatchObject({ total: 1, turnCount: 2 });
      expect(await read("threads/thread-1/turns")).toMatchObject({ total: 2 });
      expect(await read("requests")).toMatchObject({ total: 2 });
      expect(await read("errors")).toMatchObject({ total: 1 });
    }
    const current = await (await fetch(`${origin}/api/v1/overview?range=today`)).json();
    expect(current).toMatchObject({ threadCount: 1, turnCount: 1, global: { requestCount: 1 }, range: { startAtMs: today.getTime() } });
    expect(current.trend.range).toEqual(current.range);
    expect(current.heatmap.range.endAtMs).toBe(current.range.endAtMs);
    expect(current.trend.granularity).toBe("hour");
    expect(current.trend.hourly).toHaveLength(new Date(current.range.endAtMs - 1).getHours() + 1);
    expect(current.heatmap.daily.at(-1)).toMatchObject({
      inputTokens: current.global.inputTokens, outputTokens: current.global.outputTokens,
      requestCount: current.global.requestCount,
    });
    for (const key of ["requestCount", "inputTokens", "outputTokens"]) {
      expect(current.trend.hourly.reduce((sum: number, row: Record<string, number>) => sum + row[key]!, 0)).toBe(current.global[key]);
    }
    const multi = await (await fetch(`${origin}/api/v1/overview?range=7d`)).json();
    expect(multi.trend.granularity).toBe("day");
    expect(multi.trend.daily.length).toBeGreaterThan(1);
  });

  it("counts overview Threads and Turns in the selected range without counting requests as turns", async () => {
    const fixture = createFixture();
    const nowMs = Date.now();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    store.recordBatch([
      { ...metricSample(), recordedAtMs: nowMs - 1_000 },
      { ...metricSample(), recordedAtMs: nowMs - 1_000 },
      { ...metricSample(), recordedAtMs: nowMs - 1_000, turnId: "turn-2" },
      { ...metricSample(), recordedAtMs: nowMs - 1_000, threadId: "subagent-1" },
      { ...metricSample(), recordedAtMs: nowMs - 1_000, threadId: null, turnId: null },
      { ...metricSample(), recordedAtMs: nowMs - 1_000, threadId: "no-turn", turnId: null },
      { ...metricSample(), recordedAtMs: nowMs - 2 * 86_400_000, threadId: "older-thread" },
    ]);
    store.recordSubagentThread({ agentThreadId: "subagent-1", parentThreadId: "thread-1", parentTurnId: "turn-1", agentPath: "/root/child" });
    store.close();
    const { origin } = await startServer(fixture.environment);
    for (const [range, threadCount, turnCount] of [["24h", 2, 3], ["7d", 3, 4]] as const) {
      const response = await fetch(`${origin}/api/v1/overview?range=${range}`);
      expect(response.status).toBe(200);
      const overview = await response.json();
      expect(overview).toMatchObject({ threadCount, turnCount });
      const threads = await (await fetch(`${origin}/api/v1/threads?range=${range}&limit=1`)).json();
      expect(threads.total).toBe(threadCount - 1);
      expect(threads.turnCount).toBe(turnCount - 1);
      expect(threads.aggregate.requestCount).toBe(range === "24h" ? 3 : 4);
    }
    const empty = await (await fetch(`${origin}/api/v1/overview?from=2020-01-01&to=2020-01-01`)).json();
    expect(empty).toMatchObject({ global: null, threadCount: 0, turnCount: 0 });
  });

  it("keeps custom-date Thread, Turn, request, error and export queries consistent", async () => {
    const fixture = createFixture();
    const startAtMs = new Date(2026, 0, 2).getTime();
    const endAtMs = new Date(2026, 0, 3).getTime();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    store.recordBatch([
      { ...metricSample(), recordedAtMs: startAtMs - 1, model: "old" },
      { ...metricSample(), recordedAtMs: startAtMs, model: "matching" },
      { ...metricSample(), recordedAtMs: startAtMs + 1, model: "matching", turnId: "turn-2", status: "failed" },
      { ...metricSample(), recordedAtMs: startAtMs + 2, model: "matching", threadId: "thread-2", cachedInputTokens: null },
      { ...metricSample(), recordedAtMs: endAtMs, model: "outside" },
    ]);
    store.close();
    const { origin } = await startServer(fixture.environment);
    const scope = "from=2026-01-02&to=2026-01-02&provider=deepseek&model=matching";
    const read = async (path: string) => {
      const response = await fetch(`${origin}/api/v1/${path}`);
      expect(response.status).toBe(200);
      return response.json();
    };
    const threads = await read(`threads?${scope}&limit=1&sort=requests`);
    expect(threads).toMatchObject({ total: 2, nextOffset: 1, turnCount: 3, aggregate: { requestCount: 3 } });
    expect(threads.threads[0]).toMatchObject({ threadId: "thread-1", requestCount: 2, turnCount: 2, model: "matching", inputTokens: 2000, cacheUsage: { inputTokens: 2000, cachedInputTokens: 1800, missingRequestCount: 0 } });
    expect(threads.aggregate.cacheUsage).toEqual({ inputTokens: 2000, cachedInputTokens: 1800, missingRequestCount: 1 });
    const unknownCache = await read(`threads?${scope}&threadId=thread-2`);
    expect(unknownCache.threads[0]).toMatchObject({ inputTokens: 1000, cacheUsage: { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 1 } });
    const turns = await read(`threads/thread-1/turns?${scope}&limit=1`);
    expect(turns).toMatchObject({ total: 2, nextOffset: 1, aggregate: { requestCount: 2, unsuccessfulRequestCount: 1 } });
    expect(turns.turns[0].turnId).toBe("turn-2");
    const requestScope = `${scope}&threadId=thread-1&turnId=turn-2`;
    const requests = await read(`requests?${requestScope}`);
    expect(requests).toMatchObject({ total: 1, aggregate: { requestCount: 1, unsuccessfulRequestCount: 1 } });
    const exported = await read(`requests/export?${requestScope}`);
    expect(exported.records).toEqual(requests.records);
    expect(exported.aggregate).toEqual(requests.aggregate);
    const errors = await read(`errors?${scope}&threadId=thread-1`);
    expect(errors).toMatchObject({ total: 1, errors: { requestCount: 2, unsuccessfulRequestCount: 1 } });
    for (const sort of ["time", "last", "thread", "provider", "model", "turns", "requests", "input", "output", "totalTokens", "compact"]) {
      await read(`threads?${scope}&sort=${sort}&direction=asc`);
    }
    for (const sort of ["time", "last", "turn", "provider", "model", "requests", "failures", "input", "output", "compact"]) {
      await read(`threads/thread-1/turns?${scope}&sort=${sort}&direction=asc`);
    }
    for (const path of [
      "threads?range=1h", "threads?from=2026-01-02", "threads?from=2026-02-30&to=2026-03-01",
      `threads?${scope}&range=7d`, "requests?turnId=turn-1", "requests?status=invalid",
      "threads/thread-1/turns?threadId=thread-2", "threads/thread-1/turns?sort=totalTokens", "threads?sort=treeInput", "threads?sort=treeOutput", "threads?limit=501", "threads?sort=invalid",
      "requests?model=a&model=b", "requests?unsupported=value", "threads/thread-1/run?range=7d",
      "threads?from=1969-01-01&to=2026-01-02",
    ]) {
      expect((await fetch(`${origin}/api/v1/${path}`)).status, path).toBe(400);
    }
  });

  it("returns overview aggregates, errors and weekly quota", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "openai",
      status: "incomplete",
      incompleteReason: "response_not_observed",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      weeklyQuota: {
        limitId: "codex",
        planType: "plus",
        usedPercentMillionths: 12_500_000,
        resetsAt: Math.floor(Date.now() / 1_000) + 24 * 60 * 60,
      },
      errorMessage: "You've hit your usage limit",
    });
    recordSample(fixture.databasePath, {
      ...metricSample(),
    });
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/overview?range=24h`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      global: {
        requestCount: number;
        unsuccessfulRequestCount: number;
      };
      providers: Array<{
        provider: string;
        aggregate: { requestCount: number };
      }>;
      errors: { requestCount: number; unsuccessfulRequestCount: number };
      weeklyQuota: {
        limitId: string;
        planType: string | null;
        usedPercent: number;
        resetsAt: number;
      };
    };
    expect(body.global.requestCount).toBe(2);
    expect(body.global.unsuccessfulRequestCount).toBe(1);
    expect(body.providers).toHaveLength(2);
    const deepseek = body.providers.find((group) => group.provider === "deepseek");
    const openai = body.providers.find((group) => group.provider === "openai");
    expect(deepseek?.aggregate.requestCount).toBe(1);
    expect(openai?.aggregate.requestCount).toBe(1);
    expect(body.errors).toMatchObject({
      requestCount: 2,
      unsuccessfulRequestCount: 1,
      groups: [{
        status: "incomplete",
        errorType: "response_not_observed",
        lastErrorMessage: "You've hit your usage limit",
      }],
    });
    expect(body.weeklyQuota).toMatchObject({
      limitId: "codex",
      planType: "plus",
      usedPercent: 12.5,
    });
    expect(body.weeklyQuota.resetsAt).toBeGreaterThan(1_000_000_000_000);
  });

  it("keeps quota estimates aligned across snapshot backtracking and an unclosed tail", async () => {
    const fixture = createFixture();
    const resetsAt = Math.floor(Date.now() / 1_000) + 24 * 60 * 60;
    for (const [usedPercent, inputTokens] of [[0, 100], [1, 100], [0, 100], [1, 100], [2, 100], [2, 9_000]] as const) {
      recordSample(fixture.databasePath, {
        ...metricSample(),
        provider: "openai",
        inputTokens,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: inputTokens,
        weeklyQuota: { limitId: "codex", planType: "plus", usedPercentMillionths: usedPercent * 1_000_000, resetsAt },
      });
    }
    const { origin } = await startServer(fixture.environment);
    const response = await fetch(`${origin}/api/v1/overview?range=24h`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      global: { requestCount: 6, inputTokens: 9_500, outputTokens: 0 },
      weeklyQuota: {
        usedPercent: 2,
        remainingPercent: 98,
        estimate: {
          observedDeltaPercent: 2,
          intervalCount: 2,
          requestCount: 4,
          inputTokensPerPercent: 200,
          outputTokensPerPercent: 0,
          totalTokensPerPercent: 200,
        },
      },
    });
  });

  it("lists threads and returns run and turns details", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "deepseek",
      threadId: "thread-1",
      turnId: "turn-1",
      operation: "compact",
      requestStartedAtMs: 1_000,
    });
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "deepseek",
      threadId: "thread-1",
      turnId: "turn-1",
      requestStartedAtMs: 2_000,
    });
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "deepseek",
      threadId: "thread-1",
      turnId: "turn-2",
      requestStartedAtMs: 3_000,
      status: "failed",
      httpStatus: 429,
      errorType: "http_error",
    });
    const { origin } = await startServer(fixture.environment);

    const threads = await fetch(`${origin}/api/v1/threads`);
    expect(threads.status).toBe(200);
    const threadsBody = await threads.json() as {
      threads: Array<{
        threadId: string;
        turnCount: number;
        compact: { requestCount: number };
        firstRequestStartedAtMs: number;
      }>;
    };
    expect(threadsBody.threads).toHaveLength(1);
    expect(threadsBody.threads[0]).toMatchObject({
      threadId: "thread-1",
      turnCount: 2,
      compact: { requestCount: 1 },
      firstRequestStartedAtMs: 1_000,
    });
    const run = await fetch(`${origin}/api/v1/threads/thread-1/run`);
    expect(run.status).toBe(200);
    const runBody = await run.json() as {
      latestTurn: { turnId: string; compact: { requestCount: number } | null };
      threadAggregate: { turnCount: number };
    };
    expect(runBody.latestTurn?.turnId).toBe("turn-2");
    expect(runBody.threadAggregate?.turnCount).toBe(2);

    const timingStore = new SqliteModelRequestMetricsStore(fixture.databasePath);
    try {
      timingStore.replaceThreadExecutions("thread-1", "deepseek", [
        { turnId: "turn-1", durationMs: 0, recordedAtMs: Date.now() },
        { turnId: "turn-2", durationMs: 71_000, recordedAtMs: Date.now() },
      ]);
    } finally { timingStore.close(); }
    expect(await (await fetch(`${origin}/api/v1/threads/thread-1/run`)).json())
      .toMatchObject({ sessionDurationMs: 71_000, latestTurn: { turnId: "turn-2", durationMs: 71_000 } });

    const missingTimingStore = new SqliteModelRequestMetricsStore(fixture.databasePath);
    try {
      missingTimingStore.recordTurnExecution("thread-1", "deepseek", { turnId: "missing", durationMs: null, recordedAtMs: Date.now() });
    } finally { missingTimingStore.close(); }
    expect(await (await fetch(`${origin}/api/v1/threads/thread-1/run`)).json()).toMatchObject({
      sessionDurationMs: null,
      sessionTiming: { knownDurationMs: 71_000, missingTurnCount: 1, historyComplete: true },
      latestExecution: { turnId: "missing", durationMs: null },
    });

    const turns = await fetch(`${origin}/api/v1/threads/thread-1/turns`);
    expect(turns.status).toBe(200);
    const turnsBody = await turns.json() as {
      turns: Array<{ turnId: string }>;
    };
    expect(turnsBody.turns).toHaveLength(2);
    expect(turnsBody.turns).toEqual(expect.arrayContaining([
      expect.objectContaining({ turnId: "turn-1", durationMs: 0 }),
      expect.objectContaining({ turnId: "turn-2", durationMs: 71_000 }),
    ]));
  });

  it("sorts request records across server pages and aggregates errors", async () => {
    const fixture = createFixture();
    for (let index = 0; index < 3; index += 1) {
      recordSample(fixture.databasePath, {
        ...metricSample(),
        outputTokens: [100, 300, 200][index]!,
        status: index === 2 ? "failed" : "completed",
        httpStatus: index === 2 ? 500 : 200,
        errorType: index === 2 ? "http_error" : null,
      });
    }
    const { origin } = await startServer(fixture.environment);

    const first = await fetch(
      `${origin}/api/v1/requests?range=24h&limit=2&sort=output&direction=desc&offset=0`,
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      records: Array<{ outputTokens: number }>;
      nextOffset: number | null;
    };
    expect(firstBody.records.map((record) => record.outputTokens)).toEqual([300, 200]);
    expect(firstBody.nextOffset).toBe(2);

    const second = await fetch(
      `${origin}/api/v1/requests?range=24h&limit=2&sort=output&direction=desc&offset=${firstBody.nextOffset}`,
    );
    const secondBody = await second.json() as {
      records: Array<{ outputTokens: number }>;
      nextOffset: number | null;
    };
    expect(secondBody.records.map((record) => record.outputTokens)).toEqual([100]);
    expect(secondBody.nextOffset).toBeNull();

    const removedTimingSort = await fetch(
      `${origin}/api/v1/requests?range=24h&limit=2&sort=duration&direction=desc`,
    );
    expect(removedTimingSort.status).toBe(400);

    const filtered = await fetch(
      `${origin}/api/v1/requests?range=24h&limit=10&filter=http_error`,
    );
    expect(filtered.status).toBe(200);
    const filteredBody = await filtered.json() as {
      records: Array<{ errorType: string | null }>;
      total: number;
    };
    expect(filteredBody.total).toBe(1);
    expect(filteredBody.records[0]?.errorType).toBe("http_error");

    const invalidFilter = await fetch(
      `${origin}/api/v1/requests?range=24h&filter=${"x".repeat(129)}`,
    );
    expect(invalidFilter.status).toBe(400);

    const errors = await fetch(`${origin}/api/v1/errors?range=7d`);
    expect(errors.status).toBe(200);
    const errorsBody = await errors.json() as {
      errors: {
        requestCount: number;
        groups: Array<{ errorType: string; requestCount: number }>;
      };
      records: Array<{ status: string; errorType: string | null }>;
      total: number;
      nextOffset: number | null;
    };
    expect(errorsBody.errors).toMatchObject({
      requestCount: 3,
      unsuccessfulRequestCount: 1,
    });
    expect(errorsBody.errors.groups[0]).toMatchObject({
      errorType: "http_error",
      requestCount: 1,
    });
    expect(errorsBody.records).toEqual([
      expect.objectContaining({ status: "failed", errorType: "http_error" }),
    ]);
    expect(errorsBody.total).toBe(1);
    expect(errorsBody.nextOffset).toBeNull();
  });

  it("validates query parameters and thread ids", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, metricSample());
    const { origin } = await startServer(fixture.environment);

    const invalidRange = await fetch(`${origin}/api/v1/overview?range=1h`);
    expect(invalidRange.status).toBe(400);
    expect(await invalidRange.json()).toMatchObject({
      error: { code: "invalid_range" },
    });

    const rollingRange = await fetch(`${origin}/api/v1/overview?range=90d`);
    expect(rollingRange.status).toBe(200);

    const removedRange = await fetch(`${origin}/api/v1/overview?range=365d`);
    expect(removedRange.status).toBe(400);

    const invalidLimit = await fetch(`${origin}/api/v1/requests?limit=501`);
    expect(invalidLimit.status).toBe(400);
    expect(await invalidLimit.json()).toMatchObject({
      error: { code: "invalid_limit" },
    });

    const invalidOffset = await fetch(`${origin}/api/v1/requests?offset=-1`);
    expect(invalidOffset.status).toBe(400);
    expect(await invalidOffset.json()).toMatchObject({
      error: { code: "invalid_offset" },
    });

    const invalidSort = await fetch(`${origin}/api/v1/requests?sort=unknown`);
    expect(invalidSort.status).toBe(400);
    expect(await invalidSort.json()).toMatchObject({
      error: { code: "invalid_sort" },
    });

    const invalidDirection = await fetch(`${origin}/api/v1/requests?direction=newest`);
    expect(invalidDirection.status).toBe(400);
    expect(await invalidDirection.json()).toMatchObject({
      error: { code: "invalid_direction" },
    });

    const removedCursor = await fetch(`${origin}/api/v1/requests?afterId=1`);
    expect(removedCursor.status).toBe(400);
    expect(await removedCursor.json()).toMatchObject({
      error: { code: "unsupported_parameter" },
    });

    const invalidThread = await fetch(
      `${origin}/api/v1/threads/${"x".repeat(129)}/run`,
    );
    expect(invalidThread.status).toBe(400);
    expect(await invalidThread.json()).toMatchObject({
      error: { code: "invalid_thread_id" },
    });
  });

  it.each([
    "UPDATE schema_metadata SET value = 0 WHERE name = 'schema_version'",
    "DROP TABLE subagent_turns",
  ])("returns a safe 503 for incompatible metrics databases: %s", async (sql) => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, metricSample());
    const database = new DatabaseSync(fixture.databasePath);
    try {
      database.exec(sql);
    } finally {
      database.close();
    }
    const { origin } = await startServer(fixture.environment);
    const response = await fetch(`${origin}/api/v1/overview`);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ error: {
      code: "metrics_database_incompatible",
      message: "指标数据库版本或结构不兼容，仅支持当前 Schema；请核对版本及备份，勿删除数据库",
    } });
    expect(JSON.stringify(body)).not.toContain(fixture.databasePath);
  });

  it("returns 503 when the metrics database is unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-webui-missing-"));
    temporaryDirectories.push(home);
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    initializeUserData({ environment, cwd: home });
    const { origin } = await startServer(environment);

    const response = await fetch(`${origin}/api/v1/overview`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "metrics_database_unavailable" },
    });
  });

  it("rejects non-GET methods and unknown API paths", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);

    const post = await fetch(`${origin}/api/v1/overview`, { method: "POST" });
    expect(post.status).toBe(405);
    expect(await post.json()).toMatchObject({
      error: { code: "method_not_allowed" },
    });

    const unknown = await fetch(`${origin}/api/v1/unknown`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({
      error: { code: "not_found" },
    });

    const withoutVersion = await fetch(`${origin}/api/unknown`);
    expect(withoutVersion.status).toBe(404);
    expect(await withoutVersion.json()).toMatchObject({
      error: { code: "not_found" },
    });
  });

});
