import type { ExchangeRateSnapshot } from "../application/index.js";

export interface ReferenceCostDisplay {
  currency: string | null;
  totalCostNanos: number | null;
  pricedRequestCount: number;
  requestCount: number;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
}

export function formatReferenceCostTotal(
  value: ReferenceCostDisplay,
  requestLabel: "次请求" | "个成功请求" = "次请求",
): string {
  if (value.pricedRequestCount === 0) {
    return `暂无价格快照（已计价 0/${value.requestCount} ${requestLabel}）`;
  }
  if (value.currency === null || value.totalCostNanos === null) {
    return `无法合计（已计价 ${value.pricedRequestCount}/${value.requestCount} ${requestLabel}）`;
  }
  return `${formatCurrencyNanos(value.currency, value.totalCostNanos)}（已计价 ${value.pricedRequestCount}/${value.requestCount} ${requestLabel}）`;
}

export function formatReferenceUnitPrices(
  value: ReferenceCostDisplay,
): string[] {
  if (value.pricedRequestCount === 0) return [];
  if (value.hasMixedPrices) {
    return ["单价（/M Token）：存在多档价格"];
  }
  if (
    value.currency === null
    || value.uncachedInputPricePerMillionNanos === null
    || value.cachedInputPricePerMillionNanos === null
    || value.outputPricePerMillionNanos === null
  ) {
    return ["单价（/M Token）：未知"];
  }
  return [
    `输入单价：${formatCurrencyNanos(value.currency, value.uncachedInputPricePerMillionNanos)}/M Token`,
    `缓存输入单价：${formatCurrencyNanos(value.currency, value.cachedInputPricePerMillionNanos)}/M Token`,
    `输出单价：${formatCurrencyNanos(value.currency, value.outputPricePerMillionNanos)}/M Token`,
  ];
}

export function formatCurrencyNanos(currency: string, value: number): string {
  const amount = value / 1_000_000_000;
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: amount < 0.01 ? 6 : 2,
    maximumFractionDigits: 6,
  }).format(amount);
}

export function formatReferenceCostCnyValue(
  value: ReferenceCostDisplay,
  exchangeRate: ExchangeRateSnapshot,
): string | null {
  if (
    value.currency !== "USD"
    || value.totalCostNanos === null
    || value.pricedRequestCount === 0
  ) {
    return null;
  }
  const converted = Math.round(value.totalCostNanos * exchangeRate.usdToCny);
  if (!Number.isSafeInteger(converted)) return null;
  return `约 ${formatCurrencyNanos("CNY", converted)}（1 USD ≈ ${formatExchangeRate(exchangeRate.usdToCny)} CNY）`;
}

export function formatExchangeRateLine(exchangeRate: ExchangeRateSnapshot): string {
  return `汇率：1 USD ≈ ${formatExchangeRate(exchangeRate.usdToCny)} CNY（${exchangeRate.source} · ${new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(exchangeRate.effectiveAtMs))}）`;
}

function formatExchangeRate(value: number): string {
  return value.toFixed(4);
}
