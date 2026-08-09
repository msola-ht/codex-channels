import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { ThreadTable } from "@/components/threads/thread-table"
import { useThreads } from "@/hooks/use-threads"

export function ThreadsPage() {
  const { data, loading, error } = useThreads()

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Threads</h1>
        <p className="text-sm text-muted-foreground">指标库中有记录的全部会话</p>
      </div>

      <ErrorBanner error={error} />

      {loading || data === null
        ? <PageSkeleton rows={5} />
        : <ThreadTable threads={data.threads} />}
    </div>
  )
}
