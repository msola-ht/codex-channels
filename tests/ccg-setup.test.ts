import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it, vi } from "vitest";

const failure = vi.hoisted(() => ({ path: "", validation: false }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: Parameters<typeof actual.spawnSync>) => {
      if (failure.validation) return { status: 1 };
      return process.env.RUN_CODEX_CONTRACT === "1" ? actual.spawnSync(...args) : { status: 0 };
    },
  };
});
vi.mock("../runtime/private-file.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/private-file.mjs")>();
  return {
    ...actual,
    writePrivateFileAtomic: async (...args: Parameters<typeof actual.writePrivateFileAtomic>) => {
      if (args[0] === failure.path) throw new Error("injected write failure");
      return actual.writePrivateFileAtomic(...args);
    },
  };
});

import {
  applyCcgConfiguration, ccgSetupPaths, removeCcgConfiguration, runCcgSetup, refreshCcgCatalogForUpdate,
} from "../scripts/ccg-setup.mjs";
import { createCcgCatalog } from "../scripts/provider-model-catalog.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { commandCodeProviderDefinition } from "../runtime/model-provider-definitions.mjs";
import { JsonRpcClient, loadManagedModelOptions, StdioTransport } from "../src/codex-client/index.js";
import {
  loadManagedModelProviderSettings,
  loadManagedProviderAppServers,
  managedModelProviderRoleConfigPath,
  writeManagedModelProviderRoleConfig,
  writeManagedModelProviderProfileDefault,
} from "../runtime/model-provider-runtime.mjs";

const homes: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ccg-setup-"));
  homes.push(home);
  const environment = {
    ...process.env, CODEX_HOME: join(home, "codex"), CODEX_CONNECT_HOME: join(home, "connect"),
    ...(process.env.RUN_CODEX_CONTRACT === "1" ? {} : { CODEX_BINARY: process.execPath }),
  };
  const paths = ccgSetupPaths(environment);
  writePrivateFileAtomicSync(paths.config, 'model = "gpt-5.5"\n');
  const source = { models: ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"].map((slug) => ({
    slug, display_name: slug, context_window: 1048576, max_context_window: 1048576,
    description: "CCG contract fixture", shell_type: "shell_command", visibility: "list",
    minimal_client_version: [0, 1, 0], supported_in_api: true, priority: 0,
    support_verbosity: false, truncation_policy: { mode: "bytes", limit: 10000 },
    experimental_supported_tools: [],
    model_messages: { instructions_template: "You are a coding assistant." },
    input_modalities: ["text"], default_reasoning_level: "high",
    supported_reasoning_levels: [{ effort: "high", description: "High" }, { effort: "max", description: "Max" }],
  })) };
  const input = { apiKey: "cmd_test-key", catalog: source, model: "deepseek/deepseek-v4-flash" };
  return { environment, paths, source, input };
}

function deepseekSource(source: ReturnType<typeof fixture>["source"]) {
  return {
    models: source.models.map((entry, index) => ({
      ...entry, slug: index === 0 ? "deepseek-flash" : "deepseek-v4-pro",
    })),
  };
}

