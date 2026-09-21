import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeUserData } from "../scripts/runtime-config.mjs";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
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

describe("webui server data API", () => {
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
    const traffic = { label: "openai", session: "2026-09-19T00-00-00-000Z-2", interaction: 4 };
    recordSample(fixture.databasePath, {
      ...metricSample(), provider: "openai", upstreamTtftMs: 569.25,
      requestServiceTier: "priority", serviceTier: "default",
      firstContentMs: 12.5, totalDurationMs: 1234.5, outputTokens: 1_000, requestModel: "requested", responseModel: "echoed", traffic,
    });
    recordSample(fixture.databasePath, metricSample());
    const { origin } = await startServer(fixture.environment);
    for (const path of ["requests", "requests/export"]) {
      const response = await fetch(`${origin}/api/v1/${path}?range=all`);
      expect(response.status).toBe(200);
      const body = await response.json() as { records: Array<{ provider: string; upstreamTtftMs: number | null }> };
      expect(body.records.find((row) => row.provider === "openai")?.upstreamTtftMs).toBe(569.25);
      expect(body.records.find((row) => row.provider === "openai")).toMatchObject({
        firstContentMs: 12.5, totalDurationMs: 1234.5, requestModel: "requested", responseModel: "echoed", traffic,
        tokensPerSecond: 1_000_000 / 1234.5,
        requestServiceTier: "priority", serviceTier: "default",
      });
      expect(body.records.find((row) => row.provider === "deepseek")).toMatchObject({
        firstContentMs: null, totalDurationMs: null, requestModel: null, responseModel: null, traffic: null,
        tokensPerSecond: null,
        requestServiceTier: null,
      });
      expect(body.records.find((row) => row.provider === "deepseek")?.upstreamTtftMs).toBeNull();
    }
    const sorted = await fetch(`${origin}/api/v1/requests?range=all&sort=totalDuration&direction=desc`);
    expect(sorted.status).toBe(200);
    expect(((await sorted.json()) as { records: Array<{ totalDurationMs: number | null }> }).records[0]?.totalDurationMs).toBe(1234.5);
    const speeds = await fetch(`${origin}/api/v1/requests?range=all&sort=tokensPerSecond&direction=desc`);
    expect(speeds.status).toBe(200);
    expect(((await speeds.json()) as { records: Array<{ tokensPerSecond: number | null }> }).records[0]?.tokensPerSecond).toBe(1_000_000 / 1234.5);
    for (const [path, key] of [["threads", "threads"], ["threads/thread-1/turns", "turns"]]) {
      const response = await fetch(`${origin}/api/v1/${path}?range=all&sort=tokensPerSecond&direction=desc`);
      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, Array<{ tokensPerSecond: number | null }>>;
      expect(body[key!]![0]?.tokensPerSecond).toBe(1_000_000 / 1234.5);
    }
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
        expect(group.threadCount).toBe(threads.total);
        expect(group.turnCount).toBe(threads.turnCount);
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
      expect(overview.threadCount).toBe(threads.total);
      expect(overview.turnCount).toBe(threads.turnCount);
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
      { ...metricSample(), recordedAtMs: startAtMs + 2, model: "matching", threadId: "thread-2" },
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
    expect(threads.threads[0]).toMatchObject({ threadId: "thread-1", requestCount: 2, turnCount: 2, model: "matching" });
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
    for (const sort of ["time", "last", "thread", "provider", "model", "turns", "requests", "input", "output", "compact"]) {
      await read(`threads?${scope}&sort=${sort}&direction=asc`);
    }
    for (const sort of ["time", "last", "turn", "provider", "model", "requests", "failures", "input", "output", "compact"]) {
      await read(`threads/thread-1/turns?${scope}&sort=${sort}&direction=asc`);
    }
    for (const path of [
      "threads?range=1h", "threads?from=2026-01-02", "threads?from=2026-02-30&to=2026-03-01",
      `threads?${scope}&range=7d`, "requests?turnId=turn-1", "requests?status=invalid",
      "threads/thread-1/turns?threadId=thread-2", "threads?limit=501", "threads?sort=invalid",
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

    const turns = await fetch(`${origin}/api/v1/threads/thread-1/turns`);
    expect(turns.status).toBe(200);
    const turnsBody = await turns.json() as {
      turns: Array<{ turnId: string }>;
    };
    expect(turnsBody.turns).toHaveLength(2);
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
