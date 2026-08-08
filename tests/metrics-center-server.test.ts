import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { createMetricsCenterServer, runCenterInfo } from "../scripts/metrics-center-server.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";
import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";

const temporaryDirectories: string[] = [];
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("metrics center server", () => {
  it("uses separate bearer tokens for device ingest and read queries", async () => {
    const { origin } = await startServer({
      token: "view-token",
      deviceToken: "device-token",
    });
    const payload = payloadBody([requestRow(1)], []);

    const rejectedIngest = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer view-token",
      },
      body: JSON.stringify(payload),
    });
    expect(rejectedIngest.status).toBe(401);

    const acceptedIngest = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer device-token",
      },
      body: JSON.stringify(payload),
    });
    expect(acceptedIngest.status).toBe(200);

    const rejectedQuery = await fetch(`${origin}/api/overview`, {
      headers: { authorization: "Bearer device-token" },
    });
    expect(rejectedQuery.status).toBe(401);
    const acceptedQuery = await fetch(`${origin}/api/overview`, {
      headers: { authorization: "Bearer view-token" },
    });
    expect(acceptedQuery.status).toBe(200);
  });

  it("rejects ingest without a token and accepts a valid payload", async () => {
    const { origin } = await startServer();
    const payload = payloadBody([requestRow(1)], []);

    const unauthorized = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(unauthorized.status).toBe(401);

    const accepted = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer device-token",
      },
      body: JSON.stringify(payload),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      ok: true,
      deviceId: "device-a",
      insertedRequests: 1,
      insertedSubagents: 0,
    });
  });

  it("stores requests, subagents and devices for global queries", async () => {
    const { origin } = await startServer();
    const payload = payloadBody(
      [requestRow(1), { ...requestRow(2), localId: 2, inputTokens: 2_000 }],
      [{
        threadId: "sub-1",
        parentThreadId: "main-1",
        agentPath: "/root/ds",
        recordedAtMs: 1_785_640_800_000,
      }],
    );
    await ingest(origin, payload);

    const overview = await fetchJson<OverviewResponse>(`${origin}/api/overview`);
    expect(overview.totals).toMatchObject({
      device_count: 1,
      request_count: 2,
      subagent_count: 1,
      total_tokens: 2_200,
    });
    expect(overview.providers).toEqual([
      expect.objectContaining({ provider: "deepseek", request_count: 2 }),
    ]);

    const devices = await fetchJson<DevicesResponse>(`${origin}/api/devices`);
    expect(devices.devices).toEqual([
      expect.objectContaining({
        device_id: "device-a",
        display_name: "device-a",
        request_count: 2,
        subagent_count: 1,
      }),
    ]);

    const requests = await fetchJson<RequestsResponse>(`${origin}/api/requests`);
    expect(requests.requests).toHaveLength(2);
    expect(requests.total).toBe(2);
    expect(requests.requests[0]).toMatchObject({
      device_id: "device-a",
      local_id: 2,
    });

    const subagents = await fetchJson<SubagentsResponse>(`${origin}/api/subagents`);
    expect(subagents.subagents).toEqual([
      expect.objectContaining({
        thread_id: "sub-1",
        parent_thread_id: "main-1",
      }),
    ]);
  });

  it("stores the reported device name and falls back to the device id", async () => {
    const { origin } = await startServer();
    await ingest(origin, payloadBody([requestRow(1)], []));
    await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer device-token",
      },
      body: JSON.stringify(payloadBody([requestRow(2)], [], "device-b")),
    });
    await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer device-token",
      },
      body: JSON.stringify({
        ...payloadBody([requestRow(3)], [], "device-c"),
        deviceName: "main-server",
      }),
    });

    const devices = await fetchJson<DevicesResponse>(`${origin}/api/devices`);
    const byId = new Map(devices.devices.map((row) => [row.device_id, row]));
    expect(byId.get("device-a")?.display_name).toBe("device-a");
    expect(byId.get("device-b")?.display_name).toBe("device-b");
    expect(byId.get("device-c")?.display_name).toBe("main-server");
    expect(byId.get("device-a")?.request_count).toBe(1);
  });

  it("deduplicates repeated uploads by device and local id", async () => {
    const { origin } = await startServer();
    const payload = payloadBody([requestRow(1)], []);
    await ingest(origin, payload);
    await ingest(origin, payload);

    const overview = await fetchJson<OverviewResponse>(`${origin}/api/overview`);
    expect(overview.totals.request_count).toBe(1);
  });

  it("overwrites replayed rows so reset watermarks can repair history", async () => {
    const { origin } = await startServer();
    await ingest(origin, payloadBody([requestRow(1)], []));
    await ingest(origin, payloadBody([
      { ...requestRow(1), provider: "openai", inputTokens: 9_999 },
    ], []));

    const overview = await fetchJson<OverviewResponse>(`${origin}/api/overview`);
    expect(overview.totals.request_count).toBe(1);
    const requests = await fetchJson<RequestsResponse>(`${origin}/api/requests`);
    expect(requests.requests[0]).toMatchObject({
      device_id: "device-a",
      local_id: 1,
      provider: "openai",
      input_tokens: 9_999,
    });
  });

  it("filters overview aggregates by device", async () => {
    const { origin } = await startServer();
    await ingest(origin, payloadBody([requestRow(1)], []));
    await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer device-token",
      },
      body: JSON.stringify(payloadBody(
        [{ ...requestRow(2), provider: "openai" }],
        [],
        "device-b",
      )),
    });

    const all = await fetchJson<OverviewResponse>(`${origin}/api/overview`);
    expect(all.totals).toMatchObject({
      device_count: 2,
      request_count: 2,
    });
    expect(all.providers).toHaveLength(2);

    const filtered = await fetchJson<OverviewResponse>(
      `${origin}/api/overview?device=device-a`,
    );
    expect(filtered.totals).toMatchObject({
      device_count: 1,
      request_count: 1,
      subagent_count: 0,
    });
    expect(filtered.providers).toEqual([
      expect.objectContaining({ provider: "deepseek", request_count: 1 }),
    ]);
    expect(filtered.costsByCurrency).toEqual([
      expect.objectContaining({ currency: "USD", request_count: 1 }),
    ]);
  });

  it("sorts request records by a whitelisted column", async () => {
    const { origin } = await startServer();
    await ingest(origin, payloadBody([
      requestRow(1),
      { ...requestRow(2), inputTokens: 2_000, outputTokens: 500 },
    ], []));

    const asc = await fetchJson<RequestsResponse>(
      `${origin}/api/requests?sort=input&direction=asc`,
    );
    expect(asc.requests.map((row) => row.input_tokens)).toEqual([1_000, 2_000]);

    const desc = await fetchJson<RequestsResponse>(
      `${origin}/api/requests?sort=input&direction=desc`,
    );
    expect(desc.requests.map((row) => row.input_tokens)).toEqual([2_000, 1_000]);
    expect(desc.total).toBe(2);
  });

  it("aggregates request metrics by day with device filtering", async () => {
    const { origin } = await startServer();
    const base = 1_785_640_800_000;
    await ingest(origin, payloadBody([
      requestRow(1),
      { ...requestRow(2), recordedAtMs: base + 86_400_000 },
    ], []));
    await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer device-token",
      },
      body: JSON.stringify(payloadBody(
        [{ ...requestRow(3), recordedAtMs: base + 2 * 86_400_000 }],
        [],
        "device-b",
      )),
    });

    const all = await fetchJson<DailyResponse>(
      `${origin}/api/daily?days=365`,
    );
    expect(all.daily).toHaveLength(3);
    expect(all.daily[1]).toMatchObject({
      request_count: 1,
      total_tokens: 1_100,
    });

    const filtered = await fetchJson<DailyResponse>(
      `${origin}/api/daily?days=365&device=device-a`,
    );
    expect(filtered.daily).toHaveLength(2);

    const bounded = await fetchJson<DailyResponse>(
      `${origin}/api/daily?days=1`,
    );
    expect(bounded.daily.length).toBeLessThanOrEqual(1);
  });

  it("rejects invalid payloads and exposes public health", async () => {
    const { origin } = await startServer();

    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const invalid = await fetch(`${origin}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer device-token",
      },
      body: JSON.stringify({ deviceId: "BAD ID", requestMetrics: [], subagentThreads: [] }),
    });
    expect(invalid.status).toBe(400);
  });

  it("prints the configured address, masked token and database path via info", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-center-info-"));
    temporaryDirectories.push(directory);
    const home = join(directory, ".codex-connect");
    const workspace = join(directory, "workspace");
    mkdirSync(workspace, { recursive: true });
    const environment = {
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    };
    initializeUserData({ environment, cwd: workspace });
    const configPath = join(home, "config.toml");
    const document = readGatewayConfig(configPath);
    document.metrics = {
      sync: { enabled: false, batch_size: 200, interval_seconds: 60 },
      center: {
        enabled: true,
        host: "0.0.0.0",
        port: 8790,
        token: "center-token",
        device_token: "device-token",
        database_path: "data/central-metrics.sqlite3",
      },
    };
    writeGatewayConfig(configPath, document);

    const output: string[] = [];
    await runCenterInfo({
      environment,
      output: { write: (value: string) => output.push(value) },
    });

    const printed = output.join("");
    expect(printed).toContain("监听地址：0.0.0.0:8790");
    expect(printed).toContain("/api/ingest");
    expect(printed).toContain("查看令牌");
    expect(printed).toContain("设备上报令牌");
    expect(printed).toContain("已设置（cent****oken）");
    expect(printed).toContain("已设置（devi****oken）");
    expect(printed).toContain("中心数据库");
    expect(printed).not.toContain("center-token");
    expect(printed).not.toContain("device-token");
  });
});

async function startServer({
  token = "center-token",
  deviceToken = "device-token",
}: {
  token?: string;
  deviceToken?: string;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "codexc-metrics-center-"));
  temporaryDirectories.push(directory);
  const instance = createMetricsCenterServer({
    host: "127.0.0.1",
    token,
    deviceToken,
    databasePath: join(directory, "central-metrics.sqlite3"),
  });
  await new Promise<void>((resolve) => {
    instance.server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(instance);
  const { port } = instance.server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}` };
}

async function ingest(origin: string, payload: unknown) {
  const response = await fetch(`${origin}/api/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer device-token",
    },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: "Bearer center-token" },
  });
  expect(response.status).toBe(200);
  return await response.json() as T;
}

interface OverviewResponse {
  totals: {
    device_count: number;
    request_count: number;
    subagent_count: number;
    total_tokens: number;
  };
  providers: Array<{ provider: string; request_count: number }>;
  costsByCurrency: Array<{
    currency: string;
    request_count: number;
    total_cost_nanos: number;
  }>;
}

interface DevicesResponse {
  devices: Array<{
    device_id: string;
    display_name: string;
    request_count: number;
    subagent_count: number;
  }>;
}

interface RequestsResponse {
  requests: Array<Record<string, unknown>>;
  total: number;
}

interface DailyResponse {
  daily: Array<{
    day: string;
    request_count: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
    total_cost_nanos: number;
  }>;
}

interface SubagentsResponse {
  subagents: Array<Record<string, unknown>>;
}

function payloadBody(
  requestMetrics: unknown[],
  subagentThreads: unknown[],
  deviceId = "device-a",
) {
  return {
    deviceId,
    requestMetrics,
    subagentThreads,
  };
}

function requestRow(localId: number) {
  return {
    localId,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    status: "completed",
    inputTokens: 1_000,
    cachedInputTokens: 900,
    outputTokens: 100,
    totalTokens: 1_100,
    recordedAtMs: 1_785_640_800_000,
    totalCostNanos: 6_000,
    pricing: { currency: "USD" },
  };
}
