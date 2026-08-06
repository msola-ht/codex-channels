import { useApi } from "@/hooks/use-api"
import { fetchErrors } from "@/lib/api"
import type { RangeName } from "@/lib/types"

export function useErrors(range: RangeName) {
  return useApi((signal) => fetchErrors(range, signal), [range])
}
