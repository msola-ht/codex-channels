import {createResponsesModelCatalog} from "../runtime/model-provider-responses-catalog.mjs";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ccgAccountsFilePath } from "../runtime/ccg-accounts.mjs";
import { deepseekAccountsFilePath } from "../runtime/deepseek-accounts.mjs";
import { opencodeGoAccountsFilePath, writeOpencodeGoAccounts } from "../runtime/opencode-go-accounts.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { ProviderAccountService } from "../src/application/index.js";
import { createManagedProviderAccountAdapters } from "../src/bootstrap/managed-provider-capabilities.js";
import { managedProviderMarkerPath } from "../runtime/model-provider-runtime.mjs";
import { clinePassProviderDefinition, ccgAccountDefinition } from "../runtime/model-provider-definitions.mjs";
import { configureCcgAccounts } from "./model-provider-runtime-test-fixture.js";
import type { OfficialAccountSnapshotsResponse } from "../scripts/webui-api.js";
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
  it("refreshes Cline quota and hides retained snapshots after configuration removal", async () => {
    const fixture = createFixture();
    new SqliteModelRequestMetricsStore(fixture.databasePath).close();
    const marker = managedProviderMarkerPath(fixture.environment, clinePassProviderDefinition);
    writePrivateFileAtomicSync(marker, 'version = 1\nprovider = "cline-pass"\nmode = "switching"\n');
    let fail = false;
    const service = new ProviderAccountService([{ provider: "cline-pass", accountUsage: async () => {
      if (fail) throw new Error("upstream unavailable");
      return { kind: "quota-windows", provider: "cline-pass", available: true,
        windows: [{ windowId: "weekly", label: "7天", usedPercent: 12.5, resetsAt: 1790922837, status: null }] };
    } }], { writeOfficialAccountSnapshot: snapshot => {
      const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
      try { store.upsertAccountSnapshot({ ...snapshot, sourceId: "cline-pass:default", accountId: null,
        displayName: "Cline Pass", enabled: true }); } finally { store.close(); }
    } });
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin,
      refreshGatewayAccount: async (_path, provider) => service.refreshAccountSnapshot(provider) });
    const read = async (): Promise<OfficialAccountSnapshotsResponse> => (await fetch(`${origin}/api/v1/accounts`)).json();
    const refresh = () => fetch(`${origin}/api/v1/management/accounts/refresh`, {
      method: "POST", headers: { origin: managementOrigin, "content-type": "application/json" },
      body: JSON.stringify({ provider: "cline-pass" }),
    });
    expect((await read()).snapshots).toContainEqual(expect.objectContaining({ provider: "cline-pass", observedAtMs: 0 }));
    expect((await refresh()).status).toBe(200);
    const before = await read();
    expect(before.snapshots[0]?.usage).toMatchObject({ kind: "quota-windows", windows: [{ usedPercent: 12.5 }] });
    fail = true;
    expect((await refresh()).status).toBe(503);
    expect(await read()).toEqual(before);
    unlinkSync(marker);
    expect((await read()).snapshots).toEqual([]);
    const store = new SqliteModelRequestMetricsStore(fixture.databasePath);
    try { expect(store.latestAccountSnapshots()).toHaveLength(1); } finally { store.close(); }
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
    expect(body.entries).toHaveLength(3);
    expect(body.entries.map((entry) => entry.target)).toEqual([
      "app-server", "gateway", "webui",
    ]);
    expect(body.entries.every((entry) => entry.version !== null)).toBe(true);
    expect(body.entries.find((entry) => entry.target === "gateway")?.version).toBe("0.156.1");
    expect(body.entries.find((entry) => entry.target === "app-server")?.version).toBe("0.156.1");
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
      expect.objectContaining({ provider: "ccg-team", accountId: "team", displayName: "CCG team", default: true, observedAtMs: 0 }),
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
    );
    expect(await response.json()).toMatchObject({
      snapshots: [{ provider: "deepseek", observedAtMs: 1_800_000_000_001 }],
    });
  });

});
