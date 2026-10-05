import { normalizeDeepseekCatalogCapabilities } from "../scripts/deepseek-setup.mjs";
import { finishResponsesModelCatalogWrite, readResponsesModelCatalog, writeResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
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
import { applyDeepseekAccountConfiguration, deepseekAccountPaths, removeDeepseekAccount, setDeepseekDefaultAccount } from "../scripts/deepseek-account-management.mjs";
import { loadConfiguredRelayProviderMaterial } from "../runtime/model-provider-runtime.mjs";

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

it("exposes both native Relay protocols from existing DS credentials and rejects missing accounts", async () => {
  const options = fixture();
  await applyDeepseekAccountConfiguration(input, options);
  const material = loadConfiguredRelayProviderMaterial("ds-personal", options.environment);
  expect(material).toMatchObject({ provider: "ds-personal", apiKey: "sk-personal", protocols: ["chat", "responses"], models: ["deepseek-flash", "deepseek-v4-pro"] });
  expect(material.paths).toContain(options.paths.profile);
  expect(() => loadConfiguredRelayProviderMaterial("ds-missing", options.environment)).toThrow();
});

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
    expect(JSON.parse(readFileSync(options.paths.catalog, "utf8"))).toEqual(normalizeDeepseekCatalogCapabilities(options.catalog));
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

  it("narrows existing DS capabilities transactionally without resetting model settings", async () => {
    const options = fixture();
    await applyDeepseekAccountConfiguration(input, options);
    const catalog = JSON.parse(readFileSync(options.paths.catalog, "utf8"));
    for (const model of catalog.models) Object.assign(model, {
      support_verbosity: true, default_verbosity: "low", supports_reasoning_summaries: true,
      supports_reasoning_summary_parameter: true, default_reasoning_summary: "detailed",
      supports_search_tool: true, effective_context_window_percent: 73,
    });
    const original = JSON.stringify(catalog);
    writePrivateFileAtomicSync(options.paths.catalog, original);
    const profile = readFileSync(options.paths.profile, "utf8");
    failure.path = options.paths.marker;
    await expect(applyDeepseekAccountConfiguration({ ...input, reconfigure: true }, options)).rejects.toThrow("injected");
    expect(readFileSync(options.paths.catalog, "utf8")).toBe(original);
    expect(readFileSync(options.paths.profile, "utf8")).toBe(profile);
    failure.path = "";
    await applyDeepseekAccountConfiguration({ ...input, reconfigure: true }, options);
    const updated = JSON.parse(readFileSync(options.paths.catalog, "utf8"));
    expect(updated.models).toEqual(catalog.models.map((model: Record<string, unknown>) => {
      const result = { ...model, support_verbosity: false, default_verbosity: null,
        supports_reasoning_summary_parameter: false, default_reasoning_summary: "none" };
      delete (result as Record<string, unknown>).supports_reasoning_summaries;
      return result;
    }));
    expect(readFileSync(options.paths.profile, "utf8")).toBe(profile);
    expect(options.downloadCatalog).toHaveBeenCalledTimes(1);
  });

  it("requires detaching RS followers before removing the final DS account",async()=>{
    const options=fixture();
    await applyDeepseekAccountConfiguration(input,options);
    const model={id:"platform/flash",name:"Mapped",contextWindow:1048576,maxContextWindow:1048576,reasoningEfforts:[],defaultReasoningEffort:null,supportsImages:false,template:{source:"deepseek" as const,model:"deepseek-flash",followContext:true}};
    finishResponsesModelCatalogWrite(writeResponsesModelCatalog(options.environment,"rs-linked",[model],model.id));
    await expect(removeDeepseekAccount({accountId:input.accountId,confirmRemove:true},options)).rejects.toThrow("关闭关联 RS 模型");
    expect(existsSync(options.paths.catalog)).toBe(true);
    expect(loadDeepseekAccounts(options.environment)).toHaveLength(1);
    const catalog=readResponsesModelCatalog(options.environment,"rs-linked");
    finishResponsesModelCatalogWrite(writeResponsesModelCatalog(options.environment,"rs-linked",[{...model,template:{...model.template,followContext:false}}],model.id,catalog.revision));
    await removeDeepseekAccount({accountId:input.accountId,confirmRemove:true},options);
    await applyDeepseekAccountConfiguration(input,options);
    expect(loadDeepseekAccounts(options.environment)).toHaveLength(1);
    expect(readResponsesModelCatalog(options.environment,"rs-linked").definitions[0]?.template?.followContext).toBe(false);
  });
  it("does not rebuild a missing DS source while RS followers reference it",async()=>{
    const options=fixture();
    const model={id:"platform/flash",name:"Mapped",contextWindow:524288,reasoningEfforts:[],defaultReasoningEffort:null,supportsImages:false,template:{source:"deepseek" as const,model:"deepseek-flash",followContext:true}};
    finishResponsesModelCatalogWrite(writeResponsesModelCatalog(options.environment,"rs-linked",[model],model.id));
    await expect(applyDeepseekAccountConfiguration(input,options)).rejects.toThrow("重建 DS 目录前");
    expect(options.downloadCatalog).not.toHaveBeenCalled();
    expect(existsSync(options.paths.catalog)).toBe(false);
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
