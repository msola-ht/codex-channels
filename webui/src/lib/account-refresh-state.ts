import type {
  CcgCreditAccountUsage, DeepseekAccountBalance, DeepseekBalance,
  OfficialAccountSourcesResponse, OfficialAccountSnapshot, OfficialAccountSnapshotsResponse,
  QuotaAccountUsage, OpencodeGoQuotaWindow, OpenAiAccountCredits,
} from "./types"

const ACCOUNT_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000

export interface RefreshableAccount { id: string; displayName: string }

export interface AccountRefreshError {
  kind: "refresh-failed"
  message: string
}

/** Owned by the authenticated layout; survives route changes, never persisted. */
export type AccountRefreshAttempts = Map<string, { retryAt: number; observedAtMs: number | null; error: AccountRefreshError | null }>

/** Only a strictly newer successful observation supersedes a failed refresh. */
export function clearRecoveredAccountFailures(attempts: AccountRefreshAttempts, snapshots: OfficialAccountSnapshotsResponse | null): string[] {
  const recovered: string[] = []
  for (const [id, attempt] of attempts) {
    const snapshot = snapshots?.snapshots.find(item => item.provider === id)
    if (attempt.error !== null && attempt.observedAtMs !== null && snapshot
      && snapshot.observedAtMs > Math.max(0, attempt.observedAtMs)) {
      attempts.delete(id)
      recovered.push(id)
    }
  }
  return recovered
}

export function automaticAccountProviders(accounts: readonly RefreshableAccount[], snapshots: OfficialAccountSnapshotsResponse | null,
  attempts: AccountRefreshAttempts, serverNow: number, monotonicNow: number): string[] {
  clearRecoveredAccountFailures(attempts, snapshots)
  const active = new Set(accounts.map(account => account.id))
  for (const id of attempts.keys()) if (!active.has(id)) attempts.delete(id)
  return accounts.filter(({ id }) => {
    if ((attempts.get(id)?.retryAt ?? 0) > monotonicNow) return false
    const attempt = attempts.get(id)
    if (attempt?.error && attempt.observedAtMs === null) return true
    const snapshot = snapshots?.snapshots.find(item => item.provider === id)
    return !snapshot || snapshot.observedAtMs <= 0 || accountSnapshotIsStale(snapshot.observedAtMs, serverNow)
  }).map(account => account.id)
}

export function beginAccountRefreshAttempt(attempts: AccountRefreshAttempts, provider: string, now: number, observedAtMs: number | null = null) {
  // Bound transient metadata even if account registries repeatedly change.
  if (!attempts.has(provider) && attempts.size >= 256) attempts.delete(attempts.keys().next().value!)
  attempts.set(provider, { retryAt: now + 60_000, observedAtMs, error: attempts.get(provider)?.error ?? null })
}

export interface AccountRefreshControl {
  refreshing: boolean
  disabled: boolean
  error: AccountRefreshError | null
  onRefresh: () => void
}

/** 账户区刷新/同步失败只保存结构化标识与错误码，界面文案在渲染时按当前语言翻译。 */
export type AccountRefreshFailure =
  | { kind: "listFailed"; code: string | null }
  | { kind: "syncFailed"; code: string | null }

/** 删除成功提示只保存账户标识与是否需重启服务，文案在渲染时翻译。 */
export interface AccountRemovalNotice {
  accountId: string
  restartRequired: boolean
}

export function accountSnapshotIsStale(observedAtMs: number, now: number): boolean {
  return observedAtMs > 0 && now - observedAtMs > ACCOUNT_SNAPSHOT_MAX_AGE_MS
}

export function scheduleAccountSnapshotExpiry(
  observedAtMs: number,
  update: (nowMs: number) => void,
  page: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
  now: () => number,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = () => {
    clearTimeout(timer)
    timer = undefined
    if (page.visibilityState !== "visible") return
    const nowMs = now()
    update(nowMs)
    if (observedAtMs > 0 && !accountSnapshotIsStale(observedAtMs, nowMs)) {
      const remaining = observedAtMs + ACCOUNT_SNAPSHOT_MAX_AGE_MS + 1 - nowMs
      timer = setTimeout(check, Math.min(2_147_483_647, Math.max(1, remaining)))
    }
  }
  page.addEventListener("visibilitychange", check)
  check()
  return () => {
    clearTimeout(timer)
    page.removeEventListener("visibilitychange", check)
  }
}

