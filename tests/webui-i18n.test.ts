import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

describe("WebUI 界面文案语言切换", () => {
  let result: {
    toggleZh: string;
    toggleEn: string;
    zhKeys: string[];
    enKeys: string[];
    zhNavigationLabel: string;
    enNavigationLabel: string;
    placeholderParity: boolean;
    enThreads: string;
    enThreadsLoading: string;
    zhThreads: string;
    enTurns: string;
    enSummary: string;
    enFilters: string;
    enNavigation: string;
    restoredLanguage: string;
    unsupportedStoredLanguage: string;
    unavailableStorageLanguage: string;
    unknownError: string;
    knownError: string;
    prototypeError: string;
    interpolated: string;
    errorCodeLabel: string;
    consoleEn: string;
    consoleEnLoading: string;
    consoleEnEmptyAccounts: string;
    consoleEnQueryError: string;
    consoleEnListError: string;
    consoleEnSyncError: string;
    consoleEnRemoved: string;
    consoleEnSubscription: string;
    accountUpdateStaleEn: string;
    accountUpdateFreshEn: string;
    accountUpdateMissingEn: string;
    accountUpdateFailedEn: string;
    snapshotEmptyEn: string;
    refreshFeedbackEn: string;
    requestsTableEn: string;
    requestsTableEmptyEn: string;
    requestsTableLoadingEn: string;
    requestsPageEn: string;
    requestsPageErrorEn: string;
    errorsPageEn: string;
    errorsPageLoadingEn: string;
    errorsPageEmptyEn: string;
    errorsPageErrorEn: string;
    trafficTableEn: string;
    trafficTableEmptyEn: string;
    trafficDetailEn: string;
    trafficDetailFailedEn: string;
    trafficDetailPrewarmEn: string;
    trafficDetailNoResponseEn: string;
    trafficPageEn: string;
    trafficPageDisabledEn: string;
    trafficPageLimitedEn: string;
    trafficDetailPageEn: string;
  };

  beforeAll(() => {
    // 复用 WebUI 自身的 Vite/React 依赖渲染真实组件。
    const script = String.raw`
      import { createServer } from "vite";
      import { createElement as h } from "react";
      import { MemoryRouter } from "react-router";
      import { renderToStaticMarkup } from "react-dom/server";
      const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent",
        plugins: [{ name: "console-fixture", enforce: "pre", transform(_code, id) {
          if (id.endsWith("/src/hooks/use-dashboard.ts")) return "export function useDashboard() { return globalThis.fixtureDashboard; }";
          if (id.endsWith("/src/hooks/use-official-account-sources.ts")) return "export function useOfficialAccountSources() { return globalThis.fixtureAccounts; }";
          if (id.endsWith("/src/hooks/use-account-settings-management.ts")) return "export function useAccountSettingsManagement() { return globalThis.fixtureAccountManagement; }";
          if (id.endsWith("/src/hooks/use-metrics-query.ts")) return "export function useMetricsQuery() { return globalThis.fixtureMetricsQuery; } export function useMetricsProviders() { return globalThis.fixtureMetricsProviders ?? { data: null, loading: true, error: null, errorCode: null }; }";
          if (id.endsWith("/src/hooks/use-requests.ts")) return "export function useRequests() { return globalThis.fixtureRequests; }";
          if (id.endsWith("/src/hooks/use-errors.ts")) return "export function useErrors() { return globalThis.fixtureErrors; }";
          if (id.endsWith("/src/hooks/use-metrics-export.ts")) return "export function useMetricsExport() { return globalThis.fixtureExport; }";
          if (id.endsWith("/src/hooks/use-traffic.ts")) return "export function useTrafficExchanges() { return globalThis.fixtureTrafficList; } export function useTrafficExchange() { return globalThis.fixtureTrafficDetail; }";
          if (id.endsWith("/src/hooks/use-traffic-query.ts")) return "export const trafficPageSizeOptions = [10, 20, 50]; export function useTrafficQuery() { return globalThis.fixtureTrafficQuery; }";
          if (id.endsWith("/src/hooks/use-management-tasks.ts")) return "export function useManagementTasks() { return globalThis.fixtureManagementTasks; } export function useManagementTaskRefresh() {}";
          if (id.endsWith("/src/components/traffic/traffic-content.tsx")) return _code.replace("useState(false)", "useState(globalThis.fixtureDisclosureOpen ?? false)");
        } }],
      });
      try {
        const { LanguageContext, useLanguage } = await server.ssrLoadModule("/src/hooks/language-context.ts");
        const { LanguageToggle } = await server.ssrLoadModule("/src/components/metrics/language-toggle.tsx");
        const { translate, translateApiError } = await server.ssrLoadModule("/src/lib/i18n/translate.ts");
        const { messages } = await server.ssrLoadModule("/src/lib/i18n/messages.ts");
        const { ThreadTable } = await server.ssrLoadModule("/src/components/threads/thread-table.tsx");
        const { TurnTable } = await server.ssrLoadModule("/src/components/threads/turn-table.tsx");
        const { QuerySummary } = await server.ssrLoadModule("/src/components/metrics/query-summary.tsx");
        const { QueryFilters } = await server.ssrLoadModule("/src/components/metrics/query-filters.tsx");
        const { ConsolePage } = await server.ssrLoadModule("/src/pages/console-page.tsx");
        const { RequestsPage } = await server.ssrLoadModule("/src/pages/requests-page.tsx");
        const { ErrorsPage } = await server.ssrLoadModule("/src/pages/errors-page.tsx");
        const { RequestsTable } = await server.ssrLoadModule("/src/components/requests/requests-table.tsx");
        const { TrafficTable } = await server.ssrLoadModule("/src/components/traffic/traffic-table.tsx");
        const { TrafficDetail } = await server.ssrLoadModule("/src/components/traffic/traffic-detail.tsx");
        const { TrafficPage } = await server.ssrLoadModule("/src/pages/traffic-page.tsx");
        const { ServerTimeContext } = await server.ssrLoadModule("/src/hooks/use-server-time.ts");
        const { AccountUpdateDescription, AccountRefreshFeedback, AccountSnapshotEmpty } =
          await server.ssrLoadModule("/src/components/overview/account-refresh-feedback.tsx");
        const { TooltipProvider } = await server.ssrLoadModule("/src/components/ui/tooltip.tsx");
        const { setServerTimeZone } = await server.ssrLoadModule("/src/lib/format.ts");
        setServerTimeZone("UTC");
        const { LanguageProvider } = await server.ssrLoadModule("/src/hooks/language-provider.tsx");
        const { AppSidebar } = await server.ssrLoadModule("/src/components/layout/app-sidebar.tsx");
        const { SidebarProvider } = await server.ssrLoadModule("/src/components/ui/sidebar.tsx");
        function LanguageProbe() { return h("span", null, useLanguage().language); }
        const restore = (getItem) => {
          globalThis.localStorage = { getItem };
          try { return renderToStaticMarkup(h(LanguageProvider, null, h(LanguageProbe))); }
          finally { delete globalThis.localStorage; }
        };
        const noop = () => {};
        const pagination = { mode: "server", pageNumber: 1, pageSize: 10, hasPrevious: false, hasNext: false,
          onPrevious: noop, onNext: noop, onPageSizeChange: noop, onSortingChange: noop, sorting: [], serverTotal: 0 };
        const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/gu)].map(match=>match[1]).sort();
        const flatten = (node, prefix = "") => Object.fromEntries(Object.entries(node).flatMap(([key, value]) =>
          typeof value === "string" ? [[prefix+key, value]] : Object.entries(flatten(value, prefix+key+"."))));
        const zh = flatten(messages.zh), en = flatten(messages.en);
        const render = (component, props, language) => renderToStaticMarkup(
          h(LanguageContext.Provider, { value: { language, setLanguage: noop } }, h(MemoryRouter, null, h(TooltipProvider, null, h(component, component === TrafficTable ? { pagination: { mode: "server", pageNumber: 1, pageSize: 50, hasPrevious: false, hasNext: false, onPrevious: noop, onNext: noop, onPageSizeChange: noop, sorting: [], onSortingChange: noop }, description: "fixture", ...props } : props)))));
        const clock = { nowMs: Date.now(), receivedAtMs: Date.now(), timeZone: "UTC" };
        const renderWithClock = (component, props, language) => renderToStaticMarkup(
          h(LanguageContext.Provider, { value: { language, setLanguage: noop } }, h(MemoryRouter, null,
            h(TooltipProvider, null, h(ServerTimeContext.Provider, { value: clock }, h(component, component === TrafficTable ? { pagination: { mode: "server", pageNumber: 1, pageSize: 50, hasPrevious: false, hasNext: false, onPrevious: noop, onNext: noop, onPageSizeChange: noop, sorting: [], onSortingChange: noop }, description: "fixture", ...props } : props))))));
        const renderConsole = (language, dashboard, accounts) => {
          globalThis.fixtureDashboard = dashboard;
          globalThis.fixtureAccounts = accounts;
          globalThis.fixtureAccountManagement = {
            settings: { opencodeGo: { accounts: [{ id: "main" }] } },
            loading: false, error: null, busy: false, pendingPreview: null, actionError: null,
            refetch: noop, cancel: noop, confirm: async () => null, mutate: noop,
          };
          return renderWithClock(ConsolePage, { range: { range: "30d" }, onRangeChange: noop }, language);
        };
        const aggregate = { cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: 0 },
          requestCount: 4, unsuccessfulRequestCount: 1, inputTokens: 100, cachedInputTokens: 50,
          outputTokens: 20, reasoningOutputTokens: 5, compact: { requestCount: 2 } };
        const range = { name: "30d", startAtMs: 1000, endAtMs: 2000 };
        const windows = [
          { windowId: "rolling", label: "5小时", usedPercent: 10, resetsAt: 1000, status: null, localTokens: 12345 },
          { windowId: "weekly", label: "7天", usedPercent: 20, resetsAt: null, status: null },
          { windowId: "monthly", label: "月度", usedPercent: 30, resetsAt: null, status: null },
        ];
        const baseDashboard = {
          data: { range, generatedAt: "2026-01-01T00:00:00.000Z", global: aggregate, threadCount: 2, turnCount: 3,
            providers: [{ provider: "openai", model: "model-test", aggregate, threadCount: 2, turnCount: 3 }],
            errors: { startAtMs: 1000, endAtMs: 2000, requestCount: 4, unsuccessfulRequestCount: 1, groups: [], totalGroupCount: 0 },
            weeklyQuota: null, trend: { range, generatedAt: "2026-01-01T00:00:00.000Z", granularity: "day", daily: [] },
            heatmap: { range, generatedAt: "2026-01-01T00:00:00.000Z", daily: [] } },
          loading: false, error: null, errorCode: null, refetch: noop,
        };
        const baseAccounts = {
          data: { openaiWeeklyQuota: { usedPercent: 37.5, resetsAt: 1000, planType: "plus" }, deepseek: { accounts: [{ provider: "deepseek", account: "main", displayName: "DeepSeek main",
              default: true, observedAtMs: 1000, available: true,
              balances: [{ currency: "CNY", totalBalance: "2", grantedBalance: "1", toppedUpBalance: "1" }] }] },
            opencodeGo: { accounts: [{ subscriptionRequired: false, account: "main", displayName: "OpenCode Go main",
              default: false, available: true, windows, provider: "ocg-main", observedAtMs: 1000 }] },
            ccg: { accounts: [{ provider: "ccg-main", account: "main", displayName: "CommandCode Go main", default: false,
              available: true, observedAtMs: 1000, planId: null, monthlyRemaining: "1.00", purchasedRemaining: "2.00",
              freeRemaining: "3.00", totalRemaining: "6.00", windows: [] }] },
            clinePass: [], warnings: [] },
          loading: false, refreshing: false, refreshControls: {}, refresh: noop,
          error: null, errorCode: null, refreshError: null, removalNotice: null, accountRemoved: noop,
        };
        const consoleEn = renderConsole("en", baseDashboard, baseAccounts);
        const consoleEnLoading = renderConsole("en",
          { ...baseDashboard, data: null, loading: true },
          { ...baseAccounts, data: null, loading: true, refreshing: true });
        const consoleEnEmptyAccounts = renderConsole("en", baseDashboard,
          { ...baseAccounts, data: { deepseek: null, opencodeGo: null, ccg: null, clinePass: [], warnings: [] } });
        const consoleEnQueryError = renderConsole("en",
          { ...baseDashboard, data: null, error: "fixture-overview-failure", errorCode: "invalid_range" }, baseAccounts);
        const consoleEnListError = renderConsole("en", baseDashboard,
          { ...baseAccounts, refreshError: { kind: "listFailed", code: "unauthorized" } });
        const consoleEnSyncError = renderConsole("en", baseDashboard,
          { ...baseAccounts, refreshError: { kind: "syncFailed", code: null } });
        const consoleEnRemoved = renderConsole("en", baseDashboard,
          { ...baseAccounts, removalNotice: { accountId: "ocg-main", restartRequired: true } });
        const consoleEnSubscription = renderConsole("en", baseDashboard, { ...baseAccounts,
          data: { ...baseAccounts.data, opencodeGo: { accounts: [{ subscriptionRequired: true, account: "main",
            displayName: "OpenCode Go main", default: false, available: false, windows: [], provider: "ocg-main",
            observedAtMs: 1000 }] } } });
        const accountUpdateStaleEn = renderWithClock(AccountUpdateDescription,
          { observedAtMs: Date.now() - 16 * 60_000, isDefault: true, refreshFailed: false }, "en");
        const accountUpdateFreshEn = renderWithClock(AccountUpdateDescription,
          { observedAtMs: Date.now(), isDefault: false, refreshFailed: false }, "en");
        const accountUpdateMissingEn = renderWithClock(AccountUpdateDescription,
          { observedAtMs: 0, isDefault: false, refreshFailed: false }, "en");
        const accountUpdateFailedEn = renderWithClock(AccountUpdateDescription,
          { observedAtMs: Date.now(), isDefault: false, refreshFailed: true }, "en");
        const snapshotEmptyEn = renderWithClock(AccountSnapshotEmpty,
          { control: { refreshing: true, disabled: false, error: null, onRefresh: noop } }, "en");
        const refreshFeedbackEn = renderWithClock(AccountRefreshFeedback,
          { control: { refreshing: false, disabled: false, error: { kind: "refresh-failed", message: "账户刷新失败" }, onRefresh: noop },
            hasSnapshot: true }, "en");
        const requestRecord = { id: 42, provider: "openai", model: "model-test", recordedAtMs: 1000,
          cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: 0 },
          inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5,
          tokensPerSecond: 20, compact: null, requestCount: 1, unsuccessfulRequestCount: 0,
          status: "failed", requestModel: "model-test", responseModel: "model-other", traffic: null,
          userAgent: "fixture-client", operation: "response", httpStatus: 502, errorType: "upstream_error",
          errorCode: "fixture_error", errorMessage: "fixture failure", firstTokenMs: 100, totalDurationMs: 1000,
          upstreamTtftMs: null, cacheHitRate: 0.5, requestServiceTier: "priority", serviceTier: "default" };
        const requestTableProps = { loading: false, records: [requestRecord], pageNumber: 1, hasPrevious: false,
          hasNext: false, onPrevious: noop, onNext: noop, pageSize: 50, onPageSizeChange: noop,
          sorting: [], onSortingChange: noop, filter: "", total: 1 };
        globalThis.fixtureMetricsQuery = { query: { range: "30d", offset: 0, limit: 50, filter: "" },
          update: noop, sorting: [], onSortingChange: noop };
        globalThis.fixtureMetricsProviders = { data: { providers: ["openai"] }, loading: false, error: null, errorCode: null };
        globalThis.fixtureExport = { download: noop, pending: false, failed: false, errorCode: null };
        globalThis.fixtureRequests = { data: { aggregate: requestRecord, range, records: [requestRecord], total: 1,
          nextOffset: null }, loading: false, error: null, errorCode: null, refetch: noop };
        globalThis.fixtureErrors = { data: { errors: { requestCount: 100, unsuccessfulRequestCount: 60 },
          total: 60, nextOffset: 50,
          records: [{ ...requestRecord, id: 1, threadId: "thread-1", turnId: "turn-1" }] },
          loading: false, error: null, errorCode: null, refetch: noop };
        const requestsTableEn = render(RequestsTable, requestTableProps, "en");
        const requestsTableEmptyEn = render(RequestsTable, { ...requestTableProps, records: [], total: 0 }, "en");
        const requestsTableLoadingEn = render(RequestsTable, { ...requestTableProps, loading: true }, "en");
        const requestsPageEn = render(RequestsPage, {}, "en");
        const errorsPageEn = render(ErrorsPage, {}, "en");
        globalThis.fixtureErrors = { ...globalThis.fixtureErrors, loading: true };
        const errorsPageLoadingEn = render(ErrorsPage, {}, "en");
        globalThis.fixtureErrors = { ...globalThis.fixtureErrors, loading: false,
          data: { ...globalThis.fixtureErrors.data, records: [], total: 0 } };
        const errorsPageEmptyEn = render(ErrorsPage, {}, "en");
        globalThis.fixtureErrors = { ...globalThis.fixtureErrors, data: null, error: "fixture-errors-failure",
          errorCode: "not_found" };
        const errorsPageErrorEn = render(ErrorsPage, {}, "en");
        globalThis.fixtureRequests = { ...globalThis.fixtureRequests, data: null,
          error: "fixture-requests-failure", errorCode: "unauthorized" };
        const requestsPageErrorEn = render(RequestsPage, {}, "en");
        const trafficExchange = { id: 7, label: "openai", session: "batch-1", startedAtMs: 1000, category: "model",
          turnStateLengths: [{ source: "http.headers.x-codex-turn-state", characters: 1234 }],
          state: "completed", durationMs: 1000, hasError: true, requestModel: "model-test",
          responseModels: ["model-test"], upstreamProvider: "deepseek" };
        const trafficDetail = { ...trafficExchange, transport: "http", account: "main", threadId: "thread-1",
          turnId: "turn-1", requestKind: "response",
          modelEvidence: { serverModels: [{ source: "response.completed", model: "server-model" }],
            safetyModels: [{ source: "safety", model: "safety-model" }],
            turnStateLengths: [{ source: "http.headers.x-codex-turn-state", characters: 1234 }], truncated: true },
          parameterComparison: [{ field: "temperature", request: "0.7", response: "0.7" }],
          chatDiagnostics: { fields: { "routing.finalProvider": "deepseek", model: "upstream-model" }, truncated: true },
          request: { headers: { "content-type": "application/json" }, body: "request-body", bodyTruncated: true,
            method: "POST", path: "/v1/responses", bytes: 100, storedBytes: 90,
            parameters: { reasoningEffort: "high", serviceTier: "priority", generate: false, previousResponseId: "resp-0" },
            content: { instructions: "instructions-body",
              input: [{ type: "message", role: "user", text: "hello", name: "turn-1" }, { type: "omitted", omittedItems: 3 }],
              tools: [{ name: "tool-a", type: "function", definition: "{}" }] } },
          response: { status: 200, eventType: "response.completed", outputTruncated: true, bodyTruncated: true,
            serviceTier: "default", responseId: "resp-1", bytes: 200, storedBytes: 180,
            headers: { "x-codex-turn-state": "abc" }, body: "response-body",
            usage: { inputTokens: 100, cachedTokens: 50, outputTokens: 20, reasoningTokens: 5 },
            firstTokenMs: 100, callTiming: { totalMs: 1000 }, state: "completed",
            output: [{ type: "message", phase: "commentary", text: "answer-body" },
              { type: "reasoning", text: "reasoning-body" }, { type: "function_call", name: "tool-a", callId: "call-1" }] },
          tracePage: { offset: 0, total: 2, previousOffset: null, nextOffset: 1 },
          trace: [{ atMs: 1000, kind: "fixture-event", text: "trace-body", truncated: true }] };
        const trafficDetailProps = { provider: "openai", session: "batch-1", onTracePageChange: noop, onRetry: noop };
        const trafficDetailFailed = { ...trafficDetail, state: "failed",
          response: { ...trafficDetail.response, state: "failed", failureStage: "upstream",
            failure: "boom", errorScope: "request", error: { code: "x" } } };
        const trafficDetailPrewarm = { ...trafficDetail, category: "prewarm",
          response: { ...trafficDetail.response, output: [] } };
        const trafficDetailNoResponse = { ...trafficDetail, state: "pending", response: null };
        globalThis.fixtureDisclosureOpen = true;
        const trafficTableEn = render(TrafficTable, { exchanges: [trafficExchange], onOpen: noop }, "en");
        const trafficTableEmptyEn = render(TrafficTable, { exchanges: [], onOpen: noop }, "en");
        const trafficDetailEn = render(TrafficDetail, { ...trafficDetailProps, detail: trafficDetail }, "en");
        const trafficDetailFailedEn = render(TrafficDetail, { ...trafficDetailProps, detail: trafficDetailFailed }, "en");
        const trafficDetailPrewarmEn = render(TrafficDetail, { ...trafficDetailProps, detail: trafficDetailPrewarm }, "en");
        const trafficDetailNoResponseEn = render(TrafficDetail, { ...trafficDetailProps, detail: trafficDetailNoResponse }, "en");
        const trafficListBase = { enabled: true, label: "openai", session: null, retentionDays: 30,
          labels: [{ label: "openai", sessions: 1 }], sessions: [{ session: "batch-1", createdAtMs: 1000 }],
          exchanges: [trafficExchange], total: 1, nextOffset: null, maximumOffset: 0 };
        globalThis.fixtureTrafficQuery = { query: { id: null, limit: 50, offset: 0 }, update: noop };
        globalThis.fixtureManagementTasks = { tasks: [], loading: false, error: null, saving: false,
          pendingPreview: null, actionError: null, run: noop, refetch: noop, confirm: noop, cancelPending: noop };
        globalThis.fixtureTrafficDetail = { displayData: null, loading: false, error: null, errorCode: null, refetch: noop };
        globalThis.fixtureTrafficList = { data: trafficListBase, loading: false, error: null, errorCode: null,
          refetch: noop };
        const trafficPageEn = render(TrafficPage, {}, "en");
        globalThis.fixtureTrafficList = { ...globalThis.fixtureTrafficList, data: { ...trafficListBase, enabled: false } };
        const trafficPageDisabledEn = render(TrafficPage, {}, "en");
        globalThis.fixtureTrafficList = { ...globalThis.fixtureTrafficList, data: { ...trafficListBase, total: 5 } };
        const trafficPageLimitedEn = render(TrafficPage, {}, "en");
        globalThis.fixtureTrafficQuery = { query: { id: 7, limit: 50, offset: 0, traceOffset: 0 }, update: noop };
        globalThis.fixtureTrafficDetail = { ...globalThis.fixtureTrafficDetail, displayData: { label: "openai", session: "batch-1", exchange: trafficDetail },
          loading: false, error: null, errorCode: null, refetch: noop };
        const trafficDetailPageEn = render(TrafficPage, {}, "en");
        delete globalThis.fixtureTrafficQuery;
        delete globalThis.fixtureManagementTasks;
        delete globalThis.fixtureTrafficList;
        delete globalThis.fixtureTrafficDetail;
        delete globalThis.fixtureDisclosureOpen;
        delete globalThis.fixtureDashboard;
        delete globalThis.fixtureAccounts;
        delete globalThis.fixtureAccountManagement;
        delete globalThis.fixtureMetricsQuery;
        delete globalThis.fixtureMetricsProviders;
        delete globalThis.fixtureExport;
        delete globalThis.fixtureRequests;
        delete globalThis.fixtureErrors;
        const keys = (node, prefix) => Object.entries(node).flatMap(([key, value]) =>
          typeof value === "string" ? [prefix + key] : keys(value, prefix + key + "."));
        console.log(JSON.stringify({
          toggleZh: render(LanguageToggle, { value: "zh", onChange: noop }, "zh"),
          toggleEn: render(LanguageToggle, { value: "en", onChange: noop }, "en"),
          zhKeys: keys(messages.zh, "").sort(),
          enKeys: keys(messages.en, "").sort(),
          zhNavigationLabel: translate("zh", "shell.navigation"),
          enNavigationLabel: translate("en", "shell.navigation"),
          placeholderParity: Object.keys(zh).every(key => JSON.stringify(placeholders(zh[key])) === JSON.stringify(placeholders(en[key]))),
          zhThreads: render(ThreadTable, { threads: [], query: {}, pagination }, "zh"),
          enThreads: render(ThreadTable, { threads: [], query: {}, pagination }, "en"),
          enThreadsLoading: render(ThreadTable, { threads: [], query: {}, pagination, loading: true }, "en"),
          enTurns: render(TurnTable, { turns: [], threadId: "test", query: {}, pagination }, "en"),
          enSummary: render(QuerySummary, { aggregate: null, range: { name: "all" }, turns: 1 }, "en"),
          restoredLanguage: restore(() => "en"),
          unsupportedStoredLanguage: restore(() => "unsupported"),
          unavailableStorageLanguage: restore(() => { throw new Error("storage blocked"); }),
          enNavigation: render(SidebarProvider, { children: h(AppSidebar) }, "en"),
          enFilters: render(QueryFilters, { query: { range: "all" }, onChange: noop }, "en"),
          unknownError: translateApiError((key)=>translate("en", key), "secret-internal-details", "unrecognized"),
          prototypeError: translateApiError((key)=>translate("en", key), "secret-internal-details", "__proto__"),
          knownError: translateApiError((key)=>translate("en", key), "secret-internal-details", "invalid_range"),
          interpolated: translate("en", "threads.heading", { id: "thread-$&-<script>" }),
          errorCodeLabel: translate("en", "common.errorCode", { code: "fixture_error" }),
          consoleEn,
          consoleEnLoading,
          consoleEnEmptyAccounts,
          consoleEnQueryError,
          consoleEnListError,
          consoleEnSyncError,
          consoleEnRemoved,
          consoleEnSubscription,
          accountUpdateStaleEn,
          accountUpdateFreshEn,
          accountUpdateMissingEn,
          accountUpdateFailedEn,
          snapshotEmptyEn,
          refreshFeedbackEn,
          requestsTableEn,
          requestsTableEmptyEn,
          requestsTableLoadingEn,
          requestsPageEn,
          requestsPageErrorEn,
          errorsPageEn,
          errorsPageLoadingEn,
          errorsPageEmptyEn,
          errorsPageErrorEn,
          trafficTableEn,
          trafficTableEmptyEn,
          trafficDetailEn,
          trafficDetailFailedEn,
          trafficDetailPrewarmEn,
          trafficDetailNoResponseEn,
          trafficPageEn,
          trafficPageDisabledEn,
          trafficPageLimitedEn,
          trafficDetailPageEn,
        }));
      } finally { await server.close(); }
    `;
    result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../webui/", import.meta.url)),
      encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    })) as typeof result;
  }, 35_000);

  it("中英文键结构完全一致", () => {
    expect(result.enKeys).toEqual(result.zhKeys);
    expect(result.zhKeys.length).toBeGreaterThan(0);
  });

  it("同一键在两个语言下返回各自文案", () => {
    expect(result.zhNavigationLabel).toBe("导航");
    expect(result.enNavigationLabel).toBe("Navigation");
  });

  it("恢复有效偏好，非法值或存储不可用时使用中文", () => {
    expect(result.restoredLanguage).toBe("<span>en</span>");
    expect(result.unsupportedStoredLanguage).toBe("<span>zh</span>");
    expect(result.unavailableStorageLanguage).toBe("<span>zh</span>");
    expect(result.enNavigation).toContain("Navigation");
    expect(result.enNavigation).toContain("Settings");
    expect(result.enNavigation).not.toMatch(/[\u4e00-\u9fff]/u);
  });

  it("占位符一致，替换值按普通文本保留", () => {
    expect(result.placeholderParity).toBe(true);
    expect(result.interpolated).toBe("Thread · thread-$&-<script>");
  });

  it("Threads 链路的表头、空状态、筛选、统计与分页覆盖英文", () => {
    expect(result.zhThreads).toContain("暂无会话记录");
    for (const label of ["提供商", "会话", "轮次"]) expect(result.zhThreads).toContain(label);
    for (const label of [">Provider<", ">Thread<", ">Turn<"]) {
      expect(result.zhThreads).not.toContain(label);
      expect(result.enThreads).toContain(label);
    }
    expect(result.enThreads).toContain("No thread records");
    expect(result.enThreads).toContain("First request in range");
    expect(result.enThreads).toContain('aria-label="Next page"');
    expect(result.enTurns).toContain("Turn details");
    expect(result.enTurns).toContain("No turn details");
    expect(result.enSummary).toContain("Turns: 1");
    expect(result.enFilters).toContain("Search keywords");
    expect(result.enThreadsLoading).toContain('aria-label="Loading…"');
    expect(result.enThreadsLoading).toContain("Loading…");
    for (const html of [result.enThreads, result.enThreadsLoading, result.enTurns, result.enSummary, result.enFilters]) {
      expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
    }
  });

  it("查询错误按结构化错误码翻译且不展示内部消息", () => {
    expect(result.unknownError).toBe("Could not complete the request. Try again.");
    expect(result.prototypeError).toBe(result.unknownError);
    expect(result.knownError).toBe("Invalid query. Check the filters.");
    expect(result.unknownError).not.toContain("secret-internal-details");
  });

  it("组件按当前语言渲染无障碍标签", () => {
    expect(result.toggleZh).toContain('aria-label="切换显示语言"');
    expect(result.toggleEn).toContain('aria-label="Switch display language"');
  });

  it("控制台指标卡、图表、表格、额度与错误状态覆盖英文", () => {
    expect(result.consoleEn).toContain("Local metrics database and account status");
    expect(result.consoleEn).toContain("Summary range");
    expect(result.consoleEn).toContain("Total tokens");
    expect(result.consoleEn).toContain("Requests: 4 · Success rate: 75.0%");
    expect(result.consoleEn).toContain("Cached: 50 · Hit rate: 50.0%");
    expect(result.consoleEn).toContain("Turns: 3");
    expect(result.consoleEn).toContain("By Provider");
    expect(result.consoleEn).toContain("Compaction");
    expect(result.consoleEn).toContain("Last 30 days");
    expect(result.consoleEn).toContain("Usage trend");
    expect(result.consoleEn).toContain("No records for Last 30 days");
    expect(result.consoleEn).toContain("Activity heatmap");
    expect(result.consoleEn).toContain("Error summary");
    expect(result.consoleEn).toContain("Failure rate: 25.0%");
    expect(result.consoleEn).toContain("No failed requests");
    expect(result.consoleEn).toContain("OpenAI weekly quota");
    expect(result.consoleEn).toContain("Weekly quota remaining: 62.5%");
    expect(result.consoleEn).toContain("Local accounts and quotas");
    expect(result.consoleEn).toContain("Available balance");
    expect(result.consoleEn).toContain("Remaining credit");
    expect(result.consoleEn).toContain("5 hours");
    expect(result.consoleEn).toContain("7 days");
    expect(result.consoleEn).toContain("Monthly");
    expect(result.consoleEn).not.toMatch(/[\u4e00-\u9fff]/u);
  });

  it("控制台加载、无账户、错误、删除与订阅状态覆盖英文", () => {
    expect(result.consoleEnLoading).toContain('aria-label="Loading…"');
    expect(result.consoleEnLoading).toContain('aria-label="Loading account list"');
    expect(result.consoleEnEmptyAccounts).toContain("No DeepSeek account configured");
    expect(result.consoleEnEmptyAccounts).toContain("No OpenCode Go account configured");
    expect(result.consoleEnEmptyAccounts).toContain("No CommandCode Go account configured");
    expect(result.consoleEnQueryError).toContain("Invalid query. Check the filters.");
    expect(result.consoleEnListError).toContain("The access token is invalid or expired. Verify it again.");
    expect(result.consoleEnSyncError).toContain("The local account was removed, but the list sync failed:");
    expect(result.consoleEnSyncError).toContain("Could not complete the request. Try again.");
    expect(result.consoleEnRemoved).toContain("Local account ocg-main was removed.");
    expect(result.consoleEnRemoved).toContain("Run codexc service restart all");
    expect(result.consoleEnSubscription).toContain("No active subscription");
    expect(result.consoleEnSubscription).toContain("no active subscription");
    expect(result.consoleEnSubscription).toContain("Remove local account");
    for (const html of [
      result.consoleEnLoading,
      result.consoleEnEmptyAccounts,
      result.consoleEnQueryError,
      result.consoleEnListError,
      result.consoleEnSyncError,
      result.consoleEnRemoved,
      result.consoleEnSubscription,
    ]) {
      expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
    }
  });

  it("账户更新时间与刷新占位按当前语言渲染", () => {
    expect(result.accountUpdateStaleEn).toContain("Default account");
    expect(result.accountUpdateStaleEn).toContain("Update due");
    expect(result.accountUpdateFreshEn).toContain("Updated ");
    expect(result.accountUpdateMissingEn).toContain("Not updated yet");
    expect(result.accountUpdateFailedEn).toContain("Update failed");
    expect(result.snapshotEmptyEn).toContain('aria-label="Loading…"');
    expect(result.snapshotEmptyEn).toContain("Loading account data");
    expect(result.refreshFeedbackEn).toContain("Refresh failed");
    expect(result.refreshFeedbackEn).toContain("Showing the last successful data.");
    for (const html of [
      result.accountUpdateStaleEn,
      result.accountUpdateFreshEn,
      result.accountUpdateMissingEn,
      result.accountUpdateFailedEn,
      result.snapshotEmptyEn,
      result.refreshFeedbackEn,
    ]) {
      expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
    }
  });

  it("请求明细的表头、提示、空状态与页面文案覆盖英文", () => {
    expect(result.requestsTableEn).toContain("Records");
    expect(result.requestsTableEn).toContain("Matching records: 1 · This page: 1 · Page 1");
    expect(result.requestsTableEn).toContain("Request duration");
    expect(result.requestsTableEn).toContain("View request");
    expect(result.requestsTableEn).not.toContain("Not linked");
    expect(result.requestsTableEn).not.toContain('href="/requests/');
    expect(result.requestsTableEn).toContain("Response model: model-other (Name mismatch)");
    expect(result.requestsTableEmptyEn).toContain("No records");
    expect(result.requestsTableLoadingEn).toContain('aria-label="Loading…"');
    expect(result.requestsPageEn).toContain("Request details");
    expect(result.requestsPageEn).toContain("Export all matching requests (JSON)");
    expect(result.requestsPageErrorEn).toContain("The access token is invalid or expired. Verify it again.");
    for (const html of [
      result.requestsTableEn,
      result.requestsTableEmptyEn,
      result.requestsTableLoadingEn,
      result.requestsPageEn,
      result.requestsPageErrorEn,
    ]) {
      expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
    }
  });

  it("错误页面的统计、表头、分页、空状态与错误提示覆盖英文", () => {
    expect(result.errorsPageEn).toContain("Failed request records, newest first");
    expect(result.errorsPageEn).toContain("Total requests · Failed: 60");
    expect(result.errorsPageEn).toContain("Success rate · Showing 1 / 60 failed records");
    expect(result.errorsPageEn).toContain("Error detail");
    expect(result.errorsPageEn).toContain("Thread / Turn");
    expect(result.errorCodeLabel).toBe("Error code: fixture_error");
    expect(result.errorsPageEn).toContain("Page 1");
    expect(result.errorsPageEn).toContain("Previous page");
    expect(result.errorsPageEn).toContain("Next page");
    expect(result.errorsPageLoadingEn).toContain("Loading…");
    expect(result.errorsPageEmptyEn).toContain("No failed requests");
    expect(result.errorsPageErrorEn).toContain("The requested data was not found or has been removed.");
    for (const html of [result.errorsPageEn, result.errorsPageLoadingEn, result.errorsPageEmptyEn, result.errorsPageErrorEn]) {
      expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
    }
  });

  it("调用列表与详情的表格、提示、空状态与失败覆盖英文", () => {
    expect(result.trafficTableEn).not.toContain("Turn State characters");
    expect(result.trafficTableEn).toContain("Started at");
    expect(result.trafficTableEn).toContain("Request duration");
    expect(result.trafficTableEn).toContain("Model request");
    expect(result.trafficTableEn).toContain("Completed");
    expect(result.trafficTableEmptyEn).toContain("No traffic records");
    expect(result.trafficDetailEn).toContain("Diagnostics");
    expect(result.trafficDetailEn).toContain("Request headers and raw body");
    expect(result.trafficDetailEn).toContain("Response service tier: default");
    expect(result.trafficDetailEn).toContain("Copy reference");
    expect(result.trafficDetailFailedEn).toContain("Request failed");
    expect(result.trafficDetailFailedEn).toContain("Failure stage: upstream");
    expect(result.trafficDetailPrewarmEn).toContain("This request produces no answer.");
    expect(result.trafficDetailNoResponseEn).toContain("No terminal state recorded");
    for (const html of [result.trafficTableEn, result.trafficTableEmptyEn, result.trafficDetailEn,
      result.trafficDetailFailedEn, result.trafficDetailPrewarmEn, result.trafficDetailNoResponseEn]) {
      expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
    }
  });

  it("调用页面的标题、筛选、保留策略、告警与分页覆盖英文", () => {
    expect(result.trafficPageEn).toContain("Traffic");
    expect(result.trafficPageEn).toContain("Recorded model request and response fields");
    expect(result.trafficPageEn).toContain("Recorded session");
    expect(result.trafficPageEn).toContain("openai · All 1 retained sessions");
    expect(result.trafficPageEn).toContain("Request records (1)");
    expect(result.trafficPageEn).toContain("Automatic retention: 30 days");
    expect(result.trafficPageEn).toContain("Per page");
    expect(result.trafficPageDisabledEn).toContain("Traffic recording is currently disabled");
    expect(result.trafficPageDisabledEn).toContain("[debug].model_traffic_dump</code>");
    expect(result.trafficPageDisabledEn).toContain("off, no new records are written");
    expect(result.trafficPageLimitedEn).toContain("Traffic pagination limit reached");
    expect(result.trafficPageLimitedEn).toContain("codexc traffic</code> to view them");
    expect(result.trafficDetailPageEn).toContain("Call detail");
    expect(result.trafficDetailPageEn).toContain("View the result, usage and diagnostics for this request");
    expect(result.trafficDetailPageEn).toContain("Back to list");
    for (const html of [result.trafficPageEn, result.trafficPageDisabledEn, result.trafficPageLimitedEn, result.trafficDetailPageEn]) {
      expect(html).not.toMatch(/[\u4e00-\u9fff]/u);
    }
  });

  it("导出失败保留网络与超时分类，并按当前语言翻译", () => {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", String.raw`
      import { createServer } from "vite";
      // 执行生产 Hook 的下载路径，仅用内存槽模拟 React 状态，网络由 fetch fixture 隔离。
      const server = await createServer({server:{middlewareMode:true},appType:"custom",logLevel:"silent",plugins:[{
        name:"export-hook-state",enforce:"pre",
        transform(code,id) {
          if (!id.endsWith("/src/hooks/use-metrics-export.ts")) return;
          return code.replace('import { useEffect, useRef, useState } from "react"',
            'const { useEffect, useRef, useState } = globalThis.exportHooks');
        }
      }]});
      const slots=[]; let cursor=0;
      globalThis.exportHooks={
        useRef(value){const i=cursor++;return slots[i]??=( {current:value} );},
        useState(value){const i=cursor++;if(!(i in slots))slots[i]=value;return [slots[i],next=>{slots[i]=next}];},
        useEffect(){}
      };
      try {
        const {useMetricsExport}=await server.ssrLoadModule("/src/hooks/use-metrics-export.ts");
        const {translate,translateApiErrorCode}=await server.ssrLoadModule("/src/lib/i18n/translate.ts");
        const read=()=>{cursor=0;return useMetricsExport({range:"all"});};
        const results=[];
        for (const cause of [new TypeError("private network detail"),new DOMException("private timeout detail","TimeoutError"),new Error("private internal detail"),null]) {
          globalThis.fetch=async()=>{
            if(cause)throw cause;
            return Response.json({error:{code:"forbidden",message:"private API detail"}},{status:403});
          };
          const task=read().download();
          const pending=read();
          await task;
          const failed=read();
          results.push({pending:pending.pending,cleared:!pending.failed,failed:failed.failed,settled:!failed.pending,code:failed.errorCode,
            zh:translateApiErrorCode(key=>translate("zh",key),failed.errorCode),
            en:translateApiErrorCode(key=>translate("en",key),failed.errorCode)});
        }
        console.log(JSON.stringify(results));
      } finally {await server.close();}
    `], { cwd: fileURLToPath(new URL("../webui", import.meta.url)), encoding: "utf8", timeout: 30_000 });
    const results = JSON.parse(output) as Array<{ pending: boolean; cleared: boolean; failed: boolean; settled: boolean; code: string | null; zh: string; en: string }>;
    expect(results.map(result => result.code)).toEqual(["network_error", "request_timeout", null, "forbidden"]);
    for (const result of results) {
      expect(result).toMatchObject({ pending: true, cleared: true, failed: true, settled: true });
      expect(result.zh).toMatch(/[\u4e00-\u9fff]/u);
      expect(result.en).not.toMatch(/[\u4e00-\u9fff]/u);
      expect(result.zh + result.en).not.toContain("private");
    }
    expect(results[0]!.en).toBe("Cannot reach the service. Check your connection and retry.");
    expect(results[1]!.en).toMatch(/timed out/i);
    expect(results[2]!.en).toBe("Could not complete the request. Try again.");
  }, 30_000);

});
