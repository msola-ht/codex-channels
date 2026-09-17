import { useMemo } from "react"
import { useSearchParams } from "react-router"

export const trafficPageSizeOptions = [25, 50, 100, 200]

const defaultLimit = 50

export interface TrafficQuery {
  label?: string
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
    const offset = Number(search.get("offset") ?? 0)
    const limit = Number(search.get("limit") ?? defaultLimit)
    return {
      ...(rawLabel === null ? {} : { label: rawLabel }),
      id: rawId !== null && /^[0-9]+$/u.test(rawId) ? Number(rawId) : null,
      limit: trafficPageSizeOptions.includes(limit) ? limit : defaultLimit,
      offset: Number.isInteger(offset) && offset >= 0 ? offset : 0,
    } as TrafficQuery
  }, [encoded])

  const update = (
    changes: { label?: string | null; id?: number | null; limit?: number; offset?: number },
    resetPage = false,
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
    })
  }

  return { query, update }
}
