import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  apiProviderCredentialPath,
  readApiProviderKey,
  writeApiProviderKey,
} from "../runtime/api-provider-credential.mjs";
import {
  readVisionApiKey,
  writeVisionApiKey,
} from "../runtime/vision-credential.mjs";
import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
import { runApiProviderSetup } from "../scripts/api-provider-setup.mjs";
import { initializeUserData } from "../scripts/runtime-config.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Third-party API provider setup", () => {
  it("stores multiple provider definitions and isolates each API key", async () => {
    const fixture = createFixture();
    await addProvider(fixture, "relay-a", "中转 A", "https://a.example/v1/responses", "key-a");
    await addProvider(fixture, "relay-b", "中转 B", "https://b.example/v1/responses", "key-b");

    expect(readGatewayConfig(fixture.configPath).api_providers).toEqual([
      {
        id: "relay-a",
        name: "中转 A",
        protocol: "responses",
        endpoint: "https://a.example/v1/responses",
      },
      {
        id: "relay-b",
        name: "中转 B",
        protocol: "responses",
        endpoint: "https://b.example/v1/responses",
      },
    ]);
    expect(readApiProviderKey(fixture.credentialsDirectory, "relay-a")).toBe("key-a");
    expect(readApiProviderKey(fixture.credentialsDirectory, "relay-b")).toBe("key-b");
    expect(readFileSync(fixture.configPath, "utf8")).not.toContain("key-a");
    expect(statSync(apiProviderCredentialPath(
      fixture.credentialsDirectory,
      "relay-a",
    )).mode & 0o777).toBe(0o600);
  });

  it("updates one provider without changing the others", async () => {
    const fixture = createFixture();
    await addProvider(fixture, "relay-a", "中转 A", "https://a.example/v1/responses", "key-a");
    await addProvider(fixture, "relay-b", "中转 B", "https://b.example/v1/responses", "key-b");
    await addProvider(fixture, "relay-a", "中转 A2", "https://a2.example/v1/responses", "");

    expect(readGatewayConfig(fixture.configPath).api_providers).toEqual([
      expect.objectContaining({ id: "relay-a", name: "中转 A2" }),
      expect.objectContaining({ id: "relay-b", name: "中转 B" }),
    ]);
    expect(readApiProviderKey(fixture.credentialsDirectory, "relay-a")).toBe("key-a");
  });

  it("rolls back a newly written key when config saving fails", async () => {
    const fixture = createFixture();

    await expect(runApiProviderSetup({
      environment: fixture.environment,
      output: fixture.output as unknown as NodeJS.WritableStream,
      writeConfig: () => { throw new Error("配置写入失败"); },
      prompts: promptFixture({
        selections: ["upsert"],
        texts: ["relay-a", "中转 A", "https://a.example/v1/responses"],
        passwords: ["key-a"],
      }),
    })).rejects.toThrow("配置写入失败");

    expect(() => readApiProviderKey(fixture.credentialsDirectory, "relay-a")).toThrow();
  });

  it("refuses to delete a provider selected by image recognition", async () => {
    const fixture = createFixture();
    await addProvider(fixture, "relay-a", "中转 A", "https://a.example/v1/responses", "key-a");
    const document = readGatewayConfig(fixture.configPath);
    document.vision = {
      mode: "responses_api",
      provider: "relay-a",
      model: "vision-model",
    };
    writeGatewayConfig(fixture.configPath, document);

    await expect(runApiProviderSetup({
      environment: fixture.environment,
      output: fixture.output as unknown as NodeJS.WritableStream,
      prompts: promptFixture({ selections: ["remove", "relay-a"] }),
    })).rejects.toThrow("仍被 vision 使用");

    expect(readApiProviderKey(fixture.credentialsDirectory, "relay-a")).toBe("key-a");
  });

  it("explicitly converts the old single-vision endpoint and credential", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.vision = {
      mode: "responses_api",
      endpoint: "https://legacy.example/v1/responses",
      model: "legacy-vision",
    };
    writeGatewayConfig(fixture.configPath, document);
    writeVisionApiKey(fixture.credentialsDirectory, "legacy-key");

    await runApiProviderSetup({
      environment: fixture.environment,
      output: fixture.output as unknown as NodeJS.WritableStream,
      prompts: promptFixture({
        selections: ["upsert"],
        texts: ["legacy-relay", "旧视觉中转", "https://legacy.example/v1/responses"],
        passwords: [""],
      }),
    });

    expect(readGatewayConfig(fixture.configPath).vision).toEqual({
      mode: "responses_api",
      provider: "legacy-relay",
      model: "legacy-vision",
    });
    expect(readApiProviderKey(fixture.credentialsDirectory, "legacy-relay")).toBe("legacy-key");
    expect(() => readVisionApiKey(fixture.credentialsDirectory)).toThrow();
  });

  it("does not reuse the legacy vision key when migration is declined", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.vision = {
      mode: "responses_api",
      endpoint: "https://legacy.example/v1/responses",
      model: "legacy-vision",
    };
    writeGatewayConfig(fixture.configPath, document);
    writeVisionApiKey(fixture.credentialsDirectory, "legacy-key");

    await expect(runApiProviderSetup({
      environment: fixture.environment,
      output: fixture.output as unknown as NodeJS.WritableStream,
      prompts: promptFixture({
        selections: ["upsert"],
        texts: ["new-relay", "新中转", "https://new.example/v1/responses"],
        passwords: [""],
        confirmations: [false],
      }),
    })).rejects.toThrow("API Key 不能为空");

    expect(() => readApiProviderKey(fixture.credentialsDirectory, "new-relay")).toThrow();
    expect(readVisionApiKey(fixture.credentialsDirectory)).toBe("legacy-key");
    expect(readGatewayConfig(fixture.configPath).api_providers).toBeUndefined();
  });

  it("does not leave a migrated provider key behind when config saving fails", async () => {
    const fixture = createFixture();
    const document = readGatewayConfig(fixture.configPath);
    document.vision = {
      mode: "responses_api",
      endpoint: "https://legacy.example/v1/responses",
      model: "legacy-vision",
    };
    writeGatewayConfig(fixture.configPath, document);
    writeVisionApiKey(fixture.credentialsDirectory, "legacy-key");

    await expect(runApiProviderSetup({
      environment: fixture.environment,
      output: fixture.output as unknown as NodeJS.WritableStream,
      writeConfig: () => { throw new Error("配置写入失败"); },
      prompts: promptFixture({
        selections: ["upsert"],
        texts: ["legacy-relay", "旧视觉中转", "https://legacy.example/v1/responses"],
        passwords: [""],
        confirmations: [true],
      }),
    })).rejects.toThrow("配置写入失败");

    expect(() => readApiProviderKey(fixture.credentialsDirectory, "legacy-relay")).toThrow();
    expect(readVisionApiKey(fixture.credentialsDirectory)).toBe("legacy-key");
  });

  it("rejects a symbolic-link provider credential directory", () => {
    const fixture = createFixture();
    const redirected = join(fixture.credentialsDirectory, "redirected");
    mkdirSync(redirected, { recursive: true, mode: 0o700 });
    const providersDirectory = join(fixture.credentialsDirectory, "api-providers");
    mkdirSync(providersDirectory, { mode: 0o700 });
    symlinkSync(redirected, join(providersDirectory, "relay-a"));

    expect(() => writeApiProviderKey(
      fixture.credentialsDirectory,
      "relay-a",
      "private-key",
    )).toThrow("凭据目录权限无效");
  });
});

async function addProvider(
  fixture: ReturnType<typeof createFixture>,
  id: string,
  name: string,
  endpoint: string,
  apiKey: string,
) {
  return runApiProviderSetup({
    environment: fixture.environment,
    output: fixture.output as unknown as NodeJS.WritableStream,
    prompts: promptFixture({
      selections: ["upsert"],
      texts: [id, name, endpoint],
      passwords: [apiKey],
    }),
  });
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-api-provider-setup-"));
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
    output: { write: () => true },
  };
}

function promptFixture({
  selections = [],
  texts = [],
  passwords = [],
  confirmations = [],
}: {
  selections?: string[];
  texts?: string[];
  passwords?: string[];
  confirmations?: boolean[];
} = {}) {
  return {
    select: vi.fn(async () => selections.shift()),
    text: vi.fn(async () => texts.shift() ?? ""),
    password: vi.fn(async () => passwords.shift() ?? ""),
    confirm: vi.fn(async () => confirmations.shift() ?? true),
    isCancel: () => false,
  };
}
