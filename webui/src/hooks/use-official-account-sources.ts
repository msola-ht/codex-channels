import { useApi } from "@/hooks/use-api"
import { fetchOfficialAccountSnapshots } from "@/lib/api"
import type { DeepseekBalance, OpencodeGoAccountUsage, OpencodeGoQuotaWindow, OpencodeGoModelUsageEstimate } from "@/lib/types"

export function useOfficialAccountSources() {
  return useApi(async (signal) => {
    const result = await fetchOfficialAccountSnapshots(signal)
    const deepseekSnapshot = result.snapshots.find((snapshot) => snapshot.provider === "deepseek")
    const opencodeSnapshots = result.snapshots.filter((snapshot) => snapshot.provider === "ocg" || snapshot.provider.startsWith("ocg-"))
    const deepseek = deepseekSnapshot && isDeepseekUsage(deepseekSnapshot.usage)
      ? { available: deepseekSnapshot.available, balances: deepseekSnapshot.usage.balances }
      : null
    const opencodeGo = opencodeSnapshots.length > 0
      ? { accounts: opencodeSnapshots.flatMap((snapshot) => toOpencodeAccounts(snapshot)) }
      : null
    return {
      deepseek,
      opencodeGo,
    }
  }, [])
}

function isDeepseekUsage(value: unknown): value is { balances: DeepseekBalance[] } {
  return !!value && typeof value === "object" && Array.isArray((value as { balances?: unknown }).balances)
}

function toOpencodeAccounts(snapshot: { accountId: string | null; available: boolean; usage: unknown }): OpencodeGoAccountUsage[] {
  const usage = snapshot.usage as { windows?: OpencodeGoQuotaWindow[]; modelUsage?: OpencodeGoModelUsageEstimate[] }
  return [{
    account: snapshot.accountId ?? "default",
    displayName: snapshot.accountId ?? "OpenCode Go",
    default: snapshot.accountId === null,
    available: snapshot.available,
    windows: Array.isArray(usage.windows)
      ? usage.windows.map((window) => ({
        ...window,
        // 快照库保存官方接口的秒级时间；WebUI 展示统一使用毫秒 Unix 时间戳。
        resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
      }))
      : [],
    modelUsage: Array.isArray(usage.modelUsage) ? usage.modelUsage : [],
  }]
}
