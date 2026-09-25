import { promptResponsesModels } from "../scripts/responses-model-setup.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { createResponsesModelCatalog, writeResponsesModelCatalog, finishResponsesModelCatalogWrite, readResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { describe, expect, it, vi } from "vitest";
import { loadResponsesModelTemplates, promptResponsesModelImport, responsesModelTemplatesFromCatalog } from "../scripts/responses-model-templates.mjs";

const baseModel = {id:"deepseek-flash",name:"DeepSeek Flash",contextWindow:1048576,reasoningEfforts:["low","high"],defaultReasoningEffort:"high",supportsImages:true};

const model = {...baseModel,maxContextWindow:1048576,template:{source:"deepseek" as const,model:baseModel.id,followContext:false}};

describe("Responses model template import", () => {
  it("copies only declared RS capabilities, excluding source instructions and credentials", () => {
    const catalog={models:[{slug:model.id,display_name:model.name,context_window:model.contextWindow,supported_reasoning_levels:[{effort:"low"},{effort:"high"}],default_reasoning_level:"high",input_modalities:["text","image"],visibility:"list",supported_in_api:true,model_messages:{instructions_template:"source-only"},apiKey:"source-secret"}]};
    expect(responsesModelTemplatesFromCatalog(catalog)).toEqual([baseModel]);
    expect(catalog.models[0]?.slug).toBe(model.id);
  });
  it.each([true,false])("preserves the maximum window when CLI capability editing is %s",async edit=>{
    const texts=["Edited", "32768", "high"];
    const confirms=edit ? [false,false,false] : [false,false];
    const ui={confirm:async()=>confirms.shift(),text:async()=>texts.shift(),select:async()=>"high",password:vi.fn(),isCancel:()=>false};
    const result=await promptResponsesModels(ui,model.id,[model],edit ? [] : [model.id]);
    expect(result?.[0]?.maxContextWindow).toBe(1048576);
    expect(result?.[0]?.template).not.toHaveProperty("snapshot");
    expect(result?.[0]?.contextWindow).toBe(edit ? 32768 : model.contextWindow);
  });

  it.each(["import-edit", "reconfigure", "import-keep"] as const)("preserves instructions and tool capabilities through CLI %s and catalog save", async mode => {
    const previous = {...model, instructions: "DS instructions\nUse the available tools.", applyPatchToolType: "freeform" as const, supportsSearchTool: true};
    const original = structuredClone(previous);
    const texts = ["Edited", "32768", "high"];
    const confirms = mode === "import-edit" ? [true, false, false] : mode === "reconfigure" ? [false, false, false] : [false, false];
    const ui = {confirm: async () => confirms.shift(), text: async () => texts.shift(), select: async () => "high", password: vi.fn(), isCancel: () => false};
    const result = await promptResponsesModels(ui, model.id, [previous], mode === "reconfigure" ? [] : [model.id]);
    expect(result?.[0]).toMatchObject({instructions: previous.instructions, applyPatchToolType: "freeform", supportsSearchTool: true, maxContextWindow: model.maxContextWindow, template: model.template});
    expect(result?.[0]?.contextWindow).toBe(mode === "import-keep" ? model.contextWindow : 32768);
    expect(previous).toEqual(original);
    const root = mkdtempSync(join(tmpdir(), "responses-cli-save-"));
    try {
      const environment = {CODEX_CONNECT_HOME: root};
      const transaction = writeResponsesModelCatalog(environment, "rs-fixture", result!, model.id, undefined);
      finishResponsesModelCatalogWrite(transaction);
      const saved = readResponsesModelCatalog(environment, "rs-fixture");
      expect(saved.definitions).toEqual(result);
      expect(saved.models[0]).toMatchObject({model_messages: {instructions_template: previous.instructions}, apply_patch_tool_type: "freeform", supports_search_tool: true});
    } finally { rmSync(root, {recursive: true, force: true}); }
  });

  it.each([["deepseek","deepseek"]] as const)("reads only basic %s fields from its private catalog",async(source,directory)=>{
    const root=mkdtempSync(join(tmpdir(),"responses-template-"));
    try {
      const environment={CODEX_CONNECT_HOME:root,CODEX_HOME:join(root,"codex")};
      const snapshot={...createResponsesModelCatalog([baseModel],baseModel.id).models[0],description:`${source} local template`};
      writePrivateFileAtomicSync(join(root,"providers",directory,"models.json"),JSON.stringify({models:[snapshot]}));
      const loaded=await loadResponsesModelTemplates(source,environment);
      expect(loaded[0]?.template).toEqual({source,model:model.id,followContext:false});
      writePrivateFileAtomicSync(join(root,"providers",directory,"models.json"),"invalid JSON");
      await expect(loadResponsesModelTemplates(source,environment)).rejects.toThrow("无法安全读取");
    } finally {rmSync(root,{recursive:true,force:true});}
  });

  it("offers only official Codex and DeepSeek template sources",async()=>{
    const confirm=vi.fn(async()=>false);
    const ui={confirm,text:vi.fn(),select:vi.fn(),password:vi.fn(),isCancel:()=>false};
    await promptResponsesModelImport(ui);
    expect(confirm.mock.calls).toHaveLength(2);
    expect(confirm).toHaveBeenNthCalledWith(1,expect.objectContaining({message:expect.stringContaining("官方 Codex")}));
    expect(confirm).toHaveBeenNthCalledWith(2,expect.objectContaining({message:expect.stringContaining("DeepSeek")}));
  });

  it("excludes Codex-specific reasoning modes without rejecting usable official models",()=>{
    const catalog={models:[{slug:"official-model",display_name:"Official",context_window:64000,supported_reasoning_levels:[{effort:"high"},{effort:"max"},{effort:"ultra"},{effort:"persistent"}],default_reasoning_level:"high",input_modalities:["text"],visibility:"list",supported_in_api:true}]};
    expect(responsesModelTemplatesFromCatalog(catalog)[0]).toMatchObject({reasoningEfforts:["high","max"],defaultReasoningEffort:"high"});
    expect(catalog.models[0]?.supported_reasoning_levels).toHaveLength(4);
  });
  it("rejects invalid source capabilities instead of guessing them", () => {
    expect(()=>responsesModelTemplatesFromCatalog({models:[{slug:"broken",visibility:"list",supported_in_api:true}]})).toThrow();
  });
  it("maps a selected DS template to a platform ID without changing the source", async () => {
    const confirms=[false,true,false,true];
    const load=vi.fn(async()=>[model]);
    const prompts={confirm:async()=>confirms.shift(),multiselect:async()=>[model.id],text:async()=>"deepseek-v4.1-flash",select:async()=>undefined,password:async()=>undefined,isCancel:()=>false};
    const selected=await promptResponsesModelImport(prompts,[],load);
    expect(load).toHaveBeenCalledExactlyOnceWith("deepseek");
    expect(selected).toEqual([{...model,id:"deepseek-v4.1-flash",template:{...model.template,source:"deepseek",model:model.id,followContext:false}}]);
    expect(model.id).toBe("deepseek-flash");
  });
  it("returns to selection after an empty choice and imports the template parameters", async () => {
    const confirms=[false,true,false,true];
    const choices=[[],[model.id]];
    const load=vi.fn(async()=>[model]);
    const multiselect=vi.fn(async()=>choices.shift());
    const select=vi.fn(async()=>"retry");
    const prompts={confirm:async()=>confirms.shift(),multiselect,select,text:async()=>"platform-flash",password:async()=>undefined,isCancel:()=>false};
    expect(await promptResponsesModelImport(prompts,[],load)).toEqual([{...model,id:"platform-flash",template:{...model.template,source:"deepseek",model:model.id,followContext:false}}]);
    expect(multiselect).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });
  it("explicitly skips an empty source and continues importing the next source", async () => {
    const confirms=[true,true,false,true];
    const choices=[[],[model.id]];
    const prompts={confirm:async()=>confirms.shift(),multiselect:async()=>choices.shift(),select:async()=>"skip",text:async()=>model.id,password:async()=>undefined,isCancel:()=>false};
    expect(await promptResponsesModelImport(prompts,[],async()=>[model])).toEqual([{...model,template:{...model.template,source:"deepseek",model:model.id,followContext:false}}]);
  });
  it("cancels the empty selection decision without entering manual input", async () => {
    const cancel=Symbol("cancel");
    const text=vi.fn();
    const prompts={confirm:async()=>true,multiselect:async()=>[],select:async()=>cancel,text,password:async()=>undefined,isCancel:(value:unknown)=>value===cancel};
    expect(await promptResponsesModelImport(prompts,[],async()=>[model])).toBeUndefined();
    expect(text).not.toHaveBeenCalled();
  });
  it("rejects two imports targeting the same platform ID", async () => {
    const prompts={confirm:async()=>true,multiselect:async()=>[model.id],text:async()=>model.id,select:async()=>undefined,password:async()=>undefined,isCancel:()=>false};
    await expect(promptResponsesModelImport(prompts,[model],async()=>[model])).rejects.toThrow("本次导入已使用该平台模型 ID");
  });
  it.each([true,false])("requires confirmation to update an existing mapped model: %s",async confirmed=>{
    const existing={...model,id:"platform-flash",contextWindow:32768,template:{...model.template,source:"deepseek" as const,model:model.id,followContext:true}};
    const confirms=[false,true,true,confirmed];
    const confirm=vi.fn(async()=>confirms.shift());
    const text=vi.fn(async()=>existing.id);
    const ui={confirm,text,multiselect:async()=>[model.id],select:vi.fn(),password:vi.fn(),isCancel:()=>false};
    const result=await promptResponsesModelImport(ui,[existing],async()=>[model]);
    expect(result).toEqual(confirmed ? [{...model,id:existing.id,template:existing.template}] : []);
    expect(text).toHaveBeenCalledWith(expect.objectContaining({initialValue:existing.id}));
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({message:expect.stringContaining("更新已有模型"),initialValue:false}));
    expect(existing.contextWindow).toBe(32768);
  });
  it("allows replacing a model when the catalog already contains 64 models",async()=>{
    const previous=Array.from({length:64},(_,index)=>({...model,id:`model-${index}`}));
    const confirms=[false,true,false,true];
    const ui={confirm:async()=>confirms.shift(),text:async()=>"model-0",multiselect:async()=>[model.id],select:vi.fn(),password:vi.fn(),isCancel:()=>false};
    expect(await promptResponsesModelImport(ui,previous,async()=>[model])).toHaveLength(1);
  });
  it("does not load sources when both import choices are declined", async () => {
    const load=vi.fn(async()=>[model]);
    const prompts={confirm:async()=>false,text:async()=>undefined,select:async()=>undefined,password:async()=>undefined,isCancel:()=>false};
    expect(await promptResponsesModelImport(prompts,[],load)).toEqual([]);
    expect(load).not.toHaveBeenCalled();
  });
  it("cancels selection without copying any model", async () => {
    const cancel=Symbol("cancel");
    const prompts={confirm:async()=>true,multiselect:async()=>cancel,text:async()=>undefined,select:async()=>undefined,password:async()=>undefined,isCancel:(value:unknown)=>value===cancel};
    expect(await promptResponsesModelImport(prompts,[],async()=>[model])).toBeUndefined();
  });
});
