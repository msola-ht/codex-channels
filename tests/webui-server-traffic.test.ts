import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
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

describe("webui traffic API", () => {
  it("lists exchange summaries with models and pages without bodies", async () => {
    const fixture = createFixture();
    writeDumpFile(fixture.trafficDir, "ocg-2026-09-17T00-00-00-000Z-1.jsonl", [
      ...httpExchange(1),
      ...websocketExchange(2),
    ]);
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic?limit=1`);

    expect(list.status).toBe(200);
    expect(list.body.total).toBe(2);
    expect(list.body.exchanges).toHaveLength(1);
    expect(list.body.nextOffset).toBe(1);
    expect(list.body.label).toBe("ocg");
    expect(list.body.enabled).toBe(true);
    expect(list.body.labels).toEqual([
      expect.objectContaining({ files: 1, label: "ocg" }),
    ]);
    expect(list.body.exchanges[0]).toMatchObject({
      id: 1,
      method: "POST",
      path: "/responses",
      requestKind: "turn",
      requestModel: "deepseek-flash",
      responseModels: ["deepseek-flash"],
      status: 200,
      threadId: "th-http0001",
      transport: "http",
      turnId: "tu-http0001",
    });
    expect(JSON.stringify(list.body)).not.toContain("hello");

    const second = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic?limit=1&offset=1`);
    expect(second.body.exchanges[0]).toMatchObject({
      id: 2,
      transport: "websocket",
      url: "wss://chatgpt.com/backend-api/codex/responses",
    });
    expect(second.body.nextOffset).toBeNull();
  });

  it("returns the full request and response fields of one exchange", async () => {
    const fixture = createFixture();
    writeDumpFile(fixture.trafficDir, "ocg-2026-09-17T00-00-00-000Z-1.jsonl", httpExchange(7));
    const server = await startServer(fixture.environment);

    const detail = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?id=7`);

    expect(detail.status).toBe(200);
    expect(detail.body.exchange).toMatchObject({
      id: 7,
      requestKind: "turn",
      requestModel: "deepseek-flash",
      responseModels: ["deepseek-flash"],
      threadId: "th-http0007",
      transport: "http",
      turnId: "tu-http0007",
    });
    expect(detail.body.exchange.request).toMatchObject({
      body: JSON.stringify({ input: ["hello"], model: "deepseek-flash" }),
      bodyTruncated: false,
      headers: { authorization: "Bearer <redacted>" },
      method: "POST",
      path: "/responses",
    });
    expect(detail.body.exchange.response).toMatchObject({
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(detail.body.exchange.events.map((event) => event.type))
      .toEqual(["response.created", "response.output_text.done"]);
  });

  it("bounds SSE event payloads with the response body limit", async () => {
    const fixture = createFixture();
    const oversized = "x".repeat(4 * 1_048_576 + 1_024);
    const records = httpExchange(8).map((record) => (
      record.kind === "response_body"
        ? {
            ...record,
            text: `event: response.output_text.done\ndata: ${JSON.stringify({
              text: oversized,
              type: "response.output_text.done",
            })}\n\n`,
          }
        : record
    ));
    writeDumpFile(
      fixture.trafficDir,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      records,
    );
    const server = await startServer(fixture.environment);

    const detail = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?id=8`);

    expect(detail.body.exchange.response).toMatchObject({ bodyTruncated: true });
    expect(Buffer.byteLength(detail.body.exchange.events[0]!.payload))
      .toBeLessThanOrEqual(4 * 1_048_576);
  });

  it("bounds split request bodies while preserving their top-level model", async () => {
    const fixture = createFixture();
    const maximumBodyBytes = 4 * 1_048_576;
    const requestBody = JSON.stringify({
      input: {
        model: "nested-input-model",
        text: "x".repeat(maximumBodyBytes + 1_048_576),
      },
      model: "gpt-large-request",
    });
    const records = httpExchange(9).flatMap((record) => {
      if (record.kind === "request_end") {
        return [{ ...record, bytes: Buffer.byteLength(requestBody) }];
      }
      if (record.kind !== "request_body") return [record];
      const parts = [];
      for (let offset = 0; offset < requestBody.length; offset += 1_048_576) {
        parts.push({
          ...record,
          part: parts.length + 1,
          text: requestBody.slice(offset, offset + 1_048_576),
        });
      }
      return parts;
    });
    writeDumpFile(
      fixture.trafficDir,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      records,
    );
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic`);
    const detail = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?id=9`);

    expect(list.body.exchanges[0]).toMatchObject({ requestModel: "gpt-large-request" });
    expect(detail.body.exchange).toMatchObject({ requestModel: "gpt-large-request" });
    expect(detail.body.exchange.request).toMatchObject({
      bodyTruncated: true,
      bytes: Buffer.byteLength(requestBody),
    });
    expect(Buffer.byteLength(String(detail.body.exchange.request?.body)))
      .toBeLessThan(maximumBodyBytes + 100);
  });

  it("bounds split WebSocket frames while preserving their metadata and models", async () => {
    const fixture = createFixture();
    const maximumBodyBytes = 4 * 1_048_576;
    const turnMetadata = JSON.stringify({
      request_kind: "turn",
      thread_id: "th-large-websocket",
      turn_id: "tu-large-websocket",
    });
    const clientFrame = JSON.stringify({
      input: {
        model: "nested-input-model",
        text: "x".repeat(maximumBodyBytes + 1_048_576),
      },
      model: "gpt-large-client",
      client_metadata: {
        "x-codex-turn-metadata": turnMetadata,
        thread_id: "th-direct-websocket",
      },
      type: "response.create",
    });
    const upstreamFrame = JSON.stringify({
      output: { text: "y".repeat(maximumBodyBytes + 1_048_576) },
      response: { model: "gpt-large-response" },
      type: "response.completed",
    });
    const records = [
      websocketExchange(11)[0]!,
      ...splitWebSocketFrame(11, "client", clientFrame),
      ...splitWebSocketFrame(11, "upstream", upstreamFrame),
    ];
    writeDumpFile(
      fixture.trafficDir,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      records,
    );
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic`);
    const firstPage = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=11`,
    );
    const secondPage = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=11&frameOffset=1`,
    );

    expect(list.body.exchanges[0]).toMatchObject({
      requestKind: "turn",
      requestModel: "gpt-large-client",
      responseModels: ["gpt-large-response"],
      threadId: "th-large-websocket",
      transport: "websocket",
      turnId: "tu-large-websocket",
    });
    expect(firstPage.body.exchange).toMatchObject({
      framePage: {
        nextOffset: 1,
        offset: 0,
        previousOffset: null,
        total: 2,
      },
      requestKind: "turn",
      requestModel: "gpt-large-client",
      responseModels: ["gpt-large-response"],
      threadId: "th-large-websocket",
      transport: "websocket",
      turnId: "tu-large-websocket",
    });
    expect(firstPage.body.exchange.frames).toMatchObject([
      { direction: "client", truncated: true },
    ]);
    expect(secondPage.body.exchange).toMatchObject({
      framePage: {
        nextOffset: null,
        offset: 1,
        previousOffset: 0,
        total: 2,
      },
      requestKind: "turn",
      requestModel: "gpt-large-client",
      responseModels: ["gpt-large-response"],
      threadId: "th-large-websocket",
      transport: "websocket",
      turnId: "tu-large-websocket",
    });
    expect(secondPage.body.exchange.frames).toMatchObject([
      { direction: "upstream", truncated: true },
    ]);
    for (const frame of [
      ...firstPage.body.exchange.frames,
      ...secondPage.body.exchange.frames,
    ]) {
      expect(Buffer.byteLength(frame.text)).toBeLessThan(maximumBodyBytes + 100);
    }
  });

  it("limits a WebSocket frame page to one hundred frames", async () => {
    const fixture = createFixture();
    const prefix = { exchange: 12, startedAtMs: 1_700_000_000_012 };
    const frames = Array.from({ length: 101 }, (_, index) => ({
      ...prefix,
      direction: "upstream",
      kind: "websocket_frame",
      part: 1,
      text: JSON.stringify({ index, type: "response.output_text.delta" }),
    }));
    writeDumpFile(
      fixture.trafficDir,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      [websocketExchange(12)[0]!, ...frames],
    );
    const server = await startServer(fixture.environment);

    const firstPage = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=12`,
    );
    const secondPage = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=12&frameOffset=100`,
    );

    expect(firstPage.body.exchange.frames).toHaveLength(100);
    expect(firstPage.body.exchange.framePage).toEqual({
      nextOffset: 100,
      offset: 0,
      previousOffset: null,
      total: 101,
    });
    expect(secondPage.body.exchange.frames).toHaveLength(1);
    expect(secondPage.body.exchange.framePage).toEqual({
      nextOffset: null,
      offset: 100,
      previousOffset: 0,
      total: 101,
    });
  });

  it("parses CRLF-delimited SSE events independently", async () => {
    const fixture = createFixture();
    const responseBody = [
      "event: response.created\r\n",
      `data: ${JSON.stringify({ response: { model: "gpt-test" }, type: "response.created" })}\r\n\r\n`,
      "event: response.output_text.done\r\n",
      `data: ${JSON.stringify({ text: "done", type: "response.output_text.done" })}\r\n\r\n`,
    ].join("");
    const records = httpExchange(10).map((record) => (
      record.kind === "response_body" ? { ...record, text: responseBody } : record
    ));
    writeDumpFile(
      fixture.trafficDir,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      records,
    );
    const server = await startServer(fixture.environment);

    const detail = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=10`,
    );

    expect(detail.body.exchange.events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_text.done",
    ]);
  });

  it("keeps a rotated HTTP exchange HTTP when its request head is gone", async () => {
    const fixture = createFixture();
    writeDumpFile(
      fixture.trafficDir,
      "ocg-2026-09-17T00-00-00-000Z-1.jsonl",
      httpExchange(9).filter((record) => !String(record.kind).startsWith("request_")),
    );
    const server = await startServer(fixture.environment);

    const detail = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?id=9`);

    expect(detail.body.exchange).toMatchObject({ id: 9, request: null, transport: "http" });
    expect(detail.body.exchange.response).toMatchObject({ status: 200 });
  });

  it("reads only the newest writer session when exchange numbers restart", async () => {
    const fixture = createFixture();
    const older = writeDumpFile(
      fixture.trafficDir,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      rewriteHttpExchange(httpExchange(1), 1_700_000_000_001, "/older"),
    );
    const newer = writeDumpFile(
      fixture.trafficDir,
      "openai-2026-09-17T00-01-00-000Z-1.jsonl",
      rewriteHttpExchange(httpExchange(1), 1_700_000_060_001, "/newer"),
    );
    utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(newer, new Date(1_700_000_060_000), new Date(1_700_000_060_000));
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic`);
    const detail = await getJson<TrafficDetailBody>(`${server.origin}/api/v1/traffic/exchange?id=1`);

    expect(list.body.total).toBe(1);
    expect(list.body.exchanges[0]).toMatchObject({
      id: 1,
      path: "/newer",
      startedAtMs: 1_700_000_060_001,
    });
    expect(detail.body.exchange.request).toMatchObject({ path: "/newer" });
  });

  it("keeps list and detail on the same writer session after a restart", async () => {
    const fixture = createFixture();
    const older = writeDumpFile(
      fixture.trafficDir,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      rewriteHttpExchange(httpExchange(1), 1_700_000_000_001, "/older"),
    );
    utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const server = await startServer(fixture.environment);
    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic`);

    const newer = writeDumpFile(
      fixture.trafficDir,
      "openai-2026-09-17T00-01-00-000Z-1.jsonl",
      rewriteHttpExchange(httpExchange(1), 1_700_000_060_001, "/newer"),
    );
    utimesSync(newer, new Date(1_700_000_060_000), new Date(1_700_000_060_000));
    const detail = await getJson<TrafficDetailBody>(
      `${server.origin}/api/v1/traffic/exchange?id=1&label=openai&session=${list.body.session}`,
    );

    expect(list.body.session).toBe("2026-09-17T00-00-00-000Z");
    expect(detail.body.session).toBe(list.body.session);
    expect(detail.body.exchange.request).toMatchObject({ path: "/older" });
  });

  it("selects the requested label and rejects unknown parameters", async () => {
    const fixture = createFixture();
    writeDumpFile(fixture.trafficDir, "ocg-2026-09-17T00-00-00-000Z-1.jsonl", httpExchange(1));
    writeDumpFile(fixture.trafficDir, "openai-2026-09-17T00-00-05-000Z-1.jsonl", websocketExchange(3));
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic`);
    expect(list.body.label).toBe("openai");
    expect(list.body.labels.map((entry: { label: string }) => entry.label)).toEqual(["openai", "ocg"]);

    const selected = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic?label=ocg`);
    expect(selected.body.label).toBe("ocg");
    expect(selected.body.exchanges[0]).toMatchObject({ id: 1, transport: "http" });

    expect(await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic?bogus=1`))
      .toMatchObject({ body: { error: { code: "unsupported_parameter" } }, status: 400 });
    expect(await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic?label=nope`))
      .toMatchObject({ body: { error: { code: "traffic_label_not_found" } }, status: 404 });
    expect(await getJson<TrafficErrorBody>(
      `${server.origin}/api/v1/traffic?label=openai&session=missing`,
    )).toMatchObject({ body: { error: { code: "traffic_session_not_found" } }, status: 404 });
    expect(await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic?limit=0`))
      .toMatchObject({ body: { error: { code: "invalid_parameter" } }, status: 400 });
    expect(await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic/exchange`))
      .toMatchObject({ body: { error: { code: "missing_parameter" } }, status: 400 });
    expect(await getJson<TrafficErrorBody>(
      `${server.origin}/api/v1/traffic/exchange?id=1&frameOffset=-1`,
    )).toMatchObject({ body: { error: { code: "invalid_parameter" } }, status: 400 });
    expect(await getJson<TrafficErrorBody>(
      `${server.origin}/api/v1/traffic/exchange?id=3&label=openai&frameOffset=99`,
    )).toMatchObject({ body: { error: { code: "invalid_parameter" } }, status: 400 });
    expect(await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic/exchange?id=99`))
      .toMatchObject({ body: { error: { code: "traffic_exchange_not_found" } }, status: 404 });
  });

  it("keeps provider labels distinct and orders tied mtimes by code unit", async () => {
    const fixture = createFixture();
    const first = writeDumpFile(
      fixture.trafficDir,
      "custom-Z-2026-09-17T00-00-00-000Z-1.jsonl",
      httpExchange(1),
    );
    const second = writeDumpFile(
      fixture.trafficDir,
      "custom_a-2026-09-17T00-01-00-000Z-1.jsonl",
      httpExchange(2),
    );
    const sameTimestamp = new Date(1_700_000_000_000);
    utimesSync(first, sameTimestamp, sameTimestamp);
    utimesSync(second, sameTimestamp, sameTimestamp);
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic`);

    expect(list.body.label).toBe("custom_a");
    expect(list.body.labels.map((entry) => entry.label)).toEqual([
      "custom_a",
      "custom-Z",
    ]);
  });

  it("reports an unavailable dump directory with an actionable message", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic`);

    expect(list.status).toBe(503);
    expect(list.body.error.code).toBe("traffic_unavailable");
    expect(list.body.error.message).toContain("model_traffic_dump");
  });

  it("reads traffic beside an explicitly selected config file", async () => {
    const fixture = createFixture({ explicitConfig: true });
    writeDumpFile(
      fixture.trafficDir,
      "openai-2026-09-17T00-00-00-000Z-1.jsonl",
      httpExchange(1),
    );
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficListBody>(`${server.origin}/api/v1/traffic`);

    expect(list.status).toBe(200);
    expect(list.body.exchanges).toHaveLength(1);
    expect(list.body.label).toBe("openai");
  });

  it("rejects non-loopback callers", async () => {
    const fixture = createFixture();
    writeDumpFile(fixture.trafficDir, "ocg-2026-09-17T00-00-00-000Z-1.jsonl", httpExchange(1));

    await expect(routeTrafficApi({
      apiPath: "/traffic",
      environment: fixture.environment,
      request: { socket: { remoteAddress: "10.0.0.5" } },
      response: {},
      url: new URL("http://127.0.0.1/api/v1/traffic"),
    })).rejects.toMatchObject({ message: "转储查看只允许回环访问", status: 503 });
  });
});

