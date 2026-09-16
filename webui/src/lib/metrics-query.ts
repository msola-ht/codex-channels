import type { MetricsQuery } from "@/lib/types"

export function metricsQueryParams(query: MetricsQuery): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") params.set(key, String(value))
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
