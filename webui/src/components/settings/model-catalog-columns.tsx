import type { ReactNode } from "react"
import { useTranslation } from "@/hooks/use-translation"
import type { OpenAiModelCatalogEntry, ManagementProviderSettingsResponse } from "@/lib/types"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/** Shared catalog declarations; actions and their authorization stay with each catalog. */
export type CatalogModel = OpenAiModelCatalogEntry & { isDefault?: boolean }
export interface ModelCatalogGroup {
  id: string
  header: ReactNode
  models: CatalogModel[]
  webSearchSettings?: ManagementProviderSettingsResponse["webSearchSettings"]
  webSearchState?: "loading" | "error"
  onSelect: (model: CatalogModel) => void
  renderAction: (model: CatalogModel) => ReactNode
  content?: ReactNode
  footer?: ReactNode
}

export function ModelCatalogTable({ label, groups }: {
  label: string
  groups: ModelCatalogGroup[]
}) {
  const { t } = useTranslation()
  return <Table aria-label={label}>
    <colgroup>
      <col className="w-[18rem]" />
      <col span={9} />
    </colgroup>
    <TableHeader><TableRow>
      <TableHead>{t("modelManagement.model")}</TableHead>
      <ModelCapabilityHeaders />
      <TableHead className="text-right">{t("modelManagement.actions")}</TableHead>
    </TableRow></TableHeader>
    {groups.map(group => <TableBody key={group.id}>
      <TableRow className="bg-muted/30 hover:bg-muted/30"><TableHead colSpan={10} scope="rowgroup" className="h-auto whitespace-normal py-4">{group.header}</TableHead></TableRow>
      {group.content ? <TableRow><TableCell colSpan={10} className="whitespace-normal">{group.content}</TableCell></TableRow> : group.models.map(model => <TableRow key={model.model}>
      <TableCell className="w-[18rem] min-w-[18rem] max-w-[18rem]"><div className="flex w-[17rem] min-w-0 items-center gap-2 whitespace-nowrap">
        <Button variant="link" size="sm" className="min-w-0 shrink justify-start px-0" aria-label={t("openAiModelDetails.open", { model: model.displayName })} onClick={() => group.onSelect(model)}><span className="truncate">{model.displayName}</span></Button>
      </div></TableCell>
      <ModelCapabilityCells model={model} />
      <TableCell><ModelWebSearchSettings settings={group.webSearchSettings} state={group.webSearchState} /></TableCell>
      <TableCell className="text-right">{group.renderAction(model)}</TableCell>
    </TableRow>)}
      {group.footer && <TableRow><TableCell colSpan={10} className="whitespace-normal py-4">{group.footer}</TableCell></TableRow>}
    </TableBody>)}
  </Table>
}

export function ModelCapabilityHeaders() {
  const { t } = useTranslation()
  return <>
    <TableHead>{t("openAiModelDetails.fields.input_modalities")}</TableHead>
    <TableHead className="text-right">{t("openAiModelCatalog.defaultContext")}</TableHead>
    <TableHead className="text-right">{t("openAiModelCatalog.maxContext")}</TableHead>
    <TableHead className="text-right">{t("openAiModelDetails.fields.effective_context_window_percent")}</TableHead>
    <TableHead>{t("openAiModelCatalog.preferredEffort")}</TableHead>
    <TableHead>{t("openAiModelCatalog.acceleration")}</TableHead>
    <TableHead>{t("openAiModelCatalog.tools")}</TableHead>
    <TableHead>{t("openAiModelCatalog.builtinSearch")}</TableHead>
  </>
}

function ModelWebSearchSettings({ settings, state }: { settings?: ManagementProviderSettingsResponse["webSearchSettings"]; state?: "loading" | "error" }) {
  const { t } = useTranslation()
  if (state === "loading") return <span aria-busy="true">{t("common.loading")}</span>
  if (state === "error") return <span>{t("openAiModelCatalog.searchReadFailed")}</span>
  if (!settings?.length) return <span>{t("common.unknown")}</span>
  const labels = {
    default: t("openAiModelCatalog.searchDefault"),
    disabled: t("settingsFields.off"),
    cached: t("settingsFields.cached"),
    indexed: t("settingsFields.indexed"),
    live: t("settingsFields.live"),
  }
  return <div className="flex flex-col gap-2">{settings.map(setting => {
    const label = setting.status === "ready" ? labels[setting.mode ?? "default"] : t(setting.error === "invalid-mode" ? "openAiModelCatalog.searchInvalidMode" : setting.error === "invalid-document" ? "openAiModelCatalog.searchInvalidDocument" : "openAiModelCatalog.searchReadFailed")
    return <Tooltip key={setting.provider}>
      <TooltipTrigger render={<span tabIndex={0} className="flex items-center gap-2" />}>
        <span>{label}</span>
        {settings.length > 1 ? <span>{setting.provider}</span> : null}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm"><p>{t(setting.source === "global" ? "openAiModelCatalog.globalSearchSource" : "openAiModelCatalog.providerSearchSource", { provider: setting.provider })}</p><p>{t("openAiModelCatalog.searchDefaultHint")}</p></TooltipContent>
    </Tooltip>
  })}</div>
}

