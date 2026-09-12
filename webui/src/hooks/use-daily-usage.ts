import { useApi } from "@/hooks/use-api"
import { fetchDailyUsage } from "@/lib/api"
import type { RangeName } from "@/lib/types"

export function useDailyUsage(range: RangeName) {
  return useApi(
    (signal) => fetchDailyUsage(range, signal),
    [range],
  )
}
