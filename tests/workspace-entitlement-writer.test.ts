import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import { TomlWorkspaceEntitlementWriter } from "../src/bootstrap/workspace-entitlement-writer.js";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("TomlWorkspaceEntitlementWriter", () => {
  it("writes sandbox and approval policy back to the configuration", async () => {
    const fixture = createFixture();
    const writer = new TomlWorkspaceEntitlementWriter(fixture.configPath);

    const updated = await writer.updateWorkspaceEntitlements(
      "codex-connect",
      { kind: "sandbox", value: "danger-full-access" },
    );

    expect(updated.sandbox).toBe("danger-full-access");
    const entry = workspaceEntry(fixture.configPath);
    expect(entry).toMatchObject({ sandbox: "danger-full-access" });

    await writer.updateWorkspaceEntitlements(
      "codex-connect",
      { kind: "approval", value: "never" },
    );
    expect(workspaceEntry(fixture.configPath))
      .toMatchObject({ approval_policy: "never" });
  });

  it("rejects a permission profile while sandbox is configured", async () => {
    const fixture = createFixture();
    const writer = new TomlWorkspaceEntitlementWriter(fixture.configPath);
    await writer.updateWorkspaceEntitlements(
      "codex-connect",
      { kind: "sandbox", value: "workspace-write" },
    );

    await expect(writer.updateWorkspaceEntitlements(
      "codex-connect",
      { kind: "permissions", value: ":read-only" },
    )).rejects.toMatchObject({ code: "workspace.entitlement.conflict" });
    expect(workspaceEntry(fixture.configPath)).not.toHaveProperty("permissions");
  });

  it("clears configured entitlements with null values", async () => {
    const fixture = createFixture();
    const writer = new TomlWorkspaceEntitlementWriter(fixture.configPath);
    await writer.updateWorkspaceEntitlements(
      "codex-connect",
      { kind: "sandbox", value: "read-only" },
    );
    await writer.updateWorkspaceEntitlements(
      "codex-connect",
      { kind: "approval", value: "untrusted" },
    );

    await writer.updateWorkspaceEntitlements(
      "codex-connect",
      { kind: "sandbox", value: null },
    );
    await writer.updateWorkspaceEntitlements(
      "codex-connect",
      { kind: "approval", value: null },
    );

    const entry = workspaceEntry(fixture.configPath);
    expect(entry).not.toHaveProperty("sandbox");
    expect(entry).not.toHaveProperty("approval_policy");
  });
});

function createFixture(): { configPath: string; environment: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "codexc-entitlement-writer-"));
  roots.push(root);
  const home = join(root, ".codex-connect");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  const initialized = initializeUserData({ environment, cwd: workspace });
  return {
    configPath: initialized.configPath,
    environment,
  };
}

function workspaceEntry(configPath: string): {
  id: string;
  sandbox?: string;
  approval_policy?: string;
  permissions?: string;
} {
  const document = readGatewayConfig(configPath) as unknown as {
    workspaces: Array<{
      id: string;
      sandbox?: string;
      approval_policy?: string;
      permissions?: string;
    }>;
  };
  const entry = document.workspaces[0];
  if (!entry) {
    throw new Error("测试配置缺少 Workspace");
  }
  return entry;
}
