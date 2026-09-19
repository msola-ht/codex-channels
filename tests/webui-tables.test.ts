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
          if (id.endsWith("/src/hooks/use-api.ts")) return "export function useApi() { return globalThis.fixtureApiState; }";
          if (id.endsWith("/src/hooks/use-metrics-query.ts")) return "export function useMetricsQuery() { return { query: globalThis.fixtureQuery, update() {} }; } export function useMetricsProviders() { return { data: { providers: ['openai'] }, loading: false, error: null }; }";
          if (id.endsWith("/src/components/metrics/query-filters.tsx")) return "import { createElement } from 'react'; export function QueryFilters(props) { return createElement('div', { 'data-query-filters': true, 'data-thread-filters': props.showThreadFilters }); }";
        } }],
      });
      try {
        const { RequestsTable } = await server.ssrLoadModule("/src/components/requests/requests-table.tsx");
        const { ThreadTable } = await server.ssrLoadModule("/src/components/threads/thread-table.tsx");
        const { TurnTable } = await server.ssrLoadModule("/src/components/threads/turn-table.tsx");
        const { TrafficTable } = await server.ssrLoadModule("/src/components/traffic/traffic-table.tsx");
        const { TrafficDetail } = await server.ssrLoadModule("/src/components/traffic/traffic-detail.tsx");
        const { ErrorBanner } = await server.ssrLoadModule("/src/components/metrics/error-banner.tsx");
        const { QuerySummary } = await server.ssrLoadModule("/src/components/metrics/query-summary.tsx");
        const { ErrorsPage } = await server.ssrLoadModule("/src/pages/errors-page.tsx");
        const { LanguageContext } = await server.ssrLoadModule("/src/hooks/language-context.ts");
        const { TooltipProvider } = await server.ssrLoadModule("/src/components/ui/tooltip.tsx");
        const { setServerTimeZone } = await server.ssrLoadModule("/src/lib/format.ts");
        setServerTimeZone("UTC");
        const noop = () => {};
        const pagination = { mode: "server", pageNumber: 1, pageSize: 10, hasPrevious: false, hasNext: false,
          onPrevious: noop, onNext: noop, onPageSizeChange: noop, onSortingChange: noop,
          sorting: [{ id: "time", desc: true }], serverTotal: 1 };
        const common = { provider: "openai", model: "model-test", recordedAtMs: 1000,
          inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5,
          tokensPerSecond: 20, compact: null, requestCount: 1, unsuccessfulRequestCount: 0 };
        const record = { ...common, status: "failed", requestModel: "model-test", responseModel: "model-other",
          traffic: null, userAgent: "fixture-client", operation: "response", httpStatus: 502,
          errorType: "upstream_error", errorCode: "fixture_error", errorMessage: "fixture failure",
          firstContentMs: 100, totalDurationMs: 1000, upstreamTtftMs: null, cacheHitRate: 0.5 };
        const render = (component, props) => renderToStaticMarkup(h(MemoryRouter, null,
          h(LanguageContext.Provider, { value: { language: "zh", setLanguage: noop } }, h(TooltipProvider, null, h(component, props)))));
        const requestProps = { ...pagination, records: [record], filter: "", total: 1 };
        const exchange = { id: 7, label: "openai", session: "batch-1", startedAtMs: 1000, category: "model",
          state: "completed", durationMs: 1000, hasError: false, requestModel: "model-test", responseModels: ["model-test"] };
        const detail = { ...exchange, transport: "http", modelEvidence: { serverModels: [], safetyModels: [], truncated: false },
          parameterComparison: [], request: { headers: {}, body: "request-body", parameters: {},
            content: { instructions: null, input: [], tools: [] } }, response: null,
          tracePage: { offset: 0, total: 101, previousOffset: null, nextOffset: 100 },
          trace: [{ atMs: 1000, kind: "fixture-event", text: "old-trace-body", truncated: false }] };
        const result = {
          summaryLoading: render(QuerySummary, { aggregate: null, range: { name: "all" }, loading: true }),
          traffic: render(TrafficTable, { exchanges: [exchange], onOpen: noop }),
          trafficLoading: render(TrafficTable, { exchanges: [exchange], onOpen: noop, loading: true }),
          trafficMismatch: render(TrafficTable, { exchanges: [{ ...exchange, responseModels: ["model-other"] }], onOpen: noop }),
          traceLoading: render(TrafficDetail, { detail, onTracePageChange: noop, traceLoading: true }),
          traceFailure: render(TrafficDetail, { detail, onTracePageChange: noop, traceError: true }),
          retry: render(ErrorBanner, { error: "fixture failure", onRetry: noop }),
          retryPending: render(ErrorBanner, { error: "fixture failure", onRetry: noop, pending: true }),
          requests: render(RequestsTable, requestProps),
          loading: render(RequestsTable, { ...requestProps, loading: true }),
          ascending: render(RequestsTable, { ...requestProps, sorting: [{ id: "tokensPerSecond", desc: false }] }),
          threads: render(ThreadTable, { threads: [{ ...common, threadId: "thread-1", agentPath: null,
            parentThreadId: null, turnCount: 1, firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 }], query: {}, pagination }),
          turns: render(TurnTable, { turns: [{ ...common, turnId: "turn-1" }], threadId: "thread-1", query: {}, pagination }),
        };
        globalThis.localStorage = { getItem: key => key.endsWith(":columns") ? JSON.stringify({ ua: true, error: true }) : null };
        result.preferences = render(RequestsTable, requestProps);
        globalThis.fixtureQuery = { range: "30d", offset: 0, limit: 50 };
        const errorsData = { errors: { requestCount: 100, unsuccessfulRequestCount: 60 }, total: 60,
          nextOffset: 50, records: Array.from({ length: 50 }, (_, id) => ({ ...record, id, threadId: null })) };
        globalThis.fixtureApiState = { data: { queryKey: JSON.stringify(globalThis.fixtureQuery), data: errorsData }, loading: false, error: null };
        result.errors = render(ErrorsPage, {});
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
      "首字耗时", "总耗时", "Token/s", "调用详情",
    ]);
    expect(markup.requests).not.toContain('role="checkbox"');
    expect(markup.requests).not.toContain("已选");
    expect(markup.requests).toContain("名称不一致");
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
      "输入 Token", "输出 Token", "平均 Token/s", "最后记录",
    ]);
    expect(headers(markup.turns!)).toEqual([
      "时间", "Turn", "Provider", "模型", "请求", "失败", "输入 Token", "输出 Token", "平均 Token/s",
    ]);
    expect(markup.turns).not.toContain('role="checkbox"');
  });

  it("exposes sort direction and focusable tooltip triggers", () => {
    const requestHeaders = [...markup.requests!.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)]
      .map((match) => match[0]);
    const ascendingHeaders = [...markup.ascending!.matchAll(/<th\b[^>]*>[\s\S]*?<\/th>/g)]
      .map((match) => match[0]);
    const timeIndex = headers(markup.requests!).indexOf("时间");
    const speedIndex = headers(markup.ascending!).indexOf("Token/s");
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
    expect(headers(markup.traffic!)).toEqual(["#", "时间", "Provider", "模型", "状态", "总耗时", "类型", "请求", "线程", "轮次"]);
    expect(markup.traffic).not.toContain("名称一致");
    expect(markup.traffic).not.toContain("→");
    expect(markup.trafficMismatch).toContain("名称不一致");
    expect(headers(markup.trafficLoading!)).toEqual(headers(markup.traffic!));
    expect(markup.trafficLoading).toContain('data-slot="skeleton"');
    expect(markup.trafficLoading).not.toContain("model-test");
    expect(markup.trafficLoading).not.toContain("查看批次");
  });

  it("keeps call content but hides stale trace pages during loading or failure", () => {
    for (const html of [markup.traceLoading, markup.traceFailure]) {
      expect(html).toContain("request-body");
      expect(html).not.toContain("old-trace-body");
      expect(html).toMatch(/<button\b[^>]*disabled=""/);
    }
    expect(markup.traceLoading).toContain("正在加载原始事件");
    expect(markup.traceFailure).toContain("原始事件加载失败");
  });

  it("offers an explicit retry and prevents repeating it while pending", () => {
    expect(markup.retry).toContain("重试");
    expect(markup.retry).not.toContain('disabled=""');
    expect(markup.retryPending).toMatch(/<button\b[^>]*disabled=""/);
  });
});
