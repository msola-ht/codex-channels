import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

it("shows catalog success as a toast but preserves actionable download and audit failures", () => {
  const script = String.raw`
    import {createServer} from 'vite';
    import {createElement as h} from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    let values=[], cursor=0;
    globalThis.catalogState=initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],value=>{values[i]=value}];};
    globalThis.catalogToasts=[];
    globalThis.catalogButtons=[];
    const server=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'silent',plugins:[{
      name:'catalog-feedback-fixture',enforce:'pre',transform(code,id){
        if(id.endsWith('/hooks/use-relay-catalog.ts'))return code.replace('useRef, useState','useRef').replace('export function useRelayCatalog','const useState=globalThis.catalogState; export function useRelayCatalog');
        if(id.endsWith('/ui/button.tsx'))return "import {createElement as h} from 'react'; export const Button=({children,onClick})=>{globalThis.catalogButtons.push({children,onClick});return h('button',null,children)};";
        if(id.endsWith('/ui/toast-manager.ts'))return 'export const toast={add:entry=>globalThis.catalogToasts.push(entry)}';
        if(id.endsWith('/lib/api.ts'))return 'export const updateRelayCatalog=()=>globalThis.catalogResult()';
      }
    }]});
    try {
      const {RelayProviderModels}=await server.ssrLoadModule('/src/components/settings/relay-provider-models.tsx');
      const {LanguageContext}=await server.ssrLoadModule('/src/hooks/language-context.ts');
      const {setServerTimeZone}=await server.ssrLoadModule('/src/lib/format.ts');setServerTimeZone('UTC');
      const snapshot={providers:[{id:'clp-main',models:[]}],clineCatalog:{status:'ready',catalog:{commit:'1234567890ab',downloadedAt:1000}}};
      let refreshes=0;
      const render=()=>{cursor=0;globalThis.catalogButtons=[];return renderToStaticMarkup(h(LanguageContext.Provider,{value:{language:'zh',setLanguage(){}}},h(RelayProviderModels,{snapshot,blocked:false,onRefresh:()=>refreshes++})));};
      const results=[];
      for(const outcome of ['recorded','failed','network']) {
        values=[];globalThis.catalogToasts=[];refreshes=0;
        globalThis.catalogResult=async()=>{if(outcome==='network')throw Error('network');return {auditStatus:outcome}};
        render();globalThis.catalogButtons.find(button=>button.children==='下载／更新 Cline 模型文件').onClick();
        await new Promise(resolve=>setTimeout(resolve,0));
        results.push({html:render(),toasts:globalThis.catalogToasts,refreshes});
      }
      console.log(JSON.stringify(results));
    }finally{await server.close();}
  `;
  const [success, auditFailure, downloadFailure] = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as Array<{ html: string; toasts: Array<{ title: string; type: string; timeout: number }>; refreshes: number }>;
  expect(success!.toasts).toEqual([{ title: "模型目录已更新", type: "success", timeout: 3000 }]);
  expect(success!.html).not.toContain("模型目录已更新");
  expect(success!.refreshes).toBe(1);
  expect(auditFailure!.toasts).toEqual([]);
  expect(auditFailure!.html).toContain("目录已保存，但审计记录失败；请刷新确认。");
  expect(auditFailure!.refreshes).toBe(1);
  expect(downloadFailure!.toasts).toEqual([]);
  expect(downloadFailure!.html).toContain("下载或保存失败，原目录保留。请检查网络后重试。");
  expect(downloadFailure!.refreshes).toBe(0);
});

