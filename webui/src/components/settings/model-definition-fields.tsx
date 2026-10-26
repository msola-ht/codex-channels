import { useId, useState } from "react"
import { cn } from "cn"

import { Badge } from "@/components/ui/badge"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { ManagedSelect } from "@/components/settings/settings-controls"
import { useTranslation } from "@/hooks/use-translation"
import { validContextWindow } from "@/lib/model-context-window"
import { contextWindowPresetLabel, contextWindowPresetTokens } from "../../../../runtime/model-catalog.mjs"

export interface ModelCapabilityFieldsValue {
  contextWindow: string
  reasoningEfforts: string[] | undefined
  defaultReasoningEffort: string | null
  supportsImages: boolean | undefined
  supportsPatch: boolean | undefined
  supportsSearch: boolean | undefined
}

export function ModelIdentityFields({ id, name, disabled, idReadOnly = false, singleColumn = false, idError, onIdChange, onNameChange }: {
  id: string
  name: string
  disabled: boolean
  idReadOnly?: boolean
  singleColumn?: boolean
  idError?: string
  onIdChange: (value: string) => void
  onNameChange: (value: string) => void
}) {
  const { t } = useTranslation()
  const instance = useId()
  return <FieldGroup className={cn("grid min-w-0 gap-6", !singleColumn && "sm:grid-cols-2")}>
    <Field data-disabled={disabled || idReadOnly} data-invalid={Boolean(idError)}><FieldLabel htmlFor={`${instance}-id`}>{t("managementUi.modelId")}</FieldLabel><Input id={`${instance}-id`} value={id} disabled={disabled || idReadOnly} aria-invalid={Boolean(idError)} aria-describedby={idError ? `${instance}-id-error` : undefined} onChange={event => onIdChange(event.target.value)} />{idError && <FieldError id={`${instance}-id-error`}>{idError}</FieldError>}</Field>
    <Field data-disabled={disabled}><FieldLabel htmlFor={`${instance}-name`}>{t("managementUi.displayName")}</FieldLabel><Input id={`${instance}-name`} value={name} disabled={disabled} onChange={event => onNameChange(event.target.value)} /></Field>
  </FieldGroup>
}

