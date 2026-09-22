import {
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

import {
  loadManagedModelProvider,
  loadManagedModelProviderSettings,
  loadManagedProviderAppServer,
  readCodexConfigModelOverride,
  validateCustomPrimaryModelProviderId,
  validateConfiguredModelProvider,
  writeManagedModelProviderProfileDefault,
  writeManagedModelWindowGlobal,
} from "../runtime/model-provider-runtime.mjs";
import {
  configuredHome,
  connectHomeFor,
  providerCatalogPath,
  providerProfile,
  testEnvironment,
} from "./model-provider-runtime-test-fixture.js";
import { secureTestDirectory, secureTestFile } from "./support/windows-fixtures.js";

describe("managed model provider runtime", () => {
  it("keeps context windows separate from upstream compression thresholds", async () => {
    const codexHome = await configuredHome("switching");
    const environment = testEnvironment(codexHome);
    expect(loadManagedModelProviderSettings(environment)[0]?.models[0]).toMatchObject({
      contextWindow: 1_048_576,
      maxContextWindow: 1_048_576,
      windowPercent: 100,
    });
    writeManagedModelWindowGlobal({ model: "deepseek-v4-flash", windowPercent: 75, environment });
    const catalog = JSON.parse(readFileSync(providerCatalogPath(codexHome), "utf8"));
    expect(catalog.models[0]).toMatchObject({
      context_window: 786_432,
      auto_compact_token_limit: 629_146,
    });
    expect(loadManagedModelProviderSettings(environment)[0]?.models[0]?.windowPercent).toBe(75);
  });

  it("reads the official model context window and auto compact override", async () => {
    const codexHome = await mkdtemp(resolve(tmpdir(), "codexc-model-override-"));
    await secureTestDirectory(codexHome);
    await secureTestFile(join(codexHome, "config.toml"), [
      'model_context_window = 200000',
      'model_auto_compact_token_limit = 80000',
      "",
    ].join("\n"));

    expect(readCodexConfigModelOverride({ CODEX_HOME: codexHome })).toEqual({
      contextWindow: 200_000,
      autoCompactTokenLimit: 80_000,
    });
  });

  it("returns null when the official config has no model override", async () => {
    const codexHome = await mkdtemp(resolve(tmpdir(), "codexc-model-override-empty-"));
    await secureTestDirectory(codexHome);
    await secureTestFile(join(codexHome, "config.toml"), 'model_provider = "openai"\n');

    expect(readCodexConfigModelOverride({ CODEX_HOME: codexHome })).toEqual({
      contextWindow: null,
      autoCompactTokenLimit: null,
    });
  });

  it("rejects reserved Codex provider IDs as custom primary candidates", () => {
    const environment = testEnvironment(tmpdir());
    for (const id of [
      "openai",
      "ollama",
      "lmstudio",
      "amazon-bedrock",
      "ocg",
      "ocg-main",
      "ccg",
      "ccg-team",
    ]) {
      expect(validateCustomPrimaryModelProviderId(id, environment))
        .toBe("该 Provider ID 已被 Codex 或 Gateway 保留");
    }
  });

  it("rejects a switching profile with a root context override", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "sf-ds-test.config.toml"),
      providerProfile("switching", providerCatalogPath(codexHome)).replace(
        'model_provider = "ds-test"\n',
        'model_provider = "ds-test"\nmodel_context_window = 1048576\n',
      ),
      { mode: 0o600 },
    );
    const environment = testEnvironment(codexHome);

    expect(loadManagedModelProvider(environment)).toMatchObject({ provider: "ds-test" });
    expect(() => loadManagedProviderAppServer(environment))
      .toThrow("模型目录或思考等级无效");
  });

  it("rejects a switching profile without the reasoning mirror", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "sf-ds-test.config.toml"),
      providerProfile("switching", providerCatalogPath(codexHome)).replace(
        'model_reasoning_effort = "high"\n',
        "",
      ),
      { mode: 0o600 },
    );
    const environment = testEnvironment(codexHome);

    expect(() => loadManagedProviderAppServer(environment))
      .toThrow("模型目录或思考等级无效");
  });

  it("rejects a switching profile whose reasoning mirror differs from the catalog default", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "sf-ds-test.config.toml"),
      providerProfile("switching", providerCatalogPath(codexHome)).replace(
        'model_reasoning_effort = "high"\n',
        'model_reasoning_effort = "low"\n',
      ),
      { mode: 0o600 },
    );
    const environment = testEnvironment(codexHome);

    expect(() => loadManagedProviderAppServer(environment))
      .toThrow("模型目录或思考等级无效");
  });

  it("repairs a switching profile missing the reasoning mirror when writing defaults", async () => {
    const codexHome = await configuredHome("switching");
    writeFileSync(
      join(codexHome, "sf-ds-test.config.toml"),
      providerProfile("switching", providerCatalogPath(codexHome)).replace(
        'model_reasoning_effort = "high"\n',
        "",
      ),
      { mode: 0o600 },
    );
    const environment = testEnvironment(codexHome);

    expect(writeManagedModelProviderProfileDefault("ds-test", {
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      contextWindow: 629_146,
    }, environment)).toMatchObject({ mode: "switching" });
    expect(parse(readFileSync(
      join(codexHome, "sf-ds-test.config.toml"),
      "utf8",
    ))).toMatchObject({
      model: "deepseek-v4-flash",
      model_reasoning_effort: "high",
    });
    expect(validateConfiguredModelProvider(environment))
      .toEqual({ provider: "ds-test", mode: "switching" });
  });

  it.each([undefined, null])("retains the original window when max_context_window is %s", async (maximum) => {
    const codexHome = await configuredHome("switching");
    const environment = testEnvironment(codexHome);
    const path = providerCatalogPath(codexHome);
    const catalog = JSON.parse(readFileSync(path, "utf8"));
    catalog.models[0].max_context_window = maximum;
    writeFileSync(path, JSON.stringify(catalog), { mode: 0o600 });

    for (const windowPercent of [60, 60, 100]) {
      writeManagedModelWindowGlobal({ model: "deepseek-v4-flash", windowPercent, environment });
      expect(loadManagedModelProviderSettings(environment)[0]?.models[0]).toMatchObject({
        contextWindow: Math.round(1_048_576 * windowPercent / 100),
        maxContextWindow: 1_048_576,
        windowPercent,
      });
    }
  });

  it("validates both switching and exclusive managed configurations", async () => {
    const switchingHome = await configuredHome("switching");
    const exclusiveHome = await configuredHome("exclusive");

    expect(validateConfiguredModelProvider(testEnvironment(switchingHome)))
      .toEqual({ provider: "ds-test", mode: "switching" });
    expect(validateConfiguredModelProvider(testEnvironment(exclusiveHome)))
      .toEqual({ provider: "ds-test", mode: "exclusive" });
  });

  it("rejects a managed configuration whose actual model catalog is missing", async () => {
    const codexHome = await configuredHome("switching");
    rmSync(join(connectHomeFor(codexHome), "providers", "deepseek", "models.json"));

    expect(() => loadManagedProviderAppServer(testEnvironment(codexHome)))
      .toThrow("模型目录");
    expect(() => validateConfiguredModelProvider(testEnvironment(codexHome)))
      .toThrow("模型目录");
  });

  it("rejects a managed catalog that declares an invalid model name", async () => {
    const codexHome = await configuredHome("switching");
    const catalogPath = join(
      connectHomeFor(codexHome),
      "providers",
      "deepseek",
      "models.json",
    );
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    catalog.models.push({ ...catalog.models[0], slug: "DeepSeek Flash" });
    writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });

    expect(() => loadManagedModelProviderSettings(testEnvironment(codexHome)))
      .toThrow("包含无效模型名");
  });

  it("rejects a managed catalog with an invalid compression threshold", async () => {
    const codexHome = await configuredHome("switching");
    const catalogPath = providerCatalogPath(codexHome);
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    const [first] = catalog.models;
    if (!first) throw new Error("测试目录缺少模型");
    first.auto_compact_token_limit = 0;
    writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });

    expect(() => loadManagedModelProviderSettings(testEnvironment(codexHome)))
      .toThrow("模型目录无效");
  });

  it("rejects an exclusive configuration with a root reasoning override", async () => {
    const codexHome = await configuredHome("exclusive");
    writeFileSync(
      join(codexHome, "config.toml"),
      providerProfile("exclusive", providerCatalogPath(codexHome)).replace(
        'model_provider = "ds-test"\n',
        'model_provider = "ds-test"\nmodel_reasoning_effort = "high"\n',
      ),
      { mode: 0o600 },
    );

    expect(() => validateConfiguredModelProvider(testEnvironment(codexHome)))
      .toThrow("模型目录或思考等级无效");
  });
});