function createFixture({ explicitConfig = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codexc-webui-traffic-"));
  temporaryDirectories.push(root);
  const home = explicitConfig ? join(root, "default-home") : root;
  const dataDir = explicitConfig ? join(root, "configured") : root;
  mkdirSync(home, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const configPath = join(dataDir, "config.toml");
  const environment = {
    ...process.env,
    CODEX_CONNECT_CONFIG_FILE: explicitConfig ? configPath : "",
    CODEX_CONNECT_HOME: home,
    CODEX_HOME: join(home, "codex"),
  };
  writeGatewayConfig(configPath, {
    codex: { binary: "codex", socket_path: "runtime/app-server.sock" },
    debug: { model_traffic_dump: true, model_traffic_input_items: 3 },
    default_workspace: "main",
    network: {},
    telegram: { allowed_user_ids: [1], bot_token: "token", message_format: "html" },
    version: 1,
    workspaces: [{ cwd: join(home, "workspace"), id: "main", name: "Main" }],
  });
  const trafficDir = join(dataDir, "traffic");
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

interface TrafficLabelBody {
  files: number;
  label: string;
}

interface TrafficExchangeBody {
  [field: string]: unknown;
}

interface TrafficListBody {
  enabled: boolean;
  exchanges: TrafficExchangeBody[];
  label: string;
  labels: TrafficLabelBody[];
  nextOffset: number | null;
  session: string;
  total: number;
}

interface TrafficDetailBody {
  session: string;
  exchange: TrafficExchangeBody & {
    events: Array<{ payload: string; type: string }>;
    framePage: {
      nextOffset: number | null;
      offset: number;
      previousOffset: number | null;
      total: number;
    };
    frames: Array<{ direction: string; text: string; truncated: boolean }>;
    request: Record<string, unknown> | null;
    response: Record<string, unknown> | null;
  };
}

interface TrafficErrorBody {
  error: { code: string; message: string };
}

function writeDumpFile(
  directory: string,
  name: string,
  records: Array<Record<string, unknown>>,
): string {
  const path = join(directory, name);
  writeFileSync(
    path,
    records.map((record) => `${JSON.stringify({ ts: 1_700_000_000_000, ...record })}\n`).join(""),
    { mode: 0o600 },
  );
  return path;
}

function rewriteHttpExchange(
  records: Array<Record<string, unknown>>,
  startedAtMs: number,
  path: string,
): Array<Record<string, unknown>> {
  return records.map((record) => ({
    ...record,
    startedAtMs,
    ...(record.kind === "request_head" ? { path } : {}),
  }));
}

function httpExchange(id: number): Array<Record<string, unknown>> {
  const prefix = { account: "heforges", exchange: id, startedAtMs: 1_700_000_000_000 + id };
  const requestBody = JSON.stringify({ input: ["hello"], model: "deepseek-flash" });
  return [
    {
      ...prefix,
      headers: {
        authorization: "Bearer <redacted>",
        "content-type": "application/json",
        "x-codex-turn-metadata": JSON.stringify({
          request_kind: "turn",
          thread_id: `th-http000${id}`,
          turn_id: `tu-http000${id}`,
        }),
      },
      kind: "request_head",
      method: "POST",
      path: "/responses",
    },
    { ...prefix, kind: "request_body", part: 1, text: requestBody },
    { ...prefix, kind: "request_end", bytes: requestBody.length },
    { ...prefix, headers: { "content-type": "text/event-stream" }, kind: "response_head", status: 200 },
    {
      ...prefix,
      kind: "response_body",
      part: 1,
      text: `event: response.created\ndata: ${
        JSON.stringify({ response: { model: "deepseek-flash" }, type: "response.created" })
      }\n\nevent: response.output_text.done\ndata: ${
        JSON.stringify({ text: "OK", type: "response.output_text.done" })
      }\n\n`,
    },
    { ...prefix, kind: "response_end", bytes: 128, durationMs: 12 },
  ];
}

function websocketExchange(id: number): Array<Record<string, unknown>> {
  const prefix = { exchange: id, startedAtMs: 1_700_000_000_000 + id };
  return [
    {
      ...prefix,
      headers: { "user-agent": "codex-cli" },
      kind: "websocket_handshake",
      url: "wss://chatgpt.com/backend-api/codex/responses",
    },
    {
      ...prefix,
      direction: "client",
      kind: "websocket_frame",
      part: 1,
      text: JSON.stringify({
        client_metadata: { thread_id: `th-web000${id}` },
        model: "gpt-6-astra",
        type: "response.create",
      }),
    },
    {
      ...prefix,
      direction: "upstream",
      kind: "websocket_frame",
      part: 1,
      text: JSON.stringify({ response: { model: "gpt-6-astra" }, type: "response.completed" }),
    },
  ];
}

function splitWebSocketFrame(
  exchange: number,
  direction: "client" | "upstream",
  text: string,
): Array<Record<string, unknown>> {
  const chunks = [];
  for (let offset = 0; offset < text.length; offset += 1_048_576) {
    chunks.push(text.slice(offset, offset + 1_048_576));
  }
  return chunks.map((chunk, index) => ({
    direction,
    exchange,
    kind: "websocket_frame",
    part: index + 1,
    parts: chunks.length,
    startedAtMs: 1_700_000_000_000 + exchange,
    text: chunk,
  }));
}
