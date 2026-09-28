import { useEffect, useState } from "react"
import { AlertCircleIcon, RefreshCwIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { CardDescription } from "@/components/ui/card"
import { formatTime } from "@/lib/format"
import { Button } from "@/components/ui/button"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { accountSnapshotIsStale, scheduleAccountSnapshotExpiry, type AccountRefreshControl } from "@/lib/account-refresh-state"
import { useServerTimeSnapshot } from "@/hooks/use-server-time"
import { useTranslation } from "@/hooks/use-translation"
import { estimateServerTime } from "@/lib/server-time"

/** 网关对未知内部原因的通用文案：与标题重复，界面不再单独展示。 */
const GATEWAY_GENERIC_REFRESH_FAILURE = "账户刷新失败"

export function AccountUpdateDescription({ observedAtMs, isDefault, refreshFailed }: {
  observedAtMs: number
  isDefault: boolean
  refreshFailed: boolean
}) {
  const { t } = useTranslation()
  const clock = useServerTimeSnapshot()
  const [now, setNow] = useState(() => estimateServerTime(clock))
  useEffect(() => scheduleAccountSnapshotExpiry(observedAtMs, setNow, document, () => estimateServerTime(clock)), [observedAtMs, clock])
  return <CardDescription>
    {isDefault ? `${t("overview.accountUpdateDefault")} · ` : ""}
    {observedAtMs > 0 ? t("overview.accountUpdatedAt", { time: formatTime(observedAtMs) }) : t("overview.accountNeverUpdated")}
    {refreshFailed ? ` · ${t("overview.accountUpdateFailed")}` : accountSnapshotIsStale(observedAtMs, now) ? ` · ${t("overview.accountUpdateStale")}` : ""}
  </CardDescription>
}

export function AccountRefreshButton({ control, retry = false }: {
  control: AccountRefreshControl
  retry?: boolean
}) {
  const { t } = useTranslation()
  return <Button variant="outline" size="sm" disabled={control.disabled} onClick={control.onRefresh}>
    {control.refreshing ? <Spinner data-icon="inline-start" aria-label={t("common.loading")} /> : <RefreshCwIcon data-icon="inline-start" />}
    {control.refreshing ? t("common.refreshing") : retry ? t("common.retry") : t("common.refresh")}
  </Button>
}

export function AccountRefreshFeedback({ control, hasSnapshot }: {
  control: AccountRefreshControl | undefined
  hasSnapshot: boolean
}) {
  const { t } = useTranslation()
  if (!control?.error) return null
  return <Alert variant={hasSnapshot ? "default" : "destructive"}>
    <AlertCircleIcon />
    <AlertTitle>{t("overview.refreshFailedTitle")}</AlertTitle>
    <AlertDescription>
      <p>{hasSnapshot ? t("overview.refreshFailedKeepsSnapshot") : t("overview.refreshFailedNoSnapshot")}</p>
      {control.error.message !== GATEWAY_GENERIC_REFRESH_FAILURE ? <p className="break-words">{control.error.message}</p> : null}
      <AccountRefreshButton control={control} retry />
    </AlertDescription>
  </Alert>
}

export function AccountSnapshotEmpty({ control }: { control: AccountRefreshControl | undefined }) {
  const { t } = useTranslation()
  if (control?.error) return null
  return <Empty className="p-3">
    <EmptyHeader><EmptyTitle>{control?.refreshing ? t("overview.accountLoadingData") : t("overview.accountNoData")}</EmptyTitle></EmptyHeader>
    {control ? <AccountRefreshButton control={control} retry /> : null}
  </Empty>
}
