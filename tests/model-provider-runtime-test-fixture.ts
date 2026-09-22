import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

export function configureLegacyOpenCodeGo(
  codexHome: string,
  mode: "switching" | "exclusive" = "switching",
): void {
  const providerDirectory = join(
    connectHomeFor(codexHome),
    "providers",
    "opencode-go",
  );
  secureTestDirectory(providerDirectory);
  secureTestFile(
    join(providerDirectory, "managed.toml"),
    `version = 1\nprovider = "opencode-go"\nmode = "${mode}"\n`,
  );
  const catalogPath = join(providerDirectory, "models.json");
  secureTestFile(
    catalogPath,
    providerCatalog(),
  );
  secureTestFile(join(codexHome, mode === "exclusive" ? "config.toml" : "sf-opencode-go.config.toml"), [
    'model = "deepseek-v4-flash"',
    'model_provider = "opencode-go"',
    ...(mode === "switching" ? ['model_reasoning_effort = "high"'] : []),
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "[model_providers.opencode-go]",
    'name = "opencode-go"',
    'base_url = "https://opencode.ai/zen/go/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "supports_websockets = false",
    'experimental_bearer_token = "sk-opencode-test-secret"',
    "",
  ].join("\n"));
}

export function configureReleasedRegisteredOpenCodeGo(codexHome: string): void {
  const providerDirectory = join(
    connectHomeFor(codexHome),
    "providers",
    "opencode-go",
  );
  const accountsDirectory = join(providerDirectory, "accounts");
  rmSync(join(accountsDirectory, "main"), { recursive: true, force: true });
  secureTestDirectory(join(accountsDirectory, "opencode-go"));
  secureTestFile(
    join(providerDirectory, "accounts.json"),
    `${JSON.stringify([{ id: "opencode-go", default: true }], null, 2)}\n`,
  );
  secureTestFile(
    join(accountsDirectory, "opencode-go", "managed.toml"),
    'version = 1\nprovider = "opencode-go"\nmode = "switching"\n',
  );
  secureTestFile(
    join(codexHome, "sf-opencode-go.config.toml"),
    readFileSync(join(codexHome, "sf-ocg-main.config.toml"), "utf8")
      .replaceAll("ocg-main", "opencode-go"),
  );
}

export function configurePrMainOpenCodeGo(codexHome: string): void {
  configureOpenCodeGo(codexHome);
  const providerDirectory = join(connectHomeFor(codexHome), "providers", "opencode-go");
  const accountsDirectory = join(providerDirectory, "accounts");
  writeFileSync(
    join(providerDirectory, "accounts.json"),
    `${JSON.stringify([
      { id: "main", default: true, email: "user@example.com" },
      { id: "lunare", default: false, email: "lunare@example.com" },
    ], null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(accountsDirectory, "main", "managed.toml"),
    'version = 1\nprovider = "opencode-go-main"\nmode = "switching"\n',
    { mode: 0o600 },
  );
  const profile = readFileSync(join(codexHome, "sf-ocg-main.config.toml"), "utf8")
    .replace('model_provider = "ocg-main"', 'model_provider = "opencode-go-main"')
    .replace("[model_providers.ocg-main]", "[model_providers.opencode-go-main]")
    .replace('name = "ocg-main"', 'name = "opencode-go-main"');
  rmSync(join(codexHome, "sf-ocg-main.config.toml"));
  writeFileSync(join(codexHome, "sf-opencode-go-main.config.toml"), profile, { mode: 0o600 });
  mkdirSync(join(accountsDirectory, "lunare"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(accountsDirectory, "lunare", "managed.toml"),
    'version = 1\nprovider = "opencode-go-lunare"\nmode = "switching"\n',
    { mode: 0o600 },
  );
  writeFileSync(
    join(codexHome, "sf-opencode-go-lunare.config.toml"),
    profile
      .replace('model_provider = "opencode-go-main"', 'model_provider = "opencode-go-lunare"')
      .replace("[model_providers.opencode-go-main]", "[model_providers.opencode-go-lunare]")
      .replace('name = "opencode-go-main"', 'name = "opencode-go-lunare"'),
    { mode: 0o600 },
  );
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
