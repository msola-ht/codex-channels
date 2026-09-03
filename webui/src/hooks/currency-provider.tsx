import { useEffect, useState } from "react"
import type { ReactNode } from "react"

import { CurrencyContext } from "@/hooks/currency-context"
import type { DisplayCurrency } from "@/lib/format"
import { fetchSettings } from "@/lib/api"
import { useApi } from "@/hooks/use-api"

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
  const settingsRequest = useApi(fetchSettings, [])

  useEffect(() => {
    if (currency !== null) {
      try {
        localStorage.setItem(STORAGE_KEY, currency)
      } catch {
        // 存储不可用时仅本次会话内保留
      }
    }
  }, [currency])

  useEffect(() => {
    const settings = settingsRequest.data
    if (settings === null) return
    setCurrencyState((current) => current ?? settings.currency)
  }, [settingsRequest.data])

  return (
    <CurrencyContext.Provider
      value={{
        currency,
        setCurrency: setCurrencyState,
        settings: settingsRequest.data,
        settingsLoading: settingsRequest.loading,
        settingsError: settingsRequest.error,
        refetchSettings: settingsRequest.refetch,
      }}
    >
      {children}
    </CurrencyContext.Provider>
  )
}
