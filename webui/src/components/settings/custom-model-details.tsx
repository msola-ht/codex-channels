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

type CustomModel = NonNullable<ManagementProviderSettingsResponse["customProviders"]["fixedCandidates"][number]["models"]>[number]
export type CustomModelDraft = CustomModel & { probeConnection?: Partial<Record<"applyPatch" | "toolSearch", string>> }

export function CustomModelDetails({ entry, index, disabled, upstreamWireApi, patch }: {
  entry: CustomModelDraft
  index: number
  disabled: boolean
  upstreamWireApi: "responses" | "chat_completions"
  patch: (changes: Partial<CustomModelDraft>) => void
}) {
  const { t } = useTranslation()
  const responses = upstreamWireApi === "responses"
  const id = (field: string) => `custom-model-${index}-${field}`
  const optionalNumber = (value: string) => value === "" ? undefined : Number(value)
  return <>
    <Field data-disabled={disabled}><FieldLabel htmlFor={id("description")}>{t("customModel.description")}</FieldLabel><Textarea id={id("description")} value={entry.description ?? ""} maxLength={4000} disabled={disabled} onChange={event => patch({ description: event.target.value === "" ? undefined : event.target.value })} /></Field>
    <Field data-disabled={disabled}><FieldLabel htmlFor={id("max-context")}>{t("customModel.maxContext")}</FieldLabel><Input id={id("max-context")} type="number" min={entry.contextWindow || 1024} max={100000000} value={entry.maxContextWindow ?? ""} disabled={disabled} placeholder={t("customModel.defaultValue")} onChange={event => patch({ maxContextWindow: optionalNumber(event.target.value) })} /><FieldDescription>{t("customModel.maxContextHint")}</FieldDescription></Field>
    {entry.reasoningEfforts.length > 0 ? <FieldSet><FieldLegend>{t("customModel.reasoningDescriptions")}</FieldLegend><FieldGroup>{entry.reasoningEfforts.map((effort, position) => <Field key={`${effort}-${position}`} data-disabled={disabled}><FieldLabel htmlFor={id(`reasoning-${position}`)}>{t("customModel.reasoningDescription", { effort })}</FieldLabel><Input id={id(`reasoning-${position}`)} value={entry.reasoningDescriptions?.[effort] ?? ""} maxLength={2000} disabled={disabled} onChange={event => { const descriptions = { ...entry.reasoningDescriptions }; if (event.target.value === "") delete descriptions[effort]; else descriptions[effort] = event.target.value; patch({ reasoningDescriptions: Object.keys(descriptions).length === 0 ? undefined : descriptions }) }} /></Field>)}</FieldGroup></FieldSet> : null}
    <FieldSet><FieldLegend>{t("customModel.responseParameters")}</FieldLegend><FieldDescription>{t("customModel.summaryIndependent")}</FieldDescription><FieldGroup>
      {entry.supportsImages ? <Field orientation="horizontal" data-disabled={disabled}><Checkbox id={id("original")} checked={entry.supportsImageDetailOriginal === true} disabled={disabled} onCheckedChange={value => patch({ supportsImageDetailOriginal: value === true })} /><FieldLabel htmlFor={id("original")}>{t("customModel.imageOriginal")}</FieldLabel></Field> : null}
      <Field orientation="horizontal" data-disabled={disabled}><Checkbox id={id("verbosity")} checked={entry.supportsVerbosity === true} disabled={disabled} onCheckedChange={value => patch({ supportsVerbosity: value === true, defaultVerbosity: value === true ? entry.defaultVerbosity ?? "medium" : null })} /><FieldLabel htmlFor={id("verbosity")}>{t("customModel.supportsVerbosity")}</FieldLabel></Field>
      {entry.supportsVerbosity ? <ManagedSelect label={t("customModel.defaultVerbosity")} value={entry.defaultVerbosity ?? ""} options={(["low", "medium", "high"] as const).map(value => [value, t(`customModel.verbosity.${value}`)])} disabled={disabled} onChange={value => patch({ defaultVerbosity: value as CustomModel["defaultVerbosity"] })} /> : null}
      <Field orientation="horizontal" data-disabled={disabled}><Checkbox id={id("summary")} checked={entry.supportsReasoningSummary === true} disabled={disabled} onCheckedChange={value => patch({ supportsReasoningSummary: value === true, defaultReasoningSummary: value === true ? entry.defaultReasoningSummary ?? "auto" : "none" })} /><FieldLabel htmlFor={id("summary")}>{t("customModel.supportsSummary")}</FieldLabel></Field>
      {entry.supportsReasoningSummary ? <ManagedSelect label={t("customModel.defaultSummary")} value={entry.defaultReasoningSummary ?? "auto"} options={(["auto", "concise", "detailed", "none"] as const).map(value => [value, t(`customModel.summary.${value}`)])} disabled={disabled} onChange={value => patch({ defaultReasoningSummary: value as CustomModel["defaultReasoningSummary"] })} /> : null}
      {!responses ? <Alert><AlertDescription>{t("customModel.chatConversionHint")}</AlertDescription></Alert> : null}
    </FieldGroup></FieldSet>
    <Collapsible><CollapsibleTrigger render={<Button variant="outline" />} disabled={disabled}>{t("customModel.advanced")}</CollapsibleTrigger><CollapsibleContent className="pt-3"><FieldGroup>
      <Field data-disabled={disabled}><FieldLabel htmlFor={id("instructions")}>{t("customModel.instructions")}</FieldLabel><Textarea id={id("instructions")} rows={6} value={entry.instructions ?? ""} disabled={disabled} onChange={event => patch({ instructions: event.target.value === "" ? undefined : event.target.value })} /><FieldDescription>{t("customModel.instructionsHint")}</FieldDescription></Field>
      <Field data-disabled={disabled}><FieldLabel htmlFor={id("effective")}>{t("customModel.effectivePercent")}</FieldLabel><Input id={id("effective")} type="number" min={1} max={100} value={entry.effectiveContextWindowPercent ?? ""} placeholder="95" disabled={disabled} onChange={event => patch({ effectiveContextWindowPercent: optionalNumber(event.target.value) })} /><FieldDescription>{t("customModel.effectivePercentHint")}</FieldDescription></Field>
      <Field data-disabled={disabled}><FieldLabel htmlFor={id("compact")}>{t("customModel.autoCompact")}</FieldLabel><Input id={id("compact")} type="number" min={1} max={Math.floor(entry.contextWindow * 9 / 10)} value={entry.autoCompactTokenLimit ?? ""} placeholder={t("customModel.defaultValue")} disabled={disabled} onChange={event => patch({ autoCompactTokenLimit: optionalNumber(event.target.value) })} /><FieldDescription>{t("customModel.autoCompactHint", { limit: Math.floor(entry.contextWindow * 9 / 10) })}</FieldDescription></Field>
      <ManagedSelect label={t("customModel.truncation")} value={entry.truncationPolicy?.mode ?? "default"} options={[["default", t("customModel.defaultValue")], ["tokens", t("customModel.truncationTokens")], ["bytes", t("customModel.truncationBytes")]]} disabled={disabled} onChange={value => patch({ truncationPolicy: value === "default" ? undefined : { mode: value as "tokens" | "bytes", limit: entry.truncationPolicy?.limit ?? Math.max(1, Math.min(10000, Math.floor(entry.contextWindow / 4))) } })} />
      {entry.truncationPolicy ? <Field data-disabled={disabled}><FieldLabel htmlFor={id("truncation-limit")}>{t("customModel.truncationLimit")}</FieldLabel><Input id={id("truncation-limit")} type="number" min={1} value={entry.truncationPolicy.limit || ""} disabled={disabled} onChange={event => patch({ truncationPolicy: { mode: entry.truncationPolicy!.mode, limit: Number(event.target.value) } })} /></Field> : null}
      <FieldDescription>{t("customModel.truncationHint")}</FieldDescription>
    </FieldGroup></CollapsibleContent></Collapsible>
  </>
}

