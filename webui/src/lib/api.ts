import type {
  ErrorsResponse,
  OverviewResponse,
  RangeName,
  RequestSortDirection,
  RequestSortKey,
  RequestsResponse,
  SettingsResponse,
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

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = getToken()
  const timeoutSignal = AbortSignal.timeout(30_000)
  const effectiveSignal = signal === undefined
    ? timeoutSignal
    : AbortSignal.any([signal, timeoutSignal])
  const response = await fetch(path, {
    headers: {
      accept: "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
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
  if (currency !== null) params.set("currency", currency)
  return getJson<RequestsResponse>(`${API_PREFIX}/requests?${params.toString()}`, signal)
}

export function fetchErrors(
  range: RangeName,
  currency: DisplayCurrency | null,
  signal?: AbortSignal,
): Promise<ErrorsResponse> {
  const currencyQuery = currency === null ? "" : `&currency=${currency}`
  return getJson<ErrorsResponse>(
    `${API_PREFIX}/errors?range=${range}${currencyQuery}`,
    signal,
  )
}

export function fetchSettings(
  signal?: AbortSignal,
): Promise<SettingsResponse> {
  return getJson<SettingsResponse>(`${API_PREFIX}/settings`, signal)
}
