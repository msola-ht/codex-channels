import type { DailyUsageRow } from "@/lib/types"

export interface StackedUsageTrendRow {
  day: string
  uncachedInputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number
  totalTokens: number
}

export function toStackedUsageTrend(rows: DailyUsageRow[]): StackedUsageTrendRow[] {
  return rows.map((row) => {
    const inputTokens = Math.max(0, row.inputTokens)
    const cachedInputTokens = row.cachedInputTokens === null
      ? null
      : Math.min(Math.max(0, row.cachedInputTokens), inputTokens)
    const outputTokens = Math.max(0, row.outputTokens)
    return {
      day: row.day,
      uncachedInputTokens: cachedInputTokens === null
        ? null
        : inputTokens - cachedInputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    }
  })
}