it("copies exact authorized model IDs and offers manual copying when clipboard access fails", () => {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    const values=[]; let cursor=0;
    globalThis.copyState=initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],value=>{values[i]=value}];};
    globalThis.copyActions=[];
    const server=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'silent',plugins:[{
      name:'copy-fixture',enforce:'pre',transform(code,id){
        if(id.endsWith('/settings/relay-model-copy.tsx'))return code.replace('import { useState } from "react"','const useState = globalThis.copyState');
        if(id.endsWith('/ui/dropdown-menu.tsx'))return "import {createElement as h} from 'react'; export const DropdownMenu=({children})=>children;export const DropdownMenuTrigger=DropdownMenu;export const DropdownMenuContent=DropdownMenu;export const DropdownMenuGroup=DropdownMenu;export const DropdownMenuItem=({children,onClick})=>{globalThis.copyActions.push(onClick);return h('div',null,children)};";
      }
    }]});
    try{
      const {RelayModelCopy}=await server.ssrLoadModule('/src/components/settings/relay-model-copy.tsx');
      const {LanguageContext}=await server.ssrLoadModule('/src/hooks/language-context.ts');
      const models=['clp-main/mimo-v2.5','rs-main/vendor/model'];const written=[];
      const render=()=>{cursor=0;globalThis.copyActions=[];return renderToStaticMarkup(h(LanguageContext.Provider,{value:{language:'zh',setLanguage(){}}},h(RelayModelCopy,{models})));};
      Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>written.push(value)}}});
      const initial=render();globalThis.copyActions[1]();await new Promise(resolve=>setTimeout(resolve,0));const copied=render();
      globalThis.navigator.clipboard=undefined;globalThis.copyActions[0]();await new Promise(resolve=>setTimeout(resolve,0));const failed=render();
      console.log(JSON.stringify({initial,copied,failed,written}));
    }finally{await server.close();}
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as { initial: string; copied: string; failed: string; written: string[] };
  expect(result.initial).toContain("clp-main/mimo-v2.5");
  expect(result.initial).not.toContain("cline-pass/");
  expect(result.written).toEqual(["rs-main/vendor/model"]);
  expect(result.copied).toContain("已复制：rs-main/vendor/model");
  expect(result.failed).toContain("无法访问剪贴板，请手动复制：clp-main/mimo-v2.5");
  expect(result.failed).toMatch(/<input[^>]*readOnly=""[^>]*value="clp-main\/mimo-v2.5"/u);
});

it("binds key drafts to revisions and retains one-time secrets after saved audit failures", () => {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    const values=[];let cursor=0;
    globalThis.editorState=initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],value=>{values[i]=value}];};
    const server=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'silent',plugins:[{
      name:'key-editor-fixture',enforce:'pre',transform(code,id) {
        if(id.endsWith('/hooks/use-relay-key-editor.ts'))return code.replace('import { useState } from "react"','const useState=globalThis.editorState');
      }
    }]});
    try {
      const {useRelayKeyEditor}=await server.ssrLoadModule('/src/hooks/use-relay-key-editor.ts');
      const mutations=[];let confirmed=0,view;
      const caller={caller_id:'client-existing',display_name:'翻译',key_id:'key-existing',models:['clp-main/off','clp-main/unknown'],reasoning:'passthrough'};
      const saved={activation:'saved_unconfirmed',key:'one-time-secret',auditStatus:'failed',cleanupStatus:'failed'};
      const management={data:{revision:'r1',callers:[caller],providers:[{id:'clp-main',available:true,models:[
        {relayId:'clp-main/off',reasoningOff:true},{relayId:'clp-main/unknown',reasoningOff:false}
      ]}]},clearError(){},mutate:input=>mutations.push(input),confirm:async()=>{confirmed++;return saved}};
      const Probe=()=>{view=useRelayKeyEditor(management,false);return null;};
      const render=()=>{cursor=0;renderToStaticMarkup(h(Probe));};
      render();view.openEditor(caller);render();view.changeReasoning('off');render();view.submit();
      const filtered={models:view.models,removed:view.removedModelCount,mutation:mutations[0]};
      management.data.revision='r2';render();view.submit();
      const stale={draftStale:view.draftStale,mutations:mutations.length};
      view.openEditor(caller);render();view.submit();
      const reloaded=mutations[1];
      view.openEditor('new');render();view.setName('编码');view.setModels(['clp-main/off']);render();view.submit();
      const issued=mutations[2];
      await view.confirm();render();const result=view.result;
      view.setResult(null);render();
      console.log(JSON.stringify({filtered,stale,reloaded,issued,result,confirmed,closedResult:view.result}));
    }finally{await server.close();}
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as {
    filtered: { models: string[]; removed: number; mutation: { revision: string; input: Record<string, unknown> } };
    stale: { draftStale: boolean; mutations: number };
    reloaded: { revision: string; input: { caller: string } };
    issued: { revision: string; input: { command: string; caller: string; key: string; name: string } };
    result: { key: string; auditStatus: string; cleanupStatus: string; activation: string };
    confirmed: number; closedResult: null;
  };
  expect(result.filtered.models).toEqual(["clp-main/off"]);
  expect(result.filtered.removed).toBe(1);
  expect(result.filtered.mutation).toEqual({ revision: "r1", input: { command: "edit", caller: "client-existing", name: "翻译", models: ["clp-main/off"], reasoning: "off" } });
  expect(result.stale).toEqual({ draftStale: true, mutations: 1 });
  expect(result.reloaded.revision).toBe("r2");
  expect(result.reloaded.input.caller).toBe("client-existing");
  expect(result.issued.revision).toBe("r2");
  expect(result.issued.input).toMatchObject({ command: "issue", name: "编码" });
  expect(result.issued.input.caller).toMatch(/^client-[a-f0-9]{32}$/u);
  expect(result.issued.input.key).toMatch(/^key-[a-f0-9]{32}$/u);
  expect(result.result).toEqual({ key: "one-time-secret", auditStatus: "failed", cleanupStatus: "failed", activation: "saved_unconfirmed" });
  expect(result.confirmed).toBe(1);
  expect(result.closedResult).toBeNull();
});

