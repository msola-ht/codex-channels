import { useState } from "react"
import { useTranslation } from "@/hooks/use-translation"
import { ManagedSelect } from "@/components/settings/settings-controls"
import type { GatewaySettingsController } from "@/lib/settings-management"
import { translateDisplayScopeSource } from "@/lib/i18n/translate"
import { FieldGroup } from "@/components/ui/field"
import { SettingsEmpty } from "@/components/settings/settings-feedback"

export function DisplayScopeSettings({ management, disabled }: { management: GatewaySettingsController; disabled: boolean }) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState("")
  const scopes = management.managedSettings?.display.scopes ?? []
  const scope = scopes.find(value => value.id === selected) ?? scopes[0]
  const label = (value: typeof scopes[number]) => [value.selector.surface, value.selector.account_id, value.selector.chat_kind ? t(`displayScope.${value.selector.chat_kind}`) : undefined, value.selector.chat_id].filter(Boolean).join(" / ")
  const fields = [
    ["operation_updates", "operationUpdates", "settingsFields.operationUpdates"],
    ["subagents", "subagentsEnabled", "settingsFields.subagents"],
    ["streaming", "streamingEnabled", "settingsFields.streaming"],
    ["plan_updates", "planUpdatesEnabled", "settingsFields.planUpdates"],
    ["reasoning", "reasoningEnabled", "settingsFields.reasoningStatus"],
    ["completion", "completion", "settingsFields.completion"],
    ["presentation_detail", "presentationDetail", "settingsFields.presentationDetail"],
  ] as const
  const display = (value: typeof scope.effective[keyof typeof scope.effective]) => typeof value === "boolean" ? t(value ? "settingsFields.enabled" : "settingsFields.disabled") : value === "off" ? t("settingsFields.completionOff") : t(`settingsFields.${value}`)
  return <section className="flex flex-col gap-3">
    <h3 className="font-medium">{t("displayScope.title")}</h3>
    <p className="text-xs text-muted-foreground">{t("displayScope.hint")}</p>
    <p className="text-xs text-muted-foreground">{t("displayScope.projection")}</p>
    {management.managedSettings?.display.targetsStatus === "unavailable" && <p>{t("displayScope.unavailable")}</p>}
    <p className="text-xs text-muted-foreground">{t("displayScope.notice")}</p>
    {!scope ? <SettingsEmpty>{t("displayScope.empty")}</SettingsEmpty> : <FieldGroup>
      <ManagedSelect fullWidth label={t("displayScope.scope")} value={scope.id} options={scopes.map(value => [value.id, label(value)])} disabled={disabled} onChange={setSelected} />
      {!scope.writable && <p className="text-xs text-muted-foreground">{t("displayScope.readonly")}</p>}
      {fields.filter(([field]) => scope.supportedFields.includes(field)).map(([field, effective, title]) => <ManagedSelect key={field} label={t(title)}
        description={t("displayScope.effective", { value: display(scope.effective[effective]), source: translateDisplayScopeSource(t, scope.sources[effective]) })}
        value={scope.override[field] === undefined ? "inherit" : String(scope.override[field])}
        options={[["inherit", t("displayScope.inherit")], ...(field === "operation_updates" ? [["full", t("settingsFields.full")], ["compact", t("settingsFields.compact")], ["failures", t("settingsFields.failures")], ["hidden", t("settingsFields.hidden")]] : field === "completion" ? [["off", t("settingsFields.completionOff")], ["brief", t("settingsFields.brief")], ["detailed", t("settingsFields.detailed")]] : field === "presentation_detail" ? [["basic", t("settingsFields.basic")], ["detailed", t("settingsFields.detailed")]] : [["true", t("settingsFields.enabled")], ["false", t("settingsFields.disabled")]])]}
        disabledValues={scope.writable ? [] : ["true", "false", "full", "compact", "failures", "hidden", "off", "brief", "detailed", "basic"]}
        disabled={disabled} onChange={value => void management.previewSetting("display.scope", value === "inherit"
          ? { selector: scope.selector, field, action: "inherit" }
          : { selector: scope.selector, field, action: "set", value: field === "operation_updates" || field === "completion" || field === "presentation_detail" ? value : value === "true" }, { key: "displayScope.title" })} />)}
    </FieldGroup>}
  </section>
}
