import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import type { RangeName } from "@/lib/types"

const ranges: Array<{ value: RangeName; label: string }> = [
  { value: "24h", label: "24小时" },
  { value: "7d", label: "7天" },
  { value: "30d", label: "30天" },
]

export function RangeSelector({
  value,
  onChange,
}: {
  value: RangeName
  onChange: (value: RangeName) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next !== "") onChange(next as RangeName)
      }}
      variant="outline"
      size="sm"
    >
      {ranges.map((range) => (
        <ToggleGroupItem key={range.value} value={range.value} className="font-normal">
          {range.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