describe("Relay page presentation", () => {
  let result: ReturnType<typeof renderRelayPageFixture>;
  // Vite startup and SSR compilation are fixture setup, not assertion time.
  // Bound the child itself too, because a synchronous child blocks hook timers.
  beforeAll(() => { result = renderRelayPageFixture(); }, 35_000);

  it("renders the real Relay page with per-key policy, exact caller links and localized empty state", () => {
    assertRelayPage(result);
  });
});

function renderRelayPageFixture() {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router';
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', plugins: [{
      name: 'relay-fixture', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/hooks/use-relay-key-editor.ts')) return code
          .replace('useState<"new" | RelayManagedCaller | null>(null)', 'useState<"new" | RelayManagedCaller | null>(globalThis.editingFixture ?? null)')
          .replace('useState<string | null>(null)', 'useState<string | null>(globalThis.draftRevisionFixture ?? "r")')
          .replace('const [name, setName] = useState("")', 'const [name, setName] = useState(globalThis.editingFixture?.display_name ?? "")')
          .replace('const [models, setModels] = useState<string[]>([])', 'const [models, setModels] = useState(globalThis.editingFixture?.models ?? [])')
          .replace('useState<RelayReasoning>("passthrough")', 'useState<RelayReasoning>(globalThis.editingFixture?.reasoning ?? "passthrough")');
        if (id.endsWith('/components/ui/dialog.tsx')) return "import { createElement as h } from 'react';           export const Dialog = ({open, children}) => open ? children : null;           export const DialogContent = ({children}) => h('section', {role:'dialog'}, children);           export const DialogHeader = ({children}) => h('header', null, children);           export const DialogTitle = ({children}) => h('h2', null, children);           export const DialogDescription = ({children}) => h('p', null, children);           export const DialogFooter = ({children}) => h('footer', null, children);";
        if (id.endsWith('/hooks/use-relay-service-management.ts')) return 'export function useRelayServiceManagement(refresh, busy) { return {refresh,refreshBlocked:busy,services:{data:null,loading:false,error:null},tasks:{tasks:[],error:null,actionError:null,pendingPreview:null}}; }';
        if (id.endsWith('/hooks/use-relay-management.ts')) return 'export function useRelayManagement() { return globalThis.fixture; }';
      }
    }] });
    try {
      const { setServerTimeZone } = await server.ssrLoadModule('/src/lib/format.ts');
      setServerTimeZone('UTC');
      const { RelayPage } = await server.ssrLoadModule('/src/pages/relay-page.tsx');
      const { LanguageContext } = await server.ssrLoadModule('/src/hooks/language-context.ts');
      const noop = () => {};
      globalThis.fixture = { busy: false, loading: false, error: null, actionError: null, pendingPreview: null, refetch: noop,
        data: { enabled: true, maxConcurrency: 10, runtime: { state: 'running', listening: true, configurationValid: true, active: 4, waiting: 2, uploading: 1, oldestWaitMs: 1200, queueTimeouts: 3, capture: { enabled: true, state: 'ready', active: 2, skippedCapacity: 1 }, metrics: { accepted: 10, unconfirmed: 2, rejected: 1, localDropped: 3 } }, revision: 'r', providers: [], callers: [
          { caller_id: 'translation', display_name: '沉浸式翻译', key_id: 'key-a', credential_generation: 2, enabled: true, models: ['clp-main/deepseek-v4.1-flash'], reasoning: 'off' },
          { caller_id: 'kelivo', key_id: 'key-b', credential_generation: 1, enabled: false, models: ['clp-main/deepseek-v4.1-flash'], reasoning: 'passthrough' }
        ] }
      };
      const render = language => renderToStaticMarkup(h(MemoryRouter, null, h(LanguageContext.Provider, { value: { language, setLanguage: noop } }, h(RelayPage))));
      globalThis.fixture.data.usage = { observedAtMs: 2000, startAtMs: 0, callers: [
        { callerId: 'translation', keyId: 'key-a', lastRequestAtMs: 1000, requestCount: 17, unsuccessfulRequestCount: 3 },
        { callerId: 'kelivo', keyId: 'key-b', lastRequestAtMs: null, requestCount: 0, unsuccessfulRequestCount: 0 }
      ] };
      const zh = render('zh'), en = render('en');
      globalThis.fixture.data.usage = null;
      const unavailableUsage = render('zh');

      globalThis.fixture.data.callers = [];
      const empty = render('en');
      globalThis.fixture.data.runtime = { state: 'unknown' };
      const unknown = render('en');
      globalThis.fixture.data.runtime = { state: 'stopped' };
      const stopped = render('zh');
      globalThis.fixture.data.runtime = { state: 'running', listening: true, configurationValid: true, active: 4, waiting: 2, uploading: 1, oldestWaitMs: 1200, queueTimeouts: 3, capture: { enabled: true, state: 'ready', active: 2, skippedCapacity: 1 }, metrics: { accepted: 10, unconfirmed: 2, rejected: 1, localDropped: 3 } };
      globalThis.fixture.loading = true;
      const refreshing = render('en');
      globalThis.fixture.loading = false;
      globalThis.fixture.error = "load failed";
      const failed = render("en");
      globalThis.editingFixture = 'new';
      globalThis.fixture.error = null;
      const recovered = render("en");
      globalThis.fixture.actionError = 'stale';
      globalThis.fixture.actionErrorCode = 'stale-revision';
      const editorError = render('en');
      globalThis.editingFixture = { caller_id: 'translation', key_id: 'translation-key', display_name: '中文用途', models: ['clp-main/deepseek-v4.1-flash'], reasoning: 'off' };
      globalThis.fixture.actionError = null;
      globalThis.fixture.data.callers = [globalThis.editingFixture];
      globalThis.fixture.data.revision = 'new-revision';
      const staleEditor = render('en');
      globalThis.draftRevisionFixture = 'new-revision';
      const unavailableEditor = render('en');
      globalThis.fixture.data.providers = [{ id: 'clp-main', available: true, protocols: ['chat'], models: [{ id: 'cline-pass/deepseek-v4.1-flash', relayId: 'clp-main/deepseek-v4.1-flash', reasoningOff: true, inputModalities: ['text', 'image', 'audio'] }] }];
      const availableEditor = render('en');
      const availableZh = render('zh');
      globalThis.fixture.data.providers[0].protocols = ['chat', 'responses'];
      const dual = render('en');
      globalThis.fixture.data.providers[0].models[0].inputModalities = [];
      const unknownInputs = render('en');
      globalThis.fixture.data.providers[0].models.push({id:'cline-pass/muse',relayId:'clp-main/muse',reasoningOff:false,inputModalities:[]});
      const mixedReasoning = render('en');
      globalThis.fixture.data.providers.push({id:'rs-main',available:true,protocols:['responses'],models:[{id:'other',relayId:'rs-main/other',reasoningOff:true,inputModalities:['text']}]});
      globalThis.editingFixture.models.push('rs-main/other');
      const multiProvider = render('en');
      globalThis.editingFixture.reasoning='passthrough';
      const allModels = render('en');
      console.log(JSON.stringify({ allModels, multiProvider, unavailableUsage, zh, en, empty, unknown, stopped, refreshing, recovered, failed, editorError, staleEditor, unavailableEditor, availableEditor, availableZh, dual, unknownInputs, mixedReasoning }));
    } finally { await server.close(); }
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
  })) as { allModels: string; multiProvider: string; unavailableUsage: string; refreshing: string; recovered: string; unknown: string; stopped: string; zh: string; en: string; empty: string; failed: string; editorError: string; staleEditor: string; unavailableEditor: string; availableEditor: string; availableZh: string; dual: string; unknownInputs: string; mixedReasoning: string };
}

