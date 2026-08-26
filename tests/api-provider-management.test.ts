import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readApiProviderKey } from "../runtime/api-provider-credential.mjs";
import { readGatewayConfig } from "../runtime/gateway-config.mjs";
import {
  deleteApiProvider,
  listApiProviders,
  saveApiProvider,
} from "../scripts/api-provider-management.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("direct API Provider management", () => {
  it("returns a structured credential-free list after creating a Provider", () => {
    const fixture = createFixture();

    const created = saveApiProvider({
      operation: "create",
      id: "relay-a",
      name: "中转 A",
      endpoint: "https://a.example/v1/responses",
      apiKey: "private-key-a",
    }, { environment: fixture.environment });

    expect(created).toMatchObject({
      action: "created",
      provider: {
        id: "relay-a",
        name: "中转 A",
        protocol: "responses",
        endpoint: "https://a.example/v1/responses",
        hasApiKey: true,
      },
      activation: "restart-gateway",
    });
    expect(listApiProviders(fixture.environment)).toEqual({
      configPath: fixture.configPath,
      providers: [created.provider],
    });
    expect(JSON.stringify(created)).not.toContain("private-key-a");
    expect(readFileSync(fixture.configPath, "utf8")).not.toContain("private-key-a");
  });

  it("updates metadata while retaining the existing Key, then deletes both", () => {
    const fixture = createFixture();
    saveApiProvider({
      operation: "create",
      id: "relay-a",
      name: "中转 A",
      endpoint: "https://a.example/v1/responses",
      apiKey: "private-key-a",
    }, { environment: fixture.environment });

    const updated = saveApiProvider({
      operation: "update",
      id: "relay-a",
      name: "中转 A2",
      endpoint: "https://a2.example/v1/responses",
    }, { environment: fixture.environment });

    expect(updated).toMatchObject({ action: "updated", provider: { name: "中转 A2" } });
    expect(readApiProviderKey(fixture.credentialsDirectory, "relay-a")).toBe("private-key-a");
    expect(deleteApiProvider("relay-a", { environment: fixture.environment }))
      .toMatchObject({
        action: "removed",
        provider: "relay-a",
        activation: "restart-gateway",
      });
    expect(readGatewayConfig(fixture.configPath).api_providers).toEqual([]);
    expect(() => readApiProviderKey(fixture.credentialsDirectory, "relay-a")).toThrow();
  });

  it("rolls back a new credential when the config transaction fails", () => {
    const fixture = createFixture();

    expect(() => saveApiProvider({
      operation: "create",
      id: "relay-a",
      name: "中转 A",
      endpoint: "https://a.example/v1/responses",
      apiKey: "private-key-a",
    }, {
      environment: fixture.environment,
      writeConfig: () => { throw new Error("配置写入失败"); },
    })).toThrow("配置写入失败");

    expect(readGatewayConfig(fixture.configPath).api_providers).toBeUndefined();
    expect(() => readApiProviderKey(fixture.credentialsDirectory, "relay-a")).toThrow();
  });
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-api-provider-management-"));
  roots.push(root);
  const home = join(root, ".codex-connect");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  const { configPath, dataDir } = initializeUserData({ environment, cwd: workspace });
  return {
    environment,
    configPath,
    credentialsDirectory: join(dataDir, "credentials"),
  };
}
