import { Check, ChevronsUpDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "cn"
import type { DisplayLanguage } from "@/lib/format"
import { useTranslation } from "@/hooks/use-translation"

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
  const { t } = useTranslation()
  const current = options.find((option) => option.value === value) ?? options[0]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label={t("shell.switchLanguage")}
         />}>
          {current.label}
          <ChevronsUpDown data-icon="inline-end" className="opacity-50" />
        </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-28">
        <DropdownMenuGroup>
          {options.map((option) => (
            <DropdownMenuItem
              key={option.value}
              onClick={() => onChange(option.value)}
              className="gap-2"
            >
              <Check
                className={cn(
                  option.value === value ? "opacity-100" : "opacity-0",
                )}
              />
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
