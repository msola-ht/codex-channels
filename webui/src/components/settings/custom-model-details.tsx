import { useId } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ManagedSelect } from "@/components/settings/settings-controls"
import { useTranslation } from "@/hooks/use-translation"
import type { ManagementProviderSettingsResponse } from "@/lib/types"
import { customModelSamplingDefaults, type SamplingParameters } from "../../../../runtime/model-catalog.mjs"

const samplingKeys = Object.keys(customModelSamplingDefaults) as (keyof SamplingParameters)[]

type CustomModel = NonNullable<ManagementProviderSettingsResponse["customProviders"]["fixedCandidates"][number]["models"]>[number]
export type CustomModelDraft = Omit<CustomModel, "contextWindow"> & { contextWindow?: number; probeConnection?: Partial<Record<"applyPatch" | "toolSearch", string>> }

export function CustomModelDetails({ entry, index, disabled, upstreamWireApi, patch }: {
  entry: CustomModelDraft
  index: number
  disabled: boolean
  upstreamWireApi: "responses" | "chat_completions"
  patch: (changes: Partial<CustomModelDraft>) => void
}) {
  const { t } = useTranslation()
  const instanceId = useId()
  const responses = upstreamWireApi === "responses"
  const id = (field: string) => `${instanceId}-custom-model-${index}-${field}`
  const optionalNumber = (value: string) => value === "" ? undefined : Number(value)
  const contextWindow = entry.contextWindow
  const compactMaximum = contextWindow === undefined ? undefined : Math.floor(contextWindow * 9 / 10)
  return <Collapsible className="min-w-0"><CollapsibleTrigger render={<Button variant="outline" />} disabled={disabled}>{t("customModel.advanced")}</CollapsibleTrigger><CollapsibleContent className="min-w-0 pt-3"><FieldGroup>
    <FieldSet aria-describedby={id("sampling-hint")}><FieldLegend>{t("customModel.sampling")}</FieldLegend><FieldDescription id={id("sampling-hint")}>{t("customModel.samplingHint")}</FieldDescription>
      <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={disabled} onClick={() => patch({ sampling: { ...customModelSamplingDefaults } })}>{t("customModel.samplingRestore")}</Button><Button variant="outline" disabled={disabled} onClick={() => patch({ sampling: undefined })}>{t("customModel.samplingClear")}</Button></div>
      <FieldGroup className="grid min-w-0 gap-6 sm:grid-cols-3">{samplingKeys.map(key => <Field key={key} data-disabled={disabled}><FieldLabel htmlFor={id(key)}>{key}</FieldLabel><Input id={id(key)} aria-describedby={id("sampling-hint")} type="number" step={key === "top_k" ? 1 : "any"} value={entry.sampling?.[key] ?? ""} placeholder={t("customModel.samplingUpstream")} disabled={disabled} onChange={event => {
        const sampling = { ...entry.sampling }
        if (event.target.value === "") delete sampling[key]
        else sampling[key] = Number(event.target.value)
        patch({ sampling: Object.keys(sampling).length ? sampling : undefined })
      }} /></Field>)}</FieldGroup>
    </FieldSet>
    <Field data-disabled={disabled}><FieldLabel htmlFor={id("description")}>{t("customModel.description")}</FieldLabel><Textarea id={id("description")} className="field-sizing-fixed min-h-24 max-h-48 resize-y" rows={3} value={entry.description ?? ""} maxLength={4000} disabled={disabled} onChange={event => patch({ description: event.target.value === "" ? undefined : event.target.value })} /></Field>
    {(entry.reasoningEfforts?.length ?? 0) > 0 ? <FieldSet><FieldLegend>{t("customModel.reasoningDescriptions")}</FieldLegend><FieldGroup>{entry.reasoningEfforts?.map((effort, position) => <Field key={`${effort}-${position}`} data-disabled={disabled}><FieldLabel htmlFor={id(`reasoning-${position}`)}>{t("customModel.reasoningDescription", { effort })}</FieldLabel><Input id={id(`reasoning-${position}`)} value={entry.reasoningDescriptions?.[effort] ?? ""} maxLength={2000} disabled={disabled} onChange={event => { const descriptions = { ...entry.reasoningDescriptions }; if (event.target.value === "") delete descriptions[effort]; else descriptions[effort] = event.target.value; patch({ reasoningDescriptions: Object.keys(descriptions).length === 0 ? undefined : descriptions }) }} /></Field>)}</FieldGroup></FieldSet> : null}
    <FieldSet aria-describedby={id("response-hint")}><FieldLegend>{t("customModel.responseParameters")}</FieldLegend><FieldDescription id={id("response-hint")}>{t("customModel.summaryIndependent")}</FieldDescription><FieldGroup>
      {entry.supportsImages ? <Field orientation="horizontal" data-disabled={disabled}><Checkbox id={id("original")} checked={entry.supportsImageDetailOriginal === true} disabled={disabled} onCheckedChange={value => patch({ supportsImageDetailOriginal: value === true })} /><FieldLabel htmlFor={id("original")}>{t("customModel.imageOriginal")}</FieldLabel></Field> : null}
      <FieldGroup className="grid min-w-0 items-start gap-6 sm:grid-cols-2">
      <FieldGroup>
      <Field orientation="horizontal" data-disabled={disabled}><Checkbox id={id("verbosity")} checked={entry.supportsVerbosity === true} disabled={disabled} onCheckedChange={value => patch({ supportsVerbosity: value === true, defaultVerbosity: value === true ? entry.defaultVerbosity ?? "medium" : null })} /><FieldLabel htmlFor={id("verbosity")}>{t("customModel.supportsVerbosity")}</FieldLabel></Field>
      {entry.supportsVerbosity ? <ManagedSelect fullWidth label={t("customModel.defaultVerbosity")} value={entry.defaultVerbosity ?? ""} options={(["low", "medium", "high"] as const).map(value => [value, t(`customModel.verbosity.${value}`)])} disabled={disabled} onChange={value => patch({ defaultVerbosity: value as CustomModel["defaultVerbosity"] })} /> : null}
      </FieldGroup>
      <FieldGroup>
      <Field orientation="horizontal" data-disabled={disabled}><Checkbox id={id("summary")} checked={entry.supportsReasoningSummary === true} disabled={disabled} onCheckedChange={value => patch({ supportsReasoningSummary: value === true, defaultReasoningSummary: value === true ? entry.defaultReasoningSummary ?? "auto" : "none" })} /><FieldLabel htmlFor={id("summary")}>{t("customModel.supportsSummary")}</FieldLabel></Field>
      {entry.supportsReasoningSummary ? <ManagedSelect fullWidth label={t("customModel.defaultSummary")} value={entry.defaultReasoningSummary ?? "auto"} options={(["auto", "concise", "detailed", "none"] as const).map(value => [value, t(`customModel.summary.${value}`)])} disabled={disabled} onChange={value => patch({ defaultReasoningSummary: value as CustomModel["defaultReasoningSummary"] })} /> : null}
      </FieldGroup>
      </FieldGroup>
      {!responses ? <Alert><AlertDescription>{t("customModel.chatConversionHint")}</AlertDescription></Alert> : null}
    </FieldGroup></FieldSet>
      <Field data-disabled={disabled}><FieldLabel htmlFor={id("instructions")}>{t("customModel.instructions")}</FieldLabel><Textarea id={id("instructions")} className="field-sizing-fixed h-48 max-h-96 resize-y" aria-describedby={id("instructions-hint")} rows={6} value={entry.instructions ?? ""} disabled={disabled} onChange={event => patch({ instructions: event.target.value === "" ? undefined : event.target.value })} /><FieldDescription id={id("instructions-hint")}>{t("customModel.instructionsHint")}</FieldDescription></Field>
      <FieldSet><FieldLegend>{t("customModel.contextManagement")}</FieldLegend>
      <Field data-disabled={disabled}><FieldLabel htmlFor={id("max-context")}>{t("customModel.maxContext")}</FieldLabel><Input id={id("max-context")} aria-describedby={id("max-context-hint")} type="number" min={entry.contextWindow || 1024} max={100000000} value={entry.maxContextWindow ?? ""} disabled={disabled} placeholder={t("customModel.defaultValue")} onChange={event => patch({ maxContextWindow: optionalNumber(event.target.value) })} /><FieldDescription id={id("max-context-hint")}>{t("customModel.maxContextHint")}</FieldDescription></Field>
      <FieldGroup className="grid min-w-0 items-start gap-6 sm:grid-cols-2">
      <Field data-disabled={disabled}><FieldLabel htmlFor={id("effective")}>{t("customModel.effectivePercent")}</FieldLabel><Input id={id("effective")} aria-describedby={id("effective-hint")} type="number" min={1} max={100} value={entry.effectiveContextWindowPercent ?? ""} placeholder="95" disabled={disabled} onChange={event => patch({ effectiveContextWindowPercent: optionalNumber(event.target.value) })} /><FieldDescription id={id("effective-hint")}>{t("customModel.effectivePercentHint")}</FieldDescription></Field>
      <Field data-disabled={disabled || compactMaximum === undefined}><FieldLabel htmlFor={id("compact")}>{t("customModel.autoCompact")}</FieldLabel><Input id={id("compact")} aria-describedby={id("compact-hint")} type="number" min={1} max={compactMaximum} value={entry.autoCompactTokenLimit ?? ""} placeholder={t("customModel.defaultValue")} disabled={disabled || compactMaximum === undefined} onChange={event => patch({ autoCompactTokenLimit: optionalNumber(event.target.value) })} /><FieldDescription id={id("compact-hint")}>{t("customModel.autoCompactHint", { limit: compactMaximum ?? t("common.unknown") })}</FieldDescription></Field>
      <ManagedSelect fullWidth label={t("customModel.truncation")} description={t("customModel.truncationHint")} descriptionId={id("truncation-hint")} value={entry.truncationPolicy?.mode ?? "default"} options={[["default", t("customModel.defaultValue")], ["tokens", t("customModel.truncationTokens")], ["bytes", t("customModel.truncationBytes")]]} disabled={disabled || contextWindow === undefined} onChange={value => { if (contextWindow !== undefined) patch({ truncationPolicy: value === "default" ? undefined : { mode: value as "tokens" | "bytes", limit: entry.truncationPolicy?.limit ?? Math.max(1, Math.min(10000, Math.floor(contextWindow / 4))) } }) }} />
      {entry.truncationPolicy ? <Field data-disabled={disabled}><FieldLabel htmlFor={id("truncation-limit")}>{t("customModel.truncationLimit")}</FieldLabel><Input id={id("truncation-limit")} aria-describedby={id("truncation-hint")} type="number" min={1} value={entry.truncationPolicy.limit || ""} disabled={disabled} onChange={event => patch({ truncationPolicy: { mode: entry.truncationPolicy!.mode, limit: Number(event.target.value) } })} /></Field> : null}
      </FieldGroup></FieldSet>
    </FieldGroup></CollapsibleContent></Collapsible>
}

