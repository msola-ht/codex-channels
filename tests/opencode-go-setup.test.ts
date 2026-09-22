import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

const privateFileFailure = vi.hoisted(() => ({ path: undefined as string | undefined }));

vi.mock("../runtime/private-file.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/private-file.mjs")>();
  return {
    ...actual,
    writePrivateFileAtomicSync: (
      ...args: Parameters<typeof actual.writePrivateFileAtomicSync>
    ) => {
      const [path] = args;
      if (path === privateFileFailure.path) throw new Error("injected private write failure");
      return actual.writePrivateFileAtomicSync(...args);
    },
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
import {
  loadManagedModelWindow,
  loadManagedModelProviderSettings,
  managedModelProviderRoleConfigPath,
  writeManagedModelProviderRoleConfig,
  writeManagedModelProviderProfileDefault,
} from "../runtime/model-provider-runtime.mjs";

describe.skipIf(process.platform === "win32")("OpenCode Go setup", () => {
  afterEach(() => {
    privateFileFailure.path = undefined;
  });

  it("mirrors model reasoning to every account sharing that model without changing other models", () => {
    const codexHome = opencodeFixture();
    const environment = { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") };
    const directory = join(environment.CODEX_CONNECT_HOME, "providers/opencode-go");
    const source = readFileSync(join(codexHome, "sf-ocg-main.config.toml"), "utf8")
      .replace('model = "deepseek-v4-flash"', 'model = "deepseek-flash"');
    for (const id of ["second", "pro"]) {
      mkdirSync(join(directory, "accounts", id), { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, "accounts", id, "managed.toml"), `version = 1\nprovider = "ocg-${id}"\nmode = "switching"\n`, { mode: 0o600 });
      let profile = source.replaceAll("ocg-main", `ocg-${id}`);
      if (id === "pro") profile = profile.replace('model = "deepseek-flash"', 'model = "deepseek-v4-pro"');
      writeFileSync(join(codexHome, `sf-ocg-${id}.config.toml`), profile, { mode: 0o600 });
    }
    writeFileSync(join(directory, "accounts.json"), JSON.stringify(["main", "second", "pro"].map((id) => ({ id, default: id === "main", email: `${id}@example.com` }))), { mode: 0o600 });
    writeManagedModelProviderProfileDefault("ocg-main", {
      model: "deepseek-flash", reasoningEffort: "high",
    }, environment);
    writeManagedModelProviderRoleConfig(environment, {
      provider: "ocg-main", model: "deepseek-flash",
    });
    const rolePath = managedModelProviderRoleConfigPath(environment);
    writeFileSync(join(codexHome, "config.toml"), stringify({
      model: "gpt-5.6-sol", agents: { external: { config_file: rolePath } },
    }), { mode: 0o600 });
    writeManagedModelProviderProfileDefault("ocg-main", {
      model: "deepseek-flash", reasoningEffort: "max",
    }, environment);
    expect(loadManagedModelProviderSettings(environment).map(({ provider, model, reasoningEffort }) => ({ provider, model, reasoningEffort }))).toEqual([
      { provider: "ocg-main", model: "deepseek-flash", reasoningEffort: "max" },
      { provider: "ocg-second", model: "deepseek-flash", reasoningEffort: "max" },
      { provider: "ocg-pro", model: "deepseek-v4-pro", reasoningEffort: "high" },
    ]);
    expect(parse(readFileSync(rolePath, "utf8"))).toMatchObject({
      model_provider: "ocg-main",
      model: "deepseek-flash",
      model_reasoning_effort: "max",
    });
  });

  it.each(["none", "profile", "role"] as const)(
    "synchronizes refreshed reasoning and rolls back on reference failure (%s)",
    async (failureTarget) => {
    const codexHome = opencodeFixture();
    const environment = { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") };
    writeManagedModelProviderProfileDefault("ocg-main", { model: "deepseek-flash", reasoningEffort: "max" }, environment);
    const profile = join(codexHome, "sf-ocg-main.config.toml");
    writeManagedModelProviderRoleConfig(environment, {
      provider: "ocg-main", model: "deepseek-flash",
    });
    const role = managedModelProviderRoleConfigPath(environment);
    writeFileSync(join(codexHome, "config.toml"), stringify({
      model: "gpt-5.6-sol", agents: { external: { config_file: role } },
    }), { mode: 0o600 });
    const catalog = join(environment.CODEX_CONNECT_HOME, "providers/opencode-go/models.json");
    const before = [profile, role, catalog].map((path) => readFileSync(path, "utf8"));
    const downloaded = updatedCatalog(2_000_000);
    for (const model of downloaded.catalog.models) model.supported_reasoning_levels = [{ effort: "high", description: "High" }];
    if (failureTarget !== "none") {
      privateFileFailure.path = failureTarget === "profile" ? profile : role;
    }
    const refresh = refreshOpencodeGoCatalogForUpdate(environment, { downloadCatalog: async () => downloaded });
    if (failureTarget !== "none") {
      await expect(refresh).rejects.toThrow("injected");
      expect([profile, role, catalog].map((path) => readFileSync(path, "utf8"))).toEqual(before);
    } else {
      await expect(refresh).resolves.toMatchObject({ status: "updated", migratedProviders: [] });
      expect(loadManagedModelProviderSettings(environment)[0]).toMatchObject({ model: "deepseek-flash", reasoningEffort: "high" });
      expect(parse(readFileSync(role, "utf8"))).toMatchObject({ model_reasoning_effort: "high" });
    }
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

    const result = await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: vi.fn() },
      prompts: {
        select,
        text: vi.fn(),
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
    });
    const catalog = JSON.parse(readFileSync(
      join(codexHome, ".codex-connect", "providers", "opencode-go", "models.json"),
      "utf8",
    ));
    expect(catalog.models).toContainEqual(expect.objectContaining({
      slug: "deepseek-v4-pro",
      default_reasoning_level: "max",
      // 只改默认思考等级时不动窗口：目录里下载的字段保持原样。
      context_window: 1_048_576,
      auto_compact_token_limit: 629_146,
    }));
  });

  it.each(["switching", "exclusive"] as const)(
    "configures the first %s account with its account-scoped Profile without selecting the shared third-party role",
    async (mode) => {
      const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-setup-"));
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
        downloadCatalog: successfulCatalog,
      });

      expect(result).toMatchObject({ action: "configured", mode });
      const target = mode === "switching" ? "sf-ocg-work.config.toml" : "config.toml";
      const config = parse(readFileSync(join(codexHome, target), "utf8"));
      expect(config).toMatchObject({
        model: "deepseek-flash",
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
        model.slug === "deepseek-flash"
      )).toMatchObject({
        slug: "deepseek-flash",
        input_modalities: ["text", "image"],
        default_reasoning_level: "high",
        context_window: 1_000_000,
      });
      // 下载目录没有压缩阈值时不新增该字段。
      expect(catalog.models.find((model: { slug?: string }) =>
        model.slug === "deepseek-flash"
      ).auto_compact_token_limit).toBeUndefined();
      expect(parse(readFileSync(
        join(codexHome, ".codex-connect", "providers", "opencode-go", "accounts", "work", "managed.toml"),
        "utf8",
      ))).toEqual({ version: 1, provider: "ocg-work", mode });
      expect(existsSync(join(codexHome, "sf-agent.config.toml"))).toBe(false);
      if (mode === "exclusive") {
        expect(existsSync(join(codexHome, "sf-ocg-work.config.toml"))).toBe(false);
      }
    },
  );

  it("inherits the model window from existing DeepSeek when adding an OpenCode Go account", async () => {
    const codexHome = deepseekFixture();
    const environment = {
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
    };

    await addOpencodeGoAccount("main", {
      mode: "switching",
      environment,
      output: { write: vi.fn() },
      prompter: prompt("switching"),
      downloadCatalog: successfulCatalog,
    });

    const catalog = JSON.parse(readFileSync(
      join(codexHome, ".codex-connect", "providers", "opencode-go", "models.json"),
      "utf8",
    ));
    expect(catalog.models).toContainEqual(expect.objectContaining({
      slug: "deepseek-flash",
      context_window: 400_000,
    }));
    expect(catalog.models).toContainEqual(expect.objectContaining({
      slug: "deepseek-v4.1-flash", display_name: "DeepSeek V4.1 Flash",
      input_modalities: ["text", "image"],
    }));
    expect(catalog.models.find((model: { slug?: string }) =>
      model.slug === "deepseek-flash"
    ).auto_compact_token_limit).toBeUndefined();
  });

  it("reports divergent per-Provider window ratios without blocking the unified window", async () => {
    const codexHome = deepseekFixture();
    const environment = {
      CODEX_HOME: codexHome,
      CODEX_CONNECT_HOME: join(codexHome, ".codex-connect"),
    };

    await addOpencodeGoAccount("main", {
      mode: "switching",
      environment,
      output: { write: vi.fn() },
      prompter: prompt("switching"),
      downloadCatalog: successfulCatalog,
    });
    const catalogPath = join(
      codexHome,
      ".codex-connect",
      "providers",
      "opencode-go",
      "models.json",
    );
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
    const flash = catalog.models.find(
      (model: { slug?: string }) => model.slug === "deepseek-flash",
    );
    flash.context_window = 600_000;
    writeFileSync(catalogPath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 });

    const entry = loadManagedModelWindow(environment).find(
      (model) => model.model === "deepseek-flash",
    );
    expect(entry?.perProvider).toEqual({ "ds-test": 40, "ocg-main": 60 });
    expect(entry?.conflicts).toBe(true);
    // 最大窗口一致时不阻断统一设置；占比差异由 conflicts 单独暴露。
    expect(entry?.windowConflict).toBe(false);
  });

  it("moves from fixed mode back to switching without losing unrelated config", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-transition-"));
    writeFileSync(join(codexHome, "config.toml"), "custom = true\n", { mode: 0o600 });
    const base = {
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
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
      downloadCatalog: successfulCatalog,
    });

    const result = await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("restore"),
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
      downloadCatalog: successfulCatalog,
    });
    writeManagedModelProviderProfileDefault("ocg-main", {
      model: "deepseek-v4-pro",
      reasoningEffort: "max",
      contextWindow: 750_000,
    }, environment);
    await runOpenCodeGoSetup({
      environment,
      output: { write: () => undefined },
      prompter: prompt("switching"),
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
      context_window: 1_500_000,
      default_reasoning_level: "max",
    });
    expect(catalog.models.find((model: { slug?: string }) =>
      model.slug === "deepseek-v4-pro"
    ).auto_compact_token_limit).toBeUndefined();
    expect(existsSync(join(codexHome, "sf-agent.config.toml"))).toBe(false);
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
    expect(JSON.parse(readFileSync(
      join(codexHome, ".codex-connect", "providers", "opencode-go", "models.json"), "utf8",
    )).models).toContainEqual(expect.objectContaining({
      slug: "deepseek-v4.1-flash", display_name: "DeepSeek V4.1 Flash",
    }));
    expect(parse(readFileSync(join(codexHome, "sf-ocg-main.config.toml"), "utf8")))
      .toMatchObject({
        model: "deepseek-flash",
        model_reasoning_effort: "high",
      });
    expect(parse(readFileSync(rolePath, "utf8"))).toMatchObject({
      model: "deepseek-flash",
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
        to: "deepseek-flash",
        appliedAt: "2026-08-21T16:00:00.000Z",
      },
    });

    await runOpenCodeGoSetup({
      environment,
      output: { write: () => undefined },
      prompter: prompt("switching"),
      downloadCatalog: async () => updatedCatalog(2_000_000),
    });
    expect(JSON.parse(readFileSync(
      join(codexHome, ".codex-connect", "providers", "opencode-go", "models.manifest.json"),
      "utf8",
    ))).toMatchObject({
      defaultModelMigration: {
        from: "deepseek-v4-flash",
        to: "deepseek-flash",
        appliedAt: "2026-08-21T16:00:00.000Z",
      },
    });

    const profilePath = join(codexHome, "sf-ocg-main.config.toml");
    writeFileSync(
      profilePath,
      readFileSync(profilePath, "utf8").replace(
        'model = "deepseek-flash"',
        'model = "deepseek-v4-flash"',
      ),
      { mode: 0o600 },
    );
    const repeated = await refreshOpencodeGoCatalogForUpdate(environment, {
      downloadCatalog: async () => updatedCatalog(2_000_000),
      now: () => new Date("2026-08-22T16:00:00.000Z"),
    });
    expect(repeated).toMatchObject({
      status: "updated",
      migratedProviders: ["ocg-main"],
      roleMigrated: false,
      defaultModelMigrationApplied: true,
    });
    expect(parse(readFileSync(profilePath, "utf8")))
      .toMatchObject({ model: "deepseek-flash" });
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
      contextWindow: 750_000,
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

  it("does not run shared-role configuration during provider setup", async () => {
    const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-rollback-"));
    const original = "custom = true\n";
    writeFileSync(join(codexHome, "config.toml"), original, { mode: 0o600 });

    await runOpenCodeGoSetup({
      environment: { CODEX_HOME: codexHome, CODEX_CONNECT_HOME: join(codexHome, ".codex-connect") },
      output: { write: () => undefined },
      prompter: prompt("switching"),
      downloadCatalog: successfulCatalog,
    });

    expect(existsSync(join(codexHome, "sf-ocg-main.config.toml"))).toBe(true);
    expect(existsSync(join(codexHome, ".codex-connect", "providers", "opencode-go", "accounts", "main", "managed.toml"))).toBe(true);
    expect(existsSync(join(codexHome, "sf-agent.config.toml"))).toBe(false);
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
      "deepseek-flash",
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

function deepseekFixture(): string {
  const codexHome = mkdtempSync(join(tmpdir(), "codexc-opencode-deepseek-"));
  const connectHome = join(codexHome, ".codex-connect");
  const providerDirectory = join(connectHome, "providers", "deepseek");
  mkdirSync(providerDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(join(providerDirectory, "accounts", "test"), { recursive: true, mode: 0o700 });
  writeFileSync(join(providerDirectory, "accounts.json"), JSON.stringify([{ id: "test", default: true }]), { mode: 0o600 });
  const catalogPath = join(providerDirectory, "models.json");
  writeFileSync(
    join(providerDirectory, "accounts", "test", "managed.toml"),
    'version = 1\nprovider = "ds-test"\nmode = "switching"\n',
    { mode: 0o600 },
  );
  writeFileSync(catalogPath, JSON.stringify({
    models: [
      "deepseek-flash",
      "deepseek-v4-pro",
    ].map((slug) => ({
      slug,
      display_name: slug,
      context_window: 1_000_000,
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "high", description: "High" },
        { effort: "max", description: "Max" },
      ],
      ...(slug === "deepseek-v4-pro"
        ? {}
        : { auto_compact_token_limit: 400_000 }),
    })),
  }), { mode: 0o600 });
  writeFileSync(
    join(codexHome, "sf-ds-test.config.toml"),
    [
      'model = "deepseek-flash"',
      'model_provider = "ds-test"',
      'model_reasoning_effort = "high"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      "[model_providers.ds-test]",
      'name = "ds-test"',
      'base_url = "https://api.deepseek.com/"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      'experimental_bearer_token = "sk-test-secret"',
      "",
    ].join("\n"),
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
        "deepseek-flash",
        "deepseek-v4-pro",
      ].map((slug) => ({
        slug,
        input_modalities: slug === "deepseek-flash"
          ? ["text", "image"]
          : ["text"],
        context_window: contextWindow,
        max_context_window: contextWindow,
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
