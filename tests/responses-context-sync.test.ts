import { existsSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const writes=vi.hoisted(()=>[] as string[]);
const failures=vi.hoisted(()=>({path:"",rollback:false,readPath:"",replacement:"",replacementPath:"",postWritePath:"",mutationPath:"",mutationContent:""}));
vi.mock("../runtime/private-file.mjs",async original=>{
  const actual=await original<typeof import("../runtime/private-file.mjs")>();
  return {...actual,readPrivateFileSync:(path:string,maximumBytes?:number)=>{
    const content=actual.readPrivateFileSync(path,maximumBytes);
    if(path === failures.readPath) {
      failures.readPath="";
      actual.writePrivateFileAtomicSync(failures.replacementPath || path,failures.replacement);
    }
    return content;
  },writePrivateFileAtomicSync:(path:string,content:string)=>{
    writes.push(path);
    if(path === failures.path) {
      if(!failures.rollback) failures.path="";
      throw new Error("injected write failure");
    }
    const result=actual.writePrivateFileAtomicSync(path,content);
    if(path === failures.postWritePath) {
      failures.postWritePath="";
      actual.writePrivateFileAtomicSync(failures.mutationPath,failures.mutationContent);
    }
    return result;
  }};
});
import { writePrivateFileAtomicSync } from "../runtime/private-file.mjs";
import { finishResponsesModelCatalogWrite, removeResponsesModelCatalog, readResponsesModelCatalog, responsesContextSyncPath, writeResponsesModelCatalog } from "../runtime/model-provider-responses-catalog.mjs";
import { recoverResponsesContextSync } from "../runtime/responses-context-sync.mjs";
import { writeManagedModelWindowGlobal, loadManagedModelProviderSettings } from "../runtime/model-provider-runtime.mjs";
import { applyModelWindowChange, previewModelWindowChange } from "../scripts/model-window-management.mjs";
import { configureCcgAccounts, configureOpenCodeGo, configuredHome, testEnvironment, connectHomeFor, providerCatalogPath } from "./model-provider-runtime-test-fixture.js";

const roots:string[]=[];
afterEach(()=>{writes.length=0;failures.path="";failures.rollback=false;failures.readPath="";failures.replacement="";failures.replacementPath="";failures.postWritePath="";failures.mutationPath="";failures.mutationContent="";for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture() {
  const home=await configuredHome("switching");roots.push(home,connectHomeFor(home));
  const environment=testEnvironment(home);
  const definition={id:"vendor/flash",name:"Mapped",contextWindow:1048576,maxContextWindow:1048576,reasoningEfforts:[],defaultReasoningEffort:null,supportsImages:false,template:{source:"deepseek" as const,model:"deepseek-v4-flash",followContext:true}};
  for(const id of ["rs-one","rs-two"]) finishResponsesModelCatalogWrite(writeResponsesModelCatalog(environment,id,[definition,{...definition,id:"vendor/independent",template:{...definition.template,followContext:false}}],definition.id));
  return {environment,home,source:providerCatalogPath(home)};
}

describe("DS context propagation to mapped RS models",()=>{
  it("reuses global window settings and previews mapped targets while preserving other capabilities",async()=>{
    const {environment}=await fixture();
    expect(previewModelWindowChange({model:"deepseek-v4-flash",windowPercent:75},{environment}).providers).toEqual(expect.arrayContaining(["rs-one","rs-two"]));
    await applyModelWindowChange({model:"deepseek-v4-flash",windowPercent:75},{environment});
    for(const id of ["rs-one","rs-two"]) {
      const catalog=readResponsesModelCatalog(environment,id);
      expect(catalog.definitions[0]).toMatchObject({id:"vendor/flash",contextWindow:786432,supportsImages:false,reasoningEfforts:[]});
      expect(catalog.definitions[1]?.contextWindow).toBe(1048576);
      expect(catalog.models[0]).toMatchObject({context_window:786432,max_context_window:1048576});
      expect(catalog.definitions[0]?.template).not.toHaveProperty("snapshot");
    }
    expect(existsSync(responsesContextSyncPath(environment))).toBe(false);
    expect(existsSync(`${responsesContextSyncPath(environment)}.backup`)).toBe(true);
  });
  it("writes a shared DS catalog and each account Profile only once",async()=>{
    const {environment,home,source}=await fixture();
    const directory=`${connectHomeFor(home)}/providers/deepseek`;
    writePrivateFileAtomicSync(`${directory}/accounts.json`,JSON.stringify([{id:"test",default:true},{id:"second",default:false}]));
    writePrivateFileAtomicSync(`${directory}/accounts/second/managed.toml`,'version = 1\nprovider = "ds-second"\nmode = "switching"\n');
    const second=`${home}/sf-ds-second.config.toml`;
    writePrivateFileAtomicSync(second,readFileSync(`${home}/sf-ds-test.config.toml`,"utf8").replaceAll("ds-test","ds-second"));
    const catalog=readResponsesModelCatalog(environment,"rs-one");
    finishResponsesModelCatalogWrite(writeResponsesModelCatalog(environment,"rs-one",catalog.definitions.map(model=>({...model,contextWindow:524288})),catalog.defaultModel,catalog.revision));
    writes.length=0;
    writeManagedModelWindowGlobal({model:"deepseek-v4-flash",windowPercent:100,environment});
    expect(writes.filter(path=>path === source)).toHaveLength(1);
    expect(writes.filter(path=>path === second)).toHaveLength(1);
    expect(readResponsesModelCatalog(environment,"rs-one").definitions[0]?.contextWindow).toBe(1048576);
  });
  it.each([{windowPercent:50,target:"rs"},{windowPercent:100,target:"rs"},{windowPercent:50,target:"ocg"},{windowPercent:100,target:"ocg"}])("restores original RS and OCG contents on batch failure: $windowPercent / $target",async({windowPercent,target})=>{
    const {environment,home,source}=await fixture();
    configureOpenCodeGo(home);
    const catalog=readResponsesModelCatalog(environment,"rs-one");
    finishResponsesModelCatalogWrite(writeResponsesModelCatalog(environment,"rs-one",catalog.definitions.map(model=>({...model,contextWindow:262144})),catalog.defaultModel,catalog.revision));
    const paths=[source,`${home}/sf-ds-test.config.toml`,`${connectHomeFor(home)}/providers/opencode-go/models.json`,`${home}/sf-ocg-main.config.toml`,catalog.path];
    const before=paths.map(path=>readFileSync(path,"utf8"));
    // At 100%, ensure the second follower also needs writing.
    const second=readResponsesModelCatalog(environment,"rs-two");
    failures.path="";
    finishResponsesModelCatalogWrite(writeResponsesModelCatalog(environment,"rs-two",second.definitions.map(model=>({...model,contextWindow:262144})),second.defaultModel,second.revision));
    failures.path=target === "rs" ? second.path : `${home}/sf-ocg-main.config.toml`;
    expect(()=>writeManagedModelWindowGlobal({model:"deepseek-v4-flash",windowPercent,environment})).toThrow("injected write failure");
    expect(paths.map(path=>readFileSync(path,"utf8"))).toEqual(before);
    expect(existsSync(responsesContextSyncPath(environment))).toBe(false);
  });
  it.each(["keep","rollback"] as const)("recovers the complete DS/OCG/CCG/RS batch with %s",async(action)=>{
    const {environment,home}=await fixture();
    configureOpenCodeGo(home);
    configureCcgAccounts(home);
    const ccgCatalog=`${connectHomeFor(home)}/providers/ccg/models.json`;
    const ccgProfiles=[`${home}/sf-ccg-main.config.toml`,`${home}/sf-ccg-work.config.toml`];
    for(const path of [ccgCatalog,...ccgProfiles]) {
      writePrivateFileAtomicSync(path,readFileSync(path,"utf8").replaceAll("deepseek/deepseek-v4-flash","deepseek-v4-flash"));
    }
    failures.path=readResponsesModelCatalog(environment,"rs-two").path;failures.rollback=true;
    expect(()=>writeManagedModelWindowGlobal({model:"deepseek-v4-flash",windowPercent:50,environment})).toThrow();
    failures.path="";
    expect(recoverResponsesContextSync(environment,"rs-one",action)).toBe(true);
    const expected=action === "keep" ? 524288 : 1048576;
    const ocg=JSON.parse(readFileSync(`${connectHomeFor(home)}/providers/opencode-go/models.json`,"utf8"));
    expect(ocg.models[0].context_window).toBe(expected);
    expect(JSON.parse(readFileSync(ccgCatalog,"utf8")).models[0].context_window).toBe(expected);
    expect(readResponsesModelCatalog(environment,"rs-one").definitions[0]?.contextWindow).toBe(expected);
    expect(existsSync(responsesContextSyncPath(environment))).toBe(false);
  });
  it("stops following after the association is disabled",async()=>{
    const {environment}=await fixture();
    const catalog=readResponsesModelCatalog(environment,"rs-one");
    const definitions=catalog.definitions.map(model=>({...model,template:{...model.template!,followContext:false}}));
    finishResponsesModelCatalogWrite(writeResponsesModelCatalog(environment,"rs-one",definitions,catalog.defaultModel,catalog.revision));
    writeManagedModelWindowGlobal({model:"deepseek-v4-flash",windowPercent:50,environment});
    expect(readResponsesModelCatalog(environment,"rs-one").definitions[0]?.contextWindow).toBe(1048576);
    expect(readResponsesModelCatalog(environment,"rs-two").definitions[0]?.contextWindow).toBe(524288);
  });
  it("ignores empty directories left after a provider is removed",async()=>{
    const {environment}=await fixture();
    removeResponsesModelCatalog(environment,"rs-one");
    writeManagedModelWindowGlobal({model:"deepseek-v4-flash",windowPercent:50,environment});
    expect(readResponsesModelCatalog(environment,"rs-two").definitions[0]?.contextWindow).toBe(524288);
  });
  it("repairs a stale follower even when the DS window itself is unchanged",async()=>{
    const {environment}=await fixture();
    const catalog=readResponsesModelCatalog(environment,"rs-one");
    finishResponsesModelCatalogWrite(writeResponsesModelCatalog(environment,"rs-one",catalog.definitions.map(model=>({...model,contextWindow:524288})),catalog.defaultModel,catalog.revision));
    expect(previewModelWindowChange({model:"deepseek-v4-flash",windowPercent:100},{environment}).willChange).toBe(true);
    await applyModelWindowChange({model:"deepseek-v4-flash",windowPercent:100},{environment});
    expect(readResponsesModelCatalog(environment,"rs-one").definitions[0]?.contextWindow).toBe(1048576);
    expect(readResponsesModelCatalog(environment,"rs-one").definitions[1]?.contextWindow).toBe(524288);
  });
  it("limits repair to the selected source model",async()=>{
    const {environment}=await fixture();
    const catalog=readResponsesModelCatalog(environment,"rs-one");
    const extra={...catalog.definitions[0]!,id:"vendor/other",contextWindow:1024,template:{source:"deepseek" as const,model:"deepseek-v4-pro",followContext:true}};
    finishResponsesModelCatalogWrite(writeResponsesModelCatalog(environment,"rs-one",[...catalog.definitions,extra],catalog.defaultModel,catalog.revision));
    await applyModelWindowChange({model:"deepseek-v4-flash",windowPercent:50},{environment});
    expect(readResponsesModelCatalog(environment,"rs-one").definitions.find(model=>model.id === extra.id)?.contextWindow).toBe(1024);
  });
  it.each(["source","follower","profile"])("rejects a concurrent %s change after its first read",async(kind)=>{
    const {environment,source,home}=await fixture();
    const beforeSource=readFileSync(source,"utf8");
    const path=kind === "source" ? source : kind === "profile" ? `${home}/sf-ds-test.config.toml` : readResponsesModelCatalog(environment,"rs-one").path;
    const concurrent=`${readFileSync(path,"utf8")}\n`;
    failures.readPath=readResponsesModelCatalog(environment,"rs-one").path;failures.replacement=concurrent;failures.replacementPath=path;
    expect(()=>writeManagedModelWindowGlobal({model:"deepseek-v4-flash",windowPercent:50,environment})).toThrow("已变化");
    expect(readFileSync(path,"utf8")).toBe(concurrent);
    expect(readFileSync(source,"utf8")).toBe(kind === "source" ? concurrent : beforeSource);
    expect(existsSync(responsesContextSyncPath(environment))).toBe(false);
  });
  it("restores DS and all RS catalogs when one follower write fails",async()=>{
    const {environment,source}=await fixture();
    const previous=readFileSync(source,"utf8");
    failures.path=readResponsesModelCatalog(environment,"rs-two").path;
    expect(()=>writeManagedModelWindowGlobal({model:"deepseek-v4-flash",windowPercent:50,environment})).toThrow("injected write failure");
    expect(readFileSync(source,"utf8")).toBe(previous);
    expect(readResponsesModelCatalog(environment,"rs-one").definitions[0]?.contextWindow).toBe(1048576);
    expect(existsSync(responsesContextSyncPath(environment))).toBe(false);
  });
  it("keeps uncertain transactions blocked and explicitly recovers the entire batch",async()=>{
    const {environment}=await fixture();
    failures.path=readResponsesModelCatalog(environment,"rs-two").path;failures.rollback=true;
    expect(()=>writeManagedModelWindowGlobal({model:"deepseek-v4-flash",windowPercent:50,environment})).toThrow();
    expect(()=>readResponsesModelCatalog(environment,"rs-one")).toThrow("上下文同步未完成");
    expect(()=>loadManagedModelProviderSettings(environment)).toThrow("上下文同步未完成");
    failures.path="";
    expect(recoverResponsesContextSync(environment,"rs-one","keep")).toBe(true);
    expect(readResponsesModelCatalog(environment,"rs-one").definitions[0]?.contextWindow).toBe(524288);
    expect(readResponsesModelCatalog(environment,"rs-two").definitions[0]?.contextWindow).toBe(524288);
  });
  it("keeps the recovery journal if a restored file changes before recovery completes",async()=>{
    const {environment,source}=await fixture();
    writeManagedModelWindowGlobal({model:"deepseek-v4-flash",windowPercent:50,environment});
    const target=readResponsesModelCatalog(environment,"rs-two").path;
    const path=responsesContextSyncPath(environment);
    writePrivateFileAtomicSync(path,readFileSync(`${path}.backup`,"utf8"));
    failures.postWritePath=target;failures.mutationPath=source;failures.mutationContent=`${readFileSync(source,"utf8")}\n`;
    expect(()=>recoverResponsesContextSync(environment,"rs-one","rollback")).toThrow("恢复后文件已变化");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(source,"utf8")).toBe(failures.mutationContent);
  });
  it("refuses recovery after a later file edit and retains the journal",async()=>{
    const {environment,source}=await fixture();
    writeManagedModelWindowGlobal({model:"deepseek-v4-flash",windowPercent:50,environment});
    const path=responsesContextSyncPath(environment);
    writePrivateFileAtomicSync(path,readFileSync(`${path}.backup`,"utf8"));
    writePrivateFileAtomicSync(source,`${readFileSync(source,"utf8")}\n`);
    expect(()=>recoverResponsesContextSync(environment,"rs-one","rollback")).toThrow("已变化");
    expect(existsSync(path)).toBe(true);
  });
});
