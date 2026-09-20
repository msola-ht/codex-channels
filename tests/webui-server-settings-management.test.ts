import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readGatewayConfig, writeGatewayConfig } from "../runtime/gateway-config.mjs";
import { loadGatewaySettings } from "../scripts/config-management.mjs";
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

describe("webui server settings and task management", () => {
  it("returns a redacted settings summary", async () => {
    const fixture = createFixture();
    const configPath = join(fixture.home, "config.toml");
    const document = readGatewayConfig(configPath);
    document.webui = { token: "webui-secret" };
    document.network = { https_proxy: "http://proxy-user:proxy-secret@proxy.invalid" };
    writeGatewayConfig(configPath, document);
    const { origin } = await startServer(fixture.environment);

    const response = await fetch(`${origin}/api/v1/settings/summary`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      revision: string;
      gateway: {
        webui: { tokenConfigured: boolean };
        network: { configuredFields: string[] };
        metrics: { storage: { retentionDays: number; maxRows: number } };
        system: { modelTrafficDumpEnabled: boolean; modelTrafficRetentionDays: number };
      };
      services: { available: boolean; entries: Array<{ target: string }> };
      cli: Array<{ command: string }>;
    };
    expect(body.revision).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.gateway).toMatchObject({
      webui: { tokenConfigured: true },
      network: { configuredFields: ["https_proxy"] },
      metrics: { storage: { retentionDays: 365, maxRows: 1_000_000 } },
      system: { modelTrafficDumpEnabled: false, modelTrafficRetentionDays: 30 },
    });
    expect(body.services.entries).toBeInstanceOf(Array);
    expect(new Set(body.services.entries.map((entry) => entry.target))).toEqual(new Set([
      "app-server",
      "gateway",
      "webui",
    ]));
    expect(body.cli.map((entry) => entry.command)).toContain("codexc service status all");
    expect(body.cli.map((entry) => entry.command)).toContain("codexc service status webui");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("webui-secret");
    expect(serialized).not.toContain("proxy-secret");
    expect(serialized).not.toContain(configPath);
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

  it("previews traffic cleanup with recognized dump counts", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(
      fixture.environment,
      undefined,
      { token: "webui-token", managementOrigin },
    );
    const response = await fetch(`${origin}/api/v1/management/tasks/preview`, {
      method: "POST",
      headers: {
        authorization: "Bearer webui-token",
        origin: managementOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "traffic", action: "cleanup" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      preview: {
        operation: "traffic",
        action: "cleanup",
        resource: {
          dumps: { bytes: 0, labels: 0, legacyFiles: 0, v2Sessions: 0 },
        },
      },
      confirmationToken: expect.any(String),
    });
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

  it("allows loopback settings management without a configured WebUI token", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });

    const settings = await fetch(`${origin}/api/v1/management/settings`);
    expect(settings.status).toBe(200);
    const body = await settings.json() as { revision: string };

    const update = await fetch(`${origin}/api/v1/management/settings`, {
      method: "PATCH",
      headers: {
        origin: managementOrigin,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        revision: body.revision,
        setting: { kind: "display.reasoning", value: false },
      }),
    });
    expect(update.status).toBe(200);
    expect(loadGatewaySettings(fixture.environment).display.reasoningEnabled).toBe(false);
  });

  it("updates traffic retention through WebUI settings management", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
    const current = await (await fetch(`${origin}/api/v1/management/settings`)).json() as {
      revision: string;
      system: { modelTrafficDumpEnabled: boolean; modelTrafficRetentionDays: number };
    };
    expect(current.system).toMatchObject({
      modelTrafficDumpEnabled: false,
      modelTrafficRetentionDays: 30,
    });

    const update = await fetch(`${origin}/api/v1/management/settings`, {
      method: "PATCH",
      headers: { origin: managementOrigin, "content-type": "application/json" },
      body: JSON.stringify({
        revision: current.revision,
        setting: { kind: "system.model-traffic-retention-days", value: 14 },
      }),
    });

    expect(update.status).toBe(200);
    expect(loadGatewaySettings(fixture.environment).system.modelTrafficRetentionDays).toBe(14);
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
      body: JSON.stringify({ revision: current.revision, setting: { kind: "metrics.storage.database-path", value: "/tmp/redirected.sqlite3" } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "setting_not_allowed" } });
  });

  it.each(["tool-access", "permissions"])("requires a one-time confirmation before changing %s", async (kind) => {
    const fixture = createFixture();
    const setting = { kind, path: ["computer_use", "default_app_access"], value: "allow" };
    const revision = `sha256:${"a".repeat(64)}`;
    let writes = 0;
    const result = { kind, previousVersion: revision, value: { path: setting.path, value: "allow" }, activation: "next-thread" as const };
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, {
      token: "webui-token", managementOrigin,
      loadCodexSettings: async () => ({ version: revision }),
      previewCodexSetting: async () => result,
      updateCodexSetting: async () => { writes += 1; return result; },
    });
    const headers = { authorization: "Bearer webui-token", origin: managementOrigin, "content-type": "application/json" };
    const body = { revision, setting };
    const url = `${origin}/api/v1/management/codex/settings`;
    const denied = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(body) });
    expect(denied.status).toBe(409);
    expect(writes).toBe(0);
    const preview = await fetch(`${url}/preview`, { method: "POST", headers, body: JSON.stringify(body) });
    expect(preview.status, await preview.clone().text()).toBe(200);
    const confirmation = await preview.json() as { confirmationRequired: boolean; confirmationToken: string };
    expect(confirmation.confirmationRequired).toBe(true);
    const confirmed = { ...body, confirmationToken: confirmation.confirmationToken };
    const saved = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(confirmed) });
    expect(saved.status).toBe(200);
    expect(writes).toBe(1);
    const replay = await fetch(url, { method: "PATCH", headers, body: JSON.stringify(confirmed) });
    expect(replay.status).toBe(409);
    expect(writes).toBe(1);
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
      previewCodexSetting: async (input: unknown) => ({ kind: (input as { kind: string }).kind, previousVersion: settings.version, value: { enabled: true }, activation: "next-thread" as const }),
      updateCodexSetting: async (input: unknown) => { settings = { ...settings, version: "codex-v2" }; return { kind: (input as { kind: string }).kind, previousVersion: "codex-v1", value: { enabled: true }, activation: "next-thread" as const }; },
    });
    const headers = { authorization: "Bearer webui-token" };
    const read = await fetch(`${origin}/api/v1/management/codex/settings`, { headers });
    expect(read.status).toBe(200);
    expect((await read.json()).version).toBe("codex-v1");
    const preview = await fetch(`${origin}/api/v1/management/codex/settings/preview`, { method: "POST", headers: { ...headers, origin: "http://127.0.0.1:0", "content-type": "application/json" }, body: JSON.stringify({ revision: "codex-v1", setting: { kind: "fast", enabled: true } }) });
    expect(preview.status).toBe(200);
    expect((await preview.json()).activation.status).toBe("next-thread");
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
        storage: { retentionDays: number; maxRows: number };
      };
      channels: unknown[];
    };
    expect(body).toMatchObject({
      system: { defaultWorkspace: "codex-connect" },
      network: { configuredFields: ["https_proxy"] },
      webui: { host: "127.0.0.1", port: 8787, tokenConfigured: true },
      metrics: {
        storage: { retentionDays: 365, maxRows: 1_000_000 },
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

  });

  it("does not expose a second management login when loopback management is tokenless", async () => {
    const fixture = createFixture();
    const managementOrigin = "http://127.0.0.1:0";
    const { origin } = await startServer(fixture.environment, undefined, { managementOrigin });
    const response = await fetch(`${origin}/api/v1/management/login`, {
      method: "POST",
      headers: { origin: managementOrigin, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
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

});
