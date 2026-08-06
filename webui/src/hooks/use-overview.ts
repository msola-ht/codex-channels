import { useApi } from "@/hooks/use-api"
import { fetchOverview } from "@/lib/api"
import type { RangeName } from "@/lib/types"

export function useOverview(range: RangeName) {
  return useApi((signal) => fetchOverview(range, signal), [range])
}
