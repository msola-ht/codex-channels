import { useApi } from "@/hooks/use-api"
import { fetchThreads } from "@/lib/api"
import type { MetricsQuery } from "@/lib/types"

export function useThreads(query: MetricsQuery) {
  return useApi((signal) => fetchThreads(query, signal), [JSON.stringify(query)])
}
