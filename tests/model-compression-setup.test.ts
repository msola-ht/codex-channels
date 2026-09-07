import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runModelCompressionSetup } from "../scripts/model-compression-setup.mjs";
import {
  securePrivateDirectorySync,
  securePrivateFileSync,
} from "../runtime/private-file.mjs";

describe("managed model compression setup", () => {
  it("updates the compression by model name globally across providers", async () => {
    const codexHome = providerFixture();
    const output = { write: vi.fn() };

    await expect(runModelCompressionSetup({
      environment: testEnvironment(codexHome),
      output,
      prompter: {
        selectModel: async () => "deepseek-v4-flash",
        selectAutoCompactPercent: async () => 75,
      },
    })).resolves.toEqual({
      action: "configured",
      model: "deepseek-v4-flash",
      autoCompactPercent: 75,
      autoCompactLimit: 786_432,
      providers: ["deepseek"],
      activation: "restart-app-server",
      activationResult: {
        status: "restart",
        target: "app-server",
        commands: ["codexc service restart app-server"],
      },
    });

    const catalog = JSON.parse(readFileSync(
      catalogPath(codexHome),
      "utf8",
    ));
    expect(catalog.models).toContainEqual(expect.objectContaining({
      slug: "deepseek-v4-flash",
      auto_compact_token_limit: 786_432,
    }));
    expect(catalog.models).toContainEqual(expect.objectContaining({
      slug: "deepseek-v4-pro",
      auto_compact_token_limit: 629_146,
    }));
    expect(output.write).toHaveBeenCalledWith(
      expect.stringContaining("DeepSeek V4 Flash 自动压缩阈值：75%"),
    );
  });

  it("fails clearly when no managed third-party model is configured", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-model-compression-empty-"));

    await expect(runModelCompressionSetup({
      environment: testEnvironment(codexHome),
      output: { write: vi.fn() },
    })).rejects.toThrow("尚未配置受管第三方模型");
  });

  it("returns back when the model selection is cancelled", async () => {
    const codexHome = providerFixture();
    const prompts = {
      select: vi.fn().mockResolvedValueOnce("back"),
      text: vi.fn(),
      isCancel: () => false,
    };
    const result = await runModelCompressionSetup({
      environment: testEnvironment(codexHome),
      output: { write: vi.fn() },
      prompts,
      allowBack: true,
    });
    expect(result).toEqual({ action: "back" });
  });
});

function providerFixture() {
  const codexHome = mkdtempSync(join(tmpdir(), "codexc-model-compression-"));
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
    join(providerDirectory, "managed.toml"),
    'version = 1\nprovider = "deepseek"\nmode = "switching"\n',
    { mode: 0o600 },
  );
  if (process.platform === "win32") securePrivateFileSync(join(providerDirectory, "managed.toml"));
  writeFileSync(catalogPath, JSON.stringify({
    models: [
      { slug: "deepseek-v4-flash", display_name: "DeepSeek V4 Flash", context_window: 1_048_576 },
      { slug: "deepseek-v4-pro", display_name: "DeepSeek V4 Pro", context_window: 1_048_576 },
    ].map((entry) => ({
      ...entry,
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
  writeFileSync(join(codexHome, "sf-deepseek.config.toml"), providerLines, { mode: 0o600 });
  if (process.platform === "win32") securePrivateFileSync(join(codexHome, "sf-deepseek.config.toml"));
  writeFileSync(
    join(codexHome, "config.toml"),
    'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n',
    { mode: 0o600 },
  );
  if (process.platform === "win32") securePrivateFileSync(join(codexHome, "config.toml"));
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
