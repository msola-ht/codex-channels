import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { SqliteModelRequestMetricsStore } from "../src/observability/index.js";
import { sample } from "./request-metrics-fixtures.js";

describe("WebUI metrics table presentation", () => {
  let markup: Record<string, string>;
  it("shows recorded reasoning effort immediately after model in every request metrics table", () => {
    const tables = ["requests", "errors", "threads", "turns", "traffic", "subagentsRelated", "allSubagents"];
    for (const table of tables) {
      const labels = headers(markup[table]!);
      expect(labels[labels.indexOf("模型") + 1]).toBe("思考");
      const cells = [...markup[table]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)];
      expect(cells[labels.indexOf("思考")]?.[1]?.replace(/<[^>]*>/gu, "")).toBe("high");
      for (const [variant, expected] of [["null", "—"], ["none", "none"], ["future", "future"]]) {
        const html = markup[`${table}-reasoning-${variant}`]!;
        const values = [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)];
        expect(values[headers(html).indexOf("思考")]?.[1]?.replace(/<[^>]*>/gu, "")).toBe(expected);
      }
    }
    for (const name of ["threadsEn", "subagentsRelatedEn", "allSubagentsEn"]) {
      const labels = headers(markup[name]!);
      expect(labels[labels.indexOf("Model") + 1]).toBe("Reasoning");
    }
  });
  it("separates client interruptions from failures in cards and turn columns", () => {
    for (const name of ["interruptedSummary", "interruptedGlobal", "interruptedErrorsSummary"]) {
      expect(markup[name]).toContain("完成 2 · 客户端中断 5 · 其他失败 1 · 未完整观测 2");
      expect(markup[name]).not.toContain("失败 8");
    }
    expect(markup.interruptedSummaryEn).toContain("Completed: 2 · Client interruptions: 5 · Other failures: 1 · Not fully observed: 2");
    expect(markup.interruptedErrorsSummary).toContain("失败率 10.0%");
    expect(headers(markup.interruptedTurns!)).toContain("中断");
    expect(headers(markup.interruptedTurns!)).toContain("未完整");
    const cells = [...markup.interruptedTurns!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)].map(match => match[1]?.replace(/<[^>]*>/gu, ""));
    expect(cells[headers(markup.interruptedTurns!).indexOf("失败")]).toBe("1");
    expect(cells[headers(markup.interruptedTurns!).indexOf("中断")]).toBe("5");
    expect(cells[headers(markup.interruptedTurns!).indexOf("输入")]).toBe("≥ 100");
    expect(cells[headers(markup.interruptedTurns!).indexOf("命中率")]).toBe("50.0%");
    expect(markup.interruptedTurns).toContain('aria-description="按已记录的输入和缓存用量计算；未观测到的用量不参与计算。"');
    expect(markup.interruptedTurnsEn).toContain('aria-description="Calculated from recorded input and cached usage; unobserved usage is excluded."');
    for (const [name, rate] of [["interruptedTurnsZeroCache", "0.0%"], ["interruptedTurnsUnknownCache", "—"], ["interruptedTurnsUnknown", "—"]]) {
      const cacheCell = [...markup[name!]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)][headers(markup[name!]!).indexOf("命中率")]?.[1];
      expect(cacheCell?.replace(/<[^>]*>/gu, "")).toBe(rate);
      if (rate === "—") expect(cacheCell).not.toContain("aria-description");
    }
    const unknown = [...markup.interruptedTurnsUnknown!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)].map(match => match[1]?.replace(/<[^>]*>/gu, ""));
    expect(unknown[headers(markup.interruptedTurnsUnknown!).indexOf("输入")]).toBe("—");
    expect(unknown[headers(markup.interruptedTurnsUnknown!).indexOf("输出")]).toBe("—");
    expect(markup.interruptedTurns).not.toContain("重试成功");
    expect(markup.interruptedTurns).not.toContain("正常取消");
  });
  it("presents interruption records neutrally while retaining the recorded status and unknown usage", () => {
    for (const name of ["interruptedRequests", "interruptedErrors", "interruptedRequestDetail"]) {
      expect(markup[name]).toContain("客户端中断");
      expect(markup[name]).toContain("当前记录无法确定断开原因");
      expect(markup[name]).not.toContain("request failed due to cancellation");
    }
    expect(markup.interruptedRequestDetail).toContain("原始请求状态");
    expect(markup.interruptedRequestDetail).toContain(">failed</dd>");
    expect(markup.interruptedRequestDetailEn).toContain("Client interruption; the record does not establish why the connection closed.");
    expect(markup.interruptedRequestDetail).not.toContain(">0</dd>");
  });
  it("keeps total and own token columns and omits flat type and parent columns", () => {
    expect(markup.threads).toContain("共 1 个匹配主会话");
    expect(markup.threadsEn).toContain("Matching main threads: 1");
    expect(markup.threads).not.toContain("本页主会话");
    expect(markup.threadsEn).not.toContain("This page:");
    expect(headers(markup.threads!)).not.toContain("类型");
    expect(headers(markup.threads!)).not.toContain("父会话");
    expect(markup.subagentDetailParent).toContain("子代理");
  });
  it("renders descendant breakdown and overall total in an accessible tooltip, including descendant-only matches", () => {
    const cell = (html: string, label: string) => [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)][headers(html).indexOf(label)]?.[1]?.replace(/<[^>]*>/g, "");
    expect(headers(markup.threads!)).toEqual(["期间首次请求", "会话", "提供商", "模型", "思考", "轮次", "请求", "输入", "命中率", "输出", "总计", "总耗时", "最后记录", "子代理"]);
    expect(cell(markup.threads!, "输入")).toBe("100");
    expect(cell(markup.threads!, "命中率")).toBe("50.0%");
    expect(cell(markup.threads!, "输出")).toBe("20");
    expect(cell(markup.threads!, "总计")).toBe("1.08K");
    expect(markup.threads).toContain('aria-description="子代理: 输入: 800, 缓存: 300, 缓存命中率: 37.5%, 输出: 160, 合计: 960. 总计: 1.08K"');
    expect(markup.threads).toMatch(/<span[^>]*tabindex="0"[^>]*data-slot="tooltip-trigger"/u);
    expect(cell(markup.threadsChildOnly!, "总计")).toBe("1.08K");
    expect(cell(markup.threadsChildOnly!, "输入")).toBe("0");
    expect(cell(markup.threadsChildOnly!, "命中率")).toBe("—");
    expect(cell(markup.threadsChildOnly!, "输出")).toBe("0");
    expect(cell(markup.threadsUnknownCache!, "命中率")).toBe("—");
    expect(cell(markup.threadsPartialCache!, "命中率")).toBe("50.0%");
    expect(markup.threadsChildOnly).toContain('aria-description="子代理: 输入: 900, 缓存: —, 缓存命中率: —, 输出: 180, 合计: 1.08K. 总计: 1.08K"');
    expect(cell(markup.threadsChildOnly!, "模型")).toBe("—");
    expect(markup.threadsChildOnly).not.toContain("NaN");
    expect(markup.threadTotalSorting).toBe("totalTokens:desc");
    expect(headers(markup.threadsEn!)).toContain("Total");
    expect(markup.threadsEn).toContain('aria-description="Subagents: Input: 800, Cached: 300, Cache hit rate: 37.5%, Output: 160, Subtotal: 960. Total: 1.08K"');
  });
  it("shows a single descendant-inclusive summary and hides stale totals on query changes", () => {
    expect(markup.threadsPage).toContain("含子代理");
    expect(markup.threadsPage).toContain("输入 950 · 缓存 350");
    expect(markup.threadsPage).toContain("输出 190");
    expect(markup.threadsPage).not.toContain("主会话自身");
    expect(markup.threadsPage).not.toContain("合计按请求去重");
    expect(markup.threadsPage).not.toContain("使用相同时间范围和请求筛选");
    expect(markup.threadsPage).not.toContain("仅子代理匹配时也显示主会话");
    expect(markup.threadsPage).not.toContain("轮次：");
    expect(markup.threadsPageEn).toContain("Including subagents");
    expect(markup.threadsPageEn).toContain("Input: 950 · Cached: 350");
    expect(markup.threadsPageLoading).toMatch(/class="[^"]*invisible" aria-hidden="true"><span>含子代理/u);
    expect(markup.threadsPageEmpty).toContain("输入 0 · 缓存 —");
    expect(markup.threadsPageEmpty).not.toContain("NaN");
  });
  it("links main and child counts to independent subagent pages without inheriting metrics filters", () => {
    expect(markup.subagentsCollapsedCalls).toBe("0");
    expect(markup.subagentsCollapsed).not.toContain('aria-controls=');
    expect(markup.subagentsCollapsed).not.toContain("/root/worker");
    expect(markup.subagentsCollapsed).toContain('href="/threads/thread-1/subagents"');
    expect(markup.subagentsRelated).toContain('/threads/child%2Fone?range=all');
    expect(markup.subagentsRelated).toContain('data-slot="table"');
    expect(headers(markup.subagentsRelated!)).toEqual(["首次请求", "子代理", "会话", "提供商", "模型", "思考", "轮次", "请求", "输入", "命中率", "输出", "最后记录", "子代理"]);
    expect(markup.subagentsRelated).toContain('aria-sort="descending"');
    expect(markup.subagentsRelated).toContain("model-test");
    expect(markup.subagentsRelated).toContain("openai");
    expect(markup.subagentsRelated).toContain("50.0%");
    expect(markup.subagentsRelated).toContain('title="/root/worker"');
    expect(markup.subagentsRelated).toContain(">worker</a>");
    expect(markup.subagentsRelated).toContain("子代理 2");
    expect(markup.subagentsRelated).toContain('data-slot="badge"');
    expect(markup.subagentsRelated).toContain('href="/threads/child%2Fone/subagents"');
    expect(markup.subagentsRelated).toContain("共 21 个子代理");
    expect(markup.subagentsRelatedEn).toContain("Subagents: 21");
    expect(markup.subagentsRelatedEn).toContain("Subagents 2");
    expect(markup.subagentsRelated).toContain('data-slot="dropdown-menu-trigger"');
    expect(markup.subagentsRelated).toContain('role="combobox"');
    expect(markup.subagentsRelated).not.toContain("父会话");
    expect(markup.subagentsRelated).not.toContain("登记时间");
    expect(markup.subagentsRelated).not.toContain("filtered-");
  });
  it("shows model usage cards across pages with known-cache rates and localized input breakdowns", () => {
    const summary = (html: string, label = "模型") => html.match(new RegExp(`<section aria-label="${label}"[^>]*>([\\s\\S]*?)</section>`))?.[1]?.replace(/ id="[^"]*"/gu, "");
    const cards = summary(markup.subagentsRelated!);
    expect(cards).toBeDefined();
    expect(cards?.match(/data-slot="card"/gu)).toHaveLength(2);
    expect(cards).toContain("model-card-one");
    expect(cards).toContain("model-card-two");
    expect(cards?.match(/<dd\b[^>]*>([\s\S]*?)<\/dd>/gu)?.map(cell => cell.replace(/<[^>]*>/gu, "")))
      .toEqual(["2K", "75.0%", "500", "4K", "—", "0"]);
    expect(cards).toContain('aria-description="缓存：≥ 750; 无缓存：≥ 250"');
    expect(cards).not.toMatch(/aria-description="[^"]*命中率/u);
    expect(summary(markup.subagentsLastPage!)).toBe(cards);
    expect(summary(markup.allSubagents!)).toBe(cards);
    const english = summary(markup.subagentsRelatedEn!, "Model");
    expect(english).toContain("Input tokens");
    expect(english).toContain("Cache hit rate");
    expect(english).toContain("Output tokens");
    for (const key of ["subagentsEmpty", "subagentsLoading", "subagentsFailed"]) {
      expect(summary(markup[key]!)).toBeUndefined();
    }
  });
  it("shows localized relationship states and keeps a detail navigation entry when metrics fail", () => {
    expect(markup.subagentsEmpty).toContain("尚未登记子代理");
    expect(markup.subagentsEmptyEn).toContain("No subagents registered");
    expect(markup.subagentsEmpty).toContain('data-slot="table"');
    expect(markup.subagentsFailed).toContain("无法连接服务");
    expect(markup.subagentsFailed).toContain("重试");
    expect(markup.subagentsFailed).not.toContain("hidden-internal-error");
    expect(markup.subagentsLoading).toContain('aria-busy="true"');
    expect(markup.subagentsLoading).toContain('data-slot="skeleton"');
    expect(markup.subagentsWithFailedMetrics).toContain("查看子代理");
    expect(markup.subagentsWithFailedMetrics).not.toContain('data-slot="table"');
    expect(markup.detailSubagentCalls).toBe("0");
    expect(markup.subagentDetailParent).toContain('/threads/parent%2Fthread?range=all');
    expect(markup.subagentDetailParent).toContain('/requests?range=all&amp;threadId=parent%2Fthread&amp;turnId=creation%2Fturn');
    expect(markup.subagentDetailParent).toContain("不包含后续派发任务的全部轮次");
  });
  it("shows filtered summaries without historical totals and links each turn to its subagents", () => {
    expect(markup.threadTiming).toContain("当前筛选");
    expect(markup.threadTimingEn).toContain("Current filters");
    expect(markup.threadTiming).not.toContain("历史累计");
    expect(markup.threadTimingEn).not.toContain("Historical totals");
    expect(markup.threadTiming).not.toContain("<details");
    expect(markup.threadTiming).not.toContain("最近轮次");
    expect(markup.threadDetailLoading).toMatch(/<section[^>]*class="[^"]*invisible"[^>]*inert=""[^>]*aria-hidden="true"/u);
    expect(markup.turnsWithSubagents).toContain('href="/threads/parent%2Fthread/subagents?parentTurnId=turn%2Fone"');
    expect(markup.turnsWithSubagents).toContain('aria-label="查看轮次 turn/one 的 2 个子代理"');
    expect(markup.turns).not.toContain('/subagents?parentTurnId=');
    expect(markup.turnsLongId).toContain('>01a106b6…8882</a>');
    expect(markup.turnsLongId).toContain('aria-description="01a106b6-f258-7b82-bed0-157cc3e38882"');
    expect(markup.turnsLongId).toMatch(/<a\b[^>]*aria-description="01a106b6-f258-7b82-bed0-157cc3e38882"[^>]*>/u);
    expect(markup.turnSubagentsPage).toContain("关联轮次：turn/one");
    expect(markup.turnSubagentsPage).toContain("并非只计该父轮次内的用量");
  });
  const periodSection = (html: string) => html.match(/<section\b[^>]*aria-label="(?:当前筛选|Current filters)"[^>]*>([\s\S]*?)<\/section>/u)?.[1] ?? "";
  const periodCards = (html: string) => periodSection(html).split(/<div data-slot="card"/u).slice(1);
  const periodActivity = (html: string) => periodSection(html).match(/<p\b[^>]*aria-label="(?:轮次与请求|Turns and requests)[^"]*"[^>]*>([\s\S]*?)<\/p>/u)?.[1] ?? "";
  const periodCounts = (html: string) => [...periodActivity(html).replace(/<[^>]*>/gu, "").matchAll(/(?:轮次|请求|Turn|Requests) ([^·]+) · /gu)].map(match => match[1]);
  const values = (html: string) => [...html.matchAll(/<dd\b[^>]*>([\s\S]*?)<\/dd>/gu)].map(match => match[1]?.replace(/<[^>]*>/gu, ""));
  it("combines counts and outcomes below three token cards with separate subtotals", () => {
    for (const key of ["threadTiming", "threadTimingEn"]) {
      const cards = periodCards(markup[key]!);
      const english = key.endsWith("En");
      expect(cards).toHaveLength(3);
      expect(cards.map(card => card.match(/data-slot="card-title"[^>]*>([^<]*)</u)?.[1]))
        .toEqual(english ? ["Input tokens", "Output tokens", "Total"] : ["输入 Token", "输出 Token", "合计"]);
      const counts = periodActivity(markup[key]!);
      expect(periodSection(markup[key]!).split(/<div data-slot="card"/u)[0]).not.toContain("<dl");
      expect(counts.replace(/<[^>]*>/gu, "")).toBe(english
        ? "Turn 5 · Requests 6 · Completed: 4 · Client interruptions: 1 · Other failures: 1 · Not fully observed: 0"
        : "轮次 5 · 请求 6 · 完成 4 · 客户端中断 1 · 其他失败 1 · 未完整观测 0");
      expect(periodCounts(markup[key]!)).toEqual(["5", "6"]);
      expect(counts).toContain(english ? 'aria-description="Thread 2 + Subagents 3"' : 'aria-description="会话 2 + 子代理 3"');
      expect(counts).toContain(english ? 'aria-description="Thread 1 + Subagents 5"' : 'aria-description="会话 1 + 子代理 5"');
      for (const card of cards.slice(0, 2)) {
        expect([...card.matchAll(/<dt\b[^>]*>([^<]*)</gu)].map(match => match[1]))
          .toEqual(english ? ["Thread", "Subagents"] : ["会话", "子代理"]);
      }
      expect([...cards[2]!.matchAll(/<dt\b[^>]*>([^<]*)</gu)].map(match => match[1]))
        .toEqual(english ? ["Thread", "Subagents", "Total"] : ["会话", "子代理", "合计"]);
      expect(values(cards[0]!)).toEqual(["100", "800"]);
      expect(values(cards[1]!)).toEqual(["20", "160"]);
      expect(cards[1]).toContain(english ? 'aria-description="Reasoning output: 5; Non-reasoning output: 15"' : 'aria-description="推理输出：5; 非推理输出：15"');
      expect(cards[1]).toContain(english ? 'aria-description="Reasoning output: 5; Non-reasoning output: 155"' : 'aria-description="推理输出：5; 非推理输出：155"');
      expect(cards[0]).toContain("50.0%");
      expect(cards[0]).toContain("37.5%");
      expect(values(cards[2]!)).toEqual(["120", "960", "1.08K"]);
      expect(cards[2]).not.toContain(english ? "Input + output" : "输入 + 输出");
      expect(markup[key]).not.toContain(english ? "Own" : "自身");
    }
    expect(periodCards(markup.threadTiming!)[0]).toContain('aria-description="缓存：300; 无缓存：500"');
    expect(periodCards(markup.threadTimingEn!)[0]).toContain('aria-description="Cached: 300; Uncached: 500"');
  });
  it("keeps descendant partial cache information, unknown cache and empty filtered totals distinct", () => {
    const partial = periodCards(markup.threadPeriodPartialCache!)[0]!;
    expect(values(partial)).toEqual(["100", "1K"]);
    expect(partial).toContain('aria-description="缓存：≥ 30; 无缓存：≥ 30"');
    expect(partial).toContain("50.0%");
    const unknown = periodCards(markup.threadPeriodUnknownCache!)[0]!;
    expect(values(unknown)).toEqual(["100", "800"]);
    expect(unknown).toMatch(/aria-description="缓存命中率"[^>]*>—</u);
    expect(unknown).not.toContain("缓存：0");
    const empty = periodCards(markup.threadPeriodEmpty!);
    expect(periodCounts(markup.threadPeriodEmpty!)).toEqual(["0", "0"]);
    expect(values(empty[0]!)).toEqual(["0", "0"]);
    expect(values(empty[1]!)).toEqual(["0", "0"]);
    expect(values(empty[2]!)).toEqual(["0", "0", "0"]);
    expect(empty[0]?.match(/aria-description="缓存命中率"[^>]*>—</gu)).toHaveLength(2);
    expect(markup.threadPeriodEmpty).not.toContain("NaN");
    const descendantsOnly = periodCards(markup.threadPeriodDescendantsOnly!);
    expect(periodCounts(markup.threadPeriodDescendantsOnly!)).toEqual(["3", "5"]);
    expect(values(descendantsOnly[0]!)).toEqual(["0", "800"]);
    expect(values(descendantsOnly[1]!)).toEqual(["0", "160"]);
    expect(values(descendantsOnly[2]!)).toEqual(["0", "960", "960"]);
  });
  it("renders database cache pairs consistently in the period cards and interrupted Turn rates", () => {
    for (const [name, rate, input] of [["complementary", "—", "300"], ["unobserved", "50.0%", "100"]]) {
      const card = periodCards(markup[`pairedCache-${name}`]!)[0]!;
      expect(values(card)[0]).toBe(input);
      expect(card).toContain("50.0%");
      expect(card).toContain('aria-description="缓存：≥ 50; 无缓存：≥ 50"');
      expect(card).not.toContain("缓存：60");
      expect(card).not.toContain("无缓存：240");
      const table = markup[`pairedCacheTurns-${name}`]!;
      const cacheCell = [...table.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gu)][headers(table).indexOf("命中率")]?.[1];
      expect(cacheCell?.replace(/<[^>]*>/gu, "")).toBe(rate);
      expect(table).not.toContain("20.0%");
    }
  });
  it("marks descendants and total unavailable for an applied exact turn filter in both languages", () => {
    for (const key of ["threadPeriodExactTurn", "threadPeriodExactTurnEn"]) {
      const cards = periodCards(markup[key]!);
      expect(periodCounts(markup[key]!)).toEqual(["—", "—"]);
      expect(periodActivity(markup[key]!)).toContain(key.endsWith("En") ? 'aria-description="Thread 1 + Subagents —"' : 'aria-description="会话 1 + 子代理 —"');
      expect(markup[key]).toContain(key.endsWith("En") ? 'aria-label="Turns and requests (thread)"' : 'aria-label="轮次与请求（会话）"');
      expect(periodActivity(markup[key]!)).toContain(key.endsWith("En") ? "Completed: 1" : "完成 1");
      expect(markup[key]).not.toContain(key.endsWith("En") ? "Turns and requests (including subagents)" : "轮次与请求（含子代理）");
      expect(values(cards[0]!)).toEqual(["100", "—"]);
      expect(values(cards[1]!)).toEqual(["20", "—"]);
      expect(cards[1]?.match(/data-slot="tooltip-trigger"/gu)).toHaveLength(1);
      expect(values(cards[2]!)).toEqual(["120", "—", "—"]);
      expect(markup[key]).toContain(key.endsWith("En") ? "descendant requests cannot be assigned to a parent turn" : "无法确定后代请求属于哪个父轮次");
    }
  });
  it("renders the independent page and breadcrumb for an encoded owning thread without reading detail metrics", () => {
    expect(markup.subagentsPage).toContain("子代理 · parent/thread");
    expect(markup.subagentsPage).toContain('href="/threads/parent%2Fthread?range=all"');
    expect(markup.subagentsPage).toContain("返回所属会话");
    expect(markup.subagentsPage).toContain('/threads/child%2Fone?range=all');
    expect(markup.subagentsPageEn).toContain("Subagents · parent/thread");
    expect(markup.subagentsPageEn).toContain("Back to owning thread");
    expect(markup.subagentsPageDetailCalls).toBe("0");
    expect(markup.subagentsBreadcrumb).toContain('href="/threads/parent%2Fthread?range=all"');
    expect(markup.subagentsBreadcrumb).toContain("parent/thread");
    expect(markup.subagentsBreadcrumb).toContain("关联子代理");
    expect(markup.subagentsBreadcrumb).not.toContain("parent/thread/subagents");
  });
  it("uses server pagination for registered relationships, without inventing creation turns", () => {
    expect(markup.subagentsRelated).toMatch(/disabled=""[^>]*aria-label="上一页"/u);
    expect(markup.subagentsRelated).not.toMatch(/disabled=""[^>]*aria-label="下一页"/u);
    expect(markup.subagentsLastPage).toMatch(/disabled=""[^>]*aria-label="下一页"/u);
    expect(markup.subagentsLastPage).not.toMatch(/disabled=""[^>]*aria-label="上一页"/u);
    expect(markup.subagentsRelated).toContain("第 1 页");
    expect(markup.subagentsLastPage).toContain("第 2 页");
    expect(markup.subagentsLastPage).not.toContain("子代理 2");
    expect(markup.subagentsSingle).toContain("共 1 个子代理");
    expect(markup.subagentsSingle).toMatch(/disabled=""[^>]*aria-label="下一页"/u);
    expect(markup.subagentsEmpty).toContain("第 1 页");
    expect(markup.subagentsEmpty).toMatch(/disabled=""[^>]*aria-label="下一页"/u);
  });
  it("uses the shared DataTable for all registered subagents and links their owning threads", () => {
    expect(markup.allSubagents).toContain("全部子代理");
    expect(markup.allSubagentsEn).toContain("All subagents");
    expect(headers(markup.allSubagents!)).toContain("父会话");
    expect(markup.allSubagents).toContain('href="/threads/parent%2Fthread?range=all"');
    expect(markup.allSubagents).toContain('data-slot="dropdown-menu-trigger"');
    expect(markup.allSubagents).toContain('role="combobox"');
    expect(markup.allSubagents).toContain("[contain:size]");
    expect(markup.allSubagents).toContain("minmax(10rem,1fr) auto");
    expect(markup.allSubagents).not.toContain("filtered-");
    expect(markup.allSubagentsCalls).toBe("all,all");
    expect(markup.subagentSortCycle).toBe("last:asc,last:desc,time:desc,time:asc,time:desc");
    expect(markup.subagentDetailParent).toContain("min-h-[20rem] flex-1");
    expect(markup.subagentDetailParent).not.toContain("min-h-[32rem]");
  });
  it("shows OpenAI refresh progress and per-account failure feedback", () => {
    expect(markup.quotaRefreshing).toContain("刷新中");
    expect(markup.quotaRefreshing).toContain("disabled");
    expect(markup.quotaRefreshFailed).toContain("刷新失败");
    expect(markup.quotaRefreshFailed).toContain("账户查询超时，请重试");
    expect(markup.quotaRefreshFailed).toContain("重试");
  });
  it("shows OpenAI remaining Credits, voucher counts and expiry details without losing zero or precision", () => {
    expect(markup.quotaCredits).toContain("12.34567890123456789");
    expect(markup.quotaCredits).toContain("周额度剩余：62.5%");
    expect(markup.quotaCreditsEnglish).toContain("Credits remaining");
    expect(markup.quotaCreditsEnglish).toContain("Weekly quota remaining: 62.5%");
    expect(markup.quotaCreditsEnglish).toContain("No expiry");
    expect(markup.quotaCreditsEnglish).toContain("Other reset credits: 1");
    expect(markup.quotaCredits).toContain("可用重置券");
    expect(markup.quotaCredits).toContain("凭证刷新时间");
    expect(markup.quotaCredits).toContain("2026-09-23 02:41");
    expect(markup.quotaCreditsEnglish).toContain("Credentials refreshed at");
    expect(markup.quotaCredits).toContain("使用重置券");
    expect(markup.quotaCreditsEnglish).toContain("Use reset credit");
    expect(markup.quotaCredits).toContain("1970-01-01 00:33");
    expect(markup.quotaCredits).toContain("无到期时间");
    expect(markup.quotaCredits).toContain("其余 2 张：服务端未提供到期明细");
    expect(markup.quotaZeroCredits).toContain(">0</dd>");
    expect(markup.quotaZeroCredits).not.toContain("重置券到期时间");
    expect(markup.quotaUnlimitedCredits).toContain("无限");
    expect(markup.quotaEmpty).toContain("未提供");
  });
  it("shows reset credit metadata in the header and expiry details without a disclosure", () => {
    const html = markup.quotaCredits!;
    const header = html.slice(0, html.indexOf('data-slot="card-content"'));
    expect(header).toContain("可用重置券");
    expect(header).toContain("更新于 1970-01-01 00:00");
    expect(html).not.toContain('data-slot="collapsible"');
    expect(html).toContain("1970-01-01 00:33");
    expect(html).toContain("使用重置券");
    expect(html).toContain('<ul aria-label="重置券到期时间"');
  });
  it("shows only credential refresh time and handles missing credentials without subscription dates", () => {
    expect(markup.credentialRefreshTime).toContain("凭证刷新时间: 2026-09-23 02:41");
    expect(markup.credentialRefreshTimeEn).toContain("Credentials refreshed at: 2026-09-23 02:41");
    expect(markup.credentialRefreshTimeMissing).toContain("凭证刷新时间: 未提供");
    expect(markup.credentialRefreshTimeOmitted).toContain("凭证刷新时间: 未提供");
    expect(markup.credentialRefreshTimeZero).toContain("1970-01-01 00:00");
    for (const html of [markup.credentialRefreshTime, markup.credentialRefreshTimeEn, markup.credentialRefreshTimeMissing]) {
      expect(html).not.toContain("2026-10-03 02:05");
      expect(html).not.toContain("订阅截止时间");
      expect(html).not.toContain("订阅信息最后检查时间");
      expect(html).not.toContain("Subscription active until");
      expect(html).not.toContain("Subscription last checked");
      expect(html).not.toContain("缓存中的截止日期已过");
      expect(html).not.toContain("From the login cache");
    }
  });
  it("shows controlled relay outcomes without a request ID copy action", () => {
    expect(markup["relay-outcome-rejected"]).toContain("上游权限不足");
    expect(markup["relay-outcome-disconnected"]).toContain("客户端连接已断开");
    expect(markup["relay-outcome-incomplete"]).toContain("上游生成未完整结束");
    expect(markup["relay-outcome-unknown"]).not.toContain("untrusted-sensitive-value");
    for (const name of ["rejected", "disconnected", "unknown", "incomplete"]) {
      expect(markup[`relay-outcome-${name}`]).not.toContain("复制请求 ID");
      expect(markup[`relay-outcome-${name}`]).not.toContain("7d40d091-8c74-4dcf-9e40-71531f3f1a98");
      expect(markup[`relay-outcome-${name}`]).not.toContain("查看调用详情");
    }
  });
  it("shows standalone request metrics without capture and offers optional exact traffic navigation", () => {
    for (const label of ["请求模型", "响应模型", "思考等级", "缓存", "无缓存", "请求服务层级", "响应服务层级", "1970-01-01 00:00:01.000", "UTC", "fixture-client"]) {
      expect(markup.requestDetail).toContain(label);
    }
    expect(markup.requestDetail).not.toContain('href="/traffic');
    expect(markup.requestDetailEnglish).toContain("No dump reference");
    expect(markup.requestDetailEnglish).toContain("Request model");
    expect(markup.requestDetailLinked).toContain('/traffic?label=clp&amp;exchangeSession=batch&amp;id=7');
    expect(markup.requestDetailZero).toContain("0 ms");
    expect(markup.requestDetailZero).not.toContain("NaN");
    expect(markup.requests).toContain("1970-01-01 00:00:01");
  });
  it("preserves historical model evidence without inventing request or response names", () => {
    for (const key of ["requestHistorical", "requestHistoricalEn"]) {
      expect(markup[key]).toContain("historical-model");
    }
    expect(markup.requestHistorical).toContain("记录模型");
    expect(markup.requestHistoricalEn).toContain("Recorded model");
    expect(markup.requestHistorical).toMatch(/请求模型<\/dt><dd[^>]*>—<\/dd>/u);
    expect(markup.requestHistorical).toMatch(/响应模型<\/dt><dd[^>]*>—<\/dd>/u);
    for (const key of ["requestDetail", "requestMissingModels", "requestResponseOnly"]) {
      expect(markup[key]).not.toContain("记录模型");
    }
    expect(markup.requestMissingModels).not.toContain("NaN");
    expect(markup.requestResponseOnly).toContain("response-only-model");
  });
  beforeAll(() => {
    const directory = mkdtempSync(join(tmpdir(), "codexc-webui-cache-pairs-"));
    const store = new SqliteModelRequestMetricsStore(join(directory, "request-metrics.sqlite3"), 10_000);
    const pairedCacheFixtures = (() => {
      try {
        const request = { ...sample(), recordedAtMs: 1500, outputTokens: 10 };
        store.recordBatch([
          { ...request, threadId: "complementary", inputTokens: 100, cachedInputTokens: 50 },
          { ...request, threadId: "complementary", inputTokens: 200, cachedInputTokens: null },
          { ...request, threadId: "complementary", inputTokens: null, cachedInputTokens: 10, outputTokens: null,
            status: "failed", errorType: "client_disconnected", responseCompletedAtMs: 1700 },
          { ...request, threadId: "unobserved", inputTokens: 100, cachedInputTokens: 50 },
          { ...request, threadId: "unobserved", inputTokens: null, cachedInputTokens: null, outputTokens: null,
            status: "failed", errorType: "client_disconnected", responseCompletedAtMs: 1700 },
        ]);
        const query = { startAtMs: 1000, endAtMs: 2000, limit: 10 };
        return {
          complementary: store.threadTurnSummaries("complementary", query),
          unobserved: store.threadTurnSummaries("unobserved", query),
        };
      } finally {
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    })();
    // Render actual components with the WebUI's existing Vite/React dependencies.
    const script = String.raw`
      import { createServer } from "vite";
      import { createElement as h } from "react";
      import { renderToStaticMarkup } from "react-dom/server";
      import { MemoryRouter, Routes, Route } from "react-router";
      const server = await createServer({ server: { middlewareMode: true }, appType: "custom", logLevel: "silent",
        plugins: [{ name: "fixture-api-state", enforce: "pre", transform(_code, id) {
          if (id.endsWith("/src/components/metrics/data-table.tsx")) return _code.replace("  useTable,", "  useTable as realUseTable,") + " function useTable(...args) { const table = realUseTable(...args); if (globalThis.fixtureCaptureTable) globalThis.fixtureTable = table; return table; }";
          if (id.endsWith("/src/App.tsx")) return _code + " export { BreadcrumbTrail };";
          if (id.endsWith("/src/components/traffic/traffic-content.tsx")) return _code.replace("useState(false)", "useState(globalThis.fixtureDisclosureOpen ?? false)");
          if (id.endsWith("/src/hooks/use-official-account-sources.ts")) return "export function useOfficialAccountSources() { return globalThis.fixtureAccounts; }";
          if (id.endsWith("/src/hooks/use-api.ts")) return "export function useApi(load, deps) { globalThis.fixtureApiLoad = load; globalThis.fixtureApiDeps = deps; return globalThis.fixtureApiState; }";
          if (id.endsWith("/src/hooks/use-metrics-query.ts")) return "export function useMetricsQuery() { return { query: globalThis.fixtureQuery, update() {}, pagination() { return globalThis.fixturePagination; } }; } export function useMetricsProviders() { return { data: { providers: ['openai'] }, loading: false, error: null }; }";
          if (id.endsWith("/src/hooks/use-thread-detail.ts")) return _code.replace("export function useThreadDetail(", "function realUseThreadDetail(") + " export function useThreadDetail(...args) { globalThis.fixtureThreadDetailCalls++; return globalThis.fixtureThreadDetail ?? realUseThreadDetail(...args); }";
          if (id.endsWith("/src/hooks/use-thread-subagents.ts")) return "export function useThreadSubagents(threadId) { globalThis.fixtureSubagentCalls.push(threadId ?? 'all'); return globalThis.fixtureSubagentState; }";
          if (id.endsWith("/src/components/metrics/query-filters.tsx")) return "import { createElement } from 'react'; export function QueryFilters(props) { return createElement('div', { 'data-query-filters': true, 'data-thread-filters': props.showThreadFilters }); }";
        } }],
      });
      try {
        const { AccountIdField } = await server.ssrLoadModule("/src/components/settings/account-id-field.tsx");
        const { RequestDetail } = await server.ssrLoadModule("/src/components/requests/request-detail.tsx");
        const { RequestsTable } = await server.ssrLoadModule("/src/components/requests/requests-table.tsx");
        const { ErrorsTable } = await server.ssrLoadModule("/src/components/requests/errors-table.tsx");
        const { FastBadge } = await server.ssrLoadModule("/src/components/metrics/service-tier.tsx");
        const { ThreadTable } = await server.ssrLoadModule("/src/components/threads/thread-table.tsx");
        const { ThreadsPage } = await server.ssrLoadModule("/src/pages/threads-page.tsx");
        const { ThreadSubagents } = await server.ssrLoadModule("/src/components/threads/thread-subagents.tsx");
        const { TurnTable } = await server.ssrLoadModule("/src/components/threads/turn-table.tsx");
        const { ThreadDetailPage } = await server.ssrLoadModule("/src/pages/thread-detail-page.tsx");
        const { ThreadSubagentsPage, SubagentsPage } = await server.ssrLoadModule("/src/pages/thread-subagents-page.tsx");
        const { BreadcrumbTrail } = await server.ssrLoadModule("/src/App.tsx");
        const { TrafficTable } = await server.ssrLoadModule("/src/components/traffic/traffic-table.tsx");
        const { TrafficDetail } = await server.ssrLoadModule("/src/components/traffic/traffic-detail.tsx");
        const { ErrorBanner } = await server.ssrLoadModule("/src/components/metrics/error-banner.tsx");
        const { GlobalCards, ErrorsSummary, ProviderTable, WeeklyQuotaCard, OpencodeGoUsageCard, ClinePassUsageCard, DeepseekBalanceCards, CcgCreditUsageCards } = await server.ssrLoadModule("/src/components/overview/overview-sections.tsx");
        const { QuerySummary } = await server.ssrLoadModule("/src/components/metrics/query-summary.tsx");
        const { ConsolePage } = await server.ssrLoadModule("/src/pages/console-page.tsx");
        const { openAiWeeklyQuotaFromSnapshot, accountSnapshotsWithMissingProviders, deepseekAccountFromSnapshot, ccgAccountFromSnapshot, quotaAccountFromSnapshot } = await server.ssrLoadModule("/src/lib/account-refresh-state.ts");
        const { ServerTimeContext } = await server.ssrLoadModule("/src/hooks/use-server-time.ts");
        const { AccountUpdateDescription } = await server.ssrLoadModule("/src/components/overview/account-refresh-feedback.tsx");
        const { ErrorsPage } = await server.ssrLoadModule("/src/pages/errors-page.tsx");
        const { LanguageContext } = await server.ssrLoadModule("/src/hooks/language-context.ts");
        const { TooltipProvider } = await server.ssrLoadModule("/src/components/ui/tooltip.tsx");
        const { DataTable, TableHint, TruncatedText } = await server.ssrLoadModule("/src/components/metrics/data-table.tsx");
        const { InputTokenTooltip, OutputTokenTooltip } = await server.ssrLoadModule("/src/components/metrics/token-tooltip.tsx");
        const { setServerTimeZone } = await server.ssrLoadModule("/src/lib/format.ts");
        setServerTimeZone("UTC");
        const noop = () => {};
        const pagination = { mode: "server", pageNumber: 1, pageSize: 10, hasPrevious: false, hasNext: false,
          onPrevious: noop, onNext: noop, onPageSizeChange: noop, onSortingChange: noop,
          sorting: [{ id: "time", desc: true }], serverTotal: 1 };
        globalThis.fixtureSubagentCalls = [];
        globalThis.fixtureThreadDetailCalls = 0;
        const subagentPagination = { mode: "server", pageNumber: 1, pageSize: 20, pageSizeOptions: [10,20,50,100], serverTotal: 0,
          sorting: [{ id: "last", desc: true }], enableSortingRemoval: false, onSortingChange: noop, onPageSizeChange: noop,
          hasPrevious: false, hasNext: false, onPrevious: noop, onNext: noop };
        globalThis.fixtureSubagentState = { data: { subagents: [], modelUsage: [], total: 0 }, error: null, errorCode: null,
          loading: false, refreshing: false, refetch: noop, pagination: subagentPagination, notificationStatus: "live", lastUpdatedAt: 1000,
        };
        const common = { provider: "openai", model: "model-test", reasoningEffort: "high", recordedAtMs: 1000, directSubagentCount: 0,
          sessionTiming: { knownDurationMs: 120000, missingTurnCount: 0, historyComplete: true },
          cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: 0 },
          inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 5,
          totalTokens: 1080, subagentUsage: { inputTokens: 800, cachedInputTokens: 300, outputTokens: 160,
            cacheUsage: { inputTokens: 800, cachedInputTokens: 300, missingRequestCount: 0 } },
          requestOutcomes: { completed: 1, interrupted: 0, failed: 0, incomplete: 0 },
          interruptionSummary: { followedByCompletion: 0, noObservedCompletion: 0, usageUnobserved: 0 },
          tokensPerSecond: 20, compact: null, requestCount: 1, unsuccessfulRequestCount: 0 };
        const record = { ...common, status: "failed", requestModel: "model-test", responseModel: "model-other",
          traffic: null, userAgent: "fixture-client", operation: "response", httpStatus: 502,
          errorType: "upstream_error", errorCode: "fixture_error", errorMessage: "fixture failure",
          firstTokenMs: 100, responseTimeMs: 25, generationTiming: { reasoningMs: 100, textMs: 200, toolMs: 300, totalMs: 600 }, totalDurationMs: 1000, upstreamTtftMs: null, cacheHitRate: 0.5 };
        const render = (component, props, language = "zh", entry = "/") => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [entry] },
          h(LanguageContext.Provider, { value: { language, setLanguage: noop } }, h(TooltipProvider, null,
            h(ServerTimeContext.Provider, { value: globalThis.fixtureServerClock ?? { nowMs: Date.now(), receivedAtMs: Date.now(), timeZone: "UTC" } }, h(component, component === TrafficTable ? { pagination: { mode: "server", pageNumber: 1, pageSize: 50, hasPrevious: false, hasNext: false, onPrevious: noop, onNext: noop, onPageSizeChange: noop, sorting: [], onSortingChange: noop }, description: "fixture", ...props } : props))))));
        const requestProps = { ...pagination, records: [{ ...record, id: 42 }], filter: "", total: 1 };
        const exchange = { protocol: "responses", reasoningEffort: "high", clientName: "WorkBuddy", id: 7, label: "openai", session: "batch-1", startedAtMs: 1000, category: "model", turnStateLengths: [{ source: "http.headers.x-codex-turn-state", characters: 1234 }],
          state: "completed", firstTokenMs: 100, responseTimeMs: 25, outputTokens: 120, generationTiming: { reasoningMs: 100, textMs: 200, toolMs: 300, totalMs: 600 }, durationMs: 1000, hasError: false, requestModel: "model-test", responseModels: ["model-test"] };
        const detail = { ...exchange, transport: "http", modelEvidence: { serverModels: [], safetyModels: [], turnStateLengths: [{ source: "http.headers.x-codex-turn-state", characters: 1234 }], truncated: false },
          parameterComparison: [], request: { headers: {}, body: "request-body", parameters: {},
            content: { instructions: null, input: [], tools: [] } }, response: null,
          tracePage: { offset: 0, total: 101, previousOffset: null, nextOffset: 100 },
          trace: [{ atMs: 1000, kind: "fixture-event", text: "old-trace-body", truncated: false }] };
        const quotaWindow = (windowId, label, usedPercent) => ({ windowId, label, usedPercent, resetsAt: null, status: null });
        const quotaAccount = { account: "main", provider: "fixture", displayName: "额度测试", default: true,
          available: true, observedAtMs: Date.now(), subscriptionRequired: false };
        const monthlyWindow = quotaWindow("monthly", "月度", 30);
        const weeklyWindow = quotaWindow("weekly", "7天", 20);
        const rollingWindow = quotaWindow("rolling", "5小时", 10);
        const fiveHourWindow = quotaWindow("five-hour", "5小时", 10);
        const result = {
          providers: render(ProviderTable, { providers: [{ provider: "openai", threadCount: 1, turnCount: 1, aggregate: common }] }),
          providersEmpty: render(ProviderTable, { providers: [] }),
          providersUnknownCache: render(ProviderTable, { providers: [{ provider: "openai", threadCount: 1, turnCount: 1,
            aggregate: { ...common, cacheUsage: { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 1 } } }] }),
          ocgQuotaOrder: render(OpencodeGoUsageCard, { accounts: [{ ...quotaAccount, displayName: "OpenCode Go main",
            windows: [monthlyWindow, weeklyWindow, rollingWindow] }], refreshControls: {}, onAccountsChanged: noop }),
          clineQuotaOrder: render(ClinePassUsageCard, { account: { ...quotaAccount, displayName: "Cline Pass main",
            windows: [weeklyWindow, monthlyWindow, fiveHourWindow] } }),
          deepseekAccountBadge: render(DeepseekBalanceCards, { accounts: [{ ...quotaAccount,
            displayName: "DS main", balances: [] }], refreshControls: {} }),
          ccgAccountBadge: render(CcgCreditUsageCards, { accounts: [{ ...quotaAccount,
            displayName: "CommandCode Go main", planId: null, monthlyRemaining: "1", purchasedRemaining: "2",
            freeRemaining: "0", totalRemaining: "3", windows: [] }], refreshControls: {} }),
          missingQuotaWindow: render(ClinePassUsageCard, { account: { ...quotaAccount,
            windows: [monthlyWindow, fiveHourWindow] } }),
          newAccount: render(AccountIdField, { id: "account", value: "main", accounts: [], disabled: false, editing: false, onChange: noop }),
          reservedAccount: render(AccountIdField, { id: "account", value: "openai", accounts: [], reservedIds: ["openai", "deepseek", "ocg"], disabled: false, editing: false, onChange: noop }),
          customAccount: render(AccountIdField, { id: "account", value: "team_a", accounts: [{ id: "team-a" }], disabled: false, editing: false, onChange: noop }),
          editingAccount: render(AccountIdField, { id: "account", value: "main", accounts: [{ id: "main" }], disabled: false, editing: true, onChange: noop }),
          quota: render(WeeklyQuotaCard, { usedPercent: 37.5, resetsAt: 1000, planType: null }),
          quotaUnknownReset: render(WeeklyQuotaCard, { usedPercent: 37.5, resetsAt: null, planType: null }),
          quotaExhausted: render(WeeklyQuotaCard, { usedPercent: 120, resetsAt: null, planType: null }),
          quotaFull: render(WeeklyQuotaCard, { usedPercent: -1, resetsAt: null, planType: null }),
          quotaEmpty: render(WeeklyQuotaCard, { usedPercent: null, resetsAt: null, planType: null }),
          quotaRefreshing: render(WeeklyQuotaCard, { usedPercent: null, resetsAt: null, planType: null,
            refreshControl: { refreshing: true, disabled: true, error: null, onRefresh: noop } }),
          quotaRefreshFailed: render(WeeklyQuotaCard, { usedPercent: null, resetsAt: null, planType: null,
            refreshControl: { refreshing: false, disabled: false, error: { kind: "refresh-failed", message: "账户查询超时，请重试" }, onRefresh: noop } }),
          quotaCreditsEnglish: render(WeeklyQuotaCard, { onCreditsChanged: noop, usedPercent: 37.5, resetsAt: null, planType: null,
            credits: { observedAtMs: 1000, remaining: "0", unlimited: false, resetCreditsAvailable: "2", expirations: [{ expiresAt: null, count: 1 }], undisclosedCount: "1" } }, "en"),
          quotaCredits: render(WeeklyQuotaCard, { onCreditsChanged: noop, usedPercent: 37.5, resetsAt: 1000, planType: "plus",
            credits: { credentialRefreshedAt: 1790131317, observedAtMs: 1000, remaining: "12.34567890123456789", unlimited: false, resetCreditsAvailable: "5",
              expirations: [{ expiresAt: 2000, count: 2 }, { expiresAt: null, count: 1 }], undisclosedCount: "2" } }),
          quotaZeroCredits: render(WeeklyQuotaCard, { usedPercent: null, resetsAt: null, planType: null,
            credits: { observedAtMs: 1000, remaining: "0", unlimited: false, resetCreditsAvailable: "0", expirations: [], undisclosedCount: null } }),
          quotaUnlimitedCredits: render(WeeklyQuotaCard, { usedPercent: null, resetsAt: null, planType: null,
            credits: { observedAtMs: 1000, remaining: null, unlimited: true, resetCreditsAvailable: "1", expirations: null, undisclosedCount: "1" } }),
          emptyHint: render(TableHint, { hint: null, children: "—" }),
          shortText: render(TruncatedText, { text: "short" }),
          shortLink: render(TruncatedText, { text: "short", render: h("a", { href: "/test" }), children: "short" }),
          inputWithoutBreakdown: render(InputTokenTooltip, { inputTokens: 10, cachedInputTokens: null }),
          outputWithoutBreakdown: render(OutputTokenTooltip, { outputTokens: 10, reasoningOutputTokens: null }),
          matchingFast: render(FastBadge, { tier: "priority", source: "request", responseTier: "fast" }),
          mismatchedFast: render(FastBadge, { tier: "priority", source: "request", responseTier: "default" }),
          responseFast: render(FastBadge, { tier: "fast", source: "response" }),
          emptyToken: render(InputTokenTooltip, { inputTokens: null, cachedInputTokens: null }),
          inputToken: render(InputTokenTooltip, { inputTokens: 10, cachedInputTokens: 5 }),
          outputToken: render(OutputTokenTooltip, { outputTokens: 10, reasoningOutputTokens: 5 }),
          summaryLoading: render(QuerySummary, { aggregate: null, range: { name: "all" }, loading: true }),
          traffic: render(TrafficTable, { exchanges: [exchange], onOpen: noop }),
          trafficFirstZero: render(TrafficTable, { exchanges: [{ ...exchange, firstTokenMs: 0, durationMs: 0 }], onOpen: noop }),
          trafficFirstMissing: render(TrafficTable, { exchanges: [{ ...exchange, firstTokenMs: undefined, durationMs: undefined }], onOpen: noop }),
          trafficLoading: render(TrafficTable, { exchanges: [exchange], onOpen: noop, loading: true }),
          trafficMismatch: render(TrafficTable, { exchanges: [{ ...exchange, responseModels: ["model-other"] }], onOpen: noop }),
          relayDebug: render(TrafficDetail, { detail: { ...detail, debug: {
            inbound: { headers: { "x-client": "[REDACTED]" }, headersTruncated: true, body: "<script>private</script>", bodyTruncated: false },
            delivered: { headers: {}, headersTruncated: false, body: "{}", bodyTruncated: true, state: "finished", status: 200 },
            transformations: ["stream_defaulted", "provider_routing_pinned", "json_unwrapped"] } }, provider: "clp-main", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          traceFinalProvider: render(TrafficDetail, { detail: { ...detail, chatDiagnostics: { fields: { "routing.finalProvider": "deepseek" }, truncated: false } }, provider: "clp-main", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          traceFallbackOnly: render(TrafficDetail, { detail: { ...detail, chatDiagnostics: { fields: { "routing.fallbacks.0": "deepseek" }, truncated: false } }, provider: "clp-main", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          traceClosed: render(TrafficDetail, { detail, provider: "openai", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          retry: render(ErrorBanner, { error: "fixture failure", onRetry: noop }),
          retryPending: render(ErrorBanner, { error: "fixture failure", onRetry: noop, pending: true }),
          requests: render(RequestsTable, requestProps),
          requestDetail: render(RequestDetail, { record: { ...record, totalTokens: 120, transport: "http", responseFormat: "sse", reasoningEffort: "high", requestServiceTier: "priority", serviceTier: "default" } }),
          requestDetailEnglish: render(RequestDetail, { record }, "en"),
          requestDiagnostics: render(RequestDetail, { record: { ...record, upstreamProvider: "deepseek", upstreamAttemptCount: 3, modelAttemptCount: 2,
            finishReason: "stop", errorStage: "stream", upstreamErrorCode: "rate_limit", upstreamErrorType: "limit", upstreamHttpStatus: 429 } }),
          requestDiagnosticsEn: render(RequestDetail, { record: { ...record, upstreamProvider: "deepseek", upstreamAttemptCount: 3, modelAttemptCount: 2,
            finishReason: "stop", errorStage: "http", upstreamErrorCode: "rate_limit", upstreamErrorType: "limit", upstreamHttpStatus: 429 } }, "en"),
          requestHistorical: render(RequestDetail, { record: { ...record, requestModel: null, responseModel: null, model: "historical-model" } }),
          requestHistoricalEn: render(RequestDetail, { record: { ...record, requestModel: null, responseModel: null, model: "historical-model" } }, "en"),
          requestMissingModels: render(RequestDetail, { record: { ...record, requestModel: null, responseModel: null, model: null } }),
          requestResponseOnly: render(RequestDetail, { record: { ...record, requestModel: null, responseModel: "response-only-model" } }),
          requestDetailLinked: render(RequestDetail, { record: { ...record, traffic: {label:"clp",session:"batch",interaction:7} } }, "zh", "/requests?range=7d&offset=50"),
          requestDetailZero: render(RequestDetail, { record: { ...record, inputTokens:0,cachedInputTokens:0,outputTokens:0,totalTokens:0,responseTimeMs:0,totalDurationMs:0,cacheHitRate:null,errorMessage:null,errorType:null,errorCode:null } }),
          requestsClp: render(RequestsTable, { ...requestProps, records: [{ ...record, provider: "clp-main", requestModel: "cline-pass/deepseek-v4.1-flash", responseModel: "hidden-response-model", upstreamProvider: "deepseek" }] }),
          trafficClp: render(TrafficTable, { exchanges: [{ ...exchange, label: "clp", requestModel: "cline-pass/deepseek-v4.1-flash", responseModels: ["hidden-response-model"], upstreamProvider: "deepseek" }], onOpen: noop }),
          trafficRelayClp: render(TrafficTable, { exchanges: [{ ...exchange, label: "relay.chat", account: "clp-main", requestModel: "cline-pass/deepseek-v4.1-flash", responseModels: ["deepseek/deepseek-v4.1-flash"], upstreamProvider: "deepseek" }], onOpen: noop }),
          trafficRelayUnknown: render(TrafficTable, { exchanges: [{ ...exchange, label: "relay.chat", account: undefined, requestModel: "cline-pass/deepseek-v4.1-flash", responseModels: ["deepseek/deepseek-v4.1-flash"] }], onOpen: noop }),
          detailRelayClp: render(TrafficDetail, { detail: { ...detail, account: "clp-main", requestModel: "cline-pass/deepseek-v4.1-flash", responseModels: ["deepseek/deepseek-v4.1-flash"], upstreamProvider: "deepseek" }, provider: "relay.chat", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          trafficClpNoUpstream: render(TrafficTable, { exchanges: [{ ...exchange, label: "clp", requestModel: "cline-pass/deepseek-v4.1-flash", responseModels: ["hidden-response-model"] }], onOpen: noop }),
          requestsMatch: render(RequestsTable, { ...requestProps, records: [{ ...record, responseModel: "model-test" }] }),
          requestsMissingModel: render(RequestsTable, { ...requestProps, records: [{ ...record, requestModel: null, responseModel: "model-test" }] }),
          requestsOtherUpstream: render(RequestsTable, { ...requestProps, records: [{ ...record, upstreamProvider: "other-provider" }] }),
          trafficOtherUpstream: render(TrafficTable, { exchanges: [{ ...exchange, upstreamProvider: "other-provider" }], onOpen: noop }),
          requestsClpUnexpected: render(RequestsTable, { ...requestProps, records: [{ ...record, provider: "clp-main", requestModel: "cline-pass/deepseek-v4.1-flash", upstreamProvider: "other-provider" }] }),
          trafficClpUnexpected: render(TrafficTable, { exchanges: [{ ...exchange, label: "relay.chat", account: "clp-main", requestModel: "clp-main/deepseek-v4.1-flash", upstreamProvider: "other-provider" }], onOpen: noop }),
          detailClpUnexpected: render(TrafficDetail, { detail: { ...detail, account: "clp-main", requestModel: "cline-pass/deepseek-v4.1-flash", upstreamProvider: "other-provider" }, provider: "relay.chat", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          requestsMuseUpstream: render(RequestsTable, { ...requestProps, records: [{ ...record, provider: "clp-main", requestModel: "cline-pass/muse-spark-1.3-contributor", upstreamProvider: "meta" }] }),
          detailMuseUpstream: render(TrafficDetail, { detail: { ...detail, account: "clp-main", requestModel: "cline-pass/muse-spark-1.3-contributor", upstreamProvider: "meta" }, provider: "relay.chat", session: "batch-1", onRetry: noop, onTracePageChange: noop }),
          requestsOtherProviderDeepSeek: render(RequestsTable, { ...requestProps, records: [{ ...record, provider: "custom", requestModel: "cline-pass/deepseek-v4.1-flash", upstreamProvider: "other-provider" }] }),
          requestsUpstream: render(RequestsTable, { ...requestProps, records: [{ ...record, upstreamProvider: "deepseek", upstreamAttemptCount: 3 }] }),
          trafficUpstream: render(TrafficTable, { exchanges: [{ ...exchange, upstreamProvider: "deepseek" }], onOpen: noop }),
          loading: render(RequestsTable, { ...requestProps, loading: true }),
          ascending: render(RequestsTable, { ...requestProps, sorting: [{ id: "output", desc: false }] }),
          threads: render(ThreadTable, { threads: [{ ...common, threadId: "thread-1", agentPath: null,
            parentThreadId: null, turnCount: 1, firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 }], query: {}, pagination }),
          threadsEn: render(ThreadTable, { threads: [{ ...common, threadId: "thread-1", agentPath: null,
            parentThreadId: null, turnCount: 1, firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 }], query: {}, pagination }, "en"),
          threadsPartialDuration: render(ThreadTable, { threads: [{ ...common, threadId: "thread-1", sessionTiming: { knownDurationMs: 120000, missingTurnCount: 1, historyComplete: false } }], query: {}, pagination }),
          threadsMissingDuration: render(ThreadTable, { threads: [{ ...common, threadId: "thread-1", sessionTiming: { knownDurationMs: null, missingTurnCount: 1, historyComplete: false } }], query: {}, pagination }),
          turns: render(TurnTable, { turns: [{ ...common, turnId: "turn-1" }], threadId: "thread-1", query: {}, pagination }),
          turnsWithSubagents: render(TurnTable, { turns: [{ ...common, turnId: "turn/one", directSubagentCount: 2 }], threadId: "parent/thread", query: { provider: ["filtered"] }, pagination }),
          turnsLongId: render(TurnTable, { turns: [{ ...common, turnId: "01a106b6-f258-7b82-bed0-157cc3e38882" }], threadId: "thread-1", query: {}, pagination }),
          turnsZeroCache: render(TurnTable, { turns: [{ ...common, cachedInputTokens: 0, turnId: "turn-1" }], threadId: "thread-1", query: {}, pagination }),
          turnsUnknownCache: render(TurnTable, { turns: [{ ...common, cachedInputTokens: null, turnId: "turn-1" }], threadId: "thread-1", query: {}, pagination }),
          turnsZeroInput: render(TurnTable, { turns: [{ ...common, inputTokens: 0, cachedInputTokens: 0, turnId: "turn-1" }], threadId: "thread-1", query: {}, pagination }),
          turnsDuration: render(TurnTable, { turns: [{ ...common, turnId: "turn-1", durationMs: 71_000 }], threadId: "thread-1", query: {}, pagination }),
          turnsDurationZero: render(TurnTable, { turns: [{ ...common, turnId: "turn-1", durationMs: 0 }], threadId: "thread-1", query: {}, pagination }, "en"),
        };
        const interrupted = { ...common, requestCount: 10, unsuccessfulRequestCount: 8,
          requestOutcomes: { completed: 2, interrupted: 5, failed: 1, incomplete: 2 },
          interruptionSummary: { followedByCompletion: 2, noObservedCompletion: 3, usageUnobserved: 1 } };
        const interruptedRecord = { ...record, id: 91, source: "owned", status: "failed", errorType: "client_disconnected", errorCode: "client_disconnected", errorMessage: "request failed due to cancellation", inputTokens: null, outputTokens: null, totalTokens: null };
        result.interruptedSummary = render(QuerySummary, { aggregate: interrupted, range: { name: "all" } });
        result.interruptedSummaryEn = render(QuerySummary, { aggregate: interrupted, range: { name: "all" } }, "en");
        result.interruptedGlobal = render(GlobalCards, { global: interrupted, threadCount: 1, turnCount: 1 });
        result.interruptedTurns = render(TurnTable, { turns: [{ ...interrupted, turnId: "turn-interrupted" }], threadId: "thread-1", query: {}, pagination });
        result.interruptedTurnsEn = render(TurnTable, { turns: [{ ...interrupted, turnId: "turn-interrupted" }], threadId: "thread-1", query: {}, pagination }, "en");
        result.interruptedTurnsZeroCache = render(TurnTable, { turns: [{ ...interrupted, cachedInputTokens: 0, turnId: "turn-interrupted" }], threadId: "thread-1", query: {}, pagination });
        result.interruptedTurnsUnknownCache = render(TurnTable, { turns: [{ ...interrupted, cachedInputTokens: null, turnId: "turn-interrupted" }], threadId: "thread-1", query: {}, pagination });
        result.interruptedTurnsUnknown = render(TurnTable, { turns: [{ ...interrupted, inputTokens: 0, outputTokens: 0, turnId: "turn-interrupted" }], threadId: "thread-1", query: {}, pagination });
        result.interruptedRequests = render(RequestsTable, { ...requestProps, records: [interruptedRecord] });
        result.interruptedRequestDetail = render(RequestDetail, { record: interruptedRecord });
        result.interruptedRequestDetailEn = render(RequestDetail, { record: interruptedRecord }, "en");
        result.interruptedErrorsSummary = render(ErrorsSummary, { errors: { requestCount: 10, unsuccessfulRequestCount: 8, requestOutcomes: interrupted.requestOutcomes, groups: [{ provider: "openai", model: "model-test", status: "failed", errorType: "client_disconnected", requestCount: 5, lastOccurredAtMs: 1000 }] } });
        globalThis.fixtureQuery = {};
        globalThis.fixturePagination = pagination;
        const mainThread = { ...common, threadId: "thread-1", agentPath: null, parentThreadId: null,
          turnCount: 1, firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 };
        const childOnlyThread = { ...mainThread, provider: null, model: null, requestCount: 0, turnCount: 0,
          inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
          subagentUsage: { inputTokens: 900, cachedInputTokens: null, outputTokens: 180,
            cacheUsage: { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 1 } },
          cacheUsage: { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 0 } };
        result.threadsChildOnly = render(ThreadTable, { threads: [childOnlyThread], query: {}, pagination });
        result.threadsUnknownCache = render(ThreadTable, { threads: [{ ...mainThread, cachedInputTokens: null,
          cacheUsage: { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 1 } }], query: {}, pagination });
        result.threadsPartialCache = render(ThreadTable, { threads: [{ ...mainThread, cachedInputTokens: null,
          cacheUsage: { inputTokens: 60, cachedInputTokens: 30, missingRequestCount: 1 } }], query: {}, pagination });
        globalThis.fixtureCaptureTable = true;
        const totalSortCycle = [];
        const totalPagination = { ...pagination, onSortingChange: next => {
          const sort = next[0];
          totalSortCycle.push(sort.id + ":" + (sort.desc ? "desc" : "asc"));
        } };
        render(ThreadTable, { threads: [mainThread], query: {}, pagination: totalPagination });
        globalThis.fixtureTable.getColumn("totalTokens").getToggleSortingHandler()({ shiftKey: false });
        result.threadTotalSorting = totalSortCycle.join(",");
        globalThis.fixtureCaptureTable = false;
        const threadPageData = { aggregate: common, treeAggregate: { ...common, inputTokens: 950, outputTokens: 190,
          cacheUsage: { inputTokens: 950, cachedInputTokens: 350, missingRequestCount: 0 } },
          threads: [mainThread], range: { name: "all" }, turnCount: 1, total: 2, nextOffset: 1 };
        globalThis.fixtureApiState = { data: { queryKey: "{}", data: threadPageData }, loading: false, error: null };
        result.threadsPage = render(ThreadsPage, {});
        result.threadsPageEn = render(ThreadsPage, {}, "en");
        globalThis.fixtureQuery = { model: "new-model" };
        result.threadsPageLoading = render(ThreadsPage, {});
        globalThis.fixtureQuery = {};
        globalThis.fixtureApiState.data.data = { ...threadPageData, aggregate: null, treeAggregate: null, threads: [], turnCount: 0, total: 0, nextOffset: null };
        result.threadsPageEmpty = render(ThreadsPage, {});
        globalThis.fixtureThreadDetail = { error: null, loading: false, refreshing: false, refetch: noop,
          data: { run: { latestTurn: { ...common, turnId: "turn-1", durationMs: 71_000 }, latestExecution: { turnId: "turn-1", durationMs: 71_000 }, sessionDurationMs: 120_000, threadAggregate: { ...common, turnCount: 2 } },
            turns: { aggregate: common, subagentAggregate: { ...common, ...common.subagentUsage, requestCount: 5,
              requestOutcomes: { completed: 3, interrupted: 1, failed: 1, incomplete: 0 } },
              treeAggregate: { ...common, inputTokens: 900, outputTokens: 180, requestCount: 6,
                requestOutcomes: { completed: 4, interrupted: 1, failed: 1, incomplete: 0 } }, range: { name: "all" }, turns: [], turnCount: 2, subagentTurnCount: 3 } } };
        result.threadTiming = render(ThreadDetailPage, {});
        result.threadTimingEn = render(ThreadDetailPage, {}, "en");
        globalThis.fixtureThreadDetail.loading = true;
        result.threadDetailLoading = render(ThreadDetailPage, {});
        globalThis.fixtureThreadDetail.loading = false;
        const ownPeriodTurns = globalThis.fixtureThreadDetail.data.turns;
        for (const [name, data] of Object.entries(${JSON.stringify(pairedCacheFixtures)})) {
          globalThis.fixtureThreadDetail.data.turns = { ...ownPeriodTurns, ...data, turnCount: 1 };
          result['pairedCache-' + name] = render(ThreadDetailPage, {});
          result['pairedCacheTurns-' + name] = render(TurnTable, { turns: data.turns, threadId: name, query: {}, pagination });
        }
        globalThis.fixtureThreadDetail.data.turns = { ...ownPeriodTurns, subagentAggregate: { ...common, inputTokens: 1000, cachedInputTokens: null,
          cacheUsage: { inputTokens: 60, cachedInputTokens: 30, missingRequestCount: 1 } } };
        result.threadPeriodPartialCache = render(ThreadDetailPage, {});
        globalThis.fixtureThreadDetail.data.turns = { ...ownPeriodTurns, subagentAggregate: { ...common, ...common.subagentUsage, cachedInputTokens: null,
          cacheUsage: { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 1 } } };
        result.threadPeriodUnknownCache = render(ThreadDetailPage, {});
        globalThis.fixtureThreadDetail.data.turns = { ...ownPeriodTurns, aggregate: null, subagentAggregate: null, treeAggregate: null, turnCount: 0, subagentTurnCount: 0 };
        result.threadPeriodEmpty = render(ThreadDetailPage, {});
        globalThis.fixtureThreadDetail.data.turns = { ...ownPeriodTurns, aggregate: null, turnCount: 0,
          treeAggregate: { ...common, ...common.subagentUsage } };
        result.threadPeriodDescendantsOnly = render(ThreadDetailPage, {});
        globalThis.fixtureThreadDetail.data.turns = { ...ownPeriodTurns, subagentAggregate: null, treeAggregate: null, turnCount: 1, subagentTurnCount: null };
        globalThis.fixtureQuery = { turnId: "selected-turn" };
        result.threadPeriodExactTurn = render(ThreadDetailPage, {});
        result.threadPeriodExactTurnEn = render(ThreadDetailPage, {}, "en");
        globalThis.fixtureQuery = {};
        globalThis.fixtureThreadDetail.data.turns = ownPeriodTurns;
        globalThis.fixtureThreadDetail.data.run.sessionDurationMs = null;
        result.threadTimingMissing = render(ThreadDetailPage, {});
        globalThis.fixtureThreadDetail.data.run.sessionTiming = { knownDurationMs: 120_000, missingTurnCount: 1, historyComplete: false };
        result.threadTimingPartial = render(ThreadDetailPage, {});
        result.threadTimingPartialEn = render(ThreadDetailPage, {}, "en");
        const relation = { ...common, turnCount: 2, firstRequestStartedAtMs: 1000, lastRecordedAtMs: 120000, threadId: "child/one", parentThreadId: "thread-1", parentTurnId: "turn-create/one", agentPath: "/root/worker", recordedAtMs: 120000, directSubagentCount: 2 };
        const modelUsage = [
          { model: "model-card-one", inputTokens: 2000, outputTokens: 500, cacheUsage: { inputTokens: 1000, cachedInputTokens: 750, missingRequestCount: 1 } },
          { model: "model-card-two", inputTokens: 4000, outputTokens: 0, cacheUsage: { inputTokens: 0, cachedInputTokens: null, missingRequestCount: 2 } },
        ];
        globalThis.fixtureSubagentState = { ...globalThis.fixtureSubagentState, data: { subagents: [relation], modelUsage, total: 21 },
          pagination: { ...subagentPagination, serverTotal: 21, hasNext: true } };
        const filteredQuery = { range: "today", provider: ["filtered-provider"], model: "filtered-model", status: "failed", turnId: "filtered-turn", filter: "filtered-text", offset: 40, limit: 20 };
        globalThis.fixtureSubagentCalls.length = 0;
        result.subagentsCollapsed = render(ThreadTable, { threads: [{ ...common, threadId: "thread-1", agentPath: null, parentThreadId: null, directSubagentCount: 21 }], query: filteredQuery, pagination });
        result.subagentsCollapsedCalls = String(globalThis.fixtureSubagentCalls.length);
        result.subagentsRelated = render(ThreadSubagents, { threadId: "thread-1" });
        result.subagentsRelatedEn = render(ThreadSubagents, { threadId: "thread-1" }, "en");
        globalThis.fixtureSubagentState = { ...globalThis.fixtureSubagentState, data: { subagents: [{ ...relation, parentTurnId: null, directSubagentCount: 0 }], modelUsage, total: 21 },
          pagination: { ...subagentPagination, serverTotal: 21, pageNumber: 2, hasPrevious: true } };
        result.subagentsLastPage = render(ThreadSubagents, { threadId: "thread-1" });
        globalThis.fixtureSubagentState = { ...globalThis.fixtureSubagentState, data: { subagents: [], modelUsage: [], total: 0 },
          pagination: subagentPagination };
        result.subagentsEmpty = render(ThreadSubagents, { threadId: "empty-thread" });
        result.subagentsEmptyEn = render(ThreadSubagents, { threadId: "empty-thread" }, "en");
        globalThis.fixtureSubagentState = { ...globalThis.fixtureSubagentState, data: null, error: "hidden-internal-error", errorCode: "network_error" };
        result.subagentsFailed = render(ThreadSubagents, { threadId: "thread-1" });
        globalThis.fixtureSubagentState = { ...globalThis.fixtureSubagentState, data: null, error: null, loading: true, refreshing: true };
        result.subagentsLoading = render(ThreadSubagents, { threadId: "thread-1" });
        globalThis.fixtureSubagentState = { ...globalThis.fixtureSubagentState, data: { subagents: [relation], modelUsage, total: 1 }, pagination: { ...subagentPagination, serverTotal: 1 }, loading: false, refreshing: false };
        result.subagentsSingle = render(ThreadSubagents, { threadId: "thread-1" });
        globalThis.fixtureThreadDetailCalls = 0;
        result.subagentsPage = render(() => h(Routes, null, h(Route, { path: "/threads/:id/subagents", element: h(ThreadSubagentsPage) })), {}, "zh", "/threads/parent%2Fthread/subagents");
        result.subagentsPageEn = render(() => h(Routes, null, h(Route, { path: "/threads/:id/subagents", element: h(ThreadSubagentsPage) })), {}, "en", "/threads/parent%2Fthread/subagents");
        result.turnSubagentsPage = render(() => h(Routes, null, h(Route, { path: "/threads/:id/subagents", element: h(ThreadSubagentsPage) })), {}, "zh", "/threads/parent%2Fthread/subagents?parentTurnId=turn%2Fone");
        result.subagentsPageDetailCalls = String(globalThis.fixtureThreadDetailCalls);
        globalThis.fixtureSubagentState.data.subagents[0].parentThreadId = "parent/thread";
        globalThis.fixtureSubagentCalls = [];
        result.allSubagents = render(SubagentsPage, {});
        result.allSubagentsEn = render(SubagentsPage, {}, "en");
        result.allSubagentsCalls = globalThis.fixtureSubagentCalls.join(",");
        for (const reasoningEffort of [null, "none", "future"]) {
          const variant = String(reasoningEffort);
          result['requests-reasoning-' + variant] = render(RequestsTable, { ...requestProps, records: [{ ...record, id: 42, reasoningEffort }] });
          result['errors-reasoning-' + variant] = render(ErrorsTable, { records: [{ ...record, id: 42, reasoningEffort }], query: {}, pagination });
          result['threads-reasoning-' + variant] = render(ThreadTable, { threads: [{ ...common, threadId: "thread-1", reasoningEffort }], query: {}, pagination });
          result['turns-reasoning-' + variant] = render(TurnTable, { turns: [{ ...common, turnId: "turn-1", reasoningEffort }], threadId: "thread-1", query: {}, pagination });
          result['traffic-reasoning-' + variant] = render(TrafficTable, { exchanges: [{ ...exchange, reasoningEffort: reasoningEffort ?? undefined }], onOpen: noop });
          globalThis.fixtureSubagentState.data.subagents[0].reasoningEffort = reasoningEffort;
          result['subagentsRelated-reasoning-' + variant] = render(ThreadSubagents, { threadId: "thread-1" });
          result['allSubagents-reasoning-' + variant] = render(ThreadSubagents, {});
        }
        globalThis.fixtureSubagentState.data.subagents[0].reasoningEffort = "high";
        globalThis.fixtureCaptureTable = true;
        const sortCycle = [];
        globalThis.fixtureSubagentState.pagination.onSortingChange = next => { globalThis.fixtureSubagentState.pagination.sorting = next; };
        for (const key of ["last", "last", "time", "time", "time"]) {
          render(SubagentsPage, {});
          globalThis.fixtureTable.getColumn(key).getToggleSortingHandler()({ shiftKey: false });
          const sort = globalThis.fixtureSubagentState.pagination.sorting[0];
          sortCycle.push(sort.id + ":" + (sort.desc ? "desc" : "asc"));
        }
        result.subagentSortCycle = sortCycle.join(",");
        globalThis.fixtureCaptureTable = false;
        result.subagentsBreadcrumb = render(BreadcrumbTrail, { pathname: "/threads/parent%2Fthread/subagents" });
        globalThis.fixtureQuery = filteredQuery;
        globalThis.fixtureThreadDetail = { ...globalThis.fixtureThreadDetail, error: "metrics-failed", errorCode: "unknown" };
        globalThis.fixtureSubagentCalls = [];
        result.subagentsWithFailedMetrics = render(ThreadDetailPage, {});
        result.detailSubagentCalls = String(globalThis.fixtureSubagentCalls.length);
        globalThis.fixtureThreadDetail.error = null;
        Object.assign(globalThis.fixtureThreadDetail.data.run, { agentPath: "/root/worker", parentThreadId: "parent/thread", parentTurnId: "creation/turn" });
        result.subagentDetailParent = render(ThreadDetailPage, {});
        globalThis.fixtureQuery = {};
        delete globalThis.fixtureThreadDetail;
        for (const provider of ["clp-main", "openai"]) {
          const model = "cline-pass/deepseek-v4.1-flash";
          result["threadsModel-" + provider] = render(ThreadTable, { threads: [{ ...common, provider, model,
            threadId: "thread-1", agentPath: null, parentThreadId: null, turnCount: 1,
            firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 }], query: {}, pagination });
          result["turnsModel-" + provider] = render(TurnTable, { turns: [{ ...common, provider, model,
            turnId: "turn-1" }], threadId: "thread-1", query: {}, pagination });
        }
        for (const [key, inputTokens, cachedInputTokens] of [
          ["threadCacheZero", 100, 0], ["threadCacheUnknown", 100, null], ["threadInputZero", 0, 0],
        ]) {
          result[key] = render(ThreadTable, { threads: [{ ...common, inputTokens, cachedInputTokens,
            subagentUsage: { inputTokens, cachedInputTokens, outputTokens: 20,
              cacheUsage: { inputTokens: cachedInputTokens === null ? 0 : inputTokens, cachedInputTokens, missingRequestCount: cachedInputTokens === null ? 1 : 0 } },
            cacheUsage: { inputTokens: cachedInputTokens === null ? 0 : inputTokens, cachedInputTokens, missingRequestCount: cachedInputTokens === null ? 1 : 0 },
            threadId: "thread-1", agentPath: null, parentThreadId: null, turnCount: 1,
            firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 }], query: {}, pagination });
        }
        for (const [kind, component, convert] of [
          ["ds", DeepseekBalanceCards, deepseekAccountFromSnapshot],
          ["ocg", OpencodeGoUsageCard, quotaAccountFromSnapshot],
          ["ccg", CcgCreditUsageCards, ccgAccountFromSnapshot],
          ["clp", ClinePassUsageCard, quotaAccountFromSnapshot],
        ]) {
          const placeholders = accountSnapshotsWithMissingProviders({ snapshots: [], warnings: [], observedAtMs: 0 },
            ["team-a", "team-b"].map((name) => ({ id: kind + "-" + name, displayName: "配置 " + name })));
          if (placeholders.snapshots.some((snapshot) => snapshot.accountId !== null)) throw new Error("Placeholder identity must remain unknown");
          const accounts = placeholders.snapshots.map(convert);
          result[kind + "MissingIdentity"] = kind === "clp"
            ? accounts.map((account) => render(component, { account })).join("")
            : render(component, { accounts, refreshControls: {}, onAccountsChanged: noop });
        }
        globalThis.fixtureApiState = { data: null, loading: true, error: null };
        globalThis.fixtureAccounts = { notificationStatus: "live", data: null, loading: true, refreshing: false, refreshControls: {}, refresh: noop,
          error: null, refreshError: null, removalNotice: null, accountRemoved: noop };
        const consoleProps = { range: { range: "30d" }, onRangeChange: noop };
        result.consoleAccountsLoading = render(ConsolePage, consoleProps);
        globalThis.fixtureAccounts = { ...globalThis.fixtureAccounts, loading: false, error: "fixture account read failure" };
        result.consoleAccountsFailed = render(ConsolePage, consoleProps);
        globalThis.fixtureAccounts = { ...globalThis.fixtureAccounts, error: null,
          data: { deepseek: null, opencodeGo: null, ccg: null, clinePass: [], warnings: [] } };
        result.consoleAccountsEmpty = render(ConsolePage, consoleProps);
        for (const [source, title] of [["deepseek", "DeepSeek"], ["opencode-go", "OpenCode Go"], ["ccg", "CommandCode Go"], ["clp", "Cline Pass"]]) {
          globalThis.fixtureAccounts.data.warnings = [{ source, code: "registry_unavailable", message: title + " 元数据暂不可用" }];
          result[source + "PartialFailure"] = render(ConsolePage, consoleProps);
        }
        globalThis.fixtureAccounts.data.deepseek = { accounts: [{ ...quotaAccount, displayName: "DeepSeek main",
          balances: [{ currency: "CNY", totalBalance: "2", grantedBalance: "0", toppedUpBalance: "2" }] }] };
        globalThis.fixtureAccounts.data.warnings = [{ source: "deepseek", code: "registry_unavailable", message: "DeepSeek 元数据暂不可用" }];
        result.partialFailureRetainsSnapshot = render(ConsolePage, consoleProps);
        globalThis.fixtureAccounts.data.deepseek = null;
        globalThis.fixtureAccounts.data.warnings = [];
        const credentialProps = { usedPercent: 37.5, resetsAt: null, planType: "plus",
          credits: { credentialRefreshedAt: 1790131317, subscription: { activeUntil: 1790993155, lastChecked: 1790131317 }, observedAtMs: 1000,
            remaining: "0", unlimited: false, resetCreditsAvailable: "0", expirations: [], undisclosedCount: null } };
        result.credentialRefreshTime = render(WeeklyQuotaCard, credentialProps);
        result.credentialRefreshTimeEn = render(WeeklyQuotaCard, credentialProps, "en");
        result.credentialRefreshTimeMissing = render(WeeklyQuotaCard, { ...credentialProps,
          credits: { ...credentialProps.credits, credentialRefreshedAt: null } });
        result.credentialRefreshTimeOmitted = render(WeeklyQuotaCard, { ...credentialProps,
          credits: { ...credentialProps.credits, credentialRefreshedAt: undefined } });
        result.credentialRefreshTimeZero = render(WeeklyQuotaCard, { ...credentialProps,
          credits: { ...credentialProps.credits, credentialRefreshedAt: 0 } });
        globalThis.fixtureServerClock = { nowMs: Date.now() - 20 * 60_000, receivedAtMs: Date.now(), timeZone: "UTC" };
        result.skewedClientFreshAccount = render(AccountUpdateDescription, { observedAtMs: globalThis.fixtureServerClock.nowMs, isDefault: false, refreshFailed: false });
        globalThis.fixtureServerClock = undefined;
        globalThis.fixtureApiState = { data: { request: {}, data: { weeklyQuota: { usedPercent: 37.5, resetsAt: 1000, planType: "plus" } } },
          loading: true, error: null };
        globalThis.fixtureAccounts.data.openaiWeeklyQuota = { usedPercent: 37.5, resetsAt: 1000, planType: "plus" };
        result.consoleQuotaLoading = render(ConsolePage, consoleProps);
        globalThis.fixtureApiState = { ...globalThis.fixtureApiState, loading: false, error: "fixture overview failure" };
        result.consoleQuotaFailed = render(ConsolePage, consoleProps);
        globalThis.fixtureApiState = { data: { request: {}, data: { weeklyQuota: { usedPercent: 100, resetsAt: 1000, planType: "plus" } } }, loading: false, error: null };
        globalThis.fixtureAccounts.data.openaiWeeklyQuota = openAiWeeklyQuotaFromSnapshot({ provider: "openai", limits: {
          kind: "rate-limits", provider: "openai", limits: { ordinaryUsageLimit: { planType: "plus",
            secondary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 4000 } } } } });
        result.consoleQuotaAfterReset = render(ConsolePage, consoleProps);
        globalThis.fixtureAccounts.data.openaiWeeklyQuota = null;
        result.consoleQuotaCleared = render(ConsolePage, consoleProps);
        result.accountStale = render(AccountUpdateDescription, { observedAtMs: Date.now() - 16 * 60_000, isDefault: true, refreshFailed: false });
        result.accountFresh = render(AccountUpdateDescription, { observedAtMs: Date.now(), isDefault: false, refreshFailed: false });
        result.accountMissing = render(AccountUpdateDescription, { observedAtMs: 0, isDefault: false, refreshFailed: false });
        result.accountFailed = render(AccountUpdateDescription, { observedAtMs: Date.now() - 16 * 60_000, isDefault: false, refreshFailed: true });
        const partial = { ...common, inputTokens: 1000, cachedInputTokens: null,
          cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: 1 } };
        result.partialSummary = render(QuerySummary, { aggregate: partial, range: { name: "all" } });
        result.partialGlobal = render(GlobalCards, { global: partial, threadCount: 1, turnCount: 1 });
        result.partialThread = render(ThreadTable, { threads: [{ ...partial, threadId: "thread-1", agentPath: null,
          subagentUsage: { inputTokens: 1000, cachedInputTokens: null, outputTokens: 20, cacheUsage: partial.cacheUsage },
          parentThreadId: null, turnCount: 1, firstRequestStartedAtMs: 1000, lastRecordedAtMs: 1000 }], query: {}, pagination });
        globalThis.fixtureDisclosureOpen = true;
        for (const tier of ["fast", "priority", "default", "flex", "auto", null, undefined]) {
          result['tier-' + tier] = render(FastBadge, { tier, source: "request" });
        }
        for (const rate of [0, null]) {
          result['request-cache-' + rate] = render(RequestsTable, { ...requestProps, records: [{ ...record, cacheHitRate: rate }] });
        }
        for (const cache of [{ inputTokens: 100, cachedInputTokens: 0 }, { inputTokens: 100, cachedInputTokens: null }, { inputTokens: 0, cachedInputTokens: 0 }]) {
          result['summary-cache-' + cache.inputTokens + '-' + cache.cachedInputTokens] = render(QuerySummary, { aggregate: { ...common, cacheUsage: { ...cache, missingRequestCount: 0 } }, range: { name: 'all' } });
        }
        result.fastRequests = render(RequestsTable, { ...requestProps, records: [{ ...record, requestServiceTier: "priority", serviceTier: "default",
          traffic: { label: "ocg", session: "batch-fast", interaction: 23 } }] });
        result.responseFastRequests = render(RequestsTable, { ...requestProps, records: [{ ...record, serviceTier: "priority", requestServiceTier: null }] });
        for (const [name, outcome] of Object.entries({
          rejected: { status: "failed", httpStatus: 403, errorCode: "permission_denied" },
          disconnected: { status: "completed", deliveryStatus: "disconnected", errorCode: "client_disconnected" },
          unknown: { status: "failed", errorCode: "untrusted-sensitive-value" },
          incomplete: { status: "incomplete" },
        })) result['relay-outcome-' + name] = render(RequestsTable, { ...requestProps, records: [{ ...record,
          source: "relay", httpStatus: 200, errorCode: null, traffic: null,
          relayRequestId: "7d40d091-8c74-4dcf-9e40-71531f3f1a98", ...outcome }] });
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
        const completedDetail = { ...detail, response: { ...response, durationMs: 9500, callTiming: { totalMs: 9500 }, firstTokenMs: 1550, responseTimeMs: 25,
          outputTokens: 200, generationTiming: { reasoningMs: 1000, textMs: 2000, toolMs: 1000, totalMs: 4000 },
          usage: { inputTokens: 1000, cachedTokens: 500, outputTokens: 200, reasoningTokens: 50 },
          output: [{ type: "message", text: "visible-answer" }] } };
        result.structuredCall = render(TrafficDetail, { detail: completedDetail, provider: "openai", session: "hidden-batch", onRetry: noop, onTracePageChange: noop });
        for (const category of ["prewarm", "models"]) {
          result['call-' + category] = render(TrafficDetail, { detail: { ...completedDetail, category }, provider: "openai", session: "batch", onRetry: noop, onTracePageChange: noop });
        }
        result.pendingCall = render(TrafficDetail, { detail: { ...detail, state: "pending" }, provider: "openai", session: "batch", onRetry: noop, onTracePageChange: noop });
        result.failedCall = render(TrafficDetail, { detail: { ...completedDetail, state: "failed", response: { ...completedDetail.response,
          state: "failed", failureStage: "upstream_error", failure: "hidden-error", errorScope: "socket", error: "hidden-transport-error" } }, provider: "openai", session: "batch", onRetry: noop, onTracePageChange: noop });
        for (const [name, fields] of Object.entries({
          rateLimit: { "upstreamError.code": "stream_initialization_failed", "upstreamError.cause.type": "rate_limit_exceeded", "upstreamError.cause.statusCode": 429, "upstreamError.request_id": "readable-request-id" },
          authentication: { "upstreamError.cause.statusCode": 401 },
          unknown: { "upstreamError.code": "unknown_upstream_code" },
        })) {
          result["errorSummary-" + name] = render(TrafficDetail, { detail: { ...completedDetail, state: "failed", response: { ...completedDetail.response, state: "failed", status: 200, error: "chat_upstream_error" }, chatDiagnostics: { fields, truncated: false } }, provider: "clp-main", session: "batch", onRetry: noop, onTracePageChange: noop });
        }
        const completedWithDisconnect = { ...completedDetail, response: { ...completedDetail.response, errorScope: "client_disconnected" } };
        result.completedDisconnect = render(TrafficDetail, { detail: completedWithDisconnect, provider: "openai", session: "batch", onRetry: noop, onTracePageChange: noop });
        globalThis.fixtureDisclosureOpen = true;
        result.completedDisconnectOpen = render(TrafficDetail, { detail: completedWithDisconnect, provider: "openai", session: "batch", onRetry: noop, onTracePageChange: noop });
        result.relayRoutingOpen = render(TrafficDetail, { detail: { ...detail, debug: {
          inbound: { headers: {}, headersTruncated: false, body: "{}", bodyTruncated: false },
          delivered: null, transformations: ["provider_routing_pinned"]
        } }, provider: "clp-main", session: "batch", onRetry: noop, onTracePageChange: noop });
        globalThis.fixtureDisclosureOpen = false;
        result.incompleteOutput = render(TrafficDetail, { detail: { ...detail, response: {
          state: "completed", status: null, usage: null, headers: {}, body: "", outputTruncated: true,
          output: [{ type: "message", text: "complete visible message" }],
        } }, provider: "openai", session: "batch-1", onRetry: noop, onTracePageChange: noop });
        globalThis.localStorage = { getItem: key => key.endsWith(":columns") ? JSON.stringify({ ua: true, error: true }) : null };
        result.preferences = render(RequestsTable, requestProps);
        globalThis.localStorage = { getItem: key => key.endsWith(":columns") ? JSON.stringify({ traffic: false, time: false, provider: false, ua: true }) : null };
        globalThis.fixtureCaptureTable = true;
        result.requestsHiddenDetail = render(RequestsTable, requestProps);
        result.requestsDetailVisibility = JSON.stringify({ visible: globalThis.fixtureTable.getColumn("traffic").getIsVisible(), canHide: globalThis.fixtureTable.getColumn("traffic").getCanHide() });
        globalThis.fixtureTable.getColumn("traffic").toggleVisibility(false);
        result.requestsDetailAfterHide = String(globalThis.fixtureTable.getColumn("traffic").getIsVisible());
        result.trafficHiddenDetail = render(TrafficTable, { exchanges: [exchange], onOpen: noop });
        result.trafficDetailVisibility = JSON.stringify({ visible: globalThis.fixtureTable.getColumn("time").getIsVisible(), canHide: globalThis.fixtureTable.getColumn("time").getCanHide() });
        globalThis.localStorage = { getItem: key => key.endsWith(":columns") ? JSON.stringify({ nested_value: false, Action: false, optional: false }) : null };
        result.requiredGroupedColumns = render(DataTable, { title: "Required", storageKey: "fixture-required", pagination: { mode: "none" },
          columns: [{ id: "group", header: "Group", columns: [{ accessorKey: "nested.value", header: "Value", enableHiding: false }, { header: "Action", enableHiding: false, cell: () => h("button", { type: "button" }, "Open") }, { id: "optional", header: "Optional" }] }], data: [{ nested: { value: "required-cell" } }] });
        globalThis.fixtureCaptureTable = false;
        globalThis.localStorage = { getItem: key => key.endsWith(":columns") ? JSON.stringify({ ua: true, error: true }) : null };
        globalThis.fixtureQuery = { range: "30d", offset: 0, limit: 50 };
        const errorsData = { errors: { requestCount: 100, unsuccessfulRequestCount: 60, requestOutcomes: { completed: 40, interrupted: 0, failed: 60, incomplete: 0 } }, total: 60,
          nextOffset: 50, records: Array.from({ length: 50 }, (_, id) => ({ ...record, id, threadId: null })) };
        globalThis.fixtureApiState = { data: { queryKey: JSON.stringify(globalThis.fixtureQuery), data: errorsData }, loading: false, error: null };
        result.errors = render(ErrorsPage, {});
        errorsData.records[0] = { ...interruptedRecord, threadId: null };
        result.interruptedErrors = render(ErrorsPage, {});
        errorsData.records[0].requestServiceTier = "priority";
        errorsData.records[0].serviceTier = "default";
        result.fastErrors = render(ErrorsPage, {});
        errorsData.records[0].upstreamProvider = "deepseek";
        result.errorsUpstream = render(ErrorsPage, {});
        globalThis.fixtureApiState.loading = true;
        result.errorsRefreshing = render(ErrorsPage, {});
        globalThis.fixtureApiState.data.queryKey = "previous-filter";
        result.errorsLoading = render(ErrorsPage, {});
        const { QueryFilters } = await server.ssrLoadModule("/src/components/metrics/query-filters.tsx?actual");
        result.filters = render(QueryFilters, { query: { range: "all" }, onChange: noop });
        result.activeFilters = render(QueryFilters, { query: { range: "7d", provider: ["openai"], model: "test" }, onChange: noop });
        const { useRequests } = await server.ssrLoadModule("/src/hooks/use-requests.ts");
        const { useThreads } = await server.ssrLoadModule("/src/hooks/use-threads.ts");
        const { useErrors } = await server.ssrLoadModule("/src/hooks/use-errors.ts");
        const { useThreadDetail } = await server.ssrLoadModule("/src/hooks/use-thread-detail.ts");
        const { useMetricsSnapshot } = await server.ssrLoadModule("/src/hooks/use-metrics-snapshot.ts");
        const query = { range: "all", offset: 0, limit: 10 };
        const nextQuery = { ...query, offset: 10 };
        const readSnapshot = q => {
          let value;
          function Probe() {
            const state = useMetricsSnapshot(q, JSON.stringify(q), noop);
            value = { data: state.data, error: state.error, errorCode: state.errorCode, loading: state.loading };
            return null;
          }
          render(Probe, {});
          return value;
        };
        globalThis.fixtureApiState = { data: { queryKey: JSON.stringify(query), data: { total: 1 } }, loading: false, error: null };
        const ready = readSnapshot(query);
        const changed = readSnapshot(nextQuery);
        const returned = readSnapshot(query);
        globalThis.fixtureApiState = { ...globalThis.fixtureApiState, loading: true };
        const pending = readSnapshot(query);
        globalThis.fixtureApiState = { ...globalThis.fixtureApiState, loading: false, error: "fixture failure" };
        const failed = readSnapshot(nextQuery);
        globalThis.fixtureApiState = { data: null, loading: true, error: null };
        const initial = readSnapshot(query);
        result.queryStates = JSON.stringify({ ready, changed, returned, pending, failed, initial });

        // Exercise each real wrapper and API loader, including changed filters and encoded thread IDs.
        const wiringQuery = { ...query, provider: ["openai", "clp-main"], model: "fixture model" };
        const nextWiringQuery = { ...wiringQuery, offset: 10 };
        globalThis.fixtureThreadDetail = null;
        const wiring = {};
        for (const [name, hook] of Object.entries({ requests: useRequests, threads: useThreads, errors: useErrors, detail: useThreadDetail })) {
          wiring[name] = [];
          for (const [q, threadId] of [[wiringQuery, "thread/one"], [nextWiringQuery, "thread/two"]]) {
            function Probe() { if (name === "detail") hook(threadId, q); else hook(q); return null; }
            render(Probe, {});
            const calls = [];
            globalThis.fetch = async (path, init) => {
              calls.push({ path, signal: init.signal });
              return { ok: true, json: async () => ({ path }) };
            };
            const controller = new AbortController();
            const snapshot = await globalThis.fixtureApiLoad(controller.signal);
            const activeSignals = calls.every(call => call.signal instanceof AbortSignal && !call.signal.aborted);
            controller.abort();
            wiring[name].push({ deps: globalThis.fixtureApiDeps, snapshot, paths: calls.map(call => call.path),
              activeSignals, cancelledSignals: calls.every(call => call.signal.aborted) });
          }
        }
        result.queryWiring = JSON.stringify(wiring);
        console.log(JSON.stringify(result));
      } finally { await server.close(); }
    `;
    markup = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: fileURLToPath(new URL("../webui/", import.meta.url)),
      encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    })) as Record<string, string>;
  }, 35_000);

  const headers = (html: string) => [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)]
    .map((match) => match[1]!.replace(/<[^>]*>/g, ""));

  it("renders Relay debug stages within the existing detail", () => {
    expect(markup.relayDebug).toContain("调试报文");
    expect(markup.relayDebug).toContain("客户端入站请求");
    expect(markup.relayDebug).toContain("客户端交付报文");
    expect(markup.relayDebug).toContain("Relay 出站请求");
    expect(markup.relayRoutingOpen).toContain("已将 CLP 上游限定为 DeepSeek");
    expect(markup.relayDebug).not.toContain("<script>private</script>");
  });
  it("distinguishes account loading and failures from confirmed empty configuration", () => {
    expect(markup.consoleAccountsLoading).toContain("正在加载账户列表");
    expect(markup.consoleAccountsLoading).not.toContain("尚未配置");
    expect(markup.consoleAccountsFailed).toContain("账户数据暂未更新");
    expect(markup.consoleAccountsFailed).toContain("无法完成请求，请重试。");
    expect(markup.consoleAccountsFailed).not.toContain("fixture account read failure");
    expect(markup.consoleAccountsFailed).not.toContain("尚未配置");
    expect(markup.consoleAccountsEmpty).toContain("尚未配置 DeepSeek 账户");
  });

  it("distinguishes partial source failures from empty configuration and preserves valid snapshots", () => {
    for (const [source, title] of [["deepseek", "DeepSeek"], ["opencode-go", "OpenCode Go"], ["ccg", "CommandCode Go"], ["clp", "Cline Pass"]]) {
      const html = markup[source + "PartialFailure"]!;
      expect(html).toContain(title + " 元数据暂不可用");
      expect(html).not.toContain("尚未配置 " + title + " 账户");
      if (source !== "deepseek") expect(html).toContain("尚未配置 DeepSeek 账户");
    }
    expect(markup.partialFailureRetainsSnapshot).toContain("DeepSeek 元数据暂不可用");
    expect(markup.partialFailureRetainsSnapshot).toContain("¥2.00");
    expect(markup.skewedClientFreshAccount).not.toContain("待更新");
  });

  it("shows the refreshed official window after redemption without another model request", () => {
    expect(markup.consoleQuotaAfterReset).toContain('aria-valuenow="100"');
    expect(markup.consoleQuotaAfterReset).toContain("1970-01-01 01:06");
    expect(markup.consoleQuotaAfterReset).not.toContain('aria-valuenow="0"');
    expect(markup.consoleQuotaAfterReset).not.toContain("1970-01-01 00:16");
  });

  it("keeps the last OpenAI quota during range loading and failures but honors an explicit empty snapshot", () => {
    for (const key of ["consoleQuotaLoading", "consoleQuotaFailed"]) {
      expect(markup[key]).toContain('aria-valuenow="62.5"');
      expect(markup[key]).not.toContain("尚未获取 OpenAI 额度快照");
    }
    expect(markup.consoleQuotaFailed).toContain("加载失败");
    expect(markup.consoleQuotaFailed).toContain("无法完成请求，请重试。");
    expect(markup.consoleQuotaFailed).not.toContain("fixture overview failure");
    expect(markup.consoleQuotaCleared).toContain("尚未获取 OpenAI 额度快照");
  });

  it("uses short consistent account update descriptions", () => {
    expect(markup.accountStale).toContain("待更新");
    expect(markup.accountStale).not.toContain('data-slot="badge"');
    expect(markup.accountFresh).toContain("更新于");
    expect(markup.accountFresh).not.toContain("待更新");
    expect(markup.accountMissing).toContain("尚未更新");
    expect(markup.accountFailed).toContain("更新失败");
    expect(markup.accountFailed).not.toContain("待更新");
  });

  it("keeps missing-snapshot account labels distinct without inventing an actionable identity", () => {
    for (const kind of ["ds", "ocg", "ccg", "clp"]) {
      const html = markup[kind + "MissingIdentity"]!;
      expect(html).toContain("配置 team-a");
      expect(html).toContain("配置 team-b");
      expect(html).not.toContain("删除本地账户");
    }
  });

  it("renders managed account names as badges beside their provider", () => {
    for (const [key, provider] of [["ocgQuotaOrder", "OpenCode Go"], ["clineQuotaOrder", "Cline Pass"],
      ["deepseekAccountBadge", "DeepSeek"], ["ccgAccountBadge", "CommandCode Go"]]) {
      const html = markup[key!]!;
      expect(html).toContain(`>${provider}</span>`);
      expect(html).not.toContain(`${provider} main`);
      expect(html).toMatch(/data-slot="badge"[^>]*><span[^>]*>main<\/span><\/span>/);
    }
  });

  it("orders quota windows by duration and keeps missing windows absent", () => {
    for (const key of ["ocgQuotaOrder", "clineQuotaOrder"]) {
      const html = markup[key]!;
      const labels = [...html.matchAll(/aria-label="([^"]+)剩余比例"/g)].map((match) => match[1]);
      const values = [...html.matchAll(/aria-valuenow="([^"]+)"/g)].map((match) => match[1]);
      expect(labels).toEqual(["5小时", "7天", "月度"]);
      expect(values).toEqual(["90", "80", "70"]);
    }
    const missing = markup.missingQuotaWindow!;
    expect(missing).not.toContain("7天");
    expect([...missing.matchAll(/aria-label="([^"]+)剩余比例"/g)].map((match) => match[1]))
      .toEqual(["5小时", "月度"]);
  });

  it("exposes the quota value and names its current snapshot correctly", () => {
    expect(markup.quota).toContain('aria-valuenow="62.5"');
    expect(markup.quota).toContain('aria-label="OpenAI 周额度剩余比例"');
    expect(markup.quota).toContain('data-progressing=""');
    expect(markup.quotaEmpty).toContain("尚未获取 OpenAI 额度快照");
    expect(markup.quotaEmpty).not.toContain("role=\"progressbar\"");
    expect(markup.quotaExhausted).toContain('aria-valuenow="0"');
    expect(markup.quotaFull).toContain('aria-valuenow="100"');
    expect(markup.quotaEmpty).not.toContain("当前时间范围");
    expect(markup.quotaUnknownReset).toContain("重置时间未知");
    expect(markup.quotaUnknownReset).not.toContain("暂无限额快照");
    expect(markup.quotaUnknownReset).toContain('aria-valuenow="62.5"');
  });

  it("shows the recorded upstream provider as a tag beside the model without adding a column", () => {
    for (const key of ["trafficUpstream"] as const) {
      const html = markup[key]!;
      expect(html).toContain('title="routing.finalProvider"><span class="truncate">deepseek');
      expect(html.indexOf('title="routing.finalProvider"')).toBeGreaterThan(html.indexOf("model-test"));
      expect(html.match(/<th\b/g)?.length).toBe(markup.traffic!.match(/<th\b/g)?.length);
    }
    expect(markup.requests).not.toContain('title="routing.finalProvider"');
    expect(markup.traffic).not.toContain('title="routing.finalProvider"');
  });

  it("omits identical response model badges while preserving evidence and warning badges", () => {
    const badge = (html: string, title: string) => [...html.matchAll(/<span\b[^>]*data-slot="badge"[^>]*>[\s\S]*?<\/span>/g)].find(match => match[0].includes(`title="${title}"`))?.[0] ?? "";
    for (const key of ["requestsMatch", "traffic"]) {
      expect(badge(markup[key]!, "响应模型：model-test（名称一致）")).toBe("");
      expect(markup[key]).toContain('aria-description="请求：model-test；响应回显：model-test。仅比较名称，不验证模型身份。"');
    }
    for (const key of ["requests", "trafficMismatch"]) {
      const tag = badge(markup[key]!, "响应模型：model-other（名称不一致）");
      expect(tag).toContain('data-variant="destructive"');
      expect(tag).toContain('data-size="sm"');
      expect(tag).toContain('data-icon="inline-start"');
    }
    expect(badge(markup.requestsMissingModel!, "响应模型：model-test（信息不足）")).toContain('data-variant="outline"');
    for (const key of ["trafficUpstream", "trafficOtherUpstream", "requestsOtherUpstream", "requestsMuseUpstream", "detailMuseUpstream", "requestsOtherProviderDeepSeek"]) {
      const tag = badge(markup[key]!, "routing.finalProvider");
      expect(tag).toContain('data-variant="outline"');
      expect(tag).not.toContain('data-icon="inline-start"');
      expect(tag).toContain('data-size="sm"');
      expect(tag).not.toContain("上游：");
    }
    for (const key of ["requestsClpUnexpected", "trafficClpUnexpected", "detailClpUnexpected"]) {
      const tag = badge(markup[key]!, "routing.finalProvider");
      expect(tag).toContain('data-variant="destructive"');
      expect(tag).toContain('data-icon="inline-start"');
    }
  });

  it("omits the CLP model prefix in thread and turn tables only for CLP providers", () => {
    for (const table of ["threads", "turns"]) {
      expect(markup[table + "Model-clp-main"]).toContain(">deepseek-v4.1-flash</span>");
      expect(markup[table + "Model-clp-main"]).not.toContain("cline-pass/");
      expect(markup[table + "Model-openai"]).toContain(">cline-pass/deepseek-v4.1-flash</span>");
    }
  });

  it("uses the recorded Relay account for model display and the same upstream index in list and detail", () => {
    for (const key of ["trafficRelayClp", "detailRelayClp"]) {
      expect(markup[key]).toContain('>deepseek-v4.1-flash</span>');
      expect(markup[key]).toContain('title="routing.finalProvider"><span class="truncate">deepseek');
      expect(markup[key]).not.toContain('响应模型：deepseek/deepseek-v4.1-flash（名称不一致）');
      expect(markup[key]).toContain('clp-main');
    }
    expect(markup.trafficRelayUnknown).toContain('响应模型：deepseek/deepseek-v4.1-flash（名称不一致）');
    expect(markup.trafficRelayUnknown).not.toContain('title="routing.finalProvider"');
  });

  it("shows only actual upstream badges for CLP account and dump identities", () => {
    for (const key of ["requestsClp", "trafficClp"]) {
      expect(markup[key]).toContain('title="routing.finalProvider"><span class="truncate">deepseek');
      expect(markup[key]).not.toContain("hidden-response-model");
      expect(markup[key]).not.toContain("响应模型：");
      expect(markup[key]).toContain('>deepseek-v4.1-flash</span>');
      expect(markup[key]).not.toContain('>cline-pass/deepseek-v4.1-flash</span>');
    }
    expect(markup.trafficClpNoUpstream).toContain('>deepseek-v4.1-flash</span>');
    expect(markup.trafficClpNoUpstream).not.toContain("hidden-response-model");
    expect(markup.trafficClpNoUpstream).not.toContain('title="routing.finalProvider"');
  });

  it("renders independently collected request diagnostics in both languages", () => {
    for (const key of ["requestDiagnostics", "requestDiagnosticsEn"]) {
      for (const value of ["deepseek", "stop", "rate_limit", "429"]) expect(markup[key]).toContain(value);
    }
    for (const label of ["实际上游提供商", "提供商尝试次数", "模型尝试次数", "流式阶段", "内层上游 HTTP 状态"]) expect(markup.requestDiagnostics).toContain(label);
    for (const label of ["Actual upstream provider", "Provider attempts", "Model attempts", "HTTP phase", "Inner upstream HTTP status"]) expect(markup.requestDiagnosticsEn).toContain(label);
  });

  it("shows independently collected request upstream evidence, leaving aggregate errors unchanged", () => {
    for (const key of ["requestsUpstream", "requestsOtherUpstream", "requestsClp"]) {
      expect(markup[key]).toContain('title="routing.finalProvider"');
    }
    expect(markup.requestsUpstream).toContain("尝试 3 次");
    expect(markup.errorsUpstream).not.toContain('title="routing.finalProvider"');
  });

  it("shows the reported final provider beside the detail model without inferring fallbacks", () => {
    expect(markup.traceFinalProvider).toMatch(/title="routing.finalProvider"><span class="truncate">deepseek/);
    expect(markup.traceFinalProvider!.indexOf('title="routing.finalProvider"')).toBeLessThan(markup.traceFinalProvider!.indexOf(">请求</"));
    expect(markup.traceClosed).not.toContain('title="routing.finalProvider"');
    expect(markup.traceFallbackOnly).not.toContain('title="routing.finalProvider"');
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
    expect(markup.filters).not.toContain("会话 ID");
    expect(markup.filters).not.toContain("轮次 ID");
    expect(markup.activeFilters).toContain("筛选 · 3");
    expect(markup.filters).not.toContain("筛选 ·");
  });

  it("uses shared table skeletons and hides stale error values while loading", () => {
    expect(headers(markup.errorsLoading!)).toEqual(headers(markup.errors!));
    expect([...markup.errorsLoading!.matchAll(/<tr\b/g)]).toHaveLength(6);
    expect([...markup.errorsLoading!.matchAll(/data-slot="skeleton"/g)]).toHaveLength(headers(markup.errorsLoading!).length * 5);
    expect(markup.errorsLoading).not.toContain("fixture failure");
    expect(markup.errorsLoading).toMatch(/data-slot="card-content"[^>]*inert=""/);
    expect(markup.errorsLoading).toContain('data-slot="spinner"');
    expect(markup.errors).not.toContain('data-slot="skeleton"');
    expect(markup.errorsRefreshing).not.toContain('data-slot="skeleton"');
    expect([...markup.errorsRefreshing!.matchAll(/<tr\b/g)]).toHaveLength(51);
    expect(markup.errorsRefreshing).toContain("刷新中");
  });

  it("shows error filters and table without summary cards or thread inputs", () => {
    const html = markup.errors!;
    const filters = html.indexOf('data-query-filters="true"');
    expect(filters).toBeGreaterThan(0);
    expect(html).toContain('data-thread-filters="false"');
    const cards = html.slice(0, filters);
    expect(cards).not.toContain("请求总数");
    expect(cards).not.toContain("成功率");
    expect(cards).not.toContain('data-slot="card-header"');
    expect(cards).not.toContain('data-slot="card-content"');
  });

  it("groups request identity, usage, performance and detail columns", () => {
    expect(markup.turnsDuration).toContain("本轮耗时");
    expect(markup.turnsDuration).toContain("1 min 11 s");
    expect(markup.turnsDurationZero).toContain("Turn duration");
    expect(markup.turnsDurationZero).toContain("0 ms");
    expect(markup.threadTiming).not.toContain("会话总耗时");
    expect(markup.threadTiming).not.toContain("最近一轮耗时");
    expect(headers(markup.threads!)).toContain("总耗时");
    expect(markup.threads).toContain("2 min");
    expect(markup.threadsPartialDuration).toContain("2 min *");
    expect(markup.threadsPartialDuration).toContain("耗时缺失轮数：1");
    expect(markup.threadsPartialDuration).toContain("历史未补齐");
    expect(markup.threadsMissingDuration).not.toContain("2 min");
    expect(markup.threadTimingEn).not.toContain("Thread total duration");
    expect(markup.threadTimingPartial).not.toContain("会话已知累计耗时");
    expect(markup.threadTimingPartialEn).not.toContain("Thread known duration");
    expect(markup.threadTimingMissing).not.toContain("2 min");
    expect(headers(markup.requests!)).toEqual([
      "记录时间", "提供商", "模型", "思考", "状态", "输入", "命中率", "输出",
      "首 Token", "速度", "请求耗时", "来源", "请求详情",
    ]);
    expect(markup.requests).not.toContain("未关联");
    expect(markup.requests).toContain("查看请求");
    expect(markup.requests).not.toContain('href="/requests/');
    expect(markup.requests).not.toContain('href="/traffic');
    expect(markup.requests).not.toContain('role="checkbox"');
    expect(markup.requests).not.toContain("已选");
    expect(markup.requests).toContain("名称不一致");
  });

  it("shows request and period cache hit rates without treating missing data as zero", () => {
    const cacheCell = (html: string) => [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)][headers(html).indexOf("命中率")]?.[1];
    expect(cacheCell(markup.requests!)).toContain("50.0%");
    expect(cacheCell(markup['request-cache-0']!)).toContain("0.0%");
    expect(cacheCell(markup['request-cache-null']!)).toContain("—");
    expect(markup.partialSummary).toContain("缓存命中率 50.0%");
    expect(markup['summary-cache-100-0']).toContain("缓存命中率 0.0%");
    expect(markup['summary-cache-100-null']).toContain("缓存命中率 —");
    expect(markup['summary-cache-0-0']).toContain("缓存命中率 —");
  });

  it("shows only Fast tiers and preserves the exact call link", () => {
    for (const tier of ["fast", "priority"]) expect(markup['tier-' + tier]).toContain(">Fast</span>");
    for (const tier of ["default", "flex", "auto", "null", "undefined"]) expect(markup['tier-' + tier]).toBe("");
    expect(markup.fastRequests).toContain(">Fast</span>");
    expect(markup.fastRequests).toContain("查看请求");
    expect(markup.fastRequests).not.toContain('href="/traffic');
    expect(markup.fastErrors).toContain(">Fast</span>");
    expect(markup.requests).not.toContain(">Fast</span>");
    expect(markup.responseFastRequests).not.toContain(">Fast</span>");
  });

  it("keeps request and response Fast badges on their own side", () => {
    const requestOnly = markup.fastRequestOnly!;
    const responseOnly = markup.fastResponseOnly!;
    expect(requestOnly.match(/>Fast<\/span>/g)).toHaveLength(1);
    expect(responseOnly.match(/>Fast<\/span>/g)).toHaveLength(1);
    expect(requestOnly.indexOf(">Fast</span>")).toBeGreaterThan(requestOnly.indexOf("请求服务层级"));
    expect(responseOnly.indexOf(">Fast</span>")).toBeGreaterThan(responseOnly.indexOf("响应服务层级"));
    expect(responseOnly.indexOf(">Fast</span>")).toBeLessThan(responseOnly.indexOf("请求服务层级"));
    expect(markup.traceClosed).not.toContain(">Fast</span>");
  });

  it("reserves intrinsic toolbar and pagination space around the bounded table viewport", () => {
    for (const key of ["requests", "threads", "turns", "loading"]) {
      expect(markup[key]).toMatch(/data-slot="card"[^>]*class="[^"]*min-h-min/);
      const html = markup[key]!;
      const hasSearch = html.includes('data-slot="input-group"');
      expect(html).toContain(`grid-template-rows:${hasSearch ? "auto " : ""}minmax(10rem,1fr) auto`);
      const contentStart = html.indexOf('data-slot="card-content"');
      expect(html.slice(0, contentStart)).toContain("lucide-columns3");
      expect(html.slice(contentStart)).not.toContain("lucide-columns3");
      expect(markup[key]).toContain("[contain:size]");
    }
    expect(markup.summaryLoading).toMatch(/class="[^"]*invisible" aria-hidden="true"/);
    expect(markup.summaryLoading).toContain("全部保留历史");
  });

  it("keeps aggregate speeds after token counts and omits unused selection", () => {
    expect(headers(markup.turns!)).toEqual([
      "时间", "轮次", "提供商", "模型", "思考", "请求", "失败", "输入", "命中率", "输出",
      "中断", "未完整", "耗时", "子代理",
    ]);
    expect(markup.turns).not.toContain('role="checkbox"');
  });

  it("shows cache rates in separate columns and removes them from input tooltips", () => {
    const cell = (html: string, label: string) => [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)][headers(html).indexOf(label)]?.[1] ?? "";
    for (const key of ["requests", "threads", "turns", "providers", "subagentsRelated"]) {
      expect(headers(markup[key]!)).toContain("命中率");
      expect(cell(markup[key]!, "命中率")).toContain("50.0%");
      const input = cell(markup[key]!, "输入");
      const head = markup[key]!.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/u)?.[1];
      expect(head).toContain('aria-description="输入 Token"');
      expect(head).toContain('aria-description="输出 Token"');
      expect(head).toContain('aria-description="缓存命中率"');
      expect(input).toContain('aria-description="缓存：50; 无缓存：50"');
      expect(input).not.toContain("命中率");
      expect(input).not.toContain("50.0%");
    }
    expect(cell(markup.turnsZeroCache!, "命中率")).toContain("0.0%");
    for (const key of ["turnsUnknownCache", "turnsZeroInput", "providersUnknownCache"]) {
      expect(cell(markup[key]!, "命中率")).toContain("—");
      expect(markup[key]).not.toContain("NaN");
    }
    expect(markup.providersEmpty).toContain('colSpan="8"');
    expect(cell(markup.partialThread!, "输入")).toContain('aria-description="缓存：≥ 50; 无缓存：≥ 50"');
    expect(cell(markup.partialThread!, "输入")).not.toContain("命中率");
  });

  it("preserves unknown and zero cache counts in thread tooltips while retaining aggregate cache metrics", () => {
    expect(markup.threadCacheZero).toContain("子代理: 输入: 100, 缓存: 0, 缓存命中率: 0.0%, 输出: 20, 合计: 120");
    expect(markup.threadCacheUnknown).toContain("子代理: 输入: 100, 缓存: —, 缓存命中率: —, 输出: 20, 合计: 120");
    expect(markup.threadInputZero).toContain("子代理: 输入: 0, 缓存: 0, 缓存命中率: —, 输出: 20, 合计: 20");
    expect(markup.partialThread).toContain("子代理: 输入: 1K, 缓存: ≥ 50, 缓存命中率: 50.0%, 输出: 20, 合计: 1.02K");
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
    const timeIndex = headers(markup.requests!).indexOf("记录时间");
    const speedIndex = headers(markup.ascending!).indexOf("输出");
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
    expect(markup.inputToken).toContain('aria-description="缓存：5; 无缓存：5"');
    expect(markup.inputToken).not.toContain("50.0%");
    expect(markup.outputToken).toContain('aria-description="推理输出：5; 非推理输出：5"');
    const cells = [...markup.requests!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(match => match[1]!);
    for (const label of ["首 Token", "速度", "请求详情"]) {
      expect(cells[headers(markup.requests!).indexOf(label)]).not.toContain('data-slot="tooltip-trigger"');
    }
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

  it("keeps native detail buttons available despite old hidden-column preferences", () => {
    for (const key of ["requestsDetailVisibility", "trafficDetailVisibility"]) {
      expect(JSON.parse(markup[key]!)).toEqual({ visible: true, canHide: false });
    }
    expect(markup.requestsDetailAfterHide).toBe("true");
    expect(headers(markup.requestsHiddenDetail!)).toContain("请求详情");
    expect(headers(markup.requestsHiddenDetail!)).toContain("User-Agent");
    expect(headers(markup.requestsHiddenDetail!)).not.toContain("提供商");
    expect(markup.requestsHiddenDetail).toMatch(/<button\b[^>]*type="button"[^>]*>查看请求<\/button>/u);
    expect(headers(markup.trafficHiddenDetail!)).toContain("开始时间");
    expect(headers(markup.trafficHiddenDetail!)).not.toContain("提供商");
    expect(markup.trafficHiddenDetail).toMatch(/<button\b[^>]*aria-label="[^"]*的调用明细"/u);
    expect(markup.requiredGroupedColumns).toContain("required-cell");
    expect(markup.requiredGroupedColumns).toContain('<button type="button">Open</button>');
    expect(headers(markup.requiredGroupedColumns!)).not.toContain("Optional");
  });

  it("keeps headers while hiding stale rows and disabling table interaction during loading", () => {
    expect(headers(markup.loading!)).toEqual(headers(markup.requests!));
    expect(markup.loading).toContain('aria-busy="true"');
    expect(markup.loading).toMatch(/data-slot="card-content"[^>]*inert=""/);
    expect(markup.loading).toContain('data-slot="skeleton"');
    expect(markup.loading).not.toContain("model-test");
    expect(markup.loading!.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/u)?.[1]).not.toContain("失败");
    expect(markup.loading).toMatch(/class="block invisible" aria-hidden="true">共 1 条匹配/);
  });

  it("marks changed queries pending before the API effect and preserves explicit failures", () => {
    expect(JSON.parse(markup.queryStates!)).toEqual({
      ready: { data: { total: 1 }, error: null, loading: false },
      changed: { data: { total: 1 }, error: null, loading: true },
      returned: { data: { total: 1 }, error: null, loading: false },
      pending: { data: { total: 1 }, error: null, loading: false },
      failed: { data: { total: 1 }, error: "fixture failure", loading: false },
      initial: { data: null, error: null, loading: true },
    });
  });

  it("wires each metrics wrapper to its query key and actual API loader", () => {
    const wiring = JSON.parse(markup.queryWiring!) as Record<string, unknown[]>;
    for (const name of ["requests", "threads", "errors", "detail"]) {
      expect(wiring[name]).toEqual([0, 10].map((offset) => {
        const query = { range: "all", offset, limit: 10, provider: ["openai", "clp-main"], model: "fixture model" };
        const params = `range=all&offset=${offset}&limit=10&provider=openai&provider=clp-main&model=fixture+model`;
        const threadId = offset === 0 ? "thread/one" : "thread/two";
        const queryKey = JSON.stringify(name === "detail" ? [threadId, query] : query);
        const paths = name === "detail"
          ? [`/api/v1/threads/${encodeURIComponent(threadId)}/run`, `/api/v1/threads/${encodeURIComponent(threadId)}/turns?${params}`]
          : [`/api/v1/${name}?${params}`];
        const data = name === "detail" ? { run: { path: paths[0] }, turns: { path: paths[1] } } : { path: paths[0] };
        return { deps: [queryKey], snapshot: { queryKey, data }, paths, activeSignals: true, cancelledSignals: true };
      }));
    }
  });

  it("aligns numeric headers and cells on the same edge", () => {
    const columnIndex = headers(markup.requests!).indexOf("输入");
    const heads = [...markup.requests!.matchAll(/<th\b[^>]*>/g)].map(match => match[0]);
    const cells = [...markup.requests!.matchAll(/<td\b[^>]*>/g)].map(match => match[0]);
    expect(columnIndex).toBeGreaterThanOrEqual(0);
    expect(heads[columnIndex]).toContain("text-right");
    expect(cells[columnIndex]).toContain("text-right");
  });

  it("prioritizes traffic model, status and duration with compact response-model badges", () => {
    expect(headers(markup.traffic!)).toEqual(["开始时间", "提供商", "客户端", "模型", "思考", "协议", "状态", "首 Token", "速度", "请求耗时", "类型"]);
    expect(markup.traffic).toContain("WorkBuddy");
    expect(markup.traffic).toContain("客户端");
    expect(markup.traffic).toContain("Responses");
    expect(markup.traffic).toContain("100 ms");
    expect(markup.traffic).toContain("120.0 /s");
    expect(markup.traffic).not.toContain("Turn State 字符数");
    expect(markup.traffic).not.toContain("加载中…");
    expect(markup.traffic).not.toContain("#7");
    expect(markup.traffic).toContain("的调用明细");
    expect(markup.traffic).toContain("请求：model-test；响应回显：model-test。");
    expect(markup.traffic).not.toContain("→");
    expect(markup.trafficMismatch).toContain("名称不一致");
    expect(headers(markup.trafficLoading!)).toEqual(headers(markup.traffic!));
    expect(markup.trafficLoading).toContain('data-slot="skeleton"');
    expect(markup.trafficLoading).not.toContain("model-test");
    expect(markup.trafficLoading).not.toContain("的调用明细");
  });

  it("distinguishes zero first-token latency from an unrecorded value", () => {
    const cell = (html: string) => [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)][headers(html).indexOf("首 Token")]?.[1];
    expect(cell(markup.trafficFirstZero!)).toBe("0 ms");
    expect(cell(markup.trafficFirstMissing!)).toBe("—");
  });

  it("keeps total request duration beside response and speed, including zero and unknown", () => {
    const cell = (html: string) => [...html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)][headers(html).indexOf("请求耗时")]?.[1];
    expect(cell(markup.requests!)).toContain("1 s");
    expect(cell(markup.traffic!)).toBe("1 s");
    expect(cell(markup.trafficFirstZero!)).toBe("0 ms");
    expect(cell(markup.trafficFirstMissing!)).toBe("—");
    expect(markup.requestDetailZero).toContain("请求耗时");
  });

  it("structures call overview, response, request and folded diagnostics without guessing live state", () => {
    const html = markup.structuredCall!;
    const titles = [...html.matchAll(/data-slot="card-title"[^>]*>(.*?)<\/div>/g)].map(match => match[1]);
    expect(titles.slice(1)).toEqual(["响应", "请求", "诊断信息"]);
    expect(html).toContain('aria-label="调用概览"');
    for (const text of ["响应", "速度", "请求耗时", "9.5 s", "1.55 s", "21.1 /s", "输入 Token", "输出 Token", "缓存 500", "其中推理 50", "visible-answer"]) expect(html).toContain(text);
    for (const text of ["hidden-batch", "request-body", "old-trace-body", "详细耗时", "逐条用量归因"]) expect(html).not.toContain(text);
    expect(markup.pendingCall).toContain("未记录终态");
    expect(markup.pendingCall).not.toContain("进行中");
    expect(markup.pendingCall).toContain('data-slot="empty"');
    expect(markup.failedCall!.match(/role="alert"/g)).toHaveLength(1);
    expect(markup.failedCall).toContain("错误详情");
    expect(markup.failedCall).not.toContain("hidden-error");
    expect(markup["errorSummary-rateLimit"]).toContain("上游限流，请稍后重试或降低并发。");
    expect(markup["errorSummary-rateLimit"]).toContain("stream_initialization_failed");
    expect(markup["errorSummary-rateLimit"]).toContain("rate_limit_exceeded");
    expect(markup["errorSummary-rateLimit"]).toContain("readable-request-id");
    expect(markup["errorSummary-rateLimit"]).toContain("429");
    expect(markup["errorSummary-rateLimit"]).toContain("HTTP 200");
    expect(markup["errorSummary-authentication"]).toContain("上游认证失败，请检查 API Key。");
    expect(markup["errorSummary-unknown"]).toContain("现有记录不足以确定具体原因");
    for (const category of ["prewarm", "models"]) {
      expect(markup['call-' + category]).not.toContain('>首 Token</span>');
      expect(markup['call-' + category]).not.toContain("输入 Token");
      expect(markup['call-' + category]).not.toContain("速度");
    }
  });

  it("keeps completed calls successful and preserves late disconnects in folded diagnostics", () => {
    expect(markup.completedDisconnect).toContain("完成后的诊断信息");
    expect(markup.completedDisconnect).not.toContain("client_disconnected");
    for (const html of [markup.completedDisconnect, markup.completedDisconnectOpen]) {
      expect(html).not.toContain("请求失败");
      expect(html).not.toContain('role="alert"');
      expect(html).toContain("visible-answer");
    }
    expect(markup.completedDisconnectOpen).toContain("client_disconnected");
    expect(markup.completedDisconnectOpen).toContain("不改变本次请求的完成状态");
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
      expect(html).toContain("batch-1");
      expect(html).toContain("提供商");
      expect(html).toContain("调用编号");
      expect(html).toContain("#7");
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
