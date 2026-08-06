import { createContext, useContext } from "react"

import type { DisplayCurrency } from "@/lib/format"

export const CurrencyContext = createContext<{
  currency: DisplayCurrency
  setCurrency: (currency: DisplayCurrency) => void
} | null>(null)

export function useCurrency() {
  const context = useContext(CurrencyContext)
  if (context === null) {
    throw new Error("useCurrency 必须在 CurrencyProvider 内使用")
  }
  return context
}
