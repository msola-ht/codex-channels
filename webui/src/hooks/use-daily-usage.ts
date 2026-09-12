import { useApi } from "@/hooks/use-api"
import { fetchDailyUsage } from "@/lib/api"

export function useDailyUsage() {
  return useApi(
    (signal) => fetchDailyUsage(signal),
    [],
  )
}
