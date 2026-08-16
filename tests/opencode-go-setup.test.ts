import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";
import { describe, expect, it, vi } from "vitest";

import { runOpenCodeGoSetup } from "../scripts/opencode-go-setup.mjs";
import { writeManagedModelProviderProfileDefault } from "../runtime/model-provider-runtime.mjs";

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
      const target = mode === "switching" ? "sf-opencode-go.config.toml" : "config.toml";
      const config = parse(readFileSync(join(codexHome, target), "utf8"));
      expect(config).toMatchObject({
        model: "deepseek-v4-flash",
        model_provider: "opencode-go",
        model_providers: {
          "opencode-go": {
            base_url: "https://opencode.ai/zen/go/v1",
            wire_api: "responses",
            supports_websockets: false,
            experimental_bearer_token: "sk-opencode-test",
          },
        },
      });
      const catalog = JSON.parse(readFileSync(
        join(codexHome, "sf-opencode-go.models.json"),
        "utf8",
      ));
      expect(catalog.models[0]).toMatchObject({
        slug: "deepseek-v4-flash",
        default_reasoning_level: "high",
        auto_compact_token_limit: 600_000,
      });
      expect(parse(readFileSync(
        join(codexHome, "sf-opencode-go.managed.toml"),
        "utf8",
      ))).toEqual({ version: 1, provider: "opencode-go", mode });
      expect(configureRole).toHaveBeenCalledWith(
        "opencode-go",
        "deepseek-v4-flash",
        expect.objectContaining({ CODEX_HOME: codexHome }),
      );
      if (mode === "exclusive") {
        expect(existsSync(join(codexHome, "sf-opencode-go.config.toml"))).toBe(false);
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
    expect(parse(readFileSync(join(codexHome, "sf-opencode-go.config.toml"), "utf8")))
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
    expect(existsSync(join(codexHome, "sf-opencode-go.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "sf-opencode-go.managed.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "sf-opencode-go.models.json"))).toBe(false);
    expect(existsSync(join(codexHome, "sf-opencode-go.models.manifest.json"))).toBe(false);
  });

  it("restores a legacy backup state created before catalog files were provider-owned", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-legacy-restore-"));
    await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    });
    const statePath = join(codexHome, "backup-codex-connect-opencode-go", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    delete state.catalog;
    delete state.manifest;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: prompt("restore"),
    })).resolves.toMatchObject({ action: "restored" });

    expect(existsSync(join(codexHome, "sf-opencode-go.models.json"))).toBe(false);
    expect(existsSync(join(codexHome, "sf-opencode-go.models.manifest.json"))).toBe(false);
  });

  it("validates the complete backup state before restoring any file", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-invalid-restore-"));
    writeFileSync(join(codexHome, "config.toml"), "custom = true\n", { mode: 0o600 });
    await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    });
    const configPath = join(codexHome, "config.toml");
    const configBefore = readFileSync(configPath, "utf8");
    const statePath = join(codexHome, "backup-codex-connect-opencode-go", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    delete state.manifest;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: prompt("restore"),
    })).rejects.toThrow("备份状态无效");

    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    expect(existsSync(join(codexHome, "sf-opencode-go.models.json"))).toBe(true);
  });

  it("preserves the selected model and per-model settings when setup is repeated", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-repeat-"));
    const environment = { CODEX_HOME: codexHome };
    await runOpenCodeGoSetup({
      environment,
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    });
    writeManagedModelProviderProfileDefault("opencode-go", {
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactLimit: 750_000,
    }, environment);
    const configureRole = vi.fn(async () => undefined);

    await runOpenCodeGoSetup({
      environment,
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole,
      downloadCatalog: async () => updatedCatalog(2_000_000),
    });

    expect(parse(readFileSync(join(codexHome, "sf-opencode-go.config.toml"), "utf8")))
      .toMatchObject({ model: "deepseek-v4-pro" });
    const catalog = JSON.parse(readFileSync(
      join(codexHome, "sf-opencode-go.models.json"),
      "utf8",
    ));
    expect(catalog.models[1]).toMatchObject({
      slug: "deepseek-v4-pro",
      context_window: 2_000_000,
      default_reasoning_level: "max",
      auto_compact_token_limit: 1_500_000,
    });
    expect(configureRole).toHaveBeenCalledWith("opencode-go", "deepseek-v4-pro", environment);
  });

  it("refuses to overwrite an unmanaged OpenCode Go Profile", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-unmanaged-"));
    const profilePath = join(codexHome, "sf-opencode-go.config.toml");
    writeFileSync(profilePath, 'model = "user-managed"\n', { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: prompt("switching"),
    })).rejects.toThrow("管理标记不存在");
    expect(readFileSync(profilePath, "utf8")).toBe('model = "user-managed"\n');
  });

  it("refuses a user-managed OpenCode Go Provider in config.toml", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-config-owner-"));
    const configPath = join(codexHome, "config.toml");
    const original = '[model_providers.opencode-go]\nname = "user-managed"\n';
    writeFileSync(configPath, original, { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome },
      output: { write: () => undefined },
      prompter: prompt("switching"),
      downloadCatalog: successfulCatalog,
    })).rejects.toThrow("已占用 OpenCode Go Provider 或 Profile");

    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "sf-opencode-go.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "sf-opencode-go.managed.toml"))).toBe(false);
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
    expect(existsSync(join(codexHome, "sf-opencode-go.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, "sf-opencode-go.managed.toml"))).toBe(false);
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
  return updatedCatalog(1_000_000);
}

function updatedCatalog(contextWindow: number) {
  return {
    catalog: {
      models: ["deepseek-v4-flash", "deepseek-v4-pro"].map((slug) => ({
        slug,
        context_window: contextWindow,
        default_reasoning_level: "high",
        supported_reasoning_levels: [
          { effort: "high", description: "High" },
          { effort: "max", description: "Max" },
        ],
      })),
    },
    sha256: "a".repeat(64),
  };
}
