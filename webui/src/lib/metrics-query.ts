import type { MetricsQuery, RangeName } from "@/lib/types"

export const metricsRangeLabels: Record<RangeName | "custom", string> = {
  today: "今天", yesterday: "昨天", "7d": "最近 7 天", "30d": "最近 30 天",
  all: "全部历史", custom: "自定义日期", "24h": "最近 24 小时", "90d": "最近 90 天",
}

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
