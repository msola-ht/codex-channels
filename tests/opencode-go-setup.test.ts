import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

const privateFileFailure = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock("../runtime/private-file.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/private-file.mjs")>();
  return {
    ...actual,
    writePrivateFileAtomic: async (
      ...args: Parameters<typeof actual.writePrivateFileAtomic>
    ) => {
      const [path] = args;
      if (path === privateFileFailure.path) throw new Error("injected private write failure");
      return actual.writePrivateFileAtomic(...args);
    },
  };
});

import {
  addOpencodeGoAccount,
  applyOpencodeGoRestore,
  previewOpencodeGoRestore,
  refreshOpencodeGoCatalogForUpdate,
  runOpenCodeGoSetup,
} from "../scripts/opencode-go-setup.mjs";
import { writeManagedModelProviderProfileDefault } from "../runtime/model-provider-runtime.mjs";

describe.skipIf(process.platform === "win32")("OpenCode Go setup", () => {
  afterEach(() => {
    privateFileFailure.path = undefined;
  });

  it("shows that first-time setup requires an explicit account id", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-first-menu-"));
    let labels: string[] = [];

    await expect(runOpenCodeGoSetup({
      allowBack: true,
      environment: {
        CODEX_HOME: codexHome,
        CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
      },
      prompts: {
        select: async (options: { options: Array<{ label: string }> }) => {
          labels = options.options.map(({ label }) => label);
          return "back";
        },
        text: vi.fn(),
        password: vi.fn(),
        confirm: vi.fn(),
        isCancel: () => false,
      } as never,
    })).resolves.toEqual({ action: "back" });

    expect(labels.filter((label) => label.includes("先输入账户 ID"))).toEqual([
      "OpenAI + OpenCode Go 切换模式（先输入账户 ID）",
      "仅 OpenCode Go 固定模式（先输入账户 ID）",
    ]);
  });

  it("exposes account deletion in the configured OpenCode Go menu", async () => {
    const codexHome = opencodeFixture();
    let labels: string[] = [];

    await expect(runOpenCodeGoSetup({
      allowBack: true,
      environment: {
        CODEX_HOME: codexHome,
        CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
      },
      prompts: {
        select: async (options: { options: Array<{ label: string }> }) => {
          labels = options.options.map(({ label }) => label);
          return "back";
        },
        text: vi.fn(),
        password: vi.fn(),
        confirm: vi.fn(),
        isCancel: () => false,
      } as never,
    })).resolves.toEqual({ action: "back" });

    expect(labels).toContain("删除账户");
  });

  it("requires fixed-mode confirmation when called without a custom prompter", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-confirm-"));
    const password = vi.fn();
    const output = { write: vi.fn() };

    await expect(addOpencodeGoAccount("main", {
      mode: "exclusive",
      contact: "user@example.com",
      environment: {
        CODEX_HOME: codexHome,
        CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
      },
      output,
      prompts: {
        confirm: async () => false,
        password,
        isCancel: () => false,
      } as never,
    })).resolves.toEqual({ action: "cancelled", accountId: "main" });

    expect(password).not.toHaveBeenCalled();
    expect(output.write).toHaveBeenCalledWith("已取消，未修改任何文件。\n");
  });

  it("opens model settings from the OpenCode Go menu when configured", async () => {
    const codexHome = opencodeFixture();
    const select = vi.fn()
      .mockResolvedValueOnce("model-settings")
      .mockResolvedValueOnce("deepseek-v4-pro")
      .mockResolvedValueOnce("max");
    const text = vi.fn(async () => "60");

    const result = await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: vi.fn() },
      prompts: {
        select,
        text,
        password: vi.fn(),
        confirm: vi.fn(),
        isCancel: () => false,
      } as never,
    });

    expect(result).toMatchObject({
      action: "configured",
      provider: "ocg-main",
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactPercent: 60,
    });
    const catalog = JSON.parse(readFileSync(
      join(codexHome, ".codex-connect", "providers", "opencode-go", "models.json"),
      "utf8",
    ));
    expect(catalog.models).toContainEqual(expect.objectContaining({
      slug: "deepseek-v4-pro",
      auto_compact_token_limit: 629_146,
    }));
  });

  it.each(["switching", "exclusive"] as const)(
    "configures the first %s account with its account-scoped Profile and selects the shared third-party role",
    async (mode) => {
      const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-setup-"));
      const configureRole = vi.fn(async () => ({
        role: "external",
        provider: "ocg-work",
        model: "deepseek-v4-flash-vision-exp",
      }));
      const result = await runOpenCodeGoSetup({
        environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
        output: { write: vi.fn() },
        prompter: {
          select: async () => mode,
          accountId: async () => "work",
          secret: async () => "sk-opencode-test",
          confirm: async () => true,
          contact: async () => "user@example.com",
        },
        configureRole,
        downloadCatalog: successfulCatalog,
      });

      expect(result).toMatchObject({ action: "configured", mode });
      const target = mode === "switching" ? "sf-ocg-work.config.toml" : "config.toml";
      const config = parse(readFileSync(join(codexHome, target), "utf8"));
      expect(config).toMatchObject({
        model: "deepseek-v4-flash-vision-exp",
        model_provider: "ocg-work",
        model_providers: {
          "ocg-work": {
            base_url: "https://opencode.ai/zen/go/v1",
            wire_api: "responses",
            supports_websockets: false,
            experimental_bearer_token: "sk-opencode-test",
          },
        },
      });
      if (mode === "switching") {
        expect(config.model_reasoning_effort).toBe("high");
      } else {
        expect(config.model_reasoning_effort).toBeUndefined();
      }
      const catalog = JSON.parse(readFileSync(
        join(codexHome, ".codex-connect", "providers", "opencode-go", "models.json"),
        "utf8",
      ));
      expect(catalog.models.find((model: { slug?: string }) =>
        model.slug === "deepseek-v4-flash-vision-exp"
      )).toMatchObject({
        slug: "deepseek-v4-flash-vision-exp",
        input_modalities: ["text", "image"],
        default_reasoning_level: "high",
        auto_compact_token_limit: 600_000,
      });
      expect(parse(readFileSync(
        join(codexHome, ".codex-connect", "providers", "opencode-go", "accounts", "work", "managed.toml"),
        "utf8",
      ))).toEqual({ version: 1, provider: "ocg-work", mode });
      expect(configureRole).toHaveBeenCalledWith(
        "ocg-work",
        "deepseek-v4-flash-vision-exp",
        expect.objectContaining({ CODEX_HOME: codexHome }),
      );
      if (mode === "exclusive") {
        expect(existsSync(join(codexHome, "sf-ocg-work.config.toml"))).toBe(false);
      }
    },
  );

  it("moves from fixed mode back to switching without losing unrelated config", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-transition-"));
    writeFileSync(join(codexHome, "config.toml"), "custom = true\n", { mode: 0o600 });
    const base = {
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
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
    expect(parse(readFileSync(join(codexHome, "sf-ocg-main.config.toml"), "utf8")))
      .toMatchObject({ model_provider: "ocg-main" });
  });

  it("restores the initial config and provider files", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-restore-"));
    const original = 'model = "gpt-5.6-sol"\n';
    writeFileSync(join(codexHome, "config.toml"), original, { mode: 0o600 });
    await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("exclusive"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    });

    const result = await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("restore"),
      configureRole: vi.fn(async () => undefined),
    });

    expect(result).toMatchObject({ action: "restored" });
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "sf-ocg-main.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, ".codex-connect", "providers", "opencode-go", "accounts", "main", "managed.toml"))).toBe(false);
    expect(existsSync(join(codexHome, ".codex-connect", "providers", "opencode-go", "models.json"))).toBe(false);
    expect(existsSync(join(codexHome, ".codex-connect", "providers", "opencode-go", "models.manifest.json"))).toBe(false);
  });

  it("exposes a credential-free restore preview and requires explicit confirmation", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-restore-preview-"));
    const environment = {
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
    };
    await runOpenCodeGoSetup({
      environment,
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    });

    expect(previewOpencodeGoRestore({ environment })).toEqual({
      operation: "restore",
      provider: { id: "ocg", name: "OpenCode Go" },
      effects: {
        restoresInitialConfig: true,
        removesManagedCatalog: true,
        restoresExternalAgentConfig: true,
        removesManagedAccounts: true,
      },
      confirmation: { required: true, field: "confirmRestore" },
      activation: "restart-all",
    });
    await expect(applyOpencodeGoRestore({}, { environment })).rejects.toMatchObject({
      code: "confirmation-required",
      field: "confirmRestore",
    });
  });

  it("returns a stable error when no restore backup exists", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-no-restore-"));

    expect(() => previewOpencodeGoRestore({
      environment: {
        CODEX_HOME: codexHome,
        CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
      },
    })).toThrow(expect.objectContaining({
      code: "backup-not-found",
      field: "restore",
    }));
  });

  it("restores a legacy backup state created before catalog files were provider-owned", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-legacy-restore-"));
    await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    });
    const statePath = join(codexHome, ".codex-connect", "providers", "opencode-go", "backup", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    delete state.catalog;
    delete state.manifest;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("restore"),
    })).resolves.toMatchObject({ action: "restored" });

    expect(existsSync(join(codexHome, ".codex-connect", "providers", "opencode-go", "models.json"))).toBe(false);
    expect(existsSync(join(codexHome, ".codex-connect", "providers", "opencode-go", "models.manifest.json"))).toBe(false);
  });

  it("validates the complete backup state before restoring any file", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-invalid-restore-"));
    writeFileSync(join(codexHome, "config.toml"), "custom = true\n", { mode: 0o600 });
    await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    });
    const configPath = join(codexHome, "config.toml");
    const configBefore = readFileSync(configPath, "utf8");
    const statePath = join(codexHome, ".codex-connect", "providers", "opencode-go", "backup", "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    delete state.manifest;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("restore"),
    })).rejects.toMatchObject({ code: "backup-invalid", field: "restore" });

    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    expect(existsSync(join(codexHome, ".codex-connect", "providers", "opencode-go", "models.json"))).toBe(true);
  });

  it("preserves the selected model and per-model settings when setup is repeated", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-repeat-"));
    const environment = { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") };
    await runOpenCodeGoSetup({
      environment,
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    });
    writeManagedModelProviderProfileDefault("ocg-main", {
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

    expect(parse(readFileSync(join(codexHome, "sf-ocg-main.config.toml"), "utf8")))
      .toMatchObject({
        model: "deepseek-v4-pro",
        model_reasoning_effort: "max",
      });
    const catalog = JSON.parse(readFileSync(
      join(codexHome, ".codex-connect", "providers", "opencode-go", "models.json"),
      "utf8",
    ));
    expect(catalog.models.find((model: { slug?: string }) =>
      model.slug === "deepseek-v4-pro"
    )).toMatchObject({
      slug: "deepseek-v4-pro",
      context_window: 2_000_000,
      default_reasoning_level: "max",
      auto_compact_token_limit: 1_500_000,
    });
    expect(configureRole).toHaveBeenCalledWith("ocg-main", "deepseek-v4-pro", environment);
  });

  it("migrates the previous OpenCode Go default during codexc update", async () => {
    const codexHome = opencodeFixture();
    const environment = {
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
    };
    const rolePath = join(codexHome, "sf-agent.config.toml");
    writeFileSync(
      join(codexHome, "config.toml"),
      `model = "gpt-5.6-sol"\nmodel_provider = "openai"\n\n[agents.external]\nconfig_file = ${JSON.stringify(rolePath)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      rolePath,
      'model = "deepseek-v4-flash"\nmodel_provider = "ocg-main"\nmodel_reasoning_effort = "high"\n',
      { mode: 0o600 },
    );

    const result = await refreshOpencodeGoCatalogForUpdate(environment, {
      downloadCatalog: async () => updatedCatalog(2_000_000),
      now: () => new Date("2026-08-21T16:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "updated",
      modelCount: 3,
      migratedProviders: ["ocg-main"],
      roleMigrated: true,
      defaultModelMigrationApplied: true,
    });
    expect(parse(readFileSync(join(codexHome, "sf-ocg-main.config.toml"), "utf8")))
      .toMatchObject({
        model: "deepseek-v4-flash-vision-exp",
        model_reasoning_effort: "high",
      });
    expect(parse(readFileSync(rolePath, "utf8"))).toMatchObject({
      model: "deepseek-v4-flash-vision-exp",
      model_provider: "ocg-main",
      model_reasoning_effort: "high",
    });
    expect(JSON.parse(readFileSync(
      join(codexHome, ".codex-connect", "providers", "opencode-go", "models.manifest.json"),
      "utf8",
    ))).toMatchObject({
      sha256: "a".repeat(64),
      downloadedAt: "2026-08-21T16:00:00.000Z",
      defaultModelMigration: {
        from: "deepseek-v4-flash",
        to: "deepseek-v4-flash-vision-exp",
        appliedAt: "2026-08-21T16:00:00.000Z",
      },
    });

    await runOpenCodeGoSetup({
      environment,
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: async () => updatedCatalog(2_000_000),
    });
    expect(JSON.parse(readFileSync(
      join(codexHome, ".codex-connect", "providers", "opencode-go", "models.manifest.json"),
      "utf8",
    ))).toMatchObject({
      defaultModelMigration: {
        from: "deepseek-v4-flash",
        to: "deepseek-v4-flash-vision-exp",
        appliedAt: "2026-08-21T16:00:00.000Z",
      },
    });

    writeManagedModelProviderProfileDefault("ocg-main", {
      model: "deepseek-v4-flash",
      reasoningEffort: "high",
      autoCompactLimit: 1_200_000,
    }, environment);
    const repeated = await refreshOpencodeGoCatalogForUpdate(environment, {
      downloadCatalog: async () => updatedCatalog(2_000_000),
      now: () => new Date("2026-08-22T16:00:00.000Z"),
    });
    expect(repeated).toMatchObject({
      status: "updated",
      migratedProviders: [],
      roleMigrated: false,
      defaultModelMigrationApplied: false,
    });
    expect(parse(readFileSync(join(codexHome, "sf-ocg-main.config.toml"), "utf8")))
      .toMatchObject({ model: "deepseek-v4-flash" });
  });

  it("preserves an explicitly selected OpenCode Go Pro model during codexc update", async () => {
    const codexHome = opencodeFixture();
    const environment = {
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
    };
    writeManagedModelProviderProfileDefault("ocg-main", {
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      autoCompactLimit: 750_000,
    }, environment);

    const result = await refreshOpencodeGoCatalogForUpdate(environment, {
      downloadCatalog: async () => updatedCatalog(2_000_000),
    });

    expect(result).toMatchObject({
      status: "updated",
      migratedProviders: [],
      roleMigrated: false,
    });
    expect(parse(readFileSync(join(codexHome, "sf-ocg-main.config.toml"), "utf8")))
      .toMatchObject({
        model: "deepseek-v4-pro",
        model_reasoning_effort: "max",
      });
  });

  it("refuses to overwrite an unmanaged OpenCode Go Profile", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-unmanaged-"));
    const profilePath = join(codexHome, "sf-ocg-main.config.toml");
    writeFileSync(profilePath, 'model = "user-managed"\n', { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("switching"),
    })).rejects.toThrow("管理标记不存在");
    expect(readFileSync(profilePath, "utf8")).toBe('model = "user-managed"\n');
  });

  it("refuses a user-managed OpenCode Go Provider in config.toml", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-config-owner-"));
    const configPath = join(codexHome, "config.toml");
    const original = '[model_providers.ocg-main]\nname = "user-managed"\n';
    writeFileSync(configPath, original, { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("switching"),
      downloadCatalog: successfulCatalog,
    })).rejects.toThrow("已占用 ocg-main Provider 或 Profile");

    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "sf-ocg-main.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, ".codex-connect", "providers", "opencode-go", "accounts", "main", "managed.toml"))).toBe(false);
  });

  it("rolls back every file when shared-role configuration fails", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-rollback-"));
    const original = "custom = true\n";
    writeFileSync(join(codexHome, "config.toml"), original, { mode: 0o600 });

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => { throw new Error("config conflict"); }),
      downloadCatalog: successfulCatalog,
    })).rejects.toThrow("config conflict");

    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe(original);
    expect(existsSync(join(codexHome, "sf-ocg-main.config.toml"))).toBe(false);
    expect(existsSync(join(codexHome, ".codex-connect", "providers", "opencode-go", "accounts", "main", "managed.toml"))).toBe(false);
  });

  it("rolls back earlier files when a setup write fails midway", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-write-rollback-"));
    const connectHome = join(codexHome, ".codex-connect");
    const providerDirectory = join(connectHome, "providers", "opencode-go");
    const configPath = join(codexHome, "config.toml");
    const original = "custom = true\n";
    writeFileSync(configPath, original, { mode: 0o600 });
    privateFileFailure.path = join(providerDirectory, "models.manifest.json");

    await expect(runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: connectHome },
      output: { write: () => undefined },
      prompter: prompt("switching"),
      configureRole: vi.fn(async () => undefined),
      downloadCatalog: successfulCatalog,
    })).rejects.toThrow("injected private write failure");

    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(join(providerDirectory, "models.json"))).toBe(false);
    expect(existsSync(join(codexHome, "sf-ocg-main.config.toml"))).toBe(false);
    expect(existsSync(join(providerDirectory, "accounts.json"))).toBe(false);
  });
});

function prompt(action: "switching" | "exclusive" | "restore") {
  return {
    select: async () => action,
    accountId: async () => "main",
    secret: async () => "sk-opencode-test",
    confirm: async () => true,
    contact: async () => "user@example.com",
  };
}

function opencodeFixture(): string {
  const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-menu-"));
  const providerDirectory = join(
    codexHome,
    ".codex-connect",
    "providers",
    "opencode-go",
  );
  mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
  const accountDirectory = join(providerDirectory, "accounts", "main");
  mkdirSync(accountDirectory, { recursive: true, mode: 0o700 });
  const catalogPath = join(providerDirectory, "models.json");
  const providerLines = [
    'model = "deepseek-v4-flash"',
    'model_provider = "ocg-main"',
    'model_reasoning_effort = "high"',
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
    "[model_providers.ocg-main]",
    'name = "ocg-main"',
    'base_url = "https://opencode.ai/zen/go/v1"',
    'wire_api = "responses"',
    "supports_websockets = false",
    "requires_openai_auth = false",
    'experimental_bearer_token = "sk-test-secret"',
    "",
  ].join("\n");
  writeFileSync(
    join(providerDirectory, "accounts.json"),
    `${JSON.stringify([{ id: "main", default: true, email: "user@example.com" }], null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(accountDirectory, "managed.toml"),
    'version = 1\nprovider = "ocg-main"\nmode = "switching"\n',
    { mode: 0o600 },
  );
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
  writeFileSync(
    join(codexHome, "sf-ocg-main.config.toml"),
    providerLines,
    { mode: 0o600 },
  );
  writeFileSync(
    join(codexHome, "config.toml"),
    'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n',
    { mode: 0o600 },
  );
  return codexHome;
}

async function successfulCatalog() {
  return updatedCatalog(1_000_000);
}

function updatedCatalog(contextWindow: number) {
  return {
    catalog: {
      models: [
        "deepseek-v4-flash",
        "deepseek-v4-flash-vision-exp",
        "deepseek-v4-pro",
      ].map((slug) => ({
        slug,
        input_modalities: slug === "deepseek-v4-flash-vision-exp"
          ? ["text", "image"]
          : ["text"],
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
