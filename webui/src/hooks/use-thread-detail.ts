import { useApi } from "@/hooks/use-api"
import { fetchThreadRun, fetchThreadTurns } from "@/lib/api"

export function useThreadRun(threadId: string) {
  return useApi((signal) => fetchThreadRun(threadId, signal), [threadId])
}

export function useThreadTurns(threadId: string) {
  return useApi((signal) => fetchThreadTurns(threadId, signal), [threadId])
}