export function refreshableAccounts(result: OfficialAccountSourcesResponse): RefreshableAccount[] {
  return result.accounts.map(account => ({ id: account.provider, displayName: account.displayName }))
}

/** 整表读取负责账户增删与元数据；迟到的旧观测不能覆盖当前较新观测。 */
export function mergeAccountSnapshotLists(previous: OfficialAccountSnapshotsResponse | null, next: OfficialAccountSnapshotsResponse): OfficialAccountSnapshotsResponse {
  const current = new Map(previous?.snapshots.map(snapshot => [snapshot.provider, snapshot]))
  const snapshots = next.snapshots.map(snapshot => {
    const old = current.get(snapshot.provider)
    return old && old.observedAtMs > snapshot.observedAtMs
      ? { ...old, displayName: snapshot.displayName, default: snapshot.default }
      : snapshot
  })
  return { ...next, snapshots, observedAtMs: Math.max(0, ...snapshots.map(snapshot => snapshot.observedAtMs)) }
}

/** 限制同时出站的查询，并在每个账户完成时立即交付结果。 */
export async function refreshAccountSnapshots(
  providers: readonly string[],
  query: (provider: string, signal: AbortSignal) => Promise<OfficialAccountSnapshotsResponse>,
  receive: (provider: string, result: PromiseSettledResult<OfficialAccountSnapshotsResponse>) => void,
  signal: AbortSignal,
): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(4, providers.length) }, async () => {
    while (!signal.aborted && next < providers.length) {
      const provider = providers[next++]!
      let result: PromiseSettledResult<OfficialAccountSnapshotsResponse>
      try {
        result = { status: "fulfilled", value: await query(provider, signal) }
      } catch (reason) {
        result = { status: "rejected", reason }
      }
      if (!signal.aborted) receive(provider, result)
    }
  }))
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
    const current = snapshot ? snapshots.get(snapshot.provider) : undefined
    if (snapshot && (!current || current.observedAtMs <= snapshot.observedAtMs)) snapshots.set(snapshot.provider, snapshot)
  }
  return { ...base, observedAtMs: Math.max(0, ...[...snapshots.values()].map(snapshot => snapshot.observedAtMs)), snapshots: [...snapshots.values()] }
}

export function accountSnapshotsWithoutRemoved(
  result: OfficialAccountSnapshotsResponse,
  removedProviders: readonly string[],
): OfficialAccountSnapshotsResponse {
  return { ...result, snapshots: result.snapshots.filter((snapshot) =>
    !removedProviders.includes(snapshot.provider)) }
}

export function remainingRemovedAccountProviders(
  result: OfficialAccountSnapshotsResponse,
  providers: readonly RefreshableAccount[],
  removedProviders: readonly string[],
): string[] {
  return removedProviders.filter((provider) => providers.some((account) => account.id === provider)
    || result.snapshots.some((snapshot) => snapshot.provider === provider))
}

export function quotaAccountFromSnapshot(
  snapshot: OfficialAccountSnapshotsResponse["snapshots"][number],
): QuotaAccountUsage {
  const usage = snapshot.usage as { kind?: string; windows?: OpencodeGoQuotaWindow[] } | null
  return {
    subscriptionRequired: usage?.kind === "subscription-required",
    provider: snapshot.provider,
    account: snapshot.accountId,
    displayName: snapshot.displayName,
    default: snapshot.default,
    observedAtMs: snapshot.observedAtMs,
    available: snapshot.available,
    windows: quotaWindowsFromSnapshot(usage?.windows),
  }
}

export function deepseekAccountFromSnapshot(
  snapshot: OfficialAccountSnapshot,
): DeepseekAccountBalance {
  const usage = snapshot.usage as { kind?: string; balances?: DeepseekBalance[] } | null
  return {
    provider: snapshot.provider,
    account: snapshot.accountId,
    displayName: snapshot.displayName,
    default: snapshot.default,
    observedAtMs: snapshot.observedAtMs,
    available: snapshot.available,
    balances: usage?.kind === "balance" && Array.isArray(usage.balances) ? usage.balances : [],
  }
}

