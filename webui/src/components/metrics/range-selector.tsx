import { useTranslation } from "@/hooks/use-translation"
import { useId } from "react"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
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
  label,
}: {
  value: RangeName | "custom"
  onChange: (value: RangeName | "custom") => void
  from?: string
  to?: string
  onDateChange: (key: "from" | "to", value: string) => void
  label?: string
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <>
      <Field>
        <FieldLabel htmlFor={`${id}-range`}>{label ?? t("filters.range")}</FieldLabel>
        <Select items={ranges.map(value => ({ value, label: t(`ranges.${value}`) }))} value={value} onValueChange={(next) => { if (next !== null) onChange(next) }}>
          <SelectTrigger id={`${id}-range`}><SelectValue>{t(`ranges.${value}`)}</SelectValue></SelectTrigger>
          <SelectContent><SelectGroup>
            {ranges.map((range) => <SelectItem key={range} value={range}>{t(`ranges.${range}`)}</SelectItem>)}
          </SelectGroup></SelectContent>
        </Select>
      </Field>
      {value === "custom" ? <>
        <Field><FieldLabel htmlFor={`${id}-from`}>{t("filters.from")}</FieldLabel><Input id={`${id}-from`} type="date" required value={from ?? ""} onChange={(event) => onDateChange("from", event.target.value)} /></Field>
        <Field><FieldLabel htmlFor={`${id}-to`}>{t("filters.to")}</FieldLabel><Input id={`${id}-to`} type="date" required min={from} value={to ?? ""} onChange={(event) => onDateChange("to", event.target.value)} /></Field>
      </> : null}
    </>
  )
}
