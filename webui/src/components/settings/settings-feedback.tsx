import type { ReactNode } from "react"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { RefreshCwIcon } from "lucide-react"
import { useTranslation } from "@/hooks/use-translation"

export function SettingsError({ message, retry }: { message: string; retry: () => void }) {
  const { t } = useTranslation()
  return <Alert variant="destructive"><AlertTitle>{t("settingsUi.loadFailed")}</AlertTitle><AlertDescription>{message}</AlertDescription><AlertAction><Button variant="outline" size="sm" onClick={retry}><RefreshCwIcon data-icon="inline-start" />{t("common.retry")}</Button></AlertAction></Alert>
}

export function LoadingSettingsCard({ title }: { title: string }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardContent><Skeleton className="h-28 w-full" /></CardContent></Card>
}

export function SettingsEmpty({ children }: { children: ReactNode }) {
  return <Empty className="min-h-20 items-start p-3 text-left"><EmptyHeader className="items-start"><EmptyTitle>{children}</EmptyTitle></EmptyHeader></Empty>
}
