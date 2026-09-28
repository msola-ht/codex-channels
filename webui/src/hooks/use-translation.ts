import { useCallback } from "react"

import { useLanguage } from "@/hooks/language-context"
import type { MessageKey, TranslateParams } from "@/lib/i18n/messages"
import { translate } from "@/lib/i18n/translate"

export function useTranslation() {
  const { language, setLanguage } = useLanguage()
  const t = useCallback(
    (key: MessageKey, params?: TranslateParams) => translate(language, key, params),
    [language],
  )
  return { t, language, setLanguage }
}
