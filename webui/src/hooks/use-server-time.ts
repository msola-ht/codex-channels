import { createContext, useContext, useEffect } from "react"
import { useApi } from "@/hooks/use-api"
import { fetchServerTime } from "@/lib/api"
import { setServerTimeZone } from "@/lib/format"
import { observeServerTimeResync, type ServerClockSnapshot } from "@/lib/server-time"

export const ServerTimeContext = createContext<ServerClockSnapshot | null>(null)

export function useServerTimeSnapshot() {
  const snapshot = useContext(ServerTimeContext)
  if (snapshot === null) throw new Error("服务端时间尚未加载")
  return snapshot
}

export function useServerTime() {
  const request = useApi(async (signal) => {
    const time = await fetchServerTime(signal)
    setServerTimeZone(time.timeZone)
    return { ...time, receivedAtMs: Date.now() }
  }, [])
  const refetch = request.refetch
  useEffect(() => observeServerTimeResync(refetch, document, window), [refetch])
  return request
}
