import type {
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
} from "../application/index.js";

export interface ReferenceCostDisplay {
  currency: string | null;
  totalCostNanos: number | null;
  inputCostNanos: number | null;
  cachedInputCostNanos: number | null;
  outputCostNanos: number | null;
  pricedRequestCount: number;
  requestCount: number;
  uncachedInputPricePerMillionNanos: number | null;
  cachedInputPricePerMillionNanos: number | null;
  outputPricePerMillionNanos: number | null;
  hasMixedPrices: boolean;
}

export function formatReferenceCostTotal(
  value: ReferenceCostDisplay,
): string {
  if (value.pricedRequestCount === 0) {
    return `暂无价格快照（计价 0/${value.requestCount}）`;
  }
  if (value.currency === null || value.totalCostNanos === null) {
    return `无法合计（计价 ${value.pricedRequestCount}/${value.requestCount}）`;
  }
  const coverage = value.pricedRequestCount === value.requestCount
    ? ""
    : `（计价 ${value.pricedRequestCount}/${value.requestCount}）`;
  return `${formatCurrencyNanos(value.currency, value.totalCostNanos)}${coverage}`;
}

export function formatReferenceCostBreakdown(
  value: ReferenceCostDisplay,
): string[] {
  if (value.currency === null || value.pricedRequestCount === 0) return [];
  const lines: string[] = [];
  if (value.inputCostNanos !== null) {
    lines.push(`输入价格：${formatCurrencyNanos(value.currency, value.inputCostNanos)}`);
  }
  if (value.cachedInputCostNanos !== null) {
    lines.push(
      `缓存价格：${formatCurrencyNanos(value.currency, value.cachedInputCostNanos)}`,
    );
  }
  if (value.outputCostNanos !== null) {
    lines.push(`输出价格：${formatCurrencyNanos(value.currency, value.outputCostNanos)}`);
  }
  return lines;
}

export function formatCurrencyNanos(currency: string, value: number): string {
  const amount = value / 1_000_000_000;
  if (Math.abs(amount) >= 100_000_000) {
    return `${currencySymbol(currency)}${(amount / 100_000_000).toLocaleString("zh-CN", {
      maximumFractionDigits: 2,
    })} 亿`;
  }
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: 6,
    maximumFractionDigits: 6,
  }).format(amount);
}

function currencySymbol(currency: string): string {
  const symbol = new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  }).formatToParts(0).find((part) => part.type === "currency")?.value;
  return symbol ?? `${currency} `;
}

export function toDisplayReferenceCost(
  value: ReferenceCostDisplay,
  currency: DisplayPriceCurrency,
  exchangeRate: ExchangeRateSnapshot | null,
): ReferenceCostDisplay {
  if (
    currency !== "cny"
    || exchangeRate === null
    || value.currency !== "USD"
  ) {
    return value;
  }
  const rate = exchangeRate.usdToCny;
  const convertedNanos = (input: number | null): number | null => {
    if (input === null) return null;
    const converted = Math.round(input * rate);
    return Number.isSafeInteger(converted) ? converted : null;
  };
  return {
    ...value,
    currency: "CNY",
    totalCostNanos: convertedNanos(value.totalCostNanos),
    inputCostNanos: convertedNanos(value.inputCostNanos),
    cachedInputCostNanos: convertedNanos(value.cachedInputCostNanos),
    outputCostNanos: convertedNanos(value.outputCostNanos),
    uncachedInputPricePerMillionNanos: convertedNanos(
      value.uncachedInputPricePerMillionNanos,
    ),
    cachedInputPricePerMillionNanos: convertedNanos(
      value.cachedInputPricePerMillionNanos,
    ),
    outputPricePerMillionNanos: convertedNanos(
      value.outputPricePerMillionNanos,
    ),
  };
}

export function formatExchangeRateLine(exchangeRate: ExchangeRateSnapshot): string[] {
  return [
    `汇率：1 USD ≈ ${formatExchangeRate(exchangeRate.usdToCny)} CNY`,
    `  - 来源：${exchangeRate.source} · ${new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(exchangeRate.effectiveAtMs))}`,
  ];
}

export function formatExchangeRate(value: number): string {
  return value.toFixed(4);
}
