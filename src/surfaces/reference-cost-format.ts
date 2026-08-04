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

export function formatReferenceCostTotal(value: ReferenceCostDisplay): string {
  if (value.pricedRequestCount === 0) {
    return `暂无价格快照（已计价 0/${value.requestCount} 次请求）`;
  }
  if (value.currency === null || value.totalCostNanos === null) {
    return `无法合计（已计价 ${value.pricedRequestCount}/${value.requestCount} 次请求）`;
  }
  return `${formatCurrencyNanos(value.currency, value.totalCostNanos)}（已计价 ${value.pricedRequestCount}/${value.requestCount} 次请求）`;
}

export function formatReferenceUnitPrices(
  value: ReferenceCostDisplay,
): string[] {
  if (value.pricedRequestCount === 0) return [];
  if (value.hasMixedPrices) {
    return ["单价（每百万 Token）：存在多档价格"];
  }
  if (
    value.currency === null
    || value.uncachedInputPricePerMillionNanos === null
    || value.cachedInputPricePerMillionNanos === null
    || value.outputPricePerMillionNanos === null
  ) {
    return ["单价（每百万 Token）：未知"];
  }
  return [
    `输入单价：${formatCurrencyNanos(value.currency, value.uncachedInputPricePerMillionNanos)} / 百万 Token`,
    `缓存输入单价：${formatCurrencyNanos(value.currency, value.cachedInputPricePerMillionNanos)} / 百万 Token`,
    `输出单价：${formatCurrencyNanos(value.currency, value.outputPricePerMillionNanos)} / 百万 Token`,
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
