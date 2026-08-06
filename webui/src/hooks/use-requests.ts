import { useApi } from "@/hooks/use-api"
import { fetchRequests } from "@/lib/api"
import type { RangeName } from "@/lib/types"

export function useRequests(
  range: RangeName,
  afterId: number | null,
  limit: number,
) {
  return useApi(
    (signal) => fetchRequests(range, afterId, limit, signal),
    [range, afterId, limit],
  )
}