function assertRelayPage(result: ReturnType<typeof renderRelayPageFixture>): void {
  for (const id of ['clp-main/deepseek-v4.1-flash', 'rs-main/other']) {
    expect(result.multiProvider).toMatch(new RegExp('aria-label="' + id + '"[^>]*aria-checked="true"|aria-checked="true"[^>]*aria-label="' + id + '"'));
  }
  expect(result.multiProvider).toContain('Responses');
  expect(result.zh).toMatch(/<th[^>]*>凭据轮换<\/th>/u);
  expect(result.en).toContain("Credential rotation");
  expect(result.zh).toContain("复制模型 ID");
  expect(result.en).toContain("Copy model ID");
  expect(result.zh).toContain("沉浸式翻译 的更多操作");
  expect(result.en).toContain("More actions for 沉浸式翻译");
  expect(result.zh).not.toContain(">轮换并启用</button>");
  expect(result.zh).toContain("17 次调用"); expect(result.zh).toContain("3 次未成功");
  expect(result.zh).toContain("暂无记录"); expect(result.zh).toContain("0 次调用");
  expect(result.en).toContain("Calls: 17"); expect(result.en).toContain("Unsuccessful: 3");
  expect(result.unavailableUsage).toContain("暂不可用"); expect(result.unavailableUsage).not.toContain("0 次调用");
  for (const text of ["调用采集", "指标交付", "队列与采集状态", "最早等待", "排队超时"]) expect(result.zh).not.toContain(text);
  for (const text of ["Traffic capture", "Metric delivery", "Queue and capture status"]) expect(result.en).not.toContain(text);
  expect(result.zh).not.toContain("请求队列");
  expect(result.zh).toContain("配置并发上限 10");
  expect(result.unknown).toContain("Runtime status unconfirmed"); expect(result.unknown).not.toContain("Waiting 0");
  expect(result.stopped).toContain("服务未运行");
  expect(result.refreshing).toContain("Refreshing runtime status");
  expect(result.failed).toContain("Runtime status unconfirmed");
  for (const stale of [result.refreshing, result.failed]) {
    for (const text of ["Capture ready", "Capacity skips", "Oldest wait", ">Listening<", ">Processing</dt>", ">Waiting</dt>", ">Receiving</dt>", "Configured concurrency limit 10", "Configuration enabled"]) expect(stale).not.toContain(text);
  }
  expect(result.recovered).toContain(">Listening<");

  expect(result.zh).toContain("沉浸式翻译"); expect(result.zh).toContain("强制关闭"); expect(result.zh).toContain("跟随客户端");
  expect(result.zh).toContain("callerId=translation"); expect(result.zh).toContain("callerId=kelivo");
  expect(result.mixedReasoning).toContain("may still reason");
  const offOption = result.mixedReasoning.match(/<button[^>]*>Force off \(supported models\)<\/button>/u)?.[0];
  expect(offOption).toBeDefined();
  expect(offOption).not.toMatch(/ disabled(?:=|\s|>)/u);
  expect(result.en).toContain("Force off"); expect(result.en).toContain("Follow client");
  expect(result.en).not.toContain("强制关闭");
  expect(result.zh).not.toContain(">删除</button>");
  expect(result.en).not.toContain(">Delete</button>");
  expect(result.empty).toContain("No keys yet");
  expect(result.zh).not.toContain("cr1.");
  expect(result.failed).toMatch(/<button(?![^>]* disabled=)[^>]*>Refresh<\/button>/u);
  expect(result.failed).toMatch(/<button[^>]*disabled=[^>]*>Create key<\/button>/u);
  const dialog = result.editorError.split('<section role="dialog">')[1]!;
  expect(dialog).toContain('role="alert"');
  expect(dialog).toContain('Refresh');
  expect(dialog).toContain('relay-name');
  expect(result.staleEditor).toContain('Reload and discard draft');
  expect(result.staleEditor).toMatch(/<button[^>]* disabled=[^>]*>Preview change<\/button>/u);
  expect(result.unavailableEditor).toContain('Unavailable');
  expect(result.unavailableEditor).not.toContain('This model selection does not support force off');
  expect(result.unavailableEditor).not.toContain('data-invalid="true"');
  expect(result.unavailableEditor).toMatch(/<button[^>]* disabled=[^>]*>Preview change<\/button>/u);
  for (const label of ['Protocol', '>Chat<']) expect(result.availableEditor).toContain(label);
  for (const label of ['模型转发']) expect(result.availableZh).toContain(label);
  expect(result.dual).toContain('>Responses<');
  expect(result.availableEditor).toContain('Only models with declared reasoning-off support');
  expect(result.mixedReasoning).not.toContain('aria-label="clp-main/muse"');
  expect(result.allModels).toContain('aria-label="clp-main/muse"');
  expect(result.availableEditor).toContain('role="checkbox"');
}

