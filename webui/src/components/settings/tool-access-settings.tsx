import { useEffect, useState } from "react"

import { useSettingsDraft } from "@/hooks/use-settings-draft"
import { useTranslation } from "@/hooks/use-translation"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ManagedSelect, SettingsRow } from "@/components/settings/settings-controls"
import type { CodexSettingsController, SettingLabel } from "@/lib/settings-management"
import type { MessageKey } from "@/lib/i18n/messages"
import type { CodexUserSettingsResponse } from "@/lib/types"

const mcpFieldLabels: Record<string, MessageKey> = {
  enabled: "settingsFields.mcpEnabled",
  default_tools_approval_mode: "settingsFields.mcpApproval",
  enabled_tools: "settingsFields.mcpAllowedTools",
  disabled_tools: "settingsFields.mcpDisabledTools",
  startup_timeout_sec: "settingsFields.mcpStartupTimeout",
  tool_timeout_sec: "settingsFields.mcpToolTimeout",
}
const pluginMcpFieldLabels: Record<string, MessageKey> = {
  enabled: "settingsFields.pluginMcpEnabled",
  default_tools_approval_mode: "settingsFields.pluginMcpApproval",
  enabled_tools: "settingsFields.pluginMcpAllowedTools",
  disabled_tools: "settingsFields.pluginMcpDisabledTools",
}

function toolSettingLabel(path: readonly string[]): SettingLabel {
  const [root, name, field, detail, tool, toolField] = path
  if (path.length === 2 && root === "computer_use" && name === "default_app_access") return { key: "settingsFields.computerAppAccess" }
  if (path.length === 2 && root === "browser_use" && name === "allow_history_access") return { key: "settingsFields.browserHistory" }
  if (path.length === 3 && root === "browser_use" && name === "default_origin_policy" && field !== undefined) return { key: "settingsFields.browserDefaultPolicy", params: { field } }
  if (path.length === 4 && root === "computer_use" && (name === "macos" || name === "windows") && (field === "bundle_ids" || field === "aumids") && detail !== undefined) return { key: "settingsFields.computerApp", params: { platform: name, id: detail } }
  if (path.length === 4 && root === "browser_use" && name === "origins" && field !== undefined && detail !== undefined) return { key: "settingsFields.browserOriginPolicy", params: { origin: field, field: detail } }
  if (root === "mcp_servers" && name !== undefined) {
    if (path.length === 3 && field !== undefined && Object.hasOwn(mcpFieldLabels, field)) return { key: mcpFieldLabels[field]!, params: { server: name } }
    if (path.length === 5 && field === "tools" && detail !== undefined && (tool === "approval_mode" || tool === "output_token_limit")) return { key: tool === "approval_mode" ? "settingsFields.mcpToolApproval" : "settingsFields.mcpToolOutputLimit", params: { server: name, tool: detail } }
  }
  if (root === "plugins" && name !== undefined && field === "mcp_servers" && detail !== undefined) {
    if (path.length === 5 && tool !== undefined && Object.hasOwn(pluginMcpFieldLabels, tool)) return { key: pluginMcpFieldLabels[tool]!, params: { plugin: name, server: detail } }
    if (path.length === 7 && tool === "tools" && toolField !== undefined && (path[6] === "approval_mode" || path[6] === "output_token_limit")) return { key: path[6] === "approval_mode" ? "settingsFields.pluginMcpToolApproval" : "settingsFields.pluginMcpToolOutputLimit", params: { plugin: name, server: detail, tool: toolField } }
  }
  return path.join(".")
}

