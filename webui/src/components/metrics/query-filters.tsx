import { useId, useState } from "react"

import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { MetricsQuery, RangeName } from "@/lib/types"
import { RangeSelector } from "@/components/metrics/range-selector"

export function QueryFilters(props: { query: MetricsQuery; onChange: (query: Partial<MetricsQuery>) => void; threadId?: string }) {
  // 路由前进/后退和逐层跳转时重建草稿；翻页不影响已填写的筛选。
  const { offset: _offset, limit: _limit, sort: _sort, direction: _direction, ...scope } = props.query
  return <QueryFiltersForm key={JSON.stringify(scope)} {...props} />
}

function QueryFiltersForm({ query, onChange, threadId }: { query: MetricsQuery; onChange: (query: Partial<MetricsQuery>) => void; threadId?: string }) {
  const id = useId()
  const [draft, setDraft] = useState(query)
  const [range, setRange] = useState<RangeName | "custom">(query.from !== undefined || query.to !== undefined ? "custom" : query.range ?? "all")
  const set = (key: keyof MetricsQuery, value: string) => setDraft((previous) => ({ ...previous, [key]: value }))
  const textFields = [
    ...(!threadId ? [["threadId", "Thread ID"]] : []),
    ["turnId", "Turn ID"], ["provider", "Provider"], ["model", "模型"], ["filter", "关键词"],
  ] as Array<["threadId" | "turnId" | "provider" | "model" | "filter", string]>
  return (
    <form className="shrink-0" onSubmit={(event) => {
      event.preventDefault()
      const changes: Partial<MetricsQuery> = {
        range: range === "custom" ? undefined : range as MetricsQuery["range"],
        from: range === "custom" ? draft.from : undefined,
        to: range === "custom" ? draft.to : undefined,
        operation: draft.operation || undefined,
        status: draft.status || undefined,
      }
      for (const [key] of textFields) changes[key] = draft[key]?.trim() || undefined
      onChange(changes)
    }}>
      <FieldGroup className="grid grid-cols-2 items-end gap-3 lg:grid-cols-4 xl:grid-cols-6">
        <RangeSelector value={range} onChange={setRange} from={draft.from} to={draft.to} onDateChange={set} />
        {textFields.map(([key, label]) => (
          <Field key={key}><FieldLabel htmlFor={`${id}-${key}`}>{label}</FieldLabel><Input id={`${id}-${key}`} value={draft[key] ?? ""} maxLength={128} placeholder={key === "filter" ? "会话 / 模型 / 错误" : "全部"} onChange={(event) => set(key, event.target.value)} /></Field>
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
        <div className="flex gap-2">
          <Button type="submit">查询</Button>
          <Button type="button" variant="outline" onClick={() => {
            const cleared: MetricsQuery = { range: "all", from: undefined, to: undefined, threadId: undefined, turnId: undefined, provider: undefined, model: undefined, operation: undefined, status: undefined, filter: undefined }
            setDraft(cleared)
            setRange("all")
            onChange(cleared)
          }}>重置</Button>
        </div>
      </FieldGroup>
    </form>
  )
}
