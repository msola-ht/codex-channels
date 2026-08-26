import {
  mkdtempSync,
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

    expect(updateGatewaySetting({
      kind: "display.operation-updates",
      value: "full",
    }, { environment: fixture.environment })).toMatchObject({
      value: "full",
      activation: "restart-gateway",
    });
    expect(updateGatewaySetting({
      kind: "network.proxy",
      field: "https_proxy",
      action: "set",
      value: "http://127.0.0.1:7890",
    }, { environment: fixture.environment })).toMatchObject({
      value: { field: "https_proxy", configured: true },
      activation: "reinstall-services",
    });

    const settings = loadGatewaySettings(fixture.environment);
    expect(settings.display.operationUpdates).toBe("full");
    expect(settings.network.https_proxy).toEqual({ configured: true });
    expect(JSON.stringify(settings)).not.toContain("127.0.0.1:7890");
  });

  it("returns stable field and code information for invalid input", () => {
    const fixture = createFixture();

    expect(() => updateGatewaySetting({
      kind: "system.approval-timeout",
      value: 5,
    }, { environment: fixture.environment })).toThrow(expect.objectContaining({
      name: "ConfigManagementError",
      code: "invalid-integer",
      field: "value",
    } satisfies Partial<ConfigManagementError>));
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
