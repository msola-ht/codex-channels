import { useApi } from "@/hooks/use-api"
import { fetchErrors } from "@/lib/api"
import type { RangeName } from "@/lib/types"

export function useErrors(range: RangeName, offset: number, limit: number) {
  return useApi(
    (signal) => fetchErrors(range, offset, limit, signal),
    [range, offset, limit],
  )
}
