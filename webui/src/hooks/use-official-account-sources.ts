import { useCallback, useEffect, useRef, useState } from "react"

import { useApi } from "@/hooks/use-api"
import {
  fetchManagementProviders,
  fetchOfficialAccountSnapshots,
  refreshOfficialAccountSnapshot,
} from "@/lib/api"
import type { DeepseekBalance, OpencodeGoAccountUsage, OpencodeGoQuotaWindow } from "@/lib/types"

const ACCOUNT_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000

export type AccountSnapshotFreshness = "fresh" | "stale" | "missing"

export function useOfficialAccountSources() {
  const snapshots = useApi(async (signal) => {
    const result = await fetchOfficialAccountSnapshots(signal)
    return accountSources(result)
  }, [])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const initialRefreshStarted = useRef(false)
  const refreshOperation = useRef<Promise<void> | null>(null)
  const refreshController = useRef<AbortController | null>(null)
  const replaceData = snapshots.replaceData
  const refresh = useCallback(() => {
    if (refreshOperation.current !== null) return refreshOperation.current
    const controller = new AbortController()
    refreshController.current = controller
    const operation = (async () => {
      setRefreshing(true)
      setRefreshError(null)
      try {
        const providers = await fetchManagementProviders(controller.signal)
        const refreshableProviders = providers.providers
          .filter((provider) =>
            provider.kind === "managed" && isRefreshableAccountProvider(provider.id))
          .map((provider) => provider.id)
        const results = await Promise.allSettled(
          refreshableProviders.map((provider) =>
            refreshOfficialAccountSnapshot(provider, controller.signal)),
        )
        const result = await fetchOfficialAccountSnapshots(controller.signal)
        replaceData(accountSources(result))
        const failed = results.find((item) => item.status === "rejected")
        if (failed?.status === "rejected") {
          setRefreshError(failed.reason instanceof Error ? failed.reason.message : String(failed.reason))
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setRefreshError(error instanceof Error ? error.message : String(error))
        }
      } finally {
        if (refreshController.current === controller) {
          refreshController.current = null
          refreshOperation.current = null
          setRefreshing(false)
        }
      }
    })()
    refreshOperation.current = operation
    return operation
  }, [replaceData])

  useEffect(() => {
    if (snapshots.data === null || initialRefreshStarted.current) return
    initialRefreshStarted.current = true
    void refresh()
  }, [refresh, snapshots.data])

  useEffect(() => () => refreshController.current?.abort(), [])

  return { ...snapshots, refreshing, refreshError, refresh }
}

function isRefreshableAccountProvider(provider: string): boolean {
  return provider === "deepseek" || provider === "ocg" || provider.startsWith("ocg-")
}

function accountSources(result: Awaited<ReturnType<typeof fetchOfficialAccountSnapshots>>) {
  const deepseekSnapshot = result.snapshots.find((snapshot) => snapshot.provider === "deepseek")
  const opencodeSnapshots = result.snapshots.filter((snapshot) => snapshot.provider === "ocg" || snapshot.provider.startsWith("ocg-"))
  const deepseek = deepseekSnapshot && isDeepseekUsage(deepseekSnapshot.usage)
    ? {
        available: deepseekSnapshot.available,
        observedAtMs: deepseekSnapshot.observedAtMs,
        balances: deepseekSnapshot.usage.balances,
      }
    : null
  const opencodeGo = opencodeSnapshots.length > 0
    ? { accounts: opencodeSnapshots.flatMap((snapshot) => toOpencodeAccounts(snapshot)) }
    : null
  const now = Date.now()
  const freshness = (observedAtMs: number | null): AccountSnapshotFreshness =>
    observedAtMs === null || observedAtMs <= 0
      ? "missing"
      : now - observedAtMs > ACCOUNT_SNAPSHOT_MAX_AGE_MS
        ? "stale"
        : "fresh"
  const opencodeFreshness = opencodeSnapshots.map((snapshot) =>
    freshness(snapshot.observedAtMs))
  const opencodeGoFreshness: AccountSnapshotFreshness = opencodeFreshness.includes("missing")
    ? "missing"
    : opencodeFreshness.includes("stale")
      ? "stale"
      : opencodeFreshness.length === 0 ? "missing" : "fresh"
  return {
    deepseek,
    opencodeGo,
    freshness: {
      deepseek: freshness(deepseekSnapshot?.observedAtMs ?? null),
      opencodeGo: opencodeGoFreshness,
    },
    warning: result.warnings[0]?.message ?? null,
  }
}

function isDeepseekUsage(value: unknown): value is { balances: DeepseekBalance[] } {
  return !!value && typeof value === "object" && Array.isArray((value as { balances?: unknown }).balances)
}

function toOpencodeAccounts(snapshot: {
  provider: string
  accountId: string | null
  displayName: string
  default: boolean
  observedAtMs: number
  available: boolean
  usage: unknown
}): OpencodeGoAccountUsage[] {
  const usage = snapshot.usage as { windows?: OpencodeGoQuotaWindow[] }
  return [{
    provider: snapshot.provider,
    account: snapshot.accountId ?? "default",
    displayName: snapshot.displayName,
    default: snapshot.default,
    observedAtMs: snapshot.observedAtMs,
    available: snapshot.available,
    windows: Array.isArray(usage.windows)
      ? usage.windows.map((window) => ({
        ...window,
        // 快照库保存官方接口的秒级时间；WebUI 展示统一使用毫秒 Unix 时间戳。
        resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
      }))
      : [],
  }]
}
