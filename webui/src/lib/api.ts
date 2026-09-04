import type {
  DeepseekBalanceResponse,
  ErrorsResponse,
  GlobalDailyResponse,
  GlobalDevicesResponse,
  GlobalOverviewResponse,
  GlobalQuotaResponse,
  GlobalRequestsResponse,
  OpencodeGoUsageResponse,
  OfficialAccountSnapshotsResponse,
  OverviewResponse,
  RangeName,
  RequestSortDirection,
  RequestSortKey,
  RequestsResponse,
  SettingsResponse,
  SettingsSummaryResponse,
  ManagementSettingsResponse,
  ManagementServicesResponse,
  ManagementSettingInput,
  ManagementSettingMutationResponse,
  ThreadRunResponse,
  ThreadsResponse,
  ThreadTurnsResponse,
} from "@/lib/types"
import type { DisplayCurrency } from "@/lib/format"

export class ApiClientError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    message: string,
    status: number,
    code: string,
  ) {
    super(message)
    this.name = "ApiClientError"
    this.status = status
    this.code = code
  }
}

const TOKEN_KEY = "codex-webui:token"
export const API_PREFIX = "/api/v1"
let unauthorizedHandler: (() => void) | null = null

export function getToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
  } catch {
    // 存储不可用时仅本次会话内保留
  }
}

export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandler = handler
  return () => {
    if (unauthorizedHandler === handler) unauthorizedHandler = null
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const token = getToken()
  const timeoutSignal = AbortSignal.timeout(30_000)
  const effectiveSignal = signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal])
  const headers = new Headers(init.headers)
  headers.set("accept", "application/json")
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
  if (token !== null) headers.set("authorization", `Bearer ${token}`)
  const response = await fetch(path, {
    ...init,
    headers,
    signal: effectiveSignal,
  })
  if (response.status === 401) {
    unauthorizedHandler?.()
  }
  if (!response.ok) {
    let code = "http_error"
    let message = `请求失败：HTTP ${response.status}`
    try {
      const body = await response.json() as {
        error?: { code?: string; message?: string }
      }
      code = body.error?.code ?? code
      message = body.error?.message ?? message
    } catch {
      // 保留 HTTP 状态默认错误信息
    }
    throw new ApiClientError(message, response.status, code)
  }
  return await response.json() as T
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return requestJson<T>(path, {}, signal)
}

export function fetchManagementSettings(signal?: AbortSignal): Promise<ManagementSettingsResponse> {
  return getJson<ManagementSettingsResponse>(`${API_PREFIX}/management/settings`, signal)
}

export function previewManagementSetting(
  revision: string,
  setting: ManagementSettingInput,
  signal?: AbortSignal,
): Promise<ManagementSettingMutationResponse> {
  return requestJson<ManagementSettingMutationResponse>(`${API_PREFIX}/management/settings/preview`, {
    method: "POST", body: JSON.stringify({ revision, setting }),
  }, signal)
}

export function updateManagementSetting(
  revision: string,
  setting: ManagementSettingInput,
  signal?: AbortSignal,
): Promise<ManagementSettingMutationResponse> {
  return requestJson<ManagementSettingMutationResponse>(`${API_PREFIX}/management/settings`, {
    method: "PATCH", body: JSON.stringify({ revision, setting }),
  }, signal)
}

export function fetchOverview(
  range: RangeName,
  currency: DisplayCurrency | null,
  signal?: AbortSignal,
): Promise<OverviewResponse> {
  const currencyQuery = currency === null ? "" : `&currency=${currency}`
  return getJson<OverviewResponse>(
    `${API_PREFIX}/overview?range=${range}${currencyQuery}`,
    signal,
  )
}

export function fetchThreads(
  currency: DisplayCurrency | null,
  signal?: AbortSignal,
): Promise<ThreadsResponse> {
  const currencyQuery = currency === null ? "" : `?currency=${currency}`
  return getJson<ThreadsResponse>(
    `${API_PREFIX}/threads${currencyQuery}`,
    signal,
  )
}

export function fetchThreadRun(
  threadId: string,
  currency: DisplayCurrency | null,
  signal?: AbortSignal,
): Promise<ThreadRunResponse> {
  const currencyQuery = currency === null ? "" : `?currency=${currency}`
  return getJson<ThreadRunResponse>(
    `${API_PREFIX}/threads/${encodeURIComponent(threadId)}/run${currencyQuery}`,
    signal,
  )
}

export function fetchThreadTurns(
  threadId: string,
  currency: DisplayCurrency | null,
  signal?: AbortSignal,
): Promise<ThreadTurnsResponse> {
  const currencyQuery = currency === null ? "" : `?currency=${currency}`
  return getJson<ThreadTurnsResponse>(
    `${API_PREFIX}/threads/${encodeURIComponent(threadId)}/turns${currencyQuery}`,
    signal,
  )
}