export function ToolAccessSettings({ management }: { management: CodexSettingsController }) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState("")
  const settings = management.codexSettings?.toolSettings
  if (!settings || settings.fields.length === 0) return null
  const field = settings.fields.find((item) => JSON.stringify(item.path) === selected) ?? settings.fields[0]
  const busy = management.loading || management.error !== null || management.saving || management.pendingSetting !== null
  return <section className="flex flex-col gap-3">
    <div><h3 className="font-medium">{t("settingsFields.toolsTitle")}</h3><p className="text-xs text-muted-foreground">{t("settingsFields.toolsHint")}</p></div>
    <ManagedSelect label={t("settingsFields.toolSetting")} value={JSON.stringify(field.path)} options={settings.fields.map((item) => { const label = toolSettingLabel(item.path); return [JSON.stringify(item.path), typeof label === "string" ? label : t(label.key, label.params)] })} disabled={busy} onChange={setSelected} />
    <ToolSettingEditor key={JSON.stringify(field.path)} field={field} management={management} mergedAvailable={settings.mergedAvailable} />
    <p className="text-xs text-muted-foreground">{t("settingsFields.toolsPolicyHint")}</p>
  </section>
}

function ToolSettingEditor({ field, management, mergedAvailable }: {
  field: CodexUserSettingsResponse["toolSettings"]["fields"][number]
  management: CodexSettingsController
  mergedAvailable: boolean
}) {
  const { t } = useTranslation()
  const [draft, patch, reset] = useSettingsDraft({ text: field.userValue === null ? "" : JSON.stringify(field.userValue) })
  const { text } = draft
  const path = JSON.stringify(field.path)
  useEffect(() => {
    const saved = management.lastAppliedSetting
    if (saved?.kind === "tool-access" && JSON.stringify(saved.path) === path) reset()
  }, [management.lastAppliedSetting, path, reset])
  const [error, setError] = useState<MessageKey | null>(null)
  const busy = management.loading || management.error !== null || management.saving || management.pendingSetting !== null
  const preview = (value: unknown) => {
    setError(null)
    void management.previewSetting({ kind: "tool-access", path: field.path, value }, toolSettingLabel(field.path))
  }
  const saveText = () => {
    try {
      preview(text.trim() === "" ? null : JSON.parse(text))
    } catch {
      setError(field.type === "list" ? "settingsFields.toolListInvalid" : "settingsFields.toolNumberInvalid")
    }
  }
  return <>
    <FieldGroup className="flex flex-col gap-3">
      <SettingsRow label={t("settingsFields.userSetting")} value={field.userValue === null ? t("settingsFields.notSet") : JSON.stringify(field.userValue)} />
      <SettingsRow label={t("settingsFields.mergedConfig")} value={!mergedAvailable ? t("settingsFields.unavailable") : field.mergedValue === null ? t("settingsFields.upstreamDecides") : JSON.stringify(field.mergedValue)} />
      {field.type === "choice" || field.type === "boolean"
        ? <ManagedSelect label={t("settingsFields.editUserSetting")} value={field.userValue === null ? "inherit" : JSON.stringify(field.userValue)} options={[["inherit", t("settingsFields.inheritUserSetting")], ...(field.type === "boolean" ? [true, false] : field.options ?? []).map((value) => [JSON.stringify(value), String(value)])]} disabled={busy} onChange={(value) => preview(value === "inherit" ? null : JSON.parse(value))} />
        : <Field data-disabled={busy} data-invalid={error !== null}>
            <FieldLabel htmlFor="tool-setting-value">{t("settingsFields.newValue")}</FieldLabel>
            <Input id="tool-setting-value" value={text} disabled={busy} aria-invalid={error !== null} aria-describedby={error === null ? "tool-setting-value-description" : "tool-setting-value-description tool-setting-value-error"} onChange={(event) => { patch({ text: event.target.value }); setError(null) }} />
            <FieldDescription id="tool-setting-value-description">{t(field.type === "list" ? "settingsFields.toolListHint" : "settingsFields.toolNumberHint")}</FieldDescription>
            {error !== null ? <FieldError id="tool-setting-value-error">{t(error)}</FieldError> : null}
            <Button className="self-start" variant="outline" disabled={busy} onClick={saveText}>{t("settingsFields.preview")}</Button>
          </Field>}
    </FieldGroup>
  </>
}
