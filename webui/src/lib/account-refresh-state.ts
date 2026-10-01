import type {
  CcgCreditAccountUsage, DeepseekAccountBalance, DeepseekBalance,
  ManagementProvidersResponse, OfficialAccountSnapshot, OfficialAccountSnapshotsResponse,
  QuotaAccountUsage, OpencodeGoQuotaWindow, OpenAiAccountCredits,
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

/** 账户区刷新/同步失败只保存结构化标识与错误码，界面文案在渲染时按当前语言翻译。 */
export type AccountRefreshFailure =
  | { kind: "listFailed"; code: string | null }
  | { kind: "syncFailed"; code: string | null }
  | { kind: "sourceMissing" }

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

export function refreshableAccounts(result: ManagementProvidersResponse): RefreshableAccount[] {
  return result.providers.filter((provider) => provider.kind === "managed" && (
    provider.id.startsWith("clp-") || provider.id === "deepseek" || provider.id.startsWith("ds-")
      || provider.id === "ocg" || provider.id.startsWith("ocg-")
      || provider.id === "ccg" || provider.id.startsWith("ccg-")
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