afterEach(() => {
  failure.path = "";
  failure.validation = false;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("CCG file catalog setup", () => {
  it("downloads the DS directory for setup and offers the added V4.1 model", async () => {
    const options = fixture();
    const source = deepseekSource(options.source);
    const downloadCatalog = vi.fn(async () => ({ catalog: source }));
    const model = "deepseek/deepseek-v4.1-flash";
    const select = vi.fn().mockResolvedValueOnce("switching").mockResolvedValueOnce(model);
    await expect(runCcgSetup({
      environment: options.environment, downloadCatalog, output: { write: vi.fn() },
      prompts: { select, password: async () => "cmd_test-key", isCancel: () => false },
    })).resolves.toMatchObject({ action: "configured", model });
    expect(downloadCatalog).toHaveBeenCalledOnce();
    expect(select.mock.calls[1]![0].options).toHaveLength(3);
    expect(loadManagedModelProviderSettings(options.environment)[0]).toMatchObject({ model });
  });

  it.each(["switching", "exclusive"] as const)("refreshes DS-based V4.1 capabilities while preserving %s settings", async (mode) => {
    const options = fixture();
    const source = deepseekSource(options.source);
    const model = "deepseek/deepseek-v4.1-flash";
    await applyCcgConfiguration({
      ...options.input, catalog: createCcgCatalog(source), model, mode, confirmExclusiveConfigChange: true,
    }, options);
    const beforeConfig = readFileSync(options.paths.config);
    const beforeBackup = readFileSync(options.paths.backup);
    source.models[0]!.context_window = 2_097_152;
    source.models[0]!.max_context_window = 2_097_152;
    source.models[0]!.model_messages = { instructions_template: "Updated Flash instructions" };
    await expect(refreshCcgCatalogForUpdate(options.environment, {
      downloadCatalog: async () => ({ catalog: source }),
    })).resolves.toEqual({ status: "updated", provider: "ccg" });
    const catalog = JSON.parse(readFileSync(options.paths.catalog, "utf8"));
    expect(catalog.models).toHaveLength(3);
    expect(catalog.models[2]).toMatchObject({
      slug: model, context_window: 2_097_152,
      model_messages: { instructions_template: "Updated Flash instructions" },
    });
    expect(loadManagedModelProviderSettings(options.environment)[0]).toMatchObject({ model, mode });
    expect(readFileSync(options.paths.config)).toEqual(beforeConfig);
    expect(readFileSync(options.paths.backup)).toEqual(beforeBackup);
  });

  it.each(["model", "reasoning"])("returns to the parent menu when cancelling %s selection", async (step) => {
    const options = fixture();
    await applyCcgConfiguration(options.input, options);
    const before = Object.values(options.paths).map((path) => existsSync(path) ? readFileSync(path) : undefined);
    const cancelled = Symbol("cancelled");
    const answers = step === "model"
      ? ["settings", cancelled]
      : ["settings", options.input.model, cancelled];
    const output = { write: vi.fn() };
    const select = vi.fn(async () => answers.shift());
    await expect(runCcgSetup({
      environment: options.environment, output,
      prompts: { select, isCancel: (value: unknown) => value === cancelled },
    })).resolves.toEqual({ action: "back" });
    expect(select).toHaveBeenCalledTimes(step === "model" ? 2 : 3);
    expect(output.write).not.toHaveBeenCalled();
    expect(Object.values(options.paths).map((path) => existsSync(path) ? readFileSync(path) : undefined)).toEqual(before);
  });

  it.skipIf(process.env.RUN_CODEX_CONTRACT !== "1").each(["model_messages", "shell_type", "truncation_policy"])(
    "rejects a catalog missing Codex field %s before installation", async (field) => {
      const options = fixture();
      const catalog = JSON.parse(JSON.stringify(options.source)) as { models: Array<Record<string, unknown>> };
      delete catalog.models[0]![field];
      await expect(applyCcgConfiguration({ ...options.input, catalog }, options)).rejects.toThrow("Codex CLI 校验");
      expect(existsSync(options.paths.catalog)).toBe(false);
      expect(existsSync(options.paths.backup)).toBe(false);
    },
  );

  it("does not replace configured files when Codex validation fails", async () => {
    const options = fixture();
    await applyCcgConfiguration(options.input, options);
    const before = Object.values(options.paths).map((path) => existsSync(path) ? readFileSync(path) : undefined);
    failure.validation = true;
    await expect(applyCcgConfiguration(options.input, options)).rejects.toThrow("Codex CLI 校验");
    expect(Object.values(options.paths).map((path) => existsSync(path) ? readFileSync(path) : undefined)).toEqual(before);
  });

  it("does not recreate a missing initial backup from fixed CCG configuration", async () => {
    const options = fixture();
    const input = { ...options.input, mode: "exclusive" as const, confirmExclusiveConfigChange: true };
    await applyCcgConfiguration(input, options);
    const before = readFileSync(options.paths.config);
    rmSync(options.paths.backup);
    await expect(applyCcgConfiguration(input, options)).rejects.toThrow("初始配置备份缺失");
    expect(existsSync(options.paths.backup)).toBe(false);
    expect(readFileSync(options.paths.config)).toEqual(before);
  });

  it.each(["model", "reasoning"])("rejects removing the shared role's %s from the catalog", async (removed) => {
    const options = fixture();
    await applyCcgConfiguration(options.input, options);
    writeManagedModelProviderRoleConfig(options.environment, { provider: "ccg", model: options.input.model });
    const rolePath = managedModelProviderRoleConfigPath(options.environment);
    writePrivateFileAtomicSync(options.paths.config, stringify({
      model: "gpt-5.5", agents: { external: { config_file: rolePath } },
    }));
    const before = readFileSync(options.paths.catalog);
    if (removed === "model") options.source.models.shift();
    else {
      options.source.models[0]!.default_reasoning_level = "max";
      options.source.models[0]!.supported_reasoning_levels = [{ effort: "max", description: "Max" }];
    }
    await expect(applyCcgConfiguration({ ...options.input, model: "deepseek/deepseek-v4-pro" }, options))
      .rejects.toThrow("共享第三方子代理当前的模型或思考等级");
    expect(readFileSync(options.paths.catalog)).toEqual(before);
  });

  it.skipIf(process.env.RUN_CODEX_CONTRACT !== "1")("loads the configured file through real App Server model/list", async () => {
    const options = fixture();
    await applyCcgConfiguration({
      ...options.input, catalog: createCcgCatalog(deepseekSource(options.source)),
    }, options);
    const [runtime] = loadManagedProviderAppServers(options.environment);
    if (!runtime) throw new Error("missing CCG runtime");
    let diagnostics = "";
    const rpc = new JsonRpcClient(new StdioTransport({
      codexBinary: process.env.CODEX_BINARY ?? "codex",
      cwd: options.environment.CODEX_HOME,
      environment: { ...options.environment, ...runtime.childEnvironment },
      onStderr: (text) => { diagnostics += text; },
      createCodexProcessInvocation: (args) => ({
        file: process.env.CODEX_BINARY ?? "codex",
        args: [...args, ...runtime.arguments],
      }),
    }), 15000);
    try {
      await rpc.connect();
      const result = await rpc.request<{ data: Array<{ model: string }> }>({
        method: "model/list", params: { limit: 100, cursor: null, includeHidden: false },
      }, { retryOverload: false });
      expect(result.data.map(({ model }) => model)).toEqual([
        "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "deepseek/deepseek-v4.1-flash",
      ]);
    } catch (error) {
      throw new Error(`CCG App Server contract failed: ${diagnostics}`, { cause: error });
    } finally {
      await rpc.close();
    }
  });

  it("rejects malformed catalog capabilities", async () => {
    const options = fixture();
    options.source.models[0]!.input_modalities = [];
    await expect(applyCcgConfiguration(options.input, options)).rejects.toThrow("输入能力");
  });

  it("preserves the primary config and exposes isolated CCG runtime credentials", async () => {
    const options = fixture();
    await applyCcgConfiguration(options.input, options);
    expect(readFileSync(options.paths.config, "utf8")).toBe('model = "gpt-5.5"\n');
    expect(loadManagedModelProviderSettings(options.environment)).toEqual([
      expect.objectContaining({ provider: "ccg", mode: "switching", model: "deepseek/deepseek-v4-flash" }),
    ]);
    expect(loadManagedProviderAppServers(options.environment)).toEqual([
      expect.objectContaining({
        provider: "ccg", childEnvironment: { CODEX_CONNECT_CCG_API_KEY: "cmd_test-key" },
        arguments: expect.arrayContaining(["model_providers.ccg.supports_websockets=false"]),
      }),
    ]);
    expect(readFileSync(options.paths.manifest, "utf8")).not.toContain("cmd_test-key");
    expect(loadManagedModelOptions(dirname(options.paths.catalog), true, commandCodeProviderDefinition))
      .toMatchObject([
        { provider: "ccg", model: "deepseek/deepseek-v4-flash", inputModalities: ["text"] },
        { provider: "ccg", model: "deepseek/deepseek-v4-pro", inputModalities: ["text"] },
      ]);
    expect(existsSync(join(options.environment.CODEX_HOME, "sf-agent.config.toml"))).toBe(false);
  });

  it("uses an independent file's model defaults and capabilities without DS defaults", async () => {
    const options = fixture();
    options.source.models = [{
      ...options.source.models[0]!, slug: "other/Model-1", display_name: "Independent model",
      context_window: 65536, max_context_window: 65536, input_modalities: ["text", "image"],
      default_reasoning_level: "low", supported_reasoning_levels: [{ effort: "low", description: "Low" }],
    }];
    await applyCcgConfiguration({ ...options.input, model: "other/Model-1" }, options);
    expect(JSON.parse(readFileSync(options.paths.catalog, "utf8"))).toEqual(options.source);
    expect(loadManagedModelProviderSettings(options.environment)[0]).toMatchObject({
      model: "other/Model-1", reasoningEffort: "low",
    });
    expect(commandCodeProviderDefinition.defaultModel).toBeUndefined();
    expect(commandCodeProviderDefinition.defaultReasoningEffort).toBeUndefined();
    const catalog = JSON.parse(JSON.stringify(options.source)) as { models: Array<Record<string, unknown>> };
    delete catalog.models[0]!.default_reasoning_level;
    writePrivateFileAtomicSync(options.paths.catalog, JSON.stringify(catalog));
    expect(() => loadManagedModelOptions(dirname(options.paths.catalog), true, commandCodeProviderDefinition))
      .toThrow("默认思考等级");
  });

  it("rejects catalogs larger than the runtime limit before writing files", async () => {
    const options = fixture();
    options.source.models[0]!.model_messages.instructions_template = "x".repeat(2 * 1024 * 1024);
    await expect(applyCcgConfiguration(options.input, options)).rejects.toThrow("2 MiB");
    expect(existsSync(options.paths.catalog)).toBe(false);
  });

  it("preserves model choices when refreshing the catalog and credential", async () => {
    const options = fixture();
    await applyCcgConfiguration(options.input, options);
    writeManagedModelProviderProfileDefault("ccg", {
      model: "deepseek/deepseek-v4-pro", reasoningEffort: "max",
    }, options.environment);
    await applyCcgConfiguration({ ...options.input, apiKey: "cmd_new-key", model: "deepseek/deepseek-v4-pro" }, options);
    expect(loadManagedModelProviderSettings(options.environment)[0]).toMatchObject({
      model: "deepseek/deepseek-v4-pro", reasoningEffort: "max",
    });
  });

  it("requires explicit fixed-mode confirmation and restores only Provider settings", async () => {
    const options = fixture();
    await expect(applyCcgConfiguration({ ...options.input, mode: "exclusive" }, options))
      .rejects.toThrow("确认");
    await applyCcgConfiguration({ ...options.input, mode: "exclusive", confirmExclusiveConfigChange: true }, options);
    expect(loadManagedModelProviderSettings(options.environment)[0]).toMatchObject({ mode: "exclusive" });
    writePrivateFileAtomicSync(options.paths.config, `${readFileSync(options.paths.config, "utf8")}\n`);
    await applyCcgConfiguration({ ...options.input, mode: "switching" }, options);
    expect(parse(readFileSync(options.paths.config, "utf8"))).toEqual({ model: "gpt-5.5" });
    await removeCcgConfiguration({ confirmRemove: true }, options);
    expect(loadManagedModelProviderSettings(options.environment)).toEqual([]);
    expect(existsSync(options.paths.backup)).toBe(true);
    expect(existsSync(options.paths.catalog)).toBe(false);
  });

  it("rolls back the installation when writing the marker fails", async () => {
    const options = fixture();
    failure.path = options.paths.marker;
    await expect(applyCcgConfiguration(options.input, options)).rejects.toThrow("injected");
    expect(readFileSync(options.paths.config, "utf8")).toBe('model = "gpt-5.5"\n');
    for (const key of ["profile", "catalog", "manifest", "backup"] as const) {
      expect(existsSync(options.paths[key])).toBe(false);
    }
  });

  it("rejects malformed credentials and missing models before writing files", async () => {
    const options = fixture();
    await expect(applyCcgConfiguration({ ...options.input, apiKey: "key\ninvalid" }, options)).rejects.toThrow("Key");
    await expect(applyCcgConfiguration({ ...options.input, model: "missing" }, options)).rejects.toThrow("目录中的模型");
    expect(existsSync(options.paths.profile)).toBe(false);
  });
});
