import { useApi } from "@/hooks/use-api"
import { useCurrency } from "@/hooks/currency-context"
import { fetchRequests } from "@/lib/api"
import type {
  RangeName,
  RequestSortDirection,
  RequestSortKey,
} from "@/lib/types"

export function useRequests(
  range: RangeName,
  offset: number,
  limit: number,
  sort: RequestSortKey,
  direction: RequestSortDirection,
) {
  const { currency } = useCurrency()
  return useApi(
    (signal) => fetchRequests(
      range,
      offset,
      limit,
      sort,
      direction,
      currency,
      signal,
    ),
    [range, offset, limit, sort, direction, currency],
  )
}