describe("Relay queue and service presentation", () => {
  let fixture: ReturnType<typeof renderRelayQueueAndServiceFixture>;
  beforeAll(() => { fixture = renderRelayQueueAndServiceFixture(); }, 35_000);

  it("uses a queue table and shared loading, empty and unavailable components", () => {
    const result = fixture.queue;
    expect(result.disabled).toContain("Relay 已停用");
    expect(result.disabled).toContain("long/model");
    expect(result.invalid).toContain("当前运行配置不可用");
    expect(result.notListening).toContain("Relay is not listening");
    expect(result.ready).toContain("请求模型");
    const headers = (html: string) => [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gu)].map(match => match[1]?.replace(/<[^>]*>/gu, ""));
    expect(headers(result.ready!)).toEqual(["调用方 ID", "请求模型", "思考", "阶段", "已耗时"]);
    expect(result.ready).toMatch(/<td\b[^>]*>high<\/td>/u);
    expect(result.missingEffort).toMatch(/<td\b[^>]*>—<\/td>/u);
    expect(result.unknownEffort).toMatch(/<td\b[^>]*>future<\/td>/u);
    expect(headers(result.englishEffort!)).toContain("Reasoning");
    expect(result.ready).toMatch(/<h1[^>]*>请求队列<\/h1>/u);
    expect(result.ready).not.toContain('role="dialog"');
    expect(result.loading).toContain('data-slot="skeleton"');
    expect(result.empty).toContain("No model requests in progress");
    expect(result.unknown).toContain('data-slot="alert"');
    expect(result.ready).toContain('data-slot="card"');
    expect(result.ready).toContain("中文用途");
    expect(result.ready).toContain("long/model");
    expect(result.ready).toContain("Responses");
    expect(result.ready).toContain("等待名额");
    expect(result.ready).toContain("<table");
    expect(result.failed).not.toContain("long/model");
  });

  it("scopes relay service controls and task feedback without bypassing the global task lock", () => {
    const result = fixture.services;
    expect(result.running).toContain("重启");
    expect(result.running).toContain("停止");
    expect(result.running).not.toContain("gateway");
    expect(result.running).not.toContain("安装全部服务");
    expect(result.running).not.toContain("卸载全部服务");
    expect(result.running).toContain("service:restart:model-relay");
    expect(result.busy).toContain("其他管理任务正在执行");
    expect(result.busy).toContain('href="/settings/services"');
    expect(result.busy.match(/<button[^>]*disabled/g)).toHaveLength(2);
    expect(result.stopped).toContain("启动");
    expect(result.stopped).not.toMatch(/>重启<|>停止</u);
  });
});

