import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import { runOpenCodeGoSetup } from "../scripts/opencode-go-setup.mjs";

describe("OpenCode Go setup", () => {
  it.each(["switching", "exclusive"] as const)(
    "configures %s mode and selects the shared third-party role",
    async (mode) => {
      const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-setup-"));
      const configureRole = vi.fn(async () => ({
        role: "external",
        provider: "opencode-go",
        model: "deepseek-v4-flash",
      }));
      const result = await runOpenCodeGoSetup({
        environment: { CODEX_HOME: codexHome },
        output: { write: vi.fn() },
        prompter: {
          select: async () => mode,
          secret: async () => "sk-opencode-test",
          confirm: async () => true,
        },
        configureRole,
        downloadCatalog: successfulCatalog,
      });

      expect(result).toMatchObject({ action: "configured", mode });
      const target = mode === "switching" ? "opencode-go.config.toml" : "config.toml";
      const config = parse(readFileSync(join(codexHome, target), "utf8"));
      expect(config).toMatchObject({
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
      ))).toEqual({ version: 1, provider: "opencode-go", mode });
      expect(configureRole).toHaveBeenCalledWith(
        "opencode-go",
        "deepseek-v4-flash",
        expect.objectContaining({ CODEX_HOME: codexHome }),
      );
      if (mode === "exclusive") {
        expect(existsSync(join(codexHome, "opencode-go.config.toml"))).toBe(false);
      }
    },
  );

  it("moves from fixed mode back to switching without losing unrelated config", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-transition-"));
    writeFileSync(join(codexHome, "config.toml"), "custom = true\n", { mode: 0o600 });
    const base = {
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    };
    await runOpenCodeGoSetup({
      ...base,
      prompter: prompt("exclusive"),
    });
    await runOpenCodeGoSetup({
      ...base,
      prompter: prompt("switching"),
    });

    expect(parse(readFileSync(join(codexHome, "config.toml"), "utf8"))).toEqual({
      custom: true,
    });
    expect(parse(readFileSync(join(codexHome, "opencode-go.config.toml"), "utf8")))
      .toMatchObject({ model_provider: "opencode-go" });
  });

  it("restores the initial config and provider files", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-restore-"));
    const original = 'model = "gpt-5.6-sol"\n';
    writeFileSync(join(codexHome, "config.toml"), original, { mode: 0o600 });
    await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: prompt("exclusive"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    });

    const result = await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: prompt("restore"),
      configureRole: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({ action: "restored" });
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "opencode-go.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "codex-connect-opencode-go.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "deepseek.models.json"))).toBe(true);
  });

  it("refuses to overwrite an unmanaged OpenCode Go Profile", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-unmanaged-"));
    const profilePath = join(codexHome, "opencode-go.config.toml");
    writeFileSync(profilePath, 'model = "user-managed"\n', { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: prompt("switching"),
    })).rejects.toThrow("管理标记不存在");
    expect(readFileSync(profilePath, "utf8")).toBe('model = "user-managed"\n');
  });

  it("rolls back every file when shared-role configuration fails", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-rollback-"));
    const original = "custom = true\n";
    writeFileSync(join(codexHome, "config.toml"), original, { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => { throw new Error("config conflict"); }),
      downloadCatalog: successfulCatalog,
    })).rejects.toThrow("config conflict");

    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "opencode-go.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "codex-connect-opencode-go.config.toml"))).toBe(false);
  });
});

function prompt(action: "switching" | "exclusive" | "restore") {
  return {
    select: async () => action,
    secret: async () => "sk-opencode-test",
    confirm: async () => true,
  };
}

async function successfulCatalog() {
  return {
    catalog: {
      models: [{
        slug: "deepseek-v4-flash",
        context_window: 1_000_000,
        default_reasoning_level: "high",
        supported_reasoning_levels: [{ effort: "high", description: "High" }],
      }],
    },
    sha256: "a".repeat(64),
  };
}
