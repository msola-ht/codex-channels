import type {
  ConversationCommandResult,
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
  RequestMetricsTimeRange,
} from "../application/index.js";

import {
  formatPercent,
} from "./account-format.js";
import {
  formatElapsedDuration,
  formatTokensPerSecond,
} from "./elapsed-duration.js";
import { toStructuredMarkdownList } from "./markdown-list.js";
import {
  formatCodexProviderLabel,
  formatProviderLabel,
} from "./provider-format.js";
import {
  formatCurrencyNanos,
  formatExchangeRateLine,
  formatReferenceCostBreakdown,
  formatReferenceCostTotal,
  toDisplayReferenceCost,
  type ReferenceCostDisplay,
} from "./reference-cost-format.js";
import {
  formatCacheHitRate,
  formatTokenCount,
} from "./token-format.js";
export function formatConversationMetrics(
  result: Extract<ConversationCommandResult, { kind: "metrics" }>,
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string {
  const summary = result.summary;
  if (summary === null) {
    return "当前会话尚未绑定 Thread，暂无请求指标。";
  }
  if ("view" in summary) {
    if (summary.view === "errors") {
      return formatErrorMetricsReport(summary);
    }
    return formatAggregateMetricsReport(summary, priceCurrency, exchangeRate);
  }
  const currency = priceCurrency?.(summary.modelProvider) ?? "usd";
  const lines = [
    "## 请求指标",
    `Thread：${formatThreadId(summary.threadId)}`,
    ...(exchangeRate ? formatExchangeRateLine(exchangeRate) : []),
  ];
  if (summary.latestTurn) {
    const turn = summary.latestTurn;
    lines.push(
      "",
      "### 最近运行聚合",
      `模型请求：${turn.requestCount} 次${turn.unsuccessfulRequestCount > 0 ? `（异常 ${turn.unsuccessfulRequestCount} 次）` : ""}`,
      `模型请求聚合耗时：${formatElapsedDuration(turn.requestDurationMs)}`,
      `- **Token**：${formatTokenCount(turn.inputTokens + turn.outputTokens)}`,
      ...(turn.cachedInputTokens === null
        ? ["  - 缓存：上游未提供完整数据"]
        : [
            `  - 输入命中缓存：${formatTokenCount(turn.cachedInputTokens)}`,
            `  - 输入未命中缓存：${formatTokenCount(Math.max(0, turn.inputTokens - turn.cachedInputTokens))}`,
            `  - 缓存命中率：${formatCacheHitRate(turn.inputTokens, turn.cachedInputTokens)}`,
          ]),
      `  - 输出：${formatTokenCount(turn.outputTokens)}`,
      ...(turn.reasoningOutputTokens > 0
        ? [`  - 其中推理输出：${formatTokenCount(turn.reasoningOutputTokens)}`]
        : []),
      ...(turn.outputTokensPerSecond === null
        ? []
        : [`  - ${formatAggregateOutputSpeed(
            turn.outputTokensPerSecond,
            turn.outputSpeedTimedCount,
            turn.outputSpeedSampleCount,
          )}`]),
      ...formatReferenceCost({
        currency: turn.pricingCurrency,
        totalCostNanos: turn.totalCostNanos,
        inputCostNanos: turn.inputCostNanos,
        cachedInputCostNanos: turn.cachedInputCostNanos,
        outputCostNanos: turn.outputCostNanos,
        pricedRequestCount: turn.pricedRequestCount,
        requestCount: turn.requestCount,
        uncachedInputPricePerMillionNanos:
          turn.uncachedInputPricePerMillionNanos,
        cachedInputPricePerMillionNanos:
          turn.cachedInputPricePerMillionNanos,
        outputPricePerMillionNanos: turn.outputPricePerMillionNanos,
        hasMixedPrices: turn.hasMixedPrices,
      }, currency, exchangeRate),
      ...[formatAveragePriceValue(turn, currency, exchangeRate)]
        .filter((value): value is string => value !== null)
        .map((value) => `均价：${value}`),
      ...(turn.compact
        ? [formatCompactMetrics(turn.compact, currency, exchangeRate)]
        : []),
    );
  } else {
    lines.push("", "### 最近运行聚合", "暂无已记录请求");
  }
  if (summary.threadAggregate) {
    const aggregate = summary.threadAggregate;
    lines.push(
      "",
      "### 当前会话指标累计",
      `Turn：${aggregate.turnCount} 次`,
      `模型请求：${aggregate.requestCount} 次${aggregate.unsuccessfulRequestCount > 0 ? `（异常 ${aggregate.unsuccessfulRequestCount} 次）` : ""}`,
      `模型请求累计耗时：${formatElapsedDuration(aggregate.requestDurationMs)}`,
      `- **Token**：${formatTokenCount(aggregate.inputTokens + aggregate.outputTokens)}`,
      ...(aggregate.cachedInputTokens === null
        ? ["  - 缓存：上游未提供完整数据"]
        : [
            `  - 输入命中缓存：${formatTokenCount(aggregate.cachedInputTokens)}`,
            `  - 输入未命中缓存：${formatTokenCount(Math.max(0, aggregate.inputTokens - aggregate.cachedInputTokens))}`,
            `  - 缓存命中率：${formatCacheHitRate(aggregate.inputTokens, aggregate.cachedInputTokens)}`,
          ]),
      `  - 输出：${formatTokenCount(aggregate.outputTokens)}`,
      ...(aggregate.reasoningOutputTokens > 0
        ? [`  - 其中推理输出：${formatTokenCount(aggregate.reasoningOutputTokens)}`]
        : []),
      ...(aggregate.outputTokensPerSecond === null
        ? []
        : [`  - ${formatAggregateOutputSpeed(
            aggregate.outputTokensPerSecond,
            aggregate.outputSpeedTimedCount,
            aggregate.outputSpeedSampleCount,
          )}`]),
      ...formatReferenceCost(toReferenceCostDisplay(aggregate), currency, exchangeRate),
      ...[formatAveragePriceValue(aggregate, currency, exchangeRate)]
        .filter((value): value is string => value !== null)
        .map((value) => `均价：${value}`),
      ...(aggregate.compact
        ? [formatCompactMetrics(aggregate.compact, currency, exchangeRate)]
        : []),
    );
  }
  if (summary.latestDirectApi) {
    const direct = summary.latestDirectApi;
    lines.push(
      "",
      "### 最近直接 API",
      `API 提供商：${formatProviderLabel(direct.providerName ?? direct.provider)}`,
      `调用模型：${direct.model ?? "未知"}`,
      `状态：${formatRequestStatus(direct.status)}${direct.httpStatus === null ? "" : ` · HTTP ${direct.httpStatus}`}`,
      ...(direct.requestDurationMs === null
        ? []
        : [`耗时：${formatElapsedDuration(direct.requestDurationMs)}`]),
      ...(direct.inputTokens === null && direct.outputTokens === null
        ? []
        : [
            `- **Token**：${formatTokenCount(
              direct.totalTokens ?? (direct.inputTokens ?? 0) + (direct.outputTokens ?? 0),
            )}`,
            ...(direct.cachedInputTokens === null
              ? direct.inputTokens === null
                ? []
                : [`  - 输入：${formatTokenCount(direct.inputTokens)}`]
              : [
                  `  - 输入命中缓存：${formatTokenCount(direct.cachedInputTokens)}`,
                  `  - 输入未命中缓存：${formatTokenCount(Math.max(0, (direct.inputTokens ?? 0) - direct.cachedInputTokens))}`,
                ]),
            ...(direct.outputTokens === null
              ? []
              : [`  - 输出：${formatTokenCount(direct.outputTokens)}`]),
            ...(direct.reasoningOutputTokens === null || direct.reasoningOutputTokens === 0
              ? []
              : [`  - 其中推理输出：${formatTokenCount(direct.reasoningOutputTokens)}`]),
          ]),
      ...(direct.totalCostNanos === null
        ? []
        : [
            ...formatReferenceCost({
              currency: direct.pricingCurrency,
              totalCostNanos: direct.totalCostNanos,
              inputCostNanos: direct.inputCostNanos,
              cachedInputCostNanos: direct.cachedInputCostNanos,
              outputCostNanos: direct.outputCostNanos,
              pricedRequestCount: 1,
              requestCount: 1,
              uncachedInputPricePerMillionNanos:
                direct.uncachedInputPricePerMillionNanos,
              cachedInputPricePerMillionNanos:
                direct.cachedInputPricePerMillionNanos,
              outputPricePerMillionNanos: direct.outputPricePerMillionNanos,
              hasMixedPrices: false,
            }, currency, exchangeRate),
          ]),
    );
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

function formatErrorMetricsReport(
  report: Extract<NonNullable<Extract<
    ConversationCommandResult,
    { kind: "metrics" }
  >["summary"]>, { view: "errors" }>,
): string {
  const failureRate = report.requestCount === 0
    ? 0
    : report.unsuccessfulRequestCount / report.requestCount * 100;
  const lines = [
    "## 请求指标 · 异常请求",
    `范围：${formatMetricsRange(report.range)}`,
    "",
    `模型请求：${report.requestCount} 次`,
    `异常请求：${report.unsuccessfulRequestCount} 次`,
    `异常率：${formatPercent(failureRate)}`,
  ];
  if (report.groups.length === 0) {
    lines.push("", "本时间范围未记录异常请求。");
    return toStructuredMarkdownList(lines.join("\n"));
  }
  lines.push(
    "",
    "### 异常明细",
    ...report.groups.map((group, index) => {
      const provider = group.providerName
        ? formatProviderLabel(group.providerName)
        : formatCodexProviderLabel(group.provider);
      const status = formatRequestStatus(group.status);
      const httpStatus = group.httpStatus === null
        ? ""
        : ` · HTTP ${group.httpStatus}`;
      return `${index + 1}. ${provider} / ${group.model ?? "未知模型"} · ${formatMetricsErrorType(group.errorType)} · ${status}${httpStatus} · ${group.requestCount} 次 · 最近发生：${formatMetricOccurredAt(group.lastOccurredAtMs)}`;
    }),
  );
  const hidden = report.totalGroupCount - report.groups.length;
  if (hidden > 0) {
    lines.push(`仅显示出现次数最高的 ${report.groups.length} 项，另有 ${hidden} 项。`);
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

function formatThreadId(threadId: string): string {
  return threadId.length > 12
    ? `${threadId.slice(0, 12)}…`
    : threadId;
}

function formatMetricsErrorType(value: string | null): string {
  if (value === null) return "未提供错误类型";
  const knownLabel = {
    websocket_closed: "WebSocket 提前关闭",
    upstream_handshake_error: "上游握手失败",
    upstream_request_error: "上游请求失败",
    upstream_response_error: "上游响应失败",
    upstream_error: "上游错误",
    client_request_error: "客户端请求失败",
    client_disconnected: "客户端提前断开",
    response_not_observed: "响应结果未完整观测",
    http_error: "HTTP 请求失败",
    usage_limit_reached: "OpenAI 用量上限",
    rate_limit_reached: "速率限制",
    turn_start_error: "Turn 启动失败",
    turn_steer_error: "Turn 追加失败",
    turn_notification_error: "Turn 运行失败",
  }[value];
  if (knownLabel !== undefined) return knownLabel;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)
    ? value
    : "其他错误";
}

function formatMetricOccurredAt(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatAggregateMetricsReport(
  report: Extract<NonNullable<Extract<
    ConversationCommandResult,
    { kind: "metrics" }
  >["summary"]>, { view: "global" | "providers" | "models" }>,
  priceCurrency?: (
    provider: string | null | undefined,
  ) => DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string {
  const viewName = {
    global: "全局",
    providers: "按提供商",
    models: "按模型",
  }[report.view];
  const lines = [
    `## 请求指标 · ${viewName}`,
    `范围：${formatMetricsRange(report.range)}`,
    ...(exchangeRate ? formatExchangeRateLine(exchangeRate) : []),
  ];
  if (report.aggregate === null) {
    lines.push("", "本时间范围暂无已记录请求。");
    return toStructuredMarkdownList(lines.join("\n"));
  }
  lines.push(
    "",
    "### 本时间范围累计",
    ...formatMetricsAggregate(
      report.aggregate,
      priceCurrency?.(null) ?? "usd",
      exchangeRate,
    ),
  );
  if (report.view !== "global" && report.groups.length > 0) {
    const groupView = report.view === "providers" ? "providers" : "models";
    lines.push(
      "",
      groupView === "providers" ? "### 提供商明细" : "### 模型明细",
      ...report.groups.map((group, index) => formatMetricsGroup(
        group,
        index,
        groupView,
        priceCurrency?.(group.provider) ?? "usd",
        exchangeRate,
      )),
    );
    const hidden = report.totalGroupCount - report.groups.length;
    if (hidden > 0) {
      lines.push(`仅显示请求量最高的 ${report.groups.length} 项，另有 ${hidden} 项。`);
    }
  }
  return toStructuredMarkdownList(lines.join("\n"));
}

function formatMetricsAggregate(
  aggregate: {
  requestCount: number;
  unsuccessfulRequestCount: number;
  requestDurationMs: number;
  inputTokens: number;
  cachedInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
  outputTokensPerSecond: number | null;
  outputSpeedSampleCount: number;
  outputSpeedTimedCount: number;
  ttftAverageMs: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  ttftSampleCount: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
  compact?: Parameters<typeof formatCompactMetricsValue>[0] | null;
  },
  currency: DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string[] {
  return [
    `模型请求：${aggregate.requestCount} 次${aggregate.unsuccessfulRequestCount > 0 ? `（异常 ${aggregate.unsuccessfulRequestCount} 次）` : ""}`,
    `模型请求累计耗时：${formatElapsedDuration(aggregate.requestDurationMs)}`,
    `- **Token**：${formatTokenCount(aggregate.inputTokens + aggregate.outputTokens)}`,
    ...(aggregate.cachedInputTokens === null
      ? ["  - 缓存：上游未提供完整数据"]
      : [
          `  - 输入命中缓存：${formatTokenCount(aggregate.cachedInputTokens)}`,
          `  - 输入未命中缓存：${formatTokenCount(Math.max(0, aggregate.inputTokens - aggregate.cachedInputTokens))}`,
          `  - 缓存命中率：${formatCacheHitRate(aggregate.inputTokens, aggregate.cachedInputTokens)}`,
        ]),
    `  - 输出：${formatTokenCount(aggregate.outputTokens)}`,
    ...(aggregate.reasoningOutputTokens > 0
      ? [`  - 其中推理输出：${formatTokenCount(aggregate.reasoningOutputTokens)}`]
      : []),
    ...(aggregate.outputTokensPerSecond === null
      ? []
      : [`  - ${formatAggregateOutputSpeed(
          aggregate.outputTokensPerSecond,
          aggregate.outputSpeedTimedCount,
          aggregate.outputSpeedSampleCount,
        )}`]),
    ...(aggregate.ttftAverageMs === null || aggregate.ttftP50Ms === null || aggregate.ttftP95Ms === null
      ? []
      : [
          `  - 首段回复延迟：平均 ${formatMetricLatency(aggregate.ttftAverageMs)} · P50 ${formatMetricLatency(aggregate.ttftP50Ms)} · P95 ${formatMetricLatency(aggregate.ttftP95Ms)}（覆盖 ${aggregate.ttftSampleCount}/${aggregate.requestCount} 次请求）`,
        ]),
    ...formatReferenceCost(toReferenceCostDisplay(aggregate), currency, exchangeRate),
    ...(aggregate.compact
      ? [formatCompactMetrics(aggregate.compact, currency, exchangeRate)]
      : []),
  ];
}

function formatMetricsGroup(
  group: {
    provider: string | null;
    providerName?: string;
    model: string | null;
    aggregate: Parameters<typeof formatMetricsAggregate>[0];
  },
  index: number,
  view: "providers" | "models",
  currency: DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string {
  const provider = group.providerName
    ? formatProviderLabel(group.providerName)
    : group.provider === null
      ? "未知提供商"
      : formatCodexProviderLabel(group.provider);
  const label = view === "models"
    ? `${provider} / ${group.model ?? "未知模型"}`
    : provider;
  const aggregate = group.aggregate;
  const speed = aggregate.outputTokensPerSecond === null
    ? "速度未知"
    : `${formatTokensPerSecond(aggregate.outputTokensPerSecond)}`;
  const latency = aggregate.ttftP50Ms === null || aggregate.ttftP95Ms === null
    ? "首段延迟未知"
    : `首段 P50/P95 ${formatMetricLatency(aggregate.ttftP50Ms)}/${formatMetricLatency(aggregate.ttftP95Ms)}`;
  const reasoning = aggregate.reasoningOutputTokens > 0
    ? `  - 其中推理输出：${formatTokenCount(aggregate.reasoningOutputTokens)}`
    : "";
  const referenceCost = toReferenceCostDisplay(aggregate);
  const referenceCostDisplay = toDisplayReferenceCost(
    referenceCost,
    currency,
    exchangeRate ?? null,
  );
  const costBreakdown = formatReferenceCostBreakdown(referenceCostDisplay);
  const cost = aggregate.pricedRequestCount === 0
    ? "  - **费用**：总价未知"
    : `  - **费用**：${formatReferenceCostTotal(referenceCostDisplay, exchangeRate ?? null)}${costBreakdown.length === 0 ? "" : `（${costBreakdown.join(" · ")}）`}`;
  return [
    `${index + 1}. ${label}`,
    `  - 请求：${aggregate.requestCount} 次${aggregate.unsuccessfulRequestCount > 0 ? `（异常 ${aggregate.unsuccessfulRequestCount} 次）` : ""}`,
    ...(aggregate.cachedInputTokens === null
      ? []
      : [
          `  - 输入命中缓存：${formatTokenCount(aggregate.cachedInputTokens)}`,
          `  - 输入未命中缓存：${formatTokenCount(Math.max(0, aggregate.inputTokens - aggregate.cachedInputTokens))}`,
          `  - 缓存命中率：${formatCacheHitRate(aggregate.inputTokens, aggregate.cachedInputTokens)}`,
        ]),
    `  - 输出：${formatTokenCount(aggregate.outputTokens)}`,
    ...(reasoning === "" ? [] : [reasoning]),
    `  - 合计：${formatTokenCount(aggregate.inputTokens + aggregate.outputTokens)}`,
    `  - 速度：${speed}`,
    `  - ${latency}`,
    cost,
    ...(aggregate.compact
      ? [`  - ${formatCompactMetrics(aggregate.compact, currency, exchangeRate)}`]
      : []),
  ].join("\n");
}

function formatCompactMetrics(
  compact: Parameters<typeof formatCompactMetricsValue>[0],
  currency: DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string {
  return `上下文压缩：${formatCompactMetricsValue(compact, currency, exchangeRate)}`;
}

export function formatAveragePriceValue(
  value: {
    pricingCurrency: string | null;
    totalCostNanos: number | null;
    pricedRequestCount: number;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
  },
  currency: DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string | null {
  if (
    value.pricingCurrency !== "USD"
    || value.totalCostNanos === null
    || value.pricedRequestCount === 0
    || value.requestCount === 0
  ) {
    return null;
  }
  const totalTokens = value.inputTokens + value.outputTokens;
  if (totalTokens <= 0) return null;
  const usdNanosPerHundredMillion =
    value.totalCostNanos / totalTokens * 100_000_000;
  let nanos = usdNanosPerHundredMillion;
  let displayCurrency = "USD";
  if (currency === "cny" && exchangeRate) {
    const converted = Math.round(usdNanosPerHundredMillion * exchangeRate.usdToCny);
    if (Number.isSafeInteger(converted)) {
      nanos = converted;
      displayCurrency = "CNY";
    }
  }
  const coverage = value.pricedRequestCount === value.requestCount
    ? ""
    : `（计价 ${value.pricedRequestCount}/${value.requestCount}）`;
  const amount = new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: displayCurrency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(nanos / 1_000_000_000);
  const cnyEquivalent = displayCurrency === "USD" && exchangeRate
    ? formatCnyEquivalentPerHundredMillion(
        usdNanosPerHundredMillion,
        exchangeRate,
      )
    : null;
  return `约 ${amount}/100M`
    + `${cnyEquivalent === null ? "" : `（${cnyEquivalent}/100M）`}${coverage}`;
}

function formatCnyEquivalentPerHundredMillion(
  usdNanosPerHundredMillion: number,
  exchangeRate: ExchangeRateSnapshot,
): string | null {
  const converted = Math.round(
    usdNanosPerHundredMillion * exchangeRate.usdToCny,
  );
  if (!Number.isSafeInteger(converted)) return null;
  return `≈ ${new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(converted / 1_000_000_000)}`;
}

export function formatCompactMetricsValue(
  compact: {
    model: string | null;
    hasMixedModels: boolean;
    requestCount: number;
    unsuccessfulRequestCount: number;
    inputTokens: number;
    outputTokens: number;
    pricingCurrency: string | null;
    pricedRequestCount: number;
    totalCostNanos: number | null;
  },
  currency: DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string {
  const model = compact.hasMixedModels
    ? "混合模型"
    : compact.model ?? "模型未知";
  const display = toDisplayReferenceCost({
    currency: compact.pricingCurrency,
    totalCostNanos: compact.totalCostNanos,
    inputCostNanos: null,
    cachedInputCostNanos: null,
    outputCostNanos: null,
    pricedRequestCount: compact.pricedRequestCount,
    requestCount: compact.requestCount,
    uncachedInputPricePerMillionNanos: null,
    cachedInputPricePerMillionNanos: null,
    outputPricePerMillionNanos: null,
    hasMixedPrices: false,
  }, currency, exchangeRate ?? null);
  const cost = display.currency === null || display.totalCostNanos === null
    ? compact.pricedRequestCount === 0 ? "参考费用未知" : "参考费用无法合计"
    : formatCurrencyNanos(display.currency, display.totalCostNanos);
  const coverage = compact.pricedRequestCount === compact.requestCount
    ? ""
    : `（计价 ${compact.pricedRequestCount}/${compact.requestCount}）`;
  const failures = compact.unsuccessfulRequestCount === 0
    ? ""
    : `（异常 ${compact.unsuccessfulRequestCount} 次）`;
  return `${compact.requestCount} 次${failures} · ${model} · ${formatTokenCount(compact.inputTokens + compact.outputTokens)} Token · ${cost}${coverage}`;
}

function formatReferenceCost(
  value: ReferenceCostDisplay,
  currency: DisplayPriceCurrency,
  exchangeRate?: ExchangeRateSnapshot | null,
): string[] {
  const display = toDisplayReferenceCost(value, currency, exchangeRate ?? null);
  return [
    `- **费用**：${formatReferenceCostTotal(display, exchangeRate ?? null)}`,
    ...formatReferenceCostBreakdown(display, exchangeRate ?? null)
      .map((line) => `  - ${line}`),
  ];
}

function toReferenceCostDisplay(value: {
  requestCount: number;
  pricingCurrency: string | null;
  pricedRequestCount: number;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
}): ReferenceCostDisplay {
  return {
    currency: value.pricingCurrency,
    totalCostNanos: value.totalCostNanos,
    inputCostNanos: value.inputCostNanos,
    cachedInputCostNanos: value.cachedInputCostNanos,
    outputCostNanos: value.outputCostNanos,
    pricedRequestCount: value.pricedRequestCount,
    requestCount: value.requestCount,
    uncachedInputPricePerMillionNanos:
      value.uncachedInputPricePerMillionNanos,
    cachedInputPricePerMillionNanos:
      value.cachedInputPricePerMillionNanos,
    outputPricePerMillionNanos: value.outputPricePerMillionNanos,
    hasMixedPrices: value.hasMixedPrices,
  };
}

function formatMetricsRange(range: RequestMetricsTimeRange): string {
  return {
    today: "今天",
    yesterday: "昨天",
    "this-week": "本周",
    "last-week": "上周",
    "this-month": "本月",
    "last-month": "上月",
    "24h": "最近 24 小时",
    "7d": "最近 7 天",
    "30d": "最近 30 天",
    "90d": "最近 90 天",
    "365d": "最近 365 天",
    all: "全部历史",
  }[range];
}

function formatMetricLatency(value: number): string {
  const rounded = Math.round(value);
  return rounded < 1_000
    ? `${rounded}毫秒`
    : formatElapsedDuration(rounded);
}

function formatAggregateOutputSpeed(
  outputTokensPerSecond: number,
  timedCount: number,
  sampleCount: number,
): string {
  return `综合输出速度：${formatTokensPerSecond(outputTokensPerSecond)}（不含推理 · 覆盖 ${timedCount}/${sampleCount} 次请求）`;
}

function formatRequestStatus(
  status: "completed" | "failed" | "incomplete" | "unknown",
): string {
  switch (status) {
    case "completed": return "已完成";
    case "failed": return "失败";
    case "incomplete": return "未完成";
    case "unknown": return "未知";
  }
}
