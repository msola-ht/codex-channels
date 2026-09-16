import { useId, useState } from "react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { MetricsQuery } from "@/lib/types"

export function QueryFilters(props: { query: MetricsQuery; onChange: (query: Partial<MetricsQuery>) => void; threadId?: string }) {
  // 路由前进/后退和逐层跳转时重建草稿；翻页不影响已填写的筛选。
  const { offset: _offset, limit: _limit, sort: _sort, direction: _direction, ...scope } = props.query
  return <QueryFiltersForm key={JSON.stringify(scope)} {...props} />
}

function QueryFiltersForm({ query, onChange, threadId }: { query: MetricsQuery; onChange: (query: Partial<MetricsQuery>) => void; threadId?: string }) {
  const id = useId()
  const [draft, setDraft] = useState(query)
  const [range, setRange] = useState(query.from !== undefined || query.to !== undefined ? "custom" : query.range ?? "all")
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
        <Field>
          <FieldLabel htmlFor={`${id}-range`}>时间范围</FieldLabel>
          <Select value={range} onValueChange={setRange}>
            <SelectTrigger id={`${id}-range`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>
              {[['24h', '最近 24 小时'], ['7d', '最近 7 天'], ['30d', '最近 30 天'], ['90d', '最近 90 天'], ['all', '全部历史'], ['custom', '自定义日期']].map(([value, label]) => <SelectItem key={value} value={value!}>{label}</SelectItem>)}
            </SelectGroup></SelectContent>
          </Select>
          {range === "custom" ? <FieldDescription>按服务端本地时区查询</FieldDescription> : null}
        </Field>
        {range === "custom" ? <>
          <Field><FieldLabel htmlFor={`${id}-from`}>开始日期</FieldLabel><Input id={`${id}-from`} type="date" required value={draft.from ?? ""} onChange={(event) => set("from", event.target.value)} /></Field>
          <Field><FieldLabel htmlFor={`${id}-to`}>结束日期（含当天）</FieldLabel><Input id={`${id}-to`} type="date" required min={draft.from} value={draft.to ?? ""} onChange={(event) => set("to", event.target.value)} /></Field>
        </> : null}
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
