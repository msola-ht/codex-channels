import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useTranslation } from "@/hooks/use-translation"
import { formatElapsedDuration } from "@/lib/format"
import type { RelayManagementSnapshot } from "@/lib/types"

export function RelayRuntimeStatus({ runtime }: { runtime: Extract<RelayManagementSnapshot["runtime"], { state: "running" }> }) {
  const { t } = useTranslation()
  const capture = runtime.capture
  const state = !runtime.configurationValid ? "unknown" : !capture.enabled ? "disabled" : capture.state
  const queue = [[t("relay.stats.active"), runtime.active], [t("relay.stats.waiting"), runtime.waiting], [t("relay.stats.uploading"), runtime.uploading]] as const
  const metrics = [[t("relay.stats.accepted"), runtime.metrics.accepted], [t("relay.stats.unconfirmed"), runtime.metrics.unconfirmed],
    [t("relay.stats.rejected"), runtime.metrics.rejected], [t("relay.stats.dropped"), runtime.metrics.localDropped]] as const
  return <section className="grid min-w-0 gap-3 lg:grid-cols-3" aria-label={t("relay.diagnosticsLabel")}>
    <Card size="sm"><CardHeader><CardTitle>{t("relay.stats.queue")}</CardTitle></CardHeader><CardContent className="flex flex-col gap-2">
      <dl className="grid grid-cols-3 gap-3">{queue.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="text-xl font-semibold tabular-nums">{value}</dd></div>)}</dl>
      <div className="flex flex-wrap gap-2"><Badge variant="outline">{t("relay.oldestWait", { value: formatElapsedDuration(runtime.oldestWaitMs) })}</Badge><Badge variant="outline">{t("relay.queueTimeouts", { count: runtime.queueTimeouts })}</Badge></div>
      <CardDescription>{t("relay.queueHint")}</CardDescription>
    </CardContent></Card>
    <Card size="sm"><CardHeader><CardTitle>{t("relay.stats.capture")}</CardTitle><CardAction><Badge variant={state === "failed" ? "destructive" : "outline"}>{t(`relay.captureStates.${state}`)}</Badge></CardAction></CardHeader><CardContent className="flex flex-col gap-2">
      <dl className="grid grid-cols-2 gap-3">{[[t("relay.stats.capturing"), capture.active], [t("relay.stats.skipped"), capture.skippedCapacity]].map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="text-xl font-semibold tabular-nums">{value}</dd></div>)}</dl>
      <CardDescription>{t("relay.stats.captureHint")}</CardDescription>
    </CardContent></Card>
    <Card size="sm"><CardHeader><CardTitle>{t("relay.stats.metrics")}</CardTitle></CardHeader><CardContent className="flex flex-col gap-2">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">{metrics.map(([label, value]) => <div key={label} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-2"><dt className="text-sm text-muted-foreground">{label}</dt><dd className="text-xl font-semibold tabular-nums">{value}</dd></div>)}</dl>
      <CardDescription>{t("relay.stats.metricsHint")}</CardDescription>
    </CardContent></Card>
    <p className="text-sm text-muted-foreground lg:col-span-3">{t("relay.stats.snapshotHint")}</p>
  </section>
}
