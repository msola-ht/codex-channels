import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigManagementError,
  loadGatewaySettings,
  updateGatewaySetting,
} from "../scripts/config-management.mjs";
import { GatewayConfigConflictError } from "../runtime/gateway-config.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Gateway Config management", () => {
  it("loads a credential-free structured settings model", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);

    expect(settings).toMatchObject({
      configPath: fixture.configPath,
      revision: expect.stringMatching(/^[0-9a-f]{64}$/u),
      display: {
        operationUpdates: "compact",
        planUpdatesEnabled: true,
        reasoningEnabled: true,
        priceCurrency: "cny",
      },
      system: {
        approvalTimeoutSeconds: 300,
        sandbox: "workspace-write",
        defaultWorkspace: expect.any(String),
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
      activation: "reinstall-services",
    });

    settings = loadGatewaySettings(fixture.environment);
    expect(settings.display.operationUpdates).toBe("full");
    expect(settings.network.https_proxy).toEqual({ configured: true });
    expect(JSON.stringify(settings)).not.toContain("127.0.0.1:7890");
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
      value: false,
    }, { environment: fixture.environment })).toThrow(expect.objectContaining({
      code: "required-revision",
      field: "revision",
    }));

    updateGatewaySetting({
      kind: "display.reasoning",
      value: false,
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
      value: false,
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
      value: false,
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

  it("removes a metrics backup when the config write conflicts", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);

    expect(() => updateGatewaySetting({
      kind: "metrics.disconnect",
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
      writeConfig: () => {
        throw new GatewayConfigConflictError();
      },
    })).toThrow(expect.objectContaining({ code: "stale-revision" }));
    expect(readdirSync(dirname(fixture.configPath)).filter((name) => name.includes(".bak-"))).toEqual([]);
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

  it("connects metrics with a private backup and credential-free status", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);

    const result = updateGatewaySetting({
      kind: "metrics.connect",
      endpoint: "http://127.0.0.1:8790",
      deviceToken: "private-device-token",
      viewToken: "private-view-token",
      deviceId: "device-a",
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });

    expect(result.backupPath).toEqual(expect.any(String));
    expect(result.activation).toBe("restart-all");
    expect(existsSync(result.backupPath!)).toBe(true);
    const updated = loadGatewaySettings(fixture.environment);
    expect(updated.metrics.sync).toMatchObject({
      enabled: true,
      endpoint: "http://127.0.0.1:8790/api/ingest",
      deviceId: "device-a",
      deviceTokenConfigured: true,
    });
    expect(updated.metrics.view).toMatchObject({
      enabled: true,
      endpoint: "http://127.0.0.1:8790",
      tokenConfigured: true,
    });
    expect(JSON.stringify(updated)).not.toContain("private-device-token");
    expect(JSON.stringify(updated)).not.toContain("private-view-token");
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

  it("keeps metrics center tokens distinct", () => {
    const fixture = createFixture();
    let settings = loadGatewaySettings(fixture.environment);
    updateGatewaySetting({
      kind: "metrics.center.token",
      field: "token",
      action: "set",
      value: "shared-token",
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });
    settings = loadGatewaySettings(fixture.environment);

    expect(() => updateGatewaySetting({
      kind: "metrics.center.token",
      field: "device_token",
      action: "set",
      value: "shared-token",
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    })).toThrow(expect.objectContaining({ code: "token-conflict" }));
  });

  it("returns the center-specific activation action", () => {
    const fixture = createFixture();
    const settings = loadGatewaySettings(fixture.environment);

    const result = updateGatewaySetting({
      kind: "metrics.center.enabled",
      value: true,
    }, {
      environment: fixture.environment,
      expectedRevision: settings.revision,
    });

    expect(result.activation).toBe("restart-center");
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-config-management-"));
  roots.push(root);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: join(root, ".codex-connect"),
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  const initialized = initializeUserData({ environment, cwd: root });
  return { environment, configPath: initialized.configPath };
}
