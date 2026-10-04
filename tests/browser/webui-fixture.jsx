import { StrictMode, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { HashRouter } from "react-router"
import App from "@/App"
import { AuthGate } from "@/components/layout/auth-gate"
import { PageErrorBoundary } from "@/components/layout/page-recovery"
import { RequestsTable } from "@/components/requests/requests-table"
import { ThreadTable } from "@/components/threads/thread-table"
import { useMetricsQuery } from "@/hooks/use-metrics-query"
import { ManagementConfirmationDialog } from "@/components/settings/settings-controls"
import { AppServerSettingsCard } from "@/components/settings/app-server-settings-card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { LanguageContext } from "@/hooks/language-context"
import { useApi } from "@/hooks/use-api"
import { useResetCredits } from "@/hooks/use-reset-credits"
import { useQueueEvents } from "@/hooks/use-queue-events"
import { useRelayCatalog } from "@/hooks/use-relay-catalog"
import { setServerTimeZone } from "@/lib/format"
import "@/index.css"

// Network is entirely local to this fixture. Deferred requests intentionally allow
// late resolution after abort, so cancellation guards are tested independently.
const scenario = new URLSearchParams(location.search).get("case")
const contract = window.__contract = { requests: [], queries: [], subscriptions: [], previews: [], changed: 0, cancelled: 0, catalogRefreshes: 0, catalogSuccesses: 0, status: 503, unexpected: [] }
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
window.fetch = (input, init = {}) => {
  const url = typeof input === "string" ? input : input.url
  const entry = { url, signal: init.signal }
  contract.requests.push(entry)
  if (url === "/api/v1/time") return Promise.resolve(json({ nowMs: 1700000000000, timeZone: "UTC" }))
  if (url === "/api/v1/management/accounts/openai/reset-credits") return Promise.resolve(json({ accountId: "fixture-account", availableCount: "0", credits: [] }))
  if (url === "/api/v1/management/accounts/refresh") return new Promise(resolve => { entry.resolve = () => resolve(json({ accounts: [] })) })
  if (url === "/api/v1/management/relay/catalog/update") return new Promise(resolve => {
    entry.resolve = (status = 200) => resolve(json(status === 200 ? { auditStatus: "recorded" } : { error: { code: "unavailable", message: "Fixture unavailable" } }, status))
  })
  if (url === "/api/v1/threads" && scenario === "auth") {
    if (!contract.hold) return Promise.resolve(json({}, contract.status))
    return new Promise((resolve, reject) => {
      entry.resolve = () => resolve(json({}))
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })
    })
  }
  contract.unexpected.push(url)
  return Promise.reject(new Error(`Unexpected fixture request: ${url}`))
}
setServerTimeZone("UTC")
const noop = () => {}

function AuthFixture() {
  const [mounted, setMounted] = useState(true)
  return <><button data-testid="unmount" onClick={() => setMounted(false)}>Unmount</button>
    {mounted && <AuthGate initialTokenStorageFailed><p>Authenticated</p></AuthGate>}</>
}

function SettingsFixture() {
  const [contextWindow, setContextWindow] = useState(null)
  const management = { loading: false, error: null, saving: false, pendingSetting: null, lastAppliedSetting: null, actionError: null,
    refetch: noop, cancelSetting: noop, confirmSetting: noop, previewSetting: input => { contract.previews.push(input) },
    codexSettings: { models: [], defaults: {}, compact: { contextWindow, autoCompactPercent: null }, defaultsEditable: true } }
  return <><button onClick={() => setContextWindow(1000)}>Refresh server snapshot</button>
    <AppServerSettingsCard management={management} section="context" /></>
}

function ApiFixture() {
  const [query, setQuery] = useState("A")
  const request = useApi(signal => new Promise(resolve => {
    contract.queries.push({ query, signal, resolve })
  }), [query])
  return <><button onClick={() => setQuery("B")}>Switch query</button>
    <output data-testid="api-state">{JSON.stringify({ data: request.data, loading: request.loading })}</output></>
}

function ResetHook() {
  const reset = useResetCredits({ onClose: noop, onChanged: () => { contract.changed++ } })
  return <><output data-testid="reset-ready">{String(!reset.management.loading)}</output>
    <button disabled={reset.management.loading} onClick={() => { void reset.refresh(); void reset.refresh() }}>Double refresh</button>
    <output data-testid="reset-busy">{String(reset.busy)}</output></>
}

function ResetFixture() {
  const [mounted, setMounted] = useState(true)
  return <><button data-testid="unmount" onClick={() => setMounted(false)}>Unmount</button>{mounted && <ResetHook />}</>
}

