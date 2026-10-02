import { useCallback, useEffect, useRef, useState } from "react"

import { useServerTimeSnapshot } from "@/hooks/use-server-time"
import { estimateServerTime } from "@/lib/server-time"
import type { OfficialAccountSnapshotsResponse } from "@/lib/types"

import { ApiClientError } from "@/lib/api"
import { useApi } from "@/hooks/use-api"
import { scheduleVisibleSettingsRefresh } from "@/lib/api-polling"
import {
  fetchOfficialAccountSources,
  fetchOfficialAccountSnapshots,
  refreshOfficialAccountSnapshot,
} from "@/lib/api"
import {
  automaticAccountProviders, beginAccountRefreshAttempt, clearRecoveredAccountFailures, type AccountRefreshAttempts,
  accountRefreshErrors, accountSnapshotsWithMissingProviders, accountSnapshotsAfterRefresh, mergeAccountSnapshotLists,
  accountSnapshotsWithoutRemoved, ccgAccountFromSnapshot, deepseekAccountFromSnapshot,
  quotaAccountFromSnapshot, openAiCreditsFromSnapshot, openAiWeeklyQuotaFromSnapshot, refreshableAccounts, remainingRemovedAccountProviders, refreshAccountSnapshots,
  type RefreshableAccount, type AccountRefreshError, type AccountRefreshControl,
  type AccountRefreshFailure, type AccountRemovalNotice,
} from "@/lib/account-refresh-state"

