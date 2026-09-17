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
    expect(await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic?limit=0`))
      .toMatchObject({ body: { error: { code: "invalid_parameter" } }, status: 400 });
    expect(await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic/exchange`))
      .toMatchObject({ body: { error: { code: "missing_parameter" } }, status: 400 });
    expect(await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic/exchange?id=99`))
      .toMatchObject({ body: { error: { code: "traffic_exchange_not_found" } }, status: 404 });
  });

  it("reports an unavailable dump directory with an actionable message", async () => {
    const fixture = createFixture();
    const server = await startServer(fixture.environment);

    const list = await getJson<TrafficErrorBody>(`${server.origin}/api/v1/traffic`);

    expect(list.status).toBe(503);
    expect(list.body.error.code).toBe("traffic_unavailable");
    expect(list.body.error.message).toContain("model_traffic_dump");
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

function createFixture() {
  const home = mkdtempSync(join(tmpdir(), "codexc-webui-traffic-"));
  temporaryDirectories.push(home);
  const environment = {
    ...process.env,
    CODEX_CONNECT_CONFIG_FILE: "",
    CODEX_CONNECT_HOME: home,
    CODEX_HOME: join(home, "codex"),
  };
  writeGatewayConfig(join(home, "config.toml"), {
    codex: { binary: "codex", socket_path: "runtime/app-server.sock" },
    debug: { model_traffic_dump: true, model_traffic_input_items: 3 },
    default_workspace: "main",
    network: {},
    telegram: { allowed_user_ids: [1], bot_token: "token", message_format: "html" },
    version: 1,
    workspaces: [{ cwd: join(home, "workspace"), id: "main", name: "Main" }],
  });
  const trafficDir = join(home, "traffic");
  mkdirSync(trafficDir, { recursive: true });
  return { environment, home, trafficDir };
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
  total: number;
}

interface TrafficDetailBody {
  exchange: TrafficExchangeBody & {
    events: Array<{ type: string }>;
    request: Record<string, unknown> | null;
    response: Record<string, unknown> | null;
  };
}

interface TrafficErrorBody {
  error: { code: string; message: string };
}

function writeDumpFile(directory: string, name: string, records: Array<Record<string, unknown>>) {
  writeFileSync(
    join(directory, name),
    records.map((record) => `${JSON.stringify({ ts: 1_700_000_000_000, ...record })}\n`).join(""),
    { mode: 0o600 },
  );
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
