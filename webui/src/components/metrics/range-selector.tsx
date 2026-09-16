import { useId } from "react"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { metricsRangeLabels } from "@/lib/metrics-query"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { RangeName } from "@/lib/types"

const ranges = ["today", "yesterday", "7d", "30d", "all", "custom"] as const

export function RangeSelector({
  value,
  onChange,
  from,
  to,
  onDateChange,
  label = "时间范围",
}: {
  value: RangeName | "custom"
  onChange: (value: RangeName | "custom") => void
  from?: string
  to?: string
  onDateChange: (key: "from" | "to", value: string) => void
  label?: string
}) {
  const id = useId()
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-range`}>{label}</FieldLabel>
        <Select value={value} onValueChange={(next) => onChange(next as RangeName | "custom")}>
          <SelectTrigger id={`${id}-range`}><SelectValue>{metricsRangeLabels[value]}</SelectValue></SelectTrigger>
          <SelectContent><SelectGroup>
            {ranges.map((range) => <SelectItem key={range} value={range}>{metricsRangeLabels[range]}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
      </Field>
      {value === "custom" ? <>
        <Field><FieldLabel htmlFor={`${id}-from`}>开始日期</FieldLabel><Input id={`${id}-from`} type="date" required value={from ?? ""} onChange={(event) => onDateChange("from", event.target.value)} /></Field>
        <Field><FieldLabel htmlFor={`${id}-to`}>结束日期（含当天）</FieldLabel><Input id={`${id}-to`} type="date" required min={from} value={to ?? ""} onChange={(event) => onDateChange("to", event.target.value)} /></Field>
      </> : null}
    </>
  )
}
