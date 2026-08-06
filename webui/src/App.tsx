import { useEffect } from "react"
import { HashRouter, Link, Route, Routes, useLocation } from "react-router"

import { AuthGate } from "@/components/layout/auth-gate"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { ModeToggle } from "@/components/layout/mode-toggle"
import { CurrencyToggle } from "@/components/metrics/currency-toggle"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CurrencyProvider } from "@/hooks/currency-provider"
import { useCurrency } from "@/hooks/currency-context"
import { fetchSettings } from "@/lib/api"
import { ErrorsPage } from "@/pages/errors-page"
import { OverviewPage } from "@/pages/overview-page"
import { RequestsPage } from "@/pages/requests-page"
import { ThreadDetailPage } from "@/pages/thread-detail-page"
import { ThreadsPage } from "@/pages/threads-page"

function pageTitle(pathname: string): string {
  if (pathname.startsWith("/threads/")) return "Thread 详情"
  if (pathname === "/threads") return "Threads"
  if (pathname === "/requests") return "请求"
  if (pathname === "/errors") return "错误"
  return "概览"
}

function Layout() {
  const { pathname } = useLocation()
  const { currency, setCurrency } = useCurrency()

  useEffect(() => {
    if (currency !== null) return
    const controller = new AbortController()
    fetchSettings(controller.signal)
      .then((settings) => {
        if (!controller.signal.aborted) {
          setCurrency(settings.currency)
        }
      })
      .catch(() => {
        // 初始化失败时保持跟随服务端配置，不阻塞页面
      })
    return () => controller.abort()
  }, [currency, setCurrency])

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-16 shrink-0 items-center gap-2 border-b px-3">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="h-5" />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink asChild>
                  <Link to="/">Codex WebUI</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
              <BreadcrumbItem>
                <BreadcrumbPage>{pageTitle(pathname)}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="ml-auto flex items-center gap-1">
            <CurrencyToggle value={currency} onChange={setCurrency} />
            <ModeToggle />
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-3">
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
  )
}

export default function App() {
  return (
    <TooltipProvider>
      <CurrencyProvider>
        <AuthGate>
          <HashRouter>
            <Layout />
          </HashRouter>
        </AuthGate>
      </CurrencyProvider>
    </TooltipProvider>
  )
}
