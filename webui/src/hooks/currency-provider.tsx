import { useCallback, useEffect, useState } from "react"
import type { ReactNode } from "react"

import { CurrencyContext } from "@/hooks/currency-context"
import type { DisplayCurrency } from "@/lib/format"
import { fetchSettings } from "@/lib/api"
import { useApi } from "@/hooks/use-api"

const STORAGE_KEY = "codex-webui:currency"
const PREFERENCE_KEY = "codex-webui:currency-preference"

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [storedCurrency, setStoredCurrency] = useState<DisplayCurrency | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored === "cny" || stored === "usd" ? stored : null
    } catch {
      return null
    }
  })
  const [currencyOverride, setCurrencyOverride] = useState(() => {
    try {
      return localStorage.getItem(PREFERENCE_KEY) === "explicit"
    } catch {
      return false
    }
  })
  const settingsRequest = useApi(fetchSettings, [])
  // 没有显式本地覆盖时直接使用服务端当前默认值；旧版本遗留的币种值只在
  // 服务端尚未返回时作为临时回退，避免继续把历史默认值固定成覆盖项。
  const currency = currencyOverride && storedCurrency !== null
    ? storedCurrency
    : settingsRequest.data?.currency ?? storedCurrency

  const setCurrency = useCallback((next: DisplayCurrency) => {
    setCurrencyOverride(true)
    setStoredCurrency(next)
  }, [])

  useEffect(() => {
    if (!currencyOverride || storedCurrency === null) return
    try {
      localStorage.setItem(STORAGE_KEY, storedCurrency)
      localStorage.setItem(PREFERENCE_KEY, "explicit")
    } catch {
      // 存储不可用时仅本次会话内保留
    }
  }, [currencyOverride, storedCurrency])

  return (
    <CurrencyContext.Provider
      value={{
        currency,
        setCurrency,
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