export function CustomModelDetailsPreview({ entry }: { entry: CustomModel }) {
  const { t } = useTranslation()
  const capability = (value: boolean | undefined) => t(value === undefined ? "common.unknown" : value ? "managementUi.supported" : "managementUi.unsupported")
  const instructions = entry.instructions ?? entry.modelMessages?.instructions_template
  return <FieldSet><FieldLegend>{t("customModel.preview", { id: entry.id })}</FieldLegend>
    {entry.template ? <p>{t("customModel.templateOrigin", { source: entry.template.source === "official" ? "OpenAI" : "DeepSeek", model: entry.template.model })}</p> : null}
    <p>{t("managementUi.supportsReasoning")}: {capability(entry.reasoningEfforts === undefined ? undefined : entry.reasoningEfforts.length > 0)}</p>
    <p>{t("managementUi.imageInput")}: {capability(entry.supportsImages)}</p>
    <p>{t("managementUi.freeformPatchTool")}: {capability(entry.applyPatchToolType === undefined ? undefined : entry.applyPatchToolType !== null)}</p>
    <p>{t("managementUi.toolSearchTool")}: {capability(entry.supportsSearchTool)}</p>
    {entry.experimentalSupportedTools !== undefined ? <p>{t("modelTemplate.localTools")}: {entry.experimentalSupportedTools.join(", ") || t("modelTemplate.absent")}</p> : null}
    <p className="text-muted-foreground">{t("customModel.unknownDisabled")}</p>
    <p>{t("customModel.description")}: {entry.description ?? t("customModel.defaultValue")}</p>
    <p>{t("customModel.maxContext")}: {entry.maxContextWindow ?? entry.contextWindow}</p>
    <p>{t("customModel.imageOriginal")}: {capability(entry.supportsImageDetailOriginal)}</p>
    <p>{t("customModel.supportsVerbosity")}: {capability(entry.supportsVerbosity)}; {t("customModel.defaultVerbosity")}: {entry.defaultVerbosity ?? t("customModel.unset")}</p>
    <p>{t("customModel.supportsSummary")}: {capability(entry.supportsReasoningSummary)}; {t("customModel.defaultSummary")}: {entry.defaultReasoningSummary ?? t("customModel.unset")}</p>
    {entry.reasoningEfforts?.map(effort => <p key={effort}>{t("customModel.reasoningDescription", { effort })}: {entry.reasoningDescriptions?.[effort] ?? t("customModel.defaultValue")}</p>)}
    <p>{t("customModel.effectivePercent")}: {entry.effectiveContextWindowPercent ?? 95}%</p>
    <p>{t("customModel.sampling")}: {entry.sampling ? JSON.stringify(entry.sampling) : t("customModel.samplingUpstream")}</p>
    <p>{t("customModel.autoCompact")}: {entry.autoCompactTokenLimit ?? t("customModel.defaultValue")}</p>
    <p>{t("customModel.truncation")}: {entry.truncationPolicy ? `${entry.truncationPolicy.mode}: ${entry.truncationPolicy.limit}` : t("customModel.truncationDefault", { limit: Math.min(10000, Math.floor(entry.contextWindow / 4)) })}</p>
    <Field><FieldLabel>{t("customModel.instructions")}</FieldLabel><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{typeof instructions === "string" ? instructions : t("customModel.instructionsDefault")}</pre></Field>
  </FieldSet>
}
