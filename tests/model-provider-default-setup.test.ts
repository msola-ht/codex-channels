import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import { runModelProviderDefaultSetup } from "../scripts/model-provider-default-setup.mjs";

describe("managed model provider default setup", () => {
  it("updates only the selected switching Provider profile", async () => {
    const codexHome = providerFixture("switching");
    const output = { write: vi.fn() };

    await expect(runModelProviderDefaultSetup({
      environment: { CODEX_HOME: codexHome },
      output,
      prompter: {
        selectProvider: async () => "deepseek",
        selectModel: async () => "deepseek-v4-pro",
      },
    })).resolves.toEqual({
      action: "configured",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      mode: "switching",
    });

    expect(parse(readFileSync(join(codexHome, "sf-deepseek.config.toml"), "utf8")))
      .toMatchObject({ model: "deepseek-v4-pro", model_provider: "deepseek" });
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
      environment: { CODEX_HOME: codexHome },
      output: { write: vi.fn() },
      prompter: {
        selectProvider: async () => "deepseek",
        selectModel: async () => "deepseek-v4-pro",
      },
      writeConfigEdits,
    })).resolves.toMatchObject({ mode: "exclusive", model: "deepseek-v4-pro" });

    expect(writeConfigEdits).toHaveBeenCalledWith(
      expect.objectContaining({ CODEX_HOME: codexHome }),
      [{ keyPath: "model", value: "deepseek-v4-pro" }],
    );
  });

  it("fails clearly when no managed third-party Provider is configured", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-provider-default-empty-"));

    await expect(runModelProviderDefaultSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: vi.fn() },
      prompter: {
        selectProvider: vi.fn(),
        selectModel: vi.fn(),
      },
    })).rejects.toThrow("尚未配置第三方 Provider");
  });
});

function providerFixture(mode: "switching" | "exclusive") {
  const codexHome = mkdtempSync(join(tmpdir(), "codexc-provider-default-"));
  const catalogPath = join(codexHome, "sf-deepseek.models.json");
  const providerLines = [
    'model = "deepseek-v4-flash"',
    'model_provider = "deepseek"',
    'model_reasoning_effort = "high"',
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
    join(codexHome, "sf-deepseek.managed.toml"),
    `version = 1\nprovider = "deepseek"\nmode = "${mode}"\n`,
    { mode: 0o600 },
  );
  writeFileSync(catalogPath, JSON.stringify({
    models: [{ slug: "deepseek-v4-flash" }, { slug: "deepseek-v4-pro" }],
  }), { mode: 0o600 });
  if (mode === "switching") {
    writeFileSync(join(codexHome, "sf-deepseek.config.toml"), providerLines, { mode: 0o600 });
    writeFileSync(
      join(codexHome, "config.toml"),
      'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n',
      { mode: 0o600 },
    );
  } else {
    writeFileSync(join(codexHome, "config.toml"), providerLines, { mode: 0o600 });
  }
  return codexHome;
}
