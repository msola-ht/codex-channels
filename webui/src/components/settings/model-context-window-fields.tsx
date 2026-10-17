import { useId } from "react"
import { useTranslation } from "@/hooks/use-translation"
import { SettingsRow } from "@/components/settings/settings-controls"
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { ContextWindowPreset } from "@/lib/model-context-window"

/** Both catalog editors use exact token counts; preset K labels use decimal units. */
export function ModelContextWindowFields({ displayName, maxContextWindow, value, preset, valid, disabled, minimum = 1, onPresetChange, onValueChange }: {
  displayName: string
  maxContextWindow: number | null
  value: string
  preset: ContextWindowPreset
  valid: boolean
  disabled: boolean
  minimum?: number
  onPresetChange: (preset: ContextWindowPreset) => void
  onValueChange: (value: string) => void
}) {
  const { t, language } = useTranslation()
  const inputId = useId()
  const numbers = new Intl.NumberFormat(language === "zh" ? "zh-CN" : "en-US")
  return <FieldGroup>
    <span>{displayName}</span>
    <SettingsRow label={t("openAiModelCatalog.maxContext")} value={maxContextWindow === null ? t("common.unknown") : numbers.format(maxContextWindow)} />
    <FieldSet disabled={disabled}>
      <FieldLegend id={`${inputId}-label`}>{t("openAiModelCatalog.defaultContext")}</FieldLegend>
      <ToggleGroup variant="outline" size="sm" className="max-w-full flex-wrap" value={[preset]} disabled={disabled} aria-labelledby={`${inputId}-label`} aria-describedby={`${inputId}-hint`} onValueChange={([next]) => {
        if (next === "272000" || next === "372000" || next === "500000" || next === "max" || next === "custom") onPresetChange(next)
      }}>
        {(["272000", "372000", "500000"] as const).map(next => <ToggleGroupItem key={next} value={next} disabled={maxContextWindow === null || Number(next) > maxContextWindow}>{Number(next) / 1000}K</ToggleGroupItem>)}
        <ToggleGroupItem value="max" disabled={maxContextWindow === null}>{t("openAiModelCatalog.contextMaximum")}</ToggleGroupItem>
        <ToggleGroupItem value="custom">{t("openAiModelCatalog.contextCustom")}</ToggleGroupItem>
      </ToggleGroup>
      {preset === "custom" ? <Field data-invalid={!valid} data-disabled={disabled}>
        <FieldLabel htmlFor={inputId}>{t("openAiModelCatalog.contextCustom")}</FieldLabel>
        <Input id={inputId} inputMode="numeric" value={value} maxLength={16} aria-invalid={!valid} aria-describedby={`${inputId}-hint`} disabled={disabled} onChange={event => onValueChange(event.target.value)} />
      </Field> : <SettingsRow label={t("openAiModelCatalog.selectedContext")} value={numbers.format(Number(value))} />}
      <FieldDescription id={`${inputId}-hint`}>{minimum === 1 ? t("openAiModelCatalog.contextValidation") : t("managementUi.windowInvalid", { max: maxContextWindow === null ? t("common.unknown") : numbers.format(maxContextWindow) })}</FieldDescription>
    </FieldSet>
  </FieldGroup>
}
