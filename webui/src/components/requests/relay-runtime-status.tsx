import { Badge } from "@/components/ui/badge"
import { useTranslation } from "@/hooks/use-translation"
import { formatElapsedDuration } from "@/lib/format"
import type { RelayManagementSnapshot } from "@/lib/types"

export function RelayRuntimeStatus({ runtime }: { runtime: Extract<RelayManagementSnapshot["runtime"], { state: "running" }> }) {
  const { t } = useTranslation()
  const capture = runtime.capture
  const state = !runtime.configurationValid ? "unknown" : !capture.enabled ? "disabled" : capture.state
  return <div className="flex flex-col gap-2" aria-label={t("relay.diagnosticsLabel")}>
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline">{t("relay.oldestWait", { value: formatElapsedDuration(runtime.oldestWaitMs) })}</Badge>
      <Badge variant="outline">{t("relay.queueTimeouts", { count: runtime.queueTimeouts })}</Badge>
      <Badge variant={state === "failed" ? "destructive" : "outline"}>{t(`relay.captureStates.${state}`)}</Badge>
      <Badge variant="outline">{t("relay.captureActive", { count: capture.active })}</Badge>
      <Badge variant="outline">{t("relay.captureSkipped", { count: capture.skippedCapacity })}</Badge>
    </div>
    <p className="text-sm text-muted-foreground">{t("relay.queueHint")}</p>
    <p className="text-sm text-muted-foreground">{t("relay.metricCounts", runtime.metrics)}</p>
    <p className="text-sm text-muted-foreground">{t("relay.diagnosticsHint")}</p>
  </div>
}
