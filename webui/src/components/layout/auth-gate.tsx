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
import { API_PREFIX, onUnauthorized, setToken } from "@/lib/api"

export function AuthGate({ children }: { children: ReactNode }) {
  const [unauthorized, setUnauthorized] = useState(false)
  const [token, setTokenValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => onUnauthorized(() => setUnauthorized(true)), [])

  if (!unauthorized) return children

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>需要访问令牌</CardTitle>
          <CardDescription>
            请输入访问令牌（codexc config 的 WebUI 设置或 --token 配置）
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Alert>
            <AlertTitle>访问受限</AlertTitle>
            <AlertDescription>
              服务器开启了访问令牌保护，验证通过后才能查看指标。
            </AlertDescription>
          </Alert>
          <Field data-invalid={error !== null} data-disabled={submitting}>
            <FieldLabel htmlFor="auth-token">访问令牌</FieldLabel>
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
              placeholder="访问令牌"
            />
            <FieldError id="auth-token-error">{error}</FieldError>
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
                  setError("令牌无效，请检查后重试")
                  return
                }
                setToken(candidate)
                window.location.reload()
              } catch {
                setError("无法连接服务，请稍后重试")
              } finally {
                setSubmitting(false)
              }
            }}
          >
            {submitting ? <Spinner data-icon="inline-start" /> : null}
            {submitting ? "验证中…" : "进入"}
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
