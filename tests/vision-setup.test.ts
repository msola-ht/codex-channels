import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readGatewayConfig,
  writeGatewayConfig,
} from "../runtime/gateway-config.mjs";
// @ts-expect-error JavaScript CLI helper intentionally has no declaration file.
import { initializeUserData } from "../scripts/runtime-config.mjs";
import { runVisionSetup } from "../scripts/vision-setup.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Vision setup", () => {
  it("selects one registered third-party API provider without copying its endpoint or key", async () => {
    const fixture = createFixture();
    addProvider(fixture.configPath, {
      id: "relay-a",
      name: "中转 A",
      protocol: "responses",
      endpoint: "https://relay.example/v1/responses",
    });
    const prompts = promptFixture({
      selections: ["responses_api", "relay-a"],
      texts: ["vision-model"],
    });

    await expect(runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      prompts,
    })).resolves.toMatchObject({ mode: "responses_api" });

    expect(readGatewayConfig(fixture.configPath).vision).toEqual({
      mode: "responses_api",
      provider: "relay-a",
      model: "vision-model",
    });
    expect(prompts.password).not.toHaveBeenCalled();
  });

  it("offers every registered provider for explicit switching", async () => {
    const fixture = createFixture();
    addProvider(fixture.configPath, {
      id: "relay-a",
      name: "中转 A",
      protocol: "responses",
      endpoint: "https://a.example/v1/responses",
    }, {
      id: "relay-b",
      name: "中转 B",
      protocol: "responses",
      endpoint: "https://b.example/v1/responses",
    });
    const prompts = promptFixture({
      selections: ["responses_api", "relay-b"],
      texts: ["vision-b"],
    });

    await runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      prompts,
    });

    const providerQuestion = prompts.select.mock.calls[1]?.[0] as unknown as {
      options: Array<{ value: string }>;
    };
    expect(providerQuestion.options.map((option) => option.value)).toEqual([
      "relay-a",
      "relay-b",
      "back",
    ]);
    expect(readGatewayConfig(fixture.configPath).vision).toEqual({
      mode: "responses_api",
      provider: "relay-b",
      model: "vision-b",
    });
  });

  it("requires a provider before enabling external image recognition", async () => {
    const fixture = createFixture();

    await expect(runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      prompts: promptFixture({ selections: ["responses_api"] }),
    })).rejects.toThrow("尚未配置第三方 API 提供商");
  });

  it("disables image recognition without deleting shared providers", async () => {
    const fixture = createFixture();
    addProvider(fixture.configPath, {
      id: "relay-a",
      name: "中转 A",
      protocol: "responses",
      endpoint: "https://relay.example/v1/responses",
    });

    await runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      prompts: promptFixture({ selections: ["disabled"] }),
    });

    const document = readGatewayConfig(fixture.configPath);
    expect(document.vision).toEqual({ mode: "disabled" });
    expect(document.api_providers).toHaveLength(1);
  });

  it("does not mutate config when saving fails", async () => {
    const fixture = createFixture();
    addProvider(fixture.configPath, {
      id: "relay-a",
      name: "中转 A",
      protocol: "responses",
      endpoint: "https://relay.example/v1/responses",
    });
    const before = readGatewayConfig(fixture.configPath).vision;

    await expect(runVisionSetup({
      environment: fixture.environment,
      output: fixture.output,
      writeConfig: () => { throw new Error("配置写入失败"); },
      prompts: promptFixture({
        selections: ["responses_api", "relay-a"],
        texts: ["vision-model"],
      }),
    })).rejects.toThrow("配置写入失败");

    expect(readGatewayConfig(fixture.configPath).vision).toEqual(before);
  });
});

interface ProviderFixture {
  id: string;
  name: string;
  protocol: "responses";
  endpoint: string;
}

function addProvider(configPath: string, ...providers: ProviderFixture[]) {
  const document = readGatewayConfig(configPath);
  document.api_providers = providers as never;
  writeGatewayConfig(configPath, document);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "codexc-vision-setup-"));
  roots.push(root);
  const home = join(root, ".codex-connect");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const environment = {
    ...process.env,
    CODEX_CONNECT_HOME: home,
    CODEX_CONNECT_CONFIG_FILE: "",
  };
  const { configPath } = initializeUserData({ environment, cwd: workspace });
  return {
    environment,
    configPath,
    output: { write: (value: string) => { void value; return true; } },
  };
}

function promptFixture({
  selections = [],
  texts = [],
}: {
  selections?: string[];
  texts?: string[];
} = {}) {
  return {
    select: vi.fn(async (question?: unknown) => {
      void question;
      return selections.shift();
    }),
    text: vi.fn(async () => texts.shift() ?? ""),
    password: vi.fn(),
    isCancel: () => false,
  };
}
