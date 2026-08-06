import { Check, ChevronsUpDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { DisplayCurrency } from "@/lib/format"

const options: Array<{ value: DisplayCurrency; label: string }> = [
  { value: "cny", label: "¥ 人民币" },
  { value: "usd", label: "$ 美元" },
]

export function CurrencyToggle({
  value,
  onChange,
}: {
  value: DisplayCurrency
  onChange: (value: DisplayCurrency) => void
}) {
  const current = options.find((option) => option.value === value) ?? options[1]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label="切换显示货币"
        >
          {current.label}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.value}
            onClick={() => onChange(option.value)}
            className="gap-2"
          >
            <Check
              className={cn(
                "size-4",
                option.value === value ? "opacity-100" : "opacity-0",
              )}
            />
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
