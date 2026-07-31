import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  loadManagedModelProvider,
  loadPrimaryModelProvider,
  providerAppServerSocketPath,
} from "../runtime/model-provider-runtime.mjs";

describe("model provider runtime topology", () => {
  it("uses OpenAI as primary and exposes DeepSeek as an auxiliary switching server", async () => {
    const codexHome = await configuredHome("switching");
    const environment = { CODEX_HOME: codexHome };

    expect(loadPrimaryModelProvider(environment)).toBe("openai");
    expect(loadManagedModelProvider(environment)).toMatchObject({ provider: "deepseek" });
  });

  it("uses the native DeepSeek configuration as the only primary server in exclusive mode", async () => {
    const codexHome = await configuredHome("exclusive");
    const environment = { CODEX_HOME: codexHome };

    expect(loadPrimaryModelProvider(environment)).toBe("deepseek");
    expect(loadManagedModelProvider(environment)).toBeUndefined();
  });

  it("derives a private sibling socket without changing the configured primary socket", () => {
    expect(providerAppServerSocketPath(
      "/private/runtime/codex-app-server.sock",
      "deepseek",
    )).toBe("/private/runtime/codex-app-server-deepseek.sock");
  });
});

async function configuredHome(mode: "switching" | "exclusive"): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), "codexc-provider-runtime-"));
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(codexHome, "codex-connect-deepseek.config.toml"),
    `version = 1\nprovider = "deepseek"\nmode = "${mode}"\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(codexHome, "deepseek.config.toml"),
    [
      'model = "deepseek-v4-flash"',
      'model_provider = "deepseek"',
      "[model_providers.deepseek]",
      'name = "deepseek"',
      'base_url = "https://api.deepseek.com/"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      'experimental_bearer_token = "sk-test-secret"',
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return codexHome;
}
