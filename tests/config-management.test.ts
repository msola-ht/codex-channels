import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigManagementError,
  loadGatewaySettings,
  updateGatewaySetting,
} from "../scripts/config-management.mjs";
import { readCodexProxySettings, readCodexProxySnapshot, renderCodexProxySettings, writeCodexProxySettings, writeCodexProxySnapshot } from "../runtime/codex-proxy-env.mjs";
import { configActivationResult } from "../scripts/config-activation-result.mjs";
import {
  GatewayConfigConflictError,
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Gateway Config management", () => {
  it.each([false, true])("rejects a competing proxy snapshot with existing file=%s", (existing) => {
    const fixture = createFixture();
    if (existing) writeCodexProxySettings({ no_proxy: "localhost" }, fixture.environment);
    const first = readCodexProxySnapshot(fixture.environment);
    const second = readCodexProxySnapshot(fixture.environment);
    writeCodexProxySnapshot(first, renderCodexProxySettings(first, { http_proxy: "http://localhost:7890" }));
    expect(() => writeCodexProxySnapshot(second, renderCodexProxySettings(second, { https_proxy: "http://localhost:7897" })))
      .toThrow(GatewayConfigConflictError);
    expect(readCodexProxySettings(fixture.environment)).toEqual({
      ...(existing ? { no_proxy: "localhost" } : {}), http_proxy: "http://localhost:7890",
    });
    writeCodexProxySettings({ https_proxy: "http://localhost:7897" }, fixture.environment);
    expect(readCodexProxySettings(fixture.environment).https_proxy).toBe("http://localhost:7897");
  });

  it("reports a proxy conflict occurring after the revision check without overwriting it", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);
    expect(() => updateGatewaySetting({
      kind: "network.proxy", field: "https_proxy", action: "set", value: "http://localhost:7897",
    }, {
      environment: fixture.environment, expectedRevision: settings.revision,
      writeProxyConfig: (_path, content, snapshot) => {
        writeCodexProxySettings({ http_proxy: "http://localhost:7890" }, fixture.environment);
        writeCodexProxySnapshot(snapshot, content);
      },
    })).toThrow(expect.objectContaining({ code: "stale-revision" }));
    expect(readCodexProxySettings(fixture.environment)).toEqual({ http_proxy: "http://localhost:7890" });
  });

  it("rejects a stale revision after only the proxy file changes", () => {
    const fixture = createFixture();
    const before = loadGatewaySettings(fixture.environment);
    writeCodexProxySettings({ https_proxy: "http://localhost:7897" }, fixture.environment);
    expect(loadGatewaySettings(fixture.environment).revision).not.toBe(before.revision);
    expect(() => updateGatewaySetting({
      kind: "network.proxy", field: "https_proxy", action: "set", value: "http://localhost:7898",
    }, { environment: fixture.environment, expectedRevision: before.revision }))
      .toThrow(expect.objectContaining({ code: "stale-revision" }));
    expect(readCodexProxySettings(fixture.environment).https_proxy).toBe("http://localhost:7897");
  });

  it("requires an HTTP route when saving or retaining SOCKS ALL_PROXY", () => {
    const fixture = createFixture();
    expect(() => writeCodexProxySettings({ all_proxy: "socks5://localhost:7897" }, fixture.environment))
      .toThrow("必须同时配置 HTTP_PROXY");
    writeCodexProxySettings({ http_proxy: "http://localhost:7897", all_proxy: "socks5://localhost:7897" }, fixture.environment);
    expect(() => writeCodexProxySettings({ http_proxy: null }, fixture.environment))
      .toThrow("必须同时配置 HTTP_PROXY");
    expect(readCodexProxySettings(fixture.environment).http_proxy).toBe("http://localhost:7897");
  });

  it("rejects invalid quoted suffixes while accepting trailing comments", () => {
    const fixture = createFixture();
    mkdirSync(fixture.environment.CODEX_HOME, { recursive: true });
    const path = join(fixture.environment.CODEX_HOME, ".env");
    writeFileSync(path, 'HTTPS_PROXY="http://localhost:7897"garbage\n');
    expect(() => readCodexProxySettings(fixture.environment)).toThrow("引号后存在无效内容");
    writeFileSync(path, 'HTTPS_PROXY="http://localhost:7897" # comment\n');
    expect(readCodexProxySettings(fixture.environment).https_proxy).toBe("http://localhost:7897");
  });

  it("projects activation scopes to stable targets and commands", () => {
    expect(configActivationResult("reload")).toEqual({
      status: "reload",
      target: "gateway",
      commands: ["codexc service reload"],
    });
    expect(configActivationResult("reinstall-services")).toEqual({
      status: "reinstall-required",
      target: "services",
      commands: ["codexc service install"],
    });
  });

  it("loads a credential-free structured settings model", () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.display = { operation_updates: "compact", plan_updates: true };
    writeGatewayConfig(fixture.configPath, document);
    const settings = loadGatewaySettings(fixture.environment);

    expect(settings).toMatchObject({
      configPath: fixture.configPath,
      revision: expect.stringMatching(/^[0-9a-f]{64}$/u),
      display: {
        operationUpdates: "compact",
        planUpdatesEnabled: true,
        reasoningEnabled: false,
      },
      system: {
        approvalTimeoutSeconds: 900,
        idleReleaseMinutes: 15,
        sandbox: "workspace-write",
        defaultWorkspace: expect.any(String),
        modelTrafficDumpEnabled: false,
        modelTrafficRetentionDays: 30,
      },
      automation: { scheduledTasksEnabled: false },
      advanced: { loggingLevel: "info", pluginApiEnabled: false },
    });
    expect(JSON.stringify(settings)).not.toContain("bot_token");
  });

  it("updates explicit settings and returns their activation requirement", () => {
    const fixture = createFixture();
    let settings = loadGatewaySettings(fixture.environment);

    expect(updateGatewaySetting({
      kind: "display.operation-updates",
      value: "full",
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    })).toMatchObject({
      value: "full",
      activation: "restart-gateway",
      activationResult: {
        status: "restart",
        target: "gateway",
        commands: ["codexc service restart gateway"],
      },
      previousRevision: settings.revision,
    });
    settings = loadGatewaySettings(fixture.environment);
    expect(updateGatewaySetting({
      kind: "network.proxy",
      field: "https_proxy",
      action: "set",
      value: "http://127.0.0.1:7890",
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    })).toMatchObject({
      value: { field: "https_proxy", configured: true },
      activation: "restart-all",
    });

    settings = loadGatewaySettings(fixture.environment);
    expect(settings.display.operationUpdates).toBe("full");
    expect(settings.network.https_proxy).toEqual({ configured: true });
    expect(JSON.stringify(settings)).not.toContain("127.0.0.1:7890");
  });

  it("updates the global conversation idle release minutes", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);

    const result = updateGatewaySetting({
      kind: "system.idle-release-minutes",
      value: 20,
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });

    expect(result).toMatchObject({
      value: 20,
      activation: "restart-gateway",
    });
    expect(readGatewayConfig(fixture.configPath).conversation).toMatchObject({
      idle_release_minutes: 20,
    });
  });

  it("writes and clears the App Server timezone", () => {
    const fixture = createFixture();
    let settings = loadGatewaySettings(fixture.environment);
    expect(settings.system.appServerTimezone).toBeNull();

    expect(updateGatewaySetting({
      kind: "system.app-server-timezone",
      value: "America/Los_Angeles",
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    })).toMatchObject({
      value: "America/Los_Angeles",
      activation: "restart-app-server-gateway-webui",
      activationResult: {
        target: "app-server-gateway-webui",
        commands: [
          "codexc service restart app-server",
          "codexc service restart gateway",
          "codexc service restart webui",
        ],
      },
    });
    expect(readGatewayConfig(fixture.configPath).codex ?? {}).toMatchObject({
      timezone: "America/Los_Angeles",
    });

    settings = loadGatewaySettings(fixture.environment);
    expect(settings.system.appServerTimezone).toBe("America/Los_Angeles");
    expect(() => updateGatewaySetting({
      kind: "system.app-server-timezone",
      value: "Los Angeles",
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    })).toThrow(expect.objectContaining({ code: "invalid-value", field: "value" }));

    updateGatewaySetting({
      kind: "system.app-server-timezone",
      value: null,
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });
    expect(readGatewayConfig(fixture.configPath).codex ?? {})
      .not.toHaveProperty("timezone");
  });

  it("updates the model traffic dump switch without replacing its size controls", () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.debug = {
      model_traffic_dump: false,
      model_traffic_input_items: 5,
      model_traffic_item_max_bytes: 32_768,
      model_traffic_retention_days: 14,
    };
    writeGatewayConfig(fixture.configPath, document);
    const settings = loadGatewaySettings(fixture.environment);

    const result = updateGatewaySetting({
      kind: "system.model-traffic-dump",
      value: true,
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });

    expect(result).toMatchObject({
      value: true,
      activation: "restart-app-server",
      activationResult: {
        status: "restart",
        target: "app-server",
        commands: ["codexc service restart app-server"],
      },
    });
    expect(readGatewayConfig(fixture.configPath).debug).toEqual({
      model_traffic_dump: true,
      model_traffic_input_items: 5,
      model_traffic_item_max_bytes: 32_768,
      model_traffic_retention_days: 14,
    });
  });

  it("updates model traffic retention without replacing other dump controls", () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.debug = {
      model_traffic_dump: true,
      model_traffic_input_items: 4,
      model_traffic_item_max_bytes: 16_384,
    };
    writeGatewayConfig(fixture.configPath, document);
    const settings = loadGatewaySettings(fixture.environment);

    const result = updateGatewaySetting({
      kind: "system.model-traffic-retention-days",
      value: 0,
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });

    expect(result).toMatchObject({ value: 0, activation: "restart-app-server" });
    expect(readGatewayConfig(fixture.configPath).debug).toMatchObject({
      model_traffic_dump: true,
      model_traffic_input_items: 4,
      model_traffic_item_max_bytes: 16_384,
      model_traffic_retention_days: 0,
    });
  });

  it("writes three proxy endpoints atomically", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);
    const result = updateGatewaySetting({
      kind: "network.proxy-batch",
      values: {
        http_proxy: "http://127.0.0.1:7890",
        https_proxy: "http://127.0.0.1:7891",
        all_proxy: "http://127.0.0.1:7892",
      },
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });

    expect(result).toMatchObject({
      value: { fields: ["http_proxy", "https_proxy", "all_proxy"] },
      activation: "restart-all",
    });
    expect(readCodexProxySettings(fixture.environment)).toEqual({
      http_proxy: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7891",
      all_proxy: "http://127.0.0.1:7892",
    });
  });

  it("rejects an invalid protocol in a shared proxy batch without partially writing valid fields", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);
    const before = readFileSync(fixture.configPath, "utf8");
    expect(() => updateGatewaySetting({
      kind: "network.proxy-batch",
      values: {
        http_proxy: "http://localhost:7897",
        https_proxy: "http://localhost:7897",
        all_proxy: "ftp://localhost:7897",
      },
    }, { environment: fixture.environment, expectedRevision: settings.revision }))
      .toThrow("ALL_PROXY 不支持此代理协议或缺少主机");
    expect(readFileSync(fixture.configPath, "utf8")).toBe(before);
  });

  it("returns stable field and code information for invalid input", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);

    expect(() => updateGatewaySetting({
      kind: "system.approval-timeout",
      value: 5,
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    })).toThrow(expect.objectContaining({
      name: "ConfigManagementError",
      code: "invalid-integer",
      field: "value",
    } satisfies Partial<ConfigManagementError>));
  });

  it("requires the loaded revision and rejects stale settings before writing", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);

    const callWithoutRevision = updateGatewaySetting as unknown as (
      input: unknown,
      options: unknown,
    ) => unknown;
    expect(() => callWithoutRevision({
      kind: "display.reasoning",
      value: true,
    }, { environment: fixture.environment })).toThrow(expect.objectContaining({
      code: "required-revision",
      field: "revision",
    }));

    updateGatewaySetting({
      kind: "display.reasoning",
      value: true,
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });
    expect(() => updateGatewaySetting({
      kind: "display.plan-updates",
      value: false,
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    })).toThrow(expect.objectContaining({
      code: "stale-revision",
      field: "revision",
    }));
  });

  it("rechecks the config immediately before the atomic write", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);
    const content = readFileSync(fixture.configPath, "utf8");
    let reads = 0;
    let writes = 0;

    expect(() => updateGatewaySetting({
      kind: "display.reasoning",
      value: true,
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
      readConfig: () => ++reads === 1 ? content : `${content}\n# concurrent change\n`,
      writeConfig: () => { writes += 1; },
    })).toThrow(expect.objectContaining({ code: "stale-revision" }));
    expect(writes).toBe(0);
  });

  it("maps a conflict inside the locked writer to a stable stale revision error", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);

    expect(() => updateGatewaySetting({
      kind: "display.reasoning",
      value: true,
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
      writeConfig: () => {
        throw new GatewayConfigConflictError();
      },
    })).toThrow(expect.objectContaining({
      code: "stale-revision",
      field: "revision",
    }));
  });

  it("manages WebUI settings without returning the access token", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);

    const result = updateGatewaySetting({
      kind: "webui.host",
      value: "0.0.0.0",
      token: "private-webui-token",
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });

    expect(result.activation).toBe("restart-webui");
    const updated = loadGatewaySettings(fixture.environment);
    expect(updated.webui).toEqual({ host: "0.0.0.0", port: 8787, tokenConfigured: true });
    expect(JSON.stringify(updated)).not.toContain("private-webui-token");
  });

  it("updates Workspace permissions and returns a stable conflict", () => {
    const fixture = createFixture();
    let settings = loadGatewaySettings(fixture.environment);
    const workspaceId = settings.workspaces[0]!.id;

    updateGatewaySetting({
      kind: "workspace.permissions",
      workspaceId,
      update: { kind: "sandbox", value: "workspace-write" },
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });
    settings = loadGatewaySettings(fixture.environment);
    expect(settings.workspaces[0]).toMatchObject({ sandbox: "workspace-write" });

    expect(() => updateGatewaySetting({
      kind: "workspace.permissions",
      workspaceId,
      update: { kind: "permissions", value: ":read-only" },
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    })).toThrow(expect.objectContaining({
      code: "permission-conflict",
      field: "update",
    }));
  });

});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-config-management-"));
  roots.push(root);
  const environment = {
    ...process.env,
    CODEX_HOME: join(root, ".codex"),
    CODEX_CONNECT_HOME: join(root, ".codex-connect"),
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  const initialized = initializeUserData({ environment, cwd: root });
  return { environment, configPath: initialized.configPath };
}
