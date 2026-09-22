import { useCallback, useEffect, useRef, useState } from "react"

import { useApi } from "@/hooks/use-api"
import {
  fetchManagementProviders,
  fetchOfficialAccountSnapshots,
  refreshOfficialAccountSnapshot,
} from "@/lib/api"
import {
  accountRefreshErrors, accountSnapshotsWithMissingProviders, accountSnapshotsAfterRefresh,
  accountSnapshotsWithoutRemoved, ccgAccountFromSnapshot, deepseekAccountFromSnapshot,
  opencodeAccountFromSnapshot, refreshableAccounts,
  type RefreshableAccount, type AccountRefreshError, type AccountRefreshControl,
} from "@/lib/account-refresh-state"

export function useOfficialAccountSources() {
  const snapshots = useApi(fetchOfficialAccountSnapshots, [])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const [providers, setProviders] = useState<RefreshableAccount[]>([])
  const [providerErrors, setProviderErrors] = useState<Record<string, AccountRefreshError | null>>({})
  const [refreshingProviders, setRefreshingProviders] = useState<string[]>([])
  const [removedAccountIds, setRemovedAccountIds] = useState<string[]>([])
  const [removalNotice, setRemovalNotice] = useState<string | null>(null)
  const initialRefreshStarted = useRef(false)
  const refreshOperation = useRef<Promise<void> | null>(null)
  const refreshController = useRef<AbortController | null>(null)
  const replaceData = snapshots.replaceData
  const refresh = useCallback((provider?: string, snapshotsOnly = false) => {
    if (refreshOperation.current !== null) return refreshOperation.current
    initialRefreshStarted.current = true
    const controller = new AbortController()
    refreshController.current = controller
    const operation = (async () => {
      setRefreshing(true)
      setRefreshError(null)
      try {
        const accounts = refreshableAccounts(await fetchManagementProviders(controller.signal))
        if (controller.signal.aborted) return
        setProviders(accounts)
        const refreshableProviders = (snapshotsOnly ? [] : accounts)
          .filter((account) => provider === undefined || account.id === provider)
          .map((account) => account.id)
        if (provider !== undefined && refreshableProviders.length === 0) {
          throw new Error("账户来源不存在或不支持刷新")
        }
        setRefreshingProviders(refreshableProviders)
        const results = await Promise.allSettled(
          refreshableProviders.map((provider) =>
            refreshOfficialAccountSnapshot(provider, controller.signal)),
        )
        if (controller.signal.aborted) return
        setProviderErrors((previous) => ({ ...previous, ...accountRefreshErrors(refreshableProviders, results) }))
        const refreshed = accountSnapshotsAfterRefresh(snapshots.data, refreshableProviders, results)
        if (refreshed !== null) replaceData(refreshed)
        const result = await fetchOfficialAccountSnapshots(controller.signal)
        if (controller.signal.aborted) return
        replaceData(result)
        setRemovedAccountIds((removed) => removed.filter((id) => result.snapshots.some((snapshot) => snapshot.accountId === id)))
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error)
          setRefreshError(snapshotsOnly ? `账户已删除，列表同步失败：${message}` : message)
        }
      } finally {
        if (refreshController.current === controller) {
          refreshController.current = null
          refreshOperation.current = null
          setRefreshing(false)
          setRefreshingProviders([])
        }
      }
    })()
    refreshOperation.current = operation
    return operation
  }, [replaceData, snapshots.data])

  const accountRemoved = useCallback((accountId: string, activation?: string) => {
    refreshController.current?.abort()
    refreshOperation.current = null
    setRemovedAccountIds((previous) => [...previous, accountId])
    setProviderErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([provider]) => provider !== `ocg-${accountId}`)))
    setRemovalNotice(`本地账户 ${accountId} 已删除。${activation === "restart-all" ? "请运行 codexc service restart all，使运行中的服务应用配置。" : ""}此操作不会取消官方订阅。`)
    void refresh(undefined, true)
  }, [refresh])

  useEffect(() => {
    if (snapshots.data === null || initialRefreshStarted.current) return
    initialRefreshStarted.current = true
    void refresh()
  }, [refresh, snapshots.data])

  useEffect(() => () => refreshController.current?.abort(), [])

  const refreshControls: Record<string, AccountRefreshControl> = Object.fromEntries(providers.map((provider) => [provider.id, {
    refreshing: refreshingProviders.includes(provider.id),
    disabled: refreshing,
    error: providerErrors[provider.id] ?? null,
    onRefresh: () => { void refresh(provider.id) },
  }]))
  return {
    ...snapshots,
    data: snapshots.data === null ? null
      : accountSources(accountSnapshotsWithoutRemoved(accountSnapshotsWithMissingProviders(snapshots.data, providers), removedAccountIds)),
    refreshing, refreshError, refresh, refreshControls, accountRemoved, removalNotice,
  }
}

function accountSources(result: Awaited<ReturnType<typeof fetchOfficialAccountSnapshots>>) {
  const deepseekSnapshots = result.snapshots.filter((snapshot) =>
    snapshot.provider === "deepseek" || snapshot.provider.startsWith("ds-"))
  const opencodeSnapshots = result.snapshots.filter((snapshot) => snapshot.provider === "ocg" || snapshot.provider.startsWith("ocg-"))
  const ccgSnapshots = result.snapshots.filter((snapshot) =>
    snapshot.provider === "ccg" || snapshot.provider.startsWith("ccg-"))
  const deepseek = deepseekSnapshots.length > 0
    ? { accounts: deepseekSnapshots.map(deepseekAccountFromSnapshot) }
    : null
  const opencodeGo = opencodeSnapshots.length > 0
    ? { accounts: opencodeSnapshots.map(opencodeAccountFromSnapshot) }
    : null
  const ccg = ccgSnapshots.length > 0
    ? { accounts: ccgSnapshots.map(ccgAccountFromSnapshot) }
    : null
  return {
    deepseek,
    opencodeGo,
    ccg,
    warning: result.warnings.length === 0
      ? null
      : result.warnings.map((warning) => warning.message).join("；"),
  }
}
