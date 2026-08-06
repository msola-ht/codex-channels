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
import { Input } from "@/components/ui/input"
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
            请输入启动 codexc webui 时设置的 --token
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Alert>
            <AlertTitle>访问受限</AlertTitle>
            <AlertDescription>
              服务器开启了访问令牌保护，验证通过后才能查看指标。
            </AlertDescription>
          </Alert>
          <Input
            type="password"
            aria-label="访问令牌"
            value={token}
            onChange={(event) => setTokenValue(event.target.value)}
            placeholder="访问令牌"
          />
          {error === null ? null : (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
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
            {submitting ? "验证中…" : "进入"}
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
