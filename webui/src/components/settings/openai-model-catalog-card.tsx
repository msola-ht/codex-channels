import { useId, useState } from "react"
import { useTranslation } from "@/hooks/use-translation"
import type { OpenAiModelCatalogController } from "@/hooks/use-openai-model-catalog"
import type { OpenAiModelCatalogResponse, OpenAiModelRefreshResult } from "@/lib/types"
import { formatTimestamp } from "@/lib/format"
import { SettingsEmpty, SettingsError } from "@/components/settings/settings-feedback"
import { ManagementConfirmationDialog, SettingsRow } from "@/components/settings/settings-controls"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ModelDetailFields, OpenAiModelDetails } from "@/components/settings/openai-model-details"

export function OpenAiModelCatalogCard({ catalog, disabled = false }: {
  catalog: OpenAiModelCatalogController
  disabled?: boolean
}) {
  const { t, language } = useTranslation()
  const inputId = useId()
  const [selectedModel, setSelectedModel] = useState<{ id: string; scope: string } | null>(null)
  const detailModel = !catalog.loading && !catalog.error && catalog.data?.scope === selectedModel?.scope
    ? catalog.data?.models.find(model => model.model === selectedModel?.id) ?? null : null
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US")
  const context = (value: number | null) => value === null ? t("common.unknown") : numbers.format(value)
  const pending = catalog.pendingPreview?.preview
  const result = catalog.actionResult?.value
  const warning = catalog.writeUnconfirmed || result?.consistency === "unknown"
  const metadata = catalog.data
  const showMetadata = metadata !== null && !catalog.loading && !catalog.error
  const refreshResult = catalog.actionResult?.kind === "refresh" ? catalog.actionResult.value : null

  return <><Card>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>{t("openAiModelCatalog.title")}</CardTitle>
          {showMetadata && <Tooltip>
            <TooltipTrigger render={<Badge variant="outline" tabIndex={0} />} aria-label={`${t("openAiModelCatalog.clientVersion")}: ${metadata.clientVersion ?? t("common.unknown")}`}>{metadata.clientVersion ?? t("common.unknown")}</TooltipTrigger>
            <TooltipContent>{t("openAiModelCatalog.clientVersion")}</TooltipContent>
          </Tooltip>}
        </div>
        {showMetadata && <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} className="ml-auto text-sm text-muted-foreground tabular-nums" />}>
            {t("openAiModelCatalog.fetchedAt")}: {formatTimestamp(Date.parse(metadata.fetchedAt))}
          </TooltipTrigger>
          <TooltipContent>{t("openAiModelCatalog.metadataHint")}</TooltipContent>
        </Tooltip>}
      </div>
      <CardDescription>{t("openAiModelCatalog.hint")}</CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-4" aria-busy={catalog.loading}>
      {catalog.loading ? <Skeleton className="h-28 w-full" />
        : catalog.error ? <SettingsError message={catalog.error} retry={catalog.refresh} />
          : catalog.data && (catalog.data.models.length === 0
            ? <SettingsEmpty>{t("openAiModelCatalog.empty")}</SettingsEmpty>
            : <Table aria-label={t("openAiModelCatalog.title")}>
              <TableHeader><TableRow>
                <TableHead>{t("modelManagement.model")}</TableHead>
                <TableHead>{t("openAiModelDetails.fields.input_modalities")}</TableHead>
                <TableHead className="text-right">{t("openAiModelCatalog.defaultContext")}</TableHead>
                <TableHead className="text-right">{t("openAiModelCatalog.maxContext")}</TableHead>
                <TableHead className="text-right">{t("openAiModelDetails.fields.effective_context_window_percent")}</TableHead>
                <TableHead>{t("openAiModelCatalog.preferredEffort")}</TableHead>
                <TableHead>{t("openAiModelCatalog.acceleration")}</TableHead>
                <TableHead>{t("openAiModelCatalog.approvals")}</TableHead>
                <TableHead>{t("openAiModelCatalog.tools")}</TableHead>
                <TableHead className="text-right">{t("modelManagement.actions")}</TableHead>
              </TableRow></TableHeader>
              <TableBody>{catalog.data.models.map(model => <TableRow key={model.model}>
                <TableCell><Button variant="link" size="sm" className="px-0" aria-label={t("openAiModelDetails.open", { model: model.displayName })} onClick={() => { if (metadata) setSelectedModel({ id: model.model, scope: metadata.scope }) }}>{model.displayName}</Button></TableCell>
                <TableCell><div className="flex flex-wrap gap-1">{model.details.input_modalities === null
                  ? t("openAiModelDetails.undeclared")
                  : model.details.input_modalities.length === 0 ? t("openAiModelDetails.empty")
                    : model.details.input_modalities.map((modality, index) => <Badge key={`${modality}-${index}`} variant="outline">{modality === "text" ? t("openAiModelDetails.text") : modality === "image" ? t("openAiModelDetails.image") : modality}</Badge>)}</div></TableCell>
                <TableCell className="text-right tabular-nums">{context(model.contextWindow)}</TableCell>
                <TableCell className="text-right tabular-nums">{context(model.maxContextWindow)}</TableCell>
                <TableCell className="text-right tabular-nums">{model.details.effective_context_window_percent === null ? t("openAiModelDetails.undeclared") : `${numbers.format(model.details.effective_context_window_percent)}%`}</TableCell>
                <TableCell><Tooltip>
                  <TooltipTrigger render={<Badge variant="secondary" tabIndex={0} className="cursor-help" />}>
                    <span className="underline decoration-dotted underline-offset-2">{model.defaultReasoningEffort ?? t("common.unknown")}</span>
                  </TooltipTrigger>
                  <TooltipContent><div className="flex flex-col gap-2"><span>{t("openAiModelCatalog.reasoning")}</span><ul className="flex flex-col gap-1">
                    {model.reasoningEfforts.length === 0 ? <li>{t("common.unknown")}</li> : model.reasoningEfforts.map(effort => <li key={effort}>{effort === model.defaultReasoningEffort ? t("openAiModelCatalog.defaultEffort", { effort }) : effort}</li>)}
                  </ul></div></TooltipContent>
                </Tooltip></TableCell>
                <TableCell><ModelServiceTiers tiers={model.serviceTiers} /></TableCell>
                <TableCell><ModelApprovals approvals={model.approvals} /></TableCell>
                <TableCell><div className="flex flex-wrap gap-1">
                  <Tooltip>
                    <TooltipTrigger render={<Badge variant="outline" tabIndex={0} className="cursor-help" />}><span className="underline decoration-dotted underline-offset-2">{model.details.supports_search_tool === true ? t("openAiModelCatalog.searchLabel") : t("openAiModelCatalog.searchTool", { value: t(model.details.supports_search_tool === null ? "openAiModelDetails.undeclared" : "openAiModelCatalog.unsupported") })}</span></TooltipTrigger>
                    <TooltipContent>{t("openAiModelCatalog.searchTool", { value: t(model.details.supports_search_tool === null ? "openAiModelDetails.undeclared" : model.details.supports_search_tool ? "openAiModelCatalog.supported" : "openAiModelCatalog.unsupported") })}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger render={<Badge variant="outline" tabIndex={0} className="cursor-help" />}><span className="underline decoration-dotted underline-offset-2">{model.details.apply_patch_tool_type === null ? t("openAiModelCatalog.patchTool", { value: t("openAiModelDetails.undeclared") }) : t("openAiModelCatalog.editLabel")}</span></TooltipTrigger>
                    <TooltipContent>{t("openAiModelCatalog.patchTool", { value: model.details.apply_patch_tool_type ?? t("openAiModelDetails.undeclared") })}</TooltipContent>
                  </Tooltip>
                </div></TableCell>
                <TableCell className="text-right">{model.editable
                  ? <Button variant="outline" size="sm" disabled={disabled || catalog.locked || catalog.draft !== null} aria-label={t("openAiModelCatalog.editModel", { model: model.displayName })} onClick={() => catalog.startEdit(model)}>{t("openAiModelCatalog.adjustContext")}</Button>
                  : <span className="text-muted-foreground">{t("openAiModelCatalog.notEditable")}</span>}</TableCell>
              </TableRow>)}</TableBody>
            </Table>)}
      {catalog.changedModels.length > 0 && <Alert><AlertDescription><p>{t("openAiModelCatalog.cacheChanged")}</p><p className="break-all">{catalog.changedModels.join(", ")}</p></AlertDescription></Alert>}
      {catalog.storageUnavailable && <Alert><AlertDescription>{t("openAiModelCatalog.trackingUnavailable")}</AlertDescription></Alert>}
      {!catalog.draft && catalog.actionError && <Alert variant="destructive"><AlertDescription>{catalog.actionError}</AlertDescription></Alert>}
      {(result || catalog.writeUnconfirmed) && <Alert variant={warning ? "destructive" : "default"}><AlertDescription className="flex flex-col gap-2" aria-live="polite">
        <p>{catalog.writeUnconfirmed ? t("openAiModelCatalog.writeUnknown") : result?.consistency === "unknown" ? t("openAiModelCatalog.readbackUnknown") : refreshResult ? t(refreshResult.cacheChanged ? "openAiModelCatalog.configuredChanged" : "openAiModelCatalog.configuredUnchanged") : t("openAiModelCatalog.saved")}</p>
        {refreshResult && !refreshResult.outputMatchesCache && <p>{t("openAiModelCatalog.outputDiffers")}</p>}
        {result?.backupCreated && <p>{t("openAiModelCatalog.backupCreated")}</p>}
        <p>{t("openAiModelCatalog.activation")}</p>
        {result?.auditStatus === "degraded" && <p>{t("settingsUi.auditDegraded")}</p>}
        {catalog.readbackRequired && <p>{t("settingsUi.readbackUnknown")}</p>}
      </AlertDescription></Alert>}
      {refreshResult && refreshResult.consistency === "confirmed" && <CatalogDifferences differences={refreshResult.differences} />}
    </CardContent>
    <CardFooter className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
      <Button variant="outline" disabled={disabled || catalog.locked || catalog.draft !== null || catalog.data === null} onClick={() => void catalog.previewRefresh()}>{catalog.busy && !catalog.draft && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("openAiModelCatalog.refreshConfigured")}</Button>
      <p className="text-sm text-muted-foreground">{t("openAiModelCatalog.refreshHint")}</p>
    </CardFooter>
  </Card>
    <OpenAiModelDetails model={detailModel} revision={catalog.data?.revision ?? null} open={selectedModel !== null} loading={catalog.loading} onClose={() => setSelectedModel(null)} onReload={catalog.refresh} />
    <Dialog open={catalog.draft !== null && pending === undefined} disablePointerDismissal onOpenChange={(open, details) => { if (catalog.busy) { details.cancel(); return }; if (!open) catalog.closeEdit() }}>
      <DialogContent closeLabel={t("modelManagement.cancel")} showCloseButton={!catalog.busy} className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("openAiModelCatalog.editContext")}</DialogTitle><DialogDescription>{t("openAiModelCatalog.editHint")}</DialogDescription></DialogHeader>
        {catalog.draft && <FieldGroup>
          <span>{catalog.draft.displayName}</span>
          <SettingsRow label={t("openAiModelCatalog.maxContext")} value={context(catalog.draft.maxContextWindow)} />
          <FieldSet disabled={catalog.locked || disabled}>
            <FieldLegend id={`${inputId}-label`}>{t("openAiModelCatalog.defaultContext")}</FieldLegend>
            <ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={[catalog.draft.preset]} disabled={catalog.locked || disabled} aria-labelledby={`${inputId}-label`} aria-describedby={`${inputId}-hint`} onValueChange={([value]) => {
              if (value === "272000" || value === "372000" || value === "500000" || value === "max" || value === "custom") catalog.changePreset(value)
            }}>
              {(["272000", "372000", "500000"] as const).map(value => <ToggleGroupItem key={value} value={value} disabled={catalog.draft?.maxContextWindow == null || Number(value) > catalog.draft.maxContextWindow}>{Number(value) / 1000}K</ToggleGroupItem>)}
              <ToggleGroupItem value="max" disabled={catalog.draft.maxContextWindow === null}>{t("openAiModelCatalog.contextMaximum")}</ToggleGroupItem>
              <ToggleGroupItem value="custom">{t("openAiModelCatalog.contextCustom")}</ToggleGroupItem>
            </ToggleGroup>
            {catalog.draft.preset === "custom" ? <Field data-invalid={!catalog.valid} data-disabled={catalog.locked || disabled}>
              <FieldLabel htmlFor={inputId}>{t("openAiModelCatalog.contextCustom")}</FieldLabel>
              <Input id={inputId} inputMode="numeric" value={catalog.draft.value} maxLength={16} aria-invalid={!catalog.valid} aria-describedby={`${inputId}-hint`} disabled={catalog.locked || disabled} onChange={event => catalog.changeValue(event.target.value)} />
            </Field> : <SettingsRow label={t("openAiModelCatalog.selectedContext")} value={context(Number(catalog.draft.value))} />}
            <FieldDescription id={`${inputId}-hint`}>{t("openAiModelCatalog.contextValidation")}</FieldDescription>
          </FieldSet>
          {catalog.stale && <Alert variant="destructive"><AlertDescription>{t("openAiModelCatalog.stale")}</AlertDescription></Alert>}
          {catalog.error && <Alert variant="destructive"><AlertDescription>{catalog.error}</AlertDescription></Alert>}
          {catalog.actionError && <Alert variant="destructive"><AlertDescription>{catalog.actionError}</AlertDescription></Alert>}
        </FieldGroup>}
        <DialogFooter><Button variant="outline" disabled={catalog.busy} onClick={catalog.closeEdit}>{t("modelManagement.cancel")}</Button><Button disabled={disabled || catalog.locked || catalog.stale || !catalog.valid || catalog.draft?.value === String(catalog.draft?.previousContextWindow)} onClick={() => void catalog.preview()}>{catalog.busy && <Spinner data-icon="inline-start" aria-label={t("common.loading")} />}{t("modelManagement.preview")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <ManagementConfirmationDialog open={pending !== undefined} title={t(pending?.kind === "refresh" ? "openAiModelCatalog.configuredTitle" : "openAiModelCatalog.confirmTitle")} description={t(pending?.kind === "refresh" ? "openAiModelCatalog.configuredConfirmation" : "openAiModelCatalog.editHint")} saving={catalog.busy} loading={catalog.loading} confirmDisabled={disabled || catalog.readbackRequired || catalog.error !== null} confirmVariant={pending?.kind === "refresh" ? "destructive" : "default"} confirmLabel={t(pending?.kind === "refresh" ? "openAiModelCatalog.refreshConfigured" : "accountConfirmation.confirmWrite")} onConfirm={() => void catalog.confirm()} onCancel={catalog.cancel}>
      <div className="flex flex-col gap-4">
        {pending?.kind === "context" && <>
          <span>{pending.value.displayName}</span>
          <Separator />
          <SettingsRow label={t("openAiModelCatalog.previousContext")} value={context(pending.value.previousContextWindow)} />
          <SettingsRow label={t("openAiModelCatalog.nextContext")} value={context(pending.value.contextWindow)} />
          <SettingsRow label={t("openAiModelCatalog.maxContext")} value={context(pending.value.maxContextWindow)} />
          <Separator />
          <p>{t("openAiModelCatalog.backupHint")}</p>
          <p>{t("openAiModelCatalog.activation")}</p>
        </>}
        {pending?.kind === "refresh" && <code>codex debug models</code>}
      </div>
    </ManagementConfirmationDialog>
  </>
}

