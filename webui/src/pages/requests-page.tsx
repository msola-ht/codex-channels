import { useMemo, useState } from "react"

import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { RangeSelector } from "@/components/metrics/range-selector"
import { RequestsTable } from "@/components/requests/requests-table"
import { useRequests } from "@/hooks/use-requests"
import { useRequestSorting } from "@/hooks/use-request-sorting"
import type { RangeName } from "@/lib/types"

export function RequestsPage() {
  const [range, setRange] = useState<RangeName>("24h")
  const [offset, setOffset] = useState(0)
  const [pageSize, setPageSize] = useState(50)
  const [pageNumber, setPageNumber] = useState(1)
  const { sorting, setSorting, sort, direction } = useRequestSorting()
  const { data, loading, error } = useRequests(
    range,
    offset,
    pageSize,
    sort,
    direction,
  )
  const records = useMemo(() => data?.records ?? [], [data])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">请求明细</h1>
          <p className="text-sm text-muted-foreground">模型请求记录，按记录时间倒序分页</p>
        </div>
        <RangeSelector
          value={range}
          onChange={(next) => {
            setRange(next)
            setOffset(0)
            setPageNumber(1)
          }}
        />
      </div>

      <div className="shrink-0">
        <ErrorBanner error={error} />
      </div>

      {loading || data === null ? <PageSkeleton rows={8} /> : (
        <RequestsTable
          records={records}
          pageNumber={pageNumber}
          hasPrevious={offset > 0}
          hasNext={data.nextOffset !== null}
          onPrevious={() => {
            if (offset === 0) return
            setOffset(Math.max(0, offset - pageSize))
            setPageNumber((current) => current - 1)
          }}
          onNext={() => {
            if (data.nextOffset !== null) {
              setOffset(data.nextOffset)
              setPageNumber((current) => current + 1)
            }
          }}
          pageSize={pageSize}
          onPageSizeChange={(next) => {
            setPageSize(next)
            setOffset(0)
            setPageNumber(1)
          }}
          sorting={sorting}
          onSortingChange={(next) => {
            setSorting(next)
            setOffset(0)
            setPageNumber(1)
          }}
          onFilterChange={() => {
            setOffset(0)
            setPageNumber(1)
          }}
        />
      )}
    </div>
  )
}
