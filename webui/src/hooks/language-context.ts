import { createContext, useContext } from "react"

import type { DisplayLanguage } from "@/lib/format"

export const LanguageContext = createContext<{
  language: DisplayLanguage
  setLanguage: (language: DisplayLanguage) => void
} | null>(null)

export function useLanguage() {
  const context = useContext(LanguageContext)
  if (context === null) {
    throw new Error("useLanguage 必须在 LanguageProvider 内使用")
  }
  return context
}
