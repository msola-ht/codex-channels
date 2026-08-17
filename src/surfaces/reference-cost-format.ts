import type {
  DisplayPriceCurrency,
  ExchangeRateSnapshot,
} from "../application/index.js";
import { formatModelUsageBucket } from "./account-format.js";

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
  pricingBuckets?: ReadonlyArray<"peak" | "off-peak">;
}

export function formatReferenceCostTotal(
  value: ReferenceCostDisplay,
  exchangeRate?: ExchangeRateSnapshot | null,
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
  const bucketSuffix = pricingBucketsSuffix(value.pricingBuckets);
  const equivalent = value.currency === "USD" && exchangeRate
    ? formatCnyEquivalent(value.totalCostNanos, exchangeRate)
    : null;
  return `${formatCurrencyNanos(value.currency, value.totalCostNanos)}`
    + `${equivalent === null ? "" : `（${equivalent}）`}${bucketSuffix}${coverage}`;
}

export function formatReferenceCostBreakdown(
  value: ReferenceCostDisplay,
  exchangeRate?: ExchangeRateSnapshot | null,
): string[] {
  if (value.currency === null || value.pricedRequestCount === 0) return [];
  const lines: string[] = [];
  if (value.inputCostNanos !== null) {
    lines.push(formatCostLine("输入价格", value, value.inputCostNanos, exchangeRate));
  }
  if (value.cachedInputCostNanos !== null) {
    lines.push(formatCostLine("缓存价格", value, value.cachedInputCostNanos, exchangeRate));
  }
  if (value.outputCostNanos !== null) {
    lines.push(formatCostLine("输出价格", value, value.outputCostNanos, exchangeRate));
  }
  return lines;
}

function formatCostLine(
  label: string,
  value: ReferenceCostDisplay,
  nanos: number,
  exchangeRate?: ExchangeRateSnapshot | null,
): string {
  const equivalent = value.currency === "USD" && exchangeRate
    ? formatCnyEquivalent(nanos, exchangeRate)
    : null;
  return `${label}：${formatCurrencyNanos(value.currency!, nanos)}`
    + `${equivalent === null ? "" : `（${equivalent}）`}`;
}

export function formatCnyEquivalent(
  usdNanos: number,
  exchangeRate: ExchangeRateSnapshot,
): string | null {
  if (!Number.isFinite(usdNanos) || usdNanos < 0) return null;
  const converted = Math.round(usdNanos * exchangeRate.usdToCny);
  if (!Number.isSafeInteger(converted)) return null;
  return `≈ ${formatCurrencyNanos("CNY", converted)}`;
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

function pricingBucketsSuffix(
  buckets: ReadonlyArray<"peak" | "off-peak"> | undefined,
): string {
  if (buckets === undefined || buckets.length === 0) return "";
  if (buckets.length === 1) {
    return `（${formatModelUsageBucket(buckets[0]!)}）`;
  }
  return "（多档）";
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