function renderRelayQueueAndServiceFixture() {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router';
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', plugins: [{
      name: 'queue-fixture', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/hooks/use-relay-queue.ts')) return 'export function useRelayQueue() { return globalThis.queue; }';
      }
    }] });
    try {
      const {LanguageContext}=await server.ssrLoadModule('/src/hooks/language-context.ts');
      async function renderQueueScenario() {
        const {RelayQueuePage}=await server.ssrLoadModule('/src/pages/relay-queue-page.tsx');
        const {TooltipProvider}=await server.ssrLoadModule('/src/components/ui/tooltip.tsx');
        const render=language=>renderToStaticMarkup(h(LanguageContext.Provider,{value:{language,setLanguage(){}}},h(TooltipProvider,null,h(RelayQueuePage))));
        globalThis.queue={data:null,loading:true,error:null,errorCode:null,refetch(){}};
        const loading=render('zh');
        globalThis.queue={...globalThis.queue,loading:false,data:{state:'running',configurationValid:true,enabled:true,listening:true,requests:[]}};
        const empty=render('en');
        globalThis.queue.data={state:'unknown'}; const unknown=render('zh');
        globalThis.queue.data={state:'running',configurationValid:true,enabled:true,listening:true,requests:[{requestId:'id',callerId:'client',displayName:'中文用途',provider:'clp-test',model:'long/model',reasoningEffort:'high',protocol:'responses',phase:'queue',elapsedMs:2000}]};
        const ready=render('zh');
        const englishEffort=render('en');
        globalThis.queue.data.requests[0].reasoningEffort=null; const missingEffort=render('zh');
        globalThis.queue.data.requests[0].reasoningEffort='future'; const unknownEffort=render('zh');
        globalThis.queue.data.enabled=false; globalThis.queue.data.listening=false; const disabled=render('zh');
        globalThis.queue.data.configurationValid=false; const invalid=render('zh');
        globalThis.queue.data.configurationValid=true; globalThis.queue.data.enabled=true; const notListening=render('en');

        globalThis.queue.error='unavailable'; const failed=render('zh');
        return {loading,empty,unknown,ready,failed,disabled,invalid,notListening,englishEffort,missingEffort,unknownEffort};
      }
      async function renderServiceScenario() {
        const {ManagedServices} = await server.ssrLoadModule('/src/components/settings/managed-services.tsx');
        const services = {platform:'systemd',entries:['gateway','model-relay'].map(target => ({target,name:target,loaded:true,running:true,state:'running',pid:123,version:'test',recentError:null}))};
        const tasks = {loading:false,error:null,saving:false,pendingPreview:null,tasks:[{id:'other',operation:'service',action:'restart',target:'gateway',state:'completed'},{id:'relay',operation:'service',action:'restart',target:'model-relay',state:'completed'}]};
        const render = () => renderToStaticMarkup(h(MemoryRouter,null,h(LanguageContext.Provider,{value:{language:'zh',setLanguage:()=>{}}},h(ManagedServices,{services,tasks,scope:'model-relay'}))));
        const running = render();
        tasks.tasks[0].state = 'running';
        const busy = render();
        tasks.tasks[0].state = 'completed';
        services.entries[1].running = false;
        const stopped = render();
        return {running,busy,stopped};
      }
      console.log(JSON.stringify({queue:await renderQueueScenario(),services:await renderServiceScenario()}));
    } finally {await server.close();}
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
  })) as { queue: Record<string, string>; services: { running: string; busy: string; stopped: string } };
}

