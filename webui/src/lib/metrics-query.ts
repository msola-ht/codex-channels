import type { MetricsQuery, RangeName } from "./types"

export function metricsRangeSelection(query: MetricsQuery): RangeName | "custom" | null {
  if (query.from !== undefined || query.to !== undefined) return "custom"
  const range = query.range ?? "all"
  // URL inputs remain unchanged for the API to reject; never turn an invalid range into all history.
  return ["today", "yesterday", "24h", "7d", "30d", "90d", "all"].includes(range) ? range : null
}

export function metricsQueryParams(query: MetricsQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item))
  }
  return params.toString()
}

export function metricsLink(path: string, query: MetricsQuery, scope: Partial<MetricsQuery> = {}): string {
  const next = { ...query, ...scope }
  delete next.offset
  delete next.limit
  delete next.sort
  delete next.direction
  return `${path}?${metricsQueryParams(next)}`
}
