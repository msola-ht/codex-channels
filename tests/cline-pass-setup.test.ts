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
  }] }));
  const paths = clinePassSetupPaths(environment);
  writePrivateFileAtomicSync(paths.config, 'model_provider = "openai"\nmodel = "fixture-original"\n');
  return { environment, paths };
}
it("isolates switching credentials and restores exclusive configuration on removal", async () => {
  const { environment, paths } = fixture();
  const input = { apiKey: "sk_fixture-key" };
  const original = readFileSync(paths.config, "utf8");
  await applyClinePassConfiguration(input, { environment });
  expect(readFileSync(paths.config, "utf8")).toBe(original);
  expect(readFileSync(paths.profile, "utf8")).toContain('wire_api = "responses"');
  expect(JSON.parse(readFileSync(paths.catalog, "utf8"))).toMatchObject({ models: [{ input_modalities: ["text", "image"], default_reasoning_level: "high", supported_reasoning_levels: ["none", "low", "high", "max"].map(effort => ({ effort })) }] });
  expect(parse(readFileSync(paths.profile, "utf8")).model_reasoning_effort).toBe("high");
  expect(loadManagedModelProviderSettings(environment)).toContainEqual(expect.objectContaining({ provider: "cline-pass", mode: "switching" }));
  if (process.platform !== "win32") expect(statSync(paths.profile).mode & 0o777).toBe(0o600);
  await expect(applyClinePassConfiguration({ ...input, mode: "exclusive" }, { environment })).rejects.toThrow("必须确认");
  await applyClinePassConfiguration({ ...input, mode: "exclusive", confirmExclusiveConfigChange: true }, { environment });
  expect(parse(readFileSync(paths.config, "utf8")).model_provider).toBe("cline-pass");
  expect(parse(readFileSync(paths.config, "utf8"))).not.toHaveProperty("model_reasoning_effort");
  expect(existsSync(paths.profile)).toBe(false);
  await removeClinePassConfiguration({ confirmRemove: true }, { environment, resolvePrimarySocket: () => join(roots[0]!, "unused.sock"), inspectSupervisor: async () => ({ status: "missing" }) });
  expect(parse(readFileSync(paths.config, "utf8"))).toEqual(parse(original));
  expect(existsSync(paths.marker)).toBe(false);
  expect(existsSync(paths.backup)).toBe(true);
});
it("rejects invalid keys and preserves existing configuration", async () => {
  const { environment, paths } = fixture();
  const before = readFileSync(paths.config, "utf8");
  await expect(applyClinePassConfiguration({ apiKey: 'secret\ninvalid' }, { environment })).rejects.toThrow("API Key 无效");
  expect(readFileSync(paths.config, "utf8")).toBe(before);
  expect(existsSync(paths.marker)).toBe(false);
});

it("reads DS context automatically and keeps Cline reasoning on reconfiguration", async () => {
  const { environment, paths } = fixture();
  await applyClinePassConfiguration({apiKey:"sk_fixture-key"}, {environment});
  const catalog = JSON.parse(readFileSync(paths.catalog,"utf8"));
  expect(catalog.models[0]).toMatchObject({context_window:64000,max_context_window:128000});
  catalog.models[0].default_reasoning_level = "none";
  writePrivateFileAtomicSync(paths.catalog,JSON.stringify(catalog));
  writePrivateFileAtomicSync(paths.profile,readFileSync(paths.profile,"utf8").replace('model_reasoning_effort = "high"','model_reasoning_effort = "none"'));
  const source = join(environment.CODEX_CONNECT_HOME,"providers","deepseek","models.json");
  const ds = JSON.parse(readFileSync(source,"utf8")); ds.models[0].context_window=96000;
  writePrivateFileAtomicSync(source,JSON.stringify(ds));
  await applyClinePassConfiguration({apiKey:"sk_new-key"}, {environment});
  expect(JSON.parse(readFileSync(paths.catalog,"utf8")).models[0]).toMatchObject({context_window:96000,default_reasoning_level:"none"});
  expect(JSON.parse(readFileSync(paths.manifest,"utf8"))).toEqual({source:"deepseek",model:"deepseek-flash"});
});
it("configures through Setup without a manual context prompt", async () => {
  const {environment}=fixture();
  const text=vi.fn();
  await runClinePassSetup({environment,prompts:{select:vi.fn().mockResolvedValueOnce("configure").mockResolvedValueOnce("switching"),password:async()=>"sk_fixture-key",text,isCancel:()=>false},output:{write:()=>true}});
  expect(text).not.toHaveBeenCalled();
});
it("rejects a missing DS Flash template", () => {
  expect(()=>createClinePassCatalog([])).toThrow("唯一");
});

it("groups Cline with DS and updates both from one context setting", async () => {
  const {environment,paths}=fixture();
  await applyClinePassConfiguration({apiKey:"sk_fixture-key"},{environment});
  const root=join(environment.CODEX_CONNECT_HOME,"providers","deepseek");
  const definition=deepseekAccountDefinition("test");
  writePrivateFileAtomicSync(join(root,"accounts.json"),JSON.stringify([{id:"test",default:true}]));
  writePrivateFileAtomicSync(join(root,"accounts","test","managed.toml"),'version = 1\nprovider = "ds-test"\nmode = "switching"\n');
  writePrivateFileAtomicSync(join(environment.CODEX_HOME,definition.profileFileName),stringify(createManagedProviderProfile(definition,{apiKey:"sk-0123456789abcdef0123456789abcdef",catalogPath:join(root,"models.json"),model:"deepseek-flash"})));
  const windows=loadManagedModelWindow(environment);
  expect(windows).toHaveLength(1);
  expect(windows[0]).toMatchObject({model:"deepseek-flash",providers:expect.arrayContaining(["ds-test","cline-pass"])});
  writeManagedModelWindowGlobal({model:"deepseek-flash",windowPercent:75,environment});
  expect(existsSync(`${responsesContextSyncPath(environment)}.backup`)).toBe(true);
  for(const path of [join(root,"models.json"),paths.catalog]) expect(JSON.parse(readFileSync(path,"utf8")).models[0].context_window).toBe(96000);
});

it("creates a shared DS template before registering Cline and permits the first DS account", async () => {
  const {environment,paths}=fixture();
  const source=join(environment.CODEX_CONNECT_HOME,"providers","deepseek","models.json");
  const downloaded=JSON.parse(readFileSync(source,"utf8")); unlinkSync(source);
  await applyClinePassConfiguration({apiKey:"sk_fixture"},{environment,downloadCatalog:async()=>({catalog:downloaded,sha256:"fixture"})});
  expect(existsSync(source)).toBe(true);
  writeManagedModelWindowGlobal({model:"deepseek-flash",windowPercent:75,environment});
  expect(JSON.parse(readFileSync(source,"utf8")).models[0].context_window).toBe(96000);
  expect(JSON.parse(readFileSync(paths.catalog,"utf8")).models[0].context_window).toBe(96000);
  expect(previewDeepseekAccountConfiguration({accountId:"first"},{environment}).effects.downloadsCatalog).toBe(false);
  await applyDeepseekAccountConfiguration({accountId:"first",apiKey:"sk-fixture"},{environment});
  expect(loadManagedModelProviderSettings(environment).find(item=>item.provider === "ds-first")?.models[0]?.contextWindow).toBe(96000);
});