export function useOfficialAccountSources(attempts: AccountRefreshAttempts) {
  const clock = useServerTimeSnapshot()
  const snapshots = useApi(fetchOfficialAccountSnapshots, [], { mergeData: mergeAccountSnapshotLists })
  const [sourceWarnings, setSourceWarnings] = useState<Awaited<ReturnType<typeof fetchOfficialAccountSources>>["warnings"]>([])
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
  const visibilityRefresh = useRef({ pending: false, lastRefresh: 0 })
  const replaceData = snapshots.replaceData
  const refetch = snapshots.refetch
  const refetchSnapshots = useCallback(() => {
    // 独立同步接管本页刷新，取消来源、预读、排队查询及收尾，避免迟到结果抢回所有权。
    refreshController.current?.abort()
    refetch()
  }, [refetch])
  const refresh = useCallback((provider?: string, snapshotsOnly = false, automatic = false, baseline?: OfficialAccountSnapshotsResponse | null) => {
    if (automatic && document.visibilityState !== "visible") return Promise.resolve()
    if (refreshOperation.current !== null) return refreshOperation.current
    initialRefreshStarted.current = true
    if (provider === undefined && !snapshotsOnly) visibilityRefresh.current.pending = false
    visibilityRefresh.current.lastRefresh = Date.now()
    const controller = new AbortController()
    refreshController.current = controller
    const pause = () => { if (document.visibilityState !== "visible") controller.abort() }
    if (automatic) document.addEventListener("visibilitychange", pause)
    const operation = (async () => {
      setRefreshing(true)
      setRefreshError(null)
      try {
        let accounts = providers
        if (provider === undefined) {
          const sources = await fetchOfficialAccountSources(controller.signal)
          if (controller.signal.aborted) return
          accounts = refreshableAccounts(sources)
          setProviders(accounts)
          setSourceWarnings(sources.warnings)
        }
        let current = baseline ?? null
        if (automatic && baseline === undefined) {
          try {
            current = await fetchOfficialAccountSnapshots(controller.signal)
            if (controller.signal.aborted) return
            replaceData(current)
          } catch (error) { if (controller.signal.aborted) throw error }
        }
        if (controller.signal.aborted) return
        const refreshableProviders = snapshotsOnly ? [] : automatic
          ? automaticAccountProviders(accounts, current, attempts, estimateServerTime(clock), performance.now())
          : provider === undefined ? accounts.map(account => account.id) : [provider]
        if (automatic) setProviderErrors(previous => ({ ...previous, ...Object.fromEntries(accounts.map(account => [account.id, attempts.get(account.id)?.error ?? null])) }))
        setRefreshingProviders(refreshableProviders)
        await refreshAccountSnapshots(refreshableProviders, (id, signal) => {
          signal.throwIfAborted()
          const known = current ?? snapshots.data
          beginAccountRefreshAttempt(attempts, id, performance.now(), known === null ? null
            : known.snapshots.find(snapshot => snapshot.provider === id)?.observedAtMs ?? 0)
          return refreshOfficialAccountSnapshot(id, signal)
        }, (id, result) => {
          if (result.status === "fulfilled" && !result.value.snapshots.some(snapshot => snapshot.provider === id && snapshot.observedAtMs > 0)) {
            result = { status: "rejected", reason: new ApiClientError("账户来源不存在或尚未生成快照", 502, "provider_not_found") }
          }
          const errors = accountRefreshErrors([id], [result])
          if (result.status === "fulfilled") attempts.delete(id)
          else {
            beginAccountRefreshAttempt(attempts, id, performance.now(), attempts.get(id)?.observedAtMs ?? null)
            attempts.get(id)!.error = errors[id] ?? null
          }
          setProviderErrors((previous) => ({ ...previous, ...errors }))
          if (result.status === "fulfilled") replaceData(previous => accountSnapshotsAfterRefresh(previous, [id], [result]))
          setRefreshingProviders((previous) => previous.filter((candidate) => candidate !== id))
        }, controller.signal)
        if (controller.signal.aborted) return
        // No upstream work means the baseline already supplies the authoritative list.
        if (automatic && refreshableProviders.length === 0 && current !== null) {
          setRemovedProviders(removed => remainingRemovedAccountProviders(current, accounts, removed))
          return
        }
        const result = await fetchOfficialAccountSnapshots(controller.signal)
        if (controller.signal.aborted) return
        replaceData(result)
        setRemovedProviders((removed) => remainingRemovedAccountProviders(result, accounts, removed))
      } catch (error) {
        if (!controller.signal.aborted) {
          const code = error instanceof ApiClientError ? error.code : null
          setRefreshError({ kind: snapshotsOnly ? "syncFailed" : "listFailed", code })
        }
      } finally {
        if (automatic) document.removeEventListener("visibilitychange", pause)
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
  }, [replaceData, providers, attempts, clock, snapshots.data])

  useEffect(() => {
    const recovered = clearRecoveredAccountFailures(attempts, snapshots.data)
    if (recovered.length > 0) setProviderErrors(previous => ({ ...previous,
      ...Object.fromEntries(recovered.map(id => [id, null])),
    }))
  }, [attempts, snapshots.data, providerErrors])

  const accountRemoved = useCallback((accountId: string, activation?: string) => {
    const removedProvider = `ocg-${accountId}`
    attempts.delete(removedProvider)
    refreshController.current?.abort()
    refreshOperation.current = null
    setRemovedProviders((previous) => [...previous, removedProvider])
    setProviders((previous) => previous.filter((provider) => provider.id !== removedProvider))
    setProviderErrors((previous) => Object.fromEntries(Object.entries(previous).filter(([provider]) => provider !== removedProvider)))
    setRemovalNotice({ accountId, restartRequired: activation === "restart-all" })
    void refresh(undefined, true)
  }, [refresh, attempts])

  useEffect(() => {
    if (initialRefreshStarted.current || snapshots.loading) return
    initialRefreshStarted.current = true
    void refresh(undefined, false, true, snapshots.data)
  }, [refresh, snapshots.loading, snapshots.data])

  useEffect(() => scheduleVisibleSettingsRefresh(() => { void refresh(undefined, false, true) }, refreshing, document, visibilityRefresh.current), [refresh, refreshing])

  useEffect(() => () => {
    refreshController.current?.abort()
    refreshController.current = null
    refreshOperation.current = null
    initialRefreshStarted.current = false
  }, [])

  const refreshControls: Record<string, AccountRefreshControl> = Object.fromEntries(providers.map((provider) => [provider.id, {
    refreshing: refreshingProviders.includes(provider.id),
    disabled: refreshing,
    error: providerErrors[provider.id] ?? null,
    onRefresh: () => { void refresh(provider.id) },
  }]))
  // 已确认的账户来源足以展示逐账户失败，不要求指标库已有成功快照。
  const accountSnapshotData = snapshots.data ?? (providers.length > 0 || sourceWarnings.length > 0
    ? { observedAtMs: 0, snapshots: [], warnings: [] }
    : null)
  return {
    ...snapshots,
    data: accountSnapshotData === null ? null
      : accountSources(accountSnapshotsWithoutRemoved(accountSnapshotsWithMissingProviders({ ...accountSnapshotData,
        warnings: [...new Map([...accountSnapshotData.warnings, ...sourceWarnings].map(warning => [warning.source, warning])).values()],
      }, providers), removedProviders)),
    refreshing, refreshError, refresh, refreshControls, accountRemoved, removalNotice,
    refetchSnapshots,
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
