import type { DailyUsageRow } from "@/lib/types"

export interface UsageTrendRow {
  day: string
  inputTokens: number
  cachedInputTokens: number | null
  outputTokens: number
}

export function toUsageTrend(rows: DailyUsageRow[]): UsageTrendRow[] {
  return rows.map((row) => {
    const inputTokens = Math.max(0, row.inputTokens)
    const cachedInputTokens = row.cachedInputTokens === null
      ? null
      : Math.min(Math.max(0, row.cachedInputTokens), inputTokens)
    const outputTokens = Math.max(0, row.outputTokens)
    return {
      day: row.day,
      inputTokens,
      cachedInputTokens,
      outputTokens,
    }
  })
}
