import { useMemo, useState } from "react"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { RangeSelector } from "@/components/metrics/range-selector"
import { RequestsTable } from "@/components/requests/requests-table"
import { useRequests } from "@/hooks/use-requests"
import type { RangeName } from "@/lib/types"

export function RequestsPage() {
  const [range, setRange] = useState<RangeName>("24h")
  const [afterId, setAfterId] = useState<number | null>(null)
  const [history, setHistory] = useState<(number | null)[]>([])
  const [pageSize, setPageSize] = useState(100)
  const [pageNumber, setPageNumber] = useState(1)
  const { data, loading, error } = useRequests(range, afterId, pageSize)
  const records = useMemo(
    () => (data === null ? [] : [...data.records].reverse()),
    [data],
  )

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">请求明细</h1>
          <p className="text-sm text-muted-foreground">模型请求记录，按记录时间倒序分页</p>
        </div>
        <RangeSelector
          value={range}
          onChange={(next) => {
            setRange(next)
            setAfterId(null)
            setHistory([])
            setPageNumber(1)
          }}
        />
      </div>

      <ErrorBanner error={error} />

      {loading || data === null ? <PageSkeleton rows={8} /> : (
        <RequestsTable
          records={records}
          pageNumber={pageNumber}
          hasPrevious={history.length > 0}
          hasNext={data.nextAfterId !== null}
          onPrevious={() => {
            if (history.length === 0) return
            setAfterId(history[history.length - 1] ?? null)
            setHistory(history.slice(0, -1))
            setPageNumber((current) => current - 1)
          }}
          onNext={() => {
            if (data.nextAfterId !== null) {
              setHistory([...history, afterId])
              setAfterId(data.nextAfterId)
              setPageNumber((current) => current + 1)
            }
          }}
          pageSize={pageSize}
          onPageSizeChange={(next) => {
            setPageSize(next)
            setAfterId(null)
            setHistory([])
            setPageNumber(1)
          }}
        />
      )}
    </div>
  )
}
