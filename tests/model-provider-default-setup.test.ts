import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import { runModelProviderDefaultSetup } from "../scripts/model-provider-default-setup.mjs";
import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../runtime/private-file.mjs";

describe("managed model provider default setup", () => {
  it("updates only the selected switching Provider profile", async () => {
    const codexHome = providerFixture("switching");
    const output = { write: vi.fn() };

    await expect(runModelProviderDefaultSetup({
      environment: testEnvironment(codexHome),
      output,
      prompter: {
        selectProvider: async () => "deepseek",
        selectModel: async () => "deepseek-v4-pro",
        selectReasoningEffort: async () => "max",
        selectAutoCompactPercent: async () => 75,
      },
    })).resolves.toEqual({
      action: "configured",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactPercent: 75,
      mode: "switching",
      activation: "restart-app-server",
      activationResult: {
        status: "restart",
        target: "app-server",
        commands: ["codexc service restart app-server"],
      },
    });

    const profile = parse(readFileSync(join(codexHome, "sf-deepseek.config.toml"), "utf8"));
    expect(profile).toMatchObject({
      model: "deepseek-v4-pro",
      model_provider: "deepseek",
    });
    expect(profile.model_reasoning_effort).toBe("max");
    const catalog = JSON.parse(readFileSync(
      catalogPath(codexHome),
      "utf8",
    ));
    expect(catalog.models).toHaveLength(3);
    expect(catalog.models).toEqual(expect.arrayContaining([
      expect.objectContaining({
        slug: "deepseek-v4-flash",
        default_reasoning_level: "high",
        auto_compact_token_limit: 629_146,
      }),
      expect.objectContaining({
        slug: "deepseek-v4-flash-vision-exp",
        default_reasoning_level: "high",
        auto_compact_token_limit: 629_146,
      }),
      expect.objectContaining({
        slug: "deepseek-v4-pro",
        default_reasoning_level: "max",
        auto_compact_token_limit: 786_432,
      }),
    ]));
    expect(parse(readFileSync(join(codexHome, "config.toml"), "utf8")))
      .toMatchObject({ model: "gpt-5.6-sol", model_provider: "openai" });
    expect(output.write).toHaveBeenCalledWith(
      "DeepSeek 默认模型已设为 deepseek-v4-pro。\n",
    );
  });

  it("uses the official user config transaction for an exclusive Provider", async () => {
    const codexHome = providerFixture("exclusive");
    const writeConfigEdits = vi.fn(async () => undefined);

    await expect(runModelProviderDefaultSetup({
      environment: testEnvironment(codexHome),
      output: { write: vi.fn() },
      prompter: {
        selectProvider: async () => "deepseek",
        selectModel: async () => "deepseek-v4-pro",
        selectReasoningEffort: async () => "low",
        selectAutoCompactPercent: async () => 40,
      },
      readConfigSnapshot: vi.fn(async () => ({
        config: { model: "deepseek-v4-flash" },
        version: "v1",
      })),
      writeConfigEdits,
    })).resolves.toMatchObject({ mode: "exclusive", model: "deepseek-v4-pro" });

    expect(writeConfigEdits).toHaveBeenCalledWith(
      expect.objectContaining({ CODEX_HOME: codexHome }),
      [
        { keyPath: "model", value: "deepseek-v4-pro" },
        { keyPath: "model_reasoning_effort", value: null },
        { keyPath: "model_context_window", value: null },
        { keyPath: "model_auto_compact_token_limit", value: null },
        { keyPath: "model_auto_compact_token_limit_scope", value: null },
      ],
      { expectedVersion: "v1" },
    );
  });

  it("fails clearly when no managed third-party Provider is configured", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-provider-default-empty-"));

    await expect(runModelProviderDefaultSetup({
      environment: testEnvironment(codexHome),
      output: { write: vi.fn() },
      prompter: {
        selectProvider: vi.fn(),
        selectModel: vi.fn(),
        selectReasoningEffort: vi.fn(),
        selectAutoCompactPercent: vi.fn(),
      },
    })).rejects.toThrow("尚未配置第三方 Provider");
  });

  it("skips Provider selection when a Provider is preselected", async () => {
    const codexHome = providerFixture("switching");
    const selectProvider = vi.fn();

    await expect(runModelProviderDefaultSetup({
      provider: "deepseek",
      environment: testEnvironment(codexHome),
      output: { write: vi.fn() },
      prompter: {
        selectProvider,
        selectModel: async () => "deepseek-v4-pro",
        selectReasoningEffort: async () => "max",
        selectAutoCompactPercent: async () => 55,
      },
    })).resolves.toMatchObject({
      action: "configured",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      autoCompactPercent: 55,
    });

    expect(selectProvider).not.toHaveBeenCalled();
    const catalog = JSON.parse(readFileSync(
      catalogPath(codexHome),
      "utf8",
    ));
    expect(catalog.models).toContainEqual(expect.objectContaining({
      slug: "deepseek-v4-pro",
      auto_compact_token_limit: 576_717,
    }));
  });
});

function providerFixture(mode: "switching" | "exclusive") {
  const codexHome = mkdtempSync(join(tmpdir(), "codexc-provider-default-"));
  const providerDirectory = join(
    codexHome,
    ".codex-connect",
    "providers",
    "deepseek",
  );
  mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") securePrivateDirectorySync(providerDirectory);
  const catalogPath = join(providerDirectory, "models.json");
  const providerLines = [
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    ...(mode === "switching" ? ['model_reasoning_effort = "high"'] : []),
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "[model_providers.deepseek]",
    'name = "deepseek"',
    'base_url = "https://api.deepseek.com/"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    'experimental_bearer_token = "sk-test-secret"',
    "",
  ].join("\n");
  writeFileSync(
    join(providerDirectory, "managed.toml"),
    `version = 1\nprovider = "deepseek"\nmode = "${mode}"\n`,
    { mode: 0o600 },
  );
  if (process.platform === "win32") securePrivateFileSync(join(providerDirectory, "managed.toml"));
  writeFileSync(catalogPath, JSON.stringify({
    models: [
      "deepseek-v4-flash",
      "deepseek-v4-flash-vision-exp",
      "deepseek-v4-pro",
    ].map((slug) => ({
      slug,
      display_name: slug,
      context_window: 1_048_576,
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "low", description: "Low" },
        { effort: "high", description: "High" },
        { effort: "max", description: "Max" },
      ],
      auto_compact_token_limit: 629_146,
    })),
  }), { mode: 0o600 });
  if (process.platform === "win32") securePrivateFileSync(catalogPath);
  if (mode === "switching") {
    writeFileSync(join(codexHome, "sf-deepseek.config.toml"), providerLines, { mode: 0o600 });
    if (process.platform === "win32") securePrivateFileSync(join(codexHome, "sf-deepseek.config.toml"));
    writeFileSync(
      join(codexHome, "config.toml"),
      'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n',
      { mode: 0o600 },
    );
    if (process.platform === "win32") securePrivateFileSync(join(codexHome, "config.toml"));
  } else {
    writeFileSync(join(codexHome, "config.toml"), providerLines, { mode: 0o600 });
    if (process.platform === "win32") securePrivateFileSync(join(codexHome, "config.toml"));
  }
  return codexHome;
}

function testEnvironment(codexHome: string): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: codexHome,
    CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
  };
}

function catalogPath(codexHome: string): string {
  return join(codexHome, ".codex-connect", "providers", "deepseek", "models.json");
}
