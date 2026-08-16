import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import { runOpenCodeGoSetup } from "../scripts/opencode-go-setup.mjs";

describe("OpenCode Go setup", () => {
  it("writes an isolated managed Profile using the shared reviewed model catalog", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-setup-"));
    const output = { write: vi.fn() };

    const result = await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output,
      prompter: {
        select: async () => "configure",
        secret: async () => "sk-opencode-test",
      },
      downloadCatalog: async () => ({
        catalog: {
          models: [{
            slug: "deepseek-v4-flash",
            context_window: 1_000_000,
            default_reasoning_level: "high",
            supported_reasoning_levels: [{ effort: "high", description: "High" }],
          }],
        },
        sha256: "a".repeat(64),
      }),
    });

    expect(result).toMatchObject({ action: "configured" });
    const profile = parse(readFileSync(join(codexHome, "opencode-go.config.toml"), "utf8"));
    expect(profile).toMatchObject({
      model: "deepseek-v4-flash",
      model_provider: "opencode-go",
      model_auto_compact_token_limit: 600_000,
      model_providers: {
        "opencode-go": {
          base_url: "https://opencode.ai/zen/go/v1",
          wire_api: "responses",
          supports_websockets: false,
          experimental_bearer_token: "sk-opencode-test",
        },
      },
    });
    expect(parse(readFileSync(
      join(codexHome, "codex-connect-opencode-go.config.toml"),
      "utf8",
    ))).toEqual({ version: 1, provider: "opencode-go", mode: "switching" });
  });

  it("removes only the OpenCode Go Profile and marker", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-remove-"));
    await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: {
        select: async () => "configure",
        secret: async () => "sk-opencode-test",
      },
      downloadCatalog: async () => ({
        catalog: { models: [{ slug: "deepseek-v4-flash", context_window: 1_000_000 }] },
        sha256: "a".repeat(64),
      }),
    });

    await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: { select: async () => "remove", secret: async () => "" },
    });

    expect(existsSync(join(codexHome, "opencode-go.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "codex-connect-opencode-go.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "deepseek.models.json"))).toBe(true);
  });

  it("refuses to remove an unmanaged OpenCode Go Profile", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-unmanaged-"));
    const profilePath = join(codexHome, "opencode-go.config.toml");
    writeFileSync(profilePath, 'model = "user-managed"\n', { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: { select: async () => "remove", secret: async () => "" },
    })).rejects.toThrow("管理标记不存在");

    expect(readFileSync(profilePath, "utf8")).toBe('model = "user-managed"\n');
  });
});
