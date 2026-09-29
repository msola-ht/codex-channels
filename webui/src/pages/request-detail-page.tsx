import { Link, useLocation, useParams } from "react-router"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { RequestDetail } from "@/components/requests/request-detail"
import { Button } from "@/components/ui/button"
import { useRequestDetail } from "@/hooks/use-requests"
import { useTranslation } from "@/hooks/use-translation"
import { translateApiError } from "@/lib/i18n/translate"

export function RequestDetailPage() {
  const { id = "" } = useParams()
  return <RequestDetailContent key={id} id={id} />
}

function RequestDetailContent({ id }: { id: string }) {
  const { search } = useLocation()
  const { t } = useTranslation()
  const { data, loading, error, errorCode, refetch } = useRequestDetail(id)
  return <div className="flex min-w-0 flex-col gap-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">{t("requestDetail.title")}</h1>
      <Button variant="outline" asChild><Link to={{ pathname: "/requests", search }}>{t("requestDetail.back")}</Link></Button>
    </div>
    <ErrorBanner error={translateApiError(t, error, errorCode)} onRetry={refetch} pending={loading} />
    {error !== null ? null : data === null ? <PageSkeleton rows={8} /> : <RequestDetail record={data.record} />}
  </div>
}