export function CustomModelDetailsPreview({ entry }: { entry: CustomModel }) {
  const { t } = useTranslation()
  const support = (value: boolean | undefined) => t(value ? "managementUi.supported" : "managementUi.unsupported")
  return <FieldSet><FieldLegend>{t("customModel.preview", { id: entry.id })}</FieldLegend>
    <p>{t("customModel.description")}: {entry.description ?? t("customModel.defaultValue")}</p>
    <p>{t("customModel.maxContext")}: {entry.maxContextWindow ?? entry.contextWindow}</p>
    <p>{t("customModel.imageOriginal")}: {support(entry.supportsImageDetailOriginal)}</p>
    <p>{t("customModel.supportsVerbosity")}: {support(entry.supportsVerbosity)}; {t("customModel.defaultVerbosity")}: {entry.defaultVerbosity ?? t("customModel.unset")}</p>
    <p>{t("customModel.supportsSummary")}: {support(entry.supportsReasoningSummary)}; {t("customModel.defaultSummary")}: {entry.defaultReasoningSummary ?? "auto"}</p>
    {entry.reasoningEfforts.map(effort => <p key={effort}>{t("customModel.reasoningDescription", { effort })}: {entry.reasoningDescriptions?.[effort] ?? t("customModel.defaultValue")}</p>)}
    <p>{t("customModel.effectivePercent")}: {entry.effectiveContextWindowPercent ?? 95}%</p>
    <p>{t("customModel.autoCompact")}: {entry.autoCompactTokenLimit ?? t("customModel.defaultValue")}</p>
    <p>{t("customModel.truncation")}: {entry.truncationPolicy ? `${entry.truncationPolicy.mode}: ${entry.truncationPolicy.limit}` : t("customModel.truncationDefault", { limit: Math.min(10000, Math.floor(entry.contextWindow / 4)) })}</p>
    <Field><FieldLabel>{t("customModel.instructions")}</FieldLabel><pre className="whitespace-pre-wrap break-words">{entry.instructions ?? t("customModel.instructionsDefault")}</pre></Field>
  </FieldSet>
}
