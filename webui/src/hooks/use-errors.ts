import { useApi } from "@/hooks/use-api"
import { useCurrency } from "@/hooks/currency-context"
import { fetchErrors } from "@/lib/api"
import type { RangeName } from "@/lib/types"

export function useErrors(range: RangeName) {
  const { currency } = useCurrency()
  return useApi(
    (signal) => fetchErrors(range, currency, signal),
    [range, currency],
  )
}
