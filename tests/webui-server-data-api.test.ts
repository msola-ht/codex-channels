import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { initializeUserData } from "../scripts/runtime-config.mjs";
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
