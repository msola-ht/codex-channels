import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeGatewayConfig } from "../runtime/gateway-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { routeTrafficApi } from "../scripts/webui-traffic-route.mjs";
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
  it("lists logical calls without payloads and returns one request with one response", async () => {
    const fixture = createFixture();
    writeSession(fixture.trafficDir, "ocg", "2026-09-17T00-00-00-000Z", [
      httpInteraction(1),
      websocketInteraction(2),
    ]);
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic?limit=1`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ enabled: true, label: "ocg", total: 2, nextOffset: 1 });
    expect(list.body.exchanges[0]).toMatchObject({
      id: 1,
      path: "/responses",
      requestKind: "turn",
      requestModel: "deepseek-flash",
      responseModels: ["deepseek-flash"],
      state: "completed",
      threadId: "thread-http-1",
      transport: "http",
    });
    expect(JSON.stringify(list.body)).not.toContain("hello");

    const detail = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=1&session=${list.body.session}`,
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
    })).rejects.toMatchObject({ message: "转储查看只允许回环访问", status: 503 });
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
  exchanges: Array<Record<string, unknown>>;
  label: string;
  labels: Array<{ label: string; sessions: number }>;
  nextOffset: number | null;
  session: string;
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
