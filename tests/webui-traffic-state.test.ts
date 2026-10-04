import { describe, expect, it } from "vitest";
import { canReuseTrafficSummary, resolveTrafficData, resolveTrafficDetailSnapshot, trafficCallKey, trafficDetailPath } from "../webui/src/lib/traffic-state.js";
import { modelNameComparison } from "../runtime/model-name-comparison.mjs";

describe("traffic request ownership", () => {
  it("clears copy feedback when content changes and ignores late clipboard results", () => {
    const script = String.raw`
      import fs from "node:fs"; import ts from "typescript"; import assert from "node:assert/strict";
      const slots=[], writes=[]; let index=0, changed=false;
      const element=(type,props)=>({type,props});
      const imports={
        react:{useMemo:fn=>fn(),useState(initial){const i=index++;if(!(i in slots))slots[i]=initial;return [slots[i],value=>{const next=typeof value==="function"?value(slots[i]):value;if(next!==slots[i])changed=true;slots[i]=next;}];}},
        "react/jsx-runtime":{jsx:element,jsxs:element},
        "lucide-react":{CopyIcon:"copy-icon"},
        "@/components/ui/button":{Button:"button"},
        "@/hooks/use-translation":{useTranslation:()=>({t:key=>key})},
        cn:{cn:(...names)=>names.filter(Boolean).join(" ")},
      };
      Object.defineProperty(globalThis,"navigator",{configurable:true,value:{clipboard:{writeText:text=>new Promise((resolve,reject)=>writes.push({text,resolve,reject}))}}});
      const code=ts.transpileModule(fs.readFileSync("webui/src/components/traffic/traffic-content.tsx","utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
      const exports={};new Function("require","exports",code)(name=>{assert.ok(name in imports,name);return imports[name];},exports);
      const all=node=>node==null?[]:Array.isArray(node)?node.flatMap(all):typeof node==="object"?[node,...all(node.props?.children)]:[];
      const render=text=>{let tree;do{index=0;changed=false;tree=exports.TrafficContent({title:"body",text,json:true});}while(changed);return all(tree);};
      const button=(nodes,label)=>nodes.find(node=>node.type==="button"&&allText(node.props.children).includes(label));
      const allText=node=>node==null?"":Array.isArray(node)?node.map(allText).join(""):typeof node==="object"?allText(node.props?.children):String(node);
      const status=nodes=>nodes.find(node=>node.props?.role==="status").props.children;
      const settle=()=>new Promise(resolve=>setImmediate(resolve));
      let nodes=render('{"value":1}');button(nodes,"traffic.wrap").props.onClick();
      nodes=render('{"value":1}');button(nodes,"traffic.copyRaw").props.onClick();
      assert.equal(writes[0].text,'{"value":1}');writes[0].resolve();await settle();
      nodes=render('{"value":1}');assert.equal(status(nodes),"traffic.copiedRaw");
      nodes=render('{"value":2}');assert.equal(status(nodes),"");assert.equal(button(nodes,"traffic.wrap").props["aria-pressed"],false);
      button(nodes,"traffic.copyRaw").props.onClick();
      nodes=render('{"value":3}');assert.equal(button(nodes,"traffic.copyRaw").props.disabled,false);button(nodes,"traffic.copyRaw").props.onClick();
      writes[1].resolve();await settle();nodes=render('{"value":3}');assert.equal(status(nodes),"");assert.equal(button(nodes,"traffic.copyRaw").props.disabled,true);
      writes[2].resolve();await settle();nodes=render('{"value":3}');assert.equal(status(nodes),"traffic.copiedRaw");
      nodes=render('{"value":2}');assert.equal(status(nodes),"");button(nodes,"traffic.copyRaw").props.onClick();
      nodes=render('{"value":4}');writes[3].reject(new Error("late failure"));await settle();assert.equal(status(render('{"value":4}')),"");
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).not.toThrow();
  });
  it("pins a default detail to its first resolved identity and never revives a missing snapshot during retries", () => {
    const script = String.raw`
      import fs from "node:fs"; import ts from "typescript"; import assert from "node:assert/strict";
      const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
      const helpers={};new Function("exports",compile(fs.readFileSync("webui/src/lib/traffic-state.ts","utf8")))(helpers);
      const refs=[],requests=[],watches=[];let index=0,loader,watch,missing=false,defaultLabel="original";
      class ApiClientError extends Error {constructor(code){super(code);this.code=code;this.status=404;}}
      const state={data:null,loading:false,error:null,errorCode:null,refetch(){state.error=null;state.errorCode=null;state.loading=true;}};
      const imports={react:{useCallback:fn=>fn,useRef:initial=>refs[index++]??(refs[index-1]={current:initial})},
        "@/hooks/use-api":{useApi:fn=>{loader=fn;return state;}},
        "@/hooks/use-queue-events":{useQueueSnapshot:load=>({load}),useQueueEvents:(_r,_l,_e,_latest,_read,value)=>{watch=value;return "live";}},
        "@/lib/traffic-state":helpers,
        "@/lib/api":{ApiClientError,
          fetchTrafficExchange:async query=>{requests.push(query);if(missing)throw new ApiClientError("traffic_exchange_not_found");return {label:query.label??defaultLabel,session:query.session??"batch",exchange:{id:query.id,state:"pending",response:null,tracePage:{total:0}}};},
          fetchTrafficExchanges:async()=>{if(missing)throw new ApiClientError("traffic_session_not_found");return {exchanges:[7]};},
          watchTraffic:async scope=>watches.push(scope),
        }};
      const exports={};new Function("require","exports",compile(fs.readFileSync("webui/src/hooks/use-traffic.ts","utf8")))(id=>imports[id],exports);
      const signal=new AbortController().signal;
      const render=(query={id:7})=>{index=0;return exports.useTrafficExchange(query);};
      render();state.data=await loader(signal);render();defaultLabel="new-provider";
      state.data=await loader(signal);assert.equal(requests.at(-1).label,"original");assert.equal(requests.at(-1).session,"batch");
      render();await watch(signal,()=>{});assert.deepEqual(watches.at(-1),{label:"original",session:"batch",detail:true});
      render().refetch();state.data=await loader(signal);assert.equal(state.data.value.label,"original");
      missing=true;await assert.rejects(loader(signal));state.error="gone";state.errorCode="traffic_exchange_not_found";
      assert.equal(render().displayData,null);render().refetch();assert.equal(render().displayData,null);
      await assert.rejects(loader(signal));assert.equal(requests.at(-1).label,"original");
      missing=false;state.data=await loader(signal);state.loading=false;assert.equal(render().displayData.label,"original");
      assert.equal(render({id:8}).displayData,null);state.data=await loader(signal);assert.equal(state.data.value.label,"new-provider");
      refs.length=0;state.data=null;
      const renderList=()=>{index=0;return exports.useTrafficExchanges({label:"original",session:"batch"});};
      renderList();state.data=await loader(signal);assert.deepEqual(renderList().data.exchanges,[7]);
      missing=true;await assert.rejects(loader(signal));state.error="gone";state.errorCode="traffic_session_not_found";
      assert.equal(renderList().data,null);renderList().refetch();assert.equal(renderList().data,null);
      missing=false;state.data=await loader(signal);assert.deepEqual(renderList().data.exchanges,[7]);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).not.toThrow();
  });
  it("subscribes only active views, retains detail on refresh and reuses terminal bodies", () => {
    const script = String.raw`
      import fs from "node:fs"; import ts from "typescript"; import assert from "node:assert/strict";
      let loader, active, watching, fullReads=0, traceReads=0, refreshed=0, traceTotal=1;
      const saved={current:null}, anchor={current:null}, calls=[];let refs=0;
      const state={data:null,loading:false,error:null,errorCode:null,refetch:()=>refreshed++};
      const source=fs.readFileSync("webui/src/lib/traffic-state.ts","utf8");
      const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
      const helpers={};new Function("exports",compile(source))(helpers);
      const response={label:"openai",session:"batch",exchange:{id:1,state:"pending",response:null,tracePage:{total:1}}};
      const imports={react:{useCallback:fn=>fn,useRef:()=>refs++%2===0?saved:anchor},
        "@/hooks/use-api":{useApi:fn=>{loader=fn;return state;}},
        "@/hooks/use-queue-events":{useQueueSnapshot:load=>({load}),useQueueEvents:(_r,_l,enabled,_latest,_read,watch)=>{active=enabled;watching=watch;return "live";}},
        "@/lib/traffic-state":helpers,
        "@/lib/api":{
          fetchTrafficExchange:async query=>{fullReads++;return structuredClone({...response,exchange:{...response.exchange,id:query.id}});},
          fetchTrafficTrace:async query=>{traceReads++;calls.push(query);return {exchange:{trace:[traceReads],tracePage:{total:traceTotal}}};},
          watchTraffic:async scope=>calls.push(scope),
        }};
      const exports={};new Function("require","exports",compile(fs.readFileSync("webui/src/hooks/use-traffic.ts","utf8")))(id=>imports[id],exports);
      const query={label:"openai",session:"batch",id:1,traceOffset:0},signal=new AbortController().signal;
      const render=()=>exports.useTrafficExchange(query);
      render();assert.equal(active,true);await watching(signal,()=>{});assert.deepEqual(calls.pop(),{label:"openai",session:"batch",detail:true});
      state.data=await loader(signal);assert.equal(fullReads,1);
      state.loading=true;let view=render();assert.equal(view.loading,false);assert.equal(view.refreshing,true);assert.equal(view.displayData.exchange.id,1);
      response.exchange={id:1,state:"completed",response:{body:"final"},tracePage:{total:1}};
      state.data=await loader(signal);state.loading=false;render();assert.equal(fullReads,2);
      state.data=await loader(signal);assert.equal(fullReads,2);assert.equal(traceReads,1);assert.equal(state.data.value.exchange.response.body,"final");
      traceTotal=2;response.exchange.tracePage.total=2;response.exchange.response={body:"final with late output"};
      state.data=await loader(signal);assert.equal(fullReads,3);assert.equal(state.data.value.exchange.response.body,"final with late output");
      query.traceOffset=100;view=render();assert.equal(active,false);assert.equal(view.notificationStatus,"paused");assert.equal(view.displayData.exchange.id,1);
      state.data=await loader(signal);assert.equal(traceReads,3);assert.equal(calls.at(-1).traceOffset,100);
      view=render();view.refetch();assert.equal(refreshed,1);state.data=await loader(signal);assert.equal(fullReads,4);
      state.error="gone";state.errorCode="traffic_exchange_not_found";assert.equal(render().displayData,null);
      state.error=null;state.errorCode=null;query.id=2;assert.equal(render().displayData,null);
      const cancelled=new AbortController();cancelled.abort();await assert.rejects(loader(cancelled.signal),{name:"AbortError"});assert.equal(saved.current.exchange.id,1);
      exports.useTrafficExchange(null);assert.equal(watching,null);assert.equal(active,false);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).not.toThrow();
  });
  it("loads only summaries for a list and performs no supplemental diagnostic requests", () => {
    const script = String.raw`
      import fs from "node:fs";
      import ts from "typescript";
      import assert from "node:assert/strict";
      const source = fs.readFileSync("webui/src/hooks/use-traffic.ts", "utf8")
        .replace(/^import .*$/gm, "").replace(/export function/g, "function");
      const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
      const loaders = [], calls = [];
      const useApi = loader => { loaders.push(loader); return {data:null}; };
      const fetchList = async (query, signal) => { calls.push({query,signal}); return {exchanges:[]}; };
      const factory = new Function("useApi", "resolveTrafficData", "fetchTrafficExchanges", "useCallback", "useQueueSnapshot", "useQueueEvents", "useRef", compiled + ";return useTrafficExchanges;");
      const hook = factory(useApi, () => null, fetchList, fn => fn, load => ({ load }), () => "live", () => ({ current: null }));
      hook({limit:50});
      assert.equal(loaders.length, 1);
      const signal = new AbortController().signal;
      await loaders[0](signal);
      assert.deepEqual(calls, [{query:{limit:50},signal}]);
      hook(null);
      await loaders[1](signal);
      assert.equal(calls.length, 1);
    `;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })).not.toThrow();
  });
  it("reuses only terminal summaries for lightweight trace pagination", () => {
    expect(canReuseTrafficSummary({ state: "pending", response: null })).toBe(false);
    expect(canReuseTrafficSummary({ state: "pending", response: {} })).toBe(false);
    for (const state of ["completed", "failed", "incomplete"]) {
      expect(canReuseTrafficSummary({ state, response: {} })).toBe(true);
      expect(canReuseTrafficSummary({ state, response: null })).toBe(false);
    }
    const call = { label: "openai", session: "batch-1", id: 1 };
    expect(trafficCallKey(call)).not.toBe(trafficCallKey({ ...call, label: "deepseek" }));
    expect(trafficCallKey(call)).not.toBe(trafficCallKey({ ...call, session: "batch-2" }));
  });
  it("retains only an explicitly identified call while its trace page changes", () => {
    const value = { label: "openai", session: "batch-1", exchange: { id: 7 } };
    const query = { label: "openai", session: "batch-1", id: 7 };
    expect(resolveTrafficDetailSnapshot(query, value)).toBe(value);
    for (const other of [null, { id: 7 }, { ...query, label: "deepseek" }, { ...query, session: "batch-2" }, { ...query, id: 8 }]) {
      expect(resolveTrafficDetailSnapshot(other, value)).toBeNull();
    }
    expect(resolveTrafficDetailSnapshot(query, null)).toBeNull();
  });
  it.each([
    ["model-a", "model-a", "名称一致"],
    [" model-a ", "model-a", "名称一致"],
    ["model-a", "model-b", "名称不一致"],
    ["model-a", "MODEL-A", "名称不一致"],
    ["model-a", "model-a-latest", "名称不一致"],
    ["model-a", null, "信息不足"],
    [undefined, "model-a", "信息不足"],
    ["", "model-a", "信息不足"],
  ])("compares only provided names: %s / %s", (request, response, expected) => {
    expect(modelNameComparison(request, response)).toBe(expected);
  });
  it("links to the recorded label, session and interaction without using the current selection", () => {
    expect(trafficDetailPath({ label: "ocg", session: "2026-09-19T00-00-00-000Z-2", interaction: 23 }))
      .toBe("/traffic?label=ocg&exchangeSession=2026-09-19T00-00-00-000Z-2&id=23");
  });
  it("does not expose the previous provider while a new label or latest session is loading", () => {
    const oldQuery = { label: "openai", session: "old", limit: 50, offset: 0 };
    const data = { key: JSON.stringify(oldQuery), value: { label: "openai", session: "old" } };
    for (const query of [{ label: "ocg" }, { label: "deepseek" }, {}]) {
      expect(resolveTrafficData(JSON.stringify(query), data)).toBeNull();
    }
    expect(resolveTrafficData(JSON.stringify(oldQuery), data)).toEqual({ label: "openai", session: "old" });
  });

  it("does not expose a previous detail across provider, session, id or trace page changes", () => {
    const query = { label: "ocg", session: "current", id: 1, traceOffset: 0 };
    const data = { key: JSON.stringify(query), value: { label: "ocg", session: "current" } };
    for (const change of [{ label: "deepseek" }, { session: "next" }, { id: 2 }, { traceOffset: 100 }]) {
      expect(resolveTrafficData(JSON.stringify({ ...query, ...change }), data)).toBeNull();
    }
    expect(resolveTrafficData("null", data)).toBeNull();
    expect(resolveTrafficData(JSON.stringify(query), null)).toBeNull();
    expect(resolveTrafficData(JSON.stringify(query), data)).toEqual({ label: "ocg", session: "current" });
  });
});
import { execFileSync } from "node:child_process";
