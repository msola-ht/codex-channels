import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "@/hooks/use-translation"
import type { OpenAiModelCatalogController } from "@/hooks/use-openai-model-catalog"
import type { OpenAiModelRefreshResult } from "@/lib/types"
import { formatTimestamp } from "@/lib/format"
import { SettingsEmpty, SettingsError } from "@/components/settings/settings-feedback"
import { ManagementConfirmationDialog, SettingsRow, modelOperationDialogClassName } from "@/components/settings/settings-controls"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ModelContextWindowFields } from "@/components/settings/model-context-window-fields"
import { ModelDetailFields, OpenAiModelDetails } from "@/components/settings/openai-model-details"
import { ModelApprovals, ModelServiceTiers, type ModelCatalogGroup } from "@/components/settings/model-catalog-columns"
import { ProviderWebSearchProbeDialog, type ProviderWebSearchProbeTarget } from "@/components/settings/provider-web-search-probe-dialog"

export function OpenAiModelCatalogCard({ catalog, disabled = false, configurationRevision, renderCatalog, defaultBadges, editDefaultsAction }: {
  catalog: OpenAiModelCatalogController
  disabled?: boolean
  configurationRevision: string | null
  renderCatalog: (group: ModelCatalogGroup) => ReactNode
  defaultBadges?: ReactNode
  editDefaultsAction?: ReactNode
}) {
  const { t, language } = useTranslation()
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const actionTriggers = useRef(new Map<string, HTMLButtonElement>())
  const [focusAfterReadback, setFocusAfterReadback] = useState<{ model: string | null } | null>(null)
  useEffect(() => {
    if (focusAfterReadback === null || catalog.loading || catalog.busy || disabled) return
    const target = focusAfterReadback.model === null ? null : actionTriggers.current.get(focusAfterReadback.model)
    const focusTarget = target && !target.disabled ? target : headingRef.current
    focusTarget?.focus()
    setFocusAfterReadback(null)
  }, [focusAfterReadback, catalog.loading, catalog.busy, disabled])
  const contextPreviewRef = useRef<HTMLButtonElement | null>(null)
  const [selectedModel, setSelectedModel] = useState<{ id: string; scope: string } | null>(null)
  const [webSearchTarget, setWebSearchTarget] = useState<(ProviderWebSearchProbeTarget & { scope: string; configurationRevision: string | null }) | null>(null)
  const webSearchStale = webSearchTarget !== null && (catalog.data?.revision !== webSearchTarget.revision
    || catalog.data?.scope !== webSearchTarget.scope
    || configurationRevision !== webSearchTarget.configurationRevision
    || !catalog.data?.models.some(model => model.model === webSearchTarget.model))
  const detailModel = !catalog.loading && !catalog.error && catalog.data?.scope === selectedModel?.scope
    ? catalog.data?.models.find(model => model.model === selectedModel?.id) ?? null : null
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US")
  const context = (value: number | null) => value === null ? t("common.unknown") : numbers.format(value)
  const pending = catalog.pendingPreview?.preview
  const confirm = async () => {
    const model = pending?.kind === "context" ? pending.value.model : null
    if (await catalog.confirm() !== null) setFocusAfterReadback({ model })
  }
  const result = catalog.actionResult?.value
  const warning = catalog.writeUnconfirmed || result?.consistency === "unknown"
  const metadata = catalog.data
  const showMetadata = metadata !== null && !catalog.loading && !catalog.error
  const refreshResult = catalog.actionResult?.kind === "refresh" ? catalog.actionResult.value : null
  const unchanged = catalog.actionResult?.kind === "context" && catalog.actionResult.value.status === "unchanged"

  const group: ModelCatalogGroup = {
    id: "openai",
    header: <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 ref={headingRef} tabIndex={-1} className="font-medium">{t("openAiModelCatalog.title")}</h3>
          {showMetadata && <Tooltip>
            <TooltipTrigger render={<Badge variant="outline" tabIndex={0} />} aria-label={`${t("openAiModelCatalog.clientVersion")}: ${metadata.clientVersion ?? t("common.unknown")}`}>{metadata.clientVersion ?? t("common.unknown")}</TooltipTrigger>
            <TooltipContent>{t("openAiModelCatalog.clientVersion")}</TooltipContent>
          </Tooltip>}
          {defaultBadges}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {showMetadata && <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} className="text-sm text-muted-foreground tabular-nums" />}>
              {t("openAiModelCatalog.fetchedAt")}: {formatTimestamp(Date.parse(metadata.fetchedAt))}
            </TooltipTrigger>
            <TooltipContent>{t("openAiModelCatalog.metadataHint")}</TooltipContent>
          </Tooltip>}
          {editDefaultsAction}
          <Button variant="outline" disabled={disabled || catalog.locked || catalog.draft !== null || catalog.data === null || webSearchTarget !== null} onClick={() => void catalog.previewRefresh()}>{catalog.busy && !catalog.draft && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("openAiModelCatalog.refreshConfigured")}</Button>
        </div>
      </div>,
    models: !catalog.loading && !catalog.error ? catalog.data?.models ?? [] : [],
    onSelect: model => { if (metadata) setSelectedModel({ id: model.model, scope: metadata.scope }) },
    renderAction: model => <DropdownMenu><DropdownMenuTrigger ref={node => { if (node) actionTriggers.current.set(model.model, node); else actionTriggers.current.delete(model.model) }} render={<Button variant="outline" size="sm" />} onFocus={event => { actionTriggerRef.current = event.currentTarget }} onPointerDown={event => { actionTriggerRef.current = event.currentTarget }} disabled={disabled || catalog.locked || catalog.draft !== null || webSearchTarget !== null}>{t("modelManagement.actions")}</DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-2rem)]" finalFocus={catalog.draft !== null || webSearchTarget !== null ? false : undefined}><DropdownMenuGroup>
          <DropdownMenuItem disabled={disabled || catalog.locked || catalog.draft !== null || metadata === null} onClick={() => {
            if (disabled || catalog.locked || catalog.draft !== null || metadata === null) return
            setWebSearchTarget({ model: model.model, displayName: model.displayName, revision: metadata.revision, scope: metadata.scope, configurationRevision, providers: ["openai"] })
          }}>{t("modelProbe.detectWebSearch")}</DropdownMenuItem>
          <DropdownMenuItem disabled={!model.editable || disabled || catalog.locked || catalog.draft !== null} onClick={() => catalog.startEdit(model)}>{t("openAiModelCatalog.adjustContext")}</DropdownMenuItem>
        </DropdownMenuGroup></DropdownMenuContent></DropdownMenu>,
    content: catalog.loading ? <div aria-busy="true"><Skeleton className="h-28 w-full" /></div>
        : catalog.error ? <SettingsError message={catalog.error} retry={catalog.refresh} />
          : catalog.data && catalog.data.models.length === 0
            ? <SettingsEmpty>{t("openAiModelCatalog.empty")}</SettingsEmpty>
            : undefined,
    footer: <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{t("openAiModelCatalog.hint")}</p>
      <p className="text-sm text-muted-foreground">{t("openAiModelCatalog.refreshHint")}</p>
      {catalog.changedModels.length > 0 && <Alert><AlertDescription><p>{t("openAiModelCatalog.cacheChanged")}</p><p className="break-all">{catalog.changedModels.join(", ")}</p></AlertDescription></Alert>}
      {catalog.storageUnavailable && <Alert><AlertDescription>{t("openAiModelCatalog.trackingUnavailable")}</AlertDescription></Alert>}
      {!catalog.draft && catalog.actionError && <Alert variant="destructive"><AlertDescription>{catalog.actionError}</AlertDescription></Alert>}
      {(result || catalog.writeUnconfirmed) && <Alert variant={warning ? "destructive" : "default"}><AlertDescription className="flex flex-col gap-2" aria-live="polite">
        <p>{catalog.writeUnconfirmed ? t("openAiModelCatalog.writeUnknown") : result?.consistency === "unknown" ? t("openAiModelCatalog.readbackUnknown") : refreshResult ? t(refreshResult.cacheChanged ? "openAiModelCatalog.configuredChanged" : "openAiModelCatalog.configuredUnchanged") : t(unchanged ? "openAiModelCatalog.unchanged" : "openAiModelCatalog.saved")}</p>
        {refreshResult && !refreshResult.outputMatchesCache && <p>{t("openAiModelCatalog.outputDiffers")}</p>}
        {result?.backupCreated && <p>{t("openAiModelCatalog.backupCreated")}</p>}
        {!unchanged && <p>{t("openAiModelCatalog.activation")}</p>}
        {result?.auditStatus === "degraded" && <p>{t("settingsUi.auditDegraded")}</p>}
        {catalog.readbackRequired && <p>{t("settingsUi.readbackUnknown")}</p>}
      </AlertDescription></Alert>}
      {refreshResult && refreshResult.consistency === "confirmed" && <CatalogDifferences differences={refreshResult.differences} />}
    </div>,
  }

  return <>{renderCatalog(group)}
    {webSearchTarget && <ProviderWebSearchProbeDialog target={webSearchTarget} stale={webSearchStale} disabled={disabled || catalog.locked} finalFocus={actionTriggerRef} onClose={() => setWebSearchTarget(null)} />}
    <OpenAiModelDetails model={detailModel} revision={catalog.data?.revision ?? null} open={selectedModel !== null} loading={catalog.loading} onClose={() => setSelectedModel(null)} onReload={catalog.refresh} />
    <Dialog open={catalog.draft !== null && pending === undefined} disablePointerDismissal onOpenChange={(open, details) => { if (catalog.busy) { details.cancel(); return }; if (!open) catalog.closeEdit() }}>
      <DialogContent finalFocus={pending === undefined ? actionTriggerRef : false} closeLabel={t("modelManagement.cancel")} showCloseButton={!catalog.busy} className={modelOperationDialogClassName}>
        <DialogHeader><DialogTitle>{t("openAiModelCatalog.editContext")}</DialogTitle><DialogDescription>{t("openAiModelCatalog.editHint")}</DialogDescription></DialogHeader>
        {catalog.draft && <div className="flex flex-col gap-6">
          <ModelContextWindowFields presetGroup="openai" displayName={catalog.draft.displayName} maxContextWindow={catalog.draft.maxContextWindow} value={catalog.draft.value} preset={catalog.draft.preset} valid={catalog.valid} disabled={catalog.locked || disabled} onPresetChange={catalog.changePreset} onValueChange={catalog.changeValue} />
          {catalog.stale && <Alert variant="destructive"><AlertDescription>{t("openAiModelCatalog.stale")}</AlertDescription></Alert>}
          {catalog.error && <Alert variant="destructive"><AlertDescription>{catalog.error}</AlertDescription></Alert>}
          {catalog.actionError && <Alert variant="destructive"><AlertDescription>{catalog.actionError}</AlertDescription></Alert>}
        </div>}
        <DialogFooter><Button variant="outline" disabled={catalog.busy} onClick={catalog.closeEdit}>{t("modelManagement.cancel")}</Button><Button ref={contextPreviewRef} disabled={disabled || catalog.locked || catalog.stale || !catalog.valid || catalog.draft?.value === String(catalog.draft?.previousContextWindow)} onClick={() => void catalog.preview()}>{catalog.busy && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("modelManagement.preview")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <ManagementConfirmationDialog finalFocus={() => { const preview = contextPreviewRef.current; return pending?.kind === "context" && preview?.isConnected && !preview.disabled ? preview : headingRef.current }} className={pending?.kind === "context" ? modelOperationDialogClassName : undefined} open={pending !== undefined} title={t(pending?.kind === "refresh" ? "openAiModelCatalog.configuredTitle" : "openAiModelCatalog.confirmTitle")} description={t(pending?.kind === "refresh" ? "openAiModelCatalog.configuredConfirmation" : "openAiModelCatalog.editHint")} saving={catalog.busy} loading={catalog.loading} confirmDisabled={disabled || catalog.readbackRequired || catalog.error !== null} confirmVariant={pending?.kind === "refresh" ? "destructive" : "default"} confirmLabel={t(pending?.kind === "refresh" ? "openAiModelCatalog.refreshConfigured" : "accountConfirmation.confirmWrite")} onConfirm={() => void confirm()} onCancel={catalog.cancel}>
      <div className="flex flex-col gap-4">
        {pending?.kind === "context" && <>
          <span>{pending.value.displayName}</span>
          <Separator />
          <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5"><dt className="text-muted-foreground">{t("openAiModelCatalog.previousContext")}</dt><dd>{context(pending.value.previousContextWindow)}</dd></div>
            <div className="flex min-w-0 flex-col gap-1.5"><dt className="text-muted-foreground">{t("openAiModelCatalog.nextContext")}</dt><dd>{context(pending.value.contextWindow)}</dd></div>
          </dl>
          <SettingsRow label={t("openAiModelCatalog.maxContext")} value={context(pending.value.maxContextWindow)} />
          <Separator />
          {pending.value.changed ? <><p>{t("openAiModelCatalog.backupHint")}</p><p>{t("openAiModelCatalog.activation")}</p></> : <p>{t("openAiModelCatalog.unchanged")}</p>}
        </>}
        {pending?.kind === "refresh" && <code>codex debug models</code>}
      </div>
    </ManagementConfirmationDialog>
  </>
}


