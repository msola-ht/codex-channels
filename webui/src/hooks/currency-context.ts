import { createContext, useContext } from "react"

import type { DisplayCurrency } from "@/lib/format"
import type { SettingsResponse } from "@/lib/types"

export const CurrencyContext = createContext<{
  currency: DisplayCurrency | null
  setCurrency: (currency: DisplayCurrency) => void
  settings: SettingsResponse | null
} | null>(null)

export function useCurrency() {
  const context = useContext(CurrencyContext)
  if (context === null) {
    throw new Error("useCurrency 必须在 CurrencyProvider 内使用")
  }
  return context
}
