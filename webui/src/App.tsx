import { HashRouter, Route, Routes } from "react-router"

import { AuthGate } from "@/components/layout/auth-gate"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ErrorsPage } from "@/pages/errors-page"
import { OverviewPage } from "@/pages/overview-page"
import { RequestsPage } from "@/pages/requests-page"
import { ThreadDetailPage } from "@/pages/thread-detail-page"
import { ThreadsPage } from "@/pages/threads-page"

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
