import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { filterLogEntries, parseLogLine, serviceLogEntries } from "../webui/src/lib/service-logs.js";

let result: Record<string, string> & { requested: { url: string } };
beforeAll(() => {
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
        streams: [{ source: 'journal', lines: ['<script>unsafe()</script>', 'connected', JSON.stringify({time:1767225600000,level:50,module:'delivery',event:'delivery.failed',msg:'Delivery failed',threadId:'thread-1'})].map(MESSAGE => JSON.stringify({MESSAGE})).concat(JSON.stringify({MESSAGE:'Started codex-connect-gateway.service',PRIORITY:'6',SYSLOG_IDENTIFIER:'systemd',__REALTIME_TIMESTAMP:'1791051908000123'})), truncated: true, missing: false }]
      } };
      const render = language => renderToStaticMarkup(h(LanguageContext.Provider, { value: { language, setLanguage() {} } }, h(LogsPage)));
      const zh = render('zh'), en = render('en');
      globalThis.fixture.loading = true;
      const refreshing = render('zh');
      globalThis.fixture.loading = false;
      globalThis.fixture.error = 'PRIVATE INTERNAL ERROR'; globalThis.fixture.errorCode = 'logs_unavailable';
      const failed = render('en');
      globalThis.fixture.error = null;
      globalThis.fixture.data.streams = [{source:'stdout',lines:Array.from({length:100},(_,index)=>JSON.stringify({level:30,time:index,msg:'entry '+index})),truncated:true,missing:false}];
      const hundred = render('zh');
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
      console.log(JSON.stringify({zh,en,refreshing,failed,hundred,missing,empty,loading,requested,navigation:navItems.find(item=>item.to==='/logs')?.labelKey}));
    } finally { await server.close(); }
  `;
  result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
  })) as Record<string, string> & { requested: { url: string } };
}, 35_000);

it("renders bilingual structured logs, loading, missing and error states with escaped text", () => {
  expect(result.zh).toContain("服务日志");
  expect(result.en).toContain("Service logs");
  expect(result.en).not.toContain("More filters");
  expect(result.en).toContain('role="tablist"');
  expect(result.en!.match(/role="tab"/gu)).toHaveLength(4);
  expect(result.en).toContain('role="tabpanel"');
  expect(result.en).not.toContain('id="log-target"');
  expect(result.en).toContain('id="log-search"');
  expect(result.en).toContain('id="log-level"');
  expect(result.en).toContain('id="log-lines"');
  expect(result.en).toContain("4 entries");
  expect(result.en).not.toContain("Showing the tail only");
  expect(result.en).not.toContain("Warnings and errors:");
  expect(result.en).not.toContain("Last successful update:");
  expect(result.en).toContain("Delivery failed");
  expect(result.en).toContain("delivery");
  expect(result.en).toContain("systemd");
  expect(result.en).toContain("Started codex-connect-gateway.service");
  expect(result.en).not.toContain("thread-1"); // Details stay unmounted until expanded.
  expect(result.zh).toContain("4 条");
  expect(result.zh).not.toContain("当前片段");
  expect(result.zh).not.toContain("最后成功更新");
  expect(result.zh).not.toContain("较早内容已省略");
  expect(result.zh).toContain("未识别");
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

it("shows all loaded logs without a second pagination and keeps column controls in the header", () => {
  expect(result.hundred!.match(/<tr\b/gu)).toHaveLength(101);
  expect(result.hundred).toContain("最近日志 · 100 条");
  expect(result.hundred).not.toContain('id="codex-webui:logs-table-v1-page-size"');
  const header = result.hundred!.slice(0, result.hundred!.indexOf('data-slot="card-content"'));
  expect(header).toContain("lucide-columns3");
  expect(result.hundred).toContain('grid-template-rows:minmax(10rem,1fr)');
});

it("parses Pino and timestamped tracing, keeping unknown formats and invalid timestamps explicit", () => {
  const json = '{"time":1767225600000,"level":40,"module":"delivery","msg":"Retry scheduled","attempt":2,"threadId":"thread-1"}';
  expect(parseLogLine(`2026-01-01T01:00:00+00:00 host gateway[42]: ${json}`)).toMatchObject({
    time: 1767225600000, level: "warn", module: "delivery", message: "Retry scheduled", fields: { attempt: 2, threadId: "thread-1" },
  });
  expect(parseLogLine("2026-01-01T00:00:00.123Z ERROR codex_core::stream: Connection closed")).toMatchObject({ level: "error", module: "codex_core::stream", message: "Connection closed" });
  expect(parseLogLine("2026-01-01T00:00:00Z WARN transport: Retry scheduled")).toMatchObject({ level: "warn", module: "transport", message: "Retry scheduled" });
  expect(parseLogLine('2026-01-01T01:00:00+00:00 host webui[42]: {"level":30,"time":"invalid","msg":"Ready"}')).toMatchObject({ time: Date.parse("2026-01-01T01:00:00Z"), level: "info" });
  for (const raw of ["error is mentioned in ordinary text", '{"level":50', '["warning"]', "INFO plain text", "not-a-time ERROR fake: text"]) {
    expect(parseLogLine(raw)).toMatchObject({ time: null, level: "unknown", message: raw, raw });
  }
  expect(parseLogLine('{"time":1e100,"level":99,"msg":"Custom"}')).toMatchObject({ time: null, level: "unknown" });
});

it("merges dated streams, preserves duplicates, and filters severity and correlation fields without guessing stderr severity", () => {
  const snapshot = { target: "gateway" as const, observedAt: "2026-01-01T00:00:00Z", streams: [
    { source: "stdout" as const, truncated: false, missing: false, lines: [
      '{"level":30,"time":100,"msg":"Ready"}', '{"level":40,"time":200,"msg":"Retry","threadId":"THREAD-1"}',
      "duplicate", "duplicate", "plain first", "plain second",
    ] },
    { source: "stderr" as const, truncated: false, missing: false, lines: ['{"level":50,"time":300,"msg":"Failed"}', "ordinary output"] },
  ] };
  const entries = serviceLogEntries(snapshot);
  expect(entries.map(entry => entry.message)).toEqual(["Failed", "Retry", "Ready", "duplicate", "duplicate", "plain first", "plain second", "ordinary output"]);
  expect(new Set(entries.map(entry => entry.id)).size).toBe(entries.length);
  expect(filterLogEntries(entries, "problems", "").map(entry => entry.level)).toEqual(["error", "warn"]);
  expect(filterLogEntries(entries, "warn", "thread-1").map(entry => entry.message)).toEqual(["Retry"]);
  expect(filterLogEntries(entries, "error", "thread-1")).toEqual([]);
  expect(filterLogEntries(entries, "unknown", "")).toHaveLength(5);
});
