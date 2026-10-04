// @ts-expect-error JavaScript WebUI route intentionally has no declaration file.
import { sendAccountSnapshots } from "../scripts/webui-management-provider-route.mjs";
import { GatewayAccountRefreshError, GatewayAccountRefreshServer } from "../runtime/gateway-account-refresh.mjs";
import { clinePassAccountsFilePath } from "../runtime/cline-pass-accounts.mjs";
import {createResponsesModelCatalog} from "../runtime/model-provider-responses-catalog.mjs";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ccgAccountsFilePath } from "../runtime/ccg-accounts.mjs";
import { deepseekAccountsFilePath } from "../runtime/deepseek-accounts.mjs";
import { opencodeGoAccountsFilePath, writeOpencodeGoAccounts } from "../runtime/opencode-go-accounts.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { ProviderAccountService } from "../src/application/index.js";
import { QueueEventsServer } from "../runtime/queue-events.mjs";
import { accountSnapshotEventsPath, metricsEventsPath } from "../runtime/metrics-events.mjs";
import { createManagedProviderAccountAdapters } from "../src/bootstrap/managed-provider-capabilities.js";
import { createClinePassAccountAdapter } from "../src/bootstrap/cline-pass-account-adapter.js";
import { ccgAccountDefinition } from "../runtime/model-provider-definitions.mjs";
import { configureCcgAccounts } from "./model-provider-runtime-test-fixture.js";
import type { OfficialAccountSnapshotsResponse, OfficialAccountSourcesResponse } from "../scripts/webui-api.js";
import {
  cleanupWebuiTestFixtures,
  createWebuiTestFixture,
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

describe("webui server Provider and account management", () => {
  it("adds matched credential refresh time to responses without storing it", async () => {
    const fixture = createFixture();
    const payload = { "https://api.openai.com/auth": { chatgpt_account_id: "account-a" } };
    writePrivateFileAtomicSync(join(fixture.environment.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: {
      id_token: `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`, access_token: "PRIVATE-TOKEN",
    }, last_refresh: "2026-09-23T02:41:57Z" }));
    const snapshot = { provider: "openai", accountId: null, observedAtMs: 1000, available: true,
      usage: null, limits: { kind: "rate-limits", provider: "openai", limits: { accountId: "account-a" } } };
    let body = "";
    const close = vi.fn();
    const response = { writeHead: vi.fn(), end: (value: string) => { body = value; } };
    const open = () => ({ latestAccountSnapshots: () => [snapshot], close });
    await sendAccountSnapshots(fixture.environment, response, open);
    expect(JSON.parse(body).snapshots[0].credentialRefreshedAt).toBe(1790131317);
    expect(body).not.toContain("PRIVATE-TOKEN");
    expect(body).not.toContain("id_token");
    expect(snapshot).not.toHaveProperty("credentialRefreshedAt");
    snapshot.limits.limits.accountId = "account-b";
    await sendAccountSnapshots(fixture.environment, response, open);
    expect(JSON.parse(body).snapshots[0].credentialRefreshedAt).toBeNull();
    expect(close).toHaveBeenCalledTimes(2);
  });
  it.each([1, 4, 16])("bounds refresh result rows for %i accounts plus one authoritative sync", async count => {
    const fixture = createFixture();
    const accounts = Array.from({ length: count }, (_,i) => ({ id: `a${i}`, default: i === 0 }));
    writePrivateFileAtomicSync(clinePassAccountsFilePath(fixture.environment), JSON.stringify(accounts));
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const now = Date.now();
    let rows = 0;
    const bodies: string[] = [];
    const latestAccountSnapshots = vi.fn(() => { const result = store.latestAccountSnapshots(); rows += result.length; return result; });
    const latestAccountSnapshot = vi.fn((provider: string) => { const result = store.latestAccountSnapshot(provider); rows += result ? 1 : 0; return result; });
    const close = vi.fn();
    const open = () => ({ latestAccountSnapshot, latestAccountSnapshots, close });
    const response = { writeHead: vi.fn(), end: (body: string) => { bodies.push(body); } };
    try {
      for (const account of accounts) store.upsertAccountSnapshot({ sourceId: `clp-${account.id}`, provider: `clp-${account.id}`,
        accountId: account.id, displayName: account.id, enabled: true, observedAtMs: now, available: true, usage: null, limits: null });
      for (const account of accounts) await sendAccountSnapshots(fixture.environment, response, open, `clp-${account.id}`);
      await sendAccountSnapshots(fixture.environment, response, open);
      expect(rows).toBe(2 * count);
      expect(latestAccountSnapshot).toHaveBeenCalledTimes(count);
      expect(latestAccountSnapshots).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(count + 1);
      expect(bodies.slice(0, count).map(body => (JSON.parse(body) as OfficialAccountSnapshotsResponse).snapshots.length)).toEqual(accounts.map(() => 1));
      const bytes = bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0);
      const fullBytes = Buffer.byteLength(bodies.at(-1)!);
      expect(bytes).toBeLessThanOrEqual((count + 1) * fullBytes);
      if (count > 1) expect(bytes).toBeLessThan((count + 1) * fullBytes);
    } finally { store.close(); }
  });

  it("returns only the refreshed Provider while retaining authoritative lists, warnings and removal checks", async () => {
    const fixture = createFixture();
    const registry = clinePassAccountsFilePath(fixture.environment);
    writePrivateFileAtomicSync(registry, JSON.stringify([{ id: "one", default: true }, { id: "two", default: false }]));
    writePrivateFileAtomicSync(deepseekAccountsFilePath(fixture.environment), "broken registry");
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const now = Date.now();
    for (const [provider, accountId] of [["clp-one", "one"], ["clp-two", "two"]]) {
      store.upsertAccountSnapshot({ sourceId: provider!, provider: provider!, accountId: accountId!, displayName: provider!,
        enabled: true, observedAtMs: now, available: true, usage: { kind: "quota-windows", windows: [] }, limits: null });
    }
    store.close();
    let removeDuringRefresh = false;
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin,
      refreshGatewayAccount: async () => {
        if (removeDuringRefresh) writePrivateFileAtomicSync(registry, JSON.stringify([{ id: "two", default: true }]));
      },
    });
    const refresh = async (): Promise<OfficialAccountSnapshotsResponse> => {
      const response = await fetch(`${origin}/api/v1/management/accounts/refresh`, { method: "POST",
        headers: { origin: managementOrigin, "content-type": "application/json" }, body: JSON.stringify({ provider: "clp-one" }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    const first = await refresh();
    expect(first.snapshots).toEqual([expect.objectContaining({ provider: "clp-one", observedAtMs: now, default: true })]);
    expect(first.warnings).toEqual([{ source: "deepseek", code: "registry_unavailable", message: "DeepSeek 账户元数据暂不可用" }]);
    const all = await (await fetch(`${origin}/api/v1/accounts`)).json() as OfficialAccountSnapshotsResponse;
    expect(all.snapshots.map(snapshot => snapshot.provider)).toEqual(["clp-one", "clp-two"]);
    removeDuringRefresh = true;
    expect((await refresh()).snapshots).toEqual([]);
    const remaining = await (await fetch(`${origin}/api/v1/accounts`)).json() as OfficialAccountSnapshotsResponse;
    expect(remaining.snapshots.map(snapshot => snapshot.provider)).toEqual(["clp-two"]);
  });

  it("lists refresh sources without a database, model catalogs, or provider summary, isolating bad registries", async () => {
    const fixture = createFixture();
    writePrivateFileAtomicSync(clinePassAccountsFilePath(fixture.environment), JSON.stringify([{ id: "test", default: true }]));
    writePrivateFileAtomicSync(deepseekAccountsFilePath(fixture.environment), "broken registry");
    const loadProviderState = vi.fn(async () => { throw new Error("unrelated model configuration"); });
    const { origin } = await startServer(fixture.environment, undefined, { loadProviderState });
    const response = await fetch(`${origin}/api/v1/management/accounts/sources`);
    expect(response.status).toBe(200);
    const result = await response.json() as OfficialAccountSourcesResponse;
    expect(result.accounts).toEqual([{ provider: "clp-test", accountId: "test", displayName: "Cline Pass test", default: true }]);
    expect(result.warnings).toEqual([{ source: "deepseek", code: "registry_unavailable", message: "DeepSeek 账户元数据暂不可用" }]);
    expect(loadProviderState).not.toHaveBeenCalled();
  });

  it("offers OpenAI refresh only for an authenticated official primary and isolates its invalid config", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);
    const read = async (): Promise<OfficialAccountSourcesResponse> => (await fetch(`${origin}/api/v1/management/accounts/sources`)).json();
    expect((await read()).accounts).toEqual([]);
    writePrivateFileAtomicSync(join(fixture.home, "auth.json"), "{}");
    writePrivateFileAtomicSync(join(fixture.home, "config.toml"), 'model_provider = "openai"\n');
    expect((await read()).accounts.map(account => account.provider)).toEqual(["openai"]);
    writePrivateFileAtomicSync(join(fixture.home, "config.toml"), 'model_provider = "ds-test"\n');
    expect((await read()).accounts).toEqual([]);
    writePrivateFileAtomicSync(clinePassAccountsFilePath(fixture.environment), JSON.stringify([{ id: "test", default: true }]));
    writePrivateFileAtomicSync(join(fixture.home, "config.toml"), 'model_provider = "secret-unclosed');
    const broken = await read();
    expect(broken.accounts.map(account => account.provider)).toEqual(["clp-test"]);
    expect(broken.warnings).toEqual([{ source: "openai", code: "registry_unavailable", message: "OpenAI 账户来源暂不可用" }]);
    expect(JSON.stringify(broken)).not.toContain("secret-unclosed");
  });
  it("keeps account refresh traffic separate from settings write limits", async () => {
    const fixture = createFixture();
    new SqliteModelRequestMetricsStore(fixture.databasePath).close();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, {
      managementOrigin, refreshGatewayAccount: async () => undefined,
    });
    const headers = { origin: managementOrigin, "content-type": "application/json" };
    for (let i = 0; i < 31; i += 1) {
      const response = await fetch(`${origin}/api/v1/management/accounts/refresh`, {
        method: "POST", headers, body: JSON.stringify({ provider: "clp-test" }),
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const preview = await fetch(`${origin}/api/v1/management/provider-settings/preview`, {
      method: "POST", headers, body: "{}",
    });
    // Invalid input still reaches validation, rather than exhausting the write quota.
    expect(preview.status).toBe(400);
  });
  it("keeps upstream authentication failure at HTTP 502 across real refresh IPC", async () => {
    const fixture = createFixture();
    const ipc = new GatewayAccountRefreshServer(join(fixture.home, "config.toml"), async () => {
      throw new GatewayAccountRefreshError("refresh_failed", "secret upstream response", { reason: "authentication" });
    });
    await ipc.start();
    try {
      const managementOrigin = "http://127.0.0.1:0";
      const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
      const response = await fetch(`${origin}/api/v1/management/accounts/refresh`, {
        method: "POST", headers: { origin: managementOrigin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "clp-main" }),
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({ error: { code: "refresh_failed", message: "账户认证失败，请检查配置" } });
    } finally { await ipc.close(); }
  });

  it("propagates browser disconnect through HTTP and real IPC to the account query", async () => {
    const fixture = createFixture();
    let upstream: AbortSignal | undefined;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const ipc = new GatewayAccountRefreshServer(join(fixture.home, "config.toml"), (_provider, signal) => {
      upstream = signal;
      ready();
      return new Promise<boolean>(() => {});
    });
    await ipc.start();
    try {
      const managementOrigin = "http://127.0.0.1:0";
      const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
      const controller = new AbortController();
      const request = fetch(`${origin}/api/v1/management/accounts/refresh`, {
        method: "POST", signal: controller.signal,
        headers: { origin: managementOrigin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "clp-main" }),
      });
      const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
      await started;
      controller.abort();
      await rejected;
      await vi.waitFor(() => expect(upstream?.aborted).toBe(true));
    } finally { await ipc.close(); }
  });

  it("refreshes Cline quota and hides retained snapshots after configuration removal", async () => {
    const fixture = createFixture();
    new SqliteModelRequestMetricsStore(fixture.databasePath).close();
    const marker = clinePassAccountsFilePath(fixture.environment);
    writePrivateFileAtomicSync(marker, JSON.stringify([{id:"test",default:true}]));
    const catalogPath = join(fixture.home, "providers", "clp", "models.json");
    writePrivateFileAtomicSync(catalogPath, JSON.stringify({ models: [{
      slug: "cline-pass/deepseek-v4.1-flash", display_name: "CLP", visibility: "list", supported_in_api: true,
      context_window: 64000, max_context_window: 128000, input_modalities: ["text"],
      default_reasoning_level: "high", supported_reasoning_levels: [{ effort: "high", description: "High" }],
    }] }));
    writePrivateFileAtomicSync(join(fixture.home, "providers", "clp", "accounts", "test", "managed.toml"),
      'version = 1\nprovider = "clp-test"\nmode = "switching"\n');
    writePrivateFileAtomicSync(join(fixture.home, "sf-clp-test.config.toml"), [
      'model = "cline-pass/deepseek-v4.1-flash"', 'model_provider = "clp-test"', 'model_reasoning_effort = "high"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`, '[model_providers.clp-test]', 'name = "clp-test"',
      'base_url = "https://api.cline.bot/api/v1"', 'wire_api = "responses"', 'requires_openai_auth = false',
      'supports_websockets = false', 'experimental_bearer_token = "sk_fixture-secret"', "",
    ].join("\n"));
    let fail = false;
    let usedPercent = 12.5;
    const upstream = vi.fn<typeof fetch>(async () => {
      if (fail) throw new Error("upstream unavailable");
      return Response.json({ success: true, data: { limits: ["five_hour", "weekly", "monthly"].map(type => ({
        type, percentUsed: usedPercent, resetsAt: "2026-10-25T06:33:57Z",
      })) } });
    });
    const service = new ProviderAccountService([createClinePassAccountAdapter({ provider: "clp-test",
      environment: fixture.environment, fetchImpl: upstream })], { writeOfficialAccountSnapshot: snapshot => {
      const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
      try { store.upsertAccountSnapshot({ ...snapshot, sourceId: "clp-test:test", accountId: null,
        displayName: "CLP", enabled: true }); } finally { store.close(); }
    } });
    const managementOrigin = "http://127.0.0.1:0";
    const failures: unknown[] = [];
    const ipc = new GatewayAccountRefreshServer(join(fixture.home, "config.toml"),
      async (provider, signal) => {
        try { return await service.refreshAccountSnapshot(provider, signal); }
        catch (error) { failures.push(error); throw error; }
      });
    await ipc.start();
    try {
      const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
      const read = async (): Promise<OfficialAccountSnapshotsResponse> => (await fetch(`${origin}/api/v1/accounts`)).json();
      const refresh = () => fetch(`${origin}/api/v1/management/accounts/refresh`, {
        method: "POST", headers: { origin: managementOrigin, "content-type": "application/json" },
        body: JSON.stringify({ provider: "clp-test" }),
      });
      expect((await read()).snapshots).toContainEqual(expect.objectContaining({ provider: "clp-test", observedAtMs: 0 }));
      expect(upstream).not.toHaveBeenCalled();
      const firstRefresh = await refresh();
      expect(failures).toEqual([]);
      expect(firstRefresh.status).toBe(200);
      expect(upstream).toHaveBeenCalledWith("https://api.cline.bot/api/v1/users/me/plan/usage-limits", expect.objectContaining({ method: "GET" }));
      usedPercent = 35;
      // No CLI, model request, or warmup: another WebUI refresh must query upstream again.
      expect((await refresh()).status).toBe(200);
      expect(upstream).toHaveBeenCalledTimes(2);
      const before = await read();
      expect(before.snapshots[0]?.usage).toMatchObject({ kind: "quota-windows", windows: [
        { usedPercent: 35 }, { usedPercent: 35 }, { usedPercent: 35 },
      ] });
      fail = true;
      expect((await refresh()).status).toBe(502);
      expect(await read()).toEqual(before);
      unlinkSync(marker);
      expect((await read()).snapshots).toEqual([]);
      const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
      try { expect(store.latestAccountSnapshots()).toHaveLength(1); } finally { store.close(); }
    } finally { await ipc.close(); }
  });
  it("isolates same-name accounts through CCG refresh, persistence, failure, recovery and OCG removal", async () => {
    const fixture = createFixture();
    configureCcgAccounts(fixture.home);
    const environment = { ...fixture.environment,
      CODEX_CONNECT_HOME: join(fixture.home, ".codex-connect"),
      CODEX_CONNECT_CONFIG_FILE: join(fixture.home, "config.toml"),
    };
    writePrivateFileAtomicSync(deepseekAccountsFilePath(environment), JSON.stringify([{ id: "main", default: true }]));
    writeOpencodeGoAccounts(environment, [{ id: "main", default: true }]);
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    for (const provider of ["ds-main", "ocg-main"]) {
      store.upsertAccountSnapshot({
        sourceId: `${provider}:main`, provider, accountId: "main", displayName: provider,
        enabled: true, observedAtMs: Date.now(), available: true,
        usage: { kind: provider === "ds-main" ? "balance" : "quota-windows", provider, available: true },
        limits: { kind: "unsupported", provider },
      });
    }
    store.close();
    let failMain = false;
    const upstreamFetch: typeof fetch = async (input, init) => {
      const key = new Headers(init?.headers).get("authorization");
      expect(["Bearer cmd_main-secret", "Bearer cmd_work-secret"]).toContain(key);
      const account = key === "Bearer cmd_main-secret" ? "main" : "work";
      const url = String(input);
      if (url.endsWith("/alpha/whoami?limits=1")) {
        return Response.json({ success: true, user: {}, org: { id: account } });
      }
      expect(url).toBe(`https://api.commandcode.ai/alpha/billing/credits?orgId=${account}`);
      return Response.json(failMain && account === "main" ? { error: "invalid credits" }
        : { credits: { monthlyCredits: account === "main" ? 10 : 20 } });
    };
    const adapters = createManagedProviderAccountAdapters([ccgAccountDefinition("main"), ccgAccountDefinition("work")], {
      environment, fetchImpl: upstreamFetch, metricsDatabasePath: fixture.databasePath,
    });
    const service = new ProviderAccountService(adapters, {
      writeOfficialAccountSnapshot: (snapshot) => {
        const writer = new SqliteModelRequestMetricsStore(fixture.databasePath);
        try {
          const accountId = snapshot.provider.slice("ccg-".length);
          writer.upsertAccountSnapshot({ ...snapshot, accountId,
            sourceId: `${snapshot.provider}:${accountId}`, displayName: snapshot.provider, enabled: true });
        } finally { writer.close(); }
      },
    });
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(environment, undefined, {
      managementOrigin,
      refreshGatewayAccount: async (_path, provider) => service.refreshAccountSnapshot(provider),
    });
    const refresh = (provider: string) => fetch(`${origin}/api/v1/management/accounts/refresh`, {
      method: "POST", headers: { origin: managementOrigin, "content-type": "application/json" },
      body: JSON.stringify({ provider }),
    });
    const read = async (): Promise<OfficialAccountSnapshotsResponse> => (await fetch(`${origin}/api/v1/accounts`)).json();
    expect((await refresh("ccg-main")).status).toBe(200);
    expect((await refresh("ccg-work")).status).toBe(200);
    const before = await read();
    expect(before.snapshots.find((snapshot) => snapshot.provider === "ccg-main")?.usage).toMatchObject({ totalRemaining: "10.00" });
    expect(before.snapshots.find((snapshot) => snapshot.provider === "ccg-work")?.usage).toMatchObject({ totalRemaining: "20.00" });
    failMain = true;
    expect((await refresh("ccg-main")).status).toBe(503);
    expect(await read()).toEqual(before);
    failMain = false;
    expect((await refresh("ccg-main")).status).toBe(200);
    unlinkSync(opencodeGoAccountsFilePath(environment));
    const after = await read();
    expect(after.snapshots.map((snapshot) => snapshot.provider).sort()).toEqual(["ccg-main", "ccg-work", "ds-main"]);
    expect(after.snapshots.find((snapshot) => snapshot.provider === "ds-main"))
      .toEqual(before.snapshots.find((snapshot) => snapshot.provider === "ds-main"));
  });
  it("returns persisted subscription facts from Gateway refresh and subsequent reads", async () => {
    const fixture = createFixture();
    writeOpencodeGoAccounts(fixture.environment, [{ id: "main", default: true }]);
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, {
      managementOrigin,
      refreshGatewayAccount: async () => {
        const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
        store.upsertAccountSnapshot({
          sourceId: "ocg-main:main", provider: "ocg-main", accountId: "main", displayName: "OCG",
          enabled: true, observedAtMs: Date.now(), available: false,
          usage: { kind: "subscription-required", provider: "ocg-main" },
          limits: { kind: "unsupported", provider: "ocg-main" },
        });
        store.close();
      },
    });
    const response = await fetch(`${origin}/api/v1/management/accounts/refresh`, {
      method: "POST", headers: { origin: managementOrigin, "content-type": "application/json" },
      body: JSON.stringify({ provider: "ocg-main" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.snapshots).toContainEqual(expect.objectContaining({ available: false, usage: { kind: "subscription-required", provider: "ocg-main" } }));
    const reread = await fetch(`${origin}/api/v1/accounts`);
    expect(await reread.json()).toEqual(body);
  });
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
      warnings: [],
    });
  });
  it("streams account snapshot invalidations independently of request metrics without refreshing upstream", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const accounts = new QueueEventsServer(accountSnapshotEventsPath(configPath));
    const metrics = new QueueEventsServer(metricsEventsPath(configPath));
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    const controllers: AbortController[] = [], readers: ReadableStreamDefaultReader<Uint8Array>[] = [], pending: Promise<void>[] = [];
    const received = ["", ""];
    let upstreamQueries = 0;
    try {
      await accounts.start(); await metrics.start();
      const { origin } = await startServer(fixture.environment, undefined, { token: "snapshot-token", refreshGatewayAccount: async () => { upstreamQueries += 1; } });
      const headers = { authorization: "Bearer snapshot-token" };
      expect((await fetch(`${origin}/api/v1/accounts/events`)).status).toBe(401);
      expect((await fetch(`${origin}/api/v1/accounts/events?token=snapshot-token`, { headers })).status).toBe(400);
      for (const [index, path] of ["accounts", "metrics"].entries()) {
        const controller = new AbortController(); controllers.push(controller);
        const response = await fetch(`${origin}/api/v1/${path}/events`, { headers, signal: controller.signal });
        expect(response.status).toBe(200);
        const reader = response.body!.getReader(); readers.push(reader);
        const decoder = new TextDecoder();
        pending.push((async () => {
          try { while (true) {
            const chunk = await reader.read(); if (chunk.done) return;
            received[index] += decoder.decode(chunk.value, { stream: true });
          } } catch (error) { if (!controller.signal.aborted) throw error; }
        })());
      }
      await expect.poll(() => received.map(value => (value.match(/"changed"/gu) ?? []).length)).toEqual([1, 1]);
      store.upsertAccountSnapshot({ sourceId: "deepseek:default", provider: "deepseek", accountId: null,
        displayName: "DeepSeek", enabled: true, observedAtMs: 1_800_000_000_000, available: true,
        usage: { kind: "balance", provider: "deepseek", available: true, balances: [] }, limits: { kind: "unsupported", provider: "deepseek" } });
      accounts.changed();
      await expect.poll(() => (received[0]!.match(/"changed"/gu) ?? []).length).toBe(2);
      expect((received[1]!.match(/"changed"/gu) ?? []).length).toBe(1);
      const snapshot = await fetch(`${origin}/api/v1/accounts`, { headers });
      expect(await snapshot.json()).toMatchObject({ observedAtMs: 1_800_000_000_000, snapshots: [{ provider: "deepseek" }] });
      expect(upstreamQueries).toBe(0);
      expect(received.join("")).not.toMatch(/deepseek|snapshot-token|observedAt/u);
    } finally {
      for (const controller of controllers) controller.abort();
      await Promise.all(pending); for (const reader of readers) reader.releaseLock();
      store.close(); await accounts.close(); await metrics.close();
    }
  });

  it("keeps other account snapshots available when the OCG registry is invalid", async () => {
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
    const registryDirectory = join(fixture.home, "providers", "opencode-go");
    mkdirSync(registryDirectory, { recursive: true, mode: 0o700 });
    const registryPath = join(registryDirectory, "accounts.json");
    writeFileSync(registryPath, "invalid\n", { mode: 0o600 });
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/accounts`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      snapshots: [{ provider: "deepseek", available: true }],
      warnings: [{
        source: "opencode-go",
        code: "registry_unavailable",
        message: "OpenCode Go 账户元数据暂不可用",
      }],
    });
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
      "app-server", "gateway", "webui", "model-relay",
    ]);
    expect(body.entries.every((entry) => entry.version !== null)).toBe(true);
    expect(body.entries.find((entry) => entry.target === "gateway")?.version).toBe("0.160.0");
    expect(body.entries.find((entry) => entry.target === "app-server")?.version).toBe("0.160.0");
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
      official: { authenticated: boolean };
    };
    expect(body.primary).toEqual({ id: "relay", displayName: "Relay", kind: "custom", mode: "exclusive" });
    expect(body.official).toEqual({ authenticated: true });
    expect(body.providers).toHaveLength(3);
    expect(body.providers.find((provider) => provider.id === "relay")).toMatchObject({ selected: true, model: null });
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

  it("does not expose the removed direct API Provider management route", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment, undefined, {
      token: "webui-token",
      managementOrigin: "http://127.0.0.1:0",
    });

    const response = await fetch(`${origin}/api/v1/management/api-providers`, {
      headers: { authorization: "Bearer webui-token" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("previews and saves valid basic model metadata larger than 64 KiB",async()=>{
    const fixture=createFixture();
    const models=Array.from({length:64},(_,i)=>({id:`model-${i}-`+"模".repeat(185),name:"名".repeat(120),contextWindow:64000,maxContextWindow:1048576,reasoningEfforts:["low","high","max"],defaultReasoningEffort:"high",supportsImages:true,template:{source:"deepseek" as const,model:"source-model",followContext:false}}));
    expect(createResponsesModelCatalog(models,models[0]!.id).models).toHaveLength(64);
    const provider={operation:"update",providerId:"rs-demo",name:"Demo",baseUrl:"https://example.test/v1",mode:"switching",model:models[0]!.id,catalog:{kind:"custom",models},supportsWebsockets:false,credential:{action:"preserve"}};
    const input={operation:"primary.custom.save",provider};
    const applied=vi.fn(async()=>({action:"updated",provider:{id:"rs-demo",displayName:"Demo"}}));
    const preview=vi.fn(async()=>({operation:"update",provider:{id:"rs-demo",displayName:"Demo",catalog:"custom",models},effects:{},activation:"restart-all"}));
    const {origin}=await startServer(fixture.environment,undefined,{
      token:"webui-token",managementOrigin:"http://127.0.0.1:0",
      loadProviderState:async()=>({configVersion:"v1",defaults:{},primary:{id:"openai",displayName:"OpenAI",kind:"official",mode:"exclusive",active:true},managedProviders:[],customProviders:{fixedCandidates:[],switchingProviders:[],backupCandidates:[]}}),
      previewProviderSettings:preview,applyProviderSettings:applied,
    });
    const headers={authorization:"Bearer webui-token",origin,"content-type":"application/json"};
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(65536);
    const response=await fetch(`${origin}/api/v1/management/provider-settings/preview`,{method:"POST",headers,body:JSON.stringify(input)});
    expect(response.status).toBe(200);
    const {confirmationToken}=await response.json() as {confirmationToken:string};
    const saved=await fetch(`${origin}/api/v1/management/provider-settings`,{method:"POST",headers,body:JSON.stringify({...input,confirmationToken})});
    expect(saved.status).toBe(200);
    expect(applied).toHaveBeenCalledWith(input,expect.any(Object),expect.any(Object));
    for(const path of ["provider-settings/preview","provider-settings"]) {
      const oversized=await fetch(`${origin}/api/v1/management/${path}`,{method:"POST",headers,body:JSON.stringify({padding:"x".repeat(2*1024*1024)})});
      expect(oversized.status).toBe(413);
    }
    expect(preview).toHaveBeenCalledTimes(2);
    expect(applied).toHaveBeenCalledOnce();
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
    };
    let appliedInput: unknown = null;
    const { origin } = await startServer(fixture.environment, undefined, {
      token: "webui-token",
      managementOrigin,
      loadProviderState: async () => providerState,
      previewProviderSettings: async (input: unknown) => {
        const normalized = input as { operation: string; providerId?: string };
        return {
          operation: "switch",
          target: { id: normalized.providerId ?? "unknown", displayName: "Relay", source: "switching" },
          activation: "restart-all",
          effects: { currentProviderId: "openai", restoresFromBackup: false },
        };
      },
      applyProviderSettings: async (input: unknown) => {
        appliedInput = input;
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
      method: "POST", headers,
      body: JSON.stringify({ operation: "external-agent", action: "configure", provider: "deepseek" }),
    });
    expect(agentPreview.status).toBe(400);
    expect(await agentPreview.json()).toMatchObject({ error: { code: "invalid_provider_operation" } });

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

  it("manages account settings with the shared token and redacted credentials", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    let appliedInput: unknown = null;
    const { origin } = await startServer(fixture.environment, undefined, {
      token: "webui-token",
      managementOrigin,
      loadAccountSettings: async () => ({
        opencodeGo: {
          configured: true,
          defaultAccountId: "main",
          accounts: [{ id: "main", displayName: "ocg-main", email: "main@example.com", default: true }],
        },
        deepseek: { configured: false, mode: null, model: null, restoreAvailable: false },
      }),
      previewAccountSettings: async (input: unknown) => ({
        operation: (input as { operation: string }).operation,
        account: { id: "main", displayName: "ocg-main", email: "main@example.com", exists: true },
        effects: { updatesExternalAgent: false },
        activation: "restart-all",
      }),
      applyAccountSettings: async (input: unknown) => {
        appliedInput = input;
        return { action: "configured", operation: "opencode.account.configure", account: { id: "main", displayName: "ocg-main" }, activation: "restart-all" };
      },
    });
    const headers = { origin: managementOrigin, authorization: "Bearer webui-token", "content-type": "application/json" };
    const resource = await fetch(`${origin}/api/v1/management/account-settings`, { headers: { authorization: "Bearer webui-token" } });
    expect(resource.status).toBe(200);
    expect((await resource.json() as { opencodeGo: { accounts: unknown[] } }).opencodeGo.accounts).toHaveLength(1);
    const preview = await fetch(`${origin}/api/v1/management/account-settings/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "opencode.account.configure", accountId: "main", contact: "main@example.com", apiKey: "secret-key" }),
    });
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { confirmationToken: string };
    expect(JSON.stringify(previewBody)).not.toContain("secret-key");
    const apply = await fetch(`${origin}/api/v1/management/account-settings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "opencode.account.configure", accountId: "main", contact: "main@example.com", apiKey: "secret-key", confirmationToken: previewBody.confirmationToken }),
    });
    expect(apply.status).toBe(200);
    expect(appliedInput).toMatchObject({ operation: "opencode.account.configure", apiKey: "secret-key" });
    expect(await apply.json()).toMatchObject({ action: "configured", auditStatus: "recorded" });
  });

  it("does not expose the removed direct provider account endpoints", async () => {
    const fixture = createFixture();
    const { origin } = await startServer(fixture.environment);

    expect((await fetch(`${origin}/api/v1/deepseek-balance`)).status).toBe(404);
    expect((await fetch(`${origin}/api/v1/opencode-go-usage`)).status).toBe(404);
  });

  it("returns the configured OCG contact display name for usage cards", async () => {
    const fixture = createFixture();
    writeOpencodeGoAccounts(fixture.environment, [{
      id: "main",
      default: true,
      email: "User@Example.com",
    }]);
    new SqliteModelRequestMetricsStore(fixture.databasePath).close();
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/accounts`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      snapshots: [{
        accountId: "main",
        displayName: "ocg-user@example.com",
        default: true,
        available: false,
      }],
    });
  });

  it("returns account metadata and empty snapshots for every managed account family", async () => {
    const fixture = createFixture();
    writePrivateFileAtomicSync(deepseekAccountsFilePath(fixture.environment), `${JSON.stringify([
      { id: "work", default: true },
    ])}\n`);
    writeOpencodeGoAccounts(fixture.environment, [{ id: "main", default: true, email: "main@example.com" }]);
    writePrivateFileAtomicSync(ccgAccountsFilePath(fixture.environment), `${JSON.stringify([
      { id: "team", default: true },
    ])}\n`);
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    store.upsertAccountSnapshot({
      sourceId: "ccg:default", provider: "ccg", accountId: null, displayName: "CCG",
      enabled: true, observedAtMs: 1, available: true,
      usage: { kind: "unsupported", provider: "ccg" },
      limits: { kind: "unsupported", provider: "ccg" },
    });
    store.close();
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/accounts`);

    expect(response.status).toBe(200);
    const snapshots = (await response.json()).snapshots;
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "ds-work", accountId: "work", displayName: "DS work", default: true, observedAtMs: 0 }),
      expect.objectContaining({ provider: "ocg-main", accountId: "main", displayName: "ocg-main@example.com", default: true, observedAtMs: 0 }),
      expect.objectContaining({ provider: "ccg-team", accountId: "team", displayName: "CommandCode Go team", default: true, observedAtMs: 0 }),
    ]));
    expect(snapshots).not.toContainEqual(expect.objectContaining({ provider: "ccg" }));
  });

  it("refreshes one account through Gateway and returns the updated snapshot", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const refreshGatewayAccount = vi.fn(async (_configPath: string, provider: string) => {
      const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
      store.upsertAccountSnapshot!({
        sourceId: `${provider}:default`,
        provider,
        accountId: null,
        displayName: "DeepSeek",
        enabled: true,
        observedAtMs: 1_800_000_000_001,
        available: true,
        usage: { kind: "balance", provider, available: true, balances: [] },
        limits: { kind: "unsupported", provider },
      });
      store.close();
    });
    const { origin } = await startServer(fixture.environment, undefined, {
      managementOrigin,
      refreshGatewayAccount,
    });

    const response = await fetch(`${origin}/api/v1/management/accounts/refresh`, {
      method: "POST",
      headers: { origin: managementOrigin, "content-type": "application/json" },
      body: JSON.stringify({ provider: "deepseek" }),
    });

    expect(response.status).toBe(200);
    expect(refreshGatewayAccount).toHaveBeenCalledWith(
      join(fixture.home, "config.toml"),
      "deepseek",
      expect.any(AbortSignal),
    );
    expect(await response.json()).toMatchObject({
      snapshots: [{ provider: "deepseek", observedAtMs: 1_800_000_000_001 }],
    });
  });

});

it.each(["configure", "default", "remove"] as const)("audits Cline account %s through confirmed WebUI writes without exposing credentials", async action => {
  const fixture = createFixture();
  writePrivateFileAtomicSync(join(fixture.home, "providers", "deepseek", "models.json"), JSON.stringify({ models: [{
    slug: "deepseek-flash", display_name: "DeepSeek Flash", visibility: "list", supported_in_api: true,
    context_window: 64000, max_context_window: 128000, input_modalities: ["text", "image"],
    default_reasoning_level: "high", supported_reasoning_levels: ["low", "high", "max"].map(effort => ({ effort, description: effort })),
  }] }));
  const managementOrigin = "http://127.0.0.1:0";
  const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
  const url = `${origin}/api/v1/management/account-settings`;
  const headers = { origin: managementOrigin, "content-type": "application/json" };
  const configure = { operation: "clp.configure", accountId: "main", apiKey: "sk_cline-private" };
  const preview = await fetch(`${url}/preview`, { method: "POST", headers, body: JSON.stringify(configure) });
  expect(preview.status).toBe(200);
  const confirmation = await preview.json() as { confirmationToken: string };
  expect(JSON.stringify(confirmation)).not.toContain("sk_cline-private");
  const saved = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...configure, confirmationToken: confirmation.confirmationToken }) });
  expect(saved.status).toBe(200);
  expect(await saved.text()).not.toContain("sk_cline-private");
  const settings = await (await fetch(url)).json() as { clinePass: { accounts: unknown[] } };
  expect(settings.clinePass.accounts).toEqual([{ id: "main", default: true, mode: "switching", model: "cline-pass/deepseek-v4.1-flash" }]);
  expect(JSON.stringify(settings)).not.toContain("sk_cline-private");
  const replay = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...configure, reconfigure: true, confirmationToken: confirmation.confirmationToken }) });
  expect(replay.status).not.toBe(200);
  const input = action === "configure"
    ? { ...configure, reconfigure: true, apiKey: "sk_rotated-private" }
    : { operation: `clp.${action}`, accountId: "main" };
  const response = await fetch(`${url}/preview`, { method: "POST", headers, body: JSON.stringify(input) });
  expect(response.status).toBe(200);
  const confirmed = await response.json() as { confirmationToken: string };
  const applied = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ...input, confirmationToken: confirmed.confirmationToken }) });
  expect(applied.status).toBe(200);
  expect(await applied.json()).toMatchObject({ auditStatus: "recorded" });
  const audit = readFileSync(join(fixture.home, "management-audit.jsonl"), "utf8");
  const records = audit.trim().split("\n").map(line => JSON.parse(line) as { operation: string; target: string; resultCode: string });
  expect(records.map(record => ({ operation: record.operation, target: record.target, resultCode: record.resultCode }))).toEqual(
    ["configured", action === "configure" ? "configured" : action === "default" ? "default-set" : "removed"].map(resultCode => ({ operation: "account-settings.write", target: "clp-main", resultCode })),
  );
  expect(audit).not.toContain("sk_cline-private");
  expect(audit).not.toContain("sk_rotated-private");
});
