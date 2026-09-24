import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";

import { createResponsesModelCatalog, readResponsesModelCatalog, responsesProviderCatalogPath, responsesProviderBackupPath, validateResponsesModels, writeResponsesModelCatalog, finishResponsesModelCatalogWrite } from "../runtime/model-provider-responses-catalog.mjs";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { applyCustomPrimaryProviderSave, prepareCustomPrimaryProviderSave } from "../scripts/custom-primary-provider-management.mjs";
import { applyPrimaryProviderRemoval, applyPrimaryProviderSwitch } from "../scripts/primary-provider-management.mjs";
import { recoverResponsesProviderCatalog } from "../scripts/responses-provider-recovery.mjs";
// @ts-expect-error JavaScript presentation boundary intentionally has no declaration file.
import { normalizeProviderSettingsMutation, projectProviderSettings } from "../scripts/webui-provider-settings-management.mjs";
import { loadModelProviderManagementState } from "../scripts/model-provider-management.mjs";
import { customPrimaryProviderProfilePath, customSwitchingProviderRegistryPath, loadConfiguredCustomPrimaryModelProvider, loadConfiguredCustomSwitchingModelProviders } from "../runtime/model-provider-runtime.mjs";
import type { CodexUserConfigValue } from "../scripts/codex-user-config.mjs";

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
const model = { id: "vendor/model", name: "Vendor model", contextWindow: 64000, reasoningEfforts: [], defaultReasoningEffort: null, supportsImages: false };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "responses-provider-")); roots.push(root);
  const environment = { CODEX_HOME: join(root, "codex"), CODEX_CONNECT_HOME: join(root, "connect") };
  const configPath = join(environment.CODEX_HOME, "config.toml");
  writePrivateFileAtomicSync(configPath, 'model_provider = "openai"\n');
  const client = {
    connect: async () => {}, close: async () => {}, listModels: async () => [],
    readUserConfigSnapshot: async () => ({config: parse(readFileSync(configPath, "utf8")) as Record<string, CodexUserConfigValue>, version: readFileSync(configPath, "utf8")}),
    writeUserConfigEdits: async (edits: Array<{keyPath: string; value: unknown}>) => {
      const config = parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      for (const edit of edits) {
        const keys = edit.keyPath.split("."); let object = config;
        for (const key of keys.slice(0, -1)) { object[key] ??= {}; object = object[key] as Record<string, unknown>; }
        if (edit.value === null) delete object[keys.at(-1)!]; else object[keys.at(-1)!] = edit.value;
      }
      writePrivateFileAtomicSync(configPath, stringify(config));
    },
  };
  const options = { environment, createClient: async () => client };
  const input = { operation: "create" as const, providerId: "rs-demo", name: "Demo", baseUrl: "https://example.test/v1", mode: "switching" as const, model: model.id, supportsWebsockets: false, catalog: {kind:"custom" as const, models:[model]}, credential: {action:"replace" as const, apiKey:"fixture-key"} };
  return { options, input, client, configPath };
}

