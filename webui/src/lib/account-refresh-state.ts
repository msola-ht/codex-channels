import type {
  ManagementProvidersResponse, OfficialAccountSnapshotsResponse,
  OpencodeGoAccountUsage, OpencodeGoQuotaWindow,
} from "./types"

const ACCOUNT_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000

export type RefreshableAccount = Pick<ManagementProvidersResponse["providers"][number], "id" | "displayName">

export interface AccountRefreshError {
  kind: "refresh-failed"
  message: string
}

export interface AccountRefreshControl {
  refreshing: boolean
  disabled: boolean
  error: AccountRefreshError | null
  onRefresh: () => void
}

export function accountSnapshotIsStale(observedAtMs: number, now = Date.now()): boolean {
  return observedAtMs > 0 && now - observedAtMs > ACCOUNT_SNAPSHOT_MAX_AGE_MS
}

export function refreshableAccounts(result: ManagementProvidersResponse): RefreshableAccount[] {
  return result.providers.filter((provider) => provider.kind === "managed" && (
    provider.id === "deepseek" || provider.id === "ocg" || provider.id.startsWith("ocg-")
  ))
}

export function accountRefreshErrors(
  providers: readonly string[],
  results: readonly PromiseSettledResult<unknown>[],
): Record<string, AccountRefreshError | null> {
  return Object.fromEntries(providers.map((provider, index) => {
    const result = results[index]
    if (!result) throw new Error("账户刷新结果缺失")
    if (result.status === "fulfilled") return [provider, null]
    const reason: unknown = result.reason
    return [provider, {
      kind: "refresh-failed",
      message: reason instanceof Error ? reason.message : String(reason),
    }]
  }))
}

export function accountSnapshotsWithMissingProviders(
  result: OfficialAccountSnapshotsResponse,
  providers: readonly RefreshableAccount[],
): OfficialAccountSnapshotsResponse {
  return {
    ...result,
    snapshots: [...result.snapshots, ...providers
      .filter((provider) => !result.snapshots.some((snapshot) => snapshot.provider === provider.id))
      .map((provider) => ({
        provider: provider.id, displayName: provider.displayName, accountId: null,
        default: false, observedAtMs: 0, available: false, usage: null, limits: null,
      }))],
  }
}

export function accountSnapshotsAfterRefresh(
  previous: OfficialAccountSnapshotsResponse,
  providers: readonly string[],
  results: readonly PromiseSettledResult<OfficialAccountSnapshotsResponse>[],
): OfficialAccountSnapshotsResponse
export function accountSnapshotsAfterRefresh(
  previous: OfficialAccountSnapshotsResponse | null,
  providers: readonly string[],
  results: readonly PromiseSettledResult<OfficialAccountSnapshotsResponse>[],
): OfficialAccountSnapshotsResponse | null
export function accountSnapshotsAfterRefresh(
  previous: OfficialAccountSnapshotsResponse | null,
  providers: readonly string[],
  results: readonly PromiseSettledResult<OfficialAccountSnapshotsResponse>[],
): OfficialAccountSnapshotsResponse | null {
  const firstSuccess = results.find((result) => result.status === "fulfilled")
  const base = previous ?? firstSuccess?.value
  if (!base) return null
  const snapshots = new Map(base.snapshots.map((snapshot) => [snapshot.provider, snapshot]))
  for (const [index, result] of results.entries()) {
    if (result.status !== "fulfilled") continue
    const snapshot = result.value.snapshots.find((item) => item.provider === providers[index])
    if (snapshot) snapshots.set(snapshot.provider, snapshot)
  }
  return { ...base, snapshots: [...snapshots.values()] }
}

export function accountSnapshotsWithoutRemoved(
  result: OfficialAccountSnapshotsResponse,
  removedAccountIds: readonly string[],
): OfficialAccountSnapshotsResponse {
  return { ...result, snapshots: result.snapshots.filter((snapshot) =>
    !removedAccountIds.includes(snapshot.accountId ?? "")
      && !removedAccountIds.some((id) => snapshot.provider === `ocg-${id}`)) }
}

export function opencodeAccountFromSnapshot(
  snapshot: OfficialAccountSnapshotsResponse["snapshots"][number],
): OpencodeGoAccountUsage {
  const usage = snapshot.usage as { kind?: string; windows?: OpencodeGoQuotaWindow[] } | null
  return {
    subscriptionRequired: usage?.kind === "subscription-required",
    provider: snapshot.provider,
    account: snapshot.accountId,
    displayName: snapshot.displayName,
    default: snapshot.default,
    observedAtMs: snapshot.observedAtMs,
    available: snapshot.available,
    windows: Array.isArray(usage?.windows)
      ? usage.windows.map((window) => ({
        ...window,
        // 快照库保存官方接口的秒级时间；WebUI 展示统一使用毫秒 Unix 时间戳。
        resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
      }))
      : [],
  }
}
