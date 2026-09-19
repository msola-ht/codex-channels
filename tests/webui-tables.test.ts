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
      const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent" });
      try {
        const { RequestsTable } = await server.ssrLoadModule("/src/components/requests/requests-table.tsx");
        const { ThreadTable } = await server.ssrLoadModule("/src/components/threads/thread-table.tsx");
        const { TurnTable } = await server.ssrLoadModule("/src/components/threads/turn-table.tsx");
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
        const result = {
          requests: render(RequestsTable, requestProps),
          ascending: render(RequestsTable, { ...requestProps, sorting: [{ id: "tokensPerSecond", desc: false }] }),
          threads: render(ThreadTable, { threads: [{ ...common, threadId: "thread-1", agentPath: null,
            parentThreadId: null, turnCount: 1, firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 }], query: {}, pagination }),
          turns: render(TurnTable, { turns: [{ ...common, turnId: "turn-1" }], threadId: "thread-1", query: {}, pagination }),
        };
        globalThis.localStorage = { getItem: key => key.endsWith(":columns") ? JSON.stringify({ ua: true, error: true }) : null };
        result.preferences = render(RequestsTable, requestProps);
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

  it("groups request identity, usage, performance and detail columns", () => {
    expect(headers(markup.requests!)).toEqual([
      "时间", "Provider", "模型", "状态", "输入 Token", "输出 Token",
      "首字耗时", "总耗时", "Token/s", "调用详情",
    ]);
    expect(markup.requests).not.toContain('role="checkbox"');
    expect(markup.requests).not.toContain("已选");
    expect(markup.requests).toContain("名称不一致");
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
});