function CatalogHook() {
  const [revision, setRevision] = useState(0)
  const catalog = useRelayCatalog({ snapshot: { providers: [{ id: "clp-fixture", models: [] }], clineCatalog: { status: "missing" } }, blocked: false,
    onRefresh: () => { contract.catalogRefreshes++ }, onSuccess: () => { contract.catalogSuccesses++ } })
  return <><button onClick={() => setRevision(value => value + 1)}>Rerender catalog {revision}</button>
    <button onClick={() => { void catalog.download(); void catalog.download() }}>Download twice</button>
    <output data-testid="catalog-state">{JSON.stringify({ downloading: catalog.downloading, message: catalog.downloadMessage })}</output></>
}
function CatalogFixture() {
  const [mounted, setMounted] = useState(true)
  return <><button data-testid="unmount" onClick={() => setMounted(false)}>Unmount</button>{mounted && <CatalogHook />}</>
}

const watch = (signal, receive) => new Promise((_resolve, reject) => {
  contract.subscriptions.push({ signal })
  receive({ type: "heartbeat" })
  signal.addEventListener("abort", () => reject(signal.reason), { once: true })
})
function QueueHook() {
  const latest = useRef(0)
  const status = useQueueEvents(noop, false, true, latest, null, watch)
  return <output>{status}</output>
}
function QueueFixture() {
  const [mounted, setMounted] = useState(true)
  return <><button data-testid="unmount" onClick={() => setMounted(false)}>Unmount</button>{mounted && <QueueHook />}</>
}

function TabsFixture() {
  return <Tabs orientation="vertical" defaultValue="one"><TabsList>
    <TabsTrigger value="one">First</TabsTrigger><TabsTrigger value="two">Second</TabsTrigger>
  </TabsList><TabsContent value="one">First panel</TabsContent><TabsContent value="two">Second panel</TabsContent></Tabs>
}

const record = {
  id: "browser-request", source: "owned", provider: "openai", model: "model-test", recordedAtMs: 1700000000000,
  status: "completed", requestModel: "model-test", responseModel: "model-test", traffic: null,
  userAgent: "fixture-client", operation: "response", httpStatus: 200, inputTokens: 100, cachedInputTokens: 50,
  outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120, cacheHitRate: 0.5, firstTokenMs: 100,
  totalDurationMs: 1000, errorType: null, errorCode: null, errorMessage: null,
}

function RequestsFixture() {
  return <RequestsTable records={[record]} pageNumber={1} hasPrevious={false} hasNext={false}
    onPrevious={noop} onNext={noop} pageSize={10} onPageSizeChange={noop}
    sorting={[]} onSortingChange={noop} filter="" total={1} />
}

function ThreadsFixture() {
  const { query, pagination } = useMetricsQuery("all", "last")
  const [partial, setPartial] = useState(false)
  const thread = { threadId: "root-browser", provider: "openai", model: "model-test", reasoningEffort: null,
    agentPath: null, parentThreadId: null, parentTurnId: null, directSubagentCount: 2, turnCount: 1, requestCount: 1,
    inputTokens: 100, cachedInputTokens: partial ? null : 50, outputTokens: 20, totalTokens: 1080,
    subagentUsage: { inputTokens: 800, cachedInputTokens: partial ? null : 300, outputTokens: 160,
      cacheUsage: { inputTokens: 800, cachedInputTokens: 300, missingRequestCount: partial ? 1 : 0 } }, compact: null,
    cacheUsage: { inputTokens: 100, cachedInputTokens: 50, missingRequestCount: partial ? 1 : 0 }, sessionTiming: { knownDurationMs: null, missingTurnCount: 0, historyComplete: false },
    firstRequestStartedAtMs: 1700000000000, lastRecordedAtMs: 1700000000000 }
  return <><button onClick={() => setPartial(true)}>Simulate missing usage</button>
    <ThreadTable threads={[thread]} query={query} pagination={pagination({ total: 1, nextOffset: null })} /></>
}

function ConfirmationFixture() {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  return <><button onClick={() => setOpen(true)}>Open confirmation</button>
    <ManagementConfirmationDialog open={open} title="Fixture confirmation" description="Confirm fixture operation"
      saving={saving} onConfirm={() => setSaving(true)} onCancel={() => { contract.cancelled++; setOpen(false) }}>
      <p>Fixture changes</p>
    </ManagementConfirmationDialog></>
}

function ThrowingPage() { throw new Error("private-fixture-exception") }
function BoundaryFixture() {
  const [failed, setFailed] = useState(false)
  return <><button onClick={() => setFailed(true)}>Break page</button>
    <PageErrorBoundary>{failed ? <ThrowingPage /> : <p>Healthy page</p>}</PageErrorBoundary></>
}

const fixtures = { auth: AuthFixture, api: ApiFixture, reset: ResetFixture, tabs: TabsFixture,
  requests: RequestsFixture, threads: ThreadsFixture, confirmation: ConfirmationFixture, boundary: BoundaryFixture, queue: QueueFixture, catalog: CatalogFixture, settings: SettingsFixture }
const Fixture = fixtures[scenario]
createRoot(document.getElementById("root")).render(<StrictMode>{scenario === "app" ? <App /> :
  <LanguageContext.Provider value={{ language: "en", setLanguage: noop }}><TooltipProvider><HashRouter>
    <Fixture />
  </HashRouter></TooltipProvider></LanguageContext.Provider>}</StrictMode>)
