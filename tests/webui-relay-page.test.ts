import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("renders the real Relay page with per-key policy, exact caller links and localized empty state", () => {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router';
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', plugins: [{
      name: 'relay-fixture', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/pages/relay-page.tsx')) return code
          .replace('useState<"new" | RelayManagedCaller | null>(null)', 'useState<"new" | RelayManagedCaller | null>(globalThis.editingFixture ?? null)')
          .replace('useState<string | null>(null)', 'useState<string | null>(globalThis.draftRevisionFixture ?? "r")')
          .replace('const [name, setName] = useState("")', 'const [name, setName] = useState(globalThis.editingFixture?.display_name ?? "")')
          .replace('const [provider, setProvider] = useState("")', 'const [provider, setProvider] = useState(globalThis.editingFixture?.provider ?? "")')
          .replace('useState<string[]>([])', 'useState<string[]>(globalThis.editingFixture?.models ?? [])')
          .replace('useState<RelayReasoning>("passthrough")', 'useState<RelayReasoning>(globalThis.editingFixture?.reasoning ?? "passthrough")');
        if (id.endsWith('/components/ui/dialog.tsx')) return "import { createElement as h } from 'react';           export const Dialog = ({open, children}) => open ? children : null;           export const DialogContent = ({children}) => h('section', {role:'dialog'}, children);           export const DialogHeader = ({children}) => h('header', null, children);           export const DialogTitle = ({children}) => h('h2', null, children);           export const DialogDescription = ({children}) => h('p', null, children);           export const DialogFooter = ({children}) => h('footer', null, children);";
        if (id.endsWith('/hooks/use-relay-service-management.ts')) return 'export function useRelayServiceManagement(refresh, busy) { return {refresh,refreshBlocked:busy,services:{data:null,loading:false,error:null},tasks:{tasks:[],error:null,actionError:null,pendingPreview:null}}; }';
        if (id.endsWith('/hooks/use-relay-management.ts')) return 'export function useRelayManagement() { return globalThis.fixture; }';
      }
    }] });
    try {
      const { RelayPage } = await server.ssrLoadModule('/src/pages/relay-page.tsx');
      const { LanguageContext } = await server.ssrLoadModule('/src/hooks/language-context.ts');
      const noop = () => {};
      globalThis.fixture = { busy: false, loading: false, error: null, actionError: null, pendingPreview: null, refetch: noop,
        data: { enabled: true, maxConcurrency: 10, runtime: { state: 'running', listening: true, configurationValid: true, active: 4, waiting: 2, uploading: 1, oldestWaitMs: 1200, queueTimeouts: 3, capture: { enabled: true, state: 'ready', active: 2, skippedCapacity: 1 }, metrics: { accepted: 10, unconfirmed: 2, rejected: 1, localDropped: 3 } }, revision: 'r', providers: [], callers: [
          { caller_id: 'translation', display_name: '沉浸式翻译', key_id: 'key-a', credential_generation: 2, enabled: true, provider: 'clp-main', models: ['cline-pass/deepseek-v4.1-flash'], reasoning: 'off' },
          { caller_id: 'kelivo', key_id: 'key-b', credential_generation: 1, enabled: false, provider: 'clp-main', models: ['cline-pass/deepseek-v4.1-flash'], reasoning: 'passthrough' }
        ] }
      };
      const render = language => renderToStaticMarkup(h(MemoryRouter, null, h(LanguageContext.Provider, { value: { language, setLanguage: noop } }, h(RelayPage))));
      const zh = render('zh'), en = render('en');
      globalThis.fixture.data.runtime.capture.state = 'failed';
      const captureFailed = render('zh');
      globalThis.fixture.data.runtime.capture.enabled = false;
      const captureDisabled = render('zh');
      globalThis.fixture.data.runtime.configurationValid = false;
      const captureUnknown = render('zh');

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
      globalThis.editingFixture = { caller_id: 'translation', key_id: 'translation-key', display_name: '中文用途', provider: 'clp-main', models: ['cline-pass/deepseek-v4.1-flash'], reasoning: 'off' };
      globalThis.fixture.actionError = null;
      globalThis.fixture.data.callers = [globalThis.editingFixture];
      globalThis.fixture.data.revision = 'new-revision';
      const staleEditor = render('en');
      globalThis.draftRevisionFixture = 'new-revision';
      const unavailableEditor = render('en');
      globalThis.fixture.data.providers = [{ id: 'clp-main', available: true, protocols: ['chat'], models: [{ id: 'cline-pass/deepseek-v4.1-flash', reasoningOff: true, inputModalities: ['text', 'image', 'audio'] }] }];
      const availableEditor = render('en');
      const availableZh = render('zh');
      globalThis.fixture.data.providers[0].protocols = ['chat', 'responses'];
      const dual = render('en');
      globalThis.fixture.data.providers[0].models[0].inputModalities = [];
      const unknownInputs = render('en');
      console.log(JSON.stringify({ captureFailed, captureDisabled, captureUnknown, zh, en, empty, unknown, stopped, refreshing, recovered, failed, editorError, staleEditor, unavailableEditor, availableEditor, availableZh, dual, unknownInputs }));
    } finally { await server.close(); }
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as { captureFailed: string; captureDisabled: string; captureUnknown: string; refreshing: string; recovered: string; unknown: string; stopped: string; zh: string; en: string; empty: string; failed: string; editorError: string; staleEditor: string; unavailableEditor: string; availableEditor: string; availableZh: string; dual: string; unknownInputs: string };
  expect(result.captureFailed).toContain("采集故障"); expect(result.captureDisabled).toContain("采集未开启");
  expect(result.captureUnknown).toContain("采集状态未确认"); expect(result.captureUnknown).not.toContain("采集未开启");
  expect(result.zh).toMatch(/<th[^>]*>凭据轮换<\/th>/u);
  expect(result.en).toContain("Credential rotation");
  expect(result.zh).toContain("配置并发上限 10"); expect(result.zh).toMatch(/>处理中<\/dt><dd[^>]*>4<\/dd>/u);
  expect(result.en).toContain("Oldest wait 1.2 s"); expect(result.en).toMatch(/>Capacity skips<\/dt><dd[^>]*>1<\/dd>/u); expect(result.en).toMatch(/>Unconfirmed<\/dt><dd[^>]*>2<\/dd>/u);
  expect(result.zh).toContain("采集已就绪"); expect(result.zh).toContain("排队超时 3 次");
  expect(result.en).toMatch(/>Waiting<\/dt><dd[^>]*>2<\/dd>/u); expect(result.en).toMatch(/>Receiving<\/dt><dd[^>]*>1<\/dd>/u);
  expect(result.unknown).toContain("Runtime status unconfirmed"); expect(result.unknown).not.toContain("Waiting 0");
  expect(result.stopped).toContain("服务未运行");
  expect(result.refreshing).toContain("Refreshing runtime status");
  expect(result.failed).toContain("Runtime status unconfirmed");
  for (const stale of [result.refreshing, result.failed]) {
    for (const text of ["Capture ready", "Capacity skips", "Oldest wait", ">Listening<", ">Processing</dt>", ">Waiting</dt>", ">Receiving</dt>", "Configured concurrency limit 10", "Configuration enabled"]) expect(stale).not.toContain(text);
  }
  expect(result.recovered).toContain(">Listening<"); expect(result.recovered).toMatch(/>Processing<\/dt><dd[^>]*>4<\/dd>/u);

  expect(result.zh).toContain("沉浸式翻译"); expect(result.zh).toContain("强制关闭"); expect(result.zh).toContain("跟随客户端");
  expect(result.zh).toContain("callerId=translation"); expect(result.zh).toContain("callerId=kelivo");
  expect(result.en).toContain("Force off"); expect(result.en).toContain("Follow client");
  expect(result.en).not.toContain("强制关闭");
  expect(result.zh).toContain(">删除</button>");
  expect(result.en).toContain(">Delete</button>");
  expect(result.availableEditor).toMatch(/<button[^>]*id="relay-provider"[^>]*>/u);
  expect(result.availableEditor.match(/<button[^>]*id="relay-provider"[^>]*>/u)?.[0]).not.toMatch(/ disabled(?:=|\s|>)/u);
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
  expect(result.unavailableEditor).toContain('Upstream model capabilities are temporarily unavailable');
  expect(result.unavailableEditor).not.toContain('This model selection does not support force off');
  expect(result.unavailableEditor).not.toContain('data-invalid="true"');
  expect(result.unavailableEditor).toMatch(/<button(?![^>]* disabled=)[^>]*>Preview change<\/button>/u);
  expect(result.availableEditor).toContain('Native protocols: Chat Completions');
  for (const label of ['Protocol', '>Chat<', '>Text<', '>Image<', '>Audio<']) expect(result.availableEditor).toContain(label);
  for (const label of ['模型转发', '>文本<', '>图片<', '>音频<']) expect(result.availableZh).toContain(label);
  expect(result.dual).toContain('>Responses<');
  expect(result.unknownInputs).toContain('>Not declared<');
  expect(result.unavailableEditor).toContain('>Not declared<');
});

