import { useEffect, useState } from "react"
import type { ReactNode } from "react"

import { LanguageContext } from "@/hooks/language-context"
import type { DisplayLanguage } from "@/lib/format"

const STORAGE_KEY = "codex-webui:language"

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<DisplayLanguage>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      return stored === "zh" || stored === "en" ? stored : "zh"
    } catch {
      return "zh"
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, language)
    } catch {
      // 存储不可用时仅本次会话内保留
    }
  }, [language])

  return (
    <LanguageContext.Provider value={{ language, setLanguage: setLanguageState }}>
      {children}
    </LanguageContext.Provider>
  )
}
