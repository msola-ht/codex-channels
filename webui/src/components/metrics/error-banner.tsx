import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

export function ErrorBanner({ error }: { error: string | null }) {
  if (error === null) return null
  return (
    <Alert variant="destructive">
      <AlertTitle>加载失败</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  )
}