export function fetchRequests(
  range: RangeName,
  offset: number,
  limit: number,
  sort: RequestSortKey,
  direction: RequestSortDirection,
  filter: string,
  currency: DisplayCurrency | null,
  signal?: AbortSignal,
): Promise<RequestsResponse> {
  const params = new URLSearchParams({
    range,
    offset: String(offset),
    limit: String(limit),
    sort,
    direction,
  })
  if (filter.trim() !== "") params.set("filter", filter.trim())
  if (currency !== null) params.set("currency", currency)
  return getJson<RequestsResponse>(`${API_PREFIX}/requests?${params.toString()}`, signal)
}

export function fetchErrors(
  range: RangeName,
  currency: DisplayCurrency | null,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<ErrorsResponse> {
  const params = new URLSearchParams({
    range,
    offset: String(offset),
    limit: String(limit),
  })
  if (currency !== null) params.set("currency", currency)
  return getJson<ErrorsResponse>(
    `${API_PREFIX}/errors?${params.toString()}`,
    signal,
  )
}

export function fetchSettings(
  signal?: AbortSignal,
): Promise<SettingsResponse> {
  return getJson<SettingsResponse>(`${API_PREFIX}/settings`, signal)
}

export function fetchSettingsSummary(signal?: AbortSignal): Promise<SettingsSummaryResponse> {
  return getJson<SettingsSummaryResponse>(`${API_PREFIX}/settings/summary`, signal)
}

export function fetchManagementServices(signal?: AbortSignal): Promise<ManagementServicesResponse> {
  return getJson<ManagementServicesResponse>(`${API_PREFIX}/management/services`, signal)
}

export function fetchDeepseekBalance(
  signal?: AbortSignal,
): Promise<DeepseekBalanceResponse> {
  return getJson<DeepseekBalanceResponse>(
    `${API_PREFIX}/deepseek-balance`,
    signal,
  )
}

export function fetchOpencodeGoUsage(
  signal?: AbortSignal,
): Promise<OpencodeGoUsageResponse> {
  return getJson<OpencodeGoUsageResponse>(
    `${API_PREFIX}/opencode-go-usage`,
    signal,
  )
}

export function fetchOfficialAccountSnapshots(
  signal?: AbortSignal,
): Promise<OfficialAccountSnapshotsResponse> {
  return getJson<OfficialAccountSnapshotsResponse>(`${API_PREFIX}/accounts`, signal)
}

export function fetchGlobalOverview(
  device: string | null,
  signal?: AbortSignal,
): Promise<GlobalOverviewResponse> {
  const query = device === null ? "" : `?device=${encodeURIComponent(device)}`
  return getJson<GlobalOverviewResponse>(
    `${API_PREFIX}/global/overview${query}`,
    signal,
  )
}

export function fetchGlobalDevices(
  signal?: AbortSignal,
): Promise<GlobalDevicesResponse> {
  return getJson<GlobalDevicesResponse>(
    `${API_PREFIX}/global/devices`,
    signal,
  )
}

export function fetchGlobalDaily(
  device: string | null,
  days: number,
  signal?: AbortSignal,
): Promise<GlobalDailyResponse> {
  const query = [
    `days=${days}`,
    device === null ? null : `device=${encodeURIComponent(device)}`,
  ].filter(Boolean).join("&")
  return getJson<GlobalDailyResponse>(
    `${API_PREFIX}/global/daily?${query}`,
    signal,
  )
}

export function fetchGlobalQuota(
  days: number,
  device: string | null = null,
  signal?: AbortSignal,
): Promise<GlobalQuotaResponse> {
  const query = new URLSearchParams({ days: String(days) })
  if (device !== null) query.set("device", device)
  return getJson<GlobalQuotaResponse>(
    `${API_PREFIX}/global/quota?${query.toString()}`,
    signal,
  )
}

export function fetchGlobalRequests(
  limit: number,
  device: string | null,
  offset: number,
  sort: string,
  direction: string,
  signal?: AbortSignal,
): Promise<GlobalRequestsResponse> {
  const query = [
    `limit=${limit}`,
    device === null ? null : `device=${encodeURIComponent(device)}`,
    offset > 0 ? `offset=${offset}` : null,
    `sort=${encodeURIComponent(sort)}`,
    `direction=${encodeURIComponent(direction)}`,
  ].filter(Boolean).join("&")
  return getJson<GlobalRequestsResponse>(
    `${API_PREFIX}/global/requests?${query}`,
    signal,
  )
}
