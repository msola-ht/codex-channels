import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

describe("WebUI 界面文案语言切换", () => {
  let result: {
    toggleZh: string;
    toggleEn: string;
    zhKeys: string[];
    enKeys: string[];
    zhSubtitle: string;
    enSubtitle: string;
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
          h(LanguageContext.Provider, { value: { language, setLanguage: noop } }, h(MemoryRouter, null, h(TooltipProvider, null, h(component, props)))));
        const clock = { nowMs: Date.now(), receivedAtMs: Date.now(), timeZone: "UTC" };
        const renderWithClock = (component, props, language) => renderToStaticMarkup(
          h(LanguageContext.Provider, { value: { language, setLanguage: noop } }, h(MemoryRouter, null,
            h(TooltipProvider, null, h(ServerTimeContext.Provider, { value: clock }, h(component, props))))));
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
          weeklyQuota: { usedPercent: 37.5, resetsAt: 1000, planType: "plus" },
          data: { range, generatedAt: "2026-01-01T00:00:00.000Z", global: aggregate, threadCount: 2, turnCount: 3,
            providers: [{ provider: "openai", model: "model-test", aggregate, threadCount: 2, turnCount: 3 }],
            errors: { startAtMs: 1000, endAtMs: 2000, requestCount: 4, unsuccessfulRequestCount: 1, groups: [], totalGroupCount: 0 },
            weeklyQuota: null, trend: { range, generatedAt: "2026-01-01T00:00:00.000Z", granularity: "day", daily: [] },
            heatmap: { range, generatedAt: "2026-01-01T00:00:00.000Z", daily: [] } },
          loading: false, error: null, errorCode: null, refetch: noop,
        };
        const baseAccounts = {
          data: { deepseek: { accounts: [{ provider: "deepseek", account: "main", displayName: "DeepSeek main",
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
        delete globalThis.fixtureDashboard;
        delete globalThis.fixtureAccounts;
        delete globalThis.fixtureAccountManagement;
        const keys = (node, prefix) => Object.entries(node).flatMap(([key, value]) =>
          typeof value === "string" ? [prefix + key] : keys(value, prefix + key + "."));
        console.log(JSON.stringify({
          toggleZh: render(LanguageToggle, { value: "zh", onChange: noop }, "zh"),
          toggleEn: render(LanguageToggle, { value: "en", onChange: noop }, "en"),
          zhKeys: keys(messages.zh, "").sort(),
          enKeys: keys(messages.en, "").sort(),
          zhSubtitle: translate("zh", "shell.subtitle"),
          enSubtitle: translate("en", "shell.subtitle"),
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
    expect(result.zhSubtitle).toBe("本地指标与设置");
    expect(result.enSubtitle).toBe("Local metrics and settings");
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
    expect(result.consoleEn).toContain("Used 37.5%");
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
});
