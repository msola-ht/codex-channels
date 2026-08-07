interface CostFields {
  totalCostNanos: number | null
  totalCostCnyNanos?: number | null
  pricingCurrency: string | null
  pricing?: { currency?: string | null } | null
}

export type DisplayCurrency = "cny" | "usd"

function money(nanos: number, currency: string): string {
  const amount = nanos / 1_000_000_000
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `
  const digits = amount >= 100 ? 2 : amount >= 1 ? 3 : 4
  return `${symbol}${amount.toFixed(digits)}`
}

export function formatCost(
  value: CostFields,
  currency?: DisplayCurrency | null,
): string {
  const pricingCurrency = value.pricingCurrency ?? value.pricing?.currency ?? null
  if (currency === "cny" && value.totalCostCnyNanos !== null && value.totalCostCnyNanos !== undefined) {
    return money(value.totalCostCnyNanos, "CNY")
  }
  if (currency === "usd" && value.totalCostNanos !== null && pricingCurrency === "USD") {
    return money(value.totalCostNanos, "USD")
  }
  if (currency === "cny") {
    return value.totalCostCnyNanos !== null && value.totalCostCnyNanos !== undefined
      ? money(value.totalCostCnyNanos, "CNY")
      : value.totalCostNanos === null || pricingCurrency === null
        ? "—"
        : money(value.totalCostNanos, pricingCurrency)
  }
  if (value.totalCostCnyNanos !== null && value.totalCostCnyNanos !== undefined) {
    return money(value.totalCostCnyNanos, "CNY")
  }
  if (value.totalCostNanos === null || pricingCurrency === null) {
    return "—"
  }
  return money(value.totalCostNanos, pricingCurrency)
}

export interface CostDetailFields {
  pricingCurrency: string | null
  pricing?: { currency?: string | null } | null
  inputCostNanos?: number | null
  uncachedInputCostNanos?: number | null
  cachedInputCostNanos: number | null
  outputCostNanos: number | null
  inputCostCnyNanos?: number | null
  cachedInputCostCnyNanos?: number | null
  outputCostCnyNanos?: number | null
}

export function formatCostDetail(
  value: CostDetailFields,
  currency?: DisplayCurrency | null,
): { label: string; value: string }[] {
  const pricingCurrency = value.pricingCurrency ?? value.pricing?.currency ?? null
  const pick = (
    nanos: number | null | undefined,
    cnyNanos: number | null | undefined,
  ): string => {
    if (nanos === null || nanos === undefined) return "—"
    if (currency === "cny" && cnyNanos !== null && cnyNanos !== undefined) {
      return money(cnyNanos, "CNY")
    }
    return pricingCurrency === null
      ? "—"
      : money(nanos, pricingCurrency)
  }
  const inputNanos = value.inputCostNanos ?? value.uncachedInputCostNanos ?? null
  return [
    { label: "输入", value: pick(inputNanos, value.inputCostCnyNanos) },
    {
      label: "缓存",
      value: pick(value.cachedInputCostNanos, value.cachedInputCostCnyNanos),
    },
    { label: "输出", value: pick(value.outputCostNanos, value.outputCostCnyNanos) },
  ]
}

export function formatAvgPer100M(
  value: CostFields & { inputTokens: number | null; outputTokens: number },
  currency?: DisplayCurrency | null,
): string {
  const totalTokens = (value.inputTokens ?? 0) + value.outputTokens
  if (totalTokens <= 0 || value.totalCostNanos === null) return "—"
  const autoCny = value.totalCostCnyNanos !== null && value.totalCostCnyNanos !== undefined
  const targetCny = currency === "cny"
    || ((currency === undefined || currency === null) && autoCny)
  const cnyNanos = targetCny ? value.totalCostCnyNanos ?? null : null
  const targetCurrency = cnyNanos !== null
    ? "CNY"
    : currency === "usd"
      ? "USD"
      : value.pricingCurrency
  const nanos = cnyNanos ?? value.totalCostNanos
  if (nanos === null || targetCurrency === null) return "—"
  const avg = nanos / 1_000_000_000 / totalTokens * 100_000_000
  const symbol = targetCurrency === "CNY" ? "¥" : targetCurrency === "USD" ? "$" : `${targetCurrency} `
  return `${symbol}${avg.toFixed(2)}/100M`
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  if (value >= 100_000_000) {
    const n = value / 100_000_000
    return `${Number.isInteger(n) ? n : n.toFixed(2)}亿`
  }
  if (value >= 10_000) {
    const n = value / 10_000
    return `${Number.isInteger(n) ? n : n.toFixed(1)}万`
  }
  return value.toLocaleString("zh-CN")
}

export function formatDuration(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)}分`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}秒`
  return `${Math.round(value)}毫秒`
}

export function formatSpeed(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  return `${value.toFixed(1)} tok/s`
}

export function formatTime(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—"
  const date = new Date(value)
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatSuccessRate(requestCount: number, unsuccessful: number): string {
  if (requestCount <= 0) return "—"
  return `${((requestCount - unsuccessful) / requestCount * 100).toFixed(1)}%`
}

export function shortThreadId(threadId: string): string {
  return threadId.length <= 14 ? threadId : `${threadId.slice(0, 8)}…${threadId.slice(-4)}`
}
