import { Check, ChevronsUpDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import type { DisplayLanguage } from "@/lib/format"

const options: Array<{ value: DisplayLanguage; label: string }> = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
]

export function LanguageToggle({
  value,
  onChange,
}: {
  value: DisplayLanguage
  onChange: (language: DisplayLanguage) => void
}) {
  const current = options.find((option) => option.value === value) ?? options[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label="切换显示语言"
        >
          {current.label}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-28">
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
