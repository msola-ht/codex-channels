import { useApi } from "@/hooks/use-api"
import { useCurrency } from "@/hooks/currency-context"
import { fetchThreads } from "@/lib/api"

export function useThreads() {
  const { currency } = useCurrency()
  return useApi((signal) => fetchThreads(currency, signal), [currency])
}