it("shows a read-only provider model catalog with refresh errors and no policy controls", () => {
  const script = String.raw`
    import {createServer} from 'vite';
    import {createElement as h} from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    const server = await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'silent',plugins:[{
      name:'model-dialog-fixture',enforce:'pre',transform(code,id) {
        if(id.endsWith('/settings/relay-provider-models.tsx')) return code.replace('useState<string | null>(null)','useState<string | null>(globalThis.providerId ?? null)');
        if(id.endsWith('/components/ui/dialog.tsx')) return "import {createElement as h} from 'react'; export const Dialog=({open,children})=>open?children:null; export const DialogContent=({children})=>h('section',{role:'dialog'},children); export const DialogHeader=({children})=>h('header',null,children); export const DialogTitle=({children})=>h('h2',null,children); export const DialogDescription=({children})=>h('p',null,children); export const DialogFooter=({children})=>h('footer',null,children);";
      }
    }]});
    try {
      const {RelayProviderModels}=await server.ssrLoadModule('/src/components/settings/relay-provider-models.tsx');
      const {LanguageContext}=await server.ssrLoadModule('/src/hooks/language-context.ts');
      const snapshot={revision:'current',callers:[],providers:[
        {id:'clp-main',available:true,models:[{id:'model/a',relayId:'clp-main/model/a',inputModalities:['text','image','audio','video','pdf']},{id:'model/b',relayId:'clp-main/model/b',inputModalities:[]}]},
        {id:'ds-main',available:true,models:[]}
      ]};
      const render=(language='en',confirmationOpen=false)=>renderToStaticMarkup(h(LanguageContext.Provider,{value:{language,setLanguage(){}}},h(RelayProviderModels,{snapshot,blocked:!!globalThis.loadFailed,refreshBlocked:!!globalThis.refreshing,error:globalThis.modelError,onRefresh(){},confirmationOpen,onSubmit(){}})));
      const list=render();
      globalThis.providerId='clp-main';
      const editor=render('zh'), english=render();
      const confirming=render('en',true);
      globalThis.modelError='Reload required';globalThis.loadFailed=true;const refreshError=render();
      globalThis.refreshing=true;const refreshingError=render();
      globalThis.refreshing=false;globalThis.loadFailed=false;globalThis.modelError=null;
      snapshot.revision='changed';const stale=render();
      console.log(JSON.stringify({list,editor,english,confirming,stale,refreshError,refreshingError}));
    } finally {await server.close();}
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as Record<string, string>;
  expect(result.list).toContain("Provider models");
  expect(result.list).toContain("clp-main"); expect(result.list).toContain("ds-main");
  expect(result.list).toContain("Model list"); expect(result.list).not.toContain('role="dialog"');
  expect(result.list).not.toContain("model/a");
  expect(result.editor).toContain('role="dialog"');
  for (const label of ["model/a", "model/b", "文本", "图片", "音频", "视频", "PDF", "未声明"]) expect(result.editor).toContain(label);
  expect(result.editor).not.toContain('role="switch"');
  expect(result.editor).not.toContain('role="checkbox"');
  expect(result.english).toContain('This catalog is read-only');
  const refreshButton = result.refreshError?.match(/<button[^>]*>Refresh<\/button>/u)?.[0];
  expect(refreshButton).toBeDefined();
  expect(refreshButton).not.toContain(' disabled=""');
  const cancelButton = result.refreshError?.match(/<button[^>]*>Close<\/button>/u)?.[0];
  expect(cancelButton).toBeDefined();
  expect(cancelButton).not.toContain(' disabled=""');
  expect(result.refreshingError).toMatch(/<button[^>]* disabled=""[^>]*>Refresh<\/button>/u);
  expect(result.stale).not.toContain("Reload and discard draft");
  expect(result.stale).not.toContain("Preview model settings");
});
