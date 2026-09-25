import { describe, expect, it, vi } from "vitest";
import { promptResponsesModelImport, responsesModelTemplatesFromCatalog } from "../scripts/responses-model-templates.mjs";

const model = {id:"deepseek-flash",name:"DeepSeek Flash",contextWindow:1048576,reasoningEfforts:["low","high"],defaultReasoningEffort:"high",supportsImages:true};

describe("Responses model template import", () => {
  it("copies only declared RS capabilities, excluding source instructions and credentials", () => {
    const catalog={models:[{slug:model.id,display_name:model.name,context_window:model.contextWindow,supported_reasoning_levels:[{effort:"low"},{effort:"high"}],default_reasoning_level:"high",input_modalities:["text","image"],visibility:"list",supported_in_api:true,model_messages:{instructions_template:"source-only"},apiKey:"source-secret"}]};
    expect(responsesModelTemplatesFromCatalog(catalog)).toEqual([model]);
    expect(catalog.models[0]?.slug).toBe(model.id);
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
    expect(selected).toEqual([{...model,id:"deepseek-v4.1-flash",template:{source:"deepseek",model:model.id,followContext:false}}]);
    expect(model.id).toBe("deepseek-flash");
  });
  it("returns to selection after an empty choice and imports the template parameters", async () => {
    const confirms=[false,true,false,true];
    const choices=[[],[model.id]];
    const load=vi.fn(async()=>[model]);
    const multiselect=vi.fn(async()=>choices.shift());
    const select=vi.fn(async()=>"retry");
    const prompts={confirm:async()=>confirms.shift(),multiselect,select,text:async()=>"platform-flash",password:async()=>undefined,isCancel:()=>false};
    expect(await promptResponsesModelImport(prompts,[],load)).toEqual([{...model,id:"platform-flash",template:{source:"deepseek",model:model.id,followContext:false}}]);
    expect(multiselect).toHaveBeenCalledTimes(2);
    expect(select).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
  });
  it("explicitly skips an empty source and continues importing the next source", async () => {
    const confirms=[true,true,false,true];
    const choices=[[],[model.id]];
    const prompts={confirm:async()=>confirms.shift(),multiselect:async()=>choices.shift(),select:async()=>"skip",text:async()=>model.id,password:async()=>undefined,isCancel:()=>false};
    expect(await promptResponsesModelImport(prompts,[],async()=>[model])).toEqual([{...model,template:{source:"deepseek",model:model.id,followContext:false}}]);
  });
  it("cancels the empty selection decision without entering manual input", async () => {
    const cancel=Symbol("cancel");
    const text=vi.fn();
    const prompts={confirm:async()=>true,multiselect:async()=>[],select:async()=>cancel,text,password:async()=>undefined,isCancel:(value:unknown)=>value===cancel};
    expect(await promptResponsesModelImport(prompts,[],async()=>[model])).toBeUndefined();
    expect(text).not.toHaveBeenCalled();
  });
  it("rejects duplicate mapped IDs already in this provider", async () => {
    const prompts={confirm:async()=>true,multiselect:async()=>[model.id],text:async()=>model.id,select:async()=>undefined,password:async()=>undefined,isCancel:()=>false};
    await expect(promptResponsesModelImport(prompts,[model],async()=>[model])).rejects.toThrow("平台模型 ID 已存在");
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
