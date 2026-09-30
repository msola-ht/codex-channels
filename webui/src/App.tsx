import { translateApiError } from "@/lib/i18n/translate"
import { lazy, Suspense, useEffect, useState } from "react"
import { HashRouter, Link, Route, Routes, useLocation } from "react-router"

import { AuthGate } from "@/components/layout/auth-gate"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { ModeToggle } from "@/components/layout/mode-toggle"
import { LanguageToggle } from "@/components/metrics/language-toggle"
import { ErrorBanner } from "@/components/metrics/error-banner"
import { TruncatedText } from "@/components/metrics/data-table"
import { Button } from "@/components/ui/button"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LanguageProvider } from "@/hooks/language-provider"
import { useTranslation } from "@/hooks/use-translation"
import { ServerTimeContext, useServerTime } from "@/hooks/use-server-time"
import type { Translate } from "@/lib/i18n/messages"
import { observeServerClock, type ServerClockSnapshot } from "@/lib/server-time"
import { formatClockTime, formatTimeZoneLabel } from "@/lib/format"
import type { MetricsRangeQuery } from "@/lib/types"

const RelayPage = lazy(() => import("@/pages/relay-page").then(module => ({ default: module.RelayPage })))

const ConsolePage = lazy(() =>
  import("@/pages/console-page").then((module) => ({ default: module.ConsolePage })))
const ErrorsPage = lazy(() =>
  import("@/pages/errors-page").then((module) => ({ default: module.ErrorsPage })))
const RequestsPage = lazy(() =>
  import("@/pages/requests-page").then((module) => ({ default: module.RequestsPage })))
const ThreadDetailPage = lazy(() =>
  import("@/pages/thread-detail-page").then((module) => ({ default: module.ThreadDetailPage })))
const ThreadsPage = lazy(() =>
  import("@/pages/threads-page").then((module) => ({ default: module.ThreadsPage })))
const SettingsPage = lazy(() =>
  import("@/pages/settings-page").then((module) => ({ default: module.SettingsPage })))
const TrafficPage = lazy(() =>
  import("@/pages/traffic-page").then((module) => ({ default: module.TrafficPage })))

function pageTitle(pathname: string, t: Translate): string {
  if (pathname.startsWith("/threads/")) return t("pages.threadDetail")
  if (pathname === "/threads") return t("pages.threads")
  if (pathname === "/requests") return t("pages.requests")
  if (pathname === "/traffic") return t("pages.traffic")
  if (pathname === "/errors") return t("pages.errors")
  if (pathname === "/relay") return t("relay.title")
  if (pathname === "/settings") return t("pages.settings")
  return t("pages.console")
}

function BreadcrumbTrail({ pathname }: { pathname: string }) {
  const { search } = useLocation()
  const { t } = useTranslation()
  const params = new URLSearchParams(search)
  if (pathname === "/traffic" && params.has("id")) {
    for (const key of ["id", "exchangeLabel", "exchangeSession", "traceOffset"]) params.delete(key)
    return <>
      <BreadcrumbItem className="hidden md:block"><BreadcrumbLink asChild><Link to={{ pathname: "/traffic", search: params.toString() }}>{t("pages.traffic")}</Link></BreadcrumbLink></BreadcrumbItem>
      <BreadcrumbSeparator className="hidden md:block" />
      <BreadcrumbItem><BreadcrumbPage>{t("pages.trafficDetail")}</BreadcrumbPage></BreadcrumbItem>
    </>
  }
  if (pathname.startsWith("/threads/")) {
    const threadId = decodeURIComponent(pathname.slice("/threads/".length))
    return (
      <>
        <BreadcrumbItem className="hidden md:block">
          <BreadcrumbLink asChild>
            <Link to="/threads">{t("pages.threads")}</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="hidden md:block" />
        <BreadcrumbItem>
          <BreadcrumbPage>
            <TruncatedText text={threadId} className="max-w-56" />
          </BreadcrumbPage>
        </BreadcrumbItem>
      </>
    )
  }
  return (
    <BreadcrumbItem>
      <BreadcrumbPage>{pageTitle(pathname, t)}</BreadcrumbPage>
    </BreadcrumbItem>
  )
}

function ServerClock({ snapshot, syncFailed }: { snapshot: ServerClockSnapshot; syncFailed: boolean }) {
  const [currentTime, setCurrentTime] = useState(snapshot.nowMs)
  const { t } = useTranslation()
  useEffect(() => observeServerClock(snapshot, setCurrentTime, document), [snapshot])
  return <><time dateTime={new Date(currentTime).toISOString()} className="tabular-nums">{formatClockTime(currentTime)}</time>{" · "}{formatTimeZoneLabel(currentTime)}{syncFailed ? ` · ${t("shell.timeSyncPending")}` : ""}</>
}

function Layout() {
  const { pathname } = useLocation()
  const { t, language, setLanguage } = useTranslation()
  const [consoleRange, setConsoleRange] = useState<MetricsRangeQuery>({ range: "30d" })
  const time = useServerTime()

  if (time.data === null) {
    return <div className="flex flex-col gap-3 p-4">
      <div className="flex justify-end"><LanguageToggle value={language} onChange={setLanguage} /></div>
      {time.error === null ? <p>{t("shell.timeZoneLoading")}</p> : <>
        <ErrorBanner error={translateApiError(t, time.error, time.errorCode)} />
        <Button variant="outline" onClick={time.refetch}>{t("shell.timeZoneReload")}</Button>
      </>}
    </div>
  }

  return (
    <ServerTimeContext.Provider value={time.data}>
      <SidebarProvider className="min-h-0 min-w-0">
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <header className="flex h-16 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger aria-label={t("common.toggleSidebar")} className="-ml-1" />
            <Breadcrumb aria-label={t("common.breadcrumb")} className="min-w-0 flex-1">
              <BreadcrumbList className="flex-nowrap">
                <BreadcrumbItem className="hidden md:block">
                  <BreadcrumbLink asChild>
                    <Link to="/">Codex WebUI</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator className="hidden md:block" />
                <BreadcrumbTrail pathname={pathname} />
              </BreadcrumbList>
            </Breadcrumb>
            <div className="flex shrink-0 items-center gap-1">
              <span className="hidden text-xs text-muted-foreground lg:inline" title={t("shell.timeZoneHint")}>
                <ServerClock snapshot={time.data} syncFailed={time.error !== null} />
              </span>
              <LanguageToggle value={language} onChange={setLanguage} />
              <ModeToggle />
            </div>
          </header>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto p-3">
            <p className="mb-3 text-xs text-muted-foreground lg:hidden">
              <ServerClock snapshot={time.data} syncFailed={time.error !== null} />
            </p>
            <Suspense fallback={<div className="p-4 text-sm text-muted-foreground">{t("common.loading")}</div>}>
              <Routes>
                <Route path="/" element={<ConsolePage range={consoleRange} onRangeChange={setConsoleRange} />} />
                <Route path="/threads" element={<ThreadsPage />} />
                <Route path="/threads/:id" element={<ThreadDetailPage />} />
                <Route path="/requests" element={<RequestsPage />} />
                <Route path="/traffic" element={<TrafficPage />} />
                <Route path="/errors" element={<ErrorsPage />} />
                <Route path="/relay" element={<RelayPage />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </Suspense>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </ServerTimeContext.Provider>
  )
}

export default function App() {
  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={0}>
      <LanguageProvider>
        <AuthGate>
          <HashRouter>
            <Layout />
          </HashRouter>
        </AuthGate>
      </LanguageProvider>
    </TooltipProvider>
  )
}
