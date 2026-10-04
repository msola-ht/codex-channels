import { useEffect, useRef, useState } from "react"
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

export function AuthGate({ children, initialTokenStorageFailed = false }: { children: ReactNode; initialTokenStorageFailed?: boolean }) {
  const { t, language, setLanguage } = useTranslation()
  const [unauthorized, setUnauthorized] = useState(initialTokenStorageFailed)
  const [token, setTokenValue] = useState("")
  const [error, setError] = useState<MessageKey | null>(initialTokenStorageFailed ? "auth.storageFailed" : null)
  const [submitting, setSubmitting] = useState(false)
  const operation = useRef<AbortController | null>(null)

  useEffect(() => onUnauthorized(() => setUnauthorized(true)), [])
  useEffect(() => () => operation.current?.abort(), [])

  const authenticate = async () => {
    const candidate = token.trim()
    if (!candidate || operation.current !== null) return
    const current = new AbortController()
    operation.current = current
    const timeout = AbortSignal.timeout(30_000)
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch(`${API_PREFIX}/threads`, {
        headers: { authorization: `Bearer ${candidate}` },
        signal: AbortSignal.any([current.signal, timeout]),
      })
      if (current.signal.aborted) return
      if (!response.ok) {
        setError(response.status === 401 || response.status === 403 ? "auth.invalidToken" : "auth.serviceFailed")
        return
      }
      if (!setToken(candidate)) {
        setError("auth.storageFailed")
        return
      }
      window.location.reload()
    } catch {
      if (!current.signal.aborted) setError(timeout.aborted ? "auth.timeout" : "auth.connectFailed")
    } finally {
      if (operation.current === current) {
        operation.current = null
        if (!current.signal.aborted) setSubmitting(false)
      }
    }
  }

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
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void authenticate() }}>
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
            type="submit"
            disabled={token.trim() === "" || submitting}
          >
            {submitting ? <Spinner data-icon="inline-start" aria-label={t("common.loading")} /> : null}
            {submitting ? t("auth.verifying") : t("auth.submit")}
          </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
