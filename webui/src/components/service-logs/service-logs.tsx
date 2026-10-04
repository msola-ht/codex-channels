import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { useServiceLogs } from "@/hooks/use-service-logs"
import { useTranslation } from "@/hooks/use-translation"
import { logLevels, type LogLevelFilter } from "@/lib/service-logs"
import { LogResults } from "./log-results"
import { translateApiError } from "@/lib/i18n/translate"
import type { ServiceLogTarget } from "@/lib/types"

const targets: { value: ServiceLogTarget; label: string }[] = [
  { value: "gateway", label: "Gateway" }, { value: "app-server", label: "App Server" },
  { value: "webui", label: "WebUI" }, { value: "relay", label: "Relay" },
]
const limits = [100, 200, 500, 1000].map(value => ({ value, label: String(value) }))

export function ServiceLogs() {
  const { t } = useTranslation()
  const [target, setTarget] = useState<ServiceLogTarget>("gateway")
  const [lines, setLines] = useState(100)
  const [filter, setFilter] = useState("")
  const [automatic, setAutomatic] = useState(false)
  const [level, setLevel] = useState<LogLevelFilter>("all")
  const levels = (["all", "problems", ...logLevels] as const).map(value => ({ value, label: t(`logs.levels.${value}`) }))
  const { data, loading, error, errorCode, refetch } = useServiceLogs(target, lines, automatic)
  return <Tabs className="min-h-0 min-w-0 flex-1" value={target} onValueChange={value => {
    const next = targets.find(item => item.value === value)
    if (next) setTarget(next.value)
  }}>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4" aria-busy={loading}>
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">{t("logs.title")}</h1><p className="text-sm text-muted-foreground">{t("logs.description")}</p></div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={loading} onClick={refetch}>{loading ? t("common.refreshing") : t("common.refresh")}</Button>
      </div>
    </div>
    <TabsList aria-label={t("logs.service")} className="w-full shrink-0 sm:w-fit">
      {targets.map(item => <TabsTrigger key={item.value} value={item.value}>{item.label}</TabsTrigger>)}
    </TabsList>
    <TabsContent key={target} value={target} className="flex min-h-0 min-w-0 flex-col gap-4">
    <FieldGroup className="shrink-0 flex-row flex-wrap items-end gap-3">
      <Field className="min-w-48 flex-1"><FieldLabel htmlFor="log-search">{t("logs.search")}</FieldLabel>
        <Input id="log-search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t("logs.searchHint")} maxLength={200} />
      </Field>
      <Field className="w-32"><FieldLabel htmlFor="log-lines">{t("logs.lines")}</FieldLabel>
        <Select items={limits} value={lines} onValueChange={value => { if (value !== null) setLines(value) }}>
          <SelectTrigger id="log-lines" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{limits.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </Field>
      <Field className="w-44"><FieldLabel htmlFor="log-level">{t("logs.level")}</FieldLabel>
        <Select items={levels} value={level} onValueChange={value => { if (value !== null) setLevel(value) }}>
          <SelectTrigger id="log-level" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{levels.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </Field>
        <Toggle variant="outline" pressed={automatic} onPressedChange={setAutomatic} aria-label={t("logs.auto")}>{t("logs.auto")}</Toggle>
      </FieldGroup>
    <ErrorBanner error={translateApiError(t, error, errorCode)} onRetry={refetch} pending={loading} />
    {automatic && error !== null ? <Alert role="status"><AlertDescription>{t("logs.autoStopped")}</AlertDescription></Alert> : null}
    {data === null ? loading ? <PageSkeleton rows={5} /> : null : <LogResults key={`${target}:${lines}`} data={data} filter={filter} level={level} stale={error !== null} />}
    </TabsContent>
    </div>
  </Tabs>
}
