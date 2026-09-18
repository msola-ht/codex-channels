import type { DailyUsageRow, HourlyUsageRow, Range, UsageTrendResponse } from "./types"
import { formatCalendarDay } from "./format"

const calendarDayMs = 86_400_000

// UTC 数值只用于遍历日期标签，不用固定 24 小时推进真实本地时间，避免夏令时跨日偏移。
function calendarDayNumber(timestamp: number): number {
  return Date.parse(`${formatCalendarDay(timestamp)}T00:00:00.000Z`)
}

export function fillRecentDays(rows: DailyUsageRow[], endAtMs: number, days: number): DailyUsageRow[] {
  const endDay = calendarDayNumber(endAtMs)
  return fillDays(rows, endDay - (days - 1) * calendarDayMs, days)
}

export function fillDailyRange(rows: DailyUsageRow[], range: Range<string>): DailyUsageRow[] {
  const endDay = calendarDayNumber(Math.max(range.startAtMs, range.endAtMs - 1))
  const firstRecordedDay = rows[0]?.day
  const startDay = range.name === "all"
    ? firstRecordedDay === undefined ? endDay : Date.parse(`${firstRecordedDay}T00:00:00.000Z`)
    : calendarDayNumber(range.startAtMs)
  const days = Math.max(1, Math.round((endDay - startDay) / calendarDayMs) + 1)
  return fillDays(rows, startDay, days)
}

function fillDays(rows: DailyUsageRow[], startDay: number, days: number): DailyUsageRow[] {
  const rowsByDay = new Map(rows.map((row) => [row.day, row]))
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(startDay + index * calendarDayMs).toISOString().slice(0, 10)
    return rowsByDay.get(day) ?? {
      day, requestCount: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
    }
  })
}

export interface UsageTrendRow {
  period: string
  requestCount: number
  inputTokens: number
  cachedInputTokens: number | null
  outputTokens: number
}

export function usageTrendRows(trend: UsageTrendResponse): UsageTrendRow[] {
  return toUsageTrend(trend.granularity === "hour" ? trend.hourly : fillDailyRange(trend.daily, trend.range))
}

export function toUsageTrend(rows: (DailyUsageRow | HourlyUsageRow)[]): UsageTrendRow[] {
  return rows.map((row) => {
    const inputTokens = Math.max(0, row.inputTokens)
    const cachedInputTokens = row.cachedInputTokens === null
      ? null
      : Math.min(Math.max(0, row.cachedInputTokens), inputTokens)
    const outputTokens = Math.max(0, row.outputTokens)
    return {
      period: "hour" in row ? row.hour : row.day,
      requestCount: row.requestCount,
      inputTokens,
      cachedInputTokens,
      outputTokens,
    }
  })
}