function ModelServiceTiers({ tiers }: { tiers: OpenAiModelCatalogResponse["models"][number]["serviceTiers"] }) {
  const { t, language } = useTranslation()
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 6 })
  if (tiers.length === 0) return <span>{t("openAiModelCatalog.noAcceleration")}</span>
  return <div className="flex flex-wrap gap-1">{tiers.map(tier => {
    const label = tier.speedMultiplier === null ? tier.name : t("openAiModelCatalog.tierSpeed", { name: tier.name, speed: numbers.format(tier.speedMultiplier) })
    return <Badge key={tier.id} variant="outline">{label}</Badge>
  })}</div>
}

function ModelApprovals({ approvals }: { approvals: OpenAiModelCatalogResponse["models"][number]["approvals"] }) {
  const { t } = useTranslation()
  const declared = approvals.some(entry => entry.state === "custom")
  return <Tooltip>
    <TooltipTrigger render={<Badge variant={declared ? "secondary" : "outline"} tabIndex={0} className="cursor-help" />}>
      <span className="underline decoration-dotted underline-offset-2">{t(declared ? "openAiModelCatalog.approvalCustom" : "openAiModelCatalog.approvalDefault")}</span>
    </TooltipTrigger>
    <TooltipContent><div className="flex flex-col gap-2"><span>{t("openAiModelCatalog.approvalHint")}</span><ul className="flex flex-col gap-1">
      {approvals.map(entry => <li key={entry.mode}>{entry.mode}: {t(entry.state === "default" ? "openAiModelCatalog.approvalDefault" : entry.state === "empty" ? "openAiModelCatalog.approvalEmpty" : "openAiModelCatalog.approvalCustom")}</li>)}
    </ul></div></TooltipContent>
  </Tooltip>
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
