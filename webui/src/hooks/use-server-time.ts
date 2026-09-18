import { useApi } from "@/hooks/use-api"
import { fetchServerTime } from "@/lib/api"
import { setServerTimeZone } from "@/lib/format"

export function useServerTime() {
  return useApi(async (signal) => {
    const time = await fetchServerTime(signal)
    setServerTimeZone(time.timeZone)
    return time
  }, [])
}