describe("Responses provider catalog and lifecycle", () => {
  it("accepts only the rs prefix and enforces the 64-character Provider ID limit", () => {
    const {options}=fixture();
    expect(responsesProviderCatalogPath(options.environment,`rs-${"a".repeat(61)}`)).toContain("models.json");
    for(const id of ["responses-demo","rs-",`rs-${"a".repeat(62)}`]) {
      expect(()=>responsesProviderCatalogPath(options.environment,id)).toThrow("rs- 加 1-61");
    }
  });

  it("rejects unsupported catalog versions and invalid template links", () => {
    const {options,input}=fixture();
    const catalog=createResponsesModelCatalog([model],model.id);
    expect(catalog.schemaVersion).toBe(2);
    writePrivateFileAtomicSync(responsesProviderCatalogPath(options.environment,input.providerId),JSON.stringify({...catalog,schemaVersion:1}));
    expect(()=>readResponsesModelCatalog(options.environment,input.providerId)).toThrow("版本");
    expect(()=>validateResponsesModels([{...model,template:{source:"official",model:"source",followContext:true}}],model.id)).toThrow("模板关联");
  });

  it("generates explicit metadata without copying official model capabilities", () => {
    const catalog = createResponsesModelCatalog([model], model.id);
    expect(catalog.models[0]).toMatchObject({ slug: model.id, context_window: 64000, input_modalities: ["text"], default_reasoning_level: null, supports_reasoning_summary_parameter: false, model_messages: {instructions_template: expect.any(String)} });
    expect(catalog.models[0]).toHaveProperty("upgrade", null);
  });
  it.each([
    [{...model, contextWindow: 1}], [{...model, reasoningEfforts:["invented"]}],
    [{...model, reasoningEfforts:["high"], defaultReasoningEffort:"low"}],
    [{...model, supportsImages: "yes"}], [{...model, apiKey:"secret"}], [model,model],
  ].map(models => ({models})))("rejects invalid model metadata", ({models}) => { expect(() => validateResponsesModels(models, model.id)).toThrow(); });
  it("creates, edits and removes an isolated switching provider", async () => {
    const {options,input} = fixture();
    await applyCustomPrimaryProviderSave(input, options);
    expect(readFileSync(responsesProviderCatalogPath(options.environment,input.providerId), "utf8")).not.toContain("fixture-key");
    expect(loadConfiguredCustomSwitchingModelProviders(options.environment)[0]).toMatchObject({id:input.providerId, model:model.id, reasoningEffort:"none", catalogSource:{kind:"custom"}});
    await applyCustomPrimaryProviderSave({...input, operation:"update", catalog:{kind:"custom",models:[{...model, supportsImages:true}]}},options);
    expect(readResponsesModelCatalog(options.environment,input.providerId).definitions[0]?.supportsImages).toBe(true);
    await applyPrimaryProviderRemoval({providerId:input.providerId},options);
    expect(loadConfiguredCustomSwitchingModelProviders(options.environment)).toEqual([]);
    expect(existsSync(responsesProviderCatalogPath(options.environment,input.providerId))).toBe(false);
  });
  it("converts switching to fixed, backs up on official restore and reactivates its own model", async () => {
    const {options,input,configPath} = fixture();
    await applyCustomPrimaryProviderSave(input, options);
    await applyPrimaryProviderSwitch({providerId:input.providerId}, options);
    expect(loadConfiguredCustomPrimaryModelProvider(options.environment)).toMatchObject({id:input.providerId,catalogPath:responsesProviderCatalogPath(options.environment,input.providerId)});
    await applyPrimaryProviderSwitch({providerId:"openai"},options);
    expect(parse(readFileSync(configPath,"utf8"))).not.toHaveProperty("model_catalog_json");
    await applyPrimaryProviderSwitch({providerId:input.providerId},options);
    expect(parse(readFileSync(configPath,"utf8"))).toMatchObject({model:model.id,model_provider:input.providerId});
    await applyPrimaryProviderRemoval({providerId:input.providerId},options);
    expect(parse(readFileSync(configPath,"utf8"))).not.toHaveProperty("model_catalog_json");
  });
  it("rejects stale catalog previews", async () => {
    const {options,input} = fixture(); await applyCustomPrimaryProviderSave(input,options);
    const prepared = await prepareCustomPrimaryProviderSave({...input, operation:"update"},options);
    await applyCustomPrimaryProviderSave({...input,operation:"update",catalog:{kind:"custom",models:[{...model,contextWindow:128000}]}},options);
    await expect(prepared.apply()).rejects.toThrow("模型目录已变化");
  });
  it("fails closed on missing, corrupt and unfinished catalogs", async () => {
    const {options,input}=fixture();await applyCustomPrimaryProviderSave(input,options);
    const path=responsesProviderCatalogPath(options.environment,input.providerId);
    const existing=readResponsesModelCatalog(options.environment,input.providerId);
    const transaction=writeResponsesModelCatalog(options.environment,input.providerId,[model],model.id,existing.revision);
    expect(()=>loadConfiguredCustomSwitchingModelProviders(options.environment)).toThrow("上次保存未完成");
    finishResponsesModelCatalogWrite(transaction,true);
    writePrivateFileAtomicSync(path,'{"schemaVersion":99}');
    expect(()=>loadConfiguredCustomSwitchingModelProviders(options.environment)).toThrow("版本");
    rmSync(path);
    expect(()=>loadConfiguredCustomSwitchingModelProviders(options.environment)).toThrow("目录缺失");
  });
  it("restores the previous catalog after a known configuration failure", async () => {
    const {options,input,client}=fixture(); await applyCustomPrimaryProviderSave(input,options);
    const original=readResponsesModelCatalog(options.environment,input.providerId);
    client.writeUserConfigEdits=async()=>{throw new Error("write failed");};
    await expect(applyCustomPrimaryProviderSave({...input,operation:"update",mode:"exclusive",catalog:{kind:"custom",models:[{...model,contextWindow:128000}]}},options)).rejects.toThrow();
    expect(readResponsesModelCatalog(options.environment,input.providerId).revision).toBe(original.revision);
    expect(loadConfiguredCustomSwitchingModelProviders(options.environment)).toHaveLength(1);
  });
  it("preserves pending state on unknown writes and explicitly recovers a matching committed config", async () => {
    const {options,input,client}=fixture(); await applyCustomPrimaryProviderSave(input,options);
    const write=client.writeUserConfigEdits;
    client.writeUserConfigEdits=async edits=>{
      await write(edits);
      client.readUserConfigSnapshot=async()=>{throw new Error("read result unavailable");};
      throw new Error("write response lost");
    };
    await expect(applyCustomPrimaryProviderSave({...input,operation:"update",mode:"exclusive"},options)).rejects.toThrow("结果无法确认");
    expect(()=>loadConfiguredCustomPrimaryModelProvider(options.environment)).toThrow("上次保存未完成");
    await recoverResponsesProviderCatalog(input.providerId,"keep",options.environment);
    expect(loadConfiguredCustomPrimaryModelProvider(options.environment)?.id).toBe(input.providerId);
  });
  it("recovers an interrupted catalog edit and refuses a conflicting rollback", async () => {
    const {options,input}=fixture();await applyCustomPrimaryProviderSave(input,options);
    const old=readResponsesModelCatalog(options.environment,input.providerId);
    writeResponsesModelCatalog(options.environment,input.providerId,[{...model,contextWindow:128000}],model.id,old.revision);
    await recoverResponsesProviderCatalog(input.providerId,"rollback",options.environment);
    expect(readResponsesModelCatalog(options.environment,input.providerId).revision).toBe(old.revision);
  });
  it("retains custom model definitions through the WebUI mutation and resource boundary", async () => {
    const {options,input}=fixture();
    expect(normalizeProviderSettingsMutation({operation:"primary.custom.save",provider:input})).toHaveProperty("provider.catalog",input.catalog);
    await applyCustomPrimaryProviderSave(input,options);
    const state=await loadModelProviderManagementState({...options,readUserConfig:async()=>({config:{model_provider:"openai"}})});
    const resource=projectProviderSettings(state);
    expect(resource.customProviders.switchingProviders[0]).toMatchObject({catalog:"custom",models:[model],supportsWebsockets:false});
    expect(JSON.stringify(resource)).not.toContain("fixture-key");
  });
  it("restores the old Profile when changing the model and fixed config fails", async () => {
    const {options,input,client}=fixture();await applyCustomPrimaryProviderSave(input,options);
    client.writeUserConfigEdits=async()=>{throw new Error("write failed");};
    await expect(applyCustomPrimaryProviderSave({...input,operation:"update",mode:"exclusive",model:"vendor/other",catalog:{kind:"custom",models:[{...model,id:"vendor/other"}]}},options)).rejects.toThrow();
    expect(loadConfiguredCustomSwitchingModelProviders(options.environment)[0]?.model).toBe(model.id);
  });

  it.each(["registry", "profile"])("preserves pending recovery until the missing %s is restored", async (missing) => {
    const {options,input}=fixture();
    await applyCustomPrimaryProviderSave(input,options);
    const old=readResponsesModelCatalog(options.environment,input.providerId);
    writeResponsesModelCatalog(options.environment,input.providerId,[model],model.id,old.revision);
    const missingPath=missing === "registry"
      ? customSwitchingProviderRegistryPath(options.environment)
      : customPrimaryProviderProfilePath(options.environment,input.providerId);
    const original=readFileSync(missingPath,"utf8");
    rmSync(missingPath);
    await expect(recoverResponsesProviderCatalog(input.providerId,"keep",options.environment)).rejects.toThrow("Profile 与注册表不一致");
    expect(existsSync(`${old.path}.pending`)).toBe(true);
    writePrivateFileAtomicSync(missingPath,original);
    await recoverResponsesProviderCatalog(input.providerId,"keep",options.environment);
    expect(loadConfiguredCustomSwitchingModelProviders(options.environment)[0]?.id).toBe(input.providerId);
    expect(existsSync(`${old.path}.pending`)).toBe(false);
  });

  it("recovers providers independently when two catalogs are pending", async () => {
    const {options,input}=fixture();
    const ids=[input.providerId,"rs-other"];
    for(const providerId of ids) await applyCustomPrimaryProviderSave({...input,providerId},options);
    for(const providerId of ids) {
      const old=readResponsesModelCatalog(options.environment,providerId);
      writeResponsesModelCatalog(options.environment,providerId,[model],model.id,old.revision);
    }
    await recoverResponsesProviderCatalog(ids[0]!,"keep",options.environment);
    expect(()=>loadConfiguredCustomSwitchingModelProviders(options.environment)).toThrow("上次保存未完成");
    await recoverResponsesProviderCatalog(ids[1]!,"keep",options.environment);
    expect(loadConfiguredCustomSwitchingModelProviders(options.environment)).toHaveLength(2);
  });

  it("rolls back a first creation with no main config and refuses orphan keep", async () => {
    const {options,input,configPath}=fixture();
    rmSync(configPath);
    const transaction=writeResponsesModelCatalog(options.environment,input.providerId,[model],model.id);
    await expect(recoverResponsesProviderCatalog(input.providerId,"keep",options.environment)).rejects.toThrow("没有连接配置");
    await recoverResponsesProviderCatalog(input.providerId,"rollback",options.environment);
    expect(existsSync(transaction.path)).toBe(false);
    expect(existsSync(`${transaction.path}.pending`)).toBe(false);
    expect(existsSync(configPath)).toBe(false);
  });

  it.each(["malformed", "permissions"])("does not treat %s main config as absent during recovery", async (failure) => {
    const {options,input,configPath}=fixture();
    const transaction=writeResponsesModelCatalog(options.environment,input.providerId,[model],model.id);
    if(failure === "malformed") writePrivateFileAtomicSync(configPath,'model_provider = "fixture-secret');
    else chmodSync(configPath,0o644);
    await expect(recoverResponsesProviderCatalog(input.providerId,"rollback",options.environment)).rejects.toThrow();
    expect(existsSync(`${transaction.path}.pending`)).toBe(true);
    expect(existsSync(transaction.path)).toBe(true);
  });

  it("validates the runtime profile before completing recovery", async () => {
    const {options,input}=fixture();
    await applyCustomPrimaryProviderSave(input,options);
    const old=readResponsesModelCatalog(options.environment,input.providerId);
    writeResponsesModelCatalog(options.environment,input.providerId,[model],model.id,old.revision);
    const profilePath=customPrimaryProviderProfilePath(options.environment,input.providerId);
    const profile=parse(readFileSync(profilePath,"utf8"));
    profile.web_search="enabled";
    writePrivateFileAtomicSync(profilePath,stringify(profile));
    await expect(recoverResponsesProviderCatalog(input.providerId,"keep",options.environment)).rejects.toThrow("不受支持的配置");
    expect(existsSync(`${old.path}.pending`)).toBe(true);
  });

  it("preserves a switching Profile's selected model in the editing resource", async () => {
    const {options,input,client}=fixture();
    await applyCustomPrimaryProviderSave({...input,catalog:{kind:"custom",models:[model,{...model,id:"vendor/second"}]}},options);
    const path=customPrimaryProviderProfilePath(options.environment,input.providerId);
    const profile=parse(readFileSync(path,"utf8"));
    profile.model="vendor/second";
    writePrivateFileAtomicSync(path,stringify(profile));
    const state=await loadModelProviderManagementState({...options,readUserConfig:client.readUserConfigSnapshot});
    expect(projectProviderSettings(state).customProviders.switchingProviders[0].model).toBe("vendor/second");
  });

  it("does not delete a catalog still referenced by a fixed candidate", async () => {
    const {options,input}=fixture();
    await applyCustomPrimaryProviderSave({...input,mode:"exclusive"},options);
    const path=responsesProviderCatalogPath(options.environment,input.providerId);
    writePrivateFileAtomicSync(`${path}.pending`,JSON.stringify({schemaVersion:1,previous:false}));
    await expect(recoverResponsesProviderCatalog(input.providerId,"rollback",options.environment)).rejects.toThrow("配置仍引用");
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.pending`)).toBe(true);
  });

  it("rejects malformed recovery records without clearing them", async () => {
    const {options,input}=fixture();
    const path=responsesProviderCatalogPath(options.environment,input.providerId);
    writePrivateFileAtomicSync(`${path}.pending`,"null");
    await expect(recoverResponsesProviderCatalog(input.providerId,"rollback",options.environment)).rejects.toThrow("恢复记录格式无效");
    expect(existsSync(`${path}.pending`)).toBe(true);
  });

  it("preserves the selected fixed model through management, WebUI projection and editing", async () => {
    const {options,input,client,configPath}=fixture();
    const models=[model,{...model,id:"vendor/second",name:"Second"}];
    await applyCustomPrimaryProviderSave({...input,catalog:{kind:"custom",models}},options);
    await applyPrimaryProviderSwitch({providerId:input.providerId,model:"vendor/second"},options);
    const state=await loadModelProviderManagementState({...options,readUserConfig:client.readUserConfigSnapshot});
    const candidate=projectProviderSettings(state).customProviders.fixedCandidates[0];
    expect(candidate.model).toBe("vendor/second");
    await applyCustomPrimaryProviderSave({...input,operation:"update",mode:"exclusive",name:"Renamed",model:candidate.model,catalog:{kind:"custom",models:candidate.models},credential:{action:"preserve"}},options);
    expect(parse(readFileSync(configPath,"utf8")).model).toBe("vendor/second");
  });

  it("removes orphan catalogs and private recovery snapshots by exact Provider ID", async () => {
    const {options,input}=fixture();
    finishResponsesModelCatalogWrite(writeResponsesModelCatalog(options.environment,input.providerId,[model],model.id));
    const backup=responsesProviderBackupPath(options.environment,input.providerId);
    writePrivateFileAtomicSync(backup,'{"schemaVersion":1,"files":[]}');
    const result=await applyPrimaryProviderRemoval({providerId:input.providerId},options);
    expect(result.target.state).toBe("orphan-catalog");
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(responsesProviderCatalogPath(options.environment,input.providerId))).toBe(false);
  });

  it("rejects the upstream OpenAI capability sentinel for arbitrary Responses models", async () => {
    const {options,input}=fixture();
    await expect(applyCustomPrimaryProviderSave({...input,name:"OpenAI"},options)).rejects.toThrow("官方专用协议能力");
    expect(existsSync(responsesProviderCatalogPath(options.environment,input.providerId))).toBe(false);
  });

});
