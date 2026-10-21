import { useId } from "react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ManagedSelect } from "@/components/settings/settings-controls"
import { useTranslation } from "@/hooks/use-translation"
import { contextWindowPresetLabel, contextWindowPresetTokens } from "../../../../runtime/model-catalog.mjs"

export interface ModelCapabilityFieldsValue {
  contextWindow: string
  reasoningEfforts: string[] | undefined
  defaultReasoningEffort: string | null
  supportsImages: boolean | undefined
  supportsPatch: boolean | undefined
  supportsSearch: boolean | undefined
}

export function ModelIdentityFields({ id, name, disabled, idReadOnly = false, singleColumn = false, onIdChange, onNameChange }: {
  id: string
  name: string
  disabled: boolean
  idReadOnly?: boolean
  singleColumn?: boolean
  onIdChange: (value: string) => void
  onNameChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const instance = useId()
  return <FieldGroup className={cn("grid min-w-0 gap-6", !singleColumn && "sm:grid-cols-2")}>
    <Field><FieldLabel htmlFor={`${instance}-id`}>{t("managementUi.modelId")}</FieldLabel><Input id={`${instance}-id`} value={id} disabled={disabled || idReadOnly} onChange={event => onIdChange(event.target.value)} /></Field>
    <Field><FieldLabel htmlFor={`${instance}-name`}>{t("managementUi.displayName")}</FieldLabel><Input id={`${instance}-name`} value={name} disabled={disabled} onChange={event => onNameChange(event.target.value)} /></Field>
  </FieldGroup>
}

export function ModelCapabilityFields({ value, disabled, maximum = 100000000, allowUnknown = false, allowReasoningToggle = false, onChange }: {
  value: ModelCapabilityFieldsValue
  disabled: boolean
  maximum?: number
  allowUnknown?: boolean
  allowReasoningToggle?: boolean
  onChange: (changes: Partial<ModelCapabilityFieldsValue>) => void
}) {
  const { t } = useTranslation()
  const instance = useId()
  const efforts = value.reasoningEfforts ?? []
  const levels = ["none", ...(allowReasoningToggle ? ["enabled"] : []), "minimal", "low", "medium", "high", "xhigh", "max"]
  const reasoningStatus = value.reasoningEfforts === undefined ? "unknown" : efforts.length > 0 ? "supported" : "unsupported"
  return <>
    <FieldGroup className="grid min-w-0 items-start gap-6 sm:grid-cols-2">
      <FieldSet disabled={disabled}><FieldLegend>{t("modelAddition.context")}</FieldLegend><FieldGroup>
        <ManagedSelect fullWidth label={t("managementUi.contextPreset")} value={contextWindowPresetTokens.some(tokens => String(tokens) === value.contextWindow && tokens <= maximum) ? value.contextWindow : ""} placeholder={value.contextWindow ? t("openAiModelCatalog.contextCustom") : undefined} disabled={disabled} options={contextWindowPresetTokens.filter(tokens => tokens <= maximum).map(tokens => [String(tokens), t("managementUi.contextPresetLabel", { label: contextWindowPresetLabel(tokens), tokens })])} onChange={contextWindow => onChange({ contextWindow })} />
        <Field><FieldLabel htmlFor={`${instance}-window`}>{t("managementUi.contextTokens")}</FieldLabel><Input id={`${instance}-window`} type="number" min={1024} max={maximum} value={value.contextWindow} disabled={disabled} onChange={event => onChange({ contextWindow: event.target.value })} /></Field>
      </FieldGroup></FieldSet>
      <FieldSet disabled={disabled}><FieldLegend>{t("modelAddition.reasoning")}</FieldLegend><FieldGroup>
        {allowUnknown ? <ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={[reasoningStatus]} disabled={disabled} aria-label={t("customModel.reasoningSupport")} onValueChange={([status]) => {
          if (status === "unknown" || status === "unsupported" || status === "supported") onChange({ reasoningEfforts: status === "unknown" ? undefined : status === "unsupported" ? [] : ["medium"], defaultReasoningEffort: status === "supported" ? "medium" : null })
        }}>
          <ToggleGroupItem value="unknown">{t("common.unknown")}</ToggleGroupItem>
          <ToggleGroupItem value="unsupported">{t("managementUi.unsupported")}</ToggleGroupItem>
          <ToggleGroupItem value="supported">{t("managementUi.supported")}</ToggleGroupItem>
        </ToggleGroup> : null}
        {!allowUnknown || reasoningStatus === "supported" ? <>
          <FieldGroup className="flex-row flex-wrap gap-x-4 gap-y-2">{levels.map(level => <Field key={level} orientation="horizontal" className="w-auto">
            <Checkbox id={`${instance}-${level}`} checked={efforts.includes(level)} disabled={disabled} onCheckedChange={checked => {
              const next = checked ? [...efforts, level] : efforts.filter(effort => effort !== level)
              onChange({ reasoningEfforts: next, defaultReasoningEffort: next.includes(value.defaultReasoningEffort ?? "") ? value.defaultReasoningEffort : next[0] ?? null })
            }} /><FieldLabel htmlFor={`${instance}-${level}`}>{level}</FieldLabel>
          </Field>)}</FieldGroup>
          <ManagedSelect fullWidth label={t("managementUi.defaultReasoning")} value={value.defaultReasoningEffort ?? ""} disabled={disabled} options={efforts.map(level => [level, level])} onChange={defaultReasoningEffort => onChange({ defaultReasoningEffort })} />
        </> : null}
      </FieldGroup>{!allowUnknown ? <FieldDescription>{t("modelAddition.reasoningHint")}</FieldDescription> : null}</FieldSet>
    </FieldGroup>
    <FieldGroup className="grid min-w-0 gap-6 sm:grid-cols-3">
      {([
        ["supportsImages", t("managementUi.imageInput")],
        ["supportsPatch", t("modelAddition.fileEditing")],
        ["supportsSearch", t("modelAddition.toolSearch")],
      ] as const).map(([field, label]) => <FieldSet key={field} disabled={disabled}>
        <FieldLegend className="flex items-center gap-2">{label}{allowUnknown && value[field] === undefined ? <Badge variant="outline">{t("common.unknown")}</Badge> : null}</FieldLegend>
        <ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={value[field] === undefined ? [] : [value[field] ? "yes" : "no"]} disabled={disabled} aria-label={label} onValueChange={([selected]) => onChange({ [field]: selected === undefined ? undefined : selected === "yes" })}>
          <ToggleGroupItem value="yes">{t("managementUi.supported")}</ToggleGroupItem>
          <ToggleGroupItem value="no">{t("managementUi.unsupported")}</ToggleGroupItem>
        </ToggleGroup>
      </FieldSet>)}
    </FieldGroup>
  </>
}
