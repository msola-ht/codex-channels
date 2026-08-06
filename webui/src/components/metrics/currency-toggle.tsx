import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import type { DisplayCurrency } from "@/lib/format"

export function CurrencyToggle({
  value,
  onChange,
}: {
  value: DisplayCurrency
  onChange: (value: DisplayCurrency) => void
}) {
  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => {
        if (next === "cny" || next === "usd") onChange(next)
      }}
      variant="outline"
      size="sm"
    >
      <ToggleGroupItem value="cny" className="font-normal">¥ 人民币</ToggleGroupItem>
      <ToggleGroupItem value="usd" className="font-normal">$ 美元</ToggleGroupItem>
    </ToggleGroup>
  )
}
