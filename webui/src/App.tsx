import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import { HashRouter, Route, Routes } from "react-router"

import { AppSidebar } from "@/components/layout/app-sidebar"
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
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ErrorsPage } from "@/pages/errors-page"
import { OverviewPage } from "@/pages/overview-page"
import { RequestsPage } from "@/pages/requests-page"
import { ThreadDetailPage } from "@/pages/thread-detail-page"
import { ThreadsPage } from "@/pages/threads-page"
import { onUnauthorized, setToken } from "@/lib/api"

export default function App() {
  return (
    <TooltipProvider>
      <AuthGate>
        <HashRouter>
          <SidebarProvider>
            <AppSidebar />
            <SidebarInset>
              <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
                <SidebarTrigger />
                <Separator orientation="vertical" className="h-5" />
                <span className="text-sm text-muted-foreground">Codex WebUI</span>
              </header>
              <main className="p-4 md:p-6">
                <Routes>
                  <Route path="/" element={<OverviewPage />} />
                  <Route path="/threads" element={<ThreadsPage />} />
                  <Route path="/threads/:id" element={<ThreadDetailPage />} />
                  <Route path="/requests" element={<RequestsPage />} />
                  <Route path="/errors" element={<ErrorsPage />} />
                </Routes>
              </main>
            </SidebarInset>
          </SidebarProvider>
        </HashRouter>
      </AuthGate>
    </TooltipProvider>
  )
}

function AuthGate({ children }: { children: ReactNode }) {
  const [unauthorized, setUnauthorized] = useState(false)
  const [token, setTokenValue] = useState("")

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
            value={token}
            onChange={(event) => setTokenValue(event.target.value)}
            placeholder="访问令牌"
          />
          <Button
            disabled={token.trim() === ""}
            onClick={() => {
              setToken(token.trim())
              window.location.reload()
            }}
          >
            进入
          </Button>
        </CardContent>
      </Card>
    </main>
  )
}
