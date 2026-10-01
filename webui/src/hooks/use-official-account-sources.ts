import { useCallback, useEffect, useRef, useState } from "react"

import { ApiClientError } from "@/lib/api"
import { useApi } from "@/hooks/use-api"
import {
  fetchManagementProviders,
  fetchOfficialAccountSnapshots,
  refreshOfficialAccountSnapshot,
} from "@/lib/api"
import {
  accountRefreshErrors, accountSnapshotsWithMissingProviders, accountSnapshotsAfterRefresh,
  accountSnapshotsWithoutRemoved, ccgAccountFromSnapshot, deepseekAccountFromSnapshot,
  quotaAccountFromSnapshot, openAiCreditsFromSnapshot, openAiWeeklyQuotaFromSnapshot, refreshableAccounts, remainingRemovedAccountProviders,
  type RefreshableAccount, type AccountRefreshError, type AccountRefreshControl,
  type AccountRefreshFailure, type AccountRemovalNotice,
} from "@/lib/account-refresh-state"

class MissingAccountSourceError extends Error {}

export function useOfficialAccountSources() {
  const snapshots = useApi(fetchOfficialAccountSnapshots, [])
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState<AccountRefreshFailure | null>(null)
  const [providers, setProviders] = useState<RefreshableAccount[]>([])
  const [providerErrors, setProviderErrors] = useState<Record<string, AccountRefreshError | null>>({})
  const [refreshingProviders, setRefreshingProviders] = useState<string[]>([])
  const [removedProviders, setRemovedProviders] = useState<string[]>([])
  const [removalNotice, setRemovalNotice] = useState<AccountRemovalNotice | null>(null)
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
          throw new MissingAccountSourceError("account source missing or not refreshable")
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
        setRemovedProviders((removed) => remainingRemovedAccountProviders(result, accounts, removed))
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof MissingAccountSourceError) {
            setRefreshError({ kind: "sourceMissing" })
          } else {
            const code = error instanceof ApiClientError ? error.code : null
            setRefreshError({ kind: snapshotsOnly ? "syncFailed" : "listFailed", code })
          }
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
    const removedProvider = `ocg-${accountId}`
    refreshController.current?.abort()
    refreshOperation.current = null
    setRemovedProviders((previous) => [...previous, removedProvider])
    setProviders((previous) => previous.filter((provider) => provider.id !== removedProvider))
    setProviderErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([provider]) => provider !== removedProvider)))
    setRemovalNotice({ accountId, restartRequired: activation === "restart-all" })
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
      : accountSources(accountSnapshotsWithoutRemoved(accountSnapshotsWithMissingProviders(snapshots.data, providers), removedProviders)),
    refreshing, refreshError, refresh, refreshControls, accountRemoved, removalNotice,
    refetchSnapshots: snapshots.refetch,
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
    ? { accounts: opencodeSnapshots.map(quotaAccountFromSnapshot) }
    : null
  const ccg = ccgSnapshots.length > 0
    ? { accounts: ccgSnapshots.map(ccgAccountFromSnapshot) }
    : null
  const clinePass = result.snapshots.filter((snapshot) => snapshot.provider.startsWith("clp-"))
  return {
    openaiWeeklyQuota: openAiWeeklyQuotaFromSnapshot(result.snapshots.find(snapshot => snapshot.provider === "openai")),
    openai: openAiCreditsFromSnapshot(result.snapshots.find(snapshot => snapshot.provider === "openai")),
    deepseek,
    opencodeGo,
    ccg,
    clinePass: clinePass.map(quotaAccountFromSnapshot),
    warnings: result.warnings,
  }
}
