import { translateApiError } from "@/lib/i18n/translate"
import { useTranslation } from "@/hooks/use-translation"
import { useId, useState } from "react"
import { ChevronDownIcon, SlidersHorizontalIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { TruncatedText } from "@/components/metrics/data-table"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter, SheetTrigger } from "@/components/ui/sheet"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { MetricsQuery, RangeName } from "@/lib/types"
import { RangeSelector } from "@/components/metrics/range-selector"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { useMetricsProviders } from "@/hooks/use-metrics-query"

export function QueryFilters(props: { query: MetricsQuery; onChange: (query: Partial<MetricsQuery>) => void; threadId?: string; showThreadFilters?: boolean }) {
  const { t } = useTranslation()
  const providers = useMetricsProviders()
  // 路由前进/后退和逐层跳转时重建草稿；翻页不影响已填写的筛选。
  const { offset: _offset, limit: _limit, sort: _sort, direction: _direction, ...scope } = props.query
  return <>
    <ErrorBanner error={translateApiError(t, providers.error, providers.errorCode)} />
    <QueryFiltersForm key={JSON.stringify(scope)} {...props} providers={providers.data?.providers ?? []} providersLoading={providers.loading} providersError={providers.error} />
  </>
}

function QueryFiltersForm({ query, onChange, threadId, showThreadFilters = true, providers, providersLoading, providersError }: { query: MetricsQuery; onChange: (query: Partial<MetricsQuery>) => void; threadId?: string; showThreadFilters?: boolean; providers: string[]; providersLoading: boolean; providersError: string | null }) {
  const { t } = useTranslation()
  const id = useId()
  const [draft, setDraft] = useState(query)
  const [open, setOpen] = useState(false)
  const [dateError, setDateError] = useState<boolean>(false)
  const [range, setRange] = useState<RangeName | "custom">(query.from !== undefined || query.to !== undefined ? "custom" : query.range ?? "all")
  const set = (key: keyof MetricsQuery, value: string) => setDraft((previous) => ({ ...previous, [key]: value }))
  const selectedProviders = draft.provider ?? []
  const providerOptions = [...new Set([...providers, ...selectedProviders])].sort()
  const textFields = [
    ...(showThreadFilters && !threadId ? [["threadId", t("metrics.threadId")]] : []),
    ...(showThreadFilters ? [["turnId", t("metrics.turnId")]] : []),
    ["model", t("metrics.model")],
    ["callerId", t("filters.caller")],
  ] as Array<["threadId" | "turnId" | "model" | "callerId", string]>
  const scopedFields = !showThreadFilters ? (["threadId", "turnId"] as const).filter((key) => Boolean(query[key])) : []
  const filterCount = [range !== "all", selectedProviders.length > 0, ...textFields.map(([key]) => Boolean(draft[key]?.trim())), Boolean(draft.source), Boolean(draft.operation), Boolean(draft.status)].filter(Boolean).length + scopedFields.length
  const apply = () => {
      if (range === "custom" && (!draft.from || !draft.to || draft.from > draft.to)) {
        setDateError(true)
        setOpen(true)
        return
      }
      const changes: Partial<MetricsQuery> = {
        range: range === "custom" ? undefined : range as MetricsQuery["range"],
        from: range === "custom" ? draft.from : undefined,
        to: range === "custom" ? draft.to : undefined,
        operation: draft.operation || undefined,
        status: draft.status || undefined,
        source: draft.source || undefined,
        provider: selectedProviders.length === 0 ? undefined : selectedProviders,
        filter: draft.filter?.trim() || undefined,
      }
      for (const [key] of textFields) changes[key] = draft[key]?.trim() || undefined
      onChange(changes)
      setDateError(false)
      setOpen(false)
  }
  const reset = () => {
    const cleared: MetricsQuery = { range: "all", from: undefined, to: undefined, threadId: undefined, turnId: undefined, provider: undefined, model: undefined, operation: undefined, status: undefined, filter: undefined, source: undefined, callerId: undefined }
    setDraft(cleared)
    setRange("all")
    setDateError(false)
    setOpen(false)
    onChange(cleared)
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <form className="@container/filters min-w-0 shrink-0" onSubmit={(event) => { event.preventDefault(); apply() }}>
        <FieldGroup className="flex-row flex-nowrap items-center gap-2">
          <Button type="button" variant="outline" className="hidden @lg/filters:inline-flex" aria-label={t("filters.rangeLabel", { range: t(`ranges.${range}`) })} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
            {t(`ranges.${range}`)}<ChevronDownIcon data-icon="inline-end" />
          </Button>
          <Field className="min-w-0 flex-1">
            <FieldLabel className="sr-only" htmlFor={`${id}-filter`}>{t("filters.keyword")}</FieldLabel>
            <Input id={`${id}-filter`} value={draft.filter ?? ""} maxLength={128} placeholder={t("filters.search")} onChange={(event) => set("filter", event.target.value)} />
          </Field>
          <SheetTrigger asChild><Button type="button" variant="outline"><SlidersHorizontalIcon data-icon="inline-start" />{t("common.filter")}{filterCount > 0 ? ` · ${filterCount}` : ""}</Button></SheetTrigger>
          <Button type="submit">{t("filters.query")}</Button>
          <Button type="button" variant="outline" onClick={reset}>{t("filters.reset")}</Button>
        </FieldGroup>
        {scopedFields.length > 0 ? <div className="mt-2 flex flex-wrap items-center gap-2" aria-label={t("filters.scope")}>
          {scopedFields.map((key) => <div key={key} className="flex items-center gap-1"><Badge variant="outline">
            {key === "threadId" ? t("metrics.thread") : t("metrics.turn")}：<TruncatedText text={query[key]} className="max-w-48" /></Badge>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={t("filters.clear", { kind: key === "threadId" ? t("metrics.thread") : t("metrics.turn") })} onClick={() => onChange(key === "threadId" ? { threadId: undefined, turnId: undefined } : { turnId: undefined })}><XIcon /></Button>
          </div>)}
        </div> : null}
      </form>
      <SheetContent closeLabel={t("common.close")}>
        <SheetHeader><SheetTitle>{t("filters.title")}</SheetTitle><SheetDescription>{t("filters.description")}</SheetDescription></SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); apply() }}>
      <FieldGroup className="min-h-0 flex-1 gap-4 overflow-y-auto px-4 pb-4">
        <ErrorBanner error={dateError ? t("filters.invalidDate") : null} />
        <RangeSelector value={range} onChange={setRange} from={draft.from} to={draft.to} onDateChange={set} />
        <Field>
          <FieldLabel htmlFor={`${id}-provider`}>{t("metrics.provider")}</FieldLabel>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button id={`${id}-provider`} type="button" variant="outline" className="w-full justify-between" disabled={providersLoading || providersError !== null}>
                <span className="truncate">{providersLoading ? t("common.loading") : providersError !== null ? t("common.loadFailed") : selectedProviders.length === 0 ? t("common.all") : selectedProviders.join("、")}</span>
                <ChevronDownIcon data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuCheckboxItem checked={selectedProviders.length === 0} onSelect={(event) => event.preventDefault()} onCheckedChange={() => setDraft((previous) => ({ ...previous, provider: undefined }))}>{t("common.all")}</DropdownMenuCheckboxItem>
                {providerOptions.map((provider) => (
                  <DropdownMenuCheckboxItem key={provider} checked={selectedProviders.includes(provider)} onSelect={(event) => event.preventDefault()} onCheckedChange={(checked) => setDraft((previous) => ({ ...previous, provider: checked ? [...(previous.provider ?? []), provider] : previous.provider?.filter((value) => value !== provider) }))}>
                    {provider}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </Field>
        {textFields.map(([key, label]) => (
          <Field key={key}><FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel><Input id={`${id}-${key}`} value={draft[key] ?? ""} maxLength={128} placeholder={t("common.all")} onChange={(event) => set(key, event.target.value)} /></Field>
        ))}
        {([
          ["source", t("filters.source"), [["owned", t("filters.owned")], ["relay", t("filters.relay")]]],
          ["operation", t("filters.operation"), [["response", t("filters.response")], ["compact", t("metrics.compact")]]],
          ["status", t("filters.status"), [["completed", t("filters.completed")], ["failed", t("filters.failed")], ["incomplete", t("filters.incomplete")], ["unknown", t("filters.unknown")]]],
        ] as const).map(([key, label, options]) => (
          <Field key={key}><FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
            <Select value={draft[key] || "all"} onValueChange={(value) => set(key, value === "all" ? "" : value)}>
              <SelectTrigger id={`${id}-${key}`}><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup><SelectItem value="all">{t("common.all")}</SelectItem>{options.map(([value, text]) => <SelectItem key={value} value={value}>{text}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
        ))}
      </FieldGroup>
        <SheetFooter className="shrink-0 flex-row">
          <Button type="submit">{t("filters.query")}</Button>
          <Button type="button" variant="outline" onClick={reset}>{t("filters.reset")}</Button>
        </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
