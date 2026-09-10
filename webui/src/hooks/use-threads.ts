import { useApi } from "@/hooks/use-api"
import { fetchThreads } from "@/lib/api"

export function useThreads() {
  return useApi((signal) => fetchThreads(signal), [])
}
