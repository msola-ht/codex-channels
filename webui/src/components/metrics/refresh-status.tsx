import { useContext } from "react"
import { ServerTimeContext } from "@/hooks/use-server-time"
import { useTranslation } from "@/hooks/use-translation"
import { formatTime } from "@/lib/format"

export function RefreshStatus({ status, updatedAt, failed = false, history = false }: {
  status: "connecting" | "live" | "reconnecting" | "paused" | "retrying" | "stale"
  updatedAt?: number | null
  failed?: boolean
  history?: boolean
}) {
  const { t } = useTranslation()
  const clock = useContext(ServerTimeContext)
  const stale = failed || status !== "live" && !(history && status === "paused")
  const time = updatedAt == null ? null : updatedAt + (clock === null ? 0 : clock.nowMs - clock.receivedAtMs)
  return <span className="text-xs text-muted-foreground" role="status">
    {history ? t("requests.historyUpdatesPaused") : t(`delivery.notifications.${status}`)}
    {time === null ? null : <> · {t("refreshStatus.updatedAt", { time: formatTime(time) })}{stale ? <> · {t("refreshStatus.stale")}</> : null}</>}
  </span>
}
