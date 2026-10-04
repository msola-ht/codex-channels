import { Link, useParams } from "react-router"

import { ThreadSubagents } from "@/components/threads/thread-subagents"
import { Button } from "@/components/ui/button"
import { useTranslation } from "@/hooks/use-translation"
import { shortThreadId } from "@/lib/format"
import { metricsLink } from "@/lib/metrics-query"

export function ThreadSubagentsPage() {
  const { id = "" } = useParams<{ id: string }>()
  const { t } = useTranslation()

  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6">
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold" title={shortThreadId(id) === id ? undefined : id}>{t("threads.subagentsHeading", { id: shortThreadId(id) })}</h1>
      <Button variant="outline" render={<Link to={metricsLink(`/threads/${encodeURIComponent(id)}`, { range: "all" })} />} nativeButton={false}>{t("threads.backToThread")}</Button>
    </div>
    <ThreadSubagents key={id} threadId={id} />
  </div>
}

export function SubagentsPage() {
  const { t } = useTranslation()
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6">
    <h1 className="shrink-0 text-xl font-semibold">{t("threads.allSubagents")}</h1>
    <ThreadSubagents />
  </div>
}
