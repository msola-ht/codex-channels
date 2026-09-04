import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { createWebuiServer, resolveWebuiSettings } from "../scripts/webui-server.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { createMetricsCenterServer } from "../scripts/metrics-center-server.mjs";
import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { writeOpencodeGoAccounts } from "../runtime/opencode-go-accounts.mjs";
import { loadGatewaySettings } from "../scripts/config-management.mjs";
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
  it("returns the latest unified account snapshots without calling provider APIs", async () => {
    const fixture = createFixture();
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    store.upsertAccountSnapshot!({
      sourceId: "deepseek:default",
      provider: "deepseek",
      accountId: null,
      displayName: "DeepSeek",
      enabled: true,
      observedAtMs: 1_800_000_000_000,
      available: true,
      usage: { kind: "balance", provider: "deepseek", available: true, balances: [] },
      limits: { kind: "unsupported", provider: "deepseek" },
    });
    store.close();
    const { origin } = await startServer(fixture.environment);
    const response = await fetch(`${origin}/api/v1/accounts`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      observedAtMs: 1_800_000_000_000,
      snapshots: [{ provider: "deepseek", available: true }],
    });
  });

  it("authenticates the health endpoint when WebUI exposes a token", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { token: "webui-token" },
    );

    const unauthorized = await fetch(`${origin}/api/v1/health`);
    expect(unauthorized.status).toBe(401);
    const authorized = await fetch(`${origin}/api/v1/health`, {
      headers: { authorization: "Bearer webui-token" },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ ok: true, service: "webui" });
  });

  it("returns 503 for global APIs when the center service is disabled", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/global/overview`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "metrics_view_unavailable" },
    });
  });

  it("proxies global metrics from the center service", async () => {
    const fixture = createFixture();
    const center = createMetricsCenterServer({
      host: "127.0.0.1",
      token: "center-token",
      deviceToken: "device-token",
      databasePath: join(fixture.home, "data", "central-metrics.sqlite3"),
    });
    await new Promise<void>((resolve) => {
      center.server.listen(0, "127.0.0.1", resolve);
    });
    servers.push(center);
    const { port } = center.server.address() as AddressInfo;

    const configPath = join(fixture.home, "config.toml");
    const document = readGatewayConfig(configPath);
    document.metrics = {
      sync: { enabled: false, batch_size: 200, interval_seconds: 60 },
      view: {
        enabled: true,
        endpoint: `http://127.0.0.1:${port}`,
        token: "center-token",
      },
    };
    writeGatewayConfig(configPath, document);

    const ingest = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer device-token",
      },
      body: JSON.stringify({
        deviceId: "device-a",
        requestMetrics: [{
          localId: 1,
          provider: "ocg-main",
          model: "deepseek-v4-flash",
          status: "completed",
          inputTokens: 1_000,
          outputTokens: 100,
          totalTokens: 1_100,
          weeklyQuota: {
            limitId: "codex",
            usedPercentMillionths: 10_000_000,
            resetsAt: 1_800_000_000,
          },
          // Keep the fixture inside the requested 30-day window regardless
          // of when the test suite is executed.
          recordedAtMs: Date.now() - 86_400_000,
        }],
        subagentThreads: [],
        providerIdentities: [{
          provider: "ocg-main",
          displayName: "ocg-user@example.com",
          email: "user@example.com",
        }],
      }),
    });
    expect(ingest.status).toBe(200);

    const { origin } = await startServer(fixture.environment);
    const overview = await fetch(`${origin}/api/v1/global/overview`);

    expect(overview.status).toBe(200);
    const body = await overview.json() as {
      totals: { request_count: number };
      providers: Array<{ provider: string; provider_display_name: string }>;
    };
    expect(body.totals.request_count).toBe(1);
    expect(body.providers).toEqual([
      expect.objectContaining({
        provider: "ocg-main",
        provider_display_name: "ocg-user@example.com",
      }),
    ]);

    const daily = await fetch(`${origin}/api/v1/global/daily?days=30`);
    expect(daily.status).toBe(200);
    const dailyBody = await daily.json() as {
      daily: Array<{ request_count: number }>;
    };
    expect(dailyBody.daily.reduce((sum, row) => sum + row.request_count, 0)).toBe(1);

    const quota = await fetch(`${origin}/api/v1/global/quota?days=365`);
    expect(quota.status).toBe(200);
    expect(await quota.json()).toMatchObject({
      periods: [expect.objectContaining({
        provider: "ocg-main",
        providerDisplayName: "ocg-user@example.com",
        windowId: "codex",
      })],
    });
  });

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
        planType: "plus",
        usedPercentMillionths: 12_500_000,
        resetsAt: Math.floor(Date.now() / 1_000) + 24 * 60 * 60,
      },
      errorMessage: "You've hit your usage limit",
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
        planType: string | null;
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

  it("returns a redacted settings summary without changing the legacy response", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const document = readGatewayConfig(configPath);
    document.webui = { token: "webui-secret" };
    document.network = { https_proxy: "http://proxy-user:proxy-secret@proxy.invalid" };
    document.metrics = {
      view: {
        enabled: true,
        endpoint: "https://metrics.example.com/private-path",
        token: "metrics-secret",
      },
    };
    writeGatewayConfig(configPath, document);
    const { origin } = await startServer(fixture.environment);

    const legacy = await fetch(`${origin}/api/v1/settings`);
    expect(await legacy.json()).toEqual({
      currency: "cny",
      exchangeRate: expect.objectContaining({ source: "cache", usdToCny: 7.2 }),
    });

    const response = await fetch(`${origin}/api/v1/settings/summary`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      revision: string;
      gateway: {
        webui: { tokenConfigured: boolean };
        network: { configuredFields: string[] };
        metrics: { view: { endpointConfigured: boolean; tokenConfigured: boolean } };
      };
      services: { available: boolean; entries: Array<{ target: string }> };
      cli: Array<{ command: string }>;
    };
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.gateway).toMatchObject({
      webui: { tokenConfigured: true },
      network: { configuredFields: ["https_proxy"] },
      metrics: { view: { endpointConfigured: true, tokenConfigured: true } },
    });
    expect(body.services.entries).toBeInstanceOf(Array);
    expect(new Set(body.services.entries.map((entry) => entry.target))).toEqual(new Set([
      "app-server",
      "gateway",
      "webui",
      "center",
    ]));
    expect(body.cli.map((entry) => entry.command)).toContain("codexc service status all");
    expect(body.cli.map((entry) => entry.command)).toContain("codexc service status webui");
    expect(body.cli.map((entry) => entry.command)).toContain("codexc service status center");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("webui-secret");
    expect(serialized).not.toContain("proxy-secret");
    expect(serialized).not.toContain("metrics-secret");
    expect(serialized).not.toContain("private-path");
    expect(serialized).not.toContain(configPath);
  });

  it("returns service status, versions and a redacted recent error through the shared WebUI token", async () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.home, "runtime", "gateway.error.log"),
      "Error: authorization: Bearer service-secret\n",
    );
    const { origin } = await startServer(fixture.environment, undefined, { token: "webui-token" });

    const response = await fetch(`${origin}/api/v1/management/services`, {
      headers: { authorization: "Bearer webui-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      available: boolean;
      entries: Array<{ target: string; version: string | null; recentError: { message: string } | null }>;
    };
    expect(body.entries).toHaveLength(4);
    expect(body.entries.map((entry) => entry.target)).toEqual([
      "app-server", "gateway", "webui", "center",
    ]);
    expect(body.entries.every((entry) => entry.version !== null)).toBe(true);
    expect(body.entries.find((entry) => entry.target === "gateway")?.version).toBe("0.152.0");
    expect(body.entries.find((entry) => entry.target === "app-server")?.version).toBe("0.152.0");
    const gateway = body.entries.find((entry) => entry.target === "gateway");
    expect(gateway?.recentError?.message).toBe("Error: authorization: Bearer [已隐藏]");
    expect(JSON.stringify(body)).not.toContain("service-secret");
  });

  it("returns a redacted Provider overview without credentials or profiles", async () => {
    const fixture = createFixture();
    let providerLoads = 0;
    const providerState = {
      configVersion: "v7",
      defaults: { model: "gpt-test", reasoningEffort: "high" },
      primary: { id: "relay", displayName: "Relay", kind: "custom", mode: "exclusive" },
      managedProviders: [{
        id: "deepseek",
        displayName: "DeepSeek",
        kind: "managed",
        mode: "switching",
        model: "deepseek-v4-flash",
        reasoningEffort: "high",
        models: [{ id: "deepseek-v4-flash" }],
      }],
      customProviders: {
        fixedCandidates: [{
          id: "relay",
          displayName: "Relay",
          kind: "custom",
          state: "configured",
          active: true,
          baseUrl: "https://user:secret@relay.example/v1",
        }],
        switchingProviders: [{
          id: "backup-relay",
          displayName: "Backup Relay",
          kind: "custom",
          mode: "switching",
          model: "gpt-test",
          reasoningEffort: "medium",
          baseUrl: "https://relay.example/v1",
          profileName: "sf-custom-backup-relay",
        }],
        backupCandidates: [],
      },
      switchingProviders: [],
      externalAgent: { status: "configured", provider: "deepseek", model: "deepseek-v4-flash" },
    };
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { token: "webui-token", loadProviderState: async () => { providerLoads += 1; return providerState; } },
    );

    const unauthorized = await fetch(`${origin}/api/v1/management/providers`);
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${origin}/api/v1/management/providers`, {
      headers: { authorization: "Bearer webui-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      providers: Array<Record<string, unknown>>;
      primary: { id: string; mode: string };
      externalAgent: { status: string; provider?: string; model?: string };
    };
    expect(body.primary).toEqual({ id: "relay", displayName: "Relay", kind: "custom", mode: "exclusive" });
    expect(body.providers).toHaveLength(3);
    expect(body.providers.find((provider) => provider.id === "relay")).toMatchObject({ selected: true, model: null });
    expect(body.externalAgent).toEqual({ status: "configured", provider: "deepseek", model: "deepseek-v4-flash" });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("sf-custom-backup-relay");
    expect(serialized).not.toContain("baseUrl");
    const cached = await fetch(`${origin}/api/v1/management/providers`, {
      headers: { authorization: "Bearer webui-token" },
    });
    expect(cached.status).toBe(200);
    expect(providerLoads).toBe(1);
  });

  it("fails closed when the Provider overview cannot be read", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { token: "webui-token", loadProviderState: async () => { throw new Error("provider read failed"); } },
    );
    const response = await fetch(`${origin}/api/v1/management/providers`, {
      headers: { authorization: "Bearer webui-token" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "provider_state_unavailable", message: "Provider 状态暂不可用，请使用 codexc setup 查看" },
    });
    const settingsResponse = await fetch(`${origin}/api/v1/management/provider-settings`, {
      headers: { authorization: "Bearer webui-token" },
    });
    expect(settingsResponse.status).toBe(503);
    expect(await settingsResponse.json()).toEqual({
      error: { code: "provider_state_unavailable", message: "Provider 设置暂不可用，请检查 Codex 配置" },
    });
  });

  it("manages direct API Providers with a one-time confirmation token and no key echo", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const document = readGatewayConfig(configPath);
    document.api_providers = [];
    writeGatewayConfig(configPath, document);
    const { origin } = await startServer(fixture.environment, undefined, {
      token: "webui-token",
      managementOrigin: "http://127.0.0.1:0",
    });
    const headers = { authorization: "Bearer webui-token", origin: "http://127.0.0.1:0", "content-type": "application/json" };
    const preview = await fetch(`${origin}/api/v1/management/api-providers/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "create", provider: { id: "relay", name: "Relay", endpoint: "https://relay.example/v1", apiKey: "secret-key" } }),
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { confirmationToken: string; preview: { provider: { apiKeyChange: boolean } } };
    expect(previewBody.preview.provider.apiKeyChange).toBe(true);
    expect(JSON.stringify(previewBody)).not.toContain("secret-key");
    const apply = await fetch(`${origin}/api/v1/management/api-providers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "save", provider: { operation: "create", id: "relay", name: "Relay", endpoint: "https://relay.example/v1", apiKey: "secret-key" }, confirmationToken: previewBody.confirmationToken }),
    });
    expect(apply.status).toBe(200);
    expect(JSON.stringify(await apply.json())).not.toContain("secret-key");
    const replay = await fetch(`${origin}/api/v1/management/api-providers`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "save", provider: { operation: "create", id: "relay", name: "Relay", endpoint: "https://relay.example/v1", apiKey: "secret-key" }, confirmationToken: previewBody.confirmationToken }),
    });
    expect(replay.status).toBe(409);
  });

  it("manages unified Provider settings with the shared token and one-time confirmation", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const providerState = {
      configVersion: "provider-v1",
      defaults: { model: "gpt-test", reasoningEffort: "medium" },
      primary: { id: "openai", displayName: "OpenAI", kind: "official", mode: "exclusive", active: true },
      managedProviders: [{
        id: "deepseek",
        displayName: "DeepSeek",
        kind: "managed",
        mode: "switching",
        model: "deepseek-v4-flash",
        reasoningEffort: "medium",
        models: [{ id: "deepseek-v4-flash", displayName: "DeepSeek V4 Flash", contextWindow: 128000 }],
      }],
      customProviders: { fixedCandidates: [], switchingProviders: [], backupCandidates: [] },
      externalAgent: { status: "unconfigured", provider: null, model: null },
    };
    let appliedInput: unknown = null;
    const { origin } = await startServer(fixture.environment, undefined, {
      token: "webui-token",
      managementOrigin,
      loadProviderState: async () => providerState,
      previewProviderSettings: async (input: unknown) => {
        const normalized = input as { operation: string; providerId?: string };
        if (normalized.operation === "external-agent") {
          return {
            operation: "configure",
            current: { configured: false, provider: null, model: null },
            selection: { provider: "deepseek", providerDisplayName: "DeepSeek", model: "deepseek-v4-flash", modelDisplayName: "DeepSeek V4 Flash" },
            willChange: true,
            activation: "restart-all",
          };
        }
        return {
          operation: "switch",
          target: { id: normalized.providerId ?? "unknown", displayName: "Relay", source: "switching" },
          activation: "restart-all",
          effects: { currentProviderId: "openai", restoresFromBackup: false },
        };
      },
      applyProviderSettings: async (input: unknown) => {
        appliedInput = input;
        if ((input as { operation?: string }).operation === "external-agent") {
          return {
            action: "configured",
            operation: "configure",
            selection: { provider: "deepseek", model: "deepseek-v4-flash" },
            activation: "restart-all",
          };
        }
        return {
          action: "switched",
          operation: "switch",
          target: { id: "relay", displayName: "Relay", source: "switching" },
          activation: "restart-all",
          effects: { currentProviderId: "openai", restoresFromBackup: false },
        };
      },
    });
    const headers = {
      origin: managementOrigin,
      authorization: "Bearer webui-token",
      "content-type": "application/json",
    };
    const resource = await fetch(`${origin}/api/v1/management/provider-settings`, {
      headers: { authorization: "Bearer webui-token" },
    });
    expect(resource.status).toBe(200);
    const resourceBody = await resource.json() as { resourceRevision: string; primary: { id: string }; managedProviders: unknown[] };
    expect(resourceBody.primary.id).toBe("openai");
    expect(resourceBody.managedProviders).toHaveLength(1);
    expect(resourceBody.resourceRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(resourceBody)).not.toContain("secret");

    const preview = await fetch(`${origin}/api/v1/management/provider-settings/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "primary.switch", providerId: "relay" }),
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { confirmationToken: string; preview: { operation: string } };
    expect(previewBody.preview.operation).toBe("switch");
    expect(previewBody.confirmationToken).toMatch(/^[A-Za-z0-9_-]+$/u);

    const agentPreview = await fetch(`${origin}/api/v1/management/provider-settings/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "external-agent", action: "configure", provider: "deepseek", model: "deepseek-v4-flash" }),
    });
    expect(agentPreview.status).toBe(200);
    const agentPreviewBody = await agentPreview.json() as { confirmationToken: string; preview: { selection?: { provider: string } } };
    expect(agentPreviewBody.preview.selection?.provider).toBe("deepseek");
    const agentApply = await fetch(`${origin}/api/v1/management/provider-settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "external-agent", action: "configure", provider: "deepseek", model: "deepseek-v4-flash", confirmationToken: agentPreviewBody.confirmationToken }),
    });
    expect(agentApply.status).toBe(200);
    expect(await agentApply.json()).toMatchObject({ action: "configured", auditStatus: "recorded" });
    const auditEntries = readFileSync(join(fixture.home, "management-audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { target?: string });
    expect(auditEntries.some((entry) => entry.target === "deepseek")).toBe(true);

    const apply = await fetch(`${origin}/api/v1/management/provider-settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "primary.switch", providerId: "relay", confirmationToken: previewBody.confirmationToken }),
    });
    expect(apply.status).toBe(200);
    expect(appliedInput).toEqual({ operation: "primary.switch", providerId: "relay" });
    expect(await apply.json()).toMatchObject({ action: "switched", auditStatus: "recorded" });

    const replay = await fetch(`${origin}/api/v1/management/provider-settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "primary.switch", providerId: "relay", confirmationToken: previewBody.confirmationToken }),
    });
    expect(replay.status).toBe(409);
  });

  it("previews and starts a confirmed source maintenance task without replay", async () => {
    const fixture = createFixture();
    const executableDirectory = mkdtempSync(join(tmpdir(), "codexc-webui-task-route-"));
    temporaryDirectories.push(executableDirectory);
    const executable = process.platform === "win32" ? join(executableDirectory, "codexc.cmd") : join(executableDirectory, "codexc");
    if (process.platform === "win32") {
      writeFileSync(executable, "@echo off\r\nexit /b 0\r\n", { mode: 0o700 });
    } else {
      writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      chmodSync(executable, 0o700);
    }
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(
      { ...fixture.environment, PATH: executableDirectory + delimiter },
      undefined,
      { token: "webui-token", managementOrigin },
    );
    const headers = { authorization: "Bearer webui-token", origin: managementOrigin, "content-type": "application/json" };
    const preview = await fetch(`${origin}/api/v1/management/tasks/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "update" }),
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { confirmationToken: string };
    const startBody = { operation: "update", confirmationToken: previewBody.confirmationToken };
    const started = await fetch(`${origin}/api/v1/management/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify(startBody),
    });
    expect(started.status).toBe(202);
    const taskId = (await started.json() as { id: string }).id;

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const list = await fetch(`${origin}/api/v1/management/tasks`, { headers: { authorization: "Bearer webui-token" } });
      expect(list.status).toBe(200);
      const task = (await list.json() as { tasks: Array<{ id: string; state: string }> }).tasks.find((candidate) => candidate.id === taskId);
      if (task?.state === "completed") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (attempt === 99) throw new Error("管理任务未在预期时间内完成");
    }

    const replay = await fetch(`${origin}/api/v1/management/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify(startBody),
    });
    expect(replay.status).toBe(409);
  });

  it("requires a one-time confirmation for secret-bearing Gateway settings", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { token: "webui-token", managementOrigin });
    const headers = { authorization: "Bearer webui-token", origin: managementOrigin, "content-type": "application/json" };
    const current = await (await fetch(`${origin}/api/v1/management/settings`, { headers })).json() as { revision: string };
    const preview = await fetch(`${origin}/api/v1/management/settings/preview`, { method: "POST", headers, body: JSON.stringify({ revision: current.revision, setting: { kind: "webui.token", action: "set", value: "new-secret" } }) });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { confirmationToken?: string; confirmationRequired?: boolean };
    expect(previewBody.confirmationRequired).toBe(true);
    expect(previewBody.confirmationToken).toEqual(expect.any(String));
    const update = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH", headers, body: JSON.stringify({ revision: current.revision, confirmationToken: previewBody.confirmationToken, setting: { kind: "webui.token", action: "set", value: "new-secret" } }) });
    expect(update.status).toBe(200);
  });

  it("protects low-risk management writes with the same WebUI token", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const unauthorized = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: managementOrigin } });
    expect(unauthorized.status).toBe(401);
    const settings = await fetch(`${origin}/api/v1/management/settings`, {
      headers: { authorization: "Bearer webui-token" },
    });
    expect(settings.status).toBe(200);
    const body = await settings.json() as { revision: string };
    const update = await fetch(`${origin}/api/v1/management/settings`, {
      method: "PATCH",
      headers: {
        origin: managementOrigin,
        authorization: "Bearer webui-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: body.revision,
        setting: { kind: "display.reasoning", value: false },
      }),
    });
    expect(update.status).toBe(200);
    expect(loadGatewaySettings(fixture.environment).display.reasoningEnabled).toBe(false);
    const legacyLogin = await fetch(`${origin}/api/v1/management/login`, {
      method: "POST",
      headers: {
        origin: managementOrigin,
        authorization: "Bearer webui-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(legacyLogin.status).toBe(404);
  });

  it("does not expose arbitrary metrics database paths through WebUI management", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const headers = {
      origin: managementOrigin,
      authorization: "Bearer webui-token",
      "content-type": "application/json",
    };
    const current = await (await fetch(`${origin}/api/v1/management/settings`, { headers })).json() as { revision: string };
    const response = await fetch(`${origin}/api/v1/management/settings/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ revision: current.revision, setting: { kind: "metrics.center.database-path", value: "/tmp/redirected.sqlite3" } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "setting_not_allowed" } });
  });

  it("reads, previews and writes App Server user settings through the shared management token", async () => {
    const fixture = createFixture();
    let settings = {
      version: "codex-v1",
      provider: "openai",
      defaultsEditable: true,
      models: [{ model: "gpt-test", displayName: "GPT Test", reasoningEfforts: [{ effort: "medium", description: "" }], defaultReasoningEffort: "medium", isDefault: true }],
      defaults: { model: "gpt-test", reasoningEffort: "medium", fastEnabled: false, webSearch: "disabled", updatePlanEnabled: false },
      permissions: { editable: true, defaultPermissions: null, sandboxMode: "read-only", approvalPolicy: "on-request", networkAccess: false },
    };
    const { origin } = await startServer(fixture.environment, undefined, {
      token: "webui-token",
      managementOrigin: "http://127.0.0.1:0",
      loadCodexSettings: async () => settings,
      previewCodexSetting: async (input: unknown) => ({ kind: (input as { kind: string }).kind, previousVersion: settings.version, value: { enabled: true }, activation: "restart-all" as const }),
      updateCodexSetting: async (input: unknown) => { settings = { ...settings, version: "codex-v2" }; return { kind: (input as { kind: string }).kind, previousVersion: "codex-v1", value: { enabled: true }, activation: "restart-all" as const }; },
    });
    const headers = { authorization: "Bearer webui-token" };
    const read = await fetch(`${origin}/api/v1/management/codex/settings`, { headers });
    expect(read.status).toBe(200);
    expect((await read.json()).version).toBe("codex-v1");
    const preview = await fetch(`${origin}/api/v1/management/codex/settings/preview`, { method: "POST", headers: { ...headers, origin: "http://127.0.0.1:0", "content-type": "application/json" }, body: JSON.stringify({ revision: "codex-v1", setting: { kind: "fast", enabled: true } }) });
    expect(preview.status).toBe(200);
    expect((await preview.json()).activation.status).toBe("restart");
    const update = await fetch(`${origin}/api/v1/management/codex/settings`, { method: "PATCH", headers: { ...headers, origin: "http://127.0.0.1:0", "content-type": "application/json" }, body: JSON.stringify({ revision: "codex-v1", setting: { kind: "fast", enabled: true } }) });
    expect(update.status).toBe(200);
    expect((await update.json()).revision).toBe("codex-v2");
  });

  it("returns one complete redacted configuration snapshot for the settings page", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const document = readGatewayConfig(configPath);
    document.webui = { host: "127.0.0.1", port: 8787, token: "webui-secret" };
    document.network = { https_proxy: "http://proxy-user:proxy-secret@proxy.invalid" };
    writeGatewayConfig(configPath, document);
    const { origin } = await startServer(fixture.environment, undefined, { token: "webui-secret" });

    const response = await fetch(`${origin}/api/v1/management/settings`, {
      headers: { authorization: "Bearer webui-secret" },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as {
      system: { defaultWorkspace: string | null };
      network: { configuredFields: string[] };
      webui: { host: string; port: number; tokenConfigured: boolean };
      metrics: {
        sync: { intervalSeconds: number; batchSize: number; deviceTokenConfigured: boolean };
        view: { tokenConfigured: boolean };
        center: { tokenConfigured: boolean; deviceTokenConfigured: boolean };
      };
      channels: unknown[];
    };
    expect(body).toMatchObject({
      system: { defaultWorkspace: "codex-connect" },
      network: { configuredFields: ["https_proxy"] },
      webui: { host: "127.0.0.1", port: 8787, tokenConfigured: true },
      metrics: {
        sync: { intervalSeconds: 60, batchSize: 200, deviceTokenConfigured: false },
        view: { tokenConfigured: false },
        center: { tokenConfigured: false, deviceTokenConfigured: false },
      },
      channels: expect.any(Array),
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("webui-secret");
    expect(serialized).not.toContain("proxy-secret");
  });

  it("normalizes structured metrics settings from the WebUI payload", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const settings = await fetch(`${origin}/api/v1/management/settings`, {
      headers: { authorization: "Bearer webui-token" },
    });
    const current = await settings.json() as {
      revision: string;
      metrics: {
        storage: { retentionDays: number; maxRows: number };
        sync: { intervalSeconds: number; batchSize: number };
      };
    };
    const retentionDays = current.metrics.storage.retentionDays === 30 ? 90 : 30;
    const preview = await fetch(`${origin}/api/v1/management/settings/preview`, {
      method: "POST",
      headers: {
        origin: managementOrigin,
        authorization: "Bearer webui-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: current.revision,
        setting: {
          kind: "metrics.storage",
          value: { retentionDays, maxRows: current.metrics.storage.maxRows },
        },
      }),
    });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ value: { storage: { retentionDays } } });

    const intervalSeconds = current.metrics.sync.intervalSeconds === 60 ? 300 : 60;
    const update = await fetch(`${origin}/api/v1/management/settings`, {
      method: "PATCH",
      headers: {
        origin: managementOrigin,
        authorization: "Bearer webui-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: current.revision,
        setting: {
          kind: "metrics.sync-params",
          value: { intervalSeconds, batchSize: current.metrics.sync.batchSize },
        },
      }),
    });
    expect(update.status).toBe(200);
    expect(loadGatewaySettings(fixture.environment).metrics.sync.intervalSeconds).toBe(intervalSeconds);
  });

  it("does not expose a second management login and reports missing WebUI auth", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
    const response = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: managementOrigin } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "management_requires_webui_token" } });
  });

  it("rejects management writes with stale revision and cross-origin requests", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const settings = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: managementOrigin, authorization: "Bearer webui-token" } });
    const current = await settings.json() as { revision: string; display: { reasoningEnabled: boolean } };
    const revision = current.revision;
    const changedValue = !current.display.reasoningEnabled;
    const crossOrigin = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH", headers: { origin: "https://evil.example", authorization: "Bearer webui-token", "content-type": "application/json" }, body: JSON.stringify({ revision, setting: { kind: "display.reasoning", value: changedValue } }) });
    expect(crossOrigin.status).toBe(403);
    const first = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH", headers: { origin: managementOrigin, authorization: "Bearer webui-token", "content-type": "application/json" }, body: JSON.stringify({ revision, setting: { kind: "display.reasoning", value: changedValue } }) });
    expect(first.status).toBe(200);
    const stale = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH", headers: { origin: managementOrigin, authorization: "Bearer webui-token", "content-type": "application/json" }, body: JSON.stringify({ revision, setting: { kind: "display.reasoning", value: !changedValue } }) });
    expect(stale.status).toBe(409);
  });

  it("fails closed when management audit storage is unavailable", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const settings = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: managementOrigin, authorization: "Bearer webui-token" } });
    const current = await settings.json() as { revision: string; display: { reasoningEnabled: boolean } };
    const auditPath = join(fixture.home, "management-audit.jsonl");
    mkdirSync(auditPath);
    const update = await fetch(`${origin}/api/v1/management/settings`, { method: "PATCH", headers: { origin: managementOrigin, authorization: "Bearer webui-token", "content-type": "application/json" }, body: JSON.stringify({ revision: current.revision, setting: { kind: "display.reasoning", value: !current.display.reasoningEnabled } }) });
    expect(update.status).toBe(500);
    expect((await update.json() as { error: { code: string } }).error.code).toBe("management_audit_unavailable");
    expect(loadGatewaySettings(fixture.environment).display.reasoningEnabled).toBe(current.display.reasoningEnabled);
  });

  it("rejects unauthorized, cross-origin, and unsupported management requests", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin, token: "webui-token" });
    const unauthorized = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: managementOrigin } });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("x-content-type-options")).toBe("nosniff");
    const crossOrigin = await fetch(`${origin}/api/v1/management/settings`, { headers: { origin: "https://evil.example", authorization: "Bearer webui-token" } });
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.headers.get("x-content-type-options")).toBe("nosniff");
    const unsupported = await fetch(`${origin}/api/v1/management/settings/preview`, { method: "POST", headers: { origin: managementOrigin, authorization: "Bearer webui-token", "content-type": "application/json" }, body: JSON.stringify({ revision: "0".repeat(64), setting: { kind: "credentials.api-key", value: "secret" } }) });
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json() as { error: { code: string } }).error.code).toBe("setting_not_allowed");
  });

  it("returns an actionable settings error before Gateway initialization", async () => {
    const home = mkdtempSync(join(tmpdir(), "codexc-webui-uninitialized-"));
    temporaryDirectories.push(home);
    const { origin } = await startServer({
      ...process.env,
      CODEX_CONNECT_HOME: home,
      CODEX_CONNECT_CONFIG_FILE: "",
    });

    const response = await fetch(`${origin}/api/v1/settings/summary`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "configuration_unavailable",
        message: "Gateway 尚未初始化，请先运行 codexc init",
      },
    });
  });

  it("reports deepseek balance as unavailable without credentials", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/deepseek-balance`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      available: boolean;
      balances: unknown[];
    };
    expect(body.available).toBe(false);
    expect(body.balances).toEqual([]);
  });

  it("reports opencode go usage as unavailable without credentials", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/opencode-go-usage`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      accounts: Array<{
        account: string;
        available: boolean;
        windows: unknown[];
      }>;
    };
    expect(body.accounts).toEqual([]);
  });

  it("returns the configured OCG contact display name for usage cards", async () => {
    const fixture = createFixture();
    writeOpencodeGoAccounts(fixture.environment, [{
      id: "main",
      default: true,
      email: "User@Example.com",
    }]);
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/opencode-go-usage`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accounts: [{
        account: "main",
        displayName: "ocg-user@example.com",
        available: false,
      }],
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
      requestStartedAtMs: 1_000,
    });
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "deepseek",
      pricing: pricingSnapshot(),
      threadId: "thread-1",
      turnId: "turn-1",
      requestStartedAtMs: 2_000,
    });
    recordSample(fixture.databasePath, {
      ...metricSample(),
      provider: "deepseek",
      pricing: pricingSnapshot(),
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
        totalCostCnyNanos: number | null;
      }>;
    };
    expect(threadsBody.threads).toHaveLength(1);
    expect(threadsBody.threads[0]).toMatchObject({
      threadId: "thread-1",
      turnCount: 2,
      compact: { requestCount: 1 },
      firstRequestStartedAtMs: 1_000,
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

    const calendarRange = await fetch(`${origin}/api/v1/overview?range=yesterday`);
    expect(calendarRange.status).toBe(200);

    const longRange = await fetch(`${origin}/api/v1/overview?range=365d`);
    expect(longRange.status).toBe(200);

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

  it("allows the loopback management path through an SSH tunnel when bound publicly", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { host: "0.0.0.0", token: "secret-token", managementOrigin },
    );
    const response = await fetch(`${origin}/api/v1/management/settings`, {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("revision");
  });
});

function createFixture() {
  const home = mkdtempSync(join(tmpdir(), "codexc-webui-"));
  temporaryDirectories.push(home);
  const environment = {
    ...process.env,
    CODEX_HOME: home,
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
    managementOrigin?: string
    loadProviderState?: (options: { environment: NodeJS.ProcessEnv }) => Promise<unknown>
    loadCodexSettings?: (options: { environment: NodeJS.ProcessEnv }) => Promise<unknown>
    previewCodexSetting?: (input: unknown, options: { environment: NodeJS.ProcessEnv; expectedVersion: string }) => Promise<unknown>
    updateCodexSetting?: (input: unknown, options: { environment: NodeJS.ProcessEnv; expectedVersion: string }) => Promise<unknown>
    previewProviderSettings?: (input: unknown, environment: NodeJS.ProcessEnv) => Promise<unknown>
    applyProviderSettings?: (input: unknown, environment: NodeJS.ProcessEnv, preview: unknown) => Promise<unknown>
  } = {},
) {
  const { server } = createWebuiServer({
    environment,
    ...(staticDir === undefined ? {} : { staticDir }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.managementOrigin === undefined ? {} : { managementOrigin: options.managementOrigin }),
    ...(options.loadProviderState === undefined ? {} : { loadProviderState: options.loadProviderState }),
    ...(options.loadCodexSettings === undefined ? {} : { loadCodexSettings: options.loadCodexSettings }),
    ...(options.previewCodexSetting === undefined ? {} : { previewCodexSetting: options.previewCodexSetting }),
    ...(options.updateCodexSetting === undefined ? {} : { updateCodexSetting: options.updateCodexSetting }),
    ...(options.previewProviderSettings === undefined ? {} : { previewProviderSettings: options.previewProviderSettings }),
    ...(options.applyProviderSettings === undefined ? {} : { applyProviderSettings: options.applyProviderSettings }),
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
    errorMessage: null,
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
