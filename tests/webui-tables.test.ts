import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

describe("WebUI metrics table presentation", () => {
  let markup: Record<string, string>;
  beforeAll(() => {
    // Render actual components with the WebUI's existing Vite/React dependencies.
    const script = String.raw`
      import { createServer } from "vite";
      import { createElement as h } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { MemoryRouter } from "react-router";
      const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent",
        plugins: [{ name: "fixture-api-state", enforce: "pre", transform(_code, id) {
          if (id.endsWith("/src/components/traffic/traffic-content.tsx")) return _code.replace("useState(false)", "useState(globalThis.fixtureDisclosureOpen ?? false)");
          if (id.endsWith("/src/hooks/use-api.ts")) return "export function useApi() { return globalThis.fixtureApiState; }";
          if (id.endsWith("/src/hooks/use-metrics-query.ts")) return "export function useMetricsQuery() { return { query: globalThis.fixtureQuery, update() {} }; } export function useMetricsProviders() { return { data: { providers: ['openai'] }, loading: false, error: null }; }";
          if (id.endsWith("/src/components/metrics/query-filters.tsx")) return "import { createElement } from 'react'; export function QueryFilters(props) { return createElement('div', { 'data-query-filters': true, 'data-thread-filters': props.showThreadFilters }); }";
        } }],
      });
      try {
        const { AccountSettingsManagement } = await server.ssrLoadModule("/src/components/settings/account-settings-management.tsx");
        const { AccountIdField } = await server.ssrLoadModule("/src/components/settings/account-id-field.tsx");
        const { RequestsTable } = await server.ssrLoadModule("/src/components/requests/requests-table.tsx");
        const { FastBadge } = await server.ssrLoadModule("/src/components/metrics/service-tier.tsx");
        const { ThreadTable } = await server.ssrLoadModule("/src/components/threads/thread-table.tsx");
        const { TurnTable } = await server.ssrLoadModule("/src/components/threads/turn-table.tsx");
        const { TrafficTable } = await server.ssrLoadModule("/src/components/traffic/traffic-table.tsx");
        const { TrafficDetail } = await server.ssrLoadModule("/src/components/traffic/traffic-detail.tsx");
        const { ErrorBanner } = await server.ssrLoadModule("/src/components/metrics/error-banner.tsx");
        const { GlobalCards, ClinePassUsageCard } = await server.ssrLoadModule("/src/components/overview/overview-sections.tsx");
        const { QuerySummary } = await server.ssrLoadModule("/src/components/metrics/query-summary.tsx");
        const { ErrorsPage } = await server.ssrLoadModule("/src/pages/errors-page.tsx");
        const { LanguageContext } = await server.ssrLoadModule("/src/hooks/language-context.ts");
        const { TooltipProvider } = await server.ssrLoadModule("/src/components/ui/tooltip.tsx");
        const { TableHint, TruncatedText } = await server.ssrLoadModule("/src/components/metrics/data-table.tsx");
        const { InputTokenTooltip, OutputTokenTooltip } = await server.ssrLoadModule("/src/components/metrics/token-tooltip.tsx");
        const { setServerTimeZone } = await server.ssrLoadModule("/src/lib/format.ts");
        setServerTimeZone("UTC");
        const noop = () => {};
        const pagination = { mode: "server", pageNumber: 1, pageSize: 10, hasPrevious: false, hasNext: false,
          onPrevious: noop, onNext: noop, onPageSizeChange: noop, onSortingChange: noop,
          sorting: [{ id: "time", desc: true }], serverTotal: 1 };
        const common = { provider: "openai", model: "model-test", recordedAtMs: 1000,
          cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: 0 },
          inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5,
          tokensPerSecond: 20, compact: null, requestCount: 1, unsuccessfulRequestCount: 0 };
        const record = { ...common, status: "failed", requestModel: "model-test", responseModel: "model-other",
          traffic: null, userAgent: "fixture-client", operation: "response", httpStatus: 502,
          errorType: "upstream_error", errorCode: "fixture_error", errorMessage: "fixture failure",
          firstContentMs: 100, totalDurationMs: 1000, upstreamTtftMs: null, cacheHitRate: 0.5 };
        const render = (component, props) => renderToStaticMarkup(h(MemoryRouter, null,
          h(LanguageContext.Provider, { value: { language: "zh", setLanguage: noop } }, h(TooltipProvider, null, h(component, props)))));
        const requestProps = { ...pagination, records: [record], filter: "", total: 1 };
        const exchange = { id: 7, label: "openai", session: "batch-1", startedAtMs: 1000, category: "model", turnStateLengths: [{ source: "http.headers.x-codex-turn-state", characters: 1234 }],
          state: "completed", durationMs: 1000, hasError: false, requestModel: "model-test", responseModels: ["model-test"] };
        const detail = { ...exchange, transport: "http", modelEvidence: { serverModels: [], safetyModels: [], turnStateLengths: [{ source: "http.headers.x-codex-turn-state", characters: 1234 }], truncated: false },
          parameterComparison: [], request: { headers: {}, body: "request-body", parameters: {},
            content: { instructions: null, input: [], tools: [] } }, response: null,
          tracePage: { offset: 0, total: 101, previousOffset: null, nextOffset: 100 },
          trace: [{ atMs: 1000, kind: "fixture-event", text: "old-trace-body", truncated: false }] };
        const accountSettings = {
          observedAt: "fixture", resourceRevision: "fixture",
          opencodeGo: { configured: false, defaultAccountId: null, accounts: [] },
          deepseek: { configured: true, legacyConfigurationPresent: false, accounts: [{ id: "ds-main", default: true, mode: "switching", model: "deepseek-flash" }] },
          clinePass: { configured: true, accounts: [{ id: "clp-main", default: true, mode: "switching", model: "cline-pass/deepseek-v4.1-flash" }] },
        };
        const accountManagement = { settings: accountSettings, loading: false, busy: false, pendingPreview: null,
          actionError: null, error: null, mutate: noop, confirm: noop, cancel: noop, refetch: noop };
        const result = {
          quotaReady: render(ClinePassUsageCard, { account: { provider: "clp-main", displayName: "CLP main", account: "main", default: true, subscriptionRequired: false, available: true, observedAtMs: Date.now(), windows: [{ windowId: "weekly", label: "7天", usedPercent: 12, resetsAt: Date.now() + 3600000, status: null, tokenEstimate: { status: "ready", tokensPerPercent: 1000, observedDeltaPercent: 2, intervalCount: 1, requestCount: 3 } }] } }),
          quotaSampling: render(ClinePassUsageCard, { account: { provider: "clp-main", displayName: "CLP main", account: "main", default: true, subscriptionRequired: false, available: true, observedAtMs: Date.now(), windows: [{ windowId: "weekly", label: "7天", usedPercent: 12, resetsAt: Date.now() + 3600000, status: null, tokenEstimate: { status: "sampling" } }, { windowId: "monthly", label: "月度", usedPercent: 0, resetsAt: null, status: null, tokenEstimate: { status: "unavailable" } }] } }),
          accountSettings: render(AccountSettingsManagement, { management: accountManagement }),
          accountSettingsBusy: render(AccountSettingsManagement, { management: { ...accountManagement, busy: true } }),
          accountSettingsLegacy: render(AccountSettingsManagement, { management: { ...accountManagement, settings: { ...accountSettings, deepseek: { ...accountSettings.deepseek, legacyConfigurationPresent: true } } } }),
          newAccount: render(AccountIdField, { id: "account", value: "main", accounts: [], disabled: false, editing: false, onChange: noop }),
          reservedAccount: render(AccountIdField, { id: "account", value: "openai", accounts: [], reservedIds: ["openai", "deepseek", "ocg"], disabled: false, editing: false, onChange: noop }),
          customAccount: render(AccountIdField, { id: "account", value: "team_a", accounts: [{ id: "team-a" }], disabled: false, editing: false, onChange: noop }),
          editingAccount: render(AccountIdField, { id: "account", value: "main", accounts: [{ id: "main" }], disabled: false, editing: true, onChange: noop }),
          emptyHint: render(TableHint, { hint: null, children: "—" }),
          shortText: render(TruncatedText, { text: "short" }),
          shortLink: render(TruncatedText, { text: "short", asChild: true, children: h("a", { href: "/test" }, "short") }),
          inputWithoutBreakdown: render(InputTokenTooltip, { inputTokens: 10, cachedInputTokens: null }),
          outputWithoutBreakdown: render(OutputTokenTooltip, { outputTokens: 10, reasoningOutputTokens: null }),
          matchingFast: render(FastBadge, { tier: "priority", source: "request", responseTier: "fast" }),
          mismatchedFast: render(FastBadge, { tier: "priority", source: "request", responseTier: "default" }),
          responseFast: render(FastBadge, { tier: "fast", source: "response" }),
          emptyToken: render(InputTokenTooltip, { inputTokens: null, cachedInputTokens: null }),
          inputToken: render(InputTokenTooltip, { inputTokens: 10, cachedInputTokens: 5 }),
          outputToken: render(OutputTokenTooltip, { outputTokens: 10, reasoningOutputTokens: 5 }),
          summaryLoading: render(QuerySummary, { aggregate: null, range: { name: "all" }, loading: true }),
          traffic: render(TrafficTable, { exchanges: [exchange], onOpen: noop, turnStates: new Map([[JSON.stringify([exchange.label, exchange.session, exchange.id]), exchange.turnStateLengths]]) }),
          trafficCountsLoading: render(TrafficTable, { exchanges: [exchange], onOpen: noop }),
          trafficCountsFailed: render(TrafficTable, { exchanges: [exchange], onOpen: noop, turnStateErrors: new Map([[JSON.stringify([exchange.label, exchange.session, exchange.id]), "fixture count failure"]]) }),
          trafficCountsPartial: render(TrafficTable, { exchanges: [exchange, { ...exchange, id: 8 }], onOpen: noop,
            turnStates: new Map([[JSON.stringify([exchange.label, exchange.session, exchange.id]), exchange.turnStateLengths]]),
            turnStateErrors: new Map([[JSON.stringify([exchange.label, exchange.session, 8]), "fixture count failure"]]) }),
          trafficLoading: render(TrafficTable, { exchanges: [exchange], onOpen: noop, loading: true }),
          trafficMismatch: render(TrafficTable, { exchanges: [{ ...exchange, responseModels: ["model-other"] }], onOpen: noop }),
          traceFinalProvider: render(TrafficDetail, { detail: { ...detail, upstreamProvider: "deepseek", chatDiagnostics: { fields: { "routing.finalProvider": "deepseek" }, truncated: false } }, provider: "clp-main", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          traceIndexOnly: render(TrafficDetail, { detail: { ...detail, upstreamProvider: "deepseek" }, provider: "clp-main", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          traceDiagnosticsOnly: render(TrafficDetail, { detail: { ...detail, chatDiagnostics: { fields: { "routing.finalProvider": "deepseek" }, truncated: false } }, provider: "clp-main", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          traceFallbackOnly: render(TrafficDetail, { detail: { ...detail, chatDiagnostics: { fields: { "routing.fallbacks.0": "deepseek" }, truncated: false } }, provider: "clp-main", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          traceClosed: render(TrafficDetail, { detail, provider: "openai", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          retry: render(ErrorBanner, { error: "fixture failure", onRetry: noop }),
          retryPending: render(ErrorBanner, { error: "fixture failure", onRetry: noop, pending: true }),
          requests: render(RequestsTable, requestProps),
          requestsUpstream: render(RequestsTable, { ...requestProps, records: [{ ...record, upstreamProvider: "deepseek" }] }),
          trafficUpstream: render(TrafficTable, { exchanges: [{ ...exchange, upstreamProvider: "deepseek" }], onOpen: noop }),
          loading: render(RequestsTable, { ...requestProps, loading: true }),
          ascending: render(RequestsTable, { ...requestProps, sorting: [{ id: "tokensPerSecond", desc: false }] }),
          threads: render(ThreadTable, { threads: [{ ...common, threadId: "thread-1", agentPath: null,
            parentThreadId: null, turnCount: 1, firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 }], query: {}, pagination }),
          turns: render(TurnTable, { turns: [{ ...common, turnId: "turn-1" }], threadId: "thread-1", query: {}, pagination }),
        };
        for (const [key, inputTokens, cachedInputTokens] of [
          ["threadCacheZero", 100, 0], ["threadCacheUnknown", 100, null], ["threadInputZero", 0, 0],
        ]) {
          result[key] = render(ThreadTable, { threads: [{ ...common, inputTokens, cachedInputTokens,
            cacheUsage: { inputTokens: cachedInputTokens === null ? 0 : inputTokens, cachedInputTokens, missingRequestCount: cachedInputTokens === null ? 1 : 0 },
            threadId: "thread-1", agentPath: null, parentThreadId: null, turnCount: 1,
            firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 }], query: {}, pagination });
        }
        const partial = { ...common, inputTokens: 1000, cachedInputTokens: null,
          cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: 1 } };
        result.partialSummary = render(QuerySummary, { aggregate: partial, range: { name: "all" } });
        result.partialGlobal = render(GlobalCards, { global: partial, threadCount: 1, turnCount: 1 });
        result.partialThread = render(ThreadTable, { threads: [{ ...partial, threadId: "thread-1", agentPath: null,
          parentThreadId: null, turnCount: 1, firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 }], query: {}, pagination });
        globalThis.fixtureDisclosureOpen = true;
        for (const tier of ["fast", "priority", "default", "flex", "auto", null, undefined]) {
          result['tier-' + tier] = render(FastBadge, { tier, source: "request" });
        }
        result.fastRequests = render(RequestsTable, { ...requestProps, records: [{ ...record, requestServiceTier: "priority", serviceTier: "default",
          traffic: { label: "ocg", session: "batch-fast", interaction: 23 } }] });
        result.responseFastRequests = render(RequestsTable, { ...requestProps, records: [{ ...record, serviceTier: "priority", requestServiceTier: null }] });
        const response = { state: "completed", status: 200, usage: null, headers: {}, body: "", output: [] };
        result.fastRequestOnly = render(TrafficDetail, { detail: { ...detail,
          request: { ...detail.request, parameters: { serviceTier: "priority" } },
          response: { ...response, serviceTier: "default" },
        }, provider: "openai", session: "batch-1", onRetry: noop, onTracePageChange: noop });
        result.fastResponseOnly = render(TrafficDetail, { detail: { ...detail,
          response: { ...response, serviceTier: "fast" },
        }, provider: "openai", session: "batch-1", onRetry: noop, onTracePageChange: noop });
        result.traceLoading = render(TrafficDetail, { detail, provider: "openai", session: "batch-1", onRetry: noop, onTracePageChange: noop, traceLoading: true });
        result.traceFailure = render(TrafficDetail, { detail, provider: "openai", session: "batch-1", onRetry: noop, onTracePageChange: noop, traceError: true });
        const { TrafficContent } = await server.ssrLoadModule("/src/components/traffic/traffic-content.tsx");
        result.truncatedContent = render(TrafficContent, { title: "片段", text: '{"partial":', json: true, truncated: true });
        globalThis.fixtureDisclosureOpen = false;
        result.incompleteOutput = render(TrafficDetail, { detail: { ...detail, response: {
          state: "completed", status: null, usage: null, headers: {}, body: "", outputTruncated: true,
          output: [{ type: "message", text: "complete visible message" }],
        } }, provider: "openai", session: "batch-1", onRetry: noop, onTracePageChange: noop });
        globalThis.localStorage = { getItem: key => key.endsWith(":columns") ? JSON.stringify({ ua: true, error: true }) : null };
        result.preferences = render(RequestsTable, requestProps);
        globalThis.fixtureQuery = { range: "30d", offset: 0, limit: 50 };
        const errorsData = { errors: { requestCount: 100, unsuccessfulRequestCount: 60 }, total: 60,
          nextOffset: 50, records: Array.from({ length: 50 }, (_, id) => ({ ...record, id, threadId: null })) };
        globalThis.fixtureApiState = { data: { queryKey: JSON.stringify(globalThis.fixtureQuery), data: errorsData }, loading: false, error: null };
        result.errors = render(ErrorsPage, {});
        errorsData.records[0].requestServiceTier = "priority";
        errorsData.records[0].serviceTier = "default";
        result.fastErrors = render(ErrorsPage, {});
        errorsData.records[0].upstreamProvider = "deepseek";
        result.errorsUpstream = render(ErrorsPage, {});
        globalThis.fixtureApiState.loading = true;
        result.errorsLoading = render(ErrorsPage, {});
        const { QueryFilters } = await server.ssrLoadModule("/src/components/metrics/query-filters.tsx?actual");
        result.filters = render(QueryFilters, { query: { range: "all" }, onChange: noop });
        result.activeFilters = render(QueryFilters, { query: { range: "7d", provider: ["openai"], model: "test" }, onChange: noop });
        const { useRequests } = await server.ssrLoadModule("/src/hooks/use-requests.ts");
        const { useThreads } = await server.ssrLoadModule("/src/hooks/use-threads.ts");
        const { useErrors } = await server.ssrLoadModule("/src/hooks/use-errors.ts");
        const { useThreadTurns } = await server.ssrLoadModule("/src/hooks/use-thread-detail.ts");
        const query = { range: "all", offset: 0, limit: 10 };
        const nextQuery = { ...query, offset: 10 };
        result.queryStates = JSON.stringify([
          [useRequests, JSON.stringify(query)],
          [useThreads, JSON.stringify(query)],
          [useErrors, JSON.stringify(query)],
          [q => useThreadTurns("thread-1", q), JSON.stringify(["thread-1", query])],
        ].map(([hook, queryKey]) => {
          globalThis.fixtureApiState = { data: { queryKey, data: { total: 1 } }, loading: false, error: null };
          const ready = hook(query);
          const changed = hook(nextQuery);
          const returned = hook(query);
          globalThis.fixtureApiState = { ...globalThis.fixtureApiState, loading: true };
          const pending = hook(query);
          globalThis.fixtureApiState = { ...globalThis.fixtureApiState, loading: false, error: "fixture failure" };
          const failed = hook(nextQuery);
          globalThis.fixtureApiState = { data: null, loading: true, error: null };
          const initial = hook(query);
          return { ready, changed, returned, pending, failed, initial };
        }));
        console.log(JSON.stringify(result));
      } finally { await server.close(); }
    `;
    markup = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../webui/", import.meta.url)),
      encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    })) as Record<string, string>;
  }, 35_000);

  const headers = (html: string) => [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
    .map((match) => match[1]!.replace(/<[^>]*>/g, ""));

  it("shows the recorded upstream provider as a tag beside the model without adding a column", () => {
    for (const key of ["requestsUpstream", "trafficUpstream"] as const) {
      const html = markup[key]!;
      expect(html).toContain('title="routing.finalProvider">上游：deepseek');
      expect(html.indexOf("上游：deepseek")).toBeGreaterThan(html.indexOf("model-test"));
      expect(html.match(/<th\b/g)?.length).toBe(markup[key === "requestsUpstream" ? "requests" : "traffic"]!.match(/<th\b/g)?.length);
    }
    expect(markup.requests).not.toContain('title="routing.finalProvider"');
    expect(markup.traffic).not.toContain('title="routing.finalProvider"');
  });

  it("shows the recorded upstream provider on the error list without adding a column", () => {
    const html = markup.errorsUpstream!;
    expect(html).toContain('title="routing.finalProvider">上游：deepseek');
    expect(html.indexOf("上游：deepseek")).toBeGreaterThan(html.indexOf("model-test"));
    expect(html.match(/<th\b/g)?.length).toBe(markup.errors!.match(/<th\b/g)?.length);
    expect(markup.errors).not.toContain('title="routing.finalProvider"');
  });

  it("shows the reported final provider beside the detail model without inferring fallbacks", () => {
    expect(markup.traceFinalProvider).toMatch(/title="routing.finalProvider">上游：deepseek/);
    expect(markup.traceFinalProvider!.indexOf('title="routing.finalProvider"')).toBeLessThan(markup.traceFinalProvider!.indexOf(">请求</"));
    expect(markup.traceIndexOnly).toMatch(/title="routing.finalProvider">上游：deepseek/);
    expect(markup.traceDiagnosticsOnly).not.toContain('title="routing.finalProvider"');
    expect(markup.traceClosed).not.toContain('title="routing.finalProvider"');
    expect(markup.traceFallbackOnly).not.toContain('title="routing.finalProvider"');
  });

  it("distinguishes quota estimates from sampling and unavailable metrics", () => {
    expect(markup.quotaReady).toContain("每 1%");
    expect(markup.quotaReady).toContain("满额约");
    expect(markup.quotaReady).toContain("非官方固定兑换率");
    expect(markup.quotaSampling).toContain("Token 换算正在采样");
    expect(markup.quotaSampling).toContain("Token 换算暂不可用");
    expect(markup.quotaSampling).not.toContain("满额约");
  });

  it("shares managed account controls while isolating the DS legacy action", () => {
    for (const id of ["deepseek-api-key", "cline-api-key"]) {
      expect(markup.accountSettings).toContain(`for="${id}"`);
      expect(markup.accountSettings).toMatch(new RegExp(`<input[^>]*id="${id}"[^>]*value=""`));
      expect(markup.accountSettingsBusy).toMatch(new RegExp(`<input[^>]*id="${id}"[^>]*disabled=""`));
    }
    expect(markup.accountSettings).toContain("ds-main");
    expect(markup.accountSettings).toContain("clp-main");
    expect(markup.accountSettingsLegacy).toContain("移除旧账户");
    expect(markup.accountSettingsLegacy).not.toContain('id="deepseek-api-key"');
    expect(markup.accountSettingsLegacy).toContain('id="cline-api-key"');
  });

  it("renders account presets, custom validation and an immutable existing ID", () => {
    expect(markup.newAccount).toContain('role="combobox"');
    expect(markup.newAccount).not.toContain("自定义账户 ID");
    expect(markup.reservedAccount).toContain("该账户 ID 为保留名称");
    expect(markup.reservedAccount).toContain('aria-invalid="true"');
    expect(markup.customAccount).toContain("自定义账户 ID");
    expect(markup.customAccount).toContain("账户 ID 或凭据变量名已被使用");
    expect(markup.customAccount).toContain('aria-invalid="true"');
    expect(markup.editingAccount).toMatch(/<input[^>]*disabled=""[^>]*value="main"/);
    expect(markup.editingAccount).not.toContain("自定义");
  });

  it("renders a single-row filter toolbar with flexible search and collapsed secondary fields", () => {
    expect(markup.filters).toContain("flex-row flex-nowrap items-center gap-2");
    expect(markup.filters).toContain("min-w-0 flex-1");
    expect(markup.filters).toContain("hidden @lg/filters:inline-flex");
    expect(markup.filters).toContain('placeholder="搜索关键词"');
    expect(markup.filters).toContain("查询</button>");
    expect(markup.filters).toContain("重置</button>");
    expect(markup.filters).not.toContain("Thread ID");
    expect(markup.filters).not.toContain("Turn ID");
    expect(markup.activeFilters).toContain("筛选 · 3");
    expect(markup.filters).not.toContain("筛选 ·");
  });

  it("retains every error row and summary footprint while hiding stale loading values", () => {
    expect(headers(markup.errorsLoading!)).toEqual(headers(markup.errors!));
    expect([...markup.errorsLoading!.matchAll(/<tr\b/g)]).toHaveLength(51);
    expect([...markup.errorsLoading!.matchAll(/data-slot="skeleton"/g)]).toHaveLength(351);
    expect([...markup.errorsLoading!.matchAll(/class="[^"]*invisible[^"]*" aria-hidden="true"/g)]).toHaveLength(351);
    expect(markup.errorsLoading).toMatch(/data-slot="card-content"[^>]*inert=""/);
    expect(markup.errorsLoading).toContain('role="status">正在加载错误记录…');
    expect(markup.errors).not.toContain('data-slot="skeleton"');
  });

  it("places compact console-style error statistics before filters without thread inputs", () => {
    const html = markup.errors!;
    const filters = html.indexOf('data-query-filters="true"');
    expect(filters).toBeGreaterThan(0);
    expect(html).toContain('data-thread-filters="false"');
    const cards = html.slice(0, filters);
    expect(cards).toContain("grid gap-4 sm:grid-cols-2 xl:grid-cols-4");
    expect(cards).toContain("请求总数 · 失败 60 次");
    expect(cards).toContain("成功率 · 当前显示 50 / 60 条失败记录");
    expect(cards).not.toContain('data-slot="card-header"');
    expect([...cards.matchAll(/data-slot="card-content"/g)]).toHaveLength(2);
  });

  it("groups request identity, usage, performance and detail columns", () => {
    expect(headers(markup.requests!)).toEqual([
      "时间", "Provider", "模型", "状态", "输入 Token", "输出 Token",
      "首字耗时", "总耗时", "生成 Token/s", "端到端 Token/s", "调用详情",
    ]);
    expect(markup.requests).not.toContain('role="checkbox"');
    expect(markup.requests).not.toContain("已选");
    expect(markup.requests).toContain("名称不一致");
  });

  it("shows only Fast tiers and preserves the exact call link", () => {
    for (const tier of ["fast", "priority"]) expect(markup['tier-' + tier]).toContain(">Fast</span>");
    for (const tier of ["default", "flex", "auto", "null", "undefined"]) expect(markup['tier-' + tier]).toBe("");
    expect(markup.fastRequests).toContain(">Fast</span>");
    expect(markup.fastRequests).toContain('/traffic?label=ocg&amp;exchangeSession=batch-fast&amp;id=23');
    expect(markup.fastErrors).toContain(">Fast</span>");
    expect(markup.requests).not.toContain(">Fast</span>");
    expect(markup.responseFastRequests).not.toContain(">Fast</span>");
  });

  it("keeps request and response Fast badges on their own side", () => {
    const requestOnly = markup.fastRequestOnly!;
    const responseOnly = markup.fastResponseOnly!;
    expect(requestOnly.match(/>Fast<\/span>/g)).toHaveLength(1);
    expect(responseOnly.match(/>Fast<\/span>/g)).toHaveLength(1);
    expect(requestOnly.indexOf(">Fast</span>")).toBeLessThan(requestOnly.indexOf("响应服务层级"));
    expect(responseOnly.indexOf(">Fast</span>")).toBeGreaterThan(responseOnly.indexOf("响应服务层级"));
    expect(markup.traceClosed).not.toContain(">Fast</span>");
  });

  it("reserves intrinsic toolbar and pagination space around the bounded table viewport", () => {
    for (const key of ["requests", "threads", "turns", "loading"]) {
      expect(markup[key]).toMatch(/data-slot="card"[^>]*class="[^"]*min-h-min/);
      expect(markup[key]).toMatch(/data-slot="card-content"[^>]*class="[^"]*grid-rows-\[auto_minmax\(10rem,1fr\)_auto\]/);
      expect(markup[key]).toContain("[contain:size]");
    }
    expect(markup.summaryLoading).toMatch(/class="[^"]*invisible" aria-hidden="true"/);
    expect(markup.summaryLoading).toContain("全部保留历史");
  });

  it("keeps aggregate speeds after token counts and omits unused selection", () => {
    expect(headers(markup.threads!)).toEqual([
      "期间首次请求", "Thread", "Provider", "模型", "类型", "Turn", "请求",
      "输入 Token", "缓存命中率", "输出 Token", "生成 Token/s", "最后记录",
    ]);
    expect(headers(markup.turns!)).toEqual([
      "时间", "Turn", "Provider", "模型", "请求", "失败", "输入 Token", "输出 Token", "生成 Token/s",
    ]);
    expect(markup.turns).not.toContain('role="checkbox"');
  });

  it("shows thread cache hit rates and preserves unknown or zero-input usage", () => {
    const cacheCell = (html: string) => [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)][8]?.[1];
    expect(cacheCell(markup.threads!)).toContain("50.0%");
    expect(cacheCell(markup.threadCacheZero!)).toContain("0.0%");
    expect(cacheCell(markup.threadCacheUnknown!)).toContain("—");
    expect(cacheCell(markup.threadInputZero!)).toContain("—");
    expect(cacheCell(markup.partialThread!)).toContain("50.0%");
    expect(markup.partialSummary).toContain("缓存 50");
    expect(markup.partialGlobal).toContain("缓存 50 · 命中率 50.0%");
    for (const key of ["partialThread", "partialSummary", "partialGlobal"]) {
      expect(markup[key]).not.toMatch(/部分已知|已知样本/);
    }
  });

  it("exposes sort direction and focusable tooltip triggers", () => {
    const requestHeaders = [...markup.requests!.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)]
      .map((match) => match[0]);
    const ascendingHeaders = [...markup.ascending!.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)]
      .map((match) => match[0]);
    const timeIndex = headers(markup.requests!).indexOf("时间");
    const speedIndex = headers(markup.ascending!).indexOf("端到端 Token/s");
    const statusIndex = headers(markup.requests!).indexOf("状态");
    expect(timeIndex).toBeGreaterThanOrEqual(0);
    expect(speedIndex).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThanOrEqual(0);
    expect(requestHeaders[timeIndex]).toMatch(/^<th\b[^>]*aria-sort="descending"[^>]*>/);
    expect(ascendingHeaders[speedIndex]).toMatch(/^<th\b[^>]*aria-sort="ascending"[^>]*>/);

    const cells = [...markup.requests!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)]
      .map((match) => match[1]!);
    const statusCell = cells[statusIndex];
    expect(statusCell).toContain("失败");
    expect(statusCell).toMatch(/^<span\b[^>]*tabindex="0"[^>]*>/);
  });

  it("avoids empty and repeated cell hints while keeping detailed values accessible", () => {
    expect(markup.emptyHint).toBe("—");
    expect(markup.shortText).not.toContain('tabindex="0"');
    expect(markup.emptyToken).not.toContain('data-slot="tooltip-trigger"');
    expect(markup.inputToken).toContain('tabindex="0"');
    expect(markup.outputToken).toContain('tabindex="0"');
    const cells = [...markup.requests!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]!);
    for (const label of ["首字耗时", "总耗时", "生成 Token/s", "端到端 Token/s", "调用详情"]) {
      expect(cells[headers(markup.requests!).indexOf(label)]).not.toContain('data-slot="tooltip-trigger"');
    }
    expect(markup['tier-fast']).toContain("h-4");
  });

  it("only offers supplemental token and Fast information and preserves link semantics", () => {
    for (const key of ["inputWithoutBreakdown", "outputWithoutBreakdown", "matchingFast", "responseFast", "tier-fast"]) {
      expect(markup[key]).not.toContain('data-slot="tooltip-trigger"');
    }
    expect(markup.mismatchedFast).toContain('data-slot="tooltip-trigger"');
    expect(markup.shortLink).toMatch(/^<a\b/);
    expect(markup.shortLink).toContain('href="/test"');
    expect(markup.shortLink).not.toContain('tabindex=');
    expect(markup.shortLink).not.toContain('title=');
  });

  it("preserves explicit existing column visibility preferences", () => {
    expect(headers(markup.preferences!)).toContain("User-Agent");
    expect(headers(markup.preferences!)).toContain("错误");
  });

  it("keeps headers while hiding stale rows and disabling table interaction during loading", () => {
    expect(headers(markup.loading!)).toEqual(headers(markup.requests!));
    expect(markup.loading).toContain('aria-busy="true"');
    expect(markup.loading).toMatch(/data-slot="card-content"[^>]*inert=""/);
    expect(markup.loading).toContain('data-slot="skeleton"');
    expect(markup.loading).not.toContain("model-test");
    expect(markup.loading).not.toContain("失败");
    expect(markup.loading).toMatch(/class="block invisible" aria-hidden="true">共 1 条匹配/);
  });

  it("marks changed queries pending before the API effect and preserves explicit failures", () => {
    expect(JSON.parse(markup.queryStates!)).toEqual(Array.from({ length: 4 }, () => ({
      ready: { data: { total: 1 }, error: null, loading: false },
      changed: { data: { total: 1 }, error: null, loading: true },
      returned: { data: { total: 1 }, error: null, loading: false },
      pending: { data: { total: 1 }, error: null, loading: true },
      failed: { data: { total: 1 }, error: "fixture failure", loading: false },
      initial: { data: null, error: null, loading: true },
    })));
  });

  it("aligns numeric headers and cells on the same edge", () => {
    const columnIndex = headers(markup.requests!).indexOf("输入 Token");
    const heads = [...markup.requests!.matchAll(/<th\b[^>]*>/g)].map(match => match[0]);
    const cells = [...markup.requests!.matchAll(/<td\b[^>]*>/g)].map(match => match[0]);
    expect(columnIndex).toBeGreaterThanOrEqual(0);
    expect(heads[columnIndex]).toContain("text-right");
    expect(cells[columnIndex]).toContain("text-right");
  });

  it("prioritizes traffic model, status and duration without redundant matching-model badges", () => {
    expect(headers(markup.traffic!)).toEqual(["时间", "Provider", "模型", "状态", "总耗时", "Turn State 字符数", "类型", "请求", "线程", "轮次"]);
    expect(markup.traffic).toContain("1,234");
    expect(markup.trafficCountsLoading).toContain("加载中…");
    expect(markup.trafficCountsLoading).toContain("的调用明细");
    expect(markup.trafficCountsFailed).toContain("加载失败");
    expect(markup.trafficCountsFailed).toContain("的调用明细");
    expect(markup.trafficCountsPartial).toContain("1,234");
    expect(markup.trafficCountsPartial?.match(/加载失败/g)).toHaveLength(1);
    expect(markup.traffic).not.toContain("#7");
    expect(markup.traffic).toContain("的调用明细");
    expect(markup.traffic).not.toContain("名称一致");
    expect(markup.traffic).not.toContain("→");
    expect(markup.trafficMismatch).toContain("名称不一致");
    expect(headers(markup.trafficLoading!)).toEqual(headers(markup.traffic!));
    expect(markup.trafficLoading).toContain('data-slot="skeleton"');
    expect(markup.trafficLoading).not.toContain("model-test");
    expect(markup.trafficLoading).not.toContain("的调用明细");
  });

  it("keeps call content but hides stale trace pages during loading or failure", () => {
    expect(markup.incompleteOutput).toContain("输出展示不完整");
    expect(markup.incompleteOutput).toContain("complete visible message");
    expect(markup.incompleteOutput).not.toContain("内容已截断，展示和复制均仅包含已保留片段。");
    expect(markup.traceClosed).not.toContain("request-body");
    expect(markup.traceClosed).not.toContain("old-trace-body");
    expect(markup.traceClosed).toContain("诊断信息");
    expect(markup.truncatedContent).toContain("已截断");
    expect(markup.truncatedContent).toContain("复制原文");
    expect(markup.truncatedContent).not.toContain("格式化</button>");
    for (const html of [markup.traceLoading, markup.traceFailure]) {
      expect(html).toContain("request-body");
      expect(html).toContain("提供商 openai · 批次 batch-1");
      expect(html).toContain("调用编号 #7");
      expect(html).toContain("复制定位信息");
      expect(html).not.toContain("old-trace-body");
      expect(html).toMatch(/<button\b[^>]*disabled=""/);
    }
    expect(markup.traceLoading).toContain("正在加载原始事件");
    expect(markup.traceLoading).toContain("X-Codex-Turn-State 字符数");
    expect(markup.traceLoading).toContain("1,234");
    expect(markup.traceFailure).toContain("原始事件加载失败");
    expect(markup.traceFailure).toContain("重试原始事件");
  });

  it("offers an explicit retry and prevents repeating it while pending", () => {
    expect(markup.retry).toContain("重试");
    expect(markup.retry).not.toContain('disabled=""');
    expect(markup.retryPending).toMatch(/<button\b[^>]*disabled=""/);
  });
});
