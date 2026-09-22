import { writeFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { initializeUserData } from "../scripts/runtime-config.mjs";
import { loadDeepseekAccounts, validateDeepseekAccounts } from "../runtime/deepseek-accounts.mjs";
import {
  loadDeepseekAccountCredential,
  loadManagedModelProviderSettings,
  loadManagedProviderAppServers,
  writeManagedModelProviderProfileDefault,
} from "../runtime/model-provider-runtime.mjs";
import { JsonRpcClient, StdioTransport } from "../src/codex-client/index.js";
import { applyDeepseekAccountConfiguration, deepseekAccountPaths, previewLegacyDeepseekRemoval, removeLegacyDeepseekAccount, removeDeepseekAccount, setDeepseekDefaultAccount } from "../scripts/deepseek-account-management.mjs";

const homes: string[] = [];
afterEach(() => { failure.path = ""; for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ds-accounts-"));
  homes.push(home);
  const environment = { CODEX_HOME: join(home, "codex"), CODEX_CONNECT_HOME: join(home, "connect") };
  const paths = deepseekAccountPaths(environment, "personal");
  initializeUserData({ environment, cwd: home });
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

async function legacyFixture(mode: "switching" | "exclusive", oldest = false) {
  const options = fixture();
  await applyDeepseekAccountConfiguration({ ...input, mode, confirmExclusiveConfigChange: true }, options);
  const source = mode === "exclusive" ? options.paths.config : options.paths.profile;
  const document = parse(readFileSync(source, "utf8"));
  const providers = document.model_providers as Record<string, unknown>;
  document.model_provider = "deepseek";
  providers.deepseek = providers["ds-personal"];
  delete providers["ds-personal"];
  const directory = join(options.environment.CODEX_CONNECT_HOME, "providers", "deepseek");
  const legacyMarker = oldest ? join(options.environment.CODEX_HOME, "codex-connect-deepseek.config.toml") : join(directory, "managed.toml");
  const legacyProfile = join(options.environment.CODEX_HOME, oldest ? "deepseek.config.toml" : "sf-deepseek.config.toml");
  writePrivateFileAtomicSync(mode === "exclusive" ? options.paths.config : legacyProfile, stringify(document));
  writePrivateFileAtomicSync(legacyMarker, `version = 1\nprovider = "deepseek"\nmode = "${mode}"\n`);
  const originalBackup = join(oldest ? join(options.environment.CODEX_HOME, "backup-codex-connect-deepseek") : join(directory, "backup"), "config.toml");
  writePrivateFileAtomicSync(originalBackup, 'model = "original"\n');
  const current = parse(readFileSync(options.paths.config, "utf8"));
  current.personal_setting = "keep";
  writePrivateFileAtomicSync(options.paths.config, stringify(current));
  rmSync(options.paths.registry); rmSync(options.paths.marker); rmSync(options.paths.backup);
  if (existsSync(options.paths.profile)) rmSync(options.paths.profile);
  return { ...options, legacyMarker, legacyProfile, originalBackup };
}

describe("DeepSeek managed accounts", () => {
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

  it.each(["switching", "exclusive"] as const)("clears the final %s account catalog and downloads it again on re-add", async (mode) => {
    const options = fixture();
    await applyDeepseekAccountConfiguration({ ...input, mode, confirmExclusiveConfigChange: true }, options);
    const backup = readFileSync(options.paths.backup);
    await removeDeepseekAccount({ accountId: input.accountId, confirmRemove: true }, options);
    expect(existsSync(options.paths.catalog)).toBe(false);
    expect(existsSync(options.paths.manifest)).toBe(false);
    expect(existsSync(options.paths.registry)).toBe(false);
    expect(readFileSync(options.paths.backup)).toEqual(backup);
    expect(parse(readFileSync(options.paths.config, "utf8"))).toEqual({ model: "original" });
    await applyDeepseekAccountConfiguration(input, options);
    expect(options.downloadCatalog).toHaveBeenCalledTimes(2);
    expect(loadDeepseekAccountCredential(options.environment, "ds-personal")).toBe("sk-personal");
  });

  it.each(["switching", "exclusive"] as const)("removes a legacy %s account only after confirmation", async (mode) => {
    const options = await legacyFixture(mode);
    const preview = await previewLegacyDeepseekRemoval(options);
    expect(preview.files).toContain(options.legacyMarker);
    const paths = [options.legacyMarker, options.legacyProfile, options.paths.catalog, options.paths.config, options.originalBackup];
    const before = paths.map((path) => existsSync(path) ? readFileSync(path) : undefined);
    await expect(removeLegacyDeepseekAccount({}, options)).rejects.toThrow("明确确认");
    expect(paths.map((path) => existsSync(path) ? readFileSync(path) : undefined)).toEqual(before);
    await removeLegacyDeepseekAccount({ confirmRemove: true }, options);
    expect(existsSync(options.legacyMarker)).toBe(false);
    expect(existsSync(options.legacyProfile)).toBe(false);
    expect(existsSync(options.paths.catalog)).toBe(false);
    expect(existsSync(options.originalBackup)).toBe(true);
    expect(parse(readFileSync(options.paths.config, "utf8"))).toEqual({ model: "original", personal_setting: "keep" });
    await applyDeepseekAccountConfiguration(input, options);
    expect(loadDeepseekAccountCredential(options.environment, "ds-personal")).toBe("sk-personal");
  });

  it("removes the oldest file layout without running a migration", async () => {
    const options = await legacyFixture("exclusive", true);
    await removeLegacyDeepseekAccount({ confirmRemove: true }, options);
    expect(existsSync(options.legacyMarker)).toBe(false);
    expect(existsSync(options.legacyProfile)).toBe(false);
    expect(existsSync(options.originalBackup)).toBe(true);
    expect(existsSync(join(options.environment.CODEX_CONNECT_HOME, "backups"))).toBe(false);
    expect(parse(readFileSync(options.paths.config, "utf8"))).toEqual({ model: "original", personal_setting: "keep" });
  });

  it("preserves existing accounts and an unrelated custom role", async () => {
    const options = fixture();
    await applyDeepseekAccountConfiguration(input, options);
    const marker = join(options.environment.CODEX_HOME, "sf-deepseek.managed.toml");
    writePrivateFileAtomicSync(marker, 'version = 1\nprovider = "deepseek"\nmode = "switching"\n');
    const role = join(options.environment.CODEX_HOME!, "fixture-agent.toml");
    writePrivateFileAtomicSync(role, 'model_provider = "custom-provider"\nmodel = "custom-model"\n');
    writePrivateFileAtomicSync(options.paths.config, stringify({ model: "original", agents: { external: { config_file: role } } }));
    const retained = [options.paths.profile, options.paths.marker, options.paths.registry, options.paths.catalog, options.paths.config, role];
    const before = retained.map((path) => readFileSync(path));
    await removeLegacyDeepseekAccount({ confirmRemove: true }, options);
    expect(existsSync(marker)).toBe(false);
    expect(retained.map((path) => readFileSync(path))).toEqual(before);
    expect(loadDeepseekAccountCredential(options.environment, "ds-personal")).toBe("sk-personal");
  });

  it("rolls back deleted files if restoring the fixed config fails", async () => {
    const options = await legacyFixture("exclusive");
    const paths = [options.legacyMarker, options.paths.catalog, options.paths.config];
    const before = paths.map((path) => readFileSync(path));
    failure.path = options.paths.config;
    await expect(removeLegacyDeepseekAccount({ confirmRemove: true }, options)).rejects.toThrow("injected");
    expect(paths.map((path) => readFileSync(path))).toEqual(before);
  });

  it("rejects missing restore backups and leased runtimes before removing files", async () => {
    const options = await legacyFixture("exclusive");
    await expect(removeLegacyDeepseekAccount({ confirmRemove: true }, {
      ...options, inspectSupervisor: async () => ({ status: "ready", topology: { version: 5, pid: 1, primaryProvider: "openai", managedProviders: ["deepseek"], socketPaths: [], runningProviders: ["deepseek"], releasedProviders: [], leasedProviders: ["deepseek"] } }),
      releaseProvider: async () => ({ released: false, reason: "leased" }),
    })).rejects.toThrow("正在被 Remote TUI 使用");
    expect(existsSync(options.legacyMarker)).toBe(true);
    rmSync(options.originalBackup);
    await expect(removeLegacyDeepseekAccount({ confirmRemove: true }, options)).rejects.toThrow("备份缺失");
    expect(existsSync(options.legacyMarker)).toBe(true);
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

  it("keeps sibling Profile reasoning mirrors valid when shared model settings change", async () => {
    const options = fixture();
    await applyDeepseekAccountConfiguration(input, options);
    await applyDeepseekAccountConfiguration({ accountId: "work", apiKey: "sk-work" }, options);
    writeFileSync(join(options.environment.CODEX_HOME!, "fixture-agent.toml"), 'model = ' + JSON.stringify("deepseek-flash") + '\nmodel_reasoning_effort = ' + JSON.stringify("high") + '\n', { mode: 0o600 });
    const rolePath = join(options.environment.CODEX_HOME!, "fixture-agent.toml");
    writePrivateFileAtomicSync(options.paths.config, stringify({
      model: "original", agents: { external: { config_file: rolePath } },
    }));
    writeManagedModelProviderProfileDefault("ds-personal", { model: "deepseek-flash", reasoningEffort: "max" }, options.environment);
    expect(loadManagedModelProviderSettings(options.environment).map((provider) => provider.reasoningEffort)).toEqual(["max", "max"]);
    expect(parse(readFileSync(rolePath, "utf8"))).toMatchObject({
      model_reasoning_effort: "high",
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
