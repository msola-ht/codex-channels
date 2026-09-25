import { previewDeepseekAccountConfiguration, applyDeepseekAccountConfiguration } from "../scripts/deepseek-account-management.mjs";
import { responsesContextSyncPath } from "../runtime/model-provider-responses-catalog.mjs";
import { createManagedProviderProfile } from "../runtime/model-provider-profile.mjs";
import { deepseekAccountDefinition } from "../runtime/model-provider-definitions.mjs";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parse, stringify } from "smol-toml";
import { applyClinePassConfiguration, clinePassSetupPaths, removeClinePassConfiguration, createClinePassCatalog, runClinePassSetup } from "../scripts/cline-pass-setup.mjs";
import { loadManagedModelProviderSettings, loadManagedModelWindow, writeManagedModelWindowGlobal } from "../runtime/model-provider-runtime.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
vi.mock("../scripts/model-catalog-validation.mjs", () => ({ validateModelCatalogWithCodex: async () => undefined }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cline-setup-")); roots.push(root);
  const environment = { CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect") };
  writePrivateFileAtomicSync(join(environment.CODEX_CONNECT_HOME, "providers", "deepseek", "models.json"), JSON.stringify({ models: [{
    slug: "deepseek-flash", display_name: "DeepSeek Flash", visibility: "list", supported_in_api: true,
    context_window: 64000, max_context_window: 128000, input_modalities: ["text", "image"],
    default_reasoning_level: "high", supported_reasoning_levels: ["low", "high", "max"].map(effort => ({ effort, description: effort })),
    model_messages: { instructions_template: "DS fixture prompt" },
  }] }));
  const paths = clinePassSetupPaths(environment, "test");
  writePrivateFileAtomicSync(paths.config, 'model_provider = "openai"\nmodel = "fixture-original"\n');
  return { environment, paths };
}
it("isolates switching credentials and restores exclusive configuration on removal", async () => {
  const { environment, paths } = fixture();
  const input = { accountId: "test", apiKey: "sk_fixture-key" };
  const original = readFileSync(paths.config, "utf8");
  await applyClinePassConfiguration(input, { environment });
  expect(readFileSync(paths.config, "utf8")).toBe(original);
  expect(readFileSync(paths.profile, "utf8")).toContain('wire_api = "responses"');
  expect(JSON.parse(readFileSync(paths.catalog, "utf8"))).toMatchObject({ models: [{ input_modalities: ["text", "image"], default_reasoning_level: "high", apply_patch_tool_type: "freeform", supports_search_tool: true, model_messages: { instructions_template: "DS fixture prompt" }, supported_reasoning_levels: ["none", "low", "high", "max"].map(effort => ({ effort })) }] });
  expect(parse(readFileSync(paths.profile, "utf8")).model_reasoning_effort).toBe("high");
  expect(loadManagedModelProviderSettings(environment)).toContainEqual(expect.objectContaining({ provider: "clp-test", mode: "switching" }));
  if (process.platform !== "win32") expect(statSync(paths.profile).mode & 0o777).toBe(0o600);
  await expect(applyClinePassConfiguration({ ...input, reconfigure: true, mode: "exclusive" }, { environment })).rejects.toThrow("必须确认");
  await applyClinePassConfiguration({ ...input, reconfigure: true, mode: "exclusive", confirmExclusiveConfigChange: true }, { environment });
  expect(parse(readFileSync(paths.config, "utf8")).model_provider).toBe("clp-test");
  expect(parse(readFileSync(paths.config, "utf8"))).not.toHaveProperty("model_reasoning_effort");
  expect(existsSync(paths.profile)).toBe(false);
  await removeClinePassConfiguration({accountId:"test", confirmRemove: true }, { environment, resolvePrimarySocket: () => join(roots[0]!, "unused.sock"), inspectSupervisor: async () => ({ status: "missing" }) });
  expect(parse(readFileSync(paths.config, "utf8"))).toEqual(parse(original));
  expect(existsSync(paths.marker)).toBe(false);
  expect(existsSync(paths.backup)).toBe(true);
});
it("rejects invalid keys and preserves existing configuration", async () => {
  const { environment, paths } = fixture();
  const before = readFileSync(paths.config, "utf8");
  await expect(applyClinePassConfiguration({accountId:"test", apiKey: 'secret\ninvalid' }, { environment })).rejects.toThrow("API Key 无效");
  expect(readFileSync(paths.config, "utf8")).toBe(before);
  expect(existsSync(paths.marker)).toBe(false);
});

it("reads DS context automatically and preserves the shared catalog on credential updates", async () => {
  const { environment, paths } = fixture();
  await applyClinePassConfiguration({accountId:"test",apiKey:"sk_fixture-key"}, {environment});
  const catalog = JSON.parse(readFileSync(paths.catalog,"utf8"));
  expect(catalog.models[0]).toMatchObject({context_window:64000,max_context_window:128000});
  catalog.models[0].default_reasoning_level = "none";
  writePrivateFileAtomicSync(paths.catalog,JSON.stringify(catalog));
  writePrivateFileAtomicSync(paths.profile,readFileSync(paths.profile,"utf8").replace('model_reasoning_effort = "high"','model_reasoning_effort = "none"'));
  const source = join(environment.CODEX_CONNECT_HOME,"providers","deepseek","models.json");
  const ds = JSON.parse(readFileSync(source,"utf8")); ds.models[0].context_window=96000;
  writePrivateFileAtomicSync(source,JSON.stringify(ds));
  await applyClinePassConfiguration({accountId:"test",apiKey:"sk_new-key",reconfigure:true}, {environment});
  expect(JSON.parse(readFileSync(paths.catalog,"utf8")).models[0]).toMatchObject({context_window:64000,default_reasoning_level:"none"});
  expect(JSON.parse(readFileSync(paths.manifest,"utf8"))).toEqual({source:"deepseek",model:"deepseek-flash"});
});
it("configures through Setup without a manual context prompt", async () => {
  const {environment}=fixture();
  const text=vi.fn().mockResolvedValue("test");
  await runClinePassSetup({environment,prompts:{select:vi.fn().mockResolvedValueOnce("configure").mockResolvedValueOnce("custom").mockResolvedValueOnce("switching"),password:async()=>"sk_fixture-key",text,isCancel:()=>false},output:{write:()=>true}});
  expect(text).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({message:"账户 ID"}));
});
it("rejects a missing DS Flash template", () => {
  expect(()=>createClinePassCatalog([])).toThrow("唯一");
});

it("groups Cline with DS and updates both from one context setting", async () => {
  const {environment,paths}=fixture();
  await applyClinePassConfiguration({accountId:"test",apiKey:"sk_fixture-key"},{environment});
  const root=join(environment.CODEX_CONNECT_HOME,"providers","deepseek");
  const definition=deepseekAccountDefinition("test");
  writePrivateFileAtomicSync(join(root,"accounts.json"),JSON.stringify([{id:"test",default:true}]));
  writePrivateFileAtomicSync(join(root,"accounts","test","managed.toml"),'version = 1\nprovider = "ds-test"\nmode = "switching"\n');
  writePrivateFileAtomicSync(join(environment.CODEX_HOME,definition.profileFileName),stringify(createManagedProviderProfile(definition,{apiKey:"sk-0123456789abcdef0123456789abcdef",catalogPath:join(root,"models.json"),model:"deepseek-flash"})));
  const windows=loadManagedModelWindow(environment);
  expect(windows).toHaveLength(1);
  expect(windows[0]).toMatchObject({model:"deepseek-flash",providers:expect.arrayContaining(["ds-test","clp-test"])});
  writeManagedModelWindowGlobal({model:"deepseek-flash",windowPercent:75,environment});
  expect(existsSync(`${responsesContextSyncPath(environment)}.backup`)).toBe(true);
  for(const path of [join(root,"models.json"),paths.catalog]) expect(JSON.parse(readFileSync(path,"utf8")).models[0].context_window).toBe(96000);
});

it("creates a shared DS template before registering Cline and permits the first DS account", async () => {
  const {environment,paths}=fixture();
  const source=join(environment.CODEX_CONNECT_HOME,"providers","deepseek","models.json");
  const downloaded=JSON.parse(readFileSync(source,"utf8")); unlinkSync(source);
  await applyClinePassConfiguration({accountId:"test",apiKey:"sk_fixture"},{environment,downloadCatalog:async()=>({catalog:downloaded,sha256:"fixture"})});
  expect(existsSync(source)).toBe(true);
  writeManagedModelWindowGlobal({model:"deepseek-flash",windowPercent:75,environment});
  expect(JSON.parse(readFileSync(source,"utf8")).models[0].context_window).toBe(96000);
  expect(JSON.parse(readFileSync(paths.catalog,"utf8")).models[0].context_window).toBe(96000);
  expect(previewDeepseekAccountConfiguration({accountId:"first"},{environment}).effects.downloadsCatalog).toBe(false);
  await applyDeepseekAccountConfiguration({accountId:"first",apiKey:"sk-fixture"},{environment});
  expect(loadManagedModelProviderSettings(environment).find(item=>item.provider === "ds-first")?.models[0]?.contextWindow).toBe(96000);
});

it("isolates accounts, preserves shared settings, and removes only the selected account", async () => {
  const { environment, paths } = fixture();
  await applyClinePassConfiguration({ accountId: "test", apiKey: "sk_first" }, { environment });
  const second = clinePassSetupPaths(environment, "work");
  writeManagedModelWindowGlobal({ model: "deepseek-flash", windowPercent: 75, environment });
  const catalog = readFileSync(paths.catalog, "utf8");
  const firstProfile = readFileSync(paths.profile, "utf8");
  await applyClinePassConfiguration({ accountId: "work", apiKey: "sk_second" }, { environment });
  expect(second.catalog).toBe(paths.catalog);
  expect(readFileSync(paths.catalog, "utf8")).toBe(catalog);
  expect(readFileSync(paths.profile, "utf8")).toBe(firstProfile);
  expect(readFileSync(second.profile, "utf8")).toContain("sk_second");
  expect(readFileSync(second.profile, "utf8")).not.toContain("sk_first");
  expect(loadManagedModelWindow(environment)[0]?.providers).toEqual(["clp-test", "clp-work"]);
  const { setClinePassDefaultAccount } = await import("../scripts/cline-pass-setup.mjs");
  const { resolveDefaultManagedProvider, sharedProviderProxyKey, managedProviderAccountIdFromProvider } = await import("../runtime/managed-provider-account-routing.mjs");
  expect(sharedProviderProxyKey("clp-work")).toBe("clp");
  expect(managedProviderAccountIdFromProvider("clp-work")).toBe("work");
  const options = { environment, resolvePrimarySocket: () => join(roots[0]!, "unused.sock"), inspectSupervisor: async () => ({ status: "missing" as const }) };
  await expect(removeClinePassConfiguration({ accountId: "test", confirmRemove: true }, options)).rejects.toThrow("其他默认账户");
  await setClinePassDefaultAccount("work", { environment });
  expect(resolveDefaultManagedProvider(["clp-test", "clp-work"], environment)).toBe("clp-work");
  await removeClinePassConfiguration({ accountId: "test", confirmRemove: true }, options);
  expect(existsSync(paths.profile)).toBe(false);
  expect(existsSync(paths.catalog)).toBe(true);
  expect(readFileSync(second.profile, "utf8")).toContain("sk_second");
  await removeClinePassConfiguration({ accountId: "work", confirmRemove: true }, options);
  expect(existsSync(paths.catalog)).toBe(false);
  expect(existsSync(paths.registry)).toBe(false);
});

it("rejects account and credential-name collisions before changing files", async () => {
  const { environment, paths } = fixture();
  await applyClinePassConfiguration({ accountId: "a-b", apiKey: "sk_first" }, { environment });
  const before = readFileSync(paths.registry, "utf8");
  await expect(applyClinePassConfiguration({ accountId: "a_b", apiKey: "sk_second" }, { environment })).rejects.toThrow("重复");
  await expect(applyClinePassConfiguration({ accountId: "a-b", apiKey: "sk_second" }, { environment })).rejects.toThrow("已存在");
  await expect(applyClinePassConfiguration({ accountId: "../bad", apiKey: "sk_second" }, { environment })).rejects.toThrow("账户 ID");
  expect(readFileSync(paths.registry, "utf8")).toBe(before);
});

it("rejects old single-account files without modifying or adopting them", async () => {
  const { environment, paths } = fixture();
  const legacy = join(environment.CODEX_HOME, "sf-cline-pass.config.toml");
  writePrivateFileAtomicSync(legacy, "private fixture");
  await expect(applyClinePassConfiguration({ accountId: "test", apiKey: "sk_new" }, { environment })).rejects.toThrow("单账户配置不受支持");
  expect(readFileSync(legacy, "utf8")).toBe("private fixture");
  expect(existsSync(paths.registry)).toBe(false);
});