export function ModelCapabilityFields({ value, disabled, maximum = 100000000, allowUnknown = false, allowReasoningToggle = false, unavailableTools = false, onChange }: {
  value: ModelCapabilityFieldsValue
  disabled: boolean
  maximum?: number
  allowUnknown?: boolean
  allowReasoningToggle?: boolean
  unavailableTools?: boolean
  onChange: (changes: Partial<ModelCapabilityFieldsValue>) => void
}) {
  const { t } = useTranslation()
  const instance = useId()
  const [windowTouched, setWindowTouched] = useState(false)
  const windowInvalid = (windowTouched || value.contextWindow !== "") && !validContextWindow(value.contextWindow, 1024, maximum)
  const efforts = value.reasoningEfforts ?? []
  const levels = ["none", ...(allowReasoningToggle ? ["enabled"] : []), "minimal", "low", "medium", "high", "xhigh", "max"]
  const reasoningOptions = [
    ...(allowUnknown ? [{ value: "unknown", label: t("customModel.unset") }, { value: "off", label: t("settingsFields.off") }] : []),
    ...levels.map(level => ({ value: level, label: level })),
  ]
  const selectedEfforts = allowUnknown && efforts.length === 0 ? [value.reasoningEfforts === undefined ? "unknown" : "off"] : efforts
  return <>
    <FieldGroup className="grid min-w-0 items-start gap-6 sm:grid-cols-2">
      <FieldSet disabled={disabled}><FieldLegend>{t("modelAddition.context")}</FieldLegend><FieldGroup>
        <ManagedSelect fullWidth hideLabel label={t("managementUi.contextPreset")} value={contextWindowPresetTokens.some(tokens => String(tokens) === value.contextWindow && tokens <= maximum) ? value.contextWindow : ""} placeholder={value.contextWindow ? t("openAiModelCatalog.contextCustom") : undefined} disabled={disabled} options={contextWindowPresetTokens.filter(tokens => tokens <= maximum).map(tokens => [String(tokens), t("managementUi.contextPresetLabel", { label: contextWindowPresetLabel(tokens), tokens })])} onChange={contextWindow => onChange({ contextWindow })} />
        <Field data-disabled={disabled} data-invalid={windowInvalid}><FieldLabel htmlFor={`${instance}-window`}>{t("managementUi.contextTokens")}</FieldLabel><Input id={`${instance}-window`} type="number" min={1024} max={maximum} value={value.contextWindow} disabled={disabled} aria-invalid={windowInvalid} aria-describedby={windowInvalid ? `${instance}-window-error` : undefined} onBlur={() => setWindowTouched(true)} onChange={event => onChange({ contextWindow: event.target.value })} />{windowInvalid && <FieldError id={`${instance}-window-error`}>{t("modelAddition.windowInvalid", { maximum })}</FieldError>}</Field>
      </FieldGroup></FieldSet>
      <FieldSet disabled={disabled}><FieldLegend>{t("modelAddition.reasoning")}</FieldLegend><FieldGroup>
          <Field data-disabled={disabled}>
            <FieldLabel className="sr-only" htmlFor={`${instance}-efforts`}>{t("modelAddition.reasoning")}</FieldLabel>
            <Select multiple items={reasoningOptions} value={selectedEfforts} disabled={disabled} onValueChange={next => {
              const added = next.find(level => !selectedEfforts.includes(level))
              if (allowUnknown && (added === "unknown" || added === "off")) {
                onChange({ reasoningEfforts: added === "unknown" ? undefined : [], defaultReasoningEffort: null })
                return
              }
              const selected = next.filter(level => levels.includes(level))
              onChange({ reasoningEfforts: allowUnknown && selected.length === 0 ? undefined : selected, defaultReasoningEffort: selected.includes(value.defaultReasoningEffort ?? "") ? value.defaultReasoningEffort : selected[0] ?? null })
            }}>
              <SelectTrigger id={`${instance}-efforts`} aria-describedby={!allowUnknown ? `${instance}-reasoning-hint` : undefined} size="sm" className="w-full min-w-0 max-w-full whitespace-normal data-[size=sm]:h-auto data-[size=sm]:min-h-7 *:data-[slot=select-value]:line-clamp-none">
                <SelectValue className="min-w-0 [overflow-wrap:anywhere]" placeholder={t("settingsUi.notConfigured")} />
              </SelectTrigger>
              <SelectContent className="max-w-[calc(100vw-2rem)]"><SelectGroup>{reasoningOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
          {!allowUnknown || efforts.length > 0 ? <ManagedSelect fullWidth label={t("managementUi.defaultReasoning")} value={value.defaultReasoningEffort ?? ""} disabled={disabled} options={efforts.map(level => [level, level])} onChange={defaultReasoningEffort => onChange({ defaultReasoningEffort })} /> : null}
      </FieldGroup>{!allowUnknown ? <FieldDescription id={`${instance}-reasoning-hint`}>{t("modelAddition.reasoningHint")}</FieldDescription> : null}</FieldSet>
    </FieldGroup>
    <FieldGroup className="grid min-w-0 gap-6 sm:grid-cols-3">
      {([
        ["supportsImages", t("managementUi.imageInput")],
        ["supportsPatch", t("modelAddition.fileEditing")],
        ["supportsSearch", t("modelAddition.toolSearch")],
      ] as const).map(([field, label]) => <FieldSet key={field} disabled={disabled || unavailableTools && field !== "supportsImages"}>
        <FieldLegend className="flex items-center gap-2">{label}{allowUnknown && value[field] === undefined ? <Badge variant="outline">{t("common.unknown")}</Badge> : null}</FieldLegend>
        <ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={value[field] === undefined ? [] : [value[field] ? "yes" : "no"]} disabled={disabled || unavailableTools && field !== "supportsImages"} aria-label={label} onValueChange={([selected]) => onChange({ [field]: selected === undefined ? undefined : selected === "yes" })}>
          <ToggleGroupItem value="yes">{t("managementUi.supported")}</ToggleGroupItem>
          <ToggleGroupItem value="no">{t("managementUi.unsupported")}</ToggleGroupItem>
        </ToggleGroup>
      </FieldSet>)}
    </FieldGroup>
  </>
}
