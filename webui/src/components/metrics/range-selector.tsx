import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { RangeName } from "@/lib/types"

const ranges: Array<{ value: RangeName; label: string }> = [
  { value: "24h", label: "最近 24 小时" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
  { value: "90d", label: "最近 90 天" },
  { value: "365d", label: "最近 365 天" },
  { value: "all", label: "全部历史" },
]

export function RangeSelector({
  value,
  onChange,
}: {
  value: RangeName
  onChange: (value: RangeName) => void
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as RangeName)}>
      <SelectTrigger size="sm" aria-label="时间范围">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {ranges.map((range) => (
            <SelectItem key={range.value} value={range.value}>{range.label}</SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}
