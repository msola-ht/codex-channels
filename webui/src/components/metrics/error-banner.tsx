import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"

export function ErrorBanner({ error, onRetry, pending = false }: { error: string | null; onRetry?: () => void; pending?: boolean }) {
  if (error === null) return null
  return (
    <Alert variant="destructive">
      <AlertTitle>加载失败</AlertTitle>
      <AlertDescription className="min-w-0 break-all">
        <p>{error}</p>
        {onRetry === undefined ? null : <Button type="button" variant="outline" size="sm" disabled={pending} onClick={onRetry}>重试</Button>}
      </AlertDescription>
    </Alert>
  )
}