export function ModelCapabilityCells({ model }: { model: OpenAiModelCatalogEntry }) {
  const { t, language } = useTranslation()
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US")
  const context = (value: number | null) => value === null ? t("common.unknown") : numbers.format(value)
  const declared = model.declaredCapabilities
  const capability = (value: boolean | undefined) => t(value === undefined ? "common.unknown" : value ? "openAiModelCatalog.supported" : "openAiModelCatalog.unsupported")
  const reasoning = declared === undefined ? model.reasoningEfforts : declared.reasoningEfforts
  const reasoningState = declared === undefined ? t("common.unknown") : capability(reasoning === undefined ? undefined : reasoning.length > 0)
  const search = declared === undefined ? t(model.details.supports_search_tool === null ? "openAiModelDetails.undeclared" : model.details.supports_search_tool ? "openAiModelCatalog.supported" : "openAiModelCatalog.unsupported") : capability(declared.supportsSearchTool)
  const patch = declared === undefined ? t(model.details.apply_patch_tool_type === null ? "openAiModelDetails.undeclared" : "openAiModelCatalog.supported") : capability(declared.applyPatchToolType === undefined ? undefined : declared.applyPatchToolType !== null)
  return <>
    <TableCell><div className="flex flex-wrap gap-1">{declared !== undefined ? <><Badge variant="outline">{t("openAiModelDetails.text")}</Badge>{declared.supportsImages === true ? <Badge variant="outline">{t("openAiModelDetails.image")}</Badge> : <span>{t("managementUi.imageInput")}: {capability(declared.supportsImages)}</span>}</> : model.details.input_modalities === null
      ? t("openAiModelDetails.undeclared")
      : model.details.input_modalities.length === 0 ? t("openAiModelDetails.empty")
        : model.details.input_modalities.map((modality, index) => <Badge key={`${modality}-${index}`} variant="outline">{modality === "text" ? t("openAiModelDetails.text") : modality === "image" ? t("openAiModelDetails.image") : modality}</Badge>)}</div></TableCell>
    <TableCell className="text-right tabular-nums">{context(model.contextWindow)}</TableCell>
    <TableCell className="text-right tabular-nums">{context(model.maxContextWindow)}</TableCell>
    <TableCell className="text-right tabular-nums">{model.details.effective_context_window_percent === null ? t("openAiModelDetails.undeclared") : `${numbers.format(model.details.effective_context_window_percent)}%`}</TableCell>
    <TableCell><Tooltip>
      <TooltipTrigger render={<Badge variant="secondary" tabIndex={0} className="cursor-help" />}><span className="underline decoration-dotted underline-offset-2">{model.defaultReasoningEffort ?? reasoningState}</span></TooltipTrigger>
      <TooltipContent><div className="flex flex-col gap-2"><span>{t("openAiModelCatalog.reasoning")}</span><ul className="flex flex-col gap-1">
        {!reasoning?.length ? <li>{reasoningState}</li> : reasoning.map(effort => <li key={effort}>{effort === model.defaultReasoningEffort ? t("openAiModelCatalog.defaultEffort", { effort }) : effort}</li>)}
      </ul></div></TooltipContent>
    </Tooltip></TableCell>
    <TableCell><ModelServiceTiers tiers={model.serviceTiers} /></TableCell>
    <TableCell><div className="flex flex-col items-start gap-1">
      <span>{t("openAiModelCatalog.searchTool", { value: search })}</span>
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="cursor-help" />}>{t("openAiModelCatalog.editSupport", { value: patch })}</TooltipTrigger>
      <TooltipContent>{t("openAiModelCatalog.patchTool", { value: declared === undefined ? model.details.apply_patch_tool_type ?? t("openAiModelDetails.undeclared") : declared.applyPatchToolType ?? patch })}</TooltipContent>
    </Tooltip></div></TableCell>
  </>
}

export function ModelServiceTiers({ tiers }: { tiers: OpenAiModelCatalogEntry["serviceTiers"] }) {
  const { t, language } = useTranslation()
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US", { maximumFractionDigits: 6 })
  if (tiers.length === 0) return <span>{t("openAiModelCatalog.noAcceleration")}</span>
  return <div className="flex flex-wrap gap-1">{tiers.map(tier => <Badge key={tier.id} variant="outline">{tier.speedMultiplier === null ? tier.name : t("openAiModelCatalog.tierSpeed", { name: tier.name, speed: numbers.format(tier.speedMultiplier) })}</Badge>)}</div>
}

export function ModelApprovals({ approvals }: { approvals: OpenAiModelCatalogEntry["approvals"] }) {
  const { t } = useTranslation()
  const declared = approvals.some(entry => entry.state === "custom")
  return <Tooltip>
    <TooltipTrigger render={<Badge variant={declared ? "secondary" : "outline"} tabIndex={0} className="cursor-help" />}><span className="underline decoration-dotted underline-offset-2">{t(declared ? "openAiModelCatalog.approvalCustom" : "openAiModelCatalog.approvalDefault")}</span></TooltipTrigger>
    <TooltipContent><div className="flex flex-col gap-2"><span>{t("openAiModelCatalog.approvalHint")}</span><ul className="flex flex-col gap-1">
      {approvals.map(entry => <li key={entry.mode}>{entry.mode}: {t(entry.state === "default" ? "openAiModelCatalog.approvalDefault" : entry.state === "empty" ? "openAiModelCatalog.approvalEmpty" : "openAiModelCatalog.approvalCustom")}</li>)}
    </ul></div></TooltipContent>
  </Tooltip>
}