function CatalogDifferences({ differences }: { differences: OpenAiModelRefreshResult["differences"] }) {
  const { t, language } = useTranslation()
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US")
  const value = (entry: OpenAiModelRefreshResult["differences"][number]["before"], other: OpenAiModelRefreshResult["differences"][number]["before"]) => entry === null
    ? <span>{t("openAiModelCatalog.absent")}</span>
    : <div className="flex flex-col gap-1">
      <span>{entry.displayName}</span>
      <span>{t("openAiModelCatalog.defaultContext")}: {entry.contextWindow === null ? t("common.unknown") : numbers.format(entry.contextWindow)}</span>
      <span>{t("openAiModelCatalog.maxContext")}: {entry.maxContextWindow === null ? t("common.unknown") : numbers.format(entry.maxContextWindow)}</span>
      <span>{t("openAiModelCatalog.reasoning")}: {entry.reasoningEfforts.join(", ") || t("common.unknown")}</span>
      <span>{t("openAiModelCatalog.defaultEffort", { effort: entry.defaultReasoningEffort ?? t("common.unknown") })}</span>
      <div className="flex flex-wrap items-center gap-2"><span>{t("openAiModelCatalog.acceleration")}:</span><ModelServiceTiers tiers={entry.serviceTiers} /></div>
      <div className="flex flex-wrap items-center gap-2"><span>{t("openAiModelCatalog.approvals")}:</span><ModelApprovals approvals={entry.approvals} /></div>
      <ModelDetailFields details={entry.details} compareWith={other?.details} />
    </div>
  return <div className="flex flex-col gap-2">
    <p className="text-sm text-muted-foreground">{t("openAiModelCatalog.comparisonHint")}</p>
    {differences.length === 0 ? <p>{t("openAiModelCatalog.noDifferences")}</p> : <Table aria-label={t("openAiModelCatalog.comparison")}>
      <TableHeader><TableRow><TableHead>{t("modelManagement.model")}</TableHead><TableHead>{t("openAiModelCatalog.before")}</TableHead><TableHead>{t("openAiModelCatalog.after")}</TableHead></TableRow></TableHeader>
      <TableBody>{differences.map(entry => <TableRow key={entry.model}>
        <TableCell>{entry.after?.displayName ?? entry.before?.displayName}</TableCell>
        <TableCell>{value(entry.before, entry.after)}</TableCell><TableCell>{value(entry.after, entry.before)}</TableCell>
      </TableRow>)}</TableBody>
    </Table>}
  </div>
}
