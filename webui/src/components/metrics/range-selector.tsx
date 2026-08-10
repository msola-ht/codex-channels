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
  { value: "today", label: "今天" },
  { value: "yesterday", label: "昨天" },
  { value: "this-week", label: "本周" },
  { value: "last-week", label: "上周" },
  { value: "this-month", label: "本月" },
  { value: "last-month", label: "上月" },
  { value: "24h", label: "24小时" },
  { value: "7d", label: "7天" },
  { value: "30d", label: "30天" },
  { value: "90d", label: "90天" },
  { value: "365d", label: "365天" },
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
