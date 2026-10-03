import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("renders bilingual logs, loading, missing and error states with escaped text", () => {
  const script = String.raw`
    import { createServer } from 'vite';
    import { createElement as h } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent', plugins: [{
      name: 'logs-fixture', enforce: 'pre', transform(code, id) {
        if (id.endsWith('/hooks/use-service-logs.ts')) return 'export function useServiceLogs() { return globalThis.fixture; }';
      }
    }] });
    try {
      const { LogsPage } = await server.ssrLoadModule('/src/pages/logs-page.tsx');
      const { LanguageContext } = await server.ssrLoadModule('/src/hooks/language-context.ts');
      const { navItems } = await server.ssrLoadModule('/src/lib/navigation.ts');
      const { setServerTimeZone } = await server.ssrLoadModule('/src/lib/format.ts');
      const { getServiceLogs } = await server.ssrLoadModule('/src/lib/api.ts');
      setServerTimeZone('UTC');
      globalThis.fixture = { loading: false, error: null, errorCode: null, refetch() {}, data: {
        target: 'gateway', observedAt: '2026-01-01T00:00:00Z',
        streams: [{ source: 'journal', lines: ['<script>unsafe()</script>', 'connected'], truncated: true, missing: false }]
      } };
      const render = language => renderToStaticMarkup(h(LanguageContext.Provider, { value: { language, setLanguage() {} } }, h(LogsPage)));
      const zh = render('zh'), en = render('en');
      globalThis.fixture.loading = true;
      const refreshing = render('zh');
      globalThis.fixture.loading = false;
      globalThis.fixture.error = 'PRIVATE INTERNAL ERROR'; globalThis.fixture.errorCode = 'logs_unavailable';
      const failed = render('en');
      globalThis.fixture.error = null;
      globalThis.fixture.data.streams = [{source:'stdout',lines:[],truncated:false,missing:true}];
      const missing = render('zh');
      globalThis.fixture.data.streams[0].missing = false;
      const empty = render('en');
      globalThis.fixture.data = null; globalThis.fixture.loading = true;
      const loading = render('en');
      const nativeFetch = globalThis.fetch;
      let requested;
      globalThis.fetch = async (url, options) => { requested = { url, cache: options.cache }; return {ok:true,json:async()=>({})}; };
      try { await getServiceLogs('relay', 100); } finally { globalThis.fetch = nativeFetch; }
      console.log(JSON.stringify({zh,en,refreshing,failed,missing,empty,loading,requested,navigation:navItems.find(item=>item.to==='/logs')?.labelKey}));
    } finally { await server.close(); }
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as Record<string, string> & { requested: { url: string } };
  expect(result.zh).toContain("服务日志");
  expect(result.en).toContain("Service logs");
  expect(result.en).toMatch(/<button(?=[^>]*data-slot="toggle")(?=[^>]*aria-pressed="false")[^>]*>/u);
  expect(result.en).toContain("Showing the tail only");
  expect(result.zh).toContain("&lt;script&gt;");
  expect(result.zh).not.toContain("<script>");
  expect(result.refreshing).toContain("connected");
  expect(result.failed).toContain("Logs are unavailable");
  expect(result.failed).toContain("Data may be out of date");
  expect(result.failed).not.toContain("PRIVATE INTERNAL ERROR");
  expect(result.missing).toContain("尚无此日志文件");
  expect(result.empty).toContain("No logs yet");
  expect(result.loading).not.toContain("connected");
  expect(result.navigation).toBe("logs.title");
  expect(result.requested.url).toBe("/api/v1/logs?target=relay&lines=100");
});
