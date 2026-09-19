import { useId, useState } from "react"
import { ChevronDownIcon, SlidersHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetFooter, SheetTrigger } from "@/components/ui/sheet"
import { metricsRangeLabels } from "@/lib/metrics-query"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuGroup, DropdownMenuCheckboxItem } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { MetricsQuery, RangeName } from "@/lib/types"
import { RangeSelector } from "@/components/metrics/range-selector"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { useMetricsProviders } from "@/hooks/use-metrics-query"

export function QueryFilters(props: { query: MetricsQuery; onChange: (query: Partial<MetricsQuery>) => void; threadId?: string; showThreadFilters?: boolean }) {
  const providers = useMetricsProviders()
  // 路由前进/后退和逐层跳转时重建草稿；翻页不影响已填写的筛选。
  const { offset: _offset, limit: _limit, sort: _sort, direction: _direction, ...scope } = props.query
  return <>
    <ErrorBanner error={providers.error} />
    <QueryFiltersForm key={JSON.stringify(scope)} {...props} providers={providers.data?.providers ?? []} providersLoading={providers.loading} providersError={providers.error} />
  </>
}

function QueryFiltersForm({ query, onChange, threadId, showThreadFilters = true, providers, providersLoading, providersError }: { query: MetricsQuery; onChange: (query: Partial<MetricsQuery>) => void; threadId?: string; showThreadFilters?: boolean; providers: string[]; providersLoading: boolean; providersError: string | null }) {
  const id = useId()
  const [draft, setDraft] = useState(query)
  const [open, setOpen] = useState(false)
  const [dateError, setDateError] = useState<string | null>(null)
  const [range, setRange] = useState<RangeName | "custom">(query.from !== undefined || query.to !== undefined ? "custom" : query.range ?? "all")
  const set = (key: keyof MetricsQuery, value: string) => setDraft((previous) => ({ ...previous, [key]: value }))
  const selectedProviders = draft.provider ?? []
  const providerOptions = [...new Set([...providers, ...selectedProviders])].sort()
  const textFields = [
    ...(showThreadFilters && !threadId ? [["threadId", "Thread ID"]] : []),
    ...(showThreadFilters ? [["turnId", "Turn ID"]] : []),
    ["model", "模型"],
  ] as Array<["threadId" | "turnId" | "model", string]>
  const filterCount = [range !== "all", selectedProviders.length > 0, ...textFields.map(([key]) => Boolean(draft[key]?.trim())), Boolean(draft.operation), Boolean(draft.status)].filter(Boolean).length
  const apply = () => {
      if (range === "custom" && (!draft.from || !draft.to || draft.from > draft.to)) {
        setDateError("请填写完整日期，结束日期不能早于开始日期。")
        setOpen(true)
        return
      }
      const changes: Partial<MetricsQuery> = {
        range: range === "custom" ? undefined : range as MetricsQuery["range"],
        from: range === "custom" ? draft.from : undefined,
        to: range === "custom" ? draft.to : undefined,
        operation: draft.operation || undefined,
        status: draft.status || undefined,
        provider: selectedProviders.length === 0 ? undefined : selectedProviders,
        filter: draft.filter?.trim() || undefined,
      }
      for (const [key] of textFields) changes[key] = draft[key]?.trim() || undefined
      onChange(changes)
      setDateError(null)
      setOpen(false)
  }
  const reset = () => {
    const cleared: MetricsQuery = { range: "all", from: undefined, to: undefined, threadId: undefined, turnId: undefined, provider: undefined, model: undefined, operation: undefined, status: undefined, filter: undefined }
    setDraft(cleared)
    setRange("all")
    setDateError(null)
    setOpen(false)
    onChange(cleared)
  }
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <form className="@container/filters min-w-0 shrink-0" onSubmit={(event) => { event.preventDefault(); apply() }}>
        <FieldGroup className="flex-row flex-nowrap items-center gap-2">
          <Button type="button" variant="outline" className="hidden @lg/filters:inline-flex" aria-label={`时间范围：${metricsRangeLabels[range]}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
            {metricsRangeLabels[range]}<ChevronDownIcon data-icon="inline-end" />
          </Button>
          <Field className="min-w-0 flex-1">
            <FieldLabel className="sr-only" htmlFor={`${id}-filter`}>关键词</FieldLabel>
            <Input id={`${id}-filter`} value={draft.filter ?? ""} maxLength={128} placeholder="搜索关键词" onChange={(event) => set("filter", event.target.value)} />
          </Field>
          <SheetTrigger asChild><Button type="button" variant="outline"><SlidersHorizontalIcon data-icon="inline-start" />筛选{filterCount > 0 ? ` · ${filterCount}` : ""}</Button></SheetTrigger>
          <Button type="submit">查询</Button>
          <Button type="button" variant="outline" onClick={reset}>重置</Button>
        </FieldGroup>
      </form>
      <SheetContent>
        <SheetHeader><SheetTitle>筛选条件</SheetTitle><SheetDescription>调整条件后点击查询生效，关闭面板保留未应用的条件。</SheetDescription></SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); apply() }}>
      <FieldGroup className="min-h-0 flex-1 gap-4 overflow-y-auto px-4 pb-4">
        <ErrorBanner error={dateError} />
        <RangeSelector value={range} onChange={setRange} from={draft.from} to={draft.to} onDateChange={set} />
        <Field>
          <FieldLabel htmlFor={`${id}-provider`}>Provider</FieldLabel>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button id={`${id}-provider`} type="button" variant="outline" className="w-full justify-between" disabled={providersLoading || providersError !== null}>
                <span className="truncate">{providersLoading ? "加载中…" : providersError !== null ? "加载失败" : selectedProviders.length === 0 ? "全部" : selectedProviders.join("、")}</span>
                <ChevronDownIcon data-icon="inline-end" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuCheckboxItem checked={selectedProviders.length === 0} onSelect={(event) => event.preventDefault()} onCheckedChange={() => setDraft((previous) => ({ ...previous, provider: undefined }))}>全部</DropdownMenuCheckboxItem>
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
          <Field key={key}><FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel><Input id={`${id}-${key}`} value={draft[key] ?? ""} maxLength={128} placeholder="全部" onChange={(event) => set(key, event.target.value)} /></Field>
        ))}
        {([
          ["operation", "操作", [["response", "响应"], ["compact", "压缩"]]],
          ["status", "状态", [["completed", "完成"], ["failed", "失败"], ["incomplete", "未完整观测"], ["unknown", "未知"]]],
        ] as const).map(([key, label, options]) => (
          <Field key={key}><FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel>
            <Select value={draft[key] || "all"} onValueChange={(value) => set(key, value === "all" ? "" : value)}>
              <SelectTrigger id={`${id}-${key}`}><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup><SelectItem value="all">全部</SelectItem>{options.map(([value, text]) => <SelectItem key={value} value={value}>{text}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
        ))}
      </FieldGroup>
        <SheetFooter className="shrink-0 flex-row">
          <Button type="submit">查询</Button>
          <Button type="button" variant="outline" onClick={reset}>重置</Button>
        </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
