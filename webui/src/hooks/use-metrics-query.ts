import { useMemo } from "react"
import { useSearchParams } from "react-router"
import type { SortingState } from "@tanstack/react-table"

import type { MetricsQuery, RangeName } from "@/lib/types"
import type { DataTableProps } from "@/components/metrics/data-table"
import { useApi } from "@/hooks/use-api"
import { fetchMetricsProviders } from "@/lib/api"

export function useMetricsProviders() {
  return useApi(fetchMetricsProviders, [])
}

export function useMetricsQuery(defaultRange: RangeName, defaultSort = "time") {
  const [params, setParams] = useSearchParams()
  const encoded = params.toString()
  const query = useMemo(() => {
    const search = new URLSearchParams(encoded)
    const values = Object.fromEntries(search)
    return {
      ...values,
      provider: search.has("provider") ? search.getAll("provider") : undefined,
      ...(values.from === undefined && values.to === undefined ? { range: values.range ?? defaultRange } : {}),
      offset: values.offset === undefined ? 0 : Number(values.offset),
      limit: values.limit === undefined ? 50 : Number(values.limit),
      sort: values.sort ?? defaultSort,
      direction: values.direction ?? "desc",
    } as MetricsQuery & { offset: number; limit: number; sort: string; direction: "asc" | "desc" }
  }, [encoded, defaultRange, defaultSort])

  const update = (changes: Partial<MetricsQuery>, resetPage = true) => {
    setParams((previous) => {
      const next = new URLSearchParams(previous)
      if (resetPage) next.delete("offset")
      for (const [key, value] of Object.entries(changes)) {
        next.delete(key)
        if (value === undefined || value === "") continue
        for (const item of Array.isArray(value) ? value : [value]) next.append(key, String(item))
      }
      return next
    })
  }
  const sorting: SortingState = [{ id: query.sort, desc: query.direction === "desc" }]
  const onSortingChange = (next: SortingState) => update({ sort: next[0]?.id ?? defaultSort, direction: next[0]?.desc === false ? "asc" : "desc" })

  const pagination = (page: { total: number; nextOffset: number | null }): DataTableProps<object>["pagination"] => ({
    mode: "server",
    pageNumber: Math.floor(query.offset / query.limit) + 1,
    pageSize: query.limit,
    hasPrevious: query.offset > 0,
    hasNext: page.nextOffset !== null,
    onPrevious: () => update({ offset: Math.max(0, query.offset - query.limit) }, false),
    onNext: () => { if (page.nextOffset !== null) update({ offset: page.nextOffset }, false) },
    onPageSizeChange: (limit) => update({ limit }),
    sorting,
    onSortingChange,
    serverTotal: page.total,
  })
  return { query, update, sorting, onSortingChange, pagination }
}
