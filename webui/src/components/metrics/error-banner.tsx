import { useTranslation } from "@/hooks/use-translation"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export function ErrorBanner({ error, onRetry, pending = false }: { error: string | null; onRetry?: () => void; pending?: boolean }) {
  const { t } = useTranslation()
  if (error === null) return null
  return (
    <Alert variant="destructive">
      <AlertTitle>{t("common.loadFailed")}</AlertTitle>
      <AlertDescription className="min-w-0 break-all">
        <p>{error}</p>
        {onRetry === undefined ? null : <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onRetry}>{t("common.retry")}</Button>}
      </AlertDescription>
    </Alert>
  )
}
