import { useApi } from "@/hooks/use-api"
import { useCurrency } from "@/hooks/currency-context"
import { fetchOverview } from "@/lib/api"
import type { RangeName } from "@/lib/types"

export function useOverview(range: RangeName) {
  const { currency } = useCurrency()
  return useApi(
    (signal) => fetchOverview(range, currency, signal),
    [range, currency],
  )
}
