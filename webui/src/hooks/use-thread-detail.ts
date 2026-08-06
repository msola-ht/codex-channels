import { useApi } from "@/hooks/use-api"
import { useCurrency } from "@/hooks/currency-context"
import { fetchThreadRun, fetchThreadTurns } from "@/lib/api"

export function useThreadRun(threadId: string) {
  const { currency } = useCurrency()
  return useApi(
    (signal) => fetchThreadRun(threadId, currency, signal),
    [threadId, currency],
  )
}

export function useThreadTurns(threadId: string) {
  const { currency } = useCurrency()
  return useApi(
    (signal) => fetchThreadTurns(threadId, currency, signal),
    [threadId, currency],
  )
}
