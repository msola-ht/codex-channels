import { useState } from "react"
import type { SortingState } from "@tanstack/react-table"

import type { RequestSortDirection, RequestSortKey } from "@/lib/types"

const DEFAULT_SORTING: SortingState = [{ id: "time", desc: true }]

export function useRequestSorting(): {
  sorting: SortingState
  setSorting: (sorting: SortingState) => void
  sort: RequestSortKey
  direction: RequestSortDirection
} {
  // 排序不持久化：每次打开页面都回到最新时间倒序。
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORTING)
  const current = sorting[0] ?? DEFAULT_SORTING[0]!

  return {
    sorting,
    setSorting,
    sort: current.id as RequestSortKey,
    direction: current.desc ? "desc" : "asc",
  }
}