it("uses a queue table and shared loading, empty and unavailable components", () => {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', plugins: [{
      name: 'queue-fixture', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/requests/relay-queue-sheet.tsx')) return code.replace('useState(false)', 'useState(true)');
        if (id.endsWith('/hooks/use-relay-queue.ts')) return 'export function useRelayQueue() { return globalThis.queue; }';
        if (id.endsWith('/ui/sheet.tsx')) return "import {createElement as h} from 'react'; export const Sheet=({children})=>children; export const SheetTrigger=({children})=>children; export const SheetContent=({children})=>h('section',{role:'dialog'},children); export const SheetHeader=({children})=>h('header',null,children); export const SheetTitle=({children})=>h('h2',null,children); export const SheetDescription=({children})=>h('p',null,children);";
      }
    }] });
    try {
      const {RelayQueueSheet}=await server.ssrLoadModule('/src/components/requests/relay-queue-sheet.tsx');
      const {LanguageContext}=await server.ssrLoadModule('/src/hooks/language-context.ts');
      const {TooltipProvider}=await server.ssrLoadModule('/src/components/ui/tooltip.tsx');
      const render=language=>renderToStaticMarkup(h(LanguageContext.Provider,{value:{language,setLanguage(){}}},h(TooltipProvider,null,h(RelayQueueSheet))));
      globalThis.queue={data:null,loading:true,error:null,errorCode:null,refetch(){}};
      const loading=render('zh');
      globalThis.queue={...globalThis.queue,loading:false,data:{state:'running',configurationValid:true,enabled:true,listening:true,requests:[]}};
      const empty=render('en');
      globalThis.queue.data={state:'unknown'}; const unknown=render('zh');
      globalThis.queue.data={state:'running',configurationValid:true,enabled:true,listening:true,requests:[{requestId:'id',callerId:'client',displayName:'中文用途',provider:'clp-test',model:'long/model',protocol:'responses',phase:'queue',elapsedMs:2000}]};
      const ready=render('zh');
      globalThis.queue.data.enabled=false; globalThis.queue.data.listening=false; const disabled=render('zh');
      globalThis.queue.data.configurationValid=false; const invalid=render('zh');
      globalThis.queue.data.configurationValid=true; globalThis.queue.data.enabled=true; const notListening=render('en');

      globalThis.queue.error='unavailable'; const failed=render('zh');
      console.log(JSON.stringify({loading,empty,unknown,ready,failed,disabled,invalid,notListening}));
    } finally { await server.close(); }
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as Record<string, string>;
  expect(result.disabled).toContain("Relay 已停用");
  expect(result.disabled).toContain("long/model");
  expect(result.invalid).toContain("当前运行配置不可用");
  expect(result.notListening).toContain("Relay is not listening");
  expect(result.ready).toContain("请求模型");
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
  const script = String.raw`
    import {createServer} from 'vite';
    import {createElement as h} from 'react';
    import {renderToStaticMarkup} from 'react-dom/server';
    import {MemoryRouter} from 'react-router';
    const server = await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'silent'});
    try {
      const {ManagedServices} = await server.ssrLoadModule('/src/components/settings/managed-services.tsx');
      const {LanguageContext} = await server.ssrLoadModule('/src/hooks/language-context.ts');
      const services = {platform:'systemd',entries:['gateway','model-relay'].map(target => ({target,name:target,loaded:true,running:true,state:'running',pid:123,version:'test',recentError:null}))};
      const tasks = {loading:false,error:null,saving:false,pendingPreview:null,tasks:[{id:'other',operation:'service',action:'restart',target:'gateway',state:'completed'},{id:'relay',operation:'service',action:'restart',target:'model-relay',state:'completed'}]};
      const render = () => renderToStaticMarkup(h(MemoryRouter,null,h(LanguageContext.Provider,{value:{language:'zh',setLanguage:()=>{}}},h(ManagedServices,{services,tasks,scope:'model-relay'}))));
      const running = render();
      tasks.tasks[0].state = 'running';
      const busy = render();
      tasks.tasks[0].state = 'completed';
      services.entries[1].running = false;
      const stopped = render();
      console.log(JSON.stringify({running,busy,stopped}));
    } finally {await server.close();}
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as {running:string;busy:string;stopped:string};
  expect(result.running).toContain("重启");
  expect(result.running).toContain("停止");
  expect(result.running).not.toContain("gateway");
  expect(result.running).not.toContain("安装全部服务");
  expect(result.running).not.toContain("卸载全部服务");
  expect(result.running).toContain("service:restart:model-relay");
  expect(result.busy).toContain("其他管理任务正在执行");
  expect(result.busy).toContain('href="/settings"');
  expect(result.busy.match(/<button[^>]*disabled/g)).toHaveLength(2);
  expect(result.stopped).toContain("启动");
  expect(result.stopped).not.toMatch(/>重启<|>停止</u);
});
