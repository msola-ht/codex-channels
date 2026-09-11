import { useApi } from "@/hooks/use-api"
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
  filter: string,
) {
  return useApi(
    (signal) => fetchRequests(
      range,
      offset,
      limit,
      sort,
      direction,
      filter,
      signal,
    ),
    [range, offset, limit, sort, direction, filter],
  )
}
