import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router"

export const trafficPageSizeOptions = [25, 50, 100, 200]

const defaultLimit = 50

export interface TrafficQuery {
  traceOffset: number
  label?: string
  session?: string
  exchangeSession?: string
  exchangeLabel?: string
  id: number | null
  limit: number
  offset: number
}

export function useTrafficQuery() {
  const [params, setParams] = useSearchParams()
  const encoded = params.toString()
  const query = useMemo(() => {
    const search = new URLSearchParams(encoded)
    const rawId = search.get("id")
    const rawLabel = search.get("label")
    const rawSession = search.get("session")
    const rawExchangeSession = search.get("exchangeSession")
    const rawExchangeLabel = search.get("exchangeLabel")
    const traceOffset = Number(search.get("traceOffset") ?? 0)
    const offset = Number(search.get("offset") ?? 0)
    const limit = Number(search.get("limit") ?? defaultLimit)
    return {
      ...(rawLabel === null ? {} : { label: rawLabel }),
      ...(rawSession === null ? {} : { session: rawSession }),
      ...(rawExchangeSession === null ? {} : { exchangeSession: rawExchangeSession }),
      ...(rawExchangeLabel === null ? {} : { exchangeLabel: rawExchangeLabel }),
      traceOffset: Number.isInteger(traceOffset) && traceOffset >= 0 ? traceOffset : 0,
      id: rawId !== null && /^[0-9]+$/u.test(rawId) ? Number(rawId) : null,
      limit: trafficPageSizeOptions.includes(limit) ? limit : defaultLimit,
      offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
    } as TrafficQuery
  }, [encoded])

  const update = useCallback((
    changes: {
      label?: string | null
      session?: string | null
      exchangeSession?: string | null
      exchangeLabel?: string | null
      traceOffset?: number | null
      id?: number | null
      limit?: number
      offset?: number
    },
    resetPage = false,
    replace = false,
  ) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      if (resetPage) next.delete("offset")
      for (const [key, value] of Object.entries(changes)) {
        next.delete(key)
        if (value === null || value === undefined) continue
        next.set(key, String(value))
      }
      return next
    }, { replace })
  }, [setParams])

  return { query, update }
}
