import { useEffect, useState } from "react"
import type { SortingState } from "@tanstack/react-table"

import type { RequestSortDirection, RequestSortKey } from "@/lib/types"

const STORAGE_KEY = "codex-webui:requests-table-state-v3:sorting"
const DEFAULT_SORTING: SortingState = [{ id: "time", desc: true }]
const SORT_KEYS = new Set<RequestSortKey>([
  "time",
  "provider",
  "model",
  "operation",
  "status",
  "http",
  "error",
  "input",
  "output",
  "reasoningOutput",
  "speed",
  "ttft",
  "duration",
  "cost",
])

function initialSorting(): SortingState {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")
    if (!Array.isArray(stored) || stored.length === 0) return DEFAULT_SORTING
    const latest = stored.at(-1)
    return typeof latest?.id === "string"
      && SORT_KEYS.has(latest.id as RequestSortKey)
      && typeof latest.desc === "boolean"
      ? [latest]
      : DEFAULT_SORTING
  } catch {
    return DEFAULT_SORTING
  }
}

export function useRequestSorting(): {
  sorting: SortingState
  setSorting: (sorting: SortingState) => void
  sort: RequestSortKey
  direction: RequestSortDirection
} {
  const [sorting, setSorting] = useState<SortingState>(initialSorting)
  const current = sorting[0] ?? DEFAULT_SORTING[0]!

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sorting))
    } catch {
      // 存储不可用时仅在本次会话内保留
    }
  }, [sorting])

  return {
    sorting,
    setSorting,
    sort: current.id as RequestSortKey,
    direction: current.desc ? "desc" : "asc",
  }
}
