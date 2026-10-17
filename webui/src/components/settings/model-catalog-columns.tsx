import type { ReactNode } from "react"
import { useTranslation } from "@/hooks/use-translation"
import type { OpenAiModelCatalogEntry } from "@/lib/types"
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
    <TableHead>{t("openAiModelCatalog.approvals")}</TableHead>
    <TableHead>{t("openAiModelCatalog.tools")}</TableHead>
  </>
}

export function ModelCapabilityCells({ model }: { model: OpenAiModelCatalogEntry }) {
  const { t, language } = useTranslation()
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US")
  const context = (value: number | null) => value === null ? t("common.unknown") : numbers.format(value)
  return <>
    <TableCell><div className="flex flex-wrap gap-1">{model.details.input_modalities === null
      ? t("openAiModelDetails.undeclared")
      : model.details.input_modalities.length === 0 ? t("openAiModelDetails.empty")
        : model.details.input_modalities.map((modality, index) => <Badge key={`${modality}-${index}`} variant="outline">{modality === "text" ? t("openAiModelDetails.text") : modality === "image" ? t("openAiModelDetails.image") : modality}</Badge>)}</div></TableCell>
    <TableCell className="text-right tabular-nums">{context(model.contextWindow)}</TableCell>
    <TableCell className="text-right tabular-nums">{context(model.maxContextWindow)}</TableCell>
    <TableCell className="text-right tabular-nums">{model.details.effective_context_window_percent === null ? t("openAiModelDetails.undeclared") : `${numbers.format(model.details.effective_context_window_percent)}%`}</TableCell>
    <TableCell><Tooltip>
      <TooltipTrigger render={<Badge variant="secondary" tabIndex={0} className="cursor-help" />}><span className="underline decoration-dotted underline-offset-2">{model.defaultReasoningEffort ?? t("common.unknown")}</span></TooltipTrigger>
      <TooltipContent><div className="flex flex-col gap-2"><span>{t("openAiModelCatalog.reasoning")}</span><ul className="flex flex-col gap-1">
        {model.reasoningEfforts.length === 0 ? <li>{t("common.unknown")}</li> : model.reasoningEfforts.map(effort => <li key={effort}>{effort === model.defaultReasoningEffort ? t("openAiModelCatalog.defaultEffort", { effort }) : effort}</li>)}
      </ul></div></TooltipContent>
    </Tooltip></TableCell>
    <TableCell><ModelServiceTiers tiers={model.serviceTiers} /></TableCell>
    <TableCell><ModelApprovals approvals={model.approvals} /></TableCell>
    <TableCell><div className="flex flex-wrap gap-1">
      <Tooltip>
        <TooltipTrigger render={<Badge variant={model.details.supports_search_tool === true ? "default" : model.details.supports_search_tool === false ? "destructive" : "secondary"} tabIndex={0} className="cursor-help" />}><span className="underline decoration-dotted underline-offset-2">{t("openAiModelCatalog.searchLabel")}</span></TooltipTrigger>
        <TooltipContent>{t("openAiModelCatalog.searchTool", { value: t(model.details.supports_search_tool === null ? "openAiModelDetails.undeclared" : model.details.supports_search_tool ? "openAiModelCatalog.supported" : "openAiModelCatalog.unsupported") })}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Badge variant={model.details.apply_patch_tool_type === null ? "secondary" : "outline"} tabIndex={0} className="cursor-help" />}><span className="underline decoration-dotted underline-offset-2">{t("openAiModelCatalog.editLabel")}</span></TooltipTrigger>
        <TooltipContent>{t("openAiModelCatalog.patchTool", { value: model.details.apply_patch_tool_type ?? t("openAiModelDetails.undeclared") })}</TooltipContent>
      </Tooltip>
    </div></TableCell>
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
