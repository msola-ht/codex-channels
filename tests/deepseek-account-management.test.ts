import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ path: "" }));
vi.mock("../runtime/private-file.mjs", async (original) => {
  const actual = await original<typeof import("../runtime/private-file.mjs")>();
  return { ...actual, writePrivateFileAtomic: async (...args: Parameters<typeof actual.writePrivateFileAtomic>) => {
    if (args[0] === failure.path) throw new Error("injected write failure");
    return actual.writePrivateFileAtomic(...args);
  } };
});

import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { loadDeepseekAccounts, validateDeepseekAccounts } from "../runtime/deepseek-accounts.mjs";
import {
  loadDeepseekAccountCredential,
  loadManagedModelProviderSettings,
  loadManagedProviderAppServers,
  managedModelProviderRoleConfigPath,
  writeManagedModelProviderProfileDefault,
  writeManagedModelProviderRoleConfig,
} from "../runtime/model-provider-runtime.mjs";
import { JsonRpcClient, StdioTransport } from "../src/codex-client/index.js";
import { updateLocalInstallation, prepareDeepseekUpdateMigration } from "../scripts/local-update.mjs";
import { applyDeepseekAccountConfiguration, deepseekAccountPaths, migrateDeepseekAccount, refreshDeepseekAccountsCatalog, removeDeepseekAccount, setDeepseekDefaultAccount } from "../scripts/deepseek-account-management.mjs";

const homes: string[] = [];
afterEach(() => { failure.path = ""; for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ds-accounts-"));
  homes.push(home);
  const environment = { CODEX_HOME: join(home, "codex"), CODEX_CONNECT_HOME: join(home, "connect") };
  const paths = deepseekAccountPaths(environment, "personal");
  writePrivateFileAtomicSync(paths.config, 'model = "original"\n');
  const catalog = { models: ["deepseek-flash", "deepseek-v4-pro"].map((slug) => ({
    slug, display_name: slug, context_window: 1048576, max_context_window: 1048576,
    input_modalities: ["text"], default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "high", description: "High" }, { effort: "max", description: "Max" }],
    description: "DS contract fixture", shell_type: "shell_command", visibility: "list",
    minimal_client_version: [0, 1, 0], supported_in_api: true, priority: 0,
    support_verbosity: false, truncation_policy: { mode: "bytes", limit: 10000 },
    experimental_supported_tools: [], model_messages: { instructions_template: "You are a coding assistant." },
  })) };
  const downloadCatalog = vi.fn(async () => ({ catalog }));
  return { environment, paths, catalog, downloadCatalog };
}
const input = { accountId: "personal", apiKey: "sk-personal" };

