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
  };

  beforeAll(() => {
    // 复用 WebUI 自身的 Vite/React 依赖渲染真实组件。
    const script = String.raw`
      import { createServer } from "vite";
      import { createElement as h } from "react";
      import { MemoryRouter } from "react-router";
      import { renderToStaticMarkup } from "react-dom/server";
      const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
      try {
        const { LanguageContext, useLanguage } = await server.ssrLoadModule("/src/hooks/language-context.ts");
        const { LanguageToggle } = await server.ssrLoadModule("/src/components/metrics/language-toggle.tsx");
        const { translate, translateApiError } = await server.ssrLoadModule("/src/lib/i18n/translate.ts");
        const { messages } = await server.ssrLoadModule("/src/lib/i18n/messages.ts");
        const { ThreadTable } = await server.ssrLoadModule("/src/components/threads/thread-table.tsx");
        const { TurnTable } = await server.ssrLoadModule("/src/components/threads/turn-table.tsx");
        const { QuerySummary } = await server.ssrLoadModule("/src/components/metrics/query-summary.tsx");
        const { QueryFilters } = await server.ssrLoadModule("/src/components/metrics/query-filters.tsx");
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
    for (const html of [result.enThreads, result.enTurns, result.enSummary, result.enFilters]) {
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
});
