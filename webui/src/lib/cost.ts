import type { GlobalCostRow } from "../../../scripts/webui-api"

export type CostCurrency = "cny" | "usd"

export interface DisplayCost {
  primaryNanos: number
  primaryCurrency: "CNY" | "USD"
  equivalentNanos: number | null
  equivalentCurrency: "CNY" | "USD"
  requestCount: number
}

export function resolveDisplayCost(
  costs: GlobalCostRow[],
  currency: CostCurrency,
  exchangeRate: number | null,
): DisplayCost | null {
  const usd = costs.find((cost) => cost.currency.toLowerCase() === "usd")
  const cny = costs.find((cost) => cost.currency.toLowerCase() === "cny")
  const primary = currency === "cny"
    ? cny ?? (usd && exchangeRate ? { ...usd, currency: "CNY", total_cost_nanos: Math.round(usd.total_cost_nanos * exchangeRate) } : null)
    : usd ?? (cny && exchangeRate ? { ...cny, currency: "USD", total_cost_nanos: Math.round(cny.total_cost_nanos / exchangeRate) } : null)
  if (!primary) return null
  const equivalent = currency === "cny"
    ? usd
    : cny
  return {
    primaryNanos: primary.total_cost_nanos,
    primaryCurrency: currency === "cny" ? "CNY" : "USD",
    equivalentNanos: equivalent?.total_cost_nanos ?? null,
    equivalentCurrency: currency === "cny" ? "USD" : "CNY",
    requestCount: usd?.request_count ?? cny?.request_count ?? 0,
  }
}