describe("DeepSeek managed accounts", () => {
  it("rejects missing, invalid or cancelled migration IDs before stopping services", async () => {
    const options = fixture();
    writePrivateFileAtomicSync(join(options.environment.CODEX_CONNECT_HOME, "providers/deepseek/managed.toml"), 'version = 1\nprovider = "deepseek"\nmode = "switching"\n');
    const stopServices = vi.fn();
    const updateOptions = {
      inspectConfig: () => ({ configPath: options.paths.config }),
      inspectDatabases: () => ({ state: {}, metrics: {} }),
      inspectServices: () => ({ installed: true }), stopServices,
    };
    await expect(updateLocalInstallation(options.environment, updateOptions)).rejects.toThrow("填写账户 ID");
    await expect(updateLocalInstallation(options.environment, { ...updateOptions, deepseekMigrationId: "../bad" })).rejects.toThrow("账户 ID");
    await expect(updateLocalInstallation(options.environment, { ...updateOptions, requestDeepseekMigrationId: async () => { throw new Error("cancelled"); } })).rejects.toThrow("cancelled");
    expect(stopServices).not.toHaveBeenCalled();
  });

  it("preflights DS migration IDs for the old file layout", async () => {
    const options = fixture();
    writePrivateFileAtomicSync(join(options.environment.CODEX_HOME, "sf-deepseek.managed.toml"), 'version = 1\nprovider = "deepseek"\nmode = "switching"\n');
    await expect(prepareDeepseekUpdateMigration(options.environment)).rejects.toThrow("填写账户 ID");
    await expect(prepareDeepseekUpdateMigration(options.environment, { deepseekMigrationId: "personal" })).resolves.toBe("personal");
  });
  it("requires explicit valid IDs and rejects colliding credential names", () => {
    expect(() => validateDeepseekAccounts([{ default: true }])).toThrow("账户 ID");
    expect(() => validateDeepseekAccounts([{ id: "../outside", default: true }])).toThrow("账户 ID");
    expect(() => validateDeepseekAccounts([{ id: "team-a", default: true }, { id: "team_a", default: false }])).toThrow("重复");
  });
  it("isolates keys and processes while sharing only the official catalog", async () => {
    const options = fixture();
    await applyDeepseekAccountConfiguration(input, options);
    await applyDeepseekAccountConfiguration({ accountId: "work", apiKey: "sk-work" }, options);
    expect(options.downloadCatalog).toHaveBeenCalledTimes(1);
    expect(loadDeepseekAccounts(options.environment)).toEqual([{ id: "personal", default: true }, { id: "work", default: false }]);
    expect(loadDeepseekAccountCredential(options.environment, "ds-personal")).toBe("sk-personal");
    expect(loadDeepseekAccountCredential(options.environment, "ds-work")).toBe("sk-work");
    const servers = loadManagedProviderAppServers(options.environment);
    expect(servers.map((server) => server.provider)).toEqual(["ds-personal", "ds-work"]);
    expect(Object.values(servers[0]!.childEnvironment)).not.toContain("sk-work");
    expect(readFileSync(options.paths.registry, "utf8")).not.toContain("sk-");
    expect(JSON.parse(readFileSync(options.paths.catalog, "utf8"))).toEqual(options.catalog);
  });

  it("changes the default and removes accounts without deleting shared catalog or history", async () => {
    const options = fixture();
    await applyDeepseekAccountConfiguration(input, options);
    await applyDeepseekAccountConfiguration({ accountId: "work", apiKey: "sk-work" }, options);
    await expect(removeDeepseekAccount({ accountId: "personal", confirmRemove: true }, options)).rejects.toThrow("默认账户");
    await setDeepseekDefaultAccount("work", options);
    await removeDeepseekAccount({ accountId: "personal", confirmRemove: true }, options);
    expect(loadDeepseekAccountCredential(options.environment)).toBe("sk-work");
    expect(existsSync(options.paths.profile)).toBe(false);
    expect(existsSync(options.paths.catalog)).toBe(true);
    expect(existsSync(options.paths.backup)).toBe(true);
  });

  it.each(["switching", "exclusive"] as const)("directly migrates a %s legacy account with its settings", async (mode) => {
    const options = fixture();
    await applyDeepseekAccountConfiguration({ ...input, mode, confirmExclusiveConfigChange: true }, options);
    const source = mode === "exclusive" ? options.paths.config : options.paths.profile;
    const document = parse(readFileSync(source, "utf8"));
    const providers = document.model_providers as Record<string, unknown>;
    document.model_provider = "deepseek";
    providers.deepseek = providers["ds-personal"];
    delete providers["ds-personal"];
    const directory = join(options.environment.CODEX_CONNECT_HOME, "providers", "deepseek");
    const legacyProfile = join(options.environment.CODEX_HOME, "sf-deepseek.config.toml");
    writePrivateFileAtomicSync(mode === "exclusive" ? options.paths.config : legacyProfile, stringify(document));
    writePrivateFileAtomicSync(join(directory, "managed.toml"), `version = 1\nprovider = "deepseek"\nmode = "${mode}"\n`);
    writePrivateFileAtomicSync(join(directory, "backup", "config.toml"), 'model = "original"\n');
    rmSync(options.paths.registry); rmSync(options.paths.marker); rmSync(options.paths.backup);
    if (existsSync(options.paths.profile)) rmSync(options.paths.profile);
    const previousSource = readFileSync(mode === "exclusive" ? options.paths.config : legacyProfile, "utf8");
    failure.path = options.paths.registry;
    await expect(migrateDeepseekAccount({ accountId: "personal", confirmMigration: true }, options)).rejects.toThrow("injected");
    expect(readFileSync(mode === "exclusive" ? options.paths.config : legacyProfile, "utf8")).toBe(previousSource);
    expect(existsSync(join(directory, "managed.toml"))).toBe(true);
    expect(existsSync(options.paths.marker)).toBe(false);
    expect(loadDeepseekAccounts(options.environment)).toEqual([]);
    failure.path = "";
    const calls: string[] = [];
    await updateLocalInstallation(options.environment, {
      requestDeepseekMigrationId: async () => { calls.push("id"); return "personal"; },
      inspectConfig: () => ({ configPath: options.paths.config }),
      inspectDatabases: () => ({ state: {}, metrics: {} }),
      inspectServices: () => ({ installed: true }),
      stopServices: () => { calls.push("stop"); },
      updateProviderFiles: () => { calls.push("files"); },
      updateProviderCatalogs: async () => {
        expect(loadDeepseekAccounts(options.environment)[0]?.id).toBe("personal");
        await refreshDeepseekAccountsCatalog(options.environment, { downloadCatalog: options.downloadCatalog });
        calls.push("catalogs");
      },
      updateCodexSettings: () => undefined, updateConfig: () => undefined, updateDatabases: () => undefined,
      validateOffline: () => { calls.push("validate"); },
      startServices: () => { calls.push("start"); }, waitForServices: async () => undefined,
    });
    expect(calls).toEqual(["id", "stop", "files", "catalogs", "validate", "start"]);
    expect(loadDeepseekAccountCredential(options.environment, "ds-personal")).toBe("sk-personal");
    expect(loadManagedModelProviderSettings(options.environment)[0]?.model).toBe("deepseek-flash");
    expect(existsSync(legacyProfile)).toBe(false);
    expect(existsSync(join(directory, "managed.toml"))).toBe(false);
    expect(readFileSync(options.paths.catalog, "utf8")).not.toContain("4.1");
  });

  it("rolls back a failed account installation", async () => {
    const options = fixture();
    failure.path = options.paths.registry;
    await expect(applyDeepseekAccountConfiguration(input, options)).rejects.toThrow("injected");
    expect(loadDeepseekAccounts(options.environment)).toEqual([]);
    expect(existsSync(options.paths.catalog)).toBe(false);
    expect(existsSync(options.paths.profile)).toBe(false);
    expect(readFileSync(options.paths.config, "utf8")).toBe('model = "original"\n');
  });

  it("captures a fresh restore baseline when another account enters fixed mode", async () => {
    const options = fixture();
    await applyDeepseekAccountConfiguration({
      ...input,
      mode: "exclusive",
      confirmExclusiveConfigChange: true,
    }, options);
    await applyDeepseekAccountConfiguration({ accountId: "work", apiKey: "sk-work" }, options);
    await applyDeepseekAccountConfiguration({
      ...input,
      mode: "switching",
      reconfigure: true,
    }, options);
    await applyDeepseekAccountConfiguration({
      accountId: "work",
      apiKey: "sk-work",
      mode: "exclusive",
      reconfigure: true,
      confirmExclusiveConfigChange: true,
    }, options);

    await removeDeepseekAccount({ accountId: "work", confirmRemove: true }, options);

    expect(parse(readFileSync(options.paths.config, "utf8"))).toEqual({ model: "original" });
    expect(loadManagedModelProviderSettings(options.environment)).toEqual([
      expect.objectContaining({ provider: "ds-personal", mode: "switching" }),
    ]);
  });

  it("does not refresh the shared catalog when a registered account is incomplete", async () => {
    const options = fixture();
    await applyDeepseekAccountConfiguration(input, options);
    await applyDeepseekAccountConfiguration({ accountId: "work", apiKey: "sk-work" }, options);
    const before = readFileSync(options.paths.catalog);
    rmSync(deepseekAccountPaths(options.environment, "work").marker);

    await expect(refreshDeepseekAccountsCatalog(options.environment, {
      downloadCatalog: options.downloadCatalog,
    })).rejects.toThrow("账户配置不完整");
    expect(readFileSync(options.paths.catalog)).toEqual(before);
  });

  it("refreshes the shared directory and all account defaults in one transaction", async () => {
    const options = fixture();
    await applyDeepseekAccountConfiguration(input, options);
    await applyDeepseekAccountConfiguration({ accountId: "work", apiKey: "sk-work" }, options);
    const catalog = { models: [options.catalog.models[1]!] };
    await refreshDeepseekAccountsCatalog(options.environment, { downloadCatalog: async () => ({ catalog }) });
    expect(loadManagedModelProviderSettings(options.environment).map((provider) => provider.model)).toEqual(["deepseek-v4-pro", "deepseek-v4-pro"]);
  });

  it("keeps sibling Profile reasoning mirrors valid when shared model settings change", async () => {
    const options = fixture();
    await applyDeepseekAccountConfiguration(input, options);
    await applyDeepseekAccountConfiguration({ accountId: "work", apiKey: "sk-work" }, options);
    writeManagedModelProviderRoleConfig(options.environment, {
      provider: "ds-personal", model: "deepseek-flash",
    });
    const rolePath = managedModelProviderRoleConfigPath(options.environment);
    writePrivateFileAtomicSync(options.paths.config, stringify({
      model: "original", agents: { external: { config_file: rolePath } },
    }));
    writeManagedModelProviderProfileDefault("ds-personal", { model: "deepseek-flash", reasoningEffort: "max" }, options.environment);
    expect(loadManagedModelProviderSettings(options.environment).map((provider) => provider.reasoningEffort)).toEqual(["max", "max"]);
    expect(parse(readFileSync(rolePath, "utf8"))).toMatchObject({
      model_provider: "ds-personal",
      model_reasoning_effort: "max",
    });
  });

  it.skipIf(process.env.RUN_CODEX_CONTRACT !== "1")("loads both isolated DS catalogs through real App Servers", async () => {
    const options = fixture();
    await applyDeepseekAccountConfiguration(input, options);
    await applyDeepseekAccountConfiguration({ accountId: "work", apiKey: "sk-work" }, options);
    for (const runtime of loadManagedProviderAppServers(options.environment)) {
      const rpc = new JsonRpcClient(new StdioTransport({
        codexBinary: process.env.CODEX_BINARY ?? "codex", cwd: options.environment.CODEX_HOME,
        environment: { ...process.env, ...options.environment, ...runtime.childEnvironment },
        createCodexProcessInvocation: (args) => ({ file: process.env.CODEX_BINARY ?? "codex", args: [...args, ...runtime.arguments] }),
      }), 15000);
      try {
        await rpc.connect();
        const result = await rpc.request<{ data: Array<{ model: string }> }>({ method: "model/list", params: { limit: 100, cursor: null, includeHidden: false } }, { retryOverload: false });
        expect(result.data.map((entry) => entry.model)).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
      } finally { await rpc.close(); }
    }
  });
});
