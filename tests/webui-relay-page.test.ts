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
        if (id.endsWith('/hooks/use-relay-management.ts')) return 'export function useRelayManagement() { return globalThis.fixture; }';
      }
    }] });
    try {
      const { RelayPage } = await server.ssrLoadModule('/src/pages/relay-page.tsx');
      const { LanguageContext } = await server.ssrLoadModule('/src/hooks/language-context.ts');
      const noop = () => {};
      globalThis.fixture = { busy: false, loading: false, error: null, actionError: null, pendingPreview: null, refetch: noop,
        data: { enabled: true, maxConcurrency: 10, runtime: { state: 'running', listening: true, configurationValid: true, active: 4, waiting: 2, uploading: 1 }, revision: 'r', providers: [], callers: [
          { caller_id: 'translation', display_name: '沉浸式翻译', key_id: 'key-a', credential_generation: 2, enabled: true, provider: 'clp-main', models: ['cline-pass/deepseek-v4.1-flash'], reasoning: 'off' },
          { caller_id: 'kelivo', key_id: 'key-b', credential_generation: 1, enabled: false, provider: 'clp-main', models: ['cline-pass/deepseek-v4.1-flash'], reasoning: 'passthrough' }
        ] }
      };
      const render = language => renderToStaticMarkup(h(MemoryRouter, null, h(LanguageContext.Provider, { value: { language, setLanguage: noop } }, h(RelayPage))));
      const zh = render('zh'), en = render('en');
      globalThis.fixture.data.callers = [];
      const empty = render('en');
      globalThis.fixture.data.runtime = { state: 'unknown' };
      const unknown = render('en');
      globalThis.fixture.data.runtime = { state: 'stopped' };
      const stopped = render('zh');
      globalThis.fixture.data.runtime = { state: 'running', listening: true, configurationValid: true, active: 4, waiting: 2, uploading: 1 };
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
      globalThis.fixture.data.providers = [{ id: 'clp-main', available: true, protocols: ['chat'], models: [{ id: 'cline-pass/deepseek-v4.1-flash', reasoningOff: true }] }];
      const availableEditor = render('en');
      console.log(JSON.stringify({ zh, en, empty, unknown, stopped, refreshing, recovered, failed, editorError, staleEditor, unavailableEditor, availableEditor }));
    } finally { await server.close(); }
  `;
  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8",
  })) as { refreshing: string; recovered: string; unknown: string; stopped: string; zh: string; en: string; empty: string; failed: string; editorError: string; staleEditor: string; unavailableEditor: string; availableEditor: string };
  expect(result.zh).toContain("配置并发上限 10"); expect(result.zh).toContain("处理中 4");
  expect(result.en).toContain("Waiting 2"); expect(result.en).toContain("Receiving 1");
  expect(result.unknown).toContain("Runtime status unconfirmed"); expect(result.unknown).not.toContain("Waiting 0");
  expect(result.stopped).toContain("服务未运行");
  expect(result.refreshing).toContain("Refreshing runtime status");
  expect(result.failed).toContain("Runtime status unconfirmed");
  for (const stale of [result.refreshing, result.failed]) {
    for (const text of [">Listening<", "Processing 4", "Waiting 2", "Receiving 1", "Configured concurrency limit 10", "Relay configuration is enabled."]) expect(stale).not.toContain(text);
  }
  expect(result.recovered).toContain(">Listening<"); expect(result.recovered).toContain("Processing 4");

  expect(result.zh).toContain("沉浸式翻译"); expect(result.zh).toContain("强制关闭"); expect(result.zh).toContain("跟随客户端");
  expect(result.zh).toContain("callerId=translation"); expect(result.zh).toContain("callerId=kelivo");
  expect(result.en).toContain("Force off"); expect(result.en).toContain("Follow client");
  expect(result.en).not.toContain("强制关闭");
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
});
