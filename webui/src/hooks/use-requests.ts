import { useApi } from "@/hooks/use-api"
import { useCurrency } from "@/hooks/currency-context"
import { fetchRequests } from "@/lib/api"
import type { RangeName } from "@/lib/types"

export function useRequests(
  range: RangeName,
  afterId: number | null,
  limit: number,
) {
  const { currency } = useCurrency()
  return useApi(
    (signal) => fetchRequests(range, afterId, limit, currency, signal),
    [range, afterId, limit, currency],
  )
}
