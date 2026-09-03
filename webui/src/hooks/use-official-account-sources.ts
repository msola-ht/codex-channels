import { useApi } from "@/hooks/use-api"
import { fetchDeepseekBalance, fetchOpencodeGoUsage } from "@/lib/api"

export function useOfficialAccountSources() {
  return useApi(async (signal) => {
    const [deepseek, opencodeGo] = await Promise.allSettled([
      fetchDeepseekBalance(signal),
      fetchOpencodeGoUsage(signal),
    ])
    return {
      deepseek: deepseek.status === "fulfilled" ? deepseek.value : null,
      opencodeGo: opencodeGo.status === "fulfilled" ? opencodeGo.value : null,
    }
  }, [])
}
