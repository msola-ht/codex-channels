import { useEffect, useState } from "react"
import type { ReactNode } from "react"

import { CurrencyContext } from "@/hooks/currency-context"
import type { DisplayCurrency } from "@/lib/format"
import { fetchSettings } from "@/lib/api"
import type { SettingsResponse } from "@/lib/types"

const STORAGE_KEY = "codex-webui:currency"

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null)
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

  useEffect(() => {
    const controller = new AbortController()
    fetchSettings(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return
        setSettings(next)
        setCurrencyState((current) => current ?? next.currency)
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  return (
    <CurrencyContext.Provider
      value={{ currency, setCurrency: setCurrencyState, settings }}
    >
      {children}
    </CurrencyContext.Provider>
  )
}
