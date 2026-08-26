import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
