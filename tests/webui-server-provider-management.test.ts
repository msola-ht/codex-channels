import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeOpencodeGoAccounts } from "../runtime/opencode-go-accounts.mjs";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
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
    expect(body.entries.find((entry) => entry.target === "gateway")?.version).toBe("0.155.1");
    expect(body.entries.find((entry) => entry.target === "app-server")?.version).toBe("0.155.1");
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
      official: { authenticated: boolean };
      externalAgent: { status: string; provider?: string; model?: string };
    };
    expect(body.primary).toEqual({ id: "relay", displayName: "Relay", kind: "custom", mode: "exclusive" });
    expect(body.official).toEqual({ authenticated: true });
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
