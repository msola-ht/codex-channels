import { useEffect, useState } from "react"
import type { ReactNode } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { LanguageToggle } from "@/components/metrics/language-toggle"
import type { MessageKey } from "@/lib/i18n/messages"
import { useTranslation } from "@/hooks/use-translation"
import { API_PREFIX, onUnauthorized, setToken } from "@/lib/api"

export function AuthGate({ children }: { children: ReactNode }) {
  const { t, language, setLanguage } = useTranslation()
  const [unauthorized, setUnauthorized] = useState(false)
  const [token, setTokenValue] = useState("")
  const [error, setError] = useState<MessageKey | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => onUnauthorized(() => setUnauthorized(true)), [])

  if (!unauthorized) return children

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex justify-end"><LanguageToggle value={language} onChange={setLanguage} /></div>
          <CardTitle>{t("auth.tokenRequired")}</CardTitle>
          <CardDescription>
            {t("auth.tokenDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Alert>
            <AlertTitle>{t("auth.restricted")}</AlertTitle>
            <AlertDescription>
              {t("auth.restrictedDescription")}
            </AlertDescription>
          </Alert>
          <Field data-invalid={error !== null} data-disabled={submitting}>
            <FieldLabel htmlFor="auth-token">{t("auth.tokenLabel")}</FieldLabel>
            <Input
              id="auth-token"
              type="password"
              aria-invalid={error !== null}
              aria-describedby={error === null ? undefined : "auth-token-error"}
              value={token}
              disabled={submitting}
              onChange={(event) => {
                setTokenValue(event.target.value)
                setError(null)
              }}
              placeholder={t("auth.tokenPlaceholder")}
            />
            <FieldError id="auth-token-error">{error === null ? null : t(error)}</FieldError>
          </Field>
          <Button
            disabled={token.trim() === "" || submitting}
            onClick={async () => {
              const candidate = token.trim()
              setSubmitting(true)
              setError(null)
              try {
                const response = await fetch(`${API_PREFIX}/threads`, {
                  headers: { authorization: `Bearer ${candidate}` },
                })
                if (!response.ok) {
                  setError("auth.invalidToken")
                  return
                }
                setToken(candidate)
                window.location.reload()
              } catch {
                setError("auth.connectFailed")
              } finally {
                setSubmitting(false)
              }
            }}
          >
            {submitting ? <Spinner data-icon="inline-start" /> : null}
            {submitting ? t("auth.verifying") : t("auth.submit")}
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
