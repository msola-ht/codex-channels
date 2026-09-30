import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("renders localized queue states, retry eligibility, missing and error views without stale rows", () => {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', plugins: [{
      name: 'delivery-fixture', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/hooks/use-delivery-queue.ts')) return 'export function useDeliveryQueue() { return globalThis.fixture; } export function useDeliveryContents() { return { data: new Map(globalThis.fixture.data?.records.map(row => [JSON.stringify([row.id, row.revision]), { content: { type: "text.completed", text: "visible message summary", status: null }, error: false }]) ?? []), error: null }; }';
      }
    }] });
    try {
      const { DeliveryPage } = await server.ssrLoadModule('/src/pages/delivery-page.tsx');
      const { TooltipProvider } = await server.ssrLoadModule('/src/components/ui/tooltip.tsx');
      const { navItems } = await server.ssrLoadModule('/src/lib/navigation.ts');
      const { LanguageContext } = await server.ssrLoadModule('/src/hooks/language-context.ts');
      const { setServerTimeZone } = await server.ssrLoadModule('/src/lib/format.ts');
      setServerTimeZone('UTC');
      const noop = () => {};
      const records = ['pending', 'sending', 'uncertain', 'blocked'].map((state, index) => ({
        id: 'record-' + index, account: '["telegram","main"]', conversation: '["telegram","main","chat"]', state,
        createdAt: 1700000000000, sequence: index + 1, attempt: 1, bytes: 70000, confirmed: 1, checkpoints: 2, revision: 'r'
      }));
      globalThis.fixture = { busy: false, loading: false, error: null, errorCode: null, actionError: null, pendingPreview: null, result: null,
        refetch: noop, cancel: noop, mutate: noop, confirm: noop,
        data: { state: 'available', observedAt: 1700000000000, summary: { records: 4, bytes: 280000, pending: 1, sending: 1, uncertain: 1, blocked: 1 }, records, nextCursor: null }
      };
      const render = language => renderToStaticMarkup(h(LanguageContext.Provider, { value: { language, setLanguage: noop } }, h(TooltipProvider, null, h(DeliveryPage))));
      const zh = render('zh'), en = render('en');
      globalThis.fixture.loading = true;
      const refreshing = render('zh');
      globalThis.fixture.loading = false; globalThis.fixture.busy = true;
      const preparing = render('en');
      globalThis.fixture.busy = false;
      globalThis.fixture.result = { result: 'pending', cleanupStatus: 'unconfirmed', auditStatus: 'failed' };
      const cleanupFailed = render('zh');
      globalThis.fixture.result = null;
      globalThis.fixture.error = 'SECRET INTERNAL ERROR'; globalThis.fixture.errorCode = 'delivery_unavailable';
      const failed = render('zh');
      globalThis.fixture.error = null; globalThis.fixture.data = { state: 'missing', observedAt: 1700000000000, summary: null, records: [], nextCursor: null };
      const missing = render('zh');
      globalThis.fixture.data.state = 'available';
      const empty = render('zh');
      console.log(JSON.stringify({ zh, en, refreshing, preparing, failed, missing, empty, cleanupFailed, navigation: navItems.find(item => item.to === '/delivery')?.labelKey }));
    } finally { await server.close(); }
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as Record<string, string>;
  expect(result.zh).toContain("telegram · main");
  expect(result.zh).toMatch(/<table[^>]*aria-label="投递列表"/u);
  expect(result.zh?.match(/data-slot="table-row"/gu)).toHaveLength(5);
  expect(result.zh).toContain("目标会话");
  expect(result.en).toContain("Target conversation");
  expect(result.zh).toContain('data-slot="card"');
  expect(result.refreshing).toContain("正在刷新");
  expect(result.refreshing).toContain('data-slot="spinner"');
  expect(result.preparing).toContain("Preparing confirmation");
  expect(result.navigation).toBe("delivery.title");
  expect(result.zh).toMatch(/<h1[^>]*>渠道投递队列<\/h1>/u);
  expect(result.zh).toContain("授权阻塞");
  expect(result.zh).toContain("结果未知");
  expect(result.zh?.match(/>重试投递<\/button>/gu)).toHaveLength(2);
  expect(result.en?.match(/>Retry delivery<\/button>/gu)).toHaveLength(2);
  expect(result.en).toContain("Authorization blocked");
  expect(result.zh).not.toContain("2 个检查点事件，1 次确认");
  expect(result.zh).not.toContain("record-0</");
  expect(result.zh).not.toContain(">详情</button>");
  expect(result.zh).toContain("内容摘要");
  expect(result.zh).toContain("visible message summary");
  expect(result.en).toContain("Text response");
  expect(result.failed).toContain("投递队列暂不可读取");
  expect(result.failed).not.toContain("record-0");
  expect(result.failed).not.toContain("SECRET");
  expect(result.missing).toContain("投递箱尚未创建");
  expect(result.missing).not.toContain("全局 0 条");
  expect(result.empty).toContain("当前筛选下没有未确认");
  expect(result.cleanupFailed).toContain("投递维护进程关闭未确认");
  expect(result.cleanupFailed).toContain("审计记录写入失败");
  expect(result.cleanupFailed).not.toContain("codexc service start gateway");
});

