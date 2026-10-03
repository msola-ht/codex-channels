import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/ui/toggle"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card"
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { PageSkeleton } from "@/components/metrics/page-skeleton"
import { useServiceLogs } from "@/hooks/use-service-logs"
import { useTranslation } from "@/hooks/use-translation"
import { formatTime } from "@/lib/format"
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
  const [lines, setLines] = useState(200)
  const [filter, setFilter] = useState("")
  const [automatic, setAutomatic] = useState(false)
  const { data, loading, error, errorCode, refetch } = useServiceLogs(target, lines, automatic)
  return <div className="flex min-w-0 flex-col gap-4" aria-busy={loading}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-semibold">{t("logs.title")}</h1><p className="text-sm text-muted-foreground">{t("logs.description")}</p></div>
      <div className="flex flex-wrap gap-2">
        <Toggle variant="outline" pressed={automatic} onPressedChange={setAutomatic} aria-label={t("logs.auto")}>{t("logs.auto")}</Toggle>
        <Button variant="outline" disabled={loading} onClick={refetch}>{loading ? t("common.refreshing") : t("common.refresh")}</Button>
      </div>
    </div>
    <FieldGroup className="flex-row flex-wrap items-end gap-3">
      <Field className="w-40"><FieldLabel htmlFor="log-target">{t("logs.service")}</FieldLabel>
        <Select items={targets} value={target} onValueChange={value => { if (value !== null) setTarget(value) }}>
          <SelectTrigger id="log-target" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{targets.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </Field>
      <Field className="w-32"><FieldLabel htmlFor="log-lines">{t("logs.lines")}</FieldLabel>
        <Select items={limits} value={lines} onValueChange={value => { if (value !== null) setLines(value) }}>
          <SelectTrigger id="log-lines" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent><SelectGroup>{limits.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
        </Select>
      </Field>
      <Field className="min-w-48 flex-1"><FieldLabel htmlFor="log-search">{t("logs.search")}</FieldLabel>
        <Input id="log-search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t("logs.searchHint")} maxLength={200} />
      </Field>
    </FieldGroup>
    <ErrorBanner error={translateApiError(t, error, errorCode)} onRetry={refetch} pending={loading} />
    {automatic && error !== null ? <Alert role="status"><AlertDescription>{t("logs.autoStopped")}</AlertDescription></Alert> : null}
    {data === null ? loading ? <PageSkeleton rows={5} /> : null : <>
      <p className="text-xs text-muted-foreground" role="status">{t("refreshStatus.updatedAt", { time: formatTime(Date.parse(data.observedAt)) })}{error !== null ? ` · ${t("refreshStatus.stale")}` : ""}</p>
      {data.streams.map(stream => {
        const visible = stream.lines.filter(line => line.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))
        return <Card key={stream.source}>
          <CardHeader><CardTitle>{t(`logs.${stream.source}`)}</CardTitle><CardDescription>{t("logs.count", { count: visible.length })}{stream.truncated ? ` · ${t("logs.truncated")}` : ""}</CardDescription></CardHeader>
          <CardContent>
            {visible.length === 0 ? <Empty><EmptyHeader><EmptyTitle>{stream.missing ? t("logs.missing") : stream.lines.length > 0 ? t("logs.noMatches") : t("logs.empty")}</EmptyTitle></EmptyHeader></Empty>
              : <pre tabIndex={0} aria-label={t(`logs.${stream.source}`)} className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs leading-6">{visible.join("\n")}</pre>}
          </CardContent>
        </Card>
      })}
    </>}
  </div>
}
