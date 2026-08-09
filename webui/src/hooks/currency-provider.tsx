import { useEffect, useState } from "react"
import type { ReactNode } from "react"

import { CurrencyContext } from "@/hooks/currency-context"
import type { DisplayCurrency } from "@/lib/format"

const STORAGE_KEY = "codex-webui:currency"

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currency, setCurrencyState] = useState<DisplayCurrency | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored === "cny" || stored === "usd" ? stored : null
    } catch {
      return null
    }
  })

  useEffect(() => {
    if (currency !== null) {
      try {
        localStorage.setItem(STORAGE_KEY, currency)
      } catch {
        // 存储不可用时仅本次会话内保留
      }
    }
  }, [currency])

  return (
    <CurrencyContext.Provider
      value={{ currency, setCurrency: setCurrencyState }}
    >
      {children}
    </CurrencyContext.Provider>
  )
}