it("treats lost retry responses as unconfirmed while preserving definite server rejections", () => {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', plugins: [{
      name: 'capture-delivery-mutation', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/hooks/use-management-confirmed-mutation.ts')) return 'export function useManagementConfirmedMutation(options) { globalThis.options = options; return {refetch:()=>{},loading:false,busy:false,pendingPreview:null}; }';
      }
    }] });
    try {
      const { useDeliveryQueue } = await server.ssrLoadModule('/src/hooks/use-delivery-queue.ts');
      function Probe() { useDeliveryQueue(0, 'all'); return null; }
      renderToStaticMarkup(h(Probe));
      const apply = () => globalThis.options.apply({id:'record',revision:'revision'}, 'token').then(()=>'success', error=>error.code);
      globalThis.fetch = async () => { throw new TypeError('Connection lost after commit'); };
      const network = await apply();
      globalThis.fetch = async () => new Response(JSON.stringify({error:{code:'http_error',message:'Proxy failed'}}), {status:502});
      const proxy = await apply();
      globalThis.fetch = async () => new Response(JSON.stringify({error:{code:'delivery_busy',message:'Busy'}}), {status:409});
      const busy = await apply();
      globalThis.fetch = async () => new Response(JSON.stringify({error:{code:'management_audit_unavailable',message:'Audit failed'}}), {status:503});
      const audit = await apply();
      console.log(JSON.stringify({network,proxy,busy,audit}));
    } finally { await server.close(); }
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as Record<string, string>;
  expect(result).toEqual({ network: "delivery_unconfirmed", proxy: "delivery_unconfirmed", busy: "delivery_busy", audit: "management_audit_unavailable" });
});

it("batches inline summaries, reuses revisions and bounds transient retries", () => {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import assert from 'node:assert/strict';
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', plugins: [{
      name: 'capture-summary-loader', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/hooks/use-api.ts')) return 'export function useApi(loader) { globalThis.loadSummaries = loader; return {refetch:()=>{}}; } export function useApiPolling() {}';
      }
    }] });
    try {
      const { useDeliveryContents } = await server.ssrLoadModule('/src/hooks/use-delivery-queue.ts');
      function Probe() { useDeliveryContents(Array.from({length:8}, (_, index) => ({id:String(index),revision:'r'}))); return null; }
      renderToStaticMarkup(h(Probe));
      let active=0, maximum=0, calls=0;
      globalThis.fetch = async () => {
        calls++; active++; maximum=Math.max(maximum,active);
        await new Promise(resolve=>setTimeout(resolve,5)); active--;
        return new Response(JSON.stringify({records:Array.from({length:8},(_,i)=>({id:String(i),revision:'r',content:{type:'text.completed',text:'x'.repeat(160),status:null,truncated:true,threadId:null,turnId:null,imageFormat:null}}))}));
      };
      const signal = new AbortController().signal;
      const first=await globalThis.loadSummaries(signal);
      assert.equal(first.size,8); assert.equal(calls,1); assert.equal(maximum,1);
      for(const value of first.values()) assert.equal(value.content.text.length,160);
      await globalThis.loadSummaries(signal); assert.equal(calls,1);
      const cancelled=new AbortController(); cancelled.abort();
      await assert.rejects(globalThis.loadSummaries(cancelled.signal));
      assert.equal(calls,1);
      renderToStaticMarkup(h(Probe));
      calls=0;
      globalThis.fetch=async()=>{ calls++; return new Response(JSON.stringify({error:{code:'management.rate-limited',message:'limited'}}),{status:429}); };
      const realNow=Date.now;
      let now=realNow(); Date.now=()=>now;
      await globalThis.loadSummaries(signal);
      now+=59_999;
      await globalThis.loadSummaries(signal); assert.equal(calls,1);
      for(let i=0;i<5;i++) { now+=60_000; await globalThis.loadSummaries(signal); }
      assert.equal(calls,3);
      renderToStaticMarkup(h(Probe));
      calls=0;
      globalThis.fetch=async()=>{calls++;if(calls===1) throw new TypeError('offline');return new Response(JSON.stringify({records:Array.from({length:8},(_,i)=>({id:String(i),revision:'r',content:{type:'text.completed',text:'recovered'}}))}));};
      await globalThis.loadSummaries(signal);
      now+=60_000;
      const recovered=await globalThis.loadSummaries(signal);
      assert.equal(calls,2);assert.equal(recovered.get(JSON.stringify(['0','r'])).content.text,'recovered');
      Date.now=realNow;
    } finally { await server.close(); }
  `;
  expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })).not.toThrow();
});