export function ccgAccountFromSnapshot(
  snapshot: OfficialAccountSnapshot,
): CcgCreditAccountUsage {
  const usage = snapshot.usage as {
    kind?: string
    planId?: string | null
    monthlyRemaining?: string
    purchasedRemaining?: string
    freeRemaining?: string
    totalRemaining?: string
    windows?: OpencodeGoQuotaWindow[]
  } | null
  const credits = usage?.kind === "credit-usage" ? usage : null
  return {
    provider: snapshot.provider,
    account: snapshot.accountId,
    displayName: snapshot.displayName,
    default: snapshot.default,
    observedAtMs: snapshot.observedAtMs,
    available: snapshot.available,
    planId: credits?.planId ?? null,
    monthlyRemaining: credits?.monthlyRemaining ?? "0.00",
    purchasedRemaining: credits?.purchasedRemaining ?? "0.00",
    freeRemaining: credits?.freeRemaining ?? "0.00",
    totalRemaining: credits?.totalRemaining ?? "0.00",
    windows: quotaWindowsFromSnapshot(credits?.windows),
  }
}

function quotaWindowsFromSnapshot(value: OpencodeGoQuotaWindow[] | undefined): OpencodeGoQuotaWindow[] {
  return Array.isArray(value)
    ? value.map((window) => ({
        ...window,
        // 快照库保存官方接口的秒级时间；WebUI 展示统一使用毫秒 Unix 时间戳。
        resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
      }))
    : []
}


/** OpenAI 余额与重置券均来自账户快照，不从周额度或请求消耗推算。 */
export function openAiCreditsFromSnapshot(snapshot: OfficialAccountSnapshot | undefined): OpenAiAccountCredits | null {
  if (!snapshot || snapshot.provider !== "openai") return null
  const value = snapshot.limits as { kind?: string; provider?: string; limits?: {
    ordinaryUsageLimit?: { credits?: { balance?: string | null; unlimited?: boolean } | null }
    resetCreditsAvailable?: number | string | null
    resetCreditExpiresAt?: Array<number | null> | null
  } } | null
  if (value?.kind !== "rate-limits" || value.provider !== "openai" || !value.limits) return null
  const limits = value.limits
  const credits = limits.ordinaryUsageLimit?.credits
  const count = limits.resetCreditsAvailable
  const available = typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? String(count)
    : typeof count === "string" && /^[0-9]{1,128}$/u.test(count) ? count : null
  const dates = limits.resetCreditExpiresAt
  const groups = new Map<number | null, number>()
  const hasDates = Array.isArray(dates) && dates.every(date => date === null
    || (typeof date === "number" && Number.isFinite(date) && date >= 0 && date <= 8_640_000_000_000))
  if (hasDates) for (const date of dates) groups.set(date, (groups.get(date) ?? 0) + 1)
  const undisclosed = available === null ? null : BigInt(available) - BigInt(hasDates ? dates.length : 0)
  return {
    observedAtMs: snapshot.observedAtMs,
    remaining: typeof credits?.balance === "string" ? credits.balance : null,
    unlimited: credits?.unlimited === true,
    resetCreditsAvailable: available,
    expirations: hasDates ? [...groups].sort(([left], [right]) => left === null ? 1 : right === null ? -1 : left - right)
      .map(([expiresAt, count]) => ({ expiresAt, count })) : null,
    undisclosedCount: undisclosed !== null && undisclosed > 0n ? undisclosed.toString() : null,
  }
}

/** 当前周额度来自官方普通用量桶；历史请求里的窗口只用于统计估算。 */
export function openAiWeeklyQuotaFromSnapshot(snapshot: OfficialAccountSnapshot | undefined) {
  if (!snapshot || snapshot.provider !== "openai") return null
  const value = snapshot.limits as { kind?: string; provider?: string; limits?: {
    ordinaryUsageLimit?: { planType?: string | null; primary?: SnapshotQuotaWindow | null; secondary?: SnapshotQuotaWindow | null } | null
  } } | null
  if (value?.kind !== "rate-limits" || value.provider !== "openai") return null
  const limit = value.limits?.ordinaryUsageLimit
  if (!limit) return null
  const window = [limit.primary, limit.secondary].find(window => window?.windowDurationMins === 10_080)
  return {
    usedPercent: typeof window?.usedPercent === "number" && Number.isFinite(window.usedPercent) && window.usedPercent >= 0
      ? window.usedPercent : null,
    resetsAt: typeof window?.resetsAt === "number" && Number.isSafeInteger(window.resetsAt)
      && window.resetsAt >= 0 && window.resetsAt <= 8_640_000_000_000 ? window.resetsAt * 1000 : null,
    planType: typeof limit.planType === "string" ? limit.planType : null,
  }
}

type SnapshotQuotaWindow = { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null }
