import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { createWebuiServer, resolveWebuiSettings } from "../scripts/webui-server.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";
import {
  requestMetricsDatabasePath,
  SqliteModelRequestMetricsStore,
  type ModelRequestMetricSample,
} from "../src/observability/index.js";

const temporaryDirectories: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("webui server", () => {
  it("serves the static page and rejects unknown paths", async () => {
    const fixture = createFixture();
    const staticDir = createStaticDir("<h1>Codex WebUI</h1>");
    const { origin } = await startServer(fixture.environment, staticDir);

    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Codex WebUI");

    const missing = await fetch(`${origin}/missing.js`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("returns overview aggregates, errors and weekly quota", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "openai",
      pricing: pricingSnapshot(),
      status: "incomplete",
      incompleteReason: "response_not_observed",
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
      weeklyQuota: {
        limitId: "codex",
        usedPercentMillionths: 12_500_000,
        resetsAt: Math.floor(Date.now() / 1_000) + 24 * 60 * 60,
      },
    });
    recordSample(fixture.databasePath, {
      ...metricSample(),
      pricing: pricingSnapshot(),
    });
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/overview?range=24h&currency=cny`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      global: {
        requestCount: number;
        unsuccessfulRequestCount: number;
        totalCostCnyNanos: number | null;
      };
      providers: Array<{
        provider: string;
        aggregate: { requestCount: number; totalCostCnyNanos: number | null };
      }>;
      errors: { requestCount: number; unsuccessfulRequestCount: number };
      weeklyQuota: {
        limitId: string;
        usedPercent: number;
        resetsAt: number;
      };
    };
    expect(body.global.requestCount).toBe(2);
    expect(body.global.unsuccessfulRequestCount).toBe(1);
    expect(body.global.totalCostCnyNanos).toBe(3_205_440);
    expect(body.providers).toHaveLength(2);
    const deepseek = body.providers.find((group) => group.provider === "deepseek");
    const openai = body.providers.find((group) => group.provider === "openai");
    expect(deepseek?.aggregate.requestCount).toBe(1);
    expect(deepseek?.aggregate.totalCostCnyNanos).toBe(3_205_440);
    expect(openai?.aggregate.requestCount).toBe(1);
    expect(openai?.aggregate.totalCostCnyNanos).toBeNull();
    expect(body.errors).toMatchObject({
      requestCount: 2,
      unsuccessfulRequestCount: 1,
    });
    expect(body.weeklyQuota).toMatchObject({
      limitId: "codex",
      usedPercent: 12.5,
    });
    expect(body.weeklyQuota.resetsAt).toBeGreaterThan(1_000_000_000_000);
  });

  it("converts every provider to the requested currency", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "openai",
      pricing: pricingSnapshot(),
    });
    recordSample(fixture.databasePath, {
      ...metricSample(),
      pricing: pricingSnapshot(),
    });
    const { origin } = await startServer(fixture.environment);

    const cnyResponse = await fetch(`${origin}/api/v1/overview?range=24h&currency=cny`);
    const cnyBody = await cnyResponse.json() as {
      providers: Array<{
        provider: string;
        aggregate: { totalCostCnyNanos: number | null };
      }>;
    };
    for (const group of cnyBody.providers) {
      expect(group.aggregate.totalCostCnyNanos).not.toBeNull();
    }

    const usdResponse = await fetch(`${origin}/api/v1/overview?range=24h&currency=usd`);
    const usdBody = await usdResponse.json() as {
      providers: Array<{
        provider: string;
        aggregate: { totalCostCnyNanos: number | null };
      }>;
    };
    for (const group of usdBody.providers) {
      expect(group.aggregate.totalCostCnyNanos).toBeNull();
    }
  });

  it("rejects invalid currency values", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/overview?range=24h&currency=eur`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_currency" },
    });
  });

  it("returns the configured global currency and persisted exchange rate", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/settings`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      currency: string;
      exchangeRate: { usdToCny: number; source: string } | null;
    };
    expect(body.currency).toBe("cny");
    expect(body.exchangeRate).toMatchObject({
      usdToCny: 7.2,
      source: "cache",
    });
  });

  it("lists threads and returns run and turns details", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "deepseek",
      pricing: pricingSnapshot(),
      threadId: "thread-1",
      turnId: "turn-1",
      operation: "compact",
    });
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "deepseek",
      pricing: pricingSnapshot(),
      threadId: "thread-1",
      turnId: "turn-1",
    });
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "deepseek",
      pricing: pricingSnapshot(),
      threadId: "thread-1",
      turnId: "turn-2",
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
        totalCostCnyNanos: number | null;
      }>;
    };
    expect(threadsBody.threads).toHaveLength(1);
    expect(threadsBody.threads[0]).toMatchObject({
      threadId: "thread-1",
      turnCount: 2,
      compact: { requestCount: 1 },
    });
    expect(threadsBody.threads[0]!.totalCostCnyNanos).toBeGreaterThan(0);

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

  it("pages request records and aggregates errors", async () => {
    const fixture = createFixture();
    for (let index = 0; index < 3; index += 1) {
      recordSample(fixture.databasePath, {
        ...metricSample(),
        status: index === 2 ? "failed" : "completed",
        httpStatus: index === 2 ? 500 : 200,
        errorType: index === 2 ? "http_error" : null,
      });
    }
    const { origin } = await startServer(fixture.environment);

    const first = await fetch(`${origin}/api/v1/requests?range=24h&limit=2`);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as {
      records: Array<{ id: number }>;
      nextAfterId: number | null;
    };
    expect(firstBody.records).toHaveLength(2);
    expect(firstBody.nextAfterId).toBe(firstBody.records[1]!.id);

    const second = await fetch(
      `${origin}/api/v1/requests?range=24h&limit=2&afterId=${firstBody.nextAfterId}`,
    );
    const secondBody = await second.json() as {
      records: Array<{ id: number }>;
      nextAfterId: number | null;
    };
    expect(secondBody.records).toHaveLength(1);
    expect(secondBody.nextAfterId).toBeNull();

    const errors = await fetch(`${origin}/api/v1/errors?range=7d`);
    expect(errors.status).toBe(200);
    const errorsBody = await errors.json() as {
      errors: {
        requestCount: number;
        groups: Array<{ errorType: string; requestCount: number }>;
      };
    };
    expect(errorsBody.errors).toMatchObject({
      requestCount: 3,
      unsuccessfulRequestCount: 1,
    });
    expect(errorsBody.errors.groups[0]).toMatchObject({
      errorType: "http_error",
      requestCount: 1,
    });
  });

  it("validates query parameters and thread ids", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);

    const invalidRange = await fetch(`${origin}/api/v1/overview?range=1h`);
    expect(invalidRange.status).toBe(400);
    expect(await invalidRange.json()).toMatchObject({
      error: { code: "invalid_range" },
    });

    const invalidLimit = await fetch(`${origin}/api/v1/requests?limit=501`);
    expect(invalidLimit.status).toBe(400);
    expect(await invalidLimit.json()).toMatchObject({
      error: { code: "invalid_limit" },
    });

    const invalidAfterId = await fetch(`${origin}/api/v1/requests?afterId=-1`);
    expect(invalidAfterId.status).toBe(400);
    expect(await invalidAfterId.json()).toMatchObject({
      error: { code: "invalid_afterId" },
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

  it("requires the access token for API requests when configured", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, metricSample());
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { token: "secret-token" },
    );

    const missing = await fetch(`${origin}/api/v1/overview`);
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({
      error: { code: "unauthorized" },
    });

    const wrong = await fetch(`${origin}/api/v1/overview`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(401);

    const ok = await fetch(`${origin}/api/v1/overview`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(ok.status).toBe(200);
  });

  it("rejects non-loopback hosts without a token", () => {
    const fixture = createFixture();
    expect(() => createWebuiServer({
      environment: fixture.environment,
      host: "0.0.0.0",
    })).toThrow("必须提供访问令牌");
  });

  it("resolves default webui settings without a config file", () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-webui-settings-"));
    temporaryDirectories.push(home);
    const settings = resolveWebuiSettings({
      environment: {
        ...process.env,
        CODEX_CONNECT_HOME: home,
        CODEX_CONNECT_CONFIG_FILE: "",
      },
    });
    expect(settings).toMatchObject({ host: "127.0.0.1", port: 8787, token: null });
  });

  it("reads webui settings from config and lets CLI args override", () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}\n`
        + "[webui]\n"
        + 'host = "0.0.0.0"\n'
        + "port = 9000\n"
        + 'token = "cfg-token"\n',
    );

    expect(resolveWebuiSettings({ environment: fixture.environment })).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      token: "cfg-token",
    });

    expect(resolveWebuiSettings({
      environment: fixture.environment,
      args: ["--host", "127.0.0.1", "--port", "8788"],
    })).toMatchObject({
      host: "127.0.0.1",
      port: 8788,
      token: "cfg-token",
    });
  });

  it("rejects non-loopback webui config without a token", () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}\n`
        + "[webui]\n"
        + 'host = "0.0.0.0"\n',
    );

    expect(() => resolveWebuiSettings({ environment: fixture.environment }))
      .toThrow(/绑定非回环地址时必须设置 token/u);
  });

  it("still applies the token when configured", () => {
    const fixture = createFixture();
    expect(() => createWebuiServer({
      environment: fixture.environment,
      token: "secret-token",
    })).not.toThrow();
  });

  it("allows non-loopback hosts when a token is configured", async () => {
    const fixture = createFixture();
    recordSample(fixture.databasePath, metricSample());
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { host: "0.0.0.0", token: "secret-token" },
    );
    const response = await fetch(`${origin}/api/v1/threads`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(response.status).toBe(200);
  });
});

function createFixture() {
  const home = mkdtempSync(join(tmpdir(), "codexc-webui-"));
  temporaryDirectories.push(home);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  initializeUserData({ environment, cwd: home });
  writeFileSync(
    join(home, "data", "exchange-rate.json"),
    JSON.stringify({
      version: 1,
      source: "cache",
      effectiveAtMs: Date.now(),
      usdToCny: 7.2,
    }),
  );
  return {
    databasePath: requestMetricsDatabasePath(join(home, "data", "gateway.sqlite3")),
    environment,
    home,
  };
}

function pricingSnapshot() {
  return {
    billingMode: "api" as const,
    currency: "USD",
    source: "test",
    effectiveAtMs: Date.now(),
    uncachedInputPricePerMillionNanos: 1_400_000_000,
    cachedInputPricePerMillionNanos: 28_000_000,
    outputPricePerMillionNanos: 2_800_000_000,
  };
}

function createStaticDir(content: string) {
  const directory = mkdtempSync(join(tmpdir(), "codexc-webui-static-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "index.html"), content);
  return directory;
}

async function startServer(
  environment: NodeJS.ProcessEnv,
  staticDir?: string,
  options: {
    host?: string
    token?: string
  } = {},
) {
  const { server } = createWebuiServer({
    environment,
    ...(staticDir === undefined ? {} : { staticDir }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.token === undefined ? {} : { token: options.token }),
  });
  await new Promise<void>((resolve) => {
    server.listen(0, options.host ?? "127.0.0.1", resolve);
  });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
  };
}

function recordSample(databasePath: string, sample: ModelRequestMetricSample) {
  const store = new SqliteModelRequestMetricsStore(databasePath);
  try {
    store.record(sample);
  } finally {
    store.close();
  }
}

function metricSample(): ModelRequestMetricSample {
  return {
    provider: "deepseek",
    pricing: null,
    transport: "http",
    responseFormat: "sse",
    operation: "response",
    threadId: "thread-1",
    turnId: "turn-1",
    model: "deepseek-v4-flash",
    serviceTier: "default",
    reasoningEffort: "max",
    status: "completed",
    httpStatus: 200,
    errorType: null,
    errorCode: null,
    incompleteReason: null,
    inputTokens: 1_000,
    cachedInputTokens: 900,
    outputTokens: 100,
    reasoningOutputTokens: 40,
    totalTokens: 1_100,
    upstreamCreatedAt: 1_785_640_800,
    upstreamCompletedAt: 1_785_640_801,
    requestStartedAtMs: Date.now() - 60_000,
    firstTokenAtMs: Date.now() - 59_000,
    firstReasoningDeltaAtMs: Date.now() - 59_000,
    lastReasoningDeltaAtMs: Date.now() - 58_000,
    firstOutputDeltaAtMs: Date.now() - 57_000,
    lastOutputDeltaAtMs: Date.now() - 56_000,
    responseCompletedAtMs: Date.now() - 55_000,
    weeklyQuota: null,
  };
}
