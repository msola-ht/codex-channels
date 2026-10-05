import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { secureTestDirectory, secureTestFile } from "./support/windows-fixtures.js";

export function connectHomeFor(codexHome: string): string {
  return join(codexHome, ".codex-connect");
}

export function providerCatalogPath(codexHome: string): string {
  return join(connectHomeFor(codexHome), "providers", "deepseek", "models.json");
}

export function testEnvironment(codexHome: string): NodeJS.ProcessEnv {
  return { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHomeFor(codexHome) };
}

export async function configuredHome(mode: "switching" | "exclusive"): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), "codexc-provider-runtime-"));
  secureTestDirectory(codexHome);
  const providerDirectory = join(connectHomeFor(codexHome), "providers", "deepseek");
  secureTestDirectory(providerDirectory);
  secureTestDirectory(join(providerDirectory, "accounts", "test"));
  secureTestFile(
    join(providerDirectory, "accounts", "test", "managed.toml"),
    `version = 1\nprovider = "ds-test"\nmode = "${mode}"\n`,
  );
  secureTestFile(join(providerDirectory, "accounts.json"), JSON.stringify([{ id: "test", default: true }]));
  const profilePath = mode === "exclusive" ? "config.toml" : "sf-ds-test.config.toml";
  const catalogPath = join(providerDirectory, "models.json");
  secureTestFile(
    join(codexHome, profilePath),
    providerProfile(mode, catalogPath),
  );
  secureTestFile(
    catalogPath,
    providerCatalog(),
  );
  return codexHome;
}

export function providerProfile(
  mode: "switching" | "exclusive",
  catalogPath: string,
): string {
  return [
    'model = "deepseek-v4-flash"',
    'model_provider = "ds-test"',
    ...(mode === "switching" ? ['model_reasoning_effort = "high"'] : []),
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "[model_providers.ds-test]",
    'name = "ds-test"',
    'base_url = "https://api.deepseek.com/"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    'experimental_bearer_token = "sk-test-secret"',
    "",
  ].join("\n");
}

export function configureOpenCodeGo(
  codexHome: string,
  mode: "switching" | "exclusive" = "switching",
): void {
  const providerDirectory = join(
    connectHomeFor(codexHome),
    "providers",
    "opencode-go",
  );
  secureTestDirectory(providerDirectory);
  const accountId = "main";
  const accountDirectory = join(providerDirectory, "accounts", accountId);
  secureTestDirectory(accountDirectory);
  secureTestFile(
    join(providerDirectory, "accounts.json"),
    `${JSON.stringify([{ id: accountId, default: true, email: "user@example.com" }], null, 2)}\n`,
  );
  secureTestFile(
    join(accountDirectory, "managed.toml"),
    `version = 1\nprovider = "ocg-main"\nmode = "${mode}"\n`,
  );
  const catalogPath = join(providerDirectory, "models.json");
  secureTestFile(
    catalogPath,
    providerCatalog(),
  );
  const provider = "ocg-main";
  secureTestFile(join(codexHome, mode === "exclusive" ? "config.toml" : "sf-ocg-main.config.toml"), [
    'model = "deepseek-v4-flash"',
    `model_provider = "${provider}"`,
    ...(mode === "switching" ? ['model_reasoning_effort = "high"'] : []),
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    `[model_providers.${provider}]`,
    `name = "${provider}"`,
    'base_url = "https://opencode.ai/zen/go/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    'experimental_bearer_token = "sk-opencode-test-secret"',
    "",
  ].join("\n"));
}

export function configureCcgAccounts(codexHome: string, defaultAccountId = "work"): void {
  const providerDirectory = join(connectHomeFor(codexHome), "providers", "ccg");
  secureTestDirectory(providerDirectory);
  const accounts = ["main", "work"];
  secureTestFile(
    join(providerDirectory, "accounts.json"),
    `${JSON.stringify(accounts.map((id) => ({ id, default: id === defaultAccountId })), null, 2)}\n`,
  );
  const catalogPath = join(providerDirectory, "models.json");
  secureTestFile(catalogPath, `${JSON.stringify({
    models: [{
      slug: "deepseek/deepseek-v4-flash",
      display_name: "DeepSeek V4 Flash",
      context_window: 1_048_576,
      max_context_window: 1_048_576,
      auto_compact_token_limit: 629_146,
      input_modalities: ["text"],
      default_reasoning_level: "high",
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
    }],
  })}\n`);
  for (const id of accounts) {
    const provider = `ccg-${id}`;
    const accountDirectory = join(providerDirectory, "accounts", id);
    secureTestDirectory(accountDirectory);
    secureTestFile(
      join(accountDirectory, "managed.toml"),
      `version = 1\nprovider = "${provider}"\nmode = "switching"\n`,
    );
    secureTestFile(join(codexHome, `sf-${provider}.config.toml`), [
      'model = "deepseek/deepseek-v4-flash"',
      `model_provider = "${provider}"`,
      'model_reasoning_effort = "high"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      `[model_providers.${provider}]`,
      `name = "${provider}"`,
      'base_url = "https://api.commandcode.ai/provider/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      `experimental_bearer_token = "cmd_${id}-secret"`,
      "",
    ].join("\n"));
  }
}

export function providerCatalog(): string {
  return `${JSON.stringify({
    models: [
      {
        slug: "deepseek-v4-flash",
        display_name: "DeepSeek V4 Flash",
        context_window: 1_048_576,
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "high", description: "High" },
          { effort: "max", description: "Max" },
        ],
        auto_compact_token_limit: 629_146,
      },
      {
        slug: "deepseek-v4-pro",
        display_name: "DeepSeek V4 Pro",
        context_window: 900_000,
        default_reasoning_level: "low",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "high", description: "High" },
        ],
        auto_compact_token_limit: 540_000,
      },
    ],
  })}\n`;
}
